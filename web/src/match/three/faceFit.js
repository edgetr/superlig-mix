// Fit a player portrait onto the 3D head (runs in the face worker, once per photo).
//
// Inputs: the photo's 478 MediaPipe landmarks (+ hair mask, pixels), the head vertices, and the
// same landmarks located on the MakeHuman head (models/face_fit.json). Output, per head vertex:
// where it sits in the photo, how well the photo sees it, hair/beard weights and a small shape
// offset (so the head takes the player's proportions); per player: skin, hair, beard, iris and
// sclera colours, the photo's lighting (to take it back out) and the hair volume.
//
// Model: the photo is a scaled-orthographic view of the head (s·R, t) plus a smooth 3D thin-plate
// spline of the landmark residuals. Part of the residual becomes head shape, the rest is texture
// warp, so eyes, nose, mouth and jaw land exactly on the mesh's features.
import { LM, WARP, SKIN, BEARD, JAW, hairCap, HAIR0 } from './headModel.js';

const SHAPE = 0.8;        // share of the proportions moved into the geometry
const SHAPE_MAX = 0.016;  // m
const DELIGHT = 0.8;      // how much of the photo's lighting gets removed

const lin = new Float32Array(256).map((_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const ss = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const median = a => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const lum = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

export function fitPhoto(a, head, fitData) {
  const { w, h, lm, px } = a;
  const F = fitData.points;
  const FN = fitData.normals;
  const Q = i => [lm[i * 3], lm[i * 3 + 1]];

  // ---------------------------------------------------------------- camera (scaled orthographic)
  const C = WARP.filter(i => F[i]);
  const n = C.length;
  // Affine least squares q = M P + t
  const ATA = Array.from({ length: 4 }, () => new Float64Array(4)), ATx = new Float64Array(4), ATy = new Float64Array(4);
  for (const i of C) {
    const r = [F[i][0], F[i][1], F[i][2], 1], q = Q(i);
    for (let p = 0; p < 4; p++) { ATx[p] += r[p] * q[0]; ATy[p] += r[p] * q[1]; for (let k = 0; k < 4; k++) ATA[p][k] += r[p] * r[k]; }
  }
  const ax = solve(ATA.map(r => [...r]), [[...ATx]])[0], ay = solve(ATA.map(r => [...r]), [[...ATy]])[0];
  let M = [[ax[0], ax[1], ax[2]], [ay[0], ay[1], ay[2]]];
  // Closest scaled rotation (rows orthogonal, equal length).
  {
    const r1 = M[0], r2 = M[1];
    const s1 = Math.hypot(...r1), s2 = Math.hypot(...r2);
    let e1 = r1.map(v => v / s1), e2 = r2.map(v => v / s2);
    // symmetric orthogonalisation
    for (let it = 0; it < 4; it++) {
      const d = dot(e1, e2) / 2;
      const n1 = e1.map((v, k) => v - d * e2[k]), n2 = e2.map((v, k) => v - d * e1[k]);
      e1 = norm(n1); e2 = norm(n2);
    }
    const s = (s1 + s2) / 2;
    M = [e1.map(v => v * s), e2.map(v => v * s)];
  }
  const s = Math.hypot(...M[0]);
  const e1 = M[0].map(v => v / s), e2 = M[1].map(v => v / s);
  const toCam = norm(cross(e2, e1)); // towards the camera, in head space
  let t = [0, 0];
  for (const i of C) { const q = Q(i); t[0] += q[0] - dot(M[0], F[i]); t[1] += q[1] - dot(M[1], F[i]); }
  t = [t[0] / n, t[1] / n];
  const proj = p => [dot(M[0], p) + t[0], dot(M[1], p) + t[1]];

  // ---------------------------------------------------------------- residual spline (3D TPS, φ(r) = r)
  const lam = 0.0015;
  const N4 = n + 4;
  const A = Array.from({ length: N4 }, () => new Float64Array(N4));
  const bx = new Float64Array(N4), by = new Float64Array(N4);
  C.forEach((i, r) => {
    const P = F[i];
    C.forEach((j, c) => { A[r][c] = r === c ? lam : dist(P, F[j]); });
    A[r][n] = 1; A[r][n + 1] = P[0]; A[r][n + 2] = P[1]; A[r][n + 3] = P[2];
    A[n][r] = 1; A[n + 1][r] = P[0]; A[n + 2][r] = P[1]; A[n + 3][r] = P[2];
    const q = Q(i), p = proj(P);
    bx[r] = q[0] - p[0]; by[r] = q[1] - p[1];
  });
  const [wx, wy] = solve(A, [bx, by]);
  const ctrl = C.map(i => F[i]);
  // The spline is only trusted near the landmarks; further out (scalp, ears, neck) it fades back to
  // the plain camera so extrapolation can't drag the hair or the background onto the head.
  const resid = P => {
    let rx = wx[n] + wx[n + 1] * P[0] + wx[n + 2] * P[1] + wx[n + 3] * P[2];
    let ry = wy[n] + wy[n + 1] * P[0] + wy[n + 2] * P[1] + wy[n + 3] * P[2];
    let dmin = Infinity;
    for (let k = 0; k < n; k++) { const d = dist(P, ctrl[k]); rx += wx[k] * d; ry += wy[k] * d; if (d < dmin) dmin = d; }
    const f = dmin < 0.012 ? 1 : Math.exp(-(((dmin - 0.012) / 0.022) ** 2));
    return [rx * f, ry * f];
  };

  // ---------------------------------------------------------------- photo sampling
  const sample = (x, y) => {
    x = clamp(x, 0, w - 1.001); y = clamp(y, 0, h - 1.001);
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const out = [0, 0, 0];
    for (const [dx, dy, wt] of [[0, 0, (1 - fx) * (1 - fy)], [1, 0, fx * (1 - fy)], [0, 1, (1 - fx) * fy], [1, 1, fx * fy]]) {
      const o = ((y0 + dy) * w + x0 + dx) * 4;
      out[0] += lin[px[o]] * wt; out[1] += lin[px[o + 1]] * wt; out[2] += lin[px[o + 2]] * wt;
    }
    return out;
  };
  const eyeDist = Math.hypot(lm[468 * 3] - lm[473 * 3], lm[468 * 3 + 1] - lm[473 * 3 + 1]) || s * 0.06;
  const disc = (x, y, r) => {
    const out = [0, 0, 0]; let k = 0;
    for (let dy = -r; dy <= r; dy += Math.max(1, r / 2)) for (let dx = -r; dx <= r; dx += Math.max(1, r / 2)) { const c = sample(x + dx, y + dy); out[0] += c[0]; out[1] += c[1]; out[2] += c[2]; k++; }
    return out.map(v => v / k);
  };
  const hairAt = (x, y) => {
    if (!a.hair) return 0;
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= w || yi >= h) return -1;
    return a.hair[yi * w + xi] / 255;
  };

  // ---------------------------------------------------------------- lighting (Y ≈ a + b·n) and skin tone
  const rs = Math.max(1, eyeDist * 0.04);
  const skinRaw = SKIN.filter(i => F[i] && FN[i]).map(i => ({ c: disc(lm[i * 3], lm[i * 3 + 1], rs), n: FN[i] }));
  // Shine: portraits are often sweaty / flash-lit. Luminance above ~1.4× the skin's median is
  // compressed and pulled to the skin's hue (same curve in the bake shader).
  const Ys = median(skinRaw.map(sm => lum(sm.c)));
  const chromaRaw = [0, 1, 2].map(k => median(skinRaw.map(sm => sm.c[k])));
  const chroma = chromaRaw.map(v => v / Math.max(1e-4, lum(chromaRaw)));
  const shineT = Ys * 1.4;
  const unshine = c => {
    const y = lum(c);
    if (y <= shineT) return c;
    const y2 = shineT + (y - shineT) * 0.3, hgt = ss(shineT, shineT * 2.2, y) * 0.7;
    return c.map((v, k) => (v * y2) / y * (1 - hgt) + chroma[k] * y2 * hgt);
  };
  const skinS = skinRaw.map(sm => ({ c: unshine(sm.c), n: sm.n }));
  const L4 = Array.from({ length: 4 }, () => new Float64Array(4)), Ly = new Float64Array(4);
  for (const sm of skinS) {
    const r = [1, ...sm.n], y = lum(sm.c);
    for (let p = 0; p < 4; p++) { Ly[p] += r[p] * y; for (let k = 0; k < 4; k++) L4[p][k] += r[p] * r[k]; }
  }
  // Ridge on the directional terms: frontal samples can't separate "ambient" from "light from the front".
  for (let p = 1; p < 4; p++) L4[p][p] += 0.06 * skinS.length;
  const lc = solve(L4.map(r => [...r]), [[...Ly]])[0];
  const shadeOf = nn => lc[0] + lc[1] * nn[0] + lc[2] * nn[1] + lc[3] * nn[2];
  const meanShade = skinS.reduce((acc, sm) => acc + shadeOf(sm.n), 0) / Math.max(1, skinS.length);
  const delight = (c, nn) => { const k = clamp(shadeOf(nn) / meanShade, 0.55, 1.6); const f = 1 + (k - 1) * DELIGHT; return c.map(v => v / f); };
  // Skin tone: de-lit colour over the whole face mesh except eyes, brows, lips and beard areas;
  // the middle of the luminance distribution (no shine, no shadow), so the body matches the face.
  const skip = new Set([...LM.eyeR, ...LM.eyeL, ...LM.browR, ...LM.browL, ...LM.lips, ...LM.lipsIn, ...BEARD, ...LM.irisR, ...LM.irisL, ...LM.oval]);
  const skinD = [];
  for (let i = 0; i < 468; i++) if (!skip.has(i) && FN[i]) skinD.push(delight(unshine(disc(lm[i * 3], lm[i * 3 + 1], rs)), FN[i]));
  // Trimmed mean in linear light: what the face averages to on screen (mip-mapped at a distance).
  const ys = skinD.map(lum).sort((p, q) => p - q);
  const lo = ys[Math.floor(ys.length * 0.12)], hi = ys[Math.floor(ys.length * 0.95)];
  const band = skinD.filter(c => { const y = lum(c); return y >= lo && y <= hi; });
  const skin = [0, 1, 2].map(k => band.reduce((acc, c) => acc + c[k], 0) / Math.max(1, band.length));

  // ---------------------------------------------------------------- beard
  const beardS = BEARD.filter(i => F[i] && FN[i]).map(i => delight(unshine(disc(lm[i * 3], lm[i * 3 + 1], rs)), FN[i]));
  const beardY = median(beardS.map(lum));
  const beardK = clamp((0.8 - beardY / Math.max(1e-4, lum(skin))) / 0.4, 0, 1);
  const beardDark = beardS.filter(c => lum(c) < lum(skin) * 0.8);
  const beard = beardDark.length ? [0, 1, 2].map(k => median(beardDark.map(c => c[k]))) : skin.map(v => v * 0.4);

  // ---------------------------------------------------------------- eyes: iris and sclera colour
  const eyeCol = (iris, contour) => {
    const cx = lm[iris[0] * 3], cy = lm[iris[0] * 3 + 1];
    const r = iris.slice(1).reduce((acc, i) => acc + Math.hypot(lm[i * 3] - cx, lm[i * 3 + 1] - cy), 0) / 4;
    const poly = contour.map(i => [lm[i * 3], lm[i * 3 + 1]]);
    const ir = [], sc = [];
    const R = Math.ceil(r * 2.6);
    for (let y = Math.floor(cy - R); y <= cy + R; y++) for (let x = Math.floor(cx - R); x <= cx + R; x++) {
      if (!inPoly(x, y, poly)) continue;
      const d = Math.hypot(x - cx, y - cy) / r;
      const c = sample(x, y);
      if (d > 0.4 && d < 0.85) ir.push(c); else if (d > 1.15) sc.push(c);
    }
    return { ir, sc };
  };
  const eR = eyeCol(LM.irisR, LM.eyeR), eL = eyeCol(LM.irisL, LM.eyeL);
  const irisPx = [...eR.ir, ...eL.ir].filter(c => lum(c) > 0.004).sort((p, q) => lum(p) - lum(q));
  const irisMid = irisPx.slice(Math.floor(irisPx.length * 0.3), Math.ceil(irisPx.length * 0.9));
  let iris = irisMid.length ? [0, 1, 2].map(k => irisMid.reduce((acc, c) => acc + c[k], 0) / irisMid.length) : [0.06, 0.03, 0.015];
  if (a.heuristic) iris = [0.05, 0.026, 0.013];
  const iy = lum(iris); iris = iris.map(v => v * clamp(0.07 / Math.max(iy, 1e-4), 1, 2.5)); // photos keep irises in shadow
  const sclPx = [...eR.sc, ...eL.sc].sort((p, q) => lum(q) - lum(p));
  const sclTop = sclPx.slice(0, Math.max(1, Math.floor(sclPx.length * 0.4)));
  let sclera = sclTop.length ? [0, 1, 2].map(k => sclTop.reduce((acc, c) => acc + c[k], 0) / sclTop.length) : [0.62, 0.57, 0.53];
  const sy = lum(sclera); sclera = sclera.map(v => clamp(v * clamp(0.6 / Math.max(sy, 1e-3), 0.8, 2.2), 0.25, 0.85));

  // ---------------------------------------------------------------- hair: coverage, colour, volume, hairline
  const nv = head.idx.length, HP = head.P, HN = head.N;
  const pTop = (() => { let b = 0; for (let k = 1; k < nv; k++) if (HP[k * 3 + 1] > HP[b * 3 + 1]) b = k; return [HP[b * 3], HP[b * 3 + 1], HP[b * 3 + 2]]; })();
  const warp = P => { const p = proj(P), r = resid(P); return [p[0] + r[0], p[1] + r[1]]; };
  const qTop = warp(pTop), qChin = Q(152);
  const upI = norm2([qTop[0] - qChin[0], qTop[1] - qChin[1]]);
  const scan = (from, dir, maxPx) => {
    let last = 0, miss = 0, cropped = false;
    for (let d = 0; d < maxPx; d++) {
      const v = hairAt(from[0] + dir[0] * d, from[1] + dir[1] * d);
      if (v < 0) { cropped = true; break; }
      if (v > 0.5) { last = d; miss = 0; } else if (++miss > Math.max(3, eyeDist * 0.05)) break;
    }
    return { d: last, cropped };
  };
  // Is the scalp covered? Sample the mask over visible scalp vertices of the default cap.
  let cov = 0, covN = 0;
  for (let k = 0; k < nv; k++) {
    if (head.R[k] === 5) continue;
    const P = [HP[k * 3], HP[k * 3 + 1], HP[k * 3 + 2]];
    if (hairCap(P[0], P[1], P[2], head.zc, HAIR0) < 0.9 || P[1] < 1.69) continue;
    const nn = [HN[k * 3], HN[k * 3 + 1], HN[k * 3 + 2]];
    if (dot(nn, toCam) < 0.35) continue;
    const q = warp(P), m = hairAt(q[0], q[1]);
    if (m < 0) continue;
    cov += m; covN++;
  }
  const coverage = covN ? cov / covN : 0.5;
  const hasHairMask = !!a.hair;
  const bald = hasHairMask && coverage < 0.22;
  // Hair height above the skull top, and at the temples.
  const topScan = scan(qTop, upI, h);
  // A photo cropped through the hair only gives a lower bound.
  const hairTop = bald ? 0.0015 : clamp((topScan.d / s) * 0.9 + (topScan.cropped ? 0.012 : 0), 0.003, 0.055);
  const sidePts = [[head.head.x1 - 0.004, 1.672, head.zc + 0.01], [head.head.x0 + 0.004, 1.672, head.zc + 0.01]];
  const xI = norm2([M[0][0], M[1][0]]);
  const sideD = sidePts.map((P, k) => { const q = warp(P); const dir = [xI[0] * (k ? -1 : 1), xI[1] * (k ? -1 : 1)]; return scan(q, dir, w).d / s; });
  const hairSideVol = bald ? 0.001 : clamp(Math.min(...sideD) * 0.85, 0.002, 0.03);
  // Front hairline: walk up from the top of the forehead (landmark 10) to the first hair.
  let hl = null;
  if (!bald && hasHairMask) {
    const q10 = Q(10);
    for (let d = -eyeDist * 0.25; d < eyeDist * 1.2; d++) { const v = hairAt(q10[0] + upI[0] * d, q10[1] + upI[1] * d); if (v < 0) break; if (v > 0.5) { hl = d; break; } }
  }
  const front = hl == null ? HAIR0.front : clamp(F[10][1] + (hl / s) * 0.95, 1.655, 1.735);
  // Long hair: does the hair cover the ears / the side of the neck?
  const earPts = [[head.head.x1 - 0.002, 1.615, head.zc - 0.005], [head.head.x0 + 0.002, 1.615, head.zc - 0.005]];
  const earHair = hasHairMask ? earPts.reduce((acc, P) => { const q = warp(P); return acc + Math.max(0, hairAt(q[0], q[1])); }, 0) / 2 : 0;
  const long = clamp((earHair - 0.4) / 0.4, 0, 1);
  const caps = bald ? { front: 9, side: 9, back: 9 } : { front, side: HAIR0.side - long * 0.06, back: HAIR0.back - long * 0.07 };
  // Hair colour, separately for the top and the sides (fades, bleached tops): confident hair pixels
  // above the skull line vs. beside the temples.
  let hair = null, hairSideC = null;
  if (hasHairMask && !bald) {
    const qT = warp([0, HAIR0.front - 0.004, head.zc + 0.06]);
    const top = [], side = [];
    const step = Math.max(1, Math.floor(Math.min(w, h) / 200));
    const ov = LM.oval.map(i => [lm[i * 3], lm[i * 3 + 1]]);
    const yBrow = (lm[105 * 3 + 1] + lm[334 * 3 + 1]) / 2;
    for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
      if (a.hair[y * w + x] < 200) continue;
      const c = sample(x, y);
      // signed height above the hairline point along the face's up axis
      const up = (x - qT[0]) * upI[0] + (y - qT[1]) * upI[1];
      if (up > eyeDist * 0.15) top.push(c);
      else if (y < yBrow + eyeDist * 0.4 && !inPoly(x, y, ov)) side.push(c);
    }
    const robust = list => {
      if (list.length < 15) return null;
      list.sort((p, q) => lum(p) - lum(q));
      const mid = list.slice(Math.floor(list.length * 0.15), Math.ceil(list.length * 0.8));
      return [0, 1, 2].map(k => mid.reduce((acc, c) => acc + c[k], 0) / mid.length);
    };
    hair = robust(top) || robust(side);
    hairSideC = robust(side);
  }
  if (!hair && !hasHairMask) {
    // No segmentation: average the non-background pixels just above the forehead.
    const bg = sample(1, 1), q10 = Q(10), hp = [];
    for (let d = eyeDist * 0.2; d < eyeDist * 0.7; d += 1) for (let o = -eyeDist * 0.4; o <= eyeDist * 0.4; o += 2) {
      const x = q10[0] + upI[0] * d - upI[1] * o, y = q10[1] + upI[1] * d + upI[0] * o;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const c = sample(x, y);
      if (Math.abs(c[0] - bg[0]) + Math.abs(c[1] - bg[1]) + Math.abs(c[2] - bg[2]) > 0.08) hp.push(c);
    }
    if (hp.length > 10) hair = [0, 1, 2].map(k => median(hp.map(c => c[k])));
  }
  if (!hair) hair = bald ? skin.map(v => v * 0.75) : [0.025, 0.017, 0.012];
  // Short sides read as a mix of hair and scalp.
  const hairSide = hairSideC ? hairSideC.map((v, k) => v * 0.8 + skin[k] * 0.2) : hair;

  // Background: median of the top corners and upper sides that aren't hair.
  const bgS = [];
  const personAt = (x, y) => (a.person ? a.person[Math.round(clamp(y, 0, h - 1)) * w + Math.round(clamp(x, 0, w - 1))] / 255 : 0);
  for (let y = 0; y < h * 0.45; y += 2) for (const x of [1, 3, 5, w - 2, w - 4, w - 6]) if (hairAt(x, y) < 0.2 && personAt(x, y) < 0.5) bgS.push(sample(x, y));
  for (let x = 0; x < w; x += 3) for (const y of [1, 3]) if (hairAt(x, y) < 0.2 && personAt(x, y) < 0.5) bgS.push(sample(x, y));
  const bg = bgS.length ? [0, 1, 2].map(k => median(bgS.map(c => c[k]))) : [0.5, 0.5, 0.5];

  // ---------------------------------------------------------------- per-vertex outputs
  const uv = new Float32Array(nv * 2), vis = new Float32Array(nv), cap = new Float32Array(nv), hw = new Float32Array(nv), bw = new Float32Array(nv), off = new Float32Array(nv * 3);
  const chin = head.head.chin;
  const jaw = JAW.filter(i => F[i]).map(i => F[i]);
  const eyeOff = head.eyes.map(e => shapeOff(e.c, 1));
  function shapeOff(P, fade) {
    const r = resid(P);
    const d = [0, 1, 2].map(k => (SHAPE * fade * (r[0] * e1[k] + r[1] * e2[k])) / s);
    const l = Math.hypot(...d);
    return l > SHAPE_MAX ? d.map(v => (v * SHAPE_MAX) / l) : d;
  }
  for (let k = 0; k < nv; k++) {
    const P = [HP[k * 3], HP[k * 3 + 1], HP[k * 3 + 2]], nn = [HN[k * 3], HN[k * 3 + 1], HN[k * 3 + 2]];
    const q = warp(P);
    uv[k * 2] = q[0] / w; uv[k * 2 + 1] = q[1] / h;
    const nd = dot(nn, toCam);
    const isEar = head.UV[k * 2] > 0.55;
    vis[k] = isEar ? 0 : ss(0.12, 0.45, nd);
    const c = head.R[k] === 5 || isEar ? 0 : hairCap(P[0], P[1], P[2], head.zc, caps);
    cap[k] = c;
    const m = hairAt(q[0], q[1]);
    const v2 = m < 0 ? 0 : ss(0.0, 0.35, nd);
    hw[k] = head.R[k] === 5 || isEar ? 0 : (bald ? 0 : clamp(c + (Math.max(0, m) - c) * v2, 0, 1));
    // Beard continues under the jaw line.
    if (beardK > 0 && head.R[k] === 0 && P[1] < chin + 0.03 && P[2] > head.zc - 0.02) {
      let best = 1, by = 0;
      for (let j = 0; j + 1 < jaw.length; j++) { const r = segDist(P, jaw[j], jaw[j + 1]); if (r.d < best) { best = r.d; by = r.y; } }
      if (P[1] < by + 0.002) bw[k] = beardK * (1 - ss(0.008, 0.04, best));
    }
    // Shape: the face takes the player's proportions; fades out to the back of the head and neck.
    if (head.R[k] === 5) { const e = eyeOff[P[0] > 0 ? 0 : 1]; off.set(e, k * 3); }
    else {
      const fade = ss(head.zc - 0.035, head.zc + 0.03, P[2]) * ss(chin - 0.045, chin - 0.005, P[1]) * (1 - ss(1.7, 1.745, P[1]));
      if (fade > 0) off.set(shapeOff(P, fade), k * 3);
    }
  }

  // ---------------------------------------------------------------- photo masks for the bake
  // R hair, G face (feathered oval), B shading gain, A person (vs background). The gain evens out the photo's own light and
  // shadow on the skin (the stadium lights shade the head again): a blur of the luminance of
  // skin-like pixels only (normalised convolution, so beard, brows and eyes keep their darkness),
  // relative to the skin tone.
  const masks = new Uint8Array(w * h * 4);
  const oval = LM.oval.map(i => [lm[i * 3], lm[i * 3 + 1]]);
  const feather = eyeDist * 0.3; // wide: the silhouette often carries rim light or background
  const box = bbox(oval, feather);
  const L = new Float32Array(w * h), Wm = new Float32Array(w * h);
  const Ysk = lum(skin) * 1.0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4, i = y * w + x;
    masks[o] = a.hair ? a.hair[i] : 0;
    masks[o + 3] = a.person ? a.person[i] : 255;
    const c = unshine([lin[px[i * 4]], lin[px[i * 4 + 1]], lin[px[i * 4 + 2]]]);
    const yv = lum(c);
    const cd = Math.hypot(c[0] / Math.max(yv, 1e-4) - chroma[0], c[1] / Math.max(yv, 1e-4) - chroma[1], c[2] / Math.max(yv, 1e-4) - chroma[2]);
    const skinLike = yv > Ysk * 0.35 && yv < Ysk * 2.6 && cd < 0.45 && (!a.hair || a.hair[i] < 120) ? 1 : 0;
    L[i] = yv * skinLike; Wm[i] = skinLike;
    if (x < box[0] || x > box[2] || y < box[1] || y > box[3]) continue;
    if (!inPoly(x + 0.5, y + 0.5, oval)) continue;
    const d = polyDist(x + 0.5, y + 0.5, oval);
    masks[o + 1] = Math.round(ss(feather * 0.25, feather, d) * 255);
  }
  const rb = Math.max(2, Math.round(eyeDist * 0.1));
  boxBlur(L, w, h, rb); boxBlur(Wm, w, h, rb); boxBlur(L, w, h, rb); boxBlur(Wm, w, h, rb);
  for (let i = 0; i < w * h; i++) {
    const wt = Wm[i];
    const g = wt > 0.05 ? clamp(Math.pow(Ysk / Math.max(1e-4, L[i] / wt), 0.85), 0.6, 1.9) : 1;
    masks[i * 4 + 2] = Math.round(clamp(g / 2, 0, 1) * 255);
  }

  return {
    uv, vis, cap, hairW: hw, beardW: bw, off, masks, eyeOff,
    params: {
      shineT, chroma,
      heuristic: !!a.heuristic, bg, skin, hair, hairSide, beard, beardK, iris, sclera, bald, coverage, long, hairTop, hairSideVol, front,
      light: [lc[0] / meanShade, lc[1] / meanShade, lc[2] / meanShade, lc[3] / meanShade], delight: DELIGHT,
      toCam, scale: s, eyeDist,
    },
  };
}

// ---------------------------------------------------------------- small maths
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(a) { const l = Math.hypot(...a) || 1; return a.map(v => v / l); }
function norm2(a) { const l = Math.hypot(a[0], a[1]) || 1; return [a[0] / l, a[1] / l]; }
function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
function segDist(p, a, b) {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const t = clamp(((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1] + (p[2] - a[2]) * d[2]) / (dot(d, d) || 1), 0, 1);
  const c = [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t];
  return { d: dist(p, c), y: c[1] };
}
// In-place box blur (horizontal then vertical), radius r.
function boxBlur(a, w, h, r) {
  const tmp = new Float32Array(Math.max(w, h));
  for (let y = 0; y < h; y++) {
    let acc = 0; const o = y * w;
    for (let x = -r; x <= r; x++) acc += a[o + clamp(x, 0, w - 1)];
    for (let x = 0; x < w; x++) { tmp[x] = acc / (2 * r + 1); acc += a[o + Math.min(w - 1, x + r + 1)] - a[o + Math.max(0, x - r)]; }
    for (let x = 0; x < w; x++) a[o + x] = tmp[x];
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += a[clamp(y, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) { tmp[y] = acc / (2 * r + 1); acc += a[Math.min(h - 1, y + r + 1) * w + x] - a[Math.max(0, y - r) * w + x]; }
    for (let y = 0; y < h; y++) a[y * w + x] = tmp[y];
  }
}
function inPoly(x, y, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
function polyDist(x, y, poly) {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j], [bx, by] = poly[i];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
    const t = clamp(((x - ax) * dx + (y - ay) * dy) / l2, 0, 1);
    best = Math.min(best, Math.hypot(x - ax - dx * t, y - ay - dy * t));
  }
  return best;
}
function bbox(poly, m) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of poly) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return [x0 - m, y0 - m, x1 + m, y1 + m];
}
// Gaussian elimination with partial pivoting; A is n×n (array of rows), B is a list of RHS vectors.
function solve(A, B) {
  const n = A.length, X = B.map(b => Float64Array.from(b));
  const M = A.map(r => Float64Array.from(r));
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (p !== c) { [M[p], M[c]] = [M[c], M[p]]; for (const x of X) { const t = x[p]; x[p] = x[c]; x[c] = t; } }
    const d = M[c][c] || 1e-12;
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / d;
      if (!f) continue;
      const Mr = M[r], Mc = M[c];
      for (let k = c; k < n; k++) Mr[k] -= f * Mc[k];
      for (const x of X) x[r] -= f * x[c];
    }
  }
  for (const x of X) for (let r = n - 1; r >= 0; r--) { let v = x[r]; for (let k = r + 1; k < n; k++) v -= M[r][k] * x[k]; x[r] = v / (M[r][r] || 1e-12); }
  return X;
}
