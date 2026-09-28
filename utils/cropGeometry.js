/**
 * 选框几何，刻意不依赖任何页面 / 组件，方便单独跑测试。
 *
 * 所有坐标都相对「照片自身的框」归一化到 0..1，而不是相对显示它的容器：
 * 图片是用 contain 方式放进去的，容器里的百分比并不等于照片上的百分比。
 *
 * 移植自 Web 版 src/utils/cropGeometry.ts，逻辑保持一致。
 */

/** 整张图。默认不再用它作初始选区：w=1 时 clamp 会把 x 钉死在 0，拖不动，看起来像坏了。 */
const FULL = { x: 0, y: 0, w: 1, h: 1 };

/** 初始选区取页面中部一条宽带，看得见、拖得动。 */
const DEFAULT_RECT = { x: 0.05, y: 0.22, w: 0.9, h: 0.34 };

const MIN_SIZE = 0.06;

function clampRect(r) {
  const w = Math.min(Math.max(r.w, MIN_SIZE), 1);
  const h = Math.min(Math.max(r.h, MIN_SIZE), 1);
  return {
    w,
    h,
    x: Math.min(Math.max(r.x, 0), 1 - w),
    y: Math.min(Math.max(r.y, 0), 1 - h),
  };
}

/** 由两个框选点得到选区，反向拖也能正常框选。 */
function rectFromPoints(ax, ay, bx, by) {
  return clampRect({
    x: Math.min(ax, bx),
    y: Math.min(ay, by),
    w: Math.abs(bx - ax),
    h: Math.abs(by - ay),
  });
}

/**
 * 把一次手势位移作用到选区上。
 * origin 是手势开始时选区的位置，dx / dy 是位移（已归一化）。
 */
function applyDrag(origin, mode, dx, dy) {
  if (mode === 'move') return clampRect({ x: origin.x + dx, y: origin.y + dy, w: origin.w, h: origin.h });

  let { x, y, w, h } = origin;
  if (mode === 'se') {
    w = origin.w + dx;
    h = origin.h + dy;
  }
  if (mode === 'sw') {
    x = origin.x + dx;
    w = origin.w - dx;
    h = origin.h + dy;
  }
  if (mode === 'ne') {
    w = origin.w + dx;
    y = origin.y + dy;
    h = origin.h - dy;
  }
  if (mode === 'nw') {
    x = origin.x + dx;
    y = origin.y + dy;
    w = origin.w - dx;
    h = origin.h - dy;
  }
  return clampRect({ x, y, w, h });
}

/** 归一化选区映射到原始像素，取整。 */
function toSourcePixels(rect, sourceW, sourceH) {
  const sx = Math.round(rect.x * sourceW);
  const sy = Math.round(rect.y * sourceH);
  const sw = Math.max(1, Math.round(rect.w * sourceW));
  const sh = Math.max(1, Math.round(rect.h * sourceH));
  return {
    sx,
    sy,
    sw: Math.min(sw, sourceW - sx),
    sh: Math.min(sh, sourceH - sy),
  };
}

/** 图片以 contain 方式放进容器后，真正被照片占据的那块区域。 */
function containedBox(naturalW, naturalH, elementW, elementH) {
  if (!naturalW || !naturalH || !elementW || !elementH) {
    return { left: 0, top: 0, width: 0, height: 0 };
  }
  const scale = Math.min(elementW / naturalW, elementH / naturalH);
  const width = naturalW * scale;
  const height = naturalH * scale;
  return { left: (elementW - width) / 2, top: (elementH - height) / 2, width, height };
}

/** 归一化选区 → 容器内的像素位置，供 WXML 直接渲染。 */
function toStagePixels(rect, box) {
  return {
    left: Math.round(box.left + rect.x * box.width),
    top: Math.round(box.top + rect.y * box.height),
    width: Math.round(rect.w * box.width),
    height: Math.round(rect.h * box.height),
  };
}

module.exports = {
  FULL,
  DEFAULT_RECT,
  MIN_SIZE,
  clampRect,
  rectFromPoints,
  applyDrag,
  toSourcePixels,
  containedBox,
  toStagePixels,
};
