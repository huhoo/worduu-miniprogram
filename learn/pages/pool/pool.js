const store = require('../../../utils/store.js');
const audio = require('../../../utils/audio.js');
const parent = require('../../../utils/parent.js');

const M = store.MASTERY;
const EXIT_WINDOW_DAYS = 7; // 「已出库」折叠区只看最近 7 天

Page({
  data: {
    pool: [], // { id, char, pinyin, streak, progressPct, metaText }
    exited: [], // { char } 最近出库
    lastExitLabel: '', // 最近一次过关时间（不限 7 天）
    pwdModal: false,
    pwdMode: 'set', // set 首次设置 | verify 验证
    pwdInput: '',
    pwdError: '',
    pendingExit: null, // { id, char } 等待密码通过后出库的字
  },

  onShow() {
    this.refresh();
  },

  onHide() {
    audio.stopSpeaking();
  },

  refresh() {
    const state = store.loadState();

    const pool = store.poolChars(state).map((c) => {
      let metaText = `累计错 ${c.errorCount || 0} 次`;
      if (c.enteredPoolAt) {
        const days = Math.floor(
          (Date.now() - new Date(`${c.enteredPoolAt}T00:00:00`).getTime()) / 86400000,
        );
        metaText += ` · ${days <= 0 ? '今天' : `${days} 天前`}入池`;
      }
      // 迁移字没有入池时间记录：只报真实有的（错次），不显示天数。
      return {
        id: c.id,
        char: c.char,
        pinyin: c.pinyin || '',
        streak: c.correctStreak || 0,
        progressPct: Math.round(((c.correctStreak || 0) / store.POOL_EXIT_STREAK) * 100),
        metaText,
      };
    });

    const exited = store
      .recentlyExitedChars(state, EXIT_WINDOW_DAYS)
      .map((c) => ({ char: c.char }));

    // 空池庆祝态的「最近一次过关时间」：全部有出库记录里最新的，不限 7 天。
    const allExits = state.characters
      .filter((c) => c.mastery === M.MASTERED && c.poolExitedAt)
      .sort((a, b) => (a.poolExitedAt < b.poolExitedAt ? 1 : -1));

    this.state = state;
    this.setData({
      pool,
      exited,
      lastExitLabel: allExits.length ? store.isoToLabel(allExits[0].poolExitedAt) : '',
    });
  },

  openDetail(e) {
    wx.navigateTo({ url: `/learn/pages/detail/detail?id=${e.currentTarget.dataset.id}` });
  },

  /** 单字再默 / 一键再默：整批带入听写页（R2 窄集成，完整范围设定在 R3）。 */
  reDictate(e) {
    this.goDictation([e.currentTarget.dataset.id]);
  },

  reDictateAll() {
    this.goDictation(this.data.pool.map((c) => c.id));
  },

  goDictation(ids) {
    if (!ids.length) {
      wx.showToast({ title: '池子里还没有字', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: `/learn/pages/dictation/dictation?chars=${ids.join(',')}` });
  },

  /* ---------------- 家长密码 + 手动出库 ---------------- */

  askManualExit(e) {
    this.setData({
      pendingExit: { id: e.currentTarget.dataset.id, char: e.currentTarget.dataset.char },
      pwdMode: parent.hasPassword() ? 'verify' : 'set',
      pwdInput: '',
      pwdError: '',
      pwdModal: true,
    });
  },

  onPwdInput(e) {
    this.setData({ pwdInput: e.detail.value });
  },

  dismissPwd() {
    this.setData({ pwdModal: false, pwdInput: '', pwdError: '', pendingExit: null });
  },

  noop() {},

  confirmPwd() {
    const pwd = this.data.pwdInput;
    if (!parent.isValid(pwd)) {
      this.setData({ pwdError: `请输入 ${parent.MIN_LEN}-${parent.MAX_LEN} 位数字` });
      return;
    }

    if (this.data.pwdMode === 'set') {
      if (!parent.setPassword(pwd)) {
        this.setData({ pwdError: '设置失败，请重试' });
        return;
      }
    } else if (!parent.verify(pwd)) {
      this.setData({ pwdError: '密码不对，再试一次' });
      return;
    }

    const pending = this.data.pendingExit;
    this.setData({ pwdModal: false, pwdInput: '', pwdError: '', pendingExit: null });

    if (pending && store.manualPoolExit(this.state, pending.id)) {
      store.saveState(this.state);
      wx.showToast({ title: `“${pending.char}”已出库`, icon: 'success' });
    }
    this.refresh();
  },
});
