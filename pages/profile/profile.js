const store = require('../../utils/store.js');

const RING = 176; // 熟练率圆环的画布边长（px）
const SLOW_THRESHOLD = 2.5; // 反应超过 2.5 秒算「偏慢」，与 Web 版一致

/** 掌握度 -> 标签配色，与字库页保持同一套。 */
function masteryClass(level) {
  if (level === '熟练') return 'is-ok';
  if (level === '经常读错') return 'is-bad';
  if (level === '不熟' || level === '待复习') return 'is-amber';
  return 'is-blue';
}

/** 「春、蝶、森 等」这种列表文本。WXML 不支持 join，只能在 JS 里拼好。 */
function joinChars(list, limit) {
  const head = list.slice(0, limit).map((c) => c.char).join('、');
  return head + (list.length > limit ? ' 等' : '');
}

Page({
  data: {
    segment: 'profile', // profile 我的档案 | parent 家长学情端
    stats: {
      studyTimeMinutes: 0,
      todayLearnedCount: 0,
      todayMasteredCount: 0,
      todayReviewCount: 0,
      mastered: 0,
      basic: 0,
      unfamiliar: 0,
      frequentError: 0,
    },
    total: 0,
    masteryRate: 0,
    errorCount: 0,
    buckets: [],
    memoryList: [],
    canDictate: 0,
    hasAny: false,
    hasErrors: false,
    hasSlow: false,
    solidSummary: '',
    errorSummary: '',
    slowSummary: '',
    childNickname: '',
  },

  onLoad() {
    this.refresh();
  },

  onShow() {
    // 从认读、听写、写字页返回后数字会变，每次显示都重算一遍。
    this.refresh();
  },

  refresh() {
    const state = store.loadState();
    const stats = store.buildStats(state, store.getStudyMinutes());
    const characters = state.characters;
    const total = characters.length;

    const pct = (value) => (total > 0 ? Math.round((value / total) * 100) : 0);

    const solidChars = characters.filter((c) => c.mastery === '熟练');
    const errorChars = characters.filter((c) => c.mastery === '经常读错');
    const slowChars = characters.filter(
      (c) => Number(c.reactionTimeSeconds) > SLOW_THRESHOLD,
    );
    const canDictate = characters.filter((c) => c.canDictate).length;

    const buckets = [
      { name: '熟练', color: '#10B981', count: stats.mastered, pct: pct(stats.mastered) },
      { name: '基本掌握', color: '#60A5FA', count: stats.basic, pct: pct(stats.basic) },
      { name: '不熟', color: '#FBBF24', count: stats.unfamiliar, pct: pct(stats.unfamiliar) },
      { name: '经常读错', color: '#F43F5E', count: stats.frequentError, pct: pct(stats.frequentError) },
    ];

    const memoryList = characters.slice(0, 6).map((c) => ({
      id: c.id,
      char: c.char,
      source: c.source || '课外书',
      mastery: c.mastery || '不熟',
      masteryClass: masteryClass(c.mastery),
      note: c.memoryNote || `“${c.char}”来自${c.sourceDetail || c.source || '课外书'}，当前状态为${c.mastery || '不熟'}。`,
    }));

    this.setData({
      stats,
      total,
      masteryRate: pct(stats.mastered),
      buckets,
      memoryList,
      canDictate,
      hasAny: total > 0,
      hasErrors: errorChars.length > 0,
      hasSlow: slowChars.length > 0,
      childNickname: state.childNickname || '孩子',
      solidSummary:
        solidChars.length > 0
          ? `${solidChars.length} 个字认读熟练（${joinChars(solidChars, 6)}）`
          : '还没有标记为熟练的字',
      errorSummary: `${errorChars.length} 个字朗读出错（${joinChars(errorChars, 8)}）`,
      slowSummary: `${slowChars.length} 个字认读用时超过 ${SLOW_THRESHOLD} 秒（${slowChars
        .slice(0, 6)
        .map((c) => `“${c.char}”约 ${c.reactionTimeSeconds} 秒`)
        .join('，')}${slowChars.length > 6 ? ' 等' : ''}）`,
      errorCount: errorChars.length,
    });

    if (wx.nextTick) wx.nextTick(() => this.drawRing());
    else setTimeout(() => this.drawRing(), 30);
  },

  switchSegment(e) {
    const segment = e.currentTarget.dataset.segment;
    if (segment === this.data.segment) return;
    this.setData({ segment });
    // 切回档案段时 canvas 是新节点，要重新取一次。
    if (wx.nextTick) wx.nextTick(() => this.drawRing());
    else setTimeout(() => this.drawRing(), 30);
  },

  /** 熟练率圆环。小程序没有 SVG，用 canvas 2d 画。 */
  drawRing() {
    const query = wx.createSelectorQuery();
    query
      .select('#ring-canvas')
      .fields({ node: true, size: true })
      .exec((res) => {
        if (!res || !res[0] || !res[0].node) return;
        const canvas = res[0].node;
        const ctx = canvas.getContext('2d');
        const dpr = wx.getSystemInfoSync().pixelRatio || 2;
        canvas.width = RING * dpr;
        canvas.height = RING * dpr;
        ctx.scale(dpr, dpr);

        const cx = RING / 2;
        const cy = RING / 2;
        const radius = RING / 2 - 14;
        const percent = Math.max(0, Math.min(100, this.data.masteryRate));

        ctx.clearRect(0, 0, RING, RING);
        ctx.lineCap = 'round';
        ctx.lineWidth = 14;

        ctx.strokeStyle = '#F5F5F4';
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.stroke();

        if (percent > 0) {
          ctx.strokeStyle = '#059669';
          ctx.beginPath();
          // 从 12 点方向顺时针画到对应百分比。
          ctx.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + (percent / 100) * Math.PI * 2);
          ctx.stroke();
        }
      });
  },

  reviewErrors() {
    if (!this.data.hasErrors) return;
    wx.navigateTo({ url: '/learn/pages/quiz/quiz' });
  },

  openBank() {
    wx.navigateTo({ url: '/pages/bank/bank' });
  },

  openChar(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/learn/pages/detail/detail?id=${id}` });
  },

  goOcr() {
    wx.navigateTo({ url: '/pages/ocr/ocr' });
  },

  goHelp() {
    wx.navigateTo({ url: '/pages/help/help' });
  },
});
