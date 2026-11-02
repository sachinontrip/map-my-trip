// Frame-by-frame MP4 export: for every frame we set the time, wait until all map
// tiles are loaded, composite (stars + map + overlay) and feed it to the H.264 encoder.
// Because we wait for tiles, the video is perfectly smooth even on a slow connection.
import { Muxer, ArrayBufferTarget } from '../vendor/mp4-muxer.mjs';
import { outputSize } from './engine.js';

async function pickCodec(width, height, fps, bitrate) {
  for (const codec of ['avc1.640034', 'avc1.640033', 'avc1.4d0033', 'avc1.42003e']) {
    const cfg = { codec, width, height, bitrate, framerate: fps, bitrateMode: 'variable', avc: { format: 'avc' } };
    try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg; } catch { /* try next */ }
  }
  throw new Error(`This browser can't encode ${width}×${height} H.264. Try a lower quality or use Chrome.`);
}

export function canExport() { return typeof VideoEncoder !== 'undefined'; }

async function pickAudio(sampleRate) {
  if (typeof AudioEncoder === 'undefined') return null;
  for (const [codec, muxCodec] of [['mp4a.40.2', 'aac'], ['opus', 'opus']]) {
    const cfg = { codec, sampleRate, numberOfChannels: 2, bitrate: 192000 };
    try { if ((await AudioEncoder.isConfigSupported(cfg)).supported) return { cfg, muxCodec }; } catch { /* try next */ }
  }
  return null;
}

async function encodeAudio(buffer, cfg, muxer) {
  let err = null;
  const enc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: e => { err = e; } });
  enc.configure(cfg);
  const L = buffer.getChannelData(0), R = buffer.getChannelData(1);
  const step = 4800;
  for (let i = 0; i < buffer.length; i += step) {
    const n = Math.min(step, buffer.length - i);
    const data = new Float32Array(n * 2);
    data.set(L.subarray(i, i + n), 0);
    data.set(R.subarray(i, i + n), n);
    const ad = new AudioData({ format: 'f32-planar', sampleRate: buffer.sampleRate, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((i / buffer.sampleRate) * 1e6), data });
    enc.encode(ad);
    ad.close();
    if (err) throw err;
  }
  await enc.flush();
  enc.close();
  if (err) throw err;
}

/** 16-bit PCM WAV, for the PNG-sequence export's sound file. */
function wavBlob(buf) {
  const n = buf.length, ch = 2, out = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const str = (o, t) => { for (let i = 0; i < t.length; i++) out.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); out.setUint32(4, 36 + n * ch * 2, true); str(8, 'WAVEfmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true);
  out.setUint32(24, buf.sampleRate, true); out.setUint32(28, buf.sampleRate * ch * 2, true);
  out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true); str(36, 'data'); out.setUint32(40, n * ch * 2, true);
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  for (let i = 0, o = 44; i < n; i++, o += 4) {
    out.setInt16(o, Math.max(-1, Math.min(1, L[i])) * 0x7fff, true);
    out.setInt16(o + 2, Math.max(-1, Math.min(1, R[i])) * 0x7fff, true);
  }
  return new Blob([out], { type: 'audio/wav' });
}

async function writeFile(dir, name, blob) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(blob);
  await w.close();
}

/**
 * background: 'map' (normal MP4), 'green' (MP4 on chroma-key green, map hidden)
 * or 'png' (transparent PNG frames + sound.wav written into `dir`, a picked folder).
 */
export async function exportVideo(engine, { onProgress, signal, soundtrack = null, background = 'map', dir = null }) {
  const settings = engine.project.settings;
  const { OW, OH, pr } = outputSize(settings);
  const fps = +settings.fps || 30;
  const total = engine.timeline.total;
  const frames = Math.ceil(total * fps);
  const bitrate = Math.round(OW * OH * fps * 0.2); // ~12 Mbps at 1080p30
  const png = background === 'png';

  let encoder = null, muxer = null, audio = null, encErr = null;
  if (!png) {
    const cfg = await pickCodec(OW, OH, fps, bitrate);
    audio = soundtrack ? await pickAudio(soundtrack.sampleRate) : null;
    muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: 'avc', width: OW, height: OH, frameRate: fps },
      audio: audio ? { codec: audio.muxCodec, numberOfChannels: 2, sampleRate: soundtrack.sampleRate } : undefined,
      fastStart: 'in-memory',
    });
    encoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: e => { encErr = e; } });
    encoder.configure(cfg);
  }

  const comp = document.createElement('canvas');
  comp.width = OW; comp.height = OH;
  const ctx = comp.getContext('2d');
  const overlay = document.createElement('canvas');
  overlay.width = OW; overlay.height = OH;

  const prevPR = engine.map.getPixelRatio();
  const startT = engine.t;
  engine.exporting = true;
  engine.setPixelRatio(pr);
  if (background !== 'map') engine.setTransparent(true);
  const started = performance.now();
  try {
    if (png && soundtrack) await writeFile(dir, 'sound.wav', wavBlob(soundtrack));
    await engine.settle();
    for (let i = 0; i < frames; i++) {
      if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
      if (encErr) throw encErr;
      engine.renderAt(i / fps);
      await Promise.all([engine.settle(), engine.syncMedia(i / fps, true)]);
      ctx.clearRect(0, 0, OW, OH);
      if (background === 'map') ctx.drawImage(engine.starsEl, 0, 0, OW, OH);
      else if (background === 'green') { ctx.fillStyle = '#00ff00'; ctx.fillRect(0, 0, OW, OH); }
      ctx.drawImage(engine.map.getCanvas(), 0, 0, OW, OH);
      const octx = overlay.getContext('2d');
      octx.setTransform(1, 0, 0, 1, 0, 0);
      octx.clearRect(0, 0, OW, OH);
      engine.drawOverlay(overlay);
      ctx.drawImage(overlay, 0, 0);
      if (png) {
        const blob = await new Promise(r => comp.toBlob(r, 'image/png'));
        await writeFile(dir, `frame_${String(i + 1).padStart(5, '0')}.png`, blob);
      } else {
        const frame = new VideoFrame(comp, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
        encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
        frame.close();
        while (encoder.encodeQueueSize > 6) await new Promise(r => setTimeout(r, 5));
      }
      const el = (performance.now() - started) / 1000;
      onProgress?.({ frame: i + 1, frames, eta: el / (i + 1) * (frames - i - 1) });
    }
    if (png) return null;
    await encoder.flush();
    if (audio) await encodeAudio(soundtrack, audio.cfg, muxer);
    muxer.finalize();
    return new Blob([muxer.target.buffer], { type: 'video/mp4' });
  } finally {
    try { encoder?.close(); } catch { /* already closed */ }
    engine.exporting = false;
    if (background !== 'map') engine.setTransparent(false);
    engine.setPixelRatio(prevPR);
    engine.renderAt(startT);
  }
}
