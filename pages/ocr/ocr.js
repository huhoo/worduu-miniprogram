const store = require('../../utils/store.js');
const api = require('../../utils/api.js');
const privacy = require('../../utils/privacy.js');

const SOURCES = ['教材', '课外书', '绘本', '练习册', '报纸杂志', '其他'];

Page({
  data: {
    step: 'pick', // pick → result
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
        that.setData({ imagePath: file.tempFilePath, errorMsg: '' });
        that.scan(file.tempFilePath);
      },
    });
  },

  /**
   * 压缩后送识别。直接用原图会明显变慢且容易超过云函数入参上限，
   * 压到 1280 宽对识字精度没有可观察的影响。
   */
  scan(tempPath) {
    const that = this;
    this.setData({ scanning: true, errorMsg: '', scanHint: '正在压缩图片…' });

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

  requestOcr(base64) {
    const that = this;
    api
      .ocrScan(base64, SOURCES[this.data.sourceIndex])
      .then((res) => {
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
            wx.redirectTo({ url: '/pages/quiz/quiz' });
          } else {
            that.setData({ step: 'pick', imagePath: '', result: null, chars: [], selectedCount: 0 });
          }
        },
      });
    }, 800);
  },

  reset() {
    this.setData({
      step: 'pick',
      imagePath: '',
      result: null,
      chars: [],
      selectedCount: 0,
      errorMsg: '',
    });
  },
});
