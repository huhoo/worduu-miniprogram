/**
 * 底部导航栏。
 *
 * 没用原生 tabBar，因为它要求每个 tab 都准备两套 PNG 图标；
 * 这里用 emoji + CSS 实现，视觉与 Web 版一致，且不引入二进制资源。
 */

const TABS = [
  { key: 'index', label: '首页', emoji: '🏠', url: '/pages/index/index' },
  { key: 'ocr', label: '拍照识字', emoji: '📷', url: '/pages/ocr/ocr' },
  { key: 'bank', label: '生字库', emoji: '📚', url: '/pages/bank/bank' },
  { key: 'write', label: '规范写字', emoji: '✍️', url: '/learn/pages/write/write' },
  { key: 'profile', label: '识字档案', emoji: '📈', url: '/pages/profile/profile' },
];

Component({
  properties: {
    current: {
      type: String,
      value: 'index',
    },
  },

  data: {
    tabs: TABS,
  },

  methods: {
    onTap(e) {
      const key = e.currentTarget.dataset.key;
      if (key === this.data.current) return;
      const tab = TABS.find((t) => t.key === key);
      if (!tab) return;
      wx.redirectTo({ url: tab.url });
    },
  },
});
