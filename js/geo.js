// Geometry helpers: distances, great circles, paths you can sample by fraction,
// easing curves and a mercator "fit bounds" that works in design pixels.

const R = 6371.0088;
export const rad = d => d * Math.PI / 180;
export const deg = r => r * 180 / Math.PI;
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = t => t * t * (3 - 2 * t);
export const easeInOutCubic = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
export const easeInOutSine = t => -(Math.cos(Math.PI * t) - 1) / 2;
export const easeOutBack = t => { const c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
export const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
/** 0..1 progress of t inside [a, b] */
export const span = (t, a, b) => clamp((t - a) / (b - a), 0, 1);

export function distanceKm(a, b) {
  const dLat = rad(b[1] - a[1]), dLng = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearing(a, b) {
  const y = Math.sin(rad(b[0] - a[0])) * Math.cos(rad(b[1]));
  const x = Math.cos(rad(a[1])) * Math.sin(rad(b[1])) - Math.sin(rad(a[1])) * Math.cos(rad(b[1])) * Math.cos(rad(b[0] - a[0]));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** Make longitudes continuous so lines crossing the antimeridian don't jump. */
export function unwrap(coords) {
  const out = [coords[0].slice()];
  for (let i = 1; i < coords.length; i++) {
    let lng = coords[i][0];
    const prev = out[i - 1][0];
    while (lng - prev > 180) lng -= 360;
    while (lng - prev < -180) lng += 360;
    out.push([lng, coords[i][1]]);
  }
  return out;
}

export function greatCircle(a, b, n = 160) {
  const [l1, p1, l2, p2] = [rad(a[0]), rad(a[1]), rad(b[0]), rad(b[1])];
  const d = distanceKm(a, b) / R;
  if (d < 1e-6) return [a, b];
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
    const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
    const z = A * Math.sin(p1) + B * Math.sin(p2);
    pts.push([deg(Math.atan2(y, x)), deg(Math.atan2(z, Math.sqrt(x * x + y * y)))]);
  }
  return unwrap(pts);
}

/** A gently bent line (quadratic bezier in mercator space) — used for trains, boats, fallbacks. */
export function curvedLine(a, b, n = 120, bend = 0.12) {
  const [ax, ay] = toMerc(a), [bx0, by] = toMerc(unwrap([a, b])[1]);
  const bx = bx0;
  const mx = (ax + bx) / 2, my = (ay + by) / 2;
  const dx = bx - ax, dy = by - ay;
  const cx = mx - dy * bend, cy = my + dx * bend;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    pts.push(fromMerc([u * u * ax + 2 * u * t * cx + t * t * bx, u * u * ay + 2 * u * t * cy + t * t * by]));
  }
  return pts;
}

export function toMerc([lng, lat]) {
  const s = Math.sin(rad(clamp(lat, -85, 85)));
  return [(lng + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)];
}
export function fromMerc([x, y]) {
  return [x * 360 - 180, deg(Math.atan(Math.sinh(Math.PI * (1 - 2 * y))))];
}

export function bboxOf(coords) {
  let b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of coords) {
    if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y;
    if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y;
  }
  return b;
}
export function unionBbox(a, b) {
  if (!a) return b; if (!b) return a;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

/** Camera that fits a bbox inside a W×H design frame. Returns {center, zoom}. */
export function fitBbox(bbox, W, H, pad = 60, maxZoom = 16) {
  const [x0, y1] = toMerc([bbox[0], bbox[1]]);
  const [x1, y0] = toMerc([bbox[2], bbox[3]]);
  const dx = Math.max(x1 - x0, 1e-9), dy = Math.max(y1 - y0, 1e-9);
  const zoom = Math.log2(Math.min((W - 2 * pad) / (dx * 512), (H - 2 * pad) / (dy * 512)));
  return { center: fromMerc([(x0 + x1) / 2, (y0 + y1) / 2]), zoom: clamp(zoom, 0.6, maxZoom) };
}

/** Keep at most n points, preserving shape reasonably (uniform-by-distance resample). */
export function resample(coords, n = 1500) {
  if (coords.length <= n) return coords;
  const p = new Path(coords);
  const out = [];
  for (let i = 0; i <= n; i++) out.push(p.pointAt(i / n));
  return out;
}

/** A polyline you can sample by fraction of its length. */
export class Path {
  constructor(coords) {
    this.coords = coords;
    this.cum = [0];
    for (let i = 1; i < coords.length; i++) this.cum.push(this.cum[i - 1] + distanceKm(coords[i - 1], coords[i]));
    this.total = this.cum[this.cum.length - 1] || 0;
    this.bbox = bboxOf(coords);
  }
  _locate(f) {
    const d = clamp(f, 0, 1) * this.total;
    let lo = 0, hi = this.cum.length - 1;
    while (lo < hi - 1) { const m = (lo + hi) >> 1; if (this.cum[m] <= d) lo = m; else hi = m; }
    const segLen = this.cum[hi] - this.cum[lo];
    return { i: lo, k: segLen > 0 ? (d - this.cum[lo]) / segLen : 0 };
  }
  pointAt(f) {
    if (this.coords.length < 2) return this.coords[0];
    const { i, k } = this._locate(f);
    const a = this.coords[i], b = this.coords[Math.min(i + 1, this.coords.length - 1)];
    return [lerp(a[0], b[0], k), lerp(a[1], b[1], k)];
  }
  slice(f) {
    if (f <= 0) return [this.coords[0], this.coords[0]];
    if (f >= 1) return this.coords;
    const { i } = this._locate(f);
    return [...this.coords.slice(0, i + 1), this.pointAt(f)];
  }
  /** Smoothed heading around fraction f; window is a fraction of total length. */
  headingAt(f, win = 0.04) {
    const a = this.pointAt(Math.max(0, f - win)), b = this.pointAt(Math.min(1, f + win));
    return bearing(a, b);
  }
}

export function angleLerp(a, b, t) {
  const d = ((b - a + 540) % 360) - 180;
  return a + d * t;
}
