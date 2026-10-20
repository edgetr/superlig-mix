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
    // Pre-match: title over the stadium, then the two line-ups (the coin toss isn't a highlight).
    const walk = C.buildMoment(C.withHalf(M0, 1), {}, { kind: 'walkout', seed: 11, sent: new Set() });
    const i0 = push({ kind: 'intro', dur: EDIT.intro, clip: walk });
    push({ kind: 'lineup', side: 'A', dur: EDIT.lineup, clip: walk });
    const l1 = push({ kind: 'lineup', side: 'B', dur: EDIT.lineup, clip: walk });
    built.tl.push({ start: 0, end: i0.dur, kind: 'intro', type: 'intro', itemIndex: -1, side: null, minute: '' });
    built.tl.push({ start: i0.dur, end: l1.start + l1.dur, kind: 'lineups', type: 'lineups', itemIndex: -1, side: null, minute: '' });
  }
  async function ensureKickoff() {
    const st = built.state;
    if (st.kickedOff) return;
    st.kickedOff = true;
    const ko = meta?.kickoff === 'B' ? 'B' : 'A';
    st.firstKick = ko;
    await clipScene({ type: 'kickoff', side: ko, min: 1, add: 0, text: `${TEAMS[ko].name} get us under way.` }, -1, 'kickoff', {});
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
      // Only bookings, red cards and penalties are highlights. A foul in the final third is still
      // simulated (hidden) because the free kick that may follow is set up from where it happened.
      const { u } = { u: (Number(ev.x) || 50) * 1.05 };
      render = !!ev.card || !!ev.penalty;
      kind = render || u >= 66 ? 'foul' : null;
    } else if (ev.type === 'offside') { st.ev.offsides[si]++; render = true; kind = 'offside'; }
    else if (ev.type === 'corner') { st.ev.corners[si]++; }   // a cleared corner isn't a highlight
    else if (ev.type === 'injury') { render = true; kind = 'injury'; }
    else if (ev.type === 'var') { render = true; kind = 'var'; }

    if (!render) {
      built.tl.push({ start: st.t, end: st.t, kind: 'ev', type: ev.type, itemIndex: idx, side: ev.side || null, minute: minuteStr(min, add) });
      if (kind === 'foul') await clipScene(ev, idx, 'foul', { hidden: true });
      st.lastMin = min;
      return;
    }
    if (kind === 'var') varScene(ev, idx, min, add);
    else await clipScene(ev, idx, kind, {});
    st.lastMin = min; st.lastRendered = min;
  }

  // ---------------------------------------------------------------- the edit
  // Durations (ms) of the graphics scenes, and the rules that turn each simulated clip into a story
  // beat: join the move shortly before the decisive action, leave right after the payoff and a short
  // reaction (never through restarts, walking back or set-ups). All decisions are made from the
  // clip's own marks when the event arrives, so the edit is deterministic and streaming-safe.
  const EDIT = { intro: 5000, lineup: 4400, ht: 6000, ft: 6000, motm: 4600, ratings: 6000, analysis: 6500, end: 3600, freeze: 3000, freezeLine: 3400 };
  const SAVED = ['saved', 'parried', 'tipped'];
  const RESTART_CAP = new Set(['freekick', 'goalkick', 'corner']);
  // In-point: the earliest pass of the move inside [key − maxLead, key − minLead] (a beat before it),
  // so the clip opens on the move that leads to the moment rather than on aimless possession.
  function moveStart(clip, key, minLead, maxLead, fallback) {
    const ps = clip.marks.passes.filter(p => p.t0 < key - 0.3 && p.t0 >= key - maxLead + 0.6);
    const t = ps.length ? ps[0].t0 - 0.6 : key - fallback;
    return clamp(t, key - maxLead, key - minLead);
  }
  function cutPoints(clip, ev, kind) {
    const m = clip.marks, climax = clip.info.climax || 0;
    let key = climax, inT, outT;
    const capAt = icon => m.captions.find(c => c.icon === icon)?.t;
    if (kind === 'shot') {
      key = m.shot?.t ?? climax;
      const setPiece = ev.technique === 'penalty' || ev.assist_type === 'penalty' || ev.technique === 'free_kick' || ev.assist_type === 'free_kick';
      const wh = m.whistles.filter(t => t < key).pop();
      if (setPiece && wh != null) inT = wh - 1.0;                    // the referee's whistle, the run-up
      else if (ev.assist_type === 'corner') { const cr = m.passes.filter(p => p.t0 < key).pop(); inT = cr ? cr.t0 - 1.4 : key - 4; }
      else {
        // goals and big chances get the whole move; a half-chance just the last pass and the effort
        const major = ev.outcome === 'goal' || ev.outcome === 'disallowed' || ev.outcome === 'woodwork' || Number(ev.xg) >= 0.25;
        inT = major ? moveStart(clip, key, 4.5, 7.5, 6) : moveStart(clip, key, 3, 4.6, 4);
      }
      const flight = key + (m.shot?.dur || 0.8);
      if (ev.outcome === 'goal') outT = (m.goalT ?? flight) + 5.0;   // GOAL graphic + celebration close-up
      else if (ev.outcome === 'disallowed') outT = (m.disallowed?.t ?? (m.goalT ?? flight) + 1.2) + 2.0;
      else if (SAVED.includes(ev.outcome)) outT = (m.saveT ?? flight) + 1.7;
      else if (ev.outcome === 'woodwork') outT = (m.postT ?? flight) + 1.8;
      else if (ev.outcome === 'blocked') outT = key + 2.2;
      else outT = flight + 1.6;                                        // off target: the reaction
    } else if (kind === 'foul') {
      key = m.foul?.t ?? climax;
      inT = moveStart(clip, key, 2.6, 4.2, 3.4);
      outT = m.card ? m.card.t + 2.6 : key + (ev.penalty ? 2.8 : 2.2);
    } else if (kind === 'offside') {
      key = m.offside?.t ?? climax;
      inT = moveStart(clip, key, 3, 5, 4);
      outT = Math.max(key + 2.4, (capAt('offside') ?? key) + 1.6);
    } else if (kind === 'kickoff') { inT = climax - 0.7; outT = climax + 2.5; }
    else if (kind === 'whistle') { inT = climax - 1.6; outT = climax + (ev.type === 'full_time' ? 4.2 : 3.2); }
    else { inT = climax - 3; outT = climax + 3; }
    // never into the restart that follows (goal kick, corner, free-kick set-up) — a short reaction at most
    const rs = m.captions.find(c => RESTART_CAP.has(c.icon) && c.t > key + 0.3);
    if (rs && kind !== 'kickoff' && kind !== 'whistle') outT = Math.min(outT, Math.max(rs.t + 0.2, m.card ? m.card.t + 1.8 : key + 1.6));
    inT = clamp(inT, 0, Math.max(0, key - 0.5));
    outT = clamp(outT, Math.min(clip.dur, key + 0.8), clip.dur);
    return { inT, outT, key };
  }

  // Replays: the decisive 2–4 s, speed-ramped — close to real speed into the action, slow (≈0.4–0.5×)
  // only around the strike / save / contact, then back up. Goals get a second angle.
  function replayAngles(clip, ev, kind, isGoal) {
    const m = clip.marks, climax = clip.info.climax || 0;
    if (kind === 'shot' && m.shot) {
      const ts = m.shot.t, end = m.goalT ?? m.saveT ?? m.postT ?? ts + (m.shot.dur || 0.8);
      if (ev.outcome === 'disallowed' && m.offside) {
        const tp = m.offside.t;
        return [{ cam: 'line', from: tp - 1.5, to: tp + 1.3, base: 0.95, slow: [{ a: tp - 0.2, b: tp + 0.25, s: 0.35 }] }];
      }
      const last = m.passes.filter(p => p.t0 < ts - 0.2).pop();
      const from = clamp(last ? last.t0 - 0.3 : ts - 1.7, ts - 2.0, ts - 1.2);
      // goals: behind the goal, slow on the strike, real speed into the net; then over the shooter's
      // shoulder, slow on the strike again. Saves / woodwork: slow from the strike to the save.
      if (isGoal) return [
        { cam: 'goal', from, to: end + 0.55, base: 1, slow: [{ a: ts - 0.12, b: ts + 0.3, s: 0.45 }] },
        { cam: 'strike', from: ts - 0.6, to: end + 0.35, base: 0.9, slow: [{ a: ts - 0.12, b: ts + 0.2, s: 0.4 }] },
      ];
      return [{ cam: 'goal', from: Math.max(from, ts - 1.6), to: end + 0.7, base: 1, slow: [{ a: ts - 0.12, b: Math.min(end + 0.2, ts + 1.2), s: 0.5 }] }];
    }
    if (kind === 'foul') {
      const tf = m.foul?.t ?? climax;
      return [{ cam: 'reverse', from: tf - 1.4, to: tf + 0.8, base: 1, slow: [{ a: tf - 0.25, b: tf + 0.25, s: 0.4 }] }];
    }
    if (kind === 'offside') {
      const tp = m.offside?.t ?? climax;
      return [{ cam: 'line', from: tp - 1.5, to: tp + 1.3, base: 0.95, slow: [{ a: tp - 0.2, b: tp + 0.25, s: 0.35 }] }];
    }
    return [{ cam: 'reverse', from: climax - 1.5, to: climax + 1, base: 0.9, slow: [{ a: climax - 0.2, b: climax + 0.3, s: 0.45 }] }];
  }
  // Time map for a ramped replay: tab[k] = replay-local seconds at clip time from + k·RSTEP.
  const RSTEP = 1 / 120;
  function rampTable(clip, ang) {
    const from = clamp(ang.from, 0, clip.dur - 0.2), to = clamp(ang.to, from + 0.2, clip.dur - 0.01);
    const speed = ct => {
      let w = 0, s = ang.base;
      for (const z of ang.slow) {
        const r = 0.28;
        const ww = ct < z.a - r ? 0 : ct < z.a ? smooth((ct - (z.a - r)) / r) : ct <= z.b ? 1 : ct < z.b + r ? 1 - smooth((ct - z.b) / r) : 0;
        if (ww > w) { w = ww; s = z.s; }
      }
      return lerp(ang.base, s, w);
    };
    const n = Math.max(2, Math.ceil((to - from) / RSTEP) + 1);
    const tab = new Float64Array(n);
    for (let k = 1; k < n; k++) tab[k] = tab[k - 1] + RSTEP / speed(from + (k - 0.5) * RSTEP);
    return { from, to: from + (n - 1) * RSTEP, tab };
  }
  function rampCt(sc, local) {
    const tab = sc.tab, s = local / 1000;
    let lo = 0, hi = tab.length - 1;
    if (s >= tab[hi]) return sc.from + hi * RSTEP;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (tab[mid] <= s) lo = mid; else hi = mid - 1; }
    const a = (s - tab[lo]) / (tab[lo + 1] - tab[lo] || 1);
    return sc.from + (lo + clamp(a, 0, 1)) * RSTEP;
  }
  const rampLocal = (sc, ct) => { const k = clamp((ct - sc.from) / RSTEP, 0, sc.tab.length - 1), i = Math.floor(k), j = Math.min(i + 1, sc.tab.length - 1); return lerp(sc.tab[i], sc.tab[j], k - i) * 1000; };

  // One scripted moment → live clip (+ ramped replay, + analysis freeze for goals and offsides).
  async function clipScene(ev, idx, kind, opt) {
    const st = built.state;
    const half = (Number(ev.min) || 1) >= 46 || st.half === 2 ? 2 : 1;
    const M = C.withHalf(M0, half);
    const seed = C.hashStr(`${idx}|${ev.type}|${ev.min}|${ev.add}|${ev.player}|${ev.text}`);
    const ctx = { kind, seed, sent: new Set(st.sent), setup: (ev.type === 'shot' && (ev.assist_type === 'free_kick' || ev.technique === 'free_kick' || ev.technique === 'penalty' || ev.assist_type === 'penalty')) ? st.setup : null };
    let clip;
    try { clip = await build(half, ev, ctx); } catch (e) { console.warn('clip failed', e); return; }
    if (opt.hidden) { if (clip.marks.setup) st.setup = clip.marks.setup; return; }
    const min = Number(ev.min) || 1, add = Number(ev.add) || 0;
    const isGoal = kind === 'shot' && ev.outcome === 'goal';
    const scorerSide = ev.side;
    const sc = pushClip(clip, ev, idx, kind, M, half, min, add);
    const climax = clip.info.climax || 0;
    if (idx >= 0) built.tl.push({ start: sc.start + Math.max(0, clipLocal(sc, climax) - 300), end: sc.start + sc.dur, kind: 'ev', type: ev.type === 'shot' ? (ev.outcome === 'goal' ? (ev.ownGoal ? 'own_goal' : ev.technique === 'penalty' ? 'penalty_goal' : 'goal') : ev.outcome === 'woodwork' ? 'woodwork' : ev.outcome === 'blocked' ? 'block' : ['saved', 'parried', 'tipped'].includes(ev.outcome) ? 'save' : ev.outcome === 'disallowed' ? 'var' : 'shot') : ev.type === 'foul' ? (ev.card ? (ev.card === 'yellow' ? 'yellow' : 'red') : ev.penalty ? 'penalty' : 'foul') : ev.type, itemIndex: idx, side: ev.side || null, minute: minuteStr(min, add) });
    if (isGoal) {
      st.score[scorerSide === 'B' ? 1 : 0]++;
      sc.goalAt = sc.start + Math.round(clipLocal(sc, clip.marks.goalT || climax));
      st.goals.push({ side: scorerSide, name: ev.ownGoal ? `${ev.og} (OG)` : ev.player, min: minuteStr(min, add), pen: ev.technique === 'penalty' });
    }
    if (kind === 'foul') {
      if (clip.marks.setup) st.setup = clip.marks.setup;
      if (ev.card === 'red' || ev.card === 'second_yellow') { const a = clip.info.offender; if (a != null) st.sent.add(a); }
      if (ev.card) st.cards.push({ side: ev.side === 'A' ? 'B' : 'A', name: ev.offender, color: ev.card === 'yellow' ? 'yellow' : 'red', min: minuteStr(min, add) });
    } else st.setup = null;
    const big = isGoal || (kind === 'shot' && (['woodwork', 'disallowed'].includes(ev.outcome) || (SAVED.includes(ev.outcome) && (Number(ev.xg) >= 0.25 || ev.technique === 'penalty')))) || (kind === 'foul' && (ev.card === 'red' || ev.card === 'second_yellow' || ev.penalty)) || kind === 'offside';
    if (!big) return;
    const type = built.tl[built.tl.length - 1]?.type || kind;
    let momentT = null;
    replayAngles(clip, ev, kind, isGoal).forEach((ang, i) => {
      const r = rampTable(clip, ang);
      const rp = push({ kind: 'replay', clip, ev, M, half, from: r.from, to: r.to, tab: r.tab, cam: ang.cam, angle: i, dur: Math.round(r.tab[r.tab.length - 1] * 1000), min, add, scoreBefore: [...st.score] });
      if (i === 0) momentT = rp.start + Math.round(rampLocal(rp, freezeAt(clip, kind, ev)));
    });
    // Analysis image ("how it happened") only where a still explains something: how a goal was
    // made, and where the offside line was.
    const lineCall = kind === 'offside' || ev.outcome === 'disallowed';
    if (isGoal || lineCall) {
      const fr = push({ kind: 'freeze', clip, ev, M, half, at: freezeAt(clip, kind, ev), dur: lineCall ? EDIT.freezeLine : EDIT.freeze, min, add, scoreBefore: [...st.score], idx });
      momentT = fr.start + 1100;
    }
    built.moments.push({ t: momentT, title: momentTitle(ev, kind), minute: minuteStr(min, add), side: ev.side, type });
  }
  // A live clip trimmed to its story beat: [inT, outT] of the simulated clip.
  function pushClip(clip, ev, idx, kind, M, half, min, add, extra = {}) {
    const st = built.state;
    const cut = cutPoints(clip, ev, kind);
    return push({ kind: 'clip', clip, ev, idx, M, half, trimStart: cut.inT, outT: cut.outT, key: cut.key, dur: Math.round((cut.outT - cut.inT) * 1000), min, add, scoreBefore: [...st.score], climax: clip.info.climax || 0, isGoal: kind === 'shot' && ev.outcome === 'goal', live: true, ...extra });
  }
  const clipLocal = (sc, ct) => (ct - (sc.trimStart || 0)) * 1000;
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
    const sc = pushClip(wh, { ...ev, type: 'half_time' }, idx, 'whistle', M, 1, 45, add || 0);
    if (idx >= 0) built.tl.push({ start: sc.start + Math.round(clipLocal(sc, wh.info.climax || 0)), end: sc.start + sc.dur, kind: 'ev', type: 'half_time', itemIndex: idx, side: null, minute: minuteStr(45, add) });
    push({ kind: 'ht', dur: EDIT.ht, score: [...st.score], stats: JSON.parse(JSON.stringify(st.ev)), goals: [...st.goals], cards: [...st.cards] });
    st.half = 2; st.setup = null; st.lastRendered = 46;
    const ko = st.firstKick === 'A' ? 'B' : 'A';
    const M2 = C.withHalf(M0, 2);
    const k = await build(2, { side: ko }, { kind: 'kickoff', seed: 99, sent: new Set(st.sent) });
    pushClip(k, { type: 'second_half', side: ko, min: 46, add: 0, text: `Second half under way — ${TEAMS[ko].name} kick off.` }, -1, 'kickoff', M2, 2, 46, 0);
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
    const sc = pushClip(wh, { ...ev, type: 'full_time' }, idx, 'whistle', M, 2, 90, add || 0);
    st.ftWhistle = sc.start + Math.round(clipLocal(sc, wh.info.climax || 0));
    if (idx >= 0) built.tl.push({ start: st.ftWhistle, end: sc.start + sc.dur, kind: 'ev', type: 'full_time', itemIndex: idx, side: null, minute: minuteStr(90, add) });
    st.ftStart = 'pending';
    maybeFT();
  }
  function maybeFT(force) {
    const st = built.state;
    if (st.ftStart !== 'pending' || (!stats && !force)) return;
    const sc = push({ kind: 'ft', dur: EDIT.ft, score: [...st.score], goals: [...st.goals], cards: [...st.cards], ev: JSON.parse(JSON.stringify(st.ev)) });
    st.ftStart = sc.start;
    built.tl.push({ start: sc.start, end: sc.start + sc.dur, kind: 'fulltime', type: 'fulltime', itemIndex: -1, side: null, minute: 'FT' });
  }
  // After the final whistle: player of the match, ratings, one card per team, the final score.
  // (No recap montage: the viewer has just watched those moments.)
  async function buildOutro() {
    const st = built.state;
    if (st.outro) return;
    if (st.ftStart == null) await fullTime({ type: 'full_time', min: 90, add: 0 }, -1, 90, 0);
    if (st.ftStart === 'pending') maybeFT(true);
    st.outro = true;
    const s0 = st.t;
    if (stats?.motm) push({ kind: 'motm', dur: EDIT.motm });
    if (ratings) push({ kind: 'ratings', dur: EDIT.ratings });
    if (analysis.A) push({ kind: 'analysis', side: 'A', dur: EDIT.analysis });
    if (analysis.B) push({ kind: 'analysis', side: 'B', dur: EDIT.analysis });
    push({ kind: 'end', dur: EDIT.end });
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
    return { ...kit, skin: lk.skin, hair: lk.hair, faceXf: lk.faceXf, num: p.num ?? slot + 1, name: p.name, id: p.id, side, foot: p.foot || 'right', height: p.height ? p.height / 100 : 1.8,
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
  const angleMemo = new WeakMap();
  function celebAngle(c, sc, tt) {
    let memo = angleMemo.get(c); if (!memo) angleMemo.set(c, memo = new Map());
    const key = Math.round(tt * 2);
    if (memo.has(key)) return memo.get(key);
    const p = avgPos(c, sc, tt, 0.6);
    const a0 = avgPos(c, sc, tt - 0.6, 0.5), a1 = avgPos(c, sc, tt + 0.6, 0.5);
    const vx = a1.x - a0.x, vy = a1.y - a0.y, vl = Math.hypot(vx, vy);
    const run = vl > 0.4 ? clamp(Math.atan2(vx, vy), -1.05, 1.05) * smooth(clamp((vl - 0.4) / 1.2, 0, 1)) : 0;
    const f = clamp(Math.round(tt * HZ), 0, c.N - 1);
    let best = run, bestS = Infinity;
    for (let th = -1.05; th <= 1.051; th += 0.15) {
      const cx = p.x + Math.sin(th) * 7.2, cy = p.y + Math.cos(th) * 7.2;
      let occ = 0;
      for (let ag = 0; ag < 25; ag++) {
        if (ag === sc) continue;
        const ax = c.pos[(f * 25 + ag) * 2], ay = c.pos[(f * 25 + ag) * 2 + 1];
        if (ax < -20) continue;
        // distance from the agent to the camera→scorer segment
        const sx = p.x - cx, sy = p.y - cy, l2 = sx * sx + sy * sy;
        const u = clamp(((ax - cx) * sx + (ay - cy) * sy) / l2, 0, 1);
        if (u > 0.92) continue;
        const dd = Math.hypot(cx + sx * u - ax, cy + sy * u - ay);
        if (dd < 0.9) occ += (0.9 - dd) * (0.4 + u);
      }
      const score = occ * 4 + Math.abs(th - run) * 0.8;
      if (score < bestS) { bestS = score; best = th; }
    }
    memo.set(key, best);
    return best;
  }
  function clipCamera(sc, ct, mode) {
    const c = sc.clip, f = clamp(ct * HZ, 0, c.N - 1), i = Math.floor(f), j = Math.min(i + 1, c.N - 1), a = f - i;
    const bx = lerp(c.ball[i * 3], c.ball[j * 3], a), by = lerp(c.ball[i * 3 + 1], c.ball[j * 3 + 1], a);
    if (mode === 'live') {
      const m = c.marks;
      // Celebration: cut to a close camera on the scorer.
      if (m.goalT != null && m.celebrate && ct > m.goalT + 1.3) {
        // In front of the scorer (he's running at the camera side), never crossing the line:
        // the camera comes from the near touchline and swings up to 60° to see his face.
        const sc = m.celebrate.scorer, p = avgPos(c, sc, ct, 0.6);
        // Pick the clearest angle (nobody standing in the way), re-evaluated every 0.5 s and blended.
        const k0 = Math.floor(ct / 0.5) * 0.5, w = smooth((ct - k0) / 0.5);
        const ang = lerp(celebAngle(c, sc, k0), celebAngle(c, sc, k0 + 0.5), w);
        const d = 7.2;
        return D.camera([p.x + Math.sin(ang) * d, p.y + Math.cos(ang) * d, 2.4], [p.x, p.y, 1.2], 30);
      }
      // Booking: close on the referee and the player (a second yellow: from the yellow card on).
      // Held to the end of the clip so the edit never flicks back to the wide shot for a moment.
      if (m.card && ct > m.card.t - (m.card.second ? 1.5 : 0.35) && ct < Math.max(m.card.t + 2.5, sc.outT ?? 0)) {
        const r = avgPos(c, C.REF, ct, 0.4), o = m.card.agent != null ? avgPos(c, m.card.agent, ct, 0.4) : r;
        const x = (r.x + o.x) / 2, y = (r.y + o.y) / 2;
        return D.camera([x + 6, y + 12, 4.4], [x, y, 1.1], 36);
      }
      let cx = lerp(c.cam[i * 2], c.cam[j * 2], a), z = lerp(c.cam[i * 2 + 1], c.cam[j * 2 + 1], a);
      // Shot: push in towards the goal so the ball hitting the net is clearly visible.
      if (m.shot) {
        // (held through the end of the clip if it ends soon after, rather than pulling out as it cuts)
        let ts = m.shot.t, te = (m.goalT ?? (ts + m.shot.dur)) + 1.1;
        if (sc.outT != null && m.goalT == null && sc.outT - te < 1.6) te = sc.outT;
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
      // Behind the goal, lens tightening on the ball as the move comes towards the camera.
      const side = sc.ev.side || 'A', dir = sc.M.dir[side], gx = dir > 0 ? C.L : 0, sgn = dir > 0 ? 1 : -1;
      let sx = 0, sy = 0, n = 0;
      for (let k = -4; k <= 4; k++) { const f2 = clamp(Math.round((ct + k * 0.1) * HZ), 0, c.N - 1); sx += c.ball[f2 * 3]; sy += c.ball[f2 * 3 + 1]; n++; }
      const lx = sx / n, ly = sy / n;
      const pos = [gx + sgn * 8.5, 34 + (ly - 34) * 0.35, 5.2];
      const dist = Math.hypot(pos[0] - lx, pos[1] - ly);
      const fov = clamp((2 * Math.atan(10 / Math.max(dist, 1)) * 180) / Math.PI, 24, 56);
      return D.camera(pos, [lx, ly, 0.9], fov);
    }
    if (mode === 'reverse') {
      // reverse angle from the far side, panning with the (smoothed) ball
      const p = ballAvg(c, ct, 0.35);
      return D.reverseCam(p.x, p.y);
    }
    if (mode === 'strike') {
      // over the shooter's shoulder: a fixed camera behind the strike that pans with the ball to goal
      const pos = strikeCamPos(c);
      const b = ballAvg(c, ct, 0.12), lk = [b.x, b.y, 0.9];
      const dist = Math.hypot(pos[0] - b.x, pos[1] - b.y);
      return D.camera(pos, lk, clamp((2 * Math.atan(7 / Math.max(dist, 1)) * 180) / Math.PI, 20, 50));
    }
    if (mode === 'line') {
      // offside camera: square on the last defender's line at the moment of the pass
      const off = c.marks.offside, tk = clamp(Math.round((off?.t ?? ct) * HZ), 0, c.N - 1);
      let lx = bx;
      if (off) { const defSide = off.sideAtt === 'A' ? 'B' : 'A'; lx = defSide === (sc.M.dir.A > 0 ? 'B' : 'A') ? c.offX[tk * 2 + 1] : c.offX[tk * 2]; }
      const b = ballAvg(c, ct, 0.3);
      // the main gantry position slid along to the line, a little tighter
      return D.broadcastCam(lx + (b.x - lx) * 0.15, 1.3, lookY(c, ct));
    }
    if (mode === 'close') return D.closeCam(bx, by, 1);
    const cx = lerp(c.cam[i * 2], c.cam[j * 2], a), z = lerp(c.cam[i * 2 + 1], c.cam[j * 2 + 1], a);
    return D.broadcastCam(cx, z, lookY(c, ct));
  }
  // Over-the-shoulder replay camera: behind the shooter on the line of the shot, on whichever side
  // (and at whichever distance) nobody stands between the lens and the shooter at the strike.
  const strikeMemo = new WeakMap();
  function strikeCamPos(c) {
    if (strikeMemo.has(c)) return strikeMemo.get(c);
    const s = c.marks.shot, sp = posAt(c, s.agent, s.t) || s.from;
    let dx = s.to.x - sp.x, dy = s.to.y - sp.y; const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
    const f = clamp(Math.round(s.t * HZ), 0, c.N - 1);
    let best = null, bestS = Infinity;
    for (const back of [6.5, 8.5, 5]) for (const lat of [-2.6, 2.6, -4.5, 4.5, 0.8]) {
      const cx = sp.x - dx * back - dy * lat, cy = sp.y - dy * back + dx * lat;
      let occ = 0;
      for (let ag = 0; ag < 25; ag++) {
        if (ag === s.agent) continue;
        const ax = c.pos[(f * 25 + ag) * 2], ay = c.pos[(f * 25 + ag) * 2 + 1];
        if (ax < -20) continue;
        const sx = sp.x - cx, sy = sp.y - cy, l2 = sx * sx + sy * sy;
        const u = clamp(((ax - cx) * sx + (ay - cy) * sy) / l2, 0, 1.05);
        const dd = Math.hypot(cx + sx * u - ax, cy + sy * u - ay);
        if (dd < 1.4) occ += (1.4 - dd) * (1.5 - u);
      }
      const score = occ * 5 + Math.abs(lat) * 0.15 + Math.abs(back - 6.5) * 0.1;
      if (score < bestS) { bestS = score; best = [cx, cy, 2.3]; }
    }
    strikeMemo.set(c, best);
    return best;
  }
  function ballAvg(c, ct, win) {
    let x = 0, y = 0, n = 0;
    for (let k = -4; k <= 4; k++) { const f2 = clamp(Math.round((ct + (k / 4) * win) * HZ), 0, c.N - 1); x += c.ball[f2 * 3]; y += c.ball[f2 * 3 + 1]; n++; }
    return { x: x / n, y: y / n };
  }
  // The main camera tilts gently towards the ball's side of the pitch (smoothed over ~1.5 s).
  function lookY(c, ct) {
    let y = 0, w = 0;
    for (let k = -8; k <= 8; k++) {
      const tt = clamp(ct + k * 0.1, 0, c.dur), f = Math.min(c.N - 1, Math.round(tt * HZ)), ww = 1 - Math.abs(k) / 9;
      y += c.ball[f * 3 + 1] * ww; w += ww;
    }
    return 29 + (y / w - 34) * 0.7;
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
    const ko = sc.ev?.type === 'kickoff' || sc.ev?.type === 'second_half';
    const base = (sc.min - 1) * 60 + (ko ? 0 : 25);
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
    // captions from before the clip's in-point aren't shown half-way through
    for (const c of caps) if (ct >= c.t && ct < c.t + 3.4 && c.t >= (sc.trimStart || 0) - 0.2 && !(RESTART_CAP.has(c.icon) && c.t > (sc.key ?? Infinity))) cap = c;
    if (!cap || !cap.text) return null;
    const p = clamp((ct - cap.t) / 0.35, 0, 1), q = clamp((cap.t + 3.4 - ct) / 0.35, 0, 1);
    drawLowerThird(ctx, sc.ev?.side, minuteStr(sc.min, sc.add), cap.text, cap.icon, Math.min(p, q), (1 - easeOut(p)) * 30);
    return cap;
  }
  function drawLowerThird(ctx, side, label, text, icon, alpha, slide) {
    const w = 860, x = (W - w) / 2, y = H - 92 + slide;
    ctx.save(); ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(6,10,8,0.86)'; D.roundRect(ctx, x, y, w, 56, 10); ctx.fill();
    ctx.fillStyle = side === 'B' ? TEAMS.B.color : side === 'A' ? TEAMS.A.color : '#16a34a';
    D.roundRect(ctx, x + 10, y + 10, 64, 36, 7); ctx.fill();
    ctx.fillStyle = lum(ctx.fillStyle) > 0.62 ? '#111' : '#fff';
    ctx.font = `900 16px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, x + 42, y + 28.5);
    if (icon === 'yellow' || icon === 'red') { ctx.fillStyle = icon === 'red' ? '#ef1c1c' : '#ffd400'; ctx.fillRect(x + 88, y + 15, 17, 25); }
    const tx = icon === 'yellow' || icon === 'red' ? x + 118 : x + 90;
    const lines = wrap(text, 650, fit(text, 650, 19, w - (tx - x) - 20, 14), w - (tx - x) - 20, 2);
    ctx.fillStyle = '#f8fafc'; ctx.textAlign = 'left';
    const fs = fit(lines[0], 650, 19, w - (tx - x) - 20, 14);
    ctx.font = `650 ${fs}px ${FONT}`;
    lines.forEach((ln, i) => ctx.fillText(ln, tx, y + 28.5 + (i - (lines.length - 1) / 2) * (fs + 3)));
    ctx.restore();
  }
  // The moment's description under the first replay angle (the live clip cuts away before it can be read).
  function replayCaption(ctx, sc, local) {
    const p = clamp((local - 300) / 350, 0, 1), q = clamp((sc.dur - 200 - local) / 250, 0, 1);
    if (Math.min(p, q) <= 0) return;
    drawLowerThird(ctx, sc.ev.side, minuteStr(sc.min, sc.add), sc.ev.text, null, Math.min(p, q), (1 - easeOut(p)) * 30);
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
  // ---------------------------------------------------------------- transitions
  // Every cut is covered by a transition that straddles it: it starts in the outgoing scene, hides
  // the switch at its peak and resolves in the incoming one — like a broadcast highlights package.
  function fxFor(a, b) {
    // into a replay: the REPLAY wipe; a second replay angle: a quick dip
    if (b.kind === 'replay') return a.kind === 'replay' ? { type: 'dip', pre: 0.1, post: 0.14 } : { type: 'replay', pre: 0.24, post: 0.32 };
    // into the analysis image: a flash, as if the picture froze
    if (b.kind === 'freeze') return { type: 'flash', pre: 0.06, post: 0.36 };
    // every live clip is a new moment of the match: team stinger with the minute
    if (b.kind === 'clip') return { type: 'stinger', pre: 0.32, post: 0.4 };
    // from the action to a full-screen graphic, and between graphics: a dip
    if (a.kind === 'clip' || a.kind === 'replay' || a.kind === 'freeze') return { type: 'dip', pre: 0.28, post: 0.32 };
    return { type: 'dip', pre: 0.2, post: 0.26 };
  }
  function sceneIndexAt(t) {
    const sc = built.scenes;
    let lo = 0, hi = sc.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (sc[mid].start <= t) lo = mid; else hi = mid - 1; }
    return lo;
  }
  function transitions(ctx, t) {
    const scs = built.scenes; if (scs.length < 2) return;
    const i = sceneIndexAt(t);
    const pairs = [];
    if (i + 1 < scs.length) pairs.push([scs[i + 1].start, scs[i], scs[i + 1]]);
    if (i > 0) pairs.push([scs[i].start, scs[i - 1], scs[i]]);
    for (const [B, a, b] of pairs) {
      const fx = fxFor(a, b);
      const p = (t - (B - fx.pre * 1000)) / ((fx.pre + fx.post) * 1000);
      if (p <= 0 || p >= 1) continue;
      const mid = fx.pre / (fx.pre + fx.post);
      drawFx(ctx, fx.type, p, mid, b);
    }
  }
  function drawFx(ctx, type, p, mid, b) {
    // k: 0 → 1 (fully covering) at the cut → 0
    const k = p < mid ? p / mid : 1 - (p - mid) / (1 - mid);
    ctx.save();
    if (type === 'dip') {
      ctx.fillStyle = `rgba(2,4,6,${easeInOut(Math.min(1, k * 1.05))})`; ctx.fillRect(0, 0, W, H);
    } else if (type === 'flash') {
      ctx.fillStyle = `rgba(255,255,255,${Math.pow(k, 1.6) * 0.9})`; ctx.fillRect(0, 0, W, H);
    } else if (type === 'stinger' || type === 'replay') {
      // three bands race across: they arrive (cover) before the cut and leave after it
      const cols = type === 'replay' ? [TEAMS.B.color, '#f8fafc', TEAMS.A.color] : [TEAMS.A.color, '#f8fafc', TEAMS.B.color];
      const span = W + 900;
      cols.forEach((col, j) => {
        const lag = j * 0.07;
        let x;
        if (p < mid) { const q = easeOut(clamp((p / mid - lag) / (1 - lag * 2), 0, 1)); x = -span * 0.5 + q * span * 0.5; }
        else { const q = easeInOut(clamp(((p - mid) / (1 - mid) - (0.14 - lag)) / 0.86, 0, 1)); x = q * span * 0.6; }
        const x0 = x + (j - 1) * 120;
        ctx.fillStyle = col;
        ctx.beginPath(); ctx.moveTo(x0 - 420, 0); ctx.lineTo(x0 + W + 120, 0); ctx.lineTo(x0 + W - 300, H); ctx.lineTo(x0 - 840, H); ctx.closePath(); ctx.fill();
      });
      // logo / minute on the band at full cover
      const a = clamp(1 - Math.abs(p - mid) / 0.22, 0, 1);
      if (a > 0) {
        ctx.globalAlpha = a;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
        const txt = (str, size, y) => { ctx.font = `italic 900 ${size}px ${FONT}`; ctx.lineWidth = size * 0.16; ctx.strokeStyle = 'rgba(5,8,10,0.85)'; ctx.strokeText(str, W / 2, y); ctx.fillStyle = '#ffffff'; ctx.fillText(str, W / 2, y); };
        if (type === 'replay') txt('REPLAY', 64, H / 2);
        else { txt('SÜPER LIG MIX', 30, H / 2 - 46); if (b.min) txt(minuteStr(b.min, b.add), 80, H / 2 + 16); }
      }
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
    // Big kinetic GOAL, then it shrinks into a banner at the top so the celebration is visible.
    const shrink = easeInOut(clamp((p - 0.85) / 0.55, 0, 1));
    ctx.save();
    ctx.translate(W / 2, (H / 2 - 40) * (1 - shrink) + 92 * shrink);
    ctx.scale(1 - 0.55 * shrink, 1 - 0.55 * shrink);
    ctx.translate(-W / 2, -(H / 2 - 40));
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
    ctx.restore();
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
    // Offside check, as broadcast: frozen as the ball is played; a line on the second-last
    // defender, a line on the attacker, the gap between them shaded and measured (Law 11).
    const off = c.marks.offside;
    if (off) {
      const tk = clamp(Math.round(off.t * HZ), 0, c.N - 1);
      const defSide = off.sideAtt === 'A' ? 'B' : 'A';
      const lineX = defSide === (sc.M.dir.A > 0 ? 'B' : 'A') ? c.offX[tk * 2 + 1] : c.offX[tk * 2];
      const rp = posAt(c, off.runner, off.t);
      const dirAtt = sc.M.dir[off.sideAtt];
      // who sets the line: the defender nearest it (or the ball, if it's further forward)
      let setter = null, bd = 0.6;
      for (let a = defSide === 'A' ? 0 : 11, e = a + 11; a < e; a++) { const q = posAt(c, a, off.t); if (q && q.x > -20 && Math.abs(q.x - lineX) < bd) { bd = Math.abs(q.x - lineX); setter = a; } }
      if (rp) {
        const margin = (rp.x - lineX) * dirAtt;
        // shaded offside gap
        const quad = [[lineX, -0.5], [rp.x, -0.5], [rp.x, C.WD + 0.5], [lineX, C.WD + 0.5]].map(([x, y]) => D.project(cam, x, y, 0.02, [0, 0, 0]));
        ctx.save(); ctx.fillStyle = margin > 0 ? 'rgba(255,77,87,0.28)' : 'rgba(56,189,248,0.22)';
        ctx.beginPath(); quad.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]))); ctx.closePath(); ctx.fill(); ctx.restore();
        D.worldLine(ctx, cam, rp.x, -0.5, rp.x, C.WD + 0.5, '#ff4d57', 3.5);
        // measured gap, at the attacker
        D.project(cam, rp.x, clamp(rp.y + 4, 2, C.WD - 2), 0, pj);
        const txt = margin > 0.05 ? `OFFSIDE · ${margin.toFixed(2)} m` : 'ONSIDE';
        ctx.font = `900 16px ${FONT}`; const tw = ctx.measureText(txt).width + 22;
        ctx.fillStyle = margin > 0.05 ? '#ff4d57' : '#38bdf8'; D.roundRect(ctx, pj[0] - tw / 2, pj[1] - 14, tw, 28, 6); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(txt, pj[0], pj[1] + 1);
      }
      D.worldLine(ctx, cam, lineX, -0.5, lineX, C.WD + 0.5, '#38bdf8', 3.5);
      D.project(cam, lineX, 1.5, 0, pj);
      const who = setter != null ? `SECOND-LAST DEFENDER · ${surname(allLooks()[setter]?.name || '').toUpperCase()}` : 'LINE OF THE BALL';
      ctx.fillStyle = '#38bdf8'; ctx.font = `800 13px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.fillText(who, pj[0], pj[1] - 8);
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
    const p = clamp(local / 500, 0, 1), out = 1 /* the transition covers the way out */;
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
    const p = clamp(local / 500, 0, 1), out = 1 /* the transition covers the way out */;
    ctx.save(); ctx.globalAlpha = Math.min(p, out);
    panel(ctx, 200, 60, 880, 600);
    scoreHeader(ctx, 'HALF-TIME', sc.score, 110);
    scorers(ctx, sc.goals, 210);
    const s = sc.stats;
    statRows(ctx, [['Shots', s.shots[0], s.shots[1]], ['On target', s.onT[0], s.onT[1]], ['Corners', s.corners[0], s.corners[1]], ['Fouls', s.fouls[0], s.fouls[1]], ['Offsides', s.offsides[0], s.offsides[1]], ['Yellow cards', s.yellow[0], s.yellow[1]], ['Red cards', s.red[0], s.red[1]]], 300, 270, 680);
    ctx.restore();
  }

  function drawFT(ctx, sc, local) {
    dimBackdrop(ctx, sc.start + local);
    const p = clamp(local / 500, 0, 1), out = 1 /* the transition covers the way out */;
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
    const p = clamp(local / 600, 0, 1), out = 1 /* the transition covers the way out */;
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
    const p = clamp(local / 500, 0, 1), out = 1 /* the transition covers the way out */;
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
    const p = clamp(local / 500, 0, 1), out = 1 /* the transition covers the way out */;
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
        }
        break;
      }
      case 'replay': {
        const ct = rampCt(sc, local);
        drawClip(ctx, sc, ct, sc.cam, { noTags: false });
        // Replay bug + letterbox vignette
        ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(0, 0, W, 34); ctx.fillRect(0, H - 34, W, 34);
        ctx.fillStyle = '#f8fafc'; D.roundRect(ctx, W - 176, 44, 140, 32, 6); ctx.fill();
        ctx.fillStyle = TEAMS[sc.ev.side || 'A'].color; ctx.beginPath(); ctx.arc(W - 156, 60, 7 + Math.sin(local / 140) * 1.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#111'; ctx.font = `900 15px ${FONT}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText('REPLAY', W - 140, 61);
        if (!noHud) {
          scorebug(ctx, { ...sc, goalAt: null }, t, sc.from);
          if (sc.angle === 0 && sc.ev.text) replayCaption(ctx, sc, local);
        }
        break;
      }
      case 'freeze': drawFreeze(ctx, sc, local); break;
      case 'var': drawVar(ctx, sc, local); break;
      case 'ht': drawHT(ctx, sc, local); break;
      case 'ft': drawFT(ctx, sc, local); break;
      case 'motm': drawMotm(ctx, sc, local); break;
      case 'ratings': drawRatings(ctx, sc, local); break;
      case 'analysis': drawAnalysis(ctx, sc, local); break;
      case 'montage': drawMontage(ctx, sc, local); break;
      case 'end': drawEnd(ctx, sc, local); break;
    }
    ctx.restore();
    transitions(ctx, t);
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
    if (sc.kind === 'ht') minute = 'HT';
    if (['ft', 'motm', 'ratings', 'analysis', 'montage', 'end'].includes(sc.kind)) { minute = 'FT'; score = built.state.score; }
    if (['intro', 'lineup'].includes(sc.kind)) { minute = ''; score = [0, 0]; }
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
    // Real faces: landmarks + hair (worker) and a baked head per photo. The 3D view works meanwhile
    // with plain heads; wait at most a few seconds so the rehearsal below sees the final heads.
    if (stage3d?.prepareFaces) await Promise.race([stage3d.prepareFaces(photoImgs).catch(e => console.warn('faces', e)), new Promise(r => setTimeout(r, 15000))]);
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
    scenes: () => built.scenes.map(s => ({ kind: s.kind, start: s.start, dur: s.dur, type: s.ev?.type, outcome: s.ev?.outcome, card: s.ev?.card, min: s.min, add: s.add, in: s.trimStart, out: s.outT, cam: s.cam })),
    teams: TEAMS,
  };
}

// Skin tone and hair colour sampled from the player's photo (white/grey background ignored), for
// the 2D graphics and until the 3D face is ready (three/face.js fits the photo onto the 3D head).
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

