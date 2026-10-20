// The match world: 22 players, a referee and two assistants, and a ball, simulated at 30 Hz.
//
// Bodies: acceleration that fades towards top speed, harder braking, a turning circle that widens
// with speed, and a body orientation coupled to the run — a player can backpedal or shuffle sideways
// only slowly, so to play a ball behind him he has to slow down, plant and turn first. Intentions
// reach the body with a short delay (nobody changes direction on the frame he decides to), and
// jumps, dives and slides are ballistic: once off the ground nobody steers.
// Ball: real physics (./ball.js). It is never attached to anyone: carriers touch it with the foot
// that is swinging through, in directions a foot can send it (./carry.js), and run onto it; passes,
// crosses and shots are struck in stride after setting the ball; receivers attack its path.
// Contests: every loose ball — a heavy touch, a pass, a rebound — is a race (./race.js). Defenders
// press, jockey and go in for the ball when it's exposed; a carrier who sees a tackle coming can
// knock it past him; whoever gets there first wins it.
// Football intelligence: everyone plays. The team on the ball offers passing angles in open lanes,
// keeps width and spacing, stays onside, makes darts and checks, and asks for the ball; the team
// without it presses (jockeying when close), covers, tracks runners goal-side, screens lanes and
// steps up as a back line; keepers guard the angle; everyone checks their shoulders; officials
// follow play.
// Scripted football (who scores, who fouls, …) comes from the director as orders to individual
// players; everything else is decided here.
import { L, WD, HZ, DT, N_AGENTS, REF, AR_FAR, AR_NEAR, S, cycleLen, clamp, lerp, angDiff, other, sideOf, baseOf, toWorld, toTeam } from './const.js';
import { shapeTarget, playerOf, ROLE_SPEED, DEFENDERS, FORWARDS } from './shape.js';
import { R, makeBall, stepBall, predict, solveFlight, groundForArrival, solveGround } from './ball.js';
import { timeTo, interceptOf } from './race.js';
import { FOOT_FWD, planTouch, evadeTouch, touchWindow, needTouch, applyTouch, coneOf, speedForGap, touchPath as touchPathQuick } from './carry.js';

const FREE = new Set([S.FALL, S.DIVE_L, S.DIVE_R, S.SLIDE, S.KNEESLIDE]);
const TAU = Math.PI * 2;
const G = 9.81;
const unit = (x, y) => { const l = Math.hypot(x, y) || 1; return [x / l, y / l]; };

// ------------------------------------------------------------------ world
export function createWorld(M, ctx, rnd) {
  const w = {
    M, ctx, rnd, sent: ctx.sent || new Set(), t: 0, k: 0,
    agents: [], ball: makeBall(L / 2, WD / 2), owner: -1, held: -1, dead: null, possSide: 'A', lastTouch: -1,
    flight: null, path: null, log: [], marks: { captions: [], passes: [], whistles: [], touches: [] },
    presser: { A: -1, B: -1 }, cover: { A: -1, B: -1 }, chaser: { A: -1, B: -1 }, line: { A: 52.5, B: 52.5 }, hist: [],
    camX: L / 2, zoom: 1, camZoom: null, camSpeed: null, camHold: null,
    rec: { pos: [], st: [], stT: [], hd: [], ph: [], z: [], lk: [], ball: [], cam: [], poss: [], offX: [] },
  };
  for (let a = 0; a < N_AGENTS; a++) {
    const side = sideOf(a), p = a < 22 ? playerOf(M, a) : null;
    let vmax = a < 22 ? ROLE_SPEED[p.role] || 8 : a === REF ? 7.2 : 7.4;
    if (p) { if (p.age >= 32) vmax -= 0.5; else if (p.age >= 29) vmax -= 0.2; else if (p.age && p.age <= 23) vmax += 0.2; vmax += (rnd() - 0.5) * 0.4; }
    w.agents.push({
      id: a, side, slot: p ? p.slot : -1, role: p ? p.role : a === REF ? 'REF' : 'AR', isGK: p?.role === 'GK',
      foot: p?.foot === 'left' ? 'left' : 'right', vmax, acc: 4.3 + rnd() * 0.6,
      x: 0, y: 0, vx: 0, vy: 0, dvx: 0, dvy: 0, face: 0, ph: rnd(), z: 0, vz: 0,
      st: 0, st0: 0, stEnd: 0, free: false, frict: 0,
      order: null, intent: null, think: rnd() * 0.4, tgt: null, react: 0.14 + rnd() * 0.12, callCd: 1 + rnd() * 3, touchCd: 0,
      kick: null, duel: -1, gone: w.sent.has(a),
      look: 0, glance: null, scanAt: 1 + rnd() * 3, tk: null, recover: 0, threat: null, aggr: 0.5 + rnd() * 0.5,
    });
  }
  return w;
}

export const emit = (w, type, data = {}) => { const e = { type, t: w.t, ...data }; w.log.push(e); return e; };
export function order(w, a, o) {
  const ag = w.agents[a];
  ag.order = o ? { ...o, t0: w.t } : null; ag.kick = null;
  if (o?.type !== 'tackle') ag.duel = -1;
  if (o?.type === 'dribble') ag.intent = { to: o.to, pace: o.speed ?? 5 };
  return ag.order;
}
export function setAnim(w, a, st, dur, free = false, frict = 0) {
  const ag = w.agents[a];
  if (ag.st === st && w.t < ag.stEnd && !free && st !== S.KICK && st !== S.HEAD) { ag.stEnd = Math.max(ag.stEnd, w.t + dur); return; }
  ag.st = st; ag.st0 = w.t; ag.stEnd = w.t + dur; ag.free = free; ag.frict = frict;
}
export const animOf = (w, a) => (w.t < w.agents[a].stEnd ? w.agents[a].st : 0);
export function place(w, a, p, face) {
  const ag = w.agents[a];
  ag.x = p.x; ag.y = p.y; ag.vx = 0; ag.vy = 0; ag.dvx = 0; ag.dvy = 0; ag.z = 0; ag.vz = 0;
  if (face != null) ag.face = face; else ag.face = Math.atan2(w.ball.y - p.y, w.ball.x - p.x);
  ag.look = ag.face;
}
export function giveBall(w, a) {
  const ag = w.agents[a];
  w.owner = a; w.held = -1; w.dead = null; w.flight = null; w.lastTouch = a; w.possSide = ag.side;
  const b = w.ball; b.x = ag.x + Math.cos(ag.face) * FOOT_FWD; b.y = ag.y + Math.sin(ag.face) * FOOT_FWD; b.z = R; b.vx = ag.vx; b.vy = ag.vy; b.vz = 0; b.wx = b.wy = b.wz = 0; b.inNet = 0;
}
export function setDead(w, at, team) {
  w.dead = { x: at.x, y: at.y }; w.owner = -1; w.held = -1; w.flight = null;
  if (team) w.possSide = team;
  Object.assign(w.ball, { x: at.x, y: at.y, z: R, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0, inNet: 0 });
}
export function releaseDead(w) { w.dead = null; }
export function caption(w, text, icon, dt = 0) { if (text) w.marks.captions.push({ t: w.t + dt, text, icon }); }
export function whistle(w) { w.marks.whistles.push(w.t); setAnim(w, REF, S.WHISTLE, 0.7); }
export const goalOf = (w, side) => toWorld(w.M.dir[side], 105, 34);   // the goal `side` attacks
export const ownGoal = (w, side) => toWorld(w.M.dir[side], 0, 34);
export const uOf = (w, side, p) => toTeam(w.M.dir[side], p.x, p.y).u;
export const alive = (w, a) => !w.agents[a].gone;
export const speedOf = ag => Math.hypot(ag.vx, ag.vy);
// A jump: straight up (wall, header) or a keeper's dive (with the sideways launch already set).
export function jump(w, a, vz, floor = 0) { const ag = w.agents[a]; ag.vz = vz; ag.zFloor = floor; ag.z = Math.max(ag.z, floor + 0.001); }
const airborne = ag => ag.vz !== 0 || ag.z > (ag.zFloor || 0) + 0.02;

// ------------------------------------------------------------------ main step
export function tick(w) {
  context(w);
  for (const ag of w.agents) if (!ag.gone) ag.cmd = behave(w, ag);
  if (w.ctx.watch != null && w.k % 3 === 0) { const ag = w.agents[w.ctx.watch]; w.log.push({ type: 'dbg', t: w.t, agent: ag.id, o: ag.order?.type, cmd: ag.cmd && { tx: ag.cmd.tx, ty: ag.cmd.ty, sp: ag.cmd.speed, free: ag.cmd.free }, x: ag.x, y: ag.y }); }
  for (const ag of w.agents) if (!ag.gone) move(w, ag);
  contacts(w);
  for (const ag of w.agents) if (!ag.gone) gaze(w, ag);
  ballActions(w);
  ballPhysics(w);
  record(w);
  w.t += DT; w.k++;
}

// ------------------------------------------------------------------ team context
function context(w) {
  const b = w.ball;
  if (w.owner >= 0) w.possSide = w.agents[w.owner].side;
  else if (w.held >= 0) w.possSide = w.agents[w.held].side;
  else if (w.flight && w.flight.kind !== 'shot' && w.flight.kind !== 'clear') w.possSide = w.agents[w.flight.kicker].side;
  w.hist.push({ x: b.x, y: b.y, z: b.z });
  if (w.hist.length > 12) w.hist.shift();
  const moving = Math.hypot(b.vx, b.vy, b.vz) > 0.3 && w.held < 0 && !w.dead;
  w.path = moving ? predict(b, 2.6, 0.1) : null;
  // Offside line each attacking side has to respect (attacker frame u).
  for (const side of ['A', 'B']) {
    const def = other(side), us = [];
    for (let i = 0; i < 11; i++) { const ag = w.agents[baseOf(def) + i]; if (!ag.gone) us.push(uOf(w, side, ag)); }
    us.sort((p, q) => q - p);
    w.line[side] = Math.max(52.5, us[1] ?? 52.5, uOf(w, side, b));
  }
  looseBall(w);
  // Who presses the ball / covers, for the side without it.
  const def = other(w.possSide);
  const focus = pressFocus(w);
  if (!focus) { w.presser[def] = -1; w.cover[def] = -1; }
  else {
    let best = -1, bt = 1e9, second = -1, st = 1e9;
    for (let i = 1; i < 11; i++) {
      const ag = w.agents[baseOf(def) + i];
      if (ag.gone || ag.order || ag.free || ag.id === w.chaser[def]) continue;
      const d = Math.hypot(ag.x - focus.x, ag.y - focus.y);
      const h = homeOf(w, ag), zone = Math.hypot(h.x - focus.x, h.y - focus.y);
      const tt = timeTo(ag, focus, 1.5) + zone * 0.012 + (DEFENDERS.has(ag.role) && uOf(w, def, focus) > 40 ? 0.6 : 0) + (w.t < ag.recover ? 0.8 : 0);
      if (tt < bt) { second = best; st = bt; best = ag.id; bt = tt; } else if (tt < st) { second = ag.id; st = tt; }
      void d;
    }
    // stickiness: keep the current presser unless someone is clearly better placed
    const cur = w.presser[def];
    if (cur >= 0 && cur !== best && !w.agents[cur].order && !w.agents[cur].gone && w.t >= w.agents[cur].recover) {
      const tt = timeTo(w.agents[cur], focus, 1.5);
      if (tt < bt + 0.45) { if (second === cur) second = best; best = cur; }
    }
    w.presser[def] = best; w.cover[def] = second;
  }
  w.presser[w.possSide] = -1; w.cover[w.possSide] = -1;
}

// Loose balls are races: each team sends whoever gets there first (if he can get there at all —
// including a defender who can nick a dribbler's heavy touch or step into a pass).
function looseBall(w) {
  w.chaser.A = -1; w.chaser.B = -1;
  if (w.dead || w.held >= 0) return;
  const b = w.ball;
  const path = w.path || [{ t: 0, x: b.x, y: b.y, z: b.z }];
  const fl = w.flight;
  if (fl && fl.kind === 'shot') return;
  for (const side of ['A', 'B']) {
    // carrier's own ball: only opponents race him for it, and only when it's away from his feet
    if (w.owner >= 0) {
      const c = w.agents[w.owner];
      if (c.side === side) continue;
      if (Math.hypot(b.x - c.x, b.y - c.y) < 1.25 || c.kick) continue;
    }
    // a pass to a team-mate: his team has a receiver already
    if (fl && fl.receiver >= 0 && w.agents[fl.receiver].side === side && w.owner < 0) continue;
    let best = -1, bt = 1e9;
    for (let i = 0; i < 11; i++) {
      const ag = w.agents[baseOf(side) + i];
      if (ag.gone || ag.free || ag.order || w.t < ag.recover) continue;
      if (ag.isGK && !inOwnBox(w, ag, path[path.length - 1])) continue;
      const r = interceptOf(ag, path, { reach: 0.8, zmax: 1.6, slack: 0.15 });
      if (r && r.t < bt) { bt = r.t; best = ag.id; }
    }
    if (best < 0) continue;
    // against a dribbler: only if he really beats him to it
    if (w.owner >= 0) {
      const c = w.agents[w.owner];
      const mine = interceptOf(c, path, { reach: 0.6, zmax: 1, react: 0 });
      if (mine && mine.t <= bt + 0.05) continue;
    }
    w.chaser[side] = best;
    w.agents[best].chase = { t: bt };
  }
}
function inOwnBox(w, ag, p) { const u = uOf(w, ag.side, p), v = toTeam(w.M.dir[ag.side], p.x, p.y).v; return u < 16.5 && v > 13.85 && v < 54.15; }

// World x of the offside line in each half: 'left' (x < 52.5) and 'right'.
export function lineX(w, half) {
  const leftDef = w.M.dir.A > 0 ? 'A' : 'B';          // team defending the goal at x = 0
  const att = half === 'left' ? other(leftDef) : leftDef;
  return toWorld(w.M.dir[att], w.line[att], 34).x;
}
// What the defending team presses: the ball carrier, or where a pass will be received.
function pressFocus(w) {
  if (w.dead) return null;
  if (w.owner >= 0) { const c = w.agents[w.owner]; return { x: c.x + c.vx * 0.35, y: c.y + c.vy * 0.35, carrier: c }; }
  if (w.flight && w.flight.target && w.flight.kind !== 'shot') return { x: w.flight.target.x, y: w.flight.target.y, arrive: w.flight.t0 + w.flight.T };
  if (w.held >= 0) return null;
  return { x: w.ball.x, y: w.ball.y };
}
function homeOf(w, ag, ballRef) {
  const b = ballRef || (w.owner >= 0 ? w.agents[w.owner] : w.ball);
  return shapeTarget(w.M, ag.side, ag.slot, { x: b.x, y: b.y }, w.possSide);
}
// Ball position as this player perceived it a reaction-time ago.
function seenBall(w, ag) {
  const k = Math.max(0, w.hist.length - 1 - Math.round(ag.react * HZ));
  return w.hist[k] || w.ball;
}

// How open the lane from p to q is against `defSide` (metres of margin; < 0 means a defender
// would get there before the ball).
export function laneOpen(w, p, q0, defSide, ballSpeed = 15, shield = 0) {
  // the last `shield` metres are the receiver's: he takes it on the side away from his marker
  const ddx = q0.x - p.x, ddy = q0.y - p.y, dl = Math.hypot(ddx, ddy) || 1;
  const k = Math.max(0.3, (dl - shield) / dl);
  const q = { x: p.x + ddx * k, y: p.y + ddy * k };
  const dx = q.x - p.x, dy = q.y - p.y, L2 = dx * dx + dy * dy || 1, len = Math.sqrt(L2);
  let worst = 9;
  for (let i = 0; i < 11; i++) {
    const ag = w.agents[baseOf(defSide) + i];
    if (ag.gone) continue;
    const s = clamp(((ag.x - p.x) * dx + (ag.y - p.y) * dy) / L2, 0, 1);
    const cx = p.x + dx * s, cy = p.y + dy * s, d = Math.hypot(ag.x - cx, ag.y - cy);
    const tBall = (s * len) / ballSpeed;
    // how far he can get in that time: reaction, then accelerating from his current motion
    const tt = Math.max(0, tBall - ag.react - 0.12);
    const reach = 0.65 + (tt < 1.6 ? 2.1 * tt * tt : 5.4 + (tt - 1.6) * ag.vmax * 0.85);
    worst = Math.min(worst, d - reach);
  }
  return worst;
}

// ------------------------------------------------------------------ behaviours → movement commands
function behave(w, ag) {
  if (airborne(ag) || (ag.free && w.t < ag.stEnd) || ag.z < -0.05) return { free: true };
  ag.free = false;
  if (ag.order) { const c = orderCmd(w, ag); if (c) return c; }
  if (ag.id === w.owner) return carrierCmd(w, ag, ag.intent || (ag.intent = defaultIntent(w, ag)));
  if (ag.id === w.held) return { stay: true, face: ag.face };
  if (ag.id >= 22) return official(w, ag);
  if (ag.tk) return { free: true };
  if (w.dead && w.deadCalm) return calm(w, ag);
  if (w.chaser[ag.side] === ag.id) return chaseCmd(w, ag);
  if (ag.isGK) return keeperAI(w, ag);
  if (ag.side === w.possSide) return attackerAI(w, ag);
  return defenderAI(w, ag);
}

const toBall = (w, ag) => Math.atan2(w.ball.y - ag.y, w.ball.x - ag.x);
// Pace that grows smoothly with how far there is to go (no stepped speeds).
const paceFor = (d, cap, k = 0.85) => clamp(0.35 + d * k, 0, cap);

// Stoppages: players drift into shape at walking pace.
function calm(w, ag) {
  const h = homeOf(w, ag, w.ball);
  return { tx: h.x, ty: h.y, speed: 2.2, face: toBall(w, ag), keepFace: true, stop: 0.6 };
}

// --- a loose ball: get to it first (attack the ball's path, not where it is now)
function chaseCmd(w, ag) {
  const b = w.ball, path = w.path;
  let p = { x: b.x, y: b.y }, T = 0.1;
  if (path) {
    const r = interceptOf(ag, path, { reach: 0.7, zmax: 1.6, slack: 0.15 });
    if (r) { p = r; T = Math.max(0.1, r.t); }
    else { p = path[path.length - 1]; T = path[path.length - 1].t; }
  }
  const d = Math.hypot(p.x - ag.x, p.y - ag.y);
  return { tx: p.x, ty: p.y, speed: clamp(d / T * 1.15 + 1, 2.5, ag.vmax), face: null, stop: 0, precise: true };
}

// --- on the ball without instructions: keep playing — drive into space, protect it under pressure
function defaultIntent(w, ag) {
  const g = goalOf(w, ag.side);
  const opp = nearestOpp(w, ag, 9);
  const d = opp ? Math.hypot(opp.x - ag.x, opp.y - ag.y) : 9;
  let [dx, dy] = unit(g.x - ag.x, g.y - ag.y);
  if (opp && d < 5) { const [ox, oy] = unit(ag.x - opp.x, ag.y - opp.y); dx = dx * 0.5 + ox * 0.5; dy = dy * 0.5 + oy * 0.5; [dx, dy] = unit(dx, dy); }
  return { to: { x: clamp(ag.x + dx * 15, 2, L - 2), y: clamp(ag.y + dy * 15, 2, WD - 2) }, pace: clamp(1.2 + d * 0.55, 1.8, 5.5), keep: d < 3, auto: true, t: w.t };
}
function nearestOpp(w, ag, within) {
  let best = null, bd = within;
  for (let i = 0; i < 11; i++) { const o = w.agents[baseOf(other(ag.side)) + i]; if (o.gone) continue; const d = Math.hypot(o.x - ag.x, o.y - ag.y); if (d < bd) { bd = d; best = o; } }
  return best;
}

// --- running with the ball: follow the ball he has just touched and arrive behind it, at his
// pace, ready for the next touch. (The touches themselves are in carrierTouch.)
function carrierCmd(w, ag, intent) {
  if (intent.auto && w.t - intent.t > 0.6) ag.intent = intent = defaultIntent(w, ag);
  const b = w.ball;
  const bs = Math.hypot(b.vx, b.vy);
  const want = intentDir(ag, intent, b);
  const tau = 0.3;
  // where the ball will be (it is slowing down)
  const decel = Math.min(bs, 1.5 * tau);
  const bx = b.x + (bs > 0.01 ? (b.vx / bs) * (bs * tau - 0.5 * decel * tau) : 0);
  const by = b.y + (bs > 0.01 ? (b.vy / bs) * (bs * tau - 0.5 * decel * tau) : 0);
  // get behind it, along the line it is travelling (or the way he wants to take it, if it's still)
  let ad = bs > 1.2 ? Math.atan2(b.vy, b.vx) : want;
  if (bs <= 1.2 && Math.abs(angDiff(ag.face, want)) > coneOf(speedOf(ag))) ad = ag.face + clamp(angDiff(ag.face, want), -1.2, 1.2);
  const tx = bx - Math.cos(ad) * FOOT_FWD, ty = by - Math.sin(ad) * FOOT_FWD;
  const dx = tx - ag.x, dy = ty - ag.y, d = Math.hypot(dx, dy);
  // the ball sets the pace: he runs onto it and arrives behind it as it slows
  const v = Math.min(d / tau, ag.vmax);
  // standing on it and wanting to go elsewhere: turn the body first
  const face = speedOf(ag) < 1.4 && Math.hypot(b.x - ag.x, b.y - ag.y) < 0.9 ? want : null;
  if (d < 1e-3) return { vx: 0, vy: 0, face, precise: true };
  return { vx: (dx / d) * v, vy: (dy / d) * v, face, precise: true };
}
// The direction he wants to take it: towards his target, held steady once he's close to it.
export function intentDir(ag, intent, b) {
  if (intent.dir != null) return intent.dir;
  const dx = intent.to.x - b.x, dy = intent.to.y - b.y;
  if (Math.hypot(dx, dy) > 4 || intent._dir == null) intent._dir = Math.atan2(dy, dx);
  return intent._dir;
}

// --- team in possession, off the ball: find space, offer an angle, stay onside, ask for it
function attackerAI(w, ag) {
  if (w.t >= ag.think || !ag.tgt) { ag.think = w.t + 0.35 + w.rnd() * 0.25; ag.tgt = supportSpot(w, ag); }
  const t = ag.tgt;
  const d = Math.hypot(t.x - ag.x, t.y - ag.y);
  const speed = t.run ? ag.vmax * 0.92 : paceFor(d, urgency(w, ag, 4.4, 6.2), 0.6);
  // Asking for the ball: open, in range, the carrier has time.
  if (w.owner >= 0 && t.open > 2.2 && t.dc < 28 && t.dc > 7 && w.t > ag.callCd && !t.run) {
    ag.callCd = w.t + 4 + w.rnd() * 4;
    if (w.rnd() < 0.55) setAnim(w, ag.id, S.CALL, 0.8);
  }
  return { tx: t.x, ty: t.y, speed, face: toBall(w, ag), keepFace: !t.run, stop: 0.4 };
}
function supportSpot(w, ag) {
  const side = ag.side, def = other(side);
  const car = w.owner >= 0 ? w.agents[w.owner] : w.flight?.target ? { x: w.flight.target.x, y: w.flight.target.y } : w.ball;
  const home = homeOf(w, ag);
  const line = w.line[side], bu = uOf(w, side, car);
  const cands = [home];
  for (const r of [4, 8]) for (let k = 0; k < 8; k++) { const a = (k / 8) * TAU + (r === 8 ? 0.39 : 0); cands.push({ x: home.x + Math.cos(a) * r, y: home.y + Math.sin(a) * r }); }
  const fwd = FORWARDS.has(ag.role);
  let best = null, bs = -1e9;
  for (const c0 of cands) {
    const c = { x: clamp(c0.x, 1.5, L - 1.5), y: clamp(c0.y, 1.5, WD - 1.5) };
    const u = uOf(w, side, c);
    let s = -Math.max(0, Math.hypot(c.x - home.x, c.y - home.y) - 3) * 0.12;
    if (u > line - 0.6 && u > bu) s -= 6;                               // offside
    if (u > 103 || u < 1) s -= 4;
    for (let i = 0; i < 11; i++) {
      const o = w.agents[baseOf(side) + i];
      if (o === ag || o.gone || o.isGK) continue;
      const ox = o.tgt?.x ?? o.x, oy = o.tgt?.y ?? o.y, dd = Math.hypot(c.x - ox, c.y - oy);
      if (dd < 7) s -= (7 - dd) * 0.5;
    }
    let open = 0, dc = 0;
    if (car && w.owner !== ag.id) {
      dc = Math.hypot(c.x - car.x, c.y - car.y);
      if (dc < 6) s -= (6 - dc) * 0.8;
      s -= Math.abs(dc - 16) * 0.05;
      open = laneOpen(w, car, c, def);
      s += clamp(open, -2.5, 3) * 0.75;
      if (!DEFENDERS.has(ag.role)) s += clamp(u - bu, -10, 25) * 0.03;
      if (fwd && line - u < 3 && line - u > 0.5) s += 0.6;                // on the shoulder of the last defender
    }
    const near = nearestOppAt(w, def, c);
    if (near < 2.5) s -= (2.5 - near) * 0.8;
    if (s > bs) { bs = s; best = { x: c.x, y: c.y, open, dc, score: s }; }
  }
  // keep the current spot unless the new one is clearly better (no twitching)
  if (ag.tgt && !ag.tgt.run) {
    const t = ag.tgt, still = { ...t };
    if (best && best.score < (t.score ?? -1e9) + 0.5 && Math.hypot(t.x - home.x, t.y - home.y) < 12) return still;
  }
  return best || home;
}
export function nearestOppAt(w, def, p) {
  let bd = 99;
  for (let i = 0; i < 11; i++) { const o = w.agents[baseOf(def) + i]; if (!o.gone) bd = Math.min(bd, Math.hypot(o.x - p.x, o.y - p.y)); }
  return bd;
}

// --- team without the ball: press, cover, track runners goal-side, screen lanes, hold the line
function defenderAI(w, ag) {
  const side = ag.side, att = other(side), goal = ownGoal(w, side);
  const focus = pressFocus(w);
  if (focus && w.presser[side] === ag.id) return press(w, ag, focus, goal);
  const sb = seenBall(w, ag);
  const home = shapeTarget(w.M, side, ag.slot, sb, att);
  if (focus && w.cover[side] === ag.id) {
    // second man: goal-side of the ball, close enough to step in if the presser is beaten
    const [gx, gy] = unit(goal.x - focus.x, goal.y - focus.y);
    const tx = focus.x + gx * 6.5 + (home.x - focus.x) * 0.15, ty = focus.y + gy * 6.5 + (home.y - focus.y) * 0.25;
    const d = Math.hypot(tx - ag.x, ty - ag.y);
    return { tx, ty, speed: paceFor(d, 7, 0.9), face: toBall(w, ag), keepFace: d < 6, stop: 0.4 };
  }
  // the attacker closest to my zone — and anyone running in behind gets tracked
  let mk = null, md = DEFENDERS.has(ag.role) ? 9 : 11;
  for (let i = 1; i < 11; i++) {
    const o = w.agents[baseOf(att) + i];
    if (o.gone || o.id === w.owner) continue;
    let d = Math.hypot(o.x - home.x, o.y - home.y);
    const runIn = Math.max(0, -toTeamV(w, side, o));
    if (runIn > 3.5 && Math.hypot(o.x - ag.x, o.y - ag.y) < 12) d -= 4;      // a run at my goal: he's mine
    if (d < md) { md = d; mk = o; }
  }
  let tx = home.x, ty = home.y, urgent = false;
  if (mk) {
    const lead = 0.45;
    const mx0 = mk.x + mk.vx * lead, my0 = mk.y + mk.vy * lead;
    const [gx, gy] = unit(goal.x - mx0, goal.y - my0);
    const runIn = Math.max(0, -toTeamV(w, side, mk));
    if (runIn > 3.5) {
      // tracking a runner: stay goal-side of him, at his shoulder, matching his pace
      tx = mx0 + gx * 1.3; ty = my0 + gy * 1.3; urgent = true;
    } else if (DEFENDERS.has(ag.role)) {
      // back line: stay on the line unless he drops deeper; track him goal-side
      const lineU = uOf(w, side, home), mu = uOf(w, side, mk);
      const m = toTeam(w.M.dir[side], mx0 + gx * 1.8, my0 + gy * 1.8);
      const u = Math.min(lineU, Math.max(m.u, mu - 2.2)), v = lerp(toTeam(w.M.dir[side], home.x, home.y).v, m.v, 0.65);
      const p = toWorld(w.M.dir[side], u, v); tx = p.x; ty = p.y;
    } else {
      // midfield: screen the lane between the ball and his man, goal-side
      const bx = focus ? focus.x : sb.x, by = focus ? focus.y : sb.y;
      tx = lerp(mx0 + gx * 1.5, bx, 0.3); ty = lerp(my0 + gy * 1.5, by, 0.3);
      tx = lerp(tx, home.x, 0.35); ty = lerp(ty, home.y, 0.35);
    }
  }
  const d = Math.hypot(tx - ag.x, ty - ag.y);
  const speed = urgent ? Math.min(ag.vmax, speedOf(mk) + 1.2) : paceFor(d, urgency(w, ag, 4.6, 6.6), 0.65);
  return { tx, ty, speed, face: toBall(w, ag), keepFace: !urgent && d < 7, stop: 0.3 };
}
// How hard a player works to get into position: easy jogging far from the ball, quicker close to
// it (or when his team has just lost it and he's out of position).
function urgency(w, ag, lo, hi) {
  const b = w.ball, d = Math.hypot(b.x - ag.x, b.y - ag.y);
  return lerp(lo, hi, clamp((32 - d) / 22, 0, 1));
}
// Velocity of agent o towards `side`'s own goal is negative u-velocity in side's frame.
function toTeamV(w, side, o) { return o.vx * w.M.dir[side]; }

// The first defender: close him down fast, brake in time, then jockey — goal-side, on his inside
// shoulder (show him down the line), giving ground at his pace — and go in when the ball is there
// to be won.
function press(w, ag, focus, goal) {
  const c = focus.carrier;
  if (!c) {
    // a pass is on its way: get to the receiver as it arrives
    const d = Math.hypot(focus.x - ag.x, focus.y - ag.y);
    return { tx: focus.x, ty: focus.y, speed: d > 4 ? ag.vmax * 0.95 : paceFor(d, 6, 1.2), face: null, stop: 1.6 };
  }
  const lead = 0.3;
  const cx = c.x + c.vx * lead, cy = c.y + c.vy * lead;
  const [gx, gy] = unit(goal.x - cx, goal.y - cy);
  // inside shoulder: towards the middle of the pitch
  const inSign = Math.sign((WD / 2 - cy) * gx) || 1;
  const px = -gy * inSign, py = gx * inSign;
  const towardGoal = Math.max(0, c.vx * gx + c.vy * gy);
  const gap = clamp(1.5 + towardGoal * 0.3, 1.4, 3.4);
  const tx = cx + gx * gap + px * 0.35, ty = cy + gy * gap + py * 0.35;
  const d = Math.hypot(c.x - ag.x, c.y - ag.y);
  const face = Math.atan2(c.y - ag.y, c.x - ag.x);
  maybeChallenge(w, ag, c);
  if (d < 3.6) {
    // jockey: side-on, low, matching his movement, never diving in blind
    setAnim(w, ag.id, S.JOCKEY, 0.25);
    return { tx, ty, speed: Math.max(2.5, speedOf(c) + 1.2), face: face + 0.3, keepFace: true, stop: 0.05 };
  }
  // closing down: sprint, then brake so he arrives balanced (braking distance at 6 m/s² )
  const sp = speedOf(ag), brake = (sp * sp) / 12;
  const speed = d - gap > brake + 1.5 ? ag.vmax * 0.97 : clamp(Math.sqrt(2 * 5.5 * Math.max(0, d - gap)), 2.5, ag.vmax);
  return { tx, ty, speed, face, keepFace: false, stop: 0.05 };
}

// Going in: a poke at a ball that has left the dribbler's feet, or a slide across a ball he has
// knocked on. When the attacker is being protected by the script, the defender still goes in —
// but only as the dribbler is about to touch it, so the touch takes it past him (a beaten man).
function maybeChallenge(w, ag, c) {
  if (ag.tk || w.t < ag.recover || ag.order || c.kick) return;
  const b = w.ball;
  if (b.z > 0.5) return;
  const db = Math.hypot(b.x - ag.x, b.y - ag.y), dc = Math.hypot(b.x - c.x, b.y - c.y);
  const protect = w.protect === c.side;
  const sp = speedOf(ag);
  // ball in front of him?
  const toB = Math.atan2(b.y - ag.y, b.x - ag.x), facing = Math.abs(angDiff(ag.face, toB));
  let kind = null;
  if (db < 1.45 && facing < 1.2) kind = 'poke';
  else if (db < 3.0 && db > 1.5 && sp > 3.8 && facing < 0.6 && !protect) kind = 'slide';
  if (!kind) return;
  if (protect) {
    // he goes in as the dribbler is set to touch it — and gets done by the touch
    if (dc > 0.95 || w.rnd() > 0.06 * ag.aggr || w.t < (c.beatenAt ?? -9) + 2.5) return;
  } else {
    // only when the ball is genuinely there to be won (away from the dribbler's feet, nearer him)
    const mine = timeTo(ag, b, kind === 'poke' ? 1.1 : 1.6, { react: 0 });
    const his = timeTo(c, b, 0.55, { react: 0 });
    if (!(dc > 0.8 && mine + 0.05 < his) || w.rnd() > 0.35 * ag.aggr) return;
  }
  commitTackle(w, ag, c, kind, protect);
}
function commitTackle(w, ag, c, kind, protect) {
  const b = w.ball;
  const lead = kind === 'slide' ? 0.3 : 0.15;
  const px = b.x + b.vx * lead, py = b.y + b.vy * lead;
  const [ux, uy] = unit(px - ag.x, py - ag.y);
  ag.face = Math.atan2(uy, ux);
  const at = w.t + (kind === 'slide' ? 0.32 : 0.2);
  ag.tk = { kind, at, target: c.id, protect, t0: w.t };
  if (kind === 'slide') {
    const v = Math.max(5, speedOf(ag) + 0.5);
    ag.vx = ux * v; ag.vy = uy * v;
    setAnim(w, ag.id, S.SLIDE, 1.5, true, 2.1);
  } else {
    const v = Math.max(1.8, speedOf(ag) * 0.8);
    ag.vx = ux * v; ag.vy = uy * v;
    setAnim(w, ag.id, S.LUNGE, 0.7, true, 3.4);
  }
  c.threat = { from: ag.id, at, kind };
  emit(w, 'challenge', { agent: ag.id, target: c.id, kind });
}

// --- keeper: on the line between ball and goal centre; set when a shot is coming
function keeperAI(w, ag) {
  const sb = seenBall(w, ag);
  const h = shapeTarget(w.M, ag.side, ag.slot, sb, w.possSide);
  const d = Math.hypot(h.x - ag.x, h.y - ag.y);
  // small steps facing the ball (keepers shuffle, they don't turn and run)
  return { tx: h.x, ty: h.y, speed: d > 6 ? 5.5 : paceFor(d, 3.4, 1.4), face: toBall(w, ag), keepFace: d < 6 ? 'strict' : true, stop: 0.1 };
}

// --- officials
function official(w, ag) {
  const b = w.ball;
  if (ag.id === REF) {
    const sx = b.x < L / 2 ? 1 : -1;
    const tx = clamp(b.x + sx * 12, 6, 99), ty = clamp(b.y + (b.y < 34 ? 14 : -14), 6, 62);
    const d = Math.hypot(tx - ag.x, ty - ag.y);
    return { tx, ty, speed: paceFor(d, 6.4, 0.6), face: toBall(w, ag), keepFace: d < 8, stop: 1 };
  }
  // assistants: in line with the second-last defender (or the ball, if further)
  const far = ag.id === AR_FAR;
  const lx = lineX(w, far ? 'right' : 'left');
  const tx = far ? clamp(Math.max(lx, b.x), 52.5, 104.5) : clamp(Math.min(lx, b.x), 0.5, 52.5);
  return { tx, ty: far ? -1.4 : 69.4, speed: 6.5, face: far ? Math.PI / 2 : -Math.PI / 2, keepFace: 'strict', stop: 0.2 };
}

// --- director orders
function orderCmd(w, ag) {
  const o = ag.order;
  switch (o.type) {
    case 'stay': return { stay: true, face: o.face ?? toBall(w, ag) };
    case 'goto': {
      const d = Math.hypot(o.to.x - ag.x, o.to.y - ag.y);
      if (o.done && d < 0.6) { ag.order = null; return null; }
      return { tx: o.to.x, ty: o.to.y, speed: o.speed ?? 6, arrive: o.arrive ?? null, face: o.face ?? (o.faceBall ? toBall(w, ag) : null), keepFace: o.keepFace ?? false, stop: o.stop ?? 0.2 };
    }
    case 'follow': {
      const t = w.agents[o.target];
      return { tx: t.x + (o.dx || 0), ty: t.y + (o.dy || 0), speed: o.speed ?? 7, face: Math.atan2(t.y - ag.y, t.x - ag.x), stop: 0.6 };
    }
    case 'mark': {
      const t = w.agents[o.target], g = ownGoal(w, ag.side), [gx, gy] = unit(g.x - t.x, g.y - t.y);
      return { tx: t.x + t.vx * 0.3 + gx * (o.gap ?? 1.2), ty: t.y + t.vy * 0.3 + gy * (o.gap ?? 1.2), speed: ag.vmax * 0.95, face: toBall(w, ag), keepFace: true, stop: 0.05 };
    }
    case 'run': {
      // A timed run: hold an onside spot until `go`, then attack the target.
      if (!o.go) {
        const p = o.hold || o.to, d = Math.hypot(p.x - ag.x, p.y - ag.y);
        return { tx: p.x, ty: p.y, speed: paceFor(d, 6.2, 0.8), face: toBall(w, ag), keepFace: d < 5, stop: 0.3 };
      }
      return { tx: o.to.x, ty: o.to.y, speed: o.speed ?? ag.vmax * 0.95, arrive: o.arrive ?? null, face: null, stop: 0.15, precise: true };
    }
    case 'dribble': {
      if (w.owner !== ag.id) return w.owner < 0 ? chaseCmd(w, ag) : null;
      ag.intent = { to: o.to, pace: o.speed ?? 5, keep: o.keep };
      return carrierCmd(w, ag, ag.intent);
    }
    case 'pass': case 'shoot': case 'cross': case 'clear': {
      if (w.owner !== ag.id) return w.owner < 0 ? chaseCmd(w, ag) : null;
      return kickSetupCmd(w, ag);
    }
    case 'receive': return receiveCmd(w, ag);
    case 'tackle': return tackleCmd(w, ag);
    case 'keeper': return keeperOrderCmd(w, ag);
    case 'block': {
      const p = o.at;
      const d = Math.hypot(p.x - ag.x, p.y - ag.y);
      return { tx: p.x, ty: p.y, speed: ag.vmax, arrive: o.arrive ?? null, face: d < 1.5 ? toBall(w, ag) : null, stop: 0.05, precise: true };
    }
    default: return null;
  }
}

// Before a strike: the ball is set a stride in front, the body comes round to face the target,
// and he strikes it in stride (the run doesn't stop for a pass).
function kickSetupCmd(w, ag) {
  const b = w.ball, o = ag.order;
  const tgt = kickTarget(w, ag, o);
  const [kx, ky] = unit(tgt.x - b.x, tgt.y - b.y);
  o._k = [kx, ky];
  const kd = Math.atan2(ky, kx);
  const sp = speedOf(ag);
  const k = ag.kick;
  if (k?.phase === 'commit') {
    // meet the ball where it will be at the strike, planted beside it
    const tl = Math.max(0.04, k.strikeAt - w.t);
    const bx = b.x + b.vx * tl, by = b.y + b.vy * tl;
    const tx = bx - kx * 0.5, ty = by - ky * 0.5;
    const dx = tx - ag.x, dy = ty - ag.y, d = Math.hypot(dx, dy);
    const v = Math.min(ag.vmax, d / tl);
    return { vx: d > 1e-3 ? (dx / d) * v : 0, vy: d > 1e-3 ? (dy / d) * v : 0, face: kd, precise: true };
  }
  // set-up: arrive behind the ball on the line of the strike, keeping his pace
  const tau = 0.32;
  const bx = b.x + b.vx * tau, by = b.y + b.vy * tau;
  // the angle he can come round to in a stride or two
  const ad = ag.face + clamp(angDiff(ag.face, kd), -1.0, 1.0);
  const tx = bx - Math.cos(ad) * 0.55, ty = by - Math.sin(ad) * 0.55;
  const dx = tx - ag.x, dy = ty - ag.y, d = Math.hypot(dx, dy);
  const pace = o.pace ?? (o.type === 'shoot' ? 5.5 : o.kind === 'lofted' || o.type === 'cross' || o.type === 'clear' ? 5 : 5.5);
  let v = Math.min(ag.vmax, d / tau);
  const ahead = (b.x - ag.x) * Math.cos(ag.face) + (b.y - ag.y) * Math.sin(ag.face);
  if (ahead > 0.25) v = Math.max(v, Math.min(sp, pace));
  if (d < 1e-3) return { vx: 0, vy: 0, face: kd, precise: true };
  return { vx: (dx / d) * v, vy: (dy / d) * v, face: sp < 2 ? kd : null, precise: true };
}

function receiveCmd(w, ag) {
  const o = ag.order, b = w.ball;
  if (w.owner === ag.id) { ag.order = null; return null; }
  const path = w.path;
  let p = { x: b.x, y: b.y }, tau = 0;
  if (path) {
    p = path[path.length - 1];
    const r = interceptOf(ag, path, { reach: 0.55, zmax: o.first === 'head' ? 2.7 : 1.5, react: 0 });
    if (r) { p = r; tau = r.t; }
  }
  if (o.spot && w.flight && path) {
    // meet the ball on its real path: the point he can get to in time (at head height for a
    // header), as near the planned spot as possible
    const head = o.first === 'head';
    let bq = null, bs = 1e9;
    for (const q of path) {
      if (head ? q.z < 1.2 || q.z > 2.9 : q.z > 1.6) continue;
      const late = Math.max(0, timeTo(ag, q, 0.6, { react: 0 }) - q.t);
      const s = Math.hypot(q.x - o.spot.x, q.y - o.spot.y) * 0.3 + late * 12;
      if (s < bs) { bs = s; bq = q; }
    }
    if (bq) { p = bq; tau = Math.max(0.05, bq.t); }
    else { p = o.spot; tau = Math.max(0.1, w.flight.t0 + w.flight.T - w.t); }
  } else if (o.spot && w.flight) { p = o.spot; tau = Math.max(0.1, w.flight.t0 + w.flight.T - w.t); }
  else if (w.flight && w.flight.receiver === ag.id && w.flight.target && ['through', 'lofted', 'cross'].includes(w.flight.kind)) {
    // played into space / over the top: run onto it, don't come back for it
    const ft = w.flight.target, tl = Math.max(0.1, w.flight.t0 + w.flight.T - w.t);
    const db = Math.hypot(b.x - ag.x, b.y - ag.y);
    if (db > 3) { p = { x: ft.x, y: ft.y }; tau = tl; }
  }
  const d = Math.hypot(p.x - ag.x, p.y - ag.y);
  const need = tau > 0.05 ? d / tau : 8;
  // receive on the half-turn: body open between the ball and where he wants to go next
  let face = Math.atan2(b.y - ag.y, b.x - ag.x);
  if (o.next) { const nx = Math.atan2(o.next.y - ag.y, o.next.x - ag.x); face = face + clamp(angDiff(face, nx), -0.8, 0.8) * 0.6; }
  return { tx: p.x, ty: p.y, speed: clamp(need * 1.1, 1.2, ag.vmax), face, keepFace: need < 3.4, stop: 0.05, precise: true };
}

function tackleCmd(w, ag) {
  const o = ag.order, tg = w.agents[o.target];
  ag.duel = o.target;
  if (o.committed) return { free: true };
  const lead = o.style === 'slide' ? 0.45 : 0.25;
  const px = tg.x + tg.vx * lead, py = tg.y + tg.vy * lead;
  const d = Math.hypot(px - ag.x, py - ag.y);
  // a foul has to make contact: commit only when the slide/lunge will actually get there
  const closing = o.outcome === 'foul' ? (speedOf(tg) < speedOf(ag) + 1.5 || d < 1.6) : true;
  // (a foul that must stay outside the penalty area waits until he's outside it)
  const outside = !o.maxU || uOf(w, o.maxU.side, tg) + (tg.vx * w.M.dir[o.maxU.side]) * 0.4 < o.maxU.u;
  if (w.t >= (o.notBefore ?? 0) && d < (o.style === 'slide' ? 3.0 : 1.5) && closing && outside) {
    o.committed = true; o.ct = w.t;
    const [ux, uy] = unit(px - ag.x, py - ag.y);
    const v = o.style === 'slide' ? Math.max(5.2, speedOf(ag), speedOf(tg) + 1.8) : Math.max(2.8, speedOf(tg) + 1);
    ag.vx = ux * v; ag.vy = uy * v; ag.face = Math.atan2(uy, ux);
    if (o.style === 'slide') setAnim(w, ag.id, S.SLIDE, 1.5, true, 2.1);
    else setAnim(w, ag.id, S.LUNGE, 0.75, true, 3.5);
    emit(w, 'tackleCommit', { agent: ag.id, target: o.target });
    if (o.outcome === 'miss') tg.threat = { from: ag.id, at: w.t + 0.2, kind: o.style, scripted: true };
    return { free: true };
  }
  // closing down: hard, then a balanced last couple of steps
  return { tx: px, ty: py, speed: d > 4 ? ag.vmax : Math.max(speedOf(tg) + 1.2, 4), face: null, stop: 0, precise: true };
}

function keeperOrderCmd(w, ag) {
  const o = ag.order, b = w.ball;
  if (o.diving) return { free: true };
  if (o.phase === 'set' || o.phase === 'watch') {
    const h = shapeTarget(w.M, ag.side, ag.slot, b, other(ag.side));
    return { tx: o.phase === 'set' ? ag.x : h.x, ty: o.phase === 'set' ? ag.y : h.y, speed: 2.5, face: o.face ?? toBall(w, ag), keepFace: 'strict', stop: 0.1 };
  }
  if (o.phase === 'load') return { tx: o.to.x, ty: o.to.y, speed: 2.4, face: o.face, keepFace: 'strict', stop: 0, precise: true };
  if (o.phase === 'catch') return { tx: o.at.x, ty: o.at.y, speed: 4.5, face: o.face, keepFace: 'strict', stop: 0.05 };
  return keeperAI(w, ag);
}

// ------------------------------------------------------------------ bodies
function move(w, ag) {
  const c = ag.cmd || { stay: true };
  // airborne: a jump, a dive — ballistic, nobody steers in the air. z is the height of the hips
  // relative to standing; a diving keeper comes down onto his side (floor below standing height)
  // and gets back up once he's done.
  const floor = ag.zFloor || 0;
  if (ag.vz !== 0 || ag.z > floor) {
    ag.vz -= G * DT; ag.z += ag.vz * DT;
    if (ag.z <= floor) { ag.z = floor; ag.vz = 0; ag.landed = w.t; }
  }
  if (ag.z < 0 && ag.vz === 0 && !(ag.free && w.t < ag.stEnd)) { ag.z = Math.min(0, ag.z + 1.1 * DT); if (ag.z === 0) ag.zFloor = 0; }
  const air = airborne(ag);
  if (c.free || ag.free || air) {
    if (!air) { const k = Math.exp(-(ag.frict || 3) * DT); ag.vx *= k; ag.vy *= k; }
    ag.x += ag.vx * DT; ag.y += ag.vy * DT;
    ag.dvx = ag.vx; ag.dvy = ag.vy;
    if (!air) ag.ph += (Math.hypot(ag.vx, ag.vy) * DT) / cycleLen(Math.hypot(ag.vx, ag.vy)) * 0.3;
    return;
  }
  const sp = Math.hypot(ag.vx, ag.vy);
  // desired velocity
  let dvx = 0, dvy = 0, faceWant = c.face;
  if (c.vx != null) { dvx = c.vx; dvy = c.vy; const m = Math.hypot(dvx, dvy); if (m > ag.vmax) { dvx *= ag.vmax / m; dvy *= ag.vmax / m; } }
  else if (c.tx != null) {
    const dx = c.tx - ag.x, dy = c.ty - ag.y, d = Math.hypot(dx, dy);
    let s = Math.min(c.speed ?? 5, ag.vmax);
    if (c.arrive != null) s = Math.min(ag.vmax, Math.max((d / Math.max(c.arrive - w.t, 0.2)) * 1.12, 0));
    s = Math.min(s, Math.sqrt(2 * 4.2 * Math.max(0, d - (c.stop ?? 0.1))));
    if (d > 0.04) { dvx = (dx / d) * s; dvy = (dy / d) * s; }
  }
  // Intent reaches the legs with a short lag (decide → push off): no frame-perfect direction
  // changes, no twitching between two targets. Ball-playing moves stay precise.
  const lag = c.precise ? 0.05 : 0.16;
  const kq = 1 - Math.exp(-DT / lag);
  ag.dvx += (dvx - ag.dvx) * kq; ag.dvy += (dvy - ag.dvy) * kq;
  dvx = ag.dvx; dvy = ag.dvy;
  // personal space: steer around other bodies (anticipating where they're going)
  for (const o of w.agents) {
    if (o === ag || o.gone || o.id === ag.duel || ag.id === o.duel) continue;
    const rx = ag.x - o.x, ry = ag.y - o.y, d = Math.hypot(rx, ry);
    if (d > 2.2 || d < 1e-4) continue;
    const rvx = ag.vx - o.vx, rvy = ag.vy - o.vy, rv2 = rvx * rvx + rvy * rvy;
    const tc = rv2 > 0.01 ? clamp(-(rx * rvx + ry * rvy) / rv2, 0, 0.7) : 0;
    const cx = rx + rvx * tc, cy = ry + rvy * tc, cd = Math.hypot(cx, cy);
    // the man on the ball and his marker are allowed shoulder to shoulder
    const duel = (ag.id === w.owner || o.id === w.owner) && ag.side !== o.side;
    // a runner attacking the ball goes through the gap (his marker has to deal with him)
    const running = ag.order?.type === 'run' && ag.order.go;
    const near = running ? 0.5 : duel ? 0.55 : ag.id === w.owner ? 0.6 : o.id === w.owner ? 0.85 : 1.05;
    if (cd < near) {
      const k = ((near - cd) / near) * 2.4;
      const [ux, uy] = cd > 1e-3 ? [cx / cd, cy / cd] : unit(rx, ry);
      dvx += ux * k; dvy += uy * k;
    }
  }
  const ds = Math.hypot(dvx, dvy);
  // Facing: by default you face where you run; you can keep facing the play while moving only
  // slowly sideways (≤3.5 m/s) or backwards (≤3 m/s) — faster than that, the body turns to run.
  if (faceWant == null) faceWant = ds > 0.4 ? Math.atan2(dvy, dvx) : sp > 0.6 ? Math.atan2(ag.vy, ag.vx) : ag.face;
  if (ds > 0.4 && c.face != null) {
    const rel = Math.abs(angDiff(c.face, Math.atan2(dvy, dvx)));
    const lim = rel < 0.7 ? 99 : rel < 2.0 ? 3.5 : 3.0;
    if (ds > lim) { if (c.keepFace === 'strict') { dvx *= lim / ds; dvy *= lim / ds; } else if (!c.keepFace || ds > lim + 1) faceWant = Math.atan2(dvy, dvx); else { dvx *= lim / ds; dvy *= lim / ds; } }
  }
  // acceleration limits: tangential (fading towards top speed / braking) and lateral (turning circle)
  let ax = (dvx - ag.vx) / DT, ay = (dvy - ag.vy) / DT;
  if (sp > 0.5) {
    const ux = ag.vx / sp, uy = ag.vy / sp;
    let at = ax * ux + ay * uy, an = -ax * uy + ay * ux;
    const accMax = ag.acc * (1 - sp / (ag.vmax + 0.6)) + 0.5;
    at = clamp(at, -7.0, accMax);
    const latMax = Math.max(3.2, 8.5 - 0.6 * sp);
    an = clamp(an, -latMax, latMax);
    ax = at * ux - an * uy; ay = at * uy + an * ux;
  } else {
    const m = Math.hypot(ax, ay), lim = ag.acc + 0.5;
    if (m > lim) { ax *= lim / m; ay *= lim / m; }
  }
  ag.vx += ax * DT; ag.vy += ay * DT;
  // body rotation rate: quick on the spot (stepping round), slow at speed
  const nsp = Math.hypot(ag.vx, ag.vy);
  const om = 8.5 / (1 + 0.5 * nsp);
  ag.face += clamp(angDiff(ag.face, faceWant), -om * DT, om * DT);
  // can't run fast in a direction the body isn't facing: momentum bleeds off
  if (nsp > 0.3) {
    const rel = Math.abs(angDiff(ag.face, Math.atan2(ag.vy, ag.vx)));
    const lim = rel < 0.75 ? 99 : rel < 2.0 ? 3.6 : 3.1;
    if (nsp > lim) { const ns = Math.max(lim, nsp - 7 * DT); ag.vx *= ns / nsp; ag.vy *= ns / nsp; }
  }
  ag.x += ag.vx * DT; ag.y += ag.vy * DT;
  if (ag.id < 22) { ag.x = clamp(ag.x, -4, L + 4); ag.y = clamp(ag.y, -4, WD + 4); }
  const s2 = Math.hypot(ag.vx, ag.vy);
  ag.ph += (s2 * DT) / cycleLen(s2);
}
// Bodies never overlap. Team-mates ease apart; opponents in a duel collide — shoulder to shoulder,
// momentum shared along the line of contact, the stronger man moved less.
function contacts(w) {
  for (let i = 0; i <= REF; i++) {
    const a = w.agents[i]; if (a.gone) continue;
    for (let j = i + 1; j <= REF; j++) {
      const b = w.agents[j]; if (b.gone) continue;
      const duel = a.duel === j || b.duel === i;
      const minD = duel ? 0.45 : a.free || b.free ? 0.5 : 0.62;
      const dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy;
      if (d2 >= minD * minD || d2 < 1e-8) continue;
      const d = Math.sqrt(d2), ux = dx / d, uy = dy / d;
      const opp = a.side && b.side && a.side !== b.side;
      if (opp && !a.free && !b.free) {
        // inelastic bump along the contact normal (closing speeds averaged)
        const va = a.vx * ux + a.vy * uy, vb = b.vx * ux + b.vy * uy;
        if (va - vb < 0) {
          const ma = mass(w, a), mb = mass(w, b), vc = (ma * va + mb * vb) / (ma + mb);
          a.vx += (vc - va) * ux; a.vy += (vc - va) * uy; b.vx += (vc - vb) * ux; b.vy += (vc - vb) * uy;
        }
      }
      const firm = opp || i === w.owner || j === w.owner;
      const push = Math.min(firm ? 0.05 : 0.022, (minD - d) * (firm ? 0.5 : 0.3));
      const ma = mass(w, a), mb = mass(w, b), wa = (2 * mb) / (ma + mb), wb = 2 - wa;
      a.x += ux * push * wa; a.y += uy * push * wa; b.x -= ux * push * wb; b.y -= uy * push * wb;
    }
  }
}
function mass(w, ag) { const p = ag.id < 22 ? playerOf(w.M, ag.id) : null; return (p?.height ? p.height / 180 : 1) * (ag.id === w.owner ? 1.15 : 1); }

// Where each player is looking: the ball by default; the man on the ball looks up between touches
// (at the space he's going into, at the man he's about to pass to); everyone else checks over his
// shoulder every few seconds — runners in behind, his marker, the space he wants.
function gaze(w, ag) {
  const b = w.ball;
  let want = Math.atan2(b.y - ag.y, b.x - ag.x);
  if (ag.id === w.owner && ag.id < 22) {
    const lt = ag.lastTouchT ?? -9;
    const o = ag.order;
    let up = null;
    if (o && (o.type === 'pass' || o.type === 'cross') && w.agents[o.to]) { const r = w.agents[o.to]; up = Math.atan2(r.y - ag.y, r.x - ag.x); }
    else if (o?.type === 'shoot' && o.target) up = Math.atan2(o.target.y - ag.y, o.target.x - ag.x);
    else if (ag.intent?.to) up = Math.atan2(ag.intent.to.y - ag.y, ag.intent.to.x - ag.x);
    const nearTouch = w.t - lt < 0.18 || (ag.kick && ag.kick.phase === 'commit');
    if (up != null && !nearTouch && Math.hypot(b.x - ag.x, b.y - ag.y) > 0.5) want = up;
  } else if (ag.id < 22 && !ag.isGK && !w.dead) {
    if (ag.glance && w.t < ag.glance.until) want = ag.glance.dir;
    else if (w.t > ag.scanAt && w.flight?.receiver !== ag.id) {
      ag.scanAt = w.t + 2.2 + w.rnd() * 3;
      // over the shoulder, away from the ball
      const away = want + Math.PI + (w.rnd() - 0.5) * 1.6;
      ag.glance = { dir: away, until: w.t + 0.35 + w.rnd() * 0.2 };
    }
  }
  // the head turns quickly but within the neck's range (the controller clamps to the body)
  ag.look += clamp(angDiff(ag.look, want), -9 * DT, 9 * DT);
}

// ------------------------------------------------------------------ ball contacts
function ballActions(w) {
  const b = w.ball;
  if (w.dead) { Object.assign(b, { x: w.dead.x, y: w.dead.y, z: R, vx: 0, vy: 0, vz: 0 }); return; }
  if (w.held >= 0) {
    const k = w.agents[w.held];
    const hold = w.holdPos || { fwd: 0.35, z: 1.05 };
    b.x = k.x + Math.cos(k.face) * hold.fwd; b.y = k.y + Math.sin(k.face) * hold.fwd; b.z = Math.max(R, hold.z + k.z * (k.z > 0 ? 1 : 0.4)); b.vx = k.vx; b.vy = k.vy; b.vz = 0;
    return;
  }
  // committed strikes
  for (const ag of w.agents) if (ag.kick?.phase === 'commit' && w.t >= ag.kick.strikeAt - 1e-6) strike(w, ag);
  // carrier
  if (w.owner >= 0) {
    const ag = w.agents[w.owner];
    const d = Math.hypot(b.x - ag.x, b.y - ag.y);
    if (ag.free || d > 9 || (d > 3.5 && w.chaser[other(ag.side)] >= 0 && !ag.order && w.protect !== ag.side)) { w.owner = -1; emit(w, 'lost', { agent: ag.id }); }
    else if (ag.order && ['pass', 'shoot', 'cross', 'clear'].includes(ag.order.type)) kickSetup(w, ag);
    else carrierTouch(w, ag);
  }
  // first-time strikes (volleys, headers) and controls of a free ball
  for (const ag of w.agents) {
    if (ag.gone || ag.id >= 22) continue;
    const o = ag.order;
    if (o?.type === 'receive' && o.first && w.owner < 0) firstTime(w, ag);
  }
  if (!w.flightLock) control(w);
  challenges(w);
  tackles(w);
  keeperContact(w);
}

// The carrier's touches: when he catches the ball up, when it's off his line, or to take it away
// from a challenge — always with the foot that's free, in a direction that foot can play.
function carrierTouch(w, ag) {
  const b = w.ball;
  if (w.t < ag.touchCd || b.z > 0.55) return;
  const intent = ag.intent || (ag.intent = defaultIntent(w, ag));
  const th = ag.threat;
  if (th && w.t > th.at + 0.3) ag.threat = null;
  // he sees the challenge coming (after his reaction time) and plays it past the man
  const evade = th && w.t >= (th.seen ??= w.t + ag.react * (w.protect === ag.side ? 0.3 : 1)) && w.t <= th.at;
  const c = Math.cos(ag.face), s = Math.sin(ag.face);
  const fwd = (b.x - ag.x) * c + (b.y - ag.y) * s;
  const urgent = evade || fwd < 0.25;
  if (!evade && !needTouch(w, ag, intent)) return;
  const win = touchWindow(ag, b, urgent);
  if (!win) return;
  let plan;
  if (evade) {
    const tk = w.agents[th.from];
    const want = intentDir(ag, intent, b);
    plan = evadeTouch(w, ag, want, tk);
    ag.threat = null;
    if (plan) {
      ag.beatenAt = w.t; tk.recover = Math.max(tk.recover, w.t + 1.1);
      emit(w, 'beat', { agent: ag.id, by: th.from });
      ag.intent = { ...intent, pace: Math.min(ag.vmax, Math.max(speedOf(ag), 4) + 1.2), t: w.t };
    } else plan = planTouch(w, ag, intent);
  } else plan = planTouch(w, ag, intent);
  if (!plan) return;
  if (w.ctx.debug) w.log.push({ type: 'tdbg', t: w.t, agent: ag.id, kind: plan.kind, v: +plan.v.toFixed(2), dir: +(plan.dir * 57.3).toFixed(0), face: +(ag.face * 57.3).toFixed(0), want: +(intentDir(ag, intent, b) * 57.3).toFixed(0), margin: plan.margin != null ? +plan.margin.toFixed(2) : null, gap: plan.gap, pace: intent.pace, o: ag.order?.type });
  const [ux, uy] = [Math.cos(plan.dir), Math.sin(plan.dir)];
  applyTouch(b, ux * plan.v, uy * plan.v, plan.roll);
  ag.touchCd = w.t + (plan.kind === 'drag' ? 0.45 : plan.kind === 'check' ? 0.3 : 0.22);
  ag.lastTouchT = w.t;
  w.lastTouch = ag.id;
  w.marks.touches.push({ agent: ag.id, t: w.t, kind: plan.kind, foot: win.foot });
}

// The ball sits a stride in front while the striker sets himself; he strikes it in stride.
function kickSetup(w, ag) {
  const b = w.ball, o = ag.order;
  if (!ag.kick) ag.kick = { phase: 'setup', since: w.t };
  const kd = o._k || [Math.cos(ag.face), Math.sin(ag.face)];
  const kAng = Math.atan2(kd[1], kd[0]);
  if (ag.kick.phase === 'setup') {
    const sp = speedOf(ag);
    // where will the ball be relative to his foot when the boot comes through (wind-up 0.28 s)?
    const T = 0.28;
    const bx = b.x + b.vx * T, by = b.y + b.vy * T, px = ag.x + ag.vx * T, py = ag.y + ag.vy * T;
    const c = Math.cos(ag.face), s = Math.sin(ag.face);
    const fwd = (bx - px) * c + (by - py) * s, lat = -(bx - px) * s + (by - py) * c;
    const inWindow = fwd > 0.25 && fwd < 0.85 && Math.abs(lat) < 0.45 && b.z < 0.6;
    // a side-foot pass can go well across the body; a cross, a long ball, a shot need him square
    const tol = o.type === 'shoot' ? 0.45 : o.type === 'cross' ? 0.75 : o.kind === 'ground' || !o.kind ? (sp < 5 ? 1.25 : 0.95) : 0.7;
    const aligned = Math.abs(angDiff(ag.face, kAng)) < tol;
    const waited = w.t - ag.kick.since >= (o.minHold ?? 0.12) && w.t >= (o.notBefore ?? 0);
    const forced = w.t - Math.max(ag.kick.since, o.notBefore ?? 0) > 3.2 && Math.hypot(b.x - ag.x, b.y - ag.y) < 1.4;
    // a man right in front of the ball would block it: move it off his line first
    const blocker = o.type === 'pass' && (!o.kind || o.kind === 'ground' || o.kind === 'through') ? blockerOn(w, ag, b, kAng) : null;
    if ((aligned && inWindow && waited && !blocker) || forced) {
      ag.kick = { phase: 'commit', strikeAt: w.t + T, since: ag.kick.since };
      setAnim(w, ag.id, S.KICK, 0.62);
      emit(w, 'commit', { agent: ag.id, kind: o.type });
      return;
    }
    // set it up: a touch that keeps it in front and brings it round towards the strike
    if (w.t < ag.touchCd || b.z > 0.55) return;
    const rx = b.x - ag.x, ry = b.y - ag.y;
    const f0 = rx * c + ry * s;
    const catching = f0 < 0.55 && (sp - (b.vx * c + b.vy * s)) > -0.3;
    const stopped = Math.hypot(b.vx, b.vy) < 0.3;
    const offLine = !aligned && f0 < 0.9;
    if (!(catching || (stopped && !aligned) || (offLine && f0 < 0.7) || (blocker && f0 < 0.8))) return;
    const win = touchWindow(ag, b, f0 < 0.3);
    if (!win) return;
    const cone = coneOf(sp), off = angDiff(ag.face, kAng);
    let a, v, kind = 'set';
    if (Math.abs(off) > cone + 0.45 && sp > 2.2) {
      // too quick to come round: check it, slow down with it, then open up
      a = ag.face + clamp(off, -0.35, 0.35); v = Math.max(0.6, sp * 0.45); kind = 'check';
      if (w.ctx.debug) w.log.push({ type: 'kdbg', t: w.t, agent: ag.id, o: o.type, kind: o.kind, off: +(off * 57.3).toFixed(0), sp: +sp.toFixed(1) });
    } else if (blocker) {
      // shift it a yard to the side away from him to open the angle
      const side = Math.sign(angDiff(Math.atan2(blocker.y - b.y, blocker.x - b.x), kAng)) || 1;
      a = ag.face + clamp(angDiff(ag.face, kAng + side * 1.3), -cone - 0.3, cone + 0.3);
      v = speedForGap(Math.max(1.5, Math.min(sp, 3)), 0.9, 0.4, sp);
      kind = 'push';
    } else {
      a = ag.face + clamp(off, -cone, cone);
      const pace = Math.max(1.5, Math.min(sp, o.pace ?? 5.5));
      v = speedForGap(pace, waited && Math.abs(off) < tol ? 0.75 : 0.9, 0.5, sp);
    }
    // never set it up over the line
    for (let i = 0; i < 6; i++) {
      const pth = touchPathQuick(b.x, b.y, Math.cos(a) * v, Math.sin(a) * v, 1.4);
      if (!pth.some(q => q.x < 0.6 || q.x > L - 0.6 || q.y < 0.6 || q.y > WD - 0.6)) break;
      v *= 0.6;
    }
    applyTouch(b, Math.cos(a) * v, Math.sin(a) * v, 0.5);
    ag.touchCd = w.t + 0.24; ag.lastTouchT = w.t; w.lastTouch = ag.id;
    w.marks.touches.push({ agent: ag.id, t: w.t, kind, foot: win.foot });
  } else if (w.t >= ag.kick.strikeAt - 0.12) {
    // last frames of the swing: if he's slightly off, the planted foot adjusts (≤ 1 m/s)
    const fx = ag.x + kd[0] * 0.5, fy = ag.y + kd[1] * 0.5;
    const ex = fx - b.x, ey = fy - b.y, e = Math.hypot(ex, ey);
    if (e > 0.3 && e < 1.6) { const k = Math.min(1, (e - 0.3) / e) * 0.12; b.vx += ex * k * HZ * 0.25; b.vy += ey * k * HZ * 0.25; }
  }
}

// An opponent standing on the first couple of metres of the ball's path (he'd block it).
function blockerOn(w, ag, b, ang) {
  const ux = Math.cos(ang), uy = Math.sin(ang), def = other(ag.side);
  for (let i = 0; i < 11; i++) {
    const o = w.agents[baseOf(def) + i];
    if (o.gone || o.free) continue;
    const rx = o.x - b.x, ry = o.y - b.y, along = rx * ux + ry * uy;
    if (along < -0.2 || along > 2.6) continue;
    if (Math.abs(-rx * uy + ry * ux) < 0.55 + along * 0.15) return o;
  }
  return null;
}

// Where a kick should go (receiver lead for passes, the spot for crosses, goal point for shots).
function kickTarget(w, ag, o) {
  if (o.type === 'shoot' || o.type === 'clear') return o.target;
  if (o.target && !o.lead) return o.target;
  const r = w.agents[o.to];
  if (!r) return o.target || goalOf(w, ag.side);
  const b = w.ball;
  let px = r.x, py = r.y;
  for (let i = 0; i < 2; i++) {
    const d = Math.hypot(px - b.x, py - b.y);
    const T = o.kind === 'lofted' || o.kind === 'cross' ? d / 18 + 0.45 : d / 13 + 0.2;
    const k = o.lead ? 1 : 0.55;
    let lx = r.vx * T * k + (o.leadDir ? o.leadDir[0] * T * 1.5 : 0), ly = r.vy * T * k + (o.leadDir ? o.leadDir[1] * T * 1.5 : 0);
    const ll = Math.hypot(lx, ly), cap = o.lead ? 7 : 3.5;            // into his path, not miles ahead of him
    if (ll > cap) { lx *= cap / ll; ly *= cap / ll; }
    px = r.x + lx; py = r.y + ly;
  }
  return { x: clamp(px, 0.5, L - 0.5), y: clamp(py, 0.5, WD - 0.5), z: o.target?.z };
}

function strike(w, ag) {
  const b = w.ball, o = ag.order;
  ag.kick = null;
  if (!o) return;
  const from = { x: b.x, y: b.y, z: b.z };
  const tgt = kickTarget(w, ag, o);
  let v, T, kind = o.kind || (o.type === 'cross' ? 'cross' : o.type === 'shoot' ? 'shot' : 'ground');
  const d = Math.hypot(tgt.x - from.x, tgt.y - from.y);
  if (o.type === 'shoot') {
    T = o.T ?? clamp(d / (o.speed || 24), 0.25, 2.2);
    if (o.maxT) T = Math.min(T, o.maxT);
    v = solveFlight(from, { x: tgt.x, y: tgt.y, z: tgt.z ?? 0.3 }, T, o.spin || {});
    kind = 'shot';
  } else if (kind === 'ground' || kind === 'through') {
    const vArr = o.vArr ?? (kind === 'through' ? 6.5 : clamp(5.5 + d * 0.15, 6.5, 11));
    v = groundForArrival(from, tgt, vArr); T = v.T;
    if (!isFinite(T)) { v = solveGround(from, tgt, d / 10); T = v.T; }
  } else {
    // lofted / cross / clear: in the air, landing (or arriving at head height) on the spot
    T = o.T ?? (kind === 'cross' ? clamp(d / 19 + 0.55, 0.9, 1.9) : kind === 'clear' ? clamp(d / 20 + 0.9, 1.4, 3) : clamp(d / 19 + 0.5, 0.9, 2.6));
    v = solveFlight(from, { x: tgt.x, y: tgt.y, z: tgt.z ?? R }, T, o.spin || {});
  }
  Object.assign(b, { vx: v.vx, vy: v.vy, vz: v.vz, wx: v.wx || 0, wy: v.wy || 0, wz: v.wz || 0 });
  w.owner = -1; w.lastTouch = ag.id; ag.lastTouchT = w.t;
  w.flight = { kicker: ag.id, receiver: o.to ?? -1, kind, t0: w.t, T, target: tgt, from };
  if (o.type === 'pass' || o.type === 'cross') w.marks.passes.push({ from: ag.id, to: o.to ?? -1, t0: w.t, t1: w.t + T, target: { x: tgt.x, y: tgt.y }, loft: kind === 'ground' || kind === 'through' ? 0 : Math.max(1, (v.vz * v.vz) / 19.6) });
  emit(w, 'kick', { agent: ag.id, kind, ktype: o.type, to: o.to ?? -1, target: tgt, T, from, lineU: w.line[ag.side] });
  ag.order = null; ag.intent = null;
}

// One-touch finishes and headers: wind up so contact happens as the ball arrives (a header from a
// high ball is a jump timed to meet it at the top).
function firstTime(w, ag) {
  const o = ag.order, b = w.ball;
  const head = o.first === 'head';
  const lead = head ? 0.32 : 0.28;
  if (!ag.ft) {
    if (!w.path) return;
    for (const q of w.path) {
      const dd = Math.hypot(q.x - (ag.x + ag.vx * q.t * 0.9), q.y - (ag.y + ag.vy * q.t * 0.9));
      const zok = head ? q.z > 1.3 && q.z < 2.9 : q.z < 1.2;
      if (o.spot && Math.hypot(q.x - o.spot.x, q.y - o.spot.y) > 5) continue;   // not where the chance is
      if (dd < (head ? 1.35 : 1.4) && zok && q.t <= lead + 0.06 && q.t >= lead - 0.12) {
        ag.ft = { at: w.t + q.t };
        setAnim(w, ag.id, head ? S.HEAD : S.KICK, head ? 0.75 : 0.62);
        if (head && q.z > 1.95) jump(w, ag.id, clamp(G * q.t, 1.8, 3.6));   // apex as it arrives
        emit(w, 'commit', { agent: ag.id, kind: head ? 'head' : 'shoot' });
        break;
      }
    }
    return;
  }
  const dd = Math.hypot(b.x - ag.x, b.y - ag.y);
  const zok = head ? b.z > 1.1 && b.z < 3.0 + ag.z : b.z < 1.3;
  if ((dd < (head ? 1.25 : 1.3) && zok && w.t >= ag.ft.at - 0.08) || w.t > ag.ft.at + 0.12) {
    if (dd > 2.2) { ag.ft = null; return; }
    ag.order = { ...o.then, type: o.then?.type || 'shoot', t0: w.t };
    ag.ft = null;
    strike(w, ag);
  }
}

// Taking control of a loose / arriving ball (first touch): cushioned, and played into the
// direction he wants to go next — as far round as his body shape allows.
function control(w) {
  const b = w.ball;
  if (b.z > 1.9) return;
  const fl = w.flight;
  let best = null, bd = 1e9;
  for (const ag of w.agents) {
    if (ag.gone || ag.id >= 22 || ag.free || ag.tk || ag.id === w.owner) continue;
    if (fl && fl.kicker === ag.id && w.t - fl.t0 < 0.4) continue;
    // a pass struck right past him: he needs his reaction time to get a foot to it
    if (fl && w.agents[fl.kicker].side !== ag.side && w.t - fl.t0 < ag.react + 0.08) continue;
    if (ag.order?.first) continue;                          // striking it first time, not trapping it
    if (ag.kick) continue;
    const intended = ag.order?.type === 'receive';
    if (w.protect && ag.side !== w.protect && !intended) continue;   // scripted attack: they can't nick it
    const chasing = w.chaser[ag.side] === ag.id;
    const allowed = intended || (fl && fl.receiver === ag.id) || chasing
      || (w.owner < 0 && !fl && Math.hypot(b.vx, b.vy) < 6 && w.allowLoose !== false);
    if (!allowed) continue;
    // a dribbler's ball can only be taken off him if it's away from his feet
    if (w.owner >= 0) { const c = w.agents[w.owner]; if (Math.hypot(b.x - c.x, b.y - c.y) < 0.9) continue; }
    const d = Math.hypot(b.x - ag.x, b.y - ag.y);
    const reach = b.z > 1.0 ? 0.6 : intended ? 1.0 : 0.8;
    if (d < reach && d < bd) { bd = d; best = ag; }
  }
  if (!best) return;
  const ag = best;
  const o = ag.order;
  const chest = b.z > 1.0;
  const stolen = w.owner >= 0 && w.agents[w.owner].side !== ag.side;
  // first touch: cushion it into the direction he wants to go next (within his body's reach)
  let want = o?.next ? Math.atan2(o.next.y - ag.y, o.next.x - ag.x) : stolen ? Math.atan2(goalOf(w, ag.side).y - ag.y, goalOf(w, ag.side).x - ag.x) : ag.face;
  const sp = speedOf(ag), cone = coneOf(sp) + 0.35;
  want = ag.face + clamp(angDiff(ag.face, want), -cone, cone);
  const vin = Math.hypot(b.vx, b.vy);
  const [nx, ny] = [Math.cos(want), Math.sin(want)];
  const push = chest ? 0.7 : clamp(0.9 + sp * 0.2, 0.9, 2.2);
  const keep = chest ? 0.05 : 0.1;                          // what's left of the pace it arrived with
  const vx = ag.vx * 0.8 + nx * push + (vin > 0.1 ? (b.vx / vin) * vin * keep : 0);
  const vy = ag.vy * 0.8 + ny * push + (vin > 0.1 ? (b.vy / vin) * vin * keep : 0);
  if (chest) { b.vx = vx; b.vy = vy; b.vz = 0.3; b.wx = b.wy = b.wz = 0; setAnim(w, ag.id, S.CHEST, 0.6); }
  else { b.z = R; applyTouch(b, vx, vy, 0.3); }
  const c = Math.cos(ag.face), s = Math.sin(ag.face);
  const lat = -(b.x - ag.x) * s + (b.y - ag.y) * c;
  if (stolen) emit(w, 'won', { agent: ag.id, from: w.owner });
  w.owner = ag.id; w.lastTouch = ag.id; w.flight = null; w.possSide = ag.side;
  w.marks.touches.push({ agent: ag.id, t: w.t, kind: chest ? 'chest' : 'control', foot: lat > 0 ? 'L' : 'R' });
  if (o?.type === 'receive') ag.order = null;
  ag.intent = o?.next ? { to: o.next, pace: Math.max(3, Math.min(5, sp + 1)), t: w.t } : defaultIntent(w, ag);
  ag.touchCd = w.t + (sp > 3 ? 0.35 : 0.3); ag.lastTouchT = w.t;
  emit(w, 'control', { agent: ag.id, side: ag.side });
}

// Unscripted challenges: the tackling foot arrives; if the ball is there, he wins it.
function challenges(w) {
  const b = w.ball;
  for (const ag of w.agents) {
    const tk = ag.tk;
    if (!tk) continue;
    if (w.t < tk.at) continue;
    if (w.t > tk.at + 0.12) { ag.tk = null; ag.recover = w.t + (tk.kind === 'slide' ? 1.3 : 0.7); continue; }
    if (tk.done) continue;
    const reach = tk.kind === 'slide' ? 1.0 : 0.8, rad = tk.kind === 'slide' ? 0.7 : 0.5;
    const fx = ag.x + Math.cos(ag.face) * reach, fy = ag.y + Math.sin(ag.face) * reach;
    const near = Math.hypot(b.x - fx, b.y - fy) < rad && b.z < 0.5;
    const c = w.agents[tk.target];
    const carrierHas = w.owner === c.id && Math.hypot(b.x - c.x, b.y - c.y) < 0.55;
    if (near && !carrierHas && !(w.protect && w.protect !== ag.side)) {
      tk.done = true;
      // poked away / blocked: the ball goes where his foot sends it
      const [ux, uy] = [Math.cos(ag.face), Math.sin(ag.face)];
      const sp = 2.5 + w.rnd() * 3;
      const sd = (w.rnd() - 0.5) * 1.6;
      applyTouch(b, ux * sp - uy * sd + c.vx * 0.3, uy * sp + ux * sd + c.vy * 0.3, 0.1);
      if (w.owner === c.id) w.owner = -1;
      w.lastTouch = ag.id; w.flight = null;
      w.marks.touches.push({ agent: ag.id, t: w.t, kind: 'tackle', foot: ag.foot === 'left' ? 'L' : 'R' });
      emit(w, 'won', { agent: ag.id, from: c.id, tackle: tk.kind });
    }
  }
}

function tackles(w) {
  for (const ag of w.agents) {
    const o = ag.order;
    if (o?.type !== 'tackle' || !o.committed || o.resolved) continue;
    const tg = w.agents[o.target];
    const d = Math.hypot(tg.x - ag.x, tg.y - ag.y);
    const reach = o.style === 'slide' ? 1.1 : o.outcome === 'foul' ? 1.15 : 0.85;
    if (d < reach || (o.outcome === 'foul' && w.t - o.ct > 0.45 && d < 2.3)) {
      o.resolved = true;
      if (o.outcome === 'foul') {
        const [ux, uy] = unit(tg.vx || Math.cos(tg.face), tg.vy || Math.sin(tg.face));
        const s = Math.max(2.2, speedOf(tg) * 0.9);
        tg.vx = ux * s; tg.vy = uy * s; tg.order = null; tg.kick = null;
        setAnim(w, tg.id, S.FALL, o.fallFor ?? 3.4, true, 2.4);
        if (w.owner === tg.id) { w.owner = -1; const b = w.ball; applyTouch(b, tg.vx * 0.7 + (w.rnd() - 0.5) * 1.2, tg.vy * 0.7 + (w.rnd() - 0.5) * 1.2, 0.2); }
        emit(w, 'foul', { agent: ag.id, fouled: tg.id, at: { x: tg.x, y: tg.y } });
      } else if (o.outcome === 'win') {
        const b = w.ball, g = goalOf(w, ag.side);
        const [ux, uy] = unit(g.x - b.x, g.y - b.y);
        applyTouch(b, ux * 5 + (w.rnd() - 0.5) * 2, uy * 5 + (w.rnd() - 0.5) * 2, 0.2);
        if (w.owner === tg.id) w.owner = -1;
        emit(w, 'won', { agent: ag.id, from: tg.id });
      }
    }
  }
}

function keeperContact(w) {
  const b = w.ball;
  for (const ag of w.agents) {
    const o = ag.order;
    if (!ag.isGK || o?.type !== 'keeper' || !o.mode || o.mode === 'beaten' || o.mode === 'watch' || o.touched) continue;
    if (!w.flight || w.flight.kind !== 'shot') continue;
    // full stretch: fingertips find it as it reaches the line
    const gl = toWorld(w.M.dir[ag.side], 0, 34).x, toLine = Math.abs(b.x - gl);
    const reach = (o.diving ? 1.35 : 1.0) + (toLine < 2.5 ? (2.5 - toLine) * 0.45 : 0);
    // hands: diving keepers reach along the dive; standing keepers at the body
    const hx = ag.x + (o.handOff?.x || 0), hy = ag.y + (o.handOff?.y || 0);
    const d = Math.hypot(b.x - hx, b.y - hy);
    const hz = 0.9 + Math.max(0, ag.z) * 1.6 + (o.diving ? 0.4 : 0.6);
    if (d < reach && b.z < Math.max(2.6, hz) && w.t > w.flight.t0 + 0.1) {
      o.touched = true;
      if (o.mode === 'catch') {
        w.held = ag.id; w.flight = null; w.owner = -1;
        w.holdPos = o.diving ? { fwd: 0.2, z: 0.35 } : { fwd: 0.32, z: 1.0 };
        emit(w, 'save', { agent: ag.id, caught: true });
      } else {
        // parry / tip: palmed away from goal, wide
        const out = o.outDir || unit(-w.M.dir[ag.side] * 0.3, b.y < 34 ? -1 : 1);
        const sp = Math.hypot(b.vx, b.vy) * 0.35 + 3;
        b.vx = out[0] * sp; b.vy = out[1] * sp; b.vz = o.mode === 'tip' ? 4.5 : 1.8; b.wx = b.wy = b.wz = 0;
        w.flight = { kicker: ag.id, receiver: -1, kind: 'clear', t0: w.t, T: 1, target: null };
        emit(w, 'save', { agent: ag.id, caught: false });
      }
    }
  }
}

// ------------------------------------------------------------------ ball physics + out of play
function ballPhysics(w) {
  if (w.dead || w.held >= 0) return;
  const ev = {};
  const b = w.ball;
  stepBall(b, DT, ev);
  if (ev.goal != null) emit(w, 'goal', { x: ev.goal, at: { x: b.x, y: b.y, z: b.z } });
  if (ev.post) emit(w, 'post', {});
  if (!b.inNet && !w.outSeen && (b.y < -0.12 || b.y > WD + 0.12 || b.x < -0.12 || b.x > L + 0.12)) {
    w.outSeen = true;
    emit(w, 'out', { at: { x: clamp(b.x, 0, L), y: clamp(b.y, 0, WD) }, line: b.y < 0 || b.y > WD ? 'touch' : 'goal', last: w.lastTouch });
  }
  if (w.flight && w.t - w.flight.t0 > w.flight.T + 1.5) w.flight = null;
}

// ------------------------------------------------------------------ recording
function record(w) {
  const r = w.rec;
  for (const ag of w.agents) {
    if (ag.gone) { r.pos.push(-30, -30); r.hd.push(0); r.ph.push(0); r.st.push(0); r.stT.push(0); r.z.push(0); r.lk.push(0); continue; }
    r.pos.push(ag.x, ag.y); r.hd.push(ag.face); r.ph.push(ag.ph); r.z.push(ag.z); r.lk.push(ag.look);
    const on = w.t < ag.stEnd;
    r.st.push(on ? ag.st : 0); r.stT.push(on ? w.t - ag.st0 : 0);
  }
  const b = w.ball;
  r.ball.push(b.x, b.y, Math.max(0, b.z - R));
  r.poss.push(w.possSide === 'A' ? 0 : 1);
  if (w.ctx.debug) (r.own ||= []).push(w.dead ? -2 : w.owner);
  // offside lines (world x of each half's second-last defender), left half / right half
  r.offX.push(lineX(w, 'left'), lineX(w, 'right'));
  // camera: pans with the ball (a touch ahead of it), zooms in near the goals
  const want = clamp(w.camHold?.x ?? b.x + b.vx * 0.25, 21, 84);
  w.camX += (want - w.camX) * Math.min(1, DT * (w.camSpeed || 2.2));
  const fin = b.x < 22 || b.x > 83 ? 1.2 : 1;
  w.zoom += ((w.camZoom || fin) - w.zoom) * Math.min(1, DT * 1.1);
  r.cam.push(w.camX, w.zoom);
}

export function finish(w) {
  const N = w.k;
  const r = w.rec;
  const offX = new Float32Array(r.offX);   // per frame: [left-half line x, right-half line x]
  return {
    N, dur: (N - 1) * DT,
    pos: new Float32Array(r.pos), st: new Uint8Array(r.st), stT: new Float32Array(r.stT), hd: new Float32Array(r.hd), ph: new Float32Array(r.ph),
    z: new Float32Array(r.z), lk: new Float32Array(r.lk),
    ball: new Float32Array(r.ball), cam: new Float32Array(r.cam), poss: new Int8Array(r.poss), offX,
    marks: w.marks, own: r.own,
  };
}
