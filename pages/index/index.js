const store = require('../../utils/store.js');

const MODULES = [
  {
    key: 'ocr',
    title: '拍照学习',
    subtitle: '拍课本/课外书，自动识别生字',
    emoji: '📷',
    badge: 'OCR识别',
    bg: '#FEF3C7',
    fg: '#B45309',
  },
  {
    key: 'quiz',
    title: '识字认读',
    subtitle: '看字读音，逐字过关',
    emoji: '🔊',
    badge: '认读评测',
    bg: '#DBEAFE',
    fg: '#1D4ED8',
  },
  {
    key: 'write',
    title: '规范写字',
    subtitle: '笔顺动画，跟写与独立写',
    emoji: '✍️',
    badge: '笔画核对',
    bg: '#FFE4E6',
    fg: '#BE123C',
  },
  {
    key: 'dictation',
    title: '听写默写',
    subtitle: '听音写字，AI 核对字形',
    emoji: '🎧',
    badge: '听写测试',
    bg: '#EDE9FE',
    fg: '#6D28D9',
  },
  {
    key: 'bank',
    title: '我的字库',
    subtitle: '查字、复习、听发音',
    emoji: '📚',
    badge: '生字管理',
    bg: '#D1FAE5',
    fg: '#047857',
  },
  {
    key: 'profile',
    title: '识字档案',
    subtitle: '熟练率、错字与学情小结',
    emoji: '📈',
    badge: '学情档案',
    bg: '#F5F3FF',
    fg: '#5B21B6',
  },
  {
    key: 'shelf',
    title: '阅读伴读',
    subtitle: '逐句朗读，点字查义',
    emoji: '🦉',
    badge: 'AI 伴读',
    bg: '#CFFAFE',
    fg: '#0E7490',
  },
  {
    key: 'achievement',
    title: '成就分享',
    subtitle: '生成奖状，发给亲友',
    emoji: '🏆',
    badge: '亲友点赞',
    bg: '#FFE4E6',
    fg: '#BE123C',
  },
];

Page({
  data: {
    modules: MODULES,
    // 先给一份零值，避免首帧渲染时 WXML 取 null 的属性。
    stats: {
      studyTimeMinutes: 0,
      todayLearnedCount: 0,
      todayMasteredCount: 0,
      todayReviewCount: 0,
      mastered: 0,
    },
    recentChars: [],
    childNickname: '',
    total: 0,
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    const state = store.loadState();
    // 计时统一在 app.js 的前台时长里做（onShow/onHide 打点），
    // 首页不再自己累计 —— 两处同时累加会把伴读时长算成双倍。
    const stats = store.buildStats(state, store.getStudyMinutes());

    this.setData({
      stats,
      childNickname: state.childNickname,
      total: state.characters.length,
      recentChars: state.characters.slice(0, 4).map((c) => ({
        id: c.id,
        char: c.char,
        pinyin: c.pinyin,
        mastery: c.mastery,
        source: c.source,
      })),
    });
  },

  goModule(e) {
    const key = e.currentTarget.dataset.key;
    const map = {
      ocr: '/pages/ocr/ocr',
      quiz: '/learn/pages/quiz/quiz',
      write: '/learn/pages/write/write',
      dictation: '/learn/pages/dictation/dictation',
      bank: '/pages/bank/bank',
      profile: '/pages/profile/profile',
      shelf: '/learn/pages/shelf/shelf',
      achievement: '/learn/pages/achievement/achievement',
    };
    if (map[key]) wx.navigateTo({ url: map[key] });
  },

  openBank() {
    wx.navigateTo({ url: '/pages/bank/bank' });
  },

  openChar(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/learn/pages/detail/detail?id=${id}` });
  },
});
