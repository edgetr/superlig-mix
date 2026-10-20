// Ball physics: gravity, quadratic air drag, Magnus force from spin (curl, dip), bounces with
// friction, rolling resistance on grass, goal frame and net collisions. Every pass, cross and shot
// is a real strike: the solvers below find the initial velocity that makes the simulated ball
// arrive where (and when) the play needs it.
import { L, WD, GOAL_W, GOAL_H, POST_A, POST_B } from './const.js';

export const R = 0.11;            // radius (m)
const G = 9.81;
const KD = 0.0135;                // drag: a = −KD·|v|·v   (½ρ·Cd·A / m for a size-5 ball)
const KM = 0.0055;                // Magnus: a = KM · (ω × v)
const ROLL = 0.75;                // rolling resistance on grass (m/s²)
const BOUNCE = 0.55;              // vertical restitution
const SUB = 1 / 240;              // integration step
const POST_R = 0.06;
const NET_TOP = 1.4, NET_BOT = 2.0; // net depth at the crossbar / at the ground

export function makeBall(x, y, z = R) { return { x, y, z, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0, inNet: 0 }; }
export const copyBall = b => ({ ...b });

// Advance by dt; returns { goal: sideX|null, post: bool, bounced: bool }.
export function stepBall(b, dt, ev = null) {
  const n = Math.max(1, Math.round(dt / SUB)), h = dt / n;
  for (let i = 0; i < n; i++) {
    const onGround = b.z <= R + 1e-3 && Math.abs(b.vz) < 0.05;
    const sp = Math.hypot(b.vx, b.vy, b.vz);
    let ax = -KD * sp * b.vx, ay = -KD * sp * b.vy, az = -KD * sp * b.vz;
    ax += KM * (b.wy * b.vz - b.wz * b.vy);
    ay += KM * (b.wz * b.vx - b.wx * b.vz);
    az += KM * (b.wx * b.vy - b.wy * b.vx);
    if (onGround) {
      az = 0; b.vz = 0; b.z = R;
      const hs = Math.hypot(b.vx, b.vy);
      if (hs < 0.04) { b.vx = b.vy = 0; ax = ay = 0; }
      else { ax -= (ROLL * b.vx) / hs; ay -= (ROLL * b.vy) / hs; }
      const k = Math.exp(-4 * h); b.wx *= k; b.wy *= k; b.wz *= k;   // grass kills spin
    } else {
      az -= G;
      const k = Math.exp(-0.08 * h); b.wx *= k; b.wy *= k; b.wz *= k;
    }
    const pvx = b.vx, pvy = b.vy;
    b.vx += ax * h; b.vy += ay * h; b.vz += az * h;
    // friction can stop a rolling ball, never reverse it
    if (onGround && pvx * b.vx + pvy * b.vy < 0) { b.vx = 0; b.vy = 0; }
    const px = b.x, py = b.y;
    b.x += b.vx * h; b.y += b.vy * h; b.z += b.vz * h;
    if (b.z < R) {
      b.z = R;
      if (b.vz < -0.8) { b.vz = -BOUNCE * b.vz; b.vx *= 0.86; b.vy *= 0.86; b.wx *= 0.5; b.wy *= 0.5; b.wz *= 0.6; if (ev) ev.bounced = true; }
      else b.vz = 0;
    }
    frame(b, px, py, ev);
  }
  return ev;
}

// Goal frame (posts, crossbar) and the net.
function frame(b, px, py, ev) {
  for (const gx of [0, L]) {
    const s = gx > 0 ? 1 : -1;
    // Posts: vertical cylinders at (gx, POST_A|POST_B)
    if (b.z < GOAL_H + R) {
      for (const py0 of [POST_A, POST_B]) {
        const dx = b.x - gx, dy = b.y - py0, d = Math.hypot(dx, dy);
        if (d < R + POST_R && d > 1e-6) {
          const nx = dx / d, ny = dy / d, vn = b.vx * nx + b.vy * ny;
          if (vn < 0) { b.vx -= 1.65 * vn * nx; b.vy -= 1.65 * vn * ny; b.vx *= 0.9; b.vy *= 0.9; if (ev) ev.post = true; }
          b.x = gx + nx * (R + POST_R); b.y = py0 + ny * (R + POST_R);
        }
      }
    }
    // Crossbar: horizontal cylinder along y at (gx, GOAL_H)
    if (b.y > POST_A && b.y < POST_B) {
      const dx = b.x - gx, dz = b.z - GOAL_H, d = Math.hypot(dx, dz);
      if (d < R + POST_R && d > 1e-6) {
        const nx = dx / d, nz = dz / d, vn = b.vx * nx + b.vz * nz;
        if (vn < 0) { b.vx -= 1.6 * vn * nx; b.vz -= 1.6 * vn * nz; if (ev) ev.post = true; }
        b.x = gx + nx * (R + POST_R); b.z = GOAL_H + nz * (R + POST_R);
      }
    }
    // Crossing the goal line between the posts, under the bar → goal; then the net holds it.
    const crossed = (px - gx) * s < 0 && (b.x - gx) * s >= 0;
    if (crossed && b.y > POST_A + R * 0.5 && b.y < POST_B - R * 0.5 && b.z < GOAL_H) { b.inNet = s; if (ev) ev.goal = gx; }
    if (b.inNet === s) {
      const depth = NET_BOT + (NET_TOP - NET_BOT) * Math.min(1, b.z / GOAL_H);
      const back = gx + s * (depth - R);
      if ((b.x - back) * s > 0) { b.x = back; if (b.vx * s > 0) b.vx = -b.vx * 0.12; b.vy *= 0.4; b.wz = 0; }
      if (b.y < POST_A + R) { b.y = POST_A + R; b.vy = Math.abs(b.vy) * 0.15; }
      if (b.y > POST_B - R) { b.y = POST_B - R; b.vy = -Math.abs(b.vy) * 0.15; }
      if (b.z > GOAL_H - R) { b.z = GOAL_H - R; b.vz = Math.min(0, b.vz) * 0.2; }
      if ((b.x - gx) * s < R) { b.x = gx + s * R; b.vx = 0; }
    }
  }
}

// Positions along the ball's future path (no players interfering), every `dt` for `T` seconds.
export function predict(b, T, dt = 0.1) {
  const c = copyBall(b), out = [];
  for (let t = 0; t <= T + 1e-6; t += dt) { out.push({ t, x: c.x, y: c.y, z: c.z, vx: c.vx, vy: c.vy }); stepBall(c, dt); }
  return out;
}

// Rolling pass: horizontal speed v0 towards `to`; time and speed when it has covered distance d.
function rollRun(v0, d) {
  const b = makeBall(0, 0); b.vx = v0;
  let t = 0;
  while (t < 8) {
    stepBall(b, 1 / 60); t += 1 / 60;
    if (b.x >= d) return { t, v: b.vx };
    if (b.vx < 0.05) return { t: Infinity, v: 0 };
  }
  return { t: Infinity, v: 0 };
}
// Ground pass that reaches `to` after T seconds (or as close as physics allows).
export function solveGround(from, to, T) {
  const d = Math.hypot(to.x - from.x, to.y - from.y);
  let lo = 0.5, hi = 38;
  for (let i = 0; i < 26; i++) { const m = (lo + hi) / 2; if (rollRun(m, d).t > T) lo = m; else hi = m; }
  const v0 = (lo + hi) / 2, ux = (to.x - from.x) / (d || 1), uy = (to.y - from.y) / (d || 1);
  return { vx: ux * v0, vy: uy * v0, vz: 0, wx: 0, wy: 0, wz: 0, T: rollRun(v0, d).t, v0 };
}
// Ground pass that arrives with speed vArr (a weighted pass the receiver can take in stride).
export function groundForArrival(from, to, vArr) {
  const d = Math.hypot(to.x - from.x, to.y - from.y);
  let lo = 0.5, hi = 38;
  for (let i = 0; i < 26; i++) { const m = (lo + hi) / 2; const r = rollRun(m, d); if (r.v < vArr) lo = m; else hi = m; }
  const v0 = (lo + hi) / 2;
  return solveGround(from, to, rollRun(v0, d).t);
}

// Airborne strike: initial velocity so the ball is at `to` (x, y, z) exactly T seconds later,
// with drag and spin. Shooting method: simulate, correct by the miss, repeat.
export function solveFlight(from, to, T, spin = { wx: 0, wy: 0, wz: 0 }) {
  let vx = (to.x - from.x) / T, vy = (to.y - from.y) / T, vz = ((to.z ?? R) - (from.z ?? R) + 0.5 * G * T * T) / T;
  for (let i = 0; i < 14; i++) {
    const b = makeBall(from.x, from.y, from.z ?? R);
    Object.assign(b, { vx, vy, vz, wx: spin.wx || 0, wy: spin.wy || 0, wz: spin.wz || 0 });
    flyNoBounce(b, T);
    const ex = to.x - b.x, ey = to.y - b.y, ez = (to.z ?? R) - b.z;
    if (Math.hypot(ex, ey, ez) < 0.01) break;
    vx += ex / T; vy += ey / T; vz += ez / T;
  }
  return { vx, vy, vz, wx: spin.wx || 0, wy: spin.wy || 0, wz: spin.wz || 0, T };
}
// Same integrator but ignoring the ground (the solve target may be at ground level).
function flyNoBounce(b, T) {
  const n = Math.max(1, Math.round(T / SUB)), h = T / n;
  for (let i = 0; i < n; i++) {
    const sp = Math.hypot(b.vx, b.vy, b.vz);
    const ax = -KD * sp * b.vx + KM * (b.wy * b.vz - b.wz * b.vy);
    const ay = -KD * sp * b.vy + KM * (b.wz * b.vx - b.wx * b.vz);
    const az = -KD * sp * b.vz + KM * (b.wx * b.vy - b.wy * b.vx) - G;
    b.vx += ax * h; b.vy += ay * h; b.vz += az * h;
    b.x += b.vx * h; b.y += b.vy * h; b.z += b.vz * h;
  }
}
// Apex height of a strike (for choosing loft so a ball clears players).
export function apexOf(from, v) {
  const b = makeBall(from.x, from.y, from.z ?? R); Object.assign(b, v);
  let top = b.z;
  for (let t = 0; t < 4 && (b.vz > 0 || t < 0.05); t += 1 / 60) { flyNoBounce(b, 1 / 60); top = Math.max(top, b.z); }
  return top;
}
