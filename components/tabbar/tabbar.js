/**
 * 底部导航栏。
 *
 * 没用原生 tabBar，因为它要求每个 tab 都准备两套 PNG 图标；
 * 这里用 emoji + CSS 实现，视觉与 Web 版一致，且不引入二进制资源。
 *
 * R1 起底栏为四项（BASELINE.md 裁决）：主页 / 拍照识字 / 写字识字 / 默写。
 * 生字库与识字档案降级为二级页（从首页 Hub 进入，原生导航栏自带返回箭头）。
 */

const TABS = [
  { key: 'index', label: '主页', emoji: '🏠', url: '/pages/index/index' },
  { key: 'ocr', label: '拍照识字', emoji: '📷', url: '/pages/ocr/ocr' },
  { key: 'write', label: '写字识字', emoji: '✍️', url: '/learn/pages/write/write' },
  { key: 'dictation', label: '默写', emoji: '📝', url: '/learn/pages/dictation/dictation' },
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
