/**
 * 今日学习成就卡。
 *
 * 分享链路与 Web 版不同：Web 把整张卡片编码进链接（过长会被聊天软件截断），
 * 这里先存云开发数据库，分享 path 只带一个十来位的 id，接收方按 id 取。
 *
 * 海报用 canvas 现画：小程序没有 DOM，不能像 Web 那样把卡片截图导出。
 */

const store = require('../../utils/store.js');
const api = require('../../utils/api.js');
const card = require('../../utils/achievement.js');
const privacy = require('../../utils/privacy.js');

const POSTER_W = 600;
const POSTER_H = 840;

Page({
  data: {
    card: null,
    cardId: '',
    saving: false,
    drawing: false,
    posterPath: '',
    notice: '',
  },

  onLoad(options) {
    const state = store.loadState();
    const opts = options || {};

    // chars 由上一页以「春,蝶」的形式传过来，拼音回到字库里补，不靠链接带。
    let chars = null;
    if (opts.chars) {
      chars = String(opts.chars)
        .split(',')
        .filter((ch) => ch)
        .map((ch) => {
          const found = store.findByChar(state, ch);
          return found || { char: ch, pinyin: '' };
        });
    }

    const built = card.buildCard(state, {
      type: opts.type || '',
      title: opts.title ? decodeURIComponent(opts.title) : '',
      scoreText: opts.score ? decodeURIComponent(opts.score) : '',
      praise: opts.praise ? decodeURIComponent(opts.praise) : '',
      chars,
    });

    this.setData({ card: built });
  },

  /* ---------------- 保存与分享 ---------------- */

  /** 先把卡片存库拿到 id。已在库里就直接复用，不重复建卡。 */
  ensureSaved() {
    if (this.data.cardId) return Promise.resolve(this.data.cardId);

    this.setData({ saving: true, notice: '' });
    const that = this;
    return api
      .saveAchievementCard(this.data.card)
      .then((res) => {
        const id = res && res.id;
        that.setData({ cardId: id, saving: false });
        return id;
      })
      .catch((error) => {
        that.setData({
          saving: false,
          notice: (error && error.message) || '奖状没能保存，请稍后再试',
        });
        return null;
      });
  },

  onShareAppMessage() {
    const that = this;
    const fallbackTitle = `字伴 · ${(this.data.card && this.data.card.childName) || '宝贝'}的今日识字成就卡`;

    // 分享前必须先把卡片存库，否则接收方拿不到内容。
    return this.ensureSaved().then((id) => {
      if (!id) {
        return {
          title: fallbackTitle,
          path: '/pages/index/index',
        };
      }
      return {
        title: fallbackTitle,
        path: `/pages/share/share?id=${id}`,
        imageUrl: that.data.posterPath || undefined,
      };
    });
  },

  /* ---------------- 海报 ---------------- */

  makePoster() {
    if (this.data.drawing) return;
    this.setData({ drawing: true, notice: '' });

    const that = this;
    this.drawPoster()
      .then((path) => {
        that.setData({ posterPath: path, drawing: false });
        that.saveToAlbum(path);
      })
      .catch(() => {
        that.setData({ drawing: false, notice: '海报生成失败，请稍后再试' });
      });
  },

  saveToAlbum(filePath) {
    const that = this;
    // 写入相册是隐私接口，正式版未同意《用户隐私保护指引》会直接失败。
    privacy.ensurePrivacy().then((ok) => {
      if (!ok) {
        // 海报已经画好了，不授权也不算白跑 —— 引导走分享。
        that.setData({ notice: '需要同意隐私保护指引才能存相册，也可以直接点右上角分享。' });
        return;
      }
      that.writeToAlbum(filePath);
    });
  },

  writeToAlbum(filePath) {
    wx.saveImageToPhotosAlbum({
      filePath,
      success: () => {
        wx.showToast({ title: '已保存到相册', icon: 'success' });
      },
      fail: (err) => {
        const msg = (err && err.errMsg) || '';
        // 用户拒绝授权时不必报错，海报已经生成，可以直接在微信里发送。
        if (msg.indexOf('auth deny') !== -1 || msg.indexOf('auth denied') !== -1) {
          this.setData({ notice: '没有相册权限，海报已生成，可直接点右上角分享。' });
          return;
        }
        this.setData({ notice: '保存相册失败，可直接点右上角分享。' });
      },
    });
  },

  drawPoster() {
    return new Promise((resolve, reject) => {
      const query = wx.createSelectorQuery();
      query
        .select('#poster-canvas')
        .fields({ node: true, size: true })
        .exec((res) => {
          const info = res && res[0];
          if (!info || !info.node) {
            reject(new Error('canvas 未就绪'));
            return;
          }

          const canvas = info.node;
          const ctx = canvas.getContext('2d');
          const dpr = (wx.getSystemInfoSync && wx.getSystemInfoSync().pixelRatio) || 2;
          canvas.width = POSTER_W * dpr;
          canvas.height = POSTER_H * dpr;
          ctx.scale(dpr, dpr);

          paint(ctx, this.data.card);

          wx.canvasToTempFilePath({
            canvas,
            x: 0,
            y: 0,
            width: POSTER_W,
            height: POSTER_H,
            destWidth: POSTER_W * dpr,
            destHeight: POSTER_H * dpr,
            success: (out) => resolve(out.tempFilePath),
            fail: reject,
          });
        });
    });
  },

  goBank() {
    wx.navigateTo({ url: '/pages/bank/bank' });
  },
});

/* ---------------- 绘制 ---------------- */

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function paint(ctx, data) {
  const c = data || {};

  // 宣纸底
  const bg = ctx.createLinearGradient(0, 0, 0, POSTER_H);
  bg.addColorStop(0, '#FFFDF9');
  bg.addColorStop(0.5, '#FAF6F0');
  bg.addColorStop(1, '#F5EFE6');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, POSTER_W, POSTER_H);

  // 装饰圆
  ctx.fillStyle = 'rgba(251, 191, 36, 0.16)';
  ctx.beginPath();
  ctx.arc(POSTER_W - 40, 10, 110, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(5, 150, 105, 0.10)';
  ctx.beginPath();
  ctx.arc(30, POSTER_H - 20, 110, 0, Math.PI * 2);
  ctx.fill();

  // 边框
  ctx.strokeStyle = '#E9DFD0';
  ctx.lineWidth = 4;
  roundRect(ctx, 16, 16, POSTER_W - 32, POSTER_H - 32, 32);
  ctx.stroke();

  // 头部
  ctx.fillStyle = '#1C1917';
  ctx.font = 'bold 26px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('字伴 · 识字荣誉', 52, 78);
  ctx.fillStyle = '#A8A29E';
  ctx.font = '20px sans-serif';
  ctx.fillText(c.date || '', 52, 108);

  // 昵称标签
  const name = c.childName || '宝贝';
  ctx.font = 'bold 20px sans-serif';
  const nameW = ctx.measureText(`${name} 宝贝`).width + 32;
  ctx.fillStyle = '#FFFFFF';
  roundRect(ctx, POSTER_W - 52 - nameW, 58, nameW, 40, 20);
  ctx.fill();
  ctx.strokeStyle = '#E7E5E4';
  ctx.lineWidth = 1;
  roundRect(ctx, POSTER_W - 52 - nameW, 58, nameW, 40, 20);
  ctx.stroke();
  ctx.fillStyle = '#065F46';
  ctx.font = 'bold 20px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`${name} 宝贝`, POSTER_W - 52 - nameW / 2, 84);

  // 标题
  ctx.textAlign = 'center';
  const title = `🏆 ${c.title || ''}`;
  ctx.font = 'bold 24px sans-serif';
  const titleW = ctx.measureText(title).width + 40;
  ctx.fillStyle = 'rgba(245, 158, 11, 0.18)';
  roundRect(ctx, POSTER_W / 2 - titleW / 2, 150, titleW, 46, 23);
  ctx.fill();
  ctx.fillStyle = '#92400E';
  ctx.fillText(title, POSTER_W / 2, 181);

  // 成绩
  ctx.fillStyle = '#1C1917';
  ctx.font = 'bold 56px sans-serif';
  ctx.fillText(c.scoreText || '', POSTER_W / 2, 258);

  // 评语
  ctx.fillStyle = '#57534E';
  ctx.font = 'italic 21px sans-serif';
  ctx.fillText(`“${c.praiseComment || ''}”`, POSTER_W / 2, 300);

  // 三个数字格
  const metrics = [
    { label: '累计识字', value: String(c.totalRecognized || 0), unit: '字' },
    { label: '专注学习', value: String(c.durationMinutes || 0), unit: '分钟' },
    { label: '攻克生字', value: String((c.highlightChars || []).length), unit: '个' },
  ];
  const boxW = (POSTER_W - 104 - 24) / 3;
  metrics.forEach((m, i) => {
    const x = 52 + i * (boxW + 12);
    ctx.fillStyle = '#FFFFFF';
    roundRect(ctx, x, 330, boxW, 110, 20);
    ctx.fill();
    ctx.strokeStyle = '#E7E5E4';
    ctx.lineWidth = 1;
    roundRect(ctx, x, 330, boxW, 110, 20);
    ctx.stroke();

    ctx.fillStyle = '#78716C';
    ctx.font = '18px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(m.label, x + boxW / 2, 364);

    ctx.fillStyle = '#1C1917';
    ctx.font = 'bold 34px sans-serif';
    ctx.fillText(m.value, x + boxW / 2, 404);
    ctx.font = '16px sans-serif';
    ctx.fillStyle = '#A8A29E';
    ctx.fillText(m.unit, x + boxW / 2, 428);
  });

  // 生字
  const chars = c.highlightChars || [];
  if (chars.length) {
    ctx.fillStyle = '#A8A29E';
    ctx.font = 'bold 18px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('✨ 今日掌握的新汉字', POSTER_W / 2, 480);

    const chipW = 108;
    const gap = 16;
    const totalW = chars.length * chipW + (chars.length - 1) * gap;
    let x = POSTER_W / 2 - totalW / 2;
    chars.forEach((item) => {
      ctx.fillStyle = '#FFFFFF';
      roundRect(ctx, x, 500, chipW, 84, 18);
      ctx.fill();
      ctx.strokeStyle = '#E9DFD0';
      ctx.lineWidth = 2;
      roundRect(ctx, x, 500, chipW, 84, 18);
      ctx.stroke();

      ctx.fillStyle = '#1C1917';
      ctx.font = 'bold 40px sans-serif';
      ctx.fillText(item.char, x + chipW / 2, 542);
      if (item.pinyin) {
        ctx.fillStyle = '#78716C';
        ctx.font = '17px sans-serif';
        ctx.fillText(item.pinyin, x + chipW / 2, 570);
      }
      x += chipW + gap;
    });
  }

  // 落款
  ctx.fillStyle = '#A8A29E';
  ctx.font = '19px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('「字伴」让每个汉字都成为孩子的好朋友', POSTER_W / 2, POSTER_H - 96);
  ctx.fillText('数据来自孩子真实的认读、书写与默写记录', POSTER_W / 2, POSTER_H - 66);
}
