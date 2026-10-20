// Match "broadcast": turns GPT's match script into a deterministic highlight show rendered on a
// 1280×720 canvas. Every scripted moment is played out by the football engine (../sim/core.js)
// and filmed with TV-style cameras (../sim/draw.js): live action, slow-motion replays from
// another angle, and freeze-frame analysis images showing how it happened.
//
// API (unchanged for the app): createMatch({ teams }) → { setItems, duration, complete, render,
// infoAt, preload, score, timeline, moments }.
import { interpolate, clamp as mclamp, easeOut, easeInOut, backOut, circOut } from 'motion';
import * as C from '../sim/core.js';
import * as D from '../sim/draw.js';

export const W = D.W, H = D.H;
const FONT = D.FONT;
const HZ = C.HZ;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

// ------------------------------------------------------------------ text helpers
const mctx = (() => { const c = document.createElement('canvas'); return c.getContext('2d'); })();
const fitMemo = new Map(), wrapMemo = new Map();
function fit(text, weight, max, maxW, min = 10, italic = false) {
  const key = `${text}|${weight}|${max}|${maxW}|${min}|${italic}`;
  let v = fitMemo.get(key);
  if (v === undefined) { v = fitRaw(text, weight, max, maxW, min, italic); if (fitMemo.size > 4000) fitMemo.clear(); fitMemo.set(key, v); }
  return v;
}
function fitRaw(text, weight, max, maxW, min = 10, italic = false) {
  for (let s = max; s > min; s -= 1) { mctx.font = `${italic ? 'italic ' : ''}${weight} ${s}px ${FONT}`; if (mctx.measureText(text).width <= maxW) return s; }
  return min;
}
function wrap(text, weight, size, maxW, maxLines = 3) {
  const key = `${text}|${weight}|${size}|${maxW}|${maxLines}`;
  let v = wrapMemo.get(key);
  if (!v) { v = wrapRaw(text, weight, size, maxW, maxLines); if (wrapMemo.size > 2000) wrapMemo.clear(); wrapMemo.set(key, v); }
  return v;
}
function wrapRaw(text, weight, size, maxW, maxLines = 3) {
  mctx.font = `${weight} ${size}px ${FONT}`;
  const words = String(text || '').split(/\s+/); const lines = []; let line = '';
  for (const w of words) {
    const t = line ? line + ' ' + w : w;
    if (mctx.measureText(t).width > maxW && line) { lines.push(line); line = w; if (lines.length === maxLines) break; } else line = t;
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines && words.join(' ') !== lines.join(' ')) lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, '') + '…';
  return lines;
}
const surname = n => { const p = String(n || '').trim().split(/\s+/); return p.length > 1 ? p.slice(-1)[0] : p[0] || ''; };
const short3 = n => String(n || '').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 3).toUpperCase();
function hexRgb(h) { const n = parseInt(String(h).replace('#', '').padEnd(6, '0').slice(0, 6), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
const lum = h => { const [r, g, b] = hexRgb(h); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; };
const rgba = (h, a) => { const [r, g, b] = hexRgb(h); return `rgba(${r},${g},${b},${a})`; };
const colorDist = (a, b) => { const x = hexRgb(a), y = hexRgb(b); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); };
const ord = n => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };

// ------------------------------------------------------------------ event normalisation
const GOAL_OUT = new Set(['goal']);
function normEv(d) {
  const e = { ...d };
  const t = e.type;
  if (t === 'goal') return { ...e, type: 'shot', outcome: 'goal' };
  if (t === 'penalty_goal') return { ...e, type: 'shot', outcome: 'goal', technique: 'penalty' };
  if (t === 'penalty_miss') return { ...e, type: 'shot', outcome: e.outcome || 'saved', technique: 'penalty' };
  if (t === 'save') return { ...e, type: 'shot', outcome: e.outcome || 'saved' };
  if (t === 'woodwork') return { ...e, type: 'shot', outcome: 'woodwork' };
  if (t === 'block') return { ...e, type: 'shot', outcome: 'blocked' };
  if (t === 'chance') return { ...e, type: 'shot', outcome: e.outcome || 'off_target' };
  if (t === 'own_goal') return { ...e, type: 'shot', outcome: 'goal', ownGoal: true, og: e.player, player: e.assist || null, assist_type: e.assist_type || 'cross' };
  if (t === 'yellow' || t === 'red' || t === 'second_yellow') return { ...e, type: 'foul', card: t, offender: e.player, player: e.fouled || null, side: e.side === 'A' ? 'B' : e.side === 'B' ? 'A' : e.side };
  return e;
}
const minuteStr = (min, add) => (add ? `${min}+${add}'` : `${min}'`);

// ------------------------------------------------------------------ main
export function createMatch({ teams }) {
  const TEAMS = teams;
  let items = [];
  let built = { n: 0, scenes: [], tl: [], moments: [], state: null };
  let complete = false;
  let meta = null, stats = null, ratings = null, analysis = { A: null, B: null };
  const photos = new Map();   // player id → small avatar canvas (HUD graphics)
  const photoImgs = new Map(); // player id → decoded photo (face texture for the 3D players)
  const looks = new Map();    // player id → { skin, hair }
  let stage3d = null;         // WebGL stadium + mocap players (null → 2D fallback renderer)
  let M0 = C.makeMatch(TEAMS, null);
  const kits = makeKits(TEAMS);

  // Engine runs in a Web Worker (falls back to the main thread if workers aren't available).
  let worker = null, reqId = 0;
  const pending = new Map();
  function getWorker() {
    if (worker === null) {
      try {
        worker = new Worker(new URL('../sim/worker.js', import.meta.url), { type: 'module' });
        worker.onmessage = ({ data }) => {
          const p = pending.get(data.id); if (!p) return;
          pending.delete(data.id);
          if (data.error) p.reject(new Error(data.error)); else p.resolve(data.clip);
        };
        worker.onerror = () => { for (const p of pending.values()) p.reject(new Error('worker failed')); pending.clear(); worker = false; };
        worker.postMessage({ type: 'init', teams: TEAMS, styles: meta?.styles || null });
      } catch { worker = false; }
    }
    return worker;
  }
  function build(half, ev, ctx) {
    const w = getWorker();
    const local = () => C.buildMoment(C.withHalf(M0, half), ev, ctx);
    if (!w) return Promise.resolve().then(local);
    return new Promise((resolve, reject) => {
      const id = ++reqId;
      pending.set(id, { resolve, reject });
      w.postMessage({ type: 'build', id, half, ev, ctx: { ...ctx, sent: [...ctx.sent] } });
    }).catch(() => local());
  }
  // Items are processed strictly in order (each moment depends on the match state before it).
  let queue = [], pumping = false, waiters = [];
  async function pump() {
    if (pumping) return;
    pumping = true;
    while (queue.length) {
      const [it, idx, gen] = queue.shift();
      if (gen !== built.gen) continue;
      try { await addItem(it, idx, gen); } catch (e) { console.warn('match item failed', e); }
    }
    pumping = false;
    scheduleWarm();
    const w = waiters; waiters = []; w.forEach(r => r());
  }
  const ready = () => (pumping || queue.length ? new Promise(r => waiters.push(r)) : Promise.resolve());

  // ---------------------------------------------------------------- scene building (append-only)
  function initState() {
    return { t: 0, half: 1, score: [0, 0], sent: new Set(), yellows: new Map(), setup: null, lastMin: 0, lastRendered: 0, goals: [], cards: [],
      ev: { shots: [0, 0], onT: [0, 0], corners: [0, 0], fouls: [0, 0], yellow: [0, 0], red: [0, 0], offsides: [0, 0] }, htDone: false, ftStart: null, kickedOff: false, outro: false };
  }
  const push = (sc) => { sc.start = built.state.t; built.scenes.push(sc); built.state.t += sc.dur; return sc; };

  function setItems(list) {
    items = list || [];
    // Meta (team styles) comes first; if it shows up late, rebuild from scratch.
    const m = items.find(i => i.kind === 'meta')?.data || null;
    if (!built.state || (m && !meta)) {
      meta = m; rebuild(); queue = [];
      if (worker) worker.postMessage({ type: 'init', teams: TEAMS, styles: meta?.styles || null });
    }
    for (let i = built.n; i < items.length; i++) queue.push([items[i], i, built.gen]);
    built.n = items.length;
    pump();
  }
  function rebuild() {
    M0 = C.makeMatch(TEAMS, meta?.styles || null);
    built = { n: 0, scenes: [], tl: [], moments: [], state: initState(), gen: (built.gen || 0) + 1 };
    complete = false; stats = null; ratings = null; analysis = { A: null, B: null };
    // Pre-match: walk-out, line-ups, coin toss
    const walk = C.buildMoment(C.withHalf(M0, 1), {}, { kind: 'walkout', seed: 11, sent: new Set() });
    push({ kind: 'intro', dur: 7000, clip: walk });
    push({ kind: 'lineup', side: 'A', dur: 6500, clip: walk });
    push({ kind: 'lineup', side: 'B', dur: 6500, clip: walk });
    built.tl.push({ start: 0, end: 7000, kind: 'intro', type: 'intro', itemIndex: -1, side: null, minute: '' });
    built.tl.push({ start: 7000, end: 20000, kind: 'lineups', type: 'lineups', itemIndex: -1, side: null, minute: '' });
  }
  async function ensureKickoff() {
    const st = built.state;
    if (st.kickedOff) return;
    st.kickedOff = true;
    const ko = meta?.kickoff === 'B' ? 'B' : 'A';
    st.firstKick = ko;
    push({ kind: 'toss', dur: 2600, side: ko });
    await clipScene({ type: 'kickoff', side: ko, min: 1, add: 0, text: `${TEAMS[ko].name} get us under way.` }, -1, 'kickoff', { live: true });
  }

  async function addItem(it, idx) {
    const st = built.state;
    if (st.outro) return;
    if (it.kind === 'meta') { if (!meta) { meta = it.data; } return; }
    if (it.kind === 'stats') { stats = it.data; maybeFT(); return; }
    if (it.kind === 'ratings') { ratings = it.data; return; }
    if (it.kind === 'analysis') { if (it.data?.side === 'A' || it.data?.side === 'B') analysis[it.data.side] = it.data; return; }
    if (it.kind === 'end') { maybeFT(true); await buildOutro(); complete = true; return; }
    if (it.kind === 'flow') { st.lastFlow = { ...it.data, idx }; built.tl.push({ start: st.t, end: st.t, kind: 'ev', type: 'flow', itemIndex: idx, side: it.data?.momentum || null, minute: it.data?.to ? `${it.data.to}'` : '' }); return; }
    if (it.kind !== 'ev') return;
    await ensureKickoff();
    const ev = normEv(it.data || {});
    const min = Number(ev.min) || st.lastMin || 1, add = Number(ev.add) || 0;
    if (ev.type === 'kickoff' || ev.type === 'second_half') { built.tl.push({ start: st.t, end: st.t, kind: 'ev', type: ev.type, itemIndex: idx, side: ev.side || null, minute: minuteStr(min, add) }); return; }
    if (ev.type === 'half_time') return halfTime(ev, idx, min, add);
    if (ev.type === 'full_time') return fullTime(ev, idx, min, add);
    if (min >= 46 && st.half === 1) await halfTime({ type: 'half_time', min: 45, add: 0, text: 'Half-time.' }, -1, 45, 0, true);

    // Stats from events (shown at half-time; full time uses GPT's stats when available).
    const si = ev.side === 'B' ? 1 : 0;
    let render = false, kind = null;
    if (ev.type === 'shot') {
      st.ev.shots[si]++; if (['goal', 'saved', 'parried', 'tipped'].includes(ev.outcome)) st.ev.onT[si]++;
      render = true; kind = 'shot';
    } else if (ev.type === 'foul') {
      st.ev.fouls[si ? 0 : 1]++;
      // Second booking → red
      if (ev.card === 'yellow' && ev.offender) {
        const k = `${ev.side}:${ev.offender}`, n = (st.yellows.get(k) || 0) + 1; st.yellows.set(k, n);
        if (n >= 2) ev.card = 'second_yellow';
      }
      if (ev.card === 'yellow') st.ev.yellow[si ? 0 : 1]++;
      if (ev.card === 'red' || ev.card === 'second_yellow') st.ev.red[si ? 0 : 1]++;
      const { u } = { u: (Number(ev.x) || 50) * 1.05 };
      render = !!ev.card || ev.penalty || u >= 66;
      kind = 'foul';
    } else if (ev.type === 'offside') { st.ev.offsides[si]++; render = true; kind = 'offside'; }
    else if (ev.type === 'corner') { st.ev.corners[si]++; render = (min - st.lastRendered) >= 4; kind = 'corner'; }
    else if (ev.type === 'injury') { render = true; kind = 'injury'; }
    else if (ev.type === 'var') { render = true; kind = 'var'; }

    if (!render) {
      built.tl.push({ start: st.t, end: st.t, kind: 'ev', type: ev.type, itemIndex: idx, side: ev.side || null, minute: minuteStr(min, add) });
      st.lastMin = min;
      return;
    }
    // A spell of play between big moments.
    if (min - st.lastRendered >= 9 && kind !== 'var') {
      const f = st.lastFlow;
      await clipScene({ type: 'flow', side: f?.momentum === 'B' ? 'B' : f?.momentum === 'A' ? 'A' : (min % 2 ? 'A' : 'B'), min: Math.max(st.lastRendered + 3, min - 4), add: 0, text: f?.note || '' }, -1, 'flow', { live: true, short: true });
    }
    if (kind === 'var') varScene(ev, idx, min, add);
    else await clipScene(ev, idx, kind, {});
    st.lastMin = min; st.lastRendered = min;
  }

  // One scripted moment → live clip (+ replay + analysis freeze for big moments).
  async function clipScene(ev, idx, kind, opt) {
    const st = built.state;
    const half = (Number(ev.min) || 1) >= 46 || st.half === 2 ? 2 : 1;
    const M = C.withHalf(M0, half);
    const seed = C.hashStr(`${idx}|${ev.type}|${ev.min}|${ev.add}|${ev.player}|${ev.text}`);
    const ctx = { kind, seed, sent: new Set(st.sent), setup: (ev.type === 'shot' && (ev.assist_type === 'free_kick' || ev.technique === 'free_kick' || ev.technique === 'penalty' || ev.assist_type === 'penalty')) ? st.setup : null };
    let clip;
    try { clip = await build(half, ev, ctx); } catch (e) { console.warn('clip failed', e); return; }
    const min = Number(ev.min) || 1, add = Number(ev.add) || 0;
    const scoreBefore = [...st.score];
    const isGoal = kind === 'shot' && ev.outcome === 'goal';
    const scorerSide = ev.side;
    const climax = clip.info.climax || 0;
    const sc = push({ kind: 'clip', clip, ev, idx, M, half, dur: Math.round(clip.dur * 1000), min, add, scoreBefore, climax, isGoal, isWipe: !opt.short, live: true });
    if (idx >= 0) built.tl.push({ start: sc.start + Math.max(0, climax * 1000 - 300), end: sc.start + sc.dur, kind: 'ev', type: ev.type === 'shot' ? (ev.outcome === 'goal' ? (ev.ownGoal ? 'own_goal' : ev.technique === 'penalty' ? 'penalty_goal' : 'goal') : ev.outcome === 'woodwork' ? 'woodwork' : ev.outcome === 'blocked' ? 'block' : ['saved', 'parried', 'tipped'].includes(ev.outcome) ? 'save' : ev.outcome === 'disallowed' ? 'var' : 'shot') : ev.type === 'foul' ? (ev.card ? (ev.card === 'yellow' ? 'yellow' : 'red') : ev.penalty ? 'penalty' : 'foul') : ev.type, itemIndex: idx, side: ev.side || null, minute: minuteStr(min, add) });
    if (isGoal) {
      st.score[scorerSide === 'B' ? 1 : 0]++;
      sc.goalAt = sc.start + Math.round((clip.marks.goalT || climax) * 1000);
      st.goals.push({ side: scorerSide, name: ev.ownGoal ? `${ev.og} (OG)` : ev.player, min: minuteStr(min, add), pen: ev.technique === 'penalty' });
    }
    if (kind === 'foul') {
      if (clip.marks.setup) st.setup = clip.marks.setup;
      if (ev.card === 'red' || ev.card === 'second_yellow') { const a = clip.info.offender; if (a != null) st.sent.add(a); }
      if (ev.card) st.cards.push({ side: ev.side === 'A' ? 'B' : 'A', name: ev.offender, color: ev.card === 'yellow' ? 'yellow' : 'red', min: minuteStr(min, add) });
    } else st.setup = null;
    const big = isGoal || (kind === 'shot' && (['woodwork', 'disallowed'].includes(ev.outcome) || (['saved', 'parried', 'tipped'].includes(ev.outcome) && (Number(ev.xg) >= 0.25 || ev.technique === 'penalty')))) || (kind === 'foul' && (ev.card === 'red' || ev.card === 'second_yellow' || ev.penalty)) || kind === 'offside';
    if (big && !opt.live) {
      const replayCam = kind === 'shot' ? 'goal' : 'reverse';
      const from = Math.max(0, climax - (isGoal ? 3.6 : 2.6)), to = Math.min(clip.dur - 0.1, climax + (isGoal ? 1.7 : 1.4));
      const slow = 0.5;
      push({ kind: 'replay', clip, ev, M, half, from, to, slow, cam: replayCam, dur: Math.round(((to - from) / slow) * 1000), min, add, scoreBefore: [...st.score] });
      const fr = push({ kind: 'freeze', clip, ev, M, half, at: freezeAt(clip, kind, ev), dur: 5200, min, add, scoreBefore: [...st.score], idx });
      built.moments.push({ t: fr.start + 1600, title: momentTitle(ev, kind), minute: minuteStr(min, add), side: ev.side, type: built.tl[built.tl.length - 1]?.type || kind });
    }
    if (isGoal) {
      // Restart: kick-off by the team that conceded.
      const conceding = scorerSide === 'A' ? 'B' : 'A';
      const ko = await build(half, { side: conceding }, { kind: 'kickoff', seed: seed ^ 0x9e37, sent: new Set(st.sent) });
      push({ kind: 'clip', clip: ko, ev: { type: 'kickoff', side: conceding, min, add, text: '' }, idx: -1, M, half, dur: 3600, min, add, scoreBefore: [...st.score], climax: 1, trimStart: 0.3, isWipe: false });
    }
  }
  function freezeAt(clip, kind, ev) {
    if (kind === 'offside') return clip.marks.offside?.t ?? clip.info.climax;
    if (kind === 'foul') return (clip.marks.foul?.t ?? clip.info.climax) + 0.05;
    if (kind === 'shot') {
      if (clip.marks.offside) return clip.marks.offside.t;
      if (ev.outcome === 'goal' || ev.outcome === 'woodwork') return (clip.marks.shot?.t ?? clip.info.climax) + Math.min(0.35, (clip.marks.shot?.dur || 0.5) * 0.55);
      return (clip.marks.saveT ?? clip.info.climax) - 0.05;
    }
    return clip.info.climax;
  }
  function momentTitle(ev, kind) {
    if (kind === 'shot') {
      if (ev.outcome === 'goal') return ev.ownGoal ? `Own goal — ${ev.og}` : `${ev.technique === 'penalty' ? 'Penalty goal' : 'Goal'} — ${ev.player}`;
      if (ev.outcome === 'disallowed') return `Disallowed — ${ev.player}`;
      if (ev.outcome === 'woodwork') return `Woodwork — ${ev.player}`;
      const opp = ev.side === 'A' ? 'B' : 'A';
      const gk = M0.teams[opp]?.players.find(p => p.role === 'GK')?.name;
      return gk ? `Save — ${surname(gk)} denies ${surname(ev.player)}` : `Save — ${ev.player}`;
    }
    if (kind === 'foul') return ev.penalty ? `Penalty — ${ev.player || ''}` : `${ev.card === 'yellow' ? 'Booking' : 'Red card'} — ${ev.offender}`;
    if (kind === 'offside') return `Offside — ${ev.player}`;
    return ev.text || kind;
  }

  function varScene(ev, idx, min, add) {
    const st = built.state;
    const last = [...built.scenes].reverse().find(s => s.kind === 'clip');
    const sc = push({ kind: 'var', ev, idx, dur: 4200, min, add, scoreBefore: [...st.score], clip: last?.clip, M: last?.M, at: last ? last.clip.dur - 0.2 : 0 });
    built.tl.push({ start: sc.start, end: sc.start + sc.dur, kind: 'ev', type: 'var', itemIndex: idx, side: ev.side || null, minute: minuteStr(min, add) });
  }

  async function halfTime(ev, idx, min, add, synthetic) {
    const st = built.state;
    if (st.htDone) return;
    await ensureKickoff();
    st.htDone = true;
    const M = C.withHalf(M0, 1);
    const wh = await build(1, { type: 'half_time', text: ev.text }, { kind: 'whistle', seed: 77, sent: new Set(st.sent) });
    const sc = push({ kind: 'clip', clip: wh, ev: { ...ev, type: 'half_time' }, idx, M, half: 1, dur: Math.round(wh.dur * 1000), min: 45, add: add || 0, scoreBefore: [...st.score], climax: 1.6, isWipe: true });
    if (idx >= 0) built.tl.push({ start: sc.start + 1200, end: sc.start + sc.dur, kind: 'ev', type: 'half_time', itemIndex: idx, side: null, minute: minuteStr(45, add) });
    push({ kind: 'ht', dur: 8000, score: [...st.score], stats: JSON.parse(JSON.stringify(st.ev)), goals: [...st.goals], cards: [...st.cards] });
    push({ kind: 'switch', dur: 3200 });
    st.half = 2; st.setup = null; st.lastRendered = 46;
    const ko = st.firstKick === 'A' ? 'B' : 'A';
    const M2 = C.withHalf(M0, 2);
    const k = await build(2, { side: ko }, { kind: 'kickoff', seed: 99, sent: new Set(st.sent) });
    push({ kind: 'clip', clip: k, ev: { type: 'second_half', side: ko, min: 46, add: 0, text: `Second half under way — ${TEAMS[ko].name} kick off.` }, idx: -1, M: M2, half: 2, dur: Math.round(k.dur * 1000), min: 46, add: 0, scoreBefore: [...st.score], climax: 1, isWipe: false });
  }
  async function fullTime(ev, idx, min, add) {
    const st = built.state;
    if (st.ftStart != null) return;
    await ensureKickoff();
    if (!st.htDone) await halfTime({ type: 'half_time', min: 45, add: 0 }, -1, 45, 0, true);
    const M = C.withHalf(M0, 2);
    const winner = st.score[0] > st.score[1] ? 'A' : st.score[1] > st.score[0] ? 'B' : null;
    st.ftStart = 'building';
    const wh = await build(2, { type: 'full_time', winner, text: ev.text }, { kind: 'whistle', seed: 88, sent: new Set(st.sent) });
    const sc = push({ kind: 'clip', clip: wh, ev: { ...ev, type: 'full_time' }, idx, M, half: 2, dur: Math.round(wh.dur * 1000), min: 90, add: add || 0, scoreBefore: [...st.score], climax: 1.6, isWipe: true });
    st.ftWhistle = sc.start + 1500;
    if (idx >= 0) built.tl.push({ start: sc.start + 1500, end: sc.start + sc.dur, kind: 'ev', type: 'full_time', itemIndex: idx, side: null, minute: minuteStr(90, add) });
    st.ftStart = 'pending';
    maybeFT();
  }
  function maybeFT(force) {
    const st = built.state;
    if (st.ftStart !== 'pending' || (!stats && !force)) return;
    const sc = push({ kind: 'ft', dur: 9000, score: [...st.score], goals: [...st.goals], cards: [...st.cards], ev: JSON.parse(JSON.stringify(st.ev)) });
    st.ftStart = sc.start;
    built.tl.push({ start: sc.start, end: sc.start + sc.dur, kind: 'fulltime', type: 'fulltime', itemIndex: -1, side: null, minute: 'FT' });
  }
  async function buildOutro() {
    const st = built.state;
    if (st.outro) return;
    if (st.ftStart == null) await fullTime({ type: 'full_time', min: 90, add: 0 }, -1, 90, 0);
    if (st.ftStart === 'pending') maybeFT(true);
    st.outro = true;
    const s0 = st.t;
    if (stats?.motm) push({ kind: 'motm', dur: 6500 });
    if (ratings) push({ kind: 'ratings', dur: 7000 });
    if (analysis.A) push({ kind: 'analysis', side: 'A', dur: 9500 });
    if (analysis.B) push({ kind: 'analysis', side: 'B', dur: 9500 });
    if (built.moments.length) push({ kind: 'montage', dur: 7000 });
    push({ kind: 'end', dur: 4500 });
    built.tl.push({ start: s0, end: st.t, kind: 'outro', type: 'outro', itemIndex: -1, side: null, minute: 'FT' });
  }

  // ---------------------------------------------------------------- looks & kits
  function makeKits(T) {
    const GK = ['#22c55e', '#facc15', '#a855f7', '#f97316', '#06b6d4', '#ec4899', '#111827'];
    const used = [T.A.color, T.B.color];
    const gk = [];
    for (const c of GK) { if (used.every(u => colorDist(u, c) > 120) && gk.every(g => colorDist(g, c) > 120)) gk.push(c); if (gk.length === 2) break; }
    const team = c => ({ shirt: c, shorts: lum(c) > 0.62 ? '#111827' : '#f1f5f9', socks: c, numColor: lum(c) > 0.62 ? '#111827' : '#ffffff', trim: lum(c) > 0.62 ? '#111827' : 'rgba(255,255,255,0.5)' });
    const refShirt = used.some(u => lum(u) < 0.2) ? '#facc15' : '#111111';
    return {
      A: team(T.A.color), B: team(T.B.color),
      gkA: { ...team(gk[0] || '#22c55e'), shorts: '#111827', socks: gk[0] || '#22c55e' },
      gkB: { ...team(gk[1] || '#facc15'), shorts: '#111827', socks: gk[1] || '#facc15' },
      ref: { shirt: refShirt, shorts: '#111111', socks: '#111111', numColor: '#fff' },
    };
  }
  function agentLook(a) {
    if (a >= 22) return { ...kits.ref, skin: ['#c8956b', '#e0b48f', '#8d5a3b'][a - 22], hair: ['#2b1d14', '#3b2a1e', '#111111'][a - 22], num: null, boots: '#111111', foot: 'right', height: [1.82, 1.78, 1.80][a - 22] };
    const side = a < 11 ? 'A' : 'B';
    const slot = a - (side === 'A' ? 0 : 11);
    const p = TEAMS[side].players[slot];
    const role = M0.teams[side].players[slot].role;
    const kit = role === 'GK' ? kits['gk' + side] : kits[side];
    const lk = looks.get(p.id) || { skin: '#c8956b', hair: '#2b1d14' };
    const gk = role === 'GK';
    return { ...kit, skin: lk.skin, hair: lk.hair, num: p.num ?? slot + 1, name: p.name, id: p.id, side, foot: p.foot || 'right', height: p.height ? p.height / 100 : 1.8,
      boots: ['#111111', '#f8fafc', '#facc15', '#ef4444', '#22d3ee'][(Number(p.id) || slot) % 5], gloves: gk ? '#f8fafc' : null, longSleeve: gk };
  }
  let lookCache = null, lookVersion = 0;
  const allLooks = () => (lookCache ||= (lookVersion++, Array.from({ length: 25 }, (_, a) => agentLook(a))));
  function use3D() {
    if (!stage3d || (typeof window !== 'undefined' && window.__force2D)) return null;
    const lk = allLooks();
    stage3d.setCast(`${TEAMS.A.name}|${TEAMS.B.name}|${TEAMS.A.color}|${TEAMS.B.color}|${looks.size}|${photoImgs.size}`, lk, photoImgs,
      { texts: [TEAMS.A.name.toUpperCase(), TEAMS.B.name.toUpperCase(), 'SÜPER LIG MIX'], colors: [TEAMS.A.color, TEAMS.B.color] });
    return stage3d;
  }

  // ---------------------------------------------------------------- frame rendering
  const scratch = Array.from({ length: 26 }, () => ({}));
  const pj = [0, 0, 0];
  const smooth = x => x * x * (3 - 2 * x);
  // Average an agent's position over a short window (steady close-up cameras).
  function avgPos(c, ag, ct, win = 0.5) {
    let x = 0, y = 0, n = 0;
    for (let tt = ct - win; tt <= ct + win; tt += 0.1) { const k = clamp(Math.round(tt * HZ), 0, c.N - 1); x += c.pos[(k * 25 + ag) * 2]; y += c.pos[(k * 25 + ag) * 2 + 1]; n++; }
    return { x: x / n, y: y / n };
  }
  function clipCamera(sc, ct, mode) {
    const c = sc.clip, f = clamp(ct * HZ, 0, c.N - 1), i = Math.floor(f), j = Math.min(i + 1, c.N - 1), a = f - i;
    const bx = lerp(c.ball[i * 3], c.ball[j * 3], a), by = lerp(c.ball[i * 3 + 1], c.ball[j * 3 + 1], a);
    if (mode === 'live') {
      const m = c.marks;
      // Celebration: cut to a close camera on the scorer.
      if (m.goalT != null && m.celebrate && ct > m.goalT + 1.3) {
        const p = avgPos(c, m.celebrate.scorer, ct, 0.6);
        return D.camera([p.x + 7.5, p.y + 11.5, 3.9], [p.x, p.y, 1.05], 34);
      }
      // Booking: close on the referee and the player.
      if (m.card && ct > m.card.t - 0.3 && ct < m.card.t + 2.5) {
        const r = avgPos(c, C.REF, ct, 0.4), o = m.card.agent != null ? avgPos(c, m.card.agent, ct, 0.4) : r;
        const x = (r.x + o.x) / 2, y = (r.y + o.y) / 2;
        return D.camera([x + 6, y + 12, 4.4], [x, y, 1.1], 36);
      }
      let cx = lerp(c.cam[i * 2], c.cam[j * 2], a), z = lerp(c.cam[i * 2 + 1], c.cam[j * 2 + 1], a);
      // Shot: push in towards the goal so the ball hitting the net is clearly visible.
      if (m.shot) {
        const ts = m.shot.t, te = (m.goalT ?? (ts + m.shot.dur)) + 1.1;
        const w = ct < ts ? smooth(clamp((ct - (ts - 1.1)) / 0.9, 0, 1)) : ct > te ? 1 - smooth(clamp((ct - te) / 0.7, 0, 1)) : 1;
        if (w > 0) {
          // Frame the goal mouth itself (the push-in may go right to the end of the pitch).
          const gx = m.shot.to.x > C.L / 2 ? C.L - 11.5 : 11.5;
          cx = lerp(cx, gx, w); z = lerp(z, 1.55, w);
        }
      }
      if (m.foul) {
        const w = Math.max(0, 1 - Math.abs(ct - m.foul.t) / 1.6);
        if (w > 0) { cx = lerp(cx, clamp(m.foul.at.x, 21, 84), smooth(w)); z = lerp(z, 1.4, smooth(w)); }
      }
      return D.broadcastCam(cx, z, lookY(c, ct));
    }
    if (mode === 'goal') {
      const side = sc.ev.side || 'A', dir = sc.M.dir[side];
      return D.behindGoalCam(dir > 0 ? C.L : 0, by);
    }
    if (mode === 'reverse') return D.reverseCam(bx, by);
    if (mode === 'close') return D.closeCam(bx, by, 1);
    const cx = lerp(c.cam[i * 2], c.cam[j * 2], a), z = lerp(c.cam[i * 2 + 1], c.cam[j * 2 + 1], a);
    return D.broadcastCam(cx, z, lookY(c, ct));
  }
  // The main camera tilts gently towards the ball's side of the pitch (smoothed over ~1.5 s).
  function lookY(c, ct) {
    let y = 0, w = 0;
    for (let k = -8; k <= 8; k++) {
      const tt = clamp(ct + k * 0.1, 0, c.dur), f = Math.min(c.N - 1, Math.round(tt * HZ)), ww = 1 - Math.abs(k) / 9;
      y += c.ball[f * 3 + 1] * ww; w += ww;
    }
    return 29 + (y / w - 34) * 0.5;
  }

  function drawClip(ctx, sc, ct, mode, opts = {}) {
    const c = sc.clip;
    ct = clamp(ct, 0, c.dur - 0.001);
    const cam = clipCamera(sc, ct, mode);
    const f = ct * HZ, i = Math.min(Math.floor(f), c.N - 1), j = Math.min(i + 1, c.N - 1), a = f - Math.floor(f);
    const S3 = use3D();
    const goalT = c.marks.goalT, net = c.marks.netAt;
    if (S3) {
      const ripple = goalT != null && ct > goalT && net ? { x: net.x, at: net, t: ct - goalT } : null;
      S3.draw(ctx, cam, c, ct, { ripple, looks: allLooks() });
    } else {
      D.drawStadium(ctx, cam, ct);
      D.drawPitch(ctx, cam);
      // Goals (net ripple after a goal)
      for (const gx of [0, C.L]) {
        let ripple = null;
        if (goalT != null && ct > goalT && net && Math.abs(net.x - gx) < 1) ripple = { at: net, t: ct - goalT };
        D.drawGoal(ctx, cam, gx, ripple);
      }
    }
    // Agents + ball, depth-sorted
    const L = allLooks();
    const items = [];
    for (let ag = 0; ag < 25; ag++) {
      const o = (i * 25 + ag), o2 = (j * 25 + ag);
      const x = lerp(c.pos[o * 2], c.pos[o2 * 2], a), y = lerp(c.pos[o * 2 + 1], c.pos[o2 * 2 + 1], a);
      if (x < -20) continue;
      const pi = Math.max(0, i - 2), pj2 = Math.min(c.N - 1, i + 2);
      const vx = (c.pos[(pj2 * 25 + ag) * 2] - c.pos[(pi * 25 + ag) * 2]) / ((pj2 - pi) / HZ || 1);
      const vy = (c.pos[(pj2 * 25 + ag) * 2 + 1] - c.pos[(pi * 25 + ag) * 2 + 1]) / ((pj2 - pi) / HZ || 1);
      const s = scratch[ag];
      let dh = c.hd[o2] - c.hd[o]; if (dh > Math.PI) dh -= 2 * Math.PI; if (dh < -Math.PI) dh += 2 * Math.PI;
      const sp = Math.hypot(vx, vy);
      const k0 = Math.max(0, i - 4), k1 = Math.min(c.N - 1, i + 4);
      const sp0 = Math.hypot(c.pos[(Math.min(c.N - 1, k0 + 1) * 25 + ag) * 2] - c.pos[(k0 * 25 + ag) * 2], c.pos[(Math.min(c.N - 1, k0 + 1) * 25 + ag) * 2 + 1] - c.pos[(k0 * 25 + ag) * 2 + 1]) * HZ;
      const sp1 = Math.hypot(c.pos[(k1 * 25 + ag) * 2] - c.pos[(Math.max(0, k1 - 1) * 25 + ag) * 2], c.pos[(k1 * 25 + ag) * 2 + 1] - c.pos[(Math.max(0, k1 - 1) * 25 + ag) * 2 + 1]) * HZ;
      s.ag = ag; s.idx = ag; s.x = x; s.y = y; s.vx = vx; s.vy = vy; s.v = sp; s.acc = (sp1 - sp0) / ((k1 - k0) / HZ || 1);
      s.hd = c.hd[o] + dh * a; s.ph = lerp(c.ph[o], c.ph[o2], a);
      s.st = c.st[o]; s.stT = c.stT[o] + (c.st[o] === c.st[o2] ? a / HZ : 0);
      D.project(cam, x, y, 0, pj); s.sx = pj[0]; s.sy = pj[1]; s.depth = pj[2];
      if (S3) { D.project(cam, x, y, (L[ag].height || 1.8), pj); s.hx = pj[0]; s.hy = pj[1] + 8; }
      else s.hx = null;
      items.push(s);
    }
    const ball = scratch[25];
    ball.ag = -1; ball.x = lerp(c.ball[i * 3], c.ball[j * 3], a); ball.y = lerp(c.ball[i * 3 + 1], c.ball[j * 3 + 1], a); ball.z = lerp(c.ball[i * 3 + 2], c.ball[j * 3 + 2], a);
    D.project(cam, ball.x, ball.y, 0, pj); ball.depth = pj[2] - 0.3;
    let carrier = -1, cd = 1.3;
    for (const s of items) if (s.ag >= 0 && s.ag < 22 && ball.z < 0.6) { const d = Math.hypot(s.x - ball.x, s.y - ball.y); if (d < cd) { cd = d; carrier = s.ag; } }
    items.push(ball);
    if (!S3) {
      items.sort((p, q) => q.depth - p.depth);
      for (const s of items) {
        if (s.ag < 0) { D.drawBall(ctx, cam, s.x, s.y, s.z, (s.x + s.y) * 1.3); continue; }
        if (s.sx < -60 || s.sx > W + 60) continue;
        s.look = L[s.ag];
        s.diveY = s.st === C.S.DIVE_L ? -1 : 1;
        const hp = D.drawRig(ctx, cam, s, ct);
        s.hx = hp[0]; s.hy = hp[1];
      }
    }
    // Name tag over the ball carrier (broadcast style)
    if (!opts.noTags && carrier >= 0) {
      const s = items.find(q => q.ag === carrier);
      const lk = L[carrier];
      if (s && s.hx != null) D.drawTag(ctx, s.hx, s.hy + 2.05 * D.scaleAt(cam, s.x, s.y) - 6, D.scaleAt(cam, s.x, s.y), `${lk.num ?? ''} ${surname(lk.name)}`.trim(), lk.side === 'A' ? TEAMS.A.color : TEAMS.B.color);
    }
    return { cam, items, ball, i, S3 };
  }

  // ---------------------------------------------------------------- HUD
  function scoreAt(sc, t) {
    const s = [...(sc.scoreBefore || [0, 0])];
    if (sc.goalAt != null && t >= sc.goalAt) s[sc.ev.side === 'B' ? 1 : 0]++;
    return s;
  }
  function clockText(sc, ct) {
    const base = (sc.min - 1) * 60 + 25;
    let sec = Math.max(0, base + (ct - (sc.climax || 0)));
    if (sc.min >= 45 && sc.min < 46 || sc.min >= 90) sec = Math.min(sec, sc.min * 60 - 1 + (sc.add ? 59 : 0));
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    if (sc.add && (sc.min === 45 || sc.min === 90)) return `${sc.min}:00`;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  function scorebug(ctx, sc, t, ct) {
    const s = scoreAt(sc, t);
    const x = 26, y = 22, h = 34;
    ctx.save();
    ctx.fillStyle = 'rgba(6,10,8,0.88)';
    D.roundRect(ctx, x, y, 270, h, 7); ctx.fill();
    ctx.fillStyle = TEAMS.A.color; ctx.fillRect(x + 8, y + 9, 5, 16);
    ctx.fillStyle = TEAMS.B.color; ctx.fillRect(x + 160, y + 9, 5, 16);
    ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.font = `800 15px ${FONT}`;
    ctx.fillText(short3(TEAMS.A.name), x + 19, y + h / 2 + 1);
    ctx.fillText(short3(TEAMS.B.name), x + 171, y + h / 2 + 1);
    // score box
    const pulse = sc.goalAt != null && t >= sc.goalAt && t < sc.goalAt + 1200 ? 1 + Math.sin(((t - sc.goalAt) / 1200) * Math.PI) * 0.18 : 1;
    ctx.save(); ctx.translate(x + 113, y + h / 2);
    ctx.scale(pulse, pulse);
    ctx.fillStyle = '#f8fafc'; D.roundRect(ctx, -34, -13, 68, 26, 5); ctx.fill();
    ctx.fillStyle = '#0b100d'; ctx.font = `900 17px ${FONT}`; ctx.textAlign = 'center';
    ctx.fillText(`${s[0]} – ${s[1]}`, 0, 1);
    ctx.restore();
    ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(x + 212, y + 6, 1, h - 12);
    ctx.fillStyle = '#fff'; ctx.font = `700 15px ${FONT}`; ctx.textAlign = 'left';
    ctx.fillText(clockText(sc, ct), x + 220, y + h / 2 + 1);
    if (sc.add && (sc.min === 45 || sc.min === 90)) {
      ctx.fillStyle = '#16a34a'; D.roundRect(ctx, x + 276, y + 6, 34, 22, 4); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = `800 13px ${FONT}`; ctx.textAlign = 'center'; ctx.fillText(`+${sc.add}`, x + 293, y + 17.5);
    }
    // Red cards
    const reds = built.state ? built.state.cards.filter(c => c.color === 'red') : [];
    ctx.restore();
  }
  const ICON = { goal: '⚽', shot: '🎯', corner: '⚑', freekick: '◎', penalty: '◉', foul: '✕', yellow: '▮', red: '▮', offside: '⚐', var: 'VAR', injury: '+', kickoff: '▶', flow: '↔', post: '▯', goalkick: '↗', counter: '⚡', ht: '⏸', ft: '⏹' };
  function lowerThird(ctx, sc, ct) {
    const caps = sc.clip.marks.captions;
    let cap = null;
    for (const c of caps) if (ct >= c.t && ct < c.t + 3.4) cap = c;
    if (!cap || !cap.text) return null;
    const p = clamp((ct - cap.t) / 0.35, 0, 1), q = clamp((cap.t + 3.4 - ct) / 0.35, 0, 1);
    const alpha = Math.min(p, q), slide = (1 - easeOut(p)) * 30;
    const w = 860, x = (W - w) / 2, y = H - 92 + slide;
    ctx.save(); ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(6,10,8,0.86)'; D.roundRect(ctx, x, y, w, 56, 10); ctx.fill();
    const side = sc.ev?.side;
    ctx.fillStyle = side === 'B' ? TEAMS.B.color : side === 'A' ? TEAMS.A.color : '#16a34a';
    D.roundRect(ctx, x + 10, y + 10, 64, 36, 7); ctx.fill();
    ctx.fillStyle = lum(ctx.fillStyle) > 0.62 ? '#111' : '#fff';
    ctx.font = `900 16px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(minuteStr(sc.min, sc.add), x + 42, y + 28.5);
    if (cap.icon === 'yellow' || cap.icon === 'red') { ctx.fillStyle = cap.icon === 'red' ? '#ef1c1c' : '#ffd400'; ctx.fillRect(x + 88, y + 15, 17, 25); }
    const tx = cap.icon === 'yellow' || cap.icon === 'red' ? x + 118 : x + 90;
    const lines = wrap(cap.text, 650, fit(cap.text, 650, 19, w - (tx - x) - 20, 14), w - (tx - x) - 20, 2);
    ctx.fillStyle = '#f8fafc'; ctx.textAlign = 'left';
    const fs = fit(lines[0], 650, 19, w - (tx - x) - 20, 14);
    ctx.font = `650 ${fs}px ${FONT}`;
    lines.forEach((ln, i) => ctx.fillText(ln, tx, y + 28.5 + (i - (lines.length - 1) / 2) * (fs + 3)));
    ctx.restore();
    return cap;
  }
  function wipe(ctx, p, sc) {
    // Broadcast stinger: diagonal bands sweeping across.
    if (p <= 0 || p >= 1) return;
    const e = easeInOut(p);
    ctx.save();
    const cols = [TEAMS.A.color, '#f8fafc', TEAMS.B.color];
    cols.forEach((col, i) => {
      const off = (e * 2.4 - 0.7 - i * 0.12) * (W + 600);
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.moveTo(off - 300, 0); ctx.lineTo(off + 120, 0); ctx.lineTo(off - 180, H); ctx.lineTo(off - 600, H); ctx.closePath(); ctx.fill();
    });
    if (p > 0.35 && p < 0.7 && sc) {
      ctx.fillStyle = '#0b100d'; ctx.font = `italic 900 54px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.globalAlpha = Math.sin(((p - 0.35) / 0.35) * Math.PI);
      ctx.fillText(minuteStr(sc.min, sc.add), W / 2, H / 2);
    }
    ctx.restore();
  }
  function photoCircle(ctx, id, x, y, r, ring) {
    const img = photos.get(id);
    ctx.save();
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.closePath();
    ctx.fillStyle = '#1d2722'; ctx.fill();
    if (img && img.width) {
      ctx.clip();
      const s = (r * 2) / img.width;
      ctx.drawImage(img, x - r, y - r * 0.9, r * 2, img.height * s);
    }
    ctx.restore();
    if (ring) { ctx.strokeStyle = ring; ctx.lineWidth = Math.max(2, r * 0.08); ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke(); }
  }
  const playerByName = (side, name) => {
    const a = C.findAgent(M0, side, name);
    return a == null ? null : TEAMS[side].players[a - (side === 'A' ? 0 : 11)];
  };

  function goalGraphic(ctx, sc, ct) {
    const g = sc.clip.marks.goalT;
    if (g == null || ct < g + 0.25) return;
    const p = (ct - g - 0.25);
    if (p > 4.4) return;
    const side = sc.ev.side, col = TEAMS[side].color;
    const disallowed = sc.ev.outcome === 'disallowed';
    if (disallowed && p > 1.3) return;
    ctx.save();
    const inP = clamp(p / 0.45, 0, 1), outP = clamp((4.4 - p) / 0.4, 0, 1);
    ctx.globalAlpha = Math.min(1, outP);
    // Big kinetic GOAL
    const letters = 'GOAL'.split('');
    ctx.font = `italic 950 150px ${FONT}`;
    ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    const tw = ctx.measureText('GOAL').width;
    let x = W / 2 - tw / 2;
    letters.forEach((ch, i) => {
      const lp = clamp((p - i * 0.07) / 0.4, 0, 1);
      const s = lp < 1 ? backOut(lp) : 1;
      const w = ctx.measureText(ch).width;
      ctx.save();
      ctx.translate(x + w / 2, H / 2 - 40 + (1 - lp) * 60);
      ctx.scale(s, s);
      ctx.lineWidth = 14; ctx.strokeStyle = '#ffffff'; ctx.lineJoin = 'round'; ctx.strokeText(ch, 0, 0);
      ctx.fillStyle = col; ctx.fillText(ch, 0, 0);
      ctx.restore();
      x += w;
    });
    if (disallowed) { ctx.restore(); return; }
    // Scorer card
    const pl = playerByName(side, sc.ev.ownGoal ? null : sc.ev.player);
    const cp = clamp((p - 0.5) / 0.5, 0, 1);
    const cy = H - 150 + (1 - easeOut(cp)) * 80;
    ctx.globalAlpha = Math.min(outP, cp);
    ctx.fillStyle = 'rgba(6,10,8,0.9)'; D.roundRect(ctx, W / 2 - 300, cy, 600, 96, 14); ctx.fill();
    ctx.fillStyle = col; ctx.fillRect(W / 2 - 300, cy, 8, 96);
    if (pl) photoCircle(ctx, pl.id, W / 2 - 240, cy + 48, 38, col);
    ctx.fillStyle = '#fff'; ctx.textAlign = 'left';
    const nm = sc.ev.ownGoal ? `${sc.ev.og} (own goal)` : sc.ev.player || '';
    ctx.font = `900 ${fit(nm, 900, 30, 400, 16)}px ${FONT}`; ctx.fillText(nm, W / 2 - 186, cy + 36);
    ctx.fillStyle = '#cfdad4'; ctx.font = `600 16px ${FONT}`;
    const sub = `${minuteStr(sc.min, sc.add)} · ${sc.ev.technique === 'penalty' ? 'Penalty' : sc.ev.body === 'head' ? 'Header' : sc.ev.technique === 'free_kick' ? 'Free kick' : (sc.ev.body === 'left' ? 'Left foot' : 'Right foot')}${sc.ev.assist ? ` · assist ${sc.ev.assist}` : ''}`;
    ctx.fillText(sub, W / 2 - 186, cy + 66);
    ctx.restore();
  }
  function cardGraphic(ctx, sc, ct) {
    const cm = sc.clip.marks.card;
    if (!cm || ct < cm.t || ct > cm.t + 3.2) return;
    const p = ct - cm.t;
    const side = sc.ev.side === 'A' ? 'B' : 'A';
    const pl = playerByName(side, sc.ev.offender);
    const a = Math.min(clamp(p / 0.3, 0, 1), clamp((3.2 - p) / 0.3, 0, 1));
    ctx.save(); ctx.globalAlpha = a;
    const x = W - 400, y = 90;
    ctx.fillStyle = 'rgba(6,10,8,0.9)'; D.roundRect(ctx, x, y, 360, 90, 12); ctx.fill();
    const flip = Math.abs(Math.cos(clamp(p / 0.5, 0, 1) * Math.PI)) ;
    ctx.save(); ctx.translate(x + 40, y + 45); ctx.scale(Math.max(0.15, 1 - flip * 0.85 * (p < 0.5 ? 1 : 0)), 1);
    ctx.fillStyle = cm.color === 'red' ? '#ef1c1c' : '#ffd400'; D.roundRect(ctx, -15, -24, 30, 46, 4); ctx.fill();
    if (cm.second) { ctx.fillStyle = '#ffd400'; D.roundRect(ctx, -22, -28, 30, 46, 4); ctx.fill(); ctx.fillStyle = '#ef1c1c'; D.roundRect(ctx, -10, -20, 30, 46, 4); ctx.fill(); }
    ctx.restore();
    if (pl) photoCircle(ctx, pl.id, x + 105, y + 45, 30, TEAMS[side].color);
    ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const nm = sc.ev.offender || '';
    ctx.font = `800 ${fit(nm, 800, 21, 210, 12)}px ${FONT}`; ctx.fillText(nm, x + 146, y + 34);
    ctx.fillStyle = cm.color === 'red' ? '#fca5a5' : '#fde68a'; ctx.font = `700 14px ${FONT}`;
    ctx.fillText(cm.second ? 'Second yellow — sent off' : cm.color === 'red' ? 'Sent off' : 'Booked', x + 146, y + 60);
    ctx.restore();
  }

  // ---------------------------------------------------------------- freeze-frame analysis image
  function drawFreeze(ctx, sc, local) {
    const c = sc.clip, at = sc.at;
    const { cam, items, S3 } = drawClip(ctx, sc, at, 'live', { noTags: true });
    const p = clamp(local / 600, 0, 1);
    // Dim + vignette
    ctx.fillStyle = `rgba(0,0,0,${0.38 * p})`; ctx.fillRect(0, 0, W, H);
    const side = sc.ev.side || 'A', col = TEAMS[side].color, opp = side === 'A' ? 'B' : 'A';
    const agentAt = ag => { const s = items.find(q => q.ag === ag); return s ? { x: s.x, y: s.y } : null; };
    ctx.globalAlpha = p;
    // Passing move into this moment
    const passes = c.marks.passes.filter(ps => ps.t0 <= at + 0.05 && ps.t0 >= at - 9).slice(-4);
    passes.forEach((ps, i) => {
      const from = posAt(c, ps.from, ps.t0), to = ps.target;
      if (from) D.worldArrow(ctx, cam, from, to, i === passes.length - 1 ? '#ffd34d' : 'rgba(255,255,255,0.85)', { dashed: i !== passes.length - 1, loft: ps.loft ? Math.min(ps.loft, 6) * 0.35 : 0, width: i === passes.length - 1 ? 4 : 3 });
    });
    const shot = c.marks.shot;
    if (shot && sc.ev.type === 'shot') D.worldArrow(ctx, cam, posAt(c, shot.agent, shot.t) || shot.from, shot.to, '#ff4d57', { width: 4.5 });
    // Offside line
    const off = c.marks.offside;
    if (off) {
      const tk = Math.round(off.t * HZ);
      const defSide = off.sideAtt === 'A' ? 'B' : 'A';
      const lineX = defSide === (sc.M.dir.A > 0 ? 'B' : 'A') ? c.offX[tk * 2 + 1] : c.offX[tk * 2];
      D.worldLine(ctx, cam, lineX, -1, lineX, C.WD + 1, '#38bdf8', 3.5);
      const rp = posAt(c, off.runner, off.t);
      if (rp) { D.worldLine(ctx, cam, rp.x, -1, rp.x, C.WD + 1, '#ff4d57', 3, [10, 7]); }
      D.project(cam, lineX, 2, 0, pj);
      ctx.fillStyle = '#38bdf8'; ctx.font = `800 13px ${FONT}`; ctx.textAlign = 'center';
      ctx.fillText('LAST DEFENDER', pj[0], pj[1] - 8);
    }
    // Spotlights + chips on the protagonists
    const prot = (c.info.protagonists || []).filter(a => a != null).slice(0, 3);
    // Lift the protagonists out of the dimmed picture.
    if (S3) { ctx.globalAlpha = 1; S3.draw(ctx, cam, c, at, { only: new Set(prot), transparent: true, looks: allLooks() }); ctx.globalAlpha = p; }
    prot.forEach((ag, i) => {
      const s = items.find(q => q.ag === ag); if (!s) return;
      const sCol = ag < 11 ? TEAMS.A.color : TEAMS.B.color;
      D.spotlight(ctx, cam, s.x, s.y, i === 0 ? '#ffd34d' : '#ffffff', Math.sin(local / 180) * 0.5 + 0.5);
      const lk = allLooks()[ag];
      // redraw the figure over the dim
      const k = D.scaleAt(cam, s.x, s.y);
      if (!S3) D.drawRig(ctx, cam, s, at);
      chip(ctx, s.sx, s.sy - 2.2 * k - 46, lk, sCol, i === 0);
    });
    ctx.globalAlpha = 1;
    // Title banner
    const bp = clamp((local - 250) / 450, 0, 1);
    const bx = 30 - (1 - easeOut(bp)) * 360;
    ctx.save(); ctx.globalAlpha = bp;
    ctx.fillStyle = 'rgba(6,10,8,0.92)'; D.roundRect(ctx, bx, H - 132, 620, 100, 12); ctx.fill();
    ctx.fillStyle = col; ctx.fillRect(bx, H - 132, 7, 100);
    ctx.fillStyle = '#9fb7a8'; ctx.font = `800 12px ${FONT}`; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(`HOW IT HAPPENED · ${minuteStr(sc.min, sc.add)}`, bx + 22, H - 106);
    const title = momentTitle(sc.ev, sc.ev.type === 'shot' ? 'shot' : sc.ev.type);
    ctx.fillStyle = '#fff'; ctx.font = `900 ${fit(title, 900, 26, 570, 15)}px ${FONT}`; ctx.fillText(title, bx + 22, H - 78);
    const desc = wrap(sc.ev.text || '', 500, 15, 570, 2);
    ctx.fillStyle = '#cfdad4'; ctx.font = `500 15px ${FONT}`;
    desc.forEach((ln, i) => ctx.fillText(ln, bx + 22, H - 55 + i * 19));
    ctx.restore();
    // Tactical mini-map (top-down)
    miniMap(ctx, sc, at, W - 330, 26, 300, 196, bp);
    // "ANALYSIS" bug
    ctx.save(); ctx.globalAlpha = p;
    ctx.fillStyle = '#ffd34d'; D.roundRect(ctx, 26, 24, 118, 30, 6); ctx.fill();
    ctx.fillStyle = '#111'; ctx.font = `900 14px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('◉ ANALYSIS', 85, 39.5);
    ctx.restore();
  }
  function posAt(c, ag, t) {
    if (ag == null || ag < 0) return null;
    const k = clamp(Math.round(t * HZ), 0, c.N - 1);
    return { x: c.pos[(k * 25 + ag) * 2], y: c.pos[(k * 25 + ag) * 2 + 1] };
  }
  function chip(ctx, x, y, lk, col, main) {
    ctx.save();
    ctx.font = `800 13px ${FONT}`;
    const name = surname(lk.name);
    const w = ctx.measureText(name).width + 50;
    ctx.fillStyle = 'rgba(6,10,8,0.92)'; D.roundRect(ctx, x - w / 2, y - 17, w, 34, 17); ctx.fill();
    ctx.strokeStyle = main ? '#ffd34d' : col; ctx.lineWidth = 2; ctx.stroke();
    photoCircle(ctx, lk.id, x - w / 2 + 17, y, 13, col);
    ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(name, x - w / 2 + 36, y + 1);
    ctx.restore();
  }
  function miniMap(ctx, sc, at, x, y, w, h, alpha) {
    const c = sc.clip;
    ctx.save(); ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(6,10,8,0.9)'; D.roundRect(ctx, x - 8, y - 8, w + 16, h + 34, 10); ctx.fill();
    ctx.fillStyle = '#1f6b37'; ctx.fillRect(x, y, w, h);
    const sx = v => x + (v / C.L) * w, sy = v => y + (v / C.WD) * h;
    ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1;
    ctx.strokeRect(x, y, w, h);
    ctx.beginPath(); ctx.moveTo(sx(C.L / 2), y); ctx.lineTo(sx(C.L / 2), y + h); ctx.stroke();
    ctx.beginPath(); ctx.arc(sx(C.L / 2), sy(C.WD / 2), (9.15 / C.L) * w, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeRect(x, sy(13.84), (16.5 / C.L) * w, (40.32 / C.WD) * h);
    ctx.strokeRect(sx(C.L - 16.5), sy(13.84), (16.5 / C.L) * w, (40.32 / C.WD) * h);
    const passes = c.marks.passes.filter(ps => ps.t0 <= at + 0.05).slice(-5);
    passes.forEach((ps, i) => {
      const f = posAt(c, ps.from, ps.t0); if (!f) return;
      ctx.strokeStyle = i === passes.length - 1 ? '#ffd34d' : 'rgba(255,255,255,0.8)'; ctx.lineWidth = 1.6;
      ctx.setLineDash(i === passes.length - 1 ? [] : [4, 3]);
      ctx.beginPath(); ctx.moveTo(sx(f.x), sy(f.y)); ctx.lineTo(sx(ps.target.x), sy(ps.target.y)); ctx.stroke();
    });
    ctx.setLineDash([]);
    if (c.marks.shot && sc.ev.type === 'shot') {
      const f = posAt(c, c.marks.shot.agent, c.marks.shot.t) || c.marks.shot.from;
      ctx.strokeStyle = '#ff4d57'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(sx(f.x), sy(f.y)); ctx.lineTo(sx(c.marks.shot.to.x), sy(c.marks.shot.to.y)); ctx.stroke();
    }
    const k = clamp(Math.round(at * HZ), 0, c.N - 1);
    for (let ag = 0; ag < 22; ag++) {
      const px = c.pos[(k * 25 + ag) * 2], py = c.pos[(k * 25 + ag) * 2 + 1];
      if (px < -10) continue;
      const lk = allLooks()[ag];
      ctx.fillStyle = lk.shirt; ctx.beginPath(); ctx.arc(sx(px), sy(py), 4.2, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 1; ctx.stroke();
    }
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(sx(c.ball[k * 3]), sy(c.ball[k * 3 + 1]), 2.6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#9fb7a8'; ctx.font = `700 11px ${FONT}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText('THE MOVE · top-down', x, y + h + 13);
    ctx.restore();
  }

  // ---------------------------------------------------------------- full-screen cards
  function panel(ctx, x, y, w, h, alpha = 0.9) { ctx.fillStyle = `rgba(6,10,8,${alpha})`; D.roundRect(ctx, x, y, w, h, 16); ctx.fill(); }
  function dimBackdrop(ctx, t) {
    const walk = built.scenes[0]?.clip;
    if (walk) drawClip(ctx, { clip: walk, ev: {}, M: C.withHalf(M0, 1) }, 0.5 + (t / 1000) % 6, 'broadcast', { noTags: true });
    else { ctx.fillStyle = '#0b1220'; ctx.fillRect(0, 0, W, H); }
    ctx.fillStyle = 'rgba(3,6,5,0.72)'; ctx.fillRect(0, 0, W, H);
  }
  function drawIntro(ctx, sc, local) {
    const walk = sc.clip;
    // Slow camera pan across the line-up.
    const camX = lerp(36, 69, easeInOut(clamp(local / sc.dur, 0, 1)));
    const fake = { ...walk, cam: walk.cam.map((v, i) => (i % 2 === 0 ? camX : 1.08)) };
    drawClip(ctx, { clip: fake, ev: {}, M: C.withHalf(M0, 1) }, 1 + local / 1000, 'broadcast', { noTags: true });
    const p = clamp((local - 400) / 700, 0, 1);
    ctx.fillStyle = `rgba(0,0,0,${0.35 * p})`; ctx.fillRect(0, 0, W, H);
    ctx.save(); ctx.globalAlpha = p;
    const y = 120;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#9fb7a8'; ctx.font = `800 15px ${FONT}`;
    ctx.fillText('SÜPER LIG MIX · DRAFT DUEL · NEUTRAL GROUND', W / 2, y - 50);
    const a = TEAMS.A.name, b = TEAMS.B.name;
    const s = Math.min(fit(a, 900, 58, 470, 24, true), fit(b, 900, 58, 470, 24, true));
    ctx.font = `italic 900 ${s}px ${FONT}`;
    const ax = W / 2 - 60 - (1 - easeOut(p)) * 200, bxx = W / 2 + 60 + (1 - easeOut(p)) * 200;
    ctx.textAlign = 'right'; ctx.fillStyle = '#fff'; ctx.fillText(a, ax, y);
    ctx.textAlign = 'left'; ctx.fillText(b, bxx, y);
    ctx.fillStyle = TEAMS.A.color; ctx.fillRect(ax - ctx.measureText(a).width, y + s * 0.55, ctx.measureText(a).width, 6);
    ctx.fillStyle = TEAMS.B.color; ctx.fillRect(bxx, y + s * 0.55, ctx.measureText(b).width, 6);
    ctx.textAlign = 'center'; ctx.fillStyle = '#ffd34d'; ctx.font = `italic 900 30px ${FONT}`; ctx.fillText('vs', W / 2, y + 2);
    const sub = [meta?.referee && `Referee: ${meta.referee}`, meta?.weather].filter(Boolean).join(' · ');
    ctx.fillStyle = '#cfdad4'; ctx.font = `600 16px ${FONT}`; ctx.fillText(sub || 'Simulated by GPT-6.1 Sol', W / 2, y + 66);
    if (meta?.headline) {
      const hp = clamp((local - 1500) / 700, 0, 1);
      ctx.globalAlpha = hp;
      const lines = wrap(meta.headline, 700, 20, 820, 2);
      ctx.fillStyle = '#fff'; ctx.font = `italic 700 20px ${FONT}`;
      lines.forEach((ln, i) => ctx.fillText(ln, W / 2, H - 120 + i * 26));
    }
    ctx.restore();
  }
  function drawLineup(ctx, sc, local) {
    dimBackdrop(ctx, sc.start + local);
    const side = sc.side, T = TEAMS[side], col = T.color;
    const p = clamp(local / 500, 0, 1), out = clamp((sc.dur - local) / 400, 0, 1);
    ctx.save(); ctx.globalAlpha = Math.min(p, out);
    // Header
    ctx.fillStyle = col; ctx.fillRect(60, 56, 8, 56);
    ctx.fillStyle = '#9fb7a8'; ctx.font = `800 14px ${FONT}`; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(`STARTING XI · ${T.formation}`, 84, 74);
    ctx.fillStyle = '#fff'; ctx.font = `italic 900 ${fit(T.name, 900, 40, 560, 20, true)}px ${FONT}`; ctx.fillText(T.name, 84, 108);
    const sty = meta?.styles?.[side];
    if (sty) {
      const chips = [sty.style, sty.line && `${sty.line} line`, sty.press && `${sty.press} press`, sty.tempo && `${sty.tempo} tempo`, sty.width].filter(Boolean).slice(0, 5);
      let cx = 84;
      ctx.font = `700 13px ${FONT}`;
      for (const ch of chips) { const w = ctx.measureText(ch).width + 20; ctx.fillStyle = 'rgba(255,255,255,0.1)'; D.roundRect(ctx, cx, 122, w, 26, 13); ctx.fill(); ctx.fillStyle = '#e5efe9'; ctx.fillText(ch, cx + 10, 140); cx += w + 8; }
    }
    // Formation board with photos (vertical pitch)
    const bx = 760, by = 70, bw = 380, bh = 590;
    ctx.fillStyle = '#1f6b37'; D.roundRect(ctx, bx, by, bw, bh, 10); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1.5;
    ctx.strokeRect(bx + 10, by + 10, bw - 20, bh - 20);
    ctx.beginPath(); ctx.moveTo(bx + 10, by + bh / 2); ctx.lineTo(bx + bw - 10, by + bh / 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(bx + bw / 2, by + bh / 2, 46, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeRect(bx + bw / 2 - 90, by + bh - 10 - 80, 180, 80); ctx.strokeRect(bx + bw / 2 - 90, by + 10, 180, 80);
    const f = M0.teams[side];
    T.players.forEach((pl, i) => {
      const [, fx, fy] = FORMATIONS_OF(f.formation)[i];
      const x = bx + 10 + (fx / 100) * (bw - 20), y = by + 10 + (fy / 100) * (bh - 20) - 16;
      const ap = clamp((local - 300 - i * 70) / 380, 0, 1);
      ctx.save(); ctx.globalAlpha = Math.min(p, out) * ap;
      photoCircle(ctx, pl.id, x, y, 24 * (0.6 + 0.4 * backOut(ap)), col);
      ctx.fillStyle = '#fff'; ctx.font = `800 12px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.fillText(surname(pl.name), x, y + 40);
      ctx.restore();
    });
    // List
    T.players.forEach((pl, i) => {
      const role = f.players[i].role;
      const ap = clamp((local - 200 - i * 55) / 300, 0, 1);
      const y = 186 + i * 42;
      ctx.save(); ctx.globalAlpha = Math.min(p, out) * ap; ctx.translate((1 - easeOut(ap)) * -40, 0);
      ctx.fillStyle = 'rgba(255,255,255,0.06)'; D.roundRect(ctx, 84, y - 16, 600, 36, 8); ctx.fill();
      ctx.fillStyle = col; D.roundRect(ctx, 92, y - 11, 38, 26, 6); ctx.fill();
      ctx.fillStyle = lum(col) > 0.62 ? '#111' : '#fff'; ctx.font = `900 15px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(pl.num ?? i + 1), 111, y + 2);
      ctx.fillStyle = '#9fb7a8'; ctx.font = `800 12px ${FONT}`; ctx.fillText(role, 160, y + 2);
      ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.font = `700 16px ${FONT}`; ctx.fillText(pl.name, 190, y + 2);
      ctx.fillStyle = '#9fb7a8'; ctx.textAlign = 'right'; ctx.font = `600 13px ${FONT}`; ctx.fillText(pl.club || pl.value || '', 672, y + 2);
      ctx.restore();
    });
    ctx.restore();
  }
  function drawToss(ctx, sc, local) {
    dimBackdrop(ctx, sc.start + local);
    const p = local / sc.dur;
    const flip = Math.min(1, p * 1.6);
    const ang = flip * Math.PI * 7;
    const side = sc.side;
    ctx.save();
    ctx.translate(W / 2, H / 2 - 40 - Math.sin(flip * Math.PI) * 120);
    ctx.scale(1, Math.abs(Math.cos(ang)) * 0.9 + 0.1);
    ctx.fillStyle = '#e5c158'; ctx.beginPath(); ctx.arc(0, 0, 56, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#b8902c'; ctx.lineWidth = 5; ctx.stroke();
    ctx.restore();
    if (p > 0.62) {
      ctx.save(); ctx.globalAlpha = clamp((p - 0.62) / 0.15, 0, 1);
      ctx.textAlign = 'center'; ctx.fillStyle = '#fff'; ctx.font = `900 30px ${FONT}`;
      ctx.fillText(`${TEAMS[side].name} win the toss and kick off`, W / 2, H / 2 + 110);
      ctx.restore();
    }
  }
  function statRows(ctx, rows, x, y, w) {
    rows.forEach(([label, a, b, fmt], i) => {
      const yy = y + i * 44;
      const tot = (Number(a) + Number(b)) || 1;
      ctx.fillStyle = '#fff'; ctx.font = `800 18px ${FONT}`; ctx.textBaseline = 'middle';
      ctx.textAlign = 'left'; ctx.fillText(fmt ? fmt(a) : String(a), x, yy);
      ctx.textAlign = 'right'; ctx.fillText(fmt ? fmt(b) : String(b), x + w, yy);
      ctx.textAlign = 'center'; ctx.fillStyle = '#9fb7a8'; ctx.font = `700 13px ${FONT}`; ctx.fillText(label.toUpperCase(), x + w / 2, yy);
      const bw = (w - 20) / 2;
      ctx.fillStyle = 'rgba(255,255,255,0.1)'; ctx.fillRect(x, yy + 14, w, 6);
      ctx.fillStyle = TEAMS.A.color; ctx.fillRect(x + w / 2 - (Number(a) / tot) * (w / 2), yy + 14, (Number(a) / tot) * (w / 2), 6);
      ctx.fillStyle = TEAMS.B.color; ctx.fillRect(x + w / 2, yy + 14, (Number(b) / tot) * (w / 2), 6);
    });
  }
  function scoreHeader(ctx, title, score, y) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#ffd34d'; ctx.font = `900 16px ${FONT}`; ctx.fillText(title, W / 2, y);
    const s = 34;
    ctx.fillStyle = '#fff'; ctx.font = `italic 900 ${Math.min(fit(TEAMS.A.name, 900, s, 380, 16, true), fit(TEAMS.B.name, 900, s, 380, 16, true))}px ${FONT}`;
    ctx.textAlign = 'right'; ctx.fillText(TEAMS.A.name, W / 2 - 90, y + 52);
    ctx.textAlign = 'left'; ctx.fillText(TEAMS.B.name, W / 2 + 90, y + 52);
    ctx.textAlign = 'center'; ctx.font = `900 54px ${FONT}`; ctx.fillText(`${score[0]}–${score[1]}`, W / 2, y + 58);
    ctx.fillStyle = TEAMS.A.color; ctx.fillRect(W / 2 - 90 - 60, y + 66, 60, 5);
    ctx.fillStyle = TEAMS.B.color; ctx.fillRect(W / 2 + 90, y + 66, 60, 5);
  }
  function scorers(ctx, goals, y) {
    ctx.font = `600 14px ${FONT}`; ctx.fillStyle = '#cfdad4'; ctx.textBaseline = 'alphabetic';
    const A = goals.filter(g => g.side === 'A').map(g => `${surname(g.name)} ${g.min}${g.pen ? ' (p)' : ''}`).join(', ');
    const B = goals.filter(g => g.side === 'B').map(g => `${surname(g.name)} ${g.min}${g.pen ? ' (p)' : ''}`).join(', ');
    ctx.textAlign = 'right'; ctx.fillText(A ? `⚽ ${A}` : '', W / 2 - 90, y);
    ctx.textAlign = 'left'; ctx.fillText(B ? `⚽ ${B}` : '', W / 2 + 90, y);
  }
  function drawHT(ctx, sc, local) {
    dimBackdrop(ctx, sc.start + local);
    const p = clamp(local / 500, 0, 1), out = clamp((sc.dur - local) / 400, 0, 1);
    ctx.save(); ctx.globalAlpha = Math.min(p, out);
    panel(ctx, 200, 60, 880, 600);
    scoreHeader(ctx, 'HALF-TIME', sc.score, 110);
    scorers(ctx, sc.goals, 210);
    const s = sc.stats;
    statRows(ctx, [['Shots', s.shots[0], s.shots[1]], ['On target', s.onT[0], s.onT[1]], ['Corners', s.corners[0], s.corners[1]], ['Fouls', s.fouls[0], s.fouls[1]], ['Offsides', s.offsides[0], s.offsides[1]], ['Yellow cards', s.yellow[0], s.yellow[1]], ['Red cards', s.red[0], s.red[1]]], 300, 270, 680);
    ctx.restore();
  }
  function drawSwitch(ctx, sc, local) {
    dimBackdrop(ctx, sc.start + local);
    const p = easeInOut(clamp(local / 1800, 0, 1));
    const cx = W / 2, cy = H / 2 + 10, pw = 520, ph = 300;
    ctx.save();
    ctx.fillStyle = '#1f6b37'; D.roundRect(ctx, cx - pw / 2, cy - ph / 2, pw, ph, 10); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 2; ctx.strokeRect(cx - pw / 2 + 10, cy - ph / 2 + 10, pw - 20, ph - 20);
    ctx.beginPath(); ctx.moveTo(cx, cy - ph / 2 + 10); ctx.lineTo(cx, cy + ph / 2 - 10); ctx.stroke();
    // Team blocks swap halves
    const ax = lerp(cx - pw / 4, cx + pw / 4, p), bxx = lerp(cx + pw / 4, cx - pw / 4, p);
    const arc = Math.sin(p * Math.PI) * 60;
    for (const [x, col, name, dy] of [[ax, TEAMS.A.color, TEAMS.A.name, -arc], [bxx, TEAMS.B.color, TEAMS.B.name, arc]]) {
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, cy + dy, 34, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = lum(col) > 0.62 ? '#111' : '#fff'; ctx.font = `900 16px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(short3(name), x, cy + dy + 1);
    }
    ctx.fillStyle = '#fff'; ctx.font = `900 30px ${FONT}`; ctx.textAlign = 'center';
    ctx.fillText('SIDES SWITCH FOR THE SECOND HALF', cx, cy - ph / 2 - 40);
    ctx.restore();
  }
  function drawFT(ctx, sc, local) {
    dimBackdrop(ctx, sc.start + local);
    const p = clamp(local / 500, 0, 1), out = clamp((sc.dur - local) / 400, 0, 1);
    ctx.save(); ctx.globalAlpha = Math.min(p, out);
    panel(ctx, 180, 40, 920, 640);
    scoreHeader(ctx, 'FULL TIME', sc.score, 92);
    scorers(ctx, sc.goals, 192);
    const s = stats, e = sc.ev;
    const pick = (k, alt) => (Array.isArray(s?.[k]) ? s[k] : alt);
    const rows = [
      ['Possession', ...pick('possession', [50, 50]), v => `${Math.round(v)}%`],
      ['Shots', ...pick('shots', e.shots)], ['On target', ...pick('on_target', e.onT)],
      ['xG', ...pick('xg', [0, 0]), v => Number(v).toFixed(2)],
      ['Corners', ...pick('corners', e.corners)], ['Fouls', ...pick('fouls', e.fouls)],
      ['Offsides', ...pick('offsides', e.offsides)], ['Cards', e.yellow[0] + e.red[0], e.yellow[1] + e.red[1]],
    ];
    statRows(ctx, rows, 280, 240, 720);
    ctx.restore();
  }
  function drawMotm(ctx, sc, local) {
    dimBackdrop(ctx, sc.start + local);
    const m = stats?.motm; if (!m) return;
    const side = m.side === 'B' ? 'B' : 'A';
    const pl = playerByName(side, m.player);
    const p = clamp(local / 600, 0, 1), out = clamp((sc.dur - local) / 400, 0, 1);
    ctx.save(); ctx.globalAlpha = Math.min(p, out);
    const r = 150 * (0.7 + 0.3 * backOut(p));
    if (pl) photoCircle(ctx, pl.id, 360, H / 2, r, TEAMS[side].color);
    ctx.fillStyle = '#ffd34d'; ctx.font = `900 18px ${FONT}`; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText('PLAYER OF THE MATCH', 580, 250);
    ctx.fillStyle = '#fff'; ctx.font = `italic 900 ${fit(m.player, 900, 58, 640, 24, true)}px ${FONT}`; ctx.fillText(m.player, 580, 312);
    const rt = ratings?.[side]?.find(x => surname(x.player) === surname(m.player));
    if (rt) { ctx.fillStyle = TEAMS[side].color; D.roundRect(ctx, 580, 336, 92, 48, 10); ctx.fill(); ctx.fillStyle = lum(TEAMS[side].color) > 0.62 ? '#111' : '#fff'; ctx.font = `900 28px ${FONT}`; ctx.textAlign = 'center'; ctx.fillText(Number(rt.rating).toFixed(1), 626, 370); }
    ctx.textAlign = 'left'; ctx.fillStyle = '#cfdad4'; ctx.font = `500 19px ${FONT}`;
    wrap(m.reason, 500, 19, 600, 4).forEach((ln, i) => ctx.fillText(ln, 580, 420 + i * 27));
    ctx.restore();
  }
  function drawRatings(ctx, sc, local) {
    dimBackdrop(ctx, sc.start + local);
    const p = clamp(local / 500, 0, 1), out = clamp((sc.dur - local) / 400, 0, 1);
    ctx.save(); ctx.globalAlpha = Math.min(p, out);
    ctx.fillStyle = '#ffd34d'; ctx.font = `900 18px ${FONT}`; ctx.textAlign = 'center'; ctx.fillText('PLAYER RATINGS', W / 2, 60);
    ['A', 'B'].forEach((side, si) => {
      const list = (ratings?.[side] || []).slice().sort((a, b) => b.rating - a.rating);
      const x = si ? 680 : 80;
      ctx.fillStyle = '#fff'; ctx.font = `italic 900 26px ${FONT}`; ctx.textAlign = 'left'; ctx.fillText(TEAMS[side].name, x, 104);
      list.slice(0, 11).forEach((r, i) => {
        const ap = clamp((local - 200 - i * 60) / 300, 0, 1);
        const y = 140 + i * 48;
        ctx.save(); ctx.globalAlpha = Math.min(p, out) * ap;
        const pl = playerByName(side, r.player);
        ctx.fillStyle = 'rgba(255,255,255,0.06)'; D.roundRect(ctx, x, y, 520, 40, 8); ctx.fill();
        if (pl) photoCircle(ctx, pl.id, x + 22, y + 20, 15, TEAMS[side].color);
        ctx.fillStyle = '#fff'; ctx.font = `700 16px ${FONT}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.fillText(r.player, x + 48, y + 21);
        const v = Number(r.rating) || 0;
        ctx.fillStyle = v >= 8 ? '#22c55e' : v >= 7 ? '#84cc16' : v >= 6 ? '#eab308' : '#ef4444';
        D.roundRect(ctx, x + 456, y + 6, 54, 28, 6); ctx.fill();
        ctx.fillStyle = '#111'; ctx.font = `900 15px ${FONT}`; ctx.textAlign = 'center'; ctx.fillText(v.toFixed(1), x + 483, y + 21);
        ctx.restore();
      });
    });
    ctx.restore();
  }
  function drawAnalysis(ctx, sc, local) {
    dimBackdrop(ctx, sc.start + local);
    const a = analysis[sc.side]; if (!a) return;
    const col = TEAMS[sc.side].color;
    const p = clamp(local / 500, 0, 1), out = clamp((sc.dur - local) / 400, 0, 1);
    ctx.save(); ctx.globalAlpha = Math.min(p, out);
    ctx.fillStyle = col; ctx.fillRect(0, 0, 14, H);
    ctx.fillStyle = '#fff'; ctx.font = `italic 900 ${fit(TEAMS[sc.side].name, 900, 40, 760, 20, true)}px ${FONT}`; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(TEAMS[sc.side].name.toUpperCase(), 70, 92);
    ctx.fillStyle = '#9fb7a8'; ctx.font = `800 15px ${FONT}`; ctx.fillText('PLAYS LIKE', 70, 140);
    const club = a.resembles?.club || '—';
    ctx.fillStyle = '#ffd34d'; ctx.font = `italic 900 ${fit(club, 900, 64, 700, 24, true)}px ${FONT}`; ctx.fillText(club, 70, 206);
    ctx.fillStyle = '#e5efe9'; ctx.font = `700 16px ${FONT}`;
    ctx.fillText(a.resembles?.league || '', 70, 236);
    ctx.fillStyle = '#cfdad4'; ctx.font = `500 18px ${FONT}`;
    wrap(a.resembles?.why || a.summary || '', 500, 18, 1100, 2).forEach((ln, i) => ctx.fillText(ln, 70, 274 + i * 26));
    const col2 = (title, list, x, good) => {
      ctx.fillStyle = good ? '#4ade80' : '#f87171'; ctx.font = `900 16px ${FONT}`; ctx.fillText(title, x, 360);
      (list || []).slice(0, 3).forEach((s, i) => {
        const ap = clamp((local - 600 - i * 220) / 350, 0, 1);
        ctx.save(); ctx.globalAlpha = Math.min(p, out) * ap; ctx.translate((1 - easeOut(ap)) * 30, 0);
        ctx.fillStyle = 'rgba(255,255,255,0.07)'; D.roundRect(ctx, x, 380 + i * 92, 540, 80, 12); ctx.fill();
        ctx.fillStyle = good ? '#22c55e' : '#ef4444'; ctx.beginPath(); ctx.arc(x + 28, 420 + i * 92, 13, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.font = `900 14px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(good ? '✓' : '✕', x + 28, 421 + i * 92);
        ctx.textAlign = 'left'; ctx.font = `600 16px ${FONT}`;
        wrap(s, 600, 16, 470, 3).forEach((ln, j, arr) => ctx.fillText(ln, x + 54, 420 + i * 92 + (j - (arr.length - 1) / 2) * 20));
        ctx.restore();
      });
    };
    col2('STRENGTHS', a.strengths, 70, true);
    col2('WEAKNESSES', a.weaknesses, 670, false);
    ctx.restore();
  }
  // Key moments montage: small freeze frames, rendered once each.
  let montageCache = null;
  const thumbCache = new Map();
  let thumbBig = null;
  function montageThumb(i) {
    const m = built.moments[i];
    const key = `${m.t}`;
    if (!thumbCache.has(key)) {
      thumbBig ||= Object.assign(document.createElement('canvas'), { width: W, height: H });
      renderAt(thumbBig.getContext('2d'), m.t, true);
      const s = document.createElement('canvas'); s.width = 384; s.height = 216; s.getContext('2d').drawImage(thumbBig, 0, 0, 384, 216);
      thumbCache.set(key, s);
    }
    return thumbCache.get(key);
  }
  // Warm-up: render each new scene once off-screen during idle time, so the first real frame of
  // a scene never pays for font/texture/photo uploads or text measuring.
  const warmed = new Set();
  let warmCv = null, warmScheduled = false, lastWarm = 0, warmHint = 0;
  const ric = window.requestIdleCallback || (f => setTimeout(() => f({ timeRemaining: () => 8 }), 60));
  function scheduleWarm() {
    if (warmScheduled) return;
    warmScheduled = true;
    ric(function step(deadline) {
      warmScheduled = false;
      // Scenes just ahead of the playhead first, then everything else.
      const scs = built.scenes.slice().sort((p, q) => {
        const dp = p.start >= warmHint ? p.start - warmHint : 1e9 + (warmHint - p.start);
        const dq = q.start >= warmHint ? q.start - warmHint : 1e9 + (warmHint - q.start);
        return dp - dq;
      });
      for (let i = 0; i < scs.length; i++) {
        const sc = scs[i];
        const k = `${sc.kind}:${sc.start}`;
        if (warmed.has(k)) continue;
        // Rate-limited, idle-time only, so it never competes with playback.
        if (deadline.timeRemaining() < 4 || performance.now() - lastWarm < 220) { setTimeout(scheduleWarm, 120); return; }
        warmed.add(k); lastWarm = performance.now();
        warmCv ||= Object.assign(document.createElement('canvas'), { width: W, height: H });
        const wctx = warmCv.getContext('2d', { alpha: false });
        try {
          if (sc.kind === 'montage') { const j = built.moments.findIndex(m => !thumbCache.has(`${m.t}`)); if (j >= 0 && j < 6) { warmed.delete(k); montageThumb(j); scheduleWarm(); return; } }
          renderAt(wctx, sc.start + Math.min(400, sc.dur / 2));
        } catch {}
        scheduleWarm(); return;
      }
    }, { timeout: 1000 });
  }
  function drawMontage(ctx, sc, local) {
    dimBackdrop(ctx, sc.start + local);
    const ms = built.moments.slice(0, 6);
    for (let i = 0; i < ms.length; i++) montageThumb(i);
    ctx.save();
    ctx.fillStyle = '#ffd34d'; ctx.font = `900 18px ${FONT}`; ctx.textAlign = 'center'; ctx.fillText('KEY MOMENTS', W / 2, 56);
    ms.forEach((m, i) => {
      const col = i % 3, row = Math.floor(i / 3);
      const x = 40 + col * 404, y = 80 + row * 300;
      const ap = clamp((local - i * 200) / 400, 0, 1);
      ctx.save(); ctx.globalAlpha = ap; ctx.translate(x + 192, y + 108); ctx.scale(0.9 + 0.1 * backOut(ap), 0.9 + 0.1 * backOut(ap)); ctx.translate(-x - 192, -y - 108);
      ctx.drawImage(montageThumb(i), x, y, 384, 216);
      ctx.strokeStyle = m.side === 'B' ? TEAMS.B.color : TEAMS.A.color; ctx.lineWidth = 3; ctx.strokeRect(x, y, 384, 216);
      ctx.fillStyle = '#fff'; ctx.font = `800 15px ${FONT}`; ctx.textAlign = 'left';
      ctx.fillText(`${m.minute}  ${m.title}`.slice(0, 48), x, y + 240);
      ctx.restore();
    });
    ctx.restore();
  }
  function drawEnd(ctx, sc, local) {
    dimBackdrop(ctx, sc.start + local);
    const st = built.state;
    const p = clamp(local / 600, 0, 1);
    ctx.save(); ctx.globalAlpha = p;
    scoreHeader(ctx, 'FINAL SCORE', st.score, 250);
    scorers(ctx, st.goals, 350);
    ctx.textAlign = 'center'; ctx.fillStyle = '#9fb7a8'; ctx.font = `700 15px ${FONT}`;
    ctx.fillText('SÜPER LIG MIX · Draft Duel · simulated by GPT-6.1 Sol · github.com/edgetr/superlig-mix', W / 2, H - 60);
    ctx.restore();
  }
  function drawVar(ctx, sc, local) {
    if (sc.clip) drawClip(ctx, sc, sc.at, 'broadcast', { noTags: true });
    ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(0, 0, W, H);
    // Scan lines
    ctx.fillStyle = 'rgba(56,189,248,0.08)';
    for (let y = (local / 6) % 6; y < H; y += 6) ctx.fillRect(0, y, W, 2);
    const p = clamp(local / 400, 0, 1);
    ctx.save(); ctx.globalAlpha = p;
    ctx.fillStyle = '#0b1220'; D.roundRect(ctx, W / 2 - 260, H / 2 - 90, 520, 180, 16); ctx.fill();
    ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = 3; ctx.stroke();
    ctx.fillStyle = '#38bdf8'; ctx.font = `900 48px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('VAR', W / 2, H / 2 - 36);
    ctx.fillStyle = '#fff'; ctx.font = `800 20px ${FONT}`;
    const d = sc.ev.decision || sc.ev.outcome || '';
    ctx.fillText(local > 2200 ? (d ? `Decision: ${String(d).toUpperCase()}` : 'CHECK COMPLETE') : `CHECKING — ${String(sc.ev.check || 'possible incident').toUpperCase()}`, W / 2, H / 2 + 14);
    ctx.fillStyle = '#cfdad4'; ctx.font = `500 15px ${FONT}`;
    wrap(sc.ev.text || '', 500, 15, 470, 2).forEach((ln, i) => ctx.fillText(ln, W / 2, H / 2 + 50 + i * 20));
    ctx.restore();
  }
  const FORMATIONS_OF = f => C.FORMATION_TABLE[f] || C.FORMATION_TABLE['4-3-3'];

  // ---------------------------------------------------------------- scene dispatch
  function sceneAt(t) {
    const sc = built.scenes;
    let lo = 0, hi = sc.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (sc[mid].start <= t) lo = mid; else hi = mid - 1; }
    return sc[lo];
  }
  function renderAt(ctx, t, noHud) {
    const sc = sceneAt(t);
    if (!sc) { ctx.fillStyle = '#05070c'; ctx.fillRect(0, 0, W, H); return; }
    const local = t - sc.start;
    ctx.save();
    switch (sc.kind) {
      case 'intro': drawIntro(ctx, sc, local); break;
      case 'lineup': drawLineup(ctx, sc, local); break;
      case 'toss': drawToss(ctx, sc, local); break;
      case 'clip': {
        const ct = (sc.trimStart || 0) + local / 1000;
        drawClip(ctx, sc, ct, 'live');
        if (!noHud) {
          scorebug(ctx, sc, t, ct);
          const g = sc.clip.marks.goalT;
          const goalCard = g != null && ct > g + 0.25 && ct < g + 4.65 && sc.ev.outcome !== 'disallowed';
          if (!goalCard) lowerThird(ctx, sc, ct);
          goalGraphic(ctx, sc, ct);
          cardGraphic(ctx, sc, ct);
          if (sc.isWipe) wipe(ctx, local / 700, sc);
        }
        break;
      }
      case 'replay': {
        const ct = sc.from + (local / 1000) * sc.slow;
        drawClip(ctx, sc, ct, sc.cam, { noTags: false });
        // Replay bug + letterbox vignette
        ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(0, 0, W, 34); ctx.fillRect(0, H - 34, W, 34);
        ctx.fillStyle = '#f8fafc'; D.roundRect(ctx, W - 176, 44, 140, 32, 6); ctx.fill();
        ctx.fillStyle = TEAMS[sc.ev.side || 'A'].color; ctx.beginPath(); ctx.arc(W - 156, 60, 7 + Math.sin(local / 140) * 1.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#111'; ctx.font = `900 15px ${FONT}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText('REPLAY', W - 140, 61);
        if (!noHud) scorebug(ctx, { ...sc, goalAt: null }, t, sc.from);
        if (local < 450) wipe(ctx, local / 450, null);
        break;
      }
      case 'freeze': drawFreeze(ctx, sc, local); break;
      case 'var': drawVar(ctx, sc, local); break;
      case 'ht': drawHT(ctx, sc, local); break;
      case 'switch': drawSwitch(ctx, sc, local); break;
      case 'ft': drawFT(ctx, sc, local); break;
      case 'motm': drawMotm(ctx, sc, local); break;
      case 'ratings': drawRatings(ctx, sc, local); break;
      case 'analysis': drawAnalysis(ctx, sc, local); break;
      case 'montage': drawMontage(ctx, sc, local); break;
      case 'end': drawEnd(ctx, sc, local); break;
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- public API
  function duration() { return built.state ? built.state.t : 0; }
  function render(ctx, t) {
    if (!built.state) rebuild();
    if (!crownReady) { D.buildTextures([TEAMS.A.color, TEAMS.B.color], [TEAMS.A.name.toUpperCase(), TEAMS.B.name.toUpperCase(), 'SÜPER LIG MIX']); crownReady = true; }
    renderAt(ctx, clamp(t, 0, Math.max(0, duration() - 1)));
  }
  let crownReady = false;
  function infoAt(t) {
    if (!built.state) rebuild();
    t = clamp(t, 0, Math.max(0, duration() - 1));
    const sc = sceneAt(t);
    if (!sc) return { minute: '', score: [0, 0], sceneType: '', text: '', eventIndex: -1, fullTimeReached: false };
    let minute = '', score = sc.scoreBefore ? scoreAt(sc, t) : (sc.score || built.state.score);
    if (sc.kind === 'clip' || sc.kind === 'replay' || sc.kind === 'freeze' || sc.kind === 'var') minute = minuteStr(sc.min, sc.add);
    if (sc.kind === 'ht' || sc.kind === 'switch') minute = 'HT';
    if (['ft', 'motm', 'ratings', 'analysis', 'montage', 'end'].includes(sc.kind)) { minute = 'FT'; score = built.state.score; }
    if (['intro', 'lineup', 'toss'].includes(sc.kind)) { minute = ''; score = [0, 0]; }
    const ftStart = typeof built.state.ftStart === 'number' ? built.state.ftStart : (built.state.ftWhistle ?? Infinity);
    return { minute, score, sceneType: sc.kind === 'clip' ? (sc.ev?.type || 'clip') : sc.kind, text: sc.ev?.text || '', eventIndex: sc.idx ?? -1, fullTimeReached: t >= ftStart };
  }
  let preloadP = null;
  function preload() { return (preloadP ||= preloadOnce()); }
  async function preloadOnce() {
    if (!crownReady) { D.buildTextures([TEAMS.A.color, TEAMS.B.color], [TEAMS.A.name.toUpperCase(), TEAMS.B.name.toUpperCase(), 'SÜPER LIG MIX']); crownReady = true; }
    const stageP = import('./three/stage.js').then(m => m.getStage()).catch(e => { console.warn('3D renderer unavailable, using 2D', e); return null; });
    const all = [...TEAMS.A.players, ...TEAMS.B.players];
    await Promise.all(all.map(p => new Promise(res => {
      if (!p.img) return res();
      const img = new Image();
      img.crossOrigin = 'anonymous'; img.referrerPolicy = 'no-referrer';
      img.onload = async () => {
        // Decode now so the first frame that shows this face doesn't stall.
        try { await img.decode(); } catch {}
        // Pre-render a small avatar once: drawing big photos mid-playback forces a decode + GPU upload.
        const av = document.createElement('canvas'); av.width = 160; av.height = 208;
        av.getContext('2d').drawImage(img, 0, 0, 160, 208);
        photos.set(p.id, av); photoImgs.set(p.id, img); try { looks.set(p.id, sampleLook(img)); } catch {} lookCache = null; res();
      };
      img.onerror = () => res();
      img.src = p.img;
    })));
    stage3d = await stageP;
    lookCache = null;
    montageCache = null; thumbCache.clear(); warmed.clear();
    scheduleWarm();
  }
  // Rehearsal: while the players look at the line-ups, render every kind of scene once on a hidden
  // canvas using a short practice script with the real teams. Fonts, photos and graphics are then
  // warm before kick-off, so the first goal, card or analysis image never stutters.
  let rehearsed = false;
  async function rehearse() {
    if (rehearsed) return; rehearsed = true;
    const A = TEAMS.A.players.map(p => p.name), B = TEAMS.B.players.map(p => p.name);
    const ev = d => ({ kind: 'ev', data: d });
    const script = [
      { kind: 'meta', data: { kickoff: 'A', referee: 'Referee', weather: 'Clear', headline: 'Warm-up', styles: meta?.styles || null } },
      ev({ min: 10, add: 0, type: 'shot', side: 'A', player: A[9], assist: A[7], x: 89, y: 46, outcome: 'goal', target: 'bottom_left', assist_type: 'through_ball', text: `${A[9]} scores.` }),
      ev({ min: 20, add: 0, type: 'foul', side: 'B', player: B[9], offender: A[3], x: 80, y: 60, card: 'yellow', text: 'Booked.' }),
      ev({ min: 21, add: 0, type: 'shot', side: 'B', player: B[8], x: 80, y: 60, outcome: 'saved', technique: 'free_kick', assist_type: 'free_kick', target: 'top_left', xg: 0.4, text: 'Saved.' }),
      ev({ min: 30, add: 0, type: 'offside', side: 'B', player: B[10], assist: B[8], x: 85, y: 40, text: 'Offside.' }),
      ev({ min: 45, add: 1, type: 'half_time', text: 'Half-time.' }),
      ev({ min: 60, add: 0, type: 'shot', side: 'B', player: B[10], assist: B[7], x: 91, y: 40, outcome: 'woodwork', body: 'head', assist_type: 'cross', text: 'Post!' }),
      ev({ min: 90, add: 2, type: 'full_time', text: 'Full time.' }),
      { kind: 'stats', data: { possession: [50, 50], shots: [5, 5], on_target: [2, 2], xg: [1, 1], corners: [3, 3], fouls: [9, 9], offsides: [1, 1], yellow: [1, 0], red: [0, 0], motm: { side: 'A', player: A[9], reason: 'Warm-up.' } } },
      { kind: 'ratings', data: { A: A.map(n => ({ player: n, rating: 7 })), B: B.map(n => ({ player: n, rating: 7 })) } },
      { kind: 'analysis', data: { side: 'A', summary: 'x', strengths: ['a', 'b', 'c'], weaknesses: ['a', 'b', 'c'], resembles: { club: 'Club', league: 'League', why: 'x' } } },
      { kind: 'analysis', data: { side: 'B', summary: 'x', strengths: ['a', 'b', 'c'], weaknesses: ['a', 'b', 'c'], resembles: { club: 'Club', league: 'League', why: 'x' } } },
      { kind: 'end', data: {} },
    ];
    const rh = createMatch({ teams: TEAMS });
    rh.__shareAssets(photos, looks, photoImgs, stage3d);
    rh.setItems(script);
    await rh.ready();
    const cv = Object.assign(document.createElement('canvas'), { width: W, height: H });
    const c2 = cv.getContext('2d', { alpha: false });
    for (const sc of rh.scenes()) {
      for (const off of [120, Math.min(1600, sc.dur * 0.6)]) {
        await new Promise(r => setTimeout(r, 30));
        try { rh.render(c2, sc.start + off); } catch {}
      }
    }
  }
  return {
    __internal: () => ({ built, stage3d, allLooks, C }),
    rehearse,
    __shareAssets(ph, lk, imgs, st) { ph.forEach((v, k) => photos.set(k, v)); lk.forEach((v, k) => looks.set(k, v)); imgs?.forEach((v, k) => photoImgs.set(k, v)); if (st) stage3d = st; lookCache = null; crownReady = true; },
    setItems,
    get duration() { return duration(); },
    get complete() { return complete; },
    render, infoAt, preload, ready,
    warmAround: t => { warmHint = t; scheduleWarm(); },
    score: () => [...(built.state?.score || [0, 0])],
    timeline: () => built.tl,
    moments: () => built.moments,
    scenes: () => built.scenes.map(s => ({ kind: s.kind, start: s.start, dur: s.dur, type: s.ev?.type, outcome: s.ev?.outcome })),
    teams: TEAMS,
  };
}

// Skin tone and hair colour sampled from the player's photo (white/grey background ignored).
function sampleLook(img) {
  const c = document.createElement('canvas'); c.width = 30; c.height = 39;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(img, 0, 0, 30, 39);
  const d = x.getImageData(0, 0, 30, 39).data;
  const avg = (y0, y1, x0, x1) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let xx = x0; xx < x1; xx++) {
      const i = (y * 30 + xx) * 4; const R = d[i], G = d[i + 1], B = d[i + 2];
      const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
      if (mx > 200 && mx - mn < 22) continue;     // background
      if (mx - mn < 10 && mx > 120) continue;
      r += R; g += G; b += B; n++;
    }
    return n > 6 ? [r / n, g / n, b / n, n] : null;
  };
  const face = avg(14, 22, 11, 19);
  const hair = avg(2, 7, 9, 21);
  const hex = v => '#' + v.slice(0, 3).map(n => Math.round(n).toString(16).padStart(2, '0')).join('');
  const skin = face ? hex(face) : '#c8956b';
  let hairC = hair ? hex(hair) : null;
  if (hair && face && Math.abs(hair[0] - face[0]) + Math.abs(hair[1] - face[1]) < 40) hairC = null; // bald / shaved
  return { skin, hair: hairC };
}
