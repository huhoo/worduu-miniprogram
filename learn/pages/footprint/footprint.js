const store = require('../../../utils/store.js');
const audio = require('../../../utils/audio.js');

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

/** 把某月排成「周一到周日」的网格；月首前的空格子补 null。 */
function buildWeeks(year, month, footprintMap, todayISO) {
  const firstWeekday = (new Date(year, month - 1, 1).getDay() + 6) % 7; // 周一=0
  const daysInMonth = new Date(year, month, 0).getDate();
  const cells = [];
  for (let i = 0; i < firstWeekday; i += 1) cells.push(null);
  for (let d = 1; d <= daysInMonth; d += 1) {
    const iso = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    cells.push({ day: d, iso, count: footprintMap[iso] || 0, isToday: iso === todayISO });
  }
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

Page({
  data: {
    weekdays: WEEKDAYS,
    monthLabel: '',
    weeks: [],
    selected: null, // { iso, label, count, sourceText, chars: [{id, char}] }
    rangeMode: false,
    rangeStart: '',
    rangeEnd: '',
    rangeStartLabel: '',
    rangeEndLabel: '',
    rangeCount: 0,
    rangeIds: [],
    totalChars: 0,
  },

  onLoad() {
    const now = new Date();
    this.year = now.getFullYear();
    this.month = now.getMonth() + 1;
  },

  onShow() {
    this.refresh();
  },

  onHide() {
    audio.stopSpeaking();
  },

  refresh() {
    const state = store.loadState();
    this.state = state;

    // 足迹是字库在时间维度上的投影：按天聚合全部来自 dateEncountered，
    // 不建平行账本（平行账本会和字库漂移）。
    this.footprintMap = {};
    store.allFootprintDays(state).forEach((d) => {
      this.footprintMap[d.iso] = d.count;
    });

    this.setData({ totalChars: state.characters.length });
    this.renderMonth();
    if (this.data.selected) this.selectDay(this.data.selected.iso);
    if (this.data.rangeStart && this.data.rangeEnd) this.computeRange();
  },

  renderMonth() {
    const weeks = buildWeeks(this.year, this.month, this.footprintMap, store.todayISO());
    const { selected, rangeStart, rangeEnd } = this.data;
    weeks.forEach((week) =>
      week.forEach((cell) => {
        if (!cell) return;
        const cls = ['d'];
        if (cell.count > 0) cls.push('has');
        if (cell.isToday) cls.push('today');
        if (selected && selected.iso === cell.iso) cls.push('sel');
        if (rangeStart && cell.iso === rangeStart) cls.push('rs');
        if (rangeEnd && cell.iso === rangeEnd) cls.push('re');
        if (rangeStart && rangeEnd && cell.iso > rangeStart && cell.iso < rangeEnd) cls.push('rm');
        cell.cls = cls.join(' ');
      }),
    );
    this.setData({ monthLabel: `${this.year} 年 ${this.month} 月`, weeks });
  },

  prevMonth() {
    this.month -= 1;
    if (this.month < 1) {
      this.month = 12;
      this.year -= 1;
    }
    this.renderMonth();
  },

  nextMonth() {
    this.month += 1;
    if (this.month > 12) {
      this.month = 1;
      this.year += 1;
    }
    this.renderMonth();
  },

  /* ---------------- 选日 / 选范围 ---------------- */

  onDayTap(e) {
    const iso = e.currentTarget.dataset.iso;
    if (!iso) return;
    if (this.data.rangeMode) {
      this.tapRange(iso);
      return;
    }
    this.selectDay(iso);
  },

  selectDay(iso) {
    const chars = store.charsAddedOn(this.state, iso);
    const bySource = {};
    chars.forEach((c) => {
      const s = c.source || '其他';
      bySource[s] = (bySource[s] || 0) + 1;
    });
    const sourceText = Object.keys(bySource)
      .sort((a, b) => bySource[b] - bySource[a])
      .map((s) => `${bySource[s]} 字来自${s}`)
      .join('，');

    this.setData({
      selected: {
        iso,
        label: store.isoToLabel(iso),
        count: chars.length,
        sourceText,
        chars: chars.map((c) => ({ id: c.id, char: c.char })),
      },
    });
    this.renderMonth();
  },

  toggleRangeMode() {
    const on = !this.data.rangeMode;
    this.setData({
      rangeMode: on,
      // 退出选范围时清掉半截选择，避免残留一个只有起点的区间
      rangeStart: on ? this.data.rangeStart : '',
      rangeEnd: '',
      rangeCount: 0,
      rangeIds: [],
    });
    this.renderMonth();
  },

  /** 范围内点日：第一点定起点，第二点定终点（自动排序），第三点重新开始。 */
  tapRange(iso) {
    if (!this.data.rangeStart || this.data.rangeEnd) {
      this.setData({ rangeStart: iso, rangeEnd: '', rangeCount: 0, rangeIds: [] });
      this.renderMonth();
      return;
    }
    const a = this.data.rangeStart;
    const start = a <= iso ? a : iso;
    const end = a <= iso ? iso : a;
    this.setData({ rangeStart: start, rangeEnd: end }, () => {
      this.renderMonth();
      this.computeRange();
    });
  },

  computeRange() {
    const { rangeStart, rangeEnd } = this.data;
    if (!rangeStart || !rangeEnd) return;
    const chars = store.charsAddedBetween(this.state, rangeStart, rangeEnd);
    this.setData({
      rangeCount: chars.length,
      rangeIds: chars.map((c) => c.id),
      rangeStartLabel: store.isoToLabel(rangeStart),
      rangeEndLabel: store.isoToLabel(rangeEnd),
    });
  },

  /* ---------------- 带去默写 / 复习 ---------------- */

  dictateDay() {
    this.goDictation((this.data.selected && this.data.selected.chars.map((c) => c.id)) || []);
  },

  dictateRange() {
    this.goDictation(this.data.rangeIds);
  },

  reviewDay() {
    const ids = (this.data.selected && this.data.selected.chars.map((c) => c.id)) || [];
    if (!ids.length) {
      wx.showToast({ title: '当天没有新增生字', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: `/learn/pages/quiz/quiz?chars=${ids.join(',')}` });
  },

  goDictation(ids) {
    if (!ids.length) {
      wx.showToast({ title: '这批字不在字库里', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: `/learn/pages/dictation/dictation?chars=${ids.join(',')}` });
  },

  openDetail(e) {
    wx.navigateTo({ url: `/learn/pages/detail/detail?id=${e.currentTarget.dataset.id}` });
  },
});
