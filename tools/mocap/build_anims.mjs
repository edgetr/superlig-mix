// Build the animation library: CMU takes → retargeted, canonical clips for the MakeHuman body.
import fs from 'node:fs';
import { Quaternion } from 'three';
import { loadBody, take, cyclesOf, actionClip } from './clips.mjs';
import { SPEC } from './spec.mjs';
import { OUT as OUT_DIR } from './paths.mjs';

const OUT = process.argv[2] || OUT_DIR;
const only = process.argv[3] ? new Set(process.argv[3].split(',')) : null;
const body = loadBody();
const B = body.bones.length;
const takes = new Map();
const getTake = async id => { if (!takes.has(id)) takes.set(id, await take(id, body)); return takes.get(id); };

const clips = {};
for (const s of SPEC) {
  if (only && !only.has(s.name)) continue;
  const T = await getTake(s.id);
  let c;
  if (s.kind === 'cycle') {
    const all = cyclesOf(T, s.n || 32).filter(x => s.at == null || (x.a / T.fps <= s.at && x.b / T.fps >= s.at));
    if (!all.length) throw new Error(`no cycle for ${s.name} (${s.id})`);
    // most typical: speed closest to the median
    const med = all.map(x => x.clip.speed).sort((a, b) => a - b)[Math.floor(all.length / 2)];
    c = all.sort((x, y) => Math.abs(x.clip.speed - med) - Math.abs(y.clip.speed - med))[0].clip;
  } else {
    c = actionClip(T, s.t0, s.t1, s.ref ?? s.t0, { fps: s.fps || 60, sigma: s.sigma ?? 0.35, keepTravel: !!s.keepTravel, yawAt: s.yawAt ?? null, yawAxis: !!s.yawAxis, refMode: s.refMode || null });
    if (s.loop) loopify(c, s.loop);
  }
  c.name = s.name; c.src = s.id; c.events = s.events || {};
  if (s.mirror) mirror(c);
  clips[s.name] = c;
  console.log(s.name.padEnd(16), s.id.padEnd(7), c.kind, `n=${c.n}`, c.kind === 'cycle' ? `speed ${c.speed.toFixed(2)} dur ${c.dur.toFixed(2)} dir ${(c.dir * 57.3).toFixed(0)}` : `dur ${c.dur.toFixed(2)} ref ${c.ref.toFixed(2)}`);
}

// Cross-fade the tail of an action into its head so it loops.
function loopify(c, fade) {
  const n = c.samples.length, k = Math.max(2, Math.round(fade * c.fps));
  for (let i = 0; i < k; i++) {
    const w = (i + 1) / (k + 1);
    const a = c.samples[n - k + i], b = c.samples[i];
    a.q = a.q.map((q, j) => q.clone().slerp(b.q[j], w));
    a.root.lerp(b.root, w);
  }
  c.loop = true;
}

// Left/right mirror (swap sides, reflect across the sagittal plane).
function mirror(c) {
  const name = body.bones.map(b => b.name);
  const swap = n => n.replace(/^Left/, '§').replace(/^Right/, 'Left').replace(/^§/, 'Right').replace(/^LHip/, '§').replace(/^RHip/, 'LHip').replace(/^§/, 'RHip').replace(/^LThumb/, '§').replace(/^RThumb/, 'LThumb').replace(/^§/, 'RThumb');
  const map = name.map(n => name.indexOf(swap(n)));
  for (const s of c.samples) {
    const q = s.q.map(x => new Quaternion(x.x, -x.y, -x.z, x.w)); // reflect x → −x
    s.q = map.map(j => q[j]);
    s.root.x = -s.root.x;
  }
  if (c.dir != null) c.dir = -c.dir;
}

// ---------------------------------------------------------------- write
const names = Object.keys(clips);
let total = 0;
for (const n of names) total += clips[n].samples.length;
const Q = new Int16Array(total * B * 4), R = new Int16Array(total * 3);
let f = 0;
const index = {};
for (const n of names) {
  const c = clips[n];
  index[n] = { kind: c.kind, frame: f, n: c.samples.length, fps: c.fps || null, dur: +c.dur.toFixed(4), speed: c.speed != null ? +c.speed.toFixed(3) : null, dir: c.dir != null ? +c.dir.toFixed(3) : null, ref: c.ref != null ? +c.ref.toFixed(4) : null, loop: !!c.loop, events: c.events, src: c.src };
  for (const s of c.samples) {
    for (let b = 0; b < B; b++) {
      let q = s.q[b];
      if (q.w < 0) q = new Quaternion(-q.x, -q.y, -q.z, -q.w);
      const o = (f * B + b) * 4;
      Q[o] = Math.round(q.x * 32767); Q[o + 1] = Math.round(q.y * 32767); Q[o + 2] = Math.round(q.z * 32767); Q[o + 3] = Math.round(q.w * 32767);
    }
    R[f * 3] = Math.round(s.root.x * 1000); R[f * 3 + 1] = Math.round(s.root.y * 1000); R[f * 3 + 2] = Math.round(s.root.z * 1000);
    f++;
  }
}
fs.writeFileSync(`${OUT}/anims.bin`, Buffer.concat([Buffer.from(Q.buffer), Buffer.from(R.buffer)]));
fs.writeFileSync(`${OUT}/anims.json`, JSON.stringify({ source: 'CMU Graphics Lab Motion Capture Database (mocap.cs.cmu.edu), retargeted', bones: body.bones.map(b => b.name), frames: total, quatBytes: Q.byteLength, clips: index }));
console.log('frames', total, 'bytes', Q.byteLength + R.byteLength);
