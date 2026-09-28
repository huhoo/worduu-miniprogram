/**
 * 书架 / 阅读记录。
 *
 * 每本书的三个数字（全书字数、已收录、已掌握）全部由孩子自己的字库实时推导，
 * 不写在文章数据里 —— 否则换一个孩子打开，同一个字库会看到别人的进度。
 */

const store = require('../../../utils/store.js');
const ARTICLES = require('../../../utils/data/articles.js');

const CJK = /[㐀-鿿]/;

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: '教材', label: '教材' },
  { key: '课外书', label: '课外书' },
];

/** 统计一篇文章在孩子字库里的覆盖情况。 */
function articleStats(article, characters) {
  const text = article.paragraphs.join('');
  const hanzi = text.split('').filter((ch) => CJK.test(ch));
  const unique = new Set(hanzi);

  let encountered = 0;
  let mastered = 0;
  unique.forEach((symbol) => {
    const entry = characters.find((c) => c.char === symbol);
    if (!entry) return;
    encountered += 1;
    if (entry.mastery === '熟练' || entry.mastery === '基本掌握') mastered += 1;
  });

  return { total: unique.size, encountered, mastered };
}

Page({
  data: {
    filters: FILTERS,
    filter: 'all',
    articles: [],
    totalBooks: 0,
  },

  onShow() {
    this.render();
  },

  render() {
    const state = store.loadState();
    const characters = state.characters;

    const articles = ARTICLES.filter((a) => this.data.filter === 'all' || a.source === this.data.filter).map((a) => {
      const stats = articleStats(a, characters);
      return Object.assign({}, a, {
        totalChars: stats.total,
        encountered: stats.encountered,
        mastered: stats.mastered,
      });
    });

    this.setData({ articles, totalBooks: ARTICLES.length });
  },

  switchFilter(e) {
    const key = e.currentTarget.dataset.key;
    if (key === this.data.filter) return;
    this.setData({ filter: key });
    this.render();
  },

  openArticle(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/learn/pages/reader/reader?id=${id}` });
  },
});
