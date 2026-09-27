/**
 * 笔顺数据加载。
 *
 * 几何来自 hanzi-writer-data / Make Me a Hanzi（ARPHIC 许可）：
 * 只有 medians —— 每一笔的中心线，按书写顺序排列，足够驱动真实笔顺动画。
 *
 * 笔画名称（横/竖/撇/捺…）来自第二个独立数据集 cnchar（MIT，见 utils/data/），
 * 并且只在两个数据源对笔画数达成一致时才展示：
 *   - 用模型推断测过，不可靠 —— 3 个抽样字里 2 个顺序错，「雨」在 temperature 0 下
 *     两次调用的笔画数还不一样；
 *   - 基于中心线的几何分类器也做过，15 个已知答案的字只对了 1 个（曲率会被当成方向变化）。
 * 教写字的 app 里，错的笔画名比没有更糟，所以冲突时如实不显示，不猜。
 *
 * 笔数一致还不够 —— UI 是逐笔标注的，等于在断言顺序，所以顺序也核对过：
 * 首笔为基本笔画的字里，cnchar 的名字能预测 hanzi-writer 实际绘制方向的占 99.6%~100%。
 */

const api = require('./api.js');
const cnchar = require('./data/cnchar-strokes.js');

/** 源坐标系尺寸：medians 的数值都在这个方框里。 */
const STROKE_BOX = 512;

const cache = new Map(); // char -> { medians, names } | null
const pending = new Map(); // char -> Promise

function isHanzi(char) {
  return typeof char === 'string' && /^[㐀-鿿]$/.test(char);
}

/**
 * 本地查笔画名。cnchar 与 hanzi-writer 的笔画数不一致时返回 null ——
 * 实测 9,574 个字里 166 个有这种冲突，另有 798 个 cnchar 两表都没收录，
 * 这两类都保留动画、不标名称。
 */
function lookupStrokeNames(char, strokeCount) {
  const code = cnchar.CHAR_CODES[char];
  if (!code) return null;
  if (strokeCount > 0 && code.length !== strokeCount) return null;

  const out = [];
  for (let i = 0; i < code.length; i += 1) {
    const name = cnchar.LETTER_NAMES[code[i]];
    if (!name) return null;
    out.push(name);
  }
  return out.length ? out : null;
}

/**
 * 取某个字的笔顺与笔画名。没有数据返回 null —— 调用方必须诚实展示「暂无数据」，
 * 不能拿模型猜的笔顺糊弄过去。
 *
 * 返回形如 { medians, names }，names 可能为 null。
 */
function loadStrokeData(char) {
  if (!isHanzi(char)) return Promise.resolve(null);
  if (cache.has(char)) return Promise.resolve(cache.get(char));
  if (pending.has(char)) return pending.get(char);

  const task = api
    .strokeData(char)
    .then((res) => {
      const medians = res && res.medians && res.medians.length ? res.medians : null;
      if (!medians) {
        cache.set(char, null);
        pending.delete(char);
        return null;
      }

      // 优先用云上分片自带的名称（构建时已交叉校验过）；没有就本地查表，
      // 本地查表同样要求与 medians 的笔画数一致，两条路的严格程度相同。
      const remote = res && Array.isArray(res.names) && res.names.length === medians.length ? res.names : null;
      const info = { medians, names: remote || lookupStrokeNames(char, medians.length) };

      cache.set(char, info);
      pending.delete(char);
      return info;
    })
    .catch(() => {
      // 云函数没配笔画数据、网络失败都归到这里：按「无数据」处理。
      cache.set(char, null);
      pending.delete(char);
      return null;
    });

  pending.set(char, task);
  return task;
}

/**
 * 把中心线转成 SVG path。源数据 y 轴朝上，渲染坐标 y 轴朝下，所以要翻转。
 */
function toPath(median) {
  return median
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point[0]} ${STROKE_BOX - point[1]}`)
    .join(' ');
}

/** 单笔长度，用于 stroke-dasharray 动画。 */
function pathLength(median) {
  let sum = 0;
  for (let i = 1; i < median.length; i += 1) {
    sum += Math.hypot(median[i][0] - median[i][1], median[i - 1][0] - median[i - 1][1]);
  }
  return sum || 1;
}

module.exports = { STROKE_BOX, loadStrokeData, lookupStrokeNames, toPath, pathLength };
