// Running with the ball. The ball is never attached to the player: it rolls by itself (skidding
// after each touch, then rolling — ./ball.js) and the carrier only acts on it through touches.
//
// A touch happens with the foot that is swinging through (from the gait phase), when the ball is
// in front of that foot, and only in directions a foot can send it relative to the body: the
// laces/instep straight on, the inside of the foot across the body, the outside away from it, the
// sole to stop it or drag it back. Turning with the ball therefore takes time: at pace he can only
// bend his run; a sharp change needs a checking touch to slow down first, a cut with the inside or
// outside of the foot, and anything behind him a stop or a drag-back and a turn of the body.
//
// How far each touch goes is a decision: in space he knocks it on and runs onto it; with an
// opponent near he keeps it close. Every candidate touch is checked against everyone who could get
// to the ball before he does (./race.js) — a dribbler who knocks it too far loses it.
import { DT, clamp, angDiff, other, baseOf } from './const.js';
import { R, makeBall, stepBall } from './ball.js';
import { timeTo, runDist } from './race.js';

export const FOOT_FWD = 0.42;     // ball ahead of the body centre when the foot meets it
const TAU = Math.PI * 2;
const dirv = a => [Math.cos(a), Math.sin(a)];

// ------------------------------------------------------------------ gait → which foot is free
// Right foot swings through phase ~0.05–0.45 of the gait cycle, left ~0.55–0.95 (mocap cycles).
export function swingFoot(ph) {
  const f = ph - Math.floor(ph);
  if (f > 0.2 && f < 0.48) return 'R';
  if (f > 0.7 && f < 0.98) return 'L';
  return null;
}

// ------------------------------------------------------------------ touch physics
// Ball velocity, with part of the spin of a rolling ball (a push with the laces rolls; a stab with
// the inside skids).
export function applyTouch(b, vx, vy, roll = 0.5) {
  b.vx = vx; b.vy = vy; b.vz = 0; b.z = R;
  b.wy = (vx / R) * roll; b.wx = (-vy / R) * roll; b.wz = 0;
}
// Where the ball will be over the next `T` seconds after a touch (ground physics, no players).
const scratch = makeBall(0, 0);
export function touchPath(x, y, vx, vy, roll, T = 2.4, dt = 0.1) {
  const b = scratch;
  b.x = x; b.y = y; b.z = R; b.inNet = 0; b.vz = 0;
  applyTouch(b, vx, vy, roll);
  const out = [{ t: 0, x, y, z: R, vx, vy }];
  for (let t = dt; t <= T + 1e-6; t += dt) { stepBall(b, dt); out.push({ t, x: b.x, y: b.y, z: b.z, vx: b.vx, vy: b.vy }); if (Math.hypot(b.vx, b.vy) < 0.05) break; }
  return out;
}

// Ball speed for a touch that runs `gap` metres ahead of a player who is moving at `sp0` and
// picks up to `pace` (the gap opens while the ball is quicker, closes once friction has slowed it
// below him).
const gapMemo = new Map();
export function speedForGap(pace, gap, roll, sp0 = pace) {
  const p = Math.round(pace * 4) / 4, g = Math.round(gap * 10) / 10, r = Math.round(roll * 10) / 10, s0 = Math.round(Math.min(sp0, pace) * 2) / 2;
  const key = `${p}|${g}|${r}|${s0}`;
  let v = gapMemo.get(key);
  if (v != null) return v;
  const maxGap = v0 => {
    const b = makeBall(FOOT_FWD, 0); applyTouch(b, v0, 0, r);
    let best = FOOT_FWD, px = 0, vp = s0;
    for (let t = 0; t < 3.5; t += 1 / 30) {
      stepBall(b, 1 / 30);
      vp = Math.min(p, vp + 3.2 / 30); px += vp / 30;
      const gp = b.x - px; if (gp > best) best = gp;
      if (gp < best - 0.05 || b.vx < 0.05) break;
    }
    return best;
  };
  let lo = 0.2, hi = p + 12;
  for (let i = 0; i < 22; i++) { const m = (lo + hi) / 2; if (maxGap(m) < g) lo = m; else hi = m; }
  v = (lo + hi) / 2;
  gapMemo.set(key, v);
  return v;
}

// How far round from his facing a foot can send the ball at this running speed (radians).
export function coneOf(speed) {
  if (speed < 1.2) return 2.0;       // standing: inside/outside/sole can go almost anywhere in front
  if (speed < 3) return 1.4;
  if (speed < 5) return 0.95;
  if (speed < 6.5) return 0.6;
  return 0.42;                       // sprinting: he can only bend it
}

// ------------------------------------------------------------------ the touch decision
// `intent`: { to: {x,y} | dir (radians), pace (m/s), keep (bool: close control), evade: agent id }
// Returns { dir, v, roll, kind } or null when no touch is needed now.
export function planTouch(w, ag, intent, opts = {}) {
  const b = w.ball;
  const sp = Math.hypot(ag.vx, ag.vy);
  const want = intent.dir ?? intent._dir ?? Math.atan2(intent.to.y - b.y, intent.to.x - b.x);
  const pace = intent.pace ?? 5;
  const face = ag.face;
  const cone = coneOf(sp);
  const off = angDiff(face, want);
  const opp = opponents(w, ag);
  const protect = w.protect === ag.side;

  // A turn the foot can't make at this speed: check it first (slow it, slow down), then cut.
  if (Math.abs(off) > cone + 0.25 && sp > 2.2) {
    const v = Math.max(0.6, sp * 0.55);
    return { dir: face + clamp(off, -0.35, 0.35), v, roll: 0.15, kind: 'check' };
  }
  // Behind him and slow: sole stop / drag-back, then he turns with it.
  if (Math.abs(off) > 2.0) {
    const v = sp < 1 ? 1.6 : 0.9;
    return { dir: want, v, roll: 0.0, kind: 'drag' };
  }

  // Candidate touches: directions within the cone around what he wants, distances from close
  // control to knock-and-run, each raced against every opponent.
  const close = nearestDist(opp, ag);
  const toGo = intent.to ? Math.hypot(intent.to.x - b.x, intent.to.y - b.y) : 30;
  const maxGap = Math.min(intent.keep ? 0.95 : clamp(1.2 + (pace - 3) * 0.8, 1.2, 6) * (close < 4 ? 0.6 : 1), Math.max(0.7, toGo * 0.45));
  const gaps = [0.7, 1.1, 1.6, 2.4, 3.6, 5.2].filter(g => g <= maxGap + 0.05);
  if (!gaps.length) gaps.push(0.6);
  const dirs = [0, 0.22, -0.22, 0.45, -0.45, 0.75, -0.75];
  let best = null;
  for (const da of dirs) {
    const a = want + da;
    if (Math.abs(angDiff(face, a)) > cone) continue;
    for (const g of gaps) {
      const runPace = Math.min(ag.vmax, Math.max(pace, g > 2.4 ? pace + 0.8 : pace));
      const v = Math.min(speedForGap(runPace, g, 0.55, sp), Math.max(sp, 2) + 4.5);
      const [ux, uy] = dirv(a);
      const path = touchPath(b.x, b.y, ux * v, uy * v, 0.55, 2.4);
      // when he gets back on it: the ball has slowed below his pace and he's caught it up
      const mine = ownArrival(ag, path, runPace, a);
      if (mine == null || mine > 1.8) continue;
      // never knock it out of play
      if (path.some(q => q.t <= mine + 0.6 && (q.x < 0.6 || q.x > 104.4 || q.y < 0.6 || q.y > 67.4))) continue;
      // anyone who gets there first (or at the same moment) takes it off him
      let margin = 9;
      for (const o of opp) {
        const tt = earliest(o, path, mine + 0.3);
        if (tt != null) margin = Math.min(margin, tt - mine);
      }
      const end = path[Math.min(path.length - 1, Math.round(mine / 0.1))];
      const prog = intent.to ? Math.hypot(intent.to.x - b.x, intent.to.y - b.y) - Math.hypot(intent.to.x - end.x, intent.to.y - end.y) : (end.x - b.x) * Math.cos(want) + (end.y - b.y) * Math.sin(want);
      let s = prog * 0.5 - Math.abs(da) * 2.2 - Math.abs(g - preferredGap(pace, close)) * 0.35;
      const need = protect ? 0.45 : 0.28;
      if (margin < need) s -= (need - margin) * (protect ? 30 : 14);
      if (!best || s > best.s) best = { dir: a, v, roll: 0.55, kind: g > 2 ? 'knock' : 'push', s, margin, gap: g };
    }
  }
  if (!best) {
    const a = face + clamp(off, -cone, cone);
    return { dir: a, v: speedForGap(Math.max(2, sp), 0.8, 0.5, sp), roll: 0.5, kind: 'push' };
  }
  // Nothing safe: keep it under the sole and protect it (he'll look for a pass).
  if (best.margin < 0.05 && close < 2.2) {
    const away = opp.length ? awayFrom(ag, opp, face) : face;
    const a = face + clamp(angDiff(face, away), -cone, cone);
    return { dir: a, v: Math.max(0.4, Math.min(sp, 1.6)), roll: 0.1, kind: 'shield' };
  }
  return best;
}

function preferredGap(pace, close) {
  if (close < 2.5) return 0.7;
  if (close < 5) return 1.2;
  return pace > 6.5 ? 3.6 : pace > 5 ? 2.4 : pace > 3.5 ? 1.6 : 1.1;
}
function opponents(w, ag) {
  const out = [], b0 = baseOf(other(ag.side));
  for (let i = 0; i < 11; i++) { const o = w.agents[b0 + i]; if (!o.gone && !o.free) out.push(o); }
  return out;
}
function nearestDist(opp, ag) { let d = 99; for (const o of opp) d = Math.min(d, Math.hypot(o.x - ag.x, o.y - ag.y)); return d; }
function awayFrom(ag, opp, face) {
  let ax = 0, ay = 0;
  for (const o of opp) { const dx = ag.x - o.x, dy = ag.y - o.y, d = Math.hypot(dx, dy); if (d < 4) { ax += dx / (d * d); ay += dy / (d * d); } }
  return ax || ay ? Math.atan2(ay, ax) : face;
}
// The carrier runs on at `pace` along `a`: when is he back on the ball (gap ≤ foot reach)?
function ownArrival(ag, path, pace, a) {
  const [ux, uy] = dirv(a);
  const sp0 = Math.max(0, ag.vx * ux + ag.vy * uy);
  for (let i = 1; i < path.length; i++) {
    const q = path[i];
    // he runs after it flat out if he has to (same acceleration model as the bodies)
    const run = runDist(ag, sp0, q.t);
    const ahead = (q.x - ag.x) * ux + (q.y - ag.y) * uy - run;
    if (q.t > 0.25 && ahead < FOOT_FWD + 0.15) return q.t;
  }
  return null;
}
function earliest(o, path, until) {
  for (const q of path) {
    if (q.t > until) break;
    if (timeTo(o, q, 0.75) <= q.t) return q.t;
  }
  return null;
}

// ------------------------------------------------------------------ is a touch possible now?
// The ball must be in front of the foot that is swinging through, low, within reach.
export function touchWindow(ag, b, urgent = false) {
  if (b.z > 0.55) return null;
  const c = Math.cos(ag.face), s = Math.sin(ag.face);
  const rx = b.x - ag.x, ry = b.y - ag.y;
  const fwd = rx * c + ry * s, lat = -rx * s + ry * c;     // lat > 0: ball on his left
  const sp = Math.hypot(ag.vx, ag.vy);
  // standing over it he can reach round it with the sole, the heel, the outside
  const standing = sp < 1.2 && Math.hypot(rx, ry) < 0.8;
  if (!standing && (fwd < 0.05 || fwd > 0.95 || Math.abs(lat) > 0.55)) return null;
  let foot = swingFoot(ag.ph);
  if (sp < 1.2) foot = lat > 0.05 ? 'L' : lat < -0.05 ? 'R' : (ag.foot === 'left' ? 'L' : 'R');   // standing: either foot, any time
  if (!foot) { if (!urgent) return null; foot = lat > 0 ? 'L' : 'R'; }
  // the ball has to be on that foot's side (or central)
  if (foot === 'L' && lat < -0.32) return urgent ? { foot: 'R', fwd, lat } : null;
  if (foot === 'R' && lat > 0.32) return urgent ? { foot: 'L', fwd, lat } : null;
  return { foot, fwd, lat };
}

// Does the carrier need to touch it now? (catching it up, off line, or under threat)
export function needTouch(w, ag, intent) {
  const b = w.ball;
  const c = Math.cos(ag.face), s = Math.sin(ag.face);
  const rx = b.x - ag.x, ry = b.y - ag.y;
  const fwd = rx * c + ry * s;
  const bAlong = b.vx * c + b.vy * s, sp = Math.hypot(ag.vx, ag.vy);
  const closing = sp - bAlong;
  if (fwd < FOOT_FWD + 0.12 && closing > -0.2) return true;        // about to run onto it
  if (Math.hypot(b.vx, b.vy) < 0.25 && (intent.pace ?? 0) > 0.8) return true;   // dead at his feet, he wants to go
  const want = intent.dir ?? intent._dir ?? Math.atan2(intent.to.y - b.y, intent.to.x - b.x);
  const bdir = Math.atan2(b.vy, b.vx);
  if (Math.hypot(b.vx, b.vy) > 0.4 && Math.abs(angDiff(bdir, want)) > 0.3 && fwd < 0.8) return true;
  return false;
}

// A challenge is coming in: take the ball away from the tackling foot — past him, round him, or
// out of his reach — wherever the others can't get to it first.
export function evadeTouch(w, ag, want, tk) {
  const b = w.ball;
  const sp = Math.hypot(ag.vx, ag.vy);
  const cone = coneOf(sp) + 0.35;
  const fx = tk.x + Math.cos(tk.face) * 0.9, fy = tk.y + Math.sin(tk.face) * 0.9;
  const opp = opponents(w, ag).filter(o => o !== tk);
  let best = null;
  for (let da = -1.6; da <= 1.61; da += 0.2) {
    const a = want + da;
    if (Math.abs(angDiff(ag.face, a)) > cone) continue;
    for (const g of [1.2, 1.8, 2.6]) {
      const pace = Math.min(ag.vmax, Math.max(sp, 4) + 1.2);
      const v = Math.min(speedForGap(pace, g, 0.55, sp), Math.max(sp, 2) + 4.5);
      const [ux, uy] = dirv(a);
      const path = touchPath(b.x, b.y, ux * v, uy * v, 0.55, 2.0);
      // through the tackle? (his foot sweeps a circle around where it lands)
      if (path.some(q => q.t < 0.55 && Math.hypot(q.x - fx, q.y - fy) < 1.15)) continue;
      if (path.some(q => q.t < 1.4 && (q.x < 0.6 || q.x > 104.4 || q.y < 0.6 || q.y > 67.4))) continue;
      const mine = ownArrival(ag, path, pace, a);
      if (mine == null || mine > 1.8) continue;
      let margin = 9;
      for (const o of opp) { const tt = earliest(o, path, mine + 0.3); if (tt != null) margin = Math.min(margin, tt - mine); }
      const end = path[Math.min(path.length - 1, Math.round(mine / 0.1))];
      const prog = (end.x - b.x) * Math.cos(want) + (end.y - b.y) * Math.sin(want);
      const s = prog * 0.4 - Math.abs(da) * 0.8 + Math.min(margin, 1) * 4;
      if (!best || s > best.s) best = { dir: a, v, roll: 0.55, kind: 'knock', s };
    }
  }
  return best;
}
