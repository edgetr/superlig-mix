// Face lab. ?fit — render the bare MakeHuman head, find its 478 Face Mesh landmarks and project them
// onto the mesh (→ web/public/models/face_fit.json). Default — players' heads next to their photos.
import * as THREE from 'three';
import { loadAssets } from './assets.js';
import { createKitMaterial } from './kit.js';
import { detectFace } from './face.js';

const qs = new URLSearchParams(location.search);
const cv = document.getElementById('cv');
const info = document.getElementById('info');
const { body } = await loadAssets();

if (qs.has('fit')) await fitMode();

async function fitMode() {
  const S = 768;
  const renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(S, S, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#9aa3ad');
  scene.add(new THREE.HemisphereLight('#ffffff', '#5a4a40', 1.3));
  const key = new THREE.DirectionalLight('#ffffff', 1.6); key.position.set(0.3, 0.6, 1); scene.add(key);
  const mat = createKitMaterial(body);
  const u = mat.userData.uniforms;
  u.uSkin.value.set(qs.get('skin') || '#c99a7c'); u.uHasHair.value = 0; u.uHasNum.value = 0;
  const mesh = new THREE.Mesh(body.geo, mat);
  scene.add(mesh);
  const half = Number(qs.get('half') || 0.13), cy = Number(qs.get('cy') || 1.6);
  const cam = new THREE.OrthographicCamera(-half, half, half, -half, 0.01, 10);
  cam.position.set(0, cy, 2); cam.lookAt(0, cy, 0);
  cam.updateProjectionMatrix();
  // Average the landmarks over a few skin tones and light directions (less detector noise).
  const acc = new Float64Array(478 * 3);
  let nOk = 0;
  for (const skin of ['#e3b89c', '#c99a7c', '#9a6648']) for (const lx of [-0.4, 0.3]) {
    u.uSkin.value.set(skin); key.position.set(lx, 0.6, 1);
    renderer.render(scene, cam);
    const d = await detectFace(await createImageBitmap(cv));
    if (!d.ok) continue;
    nOk++; for (let i = 0; i < acc.length; i++) acc[i] += d.lm[i];
  }
  if (!nOk) { info.textContent = 'no face found'; window.__fit = { ok: false }; return; }
  const r = { lm: acc.map(v => v / nOk) };
  u.uSkin.value.set('#c99a7c'); key.position.set(0.3, 0.6, 1); renderer.render(scene, cam);
  // Ray-cast every landmark onto the head (front-most hit).
  const ray = new THREE.Raycaster();
  const pts = [], nrm = [];
  const nA = body.geo.attributes.normal;
  let miss = 0;
  for (let i = 0; i < 478; i++) {
    // Silhouette landmarks can fall just outside the mesh: nudge them towards the nose.
    let hit = null;
    for (let s = 0; s < 12 && !hit; s++) {
      const f = s * 0.006;
      const px = r.lm[i * 3] + (r.lm[3] - r.lm[i * 3]) * f, py = r.lm[i * 3 + 1] + (r.lm[4] - r.lm[i * 3 + 1]) * f;
      ray.setFromCamera(new THREE.Vector2((px / S) * 2 - 1, 1 - (py / S) * 2), cam);
      hit = ray.intersectObject(mesh, false).find(h => h.face) || null;
    }
    if (!hit) { miss++; pts.push(null); nrm.push(null); continue; }
    const p = hit.point, f = hit.face, b = hit.barycoord || new THREE.Vector3(1 / 3, 1 / 3, 1 / 3);
    const n = new THREE.Vector3();
    for (const [k, w] of [[f.a, b.x], [f.b, b.y], [f.c, b.z]]) n.add(new THREE.Vector3(nA.getX(k), nA.getY(k), nA.getZ(k)).multiplyScalar(w));
    n.normalize();
    pts.push([+p.x.toFixed(5), +p.y.toFixed(5), +p.z.toFixed(5)]); nrm.push([+n.x.toFixed(3), +n.y.toFixed(3), +n.z.toFixed(3)]);
  }
  // Overlay
  const o = document.createElement('canvas'); o.width = S; o.height = S;
  const c2 = o.getContext('2d'); c2.drawImage(cv, 0, 0);
  c2.fillStyle = '#ff0'; for (let i = 0; i < 478; i++) c2.fillRect(r.lm[i * 3] - 1.5, r.lm[i * 3 + 1] - 1.5, 3, 3);
  o.style.cssText = `position:absolute;left:${S + 8}px;top:0`; document.body.appendChild(o);
  info.textContent = `landmarks ok, misses ${miss}`;
  window.__fit = { ok: true, miss, renders: nOk, points: pts, normals: nrm };
}

// ---------------------------------------------------------------- comparison: photo | front | 3/4 | side
if (!qs.has('fit')) await compareMode();

async function compareMode() {
  const { getStage } = await import('./stage.js');
  const { S, HZ } = await import('../../sim/core.js');
  const { PLAYERS } = await import('../../../../shared/players.js');
  const stage = await getStage();
  if (qs.has('heuristic')) globalThis.__faceHeuristic = true;
  const want = (qs.get('p') || 'Osimhen,Leão,Haaland,Yamal,Salah,Kerem').split(',');
  const sel = want.map(n => PLAYERS.find(p => p.name.toLowerCase().includes(n.toLowerCase()))).filter(Boolean);
  const imgs = new Map();
  await Promise.all(sel.map(p => new Promise(res => {
    const img = new Image(); img.crossOrigin = 'anonymous'; img.referrerPolicy = 'no-referrer';
    img.onload = () => { imgs.set(p.id, img); res(); }; img.onerror = res; img.src = p.img;
  })));
  const A = 25, N = Math.ceil(2 * HZ) + 1;
  const clip = { N, dur: (N - 1) / HZ, pos: new Float32Array(N * A * 2), hd: new Float32Array(N * A), ph: new Float32Array(N * A), st: new Uint8Array(N * A), stT: new Float32Array(N * A), ball: new Float32Array(N * 3), cam: new Float32Array(N * 2), marks: { passes: [], captions: [] } };
  // ?run=<m/s>: jog/run/sprint in place of standing; ?ball=side: ball to his left (head turns).
  const v = Number(qs.get('run') || 0);
  const GAIT = [[0, 0.9], [1.3, 1.46], [2.93, 2.31], [3.65, 2.67], [4.44, 3.02], [4.83, 3.1], [6.5, 3.75], [9.5, 4.6]];
  const cyc = v => { for (let i = 1; i < GAIT.length; i++) if (v <= GAIT[i][0]) { const [a, la] = GAIT[i - 1], [b, lb] = GAIT[i]; return la + ((v - a) / (b - a)) * (lb - la); } return 4.6; };
  for (let k = 0; k < N; k++) {
    const tt = k / HZ;
    for (let a = 0; a < A; a++) { clip.pos[(k * A + a) * 2] = a < sel.length ? 20 + a * 4 + v * tt : -40; clip.pos[(k * A + a) * 2 + 1] = 34; clip.hd[k * A + a] = 0; clip.ph[k * A + a] = v ? (v * tt) / cyc(v) : 0; }
    clip.ball[k * 3] = qs.get('ball') === 'side' ? 20 + v * tt : 140; clip.ball[k * 3 + 1] = qs.get('ball') === 'side' ? 50 : 34; clip.ball[k * 3 + 2] = 0;
  }
  const looks = Array.from({ length: A }, (_, a) => {
    const p = sel[a];
    return { shirt: '#c81e2c', shorts: '#ffffff', socks: '#c81e2c', numColor: '#fff', trim: '#fff', skin: '#c8956b', hair: '#2b1d14', num: p?.num ?? 9, name: p?.name || 'X', id: p?.id, foot: 'right', height: (p?.height || 180) / 100 };
  });
  const t0 = performance.now();
  stage.setCast('facelab', looks, imgs, null);
  if (!qs.has('nofaces')) await stage.prepareFaces(imgs);
  const prepMs = performance.now() - t0;
  const TW = 300, TH = 390, views = (qs.get('views') || 'front,34,side').split(','), dist = Number(qs.get('d') || 1.15);
  cv.width = TW * (1 + views.length); cv.height = TH * sel.length;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#111'; ctx.fillRect(0, 0, cv.width, cv.height);
  const tile = document.createElement('canvas'); tile.width = Math.round(TH * 16 / 9); tile.height = TH;
  const tctx = tile.getContext('2d');
  const t = Number(qs.get('t') || 0.3);
  const atlas = qs.has('atlas');
  if (atlas) cv.width += TH;
  const THREE_ = await import('three');
  const hp = new THREE_.Vector3(), hq = new THREE_.Quaternion(), fwd = new THREE_.Vector3();
  for (const [i, p] of sel.entries()) {
    const img = imgs.get(p.id);
    if (img) ctx.drawImage(img, 0, i * TH, TW, TH);
    const fo = stage.faces.get(img);
    if (qs.has('mask') && img) {
      const d = await detectFace(await createImageBitmap(img));
      if (d.hair) {
        const id = new ImageData(d.w, d.h);
        for (let k = 0; k < d.w * d.h; k++) { id.data[k * 4] = 255; id.data[k * 4 + 3] = d.hair[k] > 128 ? 110 : 0; }
        const mc = document.createElement('canvas'); mc.width = d.w; mc.height = d.h; mc.getContext('2d').putImageData(id, 0, 0);
        ctx.drawImage(mc, 0, i * TH, TW, TH);
      }
    }
    if (qs.has('overlay') && fo?.debug) {
      const d = fo.debug;
      for (let k = 0; k < d.vis.length; k++) {
        if (d.vis[k] < 0.05) continue;
        ctx.fillStyle = `rgba(${d.R[k] === 5 ? 0 : 255},${Math.round(255 * d.hairW[k])},${d.UV[k * 2] > 0.55 ? 255 : 0},${0.25 + 0.5 * d.vis[k]})`;
        ctx.fillRect(d.uv[k * 2] * TW - 1, i * TH + d.uv[k * 2 + 1] * TH - 1, 2, 2);
      }
    }
    // Everyone poses in slot 0 (same idle pose for a fair comparison).
    const lk0 = looks.slice(); [lk0[0], lk0[i]] = [lk0[i], lk0[0]];
    stage.setCast('facelab' + i, lk0, imgs, null);
    const exp = qs.get('exp'), u0 = stage.people[0].u;
    if (exp === 'nohi') u0.uFaceHi.value = u0.uFace.value;
    if (exp === 'notex') u0.uHasFace.value = 0;
    if (exp === 'nomip') { for (const tx of [u0.uFace.value, u0.uFaceHi.value]) { tx.minFilter = THREE_.LinearFilter; tx.needsUpdate = true; } }
    if (exp === 'const') {
      const c = u0.uSkin.value.clone().convertLinearToSRGB();
      const dt = new THREE_.DataTexture(new Uint8Array([c.r * 255, c.g * 255, c.b * 255, 128]), 1, 1); dt.colorSpace = THREE_.SRGBColorSpace; dt.needsUpdate = true;
      u0.uFace.value = dt; u0.uFaceHi.value = dt;
    }
    if (exp === 'nogeo') stage.people[0].mesh.geometry = stage.body.geo;
    if (exp === 'atlas' || exp === 'hionly') {
      const g0 = stage.people[0].mesh.geometry, g = g0.clone();
      const fa = g.attributes.faceUVW.clone();
      for (let k = 0; k < fa.count; k++) fa.setZ(k, exp === 'atlas' ? 0 : (fa.getZ(k) > 0 ? 1 : 0));
      g.setAttribute('faceUVW', fa); stage.people[0].mesh.geometry = g;
    }
    // Aim at the head as posed (idle sway, head tracking): find the Head bone and its facing.
    stage.draw(tctx, { pos: [0, 0, 10], look: [1, 0, 0], fov: 30 }, clip, t, { looks: lk0, only: new Set([0]) });
    stage.draw(tctx, { pos: [0, 0, 10], look: [1, 0, 0], fov: 30 }, clip, t, { looks: lk0, only: new Set([0]) });
    const hb = stage.people[0].bones[stage.body.idx.Head];
    hb.updateWorldMatrix(true, false); hb.getWorldPosition(hp); hb.getWorldQuaternion(hq);
    fwd.set(0, 0, 1).applyQuaternion(hq);
    const pitch = 0; fwd.y = 0; fwd.normalize();
    const base = Math.atan2(fwd.z, fwd.x);
    const sc = stage.people[0].g.scale.x;
    const c = hp.clone().add(new THREE_.Vector3(0, Number(qs.get('dy') ?? 0.07) * sc, 0)).addScaledVector(fwd, 0.03 * sc);
    views.forEach((v, j) => {
      const ang = base + (v === 'front' ? 0 : v === '34' ? 0.7 : v === 'side' ? 1.5 : Number(v));
      // engine coords: x = X, y = Z, z = Y
      const cam = { pos: [c.x + Math.cos(ang) * dist * Math.cos(pitch), c.z + Math.sin(ang) * dist * Math.cos(pitch), c.y + 0.02 + dist * Math.sin(pitch)], look: [c.x, c.z, c.y], fov: 30 };
      stage.draw(tctx, cam, clip, t, { looks: lk0, only: new Set([0]) });
      ctx.drawImage(tile, (tile.width - TW) / 2, 0, TW, TH, TW * (j + 1), i * TH, TW, TH);
    });
    const f = stage.faces.get(img);
    if (atlas && f) {
      const rt = qs.get('atlas') === 'hi' ? f.rtHi : f.rt;
      const W = rt.width, H = rt.height, buf = new Uint8Array(W * H * 4);
      stage.renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
      const id = new ImageData(W, H);
      for (let y = 0; y < H; y++) id.data.set(buf.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
      for (let k = 3; k < id.data.length; k += 4) id.data[k] = 255;
      const lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      const boxAvg = (x0, y0, x1, y1) => { const c = [0, 0, 0]; let n = 0; for (let y = Math.round(y0 * H); y < y1 * H; y++) for (let x = Math.round(x0 * W); x < x1 * W; x++) { for (let k = 0; k < 3; k++) c[k] += lin(id.data[(y * W + x) * 4 + k]); n++; } return c.map(v => +(v / n).toFixed(3)); };
      (window.__tex ||= []).push({ name: p.name, cheekL: boxAvg(0.25, 0.45, 0.35, 0.55), cheekR: boxAvg(0.65, 0.45, 0.75, 0.55), forehead: boxAvg(0.4, 0.2, 0.6, 0.27), skin: f.skin.toArray().map(v => +v.toFixed(3)) });
      const tc = document.createElement('canvas'); tc.width = W; tc.height = H; tc.getContext('2d').putImageData(id, 0, 0);
      ctx.drawImage(tc, TW * (1 + views.length), i * TH, TH * W / H, TH);
    }
    ctx.fillStyle = '#fff'; ctx.font = '14px system-ui'; ctx.fillText(p.name, 6, i * TH + 16);
    if (f) ctx.fillText(`${f.params.heuristic ? 'HEURISTIC ' : ''}${f.params.bald ? 'bald ' : ''}top ${(f.hairTop * 100).toFixed(1)}cm side ${(f.hairSide * 100).toFixed(1)}cm beard ${f.params.beardK.toFixed(2)} ${f.ms.toFixed(0)}ms`, 6, i * TH + 34);
  }
  info.textContent = `prepare ${prepMs.toFixed(0)} ms`;
  window.__params = sel.map(p => { const f = stage.faces.get(imgs.get(p.id)); return f && { name: p.name, hairInfo: f.hairGeo?.userData, style: Object.fromEntries(Object.entries(f.params.style).map(([k, v]) => [k, typeof v === "number" ? +v.toFixed(3) : v])), top: +f.hairTop.toFixed(3), side: +f.hairSide.toFixed(3), front: +f.params.front.toFixed(3), bald: f.params.bald, browC: +f.params.browContrast.toFixed(2), workerMs: Math.round(f.ms), mainMs: +f.mainMs.toFixed(1), skin: '#' + f.skin.getHexString(), hair: '#' + f.hair.getHexString(), iris: '#' + f.iris.getHexString(), sclera: '#' + f.sclera.getHexString(), light: f.params.light.map(v => +v.toFixed(3)), bg: f.params.bg.map(v => +v.toFixed(3)), cov: +f.params.coverage.toFixed(2), long: +f.params.long.toFixed(2), front: f.params.front, beard: '#' + new THREE_.Color().setRGB(...f.params.beard, THREE_.LinearSRGBColorSpace).getHexString(), beardK: +f.params.beardK.toFixed(2)}; });
  window.__done = true;
}
