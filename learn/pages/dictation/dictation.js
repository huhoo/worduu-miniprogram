const store = require('../../../utils/store.js');
const api = require('../../../utils/api.js');
const audio = require('../../../utils/audio.js');
const { loadStrokeData } = require('../../utils/strokes.js');
const { checkStrokeOrder } = require('../../utils/strokeCheck.js');

const M = store.MASTERY;
const SIZE = 280; // 画布逻辑边长（px）
const PER_SESSION = 5; // 常规听写一轮 5 个字，与原 Web 版一致
const MAX_PRESET = 20; // 预设字集（足迹/默写库带入）单轮上限，超出先默前 20 个

Page({
  data: {
    scope: false, // 范围选择视图（无预设字带入时先选范围）
    picking: false, // 自选字的挑字面板
    picker: [], // { id, char, pinyin, picked }
    pickedCount: 0,
    photoCount: 0,
    current: null,
    index: 0,
    total: 0,
    isLast: false,
    playing: false,
    writtenStrokes: 0,
    revealed: false,
    isCorrect: false,
    verdictNote: '',
    feedback: '',
    evaluating: false,
    done: false,
    correctCount: 0,
    wrongList: [],
    percent: 0,
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

    // 无预设 → 先选默写范围（2026-10-25 用户反馈：人教版 / 拍照 / 自选）。
    // 人教版教材字库属 R4，数据还没建，如实标「建设中」，不给假入口。
    const all = state.characters;
    this.setData({
      scope: true,
      empty: false,
      done: false,
      photoCount: all.filter((c) => c.source !== '手写查字').length,
      picker: all.map((c) => ({
        id: c.id,
        char: c.char,
        pinyin: c.pinyin || '',
        picked: false,
      })),
      pickedCount: 0,
      picking: false,
    });
  },

  /**
   * 正式开卷。presetIds 非空时整批替换候选（仍受 MAX_PRESET 限制）；
   * fromPreset 为 true 时是足迹/默写库带入口径，需要提示截断。
   */
  beginSession(presetIds, fromPreset) {
    const state = this.state || store.loadState();
    const queue = buildQueue(state.characters, PER_SESSION, presetIds);
    if (queue.length === 0) {
      this.setData({ empty: true, scope: false, total: 0 });
      return;
    }

    if (fromPreset && presetIds.length > queue.length) {
      wx.showToast({
        title: `已按足迹带入 ${presetIds.length} 字，本批先默 ${queue.length} 字`,
        icon: 'none',
      });
    }

    // PRD 8.4：「第一次被选入默写任务」即离开新加入 —— 建队时就流转，不等出结果。
    store.markDictationStarted(
      state,
      queue.map((c) => c.id),
    );
    store.saveState(state);

    this.queue = queue;
    this.strokes = [];
    this.current = [];
    this.log = [];
    this.setData({ scope: false, picking: false, done: false });
    this.startQuestion(0);
  },

  /* ---------------- 范围选择 ---------------- */

  /** 拍照收的生字：拍照识字收进来的字（手写查字另算），先默最近收的。 */
  scopePhoto() {
    const photoChars = this.state.characters.filter((c) => c.source !== '手写查字');
    if (!photoChars.length) {
      wx.showToast({ title: '字库还是空的，先去拍照认字', icon: 'none' });
      return;
    }
    this.beginSession(photoChars.map((c) => c.id), false);
  },

  /** 人教版教材生字库：R4 数据，还没上线，如实告知。 */
  scopeTextbook() {
    wx.showToast({ title: '人教版教材字库建设中，即将上线', icon: 'none' });
  },

  /** 自选字：展开挑字面板。 */
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
    // 切后台时取消自动跳转：回来看到的是带「下一字」按钮的判定态，手动继续。
    this.clearAutoNext();
  },

  onUnload() {
    audio.stopSpeaking();
    this.clearAutoNext();
  },

  startQuestion(index) {
    const item = this.queue[index];
    this.strokes = [];
    this.current = [];

    this.setData({
      index,
      total: this.queue.length,
      isLast: index >= this.queue.length - 1,
      current: Object.assign({}, item, {
        wordsText: (item.words || []).join('、'),
      }),
      // 笔画数可能没查出来（0），直接显示「0 笔」会误导，这里如实标未记录。
      hasStandard: Number(item.strokeCount) > 0,
      writtenStrokes: 0,
      revealed: false,
      isCorrect: false,
      verdictNote: '',
      feedback: '',
      evaluating: false,
    });
    wx.setNavigationBarTitle({ title: `听写 ${index + 1}/${this.queue.length}` });

    // 预取该字的标准笔顺（与笔顺动画同源数据），提交时本地逐笔比对要用。
    this.localHint = '';
    this.strokeDataTask = loadStrokeData(item.char);

    // 等画布就绪再重画；晚 400ms 自动读一遍，和原 Web 版的节奏一致。
    if (wx.nextTick) wx.nextTick(() => this.initCanvas());
    else setTimeout(() => this.initCanvas(), 30);
    setTimeout(() => this.playRead(), 400);
  },

  /* ---------------- 发音 ---------------- */

  playRead() {
    const item = this.data.current;
    if (!item) return;
    this.setData({ playing: true });
    audio.playCharAudio({
      char: item.char,
      pinyin: item.pinyin,
      sampleWord: (item.words || [])[0],
      mode: 'read',
      onEnd: () => this.setData({ playing: false }),
    });
  },

  playSpell() {
    const item = this.data.current;
    if (!item) return;
    this.setData({ playing: true });
    audio.playCharAudio({
      char: item.char,
      pinyin: item.pinyin,
      sampleWord: (item.words || [])[0],
      mode: 'spell',
      onEnd: () => this.setData({ playing: false }),
    });
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

        // 另起一个 query —— 同一个 SelectorQuery 对象不能重复 exec。
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
    // 丢弃 —— 现象是「笔会计数但不显示」。回退保命，两种字段都有的环境行为不变。
    let x = touch.x != null ? touch.x : touch.pageX;
    let y = touch.y != null ? touch.y : touch.pageY;
    const rect = this.rect;
    // 拿到的是页面坐标时（部分基础库），减掉画布偏移换算回画布坐标。
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

  /* ---------------- 提交与批改 ---------------- */

  submit() {
    if (this.data.evaluating || this.data.revealed) return;
    if (!this.strokes.length) {
      wx.showToast({ title: '先在田字格里写一笔', icon: 'none' });
      return;
    }

    const item = this.data.current;
    const written = this.strokes.length;
    const standard = Number(item.strokeCount) || 0;
    // 拿不到 AI 结论时的兜底判定：笔画数差 1 以内算对。这是唯一本地可验证的事实。
    const countOnlyPass = standard > 0 ? Math.abs(written - standard) <= 1 : false;
    const that = this;

    this.setData({ evaluating: true });
    this.localHint = '';

    // 本地逐笔笔顺比对（PRD 9.4，标准数据与笔顺动画同源）。能本地定论的
    // （笔画数差 ≥2、顺序错）立即反馈，省一轮十几秒的 AI 等待；
    // 拿不到标准数据或比对放行时照旧走 AI —— 本地不猜，AI 不可用只报事实。
    const task = this.strokeDataTask || loadStrokeData(item.char);
    task
      .then((glyph) => {
        if (that.data.revealed) return;
        if (glyph && glyph.medians) {
          const r = checkStrokeOrder(that.strokes, SIZE, glyph.medians);
          if (r.status === 'count-error' || r.status === 'order-error') {
            that.finishTask(false, r.detail, '');
            return;
          }
          that.localHint = r.hint || '';
        }
        that.proceedToAi(written, standard, countOnlyPass);
      })
      .catch(() => {
        if (that.data.revealed) return;
        that.proceedToAi(written, standard, countOnlyPass);
      });
  },

  /** 本地比对放行后的 AI 批改路径（原 submit 主体）。 */
  proceedToAi(written, standard, countOnlyPass) {
    const that = this;

    if (!this.canvas) {
      this.finishTask(countOnlyPass, '未能取得书写图像，本次仅核对了笔画数。', '');
      return;
    }

    const dpr = this.dpr || wx.getSystemInfoSync().pixelRatio || 2;
    const side = Math.round(SIZE * dpr);

    wx.canvasToTempFilePath({
      canvas: this.canvas,
      x: 0,
      y: 0,
      width: side,
      height: side,
      destWidth: side,
      destHeight: side,
      fileType: 'png',
      success(res) {
        let base64 = '';
        try {
          base64 = wx.getFileSystemManager().readFileSync(res.tempFilePath, 'base64');
        } catch (err) {
          that.finishTask(countOnlyPass, '读取书写图片失败，本次仅核对了笔画数。', '');
          return;
        }
        that.requestEvaluate(base64, written, standard, countOnlyPass);
      },
      fail() {
        that.finishTask(countOnlyPass, '导出书写图片失败，本次仅核对了笔画数。', '');
      },
    });
  },

  requestEvaluate(base64, written, standard, countOnlyPass) {
    const that = this;
    const item = this.data.current;

    api
      .evaluateWriting({
        char: item.char,
        strokeCount: standard,
        strokeOrderLogs: [{ written }],
        canvasBase64: `data:image/png;base64,${base64}`,
      })
      .then((data) => {
        that.finishTask(data.isPassed === true, that.localHint || '', data.feedback || '');
      })
      .catch((err) => {
        // 不编造分数。只给出本地确实核对过的事实，并提醒家长复核。
        const reason = (err && err.message) || 'AI 批改不可用';
        const note = that.localHint ? `${reason}；${that.localHint}` : reason;
        that.finishTask(
          countOnlyPass,
          `${note}；本次仅按笔画数判定，请家长复核。`,
          '',
        );
      });
  },

  finishTask(passed, note, feedback) {
    const item = this.data.current;
    const written = this.strokes.length;

    this.log = this.log.filter((entry) => entry.id !== item.id).concat([
      { id: item.id, char: item.char, pinyin: item.pinyin, passed, written },
    ]);

    if (passed) audio.soundEffects.playSuccess();
    else audio.soundEffects.playNotice();

    this.setData({
      evaluating: false,
      revealed: true,
      isCorrect: passed,
      verdictNote: note || '',
      feedback: feedback || '',
      correctCount: this.data.correctCount + (passed ? 1 : 0),
    });

    // PRD 9.3：字形判定正确 → 绿勾 → 自动进入下一字（2026-10-25 用户反馈补上）。
    // 留 1.2 秒给绿勾和音效；期间手动点「下一字」会先清掉这个定时器，不会跳两个字。
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
    if (this.data.index < this.queue.length - 1) {
      this.startQuestion(this.data.index + 1);
      return;
    }
    this.finish();
  },

  finish() {
    // 幂等：最后一题连点两下不该把复习数和错字次数重复累加一遍。
    if (this.data.done) return;

    const total = this.queue.length || 1;
    const correctCount = this.data.correctCount;
    const wrongList = this.log.filter((entry) => !entry.passed);

    // 一次性写回字库：过关记「认读写默」四会，没过关留一句需要复习的备注。
    store.applyDictationResults(this.state, this.log);
    store.saveState(this.state);

    this.setData({
      done: true,
      wrongList,
      percent: Math.round((correctCount / total) * 100),
    });
    wx.setNavigationBarTitle({ title: '听写报告' });
  },

  playWrong(e) {
    const char = e.currentTarget.dataset.char;
    const entry = this.data.wrongList.find((w) => w.char === char);
    if (!entry) return;
    audio.playCharAudio({ char: entry.char, pinyin: entry.pinyin, mode: 'read' });
  },

  /** 带着本次默写成绩去生成成就卡。 */
  goAchievement() {
    const total = this.queue.length || 1;
    const correct = this.data.correctCount;
    const chars = this.queue.map((item) => item.char).slice(0, 4).join(',');
    const title = correct === total && total > 0 ? '听写默写满分奖状！' : '完成听写默写挑战！';
    const score = `默写正确 ${correct} / ${total} 字`;
    const praise = '落笔规范，笔画严谨，汉字写得越来越端正！';

    wx.navigateTo({
      url: `/learn/pages/achievement/achievement?type=dictation&title=${encodeURIComponent(title)}`
        + `&score=${encodeURIComponent(score)}&praise=${encodeURIComponent(praise)}`
        + `&chars=${encodeURIComponent(chars)}`,
    });
  },

  restart() {
    // 「再听一轮」回到范围选择，让下一次自己决定默哪批字。
    this.setData({ done: false, correctCount: 0, wrongList: [], percent: 0 });
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

/**
 * 出卷：先救待巩固的错字（二出池），再考前三种未闭环状态，已掌握的押后。
 * 不洗牌 —— 字库本身按收录时间倒序，先考最近学的，符合从新到旧的复习顺序。
 * 三档之间用 seen 去重，否则一个字会因同时命中多档被抽中两次。
 *
 * presetIds 非空时（足迹/默写库带入）整批替换候选，仍受 MAX_PRESET 限制；
 * 带入而字已不在库的（被移出过）静默剔除。
 */
function buildQueue(pool, limit, presetIds) {
  const seen = new Set();
  const pick = (list) =>
    list.filter((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    });

  if (presetIds && presetIds.length) {
    const wanted = new Set(presetIds);
    return pool.filter((c) => wanted.has(c.id)).slice(0, MAX_PRESET);
  }

  const weak = pick(pool.filter((c) => c.mastery === M.WEAK));
  const pending = pick(
    pool.filter(
      (c) => c.mastery === M.NEW || c.mastery === M.LEARNING || c.mastery === M.REVIEW,
    ),
  );
  const rest = pick(pool);

  return weak.concat(pending, rest).slice(0, limit);
}
