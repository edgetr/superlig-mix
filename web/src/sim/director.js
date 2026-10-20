// Director: plays each scripted moment out as real football in the world simulation.
//
// GPT decides WHAT happens (Haaland scores from Fernández's through ball, Yüksek is booked for
// pulling back Chiesa …). The director turns that into objectives and individual orders —
// build-up possession towards the assister (passes only into open lanes, otherwise carry it or go
// over the top), timed runs, the delivery, the finish, the keeper's reaction, the restart — while
// every other player keeps playing on their own (./world.js). Scripts are generators: each
// `yield` is one 30 Hz tick, so they read like the sequence of play they describe.
import { L, WD, GOAL_H, POST_A, POST_B, DT, REF, AR_FAR, AR_NEAR, S, clamp, lerp, dist, angDiff, other, sideOf, baseOf, toWorld, toTeam, mulberry32 } from './const.js';
import { shapeTarget, defLineOf, findAgent, byRoles, pick, playerOf, roleOf, gkOf, DEFENDERS } from './shape.js';
import { R, predict, solveFlight } from './ball.js';
import { createWorld, tick, finish, emit, order, setAnim, place, giveBall, setDead, caption, whistle, goalOf, ownGoal, uOf, laneOpen, speedOf, jump } from './world.js';

const SHOT_SPEED = { power: 30, placed: 23, curl: 21, chip: 13, header: 15, tap_in: 17, long_range: 31, volley: 27, penalty: 25, free_kick: 23, finesse: 21 };
const unit = (x, y) => { const l = Math.hypot(x, y) || 1; return [x / l, y / l]; };

export function buildMoment(M, ev, ctx) {
  const rnd = mulberry32(ctx.seed);
  ctx.seedF = rnd();
  const w = createWorld(M, ctx, rnd);
  const info = { protagonists: [] };
  const kind = ctx.kind;
  const script =
    kind === 'kickoff' ? kickoffScript :
    kind === 'shot' ? shotScript :
    kind === 'foul' ? foulScript :
    kind === 'offside' ? offsideScript :
    kind === 'corner' ? cornerClearScript :
    kind === 'whistle' ? whistleScript :
    kind === 'injury' ? injuryScript :
    kind === 'walkout' ? walkoutScript :
    flowScript;
  const gen = script(w, ev, info);
  w.sideJobs = [];
  let r = gen.next();
  while (!r.done && w.t < 42) {
    tick(w);
    w.sideJobs = w.sideJobs.filter(j => !j.next().done);
    r = gen.next();
  }
  const clip = finish(w);
  if (info.climax == null) info.climax = clip.dur * 0.5;
  info.protagonists = (info.protagonists || []).filter(a => a != null);
  const out = { ...clip, info, kind };
  if (ctx.debug) { out.log = w.log; out.world = w; }
  return out;
}

// ------------------------------------------------------------------ script helpers
function* wait(w, secs) { const end = w.t + secs; while (w.t < end - 1e-6) yield; }
function* until(w, cond, secs) { const end = w.t + secs; let v; while (!(v = cond()) && w.t < end - 1e-6) yield; return v || cond(); }
const since = (w, t0, type, pred = () => true) => { for (let i = w.log.length - 1; i >= 0; i--) { const e = w.log[i]; if (e.t < t0 - 1e-9) break; if (e.type === type && pred(e)) return e; } return null; };
function* waitEvent(w, type, pred = () => true, secs = 6) { const t0 = w.t; let e = null; yield* until(w, () => (e = since(w, t0, type, pred)), secs); return e; }

// Clips start mid-play: run the world for a moment, then start the clock (and the recording).
function* preroll(w, secs) {
  yield* wait(w, secs);
  const dt = w.t;
  w.t = 0; w.k = 0; w.log = [];
  for (const k of Object.keys(w.rec)) w.rec[k] = [];
  w.marks = { captions: [], passes: [], whistles: [], touches: [] };
  // every clock the players carry moves with the new zero
  for (const ag of w.agents) {
    ag.think -= dt; ag.touchCd -= dt; ag.callCd = Math.max(0.8, ag.callCd - dt);
    ag.st0 -= dt; ag.stEnd -= dt; ag.recover -= dt; ag.scanAt -= dt;
    if (ag.lastTouchT != null) ag.lastTouchT -= dt;
    if (ag.beatenAt != null) ag.beatenAt -= dt;
    if (ag.glance) ag.glance.until -= dt;
    if (ag.tk) ag.tk.at -= dt;
    if (ag.threat) { ag.threat.at -= dt; if (ag.threat.seen != null) ag.threat.seen -= dt; }
    if (ag.intent?.t != null) ag.intent.t -= dt;
    if (ag.kick) { ag.kick.since -= dt; if (ag.kick.strikeAt != null) ag.kick.strikeAt -= dt; }
    if (ag.order) { ag.order.t0 -= dt; if (ag.order.notBefore != null) ag.order.notBefore -= dt; if (ag.order.ct != null) ag.order.ct -= dt; }
    if (ag.ft) ag.ft.at -= dt;
  }
  if (w.flight) w.flight.t0 -= dt;
}

// Everyone in shape around the ball; `carrier` on it.
function setupPlay(w, ballAt, side, carrier, overrides = {}) {
  const { M, rnd } = w;
  for (let a = 0; a < 22; a++) {
    if (w.agents[a].gone) continue;
    const s = sideOf(a);
    const p = overrides[a] || shapeTarget(M, s, a - baseOf(s), ballAt, side);
    place(w, a, overrides[a] ? p : { x: clamp(p.x + (rnd() - 0.5) * 2.5, 1, L - 1), y: clamp(p.y + (rnd() - 0.5) * 2.5, 1, WD - 1) });
  }
  place(w, REF, { x: clamp(ballAt.x - 10, 6, 99), y: clamp(ballAt.y + (ballAt.y < 34 ? 13 : -13), 6, 62) });
  place(w, AR_FAR, { x: clamp(ballAt.x, 52.5, 104), y: -1.4 }, Math.PI / 2);
  place(w, AR_NEAR, { x: clamp(ballAt.x, 1, 52.5), y: 69.4 }, -Math.PI / 2);
  w.possSide = side;
  if (carrier != null) {
    const g = goalOf(w, side);
    place(w, carrier, { x: ballAt.x - (g.x > ballAt.x ? 0.5 : -0.5), y: ballAt.y }, Math.atan2(g.y - ballAt.y, g.x - ballAt.x));
    giveBall(w, carrier);
  } else setDead(w, ballAt, side);
}

function evLoc(ev, fallbackU = 84, fallbackV = 34) {
  const x = Number(ev.x), y = Number(ev.y);
  return { u: Number.isFinite(x) ? clamp(x, 0, 100) * 1.05 : fallbackU, v: Number.isFinite(y) ? clamp(y, 0, 100) * 0.68 : fallbackV };
}
const inBox = (u, v) => u >= 88.5 && v >= 13.85 && v <= 54.15;
function nearestOf(w, side, pt, roles, exclude = []) {
  let best = null, bd = 1e9;
  for (let i = 0; i < 11; i++) {
    const ag = w.agents[baseOf(side) + i];
    if (ag.gone || exclude.includes(ag.id) || (roles && !roles.includes(ag.role))) continue;
    const d = Math.hypot(ag.x - pt.x, ag.y - pt.y);
    if (d < bd) { bd = d; best = ag.id; }
  }
  return best ?? pick(w.M, side, ['CB', 'CM'], w.sent);
}
function nearestOppDist(w, side, p) {
  let bd = 99;
  for (let i = 0; i < 11; i++) { const o = w.agents[baseOf(other(side)) + i]; if (!o.gone) bd = Math.min(bd, Math.hypot(o.x - p.x, o.y - p.y)); }
  return bd;
}
function goalPoint(w, side, target) {
  const dir = w.M.dir[side], rnd = w.rnd;
  const t = String(target || 'bottom_right');
  let v = 34, z = 0.3;
  const left = t.includes('left'), right = t.includes('right');
  if (left) v = POST_A + 0.5 + rnd() * 0.6; else if (right) v = POST_B - 0.5 - rnd() * 0.6; else v = 34 + (rnd() - 0.5) * 1.6;
  if (t.includes('top')) z = 1.8 + rnd() * 0.35; else if (t.includes('bottom')) z = 0.2 + rnd() * 0.25; else if (t === 'middle') z = 0.9 + rnd() * 0.5;
  if (t === 'high' || t === 'over') { z = 3.2 + rnd() * 1.4; v = 34 + (rnd() - 0.5) * 6; }
  if (t === 'wide_left') { v = POST_A - 0.9 - rnd() * 2.4; z = 0.3 + rnd() * 1.2; }
  if (t === 'wide_right') { v = POST_B + 0.9 + rnd() * 2.4; z = 0.3 + rnd() * 1.2; }
  const p = toWorld(dir, 105, v);
  return { x: p.x, y: p.y, z, v };
}
function woodworkPoint(w, side, target) {
  const dir = w.M.dir[side], rnd = w.rnd;
  if (String(target).includes('top') || target === 'crossbar' || rnd() < 0.3) { const p = toWorld(dir, 105, 34 + (rnd() - 0.5) * 4); return { x: p.x, y: p.y, z: GOAL_H + 0.05, v: 34, bar: true }; }
  const left = String(target).includes('left') || (!String(target).includes('right') && rnd() < 0.5);
  const v = left ? POST_A - 0.03 : POST_B + 0.03, p = toWorld(dir, 105, v);
  return { x: p.x, y: p.y, z: 0.6 + rnd() * 1.2, v };
}
// Point `ahead` metres from agent towards `obj`, kept on the pitch.
function towards(w, ag, obj, ahead = 8) {
  const [ux, uy] = unit(obj.x - ag.x, obj.y - ag.y);
  const d = Math.min(ahead, Math.hypot(obj.x - ag.x, obj.y - ag.y));
  return { x: clamp(ag.x + ux * d, 2, L - 2), y: clamp(ag.y + uy * d, 2, WD - 2) };
}

// ------------------------------------------------------------------ possession play
// The team keeps the ball and works it towards `objective` (world point), ending with `final`
// on the ball there. Passes go only into open lanes (or over the top); otherwise the carrier
// takes it on. Returns the carrier at the end.
function choosePass(w, ca, { objective, final, recent, wantFinal, forceFinal, avoid = [] }) {
  const side = ca.side, def = other(side);
  const lineU = w.line[side], bu = uOf(w, side, ca);
  const dObj = Math.hypot(ca.x - objective.x, ca.y - objective.y);
  let best = null, bs = -1e9;
  for (let i = 0; i < 11; i++) {
    const r = w.agents[baseOf(side) + i];
    if (r.gone || r === ca || r.free || (r.isGK && uOf(w, side, ca) > 30)) continue;
    if (avoid.includes(r.id) && r.id !== final) continue;
    const lead = { x: r.x + r.vx * 0.6, y: r.y + r.vy * 0.6 };
    const d = Math.hypot(lead.x - ca.x, lead.y - ca.y);
    const isFinal = r.id === final;
    if (d < 6 || d > (isFinal ? 48 : 38)) continue;
    const u = uOf(w, side, lead);
    if (u > lineU - 0.3 && u > bu) continue;                       // would be offside
    const marked = nearestOppDist(w, side, lead);
    const open = laneOpen(w, ca, lead, def, d > 20 ? 17 : 14, 1.8);
    let kind = 'ground';
    if (open < 0.9) {
      if (d >= 14 && marked > 2.4) kind = 'lofted';
      else if (!(forceFinal && isFinal)) continue;
      else kind = d > 12 ? 'lofted' : 'ground';
    }
    if (marked < 1.3 && !(forceFinal && isFinal)) continue;
    const prog = dObj - Math.hypot(lead.x - objective.x, lead.y - objective.y);
    if (prog < -6 && !isFinal && !(open > 3 && marked > 5)) continue;   // no aimless square/back balls
    let s = prog * 0.14 + clamp(open, 0, 4) * 0.3 + Math.min(marked, 6) * 0.12 - Math.abs(d - 16) * 0.025 - (kind === 'lofted' ? 1.0 : 0);
    if (recent.slice(-3).includes(r.id) && !(forceFinal && isFinal)) continue;   // no ping-pong
    if (isFinal) s += wantFinal ? 3.5 : 0.3;
    if (forceFinal && isFinal) s += 50;
    if (s > bs) { bs = s; best = { agent: r.id, kind, score: s }; }
  }
  return best;
}
function* possession(w, side, { objective, final = null, finalSpot = null, budget = 7, minPasses = 1, maxPasses = 5, avoid = [], tempo = 'medium', arriveR = 3.5, dribbleSpeed = 5.6, handoff = false }) {
  const t0 = w.t, recent = [];
  let passes = 0, stuck = 0;
  // the final man makes his run into the zone he'll get it in
  if (final != null && finalSpot && w.owner !== final) order(w, final, { type: 'goto', to: finalSpot, speed: 6.2, faceBall: true, keepFace: true });
  const carryBeat = () => (tempo === 'fast' ? 0.2 : tempo === 'slow' ? 0.65 : 0.38) + w.rnd() * 0.45;
  while (w.t - t0 < budget + 6) {
    let c = w.owner;
    if (c < 0) { const e = yield* waitEvent(w, 'control', () => true, 3); if (!e) return { carrier: w.owner }; c = e.agent; }
    const ca = w.agents[c];
    if (ca.side !== side) return { carrier: c, lost: true };
    const late = w.t - t0 > budget;
    if (c === final) {
      if (handoff) return { carrier: c };
      order(w, c, { type: 'dribble', to: objective, speed: dribbleSpeed });
      yield* until(w, () => w.owner !== c || Math.hypot(w.agents[c].x - objective.x, w.agents[c].y - objective.y) < arriveR, 7);
      return { carrier: w.owner };
    }
    // receive, take a touch forward, look up
    order(w, c, { type: 'dribble', to: towards(w, ca, objective, 10), speed: 4.6 });
    yield* wait(w, carryBeat());
    if (w.owner !== c) continue;
    const finalTarget = finalSpot || objective;
    let opt = choosePass(w, ca, { objective: final != null && passes >= minPasses - 1 ? finalTarget : objective, final, recent, avoid, wantFinal: passes >= minPasses || late, forceFinal: final != null && (passes >= maxPasses || late || stuck > 0.9) });
    if (!opt && final == null && stuck > 1.2) opt = choosePass(w, ca, { objective, final, recent: [], avoid, wantFinal: false, forceFinal: false });
    if (!opt) { stuck += 0.5; order(w, c, { type: 'dribble', to: towards(w, ca, objective, 8), speed: 4.2 }); yield* wait(w, 0.5); continue; }
    stuck = 0;
    order(w, c, { type: 'pass', to: opt.agent, kind: opt.kind, minHold: 0.08 });
    const k = yield* waitEvent(w, 'kick', e => e.agent === c, 3.6);
    if (!k) continue;
    passes++; recent.push(c);
    const r = w.agents[opt.agent];
    order(w, opt.agent, { type: 'receive', next: towards(w, r, opt.agent === final ? objective : objective, 6) });
    yield* waitEvent(w, 'control', () => true, k.T + 2.5);
  }
  return { carrier: w.owner };
}

// ------------------------------------------------------------------ keeper
// Reacts to the shot: set as it's struck, then a dive along the line (or a catch at the body)
// to where the ball crosses him. mode: 'beaten' | 'catch' | 'parry' | 'tip' | 'watch'.
function* keeperVsShot(w, gk, shooter, mode, outDir, penalty = false) {
  const ag = w.agents[gk];
  order(w, gk, { type: 'keeper', phase: 'watch', mode });
  const c = yield* waitEvent(w, 'commit', e => e.agent === shooter, 10);
  if (!c) return;
  order(w, gk, { type: 'keeper', phase: 'set', mode, face: Math.atan2(w.ball.y - ag.y, w.ball.x - ag.x) });
  setAnim(w, gk, S.SET, 0.7);
  const k = yield* waitEvent(w, 'kick', e => e.agent === shooter, 1.5);
  if (!k) return;
  // penalties: he goes as it's struck (and a beaten keeper may have guessed wrong); open play: reaction time
  const guessWrong = penalty && mode === 'beaten' && w.rnd() < 0.55;
  yield* wait(w, penalty ? 0.03 : mode === 'beaten' ? 0.24 : 0.13);
  const path = predict(w.ball, 2.2, 1 / 60);
  // where the ball passes the keeper's position (along the attack direction)
  const s = w.M.dir[ag.side];                              // keeper's team attacks +x if s > 0 → own goal at x = 0
  let p = null;
  for (const q of path) if ((q.x - ag.x) * s <= 0.15) { p = q; break; }
  if (!p) { order(w, gk, { type: 'keeper', phase: 'watch', mode: 'watch' }); return; }
  const face = Math.atan2(k.from.y - ag.y, k.from.x - ag.x);
  const dy = p.y - ag.y, T = Math.max(0.1, p.t);
  if (Math.abs(dy) < 0.6 && p.z < 1.9 && mode !== 'tip') {
    order(w, gk, { type: 'keeper', phase: 'catch', mode: mode === 'beaten' ? 'beaten' : mode, at: { x: ag.x, y: p.y }, face });
    setAnim(w, gk, mode === 'beaten' ? S.SET : S.CATCH, 1.2);
    return;
  }
  // dive: a power step towards the ball's side, then a launch off that foot — ballistic from
  // there (nobody steers in the air): sideways along the line, up as high as the ball is, the body
  // still square to the shooter; he lands on his side and slides to a stop.
  let sgn = Math.sign(dy) || 1;
  if (guessWrong) sgn = -sgn;
  const high = p.z > 1.5;
  const load = penalty ? 0.06 : mode === 'beaten' ? 0.14 : 0.1;
  order(w, gk, { type: 'keeper', phase: 'load', mode, to: { x: ag.x, y: ag.y + sgn * 0.35 }, face });
  setAnim(w, gk, S.SET, load + 0.05);
  yield* wait(w, load);
  const T2 = Math.max(0.12, T - load);
  // hands at full stretch reach ~1 m beyond the body's centre along the dive
  const need = Math.max(0, Math.abs(p.y - ag.y) - 1.0);
  let vl = guessWrong ? 3.6 : clamp(need / T2, 1.6, 5.4);
  if (mode === 'beaten' && !guessWrong) vl = clamp(vl * 0.8, 1.6, 4.6);
  const vz = high ? clamp(2.2 + (p.z - 1.5) * 1.1, 2.2, 3.6) : clamp(1.1 + p.z * 0.7, 1.1, 2.2);
  ag.vx = Math.cos(face) * 0.45; ag.vy = sgn * vl;
  ag.face = face;
  jump(w, gk, vz, -0.62);
  order(w, gk, { type: 'keeper', phase: 'dive', mode, diving: true, handOff: { x: 0, y: sgn * 1.0 }, outDir });
  setAnim(w, gk, sgn < 0 ? S.DIVE_L : S.DIVE_R, mode === 'beaten' ? 7 : 1.9, true, 7);
}

// ------------------------------------------------------------------ shots
function* shotScript(w, ev, info) {
  const { M, ctx } = w;
  const side = ev.side === 'B' ? 'B' : 'A', opp = other(side), dir = M.dir[side];
  const gk = gkOf(M, opp);
  const technique = ev.technique || (ev.body === 'head' ? 'header' : 'placed');
  const isPen = technique === 'penalty' || ev.assist_type === 'penalty';
  const isFK = !isPen && (technique === 'free_kick' || ev.assist_type === 'free_kick');
  const isCorner = ev.assist_type === 'corner';
  let shooter = findAgent(M, side, ev.player) ?? pick(M, side, ['ST', 'LW', 'RW', 'CAM'], w.sent);
  if (w.sent.has(shooter)) shooter = pick(M, side, ['ST', 'LW', 'RW', 'CAM', 'CM'], w.sent);
  let assister = findAgent(M, side, ev.assist);
  if (assister === shooter || (assister != null && w.sent.has(assister))) assister = null;
  let { u: su, v: sv } = evLoc(ev, 90, 34);
  if (!isPen && !isFK) su = clamp(su, 62, 103);
  const head = ev.body === 'head' || technique === 'header';
  const outcome = ev.outcome || 'off_target';
  let target = ev.target || (outcome === 'off_target' ? (w.rnd() < 0.5 ? (w.rnd() < 0.5 ? 'wide_left' : 'wide_right') : 'high') : w.rnd() < 0.5 ? 'bottom_left' : 'bottom_right');
  if (outcome === 'off_target' && !/wide|high|over/.test(target)) target = w.rnd() < 0.5 ? (target.includes('left') ? 'wide_left' : 'wide_right') : 'high';
  const goalPt = outcome === 'woodwork' ? woodworkPoint(w, side, target) : goalPoint(w, side, target);
  const speed = SHOT_SPEED[technique] || (head ? 15 : 24);
  const shot = { target: { x: goalPt.x, y: goalPt.y, z: goalPt.z }, speed, spin: spinFor(w, side, technique, goalPt) };
  const gkMode = outcome === 'goal' || outcome === 'disallowed' ? 'beaten' : outcome === 'saved' ? 'catch' : outcome === 'parried' ? 'parry' : outcome === 'tipped' ? 'tip' : 'beaten';
  const outDir = unit(dir * 0.18, goalPt.y < 34 ? -1 : 1);
  info.outcome = outcome; info.shooter = shooter; info.gk = gk;
  w.allowLoose = true;
  w.protect = side;

  // --- the build-up / set piece, ending with the shooter about to strike
  let first = null;   // first-time finish order (volley / header) instead of a set shot
  if (isPen) yield* penaltySetup(w, side, shooter);
  else if (isFK) yield* freeKickSetup(w, side, shooter, ctx.setup, { u: su, v: sv });
  else if (isCorner) first = yield* cornerSetup(w, side, shooter, assister, head, sv);
  else first = yield* openPlay(w, ev, side, shooter, assister, { u: su, v: sv }, head, outcome);
  if (isFK) shot.T = fkFlightTime(w, goalPt, shot);

  // --- the shot
  let blocker = null;
  const keeperGen = keeperVsShot(w, gk, shooter, outcome === 'blocked' || outcome === 'off_target' ? 'watch' : gkMode, outDir, isPen);
  if (first) {
    order(w, shooter, { type: 'receive', first: first.head ? 'head' : 'shoot', spot: first.spot, then: { type: 'shoot', ...shot, speed: first.head ? 17 : Math.min(speed, 27), maxT: first.head ? 0.9 : null } });
  } else {
    if (w.owner !== shooter) { const e = yield* waitEvent(w, 'control', e => e.agent === shooter, 3); if (!e) { /* fallback */ } }
    order(w, shooter, { type: 'shoot', ...shot, minHold: isPen || isFK ? 0.05 : 0.1 });
  }
  const pickBlocker = () => {
    if (outcome !== 'blocked' || blocker != null) return;
    const sa = w.agents[shooter], [gx, gy] = unit(goalPt.x - sa.x, goalPt.y - sa.y);
    // the nearest defender goal-side of him
    const lane = { x: sa.x + gx * 2.4, y: sa.y + gy * 2.4 };
    // whoever can physically get across in time (momentum counts: stop, turn, go)
    let best = null, bt = 1e9;
    for (let i = 1; i < 11; i++) {
      const o = w.agents[baseOf(opp) + i]; if (o.gone) continue;
      const dx = lane.x - o.x, dy = lane.y - o.y, d = Math.hypot(dx, dy) || 1;
      const along = (o.vx * dx + o.vy * dy) / d, perp = Math.abs(o.vx * dy - o.vy * dx) / d;
      let tt = d / (o.vmax * 0.8) + (Math.max(0, -along) + perp * 0.8) / 5 + 0.3;
      if (uOf(w, side, o) < uOf(w, side, sa) - 0.5) tt += 1.2;      // chasing from behind: he won't get across
      if (tt < bt) { bt = tt; best = o.id; }
    }
    blocker = best;
    emit(w, 'blocker', { agent: blocker, tt: bt });
    order(w, blocker, { type: 'block', at: lane });
    const so = w.agents[shooter].order;
    if (so && so.type === 'shoot') { so.notBefore = Math.max(so.notBefore ?? 0, w.t + clamp(bt - 0.25, 0.15, 1.8)); so.pace = 2.6; }
  };
  if (w.owner === shooter || first) pickBlocker();
  // run the keeper alongside, until the strike
  let kick = null;
  const t0 = w.t;
  let fellBack = false, aimedAtBlock = false;
  while (!kick && w.t - t0 < 8) {
    keeperGen.next();
    if (w.owner === shooter || first) pickBlocker();
    // the first-time chance didn't come off: he takes a touch and shoots instead
    if (first && !fellBack && !since(w, t0, 'commit', e => e.agent === shooter)) {
      const sa = w.agents[shooter], b = w.ball;
      const away = Math.hypot(b.x - sa.x, b.y - sa.y) > 2.2 && (b.vx * (b.x - sa.x) + b.vy * (b.y - sa.y)) > 0;
      if ((w.t - t0 > 0.6 && (away || Math.hypot(b.vx, b.vy) < 2)) || w.t - t0 > 3) { fellBack = true; order(w, shooter, { type: 'receive', next: goalPt }); }
    }
    if (fellBack && w.owner === shooter && w.agents[shooter].order?.type !== 'shoot') order(w, shooter, { type: 'shoot', ...shot, minHold: 0.15 });
    if (blocker != null && !w.agents[blocker].free) {
      const sa = w.agents[shooter], [gx, gy] = unit(goalPt.x - sa.x, goalPt.y - sa.y);
      const bo = w.agents[blocker].order; if (bo?.type === 'block') bo.at = { x: sa.x + gx * 2.4, y: sa.y + gy * 2.4 };
      // he shapes to shoot until the defender has got across (a shot needs a man to block it)
      const so = sa.order, bk = w.agents[blocker];
      if (so?.type === 'shoot' && !sa.kick?.strikeAt && w.t - t0 < 3.5 && Math.hypot(bk.x - (sa.x + gx * 2.4), bk.y - (sa.y + gy * 2.4)) > 1.3) so.notBefore = Math.max(so.notBefore ?? 0, w.t + 0.1);
    }
    kick = since(w, t0, 'kick', e => e.agent === shooter);
    const cm = since(w, t0, 'commit', e => e.agent === shooter);
    if (cm && blocker != null && !w.agents[blocker].free) { const bk = w.agents[blocker], sa = w.agents[shooter]; if (Math.hypot(bk.x - sa.x, bk.y - sa.y) < 4.5) setAnim(w, blocker, S.SLIDE, 1.4, false, 0); }
    // scripted block: the shot goes through the line he's covering (still goalwards)
    if (cm && blocker != null && !aimedAtBlock) {
      aimedAtBlock = true;
      const so = w.agents[shooter].order, bk = w.agents[blocker], b = w.ball;
      if (so?.type === 'shoot') {
        const dx = bk.x + bk.vx * 0.3 - b.x, dy = bk.y + bk.vy * 0.3 - b.y;
        if (Math.abs(dx) > 0.5 && Math.sign(dx) === Math.sign(goalPt.x - b.x)) {
          const k = (goalPt.x - b.x) / dx;
          so.target = { x: goalPt.x, y: clamp(b.y + dy * k, POST_A - 3, POST_B + 3), z: 0.45 };
        }
      }
    }
    if (!kick) yield;
  }
  if (!kick) { info.climax = w.t; yield* wait(w, 1); return; }
  releaseAll(w);
  w.protect = null;
  const shotT = kick.t;
  info.climax = shotT;
  info.protagonists = [shooter, assister, gk];
  w.marks.shot = { t: shotT, from: { ...kick.from }, to: { ...shot.target }, agent: shooter, dur: kick.T };
  caption(w, outcome === 'disallowed' ? `${playerOf(M, shooter).name} puts it in the net!` : ev.text, outcome === 'goal' || outcome === 'disallowed' ? 'goal' : 'shot');
  if (blocker != null) {
    const bk = w.agents[blocker];
    // throws himself across the line of the shot
    const fx = kick.from.x, fy = kick.from.y, [sx, sy] = unit(goalPt.x - fx, goalPt.y - fy);
    const along = clamp((bk.x - fx) * sx + (bk.y - fy) * sy, 1.2, 5);
    const lx = fx + sx * along, ly = fy + sy * along;
    const [ux, uy] = unit(lx - bk.x, ly - bk.y), dl = Math.hypot(lx - bk.x, ly - bk.y);
    bk.vx = ux * clamp(dl * 4, 2, 6); bk.vy = uy * clamp(dl * 4, 2, 6); bk.face = Math.atan2(uy, ux);
    setAnim(w, blocker, S.SLIDE, 1.4, true, 2.4);
  }
  // --- in flight: keeper reacts, ball meets keeper / post / blocker / net
  let res = null;
  const t1 = w.t;
  while (w.t - t1 < 3.2) {
    keeperGen.next();
    if (blocker != null && !res) {
      const b = w.ball, bk = w.agents[blocker];
      if (Math.hypot(b.x - bk.x, b.y - bk.y) < (w.t - shotT < 0.45 ? 2.1 : 1.5) && b.z < 1.6) {
        const out = toWorld(dir, 106.5, sv < 34 ? POST_A - 7 : POST_B + 7);
        const [ux, uy] = unit(out.x - b.x, out.y - b.y);
        const sp = Math.hypot(b.vx, b.vy) * 0.4;
        Object.assign(b, { vx: ux * sp, vy: uy * sp, vz: 2.5, wz: 0 });
        w.flight = { kicker: blocker, receiver: -1, kind: 'clear', t0: w.t, T: 1, target: null };
        res = emit(w, 'block', { agent: blocker });
      }
    }
    const g = since(w, t1, 'goal'), sv2 = since(w, t1, 'save'), p = since(w, t1, 'post'), o = since(w, t1, 'out');
    if (g && !res) { res = g; w.marks.goalT = g.t; w.marks.netAt = { x: g.x, y: g.at.y, z: g.at.z }; }
    if (sv2 && !res) { res = sv2; w.marks.saveT = sv2.t; }
    if (p && !w.marks.postT) w.marks.postT = p.t;
    if (o && !g) { res = res || o; break; }
    if (res && (res.type === 'goal' || res.type === 'save')) break;
    if (p && w.t - p.t > 0.6) break;
    if (res?.type === 'block' && w.t - res.t > 0.6) break;
    yield;
  }
  for (let i = 0; i < 6; i++) { keeperGen.next(); yield; }
  // --- aftermath
  if (outcome === 'goal' || outcome === 'disallowed') {
    if (!w.marks.goalT) { w.marks.goalT = shotT + kick.T; w.marks.netAt = { x: goalPt.x, y: goalPt.y, z: goalPt.z }; }
    if (outcome === 'disallowed') yield* disallowTail(w, side, shooter, ev);
    else yield* celebrate(w, side, shooter);
  } else if (outcome === 'saved') {
    yield* afterCatch(w, gk);
  } else if (outcome === 'woodwork') {
    caption(w, 'Off the woodwork!', 'post');
    yield* clearance(w, opp, 2.6);
  } else if (outcome === 'parried' || outcome === 'tipped' || outcome === 'blocked') {
    yield* restartCorner(w, side);
  } else {
    setAnim(w, shooter, S.APPEAL, 1.8);
    yield* restartGoalKick(w, opp);
  }
}
// A direct free kick has to get up and over the wall (2.3 m at 9.15 m) and dip under the bar.
function fkFlightTime(w, gp, shot) {
  const spot = w.ctx.setup?.spot || w.ball;
  const from = { x: w.ball.x, y: w.ball.y, z: R };
  const d = Math.hypot(gp.x - from.x, gp.y - from.y);
  let T = d / shot.speed;
  for (let i = 0; i < 12; i++) {
    const v = solveFlight(from, { x: gp.x, y: gp.y, z: gp.z }, T, shot.spin);
    const tw = 9.15 / Math.max(1, Math.hypot(v.vx, v.vy));
    const zw = R + v.vz * tw - 4.9 * tw * tw;
    if (zw > 2.35) break;
    T += 0.06;
  }
  return T;
}
// Curl for finesse/curl/free kicks; slight topspin dip on power shots.
function spinFor(w, side, technique, gp) {
  const dir = w.M.dir[side];
  if (technique === 'curl' || technique === 'finesse' || technique === 'free_kick') {
    const k = (gp.v < 34 ? 1 : -1) * dir * (technique === 'free_kick' ? 55 : 40);
    return { wx: 0, wy: 0, wz: k };
  }
  return { wx: 0, wy: 0, wz: 0 };
}

// Where a runner can be `secs` from now heading for `to` (he won't get further than that).
export function runDistance(ag, dirx, diry, secs) {
  // accelerating from his current speed along the run (same model as the bodies in world.js)
  let v = Math.max(0, ag.vx * dirx + ag.vy * diry), d = 0;
  const dt = 1 / 30;
  for (let t = 0; t < secs; t += dt) { v = Math.min(ag.vmax, v + (ag.acc * (1 - v / (ag.vmax + 0.6)) + 0.5) * dt); d += v * dt; }
  return d;
}
function reachable(ag, to, secs) {
  const d = Math.hypot(to.x - ag.x, to.y - ag.y);
  const [ux, uy] = unit(to.x - ag.x, to.y - ag.y);
  const maxD = runDistance(ag, ux, uy, Math.max(0, secs - 0.2)) * 0.88;
  if (d <= maxD) return { x: to.x, y: to.y };
  const k = maxD / d;
  return { x: ag.x + (to.x - ag.x) * k, y: ag.y + (to.y - ag.y) * k };
}

// Open play: build-up, delivery, the finisher arriving. Returns a first-time order or null.
function* openPlay(w, ev, side, shooter, assister, SL, head, outcome) {
  const { M, rnd } = w;
  const dir = M.dir[side], opp = other(side), team = M.teams[side];
  const tempo = team.style.tempo;
  let type = ev.assist_type || (assister == null ? 'solo' : 'short_pass');
  if (type === 'rebound' && assister == null) type = 'solo';
  if (head && !['cross', 'corner', 'free_kick', 'set_piece'].includes(type)) type = 'cross';
  const build = ev.build_up || (team.style.build === 'direct' ? 'long_ball' : team.style.build === 'short' ? 'possession' : 'counter');
  const offsideGoal = outcome === 'disallowed' && (ev.reason || 'offside') === 'offside';
  const W = (u, v) => toWorld(dir, u, v);
  const solo = type === 'solo';
  // delivery spot A and the zone the final man receives in, R (team coords)
  let A, R;
  if (type === 'cross') {
    // from the wing the crosser plays on
    let left = SL.v > 34;
    if (assister != null) { const r = roleOf(M, assister); if (/^L/.test(r)) left = true; else if (/^R/.test(r)) left = false; else { const v0 = playerOf(M, assister).v0; left = v0 < 34; } }
    // (an offside goal comes from an early cross — from the byline nobody can be offside)
    A = offsideGoal ? { u: clamp(SL.u - 20, 66, 78), v: left ? 6 + rnd() * 4 : 58 + rnd() * 4 } : { u: clamp(SL.u - 2 + rnd() * 6, 86, 99), v: left ? 4 + rnd() * 3 : 61 + rnd() * 3 };
    R = { u: A.u - 11, v: A.v + (A.v > 34 ? -2 : 2) };
  }
  else if (type === 'cutback') { A = { u: 101, v: SL.v < 34 ? 19 + rnd() * 3 : 46 + rnd() * 3 }; R = { u: 91, v: SL.v < 34 ? 13 : 55 }; }
  else if (type === 'through_ball') { A = { u: clamp(SL.u - 24, 55, 76), v: clamp(34 + (SL.v - 34) * 0.4 + (rnd() - 0.5) * 10, 14, 54) }; R = A; }
  else if (type === 'long_ball') { A = { u: 30 + rnd() * 8, v: 34 + (rnd() - 0.5) * 18 }; R = A; }
  else if (solo) { A = { u: clamp(SL.u - 16, 50, 86), v: clamp(SL.v + (rnd() - 0.5) * 12, 10, 58) }; R = { u: A.u - 8, v: A.v }; }
  else { A = { u: clamp(SL.u - 12 - rnd() * 4, 58, 92), v: clamp(SL.v + (SL.v < 34 ? 10 : -10), 8, 60) }; R = A; }
  if (assister == null && !solo) {
    const roles = type === 'cross' ? (A.v > 34 ? ['RW', 'RB', 'RM', 'RWB', 'CM'] : ['LW', 'LB', 'LM', 'LWB', 'CM']) : type === 'long_ball' ? ['CB', 'CDM'] : ['CAM', 'CM', 'LW', 'RW', 'CDM'];
    assister = pick(M, side, roles, w.sent, [shooter]);
  }
  const final = solo ? shooter : assister;
  const Aw = W(A.u, A.v), Rw = W(R.u, R.v), SLw = W(SL.u, SL.v);
  // --- start of the move (the final man not on it, unless it's his long ball)
  const startU = build === 'counter' ? 36 + rnd() * 10 : build === 'long_ball' ? 20 + rnd() * 8 : 30 + rnd() * 10;
  const startW = W(Math.min(startU, R.u - 12), 34 + (rnd() - 0.5) * 22);
  const starter = type === 'long_ball' ? assister : pick(M, side, build === 'counter' ? ['CDM', 'CM', 'CB'] : ['CB', 'CDM', 'CM'], w.sent, [shooter, assister]);
  const pre = {};
  if (final !== starter) { const f0 = shapeTarget(M, side, playerOf(M, final).slot, startW, side); pre[final] = { x: lerp(f0.x, Rw.x, 0.55), y: lerp(f0.y, Rw.y, 0.55) }; }
  if (build === 'counter') {
    yield* turnoverStart(w, side, starter, startW, pre);
    caption(w, 'Ball won — they break!', 'counter');
  } else {
    setupPlay(w, startW, side, starter, pre);
    yield* preroll(w, 1.1);
  }
  const n = build === 'counter' ? 1 : build === 'long_ball' ? 0 : 1 + Math.floor(rnd() * 2);
  // the finisher keeps his position for now (he'll time his run)
  if (!solo) order(w, shooter, { type: 'goto', to: W(Math.min(SL.u - 12, w.line[side] - 1.5), SL.v), speed: 4.5, faceBall: true, keepFace: true });
  yield* possession(w, side, { objective: Aw, final, finalSpot: Rw, budget: 2 + n * 1.8, minPasses: n, maxPasses: n + 1, avoid: solo ? [] : [shooter], tempo, handoff: true });
  // make sure the final man has it
  if (w.owner !== final && w.owner >= 0 && w.agents[w.owner].side === side) {
    const c = w.owner, f = w.agents[final];
    order(w, c, { type: 'pass', to: final, kind: Math.hypot(f.x - w.agents[c].x, f.y - w.agents[c].y) > 16 ? 'lofted' : 'ground' });
    const k = yield* waitEvent(w, 'kick', e => e.agent === c, 3.5);
    if (k) { order(w, final, { type: 'receive', next: Aw }); yield* waitEvent(w, 'control', e => e.agent === final, k.T + 2.5); }
  }
  const shooterA = w.agents[shooter], ass = w.agents[final];
  // carry it to the delivery spot (a crosser held up delivers from where he is, if it's wide and high enough)
  if ((type === 'cross' || type === 'cutback' || solo) && Math.hypot(ass.x - Aw.x, ass.y - Aw.y) > 4) {
    order(w, final, { type: 'dribble', to: Aw, speed: 6.6 });
    yield* until(w, () => w.owner !== final || Math.hypot(ass.x - Aw.x, ass.y - Aw.y) < 3.5
      || ((type === 'cross') && uOf(w, side, ass) > 76 && Math.abs(toTeam(dir, ass.x, ass.y).v - 34) > 20 && w.t > 2.2 + (w._dribbleStart ??= w.t)), 4);
  }

  if (solo) {
    // drive at goal; a defender comes across and is beaten
    const def = nearestOf(w, opp, { x: lerp(shooterA.x, SLw.x, 0.5), y: lerp(shooterA.y, SLw.y, 0.5) }, ['CB', 'CDM', 'LB', 'RB']);
    order(w, shooter, { type: 'dribble', to: SLw, speed: 6.6 });
    order(w, def, { type: 'tackle', target: shooter, style: rnd() < 0.5 ? 'slide' : 'lunge', outcome: 'miss', notBefore: w.t + 0.5 });
    const cm = yield* waitEvent(w, 'tackleCommit', e => e.agent === def, 3.5);
    if (cm) {
      // he knocks it past the challenge
      const sa = w.agents[shooter], [gx, gy] = unit(SLw.x - sa.x, SLw.y - sa.y);
      const lat = rnd() < 0.5 ? 1 : -1;
      const cut = { x: clamp(sa.x + gx * 4 - gy * 2.6 * lat, 2, L - 2), y: clamp(sa.y + gy * 4 + gx * 2.6 * lat, 2, WD - 2) };
      order(w, shooter, { type: 'dribble', to: cut, speed: 7 });
      yield* wait(w, 0.6);
      order(w, shooter, { type: 'dribble', to: SLw, speed: 6.4 });
    }
    yield* until(w, () => Math.hypot(w.agents[shooter].x - SLw.x, w.agents[shooter].y - SLw.y) < 2.5 || w.owner !== shooter, 3);
    return null;
  }

  // --- the delivery
  const lineU = () => w.line[side];
  if (type === 'cross' || type === 'cutback') {
    // the box fills: finisher and a second runner attack spaces; defenders pick them up
    const spot0 = type === 'cross' ? W(clamp(SL.u, 92, 101), SL.v) : W(clamp(SL.u, 86, 95), SL.v);
    // (a goal that will be ruled out for offside: he's already a yard beyond the line when it's crossed)
    const hold = W(offsideGoal ? Math.min(lineU() + 1.6, 99) : Math.min(clamp(SL.u - 8, 80, 90), lineU() - 1), clamp(SL.v + (A.v > 34 ? -3 : 3), 18, 50));
    order(w, shooter, { type: 'run', hold, to: spot0, go: false });
    const second = offsideGoal ? null : byRoles(M, side, ['ST', 'LW', 'RW', 'CAM', 'CM'], w.sent, [shooter, final])[0];
    if (second != null) order(w, second, { type: 'run', hold: W(86, A.v > 34 ? 30 : 38), to: W(type === 'cross' ? 97 : 91, A.v > 34 ? 28 : 40), go: false });
    // runners start as he shapes to cross
    order(w, shooter, { type: 'goto', to: { x: lerp(hold.x, spot0.x, 0.35), y: lerp(hold.y, spot0.y, 0.35) }, speed: 4.2, faceBall: true, keepFace: false });
    const m1 = nearestOf(w, opp, spot0, ['CB', 'LB', 'RB']);
    order(w, m1, { type: 'mark', target: shooter, gap: 1.4 });
    if (second != null) { const m2 = nearestOf(w, opp, W(95, 34), ['CB', 'LB', 'RB', 'CDM'], [m1]); order(w, m2, { type: 'mark', target: second, gap: 1.1 }); }
    const T = type === 'cross' ? clamp(Math.hypot(spot0.x - ass.x, spot0.y - ass.y) / 19 + 0.55, 0.9, 1.6) : null;
    // the delivery waits until the runner can get there (he holds it up, takes a touch, looks up)
    const flight0 = type === 'cross' ? T : Math.hypot(spot0.x - ass.x, spot0.y - ass.y) / 15 + 0.1;
    const [rx0, ry0] = unit(spot0.x - shooterA.x, spot0.y - shooterA.y);
    const need = Math.hypot(spot0.x - shooterA.x, spot0.y - shooterA.y);
    let tRun = 0; for (let d = 0; d < need && tRun < 6; tRun += 0.1) d = runDistance(shooterA, rx0, ry0, tRun) * 0.95;
    const holdFor = clamp(tRun - flight0 - 0.28 - 0.1, 0, 2.6);
    const o = order(w, final, type === 'cross'
      ? { type: 'cross', to: shooter, kind: 'cross', target: { x: spot0.x, y: spot0.y, z: head ? 1.95 : 0.55 }, T, minHold: 0.15, notBefore: w.t + holdFor }
      : { type: 'pass', to: shooter, kind: 'ground', target: spot0, vArr: 12, minHold: 0.12, notBefore: w.t + holdFor });
    if (holdFor > 0.3 && !offsideGoal) order(w, shooter, { type: 'run', hold: spot0, to: spot0, go: false });
    let trap = [];
    const tDel = w.t;
    if (offsideGoal && o) {
      // offside trap: the back line steps up together as he shapes to cross, and the striker,
      // drifting towards the far post, is caught a yard beyond it
      o.notBefore = w.t + 6;
      const hv = toTeam(dir, hold.x, hold.y).v;
      order(w, shooter, { type: 'goto', to: W(Math.min(lineU() + 1.5, 99), hv), speed: 7, faceBall: true, keepFace: false });
      if (w.agents[m1]?.order?.type === 'mark') order(w, m1, null);
      // everyone in their back line (and anyone who has dropped into it) steps up together
      trap = M.teams[opp].players.filter(p => p.role !== 'GK' && !w.sent.has(p.agent)).map(p => p.agent);
      // the cross is only released while he's (still) beyond the line as it will be struck
      yield* until(w, () => {
        // they squeeze up to just behind him, but stay goal-side of the ball
        const ru = uOf(w, side, shooterA), stepTo = Math.max(ru - 1.6, uOf(w, side, w.ball) + 4, 70);
        const so = shooterA.order;
        if (so?.type === 'goto') { so.to = W(Math.min(Math.max(lineU() + 1.5, uOf(w, side, w.ball) + 6.5), 99), hv); const far = lineU() - ru > 6; so.speed = far ? 7 : 3.2; so.keepFace = !far; }
        for (const d of trap) {
          const ag = w.agents[d], v0 = toTeam(dir, ag.x, ag.y).v;
          if (!ag.free && uOf(w, side, ag) > stepTo - 0.5) order(w, d, { type: 'goto', to: W(Math.min(uOf(w, side, ag), stepTo), v0), speed: 3.6, faceBall: true, keepFace: true });
          else if (ag.order?.type === 'goto') order(w, d, null);
        }
        const ruNext = uOf(w, side, { x: shooterA.x + shooterA.vx * 0.35, y: shooterA.y + shooterA.vy * 0.35 });
        const ok = lineU() - ru < 4 && ruNext > lineU() + 1.1 && ru > lineU() + 0.6;
        if (w.agents[final].order === o) { o.notBefore = ok ? w.t : w.t + 5; o.pace = ok ? null : 0.8; }   // he holds it up, waiting
        return !!since(w, tDel, 'commit', e => e.agent === final);
      }, 9);
    }
    const cm = since(w, tDel, 'commit', e => e.agent === final) || (yield* waitEvent(w, 'commit', e => e.agent === final, 6));
    // he winds up: runners go, and the ball is aimed where the finisher will actually be
    const flight = type === 'cross' ? T : Math.hypot(spot0.x - ass.x, spot0.y - ass.y) / 15 + 0.1;
    const avail = 0.28 + flight;
    const spot = reachable(shooterA, spot0, avail);
    if (o) o.target = { x: spot.x, y: spot.y, z: o.target.z };
    order(w, shooter, { type: 'run', hold, to: spot, go: true, arrive: (cm ? cm.t : w.t) + avail });
    if (second != null) { const o2 = w.agents[second].order; if (o2?.type === 'run') o2.go = true; }
    const kd = since(w, tDel, 'kick', e => e.agent === final) || (yield* waitEvent(w, 'kick', e => e.agent === final, 2));
    for (const d of trap) if (w.agents[d].order?.type === 'goto') order(w, d, null);
    if (offsideGoal && kd) w.marks.offside = { t: kd.t, runner: shooter, lineU: lineU(), sideAtt: side, passer: final };
    w.marks.assist = { from: { x: ass.x, y: ass.y }, to: spot, type };
    return { spot, head };
  }
  if (type === 'through_ball' || type === 'long_ball') {
    // striker on the shoulder of the last defender; he goes as the pass is played
    const holdU = offsideGoal ? lineU() + 1.6 : lineU() - 1.0;
    const hold = W(holdU, clamp(SL.v + (rnd() - 0.5) * 8, 10, 58));
    order(w, shooter, { type: 'run', hold, to: SLw, go: false });
    // he looks up and plays it as soon as he's set (the striker is already on the line)
    const o = order(w, final, { type: 'pass', to: shooter, kind: type === 'long_ball' ? 'lofted' : 'through', target: W(clamp(SL.u - 3, 80, 99), SL.v), vArr: 6.5, minHold: 0.25,
      notBefore: w.t + clamp(Math.hypot(shooterA.x - hold.x, shooterA.y - hold.y) / 6, 0.25, 2.4) });
    const cm = yield* waitEvent(w, 'commit', e => e.agent === final, 4);
    // lead the runner: where he'll be when the ball gets there
    const [rx, ry] = unit(SLw.x - shooterA.x, SLw.y - shooterA.y);
    let tgt = { x: shooterA.x, y: shooterA.y };
    for (let i = 0; i < 3; i++) {
      const d = Math.hypot(tgt.x - w.ball.x, tgt.y - w.ball.y);
      const T = type === 'long_ball' ? d / 19 + 0.5 : d / 14 + 0.2;
      const run = Math.min(Math.hypot(SLw.x - shooterA.x, SLw.y - shooterA.y), shooterA.vmax * 0.8 * (0.28 + T - 0.35));
      tgt = { x: shooterA.x + rx * run, y: shooterA.y + ry * run };
    }
    if (o) o.target = tgt;
    if (offsideGoal) w.marks.offside = { t: w.t + 0.28, runner: shooter, lineU: lineU(), sideAtt: side, passer: final };
    order(w, shooter, { type: 'run', hold, to: tgt, go: true });
    const k = yield* waitEvent(w, 'kick', e => e.agent === final, 2);
    if (offsideGoal && k) w.marks.offside.t = k.t;
    order(w, shooter, { type: 'receive', next: SLw });
    yield* waitEvent(w, 'control', e => e.agent === shooter, (k?.T ?? 2) + 2);
    order(w, shooter, { type: 'dribble', to: SLw, speed: 7.2 });
    yield* until(w, () => Math.hypot(shooterA.x - SLw.x, shooterA.y - SLw.y) < 3 || w.owner !== shooter, 4.5);
    w.marks.assist = { from: { x: ass.x, y: ass.y }, to: tgt, type };
    return null;
  }
  // short pass / lay-off into his feet at the edge of the box
  const spot = W(SL.u - 1, SL.v);
  order(w, shooter, { type: 'goto', to: spot, speed: 7, faceBall: true, keepFace: false });
  yield* until(w, () => Math.hypot(shooterA.x - spot.x, shooterA.y - spot.y) < 3, 3.5);
  const near = Math.hypot(shooterA.x - spot.x, shooterA.y - spot.y) < 4;
  order(w, final, { type: 'pass', to: shooter, kind: 'ground', lead: !near, minHold: 0.1 });
  const k = yield* waitEvent(w, 'kick', e => e.agent === final, 3);
  const firstTime = near && (rnd() < 0.4 || ev.technique === 'volley' || ev.technique === 'tap_in');
  w.marks.assist = { from: { x: ass.x, y: ass.y }, to: spot, type };
  if (firstTime && k) return { spot: null, head: false };
  order(w, shooter, { type: 'receive', next: SLw });
  yield* waitEvent(w, 'control', e => e.agent === shooter, (k?.T ?? 2) + 2);
  if (!near && w.owner === shooter) {
    order(w, shooter, { type: 'dribble', to: SLw, speed: 7 });
    yield* until(w, () => Math.hypot(shooterA.x - SLw.x, shooterA.y - SLw.y) < 2.5 || w.owner !== shooter, 4);
  }
  return null;
}
const unitObj = (x, y) => { const l = Math.hypot(x, y) || 1; return { dx: x / l, dy: y / l }; };

// The other team has it; one of ours reads the pass and steps in front of the receiver.
function* turnoverStart(w, side, winner, at, pre = {}) {
  const opp = other(side);
  const passer = nearestOf(w, opp, at, ['CM', 'CDM', 'CAM', 'LB', 'RB']);
  const pStart = toWorld(w.M.dir[side], toTeam(w.M.dir[side], at.x, at.y).u + 14, toTeam(w.M.dir[side], at.x, at.y).v + (w.rnd() - 0.5) * 10);
  setupPlay(w, pStart, opp, passer, pre);
  // intended receiver: an opponent between the passer and our winner
  const recv = nearestOf(w, opp, at, null, [passer]);
  const sd = w.M.dir[side] > 0 ? 1 : -1;
  place(w, recv, { x: at.x - sd * 3, y: at.y + 0.8 });
  // our man lurks a couple of metres off the line of the pass
  const [lx, ly] = unit(at.x - pStart.x, at.y - pStart.y);
  place(w, winner, { x: lerp(pStart.x, at.x, 0.7) - ly * 2.0, y: lerp(pStart.y, at.y, 0.7) + lx * 2.0 });
  yield* preroll(w, 0.8);
  order(w, recv, { type: 'stay' });
  order(w, passer, { type: 'pass', to: recv, kind: 'ground', target: { x: at.x - sd * 2.2, y: at.y + 0.4 }, vArr: 4.5, minHold: 0.3 });
  const k = yield* waitEvent(w, 'kick', e => e.agent === passer, 3);
  // he reads it and steps into the path of the ball
  order(w, winner, { type: 'receive', next: goalOf(w, side) });
  if (w.flight) w.flight.receiver = winner;
  order(w, recv, { type: 'goto', to: { x: at.x + (w.M.dir[side] > 0 ? -1 : 1), y: at.y }, speed: 3, faceBall: true });
  yield* waitEvent(w, 'control', e => e.agent === winner, (k?.T ?? 1.5) + 1.5);
  order(w, recv, null);
}

// ------------------------------------------------------------------ set pieces
export function freeKickPositions(w, side, spot, taker) {
  const { M, rnd } = w;
  const dir = M.dir[side], opp = other(side), sent = w.sent;
  const start = [];
  for (let a = 0; a < 22; a++) start.push(sent.has(a) ? { x: -30, y: -30 } : shapeTarget(M, sideOf(a), a - baseOf(sideOf(a)), spot, side));
  const uv = toTeam(dir, spot.x, spot.y);
  const g = toWorld(dir, 105, 34);
  const dg = dist(spot, g);
  const wall = [];
  if (uv.u > 68 && Math.abs(uv.v - 34) < 24) {
    const n = dg < 22 ? 5 : dg < 28 ? 4 : 3;
    const ux = (g.x - spot.x) / dg, uy = (g.y - spot.y) / dg;
    const cx = spot.x + ux * 9.15, cy = spot.y + uy * 9.15;
    const cand = byRoles(M, opp, ['ST', 'LW', 'RW', 'CAM', 'CM', 'CDM', 'LM', 'RM'], sent).slice(0, n);
    cand.forEach((a, i) => { const off = (i - (n - 1) / 2) * 0.62; start[a] = { x: cx - uy * off, y: cy + ux * off }; wall.push(a); });
    const att = byRoles(M, side, ['ST', 'CB', 'LW', 'RW', 'CAM'], sent, [taker]).slice(0, 4);
    att.forEach((a, i) => { start[a] = toWorld(dir, 92 + rnd() * 4, 26 + i * 5 + rnd() * 2); });
    const defs = byRoles(M, opp, ['CB', 'LB', 'RB', 'CDM'], sent, wall).slice(0, 4);
    defs.forEach((d, i) => { const tA = att[i % att.length]; if (tA != null) start[d] = { x: start[tA].x + (dir > 0 ? 0.9 : -0.9), y: start[tA].y + 0.4 }; });
    start[gkOf(M, opp)] = toWorld(dir, 104.2, 34 + (uv.v < 34 ? 1.2 : -1.2));
  } else {
    for (let a = 0; a < 22; a++) {
      if (sideOf(a) !== opp || sent.has(a)) continue;
      const d = dist(start[a], spot);
      if (d < 9.3) { const k = 9.4 / (d || 1); start[a] = { x: spot.x + (start[a].x - spot.x) * k, y: spot.y + (start[a].y - spot.y) * k }; }
    }
  }
  if (taker != null) start[taker] = { x: spot.x - dir * 1.5, y: spot.y + 0.8 };
  return Object.assign(start, { wall });
}
export function penaltyPositions(w, side, taker) {
  const { M, rnd } = w;
  const dir = M.dir[side], opp = other(side);
  const start = [];
  for (let a = 0; a < 22; a++) start.push(w.sent.has(a) ? { x: -30, y: -30 } : shapeTarget(M, sideOf(a), a - baseOf(sideOf(a)), toWorld(dir, 94, 34), side));
  let k = 0;
  for (let a = 0; a < 22; a++) {
    if (w.sent.has(a) || a === taker || a === gkOf(M, opp)) continue;
    const s = sideOf(a);
    if (s === side && M.teams[side].players[a - baseOf(side)].role === 'GK') continue;
    const row = k % 2 === 0 ? 86.5 : 85.2;
    const vv = 18 + ((k * 37) % 32) + rnd() * 1.5;
    if (Math.abs(vv - 34) < 9.5) start[a] = toWorld(dir, 83 - (k % 3), vv < 34 ? 24 - (k % 3) * 2 : 44 + (k % 3) * 2);
    else start[a] = toWorld(dir, row, vv);
    k++;
  }
  start[gkOf(M, opp)] = toWorld(dir, 104.8, 34);
  if (taker != null) start[taker] = toWorld(dir, 92.5, 33.2);
  return start;
}
function placeAll(w, positions, spot) {
  for (let a = 0; a < 22; a++) if (!w.agents[a].gone && positions[a]) place(w, a, positions[a], Math.atan2(spot.y - positions[a].y, spot.x - positions[a].x));
  place(w, REF, { x: clamp(spot.x + (w.M.dir.A > 0 ? 1 : -1) * 6, 4, 101), y: clamp(spot.y + 10, 4, 64) });
  place(w, AR_FAR, { x: clamp(spot.x, 52.5, 104), y: -1.4 }, Math.PI / 2);
  place(w, AR_NEAR, { x: clamp(spot.x, 1, 52.5), y: 69.4 }, -Math.PI / 2);
}
function holdStill(w, except = []) {
  for (let a = 0; a < 25; a++) if (!w.agents[a].gone && !except.includes(a)) order(w, a, { type: 'stay' });
}
function releaseAll(w, except = []) {
  for (let a = 0; a < 25; a++) if (!except.includes(a) && w.agents[a].order?.type === 'stay') order(w, a, null);
}

function* freeKickSetup(w, side, taker, setup, FKUV) {
  const { M } = w;
  const dir = M.dir[side], opp = other(side);
  const spot = setup?.type === 'freekick' && setup.side === side ? setup.spot : toWorld(dir, FKUV.u, FKUV.v);
  const pos = setup?.positions && setup.side === side && setup.type === 'freekick' ? setup.positions.map(p => ({ ...p })) : freeKickPositions(w, side, spot, taker);
  const wall = setup?.wall || pos.wall || [];
  const g = goalOf(w, side), dg = dist(spot, g) || 1;
  pos[taker] = { x: spot.x - ((g.x - spot.x) / dg) * 3.4, y: spot.y - ((g.y - spot.y) / dg) * 3.4 + 1.2 };
  placeAll(w, pos, spot);
  setDead(w, spot, side);
  holdStill(w, [REF]);
  for (const a of wall) setAnim(w, a, S.WALL, 4);
  caption(w, `Free kick, ${Math.round(dg)} m out`, 'freekick', 0.3);
  yield* wait(w, 1.1);
  whistle(w);
  yield* wait(w, 0.5);
  w.dead = null; w.owner = taker; w.possSide = side;
  order(w, taker, { type: 'stay' });
  releaseAll(w, wall);
  for (let a = 0; a < 22; a++) if (!w.agents[a].gone && !wall.includes(a) && a !== taker) order(w, a, { type: 'stay' });
  w.marks.freeKick = { spot, wall };
  w.camZoom = 1.28;
  // the wall jumps as he strikes (straight up, on the spot)
  w.sideJobs.push((function* () {
    const c = yield* waitEvent(w, 'commit', e => e.agent === taker, 8); if (!c) return;
    yield* wait(w, 0.1);
    for (const a of wall) { setAnim(w, a, S.WALLJUMP, 0.9); jump(w, a, 2.7 + w.rnd() * 0.4); }
  })());
}
function* penaltySetup(w, side, taker) {
  const { M } = w;
  const dir = M.dir[side];
  const spot = toWorld(dir, 94, 34);
  const pos = w.ctx.setup?.positions && w.ctx.setup.side === side && w.ctx.setup.type === 'penalty' ? w.ctx.setup.positions.map(p => ({ ...p })) : penaltyPositions(w, side, taker);
  pos[taker] = toWorld(dir, 90.2, 32.6);
  placeAll(w, pos, spot);
  setDead(w, spot, side);
  holdStill(w, [REF]);
  caption(w, 'Penalty!', 'penalty', 0.2);
  w.camZoom = 1.35;
  yield* wait(w, 1.3);
  whistle(w);
  yield* wait(w, 0.4);
  w.dead = null; w.owner = taker; w.possSide = side;
}
// Corner: delivery to the near/far post; returns the first-time finish for the attacker.
function* cornerSetup(w, side, shooter, assister, head, sv) {
  const { M, rnd } = w;
  const dir = M.dir[side], opp = other(side);
  const leftFlag = sv < 34 ? rnd() < 0.7 : rnd() < 0.3;
  const flag = toWorld(dir, 104.6, leftFlag ? 0.6 : 67.4);
  const taker = assister ?? pick(M, side, ['CAM', 'CM', 'LW', 'RW', 'LB', 'RB'], w.sent, [shooter]);
  const pos = [];
  for (let a = 0; a < 22; a++) pos.push(shapeTarget(M, sideOf(a), a - baseOf(sideOf(a)), flag, side));
  const att = byRoles(M, side, ['ST', 'CB', 'LW', 'RW', 'CAM', 'CM', 'CDM'], w.sent, [taker]).slice(0, 6);
  const spots = [[95, 30], [97, 38], [93, 36], [98, 28], [91, 42], [96, 44]];
  att.forEach((a, i) => { pos[a] = toWorld(dir, spots[i][0] - rnd() * 1.5, spots[i][1] + (rnd() - 0.5) * 3); });
  if (shooter != null && !att.includes(shooter)) pos[shooter] = toWorld(dir, 93, 35);
  const defs = byRoles(M, opp, ['CB', 'LB', 'RB', 'CDM', 'CM', 'ST', 'LW', 'RW'], w.sent).slice(0, 7);
  defs.forEach((d, i) => { const tA = att[i % att.length]; pos[d] = { x: pos[tA].x + (dir > 0 ? 0.9 : -0.9), y: pos[tA].y + (rnd() - 0.5) }; });
  pos[gkOf(M, opp)] = toWorld(dir, 104.3, 34 + (leftFlag ? -1.5 : 1.5));
  pos[taker] = { x: flag.x - dir * 1.6, y: flag.y + (leftFlag ? 1 : -1) * 0.6 };
  placeAll(w, pos, flag);
  setDead(w, flag, side);
  for (const a of att) order(w, a, { type: 'stay' });
  defs.forEach((d, i) => order(w, d, { type: 'mark', target: att[i % att.length], gap: 0.9 }));
  caption(w, 'Corner', 'corner', 0.2);
  w.camZoom = 1.25;
  yield* wait(w, 1.0);
  w.dead = null; w.owner = taker; w.possSide = side;
  const spot = toWorld(dir, 95 + rnd() * 3, 30 + rnd() * 8);
  const hold = toWorld(dir, 89, toTeam(dir, spot.x, spot.y).v + (rnd() - 0.5) * 6);
  order(w, shooter, { type: 'run', hold, to: spot, go: false });
  for (const a of att) if (a !== shooter) order(w, a, { type: 'run', hold: { x: w.agents[a].x, y: w.agents[a].y }, to: toWorld(dir, 94 + rnd() * 4, 28 + rnd() * 12), go: false });
  const T = clamp(dist(flag, spot) / 19 + 0.6, 1.1, 1.6);
  order(w, taker, { type: 'cross', to: shooter, kind: 'cross', target: { x: spot.x, y: spot.y, z: 1.95 }, T, spin: { wz: (leftFlag ? 1 : -1) * dir * -30 }, minHold: 0.2 });
  const cm = yield* waitEvent(w, 'commit', e => e.agent === taker, 4);
  const arrive = (cm ? cm.t : w.t) + 0.28 + T;
  for (const a of att) { const o = w.agents[a].order; if (o?.type === 'run') { o.go = true; if (a === shooter) o.arrive = arrive; } }
  yield* waitEvent(w, 'kick', e => e.agent === taker, 2);
  w.marks.assist = { from: flag, to: spot, type: 'corner' };
  return { spot, head: true };
}

// ------------------------------------------------------------------ aftermath & restarts
function* celebrate(w, side, scorer) {
  const { M } = w;
  const dir = M.dir[side], opp = other(side);
  w.allowLoose = false;
  const corner = toWorld(dir, 99, dir > 0 ? 64 : 4);
  const t = w.t;
  order(w, scorer, { type: 'goto', to: corner, speed: 7.6 });
  setAnim(w, scorer, S.CELEB, 3.0);
  w.marks.celebrate = { t: t + 0.3, scorer };
  w.camZoom = 1.25;
  let k = 0;
  for (const p of M.teams[side].players) {
    if (p.agent === scorer || w.sent.has(p.agent) || p.role === 'GK') continue;
    order(w, p.agent, { type: 'follow', target: scorer, dx: Math.cos(k * 1.3) * 1.5, dy: Math.sin(k * 1.3) * 1.5, speed: 7.2 - k * 0.15 });
    if (k < 3) setAnim(w, p.agent, S.CELEB, 4.5);
    k++;
  }
  for (const p of M.teams[opp].players) {
    if (w.sent.has(p.agent) || p.role === 'GK') continue;
    order(w, p.agent, { type: 'goto', to: { x: w.agents[p.agent].x + (dir > 0 ? -2 : 2), y: w.agents[p.agent].y }, speed: 1.2, faceBall: true, keepFace: true });
    setAnim(w, p.agent, S.DEJECT, 5);
  }
  setAnim(w, REF, S.POINT, 1.6);
  order(w, REF, { type: 'goto', to: { x: L / 2 + 4, y: 30 }, speed: 3 });
  yield* wait(w, 3.0);
  // knee slide in front of the fans
  const sa = w.agents[scorer];
  const [ux, uy] = unit(sa.vx || 1, sa.vy || 0);
  sa.vx = ux * Math.max(4.2, speedOf(sa)); sa.vy = uy * Math.max(4.2, speedOf(sa));
  setAnim(w, scorer, S.KNEESLIDE, 3.2, true, 1.1);
  order(w, scorer, null);
  yield* wait(w, 2.0);
}
function* disallowTail(w, side, scorer, ev) {
  const reason = ev.reason || 'offside';
  order(w, scorer, { type: 'goto', to: toWorld(w.M.dir[side], 98, 50), speed: 7 });
  setAnim(w, scorer, S.CELEB, 2.2);
  yield* wait(w, 0.8);
  if (reason === 'offside') { setAnim(w, AR_FAR, S.FLAG, 4); setAnim(w, AR_NEAR, S.FLAG, 4); }
  yield* wait(w, 0.4);
  whistle(w);
  w.marks.disallowed = { t: w.t, reason };
  caption(w, ev.text || (reason === 'offside' ? 'Flag up — offside! No goal.' : `No goal — ${reason}`), 'var', 0.2);
  yield* wait(w, 1.3);
  setAnim(w, scorer, S.APPEAL, 2.2);
  yield* wait(w, 1.8);
}
function* afterCatch(w, gk) {
  setAnim(w, gk, S.HOLD, 3.5);
  w.deadCalm = true;
  order(w, gk, { type: 'stay' });
  yield* wait(w, 1.0);
  w.deadCalm = false;
  // look up, roll it out to a full-back
  const side = w.agents[gk].side;
  const fb = pick(w.M, side, ['LB', 'RB', 'CB'], w.sent);
  order(w, gk, { type: 'stay', face: Math.atan2(w.agents[fb].y - w.agents[gk].y, w.agents[fb].x - w.agents[gk].x) });
  yield* wait(w, 1.6);
}
function* clearance(w, def, secs) {
  // nearest defender gets to the loose ball and hacks it clear
  const b = w.ball;
  yield* until(w, () => Math.hypot(b.vx, b.vy) < 9 || b.z < 0.5, 1.2);
  const d = nearestOf(w, def, b, null, [gkOf(w.M, def)]);
  order(w, d, { type: 'receive', next: goalOf(w, def) });
  const c = yield* waitEvent(w, 'control', e => e.agent === d, 2);
  if (c && w.owner === d) {
    const tgt = toWorld(w.M.dir[def], 55 + w.rnd() * 15, w.ball.y < 34 ? -2 : 70);
    order(w, d, { type: 'clear', target: { x: tgt.x, y: tgt.y }, kind: 'clear', minHold: 0.05 });
    yield* waitEvent(w, 'kick', e => e.agent === d, 2);
  }
  yield* wait(w, Math.max(0.6, secs - 1.5));
}
function* restartCorner(w, side) {
  yield* until(w, () => since(w, 0, 'out'), 2.2);
  yield* wait(w, 0.4);
  setAnim(w, REF, S.POINT, 1.6);
  caption(w, 'Corner kick', 'corner');
  const out = since(w, 0, 'out');
  const flag = toWorld(w.M.dir[side], 104.6, out && toTeam(w.M.dir[side], out.at.x, out.at.y).v < 34 ? 0.6 : 67.4);
  w.marks.restart = { type: 'corner', side, at: flag };
  w.deadCalm = true;
  const taker = pick(w.M, side, ['CAM', 'CM', 'LW', 'RW'], w.sent);
  order(w, taker, { type: 'goto', to: flag, speed: 4.5 });
  yield* wait(w, 2.0);
}
function* restartGoalKick(w, side) {
  yield* until(w, () => since(w, 0, 'out'), 2.0);
  yield* wait(w, 0.5);
  caption(w, 'Goal kick', 'goalkick');
  w.deadCalm = true; w.allowLoose = false;
  const dir = w.M.dir[side], gk = gkOf(w.M, side);
  order(w, gk, { type: 'goto', to: toWorld(dir, 5.5, 34 + (w.rnd() < 0.5 ? 6 : -6)), speed: 3.2 });
  w.marks.restart = { type: 'goal_kick', side, at: toWorld(dir, 5.5, 34) };
  yield* wait(w, 1.6);
}

// ------------------------------------------------------------------ fouls
function* foulScript(w, ev, info) {
  const { M, rnd } = w;
  const side = ev.side === 'B' ? 'B' : 'A', opp = other(side), dir = M.dir[side];
  let fouled = findAgent(M, side, ev.player);
  if (fouled == null || w.sent.has(fouled)) fouled = pick(M, side, ['ST', 'LW', 'RW', 'CAM', 'CM'], w.sent);
  let offender = findAgent(M, opp, ev.offender);
  const { u, v } = evLoc(ev, 70, 34);
  const pen = ev.penalty === true || inBox(u, v);
  // (a foul that isn't a penalty happens outside the area — Law 14 would make it one otherwise)
  const nearBox = !pen && v > 11 && v < 57;
  const F = toWorld(dir, pen ? clamp(u, 89, 102) : Math.min(u, nearBox ? 85.5 : 100), v);
  if (offender == null || w.sent.has(offender)) offender = pick(M, opp, ['CB', 'CDM', 'LB', 'RB', 'CM'], w.sent);
  w.allowLoose = true; w.protect = side;
  // build-up: they work it to him a few metres short of the spot
  const before = toWorld(dir, clamp(toTeam(dir, F.x, F.y).u - 10, 5, 95), clamp(v + (rnd() - 0.5) * 8, 4, 64));
  const startW = toWorld(dir, clamp(toTeam(dir, F.x, F.y).u - 26, 5, 80), clamp(v + (rnd() - 0.5) * 18, 6, 62));
  const starter = pick(M, side, ['CM', 'CDM', 'CB', 'LB', 'RB'], w.sent, [fouled]);
  setupPlay(w, startW, side, starter);
  yield* preroll(w, 1.0);
  yield* possession(w, side, { objective: before, final: fouled, budget: 4, minPasses: 1, maxPasses: 3, tempo: M.teams[side].style.tempo, arriveR: 2.5 });
  // he drives at the defender; the defender goes in
  const sliding = rnd() < 0.55;
  const Fu = toTeam(dir, F.x, F.y).u;
  const runTo = pen ? toWorld(dir, Fu + 4, v) : nearBox ? toWorld(dir, Math.min(Fu + 2, 87), v + (v < 34 ? 6 : -6)) : toWorld(dir, Math.min(Fu + 4, 103), v);
  order(w, fouled, { type: 'dribble', to: runTo, speed: 6.4 });
  order(w, offender, { type: 'tackle', target: fouled, style: sliding ? 'slide' : 'lunge', outcome: 'foul', notBefore: w.t + 0.3, maxU: nearBox ? { side, u: 87.3 } : null });
  const fa = w.agents[fouled], tF = w.t;
  // near the area he goes across the edge of it, not into it
  const f = yield* until(w, () => {
    if (nearBox && w.owner === fouled && uOf(w, side, fa) > 84.5 && fa.order?.type === 'dribble') {
      const fv = toTeam(dir, fa.x, fa.y).v;
      fa.order.to = toWorld(dir, 83, fv + (fv < 34 ? 10 : -10)); fa.order.speed = 4.5;
    }
    return since(w, tF, 'foul');
  }, 9);
  w.protect = null;
  const tf = f ? f.t : w.t;
  info.climax = tf; info.protagonists = [fouled, offender]; info.offender = offender; info.fouled = fouled;
  const at = f ? f.at : F;
  yield* wait(w, 0.25);
  whistle(w);
  w.marks.foul = { t: tf, at, fouled, offender, penalty: pen };
  caption(w, ev.text || (pen ? 'Penalty!' : 'Foul'), pen ? 'penalty' : 'foul');
  // play stops: everyone eases off, the referee comes in, the offender protests
  w.deadCalm = true; w.allowLoose = false;
  const restart = pen ? toWorld(dir, 94, 34) : { x: at.x, y: at.y };
  order(w, REF, { type: 'goto', to: { x: at.x + dir * 3, y: at.y + 3 }, speed: 7, faceBall: false });
  if (pen) setAnim(w, REF, S.POINT, 1.5);
  yield* wait(w, 0.7);
  order(w, offender, { type: 'goto', to: { x: at.x + dir * 2, y: at.y + 1.6 }, speed: 2.5 });
  setAnim(w, offender, S.APPEAL, 1.6);
  yield* wait(w, 0.9);
  const card = ev.card === 'red' || ev.card === 'second_yellow' ? 'red' : ev.card === 'yellow' ? 'yellow' : null;
  if (card) {
    const r = w.agents[REF], o = w.agents[offender];
    order(w, REF, { type: 'stay', face: Math.atan2(o.y - r.y, o.x - r.x) });
    order(w, offender, { type: 'stay', face: Math.atan2(r.y - o.y, r.x - o.x) });
    yield* wait(w, 0.3);
    if (ev.card === 'second_yellow') { setAnim(w, REF, S.CARD_Y, 1.1); yield* wait(w, 1.1); setAnim(w, REF, S.CARD_R, 1.4); }
    else setAnim(w, REF, card === 'red' ? S.CARD_R : S.CARD_Y, 2.2);
    w.marks.card = { t: w.t, agent: offender, color: card, second: ev.card === 'second_yellow' };
    caption(w, `${card === 'red' ? 'RED CARD' : 'Yellow card'} — ${playerOf(M, offender).name}`, card === 'red' ? 'red' : 'yellow');
    yield* wait(w, ev.card === 'second_yellow' ? 1.4 : 2.2);
    if (card === 'red') order(w, offender, { type: 'goto', to: { x: at.x, y: 70 }, speed: 2.2 });
  }
  // restart set-up: the ball is stopped where it ran to (free kick there), players walk to their positions
  // Law 13: the free kick is taken from where the offence happened
  if (!pen) { yield* until(w, () => Math.hypot(w.ball.vx, w.ball.vy) < 0.3, 1.5); restart.x = clamp(at.x, 1, L - 1); restart.y = clamp(at.y, 1, WD - 1); setDead(w, restart, side); }
  const sent2 = new Set(w.sent); if (card === 'red') sent2.add(offender);
  const w2 = { ...w, sent: sent2 };
  if (pen) {
    const taker = findAgent(M, side, ev.taker) ?? pick(M, side, ['ST', 'CAM', 'LW', 'RW'], w.sent);
    const pos = penaltyPositions(w2, side, taker);
    for (let a = 0; a < 22; a++) if (!w.agents[a].gone && (a !== offender || card !== 'red') && a !== fouled) order(w, a, { type: 'goto', to: pos[a], speed: 3.4, faceBall: true });
    w.marks.setup = { type: 'penalty', side, positions: pos, spot: restart };
    yield* wait(w, 2.6);
  } else {
    const taker = findAgent(M, side, ev.taker) ?? pick(M, side, ['CAM', 'CM', 'LW', 'RW', 'ST'], w.sent, [fouled]);
    const pos = freeKickPositions(w2, side, restart, taker);
    for (let a = 0; a < 22; a++) if (!w.agents[a].gone && (a !== offender || card !== 'red') && a !== fouled) order(w, a, { type: 'goto', to: pos[a], speed: 3.4, faceBall: true });
    for (const a of pos.wall) setAnim(w, a, S.WALL, 3);
    w.marks.setup = { type: 'freekick', side, positions: [...pos], wall: pos.wall, spot: restart };
    caption(w, pos.wall.length ? `Free kick — ${Math.round(dist(restart, goalOf(w, side)))} m, the wall is set` : 'Free kick', 'freekick', 0.3);
    yield* wait(w, pos.wall.length ? 3 : 1.6);
  }
}

// ------------------------------------------------------------------ offside
function* offsideScript(w, ev, info) {
  const { M, rnd } = w;
  const side = ev.side === 'B' ? 'B' : 'A', opp = other(side), dir = M.dir[side];
  const runner = findAgent(M, side, ev.player) ?? pick(M, side, ['ST', 'LW', 'RW'], w.sent);
  let passer = findAgent(M, side, ev.assist);
  if (passer == null || passer === runner) passer = pick(M, side, ['CAM', 'CM', 'CDM'], w.sent, [runner]);
  const { v } = evLoc(ev, 80, 34);
  const startW = toWorld(dir, 40 + rnd() * 8, clamp(34 + (rnd() - 0.5) * 18, 12, 56));
  const starter = pick(M, side, ['CB', 'CDM'], w.sent, [runner, passer]);
  setupPlay(w, startW, side, starter);
  yield* preroll(w, 1.0);
  const passSpot = toWorld(dir, 58 + rnd() * 8, clamp(34 + (rnd() - 0.5) * 14, 14, 54));
  w.allowLoose = true; w.protect = side;
  yield* possession(w, side, { objective: passSpot, final: passer, budget: 3.5, minPasses: 1, maxPasses: 2, avoid: [runner], arriveR: 4 });
  // Law 11: he is offside if, when the ball is played, he is in the opponents' half and nearer
  // their goal line than both the ball and the second-last opponent. The striker sits on the last
  // defender's shoulder, the back line holds (and steps up as the passer looks up), he goes too
  // early — and the pass is played while he's a yard beyond them.
  if (w.owner < 0) yield* waitEvent(w, 'control', e => w.agents[e.agent].side === side, 2.5);
  if (w.owner >= 0 && w.agents[w.owner].side === side && w.owner !== runner) passer = w.owner;   // whoever has it plays it
  const lineU = () => w.line[side];
  const ra = w.agents[runner];
  const lv = clamp(v, 10, 58);
  order(w, runner, { type: 'goto', to: toWorld(dir, lineU() - 1.2, lv), speed: 6.5, faceBall: true, keepFace: false });
  if (w.owner === passer) order(w, passer, { type: 'dribble', to: towards(w, w.agents[passer], toWorld(dir, 90, lv), 6), speed: 2.6 });
  yield* until(w, () => { const o = ra.order; if (o?.type === 'goto') o.to = toWorld(dir, lineU() - 1.2, lv); return Math.abs(uOf(w, side, ra) - (lineU() - 1.2)) < 2.2; }, 4);
  const target = toWorld(dir, Math.min(lineU() + 12, 98), lv);
  const pass = w.owner === passer ? order(w, passer, { type: 'pass', to: runner, kind: 'through', target, vArr: 6, minHold: 0.1, notBefore: w.t + 8 }) : null;
  // the back line holds and squeezes up
  const trap = byRoles(M, opp, ['CB', 'LB', 'RB', 'LWB', 'RWB'], w.sent);
  const hold = () => { for (const d of trap) { const ag = w.agents[d]; if (ag.free) continue; order(w, d, { type: 'goto', to: toWorld(dir, Math.max(55, uOf(w, side, ag) - 0.6), toTeam(dir, ag.x, ag.y).v), speed: 3, faceBall: true, keepFace: true }); } };
  hold();
  // he goes when the passer has set himself to play it (head up, body open)
  yield* until(w, () => {
    const pa = w.agents[passer], o = pa.order;
    if (w.k % 6 === 0) hold();
    if (!o || o !== pass) return true;
    const kd = Math.atan2(target.y - w.ball.y, target.x - w.ball.x);
    return pa.kick && Math.abs(angDiff(pa.face, kd)) < 0.7 && Math.hypot(w.ball.x - pa.x, w.ball.y - pa.y) < 1.1;
  }, 2.5);
  order(w, runner, { type: 'run', to: target, go: true, speed: ra.vmax * 0.9 });
  // play it once he'll still be beyond the line when the boot meets the ball (0.3 s on)
  yield* until(w, () => {
    if (w.k % 6 === 0) hold();
    const ruNext = uOf(w, side, { x: ra.x + ra.vx * 0.3, y: ra.y + ra.vy * 0.3 });
    return ruNext > lineU() + 1.0 && uOf(w, side, ra) > 52.5;
  }, 4);
  if (pass && w.agents[passer].order === pass) pass.notBefore = w.t;
  else {
    // the ball moved on in the meantime: whoever has it now plays it in
    if (w.owner < 0) yield* waitEvent(w, 'control', e => w.agents[e.agent].side === side, 2);
    if (w.owner >= 0 && w.agents[w.owner].side === side && w.owner !== runner) { passer = w.owner; order(w, passer, { type: 'pass', to: runner, kind: 'through', target: toWorld(dir, Math.min(uOf(w, side, ra) + 8, 98), lv), vArr: 6, minHold: 0.05 }); }
  }
  const k = yield* waitEvent(w, 'kick', e => e.agent === passer, 5);
  for (const d of trap) if (w.agents[d].order?.type === 'goto') { order(w, d, null); if (w.rnd() < 0.6) setAnim(w, d, S.APPEAL, 1.4); }
  const tp = k ? k.t : w.t;
  const offenceAt = { x: ra.x, y: ra.y };            // where he was when it was played
  info.climax = tp; info.protagonists = [runner, passer]; info.runner = runner;
  w.marks.offside = { t: tp, runner, lineU: k?.lineU ?? lineU(), sideAtt: side, passer };
  // flag
  yield* wait(w, 0.5);
  const flagger = target.x > L / 2 ? AR_FAR : AR_NEAR;
  setAnim(w, flagger, S.FLAG, 4);
  order(w, flagger, { type: 'stay', face: flagger === AR_FAR ? Math.PI / 2 : -Math.PI / 2 });
  caption(w, ev.text || 'Flag up — offside', 'offside', 0.3);
  yield* wait(w, 0.6);
  whistle(w);
  w.deadCalm = true; w.allowLoose = false;
  yield* wait(w, 0.6);
  setAnim(w, runner, S.APPEAL, 1.6);
  order(w, runner, { type: 'goto', to: w.agents[runner], speed: 1.5 });
  // indirect free kick to the defending team, from where he was when the ball was played (Law 11)
  if (w.owner >= 0) order(w, w.owner, { type: 'stay' });
  yield* until(w, () => Math.hypot(w.ball.vx, w.ball.vy) < 0.4, 1.2);
  const ifk = { x: clamp(offenceAt.x, 1, L - 1), y: clamp(offenceAt.y, 1, WD - 1) };
  setDead(w, ifk, opp);
  const def = nearestOf(w, opp, ifk, ['CB', 'LB', 'RB']);
  order(w, def, { type: 'goto', to: { x: ifk.x + dir * 1.4, y: ifk.y }, speed: 3.5, faceBall: true });
  yield* wait(w, 2.2);
}

// ------------------------------------------------------------------ kick-off
function* kickoffScript(w, ev, info) {
  const { M } = w;
  const side = ev.side === 'B' ? 'B' : 'A', opp = other(side), dir = M.dir[side];
  const centre = { x: L / 2, y: WD / 2 };
  const pos = [];
  for (let a = 0; a < 22; a++) {
    if (w.agents[a].gone) { pos.push(null); continue; }
    const s = sideOf(a), d = M.dir[s];
    const p = shapeTarget(M, s, a - baseOf(s), centre, side);
    const tu = toTeam(d, p.x, p.y);
    tu.u = Math.min(tu.u, s === side ? 51.5 : 42);
    const q = toWorld(d, tu.u, tu.v);
    if (s === opp && dist(q, centre) < 9.6) { const k = 9.8 / (dist(q, centre) || 1); q.x = centre.x + (q.x - centre.x) * k; q.y = centre.y + (q.y - centre.y) * k; }
    pos.push(q);
  }
  const [st0, partner0] = byRoles(M, side, ['ST', 'CAM', 'CM', 'LW', 'RW'], w.sent);
  const st = st0 ?? pick(M, side, ['ST'], w.sent);
  const partner = partner0 ?? pick(M, side, ['CM'], w.sent, [st]);
  const back = pick(M, side, ['CDM', 'CM', 'CB'], w.sent, [st, partner]);
  pos[st] = toWorld(dir, 52.0, 34.4);
  pos[partner] = toWorld(dir, 51.2, 30.2);
  placeAll(w, pos, centre);
  place(w, REF, { x: L / 2 + 5, y: 41 });
  setDead(w, centre, side);
  holdStill(w);
  caption(w, ev.text, 'kickoff', 1.0);
  yield* wait(w, 1.0);
  whistle(w);
  info.climax = 1.0; info.protagonists = [st];
  yield* wait(w, 0.35);
  releaseAll(w);
  w.dead = null; w.owner = st; w.possSide = side;
  order(w, st, { type: 'pass', to: partner, kind: 'ground', target: toWorld(dir, 49.8, 31.2), minHold: 0.05 });
  const k = yield* waitEvent(w, 'kick', e => e.agent === st, 2.5);
  if (k) order(w, partner, { type: 'receive', next: toWorld(dir, 44, 33) });
  yield* waitEvent(w, 'control', e => e.agent === partner, 2.5);
  yield* possession(w, side, { objective: toWorld(dir, 50, 34), final: null, budget: 2.5, minPasses: 1, maxPasses: 2, tempo: 'medium' });
}

// ------------------------------------------------------------------ corner cleared
function* cornerClearScript(w, ev, info) {
  const { M, rnd } = w;
  const side = ev.side === 'B' ? 'B' : 'A', opp = other(side), dir = M.dir[side];
  const { v } = evLoc(ev, 100, rnd() < 0.5 ? 10 : 58);
  const header = byRoles(M, opp, ['CB', 'ST', 'CDM'], w.sent)[0];
  const target = byRoles(M, side, ['ST', 'CB', 'LW', 'RW', 'CAM'], w.sent)[0];
  // the defender attacks the delivery: header order replaces the attacker's
  const spot = yield* cornerSetup(w, side, target, findAgent(M, side, ev.player), true, v);
  const landing = spot.spot;
  info.climax = w.t + 1.0; info.protagonists = [header];
  order(w, header, { type: 'receive', first: 'head', spot: { x: landing.x + (dir > 0 ? 0.8 : -0.8), y: landing.y }, then: { type: 'clear', target: toWorld(dir, 66 - rnd() * 14, 34 + (rnd() - 0.5) * 30), kind: 'clear', T: 1.5 } });
  order(w, target, { type: 'goto', to: { x: landing.x - (dir > 0 ? 0.9 : -0.9), y: landing.y + 0.5 }, speed: 7 });
  setAnim(w, target, S.HEAD, 0.8);
  caption(w, ev.text || 'Headed clear', 'corner', 1.4);
  const k = yield* waitEvent(w, 'kick', e => e.agent === header, 3);
  if (k) info.climax = k.t;
  yield* wait(w, 1.6);
}

// ------------------------------------------------------------------ half-time / full-time whistle
function* whistleScript(w, ev, info) {
  const { M, rnd } = w;
  const side = rnd() < 0.5 ? 'A' : 'B', dir = M.dir[side];
  const b = toWorld(dir, 38 + rnd() * 20, 20 + rnd() * 28);
  const holder = pick(M, side, ['CB', 'CDM', 'CM'], w.sent);
  setupPlay(w, b, side, holder);
  yield* preroll(w, 1.0);
  yield* possession(w, side, { objective: toWorld(dir, 50, 34), final: null, budget: 1.2, minPasses: 1, maxPasses: 1 });
  whistle(w); info.climax = w.t;
  yield* wait(w, 0.45); whistle(w);
  yield* wait(w, 0.55); whistle(w);
  setAnim(w, REF, S.POINT, 1.8);
  caption(w, ev.text || (ev.type === 'full_time' ? 'Full time!' : 'Half-time'), ev.type === 'full_time' ? 'ft' : 'ht');
  if (w.owner >= 0) { const c = w.owner; order(w, c, { type: 'stay' }); }
  setDead(w, { x: w.ball.x, y: w.ball.y }, side);
  for (let a = 0; a < 22; a++) {
    if (w.agents[a].gone) continue;
    order(w, a, { type: 'goto', to: { x: L / 2 + ((a % 7) - 3) * 2.2, y: 71 }, speed: 1.5 + (a % 3) * 0.25 });
  }
  const winner = ev.winner;
  if (ev.type === 'full_time' && winner) {
    for (const p of M.teams[winner].players) if (!w.sent.has(p.agent)) setAnim(w, p.agent, S.CELEB, 4.5);
    for (const p of M.teams[other(winner)].players) if (!w.sent.has(p.agent)) setAnim(w, p.agent, p.role === 'GK' ? S.DEJECT : S.DEJECT, 4.8);
  }
  yield* wait(w, 3.2);
}

function* injuryScript(w, ev, info) {
  const { M, rnd } = w;
  const side = ev.side === 'B' ? 'B' : 'A', dir = M.dir[side];
  let a = findAgent(M, side, ev.player);
  if (a == null || w.sent.has(a)) a = pick(M, side, ['CM', 'ST', 'CB'], w.sent);
  const at = toWorld(dir, 45 + rnd() * 25, 15 + rnd() * 38);
  const holder = pick(M, other(side), ['CM', 'CDM'], w.sent);
  setupPlay(w, { x: at.x + 7, y: at.y }, other(side), holder, { [a]: { ...at } });
  setAnim(w, a, S.FALL, 8, true, 6);
  order(w, a, { type: 'stay' });
  yield* preroll(w, 0.2);
  setAnim(w, a, S.FALL, 8, true, 6);
  yield* wait(w, 0.5);
  // the ball is put out of play
  if (w.owner >= 0) { const c = w.owner; order(w, c, { type: 'clear', target: { x: w.ball.x + (rnd() - 0.5) * 6, y: w.ball.y < 34 ? -3 : 71 }, kind: 'clear', T: 1.2 }); }
  whistle(w); info.climax = w.t; info.protagonists = [a];
  caption(w, ev.text || 'Play stopped for an injury', 'injury');
  w.deadCalm = true;
  order(w, REF, { type: 'goto', to: { x: at.x + 2, y: at.y + 2 }, speed: 6 });
  yield* wait(w, 3.6);
}

// ------------------------------------------------------------------ walk-out (static line-up)
function* walkoutScript(w) {
  for (let a = 0; a < 22; a++) place(w, a, { x: L / 2 + (sideOf(a) === 'A' ? -1.8 : 1.8), y: 16 + (a % 11) * 3.3 }, Math.PI / 2);
  place(w, REF, { x: L / 2, y: 13 }, Math.PI / 2); place(w, AR_FAR, { x: L / 2 - 1.5, y: 12 }, Math.PI / 2); place(w, AR_NEAR, { x: L / 2 + 1.5, y: 12 }, Math.PI / 2);
  setDead(w, { x: L / 2, y: 13.8 }, 'A');
  for (let a = 0; a < 25; a++) order(w, a, { type: 'stay', face: Math.PI / 2 });
  w.camSpeed = 0.15;
  yield* wait(w, 9);
}

// ------------------------------------------------------------------ a spell of possession
function* flowScript(w, ev, info) {
  const { M, rnd } = w;
  let side = ev.side === 'B' ? 'B' : ev.side === 'A' ? 'A' : rnd() < 0.5 ? 'A' : 'B';
  const startW = toWorld(M.dir[side], 22 + rnd() * 18, 20 + rnd() * 28);
  const holder = pick(M, side, ['CB', 'CDM'], w.sent);
  setupPlay(w, startW, side, holder);
  yield* preroll(w, 1.2);
  w.allowLoose = true;
  info.climax = 0;
  // Nothing is scripted here: whoever has it plays; if it's won back, the other team plays on.
  const t0 = w.t;
  while (w.t - t0 < 9) {
    const r = yield* possession(w, side, { objective: toWorld(M.dir[side], 62 + rnd() * 14, 34 + (rnd() - 0.5) * 30), final: null, budget: Math.max(2, 8 - (w.t - t0)), minPasses: 2, maxPasses: 5, tempo: M.teams[side].style.tempo });
    if (r.lost) { side = other(side); continue; }
    if (w.owner < 0) { const e = yield* waitEvent(w, 'control', () => true, 2); if (!e) break; side = w.agents[e.agent].side; continue; }
    break;
  }
  yield* wait(w, 0.5);
}
