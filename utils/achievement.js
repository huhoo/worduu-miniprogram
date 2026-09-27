/**
 * 成就卡数据。
 *
 * 原则与 Web 版一致：卡片上的每一个数字都来自孩子真实的字库和真实的计时，
 * 没有一个预设值。字库为空时，累计识字就是 0，专注时长就是 0 —— 不给「看起来不错」的假数。
 */

const store = require('./store.js');

const LIKES_PREFIX = 'ziban_card_likes_v1_';
const MAX_HIGHLIGHT = 4;
const MAX_LOCAL_LIKES = 20;

/** 身份预设。寄语是每个身份的默认文案，可自行改写。 */
const ROLE_PRESETS = [
  { role: 'teacher', name: '语文老师', emoji: '🌸', defaultMsg: '发音特别标准，明天课堂表扬！🌸' },
  { role: 'grandma', name: '奶奶/姥姥', emoji: '❤️', defaultMsg: '宝贝太懂事了，真为你骄傲！❤️' },
  { role: 'grandpa', name: '爷爷/姥爷', emoji: '👍', defaultMsg: '每天坚持，长大了不得了！👍' },
  { role: 'dad', name: '爸爸', emoji: '⭐', defaultMsg: '好样的，今晚带你去公园！⭐' },
  { role: 'mom', name: '妈妈', emoji: '💖', defaultMsg: '宝贝超棒，妈妈一直陪着你！💖' },
  { role: 'friend', name: '同学伙伴', emoji: '🎉', defaultMsg: '太厉害了，明天一起背课文！🎉' },
];

/**
 * 组装一张卡片。
 * options: { type, title, scoreText, praise, chars }
 *   chars 优先用本次练习涉及的字，其次取字库里最近掌握的。
 */
function buildCard(state, options) {
  const opts = options || {};
  const characters = state.characters || [];

  let source = opts.chars;
  if (!Array.isArray(source) || !source.length) {
    source = characters.filter((c) => c.mastery === '熟练' || c.mastery === '基本掌握');
  }
  // 本次练习的字可能不在字库里（例如刚拍的照片），这时补上字库最近的字。
  if (source.length < MAX_HIGHLIGHT) {
    source = source.concat(characters.slice(0, MAX_HIGHLIGHT));
  }

  const seen = new Set();
  const highlightChars = [];
  source.forEach((c) => {
    if (highlightChars.length >= MAX_HIGHLIGHT) return;
    if (!c || !c.char || seen.has(c.char)) return;
    seen.add(c.char);
    highlightChars.push({ char: c.char, pinyin: c.pinyin || '' });
  });

  return {
    id: '',
    childName: state.childNickname || '宝贝',
    date: store.todayLabel(),
    type: opts.type || 'daily',
    title: opts.title || '今日汉字大通关！',
    scoreText: opts.scoreText || '完成一次练习',
    durationMinutes: store.getStudyMinutes(),
    totalRecognized: characters.length,
    highlightChars,
    praiseComment: opts.praise || '坚持练习，每一个汉字都记得更牢固了！',
    // 点赞只能来自真正打开链接的亲友，绝不预填。
    likes: [],
  };
}

/** 卡片是否够格分享：没有孩子昵称时也要能分享，只要求有标题。 */
function isShareable(card) {
  return !!(card && card.title);
}

function readLocalLikes(cardId) {
  try {
    const raw = wx.getStorageSync(`${LIKES_PREFIX}${cardId}`);
    const parsed = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
    return Array.isArray(parsed) ? parsed.slice(0, MAX_LOCAL_LIKES) : [];
  } catch (e) {
    return [];
  }
}

function writeLocalLikes(cardId, likes) {
  try {
    wx.setStorageSync(`${LIKES_PREFIX}${cardId}`, JSON.stringify((likes || []).slice(0, MAX_LOCAL_LIKES)));
  } catch (e) {
    /* 存不下不影响本次点赞显示 */
  }
}

module.exports = {
  ROLE_PRESETS,
  buildCard,
  isShareable,
  readLocalLikes,
  writeLocalLikes,
};
