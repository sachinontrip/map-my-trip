// "Type your trip": turns a plain-words trip ("Delhi to Cairo by flight, taxi to the pyramids,
// show Egypt's neighbours") into scenes. Rule-based, English + Hinglish, no AI service needed.
import { searchPlaces, geocodeBest } from './services.js';
import { newScene, PALETTE } from './project.js';
import { MODES } from './icons.js';
import { distanceKm } from './geo.js';

export const TRIP_EXAMPLES = [
  "Delhi to Cairo by flight, taxi to the pyramids, show Egypt's neighbours",
  'Day 1: Mumbai se Goa train. Day 2: walk to Baga Beach, visit Fort Aguada',
  'Kolkata to Kathmandu flight, then highlight Nepal, Bhutan and Bangladesh',
  'Fly from London to Paris, explore the Eiffel Tower',
];

const MODE_WORDS = [
  ['flight', /\b(flight|flights|fly|flying|flew|plane|aeroplane|airplane|jahaz|hawai jahaz)\b/],
  ['taxi', /\b(taxi|cab|uber|ola|auto rickshaw|rickshaw|tuk ?tuk)\b/],
  ['train', /\b(train|rail|railway|metro)\b/],
  ['bus', /\b(bus|coach)\b/],
  ['bike', /\b(bike|motorbike|motorcycle|scooter|scooty|cycle|bicycle)\b/],
  ['boat', /\b(boat|ferry|cruise|ship|naav|nav)\b/],
  ['walk', /\b(walk|walked|walking|on foot|paidal|hike|trek|trekking)\b/],
  ['car', /\b(car|drive|drove|driving|road ?trip|gaadi|gadi)\b/],
];
const NEIGHBOURS = /\b(neighbou?rs?|neighbou?ring( countries)?|bordering( countries)?|padosi|padoshi|pados)\b/;
const HIGHLIGHT = /\b(highlight|show|colou?r|mark|dikhao|dikha|dikhana|batao)\b/;
const SPOTLIGHT = /\b(visit|visiting|explore|exploring|spotlight|see|zoom (?:in )?(?:on|to|into)|close ?up( of)?|ghumo|ghoomo|dekho|dekhna|reach|arrive (?:at|in)|end at)\b/;
// words that are never part of a place name
const FILLER = /\b(by|via|take|took|taking|a|an|we|i|us|then|and then|after that|next|go|going|went|travel|travelled|traveled|ride|rode|on|in|from|se|tak|tk|ki|ka|ke|ko|aur|phir|fir|uske baad|chalo|jao|gaye|gye)\b/g;
const SPLIT = /\n|;|\.(?=\s|$)|\s+(?:and then|then|after that|phir|fir|uske baad|aur phir)\s+/i;

const ALIASES = {
  usa: 'USA', 'u.s.a': 'USA', us: 'USA', america: 'USA', 'united states of america': 'USA',
  uk: 'GBR', britain: 'GBR', 'great britain': 'GBR', england: 'GBR',
  uae: 'ARE', emirates: 'ARE', 'south korea': 'KOR', korea: 'KOR', 'north korea': 'PRK',
  'south sudan': 'SDS', 'czech republic': 'CZE', holland: 'NLD', 'ivory coast': 'CIV',
  bosnia: 'BIH', 'dominican republic': 'DOM', 'central african republic': 'CAF', drc: 'COD', congo: 'COG',
  burma: 'MMR', turkiye: 'TUR', 'türkiye': 'TUR', persia: 'IRN',
  // Hindi / Hinglish
  bharat: 'IND', hindustan: 'IND', misr: 'EGY', cheen: 'CHN', chin: 'CHN', japan: 'JPN', amrika: 'USA', angrez: 'GBR',
};

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Countries and Indian states mentioned in `text`, in the order written. Longest names first, so "South Sudan" wins over "Sudan". */
function findAreas(text, app) {
  const names = [];
  for (const c of Object.values(app.index)) names.push([c.name.toLowerCase(), { iso: c.iso }]);
  for (const [alias, iso] of Object.entries(ALIASES)) if (app.index[iso]) names.push([alias, { iso }]);
  for (const opt of document.querySelectorAll('#india-states option')) {
    const id = app.stateByName(opt.value);
    if (id) names.push([opt.value.toLowerCase(), { kind: 'state', key: id }]);
  }
  names.sort((a, b) => b[0].length - a[0].length);
  let rest = ` ${text.toLowerCase().replace(/[’']s\b/g, '')} `;
  const found = [];
  for (const [name, item] of names) {
    const re = new RegExp(`(^|[^a-z])${esc(name)}(?=[^a-z]|$)`, 'g');
    let m;
    while ((m = re.exec(rest))) {
      found.push({ pos: m.index, item });
      rest = rest.slice(0, m.index + m[1].length) + ' '.repeat(name.length) + rest.slice(m.index + m[1].length + name.length);
    }
  }
  const seen = new Set();
  return found.sort((a, b) => a.pos - b.pos).map(f => f.item).filter(it => { const k = it.iso || it.key; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** Strip mode words and filler so only the place name is left: "the pyramids" → "pyramids". */
function cleanPlace(s) {
  let out = ` ${s} `.toLowerCase();
  for (const [, re] of MODE_WORDS) out = out.replace(new RegExp(re.source, 'g'), ' ');
  out = out.replace(NEIGHBOURS, ' ').replace(new RegExp(SPOTLIGHT.source, 'g'), ' ').replace(new RegExp(HIGHLIGHT.source, 'g'), ' ');
  out = out.replace(FILLER, ' ').replace(/\b(the|to|of)\b\s*$/g, ' ').replace(/^\s*(the|to)\b/, ' ');
  return out.replace(/[,:!?"“”]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Split the text into steps: travel / highlight / neighbours / spotlight. */
export function parseTrip(text) {
  const steps = [];
  let day = null;
  // commas separate steps too, unless they're inside a list of countries ("Nepal, Bhutan and India")
  const clauses = [];
  for (const part of text.split(SPLIT)) {
    const bits = part.split(',');
    for (const b of bits) {
      const t = b.trim();
      if (!t) continue;
      const last = clauses[clauses.length - 1];
      const startsNew = /\b(to|se|tak|→|->)\b|→|->/.test(` ${t.toLowerCase()} `) || MODE_WORDS.some(([, re]) => re.test(t.toLowerCase()))
        || HIGHLIGHT.test(t.toLowerCase()) || SPOTLIGHT.test(t.toLowerCase()) || NEIGHBOURS.test(t.toLowerCase()) || /\bday\s*\d+/i.test(t);
      if (last && !startsNew && last.part === part && last.list) last.text += `, ${t}`;
      else clauses.push({ text: t, part, list: HIGHLIGHT.test(t.toLowerCase()) });
    }
  }
  for (const { text: raw } of clauses) {
    let c = raw;
    const dm = c.match(/\bday\s*(\d+)\s*[:\-–]?\s*/i);
    if (dm) { day = +dm[1]; c = c.replace(dm[0], ' ').trim(); if (!c) continue; }
    const low = c.toLowerCase();
    const mode = MODE_WORDS.find(([, re]) => re.test(low))?.[0] || null;
    const step = { raw, day };
    day = null;
    if (NEIGHBOURS.test(low)) Object.assign(step, { kind: 'neighbours' });
    else if (HIGHLIGHT.test(low) && !mode && !/\b(to|se)\b|→|->/.test(low)) Object.assign(step, { kind: 'highlight' });
    else {
      // "from X to Y", "X to Y", "X se Y (tak)", "X → Y", or just "to Y" / "Y" after a mode word
      const m = c.match(/^(?:.*?\bfrom\s+)?(.*?)\s*(?:\bto\b|\bse\b|→|->)\s*(.+?)(?:\s+tak\b.*)?$/i);
      let from = m ? cleanPlace(m[1]) : '';
      let to = m ? cleanPlace(m[2]) : cleanPlace(c);
      if (/\bse\b/i.test(c) && m) { from = cleanPlace(m[1]); to = cleanPlace(m[2]); }
      if (mode || m) Object.assign(step, { kind: 'travel', mode, from, to });
      else if (SPOTLIGHT.test(low)) Object.assign(step, { kind: 'spotlight', place: cleanPlace(c) });
      else Object.assign(step, { kind: 'place', place: cleanPlace(c) });
    }
    steps.push(step);
  }
  return steps;
}

/** Build scenes for `text`. `prev` is the scene they follow (when adding to a project). */
export async function buildTrip(text, { app, prev = null, onStatus = () => {} }) {
  const steps = parseTrip(text);
  const scenes = [], notes = [];
  let here = prev?.type === 'travel' ? prev.to : prev?.type === 'spotlight' ? prev.place : null;
  let lastMode = null;
  const cache = new Map();

  const geocode = async q => {
    if (!q) return null;
    const key = `${q}|${here ? `${here.lng.toFixed(1)},${here.lat.toFixed(1)}` : ''}`;
    if (cache.has(key)) return cache.get(key);
    onStatus(`Finding “${q}”…`);
    let place = await geocodeBest(q, here).catch(() => null);
    if (!place) {
      // fallback search (Photon)
      const r = (await searchPlaces(q, undefined, here).catch(() => []))[0];
      place = r ? { name: r.name, lng: r.lng, lat: r.lat, cc: r.cc } : null;
    }
    cache.set(key, place);
    return place;
  };

  for (const st of steps) {
    let sc = null;
    if (st.kind === 'neighbours' || st.kind === 'highlight') {
      const items = findAreas(st.raw, app);
      if (!items.length) {
        // "show the pyramids" is a place, not a country
        const p = await geocode(cleanPlace(st.raw));
        if (p) { sc = newScene('spotlight'); Object.assign(sc, { place: p, title: p.name }); here = p; }
        else notes.push(`No country or place found in “${st.raw}”.`);
      } else if (st.kind === 'neighbours') {
        const main = items.find(x => x.iso) || items[0];
        const nb = app.index[main.iso]?.nb || [];
        if (!main.iso) notes.push(`Neighbours only work for countries — showing just ${app.resolve(main)?.name}.`);
        // skip unclaimed slivers and bases (Bir Tawil, Dhekelia…): they have no real country code
        const list = [main, ...nb.filter(iso => app.index[iso] && app.index[iso].iso2 !== '-99').map(iso => ({ iso }))];
        sc = { ...newScene('highlight'), countries: list.map((x, k) => ({ ...x, color: PALETTE[k % PALETTE.length] })), dim: 0.5, caption: `${app.resolve(main)?.name} & its neighbours` };
      } else {
        sc = { ...newScene('highlight'), countries: items.map((x, k) => ({ ...x, color: PALETTE[k % PALETTE.length] })), dim: 0.45 };
      }
    } else if (st.kind === 'travel') {
      const from = st.from ? await geocode(st.from) : here;
      if (st.from && !from) { notes.push(`Couldn't find “${st.from}”.`); continue; }
      if (from) here = from;
      const to = await geocode(st.to);
      if (!to) { notes.push(`Couldn't find “${st.to || st.raw}”.`); continue; }
      if (!from) {
        // first step is just "to Goa": start there with a close-up instead
        sc = newScene('spotlight'); Object.assign(sc, { place: to, title: to.name });
      } else {
        const km = distanceKm([from.lng, from.lat], [to.lng, to.lat]);
        const mode = st.mode || (km > 700 ? 'flight' : lastMode && lastMode !== 'flight' ? lastMode : 'car');
        sc = newScene('travel');
        Object.assign(sc, {
          mode, from, to, color: MODES[mode].color, rotate: mode !== 'flight',
          duration: mode === 'flight' ? 10 : mode === 'walk' ? 7 : 8,
          ...(mode === 'flight' ? { path: 'auto' } : {}),
        });
        lastMode = mode;
      }
      here = to;
    } else {
      const p = await geocode(st.place);
      if (!p) { notes.push(`Couldn't find “${st.place || st.raw}”.`); continue; }
      if (st.kind === 'place' && here) {
        // a bare place name after another stop: travel there the same way as before
        const km = distanceKm([here.lng, here.lat], [p.lng, p.lat]);
        const mode = km > 700 ? 'flight' : lastMode && lastMode !== 'flight' ? lastMode : 'car';
        sc = newScene('travel');
        Object.assign(sc, { mode, from: here, to: p, color: MODES[mode].color, rotate: mode !== 'flight', duration: mode === 'flight' ? 10 : 8 });
        lastMode = mode;
      } else {
        sc = newScene('spotlight');
        Object.assign(sc, { place: p, title: p.name });
      }
      here = p;
    }
    if (sc) {
      if (st.day) sc.day = st.day;
      scenes.push(sc);
    }
  }
  return { scenes, notes };
}
