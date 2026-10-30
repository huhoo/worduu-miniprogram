const store = require('../../utils/store.js');
const audio = require('../../utils/audio.js');

/**
 * 生字库页（2026-10-30 重构）：删掉「学习足迹」入口与汉字列表，
 * 只保留待巩固默写库卡片与认读测试入口。后续人教版教材库 / 自建多库
 * 的树形列表在 R4 一并接入。
 */
Page({
  data: {
    total: 0, // 字库总字数（认读测试按钮副标题用）
    poolCount: 0,
    poolOldest: null, // { char, days } 最久未过的字；无入池时间记录时为 null
  },

  onShow() {
    this.refresh();
  },

  onHide() {
    audio.stopSpeaking();
  },

  refresh() {
    const state = store.loadState();

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

    this.setData({
      total: state.characters.length,
      poolCount: pool.length,
      poolOldest,
    });
  },

  goQuiz() {
    if (this.data.total === 0) {
      wx.showToast({ title: '字库还是空的，先去拍照识字', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/learn/pages/quiz/quiz' });
  },

  goPool() {
    wx.navigateTo({ url: '/learn/pages/pool/pool' });
  },

  goOcr() {
    wx.navigateTo({ url: '/pages/ocr/ocr' });
  },
});
