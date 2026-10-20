// MakeHuman (CC0) base mesh → athletic male footballer body, rigged to the CMU skeleton.
// Output: body.json (rest skeleton + layout) + body.bin (geometry, skin weights, kit regions).
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

import { MH as MH_DIR, OUT as OUT_DIR } from './paths.mjs';

const MH = process.argv[2] || MH_DIR;
const OUT = process.argv[3] || OUT_DIR;
fs.mkdirSync(OUT, { recursive: true });

// MakeHuman assets from MPFB2 (CC0 1.0): base mesh, macro targets, CMU-compatible rig + weights.
const MPFB = 'https://raw.githubusercontent.com/makehumancommunity/mpfb2/master/src/mpfb/data/';
const FILES = [
  '3dobjs/base.obj', 'rigs/standard/rig.cmu_mb.json', 'rigs/standard/weights.cmu_mb.json', 'mesh_metadata/basemesh_vertex_groups.json',
  'targets/macrodetails/universal-male-young-maxmuscle-averageweight.target.gz', 'targets/macrodetails/caucasian-male-young.target.gz',
  'targets/macrodetails/african-male-young.target.gz', 'targets/macrodetails/asian-male-young.target.gz',
  'targets/macrodetails/proportions/male-young-averagemuscle-averageweight-idealproportions.target.gz',
  'targets/macrodetails/proportions/male-young-maxmuscle-averageweight-idealproportions.target.gz',
];
for (const f of FILES) {
  const dst = path.join(MH, f);
  if (fs.existsSync(dst)) continue;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const r = await fetch(MPFB + f);
  if (!r.ok) throw new Error(`download failed: ${f} (${r.status})`);
  fs.writeFileSync(dst, Buffer.from(await r.arrayBuffer()));
  console.log('downloaded', f);
}

// ---------------------------------------------------------------- base mesh
const obj = fs.readFileSync(path.join(MH, '3dobjs/base.obj'), 'utf8').split('\n');
const V = [], VT = [];
const faces = []; // { g, v:[...], t:[...] }  (vertex and texture-coordinate indices)
let group = '';
for (const ln of obj) {
  if (ln.startsWith('v ')) { const p = ln.split(/\s+/); V.push([+p[1], +p[2], +p[3]]); }
  else if (ln.startsWith('vt ')) { const p = ln.split(/\s+/); VT.push([+p[1], +p[2]]); }
  else if (ln.startsWith('g ')) group = ln.slice(2).trim();
  else if (ln.startsWith('f ')) {
    const c = ln.trim().split(/\s+/).slice(1).map(s => s.split('/'));
    faces.push({ g: group, v: c.map(x => parseInt(x[0], 10) - 1), t: c.map(x => (x[1] ? parseInt(x[1], 10) - 1 : -1)) });
  }
}
console.log('verts', V.length, 'faces', faces.length);

// ---------------------------------------------------------------- macro targets
function loadTarget(rel) {
  const raw = zlib.gunzipSync(fs.readFileSync(path.join(MH, 'targets', rel))).toString('utf8');
  const out = [];
  for (const ln of raw.split('\n')) {
    if (!ln || ln.startsWith('#')) continue;
    const p = ln.trim().split(/\s+/);
    if (p.length < 4) continue;
    out.push([+p[0], +p[1], +p[2], +p[3]]);
  }
  return out;
}
const MUSCLE = 0.72;   // athletic
const hi = (MUSCLE - 0.5) / 0.5, lo = 1 - hi;
const targets = [
  ['macrodetails/universal-male-young-maxmuscle-averageweight.target.gz', hi],
  ['macrodetails/caucasian-male-young.target.gz', 1 / 3],
  ['macrodetails/african-male-young.target.gz', 1 / 3],
  ['macrodetails/asian-male-young.target.gz', 1 / 3],
  ['macrodetails/proportions/male-young-averagemuscle-averageweight-idealproportions.target.gz', lo],
  ['macrodetails/proportions/male-young-maxmuscle-averageweight-idealproportions.target.gz', hi],
];
for (const [rel, w] of targets) {
  if (!w) continue;
  for (const [i, dx, dy, dz] of loadTarget(rel)) { V[i][0] += dx * w; V[i][1] += dy * w; V[i][2] += dz * w; }
}
// decimetres → metres
for (const p of V) { p[0] *= 0.1; p[1] *= 0.1; p[2] *= 0.1; }

// ---------------------------------------------------------------- joints
const groups = JSON.parse(fs.readFileSync(path.join(MH, 'mesh_metadata/basemesh_vertex_groups.json'), 'utf8'));
const groupVerts = name => { const out = []; for (const [a, b] of groups[name]) for (let i = a; i <= b; i++) out.push(i); return out; };
const mean = idx => { const m = [0, 0, 0]; for (const i of idx) { m[0] += V[i][0]; m[1] += V[i][1]; m[2] += V[i][2]; } return m.map(x => x / idx.length); };
const cube = name => mean(groupVerts(name));
const rig = JSON.parse(fs.readFileSync(path.join(MH, 'rigs/standard/rig.cmu_mb.json'), 'utf8'));
const jointPos = spec => (spec.strategy === 'CUBE' ? cube(spec.cube_name) : mean(spec.vertex_indices));

// Body faces only (plus eyeballs); drop helpers.
const keepGroups = new Set(['body', 'helper-l-eye', 'helper-r-eye']);
const used = faces.filter(f => keepGroups.has(f.g));
// Ground + centre
let minY = Infinity;
for (const f of used) for (const i of f.v) minY = Math.min(minY, V[i][1]);
const pelvis0 = cube('joint-pelvis');
const ox = pelvis0[0], oz = pelvis0[2];
const P = p => [p[0] - ox, p[1] - minY, p[2] - oz];

// Bone order: parents first.
const names = Object.keys(rig);
const order = [];
const visit = n => { if (order.includes(n)) return; const p = rig[n].parent; if (p) visit(p); order.push(n); };
names.forEach(visit);
const bones = order.map(n => ({ name: n, parent: rig[n].parent ? order.indexOf(rig[n].parent) : -1, head: P(jointPos(rig[n].head)), tail: P(jointPos(rig[n].tail)) }));
const bi = Object.fromEntries(bones.map((b, i) => [b.name, i]));

// ---------------------------------------------------------------- head texture atlas
// The player's face is baked per player into a small texture laid out with MakeHuman's own UV
// unwrap of the head (one island for the head and face, one per ear), repacked into [0,1]².
// Vertices on UV seams of those islands are split; everything else keeps one vertex per position.
const Wsrc = JSON.parse(fs.readFileSync(path.join(MH, 'rigs/standard/weights.cmu_mb.json'), 'utf8')).weights;
const domSrc = new Array(V.length).fill(null);
{
  const best = new Float32Array(V.length);
  for (const [b, l] of Object.entries(Wsrc)) for (const [i, w] of l) if (w > best[i]) { best[i] = w; domSrc[i] = b; }
}
const headish = f => f.v.every(i => domSrc[i] === 'Head' || domSrc[i] === 'Neck1');
const bodyFaces = used.filter(f => f.g === 'body');
const uf = new Int32Array(VT.length).map((_, i) => i);
const find = x => { while (uf[x] !== x) { uf[x] = uf[uf[x]]; x = uf[x]; } return x; };
for (const f of bodyFaces) for (let k = 1; k < f.t.length; k++) { const a = find(f.t[0]), b = find(f.t[k]); if (a !== b) uf[a] = b; }
const islands = new Map();
for (const f of bodyFaces) {
  const r = find(f.t[0]);
  const e = islands.get(r) || { n: 0, head: 0, cx: 0, u0: 9, v0: 9, u1: -9, v1: -9 };
  e.n++; if (headish(f)) e.head++;
  for (let k = 0; k < f.v.length; k++) { const t = VT[f.t[k]]; e.cx += V[f.v[k]][0] / f.v.length; e.u0 = Math.min(e.u0, t[0]); e.v0 = Math.min(e.v0, t[1]); e.u1 = Math.max(e.u1, t[0]); e.v1 = Math.max(e.v1, t[1]); }
  islands.set(r, e);
}
const headIslands = [...islands.entries()].filter(([, e]) => e.head > 0.9 * e.n && e.n > 100).sort((a, b) => b[1].n - a[1].n);
const [headRoot, headIsl] = headIslands[0];
const ears = headIslands.slice(1).filter(([, e]) => Math.abs(e.cx / e.n) > 0.015).sort((a, b) => a[1].cx - b[1].cx); // right ear (−x) first
if (ears.length !== 2) throw new Error('ear islands not found');
const mouthRoot = headIslands.slice(1).find(([, e]) => Math.abs(e.cx / e.n) < 0.015)?.[0];
// Packing: head island fills the left of the square (uniform scale), ears stacked on the right.
const atlas = new Map();
{
  const M = 0.012;
  const s = (1 - 2 * M) / (headIsl.v1 - headIsl.v0);
  atlas.set(headRoot, { s, ou: M - headIsl.u0 * s, ov: M - headIsl.v0 * s });
  const x0 = M * 2 + (headIsl.u1 - headIsl.u0) * s;
  ears.forEach(([r, e], k) => {
    const se = Math.min((1 - x0 - M) / (e.u1 - e.u0), (0.5 - 2 * M) / (e.v1 - e.v0));
    atlas.set(r, { s: se, ou: x0 - e.u0 * se, ov: M + k * 0.5 - e.v0 * se });
  });
}
const atlasUV = f => {
  if (f.g !== 'body') return null;
  const r = find(f.t[0]);
  if (r === mouthRoot) return 'mouth';
  return atlas.get(r) || null;
};

// ---------------------------------------------------------------- reindex used vertices
const map = new Map();
const verts = [], vuv = [];
const fv = used.map(f => {
  const a = atlasUV(f);
  return f.v.map((i, k) => {
    const key = a && a !== 'mouth' ? `${i}/${f.t[k]}` : a === 'mouth' ? `${i}/m` : `${i}`;
    let o = map.get(key);
    if (o == null) {
      o = verts.length; map.set(key, o); verts.push(i);
      if (a && a !== 'mouth') { const t = VT[f.t[k]]; vuv.push([t[0] * a.s + a.ou, t[1] * a.s + a.ov]); }
      else vuv.push(a === 'mouth' ? [-2, -2] : [-1, -1]);
    }
    return o;
  });
});
const nV = verts.length;
const pos = new Float32Array(nV * 3);
verts.forEach((src, i) => { const p = P(V[src]); pos.set(p, i * 3); });
const headUV = new Float32Array(nV * 2);
vuv.forEach((t, i) => { headUV[i * 2] = t[0]; headUV[i * 2 + 1] = t[1]; });
const tris = [];
for (const v of fv) for (let k = 1; k + 1 < v.length; k++) tris.push(v[0], v[k], v[k + 1]);
const index = new Uint16Array(tris);
// Smooth normals, accumulated per source vertex so split seam vertices share one normal.
const nsrc = new Float64Array(V.length * 3);
for (let t = 0; t < index.length; t += 3) {
  const a = index[t] * 3, b = index[t + 1] * 3, c = index[t + 2] * 3;
  const e1 = [pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]];
  const e2 = [pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]];
  const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  for (const o of [index[t], index[t + 1], index[t + 2]]) { const s3 = verts[o] * 3; nsrc[s3] += n[0]; nsrc[s3 + 1] += n[1]; nsrc[s3 + 2] += n[2]; }
}
const nrm = new Float32Array(nV * 3);
for (let i = 0; i < nV; i++) {
  const s3 = verts[i] * 3, l = Math.hypot(nsrc[s3], nsrc[s3 + 1], nsrc[s3 + 2]) || 1;
  nrm[i * 3] = nsrc[s3] / l; nrm[i * 3 + 1] = nsrc[s3 + 1] / l; nrm[i * 3 + 2] = nsrc[s3 + 2] / l;
}

// ---------------------------------------------------------------- skin weights (top 4)
const perSrc = new Map();
for (const [bone, list] of Object.entries(Wsrc)) {
  const b = bi[bone]; if (b == null) continue;
  for (const [src, w] of list) if (w > 0) { let l = perSrc.get(src); if (!l) perSrc.set(src, (l = [])); l.push([b, w]); }
}
const per = verts.map(src => (perSrc.get(src) || []).slice());
// Eyes follow the head.
const skinIndex = new Uint8Array(nV * 4), skinWeight = new Uint8Array(nV * 4);
const dominant = new Int16Array(nV);
for (let i = 0; i < nV; i++) {
  let l = per[i].sort((a, b) => b[1] - a[1]).slice(0, 4);
  if (!l.length) l = [[bi.Head, 1]];
  const s = l.reduce((a, x) => a + x[1], 0);
  const qs = l.map(([, w]) => Math.floor((w / s) * 255));
  qs[0] += 255 - qs.reduce((a, x) => a + x, 0);
  l.forEach(([b], k) => { skinIndex[i * 4 + k] = b; skinWeight[i * 4 + k] = qs[k]; });
  dominant[i] = l[0][0];
}

// ---------------------------------------------------------------- kit regions
// region: 0 head, 1 core (torso + pelvis + neck), 2 arm, 3 leg, 4 foot, 5 eyeball
// coord: core/head → rest height (m); arm → shoulder 0 · elbow 0.5 · wrist 1 · (hand > 1); leg → hip 0 · knee 0.5 · ankle 1
const J = n => bones[bi[n]];
const segT = (p, a, b) => { const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]; const l2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2]; return ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1] + (p[2] - a[2]) * d[2]) / l2; };
const region = new Uint8Array(nV), armT = new Float32Array(nV), legT = new Float32Array(nV);
const headSet = new Set(['Head', 'Neck1']);
const coreSet = new Set(['Hips', 'LowerBack', 'Spine', 'Spine1', 'Neck', 'LeftShoulder', 'RightShoulder', 'LHipJoint', 'RHipJoint']);
const chainT = (p, a, b, c) => { const t1 = segT(p, a, b); return t1 < 1 ? Math.max(0, t1) * 0.5 : 0.5 + segT(p, b, c) * 0.5; };
for (let i = 0; i < nV; i++) {
  const p = [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
  const name = bones[dominant[i]].name;
  const L = p[0] > 0 ? 'Left' : 'Right';
  // Continuous along-limb coordinates for every vertex, so region borders stay seamless.
  armT[i] = chainT(p, J(`${L}Arm`).head, J(`${L}ForeArm`).head, J(`${L}Hand`).head);
  legT[i] = chainT(p, J(`${L}UpLeg`).head, J(`${L}Leg`).head, J(`${L}Foot`).head);
  if (verts[i] >= 14598) region[i] = 5;
  else if (headSet.has(name)) region[i] = 0;
  else if (/Arm|Hand|Thumb|Finger/.test(name)) region[i] = 2;
  else if (/UpLeg|Leg$/.test(name)) region[i] = 3;
  else if (/Foot|Toe/.test(name)) region[i] = 4;
  else { region[i] = 1; if (!coreSet.has(name)) console.warn('unclassified', name); }
}

// Head frame for the photo projection.
let hy0 = Infinity, hy1 = -Infinity, hx0 = Infinity, hx1 = -Infinity, hz1 = -Infinity;
for (let i = 0; i < nV; i++) if (region[i] === 0 || region[i] === 5) {
  hy1 = Math.max(hy1, pos[i * 3 + 1]); hz1 = Math.max(hz1, pos[i * 3 + 2]);
  if (dominant[i] === bi.Head) { hx0 = Math.min(hx0, pos[i * 3]); hx1 = Math.max(hx1, pos[i * 3]); }
}
// Chin: lowest Head-weighted vertex near the front centre.
let chin = Infinity;
for (let i = 0; i < nV; i++) if (dominant[i] === bi.Head && Math.abs(pos[i * 3]) < 0.02 && pos[i * 3 + 2] > hz1 - 0.06) chin = Math.min(chin, pos[i * 3 + 1]);

// Eyeballs: centre and radius (the shader draws sclera, iris and pupil around the +z axis).
const eyes = ['helper-l-eye', 'helper-r-eye'].map(gname => {
  const idx = groupVerts(gname).map(i => P(V[i]));
  const c = [0, 1, 2].map(k => idx.reduce((a, p) => a + p[k], 0) / idx.length);
  const r = idx.reduce((a, p) => a + Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]), 0) / idx.length;
  return { c: c.map(v => +v.toFixed(5)), r: +r.toFixed(5) };
});

// ---------------------------------------------------------------- write
const parts = [
  ['position', pos], ['normal', nrm], ['skinIndex', skinIndex], ['skinWeight', skinWeight], ['region', region], ['armT', armT], ['legT', legT], ['headUV', headUV], ['index', index],
];
let off = 0; const layout = {};
const bufs = [];
for (const [k, arr] of parts) {
  const pad = (4 - (off % 4)) % 4; if (pad) { bufs.push(Buffer.alloc(pad)); off += pad; }
  layout[k] = { offset: off, length: arr.length, type: arr.constructor.name };
  bufs.push(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)); off += arr.byteLength;
}
fs.writeFileSync(path.join(OUT, 'body.bin'), Buffer.concat(bufs));
const meta = {
  source: 'MakeHuman HM08 base mesh + CMU (cmu_mb) rig and weights, from MPFB2 — CC0 1.0',
  muscle: MUSCLE, vertexCount: nV, indexCount: index.length, layout,
  bones: bones.map(b => ({ name: b.name, parent: b.parent, head: b.head.map(v => +v.toFixed(5)), tail: b.tail.map(v => +v.toFixed(5)) })),
  head: { top: +hy1.toFixed(4), chin: +chin.toFixed(4), x0: +hx0.toFixed(4), x1: +hx1.toFixed(4), front: +hz1.toFixed(4) },
  eyes,
  height: +(hy1).toFixed(4),
};
fs.writeFileSync(path.join(OUT, 'body.json'), JSON.stringify(meta));
console.log('body', nV, 'verts', index.length / 3, 'tris', 'height', hy1.toFixed(3), 'head', meta.head, 'bytes', off);
for (const b of meta.bones) console.log(b.name.padEnd(18), b.head.map(v => v.toFixed(3)).join(' '));
