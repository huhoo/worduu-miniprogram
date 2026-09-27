/**
 * 刷新 tools/strokes/*.json 里的笔画名（n 字段），medians（m 字段）原样不动。
 *
 * 分片的几何来自 hanzi-writer / Make Me a Hanzi，名称来自 cnchar，两者独立，
 * 所以只在笔数一致时才写 n —— 与 utils/strokes.js 运行时的判据完全相同。
 * 笔数冲突或 cnchar 未收录的字保留动画、不带 n，前端会如实不标名称。
 *
 * 只在 cnchar 数据表变动后需要跑（例如上游补进繁体表、或修正某个笔画名）。
 * 跑完之后要把整个 tools/strokes/ 重新上传到云存储，云端才会生效。
 *
 * 运行：node tools/update-stroke-shards.mjs
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = join(import.meta.dirname, "..");
const DIR = join(ROOT, "tools", "strokes");
const cnchar = require(join(ROOT, "utils", "data", "cnchar-strokes.js"));

let files = 0;
let total = 0;
let named = 0;
let conflict = 0;
let absent = 0;
let changed = 0;
let added = 0;
let dropped = 0;

for (const file of readdirSync(DIR)) {
  if (!file.endsWith(".json")) continue;
  const path = join(DIR, file);
  const shard = JSON.parse(readFileSync(path, "utf8"));
  files += 1;

  for (const [char, entry] of Object.entries(shard)) {
    total += 1;
    const medians = Array.isArray(entry) ? entry : entry && entry.m;
    if (!medians || !medians.length) continue;

    const code = cnchar.CHAR_CODES[char];
    const before = Array.isArray(entry) ? null : entry && entry.n;

    let names = null;
    if (!code) {
      absent += 1;
    } else if (code.length !== medians.length) {
      conflict += 1;
    } else {
      names = [];
      for (const letter of code) {
        const name = cnchar.LETTER_NAMES[letter];
        if (!name) {
          names = null;
          break;
        }
        names.push(name);
      }
      if (names) named += 1;
    }

    const beforeText = before ? before.join("/") : "";
    const afterText = names ? names.join("/") : "";
    if (beforeText !== afterText) {
      changed += 1;
      if (!beforeText && afterText) added += 1;
      if (beforeText && !afterText) dropped += 1;
    }

    shard[char] = { m: medians, ...(names ? { n: names } : {}) };
  }

  writeFileSync(path, `${JSON.stringify(shard)}\n`);
}

console.log(`✓ ${files} 个分片，${total} 字`);
console.log(`  带笔画名 ${named} | 笔数冲突 ${conflict} | cnchar 未收录 ${absent}`);
console.log(`  名称变动 ${changed} 字（新增 ${added} / 移除 ${dropped}）`);
