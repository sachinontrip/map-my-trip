// Sound effects, synthesised (no audio files): the whole timeline is rendered
// offline into one AudioBuffer, which the preview plays and the export muxes into the MP4.
import { formatDistance } from './engine.js';
import { span } from './geo.js';
import { boardFlapTimes } from './board.js';
import { cloudsOn } from './looks.js';

export const SR = 48000;
let noise = null;

/** Seeded brown-ish noise, 4 s stereo — the raw material for engines, wind and whooshes. */
function noiseBuffer() {
  if (noise) return noise;
  noise = new AudioBuffer({ length: SR * 4, numberOfChannels: 2, sampleRate: SR });
  let seed = 12345;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let ch = 0; ch < 2; ch++) {
    const d = noise.getChannelData(ch);
    let last = 0;
    for (let i = 0; i < d.length; i++) { last = (last + 0.04 * rnd()) / 1.04; d[i] = last * 3.2; }
  }
  return noise;
}

/** Drive an AudioParam with fn(x) for x in 0..1 across [t0, t1]. */
function curve(param, t0, t1, fn, rate = 60) {
  if (!(t1 - t0 > 0.001)) return; // Safari throws on empty curves
  const n = Math.max(2, Math.ceil((t1 - t0) * rate));
  const arr = new Float32Array(n);
  for (let i = 0; i < n; i++) arr[i] = fn(i / (n - 1));
  param.value = arr[0];
  param.setValueCurveAtTime(arr, t0, t1 - t0);
}

function noiseSrc(ctx, t0, t1, offset = 0) {
  const s = ctx.createBufferSource();
  s.buffer = noiseBuffer(); s.loop = true;
  s.start(t0, offset % 4); s.stop(t1);
  return s;
}

function chain(...nodes) { for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]); return nodes[nodes.length - 1]; }

function filter(ctx, type, freq, Q = 0.7) { const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = Q; return f; }

function blip(ctx, out, t, { freq = 1800, type = 'triangle', gain = 0.1, decay = 0.03, to = null } = {}) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + decay);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  chain(o, g, out);
  o.start(t); o.stop(t + decay + 0.02);
}

function burst(ctx, out, t, { gain = 0.3, decay = 0.06, type = 'lowpass', freq = 900, pan = 0 } = {}) {
  const g = ctx.createGain(), p = ctx.createStereoPanner();
  p.pan.value = pan;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  chain(noiseSrc(ctx, t, t + decay + 0.02, t * 7.3), filter(ctx, type, freq), g, p, out);
}

function vehicleSound(ctx, out, c) {
  const { f1: t1, m2: t2, s } = c;
  const dur = t2 - t1;
  const at = u => t1 + u * dur;
  const speed = u => { const d = 0.01; return Math.min(1, Math.abs(c.prog(Math.min(1, u + d)) - c.prog(Math.max(0, u - d))) / (2 * d) / 1.6); };
  const a = Math.max(0, c.pa - 0.1), b = Math.min(1, c.pb + 0.08);

  if (s.mode === 'flight') {
    // jet: roar at take-off, calmer cruise, a little swell on landing
    const env = u => {
      const take = span(u, c.pa - 0.08, c.pa + 0.06) * (1 - 0.6 * span(u, c.pa + 0.06, c.pa + 0.28));
      const land = 0.25 * span(u, c.pb - 0.18, c.pb - 0.04) * (1 - span(u, c.pb - 0.02, c.pb + 0.08));
      const cruise = 0.32 * span(u, c.pa, c.pa + 0.1) * (1 - span(u, c.pb - 0.08, c.pb + 0.06));
      return Math.max(take, cruise + land);
    };
    const g = ctx.createGain(), lp = filter(ctx, 'lowpass', 800, 0.9);
    curve(g.gain, at(a), at(b), x => 0.9 * env(a + x * (b - a)));
    curve(lp.frequency, at(a), at(b), x => 250 + 2600 * Math.pow(env(a + x * (b - a)), 1.4));
    chain(noiseSrc(ctx, at(a), at(b)), lp, g, out);
    // turbine whine
    const o = ctx.createOscillator(), og = ctx.createGain();
    o.type = 'sawtooth';
    curve(o.frequency, at(a), at(b), x => 900 + 1500 * env(a + x * (b - a)));
    curve(og.gain, at(a), at(b), x => 0.012 * env(a + x * (b - a)));
    chain(o, filter(ctx, 'bandpass', 2200, 2), og, out);
    o.start(at(a)); o.stop(at(b));
    return;
  }
  if (s.mode === 'walk') {
    for (let u = c.pa, k = 0; u < c.pb; u += 0.42 / dur, k++) if (speed(u) > 0.05) burst(ctx, out, at(u), { gain: 0.6, decay: 0.08, freq: 520, pan: k % 2 ? 0.25 : -0.25 });
    return;
  }
  if (s.mode === 'train') {
    for (let u = c.pa; u < c.pb; u += 0.62 / dur) if (speed(u) > 0.12) { burst(ctx, out, at(u), { gain: 0.25, decay: 0.05, type: 'highpass', freq: 1400 }); burst(ctx, out, at(u) + 0.11, { gain: 0.2, decay: 0.05, type: 'highpass', freq: 1400 }); }
  }
  if (s.mode === 'taxi') { blip(ctx, out, at(a) + 0.05, { freq: 440, type: 'square', gain: 0.05, decay: 0.12 }); blip(ctx, out, at(a) + 0.22, { freq: 440, type: 'square', gain: 0.05, decay: 0.16 }); }
  // engine hum / rumble for road vehicles, trains, boats
  const base = { car: 48, taxi: 52, bus: 38, bike: 70, train: 35, boat: 30 }[s.mode] || 45;
  const lev = u => (u < a || u > b ? 0 : 0.15 + 0.85 * speed(u)) * span(u, a, a + 0.05) * (1 - span(u, b - 0.05, b));
  const o = ctx.createOscillator(), og = ctx.createGain();
  o.type = 'sawtooth';
  curve(o.frequency, at(a), at(b), x => base * (1 + 0.9 * speed(a + x * (b - a))));
  curve(og.gain, at(a), at(b), x => (s.mode === 'boat' ? 0.03 : 0.12) * lev(a + x * (b - a)));
  chain(o, filter(ctx, 'lowpass', s.mode === 'bike' ? 900 : 420), og, out);
  o.start(at(a)); o.stop(at(b));
  const ng = ctx.createGain();
  curve(ng.gain, at(a), at(b), x => (s.mode === 'boat' ? 0.35 * (0.6 + 0.4 * Math.sin(x * dur * 2.2)) : 0.22) * lev(a + x * (b - a)));
  chain(noiseSrc(ctx, at(a), at(b), 1.3), filter(ctx, 'lowpass', s.mode === 'boat' ? 700 : 220), ng, out);
}

/** Airport chime, split-flap clatter while the tiles spin, and a soft rumble as boarding ends. */
function boardSound(ctx, out, c) {
  const t0 = c.t1;
  [[659.3, 0.15], [523.3, 0.5], [392, 0.85]].forEach(([f, d]) => {
    blip(ctx, out, t0 + d, { freq: f, type: 'sine', gain: 0.22, decay: 1.4 });
    blip(ctx, out, t0 + d, { freq: f * 2, type: 'sine', gain: 0.04, decay: 0.8 });
  });
  const { times } = boardFlapTimes(c.board, c.intro);
  let last = -1, k = 0;
  for (const x of times) {
    if (x - last < 0.012) continue; // overlapping tiles share one click
    burst(ctx, out, t0 + x, { gain: 0.16, decay: 0.022, type: 'highpass', freq: 2600 + (k % 3) * 500, pan: ((k * 37) % 11) / 11 - 0.5 });
    last = x; k++;
  }
}

function counterTicks(ctx, out, c, units) {
  const { f1: t1, m2: t2, path } = c;
  const dur = t2 - t1;
  let last = '', lastT = -1;
  for (let t = t1; t <= t2; t += 1 / 240) {
    const p = c.prog((t - t1) / dur);
    if (p <= 0 || p >= 1) continue;
    const str = formatDistance(path.total * p, units);
    if (str !== last && t - lastT >= 0.055) {
      blip(ctx, out, t, { freq: 1500 + 1100 * p, gain: 0.07, decay: 0.028 });
      lastT = t;
    }
    last = str;
  }
  const arrive = t1 + c.pb * dur;
  blip(ctx, out, arrive, { freq: 1318.5, type: 'sine', gain: 0.2, decay: 0.9 });
  blip(ctx, out, arrive + 0.09, { freq: 1975.5, type: 'sine', gain: 0.16, decay: 1.1 });
}

function whoosh(ctx, out, t0, len, gain = 0.2) {
  const g = ctx.createGain(), bp = filter(ctx, 'bandpass', 400, 1.1);
  curve(g.gain, t0, t0 + len, x => gain * Math.pow(Math.sin(Math.PI * x), 2));
  curve(bp.frequency, t0, t0 + len, x => 250 + 1700 * Math.sin(Math.PI * x));
  chain(noiseSrc(ctx, t0, t0 + len, t0), bp, g, out);
}

/** Render the whole project's sound into one stereo buffer (null if sound is off). */
export async function renderSoundtrack(timeline, settings) {
  if (!settings.sound) return null;
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil(timeline.total * SR) + SR, sampleRate: SR });
  const master = ctx.createGain();
  master.gain.value = settings.volume ?? 0.8;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14; comp.ratio.value = 4;
  chain(master, comp, ctx.destination);

  for (const c of timeline.scenes) {
    try {
      if (settings.soundFx !== false && c.tt > 0.3) whoosh(ctx, master, c.t0, c.tt, 0.18);
      if (c.s.type === 'travel') {
        if (c.intro && settings.soundFx !== false) boardSound(ctx, master, c);
        if (c.boardOnly) continue;
        if (settings.soundVehicle !== false) vehicleSound(ctx, master, c);
        if (settings.soundFx !== false && cloudsOn(c.s) && (c.s.camera || 'cinematic') === 'cinematic') {
          // airy rush while passing through the clouds on take-off and landing
          const at = u => c.f1 + u * (c.m2 - c.f1);
          whoosh(ctx, master, at(c.pa - 0.02), at(c.pa + 0.13) - at(c.pa - 0.02), 0.14);
          whoosh(ctx, master, at(c.pb - 0.15), at(c.pb) - at(c.pb - 0.15), 0.12);
        }
        if (settings.soundTicks !== false && (settings.distanceTag !== false || settings.showDistance) && c.path.total > 0.05) counterTicks(ctx, master, c, settings.units);
      } else if (c.s.type === 'highlight' && settings.soundFx !== false) {
        for (const it of c.items) blip(ctx, master, c.t1 + it.at + 0.1, { freq: 900, to: 280, type: 'sine', gain: 0.35, decay: 0.14 });
      } else if (c.s.type === 'spotlight' && settings.soundFx !== false) {
        const land = c.t1 + 0.12 * (c.m2 - c.t1);
        blip(ctx, master, land, { freq: 170, to: 55, type: 'sine', gain: 0.5, decay: 0.22 });
      }
    } catch (err) { console.warn('sound effect skipped', err); }
  }
  const buf = await ctx.startRendering();
  // trim the safety tail so audio and video are exactly the same length
  const out = new AudioBuffer({ length: Math.ceil(timeline.total * SR), numberOfChannels: 2, sampleRate: SR });
  for (let ch = 0; ch < 2; ch++) out.copyToChannel(buf.getChannelData(ch).subarray(0, out.length), ch);
  return out;
}
