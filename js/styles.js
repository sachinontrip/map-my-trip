// Base map looks + the custom layers we draw on top (countries, routes, 3D buildings, terrain).
// Every source here is free and needs no API key.

const OFM_GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
const OFM_TILES = 'https://tiles.openfreemap.org/planet';
const ESRI_SAT = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const TERRAIN = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

function satelliteStyle({ labels = false, night = false } = {}) {
  const style = {
    version: 8,
    glyphs: OFM_GLYPHS,
    sources: {
      sat: { type: 'raster', tiles: [ESRI_SAT], tileSize: 256, maxzoom: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' },
      omt: { type: 'vector', url: OFM_TILES, attribution: '© OpenFreeMap © OpenMapTiles © OpenStreetMap' },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#070b16' } },
      {
        id: 'sat', type: 'raster', source: 'sat',
        paint: night
          ? { 'raster-brightness-max': 0.55, 'raster-saturation': -0.35, 'raster-contrast': 0.15, 'raster-hue-rotate': 10 }
          : { 'raster-saturation': 0.12, 'raster-contrast': 0.06 },
      },
    ],
  };
  if (labels) {
    const txt = (id, filter, size, extra = {}) => ({
      id, type: 'symbol', source: 'omt', 'source-layer': 'place', filter,
      layout: {
        'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
        'text-font': ['Noto Sans Bold'], 'text-size': size, 'text-max-width': 8, ...extra,
      },
      paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(0,0,0,0.75)', 'text-halo-width': 1.4 },
    });
    style.layers.push(
      txt('lbl-country', ['==', ['get', 'class'], 'country'], ['interpolate', ['linear'], ['zoom'], 2, 11, 6, 16], { 'text-transform': 'uppercase', 'text-letter-spacing': 0.08 }),
      txt('lbl-city', ['in', ['get', 'class'], ['literal', ['city', 'town']]], ['interpolate', ['linear'], ['zoom'], 4, 10, 12, 17]),
      txt('lbl-local', ['in', ['get', 'class'], ['literal', ['village', 'suburb', 'neighbourhood']]], 12, { 'text-optional': true }),
    );
  }
  return style;
}

export const STYLES = [
  { id: 'satellite', name: 'Satellite', swatch: 'linear-gradient(135deg,#2c4a2e,#1d3b5a 60%,#a88f62)', style: () => satelliteStyle(), dark: true },
  { id: 'satellite-labels', name: 'Satellite + names', swatch: 'linear-gradient(135deg,#2c4a2e,#1d3b5a 60%,#a88f62)', style: () => satelliteStyle({ labels: true }), dark: true },
  { id: 'satellite-night', name: 'Cinematic dark', swatch: 'linear-gradient(135deg,#0d1424,#1b2638 60%,#3c3a33)', style: () => satelliteStyle({ labels: true, night: true }), dark: true },
  { id: 'liberty', name: 'Streets 3D', swatch: 'linear-gradient(135deg,#f3efe6,#c9e1f0 60%,#cfe3c0)', style: () => 'https://tiles.openfreemap.org/styles/liberty' },
  { id: 'bright', name: 'Bright', swatch: 'linear-gradient(135deg,#fff8e1,#9fd3f5 60%,#b8e0a0)', style: () => 'https://tiles.openfreemap.org/styles/bright' },
  { id: 'voyager', name: 'Voyager', swatch: 'linear-gradient(135deg,#faf7f2,#d4e7f3 60%,#f2d7b5)', style: () => 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json' },
  { id: 'light', name: 'Minimal light', swatch: 'linear-gradient(135deg,#fafafa,#e6eaee)', style: () => 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json' },
  { id: 'dark', name: 'Minimal dark', swatch: 'linear-gradient(135deg,#1a1d24,#2b303a)', style: () => 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json', dark: true },
  { id: 'paper', name: 'Vintage paper', swatch: 'linear-gradient(135deg,#efe4cc,#a9c4c0)', style: () => 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json', transform: paperify },
];

/** Recolour the minimal light style into an old-atlas look. */
function paperify(style) {
  for (const l of style.layers) {
    const id = l.id.toLowerCase();
    if (l.type === 'background') l.paint = { ...l.paint, 'background-color': '#efe4cc' };
    else if (l.type === 'fill' && id.includes('water')) l.paint = { ...l.paint, 'fill-color': '#a9c4c0' };
    else if (l.type === 'fill' && /park|landcover|wood|grass/.test(id)) l.paint = { ...l.paint, 'fill-color': '#dfd5b5' };
    else if (l.type === 'line' && /road|highway|street|tunnel|bridge/.test(id)) l.paint = { ...l.paint, 'line-color': '#d6c7a4' };
    else if (l.type === 'symbol' && l.paint) l.paint = { ...l.paint, 'text-color': '#5b4a33', 'text-halo-color': '#efe4cc' };
  }
  return style;
}

export function styleDef(id) { return STYLES.find(s => s.id === id) || STYLES[0]; }

/** Load a style (URL or object) into a plain object so we can tweak it before applying. */
export async function resolveStyle(def) {
  let s = def.style();
  if (typeof s === 'string') s = await (await fetch(s)).json();
  else s = structuredClone(s);
  if (def.transform) s = def.transform(s);
  return s;
}

/**
 * Add our own sources/layers on top of a freshly loaded base style.
 * Called on every style load, because switching style wipes custom layers.
 */
export function addCustomLayers(map, countries, settings, def) {
  const layers = map.getStyle().layers;
  const firstSymbol = layers.find(l => l.type === 'symbol')?.id;

  // Basemap borders come from OSM; we draw our own (India-view Natural Earth) for consistency.
  for (const l of layers) {
    if (l['source-layer'] === 'boundary' || /boundary|admin/.test(l.id)) {
      if (l.type === 'line') map.setLayoutProperty(l.id, 'visibility', 'none');
    }
    // Hide the style's own extrusions so ours (styled per theme) are the only 3D buildings.
    if (l.type === 'fill-extrusion') map.setLayoutProperty(l.id, 'visibility', 'none');
  }

  // NASA "Black Marble" Earth at night, faded in by night-time travel scenes (hidden otherwise)
  if (!map.getSource('night-lights')) {
    map.addSource('night-lights', {
      type: 'raster', tileSize: 256, maxzoom: 8,
      tiles: ['https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png'],
      attribution: 'Night lights: NASA Earth Observatory',
    });
  }
  map.addLayer({ id: 'night-lights', type: 'raster', source: 'night-lights', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0, 'raster-fade-duration': 0 } }, firstSymbol);

  if (!map.getSource('omt-b')) map.addSource('omt-b', { type: 'vector', url: OFM_TILES });

  // night close-ups: streets glow like sodium lamps (the satellite photo itself is daytime)
  const roads = ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'street']]];
  const major = ['match', ['get', 'class'], ['motorway', 'trunk', 'primary'], 1, 0.55];
  map.addLayer({
    id: 'night-roads-glow', type: 'line', source: 'omt-b', 'source-layer': 'transportation', minzoom: 8, filter: roads,
    layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ff9a3c', 'line-blur': ['interpolate', ['linear'], ['zoom'], 8, 2, 16, 10], 'line-opacity': 0,
      'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 8, ['*', 2, major], 12, ['*', 5, major], 16, ['*', 18, major]] },
  }, firstSymbol);
  map.addLayer({
    id: 'night-roads', type: 'line', source: 'omt-b', 'source-layer': 'transportation', minzoom: 8, filter: roads,
    layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['match', ['get', 'class'], ['motorway', 'trunk'], '#ffd9a0', '#ffc070'], 'line-blur': 0.6, 'line-opacity': 0,
      'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 8, ['*', 0.5, major], 12, ['*', 1.6, major], 16, ['*', 4.5, major]] },
  }, firstSymbol);
  map.addLayer({
    id: 'my-buildings', type: 'fill-extrusion', source: 'omt-b', 'source-layer': 'building', minzoom: 13,
    layout: { visibility: settings.buildings ? 'visible' : 'none' },
    paint: {
      'fill-extrusion-color': def.dark ? '#cfc8bd' : '#e6e1d8',
      'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8],
      'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
      'fill-extrusion-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0, 14.2, 0.92],
      'fill-extrusion-vertical-gradient': true,
    },
  }, firstSymbol);

  map.addSource('countries', { type: 'geojson', data: countries, promoteId: 'iso', tolerance: 0.2 });
  map.addLayer({
    id: 'cty-dim', type: 'fill', source: 'countries',
    paint: { 'fill-color': '#000814', 'fill-opacity': ['*', ['coalesce', ['feature-state', 'dim'], 0], ['-', 1, ['coalesce', ['feature-state', 'a'], 0]]] },
  }, firstSymbol);
  map.addLayer({
    id: 'cty-fill', type: 'fill', source: 'countries',
    paint: { 'fill-color': ['to-color', ['coalesce', ['feature-state', 'color'], '#ffffff']], 'fill-opacity': ['*', 0.55, ['coalesce', ['feature-state', 'a'], 0]] },
  }, firstSymbol);
  map.addLayer({
    id: 'cty-borders', type: 'line', source: 'countries',
    layout: { visibility: settings.borders ? 'visible' : 'none', 'line-join': 'round' },
    paint: { 'line-color': def.dark ? 'rgba(255,255,255,0.55)' : 'rgba(60,60,70,0.45)', 'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.4, 6, 1.2] },
  }, firstSymbol);
  map.addLayer({
    id: 'cty-glow', type: 'line', source: 'countries',
    layout: { 'line-join': 'round' },
    paint: {
      'line-color': ['to-color', ['coalesce', ['feature-state', 'color'], '#ffffff']],
      'line-width': 10, 'line-blur': 8,
      'line-opacity': ['*', 0.9, ['coalesce', ['feature-state', 'a'], 0]],
    },
  });
  map.addLayer({
    id: 'cty-line', type: 'line', source: 'countries',
    layout: { 'line-join': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': 2, 'line-opacity': ['coalesce', ['feature-state', 'a'], 0] },
  });

  // States / cities / regions highlighted inside a country
  map.addSource('areas', { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, promoteId: 'key', tolerance: 0.1 });
  map.addLayer({
    id: 'area-fill', type: 'fill', source: 'areas',
    paint: { 'fill-color': ['to-color', ['coalesce', ['feature-state', 'color'], '#ffffff']], 'fill-opacity': ['*', 0.6, ['coalesce', ['feature-state', 'a'], 0]] },
  }, firstSymbol);
  map.addLayer({
    id: 'area-borders', type: 'line', source: 'areas', filter: ['==', ['get', 'kind'], 'state'],
    layout: { 'line-join': 'round' },
    paint: { 'line-color': def.dark ? '#ffffff' : '#3c3c46', 'line-width': 0.9, 'line-opacity': 0 },
  });
  map.addLayer({
    id: 'area-glow', type: 'line', source: 'areas', layout: { 'line-join': 'round' },
    paint: { 'line-color': ['to-color', ['coalesce', ['feature-state', 'color'], '#ffffff']], 'line-width': 9, 'line-blur': 7, 'line-opacity': ['*', 0.9, ['coalesce', ['feature-state', 'a'], 0]] },
  });
  map.addLayer({
    id: 'area-line', type: 'line', source: 'areas', layout: { 'line-join': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': 1.8, 'line-opacity': ['coalesce', ['feature-state', 'a'], 0] },
  });

  // Routes: one source, separate layers per line style (dash patterns can't be data-driven).
  map.addSource('routes', { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, lineMetrics: true });
  const col = ['get', 'color'];
  const join = { 'line-join': 'round', 'line-cap': 'round' };
  map.addLayer({ id: 'rt-glow', type: 'line', source: 'routes', layout: join, paint: { 'line-color': col, 'line-width': 14, 'line-blur': 10, 'line-opacity': ['*', 0.55, ['get', 'op']] } });
  map.addLayer({ id: 'rt-casing', type: 'line', source: 'routes', filter: ['!=', ['get', 'kind'], 'dot'], layout: join, paint: { 'line-color': 'rgba(0,0,0,0.45)', 'line-width': 7, 'line-opacity': ['get', 'op'] } });
  map.addLayer({ id: 'rt-solid', type: 'line', source: 'routes', filter: ['==', ['get', 'kind'], 'solid'], layout: join, paint: { 'line-color': col, 'line-width': 4.5, 'line-opacity': ['get', 'op'] } });
  map.addLayer({ id: 'rt-dash-base', type: 'line', source: 'routes', filter: ['==', ['get', 'kind'], 'dash'], layout: join, paint: { 'line-color': col, 'line-width': 4, 'line-opacity': ['*', 0.35, ['get', 'op']] } });
  map.addLayer({ id: 'rt-dash', type: 'line', source: 'routes', filter: ['==', ['get', 'kind'], 'dash'], layout: { 'line-join': 'round' }, paint: { 'line-color': col, 'line-width': 4, 'line-dasharray': [2, 1.6], 'line-opacity': ['get', 'op'] } });
  map.addLayer({ id: 'rt-rail', type: 'line', source: 'routes', filter: ['==', ['get', 'kind'], 'rail'], layout: join, paint: { 'line-color': col, 'line-width': 4, 'line-opacity': ['get', 'op'] } });
  map.addLayer({ id: 'rt-rail-ties', type: 'line', source: 'routes', filter: ['==', ['get', 'kind'], 'rail'], layout: { 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 9, 'line-dasharray': [0.25, 1.4], 'line-opacity': ['*', 0.9, ['get', 'op']] } });
  map.addLayer({ id: 'rt-dot', type: 'line', source: 'routes', filter: ['==', ['get', 'kind'], 'dot'], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': col, 'line-width': 6, 'line-dasharray': [0.01, 2], 'line-opacity': ['get', 'op'] } });

  if (!map.getSource('dem')) map.addSource('dem', { type: 'raster-dem', tiles: [TERRAIN], tileSize: 256, maxzoom: 14, encoding: 'terrarium' });
  applyEnvironment(map, settings, def);
}

/** Globe / terrain / sky / buildings toggles that can change without reloading the style. */
export function applyEnvironment(map, settings, def) {
  map.setProjection({ type: settings.globe ? 'globe' : 'mercator' });
  map.setTerrain(settings.terrain ? { source: 'dem', exaggeration: 1.35 } : null);
  if (map.getLayer('my-buildings')) map.setLayoutProperty('my-buildings', 'visibility', settings.buildings ? 'visible' : 'none');
  if (map.getLayer('cty-borders')) map.setLayoutProperty('cty-borders', 'visibility', settings.borders ? 'visible' : 'none');
  map.setSky({
    'sky-color': def.dark ? '#0a1a33' : '#7fb6ff',
    'horizon-color': def.dark ? '#5d84b8' : '#e9f2ff',
    'fog-color': def.dark ? '#22324d' : '#ffffff',
    'sky-horizon-blend': 0.6,
    'horizon-fog-blend': 0.6,
    'fog-ground-blend': 0.85,
    'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 8, 0],
  });
}
