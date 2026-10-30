/**
 * 首页 Hub（R1 重做，照原型 home-reading）。
 *
 * 品牌头 + 四大入口 + 阅读伴读行卡。首页不再堆统计与最近生字——
 * 那些数据在生字库和识字档案里看，首页只做启动台（原型即如此，
 * 也避免首页变成第二张报表）。
 */
Page({
  goModule(e) {
    const key = e.currentTarget.dataset.key;
    const map = {
      ocr: '/pages/ocr/ocr',
      write: '/learn/pages/write/write',
      bank: '/pages/bank/bank',
      dictation: '/learn/pages/dictation/dictation',
      shelf: '/learn/pages/shelf/shelf',
    };
    if (map[key]) wx.navigateTo({ url: map[key] });
  },

  openBank() {
    wx.navigateTo({ url: '/pages/bank/bank' });
  },

  /** 右上角钟表 = 学习足迹（历史轨迹），2026-10-29 用户拍板。 */
  openFootprint() {
    wx.navigateTo({ url: '/learn/pages/footprint/footprint' });
  },

  openProfile() {
    wx.navigateTo({ url: '/pages/profile/profile' });
  },
});
