const store = require('../../utils/store.js');
const api = require('../../utils/api.js');
const privacy = require('../../utils/privacy.js');
const CROP = require('../../utils/cropGeometry.js');

const SOURCES = ['教材', '课外书', '绘本', '练习册', '报纸杂志', '其他'];

/** 选框舞台的最大高度（px）：长图不至于把下面的按钮顶出屏幕。 */
const MAX_STAGE_H = 420;
/** 四角把手的命中半径（px），比可见圆点大，手指好按。 */
const GRIP_HIT = 26;
/**
 * 识别超过这个秒数就提示可以取消。
 *
 * 云函数上限是 60 秒。在此之前孩子只能盯着转圈，
 * 所以到点就把提示换成「可以取消后重拍」，而不是继续假装一切正常。
 */
const SLOW_SCAN_SECONDS = 45;

Page({
  data: {
    step: 'pick', // pick → crop → result
    sources: SOURCES,
    sourceIndex: 0,
    imagePath: '',
    scanning: false,
    scanHint: '',
    errorMsg: '',
    result: null,
    chars: [],
    selectedCount: 0,
    manualChar: '',
    addingManual: false,
    // 裁剪态
    imgW: 0,
    imgH: 0,
    stageH: 320,
    box: null,
    rectPx: null,
    cropping: false,
  },

  onSourceChange(e) {
    this.setData({ sourceIndex: Number(e.detail.value) });
  },

  /** 拍照或从相册选图。两者都走同一条识别链路。 */
  chooseImage() {
    const that = this;
    // 正式版未同意《用户隐私保护指引》时 chooseMedia 会直接失败，
    // 表现为点了没反应，所以先确认授权再调。
    privacy.ensurePrivacy().then((ok) => {
      if (!ok) {
        wx.showToast({ title: '需要同意隐私保护指引才能拍照', icon: 'none' });
        return;
      }
      that.pickMedia();
    });
  },

  pickMedia() {
    const that = this;
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['camera', 'album'],
      camera: 'back',
      sizeType: ['compressed'],
      success(res) {
        const file = res.tempFiles && res.tempFiles[0];
        if (!file) return;
        // 先量出原图尺寸：裁剪选区要按照片自己的比例算，不能按屏幕上的显示尺寸。
        wx.getImageInfo({
          src: file.tempFilePath,
          success(info) {
            that.prepareCrop(file.tempFilePath, info.width, info.height);
          },
          fail() {
            // 量不出尺寸就退回老路子：整张直接识别。
            that.setData({ imagePath: file.tempFilePath, errorMsg: '' });
            that.scan(file.tempFilePath, false);
          },
        });
      },
    });
  },

  /* ---------------------------------------------------------------- *
   * 框选：只识别框里的那一段，桌上的其他东西就不会混进来
   * ---------------------------------------------------------------- */

  prepareCrop(path, imgW, imgH) {
    const that = this;
    const winW = wx.getSystemInfoSync().windowWidth || 375;
    // 先按「卡片左右各留 16px」估一个宽度把舞台渲染出来，紧接着再量真实宽度修正。
    const estW = Math.max(1, winW - 64);
    this.setData(
      { step: 'crop', imagePath: path, imgW, imgH, stageH: Math.min(estW * imgH / imgW, MAX_STAGE_H), errorMsg: '' },
      () => that.measureStage(imgW, imgH),
    );
  },

  /** 量出舞台真实尺寸，再算出照片在里面真正占据的那块区域。 */
  measureStage(imgW, imgH) {
    const that = this;
    wx.createSelectorQuery()
      .in(this)
      .select('.crop-stage')
      .boundingClientRect((rect) => {
        if (!rect || !rect.width) return;
        const stageW = rect.width;
        const stageH = Math.min(stageW * imgH / imgW, MAX_STAGE_H);
        const box = CROP.containedBox(imgW, imgH, stageW, stageH);
        that._box = box;
        that._stage = { left: rect.left, top: rect.top, width: stageW, height: stageH };
        that.setData({ stageH: Math.round(stageH), box }, () => that.applyRect(CROP.DEFAULT_RECT));
      })
      .exec();
  },

  applyRect(rect) {
    if (!this._box) return;
    this._rect = rect;
    this.setData({ rectPx: CROP.toStagePixels(rect, this._box) });
  },

  onCropTouchStart(e) {
    const touch = e.touches && e.touches[0];
    const stage = this._stage;
    const px = this.data.rectPx;
    if (!touch || !stage || !px) return;

    const x = touch.clientX - stage.left;
    const y = touch.clientY - stage.top;

    const corners = {
      nw: [px.left, px.top],
      ne: [px.left + px.width, px.top],
      sw: [px.left, px.top + px.height],
      se: [px.left + px.width, px.top + px.height],
    };

    let mode = 'draw';
    Object.keys(corners).forEach((key) => {
      if (Math.abs(x - corners[key][0]) <= GRIP_HIT && Math.abs(y - corners[key][1]) <= GRIP_HIT) mode = key;
    });
    if (mode === 'draw') {
      const inside = x >= px.left && x <= px.left + px.width && y >= px.top && y <= px.top + px.height;
      if (inside) mode = 'move';
    }

    const box = this._box;
    this._drag = {
      mode,
      startX: x,
      startY: y,
      origin: Object.assign({}, this._rect || CROP.DEFAULT_RECT),
      // 框选（draw）需要记住起点的归一化坐标，反向拖也能框对。
      anchorX: (x - box.left) / box.width,
      anchorY: (y - box.top) / box.height,
    };
  },

  onCropTouchMove(e) {
    const touch = e.touches && e.touches[0];
    const stage = this._stage;
    const drag = this._drag;
    const box = this._box;
    if (!touch || !stage || !drag || !box) return;

    const x = touch.clientX - stage.left;
    const y = touch.clientY - stage.top;

    if (drag.mode === 'draw') {
      const bx = Math.min(Math.max((x - box.left) / box.width, 0), 1);
      const by = Math.min(Math.max((y - box.top) / box.height, 0), 1);
      this.applyRect(CROP.rectFromPoints(drag.anchorX, drag.anchorY, bx, by));
      return;
    }

    const dx = (x - drag.startX) / box.width;
    const dy = (y - drag.startY) / box.height;
    this.applyRect(CROP.applyDrag(drag.origin, drag.mode, dx, dy));
  },

  onCropTouchEnd() {
    this._drag = null;
  },

  /** 整页识别：跳过裁剪，直接走原来的整图链路。 */
  useWholePage() {
    this.setData({ step: 'crop' });
    this.scan(this.data.imagePath, false);
  },

  /** 按选区裁一刀再送识别。裁不动就如实退回整页，不假装裁过。 */
  cropAndScan() {
    const that = this;
    const rect = this._rect || CROP.DEFAULT_RECT;
    const { imagePath, imgW, imgH } = this.data;
    if (!imagePath || !imgW || !imgH) {
      this.scan(imagePath, false);
      return;
    }

    const src = CROP.toSourcePixels(rect, imgW, imgH);
    const scale = Math.min(1, 1280 / src.sw);
    const outW = Math.max(1, Math.round(src.sw * scale));
    const outH = Math.max(1, Math.round(src.sh * scale));

    this.setData({ cropping: true, errorMsg: '' });

    wx.createSelectorQuery()
      .in(this)
      .select('#cropCanvas')
      .fields({ node: true, size: true })
      .exec((res) => {
        const canvas = res && res[0] && res[0].node;
        if (!canvas) {
          that.setData({ cropping: false });
          that.scan(imagePath, false);
          return;
        }

        canvas.width = outW;
        canvas.height = outH;
        const ctx = canvas.getContext('2d');
        const img = canvas.createImage();

        img.onload = () => {
          ctx.drawImage(img, src.sx, src.sy, src.sw, src.sh, 0, 0, outW, outH);
          wx.canvasToTempFilePath({
            canvas,
            destWidth: outW,
            destHeight: outH,
            fileType: 'jpg',
            quality: 0.92,
            success(out) {
              that.setData({ cropping: false });
              that.scan(out.tempFilePath, true);
            },
            fail() {
              that.setData({ cropping: false });
              that.scan(imagePath, false);
            },
          });
        };
        img.onerror = () => {
          that.setData({ cropping: false });
          that.scan(imagePath, false);
        };
        img.src = imagePath;
      });
  },

  /**
   * 压缩后送识别。直接用原图会明显变慢且容易超过云函数入参上限，
   * 压到 1280 宽对识字精度没有可观察的影响。
   */
  /**
   * 压缩后送识别。直接用原图会明显变慢且容易超过云函数入参上限，
   * 压到 1280 宽对识字精度没有可观察的影响。
   * 已经裁过的图宽度本身不超过 1280，跳过压缩省一次读写。
   */
  scan(tempPath, skipCompress) {
    const that = this;
    this.aborted = false;
    this.clearSlowTimer();
    this.setData({ scanning: true, errorMsg: '', scanHint: skipCompress ? 'AI 正在逐字识别…' : '正在压缩图片…' });

    // 到点还没回来就明说可以取消，别让孩子以为卡死了。
    this.slowTimer = setTimeout(() => {
      if (that.data.scanning) {
        that.setData({ scanHint: '识别有点久，可以取消后重拍' });
      }
    }, SLOW_SCAN_SECONDS * 1000);

    if (skipCompress) {
      try {
        const base64 = wx.getFileSystemManager().readFileSync(tempPath, 'base64');
        that.requestOcr(base64);
        return;
      } catch (err) {
        that.setData({ scanning: false, scanHint: '', errorMsg: '读取图片失败，请重新拍摄。' });
        return;
      }
    }

    wx.compressImage({
      src: tempPath,
      quality: 72,
      compressedWidth: 1280,
      success(compressed) {
        that.setData({ scanHint: 'AI 正在逐字识别…' });
        try {
          const base64 = wx.getFileSystemManager().readFileSync(compressed.tempFilePath, 'base64');
          that.requestOcr(base64);
        } catch (err) {
          that.setData({
            scanning: false,
            scanHint: '',
            errorMsg: '读取图片失败，请重新拍摄。',
          });
        }
      },
      fail() {
        // 压缩失败（比如 HEIC）就退回原图再试一次。
        that.setData({ scanHint: 'AI 正在逐字识别…' });
        try {
          const base64 = wx.getFileSystemManager().readFileSync(tempPath, 'base64');
          that.requestOcr(base64);
        } catch (err) {
          that.setData({ scanning: false, scanHint: '', errorMsg: '读取图片失败，请重新拍摄。' });
        }
      },
    });
  },

  clearSlowTimer() {
    if (this.slowTimer) {
      clearTimeout(this.slowTimer);
      this.slowTimer = null;
    }
  },

  /**
   * 取消识别，回到上一步。
   *
   * 云调用本身没有 abort，这里做的是「放弃这次结果」：
   * 打上 aborted 标记，请求回来时直接丢弃，不跳结果页也不弹错误 ——
   * 取消是孩子自己的选择，不是一次失败。
   */
  cancelScan() {
    this.aborted = true;
    this.clearSlowTimer();
    this.setData({
      scanning: false,
      cropping: false,
      scanHint: '',
      errorMsg: '',
      step: this.data.imagePath ? 'crop' : 'pick',
    });
  },

  requestOcr(base64) {
    const that = this;
    api
      .ocrScan(base64, SOURCES[this.data.sourceIndex])
      .then((res) => {
        // 已经取消了：结果再好也不该覆盖界面。
        if (that.aborted) return;
        that.clearSlowTimer();
        // WXML 表达式不支持 .join()，组词文本在这里先拼好。
        const chars = (res.recognizedCharacters || []).map((c) =>
          Object.assign({}, c, {
            wordsText: (c.words || []).join('、'),
            checked: c.isSuggested !== false,
          }),
        );
        that.setData({
          scanning: false,
          scanHint: '',
          step: 'result',
          result: { title: res.title || '', rawText: res.rawText || '' },
          chars,
          selectedCount: chars.filter((c) => c.checked).length,
        });
        if (chars.length === 0) {
          that.setData({ errorMsg: '这一页没有识别出可学的汉字，换一页或手动添加试试。' });
        }
      })
      .catch((err) => {
        // 取消之后回来的失败同样不该弹 —— 那是我们自己放弃的。
        if (that.aborted) return;
        that.clearSlowTimer();
        that.setData({
          scanning: false,
          scanHint: '',
          errorMsg: (err && err.message) || '识别失败，请稍后重试。',
        });
      });
  },

  toggleChar(e) {
    const index = Number(e.currentTarget.dataset.index);
    const key = `chars[${index}].checked`;
    const chars = this.data.chars;
    const next = !chars[index].checked;
    this.setData({
      [key]: next,
      selectedCount: this.data.selectedCount + (next ? 1 : -1),
    });
  },

  selectAll() {
    const chars = this.data.chars.map((c) => Object.assign({}, c, { checked: true }));
    this.setData({ chars, selectedCount: chars.length });
  },

  deselectAll() {
    const chars = this.data.chars.map((c) => Object.assign({}, c, { checked: false }));
    this.setData({ chars, selectedCount: 0 });
  },

  /** AI 没识别出来的字，家长可以手动补一个，同样走云端查字，不本地编拼音。 */
  onManualInput(e) {
    this.setData({ manualChar: e.detail.value });
  },

  addManualChar() {
    const symbol = (this.data.manualChar || '').trim();
    if (!/^[\u4e00-\u9fff]$/.test(symbol)) {
      wx.showToast({ title: '请输入单个汉字', icon: 'none' });
      return;
    }

    const that = this;
    this.setData({ addingManual: true });
    api
      .characterInfo(symbol)
      .then((info) => {
        const chars = that.data.chars.concat([
          {
            char: symbol,
            pinyin: info.pinyin || '',
            meaning: info.meaning || '',
            words: info.words || [],
            wordsText: (info.words || []).join('、'),
            isUncertain: false,
            checked: true,
          },
        ]);
        that.setData({
          chars,
          selectedCount: chars.filter((c) => c.checked).length,
          manualChar: '',
          addingManual: false,
          errorMsg: '',
        });
      })
      .catch((err) => {
        // 查不到也允许先收进来，拼音留空 —— 空值会被如实展示为「暂无拼音」，
        // 不会拿一个猜的读音冒充标准读音。
        const chars = that.data.chars.concat([
          { char: symbol, pinyin: '', meaning: '', words: [], wordsText: '', isUncertain: true, checked: true },
        ]);
        that.setData({
          chars,
          selectedCount: chars.filter((c) => c.checked).length,
          manualChar: '',
          addingManual: false,
          errorMsg: (err && err.message) || '暂时没能查到这个字，已先加入待确认。',
        });
      });
  },

  addToBank() {
    const selected = this.data.chars.filter((c) => c.checked);
    if (selected.length === 0) {
      wx.showToast({ title: '请先勾选要学的字', icon: 'none' });
      return;
    }

    const state = store.loadState();
    const source = SOURCES[this.data.sourceIndex];
    const title = (this.data.result && this.data.result.title) || '';
    const added = store.addCharacters(
      state,
      selected.map((c) => Object.assign({}, c, { sourceDetail: title || `拍照识别自${source}` })),
      source,
      title,
    );
    store.saveState(state);

    wx.showToast({ title: `已收入 ${added.length} 个生字`, icon: 'success' });

    const that = this;
    setTimeout(() => {
      wx.showModal({
        title: '生字已入库',
        content: `这次新学了 ${added.length} 个字。现在去认读测试，当场检验一下？`,
        confirmText: '去认读',
        cancelText: '稍后再说',
        success(res) {
          if (res.confirm) {
            wx.redirectTo({ url: '/learn/pages/quiz/quiz' });
          } else {
            that.setData({ step: 'pick', imagePath: '', result: null, chars: [], selectedCount: 0 });
          }
        },
      });
    }, 800);
  },

  onUnload() {
    this.clearSlowTimer();
  },

  reset() {
    this._rect = null;
    this._drag = null;
    this.clearSlowTimer();
    this.setData({
      step: 'pick',
      imagePath: '',
      result: null,
      chars: [],
      selectedCount: 0,
      errorMsg: '',
      imgW: 0,
      imgH: 0,
      box: null,
      rectPx: null,
      cropping: false,
    });
  },

  /** 识别出错时的求助出口。 */
  goHelp() {
    wx.navigateTo({ url: '/pages/help/help' });
  },
});
