// Time-of-day looks for travel scenes (day / morning / sunset / night) and the clouds
// a flight passes through on take-off and landing. Everything is a pure function of time.
import { lerp, clamp, span, smooth } from './geo.js';

/** Numbers only, so two looks can be blended during a scene transition. */
export const LOOKS = {
  day: {
    gradeTop: [0, 0, 0, 0], gradeBottom: [0, 0, 0, 0], vignette: 0,
    bright: 1, sat: 0.12, contrast: 0.06, hue: 0, lights: 0, dark: 0,
    sky: null, // keep the style's own sky
  },
  morning: {
    gradeTop: [255, 238, 205, 0.12], gradeBottom: [165, 205, 255, 0.10], vignette: 0.12,
    bright: 1, sat: 0.2, contrast: 0.1, hue: 0, lights: 0, dark: 0,
    sky: { sky: [120, 180, 255], horizon: [255, 240, 214], fog: [255, 246, 232] },
  },
  sunset: {
    gradeTop: [255, 128, 50, 0.30], gradeBottom: [120, 36, 110, 0.26], vignette: 0.35,
    bright: 0.86, sat: 0.08, contrast: 0.14, hue: -6, lights: 0, dark: 0.15,
    sky: { sky: [44, 30, 82], horizon: [255, 150, 80], fog: [255, 170, 120] },
  },
  night: {
    gradeTop: [6, 12, 38, 0.2], gradeBottom: [3, 6, 22, 0.28], vignette: 0.55,
    bright: 0.2, sat: -0.6, contrast: 0.1, hue: 18, lights: 1, dark: 1,
    sky: { sky: [2, 4, 14], horizon: [28, 44, 92], fog: [10, 18, 46] },
  },
};
export const LOOK_NAMES = [['day', '☀️ Day (normal)'], ['morning', '🌤 Morning — soft light'], ['sunset', '🌅 Sunset'], ['night', '🌙 Night — city lights']];

export const lookOf = s => (s?.type === 'travel' && LOOKS[s.sky] ? s.sky : 'day');
/** Clouds on take-off/landing: the scene's own choice, else on for morning and sunset flights. */
export const cloudsOn = s => s?.type === 'travel' && s.mode === 'flight' && (s.clouds ?? (s.sky === 'morning' || s.sky === 'sunset'));

const mix = (a, b, w) => a.map((v, i) => lerp(v, b[i], w));
export function blendLook(a, b, w) {
  if (w <= 0) return a;
  if (w >= 1) return b;
  const out = {};
  for (const k of Object.keys(a)) {
    if (k === 'sky') continue;
    out[k] = Array.isArray(a[k]) ? mix(a[k], b[k], w) : lerp(a[k], b[k], w);
  }
  const sa = a.sky || LOOKS.morning.sky, sb = b.sky || LOOKS.morning.sky; // "no sky" blends like a plain daytime sky
  out.sky = !a.sky && !b.sky ? null : { sky: mix(sa.sky, sb.sky, w), horizon: mix(sa.horizon, sb.horizon, w), fog: mix(sa.fog, sb.fog, w) };
  return out;
}

export const rgb = c => `rgb(${c.map(Math.round).join(',')})`;
const rgba = c => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${c[3]})`;

/** Colour grade over the map (drawn first on the overlay, so labels and the plane stay clean). */
export function drawGrade(ctx, W, H, L) {
  if (L.gradeTop[3] + L.gradeBottom[3] + L.vignette < 0.005) return;
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, rgba(L.gradeTop)); g.addColorStop(1, rgba(L.gradeBottom));
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  if (L.vignette > 0.005) {
    const v = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.hypot(W, H) * 0.6);
    v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, `rgba(0,0,0,${0.55 * L.vignette})`);
    ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
  }
}

// ---------------------------------------------------------------- clouds

const CLOUD_TINT = {
  day: { light: [255, 255, 255], shade: [196, 208, 226], alpha: 0.95 },
  morning: { light: [255, 250, 240], shade: [200, 212, 232], alpha: 0.95 },
  sunset: { light: [255, 200, 160], shade: [150, 90, 130], alpha: 0.92 },
  night: { light: [92, 104, 140], shade: [28, 34, 58], alpha: 0.75 },
};

let seed = 1;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

const sprites = {};
/** A few soft, puffy cloud textures per look, lit from the top. */
function cloudSprites(look) {
  if (sprites[look]) return sprites[look];
  const tint = CLOUD_TINT[look] || CLOUD_TINT.day;
  seed = 4242;
  sprites[look] = Array.from({ length: 6 }, () => {
    const w = 320, h = 190;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    const puffs = 16 + Math.floor(rnd() * 10);
    for (let i = 0; i < puffs; i++) {
      const x = w * (0.18 + rnd() * 0.64), y = h * (0.35 + rnd() * 0.35) - (1 - Math.abs(x / w - 0.5) * 2) * h * 0.12;
      const r = h * (0.16 + rnd() * 0.2) * (1 - Math.abs(x / w - 0.5));
      const top = y < h * 0.5;
      const c = top ? tint.light : mix(tint.light, tint.shade, 0.55);
      const g = ctx.createRadialGradient(x, y - r * 0.25, r * 0.1, x, y, r);
      g.addColorStop(0, `rgba(${c.map(Math.round).join(',')},0.95)`);
      g.addColorStop(0.55, `rgba(${c.map(Math.round).join(',')},0.55)`);
      g.addColorStop(1, `rgba(${c.map(Math.round).join(',')},0)`);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
    return cv;
  });
  return sprites[look];
}

// cloud bank layout: fixed per scene so preview and export match
function bank(n, s) {
  seed = s;
  return Array.from({ length: n }, () => ({ x: rnd() * 2 - 1, y: rnd() * 2 - 1, z: 0.25 + rnd() * 1.4, k: Math.floor(rnd() * 6), flip: rnd() < 0.5, w: 0.8 + rnd() * 0.7 }));
}
const BANKS = {};

/**
 * Flying through a cloud bank: clouds rush towards the camera and past the edges.
 * `k` 0→1 is progress through the bank.
 */
export function drawFlyThrough(ctx, W, H, k, look, id) {
  const env = Math.sin(Math.PI * clamp(k, 0, 1));
  if (env <= 0.01) return;
  const spr = cloudSprites(look), tint = CLOUD_TINT[look] || CLOUD_TINT.day;
  const clouds = (BANKS[id] ||= bank(26, 97 + id.length * 13));
  const R = Math.max(W, H);
  ctx.save();
  // a light haze while inside the cloud
  ctx.fillStyle = `rgba(${tint.light.join(',')},${0.38 * env * env * tint.alpha})`;
  ctx.fillRect(0, 0, W, H);
  const order = clouds.map(c => ({ c, z: c.z - k * 1.6 })).filter(o => o.z > 0.04).sort((a, b) => b.z - a.z);
  for (const { c, z } of order) {
    const sc = 0.32 / z;
    const w = R * 0.5 * sc * c.w, h = w * 0.6;
    const x = W / 2 + c.x * R * 0.45 / z - w / 2, y = H / 2 + c.y * R * 0.3 / z - h / 2;
    if (x > W || y > H || x + w < 0 || y + h < 0) continue;
    const near = smooth(span(z, 0.04, 0.3)); // fade just before it hits the lens
    ctx.globalAlpha = tint.alpha * env * near * smooth(span(z, 1.7, 1.1));
    ctx.save();
    if (c.flip) { ctx.translate(x + w, y); ctx.scale(-1, 1); ctx.drawImage(spr[c.k], 0, 0, w, h); } else ctx.drawImage(spr[c.k], x, y, w, h);
    ctx.restore();
  }
  ctx.restore();
}

/** A thin layer of clouds below the plane while cruising, drifting against the direction of flight. */
export function drawCloudDeck(ctx, W, H, t, dir, alpha, look, id) {
  if (alpha <= 0.01) return;
  const spr = cloudSprites(look), tint = CLOUD_TINT[look] || CLOUD_TINT.day;
  const clouds = (BANKS['deck' + id] ||= bank(14, 311 + id.length * 7));
  const R = Math.max(W, H);
  const speed = R * 0.05;
  ctx.save();
  for (const c of clouds) {
    const w = R * 0.32 * c.w, h = w * 0.45;
    const span2 = (n, m) => ((n % m) + m) % m;
    const x = span2(c.x * R + 0.5 * R - dir[0] * speed * t * (0.6 + c.z * 0.3), W + w * 2) - w;
    const y = span2(c.y * R + 0.5 * R - dir[1] * speed * t * (0.6 + c.z * 0.3), H + h * 2) - h;
    ctx.globalAlpha = alpha * tint.alpha * 0.4 * (0.6 + 0.4 * (c.z / 1.65));
    ctx.drawImage(spr[c.k], x, y, w, h);
  }
  ctx.restore();
}

/** Blinking navigation lights on the plane at night: red strobe, white flash. */
export function drawNavLights(ctx, x, y, size, t, a) {
  if (a <= 0.01) return;
  const blink = (t * 1.25) % 1;
  const flash = blink < 0.08 ? 1 : 0;
  const pulse = 0.55 + 0.45 * Math.sin(t * 6.3);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const glow = (gx, gy, r, col, al) => {
    const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, r);
    g.addColorStop(0, `rgba(${col},${al})`); g.addColorStop(1, `rgba(${col},0)`);
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(gx, gy, r, 0, Math.PI * 2); ctx.fill();
  };
  glow(x, y, 26 * size, '255,214,140', 0.22 * a); // cabin glow
  glow(x, y - 4 * size, 9 * size, '255,60,60', 0.9 * a * pulse);
  if (flash) glow(x, y, 34 * size, '255,255,255', 0.85 * a);
  ctx.restore();
}
