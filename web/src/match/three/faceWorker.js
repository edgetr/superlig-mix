// Face worker: runs MediaPipe Face Landmarker (478 landmarks + iris), the hair segmenter and the
// selfie (person) segmenter on each player portrait off the main thread, then fits the photo onto the 3D head
// (faceFit.js). Models are hosted with the app (web/public/mediapipe), the Wasm runtime ships from
// the @mediapipe/tasks-vision package (Apache-2.0), so it works offline.
import { FaceLandmarker, ImageSegmenter } from '@mediapipe/tasks-vision';
import classicLoader from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import classicWasm from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';
import { fitPhoto } from './faceFit.js';

let base = '/', models = null, head = null, fitData = null;

function isModuleWorker() { try { importScripts('data:text/javascript,'); return false; } catch { return true; } }

async function load() {
  return (models ||= (async () => {
    // Load the Wasm loader ourselves (Vite runs workers as ES modules in dev and as classic scripts
    // in the build; a module worker can't importScripts, so it evaluates the same script globally).
    // Every task instantiates its own runtime from the factory, which MediaPipe clears after use.
    if (isModuleWorker()) (0, eval)(await (await fetch(abs(classicLoader))).text());
    else importScripts(abs(classicLoader));
    const factory = self.ModuleFactory;
    if (!factory) throw new Error('MediaPipe loader failed');
    const prime = () => { self.ModuleFactory = factory; };
    const fileset = { wasmLoaderPath: '', wasmBinaryPath: abs(classicWasm) };
    prime();
    const landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: base + 'mediapipe/face_landmarker.task', delegate: 'CPU' },
      runningMode: 'IMAGE', numFaces: 1, minFaceDetectionConfidence: 0.3, minFacePresenceConfidence: 0.3,
    });
    let hair = null;
    try {
      prime();
      hair = await ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: base + 'mediapipe/hair_segmenter.tflite', delegate: 'CPU' },
        runningMode: 'IMAGE', outputCategoryMask: false, outputConfidenceMasks: true,
      });
    } catch (e) { console.warn('hair segmenter unavailable', e); }
    let person = null;
    try {
      prime();
      person = await ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: base + 'mediapipe/selfie_segmenter.tflite', delegate: 'CPU' },
        runningMode: 'IMAGE', outputCategoryMask: false, outputConfidenceMasks: true,
      });
    } catch (e) { console.warn('person segmenter unavailable', e); }
    return { landmarker, hair, person };
  })());
}
const abs = u => new URL(u, self.location.href).href;

// Confidence mask of a segmenter (last class: hair for the hair model, person for the selfie model),
// resampled to the photo size.
function hairMask(seg, bitmap, w, h) {
  if (!seg) return null;
  const r = seg.segment(bitmap);
  const masks = r.confidenceMasks || [];
  const m = masks[masks.length - 1];
  if (!m) { r.close?.(); return null; }
  const f = m.getAsFloat32Array();
  const mw = m.width, mh = m.height;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = Math.min(mw - 1, Math.floor((x / w) * mw)), sy = Math.min(mh - 1, Math.floor((y / h) * mh));
    out[y * w + x] = Math.round(Math.min(1, Math.max(0, f[sy * mw + sx])) * 255);
  }
  r.close?.();
  return out;
}

async function analyze(bitmap) {
  const w = bitmap.width, h = bitmap.height;
  let mp = null;
  try { mp = await load(); } catch (e) { console.warn('MediaPipe unavailable, using the photo framing heuristic', e); }
  let lm = null, hm = null, pm = null;
  if (mp) {
    const L = mp.landmarker.detect(bitmap).faceLandmarks?.[0];
    if (L && L.length >= 478) {
      lm = new Float32Array(478 * 3);
      for (let i = 0; i < 478; i++) { lm[i * 3] = L[i].x * w; lm[i * 3 + 1] = L[i].y * h; lm[i * 3 + 2] = L[i].z * w; }
    }
    try { hm = hairMask(mp.hair, bitmap, w, h); } catch (e) { console.warn('hair segmentation failed', e); }
    try { pm = hairMask(mp.person, bitmap, w, h); } catch (e) { console.warn('person segmentation failed', e); }
  }
  return { ok: !!lm, w, h, lm, hair: hm, person: pm };
}

// No landmarks: place the head the way Transfermarkt frames portraits (head ≈ 84 % of the width,
// hair touching the top), centred on the silhouette at forehead height, and project the head's own
// landmarks with that framing so the rest of the pipeline works unchanged.
function framingLandmarks(px, w, h) {
  const at = (x, y, k) => px[(y * w + x) * 4 + k];
  const bg = [0, 1, 2].map(k => (at(1, 1, k) + at(w - 2, 1, k) + at(1, 5, k) + at(w - 2, 5, k)) / 4);
  const fg = (x, y) => Math.abs(at(x, y, 0) - bg[0]) + Math.abs(at(x, y, 1) - bg[1]) + Math.abs(at(x, y, 2) - bg[2]) > 60;
  const ws = [], cs = [];
  for (let y = Math.round(h * 0.14); y < Math.round(h * 0.24); y++) {
    let a = -1, b = -1;
    for (let x = 0; x < w; x++) if (fg(x, y)) { if (a < 0) a = x; b = x; }
    if (a >= 0 && b - a > w * 0.05) { ws.push((b - a) / w); cs.push((a + b) / 2 / w); }
  }
  const med = v => v.sort((p, q) => p - q)[Math.floor(v.length / 2)];
  const fw = ws.length ? med(ws) : 0.84, cx = cs.length ? med(cs) : 0.5;
  const su = Math.min(0.97, Math.max(0.76, 0.86 * (fw / 0.84))), ou = Math.min(0.2, Math.max(-0.05, cx - su / 2));
  const H = head.head, hw = (H.x1 - H.x0) / 2;
  const lm = new Float32Array(478 * 3);
  fitData.points.forEach((P, i) => {
    if (!P) return;
    const u = 0.5 + P[0] / (2 * hw), v = (P[1] - H.chin) / (H.top - H.chin);
    lm[i * 3] = (u * su + ou) * w; lm[i * 3 + 1] = (1 - (v * 0.78 + 0.14)) * h;
  });
  return lm;
}

self.onmessage = async ({ data: m }) => {
  if (m.type === 'init') { base = m.base; head = m.head || null; fitData = m.fit || null; if (m.preload) load().catch(() => {}); return; }
  if (m.type !== 'analyze') return;
  const t0 = performance.now();
  try {
    const a = await analyze(m.bitmap);
    if (m.noLandmarks) { a.lm = null; a.ok = false; } // testing the fallback
    let fit = null;
    if (head && fitData && m.fit !== false) {
      const cv = new OffscreenCanvas(a.w, a.h);
      const cx = cv.getContext('2d', { willReadFrequently: true });
      cx.drawImage(m.bitmap, 0, 0);
      const px = cx.getImageData(0, 0, a.w, a.h).data;
      const heuristic = !a.lm;
      fit = fitPhoto({ ...a, lm: a.lm || framingLandmarks(px, a.w, a.h), px, heuristic }, head, fitData);
    }
    m.bitmap.close?.();
    const tr = [];
    if (a.lm) tr.push(a.lm.buffer);
    if (fit) for (const v of Object.values(fit)) if (ArrayBuffer.isView(v)) tr.push(v.buffer);
    self.postMessage({ id: m.id, ok: a.ok, w: a.w, h: a.h, lm: a.lm, hair: m.wantHair ? a.hair : null, fit, ms: performance.now() - t0 }, [...new Set(tr)]);
  } catch (e) {
    console.warn('face analysis failed', e);
    self.postMessage({ id: m.id, ok: false, error: String(e?.message || e) });
  }
};
