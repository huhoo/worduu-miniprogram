const store = require('../../utils/store.js');
const audio = require('../../utils/audio.js');

const M = store.MASTERY;

/** 掌握度 tab：与 5 态状态机一一对应（PRD 8.4），不再有 4 值时代的「学习中」这种混合桶。 */
const TABS = [
  { key: '全部', match: () => true },
  { key: M.NEW, match: (c) => c.mastery === M.NEW },
  { key: M.LEARNING, match: (c) => c.mastery === M.LEARNING },
  { key: M.WEAK, match: (c) => c.mastery === M.WEAK },
  { key: M.MASTERED, match: (c) => c.mastery === M.MASTERED },
  { key: M.REVIEW, match: (c) => c.mastery === M.REVIEW },
];

Page({
  data: {
    tabs: [],
    activeTab: '全部',
    keyword: '',
    list: [],
    total: 0,
    // 默写库卡片（PRD 9.5：生字库页顶部常驻）
    poolCount: 0,
    poolOldest: null, // { char, days } 最久未过的字；无入池时间记录时为 null
    footprintDays: 0, // 有足迹的天数（足迹入口的副标题用）
  },

  onShow() {
    this.refresh();
  },

  onHide() {
    audio.stopSpeaking();
  },

  refresh() {
    this.state = store.loadState();
    const state = this.state;

    // WXML 不能调 .join()，搜索用的组词文本在这里先拼好。
    // mastery 是中文，不能直接当 class 名用，这里映射一份。
    const masteryClass = (m) => {
      if (m === M.MASTERED) return 'green';
      if (m === M.LEARNING) return 'blue';
      if (m === M.WEAK) return 'rose';
      if (m === M.REVIEW) return 'amber';
      return 'plain'; // 新加入
    };

    const enriched = state.characters.map((c) =>
      Object.assign({}, c, {
        wordsText: (c.words || []).join('、'),
        masteryClass: masteryClass(c.mastery),
        dateEncounteredText: store.isoToLabel(c.dateEncountered) || '加入时间不详',
        haystack: `${c.char}${c.pinyin}${(c.words || []).join('')}`.toLowerCase(),
      }),
    );

    const tabs = TABS.map((t) =>
      Object.assign({}, t, { count: state.characters.filter(t.match).length }),
    );

    // 默写库摘要：池内字数 + 最久未过的字。迁移字没有入池时间记录，
    // 不参与「最久」计算 —— 不知道就不说。
    const pool = store.poolChars(state);
    let poolOldest = null;
    pool.forEach((c) => {
      if (!c.enteredPoolAt) return;
      const days = Math.floor(
        (Date.now() - new Date(`${c.enteredPoolAt}T00:00:00`).getTime()) / 86400000,
      );
      if (!poolOldest || days > poolOldest.days) poolOldest = { char: c.char, days };
    });

    this.all = enriched;
    this.setData({
      tabs,
      total: state.characters.length,
      poolCount: pool.length,
      poolOldest,
      footprintDays: store.allFootprintDays(state).length,
    });
    this.applyFilter();
  },

  applyFilter() {
    const tab = TABS.find((t) => t.key === this.data.activeTab) || TABS[0];
    const keyword = (this.data.keyword || '').trim().toLowerCase();

    const list = this.all.filter((c) => {
      if (!tab.match(c)) return false;
      if (!keyword) return true;
      return c.haystack.indexOf(keyword) !== -1;
    });

    this.setData({ list });
  },

  onTabTap(e) {
    this.setData({ activeTab: e.currentTarget.dataset.key }, () => this.applyFilter());
  },

  onSearch(e) {
    this.setData({ keyword: e.detail.value }, () => this.applyFilter());
  },

  openDetail(e) {
    wx.navigateTo({ url: `/learn/pages/detail/detail?id=${e.currentTarget.dataset.id}` });
  },

  playChar(e) {
    const id = e.currentTarget.dataset.id;
    const item = this.all.find((c) => c.id === id);
    if (!item) return;
    audio.playCharAudio({
      char: item.char,
      pinyin: item.pinyin,
      sampleWord: (item.words || [])[0],
      mode: 'read',
    });
  },

  /** 从生字库直达书写页，不必先进字卡绕一步。 */
  goWrite(e) {
    const char = e.currentTarget.dataset.char;
    if (!char) return;
    wx.navigateTo({ url: `/learn/pages/write/write?char=${encodeURIComponent(char)}` });
  },

  goQuiz() {
    if (this.all.length === 0) {
      wx.showToast({ title: '字库还是空的，先去拍照识字', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/learn/pages/quiz/quiz' });
  },

  goPool() {
    wx.navigateTo({ url: '/learn/pages/pool/pool' });
  },

  goFootprint() {
    wx.navigateTo({ url: '/learn/pages/footprint/footprint' });
  },

  goOcr() {
    wx.navigateTo({ url: '/pages/ocr/ocr' });
  },
});
