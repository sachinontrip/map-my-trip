// Photos and clips for pop-ups. Files live in IndexedDB (too big for localStorage);
// scenes only keep { id, kind, name }.

const DB = 'trip-map-media', STORE = 'files';
let dbp = null;
function db() {
  dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => res(req?.result);
    t.onerror = () => rej(t.error);
  });
}

export const putBlob = (id, blob) => tx('readwrite', s => s.put(blob, id));
export const getBlob = id => tx('readonly', s => s.get(id));

/** Store a user file; photos are downscaled to 1600px so projects stay light. */
export async function importFile(file) {
  const id = 'm' + Math.random().toString(36).slice(2, 10);
  const kind = file.type.startsWith('video') ? 'video' : 'image';
  let blob = file;
  if (kind === 'image') {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = new OffscreenCanvas(Math.round(bmp.width * k), Math.round(bmp.height * k));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
  }
  await putBlob(id, blob);
  return { id, kind, name: file.name };
}

const loaded = new Map();

/** Returns a ready <img>/<video> for a media id (cached). */
export function loadMedia(m) {
  if (!m?.id) return Promise.resolve(null);
  if (loaded.has(m.id)) return loaded.get(m.id);
  const p = getBlob(m.id).then(blob => new Promise(res => {
    if (!blob) return res(null);
    const url = URL.createObjectURL(blob);
    if (m.kind === 'video') {
      const v = document.createElement('video');
      Object.assign(v, { src: url, muted: true, playsInline: true, loop: true, preload: 'auto' });
      v.onloadeddata = () => res({ kind: 'video', el: v, w: v.videoWidth, h: v.videoHeight });
      v.onerror = () => res(null);
    } else {
      const img = new Image();
      img.onload = () => res({ kind: 'image', el: img, w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => res(null);
      img.src = url;
    }
  }));
  loaded.set(m.id, p);
  return p;
}

/** Seek a clip to an exact time and wait for the frame (used by export). */
export function seekVideo(v, time) {
  return new Promise(res => {
    const target = v.duration ? time % v.duration : 0;
    if (Math.abs(v.currentTime - target) < 0.001) return res();
    const done = () => { v.removeEventListener('seeked', done); res(); };
    v.addEventListener('seeked', done);
    v.currentTime = target;
    setTimeout(done, 3000);
  });
}

// project files carry media inline as data URLs so they open on any computer
const toDataURL = blob => new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(blob); });

export async function packMedia(project) {
  const out = {};
  for (const sc of project.scenes) if (sc.media?.id) {
    const b = await getBlob(sc.media.id);
    if (b) out[sc.media.id] = await toDataURL(b);
  }
  return out;
}

export async function unpackMedia(files = {}) {
  for (const [id, url] of Object.entries(files)) await putBlob(id, await (await fetch(url)).blob());
}
