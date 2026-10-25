/**
 * 本地逐笔笔顺比对（PRD 9.4 第二、三层的本地实现）。
 *
 * 标准数据与笔顺动画同源（hanzi-writer medians，512 盒、y 轴朝上）——
 * 「教的」与「考的」完全一致，这是 PRD 对笔顺检查的硬要求。
 *
 * 历史教训（见 strokes.js 头注释）：
 *   - 模型推断笔顺不可靠（3 个抽样字错 2 个）；
 *   - 中心线几何分类器判笔画「名称」15 字只对 1 个。
 * 本模块做的是「顺序/位置」比对，不是名称分类，且从严设计：
 *   - 只报本地可验证的事实：笔画数、落笔位置顺序、（仅提示的）行笔方向；
 *   - 不确定一律放行（宁漏勿错），报错必须给到具体第几笔；
 *   - 用户笔迹做「字形相对化」处理（按自身包围盒平移缩放）——
 *     孩子把字写在格子哪个角落、写多大，都不该影响对错判定。
 */

const SOURCE_BOX = 512; // medians 源坐标系边长（与 strokes.js 一致）

/** 归一化目标：字形外接框边长统一缩放到的长度（标准字在 512 盒里约占八成半） */
const TARGET_SIDE = 0.85;
/** 放大上限：防止一笔误触的小点被放大成整字 */
const MAX_SCALE_UP = 2.2;
/** 太小视为无效笔迹（误触/划痕），交回给 AI 与人工 */
const MIN_SIDE = 0.15;
/** 顺序误判的置信条件：最近笔距离 < 0.55 × 原位距离，且绝对距离足够小 */
const CONF_RATIO = 0.55;
const CONF_ABS = 0.28;

/* ---------------- 归一化 ---------------- */

/** 标准一笔：512 盒 y 轴朝上 → 0..1 y 轴朝下（与 strokes.js 的 toPath 同一翻转） */
function normStandardStroke(median) {
  return median.map((p) => ({ x: p[0] / SOURCE_BOX, y: 1 - p[1] / SOURCE_BOX }));
}

/** 用户一笔：画布 px（y 朝下）→ 0..1 */
function normUserStroke(points, size) {
  return points
    .filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))
    .map((p) => ({ x: p.x / size, y: p.y / size }));
}

/** 所有笔的点集包围盒 */
function bboxOf(allPoints) {
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  let has = false;
  for (const p of allPoints) {
    has = true;
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (!has) return null;
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

/**
 * 字形相对化：把整组笔画平移到中心 (0.5, 0.5)，包围盒长边缩放到 TARGET_SIDE。
 * 只在放大方向生效（写太大不缩小），并设放大上限。
 */
function glyphNormalize(strokes) {
  const all = [];
  for (const s of strokes) for (const p of s) all.push(p);
  const box = bboxOf(all);
  if (!box || box.w <= 0.0001 || box.h <= 0.0001) return null;

  const side = Math.max(box.w, box.h);
  if (side < MIN_SIDE) return null;
  const scale = side < TARGET_SIDE ? Math.min(MAX_SCALE_UP, TARGET_SIDE / side) : 1;
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;

  return strokes.map((s) =>
    s.map((p) => ({
      x: 0.5 + (p.x - cx) * scale,
      y: 0.5 + (p.y - cy) * scale,
    })),
  );
}

/* ---------------- 特征与距离 ---------------- */

function feat(pts) {
  return {
    start: pts[0],
    mid: pts[Math.floor(pts.length / 2)],
    end: pts[pts.length - 1],
  };
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 两笔距离：起笔为主（顺序感来自落笔位置），中段收笔为辅 */
function strokeDist(fa, fb) {
  return 0.5 * dist(fa.start, fb.start) + 0.25 * dist(fa.mid, fb.mid) + 0.25 * dist(fa.end, fb.end);
}

/** 行笔方向向量（点太少的点笔没有方向） */
function dirVec(f) {
  const dx = f.end.x - f.start.x;
  const dy = f.end.y - f.start.y;
  const len = Math.hypot(dx, dy);
  return len < 0.12 ? null : { dx: dx / len, dy: dy / len };
}

/* ---------------- 主检查 ---------------- */

/**
 * 比对用户笔顺与标准笔顺。
 * @param {Array<Array<{x,y}>>} userStrokes 用户笔画（画布 px 坐标，每笔为点列）
 * @param {number} canvasSize 画布边长（px），用于归一化
 * @param {Array<Array<[number,number]>>} medians 标准笔顺（512 盒源数据）
 * @returns {{status: string, detail: string, hint: string, firstErrorIndex: number}}
 *   status: 'pass' | 'count-error' | 'order-error' | 'unclear' | 'no-data'
 */
function checkStrokeOrder(userStrokes, canvasSize, medians) {
  const empty = { status: 'no-data', detail: '', hint: '', firstErrorIndex: -1 };
  if (!Array.isArray(medians) || !medians.length) return empty;
  if (!Array.isArray(userStrokes) || !userStrokes.length) return empty;

  const stdNorm = glyphNormalize(medians.map(normStandardStroke));
  const userNorm = glyphNormalize(userStrokes.map((s) => normUserStroke(s, canvasSize)));
  if (!stdNorm || !userNorm) return { status: 'unclear', detail: '', hint: '', firstErrorIndex: -1 };

  const uc = userNorm.length;
  const sc = stdNorm.length;

  // 笔画数：差 1 笔常是两笔连写成一笔（如「口」的竖横钩连笔），按容差放行；
  // 差 2 笔以上，字几乎一定写错，本地即可定论。
  if (Math.abs(uc - sc) >= 2) {
    return {
      status: 'count-error',
      detail:
        uc > sc
          ? `写了 ${uc} 笔，这个字标准是 ${sc} 笔，多写了几笔`
          : `写了 ${uc} 笔，这个字标准是 ${sc} 笔，少写了几笔`,
      hint: '',
      firstErrorIndex: -1,
    };
  }

  const userFeat = userNorm.map(feat);
  const stdFeat = stdNorm.map(feat);

  // 笔画数一致：逐一找最近标准笔，原位不匹配且置信足够才判顺序错。
  if (uc === sc) {
    let firstError = -1;
    let firstDetail = '';
    for (let i = 0; i < uc; i += 1) {
      let best = -1;
      let bestDist = Infinity;
      for (let j = 0; j < sc; j += 1) {
        const d = strokeDist(userFeat[i], stdFeat[j]);
        if (d < bestDist) {
          bestDist = d;
          best = j;
        }
      }
      const identityDist = strokeDist(userFeat[i], stdFeat[i]);
      if (best !== i && bestDist < CONF_RATIO * identityDist && bestDist < CONF_ABS) {
        firstError = i;
        firstDetail = `第 ${i + 1} 笔的落笔位置更接近标准笔顺的第 ${best + 1} 笔`;
        break;
      }
    }

    // 方向提示：原位匹配的笔里方向明显相反的，只提示不定错（PRD：方向仅作提示）。
    let dirHint = '';
    if (firstError === -1) {
      for (let i = 0; i < uc; i += 1) {
        const du = dirVec(userFeat[i]);
        const ds = dirVec(stdFeat[i]);
        if (du && ds && du.dx * ds.dx + du.dy * ds.dy < -0.5) {
          dirHint = `第 ${i + 1} 笔的行笔方向与标准相反，建议对照笔顺动画再写一遍`;
          break;
        }
      }
    }

    if (firstError !== -1) {
      return { status: 'order-error', detail: firstDetail, hint: '', firstErrorIndex: firstError };
    }
    return { status: 'pass', detail: '', hint: dirHint, firstErrorIndex: -1 };
  }

  // 笔画数差 1：不判顺序错（连笔/断笔让起笔对位失去意义），如实给个说明。
  return {
    status: 'pass',
    detail: '',
    hint: uc > sc ? '笔画数比标准多 1 笔，可能有两笔连写了' : '笔画数比标准少 1 笔，可能有两笔连写了',
    firstErrorIndex: -1,
  };
}

module.exports = { checkStrokeOrder, glyphNormalize, strokeDist };
