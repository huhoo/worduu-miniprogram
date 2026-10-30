const store = require('../../../utils/store.js');
const audio = require('../../../utils/audio.js');
const { loadStrokeData } = require('../../utils/strokes.js');
const { checkStrokeOrder } = require('../../utils/strokeCheck.js');

const M = store.MASTERY;
const SIZE = 280; // 画布逻辑边长（px）
const PER_SESSION = 5; // 常规听写一轮 5 个字，与原 Web 版一致
const MAX_PRESET = 20; // 预设字集（足迹/默写库带入）单轮上限，超出先默前 20 个

/**
 * 默写页（2026-10-30 重构）：
 * - 范围：人教版教材库（第一，建设中占位）/ 自选字（第二）。「拍照收的生字」入口下线。
 * - 判定：本地逐笔笔顺比对（PRD 9.4，与笔顺动画同源）。笔顺不对通通按错，
 *   不再走 AI 逐字批改，也不编造分数（#55 用户拍板）。
 * - 词：一个默写单元可以是一个词（多字）。听时念出整个词；逐字写，写完一笔（一个字）
 *   提交后跳到下一个字；整词写错/笔顺错则整词判错，错字标红。
 * - 报告：列出本次默写的词语，错字标红；错字一键归入「待巩固默写库」供复习。
 */
Page({
  data: {
    scope: false, // 范围选择视图（无预设字带入时先选范围）
    picking: false, // 自选字的挑字面板
    picker: [], // { id, char, pinyin, picked }
    pickedCount: 0,
    currentWord: null, // 当前默写单元 { word, chars, pinyin, wordCharIds, ... }
    wordIndex: 0,
    totalWords: 0,
    charIndex: 0,
    wordCharCount: 1,
    withinWord: false,
    currentChar: '',
    isLastWord: false,
    playing: false,
    writtenStrokes: 0,
    revealed: false,
    isCorrect: false,
    verdictNote: '',
    evaluating: false,
    done: false,
    reportWords: [], // [{ word, pinyin, chars:[{char,wrong}], passed }]
    correctWords: 0,
    wrongCount: 0,
    empty: false,
  },

  onLoad(options) {
    const state = store.loadState();
    this.state = state;

    // 预设字集：从学习足迹日详情/默写库「用这批字去默写」带入，直接开默。
    const presetIds =
      options && typeof options.chars === 'string' && options.chars
        ? options.chars.split(',').filter(Boolean)
        : [];

    if (presetIds.length) {
      this.beginSession(presetIds, true);
      return;
    }

    // 无预设 → 先选默写范围（2026-10-30 用户拍板：人教版第一、自选第二）。
    // 人教版教材字库属 R4，数据还没建，如实标「建设中」，不给假入口。
    const all = state.characters;
    this.setData({
      scope: true,
      empty: false,
      done: false,
      picking: false,
      picker: all.map((c) => ({
        id: c.id,
        char: c.char,
        pinyin: c.pinyin || '',
        picked: false,
      })),
      pickedCount: 0,
    });
  },

  /** 由字 id 列表拼出默写单元（支持词：用字的首个组词作为「词」）。 */
  buildItems(ids) {
    const state = this.state;
    return ids
      .map((id) => {
        const c = state.characters.find((x) => x.id === id);
        if (!c) return null;
        // 有组词就把它当作本次要默的「词」，逐字写；否则单字。
        const word = c.words && c.words.length ? c.words[0] : c.char;
        const chars = Array.from(word);
        const wordCharIds = chars.map((ch) => {
          const m = store.findByChar(state, ch);
          return m ? m.id : c.id;
        });
        return {
          id: c.id,
          char: c.char,
          pinyin: c.pinyin || '',
          word,
          chars,
          wordCharIds,
          strokeCount: c.strokeCount || 0,
          source: c.source || '',
        };
      })
      .filter(Boolean);
  },

  /**
   * 正式开卷。presetIds 非空时整批替换候选（仍受 MAX_PRESET 限制）；
   * fromPreset 为 true 时是足迹/默写库带入口径，需要提示截断。
   */
  beginSession(presetIds, fromPreset) {
    const state = this.state || store.loadState();
    const queue = this.buildItems(presetIds).slice(0, MAX_PRESET);
    if (queue.length === 0) {
      this.setData({ empty: true, scope: false, totalWords: 0 });
      return;
    }

    if (fromPreset && presetIds.length > queue.length) {
      wx.showToast({
        title: `已带入 ${presetIds.length} 字，本批先默 ${queue.length} 字`,
        icon: 'none',
      });
    }

    // PRD 8.4：「第一次被选入默写任务」即离开新加入 —— 建队时就流转，不等出结果。
    store.markDictationStarted(state, queue.map((c) => c.id));
    store.saveState(state);

    this.queue = queue;
    this.charLog = []; // 扁平的每字结果，给 store 回写与报告共用
    this.setData({ scope: false, picking: false, done: false });
    this.startWord(0);
  },

  /* ---------------- 范围选择 ---------------- */

  /** 人教版教材生字库：R4 数据，还没上线，如实告知。拍第一。 */
  scopeTextbook() {
    wx.showToast({ title: '人教版教材字库建设中，即将上线', icon: 'none' });
  },

  /** 自选字：展开挑字面板（排第二）。 */
  scopePick() {
    this.setData({ picking: true });
  },

  togglePick(e) {
    const id = e.currentTarget.dataset.id;
    const picker = this.data.picker.map((c) =>
      c.id === id ? Object.assign({}, c, { picked: !c.picked }) : c,
    );
    const pickedCount = picker.filter((c) => c.picked).length;
    if (pickedCount > MAX_PRESET) {
      wx.showToast({ title: `一卷最多 ${MAX_PRESET} 个字`, icon: 'none' });
      return;
    }
    this.setData({ picker, pickedCount });
  },

  confirmPick() {
    const ids = this.data.picker.filter((c) => c.picked).map((c) => c.id);
    if (!ids.length) {
      wx.showToast({ title: '先挑至少一个字', icon: 'none' });
      return;
    }
    this.beginSession(ids, false);
  },

  onHide() {
    audio.stopSpeaking();
    this.clearAutoNext();
  },

  onUnload() {
    audio.stopSpeaking();
    this.clearAutoNext();
  },

  startWord(index) {
    const item = this.queue[index];
    const chars = item.chars;
    this.charResults = new Array(chars.length).fill(null); // 本词逐字结果

    this.setData({
      wordIndex: index,
      totalWords: this.queue.length,
      isLastWord: index >= this.queue.length - 1,
      currentWord: item,
      charIndex: 0,
      wordCharCount: chars.length,
      withinWord: chars.length > 1,
      currentChar: chars[0],
      writtenStrokes: 0,
      revealed: false,
      isCorrect: false,
      verdictNote: '',
      evaluating: false,
    });
    wx.setNavigationBarTitle({ title: `听写 ${index + 1}/${this.queue.length}` });

    // 预取首字标准笔顺（与笔顺动画同源），提交时本地逐笔比对要用。
    this.localHint = '';
    this.strokeDataTask = loadStrokeData(chars[0]);

    if (wx.nextTick) wx.nextTick(() => this.initCanvas());
    else setTimeout(() => this.initCanvas(), 30);
    setTimeout(() => this.playPrompt(), 400);
  },

  /** 切到词内的下一个字（保留整词结果，不重新 reveal）。 */
  showChar() {
    const item = this.data.currentWord;
    const k = this.data.charIndex;
    this.strokes = [];
    this.current = [];
    this.setData({
      currentChar: item.chars[k],
      writtenStrokes: 0,
      revealed: false,
      evaluating: false,
      verdictNote: '',
    });
    this.strokeDataTask = loadStrokeData(item.chars[k]);
    this.redraw();
    if (wx.nextTick) wx.nextTick(() => this.initCanvas());
    else setTimeout(() => this.initCanvas(), 30);
    // 进下一个字时再念一遍整词，帮孩子对上音。
    setTimeout(() => this.playPrompt(), 350);
  },

  /* ---------------- 发音 ---------------- */

  /** 念出当前单元：词就念整词，单字就念字音。 */
  playPrompt() {
    const w = this.data.currentWord;
    if (!w) return;
    this.setData({ playing: true });
    const done = () => this.setData({ playing: false });
    if (w.chars.length > 1) audio.playSentence({ text: w.word, onEnd: done });
    else audio.playCharAudio({ char: w.char, pinyin: w.pinyin, mode: 'read', onEnd: done });
  },

  replay() {
    this.playPrompt();
  },

  /* ---------------- 画布 ---------------- */

  initCanvas() {
    const query = wx.createSelectorQuery();
    query
      .select('#dictation-canvas')
      .fields({ node: true, size: true })
      .exec((res) => {
        if (!res || !res[0] || !res[0].node) return;
        const canvas = res[0].node;
        const ctx = canvas.getContext('2d');
        const dpr = wx.getSystemInfoSync().pixelRatio || 2;
        canvas.width = SIZE * dpr;
        canvas.height = SIZE * dpr;
        ctx.scale(dpr, dpr);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        this.canvas = canvas;
        this.ctx = ctx;
        this.dpr = dpr;

        wx.createSelectorQuery()
          .select('#dictation-canvas')
          .boundingClientRect()
          .exec((rectRes) => {
            this.rect = rectRes && rectRes[0] ? rectRes[0] : null;
          });

        this.redraw();
      });
  },

  /** 米字格 + 已写笔画。听写绝不显示描红底字，否则等于把答案写出来。 */
  redraw() {
    const ctx = this.ctx;
    if (!ctx) return;

    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, SIZE, SIZE);

    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#6DB589';
    ctx.strokeRect(3, 3, SIZE - 6, SIZE - 6);

    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#BFE3C9';
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(3, SIZE / 2);
    ctx.lineTo(SIZE - 3, SIZE / 2);
    ctx.moveTo(SIZE / 2, 3);
    ctx.lineTo(SIZE / 2, SIZE - 3);
    ctx.moveTo(3, 3);
    ctx.lineTo(SIZE - 3, SIZE - 3);
    ctx.moveTo(SIZE - 3, 3);
    ctx.lineTo(3, SIZE - 3);
    ctx.stroke();
    ctx.restore();

    ctx.strokeStyle = '#2B2825';
    ctx.lineWidth = 12;

    const drawStroke = (points) => {
      if (points.length === 1) {
        ctx.beginPath();
        ctx.arc(points[0].x, points[0].y, 6, 0, Math.PI * 2);
        ctx.fillStyle = '#2B2825';
        ctx.fill();
        return;
      }
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i += 1) {
        const p1 = points[i - 1];
        const p2 = points[i];
        ctx.quadraticCurveTo(p1.x, p1.y, (p1.x + p2.x) / 2, (p1.y + p2.y) / 2);
      }
      ctx.stroke();
    };

    (this.strokes || []).forEach(drawStroke);
    if (this.current && this.current.length) drawStroke(this.current);
  },

  toCanvasPoint(touch) {
    // 微信 Touch 的标准字段是 pageX/pageY/clientX/clientY（官方文档没有 x/y）。
    // 只给 pageX/pageY 的环境里读 x/y 会得 undefined，坐标变 NaN 后被 canvas 静默
    // 丢弃 —— 现象是「笔会计数但不显示」。回退保命。
    let x = touch.x != null ? touch.x : touch.pageX;
    let y = touch.y != null ? touch.y : touch.pageY;
    const rect = this.rect;
    if (rect && (x > SIZE || y > SIZE || x < 0 || y < 0)) {
      x -= rect.left;
      y -= rect.top;
    }
    return { x, y };
  },

  onTouchStart(e) {
    if (!this.ctx || this.data.revealed) return;
    this.current = [this.toCanvasPoint(e.touches[0])];
    audio.soundEffects.playStrokeTap();
    this.redraw();
  },

  onTouchMove(e) {
    if (!this.ctx || !this.current || !this.current.length || this.data.revealed) return;
    this.current.push(this.toCanvasPoint(e.touches[0]));
    this.redraw();
  },

  onTouchEnd() {
    if (!this.current || !this.current.length || this.data.revealed) return;
    this.strokes.push(this.current);
    this.current = [];
    this.setData({ writtenStrokes: this.strokes.length });
    this.redraw();
  },

  clear() {
    if (this.data.revealed) return;
    this.strokes = [];
    this.current = [];
    this.setData({ writtenStrokes: 0 });
    this.redraw();
  },

  undo() {
    if (this.data.revealed || !this.strokes.length) return;
    this.strokes.pop();
    this.setData({ writtenStrokes: this.strokes.length });
    this.redraw();
  },

  /* ---------------- 提交与本地批改 ---------------- */

  submit() {
    if (this.data.evaluating || this.data.revealed) return;
    if (!this.strokes.length) {
      wx.showToast({ title: '先在田字格里写一笔', icon: 'none' });
      return;
    }

    const item = this.data.currentWord;
    const k = this.data.charIndex;
    const char = item.chars[k];
    const written = this.strokes.length;
    const that = this;

    this.setData({ evaluating: true });

    // 本地逐笔笔顺比对（PRD 9.4，标准数据与笔顺动画同源）。
    // 笔顺不对通通按错；拿不到标准数据只核对笔画数，不编造失败。
    const task = this.strokeDataTask || loadStrokeData(char);
    task
      .then((glyph) => {
        if (that.data.revealed) return;
        let passed = true;
        let hint = '';
        if (glyph && glyph.medians) {
          const r = checkStrokeOrder(that.strokes, SIZE, glyph.medians);
          if (r.status === 'count-error' || r.status === 'order-error') {
            passed = false;
            hint = r.detail;
          } else if (r.hint) {
            hint = r.hint;
          }
        } else if (Number(item.strokeCount) > 0) {
          // 没有中心线数据时，退而核对笔画数（差 ≥2 才算错，连笔宽容）。
          const diff = Math.abs(written - item.strokeCount);
          if (diff >= 2) {
            passed = false;
            hint = `标准 ${item.strokeCount} 笔，你写了 ${written} 笔`;
          }
        }
        that.recordChar(k, char, passed, hint);
      })
      .catch(() => {
        if (that.data.revealed) return;
        // 数据取不到：只核对笔画数，不编造失败。
        const diff = item.strokeCount > 0 ? Math.abs(written - item.strokeCount) : 0;
        const passed = diff < 2;
        that.recordChar(k, char, passed, passed ? '' : `标准 ${item.strokeCount} 笔，你写了 ${written} 笔`);
      });
  },

  /** 记下一个字的判定，并决定是继续本词下一字还是整词收尾。 */
  recordChar(k, char, passed, hint) {
    const item = this.data.currentWord;
    this.charResults[k] = { char, passed };
    this.charLog.push({
      id: item.wordCharIds[k],
      char,
      pinyin: item.pinyin,
      passed,
      written: this.strokes.length,
      wordIndex: this.data.wordIndex,
      charIndex: k,
      word: item.word,
    });

    if (!passed) audio.soundEffects.playNotice();
    else audio.soundEffects.playSuccess();

    this.setData({ evaluating: false });

    if (k < item.chars.length - 1) {
      // 词内还有字：清屏进下一个字，不弹整词判定。
      this.setData({ charIndex: k + 1 });
      this.showChar();
      return;
    }

    // 整词写完：收尾判定。
    this.finishWord(hint);
  },

  finishWord(hint) {
    const results = this.charResults;
    const passed = results.every((r) => r && r.passed);
    const wrongChars = results.filter((r) => r && !r.passed).map((r) => r.char);

    let note = '';
    if (passed) {
      note = hint ? `笔顺 ${hint}，整体写得真工整！` : '笔顺正确，写得真工整！';
    } else if (wrongChars.length) {
      note = `「${wrongChars.join('')}」笔顺有误，再练练这${wrongChars.length > 1 ? '几' : '一'}笔`;
    }

    this.setData({
      revealed: true,
      isCorrect: passed,
      verdictNote: note,
    });

    // PRD 9.3 / 用户拍板：判定正确 → 自动进入下一词（1.2s 留给绿勾和音效）。
    if (passed) {
      this.clearAutoNext();
      this.autoNextTimer = setTimeout(() => {
        this.autoNextTimer = null;
        this.next();
      }, 1200);
    }
  },

  clearAutoNext() {
    if (this.autoNextTimer) {
      clearTimeout(this.autoNextTimer);
      this.autoNextTimer = null;
    }
  },

  next() {
    this.clearAutoNext();
    if (this.data.wordIndex < this.queue.length - 1) {
      this.startWord(this.data.wordIndex + 1);
      return;
    }
    this.finish();
  },

  finish() {
    // 幂等：最后一题连点两下不该把复习数和错字次数重复累加一遍。
    if (this.data.done) return;

    const queue = this.queue;
    const charLog = this.charLog || [];

    // 报告：按词聚合，错字标红。
    const reportWords = queue.map((item, wi) => {
      const chars = item.chars.map((ch, k) => {
        const rec = charLog.find((r) => r.wordIndex === wi && r.charIndex === k);
        return { char: ch, wrong: rec ? !rec.passed : false };
      });
      const passed = chars.every((c) => !c.wrong);
      return { word: item.word, pinyin: item.pinyin, chars, passed };
    });

    const wrongCount = charLog.filter((r) => !r.passed).length;
    const correctWords = reportWords.filter((w) => w.passed).length;

    // 一次性写回字库（状态机 + 二出）。
    store.applyDictationResults(this.state, charLog);
    // 错字若不在库里（词里拆出来的部件），补进「默写复习」来源，保证能复习到。
    const state = this.state;
    let addedAny = false;
    const seen = new Set();
    charLog
      .filter((r) => !r.passed)
      .forEach((r) => {
        if (seen.has(r.char)) return;
        seen.add(r.char);
        if (!store.findByChar(state, r.char)) {
          store.addCharacters(
            state,
            [{ char: r.char, pinyin: '', meaning: '', words: [] }],
            '默写复习',
            '本次默写写错的字',
          );
          addedAny = true;
        }
      });
    store.saveState(state);

    this.setData({
      done: true,
      reportWords,
      wrongCount,
      correctWords,
      totalWords: queue.length,
      reviewReady: wrongCount > 0 && addedAny,
    });
    wx.setNavigationBarTitle({ title: '听写报告' });
  },

  /** 错字已归入待巩固默写库，去复习。 */
  goReview() {
    wx.navigateTo({ url: '/learn/pages/pool/pool' });
  },

  /** 带着本次默写成绩去生成成就卡。 */
  goAchievement() {
    const total = this.queue.length || 1;
    const correct = this.data.correctWords;
    const chars = this.queue.map((item) => item.char).slice(0, 4).join(',');
    const title = correct === total && total > 0 ? '听写默写满分奖状！' : '完成听写默写挑战！';
    const score = `默写正确 ${correct} / ${total} 词`;
    const praise = '落笔规范，笔画严谨，汉字写得越来越端正！';

    wx.navigateTo({
      url: `/learn/pages/achievement/achievement?type=dictation&title=${encodeURIComponent(title)}`
        + `&score=${encodeURIComponent(score)}&praise=${encodeURIComponent(praise)}`
        + `&chars=${encodeURIComponent(chars)}`,
    });
  },

  restart() {
    // 「再听一轮」回到范围选择，让下一次自己决定默哪批字。
    this.setData({ done: false, reportWords: [], wrongCount: 0, correctWords: 0 });
    this.onLoad({});
  },

  backHome() {
    wx.navigateBack({
      fail() {
        wx.redirectTo({ url: '/pages/index/index' });
      },
    });
  },

  goOcr() {
    wx.redirectTo({ url: '/pages/ocr/ocr' });
  },
});
