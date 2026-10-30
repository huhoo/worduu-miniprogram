const store = require('../../../utils/store.js');
const api = require('../../../utils/api.js');
const audio = require('../../../utils/audio.js');

const SIZE = 300; // 画布逻辑边长（px）

/**
 * 写字识字（2026-10-29 用户拍板重构）：
 * 只留「手写查字」一条闭环 —— 空白田字格写出不认识的字 → AI 认字给最多 3 个
 * 候选 → 点候选进字详情页 → 字框旁小加号询问是否加入生字库。
 * 原来的字条选字/练写/笔顺动画页签全部下线。
 */
Page({
  data: {
    stage: 'write', // write 手写画板 | detail 候选字详情
    strokeCount: 0,
    recognizing: false,
    candidates: [],
    chosen: null, // 点选的候选 { char, pinyin, meaning, words, confidence }
    wordsText: '',
    added: false, // 该字是否已加入生字库
    addedId: '',
    note: '',
  },

  onLoad() {
    wx.setNavigationBarTitle({ title: '写字识字' });
    this.strokes = [];
    this.current = [];
    if (wx.nextTick) wx.nextTick(() => this.initCanvas());
    else setTimeout(() => this.initCanvas(), 30);
  },

  onHide() {
    audio.stopSpeaking();
  },

  /* ---------------- 画板 ---------------- */

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

  /** 米字格 + 已写笔画。查字画板是白板：不描红、不提示，写什么 AI 认什么。 */
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
    // 只读 x/y 在只给标准字段的环境里坐标变 NaN 被 canvas 静默丢弃 —— 回退保命。
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
    if (!this.ctx) return;
    this.current = [this.toCanvasPoint(e.touches[0])];
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
    this.setData({ strokeCount: this.strokes.length });
    this.redraw();
  },

  undo() {
    if (!this.strokes.length) return;
    this.strokes.pop();
    this.setData({ strokeCount: this.strokes.length, note: '' });
    this.redraw();
  },

  clearBoard() {
    this.strokes = [];
    this.current = [];
    this.setData({ strokeCount: 0, note: '', candidates: [], chosen: null, stage: 'write' });
    this.redraw();
  },

  /* ---------------- AI 认字 ---------------- */

  /** 导出手写板图像，请 AI 给出最多 3 个候选字。 */
  recognize() {
    if (this.data.recognizing) return;
    if (!this.strokes.length) {
      wx.showToast({ title: '先在田字格里写一笔', icon: 'none' });
      return;
    }
    if (!this.canvas) {
      this.setData({ note: '画布还没准备好，请稍等一下再试。' });
      return;
    }

    const that = this;
    this.setData({ recognizing: true, note: '', candidates: [], chosen: null });

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
          that.setData({ recognizing: false, note: '读取书写图片失败，请再试一次。' });
          return;
        }
        api
          .recognizeHandwriting(`data:image/png;base64,${base64}`)
          .then((data) => {
            // WXML 不能调 join()，组词先在 JS 里拼好
            const candidates = (data.candidates || []).map((c) =>
              Object.assign({}, c, { wordsText: (c.words || []).join('、') }));
            that.setData({
              recognizing: false,
              candidates,
              note: candidates.length
                ? ''
                : 'AI 没认出来。写大一点、一笔一画写工整，再试一次。',
            });
          })
          .catch((err) => {
            that.setData({
              recognizing: false,
              note: (err && err.message) || 'AI 认字暂时不可用，请稍后再试。',
            });
          });
      },
      fail() {
        that.setData({ recognizing: false, note: '导出书写图片失败，请再试一次。' });
      },
    });
  },

  /** 点候选进「下页」：这个字的详情页（读音/释义/组词 + 小加号入库）。 */
  chooseCandidate(e) {
    const chosen = (this.data.candidates || []).find(
      (c) => c.char === e.currentTarget.dataset.char,
    );
    if (!chosen) return;
    this.setData({
      chosen,
      wordsText: (chosen.words || []).join('、'),
      stage: 'detail',
      added: false,
      addedId: '',
    });
    audio.playCharAudio({ char: chosen.char, pinyin: chosen.pinyin, mode: 'read' });
  },

  backToCandidates() {
    audio.stopSpeaking();
    this.setData({ stage: 'write' });
  },

  playChosen() {
    const chosen = this.data.chosen;
    if (!chosen) return;
    audio.playCharAudio({ char: chosen.char, pinyin: chosen.pinyin, mode: 'read' });
  },

  /** 字框旁的小加号：把这个字收进生字库。 */
  addToLibrary() {
    const chosen = this.data.chosen;
    if (!chosen || this.data.added) return;

    const state = store.loadState();
    const existing = store.findByChar(state, chosen.char);
    if (existing) {
      this.setData({ added: true, addedId: existing.id });
      wx.showToast({ title: `“${chosen.char}”已在生字库里`, icon: 'none' });
      return;
    }

    const added = store.addCharacters(
      state,
      [
        {
          char: chosen.char,
          pinyin: chosen.pinyin || '',
          meaning: chosen.meaning || '',
          words: Array.isArray(chosen.words) ? chosen.words : [],
        },
      ],
      '手写查字',
      '手写查字确认后加入',
    );
    store.saveState(state);

    if (added && added.length) {
      audio.soundEffects.playSuccess();
      this.setData({ added: true, addedId: added[0].id });
      wx.showToast({ title: `“${chosen.char}”已加入生字库`, icon: 'success' });
    } else {
      wx.showToast({ title: '加入生字库失败，请重试', icon: 'none' });
    }
  },

  /** 入库后去看完整字卡。 */
  goDetail() {
    const chosen = this.data.chosen;
    if (!chosen) return;
    const id = this.data.addedId;
    if (id) {
      wx.navigateTo({ url: `/learn/pages/detail/detail?id=${id}` });
      return;
    }
    const state = store.loadState();
    const existing = store.findByChar(state, chosen.char);
    if (existing) wx.navigateTo({ url: `/learn/pages/detail/detail?id=${existing.id}` });
  },

  goOcr() {
    wx.navigateTo({ url: '/pages/ocr/ocr' });
  },
});
