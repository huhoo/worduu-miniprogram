/**
 * 笔顺动画组件。
 *
 * 小程序不支持 SVG，Web 版 StrokeGlyph 的 <path> 逐笔绘制改由 canvas 2d 重绘：
 * 同样的 medians 中心线、同样的 620ms 每笔节奏、同样的「无数据就诚实不画」策略。
 */

const { loadStrokeData } = require('../../utils/strokes.js');

const BOX = 512;
const STROKE_INTERVAL = 620;
const DRAW_DURATION = 480;

function toCanvasPoints(median, size) {
  return median.map((point) => [
    (point[0] / BOX) * size,
    ((BOX - point[1]) / BOX) * size, // 源数据 y 朝上，画布 y 朝下
  ]);
}

function drawGrid(ctx, size, isMiZiGe) {
  ctx.fillStyle = '#FCFAF7';
  ctx.fillRect(0, 0, size, size);

  ctx.lineWidth = 2.5;
  ctx.strokeStyle = '#E26D5C';
  ctx.strokeRect(2, 2, size - 4, size - 4);

  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#F3AFA6';
  ctx.setLineDash([5, 5]);

  ctx.beginPath();
  ctx.moveTo(2, size / 2);
  ctx.lineTo(size - 2, size / 2);
  ctx.moveTo(size / 2, 2);
  ctx.lineTo(size / 2, size - 2);
  ctx.stroke();

  if (isMiZiGe) {
    ctx.beginPath();
    ctx.moveTo(2, 2);
    ctx.lineTo(size - 2, size - 2);
    ctx.moveTo(size - 2, 2);
    ctx.lineTo(2, size - 2);
    ctx.stroke();
  }
  ctx.restore();
}

function tracePath(ctx, points, upto) {
  if (points.length === 0) return;
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i <= upto && i < points.length; i += 1) {
    ctx.lineTo(points[i][0], points[i][1]);
  }
  ctx.stroke();
}

/** 只画一笔的一部分，用来做「生长」效果。 */
function tracePartial(ctx, points, progress) {
  if (points.length < 2 || progress >= 1) {
    tracePath(ctx, points, points.length - 1);
    return;
  }
  if (progress <= 0) return;

  const segments = [];
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const d = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    segments.push(d);
    total += d;
  }
  if (total === 0) {
    tracePath(ctx, points, points.length - 1);
    return;
  }

  const target = total * progress;
  let acc = 0;
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i += 1) {
    if (acc + segments[i - 1] <= target) {
      ctx.lineTo(points[i][0], points[i][1]);
      acc += segments[i - 1];
    } else {
      const t = (target - acc) / (segments[i - 1] || 1);
      ctx.lineTo(
        points[i - 1][0] + (points[i][0] - points[i - 1][0]) * t,
        points[i - 1][1] + (points[i][1] - points[i - 1][1]) * t,
      );
      break;
    }
  }
  ctx.stroke();
}

Component({
  properties: {
    char: { type: String, value: '' },
    size: { type: Number, value: 240 },
    isMiZiGe: { type: Boolean, value: false },
    /** 是否显示播放控制条。书写页只想要静态的字形时可以关掉。 */
    showControls: { type: Boolean, value: true },
  },

  data: {
    status: 'loading', // loading | ready | empty
    shown: 0,
    total: 0,
    playing: false,
    dots: [],
    names: [],
    hasNames: false,
    currentName: '',
  },

  lifetimes: {
    detached() {
      this.stopTimer();
    },
  },

  observers: {
    char() {
      this.load();
    },
  },

  methods: {
    load() {
      const char = this.data.char;
      if (!char) return;

      this.stopTimer();
      this.setData({ status: 'loading', shown: 0, playing: false, names: [], hasNames: false, currentName: '' });

      loadStrokeData(char).then((info) => {
        // 组件可能已经被销毁或换了字，校验一下再落地。
        if (this.data.char !== char) return;

        const medians = info ? info.medians : null;
        if (!medians || !medians.length) {
          this.setData({ status: 'empty', total: 0, dots: [] });
          this.prepareCanvas();
          return;
        }

        const names = info.names || [];
        this.medians = medians;
        this.points = medians.map((m) => toCanvasPoints(m, this.data.size));
        this.setData({
          status: 'ready',
          total: medians.length,
          names,
          hasNames: names.length === medians.length,
          dots: medians.map((_, i) => i + 1),
        });
        this.applyShown(medians.length);
        this.prepareCanvas(() => this.render(medians.length, 1));
      });
    },

    /** 统一更新「当前第几笔」，顺带把这一笔的名称算出来。 */
    applyShown(shown) {
      const names = this.data.names || [];
      const currentName = shown >= 1 && shown <= names.length ? names[shown - 1] : '';
      this.setData({ shown, currentName });
    },

    prepareCanvas(done) {
      const size = this.data.size;
      const query = this.createSelectorQuery();
      query
        .select('#glyph-canvas')
        .fields({ node: true, size: true })
        .exec((res) => {
          if (!res || !res[0] || !res[0].node) {
            if (done) done();
            return;
          }
          const canvas = res[0].node;
          const ctx = canvas.getContext('2d');
          const dpr = wx.getSystemInfoSync().pixelRatio || 2;
          canvas.width = size * dpr;
          canvas.height = size * dpr;
          ctx.scale(dpr, dpr);
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';

          this.canvas = canvas;
          this.ctx = ctx;
          if (done) done();
        });
    },

    /** 渲染到「已显示 shown 笔，其中最后一笔画到 progress」。 */
    render(shown, progress) {
      if (!this.ctx || !this.data.size) return;
      const ctx = this.ctx;
      const size = this.data.size;
      const points = this.points || [];

      drawGrid(ctx, size, this.data.isMiZiGe);

      // 极淡的完整字形作为目标轮廓
      ctx.strokeStyle = 'rgba(0,0,0,0.06)';
      ctx.lineWidth = (30 / BOX) * size;
      for (let i = 0; i < points.length; i += 1) {
        tracePath(ctx, points[i], points[i].length - 1);
      }

      // 已写出的笔画
      ctx.strokeStyle = '#1C1917';
      ctx.lineWidth = (30 / BOX) * size;
      for (let i = 0; i < shown - 1 && i < points.length; i += 1) {
        tracePath(ctx, points[i], points[i].length - 1);
      }
      if (shown > 0 && shown <= points.length) {
        tracePartial(ctx, points[shown - 1], progress == null ? 1 : progress);
      }
    },

    stopTimer() {
      if (this.timer) {
        // play() 用的是 setTimeout，两个都清，避免依赖 id 空间的实现细节。
        clearTimeout(this.timer);
        clearInterval(this.timer);
        this.timer = null;
      }
      if (this.raf && this.canvas) {
        this.canvas.cancelAnimationFrame(this.raf);
        this.raf = null;
      }
    },

    /** 从第一笔开始逐笔演示。 */
    play() {
      if (this.data.status !== 'ready' || !this.medians) return;
      this.stopTimer();

      const total = this.medians.length;
      let index = 0;

      this.setData({ playing: true, shown: 0 });
      this.render(0, 0);

      const drawStroke = () => {
        const start = Date.now();
        const tick = () => {
          const t = Math.min(1, (Date.now() - start) / DRAW_DURATION);
          this.render(index + 1, t);
          if (t < 1) {
            this.raf = this.canvas.requestAnimationFrame(tick);
            return;
          }
          this.applyShown(index + 1);
          index += 1;
          if (index >= total) {
            this.setData({ playing: false });
            return;
          }
          this.timer = setTimeout(drawStroke, STROKE_INTERVAL - DRAW_DURATION);
        };
        tick();
      };

      drawStroke();
    },

    pause() {
      this.stopTimer();
      this.setData({ playing: false });
    },

    togglePlay() {
      if (this.data.playing) this.pause();
      else this.play();
    },

    gotoStroke(e) {
      const index = Number(e.currentTarget.dataset.index);
      this.stopTimer();
      this.setData({ playing: false });
      this.applyShown(index + 1);
      this.render(index + 1, 1);
    },

    prevStroke() {
      if (this.data.shown <= 1) return;
      this.stopTimer();
      const shown = this.data.shown - 1;
      this.setData({ playing: false });
      this.applyShown(shown);
      this.render(shown, 1);
    },

    nextStroke() {
      if (this.data.shown >= this.data.total) return;
      this.stopTimer();
      const shown = this.data.shown + 1;
      this.setData({ playing: false });
      this.applyShown(shown);
      this.render(shown, 1);
    },
  },
});
