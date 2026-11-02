// Airport departure-board intro for flight scenes: a split-flap board
// ("CCU ✈ PEK · 5H 05M · BOARDING") that plays over the departure city before take-off.
import { distanceKm, span, lerp, easeOutCubic } from './geo.js';

let airports = [];
/** [iata, city, lng, lat, size(2 = large)] rows from data/airports.json. */
export function setAirports(list) { airports = list || []; }

/** Nearest airport with scheduled flights, preferring big ones (they're what people fly from). */
export function nearestAirport(place) {
  if (!place) return null;
  let best = null, bestScore = Infinity;
  for (const a of airports) {
    const d = distanceKm([place.lng, place.lat], [a[2], a[3]]);
    if (d > 250) continue;
    const score = d * (a[4] === 2 ? 1 : 2.5);
    if (score < bestScore) { bestScore = score; best = a; }
  }
  return best ? { code: best[0], city: best[1] } : null;
}

/** Rough gate-to-gate time: ~800 km/h plus 30 min for take-off and landing, to 5 minutes. */
export function estimateFlightTime(from, to) {
  if (!from || !to) return '';
  const mins = Math.max(30, Math.round(((distanceKm([from.lng, from.lat], [to.lng, to.lat]) / 800) * 60 + 30) / 5) * 5);
  return `${Math.floor(mins / 60)}H ${String(mins % 60).padStart(2, '0')}M`;
}

/** Minutes from what people type: "4H 35M", "4h35m", "4:35", "275 min", "4.5 h", "4 hours 35 minutes". */
export function parseFlightMinutes(str) {
  if (!str) return null;
  const t = String(str).toLowerCase().trim();
  let m = t.match(/^(\d+):(\d{1,2})$/);
  if (m) return +m[1] * 60 + +m[2];
  const hr = t.match(/(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours|ghante|ghanta)\b/), mn = t.match(/(\d+)\s*(?:m|min|mins|minute|minutes|minat)\b/);
  if (hr || mn) return Math.round((hr ? +hr[1] * 60 : 0) + (mn ? +mn[1] : 0));
  m = t.match(/^(\d+(?:\.\d+)?)$/);
  return m ? Math.round(+m[1] * 60) : null; // a bare number means hours
}

/** The scene's flight time in minutes: what you typed, else an estimate from the distance. */
export function flightMinutes(s) {
  return parseFlightMinutes(s.flightTime) ?? parseFlightMinutes(estimateFlightTime(s.from, s.to));
}

export const formatClock = mins => {
  const m = Math.max(0, Math.round(mins));
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};

const autoCode = place => nearestAirport(place)?.code || (place?.name || '???').replace(/[^a-z]/gi, '').slice(0, 3).toUpperCase().padEnd(3, ' ');
const cityName = place => (place?.name || '').split(',')[0].toUpperCase();

/** Everything the board shows, from the scene's settings (blank fields are filled in automatically). */
export function boardInfo(s) {
  return {
    from: (s.boardFrom || autoCode(s.from)).toUpperCase().slice(0, 3),
    to: (s.boardTo || autoCode(s.to)).toUpperCase().slice(0, 3),
    fromCity: cityName(s.from),
    toCity: cityName(s.to),
    rows: [
      ['DEPARTS', s.boardTime || ''],
      ['FLIGHT', (s.flightNo || '').toUpperCase()],
      ['GATE', (s.gate || '').toUpperCase()],
      ['DURATION', flightMinutes(s) != null ? formatClock(flightMinutes(s)).toUpperCase() : ''],
    ].filter(r => r[1]),
  };
}

export const BOARD_FLAPS = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:';
const MONO = '"SF Mono", Menlo, Consolas, "Roboto Mono", monospace';
const FLIP_RATE = 22; // flaps per second

/** Character on one tile at local time k: spins through the flaps, then settles left to right. */
export function flapAt(target, idx, k, start) {
  const settle = start + 0.35 + idx * 0.055;
  if (k < start) return { ch: ' ', f: 0, spinning: false, settle };
  if (k >= settle) return { ch: target, f: 0, spinning: false, settle };
  const n = Math.floor((k - start) * FLIP_RATE);
  return { ch: BOARD_FLAPS[(n + idx * 5 + target.charCodeAt(0)) % BOARD_FLAPS.length], f: ((k - start) * FLIP_RATE) % 1, spinning: true, settle };
}

/** When each board element starts flapping and when the status flips to DEPARTED (seconds into the intro). */
export function boardTimes(len) {
  return { codes: 0.35, cities: 0.75, rows: 0.95, status: 1.25, departed: Math.max(1.9, len - 1.35) };
}

function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function tile(ctx, x, y, w, h, ch, f, spinning, color, sc) {
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, '#262b35'); g.addColorStop(0.5, '#1c2028'); g.addColorStop(0.5, '#15181f'); g.addColorStop(1, '#1b1f27');
  ctx.fillStyle = g;
  rrect(ctx, x, y, w, h, 4 * sc); ctx.fill();
  ctx.save();
  rrect(ctx, x, y, w, h, 4 * sc); ctx.clip();
  ctx.fillStyle = color;
  ctx.font = `700 ${h * 0.68}px ${MONO}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(ch, x + w / 2, y + h / 2 + h * 0.03);
  if (spinning) {
    // the top flap falling over the hinge
    const fh = (h / 2) * (1 - f);
    ctx.fillStyle = 'rgba(14,16,21,0.85)';
    ctx.fillRect(x, y + h / 2 - fh, w, fh);
  }
  ctx.restore();
  // hinge line
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(x, y + h / 2 - 0.75 * sc, w, 1.5 * sc);
}

function flapText(ctx, text, x, y, tw, th, gap, k, start, color, sc) {
  for (let i = 0; i < text.length; i++) {
    const { ch, f, spinning } = flapAt(text[i], i, k, start);
    tile(ctx, x + i * (tw + gap), y, tw, th, ch, f, spinning, color, sc);
  }
}

/** Draw the board at `k` seconds into an intro lasting `len` seconds. */
export function drawBoard(ctx, W, H, b, k, len) {
  const a = easeOutCubic(span(k, 0, 0.45)), out = span(k, len - 0.55, len);
  const alpha = a * (1 - out);
  if (alpha <= 0) return;
  const T = boardTimes(len);
  const portrait = H > W;
  // Reels are narrow, so the board is drawn bigger relative to its width there
  const bw = Math.min(W * (portrait ? 0.92 : 0.86), 780), sc = bw / (portrait ? 600 : 780);

  // layout (in board units × sc)
  const codeW = 78 * sc, codeH = 100 * sc, codeGap = 7 * sc, planeGap = (portrait ? 74 : 120) * sc;
  const rowsN = b.rows.length + 1; // + status
  const perRow = portrait ? 2 : Math.min(rowsN, 5);
  const infoLines = Math.ceil(rowsN / perRow);
  const bh = (56 + 36 + 100 + 36 + infoLines * 70 + 26) * sc;
  const x0 = (W - bw) / 2;
  const y0 = (H - bh) / 2 + lerp(26, 0, a) * sc - out * 18 * sc;

  ctx.save();
  ctx.globalAlpha = alpha;
  // backdrop
  const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.2, W / 2, H / 2, Math.max(W, H) * 0.75);
  vg.addColorStop(0, 'rgba(5,7,12,0.35)'); vg.addColorStop(1, 'rgba(5,7,12,0.78)');
  ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);

  // panel
  ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 40 * sc; ctx.shadowOffsetY = 14 * sc;
  const pg = ctx.createLinearGradient(0, y0, 0, y0 + bh);
  pg.addColorStop(0, '#14171e'); pg.addColorStop(1, '#0a0c10');
  ctx.fillStyle = pg;
  rrect(ctx, x0, y0, bw, bh, 18 * sc); ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = 'rgba(255,255,255,0.09)'; ctx.lineWidth = 1;
  rrect(ctx, x0 + 0.5, y0 + 0.5, bw - 1, bh - 1, 18 * sc); ctx.stroke();

  // header bar
  ctx.save();
  rrect(ctx, x0, y0, bw, 56 * sc, [18 * sc, 18 * sc, 0, 0]); ctx.clip();
  ctx.fillStyle = '#ffb400'; ctx.fillRect(x0, y0, bw, 56 * sc);
  ctx.restore();
  ctx.fillStyle = '#111';
  ctx.font = `800 ${22 * sc}px Poppins, Inter, system-ui, sans-serif`;
  ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  ctx.fillText('✈  DEPARTURES', x0 + 24 * sc, y0 + 29 * sc);
  ctx.textAlign = 'right';
  ctx.font = `700 ${15 * sc}px Poppins, Inter, system-ui, sans-serif`;
  ctx.fillText('DÉPARTS · प्रस्थान', x0 + bw - 24 * sc, y0 + 29 * sc);

  // big codes:  CCU  ✈  PEK
  const codesW = 6 * codeW + 4 * codeGap + planeGap;
  const cx = x0 + (bw - codesW) / 2, cy = y0 + (56 + 36) * sc;
  flapText(ctx, b.from.padEnd(3), cx, cy, codeW, codeH, codeGap, k, T.codes, '#ffffff', sc);
  const tx = cx + 3 * codeW + 2 * codeGap + planeGap;
  flapText(ctx, b.to.padEnd(3), tx, cy, codeW, codeH, codeGap, k, T.codes + 0.12, '#ffffff', sc);
  // plane between the codes, sliding in
  const pa = easeOutCubic(span(k, T.codes + 0.2, T.codes + 0.9));
  ctx.save();
  ctx.globalAlpha = alpha * pa;
  ctx.fillStyle = '#ffb400';
  ctx.font = `${46 * sc}px "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('✈️', cx + 3 * codeW + 2 * codeGap + planeGap / 2 + lerp(-30, 0, pa) * sc, cy + codeH / 2);
  ctx.restore();

  // city names under the codes
  const ca = span(k, T.cities, T.cities + 0.4);
  ctx.save();
  ctx.globalAlpha = alpha * ca;
  ctx.fillStyle = 'rgba(255,255,255,0.62)';
  ctx.font = `600 ${15 * sc}px Poppins, Inter, system-ui, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const cityY = cy + codeH + 10 * sc;
  ctx.fillText(b.fromCity.slice(0, 22), cx + (3 * codeW + 2 * codeGap) / 2, cityY);
  ctx.fillText(b.toCity.slice(0, 22), tx + (3 * codeW + 2 * codeGap) / 2, cityY);
  ctx.restore();

  // divider
  const dy = y0 + (56 + 36 + 100 + 36) * sc;
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(x0 + 24 * sc, dy - 8 * sc, bw - 48 * sc, 1);

  // info columns, then status
  const departed = k >= T.departed;
  const status = departed ? 'DEPARTED' : 'BOARDING';
  const cells = [...b.rows, ['STATUS', status]];
  const colW = (bw - 48 * sc) / perRow;
  // one tile size for every column, small enough that the longest value fits
  const longest = Math.max(8, ...cells.map(([, v]) => v.length));
  const sg = 2.5 * sc, sw = Math.min(17 * sc, (colW - 10 * sc) / longest - sg), sh = sw * 1.5;
  cells.forEach(([label, value], i) => {
    const col = i % perRow, line = Math.floor(i / perRow);
    const lx = x0 + 24 * sc + col * colW, ly = dy + line * 70 * sc;
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = `700 ${11 * sc}px Poppins, Inter, system-ui, sans-serif`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(label, lx, ly + 6 * sc);
    const isStatus = label === 'STATUS';
    const start = isStatus ? (departed ? T.departed : T.status) : T.rows + i * 0.08;
    let color = '#ffd34d';
    if (isStatus) color = departed ? '#3ddc84' : (Math.floor(k * 2.2) % 2 && k > T.status + 0.9 ? 'rgba(255,211,77,0.35)' : '#ffd34d');
    flapText(ctx, value, lx, ly + 26 * sc, sw, sh, sg, k, start, color, sc);
  });
  ctx.restore();
}

/** Seconds (into the intro) at which tiles flap, for the clatter sound. */
export function boardFlapTimes(b, len) {
  const T = boardTimes(len), times = [];
  const add = (text, start) => {
    for (let i = 0; i < text.length; i++) {
      const settle = start + 0.35 + i * 0.055;
      for (let k = start; k < settle; k += 1 / FLIP_RATE) times.push(k);
    }
  };
  add(b.from, T.codes); add(b.to, T.codes + 0.12);
  b.rows.forEach(([, v], i) => add(v, T.rows + i * 0.08));
  add('BOARDING', T.status); add('DEPARTED', T.departed);
  return { times: times.sort((x, y) => x - y), departed: T.departed };
}
