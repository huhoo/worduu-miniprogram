/**
 * 云函数调用封装。
 *
 * 错误码到用户可见文案的映射沿用 Web 版 api/client.ts：
 * 上游的原始 message 可能回显请求内容，绝不直接展示给用户。
 */

const { cloudFunction } = require('./config.js');

const MESSAGES = {
  service_not_configured: 'AI 服务尚未开通，请联系管理员配置访问凭据。',
  invalid_image: '没有读到有效的图片，请重新拍摄或换一张更清晰的。',
  invalid_text: '请先输入或校对课文内容。',
  invalid_char: '请提供单个汉字。',
  payload_too_large: '图片太大，请离远一点重拍，或换一张小一些的。',
  upstream_timeout: 'AI 响应超时了，请再试一次。',
  upstream_unreachable: '连不上 AI 服务，请检查网络后重试。',
  unparseable_model_output: 'AI 返回的内容无法解析，请再试一次。',
  malformed_upstream_response: 'AI 服务返回异常，请稍后重试。',
  tts_error: '语音合成失败，请稍后重试。',
  tts_empty_audio: '没有生成音频，请再试一次。',
  tts_audio_fetch_failed: '音频下载失败，请再试一次。',
  rate_limited: '操作太快了，休息一下再试。',
  not_found: '找不到该功能。',
  invalid_json: '请求内容格式不正确。',
  invalid_response: '服务返回了异常响应，请检查访问权限后重试。',
  network_error: '网络请求未完成，请确认网络后重试。',
  access_denied: '没有访问权限，请重新登录。',
  internal_error: '服务处理失败，请稍后重试。',
  stroke_data_unconfigured: '笔顺数据未配置。',
  invalid_card: '奖状内容不完整，请先完成一次练习再分享。',
  card_not_found: '没有找到这张奖状，链接可能不完整或已过期。',
  card_save_failed: '奖状没能保存，请确认云开发数据库已创建 achievement_cards 集合。',
  invalid_like: '请先选择您的身份再点赞。',
  like_failed: '点赞没有保存成功，请稍后再试。',
  invalid_feedback: '请先简单描述一下遇到的问题。',
  feedback_failed: '反馈没能保存，请稍后再试。',
};

function resolveMessage(code) {
  return Object.prototype.hasOwnProperty.call(MESSAGES, code)
    ? MESSAGES[code]
    : '操作没有成功，请稍后重试。';
}

class ApiError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

/**
 * 调用云函数。云函数返回 { ok:false, error, message } 或 { ok:true, ... }。
 * 云开发未初始化时直接抛错，由调用方决定降级行为。
 */
function call(action, params) {
  return new Promise((resolve, reject) => {
    if (typeof wx === 'undefined' || !wx.cloud || !wx.cloud.callFunction) {
      reject(new ApiError(resolveMessage('network_error'), 'network_error'));
      return;
    }

    wx.cloud
      .callFunction({
        name: cloudFunction,
        data: Object.assign({ action }, params || {}),
      })
      .then((res) => {
        const body = res && res.result;
        if (!body || typeof body !== 'object') {
          reject(new ApiError(resolveMessage('invalid_response'), 'invalid_response'));
          return;
        }
        if (body.ok === false || body.error) {
          reject(new ApiError(resolveMessage(body.error), body.error));
          return;
        }
        resolve(body);
      })
      .catch((err) => {
        // 云函数不存在、未部署、网络断开都会落到这里。
        console.error(`[字伴] ${action} 调用失败`, err && (err.errMsg || err.message));
        const msg = err && (err.errMsg || err.message) ? String(err.errMsg || err.message) : '';
        if (msg.indexOf('FunctionName parameter could not be found') !== -1 || msg.indexOf('-501000') !== -1) {
          reject(new ApiError('云函数尚未部署，请在开发者工具中上传部署 ziban。', 'not_found'));
          return;
        }
        reject(new ApiError(resolveMessage('network_error'), 'network_error'));
      });
  });
}

module.exports = {
  ApiError,
  call,
  resolveMessage,
  ocrScan: (imageBase64, sourceType) => call('ocr-scan', { imageBase64, sourceType }),
  characterInfo: (char) => call('character-info', { char }),
  evaluateWriting: (payload) => call('evaluate-writing', payload),
  ttsSpeech: (payload) => call('tts-speech', payload),
  strokeData: (char) => call('stroke-data', { char }),
  saveAchievementCard: (card) => call('save-achievement-card', { card }),
  getAchievementCard: (id) => call('get-achievement-card', { id }),
  likeAchievementCard: (id, like) => call('like-achievement-card', { id, like }),
  submitFeedback: (payload) => call('submit-feedback', payload),
};
