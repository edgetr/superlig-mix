// Deterministic football match engine.
//
// GPT writes the match script (who did what, where, how). This module turns every scripted
// moment into a short, physically plausible piece of football: both teams keep their shape
// (driven by formation, playing style, ball position and possession), the defensive line holds
// an offside line, goalkeepers guard their goal, pressers close down, runners time their runs,
// and the ball travels as real passes, crosses and shots. Restarts follow the Laws of the Game
// (kick-off, free kick from the foul spot with a 9.15 m wall, penalty from the spot, corner from
// the right flag, goal kick, throw-in, indirect free kick for offside, sides switch at half-time).
//
// Everything is a pure function of (teams, event, match context, seed): the same input always
// produces the same frames, so the "video" is reproducible and exportable.

import { FORMATIONS } from '../../../shared/game.js';
export const FORMATION_TABLE = FORMATIONS;

// ------------------------------------------------------------------ constants & helpers
export const L = 105, WD = 68, GOAL_W = 7.32, GOAL_H = 2.44;
export const POST_A = WD / 2 - GOAL_W / 2, POST_B = WD / 2 + GOAL_W / 2;
export const HZ = 30, DT = 1 / HZ;
export const N_AGENTS = 25, REF = 22, AR_FAR = 23, AR_NEAR = 24;

// Animation states stored per agent per tick.
export const S = { RUN: 0, FALL: 1, DIVE_L: 2, DIVE_R: 3, CELEB: 4, KICK: 5, HEAD: 6, CARD_Y: 7, CARD_R: 8, FLAG: 9, HOLD: 10, SLIDE: 11, THROW: 12, APPEAL: 13, DEJECT: 14, WALL: 15, WHISTLE: 16, POINT: 17, KNEESLIDE: 18, LUNGE: 19, SET: 20 };

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const easeOut = t => 1 - (1 - t) * (1 - t);
const easeInOut = t => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

export const other = side => (side === 'A' ? 'B' : 'A');
export const sideOf = agent => (agent < 11 ? 'A' : agent < 22 ? 'B' : null);
export const baseOf = side => (side === 'A' ? 0 : 11);

// Team frame: u = distance from own goal line towards the opponent's goal, v = across, measured
// from the team's left touchline when facing the attack.
export function toWorld(dir, u, v) { return dir > 0 ? { x: u, y: v } : { x: L - u, y: WD - v }; }
export function toTeam(dir, x, y) { return dir > 0 ? { u: x, v: y } : { u: L - x, v: WD - y }; }

// ------------------------------------------------------------------ roles & styles
const ROLE = {
  GK:  { depth: 0, push: 0 },
  CB:  { depth: 0, push: 0.02 },
  LB:  { depth: 0.05, push: 0.34, wide: true }, RB: { depth: 0.05, push: 0.34, wide: true },
  LWB: { depth: 0.2, push: 0.42, wide: true }, RWB: { depth: 0.2, push: 0.42, wide: true },
  CDM: { depth: 0.3, push: 0.06 },
  CM:  { depth: 0.46, push: 0.14 },
  CAM: { depth: 0.66, push: 0.12 },
  LM:  { depth: 0.52, push: 0.2, wide: true }, RM: { depth: 0.52, push: 0.2, wide: true },
  LW:  { depth: 0.84, push: 0.12, wide: true }, RW: { depth: 0.84, push: 0.12, wide: true },
  ST:  { depth: 1, push: 0 },
};
const DEFAULT_STYLE = { line: 'mid', press: 'mid', width: 'normal', tempo: 'medium', build: 'mixed' };
export function normStyle(s = {}) {
  const pick = (v, ok, d) => (ok.includes(v) ? v : d);
  return {
    line: pick(s.line, ['high', 'mid', 'deep'], 'mid'),
    press: pick(s.press, ['high', 'mid', 'low'], 'mid'),
    width: pick(s.width, ['wide', 'normal', 'narrow'], 'normal'),
    tempo: pick(s.tempo, ['fast', 'medium', 'slow'], 'medium'),
    build: pick(s.build, ['short', 'mixed', 'direct'], 'mixed'),
    label: typeof s.style === 'string' ? s.style.slice(0, 40) : '',
  };
}

// Prepares a team for the engine: formation geometry per slot.
export function prepareTeam(side, team, style) {
  const f = FORMATIONS[team.formation] || FORMATIONS['4-3-3'];
  return {
    side, name: team.name, color: team.color, formation: team.formation,
    style: normStyle(style || DEFAULT_STYLE),
    players: team.players.map((p, i) => {
      const role = f[i][0];
      return { ...p, role, slot: i, agent: baseOf(side) + i, v0: (f[i][1] / 100) * WD, info: ROLE[role] || ROLE.CM };
    }),
  };
}

// ------------------------------------------------------------------ team shape
// Where a player wants to stand given the ball and who has it. Pure function.
function defLineOf(team, bu, inPos) {
  const off = team.style.line === 'high' ? 7 : team.style.line === 'deep' ? -7 : 0;
  if (inPos) return clamp(bu - 30 + off, 16, 55);
  return Math.min(clamp(bu - 21 + off * 0.6, 7.5, 46), Math.max(7.5, bu - 4));
}
function shapeTarget(M, side, slot, ball, possSide) {
  const team = M.teams[side], p = team.players[slot], dir = M.dir[side];
  const { u: bu, v: bv } = toTeam(dir, ball.x, ball.y);
  const inPos = possSide === side;
  if (p.role === 'GK') {
    if (inPos) {
      const u = clamp(bu * 0.17, 4, team.style.line === 'high' ? 17 : 12);
      return toWorld(dir, u, 34 + (bv - 34) * 0.12);
    }
    // On the line between the ball and the middle of the goal, never out of the box.
    const dx = bu, dy = bv - 34, d = Math.hypot(dx, dy) || 1;
    const gd = bu < 36 ? clamp(1.1 + d * 0.1, 1.1, 5.5) : clamp(5 + (bu - 36) * 0.1, 5, team.style.line === 'high' ? 13 : 10);
    const u = clamp((dx / d) * gd, 0.6, 16), v = clamp(34 + (dy / d) * gd, 15, 53);
    return toWorld(dir, u, v);
  }
  const opp = M.teams[other(side)];
  let defLine = defLineOf(team, bu, inPos);
  let attLine;
  if (inPos) {
    // Can't stand beyond the opponents' second-last defender (offside), unless the ball is further.
    const oppLine = L - defLineOf(opp, L - bu, false);
    const limit = Math.max(52.5, oppLine - 0.7, bu - 1);
    attLine = Math.min(clamp(bu + 13, defLine + 24, 96), limit);
    const d = clamp(p.info.depth + p.info.push, 0, 1.05);
    let u = Math.min(defLine + d * (attLine - defLine), limit);
    const wf = (team.style.width === 'wide' ? 1.2 : team.style.width === 'narrow' ? 0.95 : 1.1);
    const v = 34 + (p.v0 - 34) * wf + (bv - 34) * 0.22;
    return toWorld(dir, clamp(u, 2, 103), clamp(v, 1.5, 66.5));
  }
  const compact = team.style.press === 'high' ? 33 : team.style.press === 'low' ? 23 : 28;
  attLine = defLine + compact;
  const u = defLine + p.info.depth * (attLine - defLine);
  const wf = team.style.width === 'narrow' ? 0.74 : 0.82;
  const v = 34 + (p.v0 - 34) * wf + (bv - 34) * 0.42;
  return toWorld(dir, clamp(u, 1.5, 103), clamp(v, 2, 66));
}

// Second-last defender of the team defending `goalX` (0 or 105): the offside line.
function offsideLineX(pos, side, M, sent) {
  const dir = M.dir[side];
  const us = [];
  for (let i = 0; i < 11; i++) {
    const a = baseOf(side) + i;
    if (sent.has(a)) continue;
    us.push(toTeam(dir, pos[a * 2], pos[a * 2 + 1]).u);
  }
  us.sort((a, b) => a - b);
  const u = us[1] ?? 0;
  return toWorld(dir, u, 34).x;
}

// ------------------------------------------------------------------ plan → simulation
// A plan is a list of ball "steps" plus per-agent intents/animation states. The simulator runs
// both at 30 Hz with simple steering physics (acceleration/speed limits, separation).

function newPlan(M, ctx) {
  return { M, ctx, steps: [], intents: [], states: [], marks: { captions: [], passes: [], whistles: [] }, dur: 8 };
}

// Ball steps
const step = (plan, s) => { plan.steps.push(s); plan.steps.sort((a, b) => a.t - b.t); return s; };
// Agent intents (later ones override earlier ones while active)
const intent = (plan, s) => { plan.intents.push(s); return s; };
const anim = (plan, agent, state, t0, t1, face) => { plan.states.push({ agent, state, t0, t1, face: face || null }); };

// Physical profile per agent: top speed from role and age, plus a little individuality.
const ROLE_SPEED = { GK: 7.0, CB: 7.6, LB: 8.4, RB: 8.4, LWB: 8.5, RWB: 8.5, CDM: 7.8, CM: 8.0, CAM: 8.1, LM: 8.3, RM: 8.3, LW: 8.8, RW: 8.8, ST: 8.5 };
const FREE_STATES = new Set([2, 3, 1, 11, 18, 6]); // dive L/R, fall, slide, knee slide, header: momentum-driven, not running
const cycleLen = v => 1.2 + 0.35 * v;            // metres per full gait cycle (walk ≈ 1.7, sprint ≈ 4.2)

export function simulate(plan) {
  const { M, ctx } = plan;
  const sent = ctx.sent;
  const MAX_SHIFT = 6;
  const NA = Math.ceil((plan.dur + MAX_SHIFT) * HZ) + 1;   // allocated (room for time warps)
  let N = Math.ceil(plan.dur * HZ) + 1;
  const pos = new Float32Array(NA * N_AGENTS * 2);
  const st = new Uint8Array(NA * N_AGENTS);
  const stT = new Float32Array(NA * N_AGENTS);
  const hd = new Float32Array(NA * N_AGENTS);     // body heading (radians, world)
  const ph = new Float32Array(NA * N_AGENTS);     // gait phase (cumulative cycles)
  const ball = new Float32Array(NA * 3);
  const cam = new Float32Array(NA * 2);
  const poss = new Int8Array(NA);
  const offX = new Float32Array(NA * 2);
  // The plan runs on its own clock (tp) that pauses while players get where the action needs
  // them; real time (t) keeps flowing so everyone keeps moving naturally.
  let shift = 0;
  const tpArr = new Float32Array(NA);

  const rnd = mulberry32((ctx.seed ^ 0x51ed) >>> 0);
  const vmax = new Float32Array(N_AGENTS), P = new Float32Array(N_AGENTS * 2), V = new Float32Array(N_AGENTS * 2);
  const H = new Float32Array(N_AGENTS), PH = new Float32Array(N_AGENTS);
  for (let a = 0; a < N_AGENTS; a++) {
    if (a < 22) {
      const p = playerOf(M, a);
      let v = ROLE_SPEED[p.role] || 8;
      if (p.age >= 32) v -= 0.5; else if (p.age >= 29) v -= 0.2; else if (p.age && p.age <= 23) v += 0.2;
      vmax[a] = v + (rnd() - 0.5) * 0.5;
    } else vmax[a] = a === REF ? 7.2 : 7.6;
    P[a * 2] = ctx.start[a].x; P[a * 2 + 1] = ctx.start[a].y;
    PH[a] = rnd();
  }
  const steps = plan.steps;
  let si = -1, cur = null, ballPos = { x: ctx.ballStart.x, y: ctx.ballStart.y, z: 0 }, carrier = ctx.carrier ?? -1;
  let possSide = ctx.possStart || 'A';
  let flightFrom = null, rollTo = -1;
  let camX = clamp(ctx.ballStart.x, 22, 83), zoom = 1;
  for (let a = 0; a < N_AGENTS; a++) H[a] = Math.atan2(ballPos.y - P[a * 2 + 1], ballPos.x - P[a * 2]);

  const intents = plan.intents, states = plan.states;
  const stateAt = (a, tp) => {
    for (let i = states.length - 1; i >= 0; i--) { const x = states[i]; if (x.agent === a && tp >= x.t0 && tp <= x.t1) return x; }
    return null;
  };
  const waitOk = w => {
    if (Array.isArray(w)) return w.every(waitOk);
    const ax = P[w.agent * 2], ay = P[w.agent * 2 + 1];
    if (w.nearBall != null && Math.hypot(ax - ballPos.x, ay - ballPos.y) > w.nearBall) return false;
    if (w.near && Math.hypot(ax - w.near.x, ay - w.near.y) > w.near.r) return false;
    return true;
  };
  const inFlight = c => c && (c.type === 'pass' || c.type === 'shot' || c.type === 'free');
  const angDiff = (a, b) => { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };

  for (let k = 0; k < N; k++) {
    const t = k * DT;
    let tp = t - shift;   // plan time
    // ---- ball steps
    let blocked = false;
    while (si + 1 < steps.length && steps[si + 1].t <= tp + 1e-6) {
      const nx = steps[si + 1];
      // Never cut a ball off mid-flight; wait for the players the next action needs.
      if (inFlight(cur) && t - cur.rt < cur.dur - 1e-6) { blocked = true; break; }
      if (nx.wait && !waitOk(nx.wait)) { nx._w = (nx._w || 0) + DT; if (nx._w < (nx.waitMax || nx.wait.max || 1.5)) { blocked = true; break; } }
      si++; cur = { ...steps[si], rt: t }; rollTo = -1;
      if (cur.type === 'hold' || cur.type === 'carry') {
        // Only take the ball when it's actually at your feet; otherwise it rolls to you first.
        const a = cur.agent, d = Math.hypot(P[a * 2] - ballPos.x, P[a * 2 + 1] - ballPos.y);
        if (d < 0.95 || carrier === a) { carrier = a; } else { carrier = -1; rollTo = a; }
        possSide = sideOf(a) || possSide;
      }
      if (cur.type === 'pass' || cur.type === 'shot' || cur.type === 'free') {
        flightFrom = cur.from ? { ...cur.from } : { ...ballPos };
        if (cur.type !== 'free') possSide = sideOf(cur.agent) || possSide;
        carrier = -1;
        // Play it into where the receiver will really be: if he can't reach the planned spot in
        // time, the ball goes along his run instead.
        if (cur.type === 'pass' && cur.receiver != null && !(cur.to.z > 0.5)) {
          const r = cur.receiver, rx = P[r * 2], ry = P[r * 2 + 1];
          const dx = cur.to.x - rx, dy = cur.to.y - ry, dl = Math.hypot(dx, dy);
          const reach = vmax[r] * 0.8 * cur.dur + 0.6;
          if (dl > reach) {
            const nt = { x: rx + (dx / dl) * reach, y: ry + (dy / dl) * reach, z: 0 };
            cur = { ...cur, to: nt };
            steps[si] = cur;
            if (cur.mark) { cur.mark.target.x = nt.x; cur.mark.target.y = nt.y; }
          }
        }
      }
      if (cur.type === 'dead') {
        carrier = -1; possSide = cur.team || possSide;
        const d = Math.hypot(cur.at.x - ballPos.x, cur.at.y - ballPos.y);
        // Restarts: the ball is knocked back to the spot rather than appearing there.
        if (d > 0.4 && d < 25 && k > 0) { flightFrom = { ...ballPos, z: 0 }; cur = { type: 'free', t: cur.t, rt: t, dur: clamp(d / 9, 0.45, 1.3), to: { x: cur.at.x, y: cur.at.y, z: 0 }, loft: d > 12 ? 1.2 : 0 }; }
        else ballPos = { x: cur.at.x, y: cur.at.y, z: 0 };
      }
      if (cur.type === 'shot' || cur.type === 'pass') {
        // Struck from where the ball really is: keep the flight at a physical speed.
        const d = Math.hypot(cur.to.x - ballPos.x, cur.to.y - ballPos.y);
        const vMax = cur.type === 'shot' ? (cur.speed || 30) : cur.loft ? 24 : 21;
        cur.dur = Math.max(cur.dur, d / vMax);
      }
      if (cur.type === 'gkhold') {
        const a = cur.agent, d = Math.hypot(P[a * 2] - ballPos.x, P[a * 2 + 1] - ballPos.y);
        if (d < 1.8) carrier = a; else rollTo = a;
        possSide = sideOf(a);
      }
      if (cur.type === 'poss') possSide = cur.team;
    }
    if (blocked && shift < MAX_SHIFT) { shift += DT; N = Math.min(NA, Math.ceil((plan.dur + shift) * HZ) + 1); }
    tpArr[k] = tp;
    // ---- ball
    if (rollTo >= 0) {
      // Ball still rolling to a receiver who was a step away: no teleporting onto his foot.
      const rx = P[rollTo * 2], ry = P[rollTo * 2 + 1], dx = rx - ballPos.x, dy = ry - ballPos.y, d = Math.hypot(dx, dy);
      if (d < 0.75) { carrier = rollTo; possSide = sideOf(rollTo) || possSide; rollTo = -1; }
      else { const sp = clamp(d * 2.4, 2.5, 9) * DT; ballPos = { x: ballPos.x + (dx / d) * Math.min(sp, d), y: ballPos.y + (dy / d) * Math.min(sp, d), z: Math.max(0, ballPos.z - 0.3) }; }
    } else if (cur && (cur.type === 'pass' || cur.type === 'shot' || cur.type === 'free')) {
      const p = clamp((t - cur.rt) / cur.dur, 0, 1);
      // Ground balls lose pace (rolling friction); struck shots and lofted balls keep it.
      const e = cur.type === 'shot' || cur.loft ? p : 1 - (1 - p) * (1 - p * 0.55);
      const to = cur.to;
      let x = lerp(flightFrom.x, to.x, e), y = lerp(flightFrom.y, to.y, e);
      if (cur.curve) {
        const nx = -(to.y - flightFrom.y), ny = to.x - flightFrom.x, nl = Math.hypot(nx, ny) || 1;
        const c = Math.sin(Math.PI * e) * cur.curve;
        x += (nx / nl) * c; y += (ny / nl) * c;
      }
      const z0 = flightFrom.z || 0, z1 = to.z || 0;
      const z = lerp(z0, z1, e) + (cur.loft || 0) * 4 * e * (1 - e);
      ballPos = { x, y, z: Math.max(0, z) };
      if (p >= 1 && cur.receiver != null) {
        const r = cur.receiver, d = Math.hypot(P[r * 2] - x, P[r * 2 + 1] - y);
        if (d < 1.2 || ((to.z || 0) > 0.8 && d < 2.2)) { carrier = r; possSide = sideOf(r) || possSide; }
        else { rollTo = r; ballPos.z = Math.min(ballPos.z, 0.4); }
        cur = { type: 'hold', agent: r, t };
        if (rollTo >= 0) carrier = -1;
      }
    } else if (carrier >= 0) {
      const cx = P[carrier * 2], cy = P[carrier * 2 + 1];
      const vx = V[carrier * 2], vy = V[carrier * 2 + 1], sp = Math.hypot(vx, vy);
      const isGkHold = cur && cur.type === 'gkhold';
      const fx = Math.cos(H[carrier]), fy = Math.sin(H[carrier]);
      // Close control: the ball is touched forward every couple of strides.
      const touch = isGkHold ? 0.28 : 0.45 + Math.min(sp, 8) * 0.06 * (0.6 + 0.4 * Math.abs(Math.sin(PH[carrier] * Math.PI)));
      ballPos = { x: cx + fx * touch, y: cy + fy * touch, z: isGkHold ? 1.05 : 0 };
    }
    ball[k * 3] = ballPos.x; ball[k * 3 + 1] = ballPos.y; ball[k * 3 + 2] = ballPos.z;
    poss[k] = possSide === 'A' ? 0 : 1;

    // ---- agents
    const pressA = pressersOf(M, P, 'A', ballPos, sent)[0], pressB = pressersOf(M, P, 'B', ballPos, sent)[0];
    for (let a = 0; a < N_AGENTS; a++) {
      const o = k * N_AGENTS + a;
      const px = P[a * 2], py = P[a * 2 + 1];
      const side = sideOf(a);
      if (a < 22 && sent.has(a)) { P[a * 2] = -30; P[a * 2 + 1] = -30; V[a * 2] = V[a * 2 + 1] = 0; pos[o * 2] = -30; pos[o * 2 + 1] = -30; continue; }
      const sAt = stateAt(a, tp);
      const sCode = sAt ? sAt.state : 0;
      let tx = px, ty = py, maxSp = Math.min(vmax[a], 5.6), arriveAt = null, hold = false, faceTo = sAt?.face || null;
      if (a < 22) {
        const slot = a - baseOf(side);
        const tgt = shapeTarget(M, side, slot, ballPos, possSide);
        // Off the ball players drift into position at a jog, with small individual movements.
        const phs = a * 1.7 + ctx.seedF * 10;
        tx = tgt.x + Math.sin(t * 0.35 + phs) * 1.1;
        ty = tgt.y + Math.cos(t * 0.29 + phs * 1.3) * 1.1;
        maxSp = Math.min(vmax[a], 5.2);
        if (possSide !== side && carrier >= 0 && sideOf(carrier) !== side) {
          const team = M.teams[side];
          const bu = toTeam(M.dir[side], ballPos.x, ballPos.y).u;
          const zone = team.style.press === 'high' ? 105 : team.style.press === 'low' ? 42 : 66;
          if (bu < zone && (side === 'A' ? pressA : pressB) === a) {
            const g = toWorld(M.dir[side], 0, 34);
            const dx = g.x - ballPos.x, dy = g.y - ballPos.y, dl = Math.hypot(dx, dy) || 1;
            tx = ballPos.x + (dx / dl) * 1.7; ty = ballPos.y + (dy / dl) * 1.7; maxSp = vmax[a] * 0.85;
          }
        }
      } else if (a === REF) {
        const sx = ballPos.x < L / 2 ? 1 : -1;
        tx = clamp(ballPos.x + sx * 11, 6, 99); ty = clamp(ballPos.y + (ballPos.y < 34 ? 13 : -13), 6, 62); maxSp = 6;
      } else if (a === AR_FAR) {
        tx = clamp(Math.max(offX[k * 2 + 1] || 52.5, ballPos.x), 52.5, 104.5); ty = -1.4; maxSp = 7;
      } else if (a === AR_NEAR) {
        tx = clamp(Math.min(offX[k * 2] || 52.5, ballPos.x), 0.5, 52.5); ty = 69.4; maxSp = 7;
      }
      for (let i = intents.length - 1; i >= 0; i--) {
        const it = intents[i];
        if (it.agent !== a || tp < it.t0 || tp > it.t1) continue;
        if (it.type === 'goto') {
          tx = it.to.x; ty = it.to.y; maxSp = Math.min(it.speed || 7.5, vmax[a] + 0.4); arriveAt = it.arrive ?? null;
          if (it.onside != null && tp < it.onside && a < 22) {
            const d = M.dir[side];
            const lineX = d > 0 ? offX[k * 2 + 1] : offX[k * 2];
            if (lineX) {
              const lineU = toTeam(d, lineX, 34).u, bu = toTeam(d, ballPos.x, ballPos.y).u;
              const limit = Math.max(52.5, lineU - 1.1, bu);
              const tt = toTeam(d, tx, ty);
              if (tt.u > limit) { const w = toWorld(d, limit, tt.v); tx = w.x; ty = w.y; arriveAt = null; maxSp = Math.min(vmax[a], 7.5); }
            }
          }
        } else if (it.type === 'track') {
          // Keeper: attack the ball's line, never leaving the six-yard area.
          const g = it.goal;
          tx = clamp(ballPos.x, Math.min(g.x, g.x + it.dir * 3), Math.max(g.x, g.x + it.dir * 3));
          ty = clamp(ballPos.y, POST_A - 1.5, POST_B + 1.5); maxSp = 7; arriveAt = null;
        } else if (it.type === 'stay') hold = true;
        else if (it.type === 'follow') { tx = P[it.target * 2] + (it.dx || 0); ty = P[it.target * 2 + 1] + (it.dy || 0); maxSp = Math.min(it.speed || 7, vmax[a]); }
        else if (it.type === 'mark') {
          const g = toWorld(M.dir[side], 0, 34);
          const ax = P[it.target * 2], ay = P[it.target * 2 + 1];
          const dx = g.x - ax, dy = g.y - ay, dl = Math.hypot(dx, dy) || 1;
          tx = ax + (dx / dl) * (it.gap || 1.1); ty = ay + (dy / dl) * (it.gap || 1.1); maxSp = vmax[a] * 0.92;
        }
        break;
      }

      if (a === rollTo) { tx = ballPos.x; ty = ballPos.y; arriveAt = null; maxSp = vmax[a]; hold = false; }
      // ---- locomotion
      let vx = V[a * 2], vy = V[a * 2 + 1];
      const free = FREE_STATES.has(sCode);
      if (free) {
        // Diving / sliding / falling: momentum and friction, not running.
        const dx = tx - px, dy = ty - py, dl = Math.hypot(dx, dy);
        if (sAt && tp - sAt.t0 < 0.45 && dl > 0.05) {
          const sp = Math.min(arriveAt != null ? dl / Math.max(arriveAt - tp, 0.15) : dl * 2.5, sCode === 2 || sCode === 3 ? 6.5 : 7.5);
          vx = lerp(vx, (dx / dl) * sp, 0.35); vy = lerp(vy, (dy / dl) * sp, 0.35);
        } else { vx *= 1 - 4.2 * DT; vy *= 1 - 4.2 * DT; }
      } else if (hold) {
        const s = Math.hypot(vx, vy), ns = Math.max(0, s - 6 * DT);
        if (s > 0) { vx *= ns / s; vy *= ns / s; }
      } else {
        const dx = tx - px, dy = ty - py, dl = Math.hypot(dx, dy);
        let ds = 0;
        if (dl > 0.35) {
          if (arriveAt != null) ds = Math.min(maxSp, dl / Math.max(arriveAt - tp, 0.25));
          else ds = Math.min(maxSp, Math.max(0, dl - 0.3) * 0.95);   // gentle approach, no twitchy corrections
          if (dl < 2.5) ds = Math.min(ds, dl * 1.1);                    // ease into position
        }
        const s = Math.hypot(vx, vy);
        let dirx = s > 0.05 ? vx / s : dl > 0 ? dx / dl : Math.cos(H[a]), diry = s > 0.05 ? vy / s : dl > 0 ? dy / dl : Math.sin(H[a]);
        if (dl > 0.05) {
          const want = Math.atan2(dy, dx), curA = Math.atan2(diry, dirx);
          let dA = angDiff(curA, want);
          // Turning circle widens with speed; sharp cuts need braking first.
          const omega = 8 / (1 + 0.75 * s);
          if (s < 0.6) { dirx = dx / dl; diry = dy / dl; }
          else {
            const step = clamp(dA, -omega * DT, omega * DT);
            const na = curA + step; dirx = Math.cos(na); diry = Math.sin(na);
            if (Math.abs(dA) > 1.6) ds = Math.min(ds, 2.2);
            else if (Math.abs(dA) > 0.8) ds = Math.min(ds, s * 0.9 + 0.5);
          }
        }
        // Acceleration fades towards top speed; braking is stronger.
        let ns;
        if (ds > s) ns = s + Math.min(ds - s, (4.6 * (1 - s / (vmax[a] + 0.6)) + 0.7) * DT);
        else ns = s - Math.min(s - ds, 6.8 * DT);
        vx = dirx * ns; vy = diry * ns;
        if (a < 22) {
          for (let b = 0; b < 22; b++) {
            if (b === a) continue;
            const ox = px - P[b * 2], oy = py - P[b * 2 + 1], od = ox * ox + oy * oy;
            if (od < 1.1 && od > 1e-4) { const d = Math.sqrt(od), f = (1.05 - d) * 1.6 * DT * 30; vx += (ox / d) * f * 0.12; vy += (oy / d) * f * 0.12; }
          }
        }
      }
      V[a * 2] = vx; V[a * 2 + 1] = vy;
      P[a * 2] = px + vx * DT; P[a * 2 + 1] = py + vy * DT;
      const sp = Math.hypot(vx, vy);

      // ---- body heading: run where you're going when moving fast, otherwise watch the ball
      let want = H[a];
      if (faceTo) want = Math.atan2(faceTo.y - py, faceTo.x - px);
      else if (free) want = H[a];
      else if (a === AR_FAR) want = Math.PI / 2;
      else if (a === AR_NEAR) want = -Math.PI / 2;
      else if (carrier === a && sp > 0.5) want = Math.atan2(vy, vx);
      else if (sp > 3.6) want = Math.atan2(vy, vx);
      else if (sCode === 4 || sCode === 14 || sCode === 13) want = sp > 1 ? Math.atan2(vy, vx) : H[a];
      else want = Math.atan2(ballPos.y - py, ballPos.x - px);
      const turn = faceTo ? 14 : sp > 3.6 ? 9 : 5;
      H[a] += clamp(angDiff(H[a], want), -turn * DT, turn * DT);
      PH[a] += (sp * DT) / cycleLen(sp);
      pos[o * 2] = P[a * 2]; pos[o * 2 + 1] = P[a * 2 + 1];
      hd[o] = H[a]; ph[o] = PH[a];
      st[o] = sCode; stT[o] = sAt ? tp - sAt.t0 : 0;
    }
    if (k + 1 < N) {
      const lA = offsideLineX(pos.subarray(k * N_AGENTS * 2), 'A', M, sent);
      const lB = offsideLineX(pos.subarray(k * N_AGENTS * 2), 'B', M, sent);
      const leftDef = M.dir.A > 0 ? lA : lB, rightDef = M.dir.A > 0 ? lB : lA;
      offX[(k + 1) * 2] = leftDef; offX[(k + 1) * 2 + 1] = rightDef;
      offX[k * 2] = offX[k * 2] || leftDef; offX[k * 2 + 1] = offX[k * 2 + 1] || rightDef;
    }
    const want = clamp(ballPos.x, 21, 84);
    camX += (want - camX) * Math.min(1, DT * (plan.camSpeed || 1.6));
    const fin = ballPos.x < 22 || ballPos.x > 83 ? 1.2 : 1;
    zoom += ((plan.camZoom || fin) - zoom) * Math.min(1, DT * 1.1);
    cam[k * 2] = camX; cam[k * 2 + 1] = zoom;
  }
  // Map plan times in the marks onto real clip time.
  const realOf = v => {
    if (typeof v !== 'number') return v;
    for (let k = 0; k < N; k++) if (tpArr[k] >= v - 1e-6) return k * DT + (v - tpArr[k]);
    return v + shift;
  };
  plan.realOf = realOf;
  if (shift > 0) {
    const m = plan.marks;
    const shotEnd = m.shot ? m.shot.t + m.shot.dur : null;
    for (const k of ['goalT', 'saveT', 'postT']) if (m[k] != null) m[k] = realOf(m[k]);
    for (const k of ['celebrate', 'card', 'disallowed', 'foul', 'offside', 'shot']) if (m[k]?.t != null) m[k].t = realOf(m[k].t);
    if (m.shot && shotEnd != null) m.shot.dur = Math.max(0.1, realOf(shotEnd) - m.shot.t);
    m.captions.forEach(c => { c.t = realOf(c.t); });
    m.whistles = m.whistles.map(realOf);
    m.passes.forEach(p => { p.t0 = realOf(p.t0); p.t1 = realOf(p.t1); });
  }
  const cut = (a, per) => a.slice(0, N * per);
  return { N, dur: plan.dur + shift, pos: cut(pos, N_AGENTS * 2), st: cut(st, N_AGENTS), stT: cut(stT, N_AGENTS), hd: cut(hd, N_AGENTS), ph: cut(ph, N_AGENTS), ball: cut(ball, 3), cam: cut(cam, 2), poss: cut(poss, 1), offX: cut(offX, 2), marks: plan.marks };
}

function pressersOf(M, P, side, ball, sent) {
  let best = -1, bd = 1e9, second = -1, sd = 1e9;
  for (let i = 1; i < 11; i++) {
    const a = baseOf(side) + i;
    if (sent.has(a)) continue;
    const d = Math.hypot(P[a * 2] - ball.x, P[a * 2 + 1] - ball.y);
    if (d < bd) { second = best; sd = bd; best = a; bd = d; } else if (d < sd) { second = a; sd = d; }
  }
  return [best, second];
}

// ------------------------------------------------------------------ match context helpers
export function makeMatch(teamsIn, styles) {
  return {
    teams: { A: prepareTeam('A', teamsIn.A, styles?.A), B: prepareTeam('B', teamsIn.B, styles?.B) },
    dir: { A: 1, B: -1 },
  };
}
export function withHalf(M, half) { return { ...M, dir: half === 1 ? { A: 1, B: -1 } : { A: -1, B: 1 } }; }

const norm = s => String(s || '').toLocaleLowerCase('tr').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ı/g, 'i').trim();
export function findAgent(M, side, name) {
  if (!name || !side) return null;
  const n = norm(name), team = M.teams[side];
  let p = team.players.find(x => norm(x.name) === n);
  if (!p) { const last = n.split(' ').pop(); p = team.players.find(x => norm(x.name).split(' ').pop() === last) || team.players.find(x => norm(x.name).includes(n) || n.includes(norm(x.name))); }
  return p ? p.agent : null;
}
function byRoles(M, side, roles, sent, exclude = []) {
  const out = [];
  for (const r of roles) for (const p of M.teams[side].players) if (p.role === r && !sent.has(p.agent) && !exclude.includes(p.agent) && !out.includes(p.agent)) out.push(p.agent);
  return out;
}
// First available player with one of the roles, else any outfield player.
function pick(M, side, roles, sent, exclude = []) {
  const r = byRoles(M, side, roles, sent, exclude)[0];
  if (r != null) return r;
  const any = M.teams[side].players.find(p => p.role !== 'GK' && !sent.has(p.agent) && !exclude.includes(p.agent));
  return any ? any.agent : baseOf(side) + 1;
}
const roleOfAgent = (M, a) => M.teams[sideOf(a)].players[a - baseOf(sideOf(a))].role;
function playerOf(M, a) { return M.teams[sideOf(a)].players[a - baseOf(sideOf(a))]; }
const gkOf = (M, side) => M.teams[side].players.find(p => p.role === 'GK')?.agent ?? baseOf(side);

// Starting positions: everyone in shape around the ball.
function shapeStart(M, ball, possSide, sent) {
  const s = [];
  for (let a = 0; a < 22; a++) {
    if (sent.has(a)) { s.push({ x: -30, y: -30 }); continue; }
    const side = sideOf(a);
    s.push(shapeTarget(M, side, a - baseOf(side), ball, possSide));
  }
  s.push({ x: clamp(ball.x - 10, 6, 99), y: clamp(ball.y + (ball.y < 34 ? 13 : -13), 6, 62) });
  s.push({ x: clamp(ball.x, 52.5, 104), y: -1.4 });
  s.push({ x: clamp(ball.x, 1, 52.5), y: 69.4 });
  return s;
}

// Where the ball ends up for a shot target, in world coords.
function goalPoint(M, side, target, rnd) {
  const dir = M.dir[side];
  const gx = dir > 0 ? L : 0;
  const t = String(target || 'bottom_right');
  let v = 34, z = 0.3;
  const left = t.includes('left'), right = t.includes('right');
  if (left) v = POST_A + 0.45 + rnd() * 0.6; else if (right) v = POST_B - 0.45 - rnd() * 0.6; else v = 34 + (rnd() - 0.5) * 1.6;
  if (t.includes('top')) z = 1.85 + rnd() * 0.4; else if (t.includes('bottom')) z = 0.15 + rnd() * 0.3; else if (t === 'middle') z = 0.9 + rnd() * 0.5;
  if (t === 'high' || t === 'over') { z = 3.1 + rnd() * 1.2; v = 34 + (rnd() - 0.5) * 6; }
  if (t === 'wide_left') { v = POST_A - 0.8 - rnd() * 2.2; z = 0.4 + rnd() * 1.2; }
  if (t === 'wide_right') { v = POST_B + 0.8 + rnd() * 2.2; z = 0.4 + rnd() * 1.2; }
  const w = toWorld(dir, 105, v);
  return { x: gx, y: w.y, z, v };
}

function evLoc(M, side, ev, fallbackU = 84, fallbackV = 34) {
  const x = Number(ev.x), y = Number(ev.y);
  const u = Number.isFinite(x) ? clamp(x, 0, 100) * 1.05 : fallbackU;
  const v = Number.isFinite(y) ? clamp(y, 0, 100) * 0.68 : fallbackV;
  return { u, v };
}
const inBox = (u, v) => u >= 88.5 && v >= 13.85 && v <= 54.15;

// ------------------------------------------------------------------ builders
// Each builder fills a plan for one scripted moment and returns extra info for the renderer.

const SHOT_SPEED = { power: 30, placed: 23, curl: 21, chip: 13, header: 15, tap_in: 17, long_range: 31, volley: 27, penalty: 25, free_kick: 23, finesse: 21 };

export function buildMoment(M, ev, ctx) {
  const rnd = mulberry32(ctx.seed);
  ctx.seedF = rnd();
  const plan = newPlan(M, ctx);
  plan.rnd = rnd;
  const kind = ctx.kind;
  const res =
    kind === 'kickoff' ? buildKickoff(plan, ev) :
    kind === 'shot' ? buildShot(plan, ev) :
    kind === 'foul' ? buildFoul(plan, ev) :
    kind === 'offside' ? buildOffside(plan, ev) :
    kind === 'corner' ? buildCornerClear(plan, ev) :
    kind === 'whistle' ? buildWhistle(plan, ev) :
    kind === 'injury' ? buildInjury(plan, ev) :
    kind === 'walkout' ? buildWalkout(plan, ev) :
    buildFlow(plan, ev);
  const sim = simulate(plan);
  const info = res || {};
  if (plan.realOf && info.climax != null) info.climax = plan.realOf(info.climax);
  return { ...sim, info, kind };
}

// Possession sequence of `n` passes for `side` progressing from `from` (team coords) to around
// `to` (team coords). Returns the final time and carrier.
function buildUp(plan, side, startAgent, t, fromUV, toUV, n, tempo, avoid = []) {
  const { M, ctx, rnd } = plan;
  const dir = M.dir[side];
  let carrier = startAgent, at = t, cur = { ...fromUV };
  const used = [startAgent, ...avoid];
  const speed = tempo === 'fast' ? 17 : tempo === 'slow' ? 13 : 15;
  for (let i = 0; i < n; i++) {
    const f = (i + 1) / n;
    const aim = { u: lerp(fromUV.u, toUV.u, f), v: lerp(fromUV.v, toUV.v, f) + (i < n - 1 ? (rnd() - 0.5) * 22 : 0) };
    aim.v = clamp(aim.v, 4, 64);
    // Receiver: the teammate whose shape spot is closest to the aim point.
    let best = null, bd = 1e9;
    for (const p of M.teams[side].players) {
      if (p.role === 'GK' || used.includes(p.agent) || ctx.sent.has(p.agent)) continue;
      const s = toTeam(dir, ...Object.values(shapeTarget(M, side, p.slot, toWorld(dir, aim.u, aim.v), side)));
      const d = Math.hypot(s.u - aim.u, s.v - aim.v);
      if (d < bd) { bd = d; best = { agent: p.agent, s }; }
    }
    if (!best) break;
    const recv = { u: clamp(lerp(best.s.u, aim.u, 0.55), 3, 100), v: clamp(lerp(best.s.v, aim.v, 0.55), 2, 66) };
    const recvW = toWorld(dir, recv.u, recv.v);
    const d = Math.hypot(recv.u - cur.u, recv.v - cur.v);
    const lofted = d > 32;
    const dur = clamp(d / (lofted ? speed + 4 : speed), 0.55, 2.4);
    pass(plan, carrier, best.agent, at, recvW, dur, lofted ? 5 + d * 0.05 : 0);
    at += dur;
    // Receive and carry a few metres forward.
    const carryT = tempo === 'fast' ? 0.6 + rnd() * 0.5 : tempo === 'slow' ? 1.2 + rnd() * 0.8 : 0.8 + rnd() * 0.7;
    const carryTo = toWorld(dir, clamp(recv.u + 3 + rnd() * 5, 3, 100), clamp(recv.v + (rnd() - 0.5) * 4, 2, 66));
    carry(plan, best.agent, at, carryTo, carryT);
    // A defender steps in and lunges — the carrier rides it.
    if (carryT > 0.8 && rnd() < 0.45) {
      const opp = other(side);
      const lunger = nearestTo(plan, opp, carryTo, null);
      if (lunger != null && M.teams[opp].players[lunger - baseOf(opp)].role !== 'GK') {
        intent(plan, { agent: lunger, type: 'goto', to: { x: carryTo.x - dir * 1.2, y: carryTo.y + 0.8 }, t0: at, t1: at + carryT, arrive: at + carryT - 0.15, speed: 7.5 });
        anim(plan, lunger, S.LUNGE, at + carryT - 0.35, at + carryT + 0.45, { x: carryTo.x, y: carryTo.y });
      }
    }
    at += carryT;
    cur = toTeam(dir, carryTo.x, carryTo.y);
    used.push(best.agent);
    carrier = best.agent;
  }
  return { t: at, carrier, uv: cur };
}

function pass(plan, from, to, t, target, dur, loft = 0, curve = 0, toZ = 0) {
  const mark = { from, to, t0: t, t1: t + dur, target: { ...target }, loft };
  const reach = 7.2 * dur * 0.85 + 1.2;
  step(plan, { t, type: 'pass', agent: from, receiver: to, to: { x: target.x, y: target.y, z: toZ }, dur, loft, curve, mark,
    wait: [{ agent: from, nearBall: 1.3 }, { agent: to, near: { x: target.x, y: target.y, r: reach } }], waitMax: 2.4 });
  // Plant, swing, strike at t, follow through — body turned towards the target.
  anim(plan, from, S.KICK, t - 0.28, t + 0.26, { x: target.x, y: target.y });
  intent(plan, { agent: to, type: 'goto', to: target, t0: t - 3.4, t1: t + dur, arrive: t + dur, speed: 8.6, onside: plan.noOnside ? null : t });
  plan.marks.passes.push(mark);
}
function carry(plan, agent, t, to, dur) {
  step(plan, { t, type: 'carry', agent });
  intent(plan, { agent, type: 'goto', to, t0: t, t1: t + dur, arrive: t + dur });
}
function whistle(plan, t) { plan.marks.whistles.push(t); anim(plan, REF, S.WHISTLE, t, t + 0.7); }
function caption(plan, t, text, icon) { if (text) plan.marks.captions.push({ t, text, icon }); }

// ---------- kick-off (start of a half or after a goal) — everyone in their own half
function buildKickoff(plan, ev) {
  const { M, ctx, rnd } = plan;
  const side = ev.side || 'A', opp = other(side), dir = M.dir[side];
  const centre = { x: L / 2, y: WD / 2 };
  const start = shapeStart(M, centre, side, ctx.sent);
  // Own halves; defending team outside the centre circle.
  for (let a = 0; a < 22; a++) {
    if (ctx.sent.has(a)) continue;
    const s = sideOf(a), d = M.dir[s];
    const tu = toTeam(d, start[a].x, start[a].y);
    tu.u = Math.min(tu.u, s === side ? 51.5 : 42);
    const w = toWorld(d, tu.u, tu.v);
    if (s === opp && dist(w, centre) < 9.6) { const k = 9.8 / (dist(w, centre) || 1); w.x = centre.x + (w.x - centre.x) * k; w.y = centre.y + (w.y - centre.y) * k; }
    start[a] = w;
  }
  const [st0, partner] = byRoles(M, side, ['ST', 'CAM', 'CM', 'LW', 'RW'], ctx.sent);
  const st = st0 ?? pick(M, side, ['ST'], ctx.sent);
  const back = pick(M, side, ['CDM', 'CM', 'CB'], ctx.sent, [st, partner]);
  start[st] = toWorld(dir, 52.2, 34.6);
  if (partner != null) start[partner] = toWorld(dir, 51.4, 30.5);
  start[REF] = { x: L / 2 + 6, y: 40 };
  ctx.start = start; ctx.ballStart = centre; ctx.possStart = side; ctx.carrier = -1;
  step(plan, { t: 0, type: 'dead', at: centre, team: side });
  for (let a = 0; a < 22; a++) intent(plan, { agent: a, type: 'stay', t0: 0, t1: 1.4 });
  whistle(plan, 1.0);
  const t1 = 1.45;
  const p1 = partner ?? back;
  pass(plan, st, p1, t1, toWorld(dir, 50.6, 31), 0.5);
  pass(plan, p1, back, t1 + 1.1, toWorld(dir, 41, 33 + (rnd() - 0.5) * 8), 0.9);
  carry(plan, back, t1 + 2.0, toWorld(dir, 44, 30 + rnd() * 8), 1.2);
  plan.dur = 4.8;
  caption(plan, 1.0, ev.text, 'kickoff');
  return { climax: 1.0, protagonists: [st] };
}

// ---------- shots (goals, saves, misses, blocks, woodwork, disallowed goals, penalties, free kicks)
function buildShot(plan, ev) {
  const { M, ctx, rnd } = plan;
  const side = ev.side, opp = other(side), dir = M.dir[side];
  const gk = gkOf(M, opp);
  const technique = ev.technique || (ev.body === 'head' ? 'header' : 'placed');
  const isPen = technique === 'penalty' || ev.assist_type === 'penalty';
  const isFK = !isPen && (technique === 'free_kick' || ev.assist_type === 'free_kick');
  const isCorner = ev.assist_type === 'corner';
  let shooter = findAgent(M, side, ev.player) ?? pick(M, side, ['ST', 'LW', 'RW', 'CAM'], ctx.sent);
  if (ctx.sent.has(shooter)) shooter = pick(M, side, ['ST', 'LW', 'RW', 'CAM', 'CM'], ctx.sent);
  let assister = findAgent(M, side, ev.assist);
  if (assister === shooter || (assister != null && ctx.sent.has(assister))) assister = null;
  let { u: su, v: sv } = evLoc(M, side, ev, 90, 34);
  if (isPen) { su = 94; sv = 34; }
  if (!isPen && !isFK) su = clamp(su, 62, 103.5);
  const S0 = toWorld(dir, su, sv);
  plan.offsideGoal = (ev.outcome === 'disallowed' && (ev.reason || 'offside') === 'offside' && !isPen && !isFK && !isCorner);
  let t, origin = S0;
  if (isPen) ({ t, from: origin } = setupPenalty(plan, side, shooter, ctx.setup));
  else if (isFK) ({ t, from: origin } = setupFreeKick(plan, side, shooter, ctx.setup, { u: su, v: sv }));
  else if (isCorner) ({ t, from: origin } = setupCorner(plan, side, sv, shooter, assister));
  else t = openPlay(plan, side, shooter, assister, { u: su, v: sv }, ev);

  // ---- the shot itself
  const outcome = ev.outcome || 'off_target';
  let target = ev.target || (outcome === 'off_target' ? (rnd() < 0.5 ? (rnd() < 0.5 ? 'wide_left' : 'wide_right') : 'high') : rnd() < 0.5 ? 'bottom_left' : 'bottom_right');
  if (outcome === 'off_target' && !/wide|high|over/.test(target)) target = rnd() < 0.5 ? (target.includes('left') ? 'wide_left' : 'wide_right') : 'high';
  const goalPt = outcome === 'woodwork' ? woodworkPoint(M, side, target, rnd) : goalPoint(M, side, target, rnd);
  const head = ev.body === 'head' || technique === 'header';
  const sp = SHOT_SPEED[technique] || (head ? 15 : 24);
  const from = origin;
  const dd = Math.hypot(goalPt.x - from.x, goalPt.y - from.y);
  const sdur = clamp(dd / sp, 0.28, 1.6);
  const shotT = t;
  // The shot waits for the shooter to be on the ball at his spot.
  const shotWait = isPen || isFK ? { agent: shooter, nearBall: 1.3, max: 1.2 }
    : { agent: shooter, nearBall: head ? 1.9 : 1.4, near: { x: origin.x, y: origin.y, r: isCorner ? 2.5 : 3.5 }, max: 2.8 };
  const curve = technique === 'curl' || isFK ? (goalPt.v < 34 ? -1 : 1) * (isFK ? 2.4 : 1.4) * (M.dir[side]) : 0;
  const loft = technique === 'chip' ? 2.6 : isFK ? 1.4 : 0;
  anim(plan, shooter, head ? S.HEAD : S.KICK, shotT - (head ? 0.32 : 0.28), shotT + (head ? 0.4 : 0.3), { x: goalPt.x, y: goalPt.y });
  anim(plan, gk, S.SET, shotT - 0.6, shotT + 0.08);
  plan.marks.shot = { t: shotT, from: { ...from }, to: { x: goalPt.x, y: goalPt.y, z: goalPt.z }, agent: shooter, dur: sdur };
  // A disallowed goal looks like a goal first — the flag/VAR comes after.
  caption(plan, shotT, outcome === 'disallowed' ? `${playerOf(M, shooter).name} puts it in the net!` : ev.text, outcome === 'goal' || outcome === 'disallowed' ? 'goal' : 'shot');

  // Keeper reaction.
  const gkLine = toWorld(M.dir[opp], 0.6, 34);
  // DIVE_L = towards smaller world y, DIVE_R = towards larger world y.
  const diveState = goalPt.y < gkLine.y ? S.DIVE_L : S.DIVE_R;
  const reachT = shotT + sdur * 0.92;
  const gkTo = { x: lerp(gkLine.x, goalPt.x, 0.2), y: clamp(goalPt.y, POST_A - 0.6, POST_B + 0.6) };
  let endT;

  if (outcome === 'goal' || outcome === 'disallowed') {
    step(plan, { t: shotT, type: 'shot', agent: shooter, speed: sp, wait: shotWait, to: { x: goalPt.x, y: goalPt.y, z: goalPt.z }, dur: sdur, curve, loft });
    // Keeper: dives, beaten (late) unless it's down the middle.
    // Keeper dives full stretch and stays down, beaten.
    if (!/middle/.test(target)) { intent(plan, { agent: gk, type: 'goto', to: { x: gkTo.x, y: lerp(gkLine.y, gkTo.y, 0.75) }, t0: shotT + 0.05, t1: shotT + 1.2, speed: 6 }); anim(plan, gk, diveState, shotT + 0.12, shotT + 8); }
    // Into the net.
    const net = { x: goalPt.x + (dir > 0 ? 1.4 : -1.4), y: lerp(goalPt.y, 34, 0.2), z: Math.max(0.1, goalPt.z * 0.6) };
    step(plan, { t: shotT + sdur, type: 'free', from: { x: goalPt.x, y: goalPt.y, z: goalPt.z }, to: net, dur: 0.35 });
    step(plan, { t: shotT + sdur + 0.35, type: 'free', from: net, to: { x: net.x + (dir > 0 ? 0.2 : -0.2), y: net.y, z: 0 }, dur: 0.6 });
    plan.marks.goalT = shotT + sdur;
    plan.marks.netAt = { x: goalPt.x, y: goalPt.y, z: goalPt.z };
    if (outcome === 'disallowed') {
      const reason = ev.reason || 'offside';
      endT = disallowTail(plan, side, shooter, shotT + sdur, reason, ev);
    } else {
      endT = celebrate(plan, side, shooter, assister, shotT + sdur);
    }
  } else if (outcome === 'saved') {
    const catchPt = { x: lerp(goalPt.x, gkLine.x, 0.5) + (dir > 0 ? -0.6 : 0.6), y: goalPt.y, z: clamp(goalPt.z, 0.3, 1.9) };
    catchPt.y = clamp(catchPt.y, POST_A + 0.3, POST_B - 0.3);
    step(plan, { t: shotT, type: 'shot', agent: shooter, speed: sp, wait: shotWait, to: catchPt, dur: sdur * 0.95, curve, loft });
    const gkGoal = toWorld(M.dir[opp], 0, 34);
    intent(plan, { agent: gk, type: 'track', goal: gkGoal, dir: M.dir[opp], t0: shotT + 0.02, t1: shotT + 1.7 });
    if (Math.abs(goalPt.y - gkLine.y) > 0.9) anim(plan, gk, diveState, shotT + 0.1, shotT + 1.6);
    step(plan, { t: shotT + sdur * 0.95, type: 'gkhold', agent: gk, wait: { agent: gk, nearBall: 1.7, max: 0.9 } });
    anim(plan, gk, S.HOLD, shotT + sdur * 0.95 + 0.05, shotT + 4.5);
    intent(plan, { agent: gk, type: 'stay', t0: shotT + 1.6, t1: shotT + 6 });
    endT = shotT + 3.4;
    plan.marks.saveT = shotT + sdur * 0.95;
  } else if (outcome === 'parried' || outcome === 'tipped') {
    const touch = { x: lerp(goalPt.x, gkLine.x, 0.55), y: goalPt.y, z: clamp(goalPt.z, 0.3, 2.2) };
    step(plan, { t: shotT, type: 'shot', agent: shooter, speed: sp, wait: shotWait, to: touch, dur: sdur * 0.9, curve, loft });
    touch.y = clamp(touch.y, POST_A - 0.2, POST_B + 0.2);
    intent(plan, { agent: gk, type: 'track', goal: toWorld(M.dir[opp], 0, 34), dir: M.dir[opp], t0: shotT + 0.02, t1: shotT + 1.5 });
    anim(plan, gk, diveState, shotT + 0.08, shotT + 1.9);
    // Out for a corner (beyond the goal line, wide of the post).
    const outV = touch.y < 34 === (dir > 0) ? POST_A - 4 - rnd() * 5 : POST_B + 4 + rnd() * 5;
    const outW = toWorld(dir, 107, outV);
    step(plan, { t: shotT + sdur * 0.9, type: 'free', from: touch, to: { x: outW.x, y: outW.y, z: outcome === 'tipped' ? 0.5 : 0.2 }, dur: 0.8, loft: outcome === 'tipped' ? 2.2 : 0.6 });
    plan.marks.saveT = shotT + sdur * 0.9;
    endT = restartCorner(plan, side, outV < 34 ? 'left' : 'right', shotT + sdur * 0.9 + 1.0);
  } else if (outcome === 'woodwork') {
    step(plan, { t: shotT, type: 'shot', agent: shooter, speed: sp, wait: shotWait, to: { x: goalPt.x, y: goalPt.y, z: goalPt.z }, dur: sdur, curve, loft });
    if (!/middle/.test(target)) anim(plan, gk, diveState, shotT + 0.14, shotT + 2);
    const back = toWorld(dir, 93 - rnd() * 6, 34 + (goalPt.v - 34) * 2.4 + (rnd() - 0.5) * 6);
    step(plan, { t: shotT + sdur, type: 'free', from: { x: goalPt.x, y: goalPt.y, z: goalPt.z }, to: { x: back.x, y: back.y, z: 0 }, dur: 0.8, loft: 1.4 });
    plan.marks.postT = shotT + sdur;
    // A defender clears it upfield and out for a throw-in.
    const cb = nearestTo(plan, opp, back, ['CB', 'LB', 'RB', 'CDM']);
    intent(plan, { agent: cb, type: 'goto', to: back, t0: shotT, t1: shotT + sdur + 0.8, arrive: shotT + sdur + 0.8 });
    const outPt = toWorld(M.dir[opp], 40 + rnd() * 12, rnd() < 0.5 ? -0.5 : 68.5);
    step(plan, { t: shotT + sdur + 0.8, type: 'pass', agent: cb, to: { x: outPt.x, y: outPt.y, z: 0 }, dur: 1.4, loft: 9 });
    anim(plan, cb, S.KICK, shotT + sdur + 0.7, shotT + sdur + 1.0);
    endT = shotT + sdur + 2.6;
    caption(plan, shotT + sdur, 'Off the woodwork!', 'post');
  } else if (outcome === 'blocked') {
    const bp = { x: lerp(from.x, goalPt.x, 0.18), y: lerp(from.y, goalPt.y, 0.18) };
    const blocker = nearestTo(plan, opp, bp, ['CB', 'LB', 'RB', 'CDM', 'CM']);
    intent(plan, { agent: blocker, type: 'goto', to: bp, t0: shotT - 1.2, t1: shotT + 0.4, arrive: shotT + 0.1, speed: 8 });
    anim(plan, blocker, S.SLIDE, shotT - 0.2, shotT + 1);
    step(plan, { t: shotT, type: 'shot', agent: shooter, speed: sp, wait: shotWait, to: { x: bp.x, y: bp.y, z: 0.4 }, dur: Math.max(0.12, dist(from, bp) / sp) });
    const outV = sv < 34 ? POST_A - 6 - rnd() * 6 : POST_B + 6 + rnd() * 6;
    const outW = toWorld(dir, 106.5, outV);
    const bt = shotT + Math.max(0.12, dist(from, bp) / sp);
    step(plan, { t: bt, type: 'free', from: { x: bp.x, y: bp.y, z: 0.4 }, to: { x: outW.x, y: outW.y, z: 0 }, dur: 1.1, loft: 2 });
    endT = restartCorner(plan, side, outV < 34 ? 'left' : 'right', bt + 1.3);
  } else {
    // Off target: wide or over, goal kick.
    const past = { x: goalPt.x + (dir > 0 ? 6 : -6), y: goalPt.y + (goalPt.y - from.y) * 0.08, z: goalPt.z + (target === 'high' ? 1.5 : 0) };
    step(plan, { t: shotT, type: 'shot', agent: shooter, speed: sp, wait: shotWait, to: { x: goalPt.x, y: goalPt.y, z: goalPt.z }, dur: sdur, curve, loft });
    step(plan, { t: shotT + sdur, type: 'free', from: { x: goalPt.x, y: goalPt.y, z: goalPt.z }, to: past, dur: 0.5 });
    if (Math.abs(goalPt.y - 34) < 6) anim(plan, gk, diveState, shotT + 0.15, shotT + 1.6);
    anim(plan, shooter, S.APPEAL, shotT + sdur + 0.4, shotT + sdur + 2.6);
    endT = restartGoalKick(plan, opp, shotT + sdur + 1.2);
  }
  plan.dur = Math.max(plan.dur, endT + 0.3);
  return { climax: shotT, protagonists: [shooter, assister, gk].filter(a => a != null), outcome, shooter, assister, gk, target, isPen, isFK };
}

function nearestTo(plan, side, pt, roles) {
  const { M, ctx } = plan;
  let best = null, bd = 1e9;
  for (const p of M.teams[side].players) {
    if (ctx.sent.has(p.agent) || (roles && !roles.includes(p.role))) continue;
    const s = shapeTarget(M, side, p.slot, pt, other(side));
    const d = dist(s, pt);
    if (d < bd) { bd = d; best = p.agent; }
  }
  return best ?? gkOf(M, side) + 4;
}

function woodworkPoint(M, side, target, rnd) {
  const dir = M.dir[side];
  const left = String(target).includes('left') || (!String(target).includes('right') && rnd() < 0.5);
  if (String(target).includes('top') || target === 'crossbar' || rnd() < 0.25) {
    const w = toWorld(dir, 105, 34 + (rnd() - 0.5) * 4);
    return { x: w.x, y: w.y, z: GOAL_H, v: 34 };
  }
  const v = left ? POST_A : POST_B;
  const w = toWorld(dir, 105, v);
  return { x: w.x, y: w.y, z: 0.6 + rnd() * 1.4, v };
}

// Open play leading to a shot from (su, sv).
function openPlay(plan, side, shooter, assister, SL, ev) {
  const { M, ctx, rnd } = plan;
  const dir = M.dir[side], opp = other(side);
  const team = M.teams[side];
  const tempo = team.style.tempo;
  let type = ev.assist_type || (assister == null ? 'solo' : 'short_pass');
  if (type === 'rebound' && assister == null) type = 'solo';
  const build = ev.build_up || (team.style.build === 'direct' ? 'long_ball' : team.style.build === 'short' ? 'possession' : 'counter');
  const head = ev.body === 'head';
  if (head && !['cross', 'corner', 'free_kick', 'set_piece'].includes(type)) type = 'cross';

  // Where the final ball comes from.
  let A;
  if (type === 'cross') A = { u: clamp(SL.u - 4 + rnd() * 8, 80, 97), v: (assister != null && ['LB', 'LW', 'LM', 'LWB'].includes(roleOfAgent(M, assister))) ? 4 + rnd() * 5 : (assister != null && ['RB', 'RW', 'RM', 'RWB'].includes(roleOfAgent(M, assister))) ? 59 + rnd() * 5 : (SL.v < 34 ? 60 + rnd() * 4 : 4 + rnd() * 4) };
  else if (type === 'cutback') A = { u: 100.5, v: SL.v < 34 ? 17 + rnd() * 4 : 47 + rnd() * 4 };
  else if (type === 'through_ball') A = { u: clamp(SL.u - 24, 52, 80), v: clamp(34 + (SL.v - 34) * 0.35 + (rnd() - 0.5) * 10, 14, 54) };
  else if (type === 'long_ball') A = { u: 38 + rnd() * 8, v: 34 + (rnd() - 0.5) * 18 };
  else if (type === 'rebound') A = { u: clamp(SL.u - 8, 70, 92), v: clamp(SL.v + (rnd() - 0.5) * 16, 18, 50) };
  else A = { u: clamp(SL.u - 10 - rnd() * 4, 60, 95), v: clamp(SL.v + (SL.v < 34 ? 9 : -9), 8, 60) };

  if (assister == null && type !== 'solo') {
    const roles = type === 'cross' ? (A.v < 34 ? ['LW', 'LB', 'LM', 'LWB', 'CM'] : ['RW', 'RB', 'RM', 'RWB', 'CM']) : type === 'long_ball' ? ['CB', 'CDM', 'GK'] : ['CAM', 'CM', 'LW', 'RW', 'CDM'];
    assister = pick(M, side, roles, ctx.sent, [shooter]);
  }

  // Start of the move.
  const startU = build === 'counter' ? 36 + rnd() * 10 : build === 'long_ball' ? 18 + rnd() * 8 : 28 + rnd() * 10;
  const startUV = { u: startU, v: 34 + (rnd() - 0.5) * 24 };
  const startAgent = build === 'long_ball' ? pick(M, side, ['CB', 'GK'], ctx.sent, [shooter, assister])
    : pick(M, side, build === 'counter' ? ['CDM', 'CM', 'CB'] : ['CB', 'CDM'], ctx.sent, [shooter, assister]);
  const startW = toWorld(dir, startUV.u, startUV.v);
  ctx.ballStart = startW; ctx.possStart = side; ctx.carrier = startAgent;
  ctx.start = shapeStart(M, startW, side, ctx.sent);
  ctx.start[startAgent] = { x: startW.x - dir * 0.6, y: startW.y };
  step(plan, { t: 0, type: 'hold', agent: startAgent });

  let t = 0.5;
  if (build === 'counter') {
    // Ball won: show the turnover with a quick tackle first.
    caption(plan, 0.3, 'Ball won — they break!', 'counter');
  }
  let carrier = startAgent, uv = startUV;
  if (type !== 'solo' && assister != null) {
    const n = build === 'counter' ? 1 : build === 'long_ball' ? 0 : 2 + Math.floor(rnd() * 2);
    const receiveA = { u: type === 'cross' ? A.u - 12 : type === 'cutback' ? A.u - 14 : A.u - 5, v: type === 'cross' ? A.v + (A.v < 34 ? 3 : -3) : A.v };
    if (n > 0) {
      const r = buildUp(plan, side, carrier, t, uv, { u: receiveA.u - 8, v: receiveA.v }, n, tempo, [shooter, assister]);
      t = r.t; carrier = r.carrier; uv = r.uv;
    }
    // Pass to the assister in his zone, who carries to the delivery spot.
    if (carrier !== assister) {
      const rw = toWorld(dir, receiveA.u, receiveA.v);
      const d = Math.hypot(receiveA.u - uv.u, receiveA.v - uv.v);
      const dur = clamp(d / (d > 30 ? 20 : 15), 0.5, 2.2);
      pass(plan, carrier, assister, t, rw, dur, d > 30 ? 6 + d * 0.04 : 0);
      t += dur;
    }
    const aw = toWorld(dir, A.u, A.v);
    const ct = clamp(Math.hypot(A.u - receiveA.u, A.v - receiveA.v) / 6.5, 0.5, 2.4);
    carry(plan, assister, t, aw, ct);
    // The shooter times his run: holds his position (onside) then attacks the space.
    t += ct;
  } else {
    // Solo run: shooter receives deep and drives at goal.
    const soloFrom = { u: clamp(SL.u - 20, 45, 82), v: clamp(SL.v + (rnd() - 0.5) * 20, 8, 60) };
    const sw = toWorld(dir, soloFrom.u, soloFrom.v);
    const d = Math.hypot(soloFrom.u - uv.u, soloFrom.v - uv.v);
    const dur = clamp(d / 16, 0.6, 2.2);
    pass(plan, carrier, shooter, t, sw, dur, d > 30 ? 6 : 0);
    t += dur;
    const ct = clamp(Math.hypot(SL.u - soloFrom.u, SL.v - soloFrom.v) / 6.8, 1.2, 3.2);
    // Beats a defender on the way.
    const mid = toWorld(dir, lerp(soloFrom.u, SL.u, 0.55), lerp(soloFrom.v, SL.v, 0.55));
    const def = nearestTo(plan, opp, mid, ['CB', 'CDM', 'LB', 'RB']);
    intent(plan, { agent: def, type: 'goto', to: mid, t0: t, t1: t + ct * 0.6, arrive: t + ct * 0.5 });
    anim(plan, def, S.SLIDE, t + ct * 0.45, t + ct * 0.45 + 1.0);
    carry(plan, shooter, t, toWorld(dir, SL.u, SL.v), ct);
    t += ct;
    return t;
  }

  // Final ball.
  const Sw = toWorld(dir, SL.u, SL.v);
  const aw = toWorld(dir, A.u, A.v);
  const d = Math.hypot(SL.u - A.u, SL.v - A.v);
  let fdur, loft = 0;
  if (type === 'cross') { fdur = clamp(d / 17, 0.7, 1.6); loft = 6 + rnd() * 3; }
  else if (type === 'long_ball') { fdur = clamp(d / 21, 1.1, 2.6); loft = 10; }
  else if (type === 'cutback') fdur = clamp(d / 15, 0.4, 1.2);
  else if (type === 'through_ball') fdur = clamp(d / 16, 0.7, 1.8);
  else fdur = clamp(d / 15, 0.35, 1.2);
  // Shooter holds an onside position, then runs to meet the ball.
  const runFrom = toWorld(dir, Math.min(SL.u - (type === 'through_ball' ? 14 : 5), oppLineU(plan, side, t) - 0.8), SL.v + (rnd() - 0.5) * 6);
  intent(plan, { agent: shooter, type: 'goto', to: runFrom, t0: Math.max(0, t - 4), t1: t, arrive: t, speed: 7, onside: plan.offsideGoal ? null : t });
  if (plan.offsideGoal) {
    // Disallowed goal: the scorer is beyond the line when the ball is played.
    plan.noOnside = true;
    holdLine(plan, other(side), oppLineU(plan, side, t), t - 2.5, t + 0.6);
    intent(plan, { agent: shooter, type: 'goto', to: toWorld(dir, oppLineU(plan, side, t) + 1.6, SL.v), t0: t - 2.4, t1: t, arrive: t, speed: 7.5 });
    plan.marks.offside = { t, runner: shooter, lineU: oppLineU(plan, side, t), sideAtt: side, passer: assister };
  }
  pass(plan, assister, shooter, t, Sw, fdur, loft, 0, head ? 2.05 : ev.technique === 'volley' ? 0.7 : 0);
  plan.noOnside = false;
  // Defenders: one tracks the shooter, the keeper sets.
  const marker = nearestTo(plan, opp, Sw, ['CB', 'LB', 'RB']);
  intent(plan, { agent: marker, type: 'mark', target: shooter, gap: 1.6, t0: t - 1.5, t1: t + fdur + 0.2 });
  if (type === 'cross' || type === 'cutback') {
    // Box filled: a second attacker and defender.
    const second = byRoles(M, side, ['ST', 'LW', 'RW', 'CAM', 'CM'], ctx.sent, [shooter, assister])[0];
    if (second != null) {
      const sp = toWorld(dir, 97, SL.v < 34 ? 42 : 26);
      intent(plan, { agent: second, type: 'goto', to: sp, t0: t - 1.5, t1: t + fdur + 0.6, speed: 7.5 });
      const m2 = nearestTo(plan, opp, sp, ['CB', 'LB', 'RB', 'CDM']);
      if (m2 !== marker) intent(plan, { agent: m2, type: 'mark', target: second, gap: 1.2, t0: t - 1.2, t1: t + fdur + 0.6 });
    }
  }
  t += fdur;
  if (type === 'through_ball') {
    // One touch into stride, then the finish.
    const ct = 0.55;
    carry(plan, shooter, t, toWorld(dir, Math.min(SL.u + 2.5, 103), SL.v), ct);
    t += ct;
  } else if (type !== 'cross' && !['volley', 'tap_in'].includes(ev.technique) && rnd() < 0.6) {
    const ct = 0.35;
    carry(plan, shooter, t, toWorld(dir, Math.min(SL.u + 1, 103), SL.v), ct);
    t += ct;
  }
  plan.marks.assist = { from: aw, to: Sw, type };
  return t;
}

// Back four steps into a straight line at lineU (attacking team's coordinates).
function holdLine(plan, defSide, lineU, t0, t1) {
  const { M, ctx } = plan;
  const d = M.dir[defSide];
  for (const p of M.teams[defSide].players) {
    if (ctx.sent.has(p.agent) || !['CB', 'LB', 'RB', 'LWB', 'RWB'].includes(p.role)) continue;
    const w = toWorld(d, L - lineU, clamp(p.v0 * 0.85 + 5, 8, 60));
    intent(plan, { agent: p.agent, type: 'goto', to: w, t0, t1, arrive: t0 + 1.2, speed: 7 });
  }
}

function oppLineU(plan, side, t) {
  const { M } = plan;
  const opp = other(side);
  // Opponent def line in their coords with ball high up our end (approx) → our coords.
  return L - defLineOf(M.teams[opp], 20, false);
}

// ---------- set pieces
function setupCorner(plan, side, sv, shooter, assister) {
  const { M, ctx, rnd } = plan;
  const dir = M.dir[side], opp = other(side);
  const leftFlag = sv < 34 ? rnd() < 0.7 : rnd() < 0.3;
  const flag = toWorld(dir, 104.6, leftFlag ? 0.5 : 67.5);
  const taker = assister ?? pick(M, side, ['CAM', 'CM', 'LW', 'RW', 'LB', 'RB'], ctx.sent, [shooter]);
  const start = shapeStart(M, flag, side, ctx.sent);
  // Attackers into the box, defenders marking, keeper on his line.
  const att = byRoles(M, side, ['ST', 'CB', 'LW', 'RW', 'CAM', 'CM', 'CDM'], ctx.sent, [taker]).slice(0, 6);
  const spots = [[95, 30], [97, 38], [93, 36], [98, 28], [91, 42], [96, 44]];
  att.forEach((a, i) => { const s = toWorld(dir, spots[i][0] - rnd() * 1.5, spots[i][1] + (rnd() - 0.5) * 3); start[a] = s; });
  if (shooter != null && !att.includes(shooter)) start[shooter] = toWorld(dir, 94, 35);
  const defs = byRoles(M, opp, ['CB', 'LB', 'RB', 'CDM', 'CM', 'ST', 'LW', 'RW'], ctx.sent).slice(0, 7);
  defs.forEach((d, i) => {
    const target = att[i % att.length];
    start[d] = { x: start[target].x + (dir > 0 ? 0.9 : -0.9), y: start[target].y + (rnd() - 0.5) };
    intent(plan, { agent: d, type: 'mark', target, gap: 0.9, t0: 0, t1: 12 });
  });
  start[gkOf(M, opp)] = toWorld(dir, 104.3, 34 + (leftFlag ? 1.5 : -1.5));
  start[taker] = { x: flag.x - dir * 1.8, y: flag.y + (leftFlag ? -1 : 1) * (dir > 0 ? -1 : 1) * 0.6 };
  start[REF] = toWorld(dir, 86, 40);
  ctx.start = start; ctx.ballStart = flag; ctx.possStart = side; ctx.carrier = -1;
  step(plan, { t: 0, type: 'dead', at: flag, team: side });
  intent(plan, { agent: taker, type: 'goto', to: { x: flag.x - dir * 0.6, y: flag.y }, t0: 0.6, t1: 1.6, arrive: 1.55 });
  for (const a of att) intent(plan, { agent: a, type: 'stay', t0: 0, t1: 1.2 });
  caption(plan, 0.2, 'Corner', 'corner');
  const t = 1.6;
  const shootSpot = toWorld(dir, 95 + rnd() * 3, 30 + rnd() * 8);
  if (shooter != null) {
    intent(plan, { agent: shooter, type: 'goto', to: shootSpot, t0: 1.2, t1: 3.4, arrive: t + 1.25, speed: 8 });
    pass(plan, taker, shooter, t, shootSpot, 1.25, 7.5, (leftFlag ? 1 : -1) * dir * 1.2, 2.05);
    anim(plan, shooter, S.HEAD, t + 1.25 - 0.32, t + 1.25 + 0.4);
  }
  plan.marks.assist = { from: flag, to: shootSpot, type: 'corner' };
  plan.camZoom = 1.25;
  return { t: t + 1.25, from: shootSpot, taker };
}

function setupFreeKick(plan, side, taker, setup, FKUV) {
  const { M, ctx, rnd } = plan;
  const dir = M.dir[side], opp = other(side);
  const spot = setup?.type === 'freekick' && setup.side === side ? setup.spot : toWorld(dir, FKUV.u, FKUV.v);
  const uv = toTeam(dir, spot.x, spot.y);
  const start = setup?.positions && setup.side === side ? setup.positions.map(p => ({ ...p })) : freeKickPositions(plan, side, spot, taker);
  ctx.start = start; ctx.ballStart = spot; ctx.possStart = side; ctx.carrier = -1;
  step(plan, { t: 0, type: 'dead', at: spot, team: side });
  const wall = setup?.wall || [];
  for (let a = 0; a < 22; a++) if (!wall.includes(a)) intent(plan, { agent: a, type: 'stay', t0: 0, t1: 2.2 });
  for (const a of wall) { intent(plan, { agent: a, type: 'stay', t0: 0, t1: 4 }); anim(plan, a, S.WALL, 0, 2.6); }
  // Run-up.
  const g = toWorld(dir, 105, 34);
  const back = { x: spot.x - (g.x - spot.x) / (dist(g, spot) || 1) * 3.2, y: spot.y - (g.y - spot.y) / (dist(g, spot) || 1) * 3.2 + 1 };
  ctx.start[taker] = back;
  intent(plan, { agent: taker, type: 'goto', to: { x: spot.x - (g.x - spot.x) / (dist(g, spot) || 1) * 0.5, y: spot.y }, t0: 1.4, t1: 2.6, arrive: 2.45, speed: 6 });
  whistle(plan, 1.1);
  caption(plan, 0.3, `Free kick, ${Math.round(dist(spot, g))} m out`, 'freekick');
  for (const a of wall) anim(plan, a, S.HEAD, 2.45, 2.95);
  plan.marks.freeKick = { spot, wall };
  plan.camZoom = 1.28;
  return { t: 2.45, from: spot };
}

export function freeKickPositions(plan, side, spot, taker) {
  const { M, ctx, rnd } = plan;
  const dir = M.dir[side], opp = other(side);
  const start = shapeStart(M, spot, side, ctx.sent);
  const uv = toTeam(dir, spot.x, spot.y);
  const g = toWorld(dir, 105, 34);
  const dg = dist(spot, g);
  const wall = [];
  if (uv.u > 68 && Math.abs(uv.v - 34) < 24) {
    // Wall 9.15 m from the ball on the line to goal.
    const n = dg < 22 ? 5 : dg < 28 ? 4 : 3;
    const ux = (g.x - spot.x) / dg, uy = (g.y - spot.y) / dg;
    const cx = spot.x + ux * 9.15, cy = spot.y + uy * 9.15;
    const cand = byRoles(M, opp, ['ST', 'LW', 'RW', 'CAM', 'CM', 'CDM', 'LM', 'RM'], ctx.sent).slice(0, n);
    cand.forEach((a, i) => { const off = (i - (n - 1) / 2) * 0.62; start[a] = { x: cx - uy * off, y: cy + ux * off }; wall.push(a); });
    // Attackers in the box, defenders goal-side.
    const att = byRoles(M, side, ['ST', 'CB', 'LW', 'RW', 'CAM'], ctx.sent, [taker]).slice(0, 4);
    att.forEach((a, i) => { start[a] = toWorld(dir, 92 + rnd() * 4, 26 + i * 5 + rnd() * 2); });
    const defs = byRoles(M, opp, ['CB', 'LB', 'RB', 'CDM'], ctx.sent, wall).slice(0, 4);
    defs.forEach((d, i) => { const tA = att[i % att.length]; if (tA != null) start[d] = { x: start[tA].x + (dir > 0 ? 0.8 : -0.8), y: start[tA].y }; });
    const gkw = toWorld(dir, 104.2, 34 + (uv.v < 34 ? 1.2 : -1.2));
    start[gkOf(M, opp)] = gkw;
  } else {
    // Not dangerous: opponents retreat 9.15 m.
    for (let a = 0; a < 22; a++) {
      if (sideOf(a) !== opp || ctx.sent.has(a)) continue;
      const d = dist(start[a], spot);
      if (d < 9.3) { const k = 9.4 / (d || 1); start[a] = { x: spot.x + (start[a].x - spot.x) * k, y: spot.y + (start[a].y - spot.y) * k }; }
    }
  }
  if (taker != null) start[taker] = { x: spot.x - dir * 1.5, y: spot.y + 0.8 };
  start[REF] = { x: spot.x + dir * 6, y: clamp(spot.y + 10, 4, 64) };
  return Object.assign(start, { wall });
}

function setupPenalty(plan, side, taker, setup) {
  const { M, ctx } = plan;
  const dir = M.dir[side], opp = other(side);
  const spot = toWorld(dir, 94, 34);
  const start = setup?.positions && setup.side === side && setup.type === 'penalty' ? setup.positions.map(p => ({ ...p })) : penaltyPositions(plan, side, taker);
  ctx.start = start; ctx.ballStart = spot; ctx.possStart = side; ctx.carrier = -1;
  step(plan, { t: 0, type: 'dead', at: spot, team: side });
  for (let a = 0; a < 25; a++) intent(plan, { agent: a, type: 'stay', t0: 0, t1: 2.4 });
  start[taker] = toWorld(dir, 90.5, 32.5);
  intent(plan, { agent: taker, type: 'goto', to: toWorld(dir, 93.5, 33.8), t0: 1.5, t1: 2.65, arrive: 2.6, speed: 6 });
  whistle(plan, 1.2);
  caption(plan, 0.2, 'Penalty!', 'penalty');
  plan.camZoom = 1.35;
  return { t: 2.6, from: spot };
}
export function penaltyPositions(plan, side, taker) {
  const { M, ctx, rnd } = plan;
  const dir = M.dir[side], opp = other(side);
  const start = shapeStart(M, toWorld(dir, 94, 34), side, ctx.sent);
  // Everyone outside the box and the arc, except taker and keeper.
  let k = 0;
  for (let a = 0; a < 22; a++) {
    if (ctx.sent.has(a) || a === taker || a === gkOf(M, opp)) continue;
    const s = sideOf(a);
    if (s === side && M.teams[side].players[a - baseOf(side)].role === 'GK') continue;
    const row = k % 2 === 0 ? 86.5 : 85.2;
    const vv = 18 + ((k * 37) % 32) + rnd() * 1.5;
    if (Math.abs(vv - 34) < 9.5) { start[a] = toWorld(dir, 83 - (k % 3), vv < 34 ? 24 - (k % 3) * 2 : 44 + (k % 3) * 2); }
    else start[a] = toWorld(dir, row, vv);
    k++;
  }
  start[gkOf(M, opp)] = toWorld(dir, 104.8, 34);
  if (taker != null) start[taker] = toWorld(dir, 92.5, 33.2);
  start[REF] = toWorld(dir, 89, 25);
  return start;
}

function restartCorner(plan, side, which, t) {
  const { M } = plan;
  const dir = M.dir[side];
  anim(plan, REF, S.POINT, t, t + 1.6);
  caption(plan, t, 'Corner kick', 'corner');
  const flag = toWorld(dir, 104.6, which === 'left' ? 0.5 : 67.5);
  const taker = pick(M, side, ['CAM', 'CM', 'LW', 'RW'], plan.ctx.sent);
  if (taker != null) intent(plan, { agent: taker, type: 'goto', to: flag, t0: t, t1: t + 3, speed: 4.5 });
  plan.marks.restart = { type: 'corner', side, at: flag };
  return t + 2.2;
}
function restartGoalKick(plan, side, t) {
  const { M } = plan;
  const dir = M.dir[side];
  const gk = gkOf(M, side);
  const spot = toWorld(dir, 5.5, 34 + 8);
  step(plan, { t, type: 'dead', at: spot, team: side });
  intent(plan, { agent: gk, type: 'goto', to: { x: spot.x - dir * 2, y: spot.y }, t0: t - 0.6, t1: t + 1.2, arrive: t + 1.0, speed: 5 });
  for (let a = 0; a < 22; a++) if (a !== gk) intent(plan, { agent: a, type: 'goto', to: shapeTarget(M, sideOf(a), a - baseOf(sideOf(a)), spot, side), t0: t, t1: t + 3, speed: 4 });
  const target = pick(M, side, ['ST', 'CM', 'LW', 'RW'], plan.ctx.sent);
  const tp = toWorld(dir, 55 + plan.rnd() * 10, 34 + (plan.rnd() - 0.5) * 30);
  pass(plan, gk, target, t + 1.4, tp, 2.0, 16);
  caption(plan, t, 'Goal kick', 'goalkick');
  plan.marks.restart = { type: 'goal_kick', side, at: spot };
  return t + 2.6;
}

function celebrate(plan, side, scorer, assister, t) {
  const { M, ctx } = plan;
  const dir = M.dir[side], opp = other(side);
  const corner = toWorld(dir, 99, M.dir[side] > 0 ? 64 : 4); // run towards the near corner (camera side)
  intent(plan, { agent: scorer, type: 'goto', to: corner, t0: t + 0.2, t1: t + 3.1, speed: 7.8 });
  anim(plan, scorer, S.CELEB, t + 0.3, t + 3.1);
  // Knee slide towards the fans.
  const slideTo = toWorld(dir, toTeam(dir, corner.x, corner.y).u + 1.5, toTeam(dir, corner.x, corner.y).v + 2.5);
  intent(plan, { agent: scorer, type: 'goto', to: slideTo, t0: t + 3.1, t1: t + 6 });
  anim(plan, scorer, S.KNEESLIDE, t + 3.1, t + 6);
  let k = 0;
  for (const p of M.teams[side].players) {
    if (p.agent === scorer || ctx.sent.has(p.agent) || p.role === 'GK') continue;
    intent(plan, { agent: p.agent, type: 'follow', target: scorer, dx: Math.cos(k) * 1.4, dy: Math.sin(k) * 1.4, t0: t + 0.6 + k * 0.08, t1: t + 6, speed: 7.4 });
    if (k < 3) anim(plan, p.agent, S.CELEB, t + 1.5 + k * 0.2, t + 6);
    k++;
  }
  for (const p of M.teams[opp].players) {
    if (ctx.sent.has(p.agent) || p.role === 'GK') continue;   // the keeper is still down after his dive
    intent(plan, { agent: p.agent, type: 'stay', t0: t + 0.8, t1: t + 6 });
    anim(plan, p.agent, S.DEJECT, t + 1, t + 6);
  }
  anim(plan, REF, S.POINT, t + 1, t + 2.5);
  plan.camZoom = 1.25;
  plan.marks.celebrate = { t: t + 0.3, scorer };
  return t + 4.8;
}

function disallowTail(plan, side, scorer, t, reason, ev) {
  const { M, ctx } = plan;
  // Celebration starts…
  intent(plan, { agent: scorer, type: 'goto', to: toWorld(M.dir[side], 98, 50), t0: t + 0.2, t1: t + 2.4, speed: 7 });
  anim(plan, scorer, S.CELEB, t + 0.3, t + 2.4);
  // …then the flag / VAR.
  if (reason === 'offside') { anim(plan, AR_FAR, S.FLAG, t + 0.8, t + 5); anim(plan, AR_NEAR, S.FLAG, t + 0.8, t + 5); }
  whistle(plan, t + 1.2);
  anim(plan, scorer, S.APPEAL, t + 2.5, t + 5);
  plan.marks.disallowed = { t: t + 1.2, reason };
  caption(plan, t + 1.4, ev.text || (reason === 'offside' ? 'Flag up — offside! No goal.' : `No goal — ${reason}`), 'var');
  return t + 4.2;
}

// ---------- fouls (free kick from the spot, penalty, cards)
function buildFoul(plan, ev) {
  const { M, ctx, rnd } = plan;
  const side = ev.side, opp = other(side), dir = M.dir[side];
  let fouled = findAgent(M, side, ev.player);
  if (fouled == null || ctx.sent.has(fouled)) fouled = pick(M, side, ['ST', 'LW', 'RW', 'CAM', 'CM'], ctx.sent);
  let offender = findAgent(M, opp, ev.offender);
  const { u, v } = evLoc(M, side, ev, 70, 34);
  const pen = ev.penalty === true || inBox(u, v);
  const F = toWorld(dir, pen ? clamp(u, 89, 103) : Math.min(u, 88), v);
  if (offender == null || ctx.sent.has(offender)) offender = nearestTo(plan, opp, F, ['CB', 'CDM', 'LB', 'RB', 'CM']);

  // Build-up: the fouled player gets the ball and drives at the defender.
  const before = toWorld(dir, clamp(toTeam(dir, F.x, F.y).u - 9, 5, 95), clamp(v + (rnd() - 0.5) * 8, 3, 65));
  const feeder = pick(M, side, ['CM', 'CDM', 'CB', 'CAM', 'LB', 'RB'], ctx.sent, [fouled]);
  const feedFrom = toWorld(dir, clamp(toTeam(dir, before.x, before.y).u - 14, 3, 90), clamp(v + (rnd() - 0.5) * 18, 4, 64));
  ctx.ballStart = feedFrom; ctx.possStart = side; ctx.carrier = feeder;
  ctx.start = shapeStart(M, feedFrom, side, ctx.sent);
  ctx.start[feeder] = { ...feedFrom };
  step(plan, { t: 0, type: 'hold', agent: feeder });
  const pd = clamp(dist(feedFrom, before) / 15, 0.6, 1.8);
  pass(plan, feeder, fouled, 0.7, before, pd);
  const tf = 0.7 + pd + 1.3;
  carry(plan, fouled, 0.7 + pd, F, 1.3);
  const sliding = rnd() < 0.6;
  const fwd = toWorld(dir, 1, 0); const fdx = fwd.x - toWorld(dir, 0, 0).x;
  intent(plan, { agent: offender, type: 'goto', to: { x: F.x - dir * 1.6, y: F.y + 0.9 }, t0: 0.3, t1: tf - 0.42, arrive: tf - 0.42, speed: 8.5 });
  if (sliding) {
    // Goes to ground and slides through the man.
    intent(plan, { agent: offender, type: 'goto', to: { x: F.x + dir * 1.4, y: F.y - 0.3 }, t0: tf - 0.42, t1: tf + 0.9, arrive: tf + 0.1 });
    anim(plan, offender, S.SLIDE, tf - 0.42, tf + 1.5);
  } else {
    intent(plan, { agent: offender, type: 'goto', to: { x: F.x - dir * 0.3, y: F.y + 0.3 }, t0: tf - 0.42, t1: tf + 0.6, arrive: tf - 0.05 });
    anim(plan, offender, S.LUNGE, tf - 0.3, tf + 0.7, { x: F.x, y: F.y });
  }
  // Tripped: stumbles forward, goes down.
  anim(plan, fouled, S.FALL, tf, tf + 3.4);
  intent(plan, { agent: fouled, type: 'goto', to: { x: F.x + dir * 1.8, y: F.y }, t0: tf, t1: tf + 3.4, arrive: tf + 0.45 });
  // Loose ball rolls on and stops.
  const roll = { x: F.x + dir * 2.2, y: F.y + (rnd() - 0.5) * 2, z: 0 };
  step(plan, { t: tf, type: 'free', from: null, to: roll, dur: 0.7 });
  whistle(plan, tf + 0.25);
  plan.marks.foul = { t: tf, at: F, fouled, offender, penalty: pen };
  caption(plan, tf + 0.3, ev.text || (pen ? 'Penalty!' : 'Foul'), pen ? 'penalty' : 'foul');
  // Referee arrives.
  intent(plan, { agent: REF, type: 'goto', to: { x: F.x + dir * 3, y: F.y + 3 }, t0: tf + 0.3, t1: tf + 6, arrive: tf + 2.1, speed: 7 });
  let t = tf + 2.1;
  // Players gather, the offender protests.
  intent(plan, { agent: offender, type: 'goto', to: { x: F.x + dir * 2, y: F.y + 1.6 }, t0: tf + 0.9, t1: tf + 6, speed: 3 });
  anim(plan, offender, S.APPEAL, tf + 1.1, tf + 2.3);
  const card = ev.card === 'red' || ev.card === 'second_yellow' ? 'red' : ev.card === 'yellow' ? 'yellow' : null;
  if (card) {
    if (ev.card === 'second_yellow') { anim(plan, REF, S.CARD_Y, t, t + 1.1); anim(plan, REF, S.CARD_R, t + 1.1, t + 2.4); }
    else anim(plan, REF, card === 'red' ? S.CARD_R : S.CARD_Y, t, t + 2.2);
    plan.marks.card = { t, agent: offender, color: card, second: ev.card === 'second_yellow' };
    caption(plan, t, `${card === 'red' ? 'RED CARD' : 'Yellow card'} — ${playerOf(M, offender).name}`, card === 'red' ? 'red' : 'yellow');
    if (card === 'red') intent(plan, { agent: offender, type: 'goto', to: { x: F.x, y: 69.5 }, t0: t + 1.6, t1: t + 8, speed: 2.4 });
    t += ev.card === 'second_yellow' ? 2.5 : 2.3;
  }
  // Restart set-up: ball placed on the spot (or the penalty spot).
  if (pen) {
    anim(plan, REF, S.POINT, tf + 0.5, tf + 2);
    const spot = toWorld(dir, 94, 34);
    step(plan, { t: t + 0.2, type: 'dead', at: spot, team: side });
    const taker = findAgent(M, side, ev.taker) ?? pick(M, side, ['ST', 'CAM', 'LW', 'RW'], ctx.sent);
    const sent2 = new Set(ctx.sent); if (card === 'red') sent2.add(offender);
    const pos = penaltyPositions({ ...plan, ctx: { ...ctx, sent: sent2 } }, side, taker);
    for (let a = 0; a < 22; a++) if (a !== offender || card !== 'red') intent(plan, { agent: a, type: 'goto', to: pos[a], t0: t + 0.3, t1: t + 9, speed: 3.6 });
    plan.marks.setup = { type: 'penalty', side, positions: pos, spot };
    t += 2.8;
  } else {
    step(plan, { t: t + 0.2, type: 'dead', at: F, team: side });
    const taker = findAgent(M, side, ev.taker) ?? pick(M, side, ['CAM', 'CM', 'LW', 'RW', 'ST'], ctx.sent, [fouled]);
    const sent2 = new Set(ctx.sent); if (card === 'red') sent2.add(offender);
    const pos = freeKickPositions({ ...plan, ctx: { ...ctx, sent: sent2 } }, side, F, taker);
    for (let a = 0; a < 22; a++) if (a !== offender || card !== 'red') intent(plan, { agent: a, type: 'goto', to: pos[a], t0: t + 0.3, t1: t + 9, speed: 3.6 });
    plan.marks.setup = { type: 'freekick', side, positions: [...pos], wall: pos.wall, spot: F };
    caption(plan, t + 0.4, pos.wall.length ? `Free kick — ${Math.round(dist(F, toWorld(dir, 105, 34)))} m, the wall is set` : 'Free kick', 'freekick');
    t += pos.wall.length ? 3.2 : 1.6;
  }
  plan.dur = t + 0.2;
  return { climax: tf, protagonists: [fouled, offender], card, penalty: pen, fouled, offender };
}

// ---------- offside: the assistant's flag goes up, indirect free kick to the defenders
function buildOffside(plan, ev) {
  const { M, ctx, rnd } = plan;
  const side = ev.side, opp = other(side), dir = M.dir[side];
  let runner = findAgent(M, side, ev.player) ?? pick(M, side, ['ST', 'LW', 'RW'], ctx.sent);
  let passer = findAgent(M, side, ev.assist);
  if (passer == null || passer === runner) passer = pick(M, side, ['CAM', 'CM', 'CDM'], ctx.sent, [runner]);
  const { v } = evLoc(M, side, ev, 80, 34);
  const passFrom = { u: 56 + rnd() * 10, v: clamp(34 + (rnd() - 0.5) * 16, 12, 56) };
  const pf = toWorld(dir, passFrom.u, passFrom.v);
  ctx.ballStart = pf; ctx.possStart = side; ctx.carrier = passer;
  ctx.start = shapeStart(M, pf, side, ctx.sent);
  ctx.start[passer] = { ...pf };
  step(plan, { t: 0, type: 'hold', agent: passer });
  carry(plan, passer, 0, toWorld(dir, passFrom.u + 4, passFrom.v), 2.3);
  // The line: defenders' line with the ball here; the runner is ~1.5 m beyond it when the ball is played.
  const lineU = L - defLineOf(M.teams[opp], L - (passFrom.u + 4), false);
  holdLine(plan, opp, lineU, 0, 3.0);
  const beyond = 2.4 + rnd() * 1.2;
  const runnerAt = toWorld(dir, lineU + beyond, clamp(v, 10, 58));
  ctx.start[runner] = toWorld(dir, lineU - 4, clamp(v + 4, 10, 58));
  const tp = 2.4;
  const target = toWorld(dir, Math.min(lineU + 12, 98), clamp(v, 10, 58));
  plan.noOnside = true;
  pass(plan, passer, runner, tp, target, clamp(dist(toWorld(dir, passFrom.u + 4, passFrom.v), target) / 17, 0.8, 1.8), 0);
  plan.noOnside = false;
  // Drifts beyond the last defender just before the ball is played (added after the pass so it wins).
  intent(plan, { agent: runner, type: 'goto', to: runnerAt, t0: 0, t1: tp, arrive: tp, speed: 7 });
  plan.marks.offside = { t: tp, runner, lineU, sideAtt: side, passer };
  const flagger = (target.x > L / 2) ? AR_FAR : AR_NEAR;
  anim(plan, flagger, S.FLAG, tp + 0.5, tp + 4.5);
  intent(plan, { agent: flagger, type: 'stay', t0: tp + 0.5, t1: tp + 5 });
  whistle(plan, tp + 1.1);
  caption(plan, tp + 0.9, ev.text || 'Flag up — offside', 'offside');
  // Indirect free kick to the defending team where the runner was.
  const ifk = runnerAt;
  const def = nearestTo(plan, opp, ifk, ['CB', 'LB', 'RB']);
  step(plan, { t: tp + 2.4, type: 'dead', at: ifk, team: opp });
  intent(plan, { agent: def, type: 'goto', to: { x: ifk.x + dir * 1.2, y: ifk.y }, t0: tp + 1.6, t1: tp + 4, arrive: tp + 3.2 });
  anim(plan, runner, S.APPEAL, tp + 1.6, tp + 3.2);
  plan.dur = tp + 4.4;
  return { climax: tp, protagonists: [runner, passer], runner };
}

// ---------- corner that's cleared
function buildCornerClear(plan, ev) {
  const { M, ctx, rnd } = plan;
  const side = ev.side, opp = other(side);
  const { v } = evLoc(M, side, ev, 100, rnd() < 0.5 ? 10 : 58);
  const { t, taker } = setupCorner(plan, side, v, null, findAgent(M, side, ev.player));
  const dir = M.dir[side];
  const land = toWorld(dir, 97 + rnd() * 3, 30 + rnd() * 8);
  const header = nearestTo(plan, opp, land, ['CB', 'ST', 'CDM']);
  intent(plan, { agent: header, type: 'goto', to: land, t0: 0.8, t1: t + 1.4, arrive: t + 1.25, speed: 7.5 });
  pass(plan, taker, header, t, land, 1.25, 7.5);
  anim(plan, header, S.HEAD, t + 1.0, t + 1.6);
  const clearTo = toWorld(dir, 70 - rnd() * 15, 34 + (rnd() - 0.5) * 30);
  step(plan, { t: t + 1.25, type: 'free', from: { x: land.x, y: land.y, z: 2.2 }, to: { x: clearTo.x, y: clearTo.y, z: 0 }, dur: 1.4, loft: 7 });
  caption(plan, t + 1.3, ev.text || 'Headed clear', 'corner');
  plan.dur = t + 3;
  return { climax: t + 1.25, protagonists: [header] };
}

// ---------- referee's whistle for half-time / full-time
function buildWhistle(plan, ev) {
  const { M, ctx, rnd } = plan;
  const side = rnd() < 0.5 ? 'A' : 'B';
  const dir = M.dir[side];
  const b = toWorld(dir, 40 + rnd() * 20, 20 + rnd() * 28);
  ctx.ballStart = b; ctx.possStart = side;
  const holder = pick(M, side, ['CB', 'CDM', 'CM'], ctx.sent);
  ctx.carrier = holder; ctx.start = shapeStart(M, b, side, ctx.sent); ctx.start[holder] = { ...b };
  step(plan, { t: 0, type: 'hold', agent: holder });
  carry(plan, holder, 0, toWorld(dir, 45, 30), 1.4);
  whistle(plan, 1.5); whistle(plan, 2.0); whistle(plan, 2.6);
  anim(plan, REF, S.POINT, 1.5, 3.4);
  step(plan, { t: 1.7, type: 'dead', at: toWorld(dir, 45, 30), team: side });
  for (let a = 0; a < 22; a++) {
    intent(plan, { agent: a, type: 'goto', to: { x: L / 2 + (a % 7 - 3) * 2.2, y: 70 }, t0: 2.2, t1: 12, speed: 1.6 + (a % 3) * 0.3 });
  }
  const winner = ev.winner;
  if (ev.type === 'full_time' && winner) {
    for (const p of M.teams[winner].players) if (!ctx.sent.has(p.agent)) anim(plan, p.agent, S.CELEB, 2.2, 7);
    for (const p of M.teams[other(winner)].players) if (!ctx.sent.has(p.agent)) anim(plan, p.agent, p.role === 'GK' ? S.FALL : S.DEJECT, 2.4, 7);
  }
  caption(plan, 1.6, ev.text || (ev.type === 'full_time' ? 'Full time!' : 'Half-time'), ev.type === 'full_time' ? 'ft' : 'ht');
  plan.dur = 5.2;
  return { climax: 1.6 };
}

function buildInjury(plan, ev) {
  const { M, ctx, rnd } = plan;
  const side = ev.side || 'A', dir = M.dir[side];
  let a = findAgent(M, side, ev.player);
  if (a == null || ctx.sent.has(a)) a = pick(M, side, ['CM', 'ST', 'CB'], ctx.sent);
  const at = toWorld(dir, 45 + rnd() * 25, 15 + rnd() * 38);
  ctx.ballStart = { x: at.x + 6, y: at.y }; ctx.possStart = other(side); ctx.carrier = -1;
  ctx.start = shapeStart(M, at, other(side), ctx.sent); ctx.start[a] = { ...at };
  step(plan, { t: 0, type: 'dead', at: ctx.ballStart, team: other(side) });
  anim(plan, a, S.FALL, 0, 6);
  intent(plan, { agent: a, type: 'stay', t0: 0, t1: 6 });
  whistle(plan, 0.6);
  intent(plan, { agent: REF, type: 'goto', to: { x: at.x + 2, y: at.y + 2 }, t0: 0.5, t1: 6, speed: 6 });
  caption(plan, 0.6, ev.text || 'Play stopped for an injury', 'injury');
  plan.dur = 4.6;
  return { climax: 0.6, protagonists: [a] };
}

// ---------- pre-match: line-up on the halfway line
function buildWalkout(plan) {
  const { M, ctx } = plan;
  const start = [];
  for (let a = 0; a < 22; a++) {
    const side = sideOf(a), i = a - baseOf(side);
    start.push({ x: L / 2 + (side === 'A' ? -1.8 : 1.8) + 0, y: 18 + i * 3.2 });
  }
  start.push({ x: L / 2, y: 13 }, { x: L / 2 - 1.5, y: 12 }, { x: L / 2 + 1.5, y: 12 });
  for (let a = 0; a < 22; a++) start[a] = { x: L / 2 + (sideOf(a) === 'A' ? -1.8 : 1.8), y: 16 + (a % 11) * 3.3 };
  ctx.start = start; ctx.ballStart = { x: L / 2, y: 13.8 }; ctx.possStart = 'A'; ctx.carrier = -1;
  step(plan, { t: 0, type: 'dead', at: ctx.ballStart, team: 'A' });
  for (let a = 0; a < 25; a++) intent(plan, { agent: a, type: 'stay', t0: 0, t1: 20 });
  plan.dur = 9;
  plan.camSpeed = 0.15;
  return { climax: 0 };
}

// ---------- spell of possession (between the big moments)
function buildFlow(plan, ev) {
  const { M, ctx, rnd } = plan;
  const side = ev.side || (rnd() < 0.5 ? 'A' : 'B');
  const dir = M.dir[side];
  const startUV = { u: 22 + rnd() * 18, v: 20 + rnd() * 28 };
  const holder = pick(M, side, ['CB', 'CDM'], ctx.sent);
  const sw = toWorld(dir, startUV.u, startUV.v);
  ctx.ballStart = sw; ctx.possStart = side; ctx.carrier = holder;
  ctx.start = shapeStart(M, sw, side, ctx.sent); ctx.start[holder] = { ...sw };
  step(plan, { t: 0, type: 'hold', agent: holder });
  const r = buildUp(plan, side, holder, 0.4, startUV, { u: 55 + rnd() * 15, v: 34 + (rnd() - 0.5) * 30 }, 4, M.teams[side].style.tempo);
  plan.dur = r.t + 0.6;
  caption(plan, 0.3, ev.text, 'flow');
  return { climax: 0 };
}
