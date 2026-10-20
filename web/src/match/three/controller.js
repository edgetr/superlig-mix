// Motion controller: turns the football engine's per-agent tracks (position, heading, gait phase,
// action state) into full-body poses. Pure function of (clip, agent, time) so scrubbing, replays
// and video export all show exactly the same movement.
//
// Layers
//  1. Locomotion: motion-captured gait cycles (walk → jog → run → sprint, backpedal) blended by
//     speed and direction; the phase comes from the distance actually travelled, so feet plant.
//  2. Body dynamics: lean into turns, lean with acceleration, head and chest tracking the ball.
//  3. Actions, blended in around their real-time anchor: mocap kicks (the boot meets the ball on the
//     frame the engine releases it), headers, falls and get-ups; procedural keeper set/dive/hold,
//     slide tackles, knee slides, celebrations, referee and assistant signals, walls, throw-ins.
//  4. Leg IK keeps planted feet on the turf for crouched and kneeling poses.
import * as THREE from 'three';
import { S, HZ, N_AGENTS, cycleLen } from '../../sim/core.js';
import { makePose, sampleCycle, sampleAction, blendPose, copyPose, rotateBone } from './pose.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = x => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const angDiff = (a, b) => { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
const hash = (a, b) => { let h = Math.imul(a + 1, 0x9e3779b1) ^ Math.imul(Math.floor(b * 7) + 3, 0x85ebca6b); h ^= h >>> 15; return (h >>> 0) / 4294967296; };

export function createController(lib, body) {
  const B = lib.B, C = lib.clips, I = body.idx;
  const LOCO = ['walk', 'jog', 'run', 'run_fast', 'sprint'].filter(n => C[n]).map(n => C[n]);
  const bones = body.bones;
  const PARENT = bones.map(b => b.parent);
  const OFF = bones.map(b => (b.parent >= 0 ? new THREE.Vector3(b.head[0] - bones[b.parent].head[0], b.head[1] - bones[b.parent].head[1], b.head[2] - bones[b.parent].head[2]) : new THREE.Vector3()));
  const DIR = bones.map(b => new THREE.Vector3(b.tail[0] - b.head[0], b.tail[1] - b.head[1], b.tail[2] - b.head[2]).normalize());
  const LEN = bones.map(b => Math.hypot(b.tail[0] - b.head[0], b.tail[1] - b.head[1], b.tail[2] - b.head[2]));
  const THIGH = OFF[I.LeftLeg].length(), SHIN = OFF[I.LeftFoot].length();

  // ---------------------------------------------------------------- mirrored clips (left foot)
  const SWAP = bones.map(b => {
    const n = b.name;
    const m = n.startsWith('Left') ? 'Right' + n.slice(4) : n.startsWith('Right') ? 'Left' + n.slice(5) : n.startsWith('LHip') ? 'RHip' + n.slice(4) : n.startsWith('RHip') ? 'LHip' + n.slice(4) : n === 'LThumb' ? 'RThumb' : n === 'RThumb' ? 'LThumb' : n;
    return I[m];
  });
  function mirrored(name) {
    const key = name + '~m';
    if (C[key]) return C[key];
    const c = C[name]; if (!c) return null;
    const q = new Float32Array(c.q.length), r = new Float32Array(c.r.length);
    for (let f = 0; f < c.n; f++) {
      for (let b = 0; b < B; b++) {
        const s = (f * B + SWAP[b]) * 4, d = (f * B + b) * 4;
        q[d] = c.q[s]; q[d + 1] = -c.q[s + 1]; q[d + 2] = -c.q[s + 2]; q[d + 3] = c.q[s + 3];
      }
      r[f * 3] = -c.r[f * 3]; r[f * 3 + 1] = c.r[f * 3 + 1]; r[f * 3 + 2] = c.r[f * 3 + 2];
    }
    return (C[key] = { ...c, name: key, q, r });
  }
  const meanOf = new Map();
  for (const c of LOCO) {
    const m = new Float32Array(B * 4);
    for (let f = 0; f < c.n; f++) for (let b = 0; b < B; b++) {
      const o = (f * B + b) * 4, s = (c.q[o] * c.q[b * 4] + c.q[o + 1] * c.q[b * 4 + 1] + c.q[o + 2] * c.q[b * 4 + 2] + c.q[o + 3] * c.q[b * 4 + 3]) < 0 ? -1 : 1;
      for (let k = 0; k < 4; k++) m[b * 4 + k] += c.q[o + k] * s;
    }
    for (let b = 0; b < B; b++) { const l = Math.hypot(m[b * 4], m[b * 4 + 1], m[b * 4 + 2], m[b * 4 + 3]) || 1; for (let k = 0; k < 4; k++) m[b * 4 + k] /= l; }
    meanOf.set(c, m);
  }
  const STRIDE = ['LeftUpLeg', 'LeftLeg', 'RightUpLeg', 'RightLeg', 'LeftArm', 'LeftForeArm', 'RightArm', 'RightForeArm'].map(n => I[n]);

  // ---------------------------------------------------------------- forward kinematics (character space)
  const W = bones.map(() => new THREE.Quaternion()), P = bones.map(() => new THREE.Vector3());
  const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
  function fk(pose) {
    const q = pose.q;
    for (let b = 0; b < B; b++) {
      _q.set(q[b * 4], q[b * 4 + 1], q[b * 4 + 2], q[b * 4 + 3]);
      const p = PARENT[b];
      if (p < 0) { W[b].copy(_q); P[b].set(pose.r[0], pose.r[1], pose.r[2]); }
      else { W[b].copy(W[p]).multiply(_q); P[b].copy(OFF[b]).applyQuaternion(W[p]).add(P[p]); }
    }
  }
  const setLocal = (pose, b, world) => {
    const p = PARENT[b];
    if (p < 0) _q2.copy(world); else _q2.copy(W[p]).invert().multiply(world);
    _q2.normalize();
    pose.q[b * 4] = _q2.x; pose.q[b * 4 + 1] = _q2.y; pose.q[b * 4 + 2] = _q2.z; pose.q[b * 4 + 3] = _q2.w;
  };
  // Point bone b along `dir` (character space; +Z forward, +Y up, +X the character's left).
  const _id = new THREE.Quaternion();
  function aim(pose, b, x, y, z, w = 1) {
    if (w <= 0) return;
    fk(pose);
    _v.copy(DIR[b]).applyQuaternion(W[b]);
    _v2.set(x, y, z).normalize();
    _q.setFromUnitVectors(_v, _v2);
    if (w < 1) _q.slerpQuaternions(_id, _q, w);
    _q.multiply(W[b]);
    setLocal(pose, b, _q);
  }
  // Two-bone leg IK: put the ankle of `side` ('Left'|'Right') at `target` (character space).
  const footW = new THREE.Quaternion();
  function legIK(pose, side, tx, ty, tz, w = 1) {
    if (w <= 0) return;
    const up = I[side + 'UpLeg'], kn = I[side + 'Leg'], an = I[side + 'Foot'];
    fk(pose);
    footW.copy(W[an]);
    const hip = P[up];
    const T = _v3.set(tx, ty, tz);
    T.lerpVectors(P[an], T, w);
    const want = clamp(T.distanceTo(hip), 0.05, THIGH + SHIN - 0.002);
    // knee angle (interior) needed
    const cosK = clamp((THIGH * THIGH + SHIN * SHIN - want * want) / (2 * THIGH * SHIN), -1, 1);
    const kNeed = Math.acos(cosK);
    const curD = P[an].distanceTo(hip);
    const cosC = clamp((THIGH * THIGH + SHIN * SHIN - curD * curD) / (2 * THIGH * SHIN), -1, 1);
    const kCur = Math.acos(cosC);
    // hinge axis: perpendicular to thigh & shin (fallback: character lateral axis in thigh space)
    _v.copy(P[kn]).sub(hip).normalize();
    _v2.copy(P[an]).sub(P[kn]).normalize();
    const axis = new THREE.Vector3().crossVectors(_v, _v2);
    if (axis.lengthSq() < 1e-6) axis.set(1, 0, 0).applyQuaternion(W[up]);
    axis.normalize();
    _q.setFromAxisAngle(axis, kCur - kNeed).multiply(W[kn]);
    setLocal(pose, kn, _q);
    fk(pose);
    _v.copy(P[an]).sub(hip).normalize();
    _v2.copy(T).sub(hip).normalize();
    _q.setFromUnitVectors(_v, _v2).multiply(W[up]);
    setLocal(pose, up, _q);
    fk(pose);
    setLocal(pose, an, footW); // keep the foot's orientation (flat on the ground)
  }

  // ---------------------------------------------------------------- per-clip preparation
  const prepCache = new WeakMap();
  const kickMeta = new Map();
  function kickContact(clip) {
    // Toe position at impact, character space (cached per clip).
    let m = kickMeta.get(clip);
    if (!m) {
      const p = makePose(B); sampleAction(clip, clip.ref, p); fk(p);
      const lt = P[I.LeftToeBase].clone().add(DIR[I.LeftToeBase].clone().multiplyScalar(LEN[I.LeftToeBase]).applyQuaternion(W[I.LeftToeBase]));
      const rt = P[I.RightToeBase].clone().add(DIR[I.RightToeBase].clone().multiplyScalar(LEN[I.RightToeBase]).applyQuaternion(W[I.RightToeBase]));
      m = { toe: lt.y < rt.y ? lt : rt, right: rt };
      kickMeta.set(clip, m);
    }
    return m;
  }
  function prepare(clip) {
    let p = prepCache.get(clip);
    if (p) return p;
    const N = clip.N, A = N_AGENTS;
    const inst = Array.from({ length: A }, () => []);
    for (let a = 0; a < A; a++) {
      let cur = null;
      for (let k = 0; k < N; k++) {
        const st = clip.st[k * A + a], tt = clip.stT[k * A + a];
        if (cur && (st !== cur.st || tt + 1e-4 < cur.lastT)) { cur.k1 = k - 1; cur = null; }
        if (!cur && st) { cur = { st, k0: k, k1: N - 1, anchor: null, lastT: tt, a }; inst[a].push(cur); }
        if (cur) {
          if (cur.anchor == null) {
            const at = cur.st === S.KICK ? 0.28 : cur.st === S.HEAD ? 0.32 : 0;
            if (tt >= at - 1e-4) cur.anchor = k / HZ - (tt - at);
          }
          cur.lastT = tt;
        }
      }
      for (const c of inst[a]) { if (c.anchor == null) c.anchor = c.k0 / HZ; c.t0 = c.k0 / HZ; c.t1 = (c.k1 + 1) / HZ; }
    }
    const shot = clip.marks?.shot;
    const passes = clip.marks?.passes || [];
    for (let a = 0; a < A; a++) for (const c of inst[a]) {
      const k = clamp(Math.round(c.anchor * HZ), 0, N - 1);
      c.ball = { x: clip.ball[k * 3], y: clip.ball[k * 3 + 1], z: clip.ball[k * 3 + 2] };
      c.pos = { x: clip.pos[(k * A + a) * 2], y: clip.pos[(k * A + a) * 2 + 1] };
      c.hd = clip.hd[k * A + a];
      c.seed = hash(a, c.anchor);
      if (c.st === S.KICK) {
        const isShot = shot && shot.agent === a && Math.abs(shot.t - c.anchor) < 0.8;
        const pass = passes.find(ps => ps.from === a && Math.abs(ps.t0 - c.anchor) < 0.8);
        const dist = pass ? Math.hypot(pass.target.x - c.ball.x, pass.target.y - c.ball.y) : 0;
        c.kind = isShot ? 'shot' : pass && (pass.loft || dist > 30) ? 'long' : 'pass';
      }
      if (c.st === S.DIVE_L || c.st === S.DIVE_R) {
        // Dive side relative to the keeper's facing; height from the shot.
        const dy = c.st === S.DIVE_L ? -1 : 1;
        const crossZ = Math.cos(c.hd) * dy;
        c.side = crossZ > 0 ? -1 : 1;   // −1: character's right (−X), +1: left (+X)
        c.high = clamp(((shot?.to?.z ?? 0.8) - 0.3) / 1.8, 0, 1);
      }
    }
    p = { inst };
    prepCache.set(clip, p);
    return p;
  }

  // ---------------------------------------------------------------- locomotion
  const tmpA = makePose(B), tmpB = makePose(B), tmpC = makePose(B), act = makePose(B), base = makePose(B);
  function idlePose(out, t, a) { const idle = C.idle; return sampleAction(idle, (t + a * 1.37) % idle.dur, out); }
  // Strides per gait cycle of the directional captures vs the engine's forward gait table,
  // so their feet plant at the engine's gait phase too.
  const K_SIDE = C.side_l ? cycleLen(C.side_l.speed) / (C.side_l.speed * C.side_l.dur) : 1;
  const K_BACK = C.walk_back ? cycleLen(C.walk_back.speed) / (C.walk_back.speed * C.walk_back.dur) : 1;
  function forwardGait(out, v, phase, t, a) {
    let lo = null, hi = null, w = 0;
    if (v <= LOCO[0].speed) { hi = LOCO[0]; w = clamp(v / LOCO[0].speed, 0, 1); }
    else {
      for (let i = 0; i < LOCO.length - 1; i++) if (v <= LOCO[i + 1].speed) { lo = LOCO[i]; hi = LOCO[i + 1]; w = (v - lo.speed) / (hi.speed - lo.speed); break; }
      if (!hi) { hi = LOCO[LOCO.length - 1]; w = 1; }
    }
    sampleCycle(hi, phase, tmpA);
    if (lo) { sampleCycle(lo, phase, tmpB); blendPose(out, tmpB, tmpA, w); }
    else if (w < 1) { idlePose(tmpB, t, a); blendPose(out, tmpB, tmpA, smooth(w * 1.6)); }
    else copyPose(out, tmpA);
    if (!lo && hi === LOCO[LOCO.length - 1] && v > hi.speed) {
      const k = 1 + Math.min(0.45, (v - hi.speed) * 0.12), mean = meanOf.get(hi);
      for (const b of STRIDE) extrapolate(out.q, b, mean, k);
      out.r[1] -= Math.min(0.05, (v - hi.speed) * 0.015);
    }
    return out;
  }
  // phi: direction of travel relative to the body (engine angle; > 0 = towards the character's right).
  // Returns the hip twist applied (engine radians) so the caller can keep the chest on the ball.
  const tmpD = makePose(B), tmpE = makePose(B);
  function locomotion(out, v, phase, t, a, phi) {
    if (v < 0.05 || !LOCO.length) { idlePose(out, t, a); return 0; }
    const c = Math.cos(phi), sn = Math.sin(phi);
    // Fast and not facing the run: hips turn into the run, chest stays on the ball.
    const twistW = smooth((v - 2.0) / 1.4) * smooth((Math.abs(phi) - 0.5) / 0.5);
    const twist = clamp(phi, -1.75, 1.75) * twistW;
    const rel = phi - twist, rc = Math.cos(rel), rs = Math.sin(rel);
    forwardGait(out, v, phase, t, a);
    let wF = Math.max(0, rc) ** 2, wB = Math.max(0, -rc) ** 2, wS = rs * rs;
    const sum = wF + wB + wS || 1; wF /= sum; wB /= sum; wS /= sum;
    const slow = clamp(v / 0.6, 0, 1);
    if (wS > 0.01 && C.side_l) {
      const clip = rs > 0 ? mirrored('side_l') : C.side_l;   // engine-positive = character's right
      sampleCycle(clip, phase * K_SIDE, tmpD);
      blendPose(out, out, tmpD, (wS / (wF + wS)) * slow);
    }
    if (wB > 0.01 && C.walk_back) {
      sampleCycle(C.walk_back, phase * K_BACK, tmpE);
      blendPose(out, out, tmpE, wB * slow);
    }
    if (twist) rotateBone(out, 0, 0, 1, 0, -twist);
    return twist;
  }
  function extrapolate(q, b, mean, k) {
    const o = b * 4;
    let mx = mean[o], my = mean[o + 1], mz = mean[o + 2], mw = mean[o + 3];
    const d0 = mx * q[o] + my * q[o + 1] + mz * q[o + 2] + mw * q[o + 3];
    if (d0 < 0) { mx = -mx; my = -my; mz = -mz; mw = -mw; }
    const th = Math.acos(Math.min(1, Math.abs(d0)));
    if (th < 1e-4) return;
    const sn = Math.sin(th), s0 = Math.sin((1 - k) * th) / sn, s1 = Math.sin(k * th) / sn;
    const x = mx * s0 + q[o] * s1, y = my * s0 + q[o + 1] * s1, z = mz * s0 + q[o + 2] * s1, w = mw * s0 + q[o + 3] * s1;
    const l = 1 / Math.hypot(x, y, z, w);
    q[o] = x * l; q[o + 1] = y * l; q[o + 2] = z * l; q[o + 3] = w * l;
  }

  // ---------------------------------------------------------------- procedural poses
  // Arms: (x, y, z) are character-space directions for the upper arm and forearm.
  function arms(pose, l1, l2, r1, r2, w = 1) {
    if (l1) aim(pose, I.LeftArm, l1[0], l1[1], l1[2], w);
    if (l2) aim(pose, I.LeftForeArm, l2[0], l2[1], l2[2], w);
    if (r1) aim(pose, I.RightArm, r1[0], r1[1], r1[2], w);
    if (r2) aim(pose, I.RightForeArm, r2[0], r2[1], r2[2], w);
  }
  // Lower the hips while keeping both feet where they are (knees bend).
  function crouch(pose, drop, stance = 0, fwdLean = 0, w = 1) {
    fk(pose);
    const L = P[I.LeftFoot].clone(), R = P[I.RightFoot].clone();
    if (stance) { L.x += stance; R.x -= stance; }
    L.y = Math.max(L.y, 0.075); R.y = Math.max(R.y, 0.075);
    pose.r[1] -= drop * w;
    rotateBone(pose, 0, 1, 0, 0, fwdLean * w);
    legIK(pose, 'Left', L.x, L.y, L.z, 1);
    legIK(pose, 'Right', R.x, R.y, R.z, 1);
  }
  const KEEPER_SET = p => {
    crouch(p, 0.17, 0.08, 0.32);
    arms(p, [0.55, -0.55, 0.62], [0.25, -0.2, 1], [-0.55, -0.55, 0.62], [-0.25, -0.2, 1]);
    rotateBone(p, I.Neck, 1, 0, 0, -0.25);
  };

  // Each action returns a pose into `act` and its blend weight; or null when inactive.
  function actionPose(c, t, look, ballPt, a) {
    const lefty = look?.foot === 'left';
    const u = t - c.t0, dur = c.t1 - c.t0;
    const envelope = (pre, post) => smooth((t - (c.t0 - pre)) / Math.max(0.05, pre + 0.05)) * smooth((c.t1 + post - t) / Math.max(0.05, post));
    switch (c.st) {
      case S.KICK: {
        const name = c.kind === 'shot' ? (c.seed < 0.5 ? 'kick_shot' : 'kick_shot2') : c.kind === 'long' ? 'kick_long' : 'kick_pass';
        const clip = lefty ? mirrored(name) : C[name];
        if (!clip) return null;
        const rate = c.kind === 'shot' ? 1 : c.kind === 'long' ? 1.08 : 1.18;
        const pre = clip.ref / rate, post = (clip.dur - clip.ref) / rate;
        if (t < c.anchor - pre || t > c.anchor + post) return null;
        sampleAction(clip, clip.ref + (t - c.anchor) * rate, act);
        if (c.kind === 'pass') {
          // Side-foot: open the kicking hip so the inside of the boot meets the ball.
          const legB = I[(lefty ? 'Left' : 'Right') + 'UpLeg'];
          const open = 0.55 * Math.exp(-Math.pow((t - c.anchor) / 0.22, 2));
          rotateBone(act, legB, 0, 1, 0, lefty ? open : -open);
        }
        const w = smooth((t - (c.anchor - pre)) / Math.min(0.35, pre)) * smooth((c.anchor + post - t) / 0.4) * (c.kind === 'pass' ? 0.9 : 1);
        return { w, shift: 'kick', clip };
      }
      case S.HEAD: {
        const clip = C.jump; if (!clip) return null;
        const rate = 1.45, pre = clip.ref / rate, post = (clip.dur - clip.ref) / rate;
        if (t < c.anchor - pre || t > c.anchor + post) return null;
        sampleAction(clip, clip.ref + (t - c.anchor) * rate, act);
        // Head snaps through the ball
        const snap = Math.exp(-Math.pow((t - c.anchor) / 0.09, 2));
        rotateBone(act, I.Spine1, 1, 0, 0, 0.35 * snap - 0.15 * smooth((c.anchor - t) / 0.25));
        rotateBone(act, I.Neck, 1, 0, 0, 0.3 * snap);
        const w = smooth((t - (c.anchor - pre)) / 0.25) * smooth((c.anchor + post - t) / 0.3);
        return { w, shift: 'head' };
      }
      case S.FALL: {
        const fall = C.fall, getup = C.getup;
        if (!fall || !getup) return null;
        const gStart = Math.max(1.6, dur - 3.4);           // time into the state when he starts getting up
        const getsUp = dur > 2.6 && c.k1 < c.N1;            // only if the state ends inside the clip
        if (u < 0) return null;
        if (!getsUp || u < gStart) {
          sampleAction(fall, Math.min(u * 1.1, fall.dur - 0.02), act);
          if (u > 1.6) { // writhe a little while down
            const s = Math.sin((u - 1.6) * 2.6) * 0.12;
            rotateBone(act, I.LeftUpLeg, 1, 0, 0, s); rotateBone(act, I.RightUpLeg, 1, 0, 0, -s * 0.7);
          }
          if (u > fall.dur * 0.9 && getsUp) { sampleAction(getup, 0, tmpC); blendPose(act, act, tmpC, smooth((u - fall.dur * 0.9) / 0.6)); }
        } else {
          sampleAction(getup, Math.min((u - gStart) * (getup.dur / 3.4), getup.dur - 0.02), act);
        }
        const w = smooth(u / 0.18) * (getsUp ? 1 : 1) * smooth((c.t1 + 0.35 - t) / 0.35);
        return { w };
      }
      case S.DIVE_L: case S.DIVE_R: {
        if (u < -0.15) return null;
        idlePose(act, t, a);
        const side = c.side, hi = c.high;
        const push = smooth(u / 0.22), fly = smooth((u - 0.12) / 0.35), land = smooth((u - 0.62) / 0.35);
        // set → spring → full stretch → land on the side
        crouch(act, 0.18 * (1 - push), 0.06, 0.25 * (1 - fly));
        const roll = side * -((1.05 + 0.35 * hi) * fly + (1.45 - (1.05 + 0.35 * hi)) * land);
        rotateBone(act, 0, 0, 0, 1, roll);
        act.r[0] += side * (0.25 * fly + 0.2 * land);
        act.r[1] = act.r[1] * (1 - fly) + (0.75 + 0.55 * hi) * fly * (1 - land) + 0.17 * land;
        // arms stretched along the body towards the ball, legs extended the other way
        const th = Math.abs(roll), sn = Math.sin(th), cs = Math.cos(th);
        const up = [side * sn, cs, 0.3], up2 = [side * sn * 0.9, cs, 0.45];
        arms(act, up, up, up2, up2, fly);
        aim(act, I.LeftUpLeg, -side * sn + 0.05, -cs, 0.12, fly * 0.7);
        aim(act, I.RightUpLeg, -side * sn - 0.05, -cs, -0.08, fly * 0.7);
        const w = smooth((u + 0.15) / 0.15) * smooth((c.t1 + 0.4 - t) / 0.4);
        return { w };
      }
      case S.SET: {
        idlePose(act, t, a); KEEPER_SET(act);
        return { w: envelope(0.25, 0.2) };
      }
      case S.HOLD: {
        idlePose(act, t, a);
        arms(act, [0.2, -0.55, 0.8], [-0.55, 0.35, 0.75], [-0.2, -0.55, 0.8], [0.55, 0.35, 0.75]);
        return { w: envelope(0.15, 0.3), upper: true };
      }
      case S.SLIDE: {
        if (u < -0.1) return null;
        idlePose(act, t, a);
        const sideK = lefty ? 1 : -1;  // kicking leg: right (−X) for right-footers
        // in: legs shoot out, hips drop, body leans back; out: body comes forward, hips rise, legs last
        const g = Math.max(0.5, dur - 0.7);
        const legs = smooth(u / 0.16) * (1 - smooth((u - g - 0.25) / 0.4));
        const drop = smooth(u / 0.26) * (1 - smooth((u - g - 0.1) / 0.45));
        const lean = smooth(u / 0.34) * (1 - smooth((u - g) / 0.35));
        act.r[1] = act.r[1] * (1 - drop) + 0.17 * drop;
        rotateBone(act, 0, 1, 0, 0, -0.95 * lean);            // lean back
        rotateBone(act, 0, 0, 0, 1, sideK * 0.18 * lean);     // onto the hip of the trailing leg
        const lead = lefty ? 'Left' : 'Right', trail = lefty ? 'Right' : 'Left';
        aim(act, I[lead + 'UpLeg'], -sideK * 0.1, -0.05, 1, legs);
        aim(act, I[lead + 'Leg'], -sideK * 0.08, 0.02, 1, legs);
        aim(act, I[trail + 'UpLeg'], sideK * 0.45, -0.05, 0.9, legs);
        aim(act, I[trail + 'Leg'], sideK * 0.05, -0.2, -1, legs);
        const supp = [sideK * -0.45, -0.75, -0.5], suppF = [sideK * -0.2, -0.95, -0.25], bal = [sideK * 0.75, 0.2, 0.45], balF = [sideK * 0.5, 0.45, 0.75];
        if (lefty) arms(act, supp, suppF, bal, balF, lean); else arms(act, bal, balF, supp, suppF, lean);
        return { w: smooth((u + 0.1) / 0.12) * smooth((c.t1 + 0.3 - t) / 0.3) };
      }
      case S.LUNGE: {
        idlePose(act, t, a);
        const q = smooth(u / 0.18) * (1 - smooth((u - 0.5) / 0.3));
        const lead = lefty ? 'Left' : 'Right', sideK = lefty ? 1 : -1;
        crouch(act, 0.12 * q, 0, 0.3 * q);
        aim(act, I[lead + 'UpLeg'], sideK * 0.3, -0.55, 0.8, q);
        aim(act, I[lead + 'Leg'], sideK * 0.25, -0.75, 0.6, q);
        arms(act, [0.75, -0.2, 0.3], [0.6, 0, 0.6], [-0.75, -0.2, 0.3], [-0.6, 0, 0.6], q);
        return { w: smooth((u + 0.05) / 0.12) * smooth((c.t1 + 0.25 - t) / 0.25) };
      }
      case S.CELEB: {
        // Upper body over the running legs: three celebrations, chosen per player and moment.
        const kind = Math.floor(c.seed * 3);
        copyPose(act, base);
        const pump = Math.sin(u * 9) * 0.5 + 0.5;
        if (kind === 0) arms(act, [1, 0.12, -0.15], [1, 0.15, -0.1], [-1, 0.12, -0.15], [-1, 0.15, -0.1]);           // aeroplane
        else if (kind === 1) arms(act, [0.3, 0.95, 0.15], [0.15, 1, 0.1], [-0.3, 0.95, 0.15], [-0.15, 1, 0.1]);      // both arms up
        else arms(act, null, null, [-0.35, 0.6 + 0.3 * pump, 0.45], [0.1, 1, 0.2 - 0.4 * pump]);                   // fist pump
        rotateBone(act, I.Neck, 1, 0, 0, -0.2);
        return { w: envelope(0.2, 0.4), upper: true };
      }
      case S.KNEESLIDE: {
        idlePose(act, t, a);
        const q = smooth(u / 0.3);
        act.r[1] = act.r[1] * (1 - q) + 0.5 * q;
        rotateBone(act, 0, 1, 0, 0, -0.55 * q);
        for (const [s, k] of [['Left', 1], ['Right', -1]]) {
          aim(act, I[s + 'UpLeg'], k * 0.16, -0.9, 0.38, q);
          aim(act, I[s + 'Leg'], k * 0.05, -0.12, -1, q);
        }
        arms(act, [0.95, 0.35, 0.1], [0.75, 0.65, 0.05], [-0.95, 0.35, 0.1], [-0.75, 0.65, 0.05], q);
        rotateBone(act, I.Neck, 1, 0, 0, -0.35 * q);
        return { w: envelope(0.15, 0.4) };
      }
      case S.DEJECT: {
        copyPose(act, base);
        arms(act, [0.75, 0.5, 0.25], [-0.7, 0.55, -0.15], [-0.75, 0.5, 0.25], [0.7, 0.55, -0.15]);
        rotateBone(act, I.Neck, 1, 0, 0, 0.35); rotateBone(act, I.Head, 1, 0, 0, 0.25);
        return { w: envelope(0.3, 0.4), upper: true };
      }
      case S.APPEAL: {
        copyPose(act, base);
        const s = Math.sin(u * 5) * 0.15;
        arms(act, [0.85, -0.15 + s, 0.45], [0.55, 0.25, 0.8], [-0.85, -0.15 - s, 0.45], [-0.55, 0.25, 0.8]);
        return { w: envelope(0.2, 0.3), upper: true };
      }
      case S.WALL: {
        idlePose(act, t, a);
        arms(act, [0.12, -1, 0.25], [-0.55, -0.35, 0.75], [-0.12, -1, 0.25], [0.55, -0.35, 0.75]);
        return { w: envelope(0.25, 0.3) };
      }
      case S.THROW: {
        idlePose(act, t, a);
        const k = smooth(u / Math.max(0.3, dur * 0.7));
        const back = 1 - k;
        arms(act, [0.25, 0.85, -0.45 * back + 0.35 * k], [0.05, 0.6 - 0.4 * back, -0.8 * back + 0.6 * k], [-0.25, 0.85, -0.45 * back + 0.35 * k], [-0.05, 0.6 - 0.4 * back, -0.8 * back + 0.6 * k]);
        rotateBone(act, 0, 1, 0, 0, -0.25 * back + 0.2 * k);
        return { w: envelope(0.2, 0.3), upper: true };
      }
      case S.CARD_Y: case S.CARD_R: {
        copyPose(act, base);
        const r = smooth(u / 0.35);
        arms(act, null, null, [-0.12, 0.97, 0.18], [-0.05, 1, 0.12], r);
        return { w: envelope(0.1, 0.35), upper: true };
      }
      case S.FLAG: {
        copyPose(act, base);
        const wave = Math.sin(u * 8) * 0.08;
        arms(act, null, null, [-0.15 + wave, 0.97, 0.12], [-0.1 + wave, 1, 0.05]);
        return { w: envelope(0.15, 0.35), upper: true };
      }
      case S.WHISTLE: {
        copyPose(act, base);
        arms(act, null, null, [-0.35, -0.45, 0.82], [0.55, 0.78, 0.3]);
        return { w: envelope(0.12, 0.25), upper: true };
      }
      case S.POINT: {
        copyPose(act, base);
        const r = smooth(u / 0.3);
        arms(act, null, null, [-0.55, 0.25, 0.8], [-0.5, 0.3, 0.82], r);
        return { w: envelope(0.15, 0.3), upper: true };
      }
      default: return null;
    }
  }

  // ---------------------------------------------------------------- main
  const out = { pose: makePose(B), x: 0, y: 0, yaw: 0, visible: true };
  const UPPER = new Uint8Array(B);
  for (const n of ['LowerBack', 'Spine', 'Spine1', 'Neck', 'Neck1', 'Head', 'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand', 'LeftFingerBase', 'LeftHandFinger1', 'LThumb', 'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand', 'RightFingerBase', 'RightHandFinger1', 'RThumb']) UPPER[I[n]] = 1;
  const LEGS = new Uint8Array(B);
  for (const n of ['LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase', 'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase']) LEGS[I[n]] = 1;
  const ARMS = new Uint8Array(B);
  for (const n of ['LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand', 'Neck', 'Neck1', 'Head']) ARMS[I[n]] = 1;

  function agentPose(clip, a, t, look, ball) {
    const prep = prepare(clip);
    const N = clip.N, A = N_AGENTS;
    const f = clamp(t * HZ, 0, N - 1), i = Math.floor(f), j = Math.min(i + 1, N - 1), u = f - i;
    const Pp = clip.pos;
    const x = Pp[(i * A + a) * 2] + (Pp[(j * A + a) * 2] - Pp[(i * A + a) * 2]) * u;
    const y = Pp[(i * A + a) * 2 + 1] + (Pp[(j * A + a) * 2 + 1] - Pp[(i * A + a) * 2 + 1]) * u;
    out.visible = x > -20;
    out.x = x; out.y = y;
    if (!out.visible) return out;
    const vel = k => {
      const k0 = Math.max(0, k - 2), k1 = Math.min(N - 1, k + 2), dt = (k1 - k0) / HZ || 1;
      return [(Pp[(k1 * A + a) * 2] - Pp[(k0 * A + a) * 2]) / dt, (Pp[(k1 * A + a) * 2 + 1] - Pp[(k0 * A + a) * 2 + 1]) / dt];
    };
    const v0 = vel(i), v1 = vel(j);
    const vx = v0[0] + (v1[0] - v0[0]) * u, vy = v0[1] + (v1[1] - v0[1]) * u;
    const sp = Math.hypot(vx, vy);
    const hdI = clip.hd[i * A + a], hdJ = clip.hd[j * A + a];
    const hd = hdI + angDiff(hdI, hdJ) * u;
    const k2 = Math.min(N - 1, i + 3), k0 = Math.max(0, i - 3);
    const yawRate = angDiff(clip.hd[k0 * A + a], clip.hd[k2 * A + a]) / (((k2 - k0) / HZ) || 1);
    const vA = vel(Math.max(0, i - 4)), vB = vel(Math.min(N - 1, i + 4));
    const acc = (Math.hypot(vB[0], vB[1]) - Math.hypot(vA[0], vA[1])) / (((Math.min(N - 1, i + 4) - Math.max(0, i - 4)) / HZ) || 1);
    const ph = clip.ph[i * A + a] + (clip.ph[j * A + a] - clip.ph[i * A + a]) * u;
    const fwd = sp > 0.05 ? (vx * Math.cos(hd) + vy * Math.sin(hd)) / sp : 1;
    const phi = sp > 0.05 ? Math.atan2(Math.cos(hd) * vy - Math.sin(hd) * vx, vx * Math.cos(hd) + vy * Math.sin(hd)) : 0;

    const pose = out.pose;
    const twist = locomotion(base, sp, ph, t, a, phi);
    // keep the chest and eyes on the ball while the hips run elsewhere
    if (twist) { rotateBone(base, I.Spine, 0, 1, 0, twist * 0.3); rotateBone(base, I.Spine1, 0, 1, 0, twist * 0.35); rotateBone(base, I.Neck, 0, 1, 0, twist * 0.2); rotateBone(base, I.Head, 0, 1, 0, twist * 0.15); }
    // Turning on the spot: the feet step round with the body instead of pivoting.
    const turnW = smooth((Math.abs(yawRate) - 0.5) / 1.5) * (1 - smooth((sp - 0.5) / 1.2));
    if (turnW > 0.01 && C.walk) {
      sampleCycle(C.walk, hd / 2.4, tmpC);
      tmpC.r[1] = base.r[1];
      blendMaskedInto(base, tmpC, turnW * 0.85, LEGS);
    }
    // Leans: into turns (roll) and with acceleration (pitch).
    rotateBone(base, 0, 0, 0, 1, clamp(yawRate * sp * 0.035, -0.35, 0.35));
    rotateBone(base, 0, 1, 0, 0, clamp(acc * 0.025, -0.12, 0.15));
    copyPose(pose, base);

    // Actions
    let dx = 0, dy = 0, headLook = 1;
    prep.N1 = N - 1;
    for (const c of prep.inst[a]) {
      if (t < c.t0 - 1.3 || t > c.t1 + 1.3) continue;
      c.N1 = N - 1;
      const ac = actionPose(c, t, look, ball, a);
      if (!ac || ac.w <= 0) continue;
      if (ac.upper) { blendMaskedInto(pose, act, ac.w, UPPER); headLook *= 1 - ac.w * 0.5; }
      else { blendPose(pose, pose, act, ac.w); headLook *= 1 - ac.w; }
      // Contact: move the player so the boot / forehead meets the ball where the engine has it.
      if (ac.shift === 'kick' && ac.clip) {
        const m = kickContact(ac.clip);
        const toe = (look?.foot === 'left') ? m.toe : m.right;
        const [ex, ey] = charToEngine(toe.x, toe.z, c.hd);
        let sx = c.ball.x - (c.pos.x + ex), sy = c.ball.y - (c.pos.y + ey);
        const l = Math.hypot(sx, sy); if (l > 0.9) { sx *= 0.9 / l; sy *= 0.9 / l; }
        const g = Math.exp(-Math.pow((t - c.anchor) / 0.32, 2)) * ac.w;
        dx += sx * g; dy += sy * g;
      } else if (ac.shift === 'head') {
        const [ex, ey] = charToEngine(0, 0.12, c.hd);
        let sx = c.ball.x - (c.pos.x + ex), sy = c.ball.y - (c.pos.y + ey);
        const l = Math.hypot(sx, sy); if (l > 0.8) { sx *= 0.8 / l; sy *= 0.8 / l; }
        const g = Math.exp(-Math.pow((t - c.anchor) / 0.3, 2)) * ac.w;
        dx += sx * g; dy += sy * g;
      }
    }

    // Head and chest follow the ball (less while busy).
    if (ball && headLook > 0.02) {
      const want = Math.atan2(ball.y - y, ball.x - x);
      const d = clamp(angDiff(hd, want), -1.4, 1.4) * (sp > 5 ? 0.35 : 1) * headLook;
      rotateBone(pose, I.Spine1, 0, 1, 0, -d * 0.25);
      rotateBone(pose, I.Neck, 0, 1, 0, -d * 0.3);
      rotateBone(pose, I.Head, 0, 1, 0, -d * 0.35);
    }
    out.yaw = hd;
    out.x = x + dx; out.y = y + dy;
    return out;
  }
  function blendMaskedInto(dst, src, w, mask) {
    for (let b = 0; b < B; b++) if (mask[b]) {
      const o = b * 4;
      let x = src.q[o], y = src.q[o + 1], z = src.q[o + 2], ww = src.q[o + 3];
      const d = x * dst.q[o] + y * dst.q[o + 1] + z * dst.q[o + 2] + ww * dst.q[o + 3];
      if (d < 0) { x = -x; y = -y; z = -z; ww = -ww; }
      const nx = dst.q[o] + (x - dst.q[o]) * w, ny = dst.q[o + 1] + (y - dst.q[o + 1]) * w, nz = dst.q[o + 2] + (z - dst.q[o + 2]) * w, nw = dst.q[o + 3] + (ww - dst.q[o + 3]) * w;
      const l = 1 / Math.hypot(nx, ny, nz, nw);
      dst.q[o] = nx * l; dst.q[o + 1] = ny * l; dst.q[o + 2] = nz * l; dst.q[o + 3] = nw * l;
    }
  }
  // Character-space (x: left, z: forward) offset → engine (x, y) for heading hd.
  function charToEngine(lx, lz, hd) {
    const th = Math.PI / 2 - hd, c = Math.cos(th), s = Math.sin(th);
    return [lx * c + lz * s, -lx * s + lz * c];
  }

  return { agentPose, prepare };
}
