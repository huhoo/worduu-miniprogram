/**
 * 发音播放与音效。
 *
 * 发音走云端 CosyVoice（小鹿老师 / 大白哥哥两个音色），合成结果落地成临时 wav 后
 * 用 InnerAudioContext 播放。Web 版还有浏览器 speechSynthesis 作为第二引擎，
 * 小程序没有等价能力，所以云端失败时只做静默降级并回调 onEnd，不假装读过。
 */

const api = require('./api.js');
const { storageKeys } = require('./config.js');

const AUDIO_DIR = `${wx.env.USER_DATA_PATH}/ziban_tts`;
const MAX_CACHE_FILES = 80;

const fileCache = new Map(); // cacheKey -> filePath
let player = null;
let currentKey = '';

function ensureDir() {
  const fs = wx.getFileSystemManager();
  try {
    fs.accessSync(AUDIO_DIR);
  } catch (e) {
    try {
      fs.mkdirSync(AUDIO_DIR, true);
    } catch (e2) {
      /* 目录建不出来就退化为每次都重新合成 */
    }
  }
}

/** 缓存文件太多会一直占用户磁盘，超量就整体清一次。 */
function trimCache() {
  const fs = wx.getFileSystemManager();
  try {
    const files = fs.readdirSync(AUDIO_DIR);
    if (files.length <= MAX_CACHE_FILES) return;
    files.forEach((name) => {
      try {
        fs.unlinkSync(`${AUDIO_DIR}/${name}`);
      } catch (e) {
        /* 单个删不掉不影响整体 */
      }
    });
    fileCache.clear();
  } catch (e) {
    /* 读不到目录就跳过 */
  }
}

function getSpeechPreferences() {
  try {
    const raw = wx.getStorageSync(storageKeys.speechPref);
    const saved = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (saved && typeof saved.voice === 'string') return saved;
  } catch (e) {
    /* 用默认值 */
  }
  return { voice: 'teacher', speed: 'moderate' };
}

function saveSpeechPreferences(pref) {
  const updated = Object.assign(getSpeechPreferences(), pref);
  try {
    wx.setStorageSync(storageKeys.speechPref, JSON.stringify(updated));
  } catch (e) {
    /* 存不下不影响本次播放 */
  }
  return updated;
}

/** 缓存文件的落盘路径只由 cacheKey 决定，所以换一次冷启动也能直接命中。 */
function cachedPath(cacheKey) {
  return `${AUDIO_DIR}/${Math.abs(hash(cacheKey))}.wav`;
}

/**
 * 磁盘上已经有这段音频就直接播，不再请求云端。
 *
 * fileCache 只在内存里，小程序冷启动后是空的 —— 没有这一步，
 * 孩子第二天再点同一个字，明明本地有文件却要重新合成一遍（1~2 秒）。
 */
function findCachedFile(cacheKey) {
  if (fileCache.has(cacheKey)) return fileCache.get(cacheKey);
  const filePath = cachedPath(cacheKey);
  try {
    wx.getFileSystemManager().accessSync(filePath);
    fileCache.set(cacheKey, filePath);
    return filePath;
  } catch (e) {
    return null;
  }
}

function getPlayer() {
  if (!player) {
    player = wx.createInnerAudioContext();
    player.obeyMuteSwitch = false; // 识字场景不该被静音键打断
  }
  return player;
}

function stopSpeaking() {
  if (player) {
    try {
      player.stop();
    } catch (e) {
      /* 未播放时 stop 会抛，忽略 */
    }
  }
}

function playFile(filePath, { onStart, onEnd, speed, rate }) {
  const audio = getPlayer();
  audio.src = filePath;
  // 伴读语速直接落在播放器的 playbackRate 上（0.8x / 1.0x / 1.2x），
  // 合成侧不变 —— 同一段音频换语速不需要重新请求云端。
  if (typeof rate === 'number' && rate > 0) audio.playbackRate = rate;
  else audio.playbackRate = speed === 'slow' ? 0.9 : 1;

  audio.onPlay(() => {
    if (onStart) onStart();
  });
  audio.onEnded(() => {
    if (onEnd) onEnd();
  });
  audio.onError(() => {
    if (onEnd) onEnd();
  });
  audio.play();
}

/**
 * 播放一个字的标准读音或慢速拼读。
 * 云端不可用时静默失败 —— 由调用方决定要不要提示。
 */
function playCharAudio(options) {
  const {
    char,
    pinyin = '',
    sampleWord = '',
    mode = 'read',
    onStart,
    onEnd,
    onError,
  } = options || {};

  const pref = getSpeechPreferences();
  const voice = options.voice || pref.voice;
  const speed = options.speed || pref.speed;
  const cacheKey = `${char}_${pinyin}_${mode}_${voice}_${speed}_${sampleWord}`;

  stopSpeaking();

  const cached = findCachedFile(cacheKey);
  if (cached) {
    playFile(cached, { onStart, onEnd, speed });
    return Promise.resolve(true);
  }

  return api
    .ttsSpeech({ char, pinyin, sampleWord, mode, voice, speed })
    .then((res) => {
      const base64 = res && res.audioBase64;
      if (!base64) {
        if (onError) onError();
        if (onEnd) onEnd();
        return false;
      }

      ensureDir();
      trimCache();
      const filePath = cachedPath(cacheKey);
      const fs = wx.getFileSystemManager();
      fs.writeFileSync(filePath, base64, 'base64');
      fileCache.set(cacheKey, filePath);

      if (currentKey !== cacheKey) {
        currentKey = cacheKey;
      }
      playFile(filePath, { onStart, onEnd, speed });
      return true;
    })
    .catch(() => {
      if (onError) onError();
      if (onEnd) onEnd();
      return false;
    });
}

/**
 * 朗读一整句或一整段课文（伴读用）。
 *
 * 合成走云端同一个 tts-speech 接口，只是 mode=free、text 为整句；
 * 语速不进合成参数，改由播放器 playbackRate 实现，换语速不用重新请求。
 */
function playSentence(options) {
  const {
    text,
    voice,
    rate = 1,
    onStart,
    onEnd,
    onError,
  } = options || {};

  const body = typeof text === 'string' ? text.trim() : '';
  if (!body) {
    if (onEnd) onEnd();
    return Promise.resolve(false);
  }

  const pref = getSpeechPreferences();
  const v = voice || pref.voice;
  const cacheKey = `sentence_${body}_${v}`;

  stopSpeaking();

  const cached = findCachedFile(cacheKey);
  if (cached) {
    playFile(cached, { onStart, onEnd, rate });
    return Promise.resolve(true);
  }

  return api
    .ttsSpeech({ text: body, mode: 'free', voice: v })
    .then((res) => {
      const base64 = res && res.audioBase64;
      if (!base64) {
        if (onError) onError();
        if (onEnd) onEnd();
        return false;
      }

      ensureDir();
      trimCache();
      const filePath = cachedPath(cacheKey);
      const fs = wx.getFileSystemManager();
      fs.writeFileSync(filePath, base64, 'base64');
      fileCache.set(cacheKey, filePath);

      playFile(filePath, { onStart, onEnd, rate });
      return true;
    })
    .catch(() => {
      if (onError) onError();
      if (onEnd) onEnd();
      return false;
    });
}

function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i += 1) {
    h = (h << 5) - h + str.charCodeAt(i);
    h |= 0;
  }
  return h;
}

/**
 * 音效。小程序没有 Web Audio 那样的合成器，用触感反馈替代 ——
 * 答对给一次轻振动，答错给两次，落笔给一次极短振动。
 */
const soundEffects = {
  playSuccess() {
    wx.vibrateShort({ type: 'light' });
  },
  playNotice() {
    wx.vibrateShort({ type: 'heavy' });
  },
  playStrokeTap() {
    wx.vibrateShort({ type: 'light' });
  },
};

module.exports = {
  playCharAudio,
  playSentence,
  stopSpeaking,
  soundEffects,
  getSpeechPreferences,
  saveSpeechPreferences,
};
