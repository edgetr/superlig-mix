// The match world: 22 players, a referee and two assistants, and a ball, simulated at 30 Hz.
//
// Bodies: acceleration that fades towards top speed, harder braking, a turning circle that widens
// with speed, and a body orientation coupled to the run — a player can backpedal or shuffle sideways
// only slowly, so to play a ball behind him he has to slow down, plant and turn first.
// Ball: real physics (./ball.js). The dribbler knocks the ball ahead and runs onto it; passes, crosses
// and shots are struck after a proper set-up and wind-up; receivers move to intercept its path;
// tackles, blocks and keeper saves are physical contacts.
// Football intelligence: everyone plays. The team on the ball offers passing angles in open lanes,
// keeps width and spacing, stays onside, makes darts and checks, and asks for the ball; the team
// without it presses the ball (jockeying when close), covers, marks goal-side, screens lanes and
// steps up as a back line; keepers guard the angle; officials follow play.
// Scripted football (who scores, who fouls, …) comes from the director as orders to individual
// players; everything else is decided here.
import { L, WD, POST_A, POST_B, HZ, DT, N_AGENTS, REF, AR_FAR, AR_NEAR, S, cycleLen, clamp, lerp, dist, angDiff, other, sideOf, baseOf, toWorld, toTeam } from './const.js';
import { shapeTarget, playerOf, ROLE_SPEED, DEFENDERS, FORWARDS } from './shape.js';
import { R, makeBall, stepBall, predict, solveFlight, groundForArrival, solveGround } from './ball.js';

const FREE = new Set([S.FALL, S.DIVE_L, S.DIVE_R, S.SLIDE, S.KNEESLIDE]);
const TAU = Math.PI * 2;
const unit = (x, y) => { const l = Math.hypot(x, y) || 1; return [x / l, y / l]; };

// ------------------------------------------------------------------ world
export function createWorld(M, ctx, rnd) {
  const w = {
    M, ctx, rnd, sent: ctx.sent || new Set(), t: 0, k: 0,
    agents: [], ball: makeBall(L / 2, WD / 2), owner: -1, held: -1, dead: null, possSide: 'A', lastTouch: -1,
    flight: null, path: null, log: [], marks: { captions: [], passes: [], whistles: [], touches: [] },
    presser: { A: -1, B: -1 }, cover: { A: -1, B: -1 }, line: { A: 52.5, B: 52.5 }, hist: [],
    camX: L / 2, zoom: 1, camZoom: null, camSpeed: null, camHold: null,
    rec: { pos: [], st: [], stT: [], hd: [], ph: [], ball: [], cam: [], poss: [], offX: [] },
  };
  for (let a = 0; a < N_AGENTS; a++) {
    const side = sideOf(a), p = a < 22 ? playerOf(M, a) : null;
    let vmax = a < 22 ? ROLE_SPEED[p.role] || 8 : a === REF ? 7.2 : 7.4;
    if (p) { if (p.age >= 32) vmax -= 0.5; else if (p.age >= 29) vmax -= 0.2; else if (p.age && p.age <= 23) vmax += 0.2; vmax += (rnd() - 0.5) * 0.4; }
    w.agents.push({
      id: a, side, slot: p ? p.slot : -1, role: p ? p.role : a === REF ? 'REF' : 'AR', isGK: p?.role === 'GK',
      foot: p?.foot === 'left' ? 'left' : 'right', vmax, acc: 4.3 + rnd() * 0.6,
      x: 0, y: 0, vx: 0, vy: 0, face: 0, ph: rnd(),
      st: 0, st0: 0, stEnd: 0, free: false, frict: 0,
      order: null, think: rnd() * 0.4, tgt: null, react: 0.14 + rnd() * 0.12, callCd: 1 + rnd() * 3, touchCd: 0,
      kick: null, duel: -1, gone: w.sent.has(a),
    });
  }
  return w;
}

export const emit = (w, type, data = {}) => { const e = { type, t: w.t, ...data }; w.log.push(e); return e; };
export function order(w, a, o) { const ag = w.agents[a]; ag.order = o ? { ...o, t0: w.t } : null; ag.kick = null; if (o?.type !== 'tackle') ag.duel = -1; return ag.order; }
export function setAnim(w, a, st, dur, free = false, frict = 0) {
  const ag = w.agents[a];
  if (ag.st === st && w.t < ag.stEnd && !free && st !== S.KICK && st !== S.HEAD) { ag.stEnd = Math.max(ag.stEnd, w.t + dur); return; }
  ag.st = st; ag.st0 = w.t; ag.stEnd = w.t + dur; ag.free = free; ag.frict = frict;
}
export const animOf = (w, a) => (w.t < w.agents[a].stEnd ? w.agents[a].st : 0);
export function place(w, a, p, face) {
  const ag = w.agents[a];
  ag.x = p.x; ag.y = p.y; ag.vx = 0; ag.vy = 0;
  if (face != null) ag.face = face; else ag.face = Math.atan2(w.ball.y - p.y, w.ball.x - p.x);
}
export function giveBall(w, a) {
  const ag = w.agents[a];
  w.owner = a; w.held = -1; w.dead = null; w.flight = null; w.lastTouch = a; w.possSide = ag.side;
  const b = w.ball; b.x = ag.x + Math.cos(ag.face) * 0.5; b.y = ag.y + Math.sin(ag.face) * 0.5; b.z = R; b.vx = ag.vx; b.vy = ag.vy; b.vz = 0; b.wx = b.wy = b.wz = 0; b.inNet = 0;
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

// ------------------------------------------------------------------ main step
export function tick(w) {
  context(w);
  for (const ag of w.agents) if (!ag.gone) ag.cmd = behave(w, ag);
  if (w.ctx.watch != null && w.k % 3 === 0) { const ag = w.agents[w.ctx.watch]; w.log.push({ type: 'dbg', t: w.t, agent: ag.id, o: ag.order?.type, at: ag.order?.at, cmd: ag.cmd && { tx: ag.cmd.tx, ty: ag.cmd.ty, sp: ag.cmd.speed, free: ag.cmd.free }, x: ag.x, y: ag.y }); }
  for (const ag of w.agents) if (!ag.gone) move(w, ag);
  separate(w);
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
  const moving = Math.hypot(b.vx, b.vy, b.vz) > 0.3 && w.owner < 0 && w.held < 0 && !w.dead;
  w.path = moving ? predict(b, 2.6, 0.1) : null;
  // Offside line each attacking side has to respect (attacker frame u).
  for (const side of ['A', 'B']) {
    const def = other(side), us = [];
    for (let i = 0; i < 11; i++) { const ag = w.agents[baseOf(def) + i]; if (!ag.gone) us.push(uOf(w, side, ag)); }
    us.sort((p, q) => q - p);
    w.line[side] = Math.max(52.5, us[1] ?? 52.5, uOf(w, side, b));
  }
  // Who presses the ball / covers, for the side without it.
  const def = other(w.possSide);
  const focus = pressFocus(w);
  if (!focus) { w.presser[def] = -1; w.cover[def] = -1; }
  else {
    let best = -1, bt = 1e9, second = -1, st = 1e9;
    for (let i = 1; i < 11; i++) {
      const ag = w.agents[baseOf(def) + i];
      if (ag.gone || ag.order || ag.free) continue;
      const d = Math.hypot(ag.x - focus.x, ag.y - focus.y);
      const zone = Math.hypot(...Object.values(homeOf(w, ag)).map((v, k) => v - (k ? focus.y : focus.x)));
      const tt = d / ag.vmax + ag.react + zone * 0.012 + (DEFENDERS.has(ag.role) && uOf(w, def, focus) > 40 ? 0.6 : 0);
      if (tt < bt) { second = best; st = bt; best = ag.id; bt = tt; } else if (tt < st) { second = ag.id; st = tt; }
    }
    // stickiness: keep the current presser unless someone is clearly better placed
    const cur = w.presser[def];
    if (cur >= 0 && cur !== best && !w.agents[cur].order && !w.agents[cur].gone) {
      const ag = w.agents[cur], tt = Math.hypot(ag.x - focus.x, ag.y - focus.y) / ag.vmax + ag.react;
      if (tt < bt + 0.45) { if (second === cur) second = best; best = cur; }
    }
    w.presser[def] = best; w.cover[def] = second;
  }
  w.presser[w.possSide] = -1; w.cover[w.possSide] = -1;
}
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
  if (w.flight && w.flight.target && w.flight.kind !== 'shot') return { x: w.flight.target.x, y: w.flight.target.y };
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
  if (ag.free && w.t < ag.stEnd) return { free: true };
  ag.free = false;
  if (ag.order) { const c = orderCmd(w, ag); if (c) return c; }
  if (ag.id === w.owner) return carrierDefault(w, ag);
  if (ag.id === w.held) return { stay: true, face: ag.face };
  if (ag.id >= 22) return official(w, ag);
  if (ag.isGK) return keeperAI(w, ag);
  if (w.dead && w.deadCalm) return calm(w, ag);
  if (ag.side === w.possSide) return attackerAI(w, ag);
  return defenderAI(w, ag);
}

const toBall = (w, ag) => Math.atan2(w.ball.y - ag.y, w.ball.x - ag.x);

// Stoppages: players drift into shape at walking pace.
function calm(w, ag) {
  const h = homeOf(w, ag, w.ball);
  return { tx: h.x, ty: h.y, speed: 2.2, face: toBall(w, ag), keepFace: true, stop: 0.6 };
}

// --- on the ball, waiting for the next decision: shield it, keep it moving gently
function carrierDefault(w, ag) {
  const g = goalOf(w, ag.side);
  let [dx, dy] = unit(g.x - ag.x, g.y - ag.y);
  // turn away from the nearest opponent
  const opp = nearestOpp(w, ag, 4);
  if (opp) { const [ox, oy] = unit(ag.x - opp.x, ag.y - opp.y); dx = dx * 0.4 + ox * 0.6; dy = dy * 0.4 + oy * 0.6; [dx, dy] = unit(dx, dy); }
  ag.drib = { dx, dy, push: 0.5 };
  const b = w.ball;
  return { tx: b.x - dx * 0.35 + b.vx * 0.2, ty: b.y - dy * 0.35 + b.vy * 0.2, speed: 1.6, face: Math.atan2(dy, dx), stop: 0.05 };
}
function nearestOpp(w, ag, within) {
  let best = null, bd = within;
  for (let i = 0; i < 11; i++) { const o = w.agents[baseOf(other(ag.side)) + i]; if (o.gone) continue; const d = Math.hypot(o.x - ag.x, o.y - ag.y); if (d < bd) { bd = d; best = o; } }
  return best;
}

// --- team in possession, off the ball: find space, offer an angle, stay onside, ask for it
function attackerAI(w, ag) {
  if (w.t >= ag.think || !ag.tgt) { ag.think = w.t + 0.35 + w.rnd() * 0.25; ag.tgt = supportSpot(w, ag); }
  const t = ag.tgt;
  const d = Math.hypot(t.x - ag.x, t.y - ag.y);
  const speed = t.run ? ag.vmax * 0.92 : d > 9 ? 5.6 : d > 4 ? 3.6 : d > 1.2 ? 2.2 : 1.2;
  // Asking for the ball: open, in range, the carrier has time.
  if (w.owner >= 0 && t.open > 2.2 && t.dc < 28 && t.dc > 7 && w.t > ag.callCd && !t.run) {
    ag.callCd = w.t + 4 + w.rnd() * 4;
    if (w.rnd() < 0.55) setAnim(w, ag.id, S.CALL, 0.8);
  }
  return { tx: t.x, ty: t.y, speed, face: toBall(w, ag), keepFace: !t.run, stop: 0.4 };
}
function supportSpot(w, ag) {
  const side = ag.side, dir = w.M.dir[side], def = other(side);
  const car = w.owner >= 0 ? w.agents[w.owner] : w.flight?.target ? { x: w.flight.target.x, y: w.flight.target.y } : w.ball;
  const home = homeOf(w, ag);
  const line = w.line[side], bu = uOf(w, side, car);
  const cands = [home];
  for (const r of [4, 8]) for (let k = 0; k < 8; k++) { const a = (k / 8) * TAU + (r === 8 ? 0.39 : 0); cands.push({ x: home.x + Math.cos(a) * r, y: home.y + Math.sin(a) * r }); }
  // a run: forwards dart across/along the line or come short
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
    // marked: an opponent tight on this spot
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

// --- team without the ball: press, cover, mark goal-side, screen lanes, hold the line
function defenderAI(w, ag) {
  const side = ag.side, att = other(side), goal = ownGoal(w, side);
  const focus = pressFocus(w);
  if (focus && w.presser[side] === ag.id) return press(w, ag, focus, goal);
  const sb = seenBall(w, ag);
  const home = shapeTarget(w.M, side, ag.slot, sb, att);
  if (focus && w.cover[side] === ag.id) {
    const [gx, gy] = unit(goal.x - focus.x, goal.y - focus.y);
    const tx = focus.x + gx * 7 + (home.x - focus.x) * 0.15, ty = focus.y + gy * 7 + (home.y - focus.y) * 0.25;
    const d = Math.hypot(tx - ag.x, ty - ag.y);
    return { tx, ty, speed: d > 6 ? 6.5 : 3.5, face: toBall(w, ag), keepFace: d < 6, stop: 0.5 };
  }
  // the attacker closest to my zone
  let mk = null, md = DEFENDERS.has(ag.role) ? 9 : 11;
  for (let i = 1; i < 11; i++) {
    const o = w.agents[baseOf(att) + i];
    if (o.gone || o.id === w.owner) continue;
    const d = Math.hypot(o.x - home.x, o.y - home.y);
    if (d < md) { md = d; mk = o; }
  }
  let tx = home.x, ty = home.y;
  if (mk) {
    const [gx, gy] = unit(goal.x - mk.x, goal.y - mk.y);
    if (DEFENDERS.has(ag.role)) {
      // back line: stay on the line unless he drops deeper; track him goal-side
      const lineU = uOf(w, side, home), mu = uOf(w, side, mk);
      const mx = mk.x + gx * 1.8, my = mk.y + gy * 1.8;
      const m = toTeam(w.M.dir[side], mx, my);
      const u = Math.min(lineU, Math.max(m.u, mu - 2.2)), v = lerp(toTeam(w.M.dir[side], home.x, home.y).v, m.v, 0.65);
      const p = toWorld(w.M.dir[side], u, v); tx = p.x; ty = p.y;
    } else {
      // midfield: screen the lane between the ball and his man, goal-side
      const bx = focus ? focus.x : sb.x, by = focus ? focus.y : sb.y;
      tx = lerp(mk.x + gx * 1.5, bx, 0.3); ty = lerp(mk.y + gy * 1.5, by, 0.3);
      tx = lerp(tx, home.x, 0.35); ty = lerp(ty, home.y, 0.35);
    }
  }
  const d = Math.hypot(tx - ag.x, ty - ag.y);
  const speed = d > 10 ? 6.2 : d > 4 ? 4.2 : d > 1.2 ? 2.4 : 1.2;
  return { tx, ty, speed, face: toBall(w, ag), keepFace: d < 7, stop: 0.4 };
}
function press(w, ag, focus, goal) {
  const [gx, gy] = unit(goal.x - focus.x, goal.y - focus.y);
  const d = Math.hypot(focus.x - ag.x, focus.y - ag.y);
  // he gives ground as the dribbler drives at him (the gap grows with the attacker's speed at goal)
  let gap = 0.3;
  if (focus.carrier) { const c = focus.carrier; const at = Math.max(0, c.vx * gx + c.vy * gy); gap = 1.7 + Math.min(at, 7) * 0.32; }
  const tx = focus.x + gx * gap, ty = focus.y + gy * gap;
  const face = Math.atan2(focus.y - ag.y, focus.x - ag.x);
  if (focus.carrier && d < 3.6) {
    // jockey: side-on, low, matching his movement, never diving in
    setAnim(w, ag.id, S.JOCKEY, 0.25);
    return { tx, ty, speed: 5.2, face: face + 0.35, keepFace: true, stop: 0.1 };
  }
  return { tx, ty, speed: d > 8 ? ag.vmax * 0.95 : 6.2, face, keepFace: false, stop: 0.1 };
}

// --- keeper: on the line between ball and goal centre; set when a shot is coming
function keeperAI(w, ag) {
  const sb = seenBall(w, ag);
  const h = shapeTarget(w.M, ag.side, ag.slot, sb, w.possSide);
  const d = Math.hypot(h.x - ag.x, h.y - ag.y);
  return { tx: h.x, ty: h.y, speed: d > 4 ? 5.5 : 3, face: toBall(w, ag), keepFace: true, stop: 0.15 };
}

// --- officials
function official(w, ag) {
  const b = w.ball;
  if (ag.id === REF) {
    const sx = b.x < L / 2 ? 1 : -1;
    const tx = clamp(b.x + sx * 12, 6, 99), ty = clamp(b.y + (b.y < 34 ? 14 : -14), 6, 62);
    const d = Math.hypot(tx - ag.x, ty - ag.y);
    return { tx, ty, speed: d > 8 ? 6.2 : 3.4, face: toBall(w, ag), keepFace: d < 8, stop: 1 };
  }
  // assistants: in line with the second-last defender (or the ball, if further)
  const far = ag.id === AR_FAR;
  const lx = lineX(w, far ? 'right' : 'left');
  const tx = far ? clamp(Math.max(lx, b.x), 52.5, 104.5) : clamp(Math.min(lx, b.x), 0.5, 52.5);
  return { tx, ty: far ? -1.4 : 69.4, speed: 6.5, face: far ? Math.PI / 2 : -Math.PI / 2, keepFace: true, stop: 0.2 };
}

// --- director orders
function orderCmd(w, ag) {
  const o = ag.order, b = w.ball;
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
      return { tx: t.x + gx * (o.gap ?? 1.2), ty: t.y + gy * (o.gap ?? 1.2), speed: ag.vmax * 0.92, face: toBall(w, ag), keepFace: true, stop: 0.1 };
    }
    case 'run': {
      // A timed run: hold an onside spot until `go`, then attack the target.
      if (!o.go) {
        const p = o.hold || o.to, d = Math.hypot(p.x - ag.x, p.y - ag.y);
        return { tx: p.x, ty: p.y, speed: d > 5 ? 6.2 : 3.2, face: toBall(w, ag), keepFace: d < 5, stop: 0.3 };
      }
      return { tx: o.to.x, ty: o.to.y, speed: o.speed ?? ag.vmax * 0.95, arrive: o.arrive ?? null, face: null, stop: 0.15 };
    }
    case 'dribble': {
      if (w.owner !== ag.id) return chaseBall(w, ag);
      return dribbleCmd(w, ag, o.to, o.speed ?? 5);
    }
    case 'pass': case 'shoot': case 'cross': case 'clear': {
      if (w.owner !== ag.id) return chaseBall(w, ag);
      return kickSetupCmd(w, ag);
    }
    case 'receive': return receiveCmd(w, ag);
    case 'tackle': return tackleCmd(w, ag);
    case 'keeper': return keeperOrderCmd(w, ag);
    case 'block': {
      const p = o.at;
      const d = Math.hypot(p.x - ag.x, p.y - ag.y);
      return { tx: p.x, ty: p.y, speed: ag.vmax, arrive: o.arrive ?? null, face: d < 1.5 ? toBall(w, ag) : null, stop: 0.05 };
    }
    default: return null;
  }
}
function chaseBall(w, ag) {
  const b = w.ball;
  return { tx: b.x + b.vx * 0.3, ty: b.y + b.vy * 0.3, speed: ag.vmax * 0.9, face: null, stop: 0.2 };
}

// Dribbling: knock it ahead, run onto it, steer away from defenders in front.
function dribbleCmd(w, ag, to, speed) {
  const b = w.ball;
  let [dx, dy] = unit(to.x - b.x, to.y - b.y);
  const def = other(ag.side);
  for (let i = 0; i < 11; i++) {
    const o = w.agents[baseOf(def) + i];
    if (o.gone) continue;
    const rx = o.x - b.x, ry = o.y - b.y, d = Math.hypot(rx, ry);
    if (d > 5.5 || d < 0.01) continue;
    const ahead = rx * dx + ry * dy;
    if (ahead < -0.5) continue;
    const lat = rx * -dy + ry * dx;                   // + = defender on my left of travel
    const push = ((5.5 - d) / 5.5) * (d < 2.5 ? 0.9 : 0.4) * (Math.abs(lat) < 0.6 && d > 1.8 ? 0.5 : 1);
    const nx = dx + (lat > 0 ? dy : -dy) * push, ny = dy + (lat > 0 ? -dx : dx) * push;
    [dx, dy] = unit(nx, ny);
  }
  // keep it on the pitch
  if (b.y < 3 && dy < 0) dy *= 0.2; if (b.y > WD - 3 && dy > 0) dy *= 0.2;
  [dx, dy] = unit(dx, dy);
  const dTo = Math.hypot(to.x - b.x, to.y - b.y);
  const space = nearestOpp(w, ag, 8) ? Math.max(0.6, Math.hypot(nearestOpp(w, ag, 8).x - ag.x, nearestOpp(w, ag, 8).y - ag.y) * 0.35) : 2.6;
  const sp = Math.min(speed, dTo < 3 ? 2 + dTo : speed);
  ag.drib = { dx, dy, push: clamp(space, 0.5, 2.6) * clamp(sp / 5, 0.3, 1), want: sp };
  // run with the ball: pace from where it sits relative to the stride (ahead → push on, at the feet → ease)
  const rx = b.x - ag.x, ry = b.y - ag.y;
  const ahead = rx * dx + ry * dy, lat = rx * -dy + ry * dx;
  if (Math.hypot(rx, ry) > 1.35) {
    // it's run away from him: get back on it
    const px = b.x + b.vx * 0.3 - ag.x, py = b.y + b.vy * 0.3 - ag.y, pl = Math.hypot(px, py) || 1;
    const v = Math.min(ag.vmax, Math.hypot(b.vx, b.vy) + 2.5);
    return { vx: (px / pl) * v, vy: (py / pl) * v, face: Math.atan2(py, px) };
  }
  let v = sp * clamp(0.75 + (ahead - 0.4) * 0.35, 0.6, 1.25);
  if (ahead < -0.3) v = Math.min(v, 1.5);
  const vx = dx * v + -dy * lat * 2.2, vy = dy * v + dx * lat * 2.2;
  return { vx, vy, face: Math.atan2(dy, dx) };
}

// Before a strike: get the body behind the ball, facing where it's going.
function kickSetupCmd(w, ag) {
  const b = w.ball, o = ag.order;
  const tgt = kickTarget(w, ag, o);
  const [kx, ky] = unit(tgt.x - b.x, tgt.y - b.y);
  o._k = [kx, ky];
  const px = b.x - kx * 0.55, py = b.y - ky * 0.55;
  const committed = ag.kick?.phase === 'commit';
  return { tx: px + b.vx * 0.15, ty: py + b.vy * 0.15, speed: committed ? Math.max(1.5, speedOf(ag)) : 3.2, face: Math.atan2(ky, kx), keepFace: false, stop: 0 };
}

function receiveCmd(w, ag) {
  const o = ag.order, b = w.ball;
  if (w.owner === ag.id) { ag.order = null; return null; }
  const path = w.path;
  let p = { x: b.x, y: b.y }, tau = 0;
  if (path) {
    p = path[path.length - 1];
    for (const q of path) {
      const reach = Math.max(0, q.t - 0.08) * ag.vmax * 0.85 + 0.55;
      if (Math.hypot(q.x - ag.x, q.y - ag.y) <= reach && q.z < (o.first === 'head' ? 2.8 : 1.6)) { p = q; tau = q.t; break; }
    }
  }
  if (o.spot && w.flight && path) {
    // meet the ball where its real path passes closest to the planned spot, when it gets there
    let bq = null, bd = 1e9;
    for (const q of path) { const d = Math.hypot(q.x - o.spot.x, q.y - o.spot.y); if (d < bd && q.z < (o.first === 'head' ? 3 : 1.6)) { bd = d; bq = q; } }
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
  return { tx: p.x, ty: p.y, speed: clamp(need * 1.1, 1.5, ag.vmax), face: Math.atan2(b.y - ag.y, b.x - ag.x), keepFace: need < 3.4, stop: 0.05 };
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
  if (w.t >= (o.notBefore ?? 0) && d < (o.style === 'slide' ? 3.0 : 1.5) && closing) {
    o.committed = true; o.ct = w.t;
    const [ux, uy] = unit(px - ag.x, py - ag.y);
    const v = o.style === 'slide' ? Math.max(5.2, speedOf(ag), speedOf(tg) + 1.8) : Math.max(2.8, speedOf(tg) + 1);
    ag.vx = ux * v; ag.vy = uy * v; ag.face = Math.atan2(uy, ux);
    if (o.style === 'slide') setAnim(w, ag.id, S.SLIDE, 1.5, true, 2.1);
    else setAnim(w, ag.id, S.LUNGE, 0.75, true, 3.5);
    emit(w, 'tackleCommit', { agent: ag.id, target: o.target });
    return { free: true };
  }
  return { tx: px, ty: py, speed: ag.vmax, face: null, stop: 0 };
}

function keeperOrderCmd(w, ag) {
  const o = ag.order, b = w.ball;
  if (o.diving) return { free: true };
  if (o.phase === 'set' || o.phase === 'watch') {
    const h = shapeTarget(w.M, ag.side, ag.slot, b, other(ag.side));
    return { tx: o.phase === 'set' ? ag.x : h.x, ty: o.phase === 'set' ? ag.y : h.y, speed: 2.5, face: o.face ?? toBall(w, ag), keepFace: true, stop: 0.1 };
  }
  if (o.phase === 'catch') return { tx: o.at.x, ty: o.at.y, speed: 4.5, face: o.face, keepFace: true, stop: 0.05 };
  return keeperAI(w, ag);
}

// ------------------------------------------------------------------ bodies
function move(w, ag) {
  const c = ag.cmd || { stay: true };
  if (c.free || ag.free) {
    const k = Math.exp(-(ag.frict || 3) * DT);
    ag.vx *= k; ag.vy *= k;
    ag.x += ag.vx * DT; ag.y += ag.vy * DT;
    ag.ph += (Math.hypot(ag.vx, ag.vy) * DT) / cycleLen(Math.hypot(ag.vx, ag.vy)) * 0.3;
    return;
  }
  const sp = Math.hypot(ag.vx, ag.vy);
  // desired velocity
  let dvx = 0, dvy = 0, faceWant = c.face;
  if (c.vx != null) { dvx = c.vx; dvy = c.vy; const m = Math.hypot(dvx, dvy); if (m > ag.vmax) { dvx *= ag.vmax / m; dvy *= ag.vmax / m; } }
  else if (c.tx != null) {
    const dx = c.tx - ag.x, dy = c.ty - ag.y, d = Math.hypot(dx, dy);
    let s = Math.min(c.speed ?? 5, ag.vmax);
    if (c.arrive != null) s = Math.min(ag.vmax, Math.max(d / Math.max(c.arrive - w.t, 0.2), 0));
    s = Math.min(s, Math.sqrt(2 * 4.2 * Math.max(0, d - (c.stop ?? 0.1))));
    if (d > 0.04) { dvx = (dx / d) * s; dvy = (dy / d) * s; }
  }
  // personal space: steer around other bodies (anticipating where they're going)
  for (const o of w.agents) {
    if (o === ag || o.gone || o.id === ag.duel || ag.id === o.duel) continue;
    const rx = ag.x - o.x, ry = ag.y - o.y, d = Math.hypot(rx, ry);
    if (d > 2.2 || d < 1e-4) continue;
    const rvx = ag.vx - o.vx, rvy = ag.vy - o.vy, rv2 = rvx * rvx + rvy * rvy;
    const tc = rv2 > 0.01 ? clamp(-(rx * rvx + ry * rvy) / rv2, 0, 0.7) : 0;
    const cx = rx + rvx * tc, cy = ry + rvy * tc, cd = Math.hypot(cx, cy);
    const near = ag.id === w.owner ? 0.6 : o.id === w.owner ? 0.85 : 1.05;
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
  // body rotation rate: quick on the spot, slow at speed
  const nsp = Math.hypot(ag.vx, ag.vy);
  const om = 10 / (1 + 0.45 * nsp);
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
// Bodies never overlap: gently eased apart (duels may get closer — shoulder to shoulder).
function separate(w) {
  for (let i = 0; i <= REF; i++) {
    const a = w.agents[i]; if (a.gone) continue;
    for (let j = i + 1; j <= REF; j++) {
      const b = w.agents[j]; if (b.gone) continue;
      const duel = a.duel === j || b.duel === i;
      const minD = duel ? 0.45 : a.free || b.free ? 0.5 : 0.64;
      const dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy;
      if (d2 >= minD * minD || d2 < 1e-8) continue;
      // shoulder-to-shoulder with the man on the ball is a firm contact; elsewhere a gentle ease apart
      const firm = i === w.owner || j === w.owner || a.order?.type === 'mark' || b.order?.type === 'mark';
      const d = Math.sqrt(d2), push = Math.min(firm ? 0.05 : 0.022, (minD - d) * (firm ? 0.5 : 0.3)), ux = dx / d, uy = dy / d;
      const wa = j === w.owner ? 1.6 : i === w.owner ? 0.4 : 1, wb = 2 - wa;
      a.x += ux * push * wa; a.y += uy * push * wa; b.x -= ux * push * wb; b.y -= uy * push * wb;
    }
  }
}

// ------------------------------------------------------------------ ball contacts
function ballActions(w) {
  const b = w.ball;
  if (w.dead) { Object.assign(b, { x: w.dead.x, y: w.dead.y, z: R, vx: 0, vy: 0, vz: 0 }); return; }
  if (w.held >= 0) {
    const k = w.agents[w.held];
    const hold = w.holdPos || { fwd: 0.35, z: 1.05 };
    b.x = k.x + Math.cos(k.face) * hold.fwd; b.y = k.y + Math.sin(k.face) * hold.fwd; b.z = hold.z; b.vx = k.vx; b.vy = k.vy; b.vz = 0;
    return;
  }
  // committed strikes
  for (const ag of w.agents) if (ag.kick?.phase === 'commit' && w.t >= ag.kick.strikeAt - 1e-6) strike(w, ag);
  // carrier
  if (w.owner >= 0) {
    const ag = w.agents[w.owner];
    const d = Math.hypot(b.x - ag.x, b.y - ag.y);
    if (ag.free || d > 2.6) { w.owner = -1; emit(w, 'lost', { agent: ag.id }); }
    else if (ag.order && ['pass', 'shoot', 'cross', 'clear'].includes(ag.order.type)) kickSetup(w, ag);
    else dribbleTouch(w, ag);
  }
  // first-time strikes (volleys, headers) and controls of a free ball
  if (w.owner < 0) {
    for (const ag of w.agents) {
      if (ag.gone || ag.id >= 22) continue;
      const o = ag.order;
      if (o?.type === 'receive' && o.first) firstTime(w, ag);
    }
    if (w.owner < 0 && !w.flightLock) control(w);
  }
  tackles(w);
  keeperContact(w);
}

function dribbleTouch(w, ag) {
  const b = w.ball, dr = ag.drib || { dx: Math.cos(ag.face), dy: Math.sin(ag.face), push: 0.5 };
  const rx = b.x - ag.x, ry = b.y - ag.y, dist2 = Math.hypot(rx, ry);
  if (dist2 > 1.5) return;   // still running onto it
  const ahead = rx * dr.dx + ry * dr.dy, side = Math.abs(rx * -dr.dy + ry * dr.dx);
  const bAlong = b.vx * dr.dx + b.vy * dr.dy, sp = speedOf(ag);
  const need = ahead < 0.4 || (bAlong < sp * 0.8 && ahead < 0.95) || side > 0.5;
  if (!need || w.t < ag.touchCd) return;
  // Only touch the ball where the feet can reach it (in front, within the stride)
  if (ahead < -0.25 && sp > 2) return;
  // knock it into the stride he wants (speeding up touch by touch), not just his current pace
  const want = dr.want ?? sp;
  // close control under pressure: small touches; in space: knock it on and run
  const opp = nearestOpp(w, ag, 6);
  const press = opp ? clamp((4.5 - Math.hypot(opp.x - ag.x, opp.y - ag.y)) / 3, 0, 1) : 0;
  const v = sp > 1.4 || want > 2 ? Math.min(want, sp + lerp(1.6, 0.4, press)) + dr.push * (1 - press * 0.8) : Math.max(0.45, sp + 0.35);
  b.vx = dr.dx * v; b.vy = dr.dy * v; b.vz = 0; b.z = R;
  b.wx = b.wy = b.wz = 0;
  ag.touchCd = w.t + (press > 0.4 ? 0.24 : sp > 4 ? 0.42 : sp > 1.5 ? 0.32 : 0.5);
  w.lastTouch = ag.id;
  w.marks.touches.push({ agent: ag.id, t: w.t, kind: 'dribble' });
}

// The ball sits a stride in front while the striker sets himself; then the wind-up.
function kickSetup(w, ag) {
  const b = w.ball, o = ag.order;
  if (!ag.kick) ag.kick = { phase: 'setup', since: w.t };
  const kd = o._k || [Math.cos(ag.face), Math.sin(ag.face)];
  if (ag.kick.phase === 'setup') {
    // keep the ball where the kicking foot will meet it (small set-up touches)
    const fx = ag.x + kd[0] * 0.55, fy = ag.y + kd[1] * 0.55;
    const ex = fx - b.x, ey = fy - b.y, e = Math.hypot(ex, ey);
    if (e > 0.12 && w.t >= ag.touchCd) {
      const k = Math.min(1, 3.2 / Math.max(e, 0.01));
      b.vx = ag.vx * 0.8 + ex * 2.6 * k; b.vy = ag.vy * 0.8 + ey * 2.6 * k;
      ag.touchCd = w.t + 0.28; w.marks.touches.push({ agent: ag.id, t: w.t, kind: 'set' });
    }
    const tol = o.type === 'shoot' ? 0.45 : o.type === 'cross' ? 0.75 : o.kind === 'ground' || !o.kind ? 0.95 : 0.7;
    const aligned = Math.abs(angDiff(ag.face, Math.atan2(kd[1], kd[0]))) < tol;
    const close = Math.hypot(b.x - ag.x, b.y - ag.y) < 1.0;
    const waited = w.t - ag.kick.since >= (o.minHold ?? 0.12) && w.t >= (o.notBefore ?? 0);
    const forced = w.t - ag.kick.since > 3.2;
    if ((aligned && close && waited) || forced) {
      ag.kick = { phase: 'commit', strikeAt: w.t + 0.28, since: ag.kick.since };
      setAnim(w, ag.id, S.KICK, 0.62);
      emit(w, 'commit', { agent: ag.id, kind: o.type });
    }
  } else {
    // wind-up: the ball rolls on with the player's stride into the strike zone
    const fx = ag.x + kd[0] * 0.5, fy = ag.y + kd[1] * 0.5;
    b.vx = ag.vx + (fx - b.x) * 3; b.vy = ag.vy + (fy - b.y) * 3;
  }
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
  w.owner = -1; w.lastTouch = ag.id;
  w.flight = { kicker: ag.id, receiver: o.to ?? -1, kind, t0: w.t, T, target: tgt, from };
  if (o.type === 'pass' || o.type === 'cross') w.marks.passes.push({ from: ag.id, to: o.to ?? -1, t0: w.t, t1: w.t + T, target: { x: tgt.x, y: tgt.y }, loft: kind === 'ground' || kind === 'through' ? 0 : Math.max(1, (v.vz * v.vz) / 19.6) });
  emit(w, 'kick', { agent: ag.id, kind, ktype: o.type, to: o.to ?? -1, target: tgt, T, from });
  ag.order = null;
}

// One-touch finishes and headers: wind up so contact happens as the ball arrives.
function firstTime(w, ag) {
  const o = ag.order, b = w.ball;
  const head = o.first === 'head';
  const lead = head ? 0.32 : 0.28;
  if (!ag.ft) {
    if (!w.path) return;
    // when will the ball be at my contact point?
    for (const q of w.path) {
      const dd = Math.hypot(q.x - (ag.x + ag.vx * q.t * 0.9), q.y - (ag.y + ag.vy * q.t * 0.9));
      const zok = head ? q.z > 1.3 && q.z < 2.9 : q.z < 1.2;
      if (dd < (head ? 1.2 : 1.4) && zok && q.t <= lead + 0.06 && q.t >= lead - 0.12) {
        ag.ft = { at: w.t + q.t };
        setAnim(w, ag.id, head ? S.HEAD : S.KICK, head ? 0.75 : 0.62);
        emit(w, 'commit', { agent: ag.id, kind: head ? 'head' : 'shoot' });
        break;
      }
    }
    return;
  }
  const dd = Math.hypot(b.x - ag.x, b.y - ag.y);
  const zok = head ? b.z > 1.1 && b.z < 3.0 : b.z < 1.3;
  if ((dd < (head ? 1.25 : 1.3) && zok && w.t >= ag.ft.at - 0.08) || w.t > ag.ft.at + 0.12) {
    if (dd > 2.2) { ag.ft = null; return; }
    ag.order = { ...o.then, type: o.then?.type || 'shoot', t0: w.t };
    ag.ft = null;
    strike(w, ag);
  }
}

// Taking control of a loose / arriving ball (first touch).
function control(w) {
  const b = w.ball;
  if (b.z > 1.9) return;
  const fl = w.flight;
  let best = null, bd = 1e9;
  for (const ag of w.agents) {
    if (ag.gone || ag.id >= 22 || ag.free) continue;
    if (fl && fl.kicker === ag.id && w.t - fl.t0 < 0.4) continue;
    if (ag.order?.first) continue;                          // striking it first time, not trapping it
    const intended = ag.order?.type === 'receive';
    if (w.protect && ag.side !== w.protect && !intended) continue;   // scripted attack: they can't nick it
    const allowed = intended || (fl && fl.receiver === ag.id) || (!fl && Math.hypot(b.vx, b.vy) < 6 && w.allowLoose !== false) || ag.order?.type === 'intercept';
    if (!allowed) continue;
    const d = Math.hypot(b.x - ag.x, b.y - ag.y);
    const reach = b.z > 1.0 ? 0.6 : intended ? 1.0 : 0.85;
    if (d < reach && d < bd) { bd = d; best = ag; }
  }
  if (!best) return;
  const ag = best;
  const o = ag.order;
  const chest = b.z > 1.0;
  // first touch: cushion it into the direction he wants to go next
  let [nx, ny] = o?.next ? unit(o.next.x - ag.x, o.next.y - ag.y) : [Math.cos(ag.face), Math.sin(ag.face)];
  const sp = speedOf(ag);
  b.vx = ag.vx * 0.85 + nx * (chest ? 0.6 : 1.1); b.vy = ag.vy * 0.85 + ny * (chest ? 0.6 : 1.1);
  b.vz = chest ? 0.3 : 0; if (!chest) b.z = R;
  b.wx = b.wy = b.wz = 0;
  if (chest) setAnim(w, ag.id, S.CHEST, 0.6);
  w.owner = ag.id; w.lastTouch = ag.id; w.flight = null; w.possSide = ag.side;
  w.marks.touches.push({ agent: ag.id, t: w.t, kind: chest ? 'chest' : 'control' });
  if (o?.type === 'receive') ag.order = null;
  ag.touchCd = w.t + (sp > 3 ? 0.35 : 0.3);
  emit(w, 'control', { agent: ag.id, side: ag.side });
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
        if (w.owner === tg.id) { w.owner = -1; const b = w.ball; b.vx = tg.vx * 0.7 + (w.rnd() - 0.5) * 1.2; b.vy = tg.vy * 0.7 + (w.rnd() - 0.5) * 1.2; }
        emit(w, 'foul', { agent: ag.id, fouled: tg.id, at: { x: tg.x, y: tg.y } });
      } else if (o.outcome === 'win') {
        const b = w.ball, g = goalOf(w, ag.side);
        const [ux, uy] = unit(g.x - b.x, g.y - b.y);
        b.vx = ux * 5 + (w.rnd() - 0.5) * 2; b.vy = uy * 5 + (w.rnd() - 0.5) * 2;
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
    if (d < reach && b.z < 2.6 && w.t > w.flight.t0 + 0.1) {
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
  const px = b.x, py = b.y;
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
    if (ag.gone) { r.pos.push(-30, -30); r.hd.push(0); r.ph.push(0); r.st.push(0); r.stT.push(0); continue; }
    r.pos.push(ag.x, ag.y); r.hd.push(ag.face); r.ph.push(ag.ph);
    const on = w.t < ag.stEnd;
    r.st.push(on ? ag.st : 0); r.stT.push(on ? w.t - ag.st0 : 0);
  }
  const b = w.ball;
  r.ball.push(b.x, b.y, Math.max(0, b.z - R));
  r.poss.push(w.possSide === 'A' ? 0 : 1);
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
    ball: new Float32Array(r.ball), cam: new Float32Array(r.cam), poss: new Int8Array(r.poss), offX,
    marks: w.marks,
  };
}
