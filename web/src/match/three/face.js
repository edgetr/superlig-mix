// Player faces from their portrait photos.
//
// 1. faceWorker.js (off the main thread): MediaPipe Face Landmarker finds the 478 face landmarks
//    and the hair segmenter the hair; faceFit.js maps the photo onto the head (camera + thin-plate
//    spline through the same landmarks found once on the MakeHuman head, models/face_fit.json),
//    measures skin / hair / beard / eye colours, the photo's lighting and the hair volume, and
//    gives every head vertex its photo position, hair weight and a small shape offset.
// 2. Here, once per player: the photo is baked on the GPU into a 512² head texture laid out on the
//    head's UV atlas — de-lit face, the real hairline and hair where the photo sees it, procedural
//    hair and skin elsewhere, all converging to the body's skin tone so there is no seam — then
//    padded across UV seams and mip-mapped. The player also gets his own head shape and hair
//    volume (per-player position/normal/hairW attributes sharing the rest of the body geometry).
// Players without a photo, or whose photo can't be read, keep the plain procedural head.
import * as THREE from 'three';
import { headInfo, FACE_RECT } from './headModel.js';

const BASE = import.meta.env?.BASE_URL || '/';
const SIZE = 384;               // head atlas (whole head: hair, ears, neck)
const HI_W = 384, HI_H = 512;   // front view of the face

let worker = null, seq = 0, workerInit = null;
const pending = new Map();
function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./faceWorker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => { const p = pending.get(data.id); if (p) { pending.delete(data.id); p(data); } };
  worker.onerror = e => { console.warn('face worker failed', e.message || e); for (const p of pending.values()) p({ ok: false }); pending.clear(); };
  worker.postMessage({ type: 'init', base: BASE, ...(workerInit || {}) });
  return worker;
}
// The worker holds the MediaPipe runtime (tens of MB): let it go once the photos are done.
let idleTimer = 0;
function call(msg, transfer) {
  clearTimeout(idleTimer);
  return new Promise(res => {
    const id = ++seq;
    pending.set(id, d => { res(d); if (!pending.size) idleTimer = setTimeout(() => { if (!pending.size && worker) { worker.terminate(); worker = null; } }, 20000); });
    getWorker().postMessage({ ...msg, id }, transfer);
  });
}

// Landmarks only (lab / tooling).
export async function detectFace(bitmap) {
  return call({ type: 'analyze', bitmap, fit: false, wantHair: true }, [bitmap]);
}

export function createFaces(renderer, body) {
  const info = headInfo(body);
  const nv = info.idx.length;
  const fitP = fetch(`${BASE}models/face_fit.json`).then(r => r.json()).catch(() => null);
  let ready = null;
  const init = () => (ready ||= fitP.then(fit => {
    if (!fit) return false;
    workerInit = { head: { idx: info.idx, P: info.P, N: info.N, UV: info.UV, R: info.R, zc: info.zc, head: info.head, eyes: info.eyes }, fit };
    if (worker) worker.postMessage({ type: 'init', base: BASE, ...workerInit }); else getWorker();
    return true;
  }));

  // ---------------------------------------------------------------- bake geometry (atlas space)
  const local = new Int32Array(body.geo.attributes.position.count).fill(-1);
  info.idx.forEach((v, k) => { local[v] = k; });
  const bodyIndex = body.geo.index.array;
  const tri = [];
  for (let t = 0; t < bodyIndex.length; t += 3) {
    const a = local[bodyIndex[t]], b = local[bodyIndex[t + 1]], c = local[bodyIndex[t + 2]];
    if (a < 0 || b < 0 || c < 0) continue;
    if (info.UV[a * 2] < 0 || info.UV[b * 2] < 0 || info.UV[c * 2] < 0) continue;
    tri.push(a, b, c);
  }
  const atlasPos = new Float32Array(nv * 3);
  for (let k = 0; k < nv; k++) { atlasPos[k * 3] = info.UV[k * 2] * 2 - 1; atlasPos[k * 3 + 1] = info.UV[k * 2 + 1] * 2 - 1; }
  const bakeIndex = new THREE.BufferAttribute(new Uint16Array(tri), 1);
  const triHi = [];
  for (let t = 0; t < bodyIndex.length; t += 3) {
    const a = local[bodyIndex[t]], b = local[bodyIndex[t + 1]], c = local[bodyIndex[t + 2]];
    if (a < 0 || b < 0 || c < 0) continue;
    if (info.R[a] === 5 || info.R[b] === 5 || info.R[c] === 5) continue;
    if (info.UV[a * 2] < -1.5 || info.UV[b * 2] < -1.5 || info.UV[c * 2] < -1.5) continue;
    triHi.push(a, b, c);
  }
  const hiIndex = new THREE.BufferAttribute(new Uint16Array(triHi), 1);
  const hiCam = new THREE.OrthographicCamera(FACE_RECT.x0, FACE_RECT.x1, FACE_RECT.y1, FACE_RECT.y0, -1, 1);
  const aPos = new THREE.BufferAttribute(atlasPos, 3), aRest = new THREE.BufferAttribute(info.P, 3), aNrm = new THREE.BufferAttribute(info.N, 3);

  const bakeMat = new THREE.ShaderMaterial({
    uniforms: {
      uPhoto: { value: null }, uMask: { value: null }, uSkin: { value: new THREE.Color() }, uHair: { value: new THREE.Color() }, uHairS: { value: new THREE.Color() }, uBeard: { value: new THREE.Color() },
      uLight: { value: new THREE.Vector4(1, 0, 0, 0) }, uDelight: { value: 0.8 }, uFaceTrust: { value: 1 }, uBg: { value: new THREE.Color() }, uFlat: { value: 1 },
      uShineT: { value: 1 }, uChroma: { value: new THREE.Vector3(1, 1, 1) },
    },
    vertexShader: BAKE_VS, fragmentShader: BAKE_FS, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
  });
  const bakeHiMat = bakeMat.clone();
  bakeHiMat.uniforms = bakeMat.uniforms; bakeHiMat.depthTest = true; bakeHiMat.depthWrite = true;
  const dilateMat = new THREE.ShaderMaterial({
    uniforms: { uTex: { value: null }, uStep: { value: 1 } },
    vertexShader: QUAD_VS, fragmentShader: DILATE_FS, depthTest: false, depthWrite: false,
  });
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), dilateMat); quad.frustumCulled = false;
  const quadScene = new THREE.Scene(); quadScene.add(quad);
  const hiScratch = new THREE.WebGLRenderTarget(HI_W, HI_H, { type: THREE.HalfFloatType, depthBuffer: true, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false });
  const scratch = [0, 1].map(() => new THREE.WebGLRenderTarget(SIZE, SIZE, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false }));

  // Position groups: vertices split on UV seams share a position; their normals must stay equal.
  const posArr = body.geo.attributes.position.array, nrmArr = body.geo.attributes.normal.array;
  const group = new Int32Array(posArr.length / 3);
  {
    const m = new Map();
    for (let i = 0; i < group.length; i++) {
      const key = `${posArr[i * 3].toFixed(5)},${posArr[i * 3 + 1].toFixed(5)},${posArr[i * 3 + 2].toFixed(5)}`;
      let g = m.get(key); if (g == null) { g = i; m.set(key, g); }
      group[i] = g;
    }
  }
  const headTris = [];
  for (let t = 0; t < bodyIndex.length; t += 3) if (local[bodyIndex[t]] >= 0 || local[bodyIndex[t + 1]] >= 0 || local[bodyIndex[t + 2]] >= 0) headTris.push(bodyIndex[t], bodyIndex[t + 1], bodyIndex[t + 2]);

  // Per-player attributes only (the shared body attributes stay alive).
  function disposeOwn(g) {
    const a = g.attributes;
    g.attributes = { position: a.position, normal: a.normal, hairW: a.hairW }; g.index = null;
    g.dispose();
  }
  function playerGeometry(r) {
    const g = new THREE.BufferGeometry();
    for (const [k, v] of Object.entries(body.geo.attributes)) g.setAttribute(k, v);
    g.setIndex(body.geo.index);
    g.boundingSphere = body.geo.boundingSphere;
    const pos = posArr.slice(), nrm = nrmArr.slice(), hairW = new Float32Array(pos.length / 3);
    for (let k = 0; k < nv; k++) {
      const v = info.idx[k];
      pos[v * 3] += r.off[k * 3]; pos[v * 3 + 1] += r.off[k * 3 + 1]; pos[v * 3 + 2] += r.off[k * 3 + 2];
      hairW[v] = r.hairW[k];
    }
    // Re-derive head normals from the reshaped surface.
    const acc = new Float32Array(pos.length);
    for (let t = 0; t < headTris.length; t += 3) {
      const a = headTris[t] * 3, b = headTris[t + 1] * 3, c = headTris[t + 2] * 3;
      const e1x = pos[b] - pos[a], e1y = pos[b + 1] - pos[a + 1], e1z = pos[b + 2] - pos[a + 2];
      const e2x = pos[c] - pos[a], e2y = pos[c + 1] - pos[a + 1], e2z = pos[c + 2] - pos[a + 2];
      const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      for (const o of [headTris[t], headTris[t + 1], headTris[t + 2]]) { const q = group[o] * 3; acc[q] += nx; acc[q + 1] += ny; acc[q + 2] += nz; }
    }
    for (let k = 0; k < nv; k++) {
      const v = info.idx[k];
      if (info.R[k] === 5) continue; // eyeballs only move
      const q = group[v] * 3, l = Math.hypot(acc[q], acc[q + 1], acc[q + 2]);
      if (l > 0) { nrm[v * 3] = acc[q] / l; nrm[v * 3 + 1] = acc[q + 1] / l; nrm[v * 3 + 2] = acc[q + 2] / l; }
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('hairW', new THREE.BufferAttribute(hairW, 1));
    return g;
  }

  function bake(img, r) {
    const p = r.params;
    const photo = new THREE.Texture(img);
    photo.colorSpace = THREE.SRGBColorSpace; photo.flipY = false; photo.generateMipmaps = false; photo.minFilter = THREE.LinearFilter; photo.needsUpdate = true;
    const mask = new THREE.DataTexture(r.masks, r.w, r.h, THREE.RGBAFormat, THREE.UnsignedByteType);
    mask.flipY = false; mask.minFilter = THREE.LinearFilter; mask.magFilter = THREE.LinearFilter; mask.needsUpdate = true;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', aPos);
    geo.setAttribute('aRest', aRest);
    geo.setAttribute('aNrm', aNrm);
    geo.setAttribute('aPhoto', new THREE.BufferAttribute(r.uv, 2));
    geo.setAttribute('aVis', new THREE.BufferAttribute(r.vis, 1));
    geo.setAttribute('aCap', new THREE.BufferAttribute(r.cap, 1));
    geo.setAttribute('aBeard', new THREE.BufferAttribute(r.beardW, 1));
    geo.setIndex(bakeIndex);
    const mesh = new THREE.Mesh(geo, bakeMat); mesh.frustumCulled = false;
    const scene = new THREE.Scene(); scene.add(mesh);
    const U = bakeMat.uniforms;
    U.uPhoto.value = photo; U.uMask.value = mask;
    U.uSkin.value.setRGB(...p.skin, THREE.LinearSRGBColorSpace);
    U.uHair.value.setRGB(...p.hair, THREE.LinearSRGBColorSpace);
    U.uHairS.value.setRGB(...p.hairSide, THREE.LinearSRGBColorSpace);
    U.uBeard.value.setRGB(...p.beard, THREE.LinearSRGBColorSpace);
    U.uLight.value.set(...p.light); U.uDelight.value = p.delight;
    U.uFaceTrust.value = p.heuristic ? 0.75 : 1;
    U.uBg.value.setRGB(...p.bg, THREE.LinearSRGBColorSpace);
    U.uShineT.value = p.shineT; U.uChroma.value.set(...p.chroma);

    const out = new THREE.WebGLRenderTarget(SIZE, SIZE, { depthBuffer: false, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, colorSpace: THREE.SRGBColorSpace, anisotropy: 4 });
    const prevRT = renderer.getRenderTarget(), prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha(), prevAuto = renderer.autoClear;
    renderer.autoClear = true;
    renderer.setClearColor(U.uSkin.value, 0);
    renderer.setRenderTarget(scratch[0]);
    renderer.render(scene, cam);
    // Pad islands across UV seams (jump-flood style), last pass into the mip-mapped target.
    const steps = [1, 2, 4, 8, 16, 32];
    let src = scratch[0];
    steps.forEach((st, k) => {
      const dst = k === steps.length - 1 ? out : scratch[(k + 1) % 2];
      dilateMat.uniforms.uTex.value = src.texture; dilateMat.uniforms.uStep.value = st / SIZE;
      renderer.setRenderTarget(dst);
      renderer.render(quadScene, cam);
      src = dst;
    });
    // Front view of the face at a higher resolution (depth-tested: front-most surface wins).
    const hi = new THREE.WebGLRenderTarget(HI_W, HI_H, { depthBuffer: false, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, colorSpace: THREE.SRGBColorSpace, anisotropy: 4 });
    const geoHi = new THREE.BufferGeometry();
    for (const k of ['aRest', 'aNrm', 'aPhoto', 'aVis', 'aCap', 'aBeard']) geoHi.setAttribute(k, geo.attributes[k]);
    geoHi.setAttribute('position', aRest);
    geoHi.setIndex(hiIndex);
    mesh.geometry = geoHi; mesh.material = bakeHiMat;
    U.uFlat.value = 0;
    renderer.setRenderTarget(hiScratch);
    renderer.render(scene, hiCam);
    U.uFlat.value = 1;
    // Copy into the final (depth-less, mip-mapped) target; the depth buffer stays shared.
    dilateMat.uniforms.uTex.value = hiScratch.texture; dilateMat.uniforms.uStep.value = 0;
    renderer.setRenderTarget(hi);
    renderer.render(quadScene, cam);
    renderer.setRenderTarget(prevRT);
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.autoClear = prevAuto;
    photo.dispose(); mask.dispose(); geo.dispose(); geoHi.dispose();
    return { out, hi };
  }

  const cache = new Map(); // img → Promise<face|null>
  const done = new Map();  // img → face|null
  function prepareOne(img) {
    if (cache.has(img)) return cache.get(img);
    const pr = (async () => {
      if (!(await init())) return null;
      let bmp;
      try { bmp = await createImageBitmap(img); } catch { return null; }
      const r = await call({ type: 'analyze', bitmap: bmp, noLandmarks: !!globalThis.__faceHeuristic }, [bmp]);
      if (!r.fit) return null;
      const f = r.fit;
      const tm = performance.now();
      const { out, hi } = bake(img, { ...f, w: r.w, h: r.h });
      const geo = playerGeometry(f);
      const mainMs = performance.now() - tm;
      const p = f.params;
      const lin = c => new THREE.Color().setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace);
      const face = {
        tex: out.texture, rt: out, texHi: hi.texture, rtHi: hi, geo,
        skin: lin(p.skin), hair: lin(p.hair), hasHair: !p.bald, hairTop: p.hairTop, hairSide: p.hairSideVol,
        iris: lin(p.iris), sclera: lin(p.sclera),
        eyes: info.eyes.map((e, k) => { const o = f.eyeOff?.[k] || [0, 0, 0]; return new THREE.Vector4(e.c[0] + o[0], e.c[1] + o[1], e.c[2] + o[2], e.r); }),
        params: p, ms: r.ms, mainMs,
        debug: { uv: f.uv, vis: f.vis, hairW: f.hairW, R: info.R, UV: info.UV },
      };
      return face;
    })().catch(e => { console.warn('face failed', e); return null; }).then(f => { done.set(img, f); return f; });
    cache.set(img, pr);
    return pr;
  }

  return {
    // Analyse + bake every photo; resolves when all are done (or failed).
    prepare(imgs) { return Promise.all([...imgs].filter(Boolean).map(prepareOne)); },
    get(img) { return done.get(img) || null; },
    // Free the faces of earlier matches (keep the given photos and anything still on a player).
    retain(keep, inUse) {
      for (const [img, f] of done) {
        if (keep.has(img) || (f && inUse.has(f.tex))) continue;
        if (f) { f.rt.dispose(); f.rtHi.dispose(); disposeOwn(f.geo); }
        done.delete(img); cache.delete(img);
      }
    },
    has(img) { return done.has(img); },
    info,
  };
}

// ---------------------------------------------------------------- bake shaders
const BAKE_VS = /* glsl */`
attribute vec3 aRest, aNrm;
attribute vec2 aPhoto;
attribute float aVis, aCap, aBeard;
varying vec3 vRest, vNrm;
varying vec2 vPhoto;
varying float vVis, vCap, vBeard;
uniform float uFlat;
void main() {
  vRest = aRest; vNrm = aNrm; vPhoto = aPhoto; vVis = aVis; vCap = aCap; vBeard = aBeard;
  gl_Position = uFlat > 0.5 ? vec4(position.xy, 0.0, 1.0) : projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const BAKE_FS = /* glsl */`
uniform sampler2D uPhoto, uMask;
uniform vec3 uSkin, uHair, uHairS, uBeard, uBg;
uniform vec4 uLight;
uniform float uDelight, uFaceTrust, uShineT;
uniform vec3 uChroma;
varying vec3 vRest, vNrm;
varying vec2 vPhoto;
varying float vVis, vCap, vBeard;
float h13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h13(i), h13(i + vec3(1, 0, 0)), f.x), mix(h13(i + vec3(0, 1, 0)), h13(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(h13(i + vec3(0, 0, 1)), h13(i + vec3(1, 0, 1)), f.x), mix(h13(i + vec3(0, 1, 1)), h13(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
void main() {
  vec3 n = normalize(vNrm);
  vec2 e = min(vPhoto, 1.0 - vPhoto);
  float inP = smoothstep(0.0, 0.015, min(e.x, e.y));
  vec3 ph = texture2D(uPhoto, clamp(vPhoto, 0.0, 1.0)).rgb;
  vec4 mk = texture2D(uMask, clamp(vPhoto, 0.0, 1.0));
  vec2 m = mk.rg;
  // Shine off the skin (not off bleached hair): grey/white sheen and rim light take the skin's hue,
  // then luminance above the threshold is compressed (same curve as faceFit.js).
  float y = dot(ph, vec3(0.2126, 0.7152, 0.0722));
  float notHair = 1.0 - smoothstep(0.4, 0.8, m.r) * (1.0 - m.g);
  float cd = length(ph / max(y, 1e-4) - uChroma);
  float sheen = smoothstep(uShineT * 0.45, uShineT * 1.1, y) * smoothstep(0.12, 0.4, cd) * notHair;
  ph = mix(ph, uChroma * y, sheen * 0.85);
  if (y > uShineT) {
    float y2 = uShineT + (y - uShineT) * 0.3, hgt = smoothstep(uShineT, uShineT * 2.2, y) * 0.7;
    vec3 un = ph * (y2 / y) * (1.0 - hgt) + uChroma * y2 * hgt;
    ph = mix(un, ph, smoothstep(0.4, 0.8, m.r) * (1.0 - m.g));
  }
  float vis = clamp(vVis, 0.0, 1.0) * inP;
  // Take the photo's lighting out (fitted Y = a + b·n on the skin), the stadium lights go back on.
  float k = clamp(dot(uLight, vec4(1.0, n)), 0.55, 1.6);
  vec3 albN = ph / (1.0 + (k - 1.0) * uDelight);
  // On the face: even out the photo's shading with the skin-only shading map (B channel).
  vec3 albF = ph * (mk.b * 2.0);
  vec3 alb = mix(albN, albF, smoothstep(0.0, 0.5, m.g));
  // Face skin from the photo, feathered into the body's skin tone.
  // The person mask keeps the background out (silhouette landmarks can sit just off the face).
  float person = smoothstep(0.25, 0.75, mk.a);
  float face = m.g * vis * uFaceTrust * person;
  vec3 skin = mix(uSkin, alb, face);
  skin = mix(skin, uBeard, clamp(vBeard, 0.0, 1.0) * (1.0 - face));
  // Outside the face the photo may show the background (the 3D head is wider than his): trust it
  // only where it doesn't look like the background.
  vec3 d = sqrt(max(ph, 0.0)) - sqrt(max(uBg, 0.0));
  float bgLike = 1.0 - smoothstep(0.05, 0.12, length(d));
  // Beside the face below the temples the photo mostly shows ears and background: keep it to the
  // scalp (above eye level) there.
  float trust = vis * (1.0 - bgLike * (1.0 - face)) * person * max(smoothstep(1.615, 1.645, vRest.y), face);
  // Hair: the photo's hair where it sees the scalp, the fitted cap elsewhere.
  float hp = smoothstep(0.35, 0.75, m.r);
  float hair = clamp(mix(vCap, hp, trust), 0.0, 1.0) * (1.0 - face);
  float strand = vnoise(vRest * vec3(900.0, 260.0, 900.0)) * 0.6 + vnoise(vRest * 2400.0) * 0.4;
  vec3 hairBase = mix(uHairS, uHair, smoothstep(1.665, 1.7, vRest.y));
  vec3 hairProc = hairBase * (0.7 + 0.6 * strand);
  vec3 hairPh = mix(alb, ph, 0.5);
  // Shaved scalp catches the light in portraits: keep photo hair near the fitted hair tone.
  float yb = dot(hairBase, vec3(0.2126, 0.7152, 0.0722)), yh = dot(hairPh, vec3(0.2126, 0.7152, 0.0722));
  hairPh *= min(1.0, (yb * 1.6 + 0.01) / max(yh, 1e-4));
  float usePh = trust * smoothstep(0.5, 0.85, m.r);
  vec3 hairC = mix(hairProc, hairPh, usePh);
  vec3 c = mix(skin, hairC, hair);
  gl_FragColor = vec4(max(c, vec3(0.0)), 0.5 + 0.5 * hair);
}`;
const QUAD_VS = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const DILATE_FS = /* glsl */`
uniform sampler2D uTex;
uniform float uStep;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(uTex, vUv);
  if (c.a > 0.0) { gl_FragColor = c; return; }
  vec4 s = vec4(0.0); float n = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec4 t = texture2D(uTex, vUv + vec2(float(x), float(y)) * uStep);
    if (t.a > 0.0) { s += t; n += 1.0; }
  }
  gl_FragColor = n > 0.0 ? s / n : c;
}`;
