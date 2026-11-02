// Project defaults, new-scene templates and the demo trip.
import { MODES } from './icons.js';

export const PALETTE = ['#FFB400', '#FF5A5F', '#00C2A8', '#7B61FF', '#2EC4F1', '#FF7EB6', '#8BD346', '#FF8A3D', '#4D7CFE', '#F25F5C'];

export const uid = () => Math.random().toString(36).slice(2, 9);

export function defaultSettings() {
  return {
    style: 'satellite-labels', buildings: true, terrain: false, globe: true, borders: true,
    keepRoutes: true, showDistance: true, distanceTag: true, units: 'km',
    sound: true, soundVehicle: true, soundTicks: true, soundFx: true, volume: 0.8,
    aspect: '16:9', quality: '1080', fps: 30, transition: 1.4,
    watermark: '@sachinontrip',
  };
}

const P = (name, lng, lat, cc = '') => ({ name, lng, lat, cc });

export function newScene(type, prev) {
  const last = prev?.type === 'travel' ? prev.to : prev?.type === 'spotlight' ? prev.place : null;
  if (type === 'travel') {
    return { id: uid(), type, mode: 'car', from: last || P('New Delhi', 77.209, 28.6139, 'IN'), to: P('Agra', 78.0081, 27.1767, 'IN'), duration: 8, color: MODES.car.color, path: 'auto', camera: 'cinematic', caption: '', rotate: true };
  }
  if (type === 'highlight') {
    return { id: uid(), type, countries: [{ iso: 'IND', color: PALETTE[0] }], duration: 7, dim: 0.45, keep: false, caption: '' };
  }
  return { id: uid(), type: 'spotlight', place: last || P('Taj Mahal', 78.0421, 27.1751, 'IN'), title: last?.name || 'Taj Mahal', subtitle: '', duration: 6, zoom: 15.8, orbit: 70, color: '#ff3b5c', caption: '' };
}

export function sampleProject() {
  const delhi = P('New Delhi', 77.209, 28.6139, 'IN');
  const cairo = P('Cairo', 31.2357, 30.0444, 'EG');
  const pyramid = P('Great Pyramid of Giza', 31.1342, 29.9792, 'EG');
  const sphinx = P('Great Sphinx', 31.1376, 29.9753, 'EG');
  return {
    version: 1,
    name: 'India to Egypt',
    settings: defaultSettings(),
    scenes: [
      { id: uid(), type: 'travel', mode: 'flight', from: delhi, to: cairo, duration: 10, color: '#ffffff', path: 'auto', camera: 'cinematic', caption: 'India → Egypt', rotate: false, day: 1, date: '2026-11-12' },
      {
        id: uid(), type: 'highlight', duration: 8, dim: 0.5, keep: false, caption: 'Egypt and its neighbours',
        countries: [
          { iso: 'EGY', color: '#FFB400' }, { iso: 'LBY', color: '#FF5A5F' }, { iso: 'SDN', color: '#00C2A8' },
          { iso: 'ISR', color: '#7B61FF' }, { iso: 'PSX', color: '#2EC4F1' },
        ],
      },
      { id: uid(), type: 'travel', mode: 'taxi', from: cairo, to: pyramid, duration: 9, color: '#ffc400', path: 'auto', camera: 'cinematic', caption: 'Taxi to Giza', rotate: true, day: 2, date: '2026-11-13' },
      { id: uid(), type: 'travel', mode: 'walk', from: pyramid, to: sphinx, duration: 6, color: '#00e0a4', path: 'auto', camera: 'cinematic', caption: '', rotate: true, buildings: false },
      { id: uid(), type: 'spotlight', place: pyramid, title: 'Pyramids of Giza', subtitle: 'Egypt 🇪🇬', duration: 7, zoom: 15.6, orbit: 80, color: '#ff3b5c', caption: '', buildings: false },
    ],
  };
}
