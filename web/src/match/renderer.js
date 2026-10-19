// Deterministic broadcast-style match renderer.
// Builds an append-only timeline of scenes from streamed match items and draws any frame
// at time t (ms) onto a 1280×720 2D canvas. Same t => same pixels: no clocks, no Math.random.
// All easing / springs / interpolation come from Motion's pure utilities.

import { FORMATIONS, GROUP } from '../../../shared/game.js';
import { mix, clamp, easeInOut, easeOut, easeIn, backOut, circOut, cubicBezier, spring } from 'motion';

export const W = 1280, H = 720;

// ------------------------------------------------------------------ geometry
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const FH = 600, FW = Math.round(FH * 105 / 68);
const FL = Math.round((W - FW) / 2), FT = 70, FR = FL + FW, FB = FT + FH;
const CX = FL + FW / 2, CY = FT + FH / 2;
const GH = (7.32 / 68) * FH / 2;          // half goal width
const GD = 16;                            // goal depth
const BOXD = (16.5 / 105) * FW, BOXH = (40.32 / 68) * FH / 2;
const SIXD = (5.5 / 105) * FW, SIXH = (18.32 / 68) * FH / 2;
const SPOT = (11 / 105) * FW;
const CIRC = (9.15 / 105) * FW;
const TUNNEL = [CX, FT - 46];

// ------------------------------------------------------------------ math helpers (Motion-based)
const c01 = v => clamp(0, 1, v);
const seg = (t, a, b) => (b <= a ? (t >= b ? 1 : 0) : c01((t - a) / (b - a)));
const smooth = cubicBezier(0.22, 1, 0.36, 1);
const swift = cubicBezier(0.4, 0, 0.2, 1);

function springLUT(stiffness, damping, mass = 1, ms = 2400) {
  const gen = spring({ keyframes: [0, 1], stiffness, damping, mass });
  const n = Math.ceil(ms / 4) + 1, lut = new Float32Array(n);
  for (let i = 0; i < n; i++) lut[i] = gen.next(i * 4).value;
  lut[n - 1] = 1;
  return lut;
}
const SPR = {
  pop: springLUT(420, 15),
  soft: springLUT(220, 24),
  bouncy: springLUT(520, 10),
  snappy: springLUT(700, 36),
};
function spr(lut, ms) {
  if (ms <= 0) return 0;
  const f = ms / 4, i = f | 0;
  if (i >= lut.length - 1) return lut[lut.length - 1];
  return lut[i] + (lut[i + 1] - lut[i]) * (f - i);
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCanvas(w, h) {
  if (typeof document !== 'undefined') { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  return new OffscreenCanvas(w, h);
}

// ------------------------------------------------------------------ colour + text helpers
function hexRgb(hex) {
  let h = String(hex || '#888888').replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [136, 136, 136];
}
const lum = ([r, g, b]) => (0.299 * r + 0.587 * g + 0.114 * b) / 255;
const rgba = ([r, g, b], a) => `rgba(${r},${g},${b},${a})`;
const shade = ([r, g, b], k) => [Math.round(r * k), Math.round(g * k), Math.round(b * k)];

const font = (weight, size, italic = false) => `${italic ? 'italic ' : ''}${weight} ${Math.round(size * 10) / 10}px ${FONT}`;
let measureCtx = null;
const wCache = new Map();
function textW(f, text) {
  const k = f + '\u0000' + text;
  let w = wCache.get(k);
  if (w === undefined) {
    measureCtx ||= makeCanvas(8, 8).getContext('2d');
    measureCtx.font = f; w = measureCtx.measureText(text).width; wCache.set(k, w);
  }
  return w;
}
const fitCache = new Map();
function fitSize(text, weight, maxSize, maxW, minSize = 9, italic = false) {
  const k = `${text}|${weight}|${maxSize}|${maxW}|${italic}`;
  let s = fitCache.get(k);
  if (s === undefined) {
    s = maxSize;
    while (s > minSize && textW(font(weight, s, italic), text) > maxW) s -= 1;
    fitCache.set(k, s);
  }
  return s;
}
const wrapCache = new Map();
// Wraps text into at most maxLines lines of width maxW, shrinking the font if needed.
function wrap(text, weight, maxSize, maxW, maxLines, minSize = 11) {
  text = String(text ?? '');
  const k = `${text}|${weight}|${maxSize}|${maxW}|${maxLines}`;
  let r = wrapCache.get(k);
  if (r) return r;
  const words = text.split(/\s+/).filter(Boolean);
  for (let s = maxSize; s >= minSize; s -= 1) {
    const f = font(weight, s);
    const lines = []; let line = ''; let ok = true;
    for (const w of words) {
      if (textW(f, w) > maxW) { ok = false; break; }
      const test = line ? line + ' ' + w : w;
      if (line && textW(f, test) > maxW) { lines.push(line); line = w; } else line = test;
    }
    if (line) lines.push(line);
    if (ok && lines.length <= maxLines) { r = { size: s, lines }; break; }
  }
  if (!r) {
    // Last resort: hard truncate at the minimum size.
    const f = font(weight, minSize);
    const lines = []; let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (textW(f, test) > maxW && line) { lines.push(line); line = w; if (lines.length === maxLines) break; } else line = test;
    }
    if (lines.length < maxLines && line) lines.push(line);
    let last = lines[lines.length - 1] || '';
    while (last && textW(f, last + '…') > maxW) last = last.slice(0, -1);
    if (lines.length) lines[lines.length - 1] = last + (lines.join(' ').length < text.length ? '…' : '');
    r = { size: minSize, lines };
  }
  wrapCache.set(k, r);
  return r;
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const norm = s => String(s || '').toLocaleLowerCase('tr').replace(/ı/g, 'i').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
function surname(name) {
  const parts = String(name || '').trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  const last = parts[parts.length - 1];
  return last.length <= 2 ? parts.slice(-2).join(' ') : last;
}
function shortName(name) {
  const words = String(name || 'Team').trim().split(/\s+/).filter(Boolean);
  const up = s => s.toLocaleUpperCase('tr');
  if (words.length >= 2) return up(words.slice(0, 3).map(w => w[0]).join(''));
  return up(words[0].slice(0, 3));
}
function initials(name) {
  const p = String(name || '?').trim().split(/\s+/);
  return (p[0][0] + (p.length > 1 ? p[p.length - 1][0] : '')).toLocaleUpperCase('tr');
}

// ------------------------------------------------------------------ static pitch layer
const PITCH_SCALE = 1.5;
let PITCH = null;
function pitchLayer() {
  if (PITCH) return PITCH;
  const c = makeCanvas(W * PITCH_SCALE, H * PITCH_SCALE);
  const g = c.getContext('2d');
  g.scale(PITCH_SCALE, PITCH_SCALE);
  // grass with mowing stripes aligned to the field
  g.fillStyle = '#256f3a'; g.fillRect(0, 0, W, H);
  const stripes = 14, sw = FW / stripes;
  for (let i = -3; i < stripes + 3; i++) {
    g.fillStyle = i % 2 === 0 ? '#2f8a47' : '#2a7e41';
    g.fillRect(FL + i * sw, 0, sw + 0.5, H);
  }
  // subtle surround darkening
  g.fillStyle = 'rgba(0,0,0,0.16)';
  g.fillRect(0, 0, W, FT - 26); g.fillRect(0, FB + 26, W, H - FB - 26);
  g.fillRect(0, 0, FL - 30, H); g.fillRect(FR + 30, 0, W - FR - 30, H);
  // lines
  g.strokeStyle = 'rgba(240,250,243,0.9)'; g.lineWidth = 2.2; g.lineJoin = 'round';
  g.strokeRect(FL, FT, FW, FH);
  g.beginPath(); g.moveTo(CX, FT); g.lineTo(CX, FB); g.stroke();
  g.beginPath(); g.arc(CX, CY, CIRC, 0, Math.PI * 2); g.stroke();
  for (const [gx, dir] of [[FL, 1], [FR, -1]]) {
    g.strokeRect(dir > 0 ? gx : gx - BOXD, CY - BOXH, BOXD, BOXH * 2);
    g.strokeRect(dir > 0 ? gx : gx - SIXD, CY - SIXH, SIXD, SIXH * 2);
    const sx = gx + dir * SPOT;
    g.beginPath(); g.arc(sx, CY, CIRC, dir > 0 ? -0.927 : Math.PI - 0.927, dir > 0 ? 0.927 : Math.PI + 0.927); g.stroke();
    g.fillStyle = 'rgba(240,250,243,0.95)';
    g.beginPath(); g.arc(sx, CY, 2.6, 0, Math.PI * 2); g.fill();
    // goal + net
    const gx0 = dir > 0 ? gx - GD : gx;
    g.fillStyle = 'rgba(255,255,255,0.10)'; g.fillRect(gx0, CY - GH, GD, GH * 2);
    g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 0.8;
    for (let y = CY - GH; y <= CY + GH + 0.1; y += 6) { g.beginPath(); g.moveTo(gx0, y); g.lineTo(gx0 + GD, y); g.stroke(); }
    for (let x = gx0; x <= gx0 + GD + 0.1; x += 5) { g.beginPath(); g.moveTo(x, CY - GH); g.lineTo(x, CY + GH); g.stroke(); }
    g.strokeStyle = '#ffffff'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(gx, CY - GH); g.lineTo(gx - dir * GD, CY - GH); g.lineTo(gx - dir * GD, CY + GH); g.lineTo(gx, CY + GH); g.stroke();
    g.strokeStyle = 'rgba(240,250,243,0.9)'; g.lineWidth = 2.2;
  }
  g.fillStyle = 'rgba(240,250,243,0.95)';
  g.beginPath(); g.arc(CX, CY, 3, 0, Math.PI * 2); g.fill();
  for (const [x, y, a0] of [[FL, FT, 0], [FR, FT, Math.PI / 2], [FR, FB, Math.PI], [FL, FB, -Math.PI / 2]]) {
    g.beginPath(); g.arc(x, y, 7, a0, a0 + Math.PI / 2); g.stroke();
  }
  // floodlight vignette
  const vg = g.createRadialGradient(CX, CY, 120, CX, CY, 760);
  vg.addColorStop(0, 'rgba(255,255,255,0.07)');
  vg.addColorStop(0.55, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.42)');
  g.fillStyle = vg; g.fillRect(0, 0, W, H);
  PITCH = c;
  return c;
}

// Pre-built gradients/overlays that never change.
const DIM_GRADS = new WeakMap();
function dimGrad(ctx) {
  let g = DIM_GRADS.get(ctx);
  if (!g) {
    g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, 'rgba(4,8,6,0.92)');
    g.addColorStop(0.5, 'rgba(4,8,6,0.80)');
    g.addColorStop(1, 'rgba(4,8,6,0.94)');
    DIM_GRADS.set(ctx, g);
  }
  return g;
}

// ------------------------------------------------------------------ event typing
const MINOR = new Set(['possession', 'foul', 'kickoff', 'commentary']);
const ACTION = new Set(['chance', 'shot', 'save', 'block', 'woodwork', 'corner', 'free_kick']);
const GOALS = new Set(['goal', 'penalty_goal', 'own_goal']);
const CARDS = new Set(['yellow', 'second_yellow', 'red']);
const KNOWN = new Set([...MINOR, ...ACTION, ...GOALS, ...CARDS, 'penalty_miss', 'offside', 'injury', 'var', 'half_time', 'second_half', 'full_time']);

function outcomeFor(type, text) {
  const s = norm(text);
  if (type === 'save') return 'save';
  if (type === 'block') return 'block';
  if (type === 'woodwork') return 'post';
  if (/\b(post|crossbar|bar|woodwork|upright)\b/.test(s)) return 'post';
  if (/\b(save|saves|saved|keeper|parr|tipped|denied|stop|claims|gathers|catches)/.test(s)) return 'save';
  if (/\bblock/.test(s)) return 'block';
  if (/\bover\b/.test(s)) return 'over';
  return 'wide';
}

// ------------------------------------------------------------------ public factory
export function createMatch({ teams }) {
  // ---------------- teams
  const T = { A: prepTeam(teams?.A || {}, 'A'), B: prepTeam(teams?.B || {}, 'B') };
  const other = s => (s === 'A' ? 'B' : 'A');
  const dirOf = s => (s === 'A' ? 1 : -1);
  const goalX = s => (s === 'A' ? FR : FL); // goal the side attacks

  function prepTeam(team, side) {
    const formation = FORMATIONS[team.formation] ? team.formation : '4-3-3';
    const f = FORMATIONS[formation];
    const color = hexRgb(team.color || (side === 'A' ? '#e3262f' : '#2563eb'));
    const light = lum(color) > 0.62;
    const players = [];
    for (let i = 0; i < 11; i++) {
      const src = (team.players || [])[i] || {};
      const [role, fx, fy] = f[i];
      const reach = (100 - fy) / 100 * 0.5 * FW * 0.96;
      const bx = side === 'A' ? FL + 4 + reach : FR - 4 - reach;
      const by = side === 'A' ? FT + (fx / 100) * FH : FT + (1 - fx / 100) * FH;
      const grp = GROUP[src.role || role] || GROUP[role] || 'MID';
      players.push({
        i, side, name: src.name || `${side === 'A' ? 'Home' : 'Away'} ${i + 1}`, short: surname(src.name || `#${i + 1}`),
        role: src.role || role, img: src.img || '', bx, by,
        k: i === 0 || role === 'GK' ? 0.035 : grp === 'DEF' ? 0.2 : grp === 'MID' ? 0.26 : 0.33,
        sprite: null, photo: null,
      });
    }
    const t = {
      side, name: String(team.name || (side === 'A' ? 'Home' : 'Away')), formation, color, light,
      css: `rgb(${color.join(',')})`, dark: `rgb(${shade(color, 0.55).join(',')})`,
      ink: light ? '#0b1410' : '#ffffff', short: shortName(team.name || side), players, lookup: new Map(),
    };
    players.forEach(p => {
      t.lookup.set(norm(p.name), p.i);
      const sn = norm(p.short); if (sn && !t.lookup.has('~' + sn)) t.lookup.set('~' + sn, p.i);
    });
    players.forEach(p => { p.sprite = dotSprite(t, p); p.photo = initialsSprite(t, p); });
    return t;
  }

  function dotSprite(t, p) {
    const c = makeCanvas(104, 48), g = c.getContext('2d');
    const cx = 52, cy = 13;
    g.fillStyle = 'rgba(0,0,0,0.32)'; g.beginPath(); g.ellipse(cx + 1.5, cy + 3, 11, 9, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = t.css; g.beginPath(); g.arc(cx, cy, 10, 0, Math.PI * 2); g.fill();
    g.lineWidth = 2.2; g.strokeStyle = t.light ? '#0b1410' : '#ffffff'; g.stroke();
    if (p.i === 0) { g.lineWidth = 1.6; g.strokeStyle = t.light ? 'rgba(11,20,16,.7)' : 'rgba(255,255,255,.75)'; g.beginPath(); g.arc(cx, cy, 5, 0, Math.PI * 2); g.stroke(); }
    const s = fitSize(p.short, 700, 11, 96, 8);
    const f = font(700, s); const tw = textW(f, p.short);
    g.fillStyle = 'rgba(4,10,7,0.62)'; roundRect(g, cx - tw / 2 - 5, 27, tw + 10, 16, 8); g.fill();
    g.font = f; g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(p.short, cx, 35.5);
    return c;
  }
  function initialsSprite(t, p) {
    const c = makeCanvas(128, 128), g = c.getContext('2d');
    g.fillStyle = t.dark; g.beginPath(); g.arc(64, 64, 64, 0, Math.PI * 2); g.fill();
    g.fillStyle = t.css; g.beginPath(); g.arc(64, 64, 58, 0, Math.PI * 2); g.fill();
    g.fillStyle = t.ink; g.font = font(800, 46); g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(initials(p.name), 64, 67);
    return c;
  }
  function photoSprite(t, img) {
    const c = makeCanvas(128, 128), g = c.getContext('2d');
    g.save(); g.beginPath(); g.arc(64, 64, 64, 0, Math.PI * 2); g.clip();
    g.fillStyle = '#d9e2dc'; g.fillRect(0, 0, 128, 128);
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    const s = Math.min(iw, ih * 0.82);
    g.drawImage(img, (iw - s) / 2, ih * 0.02, s, s, 0, 0, 128, 128);
    g.restore();
    g.lineWidth = 6; g.strokeStyle = t.css; g.beginPath(); g.arc(64, 64, 61, 0, Math.PI * 2); g.stroke();
    return c;
  }

  function findPlayer(side, name) {
    if (!side || !name) return -1;
    const t = T[side]; const n = norm(name);
    if (t.lookup.has(n)) return t.lookup.get(n);
    const sn = norm(surname(name));
    if (t.lookup.has('~' + sn)) return t.lookup.get('~' + sn);
    for (const p of t.players) { const pn = norm(p.name); if (pn.includes(n) || (n.length > 3 && n.includes(norm(p.short)))) return p.i; }
    return -1;
  }
  function pickByRoles(side, roles, off, rnd) {
    const ps = T[side].players.filter(p => p.i !== 0 && !off.has(side + p.i));
    const pref = ps.filter(p => roles.includes(p.role));
    const pool = pref.length ? pref : ps.length ? ps : T[side].players;
    return pool[Math.floor(rnd() * pool.length) % pool.length].i;
  }
  const laneRoles = { left: ['LW', 'LM', 'LWB', 'LB'], right: ['RW', 'RM', 'RWB', 'RB'], center: ['ST', 'CAM', 'CM'] };
  const finisherRoles = { left: ['LW', 'ST', 'LM'], right: ['RW', 'ST', 'RM'], center: ['ST', 'CAM', 'LW', 'RW'] };
  const laneY = (side, zone) => {
    const off = zone === 'left' ? -1 : zone === 'right' ? 1 : 0;
    return CY + (side === 'A' ? off : -off) * 0.27 * FH;
  };

  // ---------------- positions
  const OUT = { x: 0, y: 0, h: 0 };
  function basePos(side, i, tilt, gt, out) {
    const p = T[side].players[i];
    let x = p.bx + tilt * p.k * FW;
    let y = p.by;
    const so = side === 'A' ? 0 : 2.1;
    x += Math.sin(gt * 0.0021 + i * 1.7 + so) * 3.2;
    y += Math.cos(gt * 0.0017 + i * 2.3 + so * 0.6) * 3.2;
    out.x = x < FL - 10 ? FL - 10 : x > FR + 10 ? FR + 10 : x;
    out.y = y < FT + 8 ? FT + 8 : y > FB - 8 ? FB - 8 : y;
    return out;
  }
  function tiltAt(sc, lt) { return mix(sc.tilt0, sc.tilt1, easeInOut(seg(lt, 0, sc.tiltDur))); }
  const TMP = { x: 0, y: 0, h: 0 };
  function playerPos(sc, side, i, lt, out = OUT) {
    basePos(side, i, tiltAt(sc, lt), sc.start + lt, out);
    const a = sc.actors && sc.actors.get(side + i);
    if (!a) return out;
    const keys = a.keys;
    if (lt <= keys[0][0]) { if (keys[0][1] != null) { out.x = keys[0][1]; out.y = keys[0][2]; } return out; }
    for (let k = 1; k < keys.length; k++) {
      const k0 = keys[k - 1], k1 = keys[k];
      if (lt <= k1[0] || k === keys.length - 1) {
        const p = easeInOut(seg(lt, k0[0], k1[0]));
        const bx = out.x, by = out.y;
        const x0 = k0[1] == null ? bx : k0[1], y0 = k0[1] == null ? by : k0[2];
        const x1 = k1[1] == null ? bx : k1[1], y1 = k1[1] == null ? by : k1[2];
        out.x = mix(x0, x1, p); out.y = mix(y0, y1, p);
        return out;
      }
    }
    return out;
  }
  function ballPos(sc, lt, out = OUT) {
    const k = sc.kf;
    if (lt <= k[0].t) { out.x = k[0].x; out.y = k[0].y; out.h = 0; return out; }
    for (let i = 1; i < k.length; i++) {
      const b = k[i];
      if (lt <= b.t || i === k.length - 1) {
        const a = k[i - 1];
        const raw = seg(lt, a.t, b.t);
        const p = (b.ease || easeInOut)(raw);
        if (b.cx != null) {
          const u = 1 - p;
          out.x = u * u * a.x + 2 * u * p * b.cx + p * p * b.x;
          out.y = u * u * a.y + 2 * u * p * b.cy + p * p * b.y;
        } else { out.x = mix(a.x, b.x, p); out.y = mix(a.y, b.y, p); }
        out.h = b.arc ? 4 * b.arc * raw * (1 - raw) : 0;
        return out;
      }
    }
    return out;
  }

  // ---------------- timeline builder
  let scenes, st, items0, processed, complete, meta, stats, ratings, analysis;
  function reset() {
    scenes = []; processed = 0; complete = false; meta = null; stats = null; ratings = null; analysis = {};
    items0 = [];
    st = {
      t: 0, score: [0, 0], tilt: 0, ball: { x: CX, y: CY }, clock: 0, off: new Set(), poss: 'A',
      pending: null, pendingFT: null, kickoffDone: false, seed: 1,
    };
    pushScene({ kind: 'intro', dur: 4200, bug: false });
    pushScene({ kind: 'lineups', dur: 5200, bug: false });
  }

  function pushScene(sc) {
    sc.start = st.t;
    sc.scoreBefore = sc.scoreBefore || [st.score[0], st.score[1]];
    sc.scoreAfter = sc.scoreAfter || sc.scoreBefore;
    sc.goalT = sc.goalT ?? Infinity;
    sc.tilt0 = sc.tilt0 ?? st.tilt;
    sc.tilt1 = sc.tilt1 ?? st.tilt;
    sc.tiltDur = sc.tiltDur ?? Math.min(800, sc.dur * 0.6);
    sc.off = sc.off || new Set(st.off);
    sc.clock0 = sc.clock0 ?? st.clock;
    sc.clock1 = sc.clock1 ?? st.clock;
    sc.caption = sc.caption || [];
    if (!sc.kf) sc.kf = [{ t: 0, x: st.ball.x, y: st.ball.y }];
    if (sc.bug === undefined) sc.bug = true;
    scenes.push(sc);
    st.t += sc.dur;
    st.tilt = sc.tilt1;
    st.clock = sc.clock1;
    const end = ballPos(sc, sc.dur, { x: 0, y: 0, h: 0 });
    st.ball = { x: end.x, y: end.y };
    return sc;
  }
  // Positions at build time need the scene's start, so allocate it first.
  function newScene(kind, dur, extra = {}) {
    return Object.assign({ kind, dur, start: st.t, tilt0: st.tilt, off: new Set(st.off), actors: new Map() }, extra);
  }
  function pp(sc, side, i, lt) { const o = playerPos(sc, side, i, lt, { x: 0, y: 0, h: 0 }); return [o.x, o.y]; }
  const minuteLabel = d => (d.add > 0 ? `${d.min}+${d.add}'` : `${d.min}'`);
  function clockFor(d) {
    const m = Number(d.min) || 0;
    if (d.add > 0) return m;
    return Math.max(st.clock, m - 0.5);
  }
  function rngFor(idx) { return mulberry32((idx + 1) * 2654435761 ^ 0x9e3779b9); }

  function ensureKickoff() {
    if (st.kickoffDone) return;
    st.kickoffDone = true;
    const kick = meta?.kickoff === 'B' ? 'B' : 'A';
    const sc = newScene('kickoff', 3400, { kick, headline: meta?.headline || '', referee: meta?.referee || '', weather: meta?.weather || '', bug: true, clock0: 0, clock1: 0, label: '' });
    sc.tilt0 = 0; sc.tilt1 = 0;
    for (const side of ['A', 'B']) for (let i = 0; i < 11; i++) {
      const d = i * 55 + (side === 'B' ? 25 : 0);
      sc.actors.set(side + i, { keys: [[0, TUNNEL[0], TUNNEL[1]], [150 + d, TUNNEL[0], TUNNEL[1]], [1500 + d, null, 0]] });
    }
    sc.kf = [{ t: 0, x: CX, y: CY }, { t: sc.dur, x: CX, y: CY }];
    sc.caption = sc.headline ? [{ t0: 1900, t1: sc.dur, text: sc.headline, badge: 'KO', side: kick }] : [];
    pushScene(sc);
    st.poss = kick;
  }

  function flushPending() {
    const g = st.pending;
    if (!g) return;
    st.pending = null;
    const first = g.items[0].data;
    let side = g.items.map(x => x.data.side).find(s => s === 'A' || s === 'B') || st.poss;
    const n = g.items.length;
    const dur = Math.min(1500, 640 + 280 * (n - 1));
    const rnd = rngFor(g.items[0].index);
    const isFoul = g.items.every(x => x.data.type === 'foul');
    const sc = newScene('beat', dur, { side, eventIndex: g.items[0].index, label: minuteLabel(first) });
    sc.tilt1 = isFoul ? st.tilt * 0.7 : (side === 'A' ? 0.26 : -0.26) + (rnd() - 0.5) * 0.12;
    sc.tiltDur = dur * 0.8;
    sc.clock0 = st.clock; sc.clock1 = clockFor(first); sc.stoppage = first.add > 0 ? first.add : 0; sc.min = first.min;
    const zone = first.zone || ['left', 'center', 'right'][Math.floor(rnd() * 3)];
    const i1 = pickByRoles(side, laneRoles[zone], sc.off, rnd);
    let i2 = pickByRoles(side, rnd() < 0.5 ? laneRoles.center : laneRoles[zone], sc.off, rnd);
    if (i2 === i1) i2 = pickByRoles(side, ['CM', 'CDM', 'CAM', 'ST'], sc.off, rnd);
    const [x1, y1] = pp(sc, side, i1, dur * 0.42);
    const [x2, y2] = pp(sc, side, i2, dur * 0.92);
    sc.kf = [{ t: 0, x: st.ball.x, y: st.ball.y }, { t: dur * 0.42, x: x1, y: y1, ease: swift }, { t: dur * 0.92, x: x2, y: y2, ease: swift, arc: rnd() < 0.3 ? 14 : 0 }, { t: dur, x: x2, y: y2 }];
    const slot = dur / n;
    sc.caption = g.items.map((x, k) => ({ t0: k * slot, t1: (k + 1) * slot, text: x.data.text || '', badge: minuteLabel(x.data), side: x.data.side, icon: x.data.type === 'foul' ? 'whistle' : null, index: x.index, type: x.data.type }));
    pushScene(sc);
    st.poss = side;
  }

  function addEvent(d, index) {
    const type = KNOWN.has(d.type) ? d.type : 'commentary';
    if (type === 'full_time') { flushPending(); st.pendingFT = { d, index }; return; }
    if (MINOR.has(type)) {
      const key = `${d.min}+${d.add || 0}`;
      if (st.pending && st.pending.key === key && st.pending.items.length < 4) st.pending.items.push({ data: { ...d, type }, index });
      else { flushPending(); st.pending = { key, items: [{ data: { ...d, type }, index }] }; }
      return;
    }
    flushPending();
    if (ACTION.has(type) || type === 'penalty_miss') return actionScene(d, type, index);
    if (GOALS.has(type)) return actionScene(d, type, index);
    if (CARDS.has(type)) return cardScene(d, type, index);
    if (type === 'var') return staticScene(d, 'var', 2300, index);
    if (type === 'injury') return staticScene(d, 'injury', 1500, index);
    if (type === 'offside') return staticScene(d, 'offside', 1400, index);
    if (type === 'half_time') return breakScene(d, 'ht', index);
    if (type === 'second_half') return secondHalf(d, index);
  }

  function staticScene(d, kind, dur, index) {
    const side = d.side === 'A' || d.side === 'B' ? d.side : st.poss;
    const sc = newScene(kind, dur, { side, eventIndex: index, evType: kind, label: minuteLabel(d), clock0: st.clock, clock1: clockFor(d), stoppage: d.add > 0 ? d.add : 0, min: d.min });
    sc.tilt1 = st.tilt * 0.8;
    const rnd = rngFor(index);
    if (kind === 'offside') {
      const i1 = pickByRoles(side, ['CM', 'CAM', 'CDM'], sc.off, rnd), i2 = pickByRoles(side, ['ST', 'LW', 'RW'], sc.off, rnd);
      const [x1, y1] = pp(sc, side, i1, 400), [x2, y2] = pp(sc, side, i2, 900);
      sc.kf = [{ t: 0, x: st.ball.x, y: st.ball.y }, { t: 400, x: x1, y: y1 }, { t: 900, x: x2, y: y2, arc: 10 }, { t: dur, x: x2, y: y2 }];
    } else sc.kf = [{ t: 0, x: st.ball.x, y: st.ball.y }, { t: dur, x: st.ball.x, y: st.ball.y }];
    sc.caption = [{ t0: 0, t1: dur, text: d.text || '', badge: minuteLabel(d), side: d.side, icon: kind }];
    sc.player = d.player || '';
    pushScene(sc);
  }

  function cardScene(d, type, index) {
    const side = d.side === 'A' || d.side === 'B' ? d.side : other(st.poss);
    const dur = type === 'second_yellow' ? 2600 : 2000;
    const sc = newScene('card', dur, { side, cardType: type, evType: type, eventIndex: index, label: minuteLabel(d), clock0: st.clock, clock1: clockFor(d), stoppage: d.add > 0 ? d.add : 0, min: d.min, player: d.player || '' });
    sc.tilt1 = st.tilt * 0.6;
    sc.kf = [{ t: 0, x: st.ball.x, y: st.ball.y }, { t: dur, x: st.ball.x, y: st.ball.y }];
    sc.caption = [{ t0: 250, t1: dur, text: d.text || '', badge: minuteLabel(d), side, icon: 'card' }];
    if (type !== 'yellow') {
      const i = findPlayer(side, d.player);
      if (i > 0 || (i === 0 && T[side].players[0])) { sc.offKey = side + i; sc.offAt = dur * 0.62; }
    }
    pushScene(sc);
    if (sc.offKey) st.off.add(sc.offKey);
  }

  function breakScene(d, which, index) {
    const sc = newScene(which, which === 'ht' ? 3100 : 4400, { eventIndex: index ?? -1, evType: which === 'ht' ? 'half_time' : 'full_time', label: which === 'ht' ? 'HT' : 'FT' });
    sc.clock0 = st.clock; sc.clock1 = which === 'ht' ? 45 : 90;
    sc.tilt1 = 0; sc.tiltDur = 1200;
    sc.kf = [{ t: 0, x: st.ball.x, y: st.ball.y }, { t: 900, x: CX, y: CY }, { t: sc.dur, x: CX, y: CY }];
    sc.text = d?.text || '';
    if (which === 'ft') sc.stats = stats;
    pushScene(sc);
    if (which === 'ht') st.clock = 45;
  }

  function secondHalf(d, index) {
    const kick = meta?.kickoff === 'A' ? 'B' : 'A';
    const sc = newScene('second', 1700, { eventIndex: index, evType: 'second_half', label: "46'", kick });
    sc.clock0 = 45; sc.clock1 = 45;
    sc.tilt1 = 0;
    sc.kf = [{ t: 0, x: CX, y: CY }, { t: sc.dur, x: CX, y: CY }];
    sc.caption = d?.text ? [{ t0: 300, t1: sc.dur, text: d.text, badge: "46'", side: null }] : [];
    pushScene(sc);
    st.poss = kick;
  }

  function actionScene(d, type, index) {
    const rnd = rngFor(index);
    let side = d.side === 'A' || d.side === 'B' ? d.side : st.poss;
    const isGoal = GOALS.has(type), isPen = type === 'penalty_goal' || type === 'penalty_miss', isOG = type === 'own_goal';
    const dir = dirOf(side), gx = goalX(side), opp = other(side);
    const zone = d.zone === 'left' || d.zone === 'right' || d.zone === 'center' ? d.zone : (['left', 'center', 'right'][Math.floor(rnd() * 3)]);
    let outcome = isGoal ? 'goal' : type === 'penalty_miss' ? (/\b(save|keeper|saved|denied)/.test(norm(d.text)) ? 'save' : (/post|bar/.test(norm(d.text)) ? 'post' : 'over')) : outcomeFor(type, d.text);
    if (type === 'corner' && outcome === 'wide' && rnd() < 0.4) outcome = 'caught';
    const dur = isPen ? (isGoal ? 5000 : 3100) : isGoal ? (isOG ? 4500 : 4700) : type === 'corner' || type === 'free_kick' ? 2400 : 2150;
    const kind = isGoal ? 'goal' : 'action';
    const sc = newScene(kind, dur, { side, type, evType: type, outcome, eventIndex: index, label: minuteLabel(d), clock0: st.clock, clock1: clockFor(d), stoppage: d.add > 0 ? d.add : 0, min: d.min, player: d.player || '', assist: d.assist || '' });
    sc.tilt1 = isPen ? (side === 'A' ? 0.7 : -0.7) : (side === 'A' ? 0.58 : -0.58);
    sc.tiltDur = isPen ? 900 : 750;
    const actors = sc.actors;
    const gkOpp = 0;

    // who
    let shooter = isOG ? pickByRoles(side, finisherRoles[zone], sc.off, rnd) : findPlayer(side, d.player);
    if (shooter < 0 || sc.off.has(side + shooter)) shooter = pickByRoles(side, finisherRoles[zone], sc.off, rnd);
    let passer = findPlayer(side, d.assist);
    if (passer < 0 || passer === shooter || sc.off.has(side + passer)) passer = pickByRoles(side, laneRoles[zone].concat(['CM', 'CAM']), sc.off, rnd);
    if (passer === shooter) passer = pickByRoles(side, ['CM', 'CDM', 'CAM'], sc.off, rnd);
    let ogDef = isOG ? findPlayer(opp, d.player) : -1;
    if (isOG && ogDef < 0) ogDef = pickByRoles(opp, ['CB'], sc.off, rnd);
    sc.shooter = shooter; sc.passer = passer; sc.ogDef = ogDef;

    // where
    const ly = laneY(side, zone);
    const spotDepth = isPen ? SPOT : SPOT * (0.75 + rnd() * 0.75);
    const shot = { x: gx - dir * spotDepth, y: isPen ? CY : mix(CY, ly, 0.45) + (rnd() - 0.5) * 40 };
    const fk = type === 'free_kick' ? { x: gx - dir * (BOXD + 70 + rnd() * 50), y: mix(CY, ly, 0.5) } : null;
    if (fk) { shot.x = fk.x; shot.y = fk.y; }
    const gyIn = CY + (rnd() < 0.5 ? -1 : 1) * GH * (0.35 + rnd() * 0.45);
    let target, after;
    let dive = null;
    if (outcome === 'goal') {
      target = { x: gx + dir * 9, y: gyIn };
      after = { x: gx + dir * (GD - 3), y: gyIn + (rnd() - 0.5) * 8 };
      dive = { x: gx - dir * 10, y: CY - (gyIn - CY) * 0.9 };          // dives the wrong way
    } else if (outcome === 'save' || outcome === 'caught') {
      const sy = CY + (rnd() - 0.5) * GH * 1.4;
      target = { x: gx - dir * 12, y: sy };
      dive = { x: target.x, y: sy };
      after = outcome === 'caught' ? { ...target } : { x: gx - dir * (55 + rnd() * 40), y: sy + (sy < CY ? -1 : 1) * (60 + rnd() * 50) };
    } else if (outcome === 'post') {
      const py = CY + (rnd() < 0.5 ? -1 : 1) * GH;
      target = { x: gx, y: py };
      after = { x: gx - dir * (80 + rnd() * 50), y: py + (py < CY ? -1 : 1) * (40 + rnd() * 40) };
      dive = { x: gx - dir * 10, y: py + (py < CY ? 1 : -1) * 6 };
    } else if (outcome === 'block') {
      target = { x: mix(shot.x, gx, 0.32), y: mix(shot.y, CY, 0.32) };
      after = { x: target.x - dir * 30, y: target.y + (rnd() < 0.5 ? -1 : 1) * 70 };
    } else {
      const wy = CY + (rnd() < 0.5 ? -1 : 1) * (GH + 22 + rnd() * 50);
      target = { x: gx + dir * 26, y: outcome === 'over' ? CY + (rnd() - 0.5) * GH : wy };
      after = { x: gx + dir * 34, y: target.y };
    }

    // timings
    const tPass = isPen ? 500 : type === 'corner' ? 700 : 520;
    const tRecv = isPen ? 1300 : type === 'corner' ? 1250 : 1050;
    const tShot = tRecv + (isPen ? 320 : 330);
    const tAfter = tShot + 420;
    sc.tShot = tRecv; sc.tHit = tShot;

    // actors
    if (isPen) {
      const run0 = { x: shot.x - dir * 46, y: CY + 14 };
      actors.set(side + shooter, { keys: [[0, null, 0], [500, run0.x, run0.y], [tRecv - 120, run0.x, run0.y], [tRecv + 40, shot.x - dir * 6, CY], [dur - 500, shot.x - dir * 6, CY], [dur, null, 0]] });
      // everyone else waits outside the box: sorted by height, spaced apart, alternating two lines
      const moved = [];
      for (const s of ['A', 'B']) for (let i = 1; i < 11; i++) {
        if (s === side && i === shooter) continue;
        const [bx, by] = pp(sc, s, i, 700);
        if (side === 'A' ? bx > gx - BOXD - 40 : bx < gx + BOXD + 40) moved.push({ s, i, by });
      }
      moved.sort((a, b) => a.by - b.by);
      const gap = 30, span = (moved.length - 1) * gap;
      let y0 = Math.max(FT + 24, Math.min(FB - 24 - span, CY - span / 2));
      moved.forEach((m, k) => {
        const tx = gx - dir * (BOXD + 30 + (k % 2) * 34);
        const ty = y0 + k * gap;
        actors.set(m.s + m.i, { keys: [[0, null, 0], [700, tx, ty], [dur - 400, tx, ty], [dur, null, 0]] });
      });
    } else {
      actors.set(side + shooter, { keys: [[0, null, 0], [180, null, 0], [tRecv - 40, shot.x, shot.y], [dur - 700, shot.x + dir * 14, shot.y], [dur, null, 0]] });
    }
    if (dive) {
      actors.set(opp + gkOpp, { keys: [[0, null, 0], [tShot - 140, null, 0], [tShot + 60, dive.x, dive.y], [dur - 600, dive.x, dive.y], [dur, null, 0]] });
    }
    if (outcome === 'block') {
      const blk = pickByRoles(opp, ['CB', 'CDM'], sc.off, rnd);
      actors.set(opp + blk, { keys: [[0, null, 0], [tRecv - 300, null, 0], [tShot - 30, target.x, target.y], [dur - 500, target.x, target.y], [dur, null, 0]] });
    }
    if (isOG && ogDef >= 0) {
      const ogSpot = { x: gx - dir * 34, y: CY + (ly > CY ? 1 : -1) * 28 };
      actors.set(opp + ogDef, { keys: [[0, null, 0], [tRecv - 200, null, 0], [tShot - 60, ogSpot.x, ogSpot.y], [dur - 600, ogSpot.x, ogSpot.y], [dur, null, 0]] });
      sc.ogSpot = ogSpot;
    }

    // ball path
    const kf = [{ t: 0, x: st.ball.x, y: st.ball.y }];
    if (isPen) {
      kf.push({ t: 600, x: shot.x, y: shot.y, ease: smooth });
      kf.push({ t: tRecv, x: shot.x, y: shot.y });
    } else if (type === 'corner') {
      const cy = ly < CY ? FT + 4 : FB - 4;
      kf.push({ t: tPass, x: gx - dir * 3, y: cy, ease: swift });
      kf.push({ t: tRecv, x: shot.x, y: shot.y, arc: 34, cx: gx - dir * 90, cy: mix(cy, CY, 0.3), ease: easeInOut });
    } else if (fk) {
      kf.push({ t: tPass, x: fk.x, y: fk.y, ease: smooth });
      kf.push({ t: tRecv, x: fk.x, y: fk.y });
      actors.set(side + shooter, { keys: [[0, null, 0], [tPass, fk.x - dir * 30, fk.y + 10], [tRecv, fk.x - dir * 8, fk.y], [dur - 500, fk.x - dir * 8, fk.y], [dur, null, 0]] });
    } else {
      const [px, py] = pp(sc, side, passer, tPass);
      kf.push({ t: tPass, x: px, y: py, ease: swift });
      kf.push({ t: tRecv, x: shot.x, y: shot.y, ease: swift, arc: rnd() < 0.45 ? 18 : 0 });
    }
    if (isOG) {
      kf.push({ t: tShot - 90, x: sc.ogSpot.x, y: sc.ogSpot.y, ease: swift });
      kf.push({ t: tShot + 140, x: target.x, y: target.y, ease: easeIn });
    } else {
      const curve = type === 'free_kick' ? { cx: mix(shot.x, target.x, 0.5), cy: mix(shot.y, target.y, 0.5) + (rnd() < 0.5 ? -1 : 1) * 70 } : {};
      kf.push({ t: tShot, x: target.x, y: target.y, ease: easeIn, arc: outcome === 'over' ? 26 : type === 'corner' ? 6 : 8, ...curve });
    }
    kf.push({ t: tAfter, x: after.x, y: after.y, ease: easeOut });
    if (isGoal) {
      kf.push({ t: dur - 260, x: after.x, y: after.y });
      kf.push({ t: dur, x: CX, y: CY, ease: easeInOut });
    } else {
      kf.push({ t: dur, x: after.x, y: after.y });
    }
    sc.kf = kf;
    sc.target = target;

    // camera: push in on the goal, then back out
    const focus = { x: mix(shot.x, gx, 0.45), y: mix(shot.y, CY, 0.5) };
    sc.cam = { x: focus.x, y: focus.y, z: isPen ? 1.42 : 1.24, in0: isPen ? 200 : 300, in1: isPen ? 1100 : 1000, out0: isGoal ? 2300 : dur - 650, out1: isGoal ? 3300 : dur };

    // scoring
    if (isGoal) {
      sc.goalT = tShot - (isOG ? 0 : 20);
      const s = [st.score[0], st.score[1]];
      s[side === 'A' ? 0 : 1]++;
      sc.scoreAfter = s;
      const conf = new Float32Array(110 * 6);
      for (let k = 0; k < 110; k++) {
        conf[k * 6] = rnd() * W; conf[k * 6 + 1] = -30 - rnd() * 260; conf[k * 6 + 2] = 140 + rnd() * 220;
        conf[k * 6 + 3] = (rnd() - 0.5) * 90; conf[k * 6 + 4] = rnd() * 6.28; conf[k * 6 + 5] = Math.floor(rnd() * 3);
      }
      sc.confetti = conf;
      sc.tilt1 = 0; sc.tiltDur = dur;   // drift back towards kickoff shape during the celebration
    }
    const punch = isGoal ? null : outcome === 'save' ? 'SAVE!' : outcome === 'caught' ? 'CLAIMED' : outcome === 'post' ? 'OFF THE POST!' : outcome === 'block' ? 'BLOCKED!' : outcome === 'over' ? 'OVER!' : 'WIDE!';
    sc.punch = punch ? { text: type === 'penalty_miss' ? (outcome === 'save' ? 'PENALTY SAVED!' : 'PENALTY MISSED!') : punch, t0: tShot - 40 } : null;
    sc.caption = [{ t0: 120, t1: isGoal ? sc.goalT : dur, text: d.text || '', badge: minuteLabel(d), side, icon: isPen ? 'pen' : null }];
    sc.banner = isPen ? 'PENALTY' : type === 'corner' ? 'CORNER' : type === 'free_kick' ? 'FREE KICK' : null;
    sc.text = d.text || '';
    pushScene(sc);
    if (isGoal) { st.score = sc.scoreAfter; st.poss = other(side); }
    else st.poss = outcome === 'save' || outcome === 'caught' || outcome === 'block' ? opp : side;
  }

  function outroScenes() {
    const order = ['A', 'B'];
    const motm = stats?.motm;
    const motmSide = motm?.side === 'B' ? 'B' : motm?.side === 'A' ? 'A' : null;
    const sc0 = newScene('motm', 4000, { bug: false, label: 'FT', motm, motmSide, motmIdx: motm ? findPlayer(motmSide || 'A', motm.player) : -1 });
    sc0.kf = [{ t: 0, x: CX, y: CY }, { t: sc0.dur, x: CX, y: CY }];
    if (motm) pushScene(sc0);
    for (const s of order) {
      const a = analysis[s];
      if (!a) continue;
      const sc = newScene('team', 5600, { bug: false, label: 'FT', teamSide: s, an: a, rating: avgRating(s) });
      sc.kf = [{ t: 0, x: CX, y: CY }, { t: sc.dur, x: CX, y: CY }];
      pushScene(sc);
    }
    const end = newScene('end', 4200, { bug: false, label: 'FT' });
    end.kf = [{ t: 0, x: CX, y: CY }, { t: end.dur, x: CX, y: CY }];
    pushScene(end);
  }
  function avgRating(side) {
    const r = ratings?.[side];
    if (!Array.isArray(r) || !r.length) return null;
    const v = r.map(x => Number(x.rating)).filter(Number.isFinite);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  }
  function playerRating(side, name) {
    const r = ratings?.[side];
    if (!Array.isArray(r)) return null;
    const n = norm(name);
    const hit = r.find(x => norm(x.player) === n) || r.find(x => norm(surname(x.player)) === norm(surname(name)));
    return hit && Number.isFinite(Number(hit.rating)) ? Number(hit.rating) : null;
  }

  function process(item, index) {
    if (complete || !item || typeof item !== 'object') return;
    const kind = item.kind, d = item.data && typeof item.data === 'object' ? item.data : {};
    try {
      if (kind === 'meta') { if (!meta) meta = d; ensureKickoff(); return; }
      if (kind === 'ev') {
        ensureKickoff();
        const ev = { ...d, min: Math.max(0, Math.min(130, Number.parseInt(d.min, 10) || 0)), add: Math.max(0, Math.min(15, Number.parseInt(d.add, 10) || 0)), type: String(d.type || 'commentary'), side: d.side === 'A' || d.side === 'B' ? d.side : null, text: String(d.text || '').slice(0, 220) };
        addEvent(ev, index);
        return;
      }
      if (kind === 'stats') {
        stats = d;
        if (st.pendingFT) { const p = st.pendingFT; st.pendingFT = null; breakScene(p.d, 'ft', p.index); }
        return;
      }
      if (kind === 'ratings') { ratings = d; return; }
      if (kind === 'analysis') { if (d.side === 'A' || d.side === 'B') analysis[d.side] = d; return; }
      if (kind === 'end') {
        ensureKickoff();
        flushPending();
        if (st.pendingFT) { const p = st.pendingFT; st.pendingFT = null; breakScene(p.d, 'ft', p.index); }
        else if (!scenes.some(s => s.kind === 'ft')) breakScene({ text: '' }, 'ft', -1);
        outroScenes();
        complete = true;
      }
    } catch (e) {
      // Never let a malformed item break the timeline.
      if (typeof console !== 'undefined') console.warn('[match] skipped item', index, e);
    }
  }

  reset();

  function setItems(items) {
    if (!Array.isArray(items)) return;
    if (items.length < processed || (processed > 0 && items[0] !== items0[0] && JSON.stringify(items[0]) !== JSON.stringify(items0[0]))) reset();
    for (let i = processed; i < items.length; i++) process(items[i], i);
    processed = items.length;
    items0 = items;
  }

  // ------------------------------------------------------------------ lookup
  function sceneIndexAt(t) {
    let lo = 0, hi = scenes.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (scenes[m].start <= t) lo = m; else hi = m - 1; }
    return lo;
  }
  const duration = () => { const s = scenes[scenes.length - 1]; return s ? s.start + s.dur : 0; };

  // Flat, append-only list of what plays when (one entry per item for merged beats).
  let tl = [], tlScenes = 0, tlOwner = null;
  const KIND_OF = { intro: 'intro', lineups: 'lineups', kickoff: 'kickoff', ht: 'halftime', ft: 'fulltime', motm: 'outro', team: 'outro', end: 'outro' };
  function timeline() {
    if (tlOwner !== scenes) { tl = []; tlScenes = 0; tlOwner = scenes; }
    for (; tlScenes < scenes.length; tlScenes++) {
      const sc = scenes[tlScenes];
      if (sc.kind === 'beat') {
        for (const c of sc.caption) tl.push({ start: sc.start + c.t0, end: sc.start + c.t1, kind: 'ev', type: c.type || 'commentary', itemIndex: c.index ?? -1, side: c.side === 'A' || c.side === 'B' ? c.side : null, minute: c.badge || sc.label || '' });
        continue;
      }
      const synthetic = KIND_OF[sc.kind];
      tl.push({
        start: sc.start, end: sc.start + sc.dur,
        kind: synthetic || 'ev',
        type: sc.evType || (synthetic ? sc.kind : null),
        itemIndex: sc.eventIndex ?? -1,
        side: sc.side === 'A' || sc.side === 'B' ? sc.side : sc.teamSide || null,
        minute: sc.kind === 'ht' ? 'HT' : synthetic === 'fulltime' || synthetic === 'outro' ? 'FT' : sc.label || '',
      });
    }
    return tl;
  }
  function ftStart() { for (const sc of scenes) if (sc.kind === 'ft') return sc.start; return Infinity; }
  const scoreAt = (sc, lt) => (lt >= sc.goalT ? sc.scoreAfter : sc.scoreBefore);
  function clockText(sc, lt) {
    if (sc.kind === 'ht') return { main: '45:00', extra: 'HT' };
    if (sc.kind === 'ft' || sc.kind === 'motm' || sc.kind === 'team' || sc.kind === 'end') return { main: '90:00', extra: 'FT' };
    if (sc.stoppage) return { main: `${sc.min}:00`, extra: `+${sc.stoppage}` };
    const m = mix(sc.clock0, sc.clock1, seg(lt, 0, sc.dur));
    const mm = Math.floor(m), ss = Math.floor((m - mm) * 60);
    return { main: `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`, extra: '' };
  }

  // ------------------------------------------------------------------ drawing: world
  function camAt(sc, lt) {
    const c = sc.cam;
    let x = CX, y = CY, z = 1;
    if (c) {
      const pin = smooth(seg(lt, c.in0, c.in1)), pout = easeInOut(seg(lt, c.out0, c.out1));
      const p = pin * (1 - pout);
      z = mix(1, c.z, p); x = mix(CX, c.x, p); y = mix(CY, c.y, p);
    }
    // keep the view inside the canvas
    const hw = W / (2 * z), hh = H / (2 * z);
    x = Math.max(hw, Math.min(W - hw, x)); y = Math.max(hh, Math.min(H - hh, y));
    let sx = 0, sy = 0;
    if (sc.kind === 'goal' && lt >= sc.goalT && lt < sc.goalT + 520) {
      const k = 1 - (lt - sc.goalT) / 520;
      sx = Math.sin(lt * 0.09) * 7 * k; sy = Math.cos(lt * 0.113) * 5 * k;
    }
    CAM.x = x; CAM.y = y; CAM.z = z; CAM.sx = sx; CAM.sy = sy;
    return CAM;
  }
  const CAM = { x: CX, y: CY, z: 1, sx: 0, sy: 0 };

  function drawWorld(ctx, sc, lt, showPlayers = true) {
    const cam = camAt(sc, lt);
    ctx.setTransform(cam.z, 0, 0, cam.z, W / 2 - cam.x * cam.z + cam.sx, H / 2 - cam.y * cam.z + cam.sy);
    ctx.drawImage(pitchLayer(), 0, 0, W, H);
    if (sc.kind === 'goal') drawNetRipple(ctx, sc, lt);
    if (showPlayers) {
      for (const side of ['B', 'A']) {
        const team = T[side];
        for (let i = 0; i < 11; i++) {
          const key = side + i;
          let alpha = 1;
          if (sc.off.has(key)) continue;
          if (sc.offKey === key && lt > sc.offAt) { alpha = 1 - seg(lt, sc.offAt, sc.offAt + 450); if (alpha <= 0) continue; }
          const p = playerPos(sc, side, i, lt);
          if (sc.kind === 'kickoff' && p.y < FT - 20) alpha *= seg(p.y, FT - 46, FT - 20);
          if (alpha < 1) ctx.globalAlpha = alpha;
          ctx.drawImage(team.players[i].sprite, p.x - 52, p.y - 13);
          if (alpha < 1) ctx.globalAlpha = 1;
        }
      }
    }
    drawBall(ctx, sc, lt);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  function drawBall(ctx, sc, lt) {
    const b = ballPos(sc, lt);
    if (sc.kind === 'goal' && lt > sc.dur - 300) return;
    const h = b.h;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath(); ctx.ellipse(b.x + h * 0.35, b.y + 2 + h * 0.2, 6 + h * 0.05, 3.5, 0, 0, Math.PI * 2); ctx.fill();
    const r = 5.6 + h * 0.07;
    ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#0d1410'; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(b.x, b.y - h, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#1b2420'; ctx.beginPath(); ctx.arc(b.x - r * 0.2, b.y - h - r * 0.15, r * 0.36, 0, Math.PI * 2); ctx.fill();
  }

  function drawNetRipple(ctx, sc, lt) {
    if (lt < sc.goalT || lt > sc.goalT + 1300) return;
    const p = (lt - sc.goalT) / 1300;
    const amp = 13 * (1 - p) * Math.abs(Math.sin(p * Math.PI * 4.5));
    const side = sc.side, gx = goalX(side), dir = dirOf(side);
    const back = gx + dir * GD;
    ctx.strokeStyle = `rgba(255,255,255,${0.85 * (1 - p)})`; ctx.lineWidth = 1.4;
    for (let k = 0; k <= 4; k++) {
      const off = k * (GD / 4);
      ctx.beginPath();
      ctx.moveTo(gx + dir * off, CY - GH);
      ctx.quadraticCurveTo(gx + dir * (off + amp * (k / 4 + 0.3)), CY, gx + dir * off, CY + GH);
      ctx.stroke();
    }
    ctx.beginPath(); ctx.moveTo(back, CY - GH); ctx.quadraticCurveTo(back + dir * amp * 1.6, CY, back, CY + GH); ctx.stroke();
  }

  // ------------------------------------------------------------------ drawing: overlays
  function drawBug(ctx, sc, lt) {
    const score = scoreAt(sc, lt);
    const pulse = sc.kind === 'goal' && lt >= sc.goalT ? 1 + 0.16 * Math.max(0, Math.sin(seg(lt, sc.goalT, sc.goalT + 700) * Math.PI)) : 1;
    const x = 22, y = 18, h = 40;
    const A = T.A, B = T.B;
    const nameF = font(800, 17);
    const wA = Math.max(46, textW(nameF, A.short) + 22), wB = Math.max(46, textW(nameF, B.short) + 22);
    const ck = clockText(sc, lt);
    const wS = 74, wC = ck.extra ? 120 : 86;
    const total = 8 + wA + wS + wB + 8 + wC;
    ctx.fillStyle = 'rgba(6,10,8,0.86)'; roundRect(ctx, x, y, total, h, 10); ctx.fill();
    // team chips
    ctx.fillStyle = A.css; ctx.fillRect(x + 8, y + 9, 5, h - 18);
    ctx.fillStyle = B.css; ctx.fillRect(x + 8 + wA + wS + wB - 5, y + 9, 5, h - 18);
    ctx.font = nameF; ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    ctx.fillText(A.short, x + 8 + wA / 2 + 3, y + h / 2 + 1);
    ctx.fillText(B.short, x + 8 + wA + wS + wB / 2 - 3, y + h / 2 + 1);
    // score
    const sx = x + 8 + wA, scx = sx + wS / 2;
    ctx.fillStyle = '#f4f7f5'; roundRect(ctx, sx + 4, y + 5, wS - 8, h - 10, 6); ctx.fill();
    ctx.save(); ctx.translate(scx, y + h / 2 + 1); ctx.scale(pulse, pulse);
    ctx.fillStyle = '#0b1410'; ctx.font = font(900, 20); ctx.fillText(`${score[0]} – ${score[1]}`, 0, 0);
    ctx.restore();
    // clock
    const cx0 = x + total - wC;
    ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fillRect(cx0, y + 7, 1, h - 14);
    ctx.fillStyle = '#e8efe9'; ctx.font = font(800, 16);
    if (ck.extra) {
      ctx.textAlign = 'left'; ctx.fillText(ck.main, cx0 + 10, y + h / 2 + 1);
      const ew = textW(font(800, 12), ck.extra) + 10;
      ctx.fillStyle = ck.extra === 'HT' || ck.extra === 'FT' ? '#f5b301' : '#e3262f';
      roundRect(ctx, cx0 + wC - ew - 6, y + 11, ew, 18, 5); ctx.fill();
      ctx.fillStyle = ck.extra === 'HT' || ck.extra === 'FT' ? '#1a1300' : '#fff'; ctx.font = font(800, 12); ctx.textAlign = 'center';
      ctx.fillText(ck.extra, cx0 + wC - ew / 2 - 6, y + h / 2 + 1);
    } else { ctx.textAlign = 'center'; ctx.fillText(ck.main, cx0 + wC / 2, y + h / 2 + 1); }
    // match progress
    const m = ck.extra === 'FT' ? 90 : ck.extra === 'HT' ? 45 : sc.stoppage ? sc.min : mix(sc.clock0, sc.clock1, seg(lt, 0, sc.dur));
    ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(x + 10, y + h + 4, total - 20, 3);
    ctx.fillStyle = '#7ee2a8'; ctx.fillRect(x + 10, y + h + 4, (total - 20) * Math.min(1, m / 90), 3);
  }

  function drawCaption(ctx, sc, lt) {
    const caps = sc.caption;
    if (!caps || !caps.length) return;
    let cap = null;
    for (let i = 0; i < caps.length; i++) if (lt >= caps[i].t0 && lt < caps[i].t1) { cap = caps[i]; break; }
    if (!cap || !cap.text) return;
    const first = caps[0], last = caps[caps.length - 1];
    const inP = smooth(seg(lt, first.t0, first.t0 + 220));
    const outP = seg(lt, last.t1 - 160, last.t1);
    const alpha = inP * (1 - outP);
    if (alpha <= 0.01) return;
    const textIn = caps.length > 1 ? smooth(seg(lt, cap.t0, cap.t0 + 160)) : 1;
    const bw = 900, bh = 62, bx = (W - bw) / 2, by = H - bh - 16 + (1 - inP) * 24;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(6,10,8,0.88)'; roundRect(ctx, bx, by, bw, bh, 12); ctx.fill();
    const team = cap.side === 'A' || cap.side === 'B' ? T[cap.side] : null;
    const bc = team ? team.css : '#e8efe9', bink = team ? team.ink : '#0b1410';
    const badge = cap.badge || '';
    const bwid = Math.max(70, textW(font(900, 18), badge) + 26);
    ctx.fillStyle = bc; roundRect(ctx, bx + 8, by + 8, bwid, bh - 16, 8); ctx.fill();
    ctx.fillStyle = bink; ctx.font = font(900, fitSize(badge, 900, 18, bwid - 12, 11)); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(badge, bx + 8 + bwid / 2, by + bh / 2 + 1);
    let tx = bx + 8 + bwid + 16;
    if (cap.icon) { drawIcon(ctx, cap.icon, tx + 10, by + bh / 2, sc); tx += 30; }
    const maxW = bx + bw - 18 - tx;
    const wr = wrap(cap.text, 600, 19, maxW, 2, 12);
    ctx.globalAlpha = alpha * textIn;
    ctx.fillStyle = '#f2f6f3'; ctx.font = font(600, wr.size); ctx.textAlign = 'left';
    const lh = wr.size * 1.22, y0 = by + bh / 2 - ((wr.lines.length - 1) * lh) / 2 + (1 - textIn) * 6;
    for (let i = 0; i < wr.lines.length; i++) ctx.fillText(wr.lines[i], tx, y0 + i * lh + 1);
    ctx.globalAlpha = 1;
  }

  function drawIcon(ctx, icon, x, y, sc) {
    ctx.save();
    if (icon === 'card') {
      ctx.fillStyle = sc.cardType === 'yellow' ? '#f5c518' : '#e3262f';
      ctx.translate(x, y); ctx.rotate(0.18); roundRect(ctx, -7, -10, 14, 20, 2.5); ctx.fill();
    } else if (icon === 'injury') {
      ctx.fillStyle = '#ff5d5d'; ctx.fillRect(x - 3, y - 9, 6, 18); ctx.fillRect(x - 9, y - 3, 18, 6);
    } else if (icon === 'offside') {
      ctx.strokeStyle = '#e8efe9'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x - 6, y + 10); ctx.lineTo(x - 6, y - 10); ctx.stroke();
      ctx.fillStyle = '#f5b301'; ctx.fillRect(x - 5, y - 10, 13, 9);
    } else if (icon === 'var') {
      ctx.strokeStyle = '#8fd3ff'; ctx.lineWidth = 2; roundRect(ctx, x - 10, y - 7, 20, 14, 3); ctx.stroke();
    } else if (icon === 'whistle') {
      ctx.fillStyle = '#c9d4ce'; ctx.beginPath(); ctx.arc(x - 2, y + 2, 6, 0, Math.PI * 2); ctx.fill(); ctx.fillRect(x - 2, y - 4, 12, 5);
    } else if (icon === 'pen') {
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#0b1410'; ctx.beginPath(); ctx.arc(x, y, 2.4, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  function drawPunch(ctx, text, t, color, size = 96, y = H * 0.42, hold = 900) {
    if (t < 0 || t > hold + 300) return;
    const s = 0.35 + 0.65 * spr(SPR.pop, t);
    const a = (1 - seg(t, hold, hold + 300));
    const fs = fitSize(text, 900, size, W - 160, 30, true);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(W / 2, y); ctx.scale(s, s); ctx.rotate(-0.04);
    ctx.font = font(900, fs, true); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillText(text, 5, 7);
    ctx.lineWidth = Math.max(4, fs * 0.08); ctx.strokeStyle = color; ctx.strokeText(text, 0, 0);
    ctx.fillStyle = '#ffffff'; ctx.fillText(text, 0, 0);
    ctx.restore();
  }

  function drawBanner(ctx, text, t, side) {
    if (!text || t < 0 || t > 1300) return;
    const team = T[side];
    const p = smooth(seg(t, 0, 260)) * (1 - seg(t, 1050, 1300));
    const w = textW(font(900, 22), text) + 44;
    const x = W - 22 - w * p, y = 18;
    ctx.globalAlpha = p;
    ctx.fillStyle = team ? team.css : '#fff'; roundRect(ctx, x, y, w, 40, 10); ctx.fill();
    ctx.fillStyle = team ? team.ink : '#0b1410'; ctx.font = font(900, 22); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, x + w / 2, y + 21);
    ctx.globalAlpha = 1;
  }

  function dim(ctx, a) { if (a <= 0) return; ctx.fillStyle = `rgba(4,8,6,${a})`; ctx.fillRect(0, 0, W, H); }

  function photo(side, i) { const p = T[side]?.players[i]; return p ? p.photo : null; }
  function drawPhoto(ctx, side, i, x, y, d) {
    const ph = photo(side, i);
    if (ph) ctx.drawImage(ph, x - d / 2, y - d / 2, d, d);
  }

  // ------------------------------------------------------------------ scenes
  function drawIntro(ctx, sc, lt) {
    ctx.drawImage(pitchLayer(), 0, 0, W, H);
    ctx.fillStyle = dimGrad(ctx); ctx.fillRect(0, 0, W, H);
    const A = T.A, B = T.B;
    const pa = spr(SPR.soft, lt - 80), pb = spr(SPR.soft, lt - 220);
    // colour slabs
    ctx.save();
    ctx.fillStyle = A.css; ctx.globalAlpha = 0.95;
    ctx.beginPath(); const ax = mix(-W * 0.6, 0, pa);
    ctx.moveTo(ax, 0); ctx.lineTo(ax + W * 0.47, 0); ctx.lineTo(ax + W * 0.41, H); ctx.lineTo(ax, H); ctx.fill();
    ctx.fillStyle = B.css;
    ctx.beginPath(); const bx = mix(W * 0.6, 0, pb);
    ctx.moveTo(W + bx, 0); ctx.lineTo(W + bx - W * 0.41, 0); ctx.lineTo(W + bx - W * 0.47, H); ctx.lineTo(W + bx, H); ctx.fill();
    ctx.restore();
    // darken slabs slightly for legibility
    ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.fillRect(0, 0, W, H);
    // names
    const nA = fitSize(A.name.toLocaleUpperCase('tr'), 900, 64, W * 0.36, 22, true);
    const nB = fitSize(B.name.toLocaleUpperCase('tr'), 900, 64, W * 0.36, 22, true);
    const ta = spr(SPR.pop, lt - 300), tb = spr(SPR.pop, lt - 420);
    ctx.textBaseline = 'middle';
    ctx.save(); ctx.globalAlpha = c01(ta); ctx.translate(mix(-200, 0, ta), 0);
    ctx.font = font(900, nA, true); ctx.textAlign = 'left'; ctx.fillStyle = A.ink; ctx.fillText(A.name.toLocaleUpperCase('tr'), 70, H / 2 - 18);
    ctx.font = font(700, 18); ctx.globalAlpha *= 0.85; ctx.fillText(`${A.formation} · ${A.short}`, 72, H / 2 + 30);
    ctx.restore();
    ctx.save(); ctx.globalAlpha = c01(tb); ctx.translate(mix(200, 0, tb), 0);
    ctx.font = font(900, nB, true); ctx.textAlign = 'right'; ctx.fillStyle = B.ink; ctx.fillText(B.name.toLocaleUpperCase('tr'), W - 70, H / 2 - 18);
    ctx.font = font(700, 18); ctx.globalAlpha *= 0.85; ctx.fillText(`${B.short} · ${B.formation}`, W - 72, H / 2 + 30);
    ctx.restore();
    // VS badge
    const v = spr(SPR.bouncy, lt - 700);
    if (v > 0) {
      ctx.save(); ctx.translate(W / 2, H / 2 - 4); ctx.scale(v, v); ctx.rotate((1 - v) * -0.6);
      ctx.fillStyle = '#0b1410'; ctx.beginPath(); ctx.arc(0, 0, 58, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 5; ctx.strokeStyle = '#fff'; ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = font(900, 46, true); ctx.textAlign = 'center'; ctx.fillText('VS', -2, 2);
      ctx.restore();
    }
    // top/bottom labels
    const l1 = smooth(seg(lt, 900, 1400));
    ctx.globalAlpha = l1; ctx.textAlign = 'center';
    ctx.fillStyle = '#fff'; ctx.font = font(800, 15);
    ctx.fillText('S Ü P E R   L I G   M I X', W / 2, 62);
    const chip = 'NEUTRAL GROUND · NO HOME ADVANTAGE';
    const cw = textW(font(800, 14), chip) + 34;
    ctx.fillStyle = 'rgba(6,10,8,0.82)'; roundRect(ctx, W / 2 - cw / 2, H - 120 + (1 - l1) * 16, cw, 34, 17); ctx.fill();
    ctx.fillStyle = '#7ee2a8'; ctx.font = font(800, 14); ctx.fillText(chip, W / 2, H - 102 + (1 - l1) * 16);
    ctx.globalAlpha = smooth(seg(lt, 1300, 1800));
    ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.font = font(600, 14);
    ctx.fillText('Simulated by GPT-6 Luna', W / 2, H - 60);
    ctx.globalAlpha = 1;
    dim(ctx, seg(lt, sc.dur - 320, sc.dur) * 0.9);
  }

  function drawLineups(ctx, sc, lt) {
    ctx.drawImage(pitchLayer(), 0, 0, W, H);
    ctx.fillStyle = dimGrad(ctx); ctx.fillRect(0, 0, W, H);
    dim(ctx, 0.9 * (1 - seg(lt, 0, 300)));
    const colW = 520, gap = 80, x0 = (W - colW * 2 - gap) / 2;
    ctx.textBaseline = 'middle';
    const head = smooth(seg(lt, 0, 420));
    ctx.globalAlpha = head; ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.font = font(900, 26, true);
    ctx.fillText('STARTING LINE-UPS', W / 2, 42 - (1 - head) * 10);
    ctx.globalAlpha = 1;
    for (const [s, ci] of [['A', 0], ['B', 1]]) {
      const team = T[s], cx = x0 + ci * (colW + gap);
      const hp = spr(SPR.soft, lt - 120 - ci * 120);
      ctx.save(); ctx.globalAlpha = c01(hp); ctx.translate((ci ? 1 : -1) * (1 - hp) * 60, 0);
      ctx.fillStyle = team.css; roundRect(ctx, cx, 72, colW, 50, 10); ctx.fill();
      ctx.fillStyle = team.ink; ctx.textAlign = 'left';
      const nm = team.name.toLocaleUpperCase('tr');
      ctx.font = font(900, fitSize(nm, 900, 24, colW - 130, 12, true), true); ctx.fillText(nm, cx + 18, 98);
      ctx.font = font(800, 15); ctx.textAlign = 'right'; ctx.fillText(team.formation, cx + colW - 16, 98);
      ctx.restore();
      for (let i = 0; i < 11; i++) {
        const p = team.players[i];
        const rp = spr(SPR.soft, lt - 300 - i * 70 - ci * 40);
        if (rp <= 0.001) continue;
        const y = 140 + i * 46;
        ctx.save(); ctx.globalAlpha = c01(rp * 1.2); ctx.translate((ci ? 1 : -1) * (1 - rp) * 80, 0);
        ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.08)'; roundRect(ctx, cx, y, colW, 42, 8); ctx.fill();
        drawPhoto(ctx, s, i, cx + 24, y + 21, 34);
        ctx.fillStyle = '#f2f6f3'; ctx.textAlign = 'left';
        ctx.font = font(700, fitSize(p.name, 700, 17, colW - 140, 11)); ctx.fillText(p.name, cx + 50, y + 22);
        const rw = textW(font(800, 12), p.role) + 16;
        ctx.fillStyle = 'rgba(255,255,255,0.12)'; roundRect(ctx, cx + colW - rw - 12, y + 11, rw, 20, 5); ctx.fill();
        ctx.fillStyle = '#cfe1d6'; ctx.font = font(800, 12); ctx.textAlign = 'center'; ctx.fillText(p.role, cx + colW - rw / 2 - 12, y + 21.5);
        ctx.restore();
      }
    }
    dim(ctx, seg(lt, sc.dur - 300, sc.dur) * 0.8);
  }

  function drawKickoff(ctx, sc, lt) {
    drawWorld(ctx, sc, lt);
    dim(ctx, 0.8 * (1 - seg(lt, 0, 380)));
    // coin toss
    const cp = seg(lt, 350, 1700);
    if (lt > 300 && lt < 2050) {
      const kickA = sc.kick === 'A';
      const ang = easeOut(cp) * (Math.PI * 8 + (kickA ? 0 : Math.PI));
      const sy = Math.cos(ang);
      const lift = Math.sin(cp * Math.PI) * 110;
      const a = 1 - seg(lt, 1800, 2050);
      ctx.save(); ctx.globalAlpha = a; ctx.translate(CX, CY - 40 - lift); ctx.scale(1, Math.max(0.06, Math.abs(sy)));
      ctx.fillStyle = sy >= 0 ? T.A.css : T.B.css; ctx.beginPath(); ctx.arc(0, 0, 34, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 5; ctx.strokeStyle = '#f5d76e'; ctx.stroke();
      ctx.fillStyle = sy >= 0 ? T.A.ink : T.B.ink; ctx.font = font(900, 18); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(sy >= 0 ? T.A.short : T.B.short, 0, 1);
      ctx.restore();
    }
    drawBug(ctx, sc, lt);
    drawPunch(ctx, 'KICK-OFF!', lt - 1750, T[sc.kick].css, 92, H * 0.4, 1150);
    if (lt > 1800) {
      const p = smooth(seg(lt, 1800, 2200));
      const sub = [sc.referee && `Referee: ${sc.referee}`, sc.weather].filter(Boolean).join(' · ');
      if (sub) {
        ctx.globalAlpha = p * (1 - seg(lt, sc.dur - 250, sc.dur));
        ctx.font = font(700, 15); ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(sub, W / 2, H * 0.4 + 70);
        ctx.globalAlpha = 1;
      }
    }
    drawCaption(ctx, sc, lt);
  }

  function drawPitchScene(ctx, sc, lt) {
    drawWorld(ctx, sc, lt);
    if (sc.kind === 'var') drawVar(ctx, sc, lt);
    drawBug(ctx, sc, lt);
    if (sc.banner) drawBanner(ctx, sc.banner, lt - 60, sc.side);
    if (sc.kind === 'card') drawCard(ctx, sc, lt);
    if (sc.kind === 'offside') drawPunch(ctx, 'OFFSIDE', lt - 820, '#f5b301', 70, H * 0.4, 520);
    if (sc.kind === 'injury') drawPunch(ctx, 'INJURY', lt - 200, '#ff5d5d', 60, H * 0.4, 800);
    if (sc.kind === 'second') drawPunch(ctx, 'SECOND HALF', lt - 150, T[sc.kick].css, 84, H * 0.42, 1150);
    if (sc.punch) drawPunch(ctx, sc.punch.text, lt - sc.punch.t0, sc.side ? T[sc.side].css : '#fff', sc.punch.text.length > 10 ? 80 : 104);
    drawCaption(ctx, sc, lt);
  }

  function drawVar(ctx, sc, lt) {
    const a = smooth(seg(lt, 0, 250)) * (1 - seg(lt, sc.dur - 250, sc.dur));
    ctx.globalAlpha = a;
    dim(ctx, 0.45);
    ctx.fillStyle = 'rgba(143,211,255,0.08)';
    for (let y = (lt * 0.12) % 8; y < H; y += 8) ctx.fillRect(0, y, W, 2);
    const by = (lt * 0.35) % (H + 160) - 80;
    ctx.fillStyle = 'rgba(143,211,255,0.16)'; ctx.fillRect(0, by, W, 60);
    const bw = 340, bh = 92, bx = (W - bw) / 2, bY = H * 0.36;
    ctx.fillStyle = 'rgba(6,14,20,0.92)'; roundRect(ctx, bx, bY, bw, bh, 14); ctx.fill();
    ctx.strokeStyle = '#8fd3ff'; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = '#8fd3ff'; ctx.font = font(900, 34, true); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('VAR CHECK', W / 2 + 18, bY + bh / 2);
    ctx.save(); ctx.translate(bx + 40, bY + bh / 2); ctx.rotate(lt * 0.008);
    ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(0, 0, 14, 0, Math.PI * 1.4); ctx.stroke();
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  function drawCard(ctx, sc, lt) {
    const a = smooth(seg(lt, 0, 200)) * (1 - seg(lt, sc.dur - 260, sc.dur));
    ctx.globalAlpha = a; dim(ctx, 0.34); ctx.globalAlpha = 1;
    const second = sc.cardType === 'second_yellow';
    const flip1 = seg(lt, 80, 560);
    let sx = Math.abs(Math.cos((1 - backOut(flip1)) * Math.PI / 2 * 1.0));
    let color = sc.cardType === 'yellow' ? '#f5c518' : '#e3262f';
    if (second) {
      const f2 = seg(lt, 1050, 1450);
      if (lt < 1050) color = '#f5c518';
      else { const ang = f2 * Math.PI; sx = Math.abs(Math.cos(ang)); color = f2 < 0.5 ? '#f5c518' : '#e3262f'; }
    }
    const lift = spr(SPR.pop, lt - 60);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(W / 2, H * 0.4 + (1 - lift) * 60); ctx.rotate(0.12 * (1 - lift) - 0.06);
    ctx.scale(Math.max(0.04, sx), 1);
    ctx.fillStyle = 'rgba(0,0,0,0.35)'; roundRect(ctx, -58, -78, 124, 170, 12); ctx.fill();
    ctx.fillStyle = color; roundRect(ctx, -64, -86, 124, 170, 12); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.22)'; roundRect(ctx, -56, -78, 40, 154, 8); ctx.fill();
    ctx.restore();
    const team = T[sc.side];
    const label = sc.cardType === 'yellow' ? 'YELLOW CARD' : second ? 'SECOND YELLOW · SENT OFF' : 'RED CARD · SENT OFF';
    const p = smooth(seg(lt, 350, 700));
    ctx.globalAlpha = a * p; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff'; const nm = sc.player || team.name;
    ctx.font = font(900, fitSize(nm, 900, 34, 640, 16)); ctx.fillText(nm, W / 2, H * 0.4 + 128);
    ctx.font = font(800, 15); ctx.fillStyle = color === '#f5c518' ? '#f5c518' : '#ff7b7b'; ctx.fillText(label, W / 2, H * 0.4 + 160);
    ctx.globalAlpha = 1;
  }

  function drawGoal(ctx, sc, lt) {
    drawWorld(ctx, sc, lt);
    const team = T[sc.side];
    const g0 = sc.goalT;
    if (lt >= g0) {
      // flash
      const f = 1 - seg(lt, g0, g0 + 380);
      if (f > 0) { ctx.fillStyle = `rgba(255,255,255,${0.62 * f})`; ctx.fillRect(0, 0, W, H); }
      // colour wash
      const wash = smooth(seg(lt, g0 + 120, g0 + 500)) * (1 - seg(lt, sc.dur - 500, sc.dur));
      if (wash > 0) { ctx.fillStyle = rgba(team.color, 0.28 * wash); ctx.fillRect(0, 0, W, H); dim(ctx, 0.25 * wash); }
      drawConfetti(ctx, sc, lt - g0, team);
    }
    drawBug(ctx, sc, lt);
    if (sc.banner) drawBanner(ctx, sc.banner, lt - 60, sc.side);
    drawCaption(ctx, sc, lt);
    if (lt >= g0 + 120) drawGoalText(ctx, sc, lt - g0 - 120, team);
    if (lt >= g0 + 520) drawScorer(ctx, sc, lt - g0 - 520, team);
  }

  function drawGoalText(ctx, sc, t, team) {
    const word = sc.type === 'own_goal' ? 'OWN GOAL!' : 'GOAL!';
    const fs = sc.type === 'own_goal' ? 128 : 176;
    const f = font(900, fs, true);
    const total = textW(f, word);
    const fade = 1 - seg(t, sc.dur - sc.goalT - 120 - 900, sc.dur - sc.goalT - 120 - 500);
    if (fade <= 0) return;
    let x = W / 2 - total / 2;
    ctx.font = f; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left'; ctx.lineJoin = 'round';
    const baseY = H * 0.47;
    const fill = team.light ? '#ffffff' : team.css, stroke = team.light ? '#0b1410' : '#ffffff';
    for (let i = 0; i < word.length; i++) {
      const ch = word[i];
      const cw = textW(f, ch);
      const s = spr(SPR.bouncy, t - i * 55);
      if (s > 0.001) {
        const wob = Math.sin((t - i * 55) * 0.012) * 4 * (1 - seg(t, 0, 1400));
        ctx.save();
        ctx.globalAlpha = fade;
        ctx.translate(x + cw / 2, baseY - (1 - s) * 80 + wob); ctx.scale(s, s); ctx.rotate(-0.05);
        ctx.fillStyle = 'rgba(0,0,0,0.42)'; ctx.fillText(ch, -cw / 2 + 7, 9);
        ctx.lineWidth = 12; ctx.strokeStyle = stroke; ctx.strokeText(ch, -cw / 2, 0);
        ctx.fillStyle = fill; ctx.fillText(ch, -cw / 2, 0);
        ctx.restore();
      }
      x += cw;
    }
    ctx.textBaseline = 'middle';
  }

  function drawScorer(ctx, sc, t, team) {
    const p = spr(SPR.soft, t);
    const fade = 1 - seg(t, sc.dur - sc.goalT - 520 - 600, sc.dur - sc.goalT - 520 - 250);
    if (fade <= 0) return;
    const bw = 620, bh = 96, bx = (W - bw) / 2, by = H - bh - 26 + (1 - p) * 140;
    ctx.save(); ctx.globalAlpha = fade * c01(p * 1.3);
    ctx.fillStyle = 'rgba(6,10,8,0.92)'; roundRect(ctx, bx, by, bw, bh, 16); ctx.fill();
    ctx.fillStyle = team.css; roundRect(ctx, bx, by, 10, bh, 5); ctx.fill();
    const isOG = sc.type === 'own_goal';
    const pSide = isOG ? other(sc.side) : sc.side, pIdx = isOG ? sc.ogDef : sc.shooter;
    drawPhoto(ctx, pSide, pIdx, bx + 62, by + bh / 2, 72);
    const name = isOG ? (sc.player || T[pSide].players[pIdx]?.name || '') : (sc.player || T[sc.side].players[sc.shooter]?.name || '');
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff';
    ctx.font = font(900, fitSize(name.toLocaleUpperCase('tr'), 900, 28, bw - 150, 14)); ctx.fillText(name.toLocaleUpperCase('tr'), bx + 112, by + 36);
    const line2 = [sc.label, sc.type === 'penalty_goal' ? 'Penalty' : isOG ? 'Own goal' : null, !isOG && sc.assist ? `Assist: ${sc.assist}` : null].filter(Boolean).join('  ·  ');
    ctx.font = font(700, fitSize(line2, 700, 16, bw - 150, 11)); ctx.fillStyle = '#b9cbbf'; ctx.fillText(line2, bx + 112, by + 66);
    ctx.restore();
  }

  const CONF_COLORS = ['#ffffff', '#f5d76e'];
  function drawConfetti(ctx, sc, t, team) {
    const c = sc.confetti; if (!c || t < 0 || t > 3600) return;
    const tt = t / 1000;
    const fade = 1 - seg(t, 2600, 3600);
    ctx.globalAlpha = fade;
    for (let k = 0; k < c.length; k += 6) {
      const y = c[k + 1] + c[k + 2] * tt + 60 * tt * tt;
      if (y > H + 20) continue;
      const x = c[k] + c[k + 3] * tt + Math.sin(tt * 3 + c[k + 4]) * 18;
      const rot = c[k + 4] + tt * 5;
      ctx.fillStyle = c[k + 5] === 0 ? team.css : CONF_COLORS[c[k + 5] - 1];
      const cs = Math.cos(rot), sn = Math.sin(rot);
      ctx.setTransform(cs, sn, -sn * 0.6, cs * 0.6, x, y);
      ctx.fillRect(-5, -3, 10, 6);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
  }

  function drawBreak(ctx, sc, lt) {
    drawWorld(ctx, sc, lt);
    const a = smooth(seg(lt, 200, 700)) * (1 - seg(lt, sc.dur - 300, sc.dur));
    dim(ctx, 0.62 * a);
    drawBug(ctx, sc, lt);
    const sc2 = sc.scoreAfter;
    const isFT = sc.kind === 'ft';
    const s = sc.stats && isFT;
    const bw = 680, bh = s ? 420 : 210, bx = (W - bw) / 2, by = (H - bh) / 2 + (s ? 10 : -10);
    const pop = spr(SPR.soft, lt - 250);
    ctx.save(); ctx.globalAlpha = c01(pop) * a; ctx.translate(0, (1 - pop) * 40);
    ctx.fillStyle = 'rgba(8,13,10,0.95)'; roundRect(ctx, bx, by, bw, bh, 18); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.1)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#f5b301'; ctx.font = font(900, 18); ctx.fillText(isFT ? 'FULL-TIME' : 'HALF-TIME', W / 2, by + 34);
    // score line
    const A = T.A, B = T.B;
    ctx.font = font(900, 64); ctx.fillStyle = '#fff'; ctx.fillText(`${sc2[0]}  –  ${sc2[1]}`, W / 2, by + 100);
    ctx.font = font(800, fitSize(A.name, 800, 22, 200, 12)); ctx.textAlign = 'right'; ctx.fillText(A.name, W / 2 - 112, by + 100);
    ctx.font = font(800, fitSize(B.name, 800, 22, 200, 12)); ctx.textAlign = 'left'; ctx.fillText(B.name, W / 2 + 112, by + 100);
    ctx.fillStyle = A.css; ctx.fillRect(bx + 24, by + 84, 6, 32);
    ctx.fillStyle = B.css; ctx.fillRect(bx + bw - 30, by + 84, 6, 32);
    if (s) {
      const st2 = sc.stats;
      const rows = [
        ['Possession', st2.possession, '%'], ['Shots', st2.shots], ['On target', st2.on_target], ['xG', st2.xg, '', 1],
        ['Corners', st2.corners], ['Fouls', st2.fouls], ['Cards', [num(st2.yellow, 0) + num(st2.red, 0), num(st2.yellow, 1) + num(st2.red, 1)]],
      ];
      let y = by + 160;
      rows.forEach(([label, v, unit = '', dec = 0], k) => {
        if (!Array.isArray(v)) return;
        const a0 = num(v, 0), b0 = num(v, 1);
        const gp = smooth(seg(lt, 600 + k * 90, 1300 + k * 90));
        ctx.fillStyle = '#cfe1d6'; ctx.font = font(700, 14); ctx.textAlign = 'center'; ctx.fillText(label, W / 2, y);
        ctx.font = font(900, 17); ctx.fillStyle = '#fff';
        ctx.textAlign = 'left'; ctx.fillText(fmtNum(a0, dec) + unit, bx + 34, y);
        ctx.textAlign = 'right'; ctx.fillText(fmtNum(b0, dec) + unit, bx + bw - 34, y);
        const barW = bw - 68, half = barW / 2, yb = y + 15;
        ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fillRect(bx + 34, yb, barW, 6);
        const mx = Math.max(a0, b0) || 1;
        const wa = half * (a0 / mx) * gp, wb = half * (b0 / mx) * gp;
        ctx.fillStyle = A.css; ctx.fillRect(bx + 34 + half - wa, yb, wa, 6);
        ctx.fillStyle = B.css; ctx.fillRect(bx + 34 + half + 2, yb, wb, 6);
        y += 36;
      });
    } else if (sc.text) {
      const wr = wrap(sc.text, 600, 16, bw - 80, 2, 11);
      ctx.fillStyle = '#b9cbbf'; ctx.font = font(600, wr.size); ctx.textAlign = 'center';
      wr.lines.forEach((ln, k) => ctx.fillText(ln, W / 2, by + 150 + k * wr.size * 1.3));
    }
    ctx.restore();
  }
  const num = (arr, i) => { const v = Number(Array.isArray(arr) ? arr[i] : 0); return Number.isFinite(v) ? v : 0; };
  const fmtNum = (v, dec) => (dec ? v.toFixed(dec) : String(Math.round(v)));

  function outroBg(ctx, sc, lt) {
    ctx.drawImage(pitchLayer(), 0, 0, W, H);
    ctx.fillStyle = dimGrad(ctx); ctx.fillRect(0, 0, W, H);
  }

  function drawMotm(ctx, sc, lt) {
    outroBg(ctx, sc, lt);
    const m = sc.motm || {};
    const side = sc.motmSide || 'A', team = T[side];
    const p = spr(SPR.soft, lt - 100);
    const a = 1 - seg(lt, sc.dur - 320, sc.dur);
    ctx.save(); ctx.globalAlpha = a;
    ctx.fillStyle = rgba(team.color, 0.22 * c01(p)); ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#f5d76e'; ctx.font = font(900, 20); ctx.globalAlpha = a * c01(p);
    ctx.fillText('★  MAN OF THE MATCH  ★', W / 2, 92);
    const ps = spr(SPR.bouncy, lt - 250);
    ctx.save(); ctx.translate(W / 2, 236); ctx.scale(ps, ps);
    ctx.fillStyle = '#f5d76e'; ctx.beginPath(); ctx.arc(0, 0, 98, 0, Math.PI * 2); ctx.fill();
    if (sc.motmIdx >= 0) drawPhoto(ctx, side, sc.motmIdx, 0, 0, 184);
    else { ctx.fillStyle = team.css; ctx.beginPath(); ctx.arc(0, 0, 92, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
    const name = String(m.player || '').toLocaleUpperCase('tr');
    const np = smooth(seg(lt, 500, 900));
    ctx.globalAlpha = a * np; ctx.fillStyle = '#fff';
    ctx.font = font(900, fitSize(name, 900, 46, W - 200, 18, true), true); ctx.fillText(name, W / 2, 380 + (1 - np) * 14);
    const rating = playerRating(side, m.player);
    const chip = `${team.name}${rating != null ? `  ·  ${rating.toFixed(1)}` : ''}`;
    const cw = textW(font(800, 16), chip) + 36;
    ctx.fillStyle = team.css; roundRect(ctx, W / 2 - cw / 2, 414, cw, 34, 17); ctx.fill();
    ctx.fillStyle = team.ink; ctx.font = font(800, 16); ctx.fillText(chip, W / 2, 432);
    const rp = smooth(seg(lt, 800, 1250));
    ctx.globalAlpha = a * rp;
    const wr = wrap(m.reason || '', 600, 20, 820, 3, 12);
    ctx.fillStyle = '#d6e3db'; ctx.font = font(600, wr.size);
    wr.lines.forEach((ln, k) => ctx.fillText(ln, W / 2, 500 + k * wr.size * 1.35));
    ctx.restore();
  }

  function drawTeam(ctx, sc, lt) {
    outroBg(ctx, sc, lt);
    const s = sc.teamSide, team = T[s], an = sc.an || {};
    const a = 1 - seg(lt, sc.dur - 320, sc.dur);
    const p = spr(SPR.soft, lt - 60);
    ctx.save(); ctx.globalAlpha = a;
    // left kit band
    ctx.fillStyle = team.css; ctx.fillRect(0, 0, mix(0, 16, c01(p)), H);
    ctx.fillStyle = rgba(team.color, 0.14); ctx.fillRect(0, 0, W, H);
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    const head = team.name.toLocaleUpperCase('tr');
    ctx.globalAlpha = a * c01(p);
    ctx.fillStyle = '#fff'; ctx.font = font(900, fitSize(head, 900, 40, 760, 18, true), true); ctx.fillText(head, 70 - (1 - p) * 40, 74);
    if (sc.rating != null) {
      const r = sc.rating.toFixed(1);
      ctx.fillStyle = team.css; roundRect(ctx, W - 200, 46, 130, 56, 12); ctx.fill();
      ctx.fillStyle = team.ink; ctx.font = font(900, 30); ctx.textAlign = 'center'; ctx.fillText(r, W - 135, 72);
      ctx.font = font(700, 11); ctx.fillText('AVG RATING', W - 135, 94);
      ctx.textAlign = 'left';
    }
    // plays like
    const pl = spr(SPR.pop, lt - 350);
    ctx.globalAlpha = a * c01(pl);
    ctx.fillStyle = '#9fb7a8'; ctx.font = font(800, 15); ctx.fillText('PLAYS LIKE', 70, 136);
    const club = String(an.resembles?.club || '—');
    ctx.save(); ctx.translate(70, 184); ctx.scale(0.8 + 0.2 * pl, 0.8 + 0.2 * pl);
    ctx.fillStyle = '#fff'; ctx.font = font(900, fitSize(club, 900, 54, 780, 20, true), true); ctx.fillText(club, 0, 0);
    ctx.restore();
    const lg = String(an.resembles?.league || '');
    if (lg) {
      const lw = textW(font(800, 14), lg) + 26;
      ctx.fillStyle = 'rgba(255,255,255,0.12)'; roundRect(ctx, 70, 218, lw, 28, 14); ctx.fill();
      ctx.fillStyle = '#e8efe9'; ctx.font = font(800, 14); ctx.fillText(lg, 83, 232.5);
    }
    const why = wrap(an.resembles?.why || an.summary || '', 600, 17, W - 160, 2, 11);
    ctx.fillStyle = '#c9d8cf'; ctx.font = font(600, why.size);
    why.lines.forEach((ln, k) => ctx.fillText(ln, 70, 276 + k * why.size * 1.3));
    // strengths / weaknesses
    const colW = (W - 140 - 40) / 2;
    const cols = [['STRENGTHS', an.strengths, '#3ddc84', '✓'], ['WEAKNESSES', an.weaknesses, '#ff6b6b', '✕']];
    cols.forEach(([title, list, col, mark], ci) => {
      const x = 70 + ci * (colW + 40), y0 = 340;
      const hp = smooth(seg(lt, 700 + ci * 150, 1100 + ci * 150));
      ctx.globalAlpha = a * hp;
      ctx.fillStyle = col; ctx.font = font(900, 16); ctx.fillText(title, x, y0);
      ctx.fillStyle = col; ctx.fillRect(x, y0 + 14, 40, 3);
      (Array.isArray(list) ? list.slice(0, 3) : []).forEach((txt, k) => {
        const ip = spr(SPR.soft, lt - 950 - ci * 150 - k * 140);
        if (ip <= 0) return;
        const y = y0 + 44 + k * 82;
        ctx.globalAlpha = a * c01(ip);
        ctx.save(); ctx.translate((1 - ip) * 30, 0);
        ctx.fillStyle = 'rgba(255,255,255,0.06)'; roundRect(ctx, x, y - 4, colW, 72, 12); ctx.fill();
        ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x + 24, y + 32, 13, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#0b1410'; ctx.font = font(900, 15); ctx.textAlign = 'center'; ctx.fillText(mark, x + 24, y + 33);
        ctx.textAlign = 'left';
        const wr = wrap(txt, 600, 17, colW - 70, 2, 11);
        ctx.fillStyle = '#eef4f0'; ctx.font = font(600, wr.size);
        const lh = wr.size * 1.25, yy = y + 32 - ((wr.lines.length - 1) * lh) / 2;
        wr.lines.forEach((ln, j) => ctx.fillText(ln, x + 50, yy + j * lh));
        ctx.restore();
      });
    });
    ctx.restore();
  }

  function drawEnd(ctx, sc, lt) {
    outroBg(ctx, sc, lt);
    const A = T.A, B = T.B;
    const s = st.score;
    const fin = sc.scoreBefore;
    const p = spr(SPR.soft, lt - 80);
    ctx.save();
    ctx.globalAlpha = c01(p);
    // split colour bars
    ctx.fillStyle = A.css; ctx.fillRect(0, H / 2 - 120, mix(0, W / 2, smooth(seg(lt, 0, 500))), 8);
    ctx.fillStyle = B.css; ctx.fillRect(W - mix(0, W / 2, smooth(seg(lt, 0, 500))), H / 2 + 112, W / 2, 8);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#f5b301'; ctx.font = font(900, 20); ctx.fillText('FULL-TIME', W / 2, H / 2 - 82);
    const sp = spr(SPR.bouncy, lt - 300);
    ctx.save(); ctx.translate(W / 2, H / 2 + 6); ctx.scale(sp, sp);
    ctx.fillStyle = '#fff'; ctx.font = font(900, 120, true); ctx.fillText(`${fin[0]}–${fin[1]}`, 0, 0);
    ctx.restore();
    ctx.font = font(900, fitSize(A.name, 900, 30, 340, 14, true), true); ctx.textAlign = 'right'; ctx.fillStyle = '#fff';
    ctx.fillText(A.name, W / 2 - 190, H / 2 + 8);
    ctx.font = font(900, fitSize(B.name, 900, 30, 340, 14, true), true); ctx.textAlign = 'left';
    ctx.fillText(B.name, W / 2 + 190, H / 2 + 8);
    const lp = smooth(seg(lt, 900, 1400));
    ctx.globalAlpha = lp; ctx.textAlign = 'center';
    ctx.fillStyle = '#fff'; ctx.font = font(900, 26, true); ctx.fillText('SÜPER LIG MIX', W / 2, H - 120);
    ctx.fillStyle = '#9fb7a8'; ctx.font = font(600, 15); ctx.fillText('Draft · Simulate · Share  —  simulated by GPT-6 Luna', W / 2, H - 88);
    ctx.restore();
    void s;
    dim(ctx, seg(lt, sc.dur - 500, sc.dur) * 0.6);
  }

  // ------------------------------------------------------------------ public API
  function render(ctx, t) {
    const d = duration();
    t = Number(t) || 0;
    if (t < 0) t = 0;
    if (t >= d) t = Math.max(0, d - 1);
    const sc = scenes[sceneIndexAt(t)];
    const lt = t - sc.start;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.textBaseline = 'middle';
    switch (sc.kind) {
      case 'intro': drawIntro(ctx, sc, lt); break;
      case 'lineups': drawLineups(ctx, sc, lt); break;
      case 'kickoff': drawKickoff(ctx, sc, lt); break;
      case 'goal': drawGoal(ctx, sc, lt); break;
      case 'ht': case 'ft': drawBreak(ctx, sc, lt); break;
      case 'motm': drawMotm(ctx, sc, lt); break;
      case 'team': drawTeam(ctx, sc, lt); break;
      case 'end': drawEnd(ctx, sc, lt); break;
      default: drawPitchScene(ctx, sc, lt);
    }
    ctx.restore();
  }

  function infoAt(t) {
    const d = duration();
    t = Math.max(0, Math.min(Number(t) || 0, Math.max(0, d - 1)));
    const sc = scenes[sceneIndexAt(t)];
    const lt = t - sc.start;
    let text = '', capIndex = null;
    if (sc.caption) for (const c of sc.caption) if (lt >= c.t0 && lt < c.t1) { text = c.text; capIndex = c.index ?? null; break; }
    if (!text && sc.caption && sc.caption.length && lt >= sc.caption[sc.caption.length - 1].t1) text = sc.caption[sc.caption.length - 1].text;
    let minute = '';
    if (sc.kind === 'ht') minute = 'HT';
    else if (sc.kind === 'ft' || sc.kind === 'motm' || sc.kind === 'team' || sc.kind === 'end') minute = 'FT';
    else if (sc.label) minute = sc.label;
    const ei = capIndex ?? sc.eventIndex ?? -1;
    const sb = scoreAt(sc, lt);
    return { minute, score: [sb[0], sb[1]], sceneType: sc.kind === 'action' ? sc.type : sc.kind, text, eventIndex: ei, fullTimeReached: t >= ftStart() };
  }

  async function preload() {
    const jobs = [];
    for (const side of ['A', 'B']) {
      const team = T[side];
      for (const p of team.players) {
        if (!p.img || typeof Image === 'undefined') continue;
        jobs.push(new Promise(resolve => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.decoding = 'async';
          img.onload = () => { try { p.photo = photoSprite(team, img); } catch { /* keep initials */ } resolve(); };
          img.onerror = () => resolve();
          img.src = p.img;
        }));
      }
    }
    await Promise.all(jobs);
  }

  return {
    setItems,
    get duration() { return duration(); },
    get complete() { return complete; },
    render,
    infoAt,
    preload,
    score() { return [st.score[0], st.score[1]]; },
    timeline,
    // extras for integrators / debugging
    scenes() { return scenes.map(s => ({ kind: s.kind, start: s.start, dur: s.dur, eventIndex: s.eventIndex ?? -1, type: s.type || null })); },
    teams: T,
  };
}
