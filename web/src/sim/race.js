// Who gets there first: time-to-reach and interception estimates shared by every decision in the
// engine — the dribbler choosing how far to knock it, a defender deciding to go for a loose ball or
// to stay on his feet, a receiver attacking a pass, a passer checking a lane.
//
// The run model matches the bodies in world.js: a reaction delay, the time to turn (and to brake
// first when moving the wrong way), then acceleration that fades towards top speed:
//   v(t) = vm − (vm − v0)·e^(−t/τ)   →   d(t) = vm·t − (vm − v0)·τ·(1 − e^(−t/τ))
import { clamp, angDiff } from './const.js';

const BRAKE = 7.0;

// Distance covered in `t` seconds running straight, starting at speed v0 along the run.
export function runDist(ag, v0, t) {
  if (t <= 0) return 0;
  const vm = ag.vmax, tau = vm / (ag.acc + 0.5);
  return vm * t - (vm - v0) * tau * (1 - Math.exp(-t / tau));
}

// Seconds for agent `ag` to get within `reach` metres of point p (x, y).
// opts.react: perception delay to add (default: the agent's own reaction time).
export function timeTo(ag, p, reach = 0.6, opts = {}) {
  const dx = p.x - ag.x, dy = p.y - ag.y, d = Math.hypot(dx, dy) - reach;
  const react = opts.react ?? ag.react;
  if (d <= 0) return react * 0.5;
  const ux = dx / (d + reach), uy = dy / (d + reach);
  const sp = Math.hypot(ag.vx, ag.vy);
  const along = ag.vx * ux + ag.vy * uy;
  let t = react, v0 = Math.max(0, along);
  // moving the wrong way: brake first (covers ground backwards while stopping)
  let back = 0;
  if (along < -0.3) { const tb = -along / BRAKE; t += tb; back = (along * along) / (2 * BRAKE); v0 = 0; }
  // turning the body: quick when slow, slower at speed (sideways momentum also has to go)
  const face = Math.atan2(uy, ux);
  const turn = Math.abs(angDiff(ag.face, face));
  t += turn > 0.6 ? (turn - 0.6) * (0.12 + 0.05 * sp) : 0;
  const perp = Math.abs(ag.vx * uy - ag.vy * ux);
  t += perp * 0.06;
  const need = d + back;
  // invert d(t) with Newton steps
  let s = need / Math.max(1, (v0 + ag.vmax) / 2);
  for (let i = 0; i < 6; i++) {
    const f = runDist(ag, v0, s) - need;
    const vm = ag.vmax, tau = vm / (ag.acc + 0.5);
    const v = vm - (vm - v0) * Math.exp(-s / tau);
    s = Math.max(0, s - f / Math.max(0.5, v));
  }
  return t + s;
}

// Earliest moment the agent can play a ball moving along `path` ([{t, x, y, z}], from now).
// Ball height decides what he can do: feet < 0.9 m, chest/thigh < 1.5, head < 2.6 (if allowed).
// Returns { t, x, y, z, i } or null if he can't get to it within the path.
export function interceptOf(ag, path, opts = {}) {
  if (!path || !path.length) return null;
  const reach = opts.reach ?? 0.7, zmax = opts.zmax ?? 1.5, slack = opts.slack ?? 0;
  for (let i = 0; i < path.length; i++) {
    const q = path[i];
    if (q.z > zmax + 0.11) continue;
    const tt = timeTo(ag, q, reach, opts);
    if (tt <= q.t + slack) return { t: Math.max(q.t, tt), x: q.x, y: q.y, z: q.z, i };
  }
  return null;
}

// Best interceptor among `agents` for a ball path: [{ ag, t, x, y }] sorted by arrival.
export function raceFor(agents, path, opts = {}) {
  const out = [];
  for (const ag of agents) {
    if (ag.gone || ag.free) continue;
    const r = interceptOf(ag, path, opts);
    if (r) out.push({ ag, ...r });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

// Margin (s) by which agent `me` beats the fastest of `others` to the ball on `path`; −Inf if he
// can't get to it at all, +Inf if nobody else can.
export function raceMargin(me, others, path, opts = {}) {
  const mine = interceptOf(me, path, { ...opts, react: opts.myReact ?? 0 });
  if (!mine) return -Infinity;
  let best = Infinity;
  for (const o of others) {
    if (o.gone || o.free) continue;
    const r = interceptOf(o, path, opts);
    if (r) best = Math.min(best, r.t);
  }
  return best - mine.t;
}

export const clampAngle = (a, centre, max) => centre + clamp(angDiff(centre, a), -max, max);
