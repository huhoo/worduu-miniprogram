/**
 * 阅读伴读。
 *
 * 三种模式沿用 Web 版 ReadingCompanionView：逐句朗读 / 整页朗读 / 自由阅读。
 * 两处小程序特有的取舍：
 *
 * 1. 语速不进合成参数，改由播放器 playbackRate 实现（0.8x / 1.0x / 1.2x），
 *    换语速不用重新请求云端，也不会出现"合成中改速度无效"。
 * 2. 云上合成失败时**不假装读过** —— 明确提示这次没朗读出来，
 *    孩子可以自己读。伴读是辅助，静默失败会让家长以为播过了。
 */

const store = require('../../utils/store.js');
const audio = require('../../utils/audio.js');
const ARTICLES = require('../../utils/data/articles.js');

const MODES = [
  { key: 'sentence', label: '逐句朗读', hint: '伴读机器人按句子逐句朗读并高亮，适合低年级跟读。' },
  { key: 'page', label: '整页朗读', hint: '流畅朗读完整篇文章，帮助孩子把握整体语感。' },
  { key: 'free', label: '自由阅读', hint: '关闭语音伴读，不替代孩子自己阅读，遇到陌生字随时点击查阅。' },
];

const RATES = [0.8, 1.0, 1.2];
const PUNCT = /[，。！？、；：""''（）《》\s·—…]/;

Page({
  data: {
    article: null,
    paragraphs: [],
    modes: MODES,
    rates: RATES,
    mode: 'sentence',
    modeHint: MODES[0].hint,
    rate: 1.0,
    playing: false,
    currentIdx: -1,
    totalSentences: 0,
    highlightVocab: true,
    progress: 0,
    showSettings: false,
    synthesizing: false,
    notice: '',
    currentLabel: '待播放',
  },

  onLoad(options) {
    const article = ARTICLES.find((a) => a.id === options.id) || ARTICLES[0];
    if (!article) {
      this.setData({ notice: '没有找到这本书' });
      return;
    }

    this.sentences = article.paragraphs;
    this.sessionId = 0;
    this.timer = null;

    const state = store.loadState();
    const vocabSet = new Set(article.suggestedVocab);
    const paragraphs = this.sentences.map((sentence, pIdx) => ({
      index: pIdx,
      chars: sentence.split('').map((ch) => ({
        ch,
        isPunct: PUNCT.test(ch),
        isVocab: vocabSet.has(ch),
      })),
    }));

    this.setData({
      article,
      paragraphs,
      totalSentences: this.sentences.length,
    });
    wx.setNavigationBarTitle({ title: article.title });
  },

  onUnload() {
    this.stopAll();
  },

  onHide() {
    this.stopAll();
  },

  stopAll() {
    this.sessionId += 1;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    audio.stopSpeaking();
    this.setData({ playing: false, synthesizing: false, currentIdx: -1, currentLabel: '待播放', progress: 0 });
  },

  /* ---------------- 播放控制 ---------------- */

  togglePlay() {
    if (this.data.playing) {
      this.stopAll();
      return;
    }
    if (this.data.mode === 'free') return;

    this.setData({ playing: true, notice: '' });
    if (this.data.mode === 'page') {
      this.playPage();
      return;
    }
    const start = this.data.currentIdx >= 0 && this.data.currentIdx < this.sentences.length - 1
      ? this.data.currentIdx
      : 0;
    this.playFrom(start);
  },

  playFrom(index) {
    if (index >= this.sentences.length) {
      this.stopAll();
      return;
    }

    const sid = this.sessionId;
    this.setData({
      currentIdx: index,
      currentLabel: `第 ${index + 1} 句`,
      progress: Math.round(((index + 1) / this.sentences.length) * 100),
      synthesizing: true,
    });

    audio.playSentence({
      text: this.sentences[index],
      rate: this.data.rate,
      onStart: () => {
        if (sid === this.sessionId) this.setData({ synthesizing: false });
      },
      onEnd: () => {
        if (sid !== this.sessionId) return; // 已经暂停或换过句子
        if (this.data.playing && this.data.mode === 'sentence' && index < this.sentences.length - 1) {
          this.timer = setTimeout(() => {
            this.timer = null;
            this.playFrom(index + 1);
          }, 600);
          return;
        }
        this.setData({ playing: false, synthesizing: false, currentIdx: -1, currentLabel: '待播放' });
      },
      onError: () => {
        if (sid !== this.sessionId) return;
        this.setData({
          playing: false,
          synthesizing: false,
          notice: '这次没能朗读出来（需要云端语音服务），可以陪孩子自己读。',
        });
      },
    });
  },

  playPage() {
    const sid = this.sessionId;
    this.setData({
      currentIdx: -1,
      currentLabel: '整页朗读',
      progress: 100,
      synthesizing: true,
    });

    audio.playSentence({
      text: this.sentences.join(''),
      rate: this.data.rate,
      onStart: () => {
        if (sid === this.sessionId) this.setData({ synthesizing: false });
      },
      onEnd: () => {
        if (sid !== this.sessionId) return;
        this.setData({ playing: false, synthesizing: false, currentIdx: -1, currentLabel: '待播放', progress: 0 });
      },
      onError: () => {
        if (sid !== this.sessionId) return;
        this.setData({
          playing: false,
          synthesizing: false,
          notice: '这次没能朗读出来（需要云端语音服务），可以陪孩子自己读。',
        });
      },
    });
  },

  replay() {
    this.stopAll();
    this.setData({ playing: true, notice: '' });
    if (this.data.mode === 'page') {
      this.playPage();
      return;
    }
    this.playFrom(0);
  },

  /* ---------------- 设置 ---------------- */

  openSettings() {
    this.setData({ showSettings: true });
  },

  closeSettings() {
    this.setData({ showSettings: false });
  },

  /** 弹层内部的空点击，用来阻止冒泡到遮罩导致误关。 */
  noop() {},

  pickMode(e) {
    const key = e.currentTarget.dataset.key;
    const mode = MODES.find((m) => m.key === key) || MODES[0];
    this.stopAll();
    this.setData({ mode: key, modeHint: mode.hint });
  },

  pickRate(e) {
    const rate = Number(e.currentTarget.dataset.rate);
    if (!rate || rate === this.data.rate) return;

    const wasPlaying = this.data.playing;
    this.setData({ rate });
    if (!wasPlaying) return;

    // 语速是播放器的 playbackRate，改了要对当前这句重新起播才听得出差别。
    // 不这么做的话，界面显示 1.2x 而耳朵听到的还是原速，等于骗人。
    this.sessionId += 1;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    audio.stopSpeaking();
    this.setData({ playing: true });
    if (this.data.mode === 'page') {
      this.playPage();
      return;
    }
    this.playFrom(this.data.currentIdx >= 0 ? this.data.currentIdx : 0);
  },

  toggleHighlight() {
    this.setData({ highlightVocab: !this.data.highlightVocab });
  },

  applyAndPlay() {
    this.setData({ showSettings: false });
    this.togglePlay();
  },

  /* ---------------- 点字查义 ---------------- */

  openChar(e) {
    const ch = e.currentTarget.dataset.char;
    if (!ch || PUNCT.test(ch)) return;
    wx.navigateTo({ url: `/pages/detail/detail?char=${encodeURIComponent(ch)}` });
  },
});
