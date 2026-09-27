const store = require('../../utils/store.js');
const api = require('../../utils/api.js');
const audio = require('../../utils/audio.js');

const SIZE = 300; // 画布逻辑边长（px）

Page({
  data: {
    tab: 'write', // write | animate
    mode: 'trace', // trace 跟写 | free 独立写
    item: null,
    strokeCount: 0,
    standardStrokeCount: 0,
    evaluating: false,
    result: null,
    note: '',
    hasNext: false,
    ready: false,
  },

  onLoad(options) {
    const state = store.loadState();
    this.state = state;

    let item = null;
    if (options.char) item = store.findByChar(state, decodeURIComponent(options.char));
    if (!item) item = state.characters.find((c) => !c.canWrite);
    if (!item) item = state.characters[0];

    if (!item) {
      this.setData({ ready: true });
      return;
    }

    this.strokes = [];
    this.current = [];
    this.pick(item);
  },

  onHide() {
    audio.stopSpeaking();
  },

  pick(item) {
    this.strokes = [];
    this.current = [];
    this.setData({
      item: Object.assign({}, item, { wordsText: (item.words || []).join('、') }),
      standardStrokeCount: item.strokeCount || 0,
      strokeCount: 0,
      result: null,
      note: '',
      ready: true,
    });
    wx.setNavigationBarTitle({ title: `写“${item.char}”` });

    // 等这一帧渲染完，选择器才拿得到 canvas 节点。
    if (wx.nextTick) wx.nextTick(() => this.initCanvas());
    else setTimeout(() => this.initCanvas(), 30);
  },

  /* ---------------- 画布 ---------------- */

  initCanvas() {
    const query = wx.createSelectorQuery();
    query
      .select('#write-canvas')
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

        // 触摸坐标在部分基础库下是页面坐标，需要画布偏移才能换算。
        // 另起一个 query —— 同一个 SelectorQuery 对象不能重复 exec。
        wx.createSelectorQuery()
          .select('#write-canvas')
          .boundingClientRect()
          .exec((rectRes) => {
            this.rect = rectRes && rectRes[0] ? rectRes[0] : null;
          });

        this.redraw();
      });
  },

  /** 画米字格 + 描红字 + 已写笔画。每一次落笔都会整幅重画，逻辑最简单也最稳。 */
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

    // 跟写模式的描红底字
    if (this.data.mode === 'trace' && this.data.item) {
      ctx.save();
      ctx.font = `${Math.round(SIZE * 0.72)}px "Kaiti SC", serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(180, 160, 150, 0.28)';
      ctx.fillText(this.data.item.char, SIZE / 2, SIZE / 2 + SIZE * 0.05);
      ctx.restore();
    }

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
    // 页面坐标落在画布尺寸之外时，说明拿到的是页面坐标，减掉画布偏移。
    if (rect && (x > SIZE || y > SIZE || x < 0 || y < 0)) {
      x -= rect.left;
      y -= rect.top;
    }
    return { x, y };
  },

  onTouchStart(e) {
    if (!this.ctx) return;
    const point = this.toCanvasPoint(e.touches[0]);
    this.current = [point];
    audio.soundEffects.playStrokeTap();
    this.redraw();
  },

  onTouchMove(e) {
    if (!this.ctx || !this.current || !this.current.length) return;
    this.current.push(this.toCanvasPoint(e.touches[0]));
    this.redraw();
  },

  onTouchEnd() {
    if (!this.current || !this.current.length) return;
    this.strokes.push(this.current);
    this.current = [];
    this.setData({ strokeCount: this.strokes.length, result: null, note: '' });
    this.redraw();
  },

  /* ---------------- 操作 ---------------- */

  switchTab(e) {
    this.setData({ tab: e.currentTarget.dataset.tab });
  },

  switchMode(e) {
    this.setData({ mode: e.currentTarget.dataset.mode });
    this.redraw();
  },

  undo() {
    if (!this.strokes.length) return;
    this.strokes.pop();
    this.setData({ strokeCount: this.strokes.length, result: null, note: '' });
    this.redraw();
  },

  clear() {
    this.strokes = [];
    this.current = [];
    this.setData({ strokeCount: 0, result: null, note: '' });
    this.redraw();
  },

  playRead() {
    const item = this.data.item;
    if (!item) return;
    audio.playCharAudio({
      char: item.char,
      pinyin: item.pinyin,
      sampleWord: (item.words || [])[0],
      mode: 'read',
    });
  },

  /** 把画布导出成图片送云端批改。 */
  evaluate() {
    if (!this.strokes.length) {
      wx.showToast({ title: '先在田字格里写一笔', icon: 'none' });
      return;
    }
    if (!this.canvas) {
      this.setData({ note: '画布还没准备好，请稍等一下再试。' });
      return;
    }

    const that = this;
    this.setData({ evaluating: true, note: '' });

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
          that.setData({ evaluating: false, note: '读取书写图片失败，请重写一次。' });
          return;
        }
        that.requestEvaluate(base64);
      },
      fail() {
        that.setData({ evaluating: false, note: '导出书写图片失败，请重写一次。' });
      },
    });
  },

  requestEvaluate(base64) {
    const that = this;
    const item = this.data.item;

    api
      .evaluateWriting({
        char: item.char,
        strokeCount: item.strokeCount,
        // 字段名沿用原 Web 版的 written —— 顶层已有 strokeCount，再重复一次只会让模型混淆。
        strokeOrderLogs: [{ written: this.strokes.length }],
        canvasBase64: `data:image/png;base64,${base64}`,
      })
      .then((data) => {
        if (data.isPassed) {
          const state = that.state || store.loadState();
          const target = store.findByChar(state, item.char);
          if (target) {
            store.markCanWrite(state, target.id);
            store.saveState(state);
          }
          audio.soundEffects.playSuccess();
        } else {
          audio.soundEffects.playNotice();
        }
        that.setData({
          evaluating: false,
          result: {
            isPassed: data.isPassed,
            shapeScore: data.shapeScore,
            strokeScore: data.strokeScore,
            feedback: data.feedback,
            improvementsText: (data.improvements || []).join('；'),
            hasImprovements: (data.improvements || []).length > 0,
          },
        });
      })
      .catch((err) => {
        // 不编造分数。只报一个本地确实能验证的事实：笔画数对不对。
        const countMatches = Math.abs(that.strokes.length - (item.strokeCount || 0)) <= 1;
        that.setData({
          evaluating: false,
          note: (err && err.message) || 'AI 书写点评暂时不可用。',
          result: {
            isPassed: false,
            shapeScore: 0,
            strokeScore: 0,
            feedback: 'AI 书写点评暂时不可用，稍后再试。',
            improvementsText: countMatches
              ? `笔画数对了（${that.strokes.length} 笔），但字形还需 AI 或老师当面确认。`
              : `标准笔画数是 ${item.strokeCount} 笔，你写了 ${that.strokes.length} 笔，先数对笔画。`,
            hasImprovements: true,
          },
        });
      });
  },

  nextChar() {
    const state = this.state || store.loadState();
    const currentChar = this.data.item ? this.data.item.char : '';
    const next =
      state.characters.find((c) => c.char !== currentChar && !c.canWrite) ||
      state.characters.find((c) => c.char !== currentChar);

    if (!next) {
      wx.showToast({ title: '字库里没有更多字了', icon: 'none' });
      return;
    }
    this.pick(next);
  },

  goOcr() {
    wx.navigateTo({ url: '/pages/ocr/ocr' });
  },
});
