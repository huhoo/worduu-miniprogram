/**
 * 生成 learn/utils/data/cnchar-strokes.js（随包发布的笔画名称表）。
 *
 * 输入是 tools/vendor-cnchar/ 下 cnchar 的三份原始数据（MIT，未修改）：
 *   stroke-table.json      字母 -> 笔画名 / 形状 / 类型
 *   stroke-order-jian.json 汉字 -> 字母串（简体，6,939 字）
 *   stroke-order-trad.json 汉字 -> 字母串（繁体，2,611 字）
 *
 * 只做三件事，不做任何推断或补全：
 *   1. 字母 -> 标准名。cnchar 有 5 个字母给了两个并存的规范名（如 斜钩|卧钩），
 *      两个都保留用 "/" 连接 —— 取第一个等于替数据源做了它自己没做的选择，
 *      「心」的第二笔是卧钩，取首项会读成斜钩。
 *   2. 字母 d 在 cnchar 里叫「点2」，那是表内部的消歧标记而不是笔画名，
 *      其几何是向下的点（dx -8.6, dy +76.6），属于点族，落地成「点」。
 *   3. 汉字 -> 字母串，简体表优先、繁体表兜底（两表近乎不相交，仅 46 字共有且一致）。
 *
 * 名字是否真的能用，不在这里决定：utils/strokes.js 只在 cnchar 的笔画数与
 * hanzi-writer 的中心线笔数一致时才展示，冲突就返回 null。
 *
 * 运行：node tools/build-cnchar-strokes.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const VENDOR = join(ROOT, "tools", "vendor-cnchar");
const OUT = join(ROOT, "learn", "utils", "data", "cnchar-strokes.js");

/** cnchar 表里不是笔画名、需要落地成真实笔画名的条目。 */
const NAME_FIXES = { "点2": "点" };

const strokeTable = JSON.parse(readFileSync(join(VENDOR, "stroke-table.json"), "utf8"));
const simplified = JSON.parse(readFileSync(join(VENDOR, "stroke-order-jian.json"), "utf8"));
const traditional = JSON.parse(readFileSync(join(VENDOR, "stroke-order-trad.json"), "utf8"));

const LETTER_NAMES = {};
for (const [letter, entry] of Object.entries(strokeTable)) {
  const raw = entry && entry.name;
  if (!raw) continue;
  const fixed = NAME_FIXES[raw] || raw;
  LETTER_NAMES[letter] = fixed.split("|").join("/").trim();
}

// 未知字母留空，运行时按「没有名字」处理，不猜。
for (const code of Object.values({ ...simplified, ...traditional })) {
  for (const letter of code) {
    if (!(letter in LETTER_NAMES)) LETTER_NAMES[letter] = LETTER_NAMES[letter] || "";
  }
}

let fromSimplified = 0;
let fromTraditional = 0;
let overlap = 0;
const CHAR_CODES = {};
for (const [char, code] of Object.entries(simplified)) {
  if (traditional[char]) overlap += 1;
  if (!code) continue;
  CHAR_CODES[char] = code;
  fromSimplified += 1;
}
for (const [char, code] of Object.entries(traditional)) {
  if (CHAR_CODES[char] || !code) continue;
  CHAR_CODES[char] = code;
  fromTraditional += 1;
}

const body = [
  "/**",
  " * 笔画名称数据（横 / 竖 / 撇 / 捺 …）。",
  " *",
  " * 来源：cnchar 的笔画表（MIT 许可），原始文件见 tools/vendor-cnchar/",
  " * （含 LICENSE 与 NOTICE.txt，MIT 要求保留，请勿删除）。",
  " * 本文件由 tools/build-cnchar-strokes.mjs 生成，请勿手工编辑。",
  " *",
  " * 为什么不用模型或几何推断：实测过两条路都不可靠 ——",
  " * 模型在 3 个抽样字里错了 2 个的顺序，且「雨」在 temperature 0 下两次调用笔画数不同；",
  " * 基于中心线的几何分类器对 15 个已知答案的字只对了 1 个（曲率会被误判成方向变化）。",
  " *",
  " * 因此名称只在「与 hanzi-writer 的笔顺笔数一致」时才展示，冲突就如实不显示，不猜。",
  " * 仅笔数相同还不够 —— UI 是逐笔标注的，等于在断言顺序，所以顺序也核对过：",
  " * 首笔为基本笔画的字里，cnchar 的名字能预测 hanzi-writer 实际绘制方向的占 99.6%~100%。",
  " *",
  " * 两个许可名：cnchar 有 5 个字母给了并存的规范名（如 斜钩|卧钩），这里用 \"/\" 两个都留着，",
  " * 不替数据源做它自己没做的选择；字母 d 在 cnchar 里叫「点2」（表内消歧标记，非笔画名），",
  " * 按其几何归属落地为「点」。",
  " */",
  "",
  "// 字母 -> 标准笔画名（cnchar stroke-table，| 分隔的别名全部保留）",
  `const LETTER_NAMES = ${JSON.stringify(LETTER_NAMES, null, 2)};`,
  "",
  "// 汉字 -> 笔画字母串，每一笔一个字母（cnchar 简体表 + 繁体表，简体优先）",
  `const CHAR_CODES = ${JSON.stringify(CHAR_CODES, null, 2)};`,
  "",
  "module.exports = { LETTER_NAMES, CHAR_CODES };",
  "",
].join("\n");

writeFileSync(OUT, body);

const kb = (Buffer.byteLength(body) / 1024).toFixed(0);
console.log(`✓ ${Object.keys(CHAR_CODES).length} 字（简体 ${fromSimplified} / 繁体 ${fromTraditional}，两表共有 ${overlap}）`);
console.log(`  ${Object.keys(LETTER_NAMES).length} 个笔画字母 -> ${kb} KB -> ${OUT}`);
