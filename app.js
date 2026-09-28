const { cloudEnv } = require('./utils/config.js');
const store = require('./utils/store.js');

/**
 * 单次计入的上限（秒）。
 *
 * 切后台再回来会触发一次结算，如果不限幅，孩子把小程序挂在后台一晚上，
 * 「今日伴读」就会凭空多出几个小时。30 分钟足以覆盖正常阅读节奏，
 * 超出的部分宁可不计 —— 一个偏小的真实数字比一个好看的假数字有用。
 */
const MAX_CHUNK_SECONDS = 30 * 60;

App({
  globalData: {
    /** 云开发是否可用。未配置环境 ID 时为 false，AI 能力自动降级。 */
    cloudReady: false,
    /** 今日累计伴读秒数，页面直接读这个，避免每个页面都去翻 storage。 */
    studySeconds: 0,
  },

  onLaunch() {
    this.globalData.studySeconds = store.readTodaySeconds();
    this.mark = Date.now();

    if (!wx.cloud) {
      console.warn('[字伴] 当前基础库不支持云开发，AI 功能不可用');
      return;
    }
    if (!cloudEnv) {
      console.warn('[字伴] 未配置云开发环境 ID（utils/config.js cloudEnv），AI 功能不可用');
      return;
    }
    try {
      wx.cloud.init({ env: cloudEnv, traceUser: true });
      this.globalData.cloudReady = true;
      this.warmUpCloud();
    } catch (error) {
      console.error('[字伴] 云开发初始化失败', error);
    }
  },

  /**
   * 预热云函数容器。
   *
   * 冷启动一次要一两秒，孩子点「拍照识字」时才开始等就太慢了。
   * 这里在首屏渲染之后发一个最轻的 health 请求把容器拉起来，
   * 结果不关心、失败也不提示 —— 只是让后面的真实调用少等一次冷启动。
   */
  warmUpCloud() {
    setTimeout(() => {
      wx.cloud
        .callFunction({ name: 'ziban', data: { action: 'health' } })
        .then(() => {})
        .catch(() => {
          /* 预热失败不影响任何功能，真正调用时会再试 */
        });
    }, 800);
  },

  onShow() {
    // 回到前台继续计时。切后台期间不计时（挂机不该刷出伴读时长），
    // 所以这里只是重新打点，落库的是上一次 onHide 之前那一段。
    this.settleStudy(true);
  },

  onHide() {
    this.settleStudy(false);
    // 字库是合并写的（见 store.saveState），切后台必须补一次落盘，否则这 300ms 内的改动会丢。
    store.flushState();
  },

  /**
   * 把「上一次打点到现在」这段前台时间结算进今日累计。
   * keepTiming 为真时结算完立刻重新打点，页面随时能读到接近实时的分钟数。
   */
  settleStudy(keepTiming) {
    if (!this.mark) {
      if (keepTiming) this.mark = Date.now();
      return;
    }

    const elapsed = Math.floor((Date.now() - this.mark) / 1000);
    this.mark = keepTiming ? Date.now() : null;
    if (elapsed <= 0) return;

    const credited = Math.min(elapsed, MAX_CHUNK_SECONDS);
    const seconds = store.readTodaySeconds() + credited;
    store.writeTodaySeconds(seconds);
    this.globalData.studySeconds = seconds;
  },
});
