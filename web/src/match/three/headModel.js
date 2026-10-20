// Head geometry helpers shared by the main thread (face.js) and the face worker: which vertices
// make up the head, the procedural hair cap, and the MediaPipe Face Mesh landmark groups we use.
// No three.js here so the worker can import it cheaply.

// MediaPipe Face Mesh (478 landmarks) index groups.
export const LM = {
  oval: [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109],
  eyeR: [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246],
  eyeL: [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466],
  browR: [70, 63, 105, 66, 107, 55, 65, 52, 53, 46],
  browL: [300, 293, 334, 296, 336, 285, 295, 282, 283, 276],
  lips: [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185],
  lipsIn: [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191],
  nose: [1, 2, 4, 5, 6, 168, 195, 197, 98, 327, 48, 278, 129, 358, 49, 279, 64, 294, 102, 331, 94, 19],
  cheeks: [50, 280, 205, 425, 117, 346, 187, 411, 147, 376, 123, 352, 101, 330, 36, 266, 118, 347, 119, 348],
  forehead: [151, 9, 108, 337, 69, 299, 104, 333, 68, 298, 107, 336, 66, 296],
  chin: [199, 175, 428, 208, 200, 18, 32, 262, 171, 396],
  irisR: [468, 469, 470, 471, 472],
  irisL: [473, 474, 475, 476, 477],
};
// Landmarks that steer the photo → head warp (thin-plate spline control points).
export const WARP = [...new Set([...LM.oval, ...LM.eyeR, ...LM.eyeL, ...LM.browR, ...LM.browL, ...LM.lips, ...LM.nose, ...LM.cheeks, ...LM.forehead, ...LM.chin])];
// Skin samples for lighting / skin tone (no eyes, brows, lips, beard).
export const SKIN = [151, 9, 108, 337, 69, 299, 104, 333, 68, 298, 50, 280, 117, 346, 118, 347, 119, 348, 101, 330, 36, 266, 205, 425, 6, 197, 195, 5, 4, 1, 45, 275, 188, 412, 114, 343, 100, 329];
// Upper-lip / chin / jaw samples to detect a beard or moustache.
export const BEARD = [164, 167, 393, 92, 322, 18, 200, 199, 175, 152, 148, 377, 176, 400, 149, 378, 150, 379, 136, 365, 172, 397, 214, 434];
// Jaw line (lower face oval, ear to ear) — the beard can continue below it.
export const JAW = [132, 58, 172, 136, 150, 149, 176, 148, 152, 377, 400, 378, 379, 365, 397, 288, 361];

// Head vertices (region 0 head/neck skin, 5 eyeballs).
export function headInfo(body) {
  const pos = body.geo.attributes.position.array, nrm = body.geo.attributes.normal.array;
  const reg = body.geo.attributes.region.array, uv = body.geo.attributes.headUV.array;
  const idx = [];
  for (let i = 0; i < reg.length; i++) if (reg[i] === 0 || reg[i] === 5) idx.push(i);
  const n = idx.length;
  const P = new Float32Array(n * 3), N = new Float32Array(n * 3), UV = new Float32Array(n * 2), R = new Uint8Array(n);
  let z0 = Infinity, z1 = -Infinity;
  idx.forEach((v, k) => {
    for (let c = 0; c < 3; c++) { P[k * 3 + c] = pos[v * 3 + c]; N[k * 3 + c] = nrm[v * 3 + c]; }
    UV[k * 2] = uv[v * 2]; UV[k * 2 + 1] = uv[v * 2 + 1]; R[k] = reg[v];
    if (reg[v] === 0 && pos[v * 3 + 1] > 1.6 && pos[v * 3 + 1] < 1.7) { z0 = Math.min(z0, pos[v * 3 + 2]); z1 = Math.max(z1, pos[v * 3 + 2]); }
  });
  return { idx: Int32Array.from(idx), P, N, UV, R, zc: (z0 + z1) / 2 - 0.01, head: body.head, eyes: body.eyes };
}

// Default hair line heights (rest metres): front hairline, above the ears, nape.
export const HAIR0 = { front: 1.695, side: 1.652, back: 1.585 };
const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
// Procedural hair cap weight at a rest-space point (0 skin … 1 hair).
export function hairCap(x, y, z, zc, h) {
  const c = (z - zc) / (Math.hypot(x, z - zc) || 1);   // cos of the angle around the head (1 front, −1 back)
  const capY = h.side + ((h.front - h.back) / 2) * c + ((h.front + h.back) / 2 - h.side) * c * c;
  return ss(capY - 0.008, capY + 0.008, y);
}
const isEar = (u, v) => u > 0.55; // ears sit on the right of the atlas (see build_body.mjs)

export function hairWeights(info, h, out) {
  const n = info.idx.length;
  for (let k = 0; k < n; k++) {
    if (info.R[k] === 5 || isEar(info.UV[k * 2], info.UV[k * 2 + 1])) { out[k] = 0; continue; }
    out[k] = hairCap(info.P[k * 3], info.P[k * 3 + 1], info.P[k * 3 + 2], info.zc, h);
  }
  return out;
}

// The face front also gets a dedicated high-resolution texture: an orthographic front view of the
// head over this rectangle (rest metres). faceUVW = (u, v, weight); the weight fades out where the
// surface turns away from the front so the shader blends it into the head atlas without a seam.
export const FACE_RECT = { x0: -0.088, x1: 0.088, y0: 1.468, y1: 1.712 };
export function faceFrame(body) {
  const pos = body.geo.attributes.position.array, nrm = body.geo.attributes.normal.array;
  const reg = body.geo.attributes.region.array, uv = body.geo.attributes.headUV.array;
  const R = FACE_RECT, out = new Float32Array(reg.length * 3);
  for (let i = 0; i < reg.length; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1];
    const u = (x - R.x0) / (R.x1 - R.x0), v = (y - R.y0) / (R.y1 - R.y0);
    out[i * 3] = u; out[i * 3 + 1] = v;
    if (reg[i] !== 0 || uv[i * 2] < -1.5 || uv[i * 2] > 0.55) continue; // head skin only (no ears, mouth)
    const edge = Math.min(u, 1 - u, v, 1 - v);
    out[i * 3 + 2] = ss(0.22, 0.5, nrm[i * 3 + 2]) * ss(0.0, 0.06, edge);
  }
  return out;
}

// Full-mesh hair weight attribute with the default cap (players without a photo).
export function defaultHair(body) {
  const info = headInfo(body);
  const w = hairWeights(info, HAIR0, new Float32Array(info.idx.length));
  const out = new Float32Array(body.geo.attributes.position.count);
  info.idx.forEach((v, k) => { out[v] = w[k]; });
  return out;
}
