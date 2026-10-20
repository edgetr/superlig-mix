// Clip extraction helpers: retarget a CMU take, ground it, find gait cycles, canonicalise.
import fs from 'node:fs';
import { Quaternion, Vector3 } from 'three';
import { fetchCMU, parseASF, parseAMC, makeRetarget, retargetFrame, fk } from './cmu.mjs';
import { OUT } from './paths.mjs';

export function loadBody() {
  const body = JSON.parse(fs.readFileSync(`${OUT}/body.json`, 'utf8'));
  body.idx = Object.fromEntries(body.bones.map((b, i) => [b.name, i]));
  return body;
}

const yawOf = q => { const fx = 2 * (q.x * q.z + q.w * q.y), fz = 1 - 2 * (q.x * q.x + q.y * q.y); return Math.atan2(fx, fz); };
const Yq = a => new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), a);

// Load + retarget a take (all frames at native fps). Returns per-frame { q[], root, yaw, feet }.
export async function take(id, body, fps = 120) {
  const { asf, amc } = await fetchCMU(id);
  const skel = parseASF(asf), raw = parseAMC(amc);
  const rt = makeRetarget(skel, body);
  const toeRest = body.bones[body.idx.LeftToeBase].tail[1];
  const ankRest = body.bones[body.idx.LeftFoot].head[1];
  const frames = raw.map(fr => {
    const { q, root } = retargetFrame(skel, rt, body, fr);
    const k = fk(body, q, root);
    const lt = k.tip('LeftToeBase'), rtp = k.tip('RightToeBase');
    const la = k.P[body.idx.LeftFoot], ra = k.P[body.idx.RightFoot];
    return { q, root, yaw: yawOf(q[0]), head: k.P[body.idx.Head], lt, rt: rtp, la, ra, g: Math.min(lt.y - toeRest, rtp.y - toeRest, la.y - ankRest, ra.y - ankRest), gl: Math.min(lt.y - toeRest, la.y - ankRest), gr: Math.min(rtp.y - toeRest, ra.y - ankRest) };
  });
  return { id, fps, frames, legScale: rt.legScale, ankRest };
}

// Ground offset: 5th percentile of the lowest foot point.
export function groundOffset(frames, a = 0, b = frames.length) {
  const g = frames.slice(a, b).map(f => f.g).sort((x, y) => x - y);
  return -g[Math.floor(g.length * 0.05)];
}

// Foot strikes: start of a stance phase (ankle low and slow) after a real swing.
export function strikes(T, side = 'l') {
  const F = T.frames, dt = 1 / T.fps, out = [];
  const ankRest = T.ankRest;
  const off = groundOffset(F);
  const ank = i => (side === 'l' ? F[i].la : F[i].ra);
  let swing = 0;
  for (let i = 2; i < F.length - 2; i++) {
    const v = ank(i + 1).clone().sub(ank(i - 1)).length() / (2 * dt);
    const h = ank(i).y - ankRest + off;
    const stance = h < 0.05 && v < 1.6;
    if (!stance) swing += dt; else { if (swing > 0.12 && i > 2) out.push(i); swing = 0; }
  }
  return out;
}

export function slerpQ(a, b, t) { return a.clone().slerp(b, t); }

// Sample frame (fractional index) of a take.
function sampleTake(F, x) {
  const i = Math.max(0, Math.min(F.length - 1, Math.floor(x))), j = Math.min(F.length - 1, i + 1), a = x - i;
  return { q: F[i].q.map((q, k) => slerpQ(q, F[j].q[k], a)), root: F[i].root.clone().lerp(F[j].root, a) };
}

// Canonicalise: rotate about the vertical so `yaw0` faces +Z, translate so `origin` (xz) is at 0.
function canon(s, yaw0, origin) {
  const R = Yq(-yaw0);
  const q = s.q.slice(); q[0] = R.clone().multiply(s.q[0]);
  const root = s.root.clone().sub(new Vector3(origin.x, 0, origin.z)).applyQuaternion(R);
  return { q, root };
}

// Gait cycle between strikes a and b → N samples, loop-closed, facing +Z, horizontal travel removed.
export function cycleClip(T, a, b, N = 32) {
  const F = T.frames;
  const dur = (b - a) / T.fps;
  // mean facing over the cycle
  let sx = 0, sz = 0; for (let i = a; i < b; i++) { sx += Math.sin(F[i].yaw); sz += Math.cos(F[i].yaw); }
  const yaw0 = Math.atan2(sx, sz);
  const off = groundOffset(F, Math.max(0, a - 60), Math.min(F.length, b + 60));
  const start = F[a].root, end = F[b].root;
  const samples = [];
  for (let k = 0; k <= N; k++) {
    const x = a + (k / N) * (b - a);
    const s = sampleTake(F, x);
    const trend = start.clone().lerp(end, k / N);
    samples.push(canon({ q: s.q, root: s.root.clone().sub(new Vector3(trend.x, 0, trend.z)).add(new Vector3(start.x, 0, start.z)) }, yaw0, start));
  }
  // travel (canonical frame)
  const disp = end.clone().sub(start).applyQuaternion(Yq(-yaw0)); disp.y = 0;
  // Loop closure: distribute the end→start mismatch over the cycle.
  const last = samples[N];
  const B = last.q.length;
  for (let bi = 0; bi < B; bi++) {
    let q0 = samples[0].q[bi], qe = last.q[bi];
    const delta = qe.clone().invert().multiply(q0);
    if (delta.w < 0) { delta.x *= -1; delta.y *= -1; delta.z *= -1; delta.w *= -1; }
    for (let k = 0; k <= N; k++) samples[k].q[bi] = samples[k].q[bi].clone().multiply(new Quaternion().slerp(delta, k / N));
  }
  const dy = samples[0].root.y - last.root.y, dx = samples[0].root.x - last.root.x, dz = samples[0].root.z - last.root.z;
  for (let k = 0; k <= N; k++) { const w = k / N; samples[k].root.y += dy * w - off * 0; samples[k].root.x += dx * w; samples[k].root.z += dz * w; }
  for (const s of samples) s.root.y += off;
  samples.pop();
  return { kind: 'cycle', n: N, dur, speed: disp.length() / dur, dir: Math.atan2(disp.x, disp.z), samples };
}

// Action window [t0, t1] seconds → resampled at `fps`, facing at `ref` → +Z, origin at ref, travel low-passed out.
export function actionClip(T, t0, t1, ref, { fps = 60, keepTravel = false, sigma = 0.35, yawRef = null, yawAt = null, yawAxis = false, refMode = null } = {}) {
  const F = T.frames;
  const a = Math.round(t0 * T.fps), b = Math.min(F.length - 1, Math.round(t1 * T.fps));
  let r = Math.round(ref * T.fps);
  if (refMode === 'maxRootY') { let best = -1; for (let i = a; i <= b; i++) if (F[i].root.y > best) { best = F[i].root.y; r = i; } }
  const off = groundOffset(F, a, b + 1);
  const yi = yawAt != null ? Math.round(yawAt * T.fps) : r;
  let yr = yawRef != null ? yawRef : F[yi].yaw;
  if (yawAxis) { const h = F[yi].head, p = F[yi].root; yr = Math.atan2(h.x - p.x, h.z - p.z); }
  const n = Math.max(2, Math.round((t1 - t0) * fps) + 1);
  // smoothed root path (gaussian) for travel removal
  const sm = i => {
    let x = 0, z = 0, w = 0;
    const s = sigma * T.fps;
    for (let k = Math.max(0, Math.round(i - 3 * s)); k <= Math.min(F.length - 1, Math.round(i + 3 * s)); k++) { const ww = Math.exp(-((k - i) * (k - i)) / (2 * s * s)); x += F[k].root.x * ww; z += F[k].root.z * ww; w += ww; }
    return new Vector3(x / w, 0, z / w);
  };
  const origin = F[r].root;
  const samples = [];
  for (let k = 0; k < n; k++) {
    const x = a + (k / (n - 1)) * (b - a);
    const s = sampleTake(F, x);
    const root = s.root.clone();
    if (!keepTravel) { const p = sm(x), p0 = sm(r); root.x -= p.x - p0.x; root.z -= p.z - p0.z; }
    const c = canon({ q: s.q, root }, yr, origin);
    c.root.y += off;
    samples.push(c);
  }
  return { kind: 'action', fps, n, dur: (n - 1) / fps, samples, ref: (r - a) / T.fps };
}

// Rotate cycle samples so that sample 0 is the left-foot strike.
export function rotateCycle(c, shift) {
  const k = ((Math.round(shift * c.n) % c.n) + c.n) % c.n;
  c.samples = c.samples.slice(k).concat(c.samples.slice(0, k));
  return c;
}

// All candidate cycles of a take (left→left, or right→right shifted to start at the left strike).
export function cyclesOf(T, N = 32) {
  const L = strikes(T, 'l'), R = strikes(T, 'r');
  const out = [];
  for (let i = 0; i + 1 < L.length; i++) out.push({ a: L[i], b: L[i + 1], shift: 0, foot: 'l' });
  for (let i = 0; i + 1 < R.length; i++) {
    const a = R[i], b = R[i + 1];
    const l = L.find(x => x > a && x < b);
    const shift = l != null ? (l - a) / (b - a) : 0.5;
    out.push({ a, b, shift, foot: 'r' });
  }
  return out.map(c => ({ ...c, clip: rotateCycle(cycleClip(T, c.a, c.b, N), c.shift) }));
}
