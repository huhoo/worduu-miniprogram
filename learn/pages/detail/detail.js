const store = require('../../../utils/store.js');
const api = require('../../../utils/api.js');
const audio = require('../../../utils/audio.js');
const { loadStrokeData } = require('../../utils/strokes.js');

Page({
  data: {
    item: null,
    loading: false,
    notice: '',
    inBank: true,
  },

  onLoad(options) {
    const state = store.loadState();

    // char 参数两种来源：reader 等页面 encodeURIComponent 后跳入（%E5%A5%BD），
    // 以及本仓库一贯的「传原字符」习惯（好）。微信框架不解码 query，
    // 接收端统一解一次：对原字符是空操作，对预编码是还原 —— 两种都兼容。
    // 不解码的后果：reader 点字跳过来的是 %XX 串，云函数报「请提供单个汉字」，
    // 字卡空白（2026-10-25 用户真机实测）。
    let charParam = '';
    if (options.char) {
      try {
        charParam = decodeURIComponent(options.char);
      } catch (e) {
        charParam = options.char;
      }
    }

    let item = null;
    if (options.id) item = store.findById(state, options.id);
    if (!item && charParam) item = store.findByChar(state, charParam);

    if (item) {
      this.state = state;
      this.render(item);
      // 拍照入库的字可能没有部首和笔画，缺了就补一次查字。
      if (!item.radical || !item.strokeCount) this.fetchInfo(item.char);
      return;
    }

    // 字库里没有：只在本次会话里展示，不写进字库。
    if (charParam) {
      this.state = state;
      this.setData({ inBank: false, loading: true });
      this.fetchInfo(charParam, true);
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
        // dateEncountered 库里存的是 ISO，展示层格式化；解析不了的老记录不显示日期。
        dateEncounteredText: store.isoToLabel(item.dateEncountered),
      }),
    });
    wx.setNavigationBarTitle({ title: `“${item.char}” 字卡` });
  },

  fetchInfo(char, standalone) {
    const that = this;
    this.setData({ loading: true });
    // 笔画数不信任模型：上游实测同一字多次调用能给出 13/14/12 三个答案，
    // 而这个数会写在字卡上、还会当书写批改的「标准」。笔顺 medians 是权威值，
    // 查字时并行拉一份（loadStrokeData 自带缓存，笔顺动画那一步不会再请求）。
    Promise.all([api.characterInfo(char), loadStrokeData(char)])
      .then(([info, glyph]) => {
        const authoritative = glyph && Array.isArray(glyph.medians) ? glyph.medians.length : 0;
        const strokeCount = authoritative || Number(info.strokeCount) || 0;

        if (standalone) {
          that.setData({
            loading: false,
            inBank: false,
            item: {
              id: `lookup-${char}`,
              char,
              pinyin: info.pinyin || '',
              radical: info.radical || '',
              strokeCount,
              meaning: info.meaning || '',
              words: info.words || [],
              wordsText: (info.words || []).join('、'),
              hasWords: (info.words || []).length > 0,
              exampleSentence: info.sentence || '',
              originStory: info.originStory || '',
              source: '课外书',
              sourceDetail: '临时查字',
              dateEncountered: store.todayISO(),
              dateEncounteredText: store.isoToLabel(store.todayISO()),
              // 临时查字的字不在字库里，掌握度无从谈起 —— 不挂 5 态里的任何一个。
              mastery: '未入字库',
            },
            notice: '',
          });
          return;
        }

        const state = that.state || store.loadState();
        const target = store.findByChar(state, char);
        if (target) {
          store.enrichCharacter(state, target.id, Object.assign({}, info, { strokeCount }));
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
