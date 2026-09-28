/**
 * 从环境变量构建上游配置。
 *
 * 凭据有两个来源，按优先级：
 *   1. 云函数环境变量（「云开发控制台 → 云函数 → ziban → 配置 → 环境变量」）——推荐；
 *   2. 同目录 secrets.local.json（已 gitignore，部署时随包上传到云端，不进仓库、不进前端）。
 *
 * 必填两项：DASHSCOPE_API_KEY、DASHSCOPE_WORKSPACE_ID。
 */

const fs = require('fs');
const path = require('path');

let localSecretsCache = null;

/** 读部署包内的本地密钥文件（仅存在于部署机，git 里没有）。 */
function readLocalSecret(name) {
  if (localSecretsCache === null) {
    localSecretsCache = {};
    try {
      const file = path.join(__dirname, 'secrets.local.json');
      localSecretsCache = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      // 文件不存在是正常情况（用环境变量的部署就没有它）
      localSecretsCache = {};
    }
  }
  const value = localSecretsCache[name];
  return typeof value === 'string' ? value.trim() : '';
}

function getenv2(getenv, name) {
  const fromEnv = (getenv(name) || '').trim();
  return fromEnv || readLocalSecret(name);
}

function buildConfigFromEnv(getenv) {
  const apiKey = getenv2(getenv, 'DASHSCOPE_API_KEY');
  if (!apiKey) return null;

  const workspaceId = getenv2(getenv, 'DASHSCOPE_WORKSPACE_ID');
  const region = getenv2(getenv, 'DASHSCOPE_REGION') || 'cn-beijing';

  const baseOverride = getenv2(getenv, 'DASHSCOPE_BASE_URL');
  const ttsOverride = getenv2(getenv, 'DASHSCOPE_TTS_URL');

  const baseUrl =
    baseOverride ||
    (workspaceId ? `https://${workspaceId}.${region}.maas.aliyuncs.com/compatible-mode/v1` : '');

  // CosyVoice / Qwen-Audio-TTS 仅华北2（北京）提供。
  const ttsUrl =
    ttsOverride ||
    (workspaceId
      ? `https://${workspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer`
      : 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer');

  if (!baseUrl) return null;

  // 模型选择沿用 Web 版实测结论，不要随意改动：
  //   vision qwen3-vl-plus  —— qwen3-vl-flash 快但会静默漏掉约 40% 的字，
  //                            漏掉的字不会被报告，只是永远进不了字库。
  //   text   qwen-plus      —— 短 JSON 场景下延迟 0.6s，优于 qwen3.8-flash。
  //   tts    cosyvoice-v3-flash + longxiaochun_v3/longcheng_v3，音色不跨模型通用。
  return {
    apiKey,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    ttsUrl,
    visionModel: getenv2(getenv, 'QWEN_VISION_MODEL') || 'qwen3-vl-plus',
    textModel: getenv2(getenv, 'QWEN_TEXT_MODEL') || 'qwen-plus',
    ttsModel: getenv2(getenv, 'QWEN_TTS_MODEL') || 'cosyvoice-v3-flash',
    ttsVoiceTeacher: getenv2(getenv, 'QWEN_TTS_VOICE_TEACHER') || 'longxiaochun_v3',
    ttsVoiceBrother: getenv2(getenv, 'QWEN_TTS_VOICE_BROTHER') || 'longcheng_v3',
    /** 笔画数据在云存储中的 fileID 前缀，形如 cloud://env.bucket/strokes/。
     *  留空则回退到函数包内自带的 data/ 分片（见 index.js）。 */
    strokeFilePrefix: getenv2(getenv, 'STROKE_FILE_PREFIX'),
  };
}

module.exports = { buildConfigFromEnv };
