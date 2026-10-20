// Real engine moments (mock match) → 3D filmstrips around one player, for tuning movement.
// ?m=<moment index>&half=1&seed=1&agent=<id|gk|owner>&a=<t0>&b=<t1>&n=8&cam=side|front|back|high|broadcast&d=6
import { getStage } from './stage.js';
import * as C from '../../sim/core.js';
import { MOCK_TEAMS, MOCK_ITEMS } from '../mock.js';
const qs = new URLSearchParams(location.search);
const stage = await getStage();
const norm = d => { const e = { ...d }; if (e.type === 'goal') return { ...e, type: 'shot', outcome: 'goal' }; if (e.type === 'yellow' || e.type === 'red') return { ...e, type: 'foul', card: e.type, offender: e.player, player: e.fouled || null, side: e.side === 'A' ? 'B' : 'A' }; return e; };
const ms = [];
for (const it of MOCK_ITEMS) { if (it.kind !== 'ev') continue; const ev = norm(it.data); const kind = ev.type === 'shot' ? 'shot' : ev.type === 'foul' ? 'foul' : ev.type === 'offside' ? 'offside' : ev.type === 'corner' ? 'corner' : ev.type === 'injury' ? 'injury' : null; if (kind) ms.push({ ev, kind }); }
ms.push({ ev: { side: 'A' }, kind: 'kickoff' }, { ev: { side: 'A' }, kind: 'flow' }, { ev: { side: 'B' }, kind: 'flow' });
const meta = MOCK_ITEMS.find(i => i.kind === 'meta').data;
const M0 = C.makeMatch(MOCK_TEAMS, meta.styles);
const m = ms[Number(qs.get('m') || 1)];
const half = Number(qs.get('half') || 1);
const clip = C.buildMoment(C.withHalf(M0, half), m.ev, { kind: m.kind, seed: Number(qs.get('seed') || 1), sent: new Set(), debug: true });
window.__clip = { dur: clip.dur, climax: clip.info.climax, log: clip.log.filter(e => e.type !== 'dbg' && e.type !== 'tdbg').map(e => `${e.t.toFixed(2)}:${e.type}#${e.agent ?? ''}`) };
const A = 25;
const kitA = { shirt: MOCK_TEAMS.A.color, shorts: '#f1f5f9', socks: MOCK_TEAMS.A.color, numColor: '#fff', trim: '#fff' };
const kitB = { shirt: MOCK_TEAMS.B.color, shorts: '#f1f5f9', socks: MOCK_TEAMS.B.color, numColor: '#fff', trim: '#fff' };
const looks = Array.from({ length: A }, (_, a) => {
  if (a >= 22) return { shirt: '#111', shorts: '#111', socks: '#111', numColor: '#fff', skin: '#c8956b', hair: '#222', num: null, foot: 'right', height: 1.8 };
  const side = a < 11 ? 'A' : 'B', p = MOCK_TEAMS[side].players[a % 11], gk = a % 11 === 0;
  return { ...(gk ? { shirt: side === 'A' ? '#22c55e' : '#facc15', shorts: '#111827', socks: '#22c55e', numColor: '#111' } : side === 'A' ? kitA : kitB), skin: '#c8956b', hair: '#2b1d14', num: p.num || a % 11 + 1, name: p.name, foot: p.foot || 'right', height: (p.height || 180) / 100, gloves: gk ? '#fff' : null, longSleeve: gk };
});
stage.setCast('enginelab', looks, new Map(), null);
const pick = qs.get('agent') || 'owner';
const agentAt = k => {
  if (pick === 'gk') { const bx = clip.ball[k * 3]; return bx > 52.5 ? (M0 && (C.withHalf(M0, half).dir.A > 0 ? 11 : 0)) : (C.withHalf(M0, half).dir.A > 0 ? 0 : 11); }
  if (pick === 'owner') { let best = 0, bd = 1e9; for (let a = 0; a < 22; a++) { const d = Math.hypot(clip.pos[(k * A + a) * 2] - clip.ball[k * 3], clip.pos[(k * A + a) * 2 + 1] - clip.ball[k * 3 + 1]); if (d < bd) { bd = d; best = a; } } return best; }
  return Number(pick);
};
const cv = document.getElementById('cv'), ctx = cv.getContext('2d');
const n = Number(qs.get('n') || 8), cols = Number(qs.get('cols') || 4), rows = Math.ceil(n / cols), tw = 1600 / cols, th = 900 / rows;
const tile = document.createElement('canvas'); tile.width = tw; tile.height = th; const tctx = tile.getContext('2d');
const ta = Number(qs.get('a') ?? clip.info.climax - 2), tb = Number(qs.get('b') ?? clip.info.climax + 1);
const view = qs.get('cam') || 'side', d = Number(qs.get('d') || 6);
const fixed = qs.has('fix') ? agentAt(Math.round(ta * C.HZ)) : null;
for (let i = 0; i < n; i++) {
  const t = ta + (tb - ta) * (n > 1 ? i / (n - 1) : 0);
  const k = Math.min(clip.N - 1, Math.round(t * C.HZ)), ag = fixed ?? agentAt(k);
  const px = clip.pos[(k * A + ag) * 2], py = clip.pos[(k * A + ag) * 2 + 1];
  const hd = clip.hd[k * A + ag];
  // perpendicular to his run, from his right, a steady distance: feet and ball in frame
  const hs = (() => { let sx = 0, sy = 0; for (let j = -6; j <= 6; j++) { const kk = Math.max(0, Math.min(clip.N - 1, k + j)); sx += Math.cos(clip.hd[kk * A + ag]); sy += Math.sin(clip.hd[kk * A + ag]); } return Math.atan2(sy, sx); })();
  const bx = clip.ball[k * 3], by = clip.ball[k * 3 + 1];
  const cam = view === 'tv' ? { pos: [bx, 68 + 30, 22], look: [bx, 30, 0], fov: 34 }
    : view === 'perp' ? { pos: [px + Math.cos(hs - Math.PI / 2) * d, py + Math.sin(hs - Math.PI / 2) * d, 1.5], look: [px + Math.cos(hs) * 0.6, py + Math.sin(hs) * 0.6, 0.6], fov: 34 }
    : view === 'side' ? { pos: [px, py + d, 1.4], look: [px, py, 0.8], fov: 38 }
    : view === 'front' ? { pos: [px + d, py, 1.4], look: [px, py, 0.8], fov: 38 }
    : view === 'back' ? { pos: [px - d, py, 1.5], look: [px, py, 0.8], fov: 38 }
    : view === 'high' ? { pos: [px, py + d * 0.8, d * 0.9], look: [px, py, 0.5], fov: 50 }
    : { pos: [px + d * 0.7, py + d * 0.7, 2.0], look: [px, py, 0.8], fov: 38 };
  stage.draw(tctx, cam, clip, t, { looks });
  ctx.drawImage(tile, (i % cols) * tw, Math.floor(i / cols) * th);
  ctx.fillStyle = '#fff'; ctx.font = '18px sans-serif'; ctx.fillText(`t=${t.toFixed(2)} #${ag} st${clip.st[k * A + ag]} z${(clip.z[k * A + ag]).toFixed(2)}`, (i % cols) * tw + 8, Math.floor(i / cols) * th + 22);
}
window.__done = true;
