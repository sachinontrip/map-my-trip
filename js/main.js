import { Engine, outputSize, pathKind, routeKey } from './engine.js';
import { setAirports } from './board.js';
import { Sidebar, h } from './ui.js';
import { sampleProject, newScene, defaultSettings } from './project.js';
import { fetchRoute } from './services.js';
import { exportVideo, canExport } from './exporter.js';
import { MODES } from './icons.js';
import { renderSoundtrack, SR } from './audio.js';
import { packMedia, unpackMedia } from './media.js';
import { buildTrip, TRIP_EXAMPLES } from './prompt.js';

const STORE = 'trip-map-animator:project';
const $ = id => document.getElementById(id);

// ---------------------------------------------------------------- data

function polygonArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return Math.abs(a / 2);
}

function buildIndex(countries) {
  const index = {};
  for (const f of countries.features) {
    const p = f.properties;
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    const main = polys.reduce((best, poly) => (polygonArea(poly[0]) > polygonArea(best[0]) ? poly : best), polys[0]);
    let b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of main[0]) { b = [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)]; }
    index[p.iso] = { iso: p.iso, iso2: p.iso2, name: p.name, lx: p.lx, ly: p.ly, nb: p.nb || [], bbox: b };
  }
  return index;
}

function loadProject() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE));
    if (saved?.scenes) { saved.settings = { ...defaultSettings(), ...saved.settings }; return saved; }
  } catch { /* storage unavailable or corrupt */ }
  return sampleProject();
}

// ---------------------------------------------------------------- app

const fmt = s => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

async function main() {
  await document.fonts.load('600 14px Poppins').catch(() => {});
  const [countries, states, airports] = await Promise.all(['data/countries.geojson', 'data/india_states.geojson', 'data/airports.json'].map(u => fetch(u).then(r => r.json())));
  setAirports(airports);
  const index = buildIndex(countries);
  const names = Object.values(index).sort((a, b) => a.name.localeCompare(b.name));
  const stateNames = states.features.map(f => f.properties).sort((a, b) => a.name.localeCompare(b.name));
  document.body.append(
    h('datalist', { id: 'country-names' }, names.map(c => h('option', { value: c.name }))),
    h('datalist', { id: 'india-states' }, stateNames.map(s => h('option', { value: s.name }))),
  );

  const app = {
    project: loadProject(),
    index,
    playing: false,
    currentIndex: -1,
    routeState: {},
    countryByName: n => names.find(c => c.name.toLowerCase() === n.trim().toLowerCase())?.iso,
    stateByName: n => stateNames.find(s => s.name.toLowerCase() === n.trim().toLowerCase())?.id,
  };

  const engine = new Engine({ frameEl: $('frame'), mapEl: $('map'), overlayEl: $('overlay'), starsEl: $('stars'), countries, index, states });
  app.engine = engine;
  app.resolve = engine.resolve;
  await engine.init(app.project);

  const sidebar = new Sidebar(app, $('settings-panel'), $('scene-list'));

  let saveTimer;
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { try { localStorage.setItem(STORE, JSON.stringify(app.project)); } catch { /* quota / private mode */ } }, 300);
    history.record();
  };

  // ------------------------------------------------------------ undo / redo
  // Snapshots of the project, taken a moment after edits settle (one slider drag = one step).
  // Fetched road geometry is left out: it is re-fetched (from cache) and is not an edit.
  const snap = () => JSON.stringify(app.project, (k, v) => (k === 'geomKey' || (k === 'geometry' && Array.isArray(v)) ? undefined : v));
  const history = {
    past: [], future: [], last: null, timer: 0,
    record() { clearTimeout(this.timer); this.timer = setTimeout(() => this.flush(), 400); },
    flush() {
      clearTimeout(this.timer);
      const now = snap();
      if (this.last !== null && now !== this.last) { this.past.push(this.last); if (this.past.length > 100) this.past.shift(); this.future = []; }
      this.last = now; this.buttons();
    },
    step(from, to) {
      this.flush();
      if (!from.length) return;
      to.push(this.last);
      this.last = from.pop();
      const prevStyle = app.project.settings.style;
      app.project = JSON.parse(this.last);
      restore(prevStyle);
      this.buttons();
    },
    undo() { this.step(this.past, this.future); },
    redo() { this.step(this.future, this.past); },
    buttons() { $('btn-undo').disabled = !this.past.length; $('btn-redo').disabled = !this.future.length; },
  };
  history.last = snap();
  $('btn-undo').onclick = () => history.undo();
  $('btn-redo').onclick = () => history.redo();

  app.routeStatus = sc => {
    const kind = pathKind(sc);
    if (kind !== 'road') return `Route: ${{ arc: 'flight arc', curve: 'smooth curve', straight: 'straight line' }[kind]}`;
    const st = app.routeState[sc.id];
    if (st === 'loading') return 'Finding the road route…';
    if (st === 'error') return '⚠ No road route found — showing a smooth curve instead';
    if (sc.geometry && sc.geomKey === routeKey(sc)) return `Route follows real ${sc.mode === 'walk' ? 'footpaths' : 'roads'} ✓`;
    return '';
  };
  const setRouteStatus = sc => {
    const el = document.querySelector(`.route-status[data-scene="${sc.id}"]`);
    if (el) el.textContent = app.routeStatus(sc);
  };

  async function ensureRoute(sc) {
    if (sc.type !== 'travel' || pathKind(sc) !== 'road') return;
    const key = routeKey(sc);
    if (sc.geometry && sc.geomKey === key) return;
    app.routeState[sc.id] = 'loading'; setRouteStatus(sc);
    try {
      const coords = await fetchRoute(sc.from, sc.to, sc.mode === 'walk' ? 'walk' : 'drive');
      if (routeKey(sc) !== key) return; // edited meanwhile
      sc.geometry = coords; sc.geomKey = key;
      app.routeState[sc.id] = 'ok';
      engine.setProject(app.project);
      renderTimeline();
      save();
    } catch (err) {
      console.warn('route failed', err);
      app.routeState[sc.id] = 'error';
    }
    setRouteStatus(sc);
  }
  const ensureAllRoutes = () => Promise.all(app.project.scenes.map(ensureRoute));

  app.commit = (kind, sc) => {
    if (kind === 'style') engine.setStyle(app.project.settings.style);
    else if (kind === 'env') engine.updateEnvironment();
    else if (kind === 'route') { engine.setProject(app.project); ensureRoute(sc); }
    else if (kind === 'sound') { sound.dirty = true; if (app.playing) { pause(); play(); } }
    else if (kind !== 'save') engine.setProject(app.project);
    if (kind === 'frame') requestAnimationFrame(() => engine.sizeFrame());
    if (!['save', 'env', 'style', 'sound'].includes(kind)) renderTimeline();
    save();
  };

  app.seekScene = i => {
    const c = engine.timeline.scenes[i];
    if (c) { pause(); engine.renderAt(c.t1 + Math.min(1.5, (c.t2 - c.t1) * 0.3)); }
  };

  // ------------------------------------------------------------ timeline + player

  const scrub = $('scrub'), blocks = $('blocks');
  function renderTimeline() {
    const tl = engine.timeline;
    blocks.replaceChildren(...tl.scenes.map(c => {
      const s = c.s;
      const icon = s.type === 'travel' ? MODES[s.mode].emoji : s.type === 'highlight' ? '🎨' : '📍';
      return h('button', {
        type: 'button', class: `block ${s.type}`, title: `Scene ${c.i + 1}`,
        style: { left: `${(c.t1 / tl.total) * 100}%`, width: `${((c.t2 - c.t1) / tl.total) * 100}%`, '--c': s.type === 'travel' ? c.color : '' },
        onclick: () => app.seekScene(c.i),
      }, `${icon} ${c.i + 1}`);
    }));
    onTime(engine.t);
  }

  function onTime(t) {
    const total = engine.timeline.total;
    $('time').textContent = `${fmt(t)} / ${fmt(total)}`;
    if (!scrubbing) scrub.value = Math.round((t / total) * 1000);
    const c = engine.sceneAt(t);
    const i = c ? c.i : -1;
    if (i !== app.currentIndex) {
      app.currentIndex = i;
      document.querySelectorAll('.card').forEach(el => el.classList.toggle('playing', +el.dataset.i === i));
      blocks.querySelectorAll('.block').forEach((el, k) => el.classList.toggle('active', k === i));
    }
  }
  engine.on('time', onTime);
  engine.on('time', t => { if (!engine.exporting) engine.syncMedia(t); });

  let scrubbing = false;
  scrub.addEventListener('input', () => { scrubbing = true; pause(); engine.renderAt((scrub.value / 1000) * engine.timeline.total); });
  scrub.addEventListener('change', () => { scrubbing = false; });

  // sound: rendered once per edit, played from the current time; while it plays it is the clock
  const sound = { ctx: null, buf: null, dirty: true, src: null, ctxStart: 0, tStart: 0, pending: null };
  let speed = 1;
  const setSpeed = v => {
    speed = v; $('speed').value = String(v);
    if (app.playing) { pause(); play(); }
  };
  $('speed').onchange = e => setSpeed(+e.target.value);
  engine.on('timeline', () => { sound.dirty = true; });
  async function getSoundtrack() {
    if (!app.project.settings.sound) return null;
    if (sound.dirty || !sound.buf) {
      sound.dirty = false;
      sound.pending = renderSoundtrack(engine.timeline, app.project.settings);
      sound.buf = await sound.pending;
    }
    return sound.buf;
  }
  function stopSound() { try { sound.src?.stop(); } catch { /* not started */ } sound.src = null; }

  let last = 0, raf = 0;
  function tick(now) {
    if (!app.playing) return;
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    let t = sound.src ? sound.tStart + (sound.ctx.currentTime - sound.ctxStart) * speed : engine.t + dt * speed;
    if (t >= engine.timeline.total) { t = engine.timeline.total; engine.renderAt(t); pause(); return; }
    engine.renderAt(t);
    raf = requestAnimationFrame(tick);
  }
  async function play() {
    if (engine.t >= engine.timeline.total - 0.05) engine.renderAt(0);
    app.playing = engine.playing = true; $('btn-play').textContent = '❚❚'; $('btn-play').classList.add('on');
    if (app.project.settings.sound) {
      sound.ctx ||= new AudioContext({ sampleRate: SR });
      sound.ctx.resume();
      const buf = await getSoundtrack().catch(err => { console.warn('sound failed', err); return null; });
      if (!app.playing) return;
      if (buf) {
        stopSound();
        sound.src = sound.ctx.createBufferSource();
        sound.src.buffer = buf;
        sound.src.playbackRate.value = speed;
        sound.src.connect(sound.ctx.destination);
        sound.src.start(0, Math.min(engine.t, buf.duration));
        sound.ctxStart = sound.ctx.currentTime; sound.tStart = engine.t;
      }
    }
    last = performance.now(); raf = requestAnimationFrame(tick);
  }
  function pause() { app.playing = engine.playing = false; cancelAnimationFrame(raf); stopSound(); engine.syncMedia(engine.t); $('btn-play').textContent = '▶'; $('btn-play').classList.remove('on'); }
  $('btn-play').onclick = () => (app.playing ? pause() : play());
  $('btn-restart').onclick = () => { pause(); engine.renderAt(0); };
  // ------------------------------------------------------------ keyboard shortcuts

  const SPEEDS = [0.5, 1, 1.5, 2];
  const seekBy = d => { const was = app.playing; pause(); engine.renderAt(Math.max(0, Math.min(engine.timeline.total, engine.t + d))); if (was) play(); };
  const openModal = id => { pause(); $(id).hidden = false; };
  document.addEventListener('keydown', e => {
    const el = document.activeElement;
    const typing = el && (/TEXTAREA|SELECT/.test(el.tagName) || (el.tagName === 'INPUT' && !/checkbox|range|color|file|radio|button/.test(el.type)));
    const mod = e.metaKey || e.ctrlKey;
    const modalOpen = [...document.querySelectorAll('.modal')].some(m => !m.hidden);
    if (e.key === 'Escape' && modalOpen) { document.querySelectorAll('.modal').forEach(m => { if (m.id !== 'export-modal') m.hidden = true; }); return; }
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); $('btn-save').click(); return; }
    if (typing || modalOpen) return; // text boxes keep their own undo, arrows, etc.
    const k = e.key.toLowerCase();
    if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? history.redo() : history.undo(); }
    else if (mod && k === 'y') { e.preventDefault(); history.redo(); }
    else if (mod && k === 'e') { e.preventDefault(); $('btn-export').click(); }
    else if (mod || e.altKey) return;
    else if (e.code === 'Space') { e.preventDefault(); if (el?.tagName === 'BUTTON') el.blur(); app.playing ? pause() : play(); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { if (el?.type === 'range') return; e.preventDefault(); seekBy((e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 5 : 1)); }
    else if (e.key === 'Home') { e.preventDefault(); pause(); engine.renderAt(0); }
    else if (e.key === '[' || e.key === ']') { const i = SPEEDS.indexOf(speed) + (e.key === ']' ? 1 : -1); if (SPEEDS[i]) setSpeed(SPEEDS[i]); }
    else if (e.key === '?') openModal('keys-modal');
    else if (k === 't') { e.preventDefault(); openTrip(); }
  });
  $('btn-keys').onclick = () => openModal('keys-modal');
  $('keys-close').onclick = () => { $('keys-modal').hidden = true; };

  // ------------------------------------------------------------ project files

  // after undo / redo: show the restored project without jumping away from where you are
  function restore(prevStyle) {
    pause();
    engine.setProject(app.project);
    if (app.project.settings.style !== prevStyle) engine.setStyle(app.project.settings.style);
    else engine.updateEnvironment();
    if (!app.project.scenes.some(s => s.id === sidebar.openId)) sidebar.openId = null;
    sidebar.renderSettings(); sidebar.renderScenes(); renderTimeline();
    engine.renderAt(Math.min(engine.t, engine.timeline.total));
    sound.dirty = true;
    ensureAllRoutes();
    try { localStorage.setItem(STORE, JSON.stringify(app.project)); } catch { /* quota / private mode */ }
  }

  const refreshAll = () => { engine.setProject(app.project); engine.setStyle(app.project.settings.style); sidebar.openId = app.project.scenes[0]?.id; sidebar.renderSettings(); sidebar.renderScenes(); renderTimeline(); engine.renderAt(0); ensureAllRoutes(); save(); };
  document.querySelectorAll('[data-add]').forEach(b => b.addEventListener('click', () => { sidebar.addScene(b.dataset.add); ensureAllRoutes(); }));
  $('btn-new').onclick = () => {
    if (!confirm('Start a new empty project? (Save first if you want to keep this one.)')) return;
    app.project = { version: 1, name: 'My trip', settings: { ...app.project.settings }, scenes: [newScene('travel')] };
    refreshAll();
  };
  $('btn-demo').onclick = () => { if (confirm('Load the India → Egypt demo? Your current project will be replaced.')) { app.project = sampleProject(); refreshAll(); } };
  $('btn-save').onclick = async () => {
    const mediaFiles = await packMedia(app.project);
    const blob = new Blob([JSON.stringify({ ...app.project, mediaFiles }, null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `${(app.project.name || 'trip').replace(/\W+/g, '-')}.mapmytrip.json` });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  $('btn-open').onclick = () => $('file-open').click();
  $('file-open').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const p = JSON.parse(await f.text());
      if (!Array.isArray(p.scenes)) throw new Error('not a project');
      p.settings = { ...defaultSettings(), ...p.settings };
      await unpackMedia(p.mediaFiles);
      delete p.mediaFiles;
      app.project = p; refreshAll();
    } catch { alert('That file is not a Map My Trip project.'); }
    e.target.value = '';
  };

  // ------------------------------------------------------------ type your trip

  const tripText = $('trip-text'), tripLog = $('trip-log');
  $('trip-examples').replaceChildren(...TRIP_EXAMPLES.map(x => h('button', { type: 'button', onclick: () => { tripText.value = x; tripText.focus(); } }, x)));
  function openTrip() { openModal('trip-modal'); tripLog.replaceChildren(); $('trip-go').disabled = false; setTimeout(() => tripText.focus(), 30); }
  $('btn-trip').onclick = openTrip;
  $('trip-close').onclick = () => { $('trip-modal').hidden = true; };
  tripText.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('trip-go').click(); });
  $('trip-go').onclick = async () => {
    const text = tripText.value.trim();
    if (!text) { tripText.focus(); return; }
    $('trip-go').disabled = true;
    const line = (cls, msg) => tripLog.append(h('div', { class: cls }, msg));
    tripLog.replaceChildren();
    const append = $('trip-append').checked;
    const prev = append ? app.project.scenes.at(-1) : null;
    try {
      const { scenes, notes } = await buildTrip(text, { app, prev, onStatus: msg => { tripLog.querySelector('.status')?.remove(); line('muted status', msg); } });
      tripLog.querySelector('.status')?.remove();
      if (!scenes.length) { line('warn', "Couldn't make any scenes from that. Try something like: Delhi to Cairo by flight, show Egypt's neighbours."); notes.forEach(n => line('warn', '⚠ ' + n)); return; }
      app.project.scenes = append ? [...app.project.scenes, ...scenes] : scenes;
      sidebar.openId = scenes[0].id;
      sidebar.renderScenes();
      app.commit('scenes');
      ensureAllRoutes();
      app.seekScene(append ? app.project.scenes.length - scenes.length : 0);
      scenes.forEach((sc, i) => line('ok', `✓ ${i + 1}. ${sidebar.summary(sc)}`));
      notes.forEach(n => line('warn', '⚠ ' + n));
      line('muted', 'Done! Close this box to see your scenes. Change anything in the sidebar, or press ⌘Z to undo.');
    } catch (err) {
      console.error(err);
      line('warn', `Something went wrong: ${err.message}. Check your internet connection and try again.`);
    } finally { $('trip-go').disabled = false; }
  };

  // ------------------------------------------------------------ export

  const modal = $('export-modal');
  let exportCtrl = null;
  $('btn-export').onclick = () => {
    pause();
    const { OW, OH } = outputSize(app.project.settings);
    $('ex-summary').textContent = `${OW}×${OH} · ${app.project.settings.fps} fps · ${engine.timeline.total.toFixed(1)}s · MP4 (H.264)${app.project.settings.sound ? ' + sound' : ''}`;
    $('ex-progress').hidden = true; $('ex-done').hidden = true; $('ex-start').hidden = false; $('ex-error').textContent = '';
    if (!canExport()) $('ex-error').textContent = 'Video export needs Chrome, Edge or Safari 17+.';
    modal.hidden = false;
  };
  $('ex-close').onclick = () => { exportCtrl?.abort(); modal.hidden = true; };
  const BG_HINTS = {
    map: 'The full animated map with sound, ready to drop into your timeline.',
    green: 'Map hidden, routes / plane / labels on pure green. In your editor use Chroma key (or Remove background) on the green.',
    png: 'Routes / plane / labels with a see-through background, one PNG per frame + sound.wav. You will pick an empty folder; import it as an image sequence.',
  };
  const bgSel = $('ex-bg');
  bgSel.onchange = () => { $('ex-bg-hint').textContent = BG_HINTS[bgSel.value]; };
  bgSel.onchange();

  $('ex-start').onclick = async () => {
    const background = bgSel.value;
    let dir = null;
    if (background === 'png') {
      if (!window.showDirectoryPicker) { $('ex-error').textContent = 'PNG sequence export needs Chrome or Edge.'; return; }
      try { dir = await window.showDirectoryPicker({ mode: 'readwrite' }); } catch { return; } // picker closed
    }
    $('ex-start').hidden = true; $('ex-progress').hidden = false; $('ex-error').textContent = '';
    $('ex-label').textContent = 'Fetching routes…';
    await ensureAllRoutes();
    exportCtrl = new AbortController();
    try {
      $('ex-label').textContent = 'Mixing sound…';
      const soundtrack = await getSoundtrack();
      const blob = await exportVideo(engine, {
        signal: exportCtrl.signal,
        soundtrack, background, dir,
        onProgress: ({ frame, frames, eta }) => {
          $('ex-bar').style.width = `${(frame / frames) * 100}%`;
          $('ex-label').textContent = `Rendering frame ${frame} / ${frames} · about ${Math.ceil(eta)}s left`;
        },
      });
      $('ex-progress').hidden = true; $('ex-done').hidden = false;
      const link = $('ex-download');
      if (!blob) {
        link.hidden = true;
        $('ex-size').textContent = `PNG frames${soundtrack ? ' + sound.wav' : ''} saved in the folder "${dir.name}".`;
      } else {
        const url = URL.createObjectURL(blob);
        const name = `${(app.project.name || 'map-my-trip').replace(/\W+/g, '-')}-${app.project.settings.aspect.replace(':', 'x')}${background === 'green' ? '-greenscreen' : ''}.mp4`;
        link.hidden = false; link.href = url; link.download = name;
        $('ex-size').textContent = `${(blob.size / 1e6).toFixed(1)} MB`;
        link.click();
      }
    } catch (err) {
      $('ex-progress').hidden = true; $('ex-start').hidden = false;
      $('ex-error').textContent = err.name === 'AbortError' ? 'Export cancelled.' : `Export failed: ${err.message}`;
      console.error(err);
    }
    exportCtrl = null;
  };

  // ------------------------------------------------------------ boot

  new ResizeObserver(() => engine.sizeFrame()).observe($('stage'));
  // phones: the sidebar shows one tab at a time (Scenes / Style & video)
  document.querySelectorAll('.mobile-tabs button').forEach(b => b.addEventListener('click', () => { $('sidebar').dataset.tab = b.dataset.tab; $('sidebar').scrollTop = 0; }));
  // lets the phone layout give vertical Reels a taller preview
  const markAspect = () => { document.documentElement.dataset.aspect = app.project.settings.aspect; };
  markAspect();
  engine.on('timeline', markAspect);
  sidebar.renderSettings();
  sidebar.renderScenes();
  renderTimeline();
  engine.renderAt(0);
  ensureAllRoutes();
  $('loading').remove();
  window.tripMap = { app, engine }; // handy for debugging in the console
}

main().catch(err => {
  console.error(err);
  $('loading').textContent = `Couldn't start: ${err.message}`;
});
