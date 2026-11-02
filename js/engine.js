// The animation engine. Everything is a pure function of time `t`, so the preview
// and the exported video are identical: renderAt(t) positions the camera and map
// layers, drawOverlay() paints vehicles, pins and text on top.
import {
  Path, greatCircle, curvedLine, fitBbox, unionBbox, bboxOf, distanceKm, clamp, lerp, span, smooth,
  easeInOutCubic, easeInOutSine, easeOutBack, easeOutCubic, angleLerp, unwrap,
} from './geo.js';
import { MODES, drawVehicle, drawPlaneShadow, flagEmoji } from './icons.js';
import { renderPlane } from './plane3d.js';
import { styleDef, resolveStyle, addCustomLayers, applyEnvironment } from './styles.js';
import { loadMedia, seekVideo } from './media.js';
import { boardInfo, drawBoard, flightMinutes, formatClock } from './board.js';
import { LOOKS, lookOf, cloudsOn, blendLook, drawGrade, drawFlyThrough, drawCloudDeck, drawNavLights, rgb } from './looks.js';

export const ASPECTS = { '16:9': [960, 540], '9:16': [540, 960], '1:1': [720, 720], '4:5': [720, 900] };
export const QUALITY = { '720': 720, '1080': 1080, '1440': 1440, '2160': 2160 };
const FONT = 'Poppins, Inter, system-ui, sans-serif';

/** "850 m" → "3.4 km" → "4,429 km" (Indian digit grouping), or feet/miles. */
export function formatDistance(km, units = 'km') {
  if (units === 'mi') {
    const mi = km * 0.621371;
    if (mi < 0.1) return `${Math.round(mi * 5280).toLocaleString('en-IN')} ft`;
    return mi < 10 ? `${mi.toFixed(1)} mi` : `${Math.round(mi).toLocaleString('en-IN')} mi`;
  }
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km).toLocaleString('en-IN')} km`;
}

export function outputSize(settings) {
  const [W, H] = ASPECTS[settings.aspect] || ASPECTS['16:9'];
  const pr = QUALITY[settings.quality] / Math.min(W, H);
  return { W, H, pr, OW: Math.round(W * pr / 2) * 2, OH: Math.round(H * pr / 2) * 2 };
}

// ---------------------------------------------------------------- timeline

export function travelCoords(s) {
  const a = [s.from.lng, s.from.lat], b = [s.to.lng, s.to.lat];
  const kind = pathKind(s);
  if (kind === 'road' && s.geometry?.length > 1 && s.geomKey === routeKey(s)) return s.geometry;
  if (kind === 'arc' || kind === 'straight') return greatCircle(a, b, kind === 'arc' ? 180 : 60);
  return curvedLine(a, b, 140, kind === 'curve' ? 0.1 : 0.04);
}
export const pathKind = s => (s.path && s.path !== 'auto' ? s.path : MODES[s.mode].path);
export const routeKey = s => `${s.mode === 'walk' ? 'walk' : 'drive'}|${s.from.lng},${s.from.lat}|${s.to.lng},${s.to.lat}`;

function blendCam(a, b, w) {
  const bc = unwrap([a.center, b.center])[1];
  return {
    center: [lerp(a.center[0], bc[0], w), lerp(a.center[1], bc[1], w)],
    zoom: lerp(a.zoom, b.zoom, w),
    pitch: lerp(a.pitch, b.pitch, w),
    bearing: angleLerp(a.bearing, b.bearing, w),
  };
}

/** Camera move between scenes: zooms out enough to see both ends, then back in. */
function flyBlend(a, b, e, W) {
  const d = Math.max(distanceKm(a.center, b.center), 0.01);
  const zSpan = Math.log2(40075 * W / (900 * d));
  const dip = Math.max(0, Math.min(a.zoom, b.zoom) - zSpan);
  const cam = blendCam(a, b, dip > 0.5 ? smooth(span(e, 0.15, 0.85)) : e);
  cam.zoom = lerp(a.zoom, b.zoom, e) - dip * Math.sin(Math.PI * e);
  cam.pitch = lerp(a.pitch, b.pitch, e) - Math.min(25, dip * 6) * Math.sin(Math.PI * e);
  return cam;
}

function buildTravel(c, W, H) {
  const s = c.s;
  const mode = MODES[s.mode] ? s.mode : 'car';
  const path = new Path(travelCoords(s));
  const fit = fitBbox(path.bbox, W, H, Math.min(W, H) * 0.14, 16.5);
  const flight = mode === 'flight';
  const camMode = s.camera || 'cinematic';
  const [pa, pb] = camMode === 'overview' ? [0.06, 0.94] : flight ? [0.14, 0.86] : [0.1, 0.9];
  c.path = path;
  c.pa = pa; c.pb = pb;
  c.prog = u => easeInOutSine(span(u, pa, pb));
  c.lineKind = MODES[mode].line;
  c.color = s.color || MODES[mode].color;

  const overview = u => ({ center: fit.center, zoom: fit.zoom - 0.15 + 0.3 * easeInOutSine(u), pitch: flight ? 15 : 25, bearing: 0 });
  // smoothed heading so the camera doesn't twitch on every street corner
  const heading = p => {
    let x = 0, y = 0;
    for (let k = -2; k <= 2; k++) {
      const h = path.headingAt(clamp(p + k * 0.025, 0, 1), 0.03) * Math.PI / 180;
      x += Math.sin(h); y += Math.cos(h);
    }
    return Math.atan2(x, y) * 180 / Math.PI;
  };

  if (camMode === 'overview') c.camAt = overview;
  else if (flight) {
    const closeZ = s.closeZoom ?? 14.6;
    const cruise = clamp(fit.zoom + 0.55, 1.2, 11.5);
    c.camAt = u => {
      const p = c.prog(u);
      const out = easeInOutCubic(span(u, 0, 0.25)), back = easeInOutCubic(span(u, 0.75, 1));
      const z = camMode === 'follow' ? cruise + 0.6 : lerp(lerp(closeZ, cruise, out), closeZ, back);
      const pitch = camMode === 'follow' ? 40 : lerp(lerp(60, 32, out), 60, back);
      const brg = (s.rotate ? heading(p) * 0.6 : 0) + 18 * (u - 0.5);
      return { center: path.pointAt(p), zoom: z, pitch, bearing: brg };
    };
  } else {
    const followZ = s.closeZoom ?? clamp(fit.zoom + 2.3, 3, 16.8);
    const follow = u => {
      const p = c.prog(u);
      return { center: path.pointAt(p), zoom: followZ, pitch: 58, bearing: s.rotate === false ? 0 : heading(p) };
    };
    c.camAt = camMode === 'follow' ? follow : u => {
      const w = smooth(span(u, 0.02, 0.22)) * (1 - smooth(span(u, 0.8, 0.98)));
      return blendCam(overview(u), follow(u), w);
    };
  }
}

/** Seconds a highlight scene needs so the camera can visit each place and then show them all. */
export function highlightMinDuration(s) {
  const n = (s.countries || []).length;
  return tourMode(s) && n > 1 ? n * 1.6 + 2.2 : 1;
}
const tourMode = s => s.stagger !== false && (s.camera || 'tour') === 'tour';

function buildHighlight(c, W, H, resolve) {
  const s = c.s;
  const list = (s.countries || []).filter(x => resolve(x));
  let bb = null;
  for (const x of list) bb = unionBbox(bb, resolve(x).bbox);
  const fit = bb ? fitBbox(bb, W, H, Math.min(W, H) * 0.1, 9) : { center: [20, 20], zoom: 2 };
  const n = Math.max(1, list.length);
  const D = c.t2 - c.t1;
  const pitch = s.pitch ?? 12, drift = s.drift ?? 6;
  const allCam = v => ({ center: fit.center, zoom: fit.zoom - 0.3 + 0.55 * easeInOutSine(v), pitch, bearing: drift * (v - 0.5) });

  if (!tourMode(s) || list.length < 2) {
    const lead = 0.35, avail = Math.max(0.5, D * 0.65);
    c.items = list.map((x, k) => ({ ...x, at: lead + (n === 1 ? 0 : (k * avail) / (n - 1)) * (s.stagger === false ? 0 : 1) }));
    c.camAt = allCam;
    return;
  }

  // Tour: fly to each place as it lights up, then pull back to frame them all.
  const hold = Math.max(2, D * 0.28), tourEnd = D - hold, seg = tourEnd / n;
  const move = Math.min(seg * 0.5, 1.4);
  const focus = list.map(x => {
    const r = resolve(x), maxZ = x.kind === 'osm' ? 10 : x.kind === 'state' ? 7.5 : 6.5;
    const f = fitBbox(r.bbox, W, H, Math.min(W, H) * 0.2, maxZ);
    // tiny places: don't zoom in so far that the region is lost
    return { center: f.center, zoom: Math.max(Math.min(f.zoom, fit.zoom + 3.5), fit.zoom) };
  });
  const camOf = (k, v) => ({ center: focus[k].center, zoom: focus[k].zoom + 0.25 * v, pitch, bearing: drift * (v - 0.5) * 0.5 });
  c.items = list.map((x, k) => ({ ...x, at: k === 0 ? 0.3 : k * seg + move * 0.8 }));
  c.camAt = u => {
    const T = u * D;
    if (T < tourEnd) {
      const k = Math.min(n - 1, Math.floor(T / seg)), local = T - k * seg;
      const cam = camOf(k, local / seg);
      return k > 0 && local < move ? flyBlend(camOf(k - 1, 1), camOf(k, local / seg), easeInOutCubic(local / move), W) : cam;
    }
    const local = T - tourEnd, m2 = Math.min(hold * 0.5, 1.5), v = local / hold;
    return local < m2 ? flyBlend(camOf(n - 1, 1), allCam(v), easeInOutCubic(local / m2), W) : allCam(v);
  };
}

function buildSpotlight(c) {
  const s = c.s;
  const z = s.zoom ?? 15.8, orbit = s.orbit ?? 70;
  c.camAt = u => {
    const e = easeInOutSine(u);
    return { center: [s.place.lng, s.place.lat], zoom: z + 0.7 * e, pitch: s.pitch ?? 62, bearing: (s.bearing ?? -20) + orbit * e };
  };
}

/** `resolve(item)` → { name, iso2, lx, ly, bbox } for a highlight item (country, state or OSM area). */
export function compile(project, resolve) {
  const [W, H] = ASPECTS[project.settings.aspect] || ASPECTS['16:9'];
  const trans = project.settings.transition ?? 1.4;
  let t = 0;
  const scenes = [];
  project.scenes.forEach((s, i) => {
    const c = { s, i, t0: t, tt: i === 0 ? 0 : (s.transition ?? trans) };
    c.t1 = t + c.tt;
    // flights can open with a departure board; the trip itself starts at f1
    // "board only" is just the board for the whole scene length, with no flight after it
    const board = s.type === 'travel' && s.mode === 'flight' && s.board;
    c.boardOnly = !!(board && s.boardOnly);
    c.intro = !board ? 0 : Math.max(2.5, c.boardOnly ? +s.duration || 6 : +s.boardLength || 4);
    c.f1 = c.t1 + c.intro;
    c.t2 = c.f1 + (c.boardOnly ? 0 : Math.max(1, +s.duration || 6, s.type === 'highlight' ? highlightMinDuration(s) : 1));
    c.m2 = c.t2; // the movement ends here; a hold after it keeps the last frame (and the photo) on screen
    try {
      if (s.type === 'travel') buildTravel(c, W, H);
      else if (s.type === 'highlight') buildHighlight(c, W, H, resolve);
      else buildSpotlight(c);
    } catch (err) {
      console.warn('scene build failed', err);
      c.camAt = () => ({ center: [0, 20], zoom: 1.5, pitch: 0, bearing: 0 });
    }
    if (c.intro) {
      // hold on the departure city with a slow drift while the board plays
      const cam0 = c.camAt(0);
      c.board = boardInfo(s);
      c.introCam = k => ({ ...cam0, zoom: cam0.zoom - 0.35 * (1 - k), bearing: cam0.bearing - 14 * (1 - k) });
    }
    c.startCam = c.intro ? c.introCam(0) : c.camAt(0);
    // a scene with a photo / clip pauses on arrival so people can see it
    c.hold = s.media?.id && s.type !== 'highlight' ? Math.max(0, s.mediaHold ?? 1.5) : 0;
    c.t2 = c.m2 + c.hold;
    t = c.t2;
    c.endCam = c.boardOnly ? c.introCam(1) : c.camAt(1);
    // day / date carry over from earlier scenes until a scene sets a new one
    const before = scenes[scenes.length - 1]?.day || {};
    c.day = { day: s.day || before.day, date: s.date || before.date };
    scenes.push(c);
  });
  // end of the video: hold the last frame a moment so it doesn't stop dead
  const last = scenes[scenes.length - 1];
  if (last && last.hold < 1) { const add = 1 - last.hold; last.hold = 1; last.t2 += add; t += add; }
  return { scenes, total: Math.max(t, 0.1), W, H };
}

/** Feature-state address of a highlight item: "source|id". */
const itemKey = it => (it.kind ? `areas|${it.key}` : `countries|${it.iso}`);

function geomBbox(g) {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  let b = null;
  for (const poly of polys) b = unionBbox(b, bboxOf(poly[0]));
  return b;
}

// ---------------------------------------------------------------- engine

export class Engine {
  constructor({ frameEl, mapEl, overlayEl, starsEl, countries, index, states }) {
    Object.assign(this, { frameEl, mapEl, overlayEl, starsEl, countries, index, states });
    this.stateIndex = {};
    for (const f of states.features) {
      const p = f.properties;
      this.stateIndex[p.id] = { name: p.name, iso2: 'IN', lx: p.lx, ly: p.ly, bbox: geomBbox(f.geometry), feature: f };
    }
    this.osmCache = new Map();
    this.resolve = item => {
      if (item.kind === 'state') return this.stateIndex[item.key];
      if (item.kind === 'osm') {
        if (!this.osmCache.has(item.key)) this.osmCache.set(item.key, { name: item.name, iso2: item.cc, lx: item.lx, ly: item.ly, bbox: geomBbox(item.geometry) });
        return this.osmCache.get(item.key);
      }
      return this.index[item.iso];
    };
    this.t = 0;
    this.state = null;
    this.ready = false;
    this.touched = new Set(); // countries with feature-state set
    this.lastDim = -1;
    this.listeners = {};
  }

  on(ev, fn) { (this.listeners[ev] ||= []).push(fn); }
  emit(ev, ...a) { (this.listeners[ev] || []).forEach(f => f(...a)); }

  /** Put every state / OSM area used by the project on the map (all Indian states once any is used, for borders). */
  setAreas() {
    const src = this.ready && this.map.getSource('areas');
    if (!src) return;
    const items = this.project.scenes.flatMap(s => (s.type === 'highlight' ? s.countries || [] : []));
    const feats = [];
    if (items.some(x => x.kind === 'state')) {
      for (const [id, st] of Object.entries(this.stateIndex)) feats.push({ type: 'Feature', properties: { key: id, kind: 'state' }, geometry: st.feature.geometry });
    }
    const seen = new Set();
    for (const x of items) if (x.kind === 'osm' && !seen.has(x.key)) { seen.add(x.key); feats.push({ type: 'Feature', properties: { key: x.key, kind: 'osm' }, geometry: x.geometry }); }
    const sig = feats.map(f => f.properties.key).join(',');
    if (sig === this.areaSig) return;
    this.areaSig = sig;
    this.touched = new Set([...this.touched].filter(k => !k.startsWith('areas|')));
    src.setData({ type: 'FeatureCollection', features: feats });
  }

  preloadMedia() {
    this.mediaEls ||= new Map();
    for (const sc of this.project.scenes) {
      if (!sc.media?.id || this.mediaEls.has(sc.media.id)) continue;
      loadMedia(sc.media).then(m => { this.mediaEls.set(sc.media.id, m); if (this.ready) this.renderAt(this.t); });
    }
  }

  /** When a scene's photo/clip pops up (seconds on the timeline). */
  mediaStart(c) {
    return c.s.type === 'travel' ? c.f1 + (c.pb + 0.02) * (c.m2 - c.f1) : c.t1 + 0.22 * (c.m2 - c.t1);
  }

  /** Keep clips in step with the timeline. `exact` seeks and waits (export). */
  async syncMedia(t, exact = false) {
    const jobs = [];
    for (const c of this.timeline.scenes) {
      const m = c.s.media && this.mediaEls?.get(c.s.media.id);
      if (m?.kind !== 'video') continue;
      const v = m.el, active = t >= this.mediaStart(c) && t <= c.t2 + 2;
      const clipT = Math.max(0, t - this.mediaStart(c));
      if (exact) { if (active) jobs.push(seekVideo(v, clipT)); continue; }
      if (active && this.playing) {
        if (v.paused) v.play().catch(() => {});
        if (Math.abs(v.currentTime - clipT % (v.duration || 1)) > 0.3) v.currentTime = clipT % (v.duration || 1);
      } else {
        if (!v.paused) v.pause();
        if (active && Math.abs(v.currentTime - clipT % (v.duration || 1)) > 0.05) v.currentTime = clipT % (v.duration || 1);
      }
    }
    await Promise.all(jobs);
  }

  drawMedia(ctx, c, anchor, t, alpha) {
    const m = c.s.media && this.mediaEls?.get(c.s.media.id);
    if (!m || !m.w) return;
    const k = span(t, this.mediaStart(c), this.mediaStart(c) + 0.55);
    if (k > 0) mediaPopup(ctx, m, anchor, k, alpha, this.W, this.H);
  }

  async init(project) {
    this.project = project;
    this.timeline = compile(project, this.resolve);
    this.preloadMedia();
    this.sizeFrame();
    this.previewPR = Math.min(2, window.devicePixelRatio || 1);
    const def = styleDef(project.settings.style);
    this.map = new maplibregl.Map({
      container: this.mapEl,
      style: await resolveStyle(def),
      center: [77, 28], zoom: 2,
      interactive: false,
      attributionControl: false,
      fadeDuration: 0,
      pixelRatio: this.previewPR,
      maxTileCacheSize: 600,
      canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true },
    });
    this.map.on('style.load', () => this.onStyleLoad());
    this.map.on('render', () => this.drawOverlay());
    this.map.on('error', e => console.warn('map error', e?.error?.message || e));
    await new Promise(r => { if (this.ready) r(); else this.on('styleloaded', r); });
  }

  onStyleLoad() {
    const def = styleDef(this.project.settings.style);
    this.def = def;
    addCustomLayers(this.map, this.countries, this.project.settings, def);
    this.touched.clear();
    this.lastDim = -1;
    this.lastB = -1;
    this.lastSL = -1;
    this.lastLook = null; this.customSky = false;
    this.areaSig = null;
    this.setAreas();
    this.ready = true;
    this.frameEl.classList.toggle('light', !def.dark);
    this.renderAt(this.t);
    this.emit('styleloaded');
  }

  async setStyle(id) {
    this.project.settings.style = id;
    this.ready = false;
    const def = styleDef(id);
    this.map.setStyle(await resolveStyle(def), { diff: false });
  }

  /** Push a time-of-day look onto the map: satellite colour, night lights, sky, building colour. */
  applyLook(L) {
    const m = this.map;
    const transparent = !!this.hiddenLayers?.length;
    const key = JSON.stringify([transparent, L.bright, L.sat, L.contrast, L.hue, L.lights, L.dark, L.sky].map(v => (typeof v === 'number' ? +v.toFixed(3) : v && JSON.stringify(v))));
    if (key === this.lastLook) return;
    this.lastLook = key;
    if (m.getLayer('sat') && !this.def?.id?.endsWith('night')) {
      m.setPaintProperty('sat', 'raster-brightness-max', L.bright);
      m.setPaintProperty('sat', 'raster-saturation', L.sat);
      m.setPaintProperty('sat', 'raster-contrast', L.contrast);
      m.setPaintProperty('sat', 'raster-hue-rotate', L.hue);
    }
    if (m.getLayer('night-lights')) {
      const on = L.lights > 0.01 && !this.hiddenLayers?.length;
      m.setLayoutProperty('night-lights', 'visibility', on ? 'visible' : 'none');
      // full lights from high up, fading out as the camera nears the ground (the tiles stop at zoom 8)
      if (on) m.setPaintProperty('night-lights', 'raster-opacity', ['interpolate', ['linear'], ['zoom'], 7.5, 0.95 * L.lights, 10.5, 0]);
      // closer in, the lit streets take over
      for (const [id, max] of [['night-roads-glow', 0.7], ['night-roads', 1]]) {
        if (!m.getLayer(id)) continue;
        m.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
        if (on) m.setPaintProperty(id, 'line-opacity', ['interpolate', ['linear'], ['zoom'], 8.5, 0, 10.5, max * L.lights]);
      }
    }
    if (m.getLayer('my-buildings')) m.setPaintProperty('my-buildings', 'fill-extrusion-color', L.dark > 0.01 ? rgb([lerp(this.def?.dark ? 207 : 230, 70, L.dark), lerp(this.def?.dark ? 200 : 225, 66, L.dark), lerp(this.def?.dark ? 189 : 216, 72, L.dark)]) : (this.def?.dark ? '#cfc8bd' : '#e6e1d8'));
    if (transparent) return; // the sky stays see-through for green-screen / PNG export
    if (L.sky) {
      m.setSky({
        'sky-color': rgb(L.sky.sky), 'horizon-color': rgb(L.sky.horizon), 'fog-color': rgb(L.sky.fog),
        'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.85,
        'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 8, 0],
      });
      this.customSky = true;
    } else if (this.customSky) {
      this.customSky = false;
      applyEnvironment(m, this.project.settings, this.def);
    }
  }

  /** Hide the base map (keep routes, highlights, overlay) for transparent / green-screen export. */
  setTransparent(on) {
    const ours = /^(cty-fill|cty-glow|cty-line|area-|rt-)/;
    if (on) {
      this.hiddenLayers = [];
      for (const l of this.map.getStyle().layers) {
        if (ours.test(l.id) || this.map.getLayoutProperty(l.id, 'visibility') === 'none') continue;
        this.map.setLayoutProperty(l.id, 'visibility', 'none');
        this.hiddenLayers.push(l.id);
      }
      this.map.setSky({ 'sky-color': 'rgba(0,0,0,0)', 'horizon-color': 'rgba(0,0,0,0)', 'fog-color': 'rgba(0,0,0,0)', 'atmosphere-blend': 0 });
    } else {
      for (const id of this.hiddenLayers || []) if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', 'visible');
      this.hiddenLayers = [];
      applyEnvironment(this.map, this.project.settings, this.def);
    }
    this.lastLook = null; this.customSky = false;
  }

  updateEnvironment() {
    if (!this.ready) return;
    applyEnvironment(this.map, this.project.settings, this.def);
    this.lastLook = null; this.customSky = false;
    this.renderAt(this.t);
  }

  setProject(project) {
    this.project = project;
    this.timeline = compile(project, this.resolve);
    this.sizeFrame();
    this.preloadMedia();
    this.setAreas();
    this.emit('timeline');
    if (this.ready) this.renderAt(Math.min(this.t, this.timeline.total));
  }

  /** Lay the map out at design size, then CSS-scale it to fit the stage. */
  sizeFrame(pr) {
    const [W, H] = ASPECTS[this.project.settings.aspect] || ASPECTS['16:9'];
    const changed = this.W !== W || this.H !== H;
    this.W = W; this.H = H;
    Object.assign(this.frameEl.style, { width: W + 'px', height: H + 'px' });
    const stage = this.frameEl.parentElement.getBoundingClientRect();
    const k = Math.min((stage.width - 40) / W, (stage.height - 40) / H);
    this.frameEl.style.transform = `translate(-50%,-50%) scale(${Math.max(0.1, k)})`;
    const ratio = pr || this.map?.getPixelRatio() || this.previewPR || 1;
    for (const c of [this.overlayEl, this.starsEl]) {
      c.width = Math.round(W * ratio); c.height = Math.round(H * ratio);
      c.style.width = W + 'px'; c.style.height = H + 'px';
    }
    this.drawStars();
    if (changed && this.map) this.map.resize();
  }

  setPixelRatio(pr) {
    this.map.setPixelRatio(pr);
    this.sizeFrame(pr);
    this.map.resize();
  }

  drawStars() {
    const c = this.starsEl, ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(c.width / 2, c.height / 2, 0, c.width / 2, c.height / 2, Math.max(c.width, c.height) * 0.7);
    g.addColorStop(0, '#0d1630'); g.addColorStop(1, '#03050c');
    ctx.fillStyle = g; ctx.fillRect(0, 0, c.width, c.height);
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const k = c.width / this.W;
    for (let i = 0; i < 420; i++) {
      ctx.globalAlpha = 0.25 + rnd() * 0.7;
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(rnd() * c.width, rnd() * c.height, (0.3 + rnd() * 0.9) * k, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  sceneAt(t) {
    const sc = this.timeline.scenes;
    for (const c of sc) if (t < c.t2) return c;
    return sc[sc.length - 1];
  }

  /** Position the camera and all map layers for time t. */
  renderAt(t) {
    this.t = clamp(t, 0, this.timeline.total);
    if (!this.ready || !this.timeline.scenes.length) return;
    t = this.t;
    const tl = this.timeline, settings = this.project.settings;
    const c = this.sceneAt(t);
    const prev = tl.scenes[c.i - 1];
    const inTrans = t < c.t1 && c.tt > 0;
    const e = inTrans ? easeInOutCubic((t - c.t0) / c.tt) : 1;
    const u = inTrans || c.boardOnly ? 0 : span(t, c.f1, c.m2);
    const inIntro = !inTrans && (t < c.f1 || c.boardOnly);
    const cam = inTrans && prev ? flyBlend(prev.endCam, c.startCam, e, tl.W) : inIntro ? c.introCam(span(t, c.t1, c.f1)) : c.camAt(u);
    cam.zoom = clamp(cam.zoom, 0.3, 19);
    cam.pitch = clamp(cam.pitch, 0, 76);
    this.map.jumpTo(cam);
    this.state = { t, c, prev, u, e, inTrans };

    // routes
    const feats = [];
    for (const r of tl.scenes) {
      if (r.s.type !== 'travel' || r.boardOnly || r.i > c.i) continue;
      let op = 1, coords;
      if (r.i === c.i) coords = r.path.slice(r.prog(u));
      else {
        coords = r.path.coords;
        if (!settings.keepRoutes) op = r.i === c.i - 1 && inTrans ? 1 - e : 0;
        else op = 0.85;
      }
      if (op > 0.01 && coords.length > 1) feats.push({ type: 'Feature', properties: { color: r.color, kind: r.lineKind, op }, geometry: { type: 'LineString', coordinates: coords } });
    }
    this.map.getSource('routes')?.setData({ type: 'FeatureCollection', features: feats });

    // country highlights
    const want = new Map();
    let stateLines = 0;
    let dim = 0;
    for (const h of tl.scenes) {
      if (h.s.type !== 'highlight' || h.i > c.i) continue;
      const local = t - h.t1;
      for (const it of h.items) {
        let a;
        if (h.i === c.i) a = inTrans ? 0 : easeOutCubic(span(local, it.at, it.at + 0.6));
        else if (h.s.keep) a = 1;
        else if (h.i === c.i - 1 && inTrans) a = 1 - e;
        else a = 0;
        const k = itemKey(it);
        if (a > 0) want.set(k, { a: Math.max(a, want.get(k)?.a || 0), color: it.color });
      }
      if (h.i === c.i && h.s.countries?.some(x => x.kind === 'state')) stateLines = inTrans ? 0 : 0.5 * smooth(span(t - h.t1, 0, 0.6));
      const d = (h.s.dim ?? 0.45);
      if (h.i === c.i) dim = Math.max(dim, inTrans ? 0 : d * smooth(span(t - h.t1, 0, 0.8)));
      else if (h.i === c.i - 1 && inTrans) dim = Math.max(dim, d * (1 - e));
      else if (h.s.keep) dim = Math.max(dim, d);
    }
    // per-scene 3D buildings (e.g. off at the pyramids, which OSM stores as one giant box)
    const bOn = sc => (sc && settings.buildings && sc.s.buildings !== false ? 1 : 0);
    const bFade = inTrans && prev ? lerp(bOn(prev), bOn(c), e) : bOn(c);
    if (Math.abs(bFade - (this.lastB ?? -1)) > 0.01 && this.map.getLayer('my-buildings')) {
      this.map.setPaintProperty('my-buildings', 'fill-extrusion-opacity', ['interpolate', ['linear'], ['zoom'], 13, 0, 14.2, 0.92 * bFade]);
      this.lastB = bFade;
    }

    // time of day (blends between scenes during the transition)
    const L = inTrans && prev ? blendLook(LOOKS[lookOf(prev.s)], LOOKS[lookOf(c.s)], e) : LOOKS[lookOf(c.s)];
    this.look = L;
    this.applyLook(L);

    const fs = k => { const [source, id] = k.split('|'); return { source, id }; };
    for (const k of this.touched) if (!want.has(k)) this.map.setFeatureState(fs(k), { a: 0 });
    for (const [k, st] of want) this.map.setFeatureState(fs(k), st);
    this.touched = new Set(want.keys());
    if (Math.abs(stateLines - (this.lastSL ?? -1)) > 0.01 && this.map.getLayer('area-borders')) {
      this.map.setPaintProperty('area-borders', 'line-opacity', stateLines);
      this.lastSL = stateLines;
    }
    if (Math.abs(dim - this.lastDim) > 0.002) {
      this.map.setPaintProperty('cty-dim', 'fill-opacity', ['*', dim, ['-', 1, ['coalesce', ['feature-state', 'a'], 0]]]);
      this.lastDim = dim;
    }
    this.emit('time', t);
  }

  /** Wait until every tile for the current frame has loaded (used by export). */
  settle(timeout = 12000) {
    return new Promise(res => {
      let done = false;
      const fin = () => { if (!done) { done = true; res(); } };
      this.map.once('idle', fin);
      setTimeout(fin, timeout);
      this.map.triggerRepaint();
    });
  }

  // ------------------------------------------------------------ overlay

  drawOverlay(target) {
    const cv = target || this.overlayEl;
    const ctx = cv.getContext('2d');
    const pr = cv.width / this.W;
    if (!target) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height); }
    if (!this.state) return;
    ctx.setTransform(pr, 0, 0, pr, 0, 0);
    const { t, c, prev, u, e, inTrans } = this.state;
    const tl = this.timeline, settings = this.project.settings;
    const proj = ll => { const p = this.map.project(ll); return [p.x, p.y]; };
    const onScreen = ([x, y], m = 60) => x > -m && y > -m && x < this.W + m && y < this.H + m;

    // time-of-day colour grade sits right on the map, under everything we draw
    if (this.look && !this.hiddenLayers?.length) drawGrade(ctx, this.W, this.H, this.look);
    // clouds: a thin deck under the plane while cruising, and a bank to fly through on take-off / landing
    const cloudy = c.s.type === 'travel' && !c.boardOnly && !inTrans && cloudsOn(c.s);
    const cloudLook = lookOf(c.s);
    if (cloudy) {
      const deck = span(u, c.pa + 0.06, c.pa + 0.16) * (1 - span(u, c.pb - 0.18, c.pb - 0.08));
      if (deck > 0.01) {
        const p = c.prog(u);
        const a = proj(c.path.pointAt(clamp(p - 0.01, 0, 1))), b = proj(c.path.pointAt(clamp(p + 0.01, 0, 1)));
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        drawCloudDeck(ctx, this.W, this.H, t - c.f1, [(b[0] - a[0]) / len, (b[1] - a[1]) / len], deck, cloudLook, c.s.id);
      }
    }

    // endpoint dots for earlier kept routes
    if (settings.keepRoutes) {
      for (const r of tl.scenes) {
        if (r.s.type !== 'travel' || r.boardOnly || r.i >= c.i) continue;
        for (const pt of [r.path.coords[0], r.path.coords[r.path.coords.length - 1]]) {
          const q = proj(pt); if (onScreen(q)) dot(ctx, q, r.color, 0.9, t, false);
        }
      }
    }

    // leaving vehicle from the previous scene fades out during the transition
    if (inTrans && prev?.s.type === 'travel' && !prev.boardOnly) this.drawTravel(ctx, prev, 1, 1 - e, proj, onScreen, t, false);
    if (c.s.type === 'travel' && !c.boardOnly) this.drawTravel(ctx, c, u, inTrans ? e : 1, proj, onScreen, t, true);
    if (cloudy && (c.s.camera || 'cinematic') === 'cinematic') {
      const up = span(u, c.pa - 0.02, c.pa + 0.13), down = span(u, c.pb - 0.15, c.pb);
      if (up > 0 && up < 1) drawFlyThrough(ctx, this.W, this.H, up, cloudLook, c.s.id + 'up');
      if (down > 0 && down < 1) drawFlyThrough(ctx, this.W, this.H, down, cloudLook, c.s.id + 'dn');
    }
    if (c.s.type === 'highlight' && !inTrans) {
      // small countries sit close together: push overlapping labels apart and draw a leader line
      const placed = [];
      ctx.font = `600 15px ${FONT}`;
      for (const it of c.items) {
        const k = span(t - c.t1, it.at + 0.1, it.at + 0.7);
        if (k <= 0) continue;
        const info = this.resolve(it);
        const q = proj([info.lx, info.ly]);
        if (!onScreen(q, 0)) continue;
        if (it.point) {
          // city known only as a point: glowing pulsing marker instead of an outline
          ctx.save();
          ctx.globalAlpha = Math.min(1, k * 2);
          const ph = (t * 0.8) % 1;
          ctx.beginPath(); ctx.arc(q[0], q[1], 10 + ph * 26, 0, Math.PI * 2);
          ctx.fillStyle = it.color; ctx.globalAlpha *= (1 - ph) * 0.45; ctx.fill();
          ctx.globalAlpha = Math.min(1, k * 2);
          ctx.shadowColor = it.color; ctx.shadowBlur = 18;
          ctx.beginPath(); ctx.arc(q[0], q[1], 10 * easeOutBack(k), 0, Math.PI * 2); ctx.fillStyle = it.color; ctx.fill();
          ctx.shadowColor = 'transparent'; ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.stroke();
          ctx.restore();
          q[1] -= 26;
        }
        const text = it.label || info.name;
        const w = ctx.measureText(text).width + 64, hh = 33;
        let y = q[1];
        const top = c.s.caption ? 90 : 24;
        for (const off of [0, 1, 2, -1, 3, -2, 4]) {
          const yy = q[1] + off * (hh + 4);
          if (yy < top || yy > this.H - 24) continue;
          if (!placed.some(b => Math.abs(b.x - q[0]) < (b.w + w) / 2 && Math.abs(b.y - yy) < hh + 2)) { y = yy; break; }
        }
        placed.push({ x: q[0], y, w });
        if (y !== q[1]) {
          ctx.save();
          ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.5; ctx.globalAlpha = Math.min(1, k * 2);
          ctx.beginPath(); ctx.moveTo(q[0], q[1]); ctx.lineTo(q[0], y + (y > q[1] ? -hh / 2 : hh / 2)); ctx.stroke();
          ctx.beginPath(); ctx.arc(q[0], q[1], 3, 0, Math.PI * 2); ctx.fillStyle = it.color; ctx.fill();
          ctx.restore();
        }
        label(ctx, [q[0], y], text, { flag: flagEmoji(info.iso2), color: it.color, alpha: Math.min(1, k * 2), scale: easeOutBack(k), pointer: false, size: 15 });
      }
    }
    if (c.s.type === 'spotlight') {
      const a = inTrans ? e : 1;
      const q = proj([c.s.place.lng, c.s.place.lat]);
      const drop = inTrans ? 0 : easeOutBack(span(u, 0.02, 0.18));
      if (drop > 0) pin(ctx, q, c.s.color || '#ff3b5c', drop, a);
      this.drawMedia(ctx, c, [q[0], q[1] - 40], t, 1 - span(t, c.t2 - 0.35, c.t2));
      if (c.s.title) titleCard(ctx, this.W, this.H, c.s.title, c.s.subtitle, inTrans ? 0 : span(u, 0.08, 0.22) * (1 - span(u, 0.92, 1)));
    }

    if (c.intro && !inTrans && t < c.f1) drawBoard(ctx, this.W, this.H, c.board, t - c.t1, c.intro);

    // day / date badge, flips when it changes between scenes
    const hasDay = d => d && (d.day || d.date);
    const badge = settings.dayBadge !== false && (hasDay(c.day) || hasDay(prev?.day));
    if (badge) {
      const same = prev && prev.day.day === c.day.day && prev.day.date === c.day.date;
      if (inTrans && prev && !same) {
        if (hasDay(prev.day)) dayBadge(ctx, prev.day, 1 - e, -e);
        if (hasDay(c.day)) dayBadge(ctx, c.day, e, 1 - e);
      } else if (hasDay(c.day)) dayBadge(ctx, c.day, c.i === 0 ? span(t, 0, 0.5) : 1, 0);
    }

    // caption
    if (c.s.caption) {
      const a = span(t, c.t1 - 0.2, c.t1 + 0.4) * (1 - span(t, c.t2 - 0.45, c.t2));
      if (a > 0) caption(ctx, this.W, c.s.caption, a, badge && this.H > this.W ? 84 : 22);
    }
    if (settings.watermark) {
      ctx.save();
      ctx.font = `600 13px ${FONT}`; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
      ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 6; ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fillText(settings.watermark, this.W - 16, this.H - (this.H > this.W ? this.H * 0.2 : 22));
      ctx.restore();
    }
    ctx.save();
    ctx.font = `500 7.5px ${FONT}`; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 3;
    const credit = this.def?.id?.startsWith('satellite') ? '© Esri · © OpenStreetMap contributors' : '© OpenStreetMap contributors · OpenFreeMap · CARTO';
    ctx.fillText(credit + (this.look?.lights > 0.01 ? ' · Night lights: NASA' : ''), this.W - 8, this.H - 5);
    ctx.restore();
  }

  drawTravel(ctx, c, u, alpha, proj, onScreen, t, current) {
    const p = c.prog(u);
    const path = c.path, s = c.s;
    const a0 = proj(path.coords[0]), a1 = proj(path.coords[path.coords.length - 1]);
    ctx.save();
    ctx.globalAlpha = alpha;
    if (onScreen(a0)) dot(ctx, a0, c.color, 1, t, true);
    if (p > 0.82 && onScreen(a1)) dot(ctx, a1, c.color, 1, t, true);
    if (current && s.labels !== false) {
      const fromA = 1 - span(u, 0.3, 0.4);
      if (fromA > 0 && onScreen(a0)) label(ctx, a0, s.from.name, { flag: flagEmoji(s.from.cc), alpha: fromA, offsetY: -16 });
      const k = span(p, 0.93, 1);
      if (k > 0 && onScreen(a1)) label(ctx, a1, s.to.name, { flag: flagEmoji(s.to.cc), alpha: Math.min(1, k * 2), scale: easeOutBack(k), offsetY: -16 });
    }
    // vehicle
    const pos = proj(path.pointAt(p));
    const w = 0.012;
    const h0 = proj(path.pointAt(clamp(p - w, 0, 1))), h1 = proj(path.pointAt(clamp(p + w, 0, 1)));
    let heading = Math.atan2(h1[0] - h0[0], -(h1[1] - h0[1]));
    if (!isFinite(heading) || (Math.abs(h1[0] - h0[0]) + Math.abs(h1[1] - h0[1]) < 0.01)) heading = c._lastHeading ?? 0;
    c._lastHeading = heading;
    const lift = s.mode === 'flight' ? Math.pow(Math.sin(Math.PI * p), 0.7) : 0;
    const size = (s.iconSize || 1) * (s.mode === 'flight' ? 1 : 1.35);
    if (onScreen(pos) && s.mode === 'flight' && this.project.settings.plane3d !== false) {
      // real 3D airliner: banks into turns, noses up on climb-out and down on approach
      const a1h = Math.atan2(pos[0] - h0[0], -(pos[1] - h0[1])), a2h = Math.atan2(h1[0] - pos[0], -(h1[1] - pos[1]));
      const turn = ((a2h - a1h + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
      const bank = isFinite(turn) ? clamp(turn * 5, -0.5, 0.5) : 0;
      const climb = 0.3 * Math.cos(Math.PI * p) * Math.min(1, Math.sin(Math.PI * p) * 5);
      drawPlaneShadow(ctx, pos[0], pos[1], heading, size, lift);
      const img = renderPlane({ heading, mapPitch: this.map.getPitch(), bank, climb, color: s.tailColor || '#ff3b5c' });
      const px = 64 * (1 + lift * 0.5) * size;
      ctx.drawImage(img, pos[0] - px / 2, pos[1] - px / 2, px, px);
    } else if (onScreen(pos)) drawVehicle(ctx, s.mode, pos[0], pos[1], heading, c.color, size, lift);
    if (s.mode === 'flight' && onScreen(pos) && lookOf(s) === 'night') drawNavLights(ctx, pos[0], pos[1], size * (1 + lift * 0.5), t, alpha);

    // yellow tag riding above the vehicle, counting up the distance travelled
    if (this.project.settings.distanceTag !== false && path.total > 0.05 && onScreen(pos)) {
      const units = this.project.settings.units;
      const show = span(u, c.pa - 0.06, c.pa);
      const arrive = span(u, c.pb, c.pb + 0.08);
      const dy = s.mode === 'flight' ? (30 + lift * 18) * size : 30 * size;
      // flights also count up the flight time beside the distance (typed in, or estimated)
      const mins = s.mode === 'flight' && s.showTime !== false ? flightMinutes(s) : null;
      const time = k => (mins ? `  ·  ⏱ ${formatClock(mins * k)}` : '');
      if (show > 0) distanceTag(ctx, [pos[0], pos[1] - dy], formatDistance(path.total * p, units) + time(p), formatDistance(path.total, units) + time(1), 1 + 0.28 * Math.sin(Math.PI * arrive), show);
    }
    ctx.restore();
    this.drawMedia(ctx, c, a1, t, alpha);

    if (current && this.project.settings.showDistance && path.total > 0.2) {
      const mins = s.mode === 'flight' && s.showTime !== false ? flightMinutes(s) : null;
      distanceCard(ctx, this.W, this.H, MODES[s.mode].emoji, path.total * p, `${s.from.name} → ${s.to.name}`, alpha, this.project.settings.units, mins ? formatClock(mins * p) : '');
    }
  }
}

// ---------------------------------------------------------------- drawing helpers

function dot(ctx, [x, y], color, a, t, pulse) {
  ctx.save();
  ctx.globalAlpha *= a;
  if (pulse) {
    const ph = (t * 0.9) % 1;
    ctx.beginPath(); ctx.arc(x, y, 6 + ph * 16, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.globalAlpha *= (1 - ph) * 0.5; ctx.fill();
    ctx.globalAlpha /= ((1 - ph) * 0.5) || 1;
  }
  ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 6;
  ctx.beginPath(); ctx.arc(x, y, 6.5, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
  ctx.restore();
}

function label(ctx, [x, y], text, { flag = '', color = null, alpha = 1, scale = 1, offsetY = -14, size = 14, pointer = true } = {}) {
  if (!text || alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha *= clamp(alpha, 0, 1);
  ctx.translate(x, y + (pointer ? offsetY : 0));
  ctx.scale(scale, scale);
  ctx.font = `600 ${size}px ${FONT}`;
  const str = flag ? `${flag}  ${text}` : text;
  const tw = ctx.measureText(str).width;
  const padX = 12, h = size + 14, dotW = color ? 16 : 0;
  const w = tw + padX * 2 + dotW;
  const by = pointer ? -h - 6 : -h / 2;
  ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 14; ctx.shadowOffsetY = 4;
  ctx.fillStyle = 'rgba(255,255,255,0.97)';
  ctx.beginPath(); ctx.roundRect(-w / 2, by, w, h, h / 2); ctx.fill();
  if (pointer) { ctx.beginPath(); ctx.moveTo(-6, by + h - 1); ctx.lineTo(0, by + h + 6); ctx.lineTo(6, by + h - 1); ctx.fill(); }
  ctx.shadowColor = 'transparent';
  if (color) { ctx.beginPath(); ctx.arc(-w / 2 + padX + 5, by + h / 2, 5.5, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill(); }
  ctx.fillStyle = '#12141a'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  ctx.fillText(str, -w / 2 + padX + dotW, by + h / 2 + 1);
  ctx.restore();
}

function pin(ctx, [x, y], color, k, a) {
  ctx.save();
  ctx.globalAlpha *= a;
  ctx.translate(x, y - (1 - Math.min(1, k)) * 40);
  ctx.beginPath(); ctx.ellipse(0, (1 - Math.min(1, k)) * 40, 9 * k, 3.5 * k, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fill();
  ctx.scale(k, k);
  ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 10; ctx.shadowOffsetY = 4;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(-4, -10, -16, -18, -16, -32);
  ctx.arc(0, -32, 16, Math.PI, 0);
  ctx.bezierCurveTo(16, -18, 4, -10, 0, 0);
  ctx.fillStyle = color; ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.beginPath(); ctx.arc(0, -32, 6.5, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
  ctx.restore();
}

/** Photo/clip card that pops out of a pin, polaroid style. */
function mediaPopup(ctx, m, [ax, ay], k, alpha, W, H) {
  const portrait = H > W;
  const maxW = portrait ? W * 0.72 : W * 0.34, maxH = portrait ? H * 0.34 : H * 0.5;
  const r = m.w / m.h;
  let w = maxW, h = w / r;
  if (h > maxH) { h = maxH; w = h * r; }
  const pad = 7, m16 = 18;
  const cx = clamp(ax, w / 2 + pad + m16, W - w / 2 - pad - m16);
  const cy = clamp(ay - 36 - h / 2 - pad, h / 2 + pad + m16, H - h / 2 - pad - m16);
  const e = easeOutCubic(k);
  ctx.save();
  ctx.globalAlpha *= clamp(alpha, 0, 1) * Math.min(1, k * 3);
  ctx.translate(lerp(ax, cx, e), lerp(ay, cy, e));
  ctx.rotate(-0.035 - (1 - k) * 0.18);
  const s = 0.15 + 0.85 * easeOutBack(k);
  ctx.scale(s, s);
  ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 24; ctx.shadowOffsetY = 8;
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.roundRect(-w / 2 - pad, -h / 2 - pad, w + pad * 2, h + pad * 2, 14); ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.beginPath(); ctx.roundRect(-w / 2, -h / 2, w, h, 9); ctx.clip();
  ctx.drawImage(m.el, -w / 2, -h / 2, w, h);
  ctx.restore();
}

function formatDate(iso) {
  const d = new Date(`${iso}T00:00:00`);
  return isNaN(d) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Top-left "DAY 3 / 12 Nov 2026" card. `slide` moves it vertically (−1 up … 1 down) for the flip. */
function dayBadge(ctx, { day, date }, a, slide) {
  if (a <= 0) return;
  ctx.save();
  ctx.globalAlpha = clamp(a, 0, 1);
  ctx.beginPath(); ctx.rect(0, 0, 400, 90); ctx.clip();
  ctx.translate(20, 20 + slide * 40);
  const big = day ? `DAY ${day}` : formatDate(date);
  const small = day && date ? formatDate(date) : '';
  ctx.font = `800 20px ${FONT}`;
  const w1 = ctx.measureText(big).width;
  ctx.font = `600 12px ${FONT}`;
  const w = Math.max(w1, ctx.measureText(small).width) + 30, h = small ? 54 : 38;
  ctx.fillStyle = 'rgba(8,12,22,0.66)';
  ctx.shadowColor = 'rgba(0,0,0,0.3)'; ctx.shadowBlur = 16;
  ctx.beginPath(); ctx.roundRect(0, 0, w, h, 12); ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = '#FFD400'; ctx.fillRect(0, 10, 3.5, h - 20);
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  ctx.font = `800 20px ${FONT}`; ctx.fillStyle = day ? '#FFD400' : '#fff';
  ctx.fillText(big, 15, 27);
  if (small) { ctx.font = `600 12px ${FONT}`; ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.fillText(small, 15, 44); }
  ctx.restore();
}

function caption(ctx, W, text, a, top = 22) {
  ctx.save();
  ctx.globalAlpha = a;
  ctx.font = `700 22px ${FONT}`;
  const tw = ctx.measureText(text).width;
  const w = Math.min(W - 40, tw + 44), h = 46, x = W / 2 - w / 2, y = top + (1 - a) * -10;
  ctx.fillStyle = 'rgba(8,12,22,0.62)';
  ctx.shadowColor = 'rgba(0,0,0,0.3)'; ctx.shadowBlur = 18;
  ctx.beginPath(); ctx.roundRect(x, y, w, h, h / 2); ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 1; ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, W / 2, y + h / 2 + 1, w - 30);
  ctx.restore();
}

function titleCard(ctx, W, H, title, sub, a) {
  if (a <= 0) return;
  ctx.save();
  ctx.globalAlpha = a;
  const base = H > W ? H * 0.72 : H - 64;
  const y = base + (1 - easeOutCubic(a)) * 20;
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.shadowColor = 'rgba(0,0,0,0.75)'; ctx.shadowBlur = 18; ctx.shadowOffsetY = 3;
  ctx.font = `800 ${H > W ? 34 : 40}px ${FONT}`;
  ctx.fillStyle = '#fff';
  ctx.fillText(title, W / 2, y, W - 40);
  if (sub) {
    ctx.font = `600 17px ${FONT}`;
    ctx.fillStyle = '#ffd84d';
    ctx.fillText(sub, W / 2, y + 28, W - 40);
  }
  ctx.restore();
}

function distanceTag(ctx, [x, y], text, finalText, scale, alpha) {
  ctx.save();
  ctx.globalAlpha *= clamp(alpha, 0, 1);
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  ctx.font = `700 14px ${FONT}`;
  // width fits the widest of current/final so the pill doesn't wobble while counting
  const w = Math.max(ctx.measureText(text).width, ctx.measureText(finalText).width) + 22, h = 26;
  ctx.shadowColor = 'rgba(0,0,0,0.4)'; ctx.shadowBlur = 10; ctx.shadowOffsetY = 3;
  ctx.fillStyle = '#FFD400';
  ctx.beginPath(); ctx.roundRect(-w / 2, -h - 6, w, h, 8); ctx.fill();
  ctx.beginPath(); ctx.moveTo(-6, -7); ctx.lineTo(0, 0); ctx.lineTo(6, -7); ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = '#16130a'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, 0, -h / 2 - 5);
  ctx.restore();
}

function distanceCard(ctx, W, H, emoji, km, sub, a, units, time = '') {
  if (a <= 0) return;
  const txt = formatDistance(km, units) + (time ? `  ·  ${time}` : '');
  ctx.save();
  ctx.globalAlpha = a;
  const portrait = H > W;
  ctx.font = `700 22px ${FONT}`;
  const tw = Math.max(ctx.measureText(txt).width, 60);
  ctx.font = `500 11px ${FONT}`;
  const sw = Math.min(ctx.measureText(sub).width, 260);
  const w = Math.max(tw, sw) + 74, h = 58;
  const x = portrait ? W / 2 - w / 2 : 20, y = portrait ? H * 0.8 - h : H - h - 20;
  ctx.fillStyle = 'rgba(8,12,22,0.66)';
  ctx.shadowColor = 'rgba(0,0,0,0.3)'; ctx.shadowBlur = 18;
  ctx.beginPath(); ctx.roundRect(x, y, w, h, 16); ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = 'rgba(255,255,255,0.16)'; ctx.lineWidth = 1; ctx.stroke();
  ctx.font = `24px ${FONT}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  ctx.fillText(emoji, x + 14, y + h / 2 + 1);
  ctx.fillStyle = '#fff'; ctx.font = `700 22px ${FONT}`; ctx.textBaseline = 'alphabetic';
  ctx.fillText(txt, x + 54, y + 29);
  ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.font = `500 11px ${FONT}`;
  ctx.fillText(sub, x + 54, y + 46, w - 66);
  ctx.restore();
}
