const store = require('../../../utils/store.js');
const api = require('../../../utils/api.js');
const audio = require('../../../utils/audio.js');

Page({
  data: {
    item: null,
    loading: false,
    notice: '',
    inBank: true,
  },

  onLoad(options) {
    const state = store.loadState();

    let item = null;
    if (options.id) item = store.findById(state, options.id);
    if (!item && options.char) item = store.findByChar(state, options.char);

    if (item) {
      this.state = state;
      this.render(item);
      // 拍照入库的字可能没有部首和笔画，缺了就补一次查字。
      if (!item.radical || !item.strokeCount) this.fetchInfo(item.char);
      return;
    }

    // 字库里没有：只在本次会话里展示，不写进字库。
    if (options.char) {
      this.state = state;
      this.setData({ inBank: false, loading: true });
      this.fetchInfo(options.char, true);
      return;
    }

    this.setData({ notice: '没有找到这个字' });
  },

  onHide() {
    audio.stopSpeaking();
  },

  render(item) {
    const words = item.words || [];
    this.setData({
      item: Object.assign({}, item, {
        wordsText: words.join('、'),
        hasWords: words.length > 0,
      }),
    });
    wx.setNavigationBarTitle({ title: `“${item.char}” 字卡` });
  },

  fetchInfo(char, standalone) {
    const that = this;
    this.setData({ loading: true });
    api
      .characterInfo(char)
      .then((info) => {
        if (standalone) {
          that.setData({
            loading: false,
            inBank: false,
            item: {
              id: `lookup-${char}`,
              char,
              pinyin: info.pinyin || '',
              radical: info.radical || '',
              strokeCount: Number(info.strokeCount) || 0,
              meaning: info.meaning || '',
              words: info.words || [],
              wordsText: (info.words || []).join('、'),
              hasWords: (info.words || []).length > 0,
              exampleSentence: info.sentence || '',
              originStory: info.originStory || '',
              source: '课外书',
              sourceDetail: '临时查字',
              dateEncountered: store.todayLabel(),
              mastery: '不熟',
            },
            notice: '',
          });
          return;
        }

        const state = that.state || store.loadState();
        const target = store.findByChar(state, char);
        if (target) {
          store.enrichCharacter(state, target.id, info);
          store.saveState(state);
          that.render(target);
        }
        that.setData({ loading: false, notice: '' });
      })
      .catch((err) => {
        that.setData({
          loading: false,
          notice: (err && err.message) || '暂时没能查到这个字的详细解析。',
        });
      });
  },

  playRead() {
    const item = this.data.item;
    if (!item) return;
    audio.playCharAudio({
      char: item.char,
      pinyin: item.pinyin,
      sampleWord: (item.words || [])[0],
      mode: 'read',
    });
  },

  playSpell() {
    const item = this.data.item;
    if (!item) return;
    audio.playCharAudio({
      char: item.char,
      pinyin: item.pinyin,
      sampleWord: (item.words || [])[0],
      mode: 'spell',
    });
  },

  goWrite() {
    const item = this.data.item;
    if (!item) return;
    wx.navigateTo({ url: `/learn/pages/write/write?char=${encodeURIComponent(item.char)}` });
  },
});
