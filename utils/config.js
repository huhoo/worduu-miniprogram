/**
 * 「字伴」小程序全局配置。
 *
 * 部署前必须修改 cloudEnv：微信开发者工具 → 云开发 → 环境 ID。
 * 其余项保持默认即可。
 */
module.exports = {
  /** 云开发环境 ID，形如 ziban-1g8xxxxxxx。留空则所有 AI 能力不可用，本地功能仍可运行。 */
  cloudEnv: 'cloudbase-d4gxrglmjdcacd33c',

  /** 云函数名，必须与 cloudfunctions/ 下的目录名一致。 */
  cloudFunction: 'ziban',

  /** 笔画数据在云存储中的目录前缀，上传脚本见 tools/upload-strokes.md。 */
  strokePrefix: 'strokes/',

  /** 本地存储键名。 */
  storageKeys: {
    state: 'ziban_state_v1',
    study: 'ziban_study_time_v1',
    speechPref: 'ziban_speech_pref_v1',
  },
};
