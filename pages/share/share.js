/**
 * 亲友点赞页（分享链接的落地页）。
 *
 * 与 Web 版 AchievementShareView 同一套交互：选身份 → 写寄语 → 送小红花。
 * 两处不同：
 *   1. 卡片按 id 从云开发数据库取，不靠链接自带内容 —— 不会被聊天软件截断。
 *   2. 点赞写回云端（同一张卡所有亲友都能看到），本机另外留一份，
 *      用来标记「这台设备已经点过」，避免重复刷赞。
 */

const api = require('../../utils/api.js');
const cardUtil = require('../../utils/achievement.js');
const audio = require('../../utils/audio.js');

Page({
  data: {
    loading: true,
    invalid: false,
    invalidReason: '',
    card: null,
    roles: cardUtil.ROLE_PRESETS,
    selectedRole: '',
    message: '',
    hasLiked: false,
    likes: [],
    submitting: false,
    syncFailed: '',
  },

  onLoad(options) {
    const id = options && options.id;
    if (!id) {
      this.setData({ loading: false, invalid: true, invalidReason: '链接里没有奖状编号。' });
      return;
    }

    this.cardId = id;
    // 本机是否点过：云端记录不含设备信息，只能靠本机标记。
    const local = cardUtil.readLocalLikes(id);
    this.setData({ hasLiked: local.length > 0 });

    api
      .getAchievementCard(id)
      .then((res) => {
        const card = res && res.card;
        if (!card) {
          this.setData({ loading: false, invalid: true, invalidReason: '没有找到这张奖状。' });
          return;
        }
        this.setData({ loading: false, card, likes: card.likes || [] });
      })
      .catch((error) => {
        this.setData({
          loading: false,
          invalid: true,
          invalidReason: (error && error.message) || '没有找到这张奖状，链接可能不完整或已过期。',
        });
      });
  },

  selectRole(e) {
    const role = e.currentTarget.dataset.role;
    const preset = cardUtil.ROLE_PRESETS.find((p) => p.role === role);
    if (!preset) return;
    this.setData({ selectedRole: role, message: preset.defaultMsg });
  },

  onMessageInput(e) {
    this.setData({ message: e.detail.value });
  },

  sendLike() {
    if (this.data.hasLiked || this.data.submitting) return;
    if (!this.data.selectedRole) {
      wx.showToast({ title: '先选一个身份', icon: 'none' });
      return;
    }

    const preset = cardUtil.ROLE_PRESETS.find((p) => p.role === this.data.selectedRole);
    if (!preset) return;

    const like = {
      id: `local-${Date.now()}`,
      role: preset.role,
      roleName: preset.name,
      message: (this.data.message || '').trim().slice(0, 80) || '为你点赞！',
      time: '刚刚',
      emoji: preset.emoji,
    };

    this.setData({ submitting: true });

    const that = this;
    api
      .likeAchievementCard(this.cardId, like)
      .then((res) => {
        const likes = (res && res.likes) || [like].concat(that.data.likes);
        cardUtil.writeLocalLikes(that.cardId, [like]);
        that.setData({ hasLiked: true, likes, submitting: false });
        audio.soundEffects.playSuccess();
      })
      .catch((error) => {
        // 云端没写进去也让这次点赞在本机可见 —— 亲友的心意不该因为网络丢了。
        const likes = [like].concat(that.data.likes);
        cardUtil.writeLocalLikes(that.cardId, [like]);
        that.setData({
          hasLiked: true,
          likes,
          submitting: false,
          syncFailed: (error && error.message) || '点赞已记录在本机，但没能同步到云端。',
        });
        audio.soundEffects.playSuccess();
      });
  },

  goApp() {
    wx.reLaunch({ url: '/pages/index/index' });
  },
});
