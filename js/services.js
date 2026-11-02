// Place search (Photon / OpenStreetMap) and road routing (OSRM). Both free, no key.
import { resample } from './geo.js';

/** `near` ({lng, lat}) ranks results close to it first, e.g. "the pyramids" after arriving in Cairo. */
export async function searchPlaces(q, signal, near = null) {
  const bias = near ? `&lat=${near.lat}&lon=${near.lng}&location_bias_scale=0.4` : '';
  const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=7&lang=en${bias}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error('Search failed');
  const data = await res.json();
  return data.features.map(f => {
    const p = f.properties;
    const sub = [p.city !== p.name ? p.city : null, p.state, p.country].filter(Boolean).join(', ');
    return { name: p.name, sub, lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], cc: (p.countrycode || '').toUpperCase(), kind: p.osm_value };
  });
}

/**
 * Best single match for a typed place name, ranked by how well-known it is (OpenStreetMap / Nominatim),
 * nudged towards `near` so "the pyramids" after Cairo finds Giza. Used by "Type your trip".
 */
let lastNominatim = 0;
export async function geocodeBest(q, near = null) {
  const wait = 1100 - (Date.now() - lastNominatim); // Nominatim allows one request per second
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastNominatim = Date.now();
  const vb = near ? `&viewbox=${near.lng - 1.5},${near.lat + 1.5},${near.lng + 1.5},${near.lat - 1.5}&bounded=0` : '';
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&addressdetails=1&accept-language=en&q=${encodeURIComponent(q)}${vb}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Search failed');
  const r = (await res.json())[0];
  return r ? { name: r.name || r.display_name.split(',')[0], lng: +(+r.lon).toFixed(5), lat: +(+r.lat).toFixed(5), cc: (r.address?.country_code || '').toUpperCase() } : null;
}

/** A rough circle polygon, for places OSM only knows as a point. */
function circle([lng, lat], km, n = 64) {
  const ring = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    ring.push([+(lng + (km / (111.32 * Math.cos(lat * Math.PI / 180))) * Math.cos(a)).toFixed(4), +(lat + (km / 110.57) * Math.sin(a)).toFixed(4)]);
  }
  return { type: 'Polygon', coordinates: [ring] };
}

/** States, districts, cities, islands… with their real outline (OpenStreetMap / Nominatim). */
export async function searchAreas(q) {
  // dedupe=0: otherwise OSM merges a city's boundary into its centre point and we lose the outline
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&polygon_geojson=1&polygon_threshold=0.003&limit=10&dedupe=0&accept-language=en&q=${encodeURIComponent(q)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Search failed');
  const data = (await res.json()).sort((a, b) => (/Polygon/.test(b.geojson?.type) ? 1 : 0) - (/Polygon/.test(a.geojson?.type) ? 1 : 0));
  const seen = new Set();
  return data.filter(r => { const k = r.display_name; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 6).map(r => {
    const poly = r.geojson && /Polygon/.test(r.geojson.type);
    const km = r.addresstype === 'city' ? 7 : r.addresstype === 'town' ? 3 : 1.2;
    const geometry = poly ? r.geojson : circle([+r.lon, +r.lat], km);
    const parts = r.display_name.split(', ');
    return {
      kind: 'osm', key: `osm:${r.osm_type}${r.osm_id}`, name: r.name || parts[0],
      sub: `${r.addresstype || r.type} · ${parts.slice(1).slice(-2).join(', ')}`,
      lx: +(+r.lon).toFixed(4), ly: +(+r.lat).toFixed(4), geometry, outline: poly,
    };
  });
}

const PROFILES = {
  walk: 'https://routing.openstreetmap.de/routed-foot/route/v1/driving',
  bike: 'https://router.project-osrm.org/route/v1/driving',
  default: 'https://router.project-osrm.org/route/v1/driving',
};

const cache = new Map();

/** Returns [[lng,lat],...] following roads/footpaths, or throws. */
export async function fetchRoute(from, to, mode) {
  const key = `${mode}:${from.lng.toFixed(5)},${from.lat.toFixed(5)};${to.lng.toFixed(5)},${to.lat.toFixed(5)}`;
  if (cache.has(key)) return cache.get(key);
  const base = PROFILES[mode] || PROFILES.default;
  const url = `${base}/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
  const p = fetch(url).then(r => r.json()).then(d => {
    if (d.code !== 'Ok' || !d.routes?.length) throw new Error(d.message || 'No route found');
    return resample(d.routes[0].geometry.coordinates, 1800);
  });
  cache.set(key, p);
  p.catch(() => cache.delete(key));
  return p;
}
