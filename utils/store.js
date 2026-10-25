/**
 * 字库与学习记录的本地持久化。
 *
 * 与 Web 版 store/local.ts 保持同一套数据结构演化和同一条原则：
 * 首次打开字库为空，掌握度由字库本身推导，不存任何编造的学习历史。
 *
 * R2（PRD 8.4 / 9.5）：掌握度从 4 值推导升级为 5 态状态机 ——
 *   新加入 N ──首次被选入默写任务──▶ 默写中 L ──默写通过──▶ 已掌握 M
 *              │                        │
 *              │                        └──默写不通过──▶ 待巩固 R ──连续 2 次全对──▶ M（自动出库）
 *              └──（认读测试不写掌握度，只记会读/反应时长/错次）
 *   待复习 V 由 R5 的遗忘节律驱动进入，R2 只定义状态与界面，不产生 V。
 * 流转只由默写任务驱动；二出原则（连续 2 次书写正确自动出库）见 applyDictationResults。
 */

const { storageKeys } = require('./config.js');

const VERSION = 2;

/* ------------------------------------------------------------------ *
 * 5 态掌握状态（PRD 8.4）
 * ------------------------------------------------------------------ */
const MASTERY = {
  NEW: '新加入',
  LEARNING: '默写中',
  WEAK: '待巩固',
  MASTERED: '已掌握',
  REVIEW: '待复习',
};
const MASTERY_STATES = [
  MASTERY.NEW,
  MASTERY.LEARNING,
  MASTERY.WEAK,
  MASTERY.MASTERED,
  MASTERY.REVIEW,
];

/** 二出原则：待巩固字连续 2 次默写全对自动出库（PRD 9.5） */
const POOL_EXIT_STREAK = 2;

/* ------------------------------------------------------------------ *
 * 日期：内部一律 ISO（YYYY-MM-DD），展示层再格式化。
 * 老数据存的是「M月D日」标签，迁移时转 ISO。
 * ------------------------------------------------------------------ */
function todayISO() {
  const now = new Date();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}`;
}

function todayLabel() {
  const now = new Date();
  return `${now.getMonth() + 1}月${now.getDate()}日`;
}

/** ISO → 「M月D日」。空值原样返回空串，调用方自行降级。 */
function isoToLabel(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return '';
  return `${Number(m[2])}月${Number(m[3])}日`;
}

/**
 * 「M月D日」→ ISO。没有年份信息，按当前年解析；
 * 若解析结果比今天还晚（12 月的记录在次年 1 月被打开），回退一年。
 * 解析不了返回空串 —— 不猜日期，没有日期就不进足迹日历。
 */
function labelToISO(label) {
  const m = /^(\d{1,2})月(\d{1,2})日$/.exec(String(label || '').trim());
  if (!m) return '';
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  let year = new Date().getFullYear();
  const candidate = new Date(year, month - 1, day);
  if (candidate.getTime() > Date.now() + 24 * 3600 * 1000) year -= 1;
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

function seed() {
  return {
    version: VERSION,
    characters: [],
    // 只留「今日事件计数器」——纯增量、没有推导来源的两项。
    // 4 态并行计数（mastered/basic/...）已废除：与字库推导重复必漂移。
    stats: {
      todayLearnedCount: 0,
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

  const mastery = MASTERY_STATES.indexOf(raw.mastery) !== -1 ? raw.mastery : MASTERY.NEW;

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
    dateEncountered: str(raw.dateEncountered), // ISO；迁移/损坏时可能是空串
    mastery,
    // 二出计数与时间戳：R2 新增字段，老记录迁移时见 migrateCharacter。
    correctStreak: Math.max(0, num(raw.correctStreak, 0)),
    enteredPoolAt: str(raw.enteredPoolAt),
    poolExitedAt: str(raw.poolExitedAt),
    lastDictatedAt: str(raw.lastDictatedAt),
    masteredAt: str(raw.masteredAt),
    reactionTimeSeconds: num(raw.reactionTimeSeconds, 0),
    errorCount: num(raw.errorCount, 0),
    canRead: raw.canRead === true,
    canWrite: raw.canWrite === true,
    canDictate: raw.canDictate === true,
    memoryNote: str(raw.memoryNote),
  };
}

/**
 * v1（4 值掌握度）→ v2（5 态状态机）单条迁移。
 *
 * 映射原则与用户拍板一致：没有默写记录的字不 claiming 掌握度。
 *   不熟 / 基本掌握 → 新加入（认读表现由 canRead/反应时长/错次承载）
 *   熟练 + 默写过关记录 → 已掌握；熟练但没默写过 → 新加入
 *   经常读错 → 待巩固（错次真实保留；入池时间无记录，留空不显示天数）
 *   待复习 → 待复习
 * 连续正确计数一律从 0 起 —— 老数据没有记录过连胜，不编造。
 */
function migrateCharacter(raw, index) {
  const c = normalizeCharacter(raw, index);
  if (!c) return null;

  c.dateEncountered = labelToISO(raw && raw.dateEncountered);

  const legacy = raw && raw.mastery;
  if (legacy === '熟练') {
    c.mastery = c.canDictate ? MASTERY.MASTERED : MASTERY.NEW;
  } else if (legacy === '经常读错') {
    c.mastery = MASTERY.WEAK;
  } else if (legacy === '待复习') {
    c.mastery = MASTERY.REVIEW;
  } else {
    // 不熟 / 基本掌握 / 其它意外值：从未进过默写任务，从新加入开始。
    c.mastery = MASTERY.NEW;
  }

  // 连续正确计数一律从 0 起 —— 老数据没有记录过连胜，不编造。
  c.correctStreak = 0;
  return c;
}

/** 损坏、为空或跨天的数据都回落到种子值，绝不抛错。 */
function loadState() {
  if (stateCache) return stateCache;

  const parsed = readRaw();
  const base = seed();
  if (!parsed || !Array.isArray(parsed.characters)) {
    stateCache = base;
    return stateCache;
  }

  const fromV1 = parsed.version === 1;
  const characters = parsed.characters
    .map((c, i) => (fromV1 ? migrateCharacter(c, i) : normalizeCharacter(c, i)))
    .filter(Boolean);

  const state = {
    version: VERSION,
    characters,
    // 只认这两个今日计数器，老 stats 里的 4 态并行计数连同废字段一起丢掉。
    stats: {
      todayLearnedCount: Number.isFinite(Number(parsed.stats && parsed.stats.todayLearnedCount))
        ? Number(parsed.stats.todayLearnedCount)
        : 0,
      todayReviewCount: Number.isFinite(Number(parsed.stats && parsed.stats.todayReviewCount))
        ? Number(parsed.stats.todayReviewCount)
        : 0,
      studyTimeMinutes: 0,
    },
    childNickname: typeof parsed.childNickname === 'string' ? parsed.childNickname.slice(0, 12) : '',
    day: typeof parsed.day === 'string' ? parsed.day : base.day,
  };

  // 换天就把「今日」两项归零，否则昨天的数字会一直挂着。
  if (state.day !== base.day) {
    state.day = base.day;
    state.stats.todayLearnedCount = 0;
    state.stats.todayReviewCount = 0;
  }

  stateCache = state;
  // v1 → v2 是一次性迁移，落盘后不再重复迁移（存储键名不变，老用户字库不丢）。
  if (fromV1) persistState(state);
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
  const counts = {
    newCount: 0,
    learningCount: 0,
    weakCount: 0,
    masteredCount: 0,
    reviewCount: 0,
  };
  for (const c of characters) {
    if (c.mastery === MASTERY.LEARNING) counts.learningCount += 1;
    else if (c.mastery === MASTERY.WEAK) counts.weakCount += 1;
    else if (c.mastery === MASTERY.MASTERED) counts.masteredCount += 1;
    else if (c.mastery === MASTERY.REVIEW) counts.reviewCount += 1;
    else counts.newCount += 1;
  }
  return counts;
}

/** 给上层用的完整统计：总量与分桶都实时来自字库。 */
function buildStats(state, studyMinutes) {
  const today = todayISO();
  const todayMastered = state.characters.filter((c) => c.masteredAt === today).length;
  return Object.assign({}, state.stats, deriveMasteryCounts(state.characters), {
    totalRecognized: state.characters.length,
    todayMasteredCount: todayMastered,
    studyTimeMinutes: studyMinutes || 0,
  });
}

/** 拍照识字后入库。返回真正新增的字（已存在的不重复计入）。 */
let idSeq = 0;
function addCharacters(state, drafts, source, sourceDetail) {
  const existing = new Set(state.characters.map((c) => c.char));
  const added = [];

  drafts.forEach((draft, index) => {
    const symbol = typeof draft.char === 'string' ? draft.char : '';
    if (!symbol || existing.has(symbol)) return;
    existing.add(symbol);
    added.push({
      // 序号后缀不能省：同一毫秒内的两次批量入库（测试/快速连续操作）会撞 id，
      // 撞了之后听写结果会按 id 同时写到两个字上。
      id: `ocr-${Date.now()}-${(idSeq += 1).toString(36)}-${index}`,
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
      dateEncountered: todayISO(),
      mastery: MASTERY.NEW,
      correctStreak: 0,
      enteredPoolAt: '',
      poolExitedAt: '',
      lastDictatedAt: '',
      masteredAt: '',
      canRead: false,
      canWrite: false,
      canDictate: false,
      errorCount: 0,
      memoryNote:
        source === '手写查字'
          ? `“${symbol}”是孩子手写查字时确认加入的`
          : `“${symbol}”是孩子在${source || '课外书'}拍照识别提取的`,
    });
  });

  if (added.length > 0) {
    state.characters = added.concat(state.characters);
    state.stats.todayLearnedCount += added.length;
  }
  return added;
}

/**
 * 认读测试结果写回（R2 起不再联动掌握度）。
 *
 * 5 态状态机的所有流转都指向默写任务（PRD 8.4），认读只记真实可验证的事实：
 * 会不会读、反应多久、错过几次。掌握度保持原状，直到这个字进入默写。
 */
function recordReadingResult(state, charId, correct, responseTime) {
  const target = state.characters.find((c) => c.id === charId);
  if (!target) return false;

  target.reactionTimeSeconds = responseTime;
  if (correct) {
    target.canRead = true;
    target.memoryNote =
      responseTime > 2.5
        ? `“${target.char}”认识但反应较慢（约${responseTime}秒）`
        : `“${target.char}”认读非常熟练，反应时间${responseTime}秒`;
  } else {
    target.errorCount = (target.errorCount || 0) + 1;
    target.memoryNote = `“${target.char}”朗读时读错，已记进错题本（累计错 ${target.errorCount} 次）`;
  }
  return true;
}

/**
 * 默写任务开始：被选入任务的新加入字流转为默写中。
 * PRD 8.4：「第一次被选入默写任务」即离开新加入，不等出结果。
 */
function markDictationStarted(state, charIds) {
  let changed = 0;
  (charIds || []).forEach((id) => {
    const target = state.characters.find((c) => c.id === id);
    if (target && target.mastery === MASTERY.NEW) {
      target.mastery = MASTERY.LEARNING;
      changed += 1;
    }
  });
  return changed;
}

/**
 * 听写结果写回字库 —— 5 态状态机 + 二出原则（PRD 8.4 / 9.5）。
 *
 * 判定维度 = 当前听写的 AI 字形批改（笔顺序列比对未接入前如实按此标准，
 * 用户已拍板）。流转：
 *   passed  默写中 → 已掌握（首次全对）
 *   passed  待巩固 → 连续正确 +1；满 POOL_EXIT_STREAK 次 → 已掌握并自动出库
 *   failed  默写中 → 待巩固（入池，错 1 次）
 *   failed  待巩固 → 连续正确计数清零，累计错次 +1，留库
 *   failed  已掌握 → 待巩固（掌握的字默写出错，回炉走二出）
 */
function applyDictationResults(state, results) {
  const byId = {};
  (results || []).forEach((r) => {
    if (r && r.id) byId[r.id] = r;
  });

  const today = todayISO();
  let changed = 0;

  state.characters.forEach((c) => {
    const r = byId[c.id];
    if (!r) return;
    const passed = r.passed === true;
    c.lastDictatedAt = today;
    c.canDictate = passed;

    if (passed) {
      if (c.mastery === MASTERY.WEAK) {
        c.correctStreak += 1;
        if (c.correctStreak >= POOL_EXIT_STREAK) {
          // 二出原则达成：连续全对出库
          c.mastery = MASTERY.MASTERED;
          c.masteredAt = today;
          c.poolExitedAt = today;
          c.enteredPoolAt = '';
          c.correctStreak = 0;
          c.memoryNote = `“${c.char}”连续 ${POOL_EXIT_STREAK} 次默写全对，按二出原则自动出库`;
        } else {
          c.memoryNote = `“${c.char}”默写全对，连续正确 ${c.correctStreak}/${POOL_EXIT_STREAK}，再全对 ${
            POOL_EXIT_STREAK - c.correctStreak
          } 次即出库`;
        }
      } else {
        // 默写中（或意外残留的新加入）首次全对 → 已掌握；已掌握保持。
        // masteredAt 只在「新达到已掌握」时记，已掌握字再次全对不刷新 ——
        // 否则「今日掌握」会被重复默写的老字虚充。
        const wasMastered = c.mastery === MASTERY.MASTERED;
        c.mastery = MASTERY.MASTERED;
        if (!wasMastered) c.masteredAt = today;
        c.correctStreak = 0;
        c.memoryNote = wasMastered
          ? `“${c.char}”默写全对，保持已掌握`
          : `“${c.char}”首次默写全对，达到已掌握`;
      }
    } else {
      if (c.mastery === MASTERY.MASTERED) {
        c.mastery = MASTERY.WEAK;
        c.enteredPoolAt = today;
        c.poolExitedAt = '';
        c.masteredAt = '';
        c.memoryNote = `“${c.char}”默写出错，从已掌握回到待巩固`;
      } else if (c.mastery === MASTERY.WEAK) {
        c.memoryNote = `“${c.char}”默写仍有误，连续正确计数清零（累计错 ${
          (c.errorCount || 0) + 1
        } 次）`;
      } else {
        c.mastery = MASTERY.WEAK;
        c.enteredPoolAt = today;
        c.memoryNote = `“${c.char}”默写有误，进入待巩固默写库`;
      }
      c.correctStreak = 0;
      c.errorCount = (c.errorCount || 0) + 1;
    }
    changed += 1;
  });

  if (results && results.length) {
    state.stats.todayReviewCount += results.length;
  }
  return changed;
}

/**
 * 家长手动出库（需家长密码，R2 最小版只保护这一个操作）。
 * PRD 9.5：手动移出不改变历史错次统计；8.4：「主动通过」是离开默写中的
 * 正当路径之一，故归档为已掌握，备注里如实写明是手动出库。
 */
function manualPoolExit(state, charId) {
  const target = state.characters.find((c) => c.id === charId);
  if (!target || target.mastery !== MASTERY.WEAK) return false;
  target.mastery = MASTERY.MASTERED;
  target.masteredAt = todayISO();
  target.poolExitedAt = todayISO();
  target.enteredPoolAt = '';
  target.correctStreak = 0;
  target.memoryNote = `“${target.char}”经家长确认手动出库（历史累计错 ${target.errorCount || 0} 次保留）`;
  return true;
}

/* ---------------- 默写库查询 ---------------- */

/** 当前在池的待巩固字。 */
function poolChars(state) {
  return state.characters.filter((c) => c.mastery === MASTERY.WEAK);
}

/** 最近出库的字（已出库折叠区）。迁移字没有出库记录，不会出现这里。 */
function recentlyExitedChars(state, withinDays) {
  const cutoff = Date.now() - (withinDays || 7) * 24 * 3600 * 1000;
  return state.characters.filter((c) => {
    if (c.mastery !== MASTERY.MASTERED || !c.poolExitedAt) return false;
    const t = new Date(`${c.poolExitedAt}T00:00:00`).getTime();
    return Number.isFinite(t) && t >= cutoff;
  });
}

/* ---------------- 学习足迹（按天生字账本，PRD 8.3） ---------------- */

/**
 * 足迹是字库数据在时间维度上的投影，不建平行账本 ——
 * 平行账本会和字库漂移（删字/改日期就对不上），投影永远不会。
 */
function allFootprintDays(state) {
  const byDay = {};
  state.characters.forEach((c) => {
    if (!c.dateEncountered) return;
    byDay[c.dateEncountered] = (byDay[c.dateEncountered] || 0) + 1;
  });
  return Object.keys(byDay)
    .sort()
    .map((iso) => ({ iso, count: byDay[iso] }));
}

function charsAddedOn(state, iso) {
  return state.characters.filter((c) => c.dateEncountered === iso);
}

function charsAddedBetween(state, startISO, endISO) {
  return state.characters.filter((c) => {
    if (!c.dateEncountered) return false;
    return c.dateEncountered >= startISO && c.dateEncountered <= endISO;
  });
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
  MASTERY,
  MASTERY_STATES,
  POOL_EXIT_STREAK,
  todayISO,
  todayLabel,
  isoToLabel,
  labelToISO,
  loadState,
  saveState,
  flushState,
  deriveMasteryCounts,
  buildStats,
  addCharacters,
  recordReadingResult,
  markDictationStarted,
  applyDictationResults,
  manualPoolExit,
  poolChars,
  recentlyExitedChars,
  allFootprintDays,
  charsAddedOn,
  charsAddedBetween,
  markCanWrite,
  enrichCharacter,
  findByChar,
  findById,
  readTodaySeconds,
  writeTodaySeconds,
  getStudyMinutes,
};
