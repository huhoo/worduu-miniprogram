/**
 * 生成 UI 线条图标（设计图《首页-字伴APP首页界面图》同款简易线图标）。
 *
 * 用法：
 *   NODE_PATH=/Users/sdai/.workbuddy/binaries/node/workspace/node_modules \
 *   node tools/gen-icons.mjs
 *
 * 小程序 image 组件不支持 SVG，所以这里以 SVG 为源、sharp 光栅化为 PNG，
 * 输出到 images/icons/{name}-{color}.png（96px，约为 32rpx 图标的 3 倍）。
 * 颜色：green #3F8E5D（主题绿）/ gray #93A397（底栏未选中）/ ink #2B3A30（头部）。
 * 风格约定：24 viewBox、stroke 2、圆角线帽 —— 改图标先改这里的 path，再重跑。
 */
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

// ESM 的 import 不认 NODE_PATH，与仓库外脚本一致走 createRequire。
const require = createRequire(import.meta.url);
const sharp = require('sharp');

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'images', 'icons');
const SIZE = 96;

const COLORS = { green: '#3F8E5D', gray: '#93A397', ink: '#2B3A30', amber: '#B8862E' };

/** 24x24 线条图标 path 集（fill:none, stroke:2, round）。 */
const ICONS = {
  home: `
    <path d="M4 11.2 L12 4.4 L20 11.2"/>
    <path d="M6.2 9.6 V19.6 H17.8 V9.6"/>
    <path d="M10.2 19.6 v-4.6 h3.6 v4.6"/>`,
  camera: `
    <rect x="3.2" y="6.8" width="17.6" height="13" rx="2.6"/>
    <circle cx="12" cy="13.2" r="3.6"/>
    <path d="M8.4 6.8 l1.3-2.4 h4.6 l1.3 2.4"/>`,
  pencil: `
    <path d="M4.4 19.6 l1-3.9 L16.6 4.5 a2.05 2.05 0 0 1 2.9 2.9 L8.3 18.6 l-3.9 1 z"/>
    <path d="M14.6 6.5 l2.9 2.9"/>`,
  doc: `
    <rect x="5" y="3.6" width="14" height="16.8" rx="2.2"/>
    <path d="M8.8 8.4 h6.4 M8.8 12 h6.4 M8.8 15.6 h4"/>`,
  book: `
    <path d="M12 6.6 C10.5 5.1 8.1 4.6 4.6 4.6 v14 c3.5 0 5.9 .5 7.4 2 1.5-1.5 3.9-2 7.4-2 v-14 C16 4.6 13.5 5.1 12 6.6 z"/>
    <path d="M12 6.6 v14"/>`,
  search: `
    <circle cx="11" cy="11" r="6.4"/>
    <path d="M15.7 15.7 L20.6 20.6"/>`,
  gear: `
    <circle cx="12" cy="12" r="3.3"/>
    <path d="M12 2.9 v2.7 M12 18.4 v2.7 M2.9 12 h2.7 M18.4 12 h2.7
             M5.6 5.6 l1.9 1.9 M16.5 16.5 l1.9 1.9 M18.4 5.6 l-1.9 1.9 M7.5 16.5 l-1.9 1.9"/>`,
  speaker: `
    <path d="M4 9.4 v5.2 h3.4 L12 18.6 V5.4 L7.4 9.4 H4 z"/>
    <path d="M15.3 9.2 a4.3 4.3 0 0 1 0 5.6 M18 6.9 a8 8 0 0 1 0 10.2"/>`,
  trophy: `
    <path d="M8 4.4 h8 v5.2 a4 4 0 0 1 -8 0 z"/>
    <path d="M8 5.8 H4.8 v1.4 a3.2 3.2 0 0 0 3.2 3.2 M16 5.8 h3.2 v1.4 a3.2 3.2 0 0 1 -3.2 3.2"/>
    <path d="M12 13.6 v3 M8.6 19.6 h6.8 M9.8 16.6 h4.4"/>`,
  eye: `
    <path d="M2.8 12 C5.4 7.5 8.5 5.4 12 5.4 s6.6 2.1 9.2 6.6 C18.6 16.5 15.5 18.6 12 18.6 s-6.6-2.1-9.2-6.6 z"/>
    <circle cx="12" cy="12" r="3"/>`,
  calendar: `
    <rect x="4" y="5.4" width="16" height="15" rx="2.2"/>
    <path d="M4 10 h16 M8.4 3.4 v3.4 M15.6 3.4 v3.4 M8 13.6 h2.6 M13.4 13.6 h2.6 M8 17 h2.6"/>`,
  shield: `
    <path d="M12 3.4 L19 6 v5.4 c0 4.6-3 7.6-7 9.2 -4-1.6-7-4.6-7-9.2 V6 z"/>
    <path d="M9.2 12 l2 2 3.6-3.8"/>`,
  sprout: `
    <path d="M12 20 v-7.4"/>
    <path d="M12 12.6 C12 9.2 9.6 7 5.8 7 c0 3.6 2.4 5.6 6.2 5.6 z"/>
    <path d="M12 11 C12 8 14.2 6 17.8 6 c0 3.2-2.2 5-5.8 5 z"/>`,
  chat: `
    <path d="M4 6.8 a2.4 2.4 0 0 1 2.4-2.4 h11.2 A2.4 2.4 0 0 1 20 6.8 v7.4 a2.4 2.4 0 0 1 -2.4 2.4 H10 L5.6 20 v-3.4 H6.4 A2.4 2.4 0 0 1 4 14.2 z"/>
    <path d="M8.6 10.5 h6.8"/>`,
  clock: `
    <circle cx="12" cy="12" r="8.4"/>
    <path d="M12 7.2 V12 l3.2 2"/>`,
  warning: `
    <path d="M12 3.8 L21 19.4 H3 z"/>
    <path d="M12 9.6 v4.2"/>
    <circle cx="12" cy="16.4" r="0.4"/>`,
};

const NEEDS = [
  ['home', ['gray', 'green']],
  ['camera', ['gray', 'green']],
  ['pencil', ['gray', 'green']],
  ['doc', ['gray', 'green']],
  ['book', ['green']],
  ['search', ['ink']],
  ['gear', ['ink']],
  ['speaker', ['green']],
  ['trophy', ['green']],
  ['eye', ['green']],
  ['calendar', ['green']],
  ['shield', ['green']],
  ['sprout', ['green']],
  ['chat', ['green']],
  ['clock', ['green']],
  ['warning', ['amber']],
];

mkdirSync(OUT_DIR, { recursive: true });

for (const [name, colors] of NEEDS) {
  for (const colorKey of colors) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${SIZE}" height="${SIZE}">
      <g fill="none" stroke="${COLORS[colorKey]}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</g>
    </svg>`;
    const out = join(OUT_DIR, `${name}-${colorKey}.png`);
    await sharp(Buffer.from(svg)).png().toFile(out);
    console.log('OK', `${name}-${colorKey}.png`);
  }
}
