// Travel modes and the top-down vehicle drawings used on the overlay canvas.
// Every drawing is centred at (0,0), points "up" (north), and is ~1 unit = 1 design px.

export const MODES = {
  flight: { label: 'Flight', emoji: '✈️', line: 'dash', path: 'arc', color: '#ffffff', speedHint: 'fast' },
  car: { label: 'Car', emoji: '🚗', line: 'solid', path: 'road', color: '#3fa9ff' },
  taxi: { label: 'Taxi', emoji: '🚕', line: 'solid', path: 'road', color: '#ffc400' },
  bus: { label: 'Bus', emoji: '🚌', line: 'solid', path: 'road', color: '#ff5a5f' },
  train: { label: 'Train', emoji: '🚆', line: 'rail', path: 'curve', color: '#b388ff' },
  walk: { label: 'Walk', emoji: '🚶', line: 'dot', path: 'road', color: '#00e0a4' },
  bike: { label: 'Bike', emoji: '🏍️', line: 'solid', path: 'road', color: '#ff8a3d' },
  boat: { label: 'Boat', emoji: '⛴️', line: 'dash', path: 'curve', color: '#2ec4f1' },
};

// Material Design "flight" glyph (Apache 2.0), nose pointing up, 24×24 box.
const PLANE = new Path2D('M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z');
const WALK = new Path2D('M13.5 5.5c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zM9.8 8.9L7 23h2.1l1.8-8 2.1 2v6h2v-7.5l-2.1-2 .6-3C14.8 12 16.8 13 19 13v-2c-1.9 0-3.5-1-4.3-2.4l-1-1.6c-.4-.6-1-1-1.7-1-.3 0-.5.1-.8.1L6 8.3V13h2V9.6l1.8-.7');
const BIKE = new Path2D('M15.5 5.5c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zM5 12c-2.8 0-5 2.2-5 5s2.2 5 5 5 5-2.2 5-5-2.2-5-5-5zm0 8.5c-1.9 0-3.5-1.6-3.5-3.5s1.6-3.5 3.5-3.5 3.5 1.6 3.5 3.5-1.6 3.5-3.5 3.5zm5.8-10l2.4-2.4.8.8c1.3 1.3 3 2.1 5.1 2.1V9c-1.5 0-2.7-.6-3.6-1.5l-1.9-1.9c-.5-.4-1-.6-1.6-.6s-1.1.2-1.4.6L7.8 8.4c-.4.4-.6.9-.6 1.4 0 .6.2 1.1.6 1.4L11 14v5h2v-6.2l-2.2-2.3zM19 12c-2.8 0-5 2.2-5 5s2.2 5 5 5 5-2.2 5-5-2.2-5-5-5zm0 8.5c-1.9 0-3.5-1.6-3.5-3.5s1.6-3.5 3.5-3.5 3.5 1.6 3.5 3.5-1.6 3.5-3.5 3.5z');

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function shadow(ctx, blur = 8, oy = 3, a = 0.45) {
  ctx.shadowColor = `rgba(0,0,0,${a})`;
  ctx.shadowBlur = blur;
  ctx.shadowOffsetY = oy;
}

function carBody(ctx, w, h, body, roof) {
  shadow(ctx);
  rr(ctx, -w / 2, -h / 2, w, h, w * 0.38);
  ctx.fillStyle = body; ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.stroke();
  // windscreen + rear window
  ctx.fillStyle = 'rgba(20,30,45,0.85)';
  rr(ctx, -w / 2 + 2, -h / 2 + h * 0.2, w - 4, h * 0.17, 2); ctx.fill();
  rr(ctx, -w / 2 + 2, h / 2 - h * 0.27, w - 4, h * 0.12, 2); ctx.fill();
  ctx.fillStyle = roof;
  rr(ctx, -w / 2 + 2.5, -h / 2 + h * 0.39, w - 5, h * 0.3, 2); ctx.fill();
  // headlights
  ctx.fillStyle = '#fff8c4';
  ctx.fillRect(-w / 2 + 1.5, -h / 2 + 0.8, 2.5, 1.6); ctx.fillRect(w / 2 - 4, -h / 2 + 0.8, 2.5, 1.6);
}

/**
 * Draw a vehicle. `heading` is the on-screen angle in radians (0 = up).
 * `lift` (0..1) is used by planes to look higher up: bigger with a farther shadow.
 */
export function drawVehicle(ctx, mode, x, y, heading, color, size = 1, lift = 0) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size, size);
  if (mode === 'walk' || mode === 'bike') {
    drawBadge(ctx, mode === 'walk' ? WALK : BIKE, color);
    ctx.restore();
    return;
  }
  if (mode === 'flight') {
    const s = 1.55 + lift * 0.7;
    // ground shadow drifts away as the plane climbs
    ctx.save();
    ctx.translate(6 + lift * 16, 8 + lift * 22);
    ctx.rotate(heading);
    ctx.scale(s, s); ctx.translate(-12, -12);
    ctx.fillStyle = `rgba(0,0,0,${0.35 - lift * 0.15})`;
    ctx.filter = `blur(${1 + lift * 2.5}px)`;
    ctx.fill(PLANE);
    ctx.restore();
    ctx.rotate(heading);
    ctx.scale(s, s); ctx.translate(-12, -12);
    shadow(ctx, 3, 1, 0.35);
    ctx.fillStyle = '#ffffff'; ctx.fill(PLANE);
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = 0.6; ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.stroke(PLANE);
    ctx.restore();
    return;
  }
  ctx.rotate(heading);
  if (mode === 'car') carBody(ctx, 14, 26, color, shade(color, -0.18));
  else if (mode === 'taxi') {
    carBody(ctx, 14, 26, '#ffc400', '#f5b800');
    ctx.fillStyle = '#222'; ctx.fillRect(-4, -1.5, 8, 3);
    ctx.fillStyle = '#fff'; ctx.fillRect(-4, -1.5, 2, 1.5); ctx.fillRect(0, -1.5, 2, 1.5); ctx.fillRect(-2, 0, 2, 1.5); ctx.fillRect(2, 0, 2, 1.5);
  } else if (mode === 'bus') {
    shadow(ctx);
    rr(ctx, -8, -20, 16, 40, 4); ctx.fillStyle = color; ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = 'rgba(20,30,45,0.85)'; rr(ctx, -6, -18, 12, 5, 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    for (let i = 0; i < 4; i++) ctx.fillRect(-5, -10 + i * 7, 10, 3);
  } else if (mode === 'train') {
    for (let i = 2; i >= 0; i--) {
      const yy = -14 + i * 18;
      shadow(ctx, 6, 2, 0.4);
      rr(ctx, -7, yy, 14, 17, i === 0 ? [7, 7, 3, 3] : 3);
      ctx.fillStyle = i === 0 ? color : '#f2f2f5'; ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = i === 0 ? 'rgba(20,30,45,0.85)' : color;
      ctx.fillRect(-5, yy + (i === 0 ? 3 : 6), 10, i === 0 ? 4 : 2);
    }
  } else if (mode === 'boat') {
    shadow(ctx);
    ctx.beginPath();
    ctx.moveTo(0, -20); ctx.quadraticCurveTo(10, -6, 9, 16); ctx.lineTo(-9, 16); ctx.quadraticCurveTo(-10, -6, 0, -20);
    ctx.fillStyle = '#ffffff'; ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = color; rr(ctx, -5, -4, 10, 14, 2); ctx.fill();
    // little wake
    ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(-8, 20); ctx.lineTo(-13, 30); ctx.moveTo(8, 20); ctx.lineTo(13, 30); ctx.stroke();
  }
  ctx.restore();
}

/** Soft ground shadow of a plane; drifts away and blurs as the plane climbs. */
export function drawPlaneShadow(ctx, x, y, heading, size, lift) {
  const s = (1.55 + lift * 0.7) * size;
  ctx.save();
  ctx.translate(x + (6 + lift * 16) * size, y + (8 + lift * 22) * size);
  ctx.rotate(heading);
  ctx.scale(s, s); ctx.translate(-12, -12);
  ctx.fillStyle = `rgba(0,0,0,${0.35 - lift * 0.15})`;
  ctx.filter = `blur(${1 + lift * 2.5}px)`;
  ctx.fill(PLANE);
  ctx.restore();
}

function drawBadge(ctx, glyph, color) {
  shadow(ctx, 10, 3, 0.45);
  ctx.beginPath(); ctx.arc(0, 0, 17, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff'; ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.beginPath(); ctx.arc(0, 0, 14, 0, Math.PI * 2);
  ctx.fillStyle = color; ctx.fill();
  ctx.save(); ctx.translate(-11, -11); ctx.scale(22 / 24, 22 / 24);
  ctx.fillStyle = '#ffffff'; ctx.fill(glyph);
  ctx.restore();
}

export function shade(hex, amt) {
  const n = parseInt(hex.replace('#', ''), 16);
  const f = c => Math.round(Math.min(255, Math.max(0, c + 255 * amt)));
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

export function flagEmoji(iso2) {
  if (!iso2 || !/^[A-Z]{2}$/.test(iso2)) return '';
  return String.fromCodePoint(...[...iso2].map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
}
