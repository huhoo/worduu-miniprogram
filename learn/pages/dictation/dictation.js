const store = require('../../../utils/store.js');
const api = require('../../../utils/api.js');
const audio = require('../../../utils/audio.js');

const SIZE = 280; // 画布逻辑边长（px）
const PER_SESSION = 5; // 一次听写 5 个字，与原 Web 版一致

Page({
  data: {
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

  onLoad() {
    const state = store.loadState();
    this.state = state;

    const queue = buildQueue(state.characters, PER_SESSION);
    if (queue.length === 0) {
      this.setData({ empty: true, total: 0 });
      return;
    }

    this.queue = queue;
    this.strokes = [];
    this.current = [];
    this.log = [];
    this.startQuestion(0);
  },

  onHide() {
    audio.stopSpeaking();
  },

  onUnload() {
    audio.stopSpeaking();
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

    ctx.fillStyle = '#FCFAF7';
    ctx.fillRect(0, 0, SIZE, SIZE);

    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#E26D5C';
    ctx.strokeRect(3, 3, SIZE - 6, SIZE - 6);

    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#F3AFA6';
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
    let x = touch.x;
    let y = touch.y;
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

    if (!this.canvas) {
      this.finishTask(countOnlyPass, '未能取得书写图像，本次仅核对了笔画数。', '');
      return;
    }

    const that = this;
    this.setData({ evaluating: true });
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
        that.finishTask(data.isPassed === true, '', data.feedback || '');
      })
      .catch((err) => {
        // 不编造分数。只给出本地确实核对过的事实，并提醒家长复核。
        const reason = (err && err.message) || 'AI 批改不可用';
        that.finishTask(
          countOnlyPass,
          `${reason}；本次仅按笔画数判定，请家长复核。`,
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
  },

  next() {
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
    const state = store.loadState();
    this.state = state;
    const queue = buildQueue(state.characters, PER_SESSION);
    if (!queue.length) {
      this.setData({ empty: true, done: false, total: 0 });
      return;
    }
    this.queue = queue;
    this.log = [];
    this.setData({ done: false, correctCount: 0, wrongList: [], percent: 0 });
    this.startQuestion(0);
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
 * 出卷：先考还没默写过关的字，再补错过的字，最后才是其余。
 * 不洗牌 —— 字库本身按收录时间倒序，先考最近学的，符合从新到旧的复习顺序。
 * 三档之间用 seen 去重，否则一个「未过关 + 经常读错」的字会被抽中两次。
 */
function buildQueue(pool, limit) {
  const seen = new Set();
  const pick = (list) =>
    list.filter((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    });

  const pending = pick(pool.filter((c) => !c.canDictate && c.mastery !== '熟练'));
  const weak = pick(pool.filter((c) => c.mastery === '经常读错'));
  const rest = pick(pool);

  return pending.concat(weak, rest).slice(0, limit);
}
