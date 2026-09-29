/**
 * 字库与学习记录的本地持久化。
 *
 * 与 Web 版 store/local.ts 保持同一套数据结构和同一条原则：
 * 首次打开字库为空，掌握度由字库本身推导，不存任何编造的学习历史。
 */

const { storageKeys } = require('./config.js');

const VERSION = 1;

function todayLabel() {
  const now = new Date();
  return `${now.getMonth() + 1}月${now.getDate()}日`;
}

function seed() {
  return {
    version: VERSION,
    characters: [],
    stats: {
      totalRecognized: 0,
      mastered: 0,
      basic: 0,
      unfamiliar: 0,
      frequentError: 0,
      todayLearnedCount: 0,
      todayMasteredCount: 0,
      todayReviewCount: 0,
      studyTimeMinutes: 0,
    },
    childNickname: '',
    day: todayLabel(),
  };
}

function readRaw() {
  try {
    const value = wx.getStorageSync(storageKeys.state);
    if (!value) return null;
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch (e) {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 进程内缓存。
 *
 * 每个页面 onShow 都要读一次字库：原本每次都是 getStorageSync + JSON.parse，
 * 字库攒到几百字时这一下是能感觉出来的卡顿。字库只在小程序里改，
 * 所以读一次就够，后面都走缓存；写的时候先更新缓存，再合并落盘。
 * ------------------------------------------------------------------ */
let stateCache = null;
let saveTimer = null;
let secondsCache = null; // { day, seconds } —— 今日伴读秒数

/**
 * 修复单条字库记录。
 *
 * 存储是边界：老版本半条记录、quota 截断的 JSON、或手改的缓存值，都可能让
 * 一条记录缺了页面会直接取用的字段。逐条补默认值而不是整库丢弃 ——
 * 丢一条记录比丢整个孩子的字库好，补一个字段又比丢一条记录好。
 * 只有 char 本身不可用（空/非字符串）才返回 null 剔除。
 */
function normalizeCharacter(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  const char = typeof raw.char === 'string' ? raw.char.trim() : '';
  if (!char) return null;

  const str = (v, fallback) => (typeof v === 'string' ? v : fallback || '');
  const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback || 0);

  return {
    id: str(raw.id) || `repaired-${char}-${index}`,
    char,
    pinyin: str(raw.pinyin),
    tone: num(raw.tone, 0),
    radical: str(raw.radical),
    strokeCount: num(raw.strokeCount, 0),
    meaning: str(raw.meaning),
    words: Array.isArray(raw.words) ? raw.words.filter((w) => typeof w === 'string') : [],
    exampleSentence: str(raw.exampleSentence),
    originStory: str(raw.originStory),
    source: str(raw.source) || '其他',
    sourceDetail: str(raw.sourceDetail),
    dateEncountered: str(raw.dateEncountered) || todayLabel(),
    mastery: str(raw.mastery) || '不熟',
    reactionTimeSeconds: num(raw.reactionTimeSeconds, 0),
    errorCount: num(raw.errorCount, 0),
    canRead: raw.canRead === true,
    canWrite: raw.canWrite === true,
    canDictate: raw.canDictate === true,
    memoryNote: str(raw.memoryNote),
  };
}

/** 损坏、为空或跨天的数据都回落到种子值，绝不抛错。 */
function loadState() {
  if (stateCache) return stateCache;

  const parsed = readRaw();
  const base = seed();
  if (!parsed || parsed.version !== VERSION || !Array.isArray(parsed.characters)) {
    stateCache = base;
    return stateCache;
  }

  const state = {
    version: VERSION,
    characters: parsed.characters.map(normalizeCharacter).filter(Boolean),
    stats: Object.assign({}, base.stats, parsed.stats || {}),
    childNickname: typeof parsed.childNickname === 'string' ? parsed.childNickname.slice(0, 12) : '',
    day: typeof parsed.day === 'string' ? parsed.day : base.day,
  };

  // 换天就把「今日」三项归零，否则昨天的数字会一直挂着。
  if (state.day !== base.day) {
    state.day = base.day;
    state.stats.todayLearnedCount = 0;
    state.stats.todayMasteredCount = 0;
    state.stats.todayReviewCount = 0;
  }

  stateCache = state;
  return stateCache;
}

/** 真正写盘。合并写之后由 flushState 兜底调用。 */
function persistState(state) {
  try {
    wx.setStorageSync(storageKeys.state, JSON.stringify(state));
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 保存字库。
 *
 * 一页答题会连着写好几次（每题一次），每次都同步序列化整个字库是纯粹的白等，
 * 所以这里只保证「缓存立刻生效」，落盘合并到 300ms 后做一次。
 * 小程序被切后台时由 app.onHide 调 flushState 立刻补写，不丢数据。
 */
function saveState(state) {
  stateCache = state || stateCache;

  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (stateCache) persistState(stateCache);
  }, 300);

  return true;
}

/** 把还没落盘的字库立刻写掉。切后台、退出前调用。 */
function flushState() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (stateCache) return persistState(stateCache);
  return false;
}

/**
 * 掌握度分桶由字库推导，不做并行计数 —— 并行计数会漂移：
 * 每次答对都给 mastered 加一，导致熟练率虚高而 basic 永远是 0。
 */
function deriveMasteryCounts(characters) {
  let mastered = 0;
  let basic = 0;
  let unfamiliar = 0;
  let frequentError = 0;
  for (const c of characters) {
    if (c.mastery === '熟练') mastered += 1;
    else if (c.mastery === '基本掌握') basic += 1;
    else if (c.mastery === '经常读错') frequentError += 1;
    else unfamiliar += 1;
  }
  return { mastered, basic, unfamiliar, frequentError };
}

/** 给上层用的完整统计：总量与分桶都实时来自字库。 */
function buildStats(state, studyMinutes) {
  return Object.assign({}, state.stats, deriveMasteryCounts(state.characters), {
    totalRecognized: state.characters.length,
    studyTimeMinutes: studyMinutes || 0,
  });
}

/** 拍照识字后入库。返回真正新增的字（已存在的不重复计入）。 */
function addCharacters(state, drafts, source, sourceDetail) {
  const existing = new Set(state.characters.map((c) => c.char));
  const added = [];

  drafts.forEach((draft, index) => {
    const symbol = typeof draft.char === 'string' ? draft.char : '';
    if (!symbol || existing.has(symbol)) return;
    existing.add(symbol);
    added.push({
      id: `ocr-${Date.now()}-${index}`,
      char: symbol,
      pinyin: draft.pinyin || '',
      tone: 0,
      radical: draft.radical || '',
      strokeCount: Number.isFinite(Number(draft.strokeCount)) ? Number(draft.strokeCount) : 0,
      meaning: draft.meaning || '',
      words: Array.isArray(draft.words) ? draft.words : [],
      exampleSentence: draft.exampleSentence || '',
      source: source || '课外书',
      // 优先用每条自带的出处，其次是本次拍照的课文标题，最后才退回一句笼统描述。
      sourceDetail: draft.sourceDetail || sourceDetail || `拍照识别自${source || '课外书'}`,
      dateEncountered: todayLabel(),
      mastery: '不熟',
      canRead: false,
      canWrite: false,
      canDictate: false,
      errorCount: 0,
      memoryNote: `“${symbol}”是孩子在${source || '课外书'}拍照识别提取的`,
    });
  });

  if (added.length > 0) {
    state.characters = added.concat(state.characters);
    state.stats.todayLearnedCount += added.length;
  }
  return added;
}

/**
 * 更新掌握度。返回是否发生了真实变化 —— 重复答同一个字不应该把总数刷上去。
 */
function updateMastery(state, charId, newMastery, responseTime, wasCorrect) {
  const target = state.characters.find((c) => c.id === charId);
  if (!target || target.mastery === newMastery) return false;

  const memoryNote = !wasCorrect
    ? `“${target.char}”孩子朗读时偶有读错，已记录进错题本`
    : responseTime > 2.5
      ? `“${target.char}”孩子认识但反应较慢（约${responseTime}秒）`
      : `“${target.char}”认读非常熟练，反应时间${responseTime}秒`;

  target.mastery = newMastery;
  target.reactionTimeSeconds = responseTime;
  target.errorCount = wasCorrect ? target.errorCount : target.errorCount + 1;
  target.memoryNote = memoryNote;

  if (wasCorrect) {
    state.stats.todayMasteredCount += 1;
  } else {
    state.stats.frequentError += 1;
    state.stats.todayReviewCount += 1;
  }
  return true;
}

function markCanWrite(state, charId) {
  const target = state.characters.find((c) => c.id === charId);
  if (target) target.canWrite = true;
}

/** 用查字结果补全某个字的部首、笔画、例句等字段。 */
function enrichCharacter(state, charId, info) {
  const target = state.characters.find((c) => c.id === charId);
  if (!target) return;
  if (info.radical) target.radical = info.radical;
  if (Number(info.strokeCount) > 0) target.strokeCount = Number(info.strokeCount);
  if (info.pinyin) target.pinyin = info.pinyin;
  if (info.meaning) target.meaning = info.meaning;
  if (Array.isArray(info.words) && info.words.length) target.words = info.words;
  if (info.sentence) target.exampleSentence = info.sentence;
  if (info.originStory) target.originStory = info.originStory;
}

/**
 * 听写结果写回字库。
 *
 * 与原 Web 版 handleDictationComplete 同一套判定：默写过关即视为「认读写默」四会，
 * 不过关则记一笔错误并保持「经常读错」。
 *
 * 这里不动 mastered/frequentError 这类分桶计数 —— 它们由字库推导（见 deriveMasteryCounts），
 * 手写累加会和真实字库漂移。只累加「今日复习数」，那个是纯增量、没有推导来源。
 */
function applyDictationResults(state, results) {
  const byId = {};
  (results || []).forEach((r) => {
    if (r && r.id) byId[r.id] = r;
  });

  let changed = 0;
  state.characters.forEach((c) => {
    const r = byId[c.id];
    if (!r) return;
    c.canDictate = r.passed === true;
    c.mastery = r.passed ? '熟练' : '经常读错';
    c.memoryNote = r.passed
      ? `“${c.char}”已经能够认读、书写、默写`
      : `“${c.char}”默写时有笔画偏差，需复习巩固`;
    if (!r.passed) c.errorCount = (c.errorCount || 0) + 1;
    changed += 1;
  });

  if (results && results.length) {
    state.stats.todayReviewCount += results.length;
  }
  return changed;
}

function findByChar(state, symbol) {
  return state.characters.find((c) => c.char === symbol) || null;
}

function findById(state, id) {
  return state.characters.find((c) => c.id === id) || null;
}

/* ---------------- 今日学习时长（仅统计前台可见时间） ---------------- */

function readTodaySeconds() {
  const day = todayLabel();
  // 首页、档案页都要读这个数，缓存住就省掉重复的读盘与解析。
  if (secondsCache && secondsCache.day === day) return secondsCache.seconds;

  let seconds = 0;
  try {
    const raw = wx.getStorageSync(storageKeys.study);
    if (raw) {
      const saved = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (saved && saved.day === day && Number.isFinite(saved.seconds)) {
        seconds = Math.max(0, saved.seconds);
      }
    }
  } catch (e) {
    /* 读不到就按 0 起算 */
  }

  secondsCache = { day, seconds };
  return seconds;
}

function writeTodaySeconds(seconds) {
  secondsCache = { day: todayLabel(), seconds };
  try {
    wx.setStorageSync(storageKeys.study, JSON.stringify(secondsCache));
  } catch (e) {
    /* 存储被拒也不影响本次会话的计时 */
  }
}

/** 今日已伴读的分钟数。读的是真实累计秒数，没有预设值。 */
function getStudyMinutes() {
  return Math.floor(readTodaySeconds() / 60);
}

module.exports = {
  todayLabel,
  loadState,
  saveState,
  flushState,
  deriveMasteryCounts,
  buildStats,
  addCharacters,
  updateMastery,
  markCanWrite,
  applyDictationResults,
  enrichCharacter,
  findByChar,
  findById,
  readTodaySeconds,
  writeTodaySeconds,
  getStudyMinutes,
};
