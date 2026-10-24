/**
 * 家长密码（R2 最小版）。
 *
 * 只保护一个操作：默写库手动出库（PRD 9.5：孩子端不可手动移出）。
 * 4-6 位数字，哈希后存本机 —— 这是防孩子误触的速度 bump，不是保险箱；
 * 要防的是「孩子拿着手机乱点」，不是「有人逆向存储文件」。
 * 忘记密码只能清库重设（见 clearPassword），没有找回通道 —— 本地密码本就不该有。
 */

const { storageKeys } = require('./config.js');

const MIN_LEN = 4;
const MAX_LEN = 6;

/** djb2 变体：让存储里看不到明文即可，不为防逆向引入依赖。 */
function hash(pwd) {
  let h = 5381;
  for (let i = 0; i < pwd.length; i += 1) {
    h = (h * 33) ^ pwd.charCodeAt(i);
  }
  return `h${(h >>> 0).toString(36)}`;
}

function isValid(pwd) {
  return typeof pwd === 'string' && new RegExp(`^\\d{${MIN_LEN},${MAX_LEN}}$`).test(pwd);
}

function getHash() {
  try {
    return wx.getStorageSync(storageKeys.parent) || '';
  } catch (e) {
    return '';
  }
}

function hasPassword() {
  return !!getHash();
}

/** 设置密码。返回是否设置成功（格式不对/存储被拒都是 false）。 */
function setPassword(pwd) {
  if (!isValid(pwd)) return false;
  try {
    wx.setStorageSync(storageKeys.parent, hash(pwd));
    return true;
  } catch (e) {
    return false;
  }
}

/** 校验密码。没设过密码一律 false。 */
function verify(pwd) {
  if (!isValid(pwd)) return false;
  const saved = getHash();
  if (!saved) return false;
  return hash(pwd) === saved;
}

/** 清掉密码（忘记密码的唯一出路：重设）。 */
function clearPassword() {
  try {
    wx.removeStorageSync(storageKeys.parent);
  } catch (e) {
    /* 存储异常也不抛 */
  }
}

module.exports = {
  MIN_LEN,
  MAX_LEN,
  isValid,
  hasPassword,
  setPassword,
  verify,
  clearPassword,
};
