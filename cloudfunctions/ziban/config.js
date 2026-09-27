/**
 * 从环境变量构建上游配置。
 *
 * 环境变量在「云开发控制台 → 云函数 → ziban → 配置 → 环境变量」中录入，
 * 不进代码库。必填两项：DASHSCOPE_API_KEY、DASHSCOPE_WORKSPACE_ID。
 */

function buildConfigFromEnv(getenv) {
  const apiKey = (getenv('DASHSCOPE_API_KEY') || '').trim();
  if (!apiKey) return null;

  const workspaceId = (getenv('DASHSCOPE_WORKSPACE_ID') || '').trim();
  const region = (getenv('DASHSCOPE_REGION') || 'cn-beijing').trim() || 'cn-beijing';

  const baseOverride = (getenv('DASHSCOPE_BASE_URL') || '').trim();
  const ttsOverride = (getenv('DASHSCOPE_TTS_URL') || '').trim();

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
    visionModel: (getenv('QWEN_VISION_MODEL') || '').trim() || 'qwen3-vl-plus',
    textModel: (getenv('QWEN_TEXT_MODEL') || '').trim() || 'qwen-plus',
    ttsModel: (getenv('QWEN_TTS_MODEL') || '').trim() || 'cosyvoice-v3-flash',
    ttsVoiceTeacher: (getenv('QWEN_TTS_VOICE_TEACHER') || '').trim() || 'longxiaochun_v3',
    ttsVoiceBrother: (getenv('QWEN_TTS_VOICE_BROTHER') || '').trim() || 'longcheng_v3',
    /** 笔画数据在云存储中的 fileID 前缀，形如 cloud://env.bucket/strokes/ */
    strokeFilePrefix: (getenv('STROKE_FILE_PREFIX') || '').trim(),
  };
}

module.exports = { buildConfigFromEnv };
