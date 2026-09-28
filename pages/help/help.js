const api = require('../../utils/api.js');
const store = require('../../utils/store.js');

const CATEGORIES = ['识别不准', '没有声音', '笔顺或写字', '闪退或白屏', '想要新功能', '其他'];

const ENV_LABEL = {
  develop: '开发版',
  trial: '体验版',
  release: '正式版',
};

/**
 * 常见问题。
 *
 * 写这些答案时守同一条规矩：能说清的说清，做不到的如实说做不到
 * （笔顺缺数据就显示暂无、AI 不可用就提示不可用），不为了"看起来能解决"编话。
 */
const FAQS = [
  {
    q: '拍出来的字不对，或者少认了几个',
    a: '一次只认一页里的一小块最准。拍照后会进入框选步骤，拖动方框罩住要认的那几行，再点「就识别这里」。另外：光线要均匀、别让手指挡住字、字在画面里别太小。',
  },
  {
    q: '点了发音没有声音',
    a: '先看手机是不是静音、音量是不是太小。第一次读某个字需要联网合成，约 1–2 秒；同一个字再读会用本机缓存，立刻出声。换个网络再试通常就好了。',
  },
  {
    q: '笔顺动画不出来，显示「暂无笔顺数据」',
    a: '笔顺来自权威开源字形数据（Make Me a Hanzi），这套数据里没有的字，我们就如实显示暂无 —— 宁可不演示，也不演示猜出来的笔顺。',
  },
  {
    q: '字库和学习记录会不会丢',
    a: '字库、掌握情况、伴读时长都保存在这台手机上，卸载小程序或换手机会丢失。建议用「成就卡」分享留一份档。',
  },
  {
    q: '识别很久没结果',
    a: '识别时可以点「取消识别，返回重拍」。网络差、图片大、一次框的字多都会变慢，一般十几秒内出结果。',
  },
  {
    q: '有的字没有释义，或提示 AI 不可用',
    a: '释义、造句、批改都由 AI 生成，服务不可用或超时时会如实提示，不会编造内容。等一会儿再试即可。',
  },
];

/** 环境信息：用户说不清"我这是什么版本"时，直接让他把这段复制给我们。 */
function readEnv() {
  let info = {};
  try {
    info = wx.getSystemInfoSync() || {};
  } catch (e) {
    /* 拿不到就留空，不猜 */
  }

  let version = '';
  let envVersion = '';
  try {
    const mp = wx.getAccountInfoSync().miniProgram || {};
    version = mp.version || '';
    envVersion = mp.envVersion || '';
  } catch (e) {
    /* 同上 */
  }

  let charCount = 0;
  try {
    charCount = (store.loadState().characters || []).length;
  } catch (e) {
    charCount = 0;
  }

  return {
    version: version || '（未发布版本）',
    envVersion: ENV_LABEL[envVersion] || envVersion || '未知',
    model: info.model || '未知机型',
    system: info.system || '未知系统',
    wechat: info.version || '未知',
    charCount,
  };
}

function envText(env) {
  return [
    `字伴 ${env.version}（${env.envVersion}）`,
    `机型：${env.model}`,
    `系统：${env.system}`,
    `微信：${env.wechat}`,
    `本机字库：${env.charCount} 字`,
  ].join('\n');
}

Page({
  data: {
    faqs: [],
    categories: CATEGORIES,
    categoryIndex: 5,
    content: '',
    contact: '',
    submitting: false,
    submitted: false,
    submitError: '',
    env: {},
    envSummary: '',
  },

  onLoad() {
    const env = readEnv();
    this.setData({
      faqs: FAQS.map((item) => ({ q: item.q, a: item.a, open: false })),
      env,
      envSummary: envText(env),
    });
  },

  toggleFaq(e) {
    const index = Number(e.currentTarget.dataset.index);
    const faqs = this.data.faqs.map((item, i) =>
      i === index ? Object.assign({}, item, { open: !item.open }) : item
    );
    this.setData({ faqs });
  },

  onCategoryChange(e) {
    this.setData({ categoryIndex: Number(e.detail.value) || 0 });
  },

  onContentInput(e) {
    this.setData({ content: e.detail.value || '' });
  },

  onContactInput(e) {
    this.setData({ contact: e.detail.value || '' });
  },

  /**
   * 提交反馈。发不出去时不假装成功 —— 给出「复制下来发给客服」的退路，
   * 用户的问题不会因为我们这边存不下就消失。
   */
  submit() {
    const content = (this.data.content || '').trim();
    if (!content) {
      wx.showToast({ title: '先写两句遇到的问题吧', icon: 'none' });
      return;
    }
    if (this.data.submitting) return;

    const that = this;
    this.setData({ submitting: true, submitError: '' });
    api
      .submitFeedback({
        category: CATEGORIES[this.data.categoryIndex],
        content,
        contact: (this.data.contact || '').trim(),
        env: this.data.env,
      })
      .then(() => {
        that.setData({ submitting: false, submitted: true, content: '' });
      })
      .catch((err) => {
        that.setData({
          submitting: false,
          submitError: (err && err.message) || '没发出去，请稍后再试',
        });
      });
  },

  feedbackAgain() {
    this.setData({ submitted: false, submitError: '', contact: '' });
  },

  /**
   * 客服会话完全由微信转接，这里刻意什么都不做：
   * 不取值、不上传，消息留在微信那里。
   */
  onContact() {},

  /** 复制环境信息，方便贴在客服会话里 —— 我们不知道用户是谁，但知道他跑在什么上面。 */
  copyEnv() {
    const text = this.data.envSummary;
    wx.setClipboardData({
      data: text,
      success() {
        wx.showToast({ title: '已复制，可粘贴给客服', icon: 'none' });
      },
    });
  },

  /** 提交失败时的退路：把整段问题连环境一起复制。 */
  copyAll() {
    const content = (this.data.content || '').trim();
    const text = [
      `【问题类型】${CATEGORIES[this.data.categoryIndex]}`,
      `【描述】${content || '（未填写）'}`,
      '',
      this.data.envSummary,
    ].join('\n');
    wx.setClipboardData({
      data: text,
      success() {
        wx.showToast({ title: '已复制，可粘贴给客服', icon: 'none' });
      },
    });
  },
});
