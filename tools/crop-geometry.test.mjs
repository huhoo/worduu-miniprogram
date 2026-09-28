/**
 * 选框几何的断言测试：node tools/crop-geometry.test.mjs
 *
 * 这些不变量都是踩出来的：每条对应一个真实出现过的坏样子，
 * 不是为了让覆盖率好看。
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const CROP = require('../utils/cropGeometry.js');

let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  console.log('  ✓', name);
};

console.log('cropGeometry');

check('整张图作为选区时会被钉死在原点——所以默认选区不能是整图', () => {
  const moved = CROP.applyDrag(CROP.FULL, 'move', 0.2, 0.2);
  assert.deepEqual(moved, { x: 0, y: 0, w: 1, h: 1 });
  // 默认选区必须真的能移动，否则控件看起来是死的。
  const d = CROP.applyDrag(CROP.DEFAULT_RECT, 'move', 0.05, 0.05);
  assert.ok(d.x > CROP.DEFAULT_RECT.x && d.y > CROP.DEFAULT_RECT.y);
});

check('选区不会被拖出画面，也不会缩到看不见', () => {
  assert.deepEqual(CROP.clampRect({ x: 0.9, y: 0.9, w: 1, h: 1 }), { x: 0, y: 0, w: 1, h: 1 });
  assert.equal(CROP.clampRect({ x: 0, y: 0, w: 0.001, h: 0.5 }).w, CROP.MIN_SIZE);
  assert.deepEqual(CROP.clampRect({ x: -0.5, y: -0.5, w: 0.4, h: 0.4 }), { x: 0, y: 0, w: 0.4, h: 0.4 });
});

check('反向框选也能选出正确范围', () => {
  const forward = CROP.rectFromPoints(0.2, 0.3, 0.6, 0.8);
  const backward = CROP.rectFromPoints(0.6, 0.8, 0.2, 0.3);
  assert.deepEqual(forward, backward);
  // 浮点减法会留下 1e-17 的尾巴，比数值本身没有意义。
  assert.ok(Math.abs(forward.x - 0.2) < 1e-9);
  assert.ok(Math.abs(forward.y - 0.3) < 1e-9);
  assert.ok(Math.abs(forward.w - 0.4) < 1e-9);
  assert.ok(Math.abs(forward.h - 0.5) < 1e-9);
});

check('拖右下角只改变大小，拖左上角会同时移动原点', () => {
  const base = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 };
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

  const se = CROP.applyDrag(base, 'se', 0.1, 0.1);
  near(se.x, 0.2);
  near(se.y, 0.2);
  near(se.w, 0.5);
  near(se.h, 0.5);

  const nw = CROP.applyDrag(base, 'nw', 0.1, 0.1);
  near(nw.x, 0.3);
  near(nw.y, 0.3);
  near(nw.w, 0.3);
  near(nw.h, 0.3);
});

check('映射到源图像素时不会越出图片边界', () => {
  const px = CROP.toSourcePixels({ x: 0.5, y: 0.5, w: 1, h: 1 }, 1000, 2000);
  assert.equal(px.sx, 500);
  assert.equal(px.sy, 1000);
  assert.equal(px.sw, 500);
  assert.equal(px.sh, 1000);
  assert.ok(px.sx + px.sw <= 1000 && px.sy + px.sh <= 2000);
});

check('contain 后的图片位置按比例留白居中', () => {
  // 图片 1000x2000 放进 300x400 的框：等比缩放后是 200x400，左右各留 50。
  assert.deepEqual(CROP.containedBox(1000, 2000, 300, 400), { left: 50, top: 0, width: 200, height: 400 });
  assert.deepEqual(CROP.containedBox(0, 0, 300, 400), { left: 0, top: 0, width: 0, height: 0 });
});

check('归一化选区能换算成舞台上的像素位置', () => {
  const box = { left: 50, top: 0, width: 200, height: 400 };
  assert.deepEqual(CROP.toStagePixels({ x: 0, y: 0, w: 0.5, h: 0.5 }, box), {
    left: 50,
    top: 0,
    width: 100,
    height: 200,
  });
});

console.log(`\n${passed} 项通过`);
