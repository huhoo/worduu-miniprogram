/**
 * 隐私接口授权。
 *
 * 小程序正式版调用 wx.chooseMedia（拍照识字）和 wx.saveImageToPhotosAlbum
 * （成就卡存相册）前，必须先拿到用户对《用户隐私保护指引》的同意 ——
 * 这不是可选项：mp 后台一旦配置了该指引，未授权调用会直接 fail，
 * 表现是「点了拍照没反应」，而开发者工具里往往复现不出来。
 *
 * 需要配合两处配置，缺一不可：
 *   1. mp 后台（或提审页面底部）完善《用户隐私保护指引》，勾选
 *      「相册（仅写入）」与「摄像头」，并写明用途；
 *   2. app.json 里 "__usePrivacyCheck__": true。
 *
 * 但第 2 项有个顺序陷阱，务必照做：
 *   隐私保护指引要等小程序**首次发布后**才生效，未发布过的小程序测不了隐私功能。
 *   首次提审就开 true，chooseMedia 会直接报
 *   "api scope is not declared in the privacy agreement"（错误码 112），
 *   表现为「点了拍照没反应」，而开发者工具和体验版往往复现不出来。
 *   所以：首次提审保持 false，在**提审页面底部**完善指引，审核通过并发布、
 *   指引生效后，再改成 true 发下一个版本。
 *
 * 基础库低于 2.32.3 没有这两个 API，此时跳过检查 —— 老版本不受此机制约束。
 */

/**
 * 确认可以继续调用隐私接口。
 * @returns {Promise<boolean>} true 表示可以继续；false 表示用户拒绝，调用方应静默收手。
 */
function ensurePrivacy() {
  return new Promise((resolve) => {
    if (typeof wx.getPrivacySetting !== 'function') {
      resolve(true);
      return;
    }

    wx.getPrivacySetting({
      success: (res) => {
        // needAuthorization 为 false 说明用户已经同意过，或后台还没启用该机制。
        if (!res || !res.needAuthorization) {
          resolve(true);
          return;
        }
        wx.requirePrivacyAuthorize({
          success: () => resolve(true),
          fail: () => resolve(false),
        });
      },
      // 查询失败时不拦人：让原接口自己走，它失败会给更准确的错误信息。
      fail: () => resolve(true),
    });
  });
}

module.exports = { ensurePrivacy };
