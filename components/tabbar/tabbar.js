/**
 * 底部导航栏。
 *
 * 没用原生 tabBar，因为它要求每个 tab 都在 app.json 里配死图标；
 * 这里用自定义组件实现。图标是设计图同款简易线图标（tools/gen-icons.mjs 生成），
 * 未选中灰、选中绿，各备一张 PNG。
 *
 * R1 起底栏为四项（BASELINE.md 裁决）：主页 / 拍照识字 / 写字识字 / 默写。
 * 生字库与识字档案降级为二级页（从首页 Hub 进入，原生导航栏自带返回箭头）。
 */

const TABS = [
  {
    key: 'index',
    label: '主页',
    icon: '/images/icons/home-gray.png',
    iconActive: '/images/icons/home-green.png',
    url: '/pages/index/index',
  },
  {
    key: 'ocr',
    label: '拍照识字',
    icon: '/images/icons/camera-gray.png',
    iconActive: '/images/icons/camera-green.png',
    url: '/pages/ocr/ocr',
  },
  {
    key: 'write',
    label: '写字识字',
    icon: '/images/icons/pencil-gray.png',
    iconActive: '/images/icons/pencil-green.png',
    url: '/learn/pages/write/write',
  },
  {
    key: 'dictation',
    label: '默写',
    icon: '/images/icons/doc-gray.png',
    iconActive: '/images/icons/doc-green.png',
    url: '/learn/pages/dictation/dictation',
  },
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
