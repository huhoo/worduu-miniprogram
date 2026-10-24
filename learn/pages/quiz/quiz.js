const store = require('../../../utils/store.js');
const audio = require('../../../utils/audio.js');

const M = store.MASTERY;
const MAX_QUESTIONS = 10;

Page({
  data: {
    queue: [],
    current: null,
    index: 0,
    total: 0,
    showPinyin: false,
    answered: false,
    isCorrect: false,
    feedback: '',
    responseTime: 0,
    done: false,
    correctCount: 0,
    wrongList: [],
    percent: 0,
  },

  onLoad(options) {
    const state = store.loadState();
    this.state = state;

    // 预设字集：从学习足迹日详情「复习这批字」带入（R2 窄集成）。
    const presetIds =
      options && typeof options.chars === 'string' && options.chars
        ? options.chars.split(',').filter(Boolean)
        : [];

    let queue;
    if (presetIds.length) {
      const wanted = new Set(presetIds);
      queue = shuffle(state.characters.filter((c) => wanted.has(c.id)).slice(0, MAX_QUESTIONS));
      if (presetIds.length > queue.length) {
        wx.showToast({
          title: `已按足迹带入 ${presetIds.length} 字，本批先测 ${queue.length} 字`,
          icon: 'none',
        });
      }
    } else {
      // 出卷：先考待巩固的错字，再考前三种未闭环状态，已掌握的押后。
      // 掌握度只由默写驱动（R2），这里排的是「该趁热打铁认读」的优先级。
      const pool = state.characters;
      const weak = pool.filter((c) => c.mastery === M.WEAK);
      const pending = pool.filter(
        (c) => c.mastery === M.NEW || c.mastery === M.LEARNING || c.mastery === M.REVIEW,
      );
      const rest = pool.filter((c) => c.mastery === M.MASTERED);

      queue = shuffle(weak.concat(shuffle(pending), shuffle(rest)).slice(0, MAX_QUESTIONS));
    }

    if (queue.length === 0) {
      this.setData({ total: 0 });
      return;
    }

    this.queue = queue;
    this.log = [];
    this.startQuestion(0);
  },

  onHide() {
    audio.stopSpeaking();
  },

  startQuestion(index) {
    const item = this.queue[index];
    this.mark = Date.now();
    this.setData({
      index,
      total: this.queue.length,
      // WXML 里写 `<` 比较容易被当成标签，这里先算好。
      isLast: index >= this.queue.length - 1,
      current: Object.assign({}, item, {
        wordsText: (item.words || []).join('、'),
      }),
      showPinyin: false,
      answered: false,
      isCorrect: false,
      feedback: '',
      responseTime: 0,
    });
    wx.setNavigationBarTitle({ title: `认读 ${index + 1}/${this.queue.length}` });
  },

  togglePinyin() {
    this.setData({ showPinyin: !this.data.showPinyin });
  },

  playRead() {
    const item = this.data.current;
    if (!item) return;
    audio.playCharAudio({
      char: item.char,
      pinyin: item.pinyin,
      sampleWord: (item.words || [])[0],
      mode: 'read',
    });
  },

  playSpell() {
    const item = this.data.current;
    if (!item) return;
    audio.playCharAudio({
      char: item.char,
      pinyin: item.pinyin,
      sampleWord: (item.words || [])[0],
      mode: 'spell',
    });
  },

  /**
   * 记录一次判断。
   *
   * 小程序没有浏览器那种语音识别能力，这里由家长旁听后点选 ——
   * 这是真实的人工判断，不是伪造的 AI 评分，页面上也如实写明。
   */
  answer(e) {
    if (this.data.answered) return;
    // dataset 的类型在不同基础库下可能是布尔也可能是字符串，两种都认。
    const raw = e.currentTarget.dataset.pass;
    const correct = raw === true || raw === 'true';
    const seconds = Math.max(0.6, Math.round(((Date.now() - this.mark) / 100) | 0) / 10);

    const item = this.data.current;
    const state = this.state;

    // 认读结果只记事实（会不会/多久/错几次），不改掌握度 —— 5 态状态机
    // 的所有流转都指向默写任务（PRD 8.4）。
    store.recordReadingResult(state, item.id, correct, seconds);
    store.saveState(state);

    this.log = this.log.filter((entry) => entry.char !== item.char).concat([
      { char: item.char, pinyin: item.pinyin, correct },
    ]);

    if (correct) audio.soundEffects.playSuccess();
    else audio.soundEffects.playNotice();

    this.setData({
      answered: true,
      isCorrect: correct,
      showPinyin: true,
      responseTime: seconds,
      feedback: correct
        ? '读得很好！本次认读已记录。'
        : `这个字读作“${item.pinyin}”，多跟读两遍，之后再考你。`,
      correctCount: this.data.correctCount + (correct ? 1 : 0),
    });
  },

  next() {
    if (this.data.index < this.queue.length - 1) {
      this.startQuestion(this.data.index + 1);
      return;
    }
    this.finish();
  },

  finish() {
    const total = this.queue.length || 1;
    const correctCount = this.data.correctCount;
    const wrongList = this.log.filter((entry) => !entry.correct);

    this.setData({
      done: true,
      wrongList,
      percent: Math.round((correctCount / total) * 100),
    });
    wx.setNavigationBarTitle({ title: '本次挑战报告' });
  },

  playWrong(e) {
    const char = e.currentTarget.dataset.char;
    const entry = this.data.wrongList.find((w) => w.char === char);
    if (!entry) return;
    audio.playCharAudio({ char: entry.char, pinyin: entry.pinyin, mode: 'read' });
  },

  backHome() {
    wx.navigateBack({
      fail() {
        wx.redirectTo({ url: '/pages/index/index' });
      },
    });
  },

  goOcr() {
    wx.redirectTo({ url: '/pages/ocr/ocr' });
  },

  /** 带着本次成绩去生成成就卡。标题与评语沿用 Web 版 triggerAchievementCard 的措辞。 */
  goAchievement() {
    const percent = this.data.percent;
    const chars = (this.log || []).map((entry) => entry.char).slice(0, 4).join(',');
    const title = percent >= 90 ? '认读测试大满贯！' : '完成认读通关挑战！';
    const score = `正确率 ${percent}%`;
    const praise = percent >= 90
      ? '字音脱口而出，认读非常熟练！'
      : '坚持练习，每一个汉字都记得更牢固了！';

    wx.navigateTo({
      url: `/learn/pages/achievement/achievement?type=reading_test&title=${encodeURIComponent(title)}`
        + `&score=${encodeURIComponent(score)}&praise=${encodeURIComponent(praise)}`
        + `&chars=${encodeURIComponent(chars)}`,
    });
  },
});

function shuffle(list) {
  const arr = list.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}
