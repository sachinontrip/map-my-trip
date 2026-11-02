// Sidebar: map & video settings, and the scene list with an editor per scene type.
import { STYLES } from './styles.js';
import { MODES, flagEmoji } from './icons.js';
import { PALETTE, newScene, uid } from './project.js';
import { searchPlaces, searchAreas } from './services.js';
import { importFile } from './media.js';
import { highlightMinDuration } from './engine.js';
import { nearestAirport, estimateFlightTime, parseFlightMinutes, formatClock } from './board.js';
import { LOOK_NAMES, cloudsOn } from './looks.js';

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') for (const [p, val] of Object.entries(v)) el.style.setProperty(p.replace(/[A-Z]/g, m => '-' + m.toLowerCase()), val);
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
}

const field = (label, ...input) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), ...input);

function slider(label, value, min, max, step, onInput, fmt = v => v) {
  const out = h('span', { class: 'slider-val' }, fmt(value));
  const inp = h('input', { type: 'range', min, max, step, value, oninput: e => { out.textContent = fmt(+e.target.value); onInput(+e.target.value); } });
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label, out), inp);
}

/** Tells the user when a highlight scene is stretched so each place gets its own moment. */
function tourHint(sc) {
  const min = highlightMinDuration(sc);
  if (min <= (+sc.duration || 6)) return h('span', { class: 'tour-hint' });
  return h('div', { class: 'hint tour-hint' }, `This scene plays for ${min.toFixed(1)} s so the camera can stop at each place (about 1.6 s each), then show them all.`);
}

function select(options, value, onChange) {
  return h('select', { onchange: e => onChange(e.target.value) },
    options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
}

function toggle(label, checked, onChange) {
  return h('label', { class: 'toggle' },
    h('input', { type: 'checkbox', checked, onchange: e => onChange(e.target.checked) }),
    h('span', { class: 'switch' }), h('span', {}, label));
}

function placeInput(place, onPick) {
  const list = h('div', { class: 'dropdown', hidden: true });
  const meta = h('div', { class: 'place-meta' }, place ? `${flagEmoji(place.cc)} ${place.lat.toFixed(4)}, ${place.lng.toFixed(4)}` : '');
  let timer, ctrl;
  const inp = h('input', {
    type: 'text', value: place?.name || '', placeholder: 'Search a city, airport, landmark…',
    oninput: e => {
      clearTimeout(timer);
      const q = e.target.value.trim();
      if (q.length < 2) { list.hidden = true; return; }
      timer = setTimeout(async () => {
        ctrl?.abort(); ctrl = new AbortController();
        list.replaceChildren(h('div', { class: 'dd-empty' }, 'Searching…')); list.hidden = false;
        try {
          const res = await searchPlaces(q, ctrl.signal);
          list.replaceChildren(...(res.length ? res.map(r => h('button', {
            type: 'button', class: 'dd-item',
            onmousedown: ev => {
              ev.preventDefault();
              inp.value = r.name; list.hidden = true;
              meta.textContent = `${flagEmoji(r.cc)} ${r.lat.toFixed(4)}, ${r.lng.toFixed(4)}`;
              onPick({ name: r.name, lng: r.lng, lat: r.lat, cc: r.cc });
            },
          }, h('b', {}, `${flagEmoji(r.cc)} ${r.name}`), h('small', {}, r.sub))) : [h('div', { class: 'dd-empty' }, 'No places found')]));
        } catch (err) { if (err.name !== 'AbortError') list.replaceChildren(h('div', { class: 'dd-empty' }, 'Search unavailable — check internet')); }
      }, 320);
    },
    onblur: () => setTimeout(() => { list.hidden = true; }, 150),
  });
  return h('div', { class: 'place' }, inp, list, meta);
}

const TYPE_META = {
  travel: { icon: '🧭', name: 'Travel' },
  highlight: { icon: '🎨', name: 'Highlight countries' },
  spotlight: { icon: '📍', name: 'Spotlight' },
};

export class Sidebar {
  constructor(app, settingsEl, listEl) {
    Object.assign(this, { app, settingsEl, listEl });
    this.openId = app.project.scenes[0]?.id;
  }

  get p() { return this.app.project; }

  renderSettings() {
    const s = this.p.settings, app = this.app;
    const set = (k, kind = 'env') => v => { s[k] = v; app.commit(kind); };
    this.settingsEl.replaceChildren(
      h('div', { class: 'panel-head' }, h('h2', {}, 'Map look')),
      h('div', { class: 'styles' }, STYLES.map(st => h('button', {
        type: 'button', class: 'style-chip' + (st.id === s.style ? ' active' : ''), title: st.name,
        onclick: () => { s.style = st.id; app.commit('style'); this.renderSettings(); },
      }, h('span', { class: 'sw', style: { background: st.swatch } }), h('span', {}, st.name)))),
      h('div', { class: 'toggles' },
        toggle('3D globe', s.globe, set('globe')),
        toggle('3D buildings', s.buildings, set('buildings')),
        toggle('3D terrain', s.terrain, set('terrain')),
        toggle('Country borders', s.borders, set('borders')),
        toggle('Keep past routes', s.keepRoutes, set('keepRoutes', 'scenes')),
        toggle('Distance counter', s.showDistance, set('showDistance', 'scenes')),
      ),
      h('div', { class: 'panel-head' }, h('h2', {}, 'Sound & extras')),
      h('div', { class: 'toggles' },
        toggle('Distance tag on vehicle', s.distanceTag !== false, set('distanceTag', 'scenes')),
        toggle('Day / date badge', s.dayBadge !== false, set('dayBadge', 'scenes')),
        toggle('3D plane model', s.plane3d !== false, set('plane3d', 'scenes')),
        toggle('Sound effects', !!s.sound, v => { s.sound = v; app.commit('sound'); }),
        toggle('Engine / flight sound', s.soundVehicle !== false, set('soundVehicle', 'sound')),
        toggle('Counter ticks + ding', s.soundTicks !== false, set('soundTicks', 'sound')),
        toggle('Whoosh & pops', s.soundFx !== false, set('soundFx', 'sound')),
      ),
      slider('Sound volume', s.volume ?? 0.8, 0, 1, 0.05, v => { s.volume = v; app.commit('sound'); }, v => `${Math.round(v * 100)}%`),
      h('div', { class: 'panel-head' }, h('h2', {}, 'Video')),
      h('div', { class: 'grid2' },
        field('Format', select([['16:9', '16:9 YouTube'], ['9:16', '9:16 Reel / Short'], ['1:1', '1:1 Square'], ['4:5', '4:5 Feed']], s.aspect, v => { s.aspect = v; app.commit('frame'); })),
        field('Quality', select([['720', '720p'], ['1080', '1080p HD'], ['1440', '1440p 2K'], ['2160', '2160p 4K']], s.quality, v => { s.quality = v; app.commit('save'); })),
        field('Frame rate', select([['30', '30 fps'], ['60', '60 fps (smoothest)']], String(s.fps), v => { s.fps = +v; app.commit('save'); })),
        field('Units', select([['km', 'Kilometres'], ['mi', 'Miles']], s.units, v => { s.units = v; app.commit('scenes'); })),
      ),
      slider('Scene transition', s.transition, 0, 3, 0.1, v => { s.transition = v; app.commit('scenes'); }, v => `${v.toFixed(1)}s`),
      field('Watermark', h('input', { type: 'text', value: s.watermark || '', placeholder: '@yourchannel', oninput: e => { s.watermark = e.target.value; app.commit('scenes'); } })),
    );
  }

  renderScenes() {
    const scenes = this.p.scenes;
    this.listEl.replaceChildren(...scenes.map((sc, i) => this.card(sc, i)));
    if (!scenes.length) this.listEl.append(h('div', { class: 'empty' }, 'No scenes yet — add one below.'));
  }

  addScene(type) {
    const sc = newScene(type, this.p.scenes[this.p.scenes.length - 1]);
    this.p.scenes.push(sc);
    this.openId = sc.id;
    this.app.commit('scenes');
    this.renderScenes();
    this.app.seekScene(this.p.scenes.length - 1);
  }

  summary(sc) {
    if (sc.type === 'travel') return `${MODES[sc.mode].emoji} ${sc.from.name} → ${sc.to.name}`;
    if (sc.type === 'highlight') return sc.countries.map(c => (c.kind ? this.app.resolve(c)?.name : flagEmoji(this.app.index[c.iso]?.iso2) || c.iso)).join(' · ') || 'Nothing yet';
    return `📍 ${sc.title || sc.place.name}`;
  }

  card(sc, i) {
    const open = this.openId === sc.id;
    const scenes = this.p.scenes;
    const move = d => { const j = i + d; if (j < 0 || j >= scenes.length) return; [scenes[i], scenes[j]] = [scenes[j], scenes[i]]; this.app.commit('scenes'); this.renderScenes(); };
    const head = h('div', {
      class: 'card-head', onclick: () => { this.openId = open ? null : sc.id; this.renderScenes(); if (!open) this.app.seekScene(i); },
    },
      h('span', {
        class: 'card-num', title: 'Drag to move this scene',
        onmousedown: e => { e.currentTarget.closest('.card').draggable = true; },
        onclick: e => e.stopPropagation(),
      }, i + 1),
      h('div', { class: 'card-title' }, h('b', {}, TYPE_META[sc.type].name), h('small', {}, this.summary(sc))),
      h('label', { class: 'card-dur', title: 'Scene length in seconds — type a new number', onclick: e => e.stopPropagation() },
        h('input', { type: 'number', min: 1, max: 300, step: 0.5, value: +sc.duration || 6, onchange: e => this.setDuration(sc, e.target.value) }), 's'),
      h('div', { class: 'card-tools', onclick: e => e.stopPropagation() },
        h('button', { type: 'button', title: 'Move up', onclick: () => move(-1) }, '↑'),
        h('button', { type: 'button', title: 'Move down', onclick: () => move(1) }, '↓'),
        h('button', { type: 'button', title: 'Duplicate', onclick: () => { const c = structuredClone(sc); c.id = uid(); scenes.splice(i + 1, 0, c); this.openId = c.id; this.app.commit('scenes'); this.renderScenes(); } }, '⧉'),
        h('button', { type: 'button', title: 'Delete', class: 'danger', onclick: () => { scenes.splice(i, 1); this.app.commit('scenes'); this.renderScenes(); } }, '✕'),
      ),
    );
    const body = open ? h('div', { class: 'card-body' }, this.durationField(sc), this[sc.type](sc, i)) : null;
    const card = h('div', { class: 'card' + (open ? ' open' : '') + (this.app.currentIndex === i ? ' playing' : ''), 'data-i': i }, head, body);
    this.dragAndDrop(card, i);
    return card;
  }

  /** Drag a card by its number onto another card to move it there. */
  dragAndDrop(card, i) {
    const clear = () => this.listEl.querySelectorAll('.drop-before, .drop-after').forEach(el => el.classList.remove('drop-before', 'drop-after'));
    const after = e => { const r = card.getBoundingClientRect(); return e.clientY > r.top + r.height / 2; };
    card.addEventListener('mouseup', () => { card.draggable = false; });
    card.addEventListener('dragstart', e => { this.dragFrom = i; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); card.classList.add('dragging'); });
    card.addEventListener('dragend', () => { card.draggable = false; card.classList.remove('dragging'); clear(); this.dragFrom = null; });
    card.addEventListener('dragover', e => {
      if (this.dragFrom == null) return;
      e.preventDefault();
      clear();
      if (this.dragFrom !== i) card.classList.add(after(e) ? 'drop-after' : 'drop-before');
    });
    card.addEventListener('drop', e => {
      e.preventDefault();
      const from = this.dragFrom;
      clear();
      if (from == null || from === i) return;
      const scenes = this.p.scenes;
      let to = i + (after(e) ? 1 : 0);
      const [moved] = scenes.splice(from, 1);
      if (from < to) to--;
      scenes.splice(to, 0, moved);
      this.app.commit('scenes');
      this.renderScenes();
    });
  }

  mediaField(sc, label) {
    const app = this.app;
    const input = h('input', {
      type: 'file', accept: 'image/*,video/*', hidden: true,
      onchange: async e => {
        const f = e.target.files[0]; if (!f) return;
        btn.textContent = 'Adding…';
        try { sc.media = await importFile(f); } catch (err) { alert(`Couldn't add that file: ${err.message}`); }
        app.commit('scenes'); this.renderScenes();
      },
    });
    const btn = h('button', { type: 'button', class: 'ghost wide-btn', onclick: () => input.click() }, '+ Add photo or video clip');
    return h('div', { class: 'field' }, h('span', { class: 'field-label' }, label),
      sc.media
        ? h('div', { class: 'media-row' }, h('span', {}, `${sc.media.kind === 'video' ? '🎬' : '🖼'} ${sc.media.name}`),
          h('button', { type: 'button', class: 'x', title: 'Remove', onclick: () => { delete sc.media; app.commit('scenes'); this.renderScenes(); } }, '✕'))
        : btn,
      sc.media ? slider(`${sc.media.kind === 'video' ? 'Clip' : 'Photo'} stays on screen after arriving`, sc.mediaHold ?? 1.5, 0, 10, 0.5,
        v => { sc.mediaHold = v; app.commit('scenes'); }, v => `+${v.toFixed(1)}s`) : null,
      input);
  }

  common(sc) {
    const app = this.app;
    return [
      sc.type !== 'highlight' ? this.mediaField(sc, sc.type === 'travel' ? 'Pop-up when you arrive' : 'Pop-up photo / clip') : null,
      sc.type !== 'highlight' ? h('div', { class: 'toggles' },
        toggle('3D buildings in this scene', sc.buildings !== false, v => { sc.buildings = v; app.commit('scenes'); })) : null,
      h('div', { class: 'grid2' },
        field('Day no.', h('input', { type: 'number', min: 1, max: 999, value: sc.day || '', placeholder: 'same as before', oninput: e => { sc.day = +e.target.value || undefined; app.commit('scenes'); } })),
        field('Date', h('input', { type: 'date', value: sc.date || '', oninput: e => { sc.date = e.target.value || undefined; app.commit('scenes'); } })),
      ),
      field('Caption on screen (optional)', h('input', { type: 'text', value: sc.caption || '', placeholder: 'e.g. Day 1 · Delhi → Cairo', oninput: e => { sc.caption = e.target.value; app.commit('scenes'); } })),
    ];
  }

  /** Scene length: a slider for quick changes plus a box for exact or long values (up to 5 min). */
  durationField(sc) {
    const v = +sc.duration || 6;
    return h('div', { class: 'field dur-field' },
      h('span', { class: 'field-label' }, sc.type === 'travel' ? 'Length (longer = slower trip)' : 'Length'),
      h('div', { class: 'dur-row' },
        h('input', { type: 'range', min: 1, max: 60, step: 0.5, value: Math.min(v, 60), oninput: e => this.setDuration(sc, e.target.value) }),
        h('input', { type: 'number', min: 1, max: 300, step: 0.5, value: v, onchange: e => this.setDuration(sc, e.target.value) }),
        h('span', {}, 's')));
  }

  setDuration(sc, val) {
    const v = Math.min(300, Math.max(1, Math.round((+val || 6) * 2) / 2));
    sc.duration = v;
    this.app.commit('scenes');
    const card = this.listEl.querySelector(`.card[data-i="${this.p.scenes.indexOf(sc)}"]`);
    card?.querySelectorAll('.card-dur input, .dur-row input[type=number]').forEach(el => { if (document.activeElement !== el) el.value = v; });
    const range = card?.querySelector('.dur-row input[type=range]');
    if (range && document.activeElement !== range) range.value = Math.min(v, 60);
    const hint = card?.querySelector('.tour-hint');
    if (hint) hint.replaceWith(tourHint(sc) || h('span', { class: 'tour-hint' }));
  }

  refreshHead(sc) {
    const i = this.p.scenes.indexOf(sc);
    const t = this.listEl.querySelector(`.card[data-i="${i}"] .card-title small`);
    if (t) t.textContent = this.summary(sc);
  }

  travel(sc) {
    const app = this.app;
    const commit = () => { app.commit('route', sc); this.refreshHead(sc); };
    const status = h('div', { class: 'route-status', 'data-scene': sc.id }, app.routeStatus(sc));
    return h('div', {},
      field('From', placeInput(sc.from, p => { sc.from = p; commit(); })),
      h('button', { type: 'button', class: 'swap', title: 'Swap', onclick: () => { [sc.from, sc.to] = [sc.to, sc.from]; commit(); this.renderScenes(); } }, '⇅ swap'),
      field('To', placeInput(sc.to, p => { sc.to = p; commit(); })),
      h('div', { class: 'field-label' }, 'How are you travelling?'),
      h('div', { class: 'modes' }, Object.entries(MODES).map(([k, m]) => h('button', {
        type: 'button', class: 'mode' + (sc.mode === k ? ' active' : ''),
        onclick: () => { const oldDefault = MODES[sc.mode].color; sc.mode = k; if (!sc.color || sc.color.toLowerCase() === oldDefault.toLowerCase()) sc.color = m.color; commit(); this.renderScenes(); },
      }, h('span', {}, m.emoji), m.label))),
      h('div', { class: 'grid2' },
        field('Route shape', select([['auto', 'Auto'], ['road', 'Follow roads'], ['curve', 'Smooth curve'], ['arc', 'Flight arc'], ['straight', 'Straight']], sc.path || 'auto', v => { sc.path = v; commit(); })),
        field('Camera', select([['cinematic', 'Cinematic (zoom in/out)'], ['follow', 'Follow vehicle'], ['overview', 'Whole route']], sc.camera || 'cinematic', v => { sc.camera = v; commit(); })),
        field('Route colour', h('input', { type: 'color', value: sc.color || MODES[sc.mode].color, oninput: e => { sc.color = e.target.value; app.commit('scenes'); } })),
        slider('Icon size', sc.iconSize || 1, 0.6, 2, 0.1, v => { sc.iconSize = v; app.commit('scenes'); }, v => `${v.toFixed(1)}×`),
      ),
      h('div', { class: 'toggles' },
        toggle('Rotate camera with route', sc.rotate !== false, v => { sc.rotate = v; app.commit('scenes'); }),
        toggle('Show place names', sc.labels !== false, v => { sc.labels = v; app.commit('scenes'); }),
      ),
      field('Time of day', select(LOOK_NAMES, sc.sky || 'day', v => { sc.sky = v; app.commit('scenes'); this.renderScenes(); })),
      sc.mode === 'flight' ? h('div', { class: 'toggles' },
        toggle('☁️ Fly through clouds on take-off & landing', cloudsOn(sc), v => { sc.clouds = v; app.commit('scenes'); })) : null,
      sc.mode === 'flight' && cloudsOn(sc) && sc.camera && sc.camera !== 'cinematic'
        ? h('div', { class: 'hint' }, 'Flying through clouds needs Camera: Cinematic. Other cameras show only the thin cloud layer below the plane.') : null,
      sc.mode === 'flight' ? this.flightTimeField(sc) : null,
      sc.mode === 'flight' ? this.boardFields(sc) : null,
      status,
      ...this.common(sc),
    );
  }

  /** Flight time: counts up next to the km in the yellow tag, and fills the departure board's DURATION. */
  flightTimeField(sc) {
    const app = this.app;
    const est = estimateFlightTime(sc.from, sc.to).toLowerCase();
    const note = h('div', { class: 'hint' });
    const check = () => {
      const v = sc.flightTime;
      note.textContent = !v ? `Blank = estimated from the distance (${est}). Type the real time from your ticket, e.g. 4h 35m.`
        : parseFlightMinutes(v) == null ? '⚠ Write it like 4h 35m or 4:35' : `Shows as ${formatClock(parseFlightMinutes(v))}`;
    };
    check();
    return h('div', {},
      field('Flight time', h('input', { type: 'text', value: sc.flightTime || '', placeholder: est, maxlength: 20,
        oninput: e => { sc.flightTime = e.target.value.trim() || undefined; check(); app.commit('scenes'); } })),
      note,
      h('div', { class: 'toggles' },
        toggle('⏱ Show flight time next to the km', sc.showTime !== false, v => { sc.showTime = v; app.commit('scenes'); })));
  }

  /** Departure-board intro for flights: codes and flight time fill in by themselves, the rest is optional. */
  boardFields(sc) {
    const app = this.app;
    const set = (key, upper) => e => { const v = e.target.value.trim(); sc[key] = v ? (upper ? v.toUpperCase() : v) : undefined; app.commit('scenes'); };
    const text = (label, key, placeholder, extra = {}) => field(label, h('input', { type: 'text', value: sc[key] || '', placeholder, oninput: set(key, true), ...extra }));
    const box = h('div', { class: 'board-box' },
      toggle('✈ Departure board intro', !!sc.board, v => { sc.board = v; app.commit('scenes'); this.renderScenes(); }));
    if (!sc.board) return box;
    box.append(
      h('div', { class: 'hint' }, 'An airport-style split-flap board plays before take-off. Blank boxes fill in automatically.'),
      h('div', { class: 'grid2' },
        text('From code', 'boardFrom', nearestAirport(sc.from)?.code || 'DEL', { maxlength: 3 }),
        text('To code', 'boardTo', nearestAirport(sc.to)?.code || 'CAI', { maxlength: 3 }),
        text('Flight no. (optional)', 'flightNo', 'e.g. AI 302', { maxlength: 8 }),
        field('Departs (optional)', h('input', { type: 'time', value: sc.boardTime || '', oninput: set('boardTime') })),
        text('Gate (optional)', 'gate', 'e.g. 23B', { maxlength: 4 }),
      ),
      h('div', { class: 'toggles' },
        toggle('Board only — no flight after it', !!sc.boardOnly, v => { sc.boardOnly = v; app.commit('scenes'); this.renderScenes(); })),
      sc.boardOnly
        ? h('div', { class: 'hint' }, 'Only the board is shown. Set how long it stays with "Length" at the top of this scene.')
        : slider('Board on screen', sc.boardLength || 4, 2.5, 8, 0.5, v => { sc.boardLength = v; app.commit('scenes'); }, v => `${v.toFixed(1)}s`),
    );
    return box;
  }

  highlight(sc) {
    const app = this.app, index = app.index;
    const rerender = () => { app.commit('scenes'); this.renderScenes(); };
    const nextColor = () => PALETTE.find(c => !sc.countries.some(x => x.color === c)) || PALETTE[sc.countries.length % PALETTE.length];
    const add = iso => { if (!index[iso] || sc.countries.some(c => c.iso === iso)) return; sc.countries.push({ iso, color: nextColor() }); };
    const addArea = item => { if (sc.countries.some(c => c.key === item.key)) return; sc.countries.push({ ...item, color: nextColor() }); };
    const firstCountry = sc.countries.find(c => !c.kind);
    const focus = firstCountry && index[firstCountry.iso];
    const icon = c => (c.kind === 'state' ? '🗺' : c.kind === 'osm' ? '📍' : flagEmoji(index[c.iso]?.iso2));
    const rows = sc.countries.map((c, k) => h('div', { class: 'country-row' },
      h('input', { type: 'color', value: c.color, oninput: e => { c.color = e.target.value; app.commit('scenes'); } }),
      h('span', { class: 'cname', title: app.resolve(c)?.name }, `${icon(c)} ${app.resolve(c)?.name || c.iso || c.key}`),
      h('input', { type: 'text', class: 'clabel', value: c.label || '', placeholder: 'Custom label', oninput: e => { c.label = e.target.value || undefined; app.commit('scenes'); } }),
      h('button', { type: 'button', class: 'x', title: 'Remove', onclick: () => { sc.countries.splice(k, 1); rerender(); } }, '✕'),
    ));
    return h('div', {},
      h('div', { class: 'hint' }, 'Countries, states and cities light up one by one, in this order, timed across the scene. Put the main one first.'),
      h('div', { class: 'countries' }, rows),
      h('input', {
        type: 'text', list: 'country-names', placeholder: '+ Add country (type a name)…', class: 'add-country',
        onchange: e => { const iso = app.countryByName(e.target.value); if (iso) { add(iso); rerender(); } else e.target.value = ''; },
      }),
      h('input', {
        type: 'text', list: 'india-states', placeholder: '+ Add Indian state / UT…', class: 'add-country',
        onchange: e => { const id = app.stateByName(e.target.value); if (id) { addArea({ kind: 'state', key: id }); rerender(); } else e.target.value = ''; },
      }),
      this.areaSearch(addArea, rerender),
      h('div', { class: 'row-btns' },
        focus ? h('button', { type: 'button', onclick: () => { focus.nb.forEach(add); rerender(); } }, `+ Neighbours of ${focus.name}`) : null,
        sc.countries.length ? h('button', { type: 'button', class: 'ghost', onclick: () => { sc.countries.splice(0); rerender(); } }, 'Clear') : null,
      ),
      sc.stagger !== false ? field('Camera', select([['tour', 'Zoom to each one, then show all'], ['all', 'Show all the whole time']], sc.camera || 'tour', v => { sc.camera = v; app.commit('scenes'); this.renderScenes(); })) : null,
      tourHint(sc),
      slider('Darken other countries', sc.dim ?? 0.45, 0, 0.9, 0.05, v => { sc.dim = v; app.commit('scenes'); }, v => `${Math.round(v * 100)}%`),
      h('div', { class: 'toggles' },
        toggle('Reveal one by one', sc.stagger !== false, v => { sc.stagger = v; app.commit('scenes'); this.renderScenes(); }),
        toggle('Keep colours in later scenes', !!sc.keep, v => { sc.keep = v; app.commit('scenes'); }),
      ),
      ...this.common(sc),
    );
  }

  /** Search any state / district / city worldwide (OpenStreetMap) and add it with its real outline. */
  areaSearch(addArea, rerender) {
    const list = h('div', { class: 'area-results' });
    const inp = h('input', { type: 'text', placeholder: 'City, district or state anywhere…', onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); go(); } } });
    const go = async () => {
      const q = inp.value.trim(); if (q.length < 2) return;
      list.replaceChildren(h('div', { class: 'dd-empty' }, 'Searching OpenStreetMap…'));
      try {
        const res = await searchAreas(q);
        list.replaceChildren(...(res.length ? res.map(r => h('button', {
          type: 'button', class: 'dd-item', onclick: () => { addArea({ kind: 'osm', key: r.key, name: r.name, lx: r.lx, ly: r.ly, geometry: r.geometry, point: !r.outline }); rerender(); },
        }, h('b', {}, `${r.outline ? '🗺' : '📍'} ${r.name}`), h('small', {}, r.sub + (r.outline ? '' : ' · no outline, shown as a circle')))) : [h('div', { class: 'dd-empty' }, 'Nothing found')]));
      } catch { list.replaceChildren(h('div', { class: 'dd-empty' }, 'Search unavailable — check internet')); }
    };
    return h('div', { class: 'area-search' }, h('div', { class: 'search-row' }, inp, h('button', { type: 'button', class: 'ghost', onclick: go }, 'Search')), list);
  }

  spotlight(sc) {
    const app = this.app;
    return h('div', {},
      field('Place', placeInput(sc.place, p => { sc.place = p; if (!sc.title) sc.title = p.name; app.commit('scenes'); this.refreshHead(sc); })),
      h('div', { class: 'grid2' },
        field('Title', h('input', { type: 'text', value: sc.title || '', oninput: e => { sc.title = e.target.value; app.commit('scenes'); this.refreshHead(sc); } })),
        field('Subtitle', h('input', { type: 'text', value: sc.subtitle || '', placeholder: 'Egypt 🇪🇬', oninput: e => { sc.subtitle = e.target.value; app.commit('scenes'); } })),
      ),
      slider('Zoom', sc.zoom ?? 15.8, 3, 18, 0.1, v => { sc.zoom = v; app.commit('scenes'); }, v => v.toFixed(1)),
      slider('Orbit (camera rotation)', sc.orbit ?? 70, -180, 180, 5, v => { sc.orbit = v; app.commit('scenes'); }, v => `${v}°`),
      slider('Tilt', sc.pitch ?? 62, 0, 75, 1, v => { sc.pitch = v; app.commit('scenes'); }, v => `${v}°`),
      field('Pin colour', h('input', { type: 'color', value: sc.color || '#ff3b5c', oninput: e => { sc.color = e.target.value; app.commit('scenes'); } })),
      ...this.common(sc),
    );
  }
}
