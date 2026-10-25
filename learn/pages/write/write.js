const store = require('../../../utils/store.js');
const api = require('../../../utils/api.js');
const audio = require('../../../utils/audio.js');
const { loadStrokeData } = require('../../utils/strokes.js');
const { checkStrokeOrder } = require('../../utils/strokeCheck.js');

const SIZE = 300; // 画布逻辑边长（px）

Page({
  data: {
    tab: 'write', // write | animate | lookup
    mode: 'trace', // trace 跟写 | free 独立写
    item: null,
    strokeCount: 0,
    standardStrokeCount: 0,
    evaluating: false,
    result: null,
    note: '',
    hasNext: false,
    ready: false,
    // 手写查字：写出不认识的字 → AI 认 → 3 候选 → 选择 → 询问入库
    lookupStrokes: 0,
    recognizing: false,
    candidates: [],
    chosen: null,
    lookupNote: '',
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

    // 「标准笔画数」不信任模型给的值：上游实测同一字温度 0 也能给出 13/14/12 三个答案，
    // 而这个数既要展示给孩子、又是批改的判定基准。笔顺 medians 是权威值，
    // 拉到后覆盖；字没有权威数据时才退回字库里存的数。
    this.authoritativeCount = 0;
    this.standardMedians = null;
    const that = this;
    loadStrokeData(item.char).then((glyph) => {
      const count = glyph && Array.isArray(glyph.medians) ? glyph.medians.length : 0;
      if (!count) return;
      that.authoritativeCount = count;
      // 逐笔笔顺比对（提交时本地先判一次）与动画共用这份数据。
      that.standardMedians = glyph.medians;
      if (that.data.item && that.data.item.char === item.char) {
        that.setData({ standardStrokeCount: count });
      }
    });

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

  /** 米字格 + （可选）描红底字 + 已写笔画。写字与查字两块画板共用这套画法。 */
  paintBoard(ctx, traceChar, strokes, current) {
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

    // 描红底字：浅绿字印（BASELINE：字卡字印浅绿 #BFE3C9）
    if (traceChar) {
      ctx.save();
      ctx.font = `${Math.round(SIZE * 0.72)}px "Kaiti SC", serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#BFE3C9';
      ctx.fillText(traceChar, SIZE / 2, SIZE / 2 + SIZE * 0.05);
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

    (strokes || []).forEach(drawStroke);
    if (current && current.length) drawStroke(current);
  },

  /** 画米字格 + 描红字 + 已写笔画。每一次落笔都会整幅重画，逻辑最简单也最稳。 */
  redraw() {
    if (!this.ctx) return;
    // 跟写模式才描红；独立写/考核是白板
    this.paintBoard(
      this.ctx,
      this.data.mode === 'trace' && this.data.item ? this.data.item.char : '',
      this.strokes,
      this.current,
    );
  },

  toCanvasPoint(touch) {
    // 微信 Touch 的标准字段是 pageX/pageY/clientX/clientY（官方文档没有 x/y）。
    // 只给 pageX/pageY 的环境里读 x/y 会得 undefined，坐标变 NaN 后被 canvas 静默
    // 丢弃 —— 现象是「笔会计数但不显示」。回退保命，两种字段都有的环境行为不变。
    let x = touch.x != null ? touch.x : touch.pageX;
    let y = touch.y != null ? touch.y : touch.pageY;
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
    const tab = e.currentTarget.dataset.tab;
    this.setData({ tab });
    // wx:if 切换会销毁/重建 canvas 节点，切回写字页签必须重新初始化画布，
    // 否则旧的 ctx 引用指向已销毁的节点，落笔无声无息地画不出来。
    if (tab === 'write') {
      if (wx.nextTick) wx.nextTick(() => this.initCanvas());
      else setTimeout(() => this.initCanvas(), 30);
    } else if (tab === 'lookup') {
      if (wx.nextTick) wx.nextTick(() => this.initLookupCanvas());
      else setTimeout(() => this.initLookupCanvas(), 30);
    }
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

    // 本地逐笔笔顺比对（PRD 9.4，标准数据与笔顺动画同源）。能本地定论的
    // （笔画数差 ≥2、顺序错）立即反馈，不等十几秒的 AI；放行时照旧走 AI。
    if (this.standardMedians) {
      const local = checkStrokeOrder(this.strokes, SIZE, this.standardMedians);
      if (local.status === 'count-error' || local.status === 'order-error') {
        audio.soundEffects.playNotice();
        this.setData({
          result: {
            isPassed: false,
            shapeScore: 0,
            strokeScore: 0,
            feedback: local.detail,
            improvementsText: '对照「看笔顺动画」页签再写一遍。',
            hasImprovements: true,
          },
        });
        return;
      }
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
    // 批改的期望笔画数用权威值（笔顺数据），模型值只做兜底。
    const standardCount = this.authoritativeCount || item.strokeCount || 0;

    api
      .evaluateWriting({
        char: item.char,
        strokeCount: standardCount,
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
        const standardCount = this.authoritativeCount || item.strokeCount || 0;
        const countMatches = Math.abs(that.strokes.length - standardCount) <= 1;
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
              : `标准笔画数是 ${standardCount} 笔，你写了 ${that.strokes.length} 笔，先数对笔画。`,
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

  /* ---------------- 手写查字 ---------------- */

  initLookupCanvas() {
    const query = wx.createSelectorQuery();
    query
      .select('#lookup-canvas')
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

        this.lcanvas = canvas;
        this.lctx = ctx;
        this.ldpr = dpr;

        // 另起一个 query —— 同一个 SelectorQuery 对象不能重复 exec。
        wx.createSelectorQuery()
          .select('#lookup-canvas')
          .boundingClientRect()
          .exec((rectRes) => {
            this.lrect = rectRes && rectRes[0] ? rectRes[0] : null;
          });

        this.redrawLookup();
      });
  },

  redrawLookup() {
    if (!this.lctx) return;
    // 查字是白板：不描红、不提示，孩子写什么 AI 认什么
    this.paintBoard(this.lctx, '', this.lstrokes, this.lcurrent);
  },

  toLookupPoint(touch) {
    // 同 toCanvasPoint：微信 Touch 标准字段是 pageX/pageY，x/y 缺失时回退保命。
    let x = touch.x != null ? touch.x : touch.pageX;
    let y = touch.y != null ? touch.y : touch.pageY;
    const rect = this.lrect;
    if (rect && (x > SIZE || y > SIZE || x < 0 || y < 0)) {
      x -= rect.left;
      y -= rect.top;
    }
    return { x, y };
  },

  onLookupTouchStart(e) {
    if (!this.lctx) return;
    this.lcurrent = [this.toLookupPoint(e.touches[0])];
    audio.soundEffects.playStrokeTap();
    this.redrawLookup();
  },

  onLookupTouchMove(e) {
    if (!this.lctx || !this.lcurrent || !this.lcurrent.length) return;
    this.lcurrent.push(this.toLookupPoint(e.touches[0]));
    this.redrawLookup();
  },

  onLookupTouchEnd() {
    if (!this.lcurrent || !this.lcurrent.length) return;
    this.lstrokes = (this.lstrokes || []).concat([this.lcurrent]);
    this.lcurrent = [];
    this.setData({ lookupStrokes: this.lstrokes.length });
    this.redrawLookup();
  },

  lookupUndo() {
    if (!this.lstrokes || !this.lstrokes.length) return;
    this.lstrokes.pop();
    this.setData({ lookupStrokes: this.lstrokes.length, chosen: null });
    this.redrawLookup();
  },

  lookupClear() {
    this.lstrokes = [];
    this.lcurrent = [];
    this.setData({ lookupStrokes: 0, chosen: null });
    this.redrawLookup();
  },

  /** 导出手写板图像，请 AI 给出最多 3 个候选字。 */
  recognize() {
    if (this.data.recognizing) return;
    if (!this.lstrokes || !this.lstrokes.length) {
      wx.showToast({ title: '先在田字格里写一笔', icon: 'none' });
      return;
    }
    if (!this.lcanvas) {
      this.setData({ lookupNote: '画布还没准备好，请稍等一下再试。' });
      return;
    }

    const that = this;
    this.setData({ recognizing: true, lookupNote: '', candidates: [], chosen: null });

    const dpr = this.ldpr || wx.getSystemInfoSync().pixelRatio || 2;
    const side = Math.round(SIZE * dpr);

    wx.canvasToTempFilePath({
      canvas: this.lcanvas,
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
          that.setData({ recognizing: false, lookupNote: '读取书写图片失败，请再试一次。' });
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
              lookupNote: candidates.length
                ? ''
                : 'AI 没认出来。写大一点、一笔一画写工整，再试一次。',
            });
          })
          .catch((err) => {
            that.setData({
              recognizing: false,
              lookupNote: (err && err.message) || 'AI 认字暂时不可用，请稍后再试。',
            });
          });
      },
      fail() {
        that.setData({ recognizing: false, lookupNote: '导出书写图片失败，请再试一次。' });
      },
    });
  },

  /** 点选候选：读一遍发音帮孩子确认，再问是否入库。 */
  chooseCandidate(e) {
    const chosen = (this.data.candidates || []).find(
      (c) => c.char === e.currentTarget.dataset.char,
    );
    if (!chosen) return;
    this.setData({ chosen });
    audio.playCharAudio({ char: chosen.char, pinyin: chosen.pinyin, mode: 'read' });
  },

  rejectCandidate() {
    this.setData({ candidates: [], chosen: null });
    this.lookupClear();
  },

  /** 确认后把字收进生字库，成功后带去字卡详情。 */
  addToLibrary() {
    const chosen = this.data.chosen;
    if (!chosen) return;

    const state = store.loadState();
    const existing = store.findByChar(state, chosen.char);
    if (existing) {
      wx.showToast({ title: `“${chosen.char}”已在生字库里`, icon: 'none' });
      wx.navigateTo({ url: `/learn/pages/detail/detail?id=${existing.id}` });
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
      wx.showToast({ title: `“${chosen.char}”已加入生字库`, icon: 'success' });
      const newId = added[0].id;
      setTimeout(() => {
        wx.navigateTo({ url: `/learn/pages/detail/detail?id=${newId}` });
      }, 900);
    } else {
      wx.showToast({ title: '加入生字库失败，请重试', icon: 'none' });
    }
  },

  goOcr() {
    wx.navigateTo({ url: '/pages/ocr/ocr' });
  },
});
