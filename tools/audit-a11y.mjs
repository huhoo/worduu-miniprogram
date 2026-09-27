/**
 * 静态审计小程序的字号与触摸目标下限。
 *
 * 对齐 Web 版 4350896 修的两件事（WCAG 2.5.5 触摸目标 44px、正文最小字号 11px）：
 *   - font-size < 22rpx  -> 11px（1px = 2rpx @375px 宽）
 *   - 可点元素高度 < 88rpx -> 44px
 *
 * 只报**能从 CSS 直接读出来**的问题，不猜布局：元素高度靠内容或 flex 撑开时
 * 这里读不到，就列为"需人工看"，不假装测过。
 *
 * 运行：node tools/audit-a11y.mjs
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const MIN_FONT_RPX = 22; // 11px
const MIN_TAP_RPX = 88; // 44px

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(ROOT).filter((p) => !p.includes("/.git/") && !p.includes("/tools/"));

/** 解析 wxss -> { selector: { prop: value } }，只处理单选择器，够用。 */
function parseCss(text) {
  const rules = new Map();
  const re = /([^{}]+)\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(text))) {
    const sel = m[1].trim().replace(/\s+/g, " ");
    if (!sel || sel.startsWith("@") || sel.includes(",")) {
      if (sel.includes(",")) {
        for (const s of sel.split(",")) {
          const key = s.trim();
          if (key) rules.set(key, { ...(rules.get(key) || {}), ...props(m[2]) });
        }
      }
      continue;
    }
    rules.set(sel, { ...(rules.get(sel) || {}), ...props(m[2]) });
  }
  return rules;
}

/**
 * `padding: 16rpx 0 12rpx` 是上右下左，不能拿第一个数当上下都用 ——
 * 那会把 104rpx 高的 tab 项算成 32rpx。
 */
function splitSides(v) {
  const parts = (v || "").trim().split(/\s+/).map(num).filter((n) => n != null);
  if (!parts.length) return null;
  const [t, r = t, b = t] = parts;
  return { top: t, right: r, bottom: b };
}

function props(body) {
  const out = {};
  for (const decl of body.split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const key = decl.slice(0, i).trim();
    const val = decl.slice(i + 1).trim();
    if (key === "padding") {
      const s = splitSides(val);
      if (s) {
        out["padding-top"] = `${s.top}rpx`;
        out["padding-bottom"] = `${s.bottom}rpx`;
      }
      continue;
    }
    out[key] = val;
  }
  return out;
}

const num = (v) => {
  const m = /(-?[\d.]+)rpx/.exec(v || "");
  return m ? parseFloat(m[1]) : null;
};

/** 一个规则框出来的高度：显式 height/min-height 优先，否则 padding + line-height/字号。 */
function boxHeight(r) {
  const h = num(r["height"]) ?? num(r["min-height"]);
  if (h != null) return h;
  const pt = num(r["padding-top"]) ?? num(r.padding) ?? 0;
  const pb = num(r["padding-bottom"]) ?? num(r.padding) ?? 0;
  const inner = num(r["line-height"]) ?? (num(r["font-size"]) ?? 0) * 1.2;
  return pt + pb + inner || null;
}

const smallFont = [];
const smallTap = [];
const tapClasses = new Set();

// 1. 收集 wxml 里所有可点的 class（bindtap / catchtap 所在标签的 class）
for (const f of files.filter((p) => p.endsWith(".wxml"))) {
  const text = readFileSync(f, "utf8");
  const tagRe = /<([a-z-]+)([^>]*bind(?:tap|touchstart)[^>]*)>/g;
  let m;
  while ((m = tagRe.exec(text))) {
    const cls = /class="([^"]*)"/.exec(m[2]);
    if (!cls) continue;
    for (const c of cls[1].split(/\s+/)) {
      if (c && !c.includes("{{") && !c.includes("}}")) tapClasses.add(c);
    }
  }
}

// 2. 逐份 wxss 检查
for (const f of files.filter((p) => p.endsWith(".wxss"))) {
  const rel = f.slice(ROOT.length + 1);
  const rules = parseCss(readFileSync(f, "utf8"));
  for (const [sel, r] of rules) {
    const fs = num(r["font-size"]);
    if (fs != null && fs > 0 && fs < MIN_FONT_RPX) {
      smallFont.push({ rel, sel, value: `${fs}rpx (${(fs / 2).toFixed(1)}px)` });
    }
    const cls = sel.replace(/^\./, "").split(/[ >:.\[]/)[0];
    if (!tapClasses.has(cls)) continue;
    const h = boxHeight(r);
    if (h != null && h > 0 && h < MIN_TAP_RPX) {
      smallTap.push({ rel, sel, value: `约 ${h.toFixed(0)}rpx (${(h / 2).toFixed(1)}px)` });
    }
  }
}

const fmt = (rows, title) => {
  console.log(`\n${title}：${rows.length} 处`);
  for (const r of rows) console.log(`  ${r.rel}  ${r.sel}  ${r.value}`);
};

fmt(smallFont, `字号 < ${MIN_FONT_RPX}rpx (11px)`);
fmt(smallTap, `可点元素高度 < ${MIN_TAP_RPX}rpx (44px)`);

if (smallTap.length === 0 && smallFont.length === 0) {
  console.log("\n✓ 未发现低于下限的字号或触摸目标");
}
console.log(
  `\n注：只覆盖 CSS 里写得出来的尺寸；靠内容或 flex 撑开的元素读不到，需人工过一遍。`
);
