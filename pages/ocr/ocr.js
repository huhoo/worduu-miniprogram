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
/** 橡皮擦在显示坐标下的半径（px），scale=1 时的尺寸。 */
const ERASE_R = 14;

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
    // 工具与视图（2026-10-29：橡皮擦 + 双指缩放）
    tool: 'select', // select 框选 | erase 橡皮擦
    viewScale: 1,
    viewTx: 0,
    viewTy: 0,
    eraseCount: 0,
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
    this.resetEraseState();
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
        that.setData({ stageH: Math.round(stageH), box }, () => {
          that.applyRect(CROP.DEFAULT_RECT);
          that.initEraseCanvas();
        });
      })
      .exec();
  },

  applyRect(rect) {
    if (!this._box) return;
    this._rect = rect;
    this.setData({ rectPx: CROP.toStagePixels(rect, this._box) });
  },

  /* ---------------- 工具切换与视图（缩放） ---------------- */

  setTool(e) {
    this.setData({ tool: e.currentTarget.dataset.tool || 'select' });
  },

  /** 视图状态（缩放/平移）归位：数据视图与 WXML 同步。 */
  resetView() {
    this._view = { s: 1, tx: 0, ty: 0 };
    this.setData({ viewScale: 1, viewTx: 0, viewTy: 0 });
  },

  resetEraseState() {
    this._erase = [];
    this._eraseCur = null;
    this._pinch = null;
    this._ecanvas = null;
    this._ectx = null;
    this.resetView();
    this.setData({ tool: 'select', eraseCount: 0 });
  },

  clearErase() {
    this._erase = [];
    this._eraseCur = null;
    this.setData({ eraseCount: 0 });
    this.redrawErase();
  },

  /** 橡皮擦画布：盖在照片显示区上，把涂过的位置画成白色。 */
  initEraseCanvas() {
    const box = this._box;
    if (!box) return;
    wx.createSelectorQuery()
      .in(this)
      .select('#eraseCanvas')
      .fields({ node: true, size: true })
      .exec((res) => {
        const canvas = res && res[0] && res[0].node;
        if (!canvas) return;
        const dpr = wx.getSystemInfoSync().pixelRatio || 2;
        canvas.width = Math.round(box.width * dpr);
        canvas.height = Math.round(box.height * dpr);
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);
        this._ecanvas = canvas;
        this._ectx = ctx;
        this.redrawErase();
      });
  },

  redrawErase() {
    const ctx = this._ectx;
    const box = this._box;
    if (!ctx || !box) return;
    ctx.clearRect(0, 0, box.width, box.height);
    ctx.fillStyle = '#FFFFFF';
    const paint = (pts) => {
      (pts || []).forEach((p) => {
        ctx.beginPath();
        ctx.arc(p[0], p[1], ERASE_R, 0, Math.PI * 2);
        ctx.fill();
      });
    };
    (this._erase || []).forEach(paint);
    paint(this._eraseCur);
  },

  /** 把舞台坐标换算成未缩放容器的坐标（选框/擦除都活在容器坐标系里）。 */
  toStagePoint(touch) {
    const stage = this._stage;
    const v = this._view;
    const rx = touch.clientX - stage.left;
    const ry = touch.clientY - stage.top;
    return { x: (rx - v.tx) / v.s, y: (ry - v.ty) / v.s };
  },

  onCropTouchStart(e) {
    const stage = this._stage;
    if (!stage) return;

    // 双指：进入捏合缩放，记下初始距离/中心与当前视图。
    if (e.touches.length >= 2) {
      const [a, b] = e.touches;
      this._pinch = {
        dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1,
        cx: (a.clientX + b.clientX) / 2 - stage.left,
        cy: (a.clientY + b.clientY) / 2 - stage.top,
        s0: this._view.s,
        tx0: this._view.tx,
        ty0: this._view.ty,
      };
      this._drag = null;
      this._eraseCur = null;
      return;
    }
    this._pinch = null;

    const touch = e.touches[0];
    if (!touch) return;
    const p = this.toStagePoint(touch);

    // 橡皮擦模式：起一段擦除笔迹
    if (this.data.tool === 'erase') {
      this._eraseCur = [[p.x, p.y]];
      this.redrawErase();
      return;
    }

    const px = this.data.rectPx;
    if (!px) return;

    const corners = {
      nw: [px.left, px.top],
      ne: [px.left + px.width, px.top],
      sw: [px.left, px.top + px.height],
      se: [px.left + px.width, px.top + px.height],
    };

    let mode = 'draw';
    Object.keys(corners).forEach((key) => {
      if (Math.abs(p.x - corners[key][0]) <= GRIP_HIT && Math.abs(p.y - corners[key][1]) <= GRIP_HIT) mode = key;
    });
    if (mode === 'draw') {
      const inside = p.x >= px.left && p.x <= px.left + px.width && p.y >= px.top && p.y <= px.top + px.height;
      if (inside) mode = 'move';
    }

    const box = this._box;
    this._drag = {
      mode,
      startX: p.x,
      startY: p.y,
      origin: Object.assign({}, this._rect || CROP.DEFAULT_RECT),
      // 框选（draw）需要记住起点的归一化坐标，反向拖也能框对。
      anchorX: (p.x - box.left) / box.width,
      anchorY: (p.y - box.top) / box.height,
    };
  },

  onCropTouchMove(e) {
    const stage = this._stage;
    if (!stage) return;

    // 双指捏合：以初始两指中心为锚点缩放，图片不飘。
    if (e.touches.length >= 2 && this._pinch) {
      const [a, b] = e.touches;
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;
      const p = this._pinch;
      const s = Math.min(4, Math.max(1, (p.s0 * dist) / p.dist));
      const k = s / p.s0;
      const tx = p.cx - (p.cx - p.tx0) * k;
      const ty = p.cy - (p.cy - p.ty0) * k;
      this._view = { s, tx, ty };
      this.setData({ viewScale: s, viewTx: tx, viewTy: ty });
      return;
    }
    if (this._pinch) this._pinch = null;

    const touch = e.touches[0];
    if (!touch) return;

    // 橡皮擦进行中：追加擦除点
    if (this._eraseCur) {
      const pt = this.toStagePoint(touch);
      this._eraseCur.push([pt.x, pt.y]);
      this.redrawErase();
      return;
    }

    const drag = this._drag;
    const box = this._box;
    if (!drag || !box) return;

    const pt = this.toStagePoint(touch);

    if (drag.mode === 'draw') {
      const bx = Math.min(Math.max((pt.x - box.left) / box.width, 0), 1);
      const by = Math.min(Math.max((pt.y - box.top) / box.height, 0), 1);
      this.applyRect(CROP.rectFromPoints(drag.anchorX, drag.anchorY, bx, by));
      return;
    }

    const dx = (pt.x - drag.startX) / box.width;
    const dy = (pt.y - drag.startY) / box.height;
    this.applyRect(CROP.applyDrag(drag.origin, drag.mode, dx, dy));
  },

  onCropTouchEnd() {
    // 橡皮擦收笔：整段笔迹入册
    if (this._eraseCur) {
      if (this._eraseCur.length) {
        this._erase = (this._erase || []).concat([this._eraseCur]);
        this.setData({ eraseCount: this._erase.length });
      }
      this._eraseCur = null;
      this.redrawErase();
    }
    this._drag = null;
    this._pinch = null;
  },

  /** 整页识别：无擦除笔迹走原压缩链路；有擦除则合成白块后再送。 */
  useWholePage() {
    this.setData({ step: 'crop' });
    const { imgW, imgH } = this.data;
    if (this._erase && this._erase.length && imgW && imgH) {
      this.renderAndScan({ sx: 0, sy: 0, sw: imgW, sh: imgH });
    } else {
      this.scan(this.data.imagePath, false);
    }
  },

  /** 按选区裁一刀再送识别。 */
  cropAndScan() {
    const rect = this._rect || CROP.DEFAULT_RECT;
    const { imagePath, imgW, imgH } = this.data;
    if (!imagePath || !imgW || !imgH) {
      this.scan(imagePath, false);
      return;
    }
    this.renderAndScan(CROP.toSourcePixels(rect, imgW, imgH));
  },

  /**
   * 渲染最终送识别的图：源图指定区域 + 橡皮擦白块，宽压到 ≤1280。
   * 擦除点记录在显示坐标，这里换算回原图坐标再画白圆，
   * 涂掉的字在识别图里就真的是白纸了，AI 不会再看见它。
   */
  renderAndScan(src) {
    const that = this;
    const { imagePath, imgW, imgH } = this.data;
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

          // 擦除白块：显示坐标 → 原图坐标 → 输出坐标
          const box = that._box;
          const erase = that._erase || [];
          if (box && erase.length) {
            const kx = imgW / box.width;
            const ky = imgH / box.height;
            const rImg = (ERASE_R * (kx + ky)) / 2;
            ctx.fillStyle = '#FFFFFF';
            erase.forEach((stroke) => {
              (stroke || []).forEach((p) => {
                const ix = (p[0] - box.left) * kx;
                const iy = (p[1] - box.top) * ky;
                if (ix < src.sx - rImg || ix > src.sx + src.sw + rImg) return;
                if (iy < src.sy - rImg || iy > src.sy + src.sh + rImg) return;
                ctx.beginPath();
                ctx.arc((ix - src.sx) * scale, (iy - src.sy) * scale, rImg * scale, 0, Math.PI * 2);
                ctx.fill();
              });
            });
          }

          wx.canvasToTempFilePath({
            canvas,
            destWidth: outW,
            destHeight: outH,
            fileType: 'jpg',
            quality: 0.75,
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
    this.resetEraseState();
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
