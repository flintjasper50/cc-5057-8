export const EPS = 1e-9;

export function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function invLerp(a, b, x) {
  return Math.abs(b - a) < EPS ? 0 : (x - a) / (b - a);
}

export function round(x, digits = 3) {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

export function add2(a, b) { return [a[0] + b[0], a[1] + b[1]]; }
export function sub2(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
export function scale2(a, s) { return [a[0] * s, a[1] * s]; }
export function dot2(a, b) { return a[0] * b[0] + a[1] * b[1]; }
export function cross2(a, b) { return a[0] * b[1] - a[1] * b[0]; }
export function len2(a) { return Math.hypot(a[0], a[1]); }
export function norm2(a) {
  const l = len2(a);
  return l < EPS ? [0, 0] : [a[0] / l, a[1] / l];
}
export function dist2(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
export function perp2(a) { return [-a[1], a[0]]; }

export function sub3(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
export function add3(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
export function scale3(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
export function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
export function len3(a) { return Math.hypot(a[0], a[1], a[2]); }
export function norm3(a) {
  const l = len3(a);
  return l < EPS ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l];
}
export function dist3(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
export function lerp3(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

export function pointInRect2(p, rect) {
  return p[0] >= rect.min[0] && p[0] <= rect.max[0] &&
         p[1] >= rect.min[1] && p[1] <= rect.max[1];
}

export function rectCenter2(rect) {
  return [(rect.min[0] + rect.max[0]) / 2, (rect.min[1] + rect.max[1]) / 2];
}

export function distancePointSegment2(p, a, b) {
  const abx = b[0] - a[0];
  const abz = b[1] - a[1];
  const apx = p[0] - a[0];
  const apz = p[1] - a[1];
  const denom = abx * abx + abz * abz;
  let t = denom < EPS ? 0 : (apx * abx + apz * abz) / denom;
  t = clamp(t, 0, 1);
  return Math.hypot(p[0] - (a[0] + abx * t), p[1] - (a[1] + abz * t));
}

// Proper segment intersection in 2D. Returns {t,u,point} where t along p1->p2,
// u along q1->q2, or null when parallel / outside both segments.
export function segmentIntersection2(p1, p2, q1, q2, eps = EPS) {
  const r = sub2(p2, p1);
  const s = sub2(q2, q1);
  const denom = cross2(r, s);
  if (Math.abs(denom) < eps) return null;
  const qp = sub2(q1, p1);
  const t = cross2(qp, s) / denom;
  const u = cross2(qp, r) / denom;
  if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) return null;
  return { t, u, point: [p1[0] + r[0] * t, p1[1] + r[1] * t] };
}

// Liang-Barsky: intersection interval of segment p->q with axis-aligned rect.
export function segmentRectInterval2(p, q, rect, eps = EPS) {
  let t0 = 0;
  let t1 = 1;
  const dx = q[0] - p[0];
  const dz = q[1] - p[1];
  const checks = [
    [-dx, p[0] - rect.min[0]],
    [dx, rect.max[0] - p[0]],
    [-dz, p[1] - rect.min[1]],
    [dz, rect.max[1] - p[1]],
  ];
  for (const [pk, qk] of checks) {
    if (Math.abs(pk) < eps) {
      if (qk < 0) return null;
    } else {
      const r = qk / pk;
      if (pk < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }
  }
  return t1 >= t0 ? [t0, t1] : null;
}

// Slab test for a segment against an AABB in 3D. Returns entry/exit t or null.
export function segmentAabbInterval3(p, q, min, max, eps = EPS) {
  let t0 = 0;
  let t1 = 1;
  for (let axis = 0; axis < 3; axis++) {
    const d = q[axis] - p[axis];
    const lo = min[axis];
    const hi = max[axis];
    if (Math.abs(d) < eps) {
      if (p[axis] < lo || p[axis] > hi) return null;
    } else {
      let a = (lo - p[axis]) / d;
      let b = (hi - p[axis]) / d;
      if (a > b) [a, b] = [b, a];
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) return null;
    }
  }
  return [t0, t1];
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function shuffleInPlace(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function jaccard(aSet, bSet) {
  let inter = 0;
  for (const x of aSet) if (bSet.has(x)) inter++;
  const union = aSet.size + bSet.size - inter;
  return union === 0 ? 1 : inter / union;
}
