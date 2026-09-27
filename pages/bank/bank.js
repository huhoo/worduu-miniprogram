const store = require('../../utils/store.js');
const audio = require('../../utils/audio.js');

const TABS = [
  { key: '全部', match: () => true },
  { key: '学习中', match: (c) => c.mastery === '基本掌握' || c.mastery === '不熟' },
  { key: '已掌握', match: (c) => c.mastery === '熟练' },
  { key: '待复习', match: (c) => c.mastery === '待复习' || c.mastery === '不熟' },
  { key: '经常读错', match: (c) => c.mastery === '经常读错' },
];

Page({
  data: {
    tabs: [],
    activeTab: '全部',
    keyword: '',
    list: [],
    total: 0,
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
      if (m === '熟练') return 'green';
      if (m === '基本掌握') return 'blue';
      if (m === '待复习') return 'amber';
      if (m === '经常读错') return 'rose';
      return 'amber';
    };

    const enriched = state.characters.map((c) =>
      Object.assign({}, c, {
        wordsText: (c.words || []).join('、'),
        masteryClass: masteryClass(c.mastery),
        haystack: `${c.char}${c.pinyin}${(c.words || []).join('')}`.toLowerCase(),
      }),
    );

    const tabs = TABS.map((t) =>
      Object.assign({}, t, { count: state.characters.filter(t.match).length }),
    );

    this.all = enriched;
    this.setData({ tabs, total: state.characters.length });
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
    wx.navigateTo({ url: `/pages/detail/detail?id=${e.currentTarget.dataset.id}` });
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

  goQuiz() {
    if (this.all.length === 0) {
      wx.showToast({ title: '字库还是空的，先去拍照识字', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/pages/quiz/quiz' });
  },

  goOcr() {
    wx.navigateTo({ url: '/pages/ocr/ocr' });
  },
});
