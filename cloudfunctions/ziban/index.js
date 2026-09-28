/**
 * 「字伴」AI 云函数。
 *
 * 前端统一调用：
 *   wx.cloud.callFunction({ name: 'ziban', data: { action, ...params } })
 *
 * 所有 prompt 与 Web 版 functions/handler.ts 保持一致 —— 那些措辞是调过的，
 * 改一个字就可能改变返回的严格程度，不要随手润色。
 */

const { chatForJson, synthesize, fenceUntrusted, UpstreamError } = require('./qwen.js');
const { buildConfigFromEnv } = require('./config.js');

const MAX_TEXT_CHARS = 20000;
const MAX_BASE64_CHARS = 10 * 1024 * 1024;

const TEACHER_SYSTEM =
  '你是一位小学语文资深特级教师，也是严谨的中文文字识别专家。你面对的是中国小学低年级学生和家长，' +
  '回答必须准确、温和、适合儿童。你只输出一个合法的 JSON 对象，不输出解释、Markdown 或代码围栏。';

const OCR_SYSTEM =
  '你是顶尖的中文 OCR 文字识别专家，同时具备小学语文教学经验。你必须逐字精准转录，' +
  '严谨辨别形近字（辨/辩/辫、己/已/巳、日/目、木/术/本、人/入/八、未/末），不漏字、不错字、不添字。' +
  '你只输出一个合法的 JSON 对象。';

const CALLIGRAPHY_SYSTEM =
  '你是书法老师兼小学语文教师，评判认真严格但语气温暖。只输出一个合法 JSON 对象。';

function fail(code, message) {
  return { ok: false, error: code, message };
}

function ok(data) {
  return Object.assign({ ok: true }, data);
}

function mustConfig(config) {
  if (!config) {
    throw new UpstreamError(503, 'service_not_configured', 'AI 服务尚未配置，请联系管理员在云函数中录入访问凭据');
  }
  return config;
}

function isCjkChar(value) {
  return typeof value === 'string' && /^[\u4e00-\u9fff]$/.test(value);
}

function clampString(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : null;
}

function clampScore(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0;
}

/** 丢掉模型编造的、不是单个汉字的条目。 */
function sanitizeCharacters(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item && isCjkChar(item.char))
    .slice(0, 40)
    .map((item) => ({
      char: item.char,
      pinyin: clampString(item.pinyin, 40) || '',
      meaning: clampString(item.meaning, 300) || '',
      words: Array.isArray(item.words)
        ? item.words.filter((w) => typeof w === 'string').slice(0, 5).map((w) => String(w).slice(0, 30))
        : [],
      isSuggested: item.isSuggested === true,
      isUncertain: item.isUncertain === true,
    }));
}

/** 拆出 data URI 或裸 base64 里的 MIME 与载荷。 */
function readImage(value) {
  const raw = clampString(value, MAX_BASE64_CHARS + 100);
  if (!raw) return null;

  const match = raw.match(/^data:([^;,]+);base64,([\s\S]*)$/);
  if (match) {
    const mimeType = match[1].toLowerCase();
    if (!/^image\/(jpeg|jpg|png|webp|heic|heif)$/.test(mimeType)) return null;
    return { mimeType, dataBase64: match[2] };
  }
  if (/^[A-Za-z0-9+/\s]+={0,2}$/.test(raw) && raw.length > 100) {
    return { mimeType: 'image/jpeg', dataBase64: raw.replace(/\s/g, '') };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 拍照识字
 * ------------------------------------------------------------------ */
async function handleOcrScan(config, body) {
  const image = readImage(body.imageBase64);
  if (!image) return fail('invalid_image', '没有读到有效的图片，请重新拍摄或换一张更清晰的');

  const cfg = mustConfig(config);
  const sourceType = clampString(body.sourceType, 40) || '课外书';

  const user = `请识别这张${sourceType}图片。

【输出要求】
1. rawText：按从上至下、从左至右的自然排版顺序，逐字转录图片中的所有文字，保留段落换行与中文标点。
2. title：图片中的课文标题；若无明确标题，提炼一个简短主题。
3. recognizedCharacters：从中精选 8~16 个最适合小学生提升识字量的核心汉字（避开“的、了、是、在、和”等超高频虚词），每个字给出：
   - char：单个汉字
   - pinyin：标准汉语拼音，必须带规范声调（如 chūn、dié、xiǎo）
   - meaning：10~20 字、生动易懂的儿童释义
   - words：2~3 个规范常用的小学组词
   - isSuggested：是否推荐重点识记
   - isUncertain：仅当该字因反光、遮挡或模糊而无法 100% 确认时为 true

【严格 JSON 结构】
{"title":"…","rawText":"…","recognizedCharacters":[{"char":"春","pinyin":"chūn","meaning":"一年的第一季，万物复苏","words":["春天","春风"],"isSuggested":true,"isUncertain":false}],"uncertainCount":0,"totalExtracted":1}
totalExtracted 等于 recognizedCharacters 的数量，uncertainCount 等于其中 isUncertain 为 true 的数量。`;

  const data = await chatForJson(cfg, {
    system: OCR_SYSTEM,
    user,
    image: { dataBase64: image.dataBase64, mimeType: image.mimeType },
    model: cfg.visionModel,
  });

  const characters = sanitizeCharacters(data.recognizedCharacters);
  return ok({
    sourceType,
    title: clampString(data.title, 120) || '',
    rawText: clampString(data.rawText, MAX_TEXT_CHARS) || '',
    recognizedCharacters: characters,
    uncertainCount: characters.filter((c) => c.isUncertain).length,
    totalExtracted: characters.length,
  });
}

/* ------------------------------------------------------------------ *
 * 查字
 * ------------------------------------------------------------------ */
async function handleCharInfo(config, body) {
  const char = body.char;
  if (!isCjkChar(char)) return fail('invalid_char', '请提供单个汉字');

  const cfg = mustConfig(config);

  // 刻意不向模型要 strokes 数组。实测（temperature=0，同一账号）3 个抽样字里
  // 2 个笔顺错误，「雨」一次答 8 画一次答 10 画。笔顺是教学知识，
  // 一个每次调用结果都可能变的来源不能进书写教学。笔顺改由 Make Me a Hanzi 数据提供。

  const user = `请面向中国小学生解析汉字“${char}”：带声调的标准拼音、10~20 字生动儿童释义、2~4 个规范常用组词。` +
    '另需给出 radical（部首）、strokeCount（规范笔画数）、sentence（适合小学生的例句）、originStory（字源或记忆口诀）。' +
    '只输出严格 JSON：' +
    '{"char":"蝶","pinyin":"dié","radical":"虫","strokeCount":15,"meaning":"…","words":["蝴蝶","彩蝶"],"sentence":"…","originStory":"…"}';

  const data = await chatForJson(cfg, { system: TEACHER_SYSTEM, user });

  return ok({
    char,
    pinyin: clampString(data.pinyin, 40) || '',
    radical: clampString(data.radical, 20) || '',
    strokeCount: Number.isFinite(Number(data.strokeCount)) ? Number(data.strokeCount) : 0,
    meaning: clampString(data.meaning, 300) || '',
    words: Array.isArray(data.words)
      ? data.words.filter((w) => typeof w === 'string').slice(0, 4).map((w) => String(w).slice(0, 30))
      : [],
    sentence: clampString(data.sentence, 200) || '',
    originStory: clampString(data.originStory, 300) || '',
  });
}

/* ------------------------------------------------------------------ *
 * 书写批改
 * ------------------------------------------------------------------ */
async function handleEvaluateWriting(config, body) {
  const char = body.char;
  if (!isCjkChar(char)) return fail('invalid_char', '缺少目标汉字');

  const image = readImage(body.canvasBase64);
  if (!image) return fail('invalid_image', '缺少书写图片');

  const cfg = mustConfig(config);
  const strokeCount = Number(body.strokeCount);
  const safeStrokeCount =
    Number.isFinite(strokeCount) && strokeCount > 0 && strokeCount <= 60 ? Math.round(strokeCount) : null;
  const logs = Array.isArray(body.strokeOrderLogs) ? JSON.stringify(body.strokeOrderLogs.slice(0, 80)) : '[]';

  const user = `这是孩子在田字格中书写的汉字“${char}”。${safeStrokeCount ? `规范笔画数为 ${safeStrokeCount}。` : ''}
笔顺记录（JSON）：${logs.slice(0, 4000)}

请评判：shapeScore 字形规范度(0-100)、strokeScore 笔顺正确度(0-100)、isPassed 是否合格、
strokeOrderCorrect 笔顺是否正确、feedback 温暖且具体的儿童评语、improvements 至多 3 条改进建议。
注意：如果孩子写的明显不是这个字，必须给低分并让 isPassed 为 false，不要因为鼓励而虚高。

只输出严格 JSON：{"shapeScore":90,"strokeScore":95,"isPassed":true,"strokeOrderCorrect":true,"feedback":"…","improvements":["…"]}`;

  const data = await chatForJson(cfg, {
    system: CALLIGRAPHY_SYSTEM,
    user,
    image: { dataBase64: image.dataBase64, mimeType: image.mimeType },
    model: cfg.visionModel,
  });

  return ok({
    shapeScore: clampScore(data.shapeScore),
    strokeScore: clampScore(data.strokeScore),
    isPassed: data.isPassed === true,
    strokeOrderCorrect: data.strokeOrderCorrect === true,
    feedback: clampString(data.feedback, 300) || '',
    improvements: Array.isArray(data.improvements)
      ? data.improvements.filter((i) => typeof i === 'string').slice(0, 3).map((i) => String(i).slice(0, 120))
      : [],
  });
}

/* ------------------------------------------------------------------ *
 * 语音合成
 * ------------------------------------------------------------------ */
async function handleTts(config, body) {
  const mode = clampString(body.mode, 20) || 'read';
  const char = isCjkChar(body.char) ? body.char : null;
  const pinyin = clampString(body.pinyin, 40) || '';
  const sampleWord = clampString(body.sampleWord, 40) || '';
  const freeText = clampString(body.text, 600) || '';
  const voice = clampString(body.voice, 20) === 'brother' ? 'brother' : 'teacher';

  let speech;
  if (mode === 'spell' && char) {
    const wordPart = sampleWord ? `，${sampleWord}的${char}` : `，${char}`;
    speech = `汉字：${char}。读音：${pinyin}。${char}${wordPart}。`;
  } else if (mode === 'read' && char) {
    const wordPart = sampleWord ? `，${sampleWord}的${char}` : '';
    speech = `${char}。${pinyin ? `${pinyin}。` : ''}${char}${wordPart}。`;
  } else {
    speech = freeText || (char ? `${char}。${sampleWord}` : '你好呀，小朋友！');
  }

  const wav = await synthesize(mustConfig(config), { text: speech, voice });
  // 云函数只能回 JSON/字符串，音频以 base64 回传，前端落临时文件后播放。
  return ok({ audioBase64: wav.toString('base64'), mimeType: 'audio/wav', text: speech });
}

/* ------------------------------------------------------------------ *
 * 笔顺数据
 *
 * 数据来源按优先级：
 *   1. 云存储（配置了 STROKE_FILE_PREFIX 时）—— 改数据不用重新部署函数；
 *   2. 函数包内自带的 data/ 分片 —— 部署时随包带上，开箱即用。
 * 两种来源格式一致，都省去了把 7MB 数据塞进小程序主包。
 * ------------------------------------------------------------------ */
const fs = require('fs');
const path = require('path');

/** 读函数包内自带的分片（部署时把 tools/strokes/*.json 复制到 data/ 即可）。 */
function readBundledShard(shard) {
  try {
    const file = path.join(__dirname, 'data', `${shard}.json`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return null;
  }
}

/** 从分片表里取一个字的 medians / names，兼容旧版（纯数组）与新版（{m,n}）两种格式。 */
function extractEntry(table, char) {
  const entry = table[char];
  if (Array.isArray(entry)) return { medians: entry, names: null };
  if (entry && Array.isArray(entry.m)) {
    return { medians: entry.m, names: Array.isArray(entry.n) ? entry.n.slice(0, 60) : null };
  }
  return { medians: null, names: null };
}

async function handleStrokeData(config, body) {
  const char = clampString(body.char, 4);
  if (!char || !/^[\u4e00-\u9fff]$/.test(char)) return fail('invalid_char', '请提供单个汉字');

  const shard = (char.codePointAt(0) >> 8).toString(16);

  // 来源 1：云存储
  if (config && config.strokeFilePrefix) {
    const fileID = `${config.strokeFilePrefix.replace(/\/$/, '')}/${shard}.json`;
    try {
      const cloud = require('wx-server-sdk');
      cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
      const res = await cloud.downloadFile({ fileID });
      const table = JSON.parse(res.fileContent.toString('utf8'));
      const { medians, names } = extractEntry(table, char);
      if (medians && medians.length) return ok({ char, medians, names });
      // 存储里查无此字：数据集未覆盖是正常情况，继续落到包内数据再试一次
    } catch (error) {
      // 分片不存在 / 存储不可用都落到包内数据
      console.error('[字伴] 云存储笔画数据读取失败，回退到包内分片', shard, error && error.message);
    }
  }

  // 来源 2：函数包内自带分片
  const table = readBundledShard(shard);
  if (!table) return ok({ char, medians: null, names: null });
  const { medians, names } = extractEntry(table, char);
  if (!medians || !medians.length) return ok({ char, medians: null, names: null });
  return ok({ char, medians, names });
}

/* ------------------------------------------------------------------ *
 * 成就卡（存云数据库，分享只带一个短 id）
 *
 * Web 版把整张卡片 base64 编码进分享链接，代价是链接过长会被聊天软件截断，
 * 接收方只能看到「这条分享链接打不开」。小程序有云开发，改存库：
 * 分享 path 只带 12 位左右的 id，链接再短也不会被截断。
 *
 * 入库前做一次 sanitize —— 卡片数据来自客户端，不能直接落库再原样渲染。
 * ------------------------------------------------------------------ */
const CARD_COLLECTION = 'achievement_cards';
const CARD_TYPES = ['reading_test', 'dictation', 'handwriting', 'daily'];
const MAX_LIKES = 20;

function database() {
  const cloud = require('wx-server-sdk');
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
  return cloud.database();
}

/**
 * 成就卡操作统一入口。集合没建（首次部署常见）时自动 createCollection 后重试一次，
 * 省掉「部署完还要去控制台手工建集合」这一步。只有报「集合不存在」才重试，
 * 其他错误原样抛出，避免重试造成重复写入。
 */
async function withCards(operation) {
  const db = database();
  try {
    return await operation(db.collection(CARD_COLLECTION), db);
  } catch (error) {
    const message = String((error && error.message) || '');
    if (!/-502005|not exist|不存在/i.test(message)) throw error;
    await db.createCollection(CARD_COLLECTION).catch(() => {});
    return await operation(db.collection(CARD_COLLECTION), db);
  }
}

function str(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function sanitizeLike(raw) {
  const item = raw && typeof raw === 'object' ? raw : {};
  return {
    id: str(item.id, 32) || `like-${Date.now()}`,
    role: str(item.role, 16) || 'other',
    roleName: str(item.roleName, 20),
    message: str(item.message, 80),
    time: str(item.time, 20),
    emoji: str(item.emoji, 4) || '👍',
  };
}

/** 只保留展示用字段，伪造的链接也塞不进多余结构。 */
function sanitizeCard(raw) {
  const card = raw && typeof raw === 'object' ? raw : {};
  const childName = str(card.childName, 12);
  const title = str(card.title, 40);
  if (!childName || !title) return null;

  const highlightChars = Array.isArray(card.highlightChars)
    ? card.highlightChars
        .slice(0, 4)
        .map((item) => ({
          char: str(item && item.char, 2),
          pinyin: str(item && item.pinyin, 24),
        }))
        .filter((item) => item.char)
    : [];

  const likes = Array.isArray(card.likes)
    ? card.likes.slice(0, MAX_LIKES).map(sanitizeLike).filter((like) => like.roleName)
    : [];

  const minutes = Number(card.durationMinutes);
  const total = Number(card.totalRecognized);

  return {
    id: str(card.id, 40),
    childName,
    date: str(card.date, 20),
    type: CARD_TYPES.indexOf(String(card.type)) !== -1 ? card.type : 'daily',
    title,
    scoreText: str(card.scoreText, 40),
    durationMinutes: Number.isFinite(minutes) && minutes >= 0 ? Math.round(minutes) : 0,
    totalRecognized: Number.isFinite(total) && total >= 0 ? Math.round(total) : 0,
    highlightChars,
    praiseComment: str(card.praiseComment, 120),
    likes,
  };
}

function newCardId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

async function handleSaveCard(config, body) {
  const card = sanitizeCard(body.card);
  if (!card) return fail('invalid_card', '奖状内容不完整，需要孩子的昵称和一句标题');

  const id = newCardId();
  card.id = id;

  try {
    await withCards((collection) =>
      collection.add({ data: Object.assign({}, card, { _id: id, createdAt: Date.now() }) })
    );
    return ok({ id });
  } catch (error) {
    console.error('[字伴] 成就卡保存失败', error && error.message);
    return fail('card_save_failed', '奖状没能保存，请稍后再试');
  }
}

async function handleGetCard(config, body) {
  const id = str(body.id, 40);
  if (!id) return fail('invalid_card', '链接里没有奖状编号');

  try {
    const res = await withCards((collection) => collection.doc(id).get());
    const card = res && res.data ? sanitizeCard(res.data) : null;
    if (!card) return fail('card_not_found', '没有找到这张奖状');
    return ok({ card });
  } catch (error) {
    console.error('[字伴] 成就卡读取失败', error && error.message);
    return fail('card_not_found', '没有找到这张奖状，可能已被清理');
  }
}

async function handleLikeCard(config, body) {
  const id = str(body.id, 40);
  const like = sanitizeLike(body.like);
  if (!id || !like.roleName) return fail('invalid_like', '请先选择您的身份');

  try {
    const likes = await withCards(async (collection) => {
      const res = await collection.doc(id).get();
      if (!res || !res.data) throw new Error('CARD_NOT_FOUND');
      const merged = [like].concat(Array.isArray(res.data.likes) ? res.data.likes : []).slice(0, MAX_LIKES);
      await collection.doc(id).update({ data: { likes: merged } });
      return merged;
    });
    return ok({ likes });
  } catch (error) {
    if (error && error.message === 'CARD_NOT_FOUND') return fail('card_not_found', '没有找到这张奖状');
    console.error('[字伴] 点赞失败', error && error.message);
    return fail('like_failed', '点赞没有保存成功，请稍后再试');
  }
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */
exports.main = async (event) => {
  const action = (event && event.action) || '';
  const config = buildConfigFromEnv((name) => process.env[name]);

  if (!action || action === 'health') {
    return ok({
      status: 'ok',
      app: 'ziban-miniprogram',
      ai: config ? 'ready' : 'unconfigured',
      strokes:
        !!(config && config.strokeFilePrefix) ||
        fs.existsSync(path.join(__dirname, 'data', '4e.json')),
    });
  }

  try {
    switch (action) {
      case 'ocr-scan':
        return await handleOcrScan(config, event);
      case 'character-info':
        return await handleCharInfo(config, event);
      case 'evaluate-writing':
        return await handleEvaluateWriting(config, event);
      case 'tts-speech':
        return await handleTts(config, event);
      case 'stroke-data':
        return await handleStrokeData(config, event);
      case 'save-achievement-card':
        return await handleSaveCard(config, event);
      case 'get-achievement-card':
        return await handleGetCard(config, event);
      case 'like-achievement-card':
        return await handleLikeCard(config, event);
      default:
        return fail('not_found', '未知的接口');
    }
  } catch (error) {
    if (error instanceof UpstreamError) {
      const status = error.status >= 400 && error.status <= 599 ? error.status : 502;
      return fail(error.code, error.message, status);
    }
    console.error(`[字伴] ${action} 处理失败:`, error && error.message);
    return fail('internal_error', '服务处理失败，请稍后重试');
  }
};
