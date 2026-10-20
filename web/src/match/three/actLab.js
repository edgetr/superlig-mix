// Synthetic engine tracks → controller → filmstrip, for tuning individual actions.
import { getStage } from './stage.js';
import { S, HZ } from '../../sim/core.js';
const qs = new URLSearchParams(location.search);
const stage = await getStage();
const A = 25, dur = Number(qs.get('dur') || 4), N = Math.ceil(dur * HZ) + 1;
const st = S[(qs.get('st') || 'KICK').toUpperCase()];
const t0 = Number(qs.get('t0') || 1), t1 = Number(qs.get('t1') || 2.2);
const v0 = Number(qs.get('v') || 4), vAfter = Number(qs.get('v2') ?? v0);
const clip = { N, dur: (N - 1) / HZ, pos: new Float32Array(N * A * 2), hd: new Float32Array(N * A), ph: new Float32Array(N * A), st: new Uint8Array(N * A), stT: new Float32Array(N * A), ball: new Float32Array(N * 3), cam: new Float32Array(N * 2), marks: { passes: [], captions: [] } };
let x = 40, ph = 0;
const GAIT = [[0, 0.9], [1.3, 1.46], [2.93, 2.31], [3.65, 2.67], [4.44, 3.02], [4.83, 3.1], [6.5, 3.75], [9.5, 4.6]];
const cyc = v => { for (let i = 1; i < GAIT.length; i++) if (v <= GAIT[i][0]) { const [a, la] = GAIT[i - 1], [b, lb] = GAIT[i]; return la + ((v - a) / (b - a)) * (lb - la); } return 4.6; };
for (let k = 0; k < N; k++) {
  const t = k / HZ;
  const v = t < t0 ? v0 : vAfter * Math.max(0, 1 - (t - t0) * Number(qs.get('decel') || 0));
  x += v / HZ; ph += (v / HZ) / cyc(v);
  for (let a = 0; a < A; a++) { clip.pos[(k * A + a) * 2] = a === 0 ? x : -30; clip.pos[(k * A + a) * 2 + 1] = 34; clip.hd[k * A + a] = 0; clip.ph[k * A + a] = ph; }
  if (t >= t0 && t <= t1) { clip.st[k * A] = st; clip.stT[k * A] = t - t0; }
  // ball: at the feet before a kick, then flies
  const kickT = t0 + 0.28;
  const bx = st === S.KICK ? (t < kickT ? x + 0.6 : x + 0.6 + (t - kickT) * 20) : x + 8;
  clip.ball[k * 3] = bx; clip.ball[k * 3 + 1] = 34; clip.ball[k * 3 + 2] = st === S.KICK && t > kickT ? Math.min(2, (t - kickT) * 3) : 0;
}
if (st === S.KICK && qs.get('shot')) clip.marks.shot = { t: t0 + 0.28, agent: 0, to: { x: 100, y: 34, z: 1 } };
if (st === S.DIVE_L || st === S.DIVE_R) clip.marks.shot = { t: t0, agent: 1, to: { x: 0, y: 30, z: Number(qs.get('z') || 0.8) } };
const looks = Array.from({ length: A }, () => ({ shirt: '#c81e2c', shorts: '#ffffff', socks: '#c81e2c', numColor: '#fff', trim: '#fff', skin: '#c8956b', hair: '#2b1d14', num: 9, name: 'Test Player', foot: qs.get('foot') || 'right', height: 1.83, gloves: st >= 2 && st <= 3 ? '#fff' : null, longSleeve: st === S.DIVE_L || st === S.DIVE_R }));
stage.setCast('actlab', looks, new Map(), null);
const cv = document.getElementById('cv'), ctx = cv.getContext('2d');
const n = Number(qs.get('n') || 8), cols = 4, rows = Math.ceil(n / cols), tw = 1600 / cols, th = 900 / rows;
const tile = document.createElement('canvas'); tile.width = tw; tile.height = th; const tctx = tile.getContext('2d');
const ta = Number(qs.get('a') ?? t0 - 0.3), tb = Number(qs.get('b') ?? t1 + 0.4);
const view = qs.get('cam') || 'side';
for (let i = 0; i < n; i++) {
  const t = ta + (tb - ta) * (n > 1 ? i / (n - 1) : 0);
  const k = Math.round(t * HZ), px = clip.pos[k * A * 2];
  const d = 5.2;
  const cam = view === 'side' ? { pos: [px, 34 + d, 1.3], look: [px, 34, 0.8], fov: 36 }
    : view === 'front' ? { pos: [px + d, 34, 1.3], look: [px, 34, 0.8], fov: 36 }
    : view === 'back' ? { pos: [px - d, 34, 1.4], look: [px, 34, 0.8], fov: 36 }
    : { pos: [px + d * 0.7, 34 + d * 0.7, 1.8], look: [px, 34, 0.8], fov: 36 };
  stage.draw(tctx, cam, clip, t, { looks });
  ctx.drawImage(tile, (i % cols) * tw, Math.floor(i / cols) * th);
  ctx.fillStyle = '#fff'; ctx.font = '20px sans-serif'; ctx.fillText(`${qs.get('st')} t=${t.toFixed(2)} (u=${(t - t0).toFixed(2)})`, (i % cols) * tw + 8, Math.floor(i / cols) * th + 24);
}
window.__done = true;
