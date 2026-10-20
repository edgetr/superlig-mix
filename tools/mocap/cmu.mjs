// CMU ASF/AMC → MakeHuman (cmu_mb) skeleton retargeting.
import fs from 'node:fs';
import path from 'node:path';
import { Matrix4, Quaternion, Euler, Vector3 } from 'three';
import { CMU } from './paths.mjs';

export const RAW = CMU;
const UNIT = (1 / 0.45) * 0.0254; // ASF length units → metres

export async function fetchCMU(id) {
  fs.mkdirSync(RAW, { recursive: true });
  const [s] = id.split('_');
  const subj = String(parseInt(s, 10)).padStart(2, '0');
  const asf = path.join(RAW, `${subj}.asf`), amc = path.join(RAW, `${id}.amc`);
  for (const [f, url] of [[asf, `http://mocap.cs.cmu.edu/subjects/${subj}/${subj}.asf`], [amc, `http://mocap.cs.cmu.edu/subjects/${subj}/${id}.amc`]]) {
    if (fs.existsSync(f) && fs.statSync(f).size > 100) continue;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url} ${r.status}`);
    fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
  }
  return { asf, amc };
}

const D2R = Math.PI / 180;
const eulerMat = (x, y, z) => new Matrix4().makeRotationFromEuler(new Euler(x * D2R, y * D2R, z * D2R, 'ZYX'));

export function parseASF(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').map(l => l.trim());
  const bones = { root: { name: 'root', dir: new Vector3(), len: 0, C: new Matrix4(), Ci: new Matrix4(), dof: ['rx', 'ry', 'rz'], children: [] } };
  let i = 0;
  while (i < lines.length && lines[i] !== ':bonedata') i++;
  i++;
  let cur = null;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith(':hierarchy')) break;
    if (l === 'begin') { cur = { dof: [], children: [] }; continue; }
    if (l === 'end') { bones[cur.name] = cur; cur = null; continue; }
    if (!cur) continue;
    const p = l.split(/\s+/);
    if (p[0] === 'name') cur.name = p[1];
    else if (p[0] === 'direction') cur.dir = new Vector3(+p[1], +p[2], +p[3]).normalize();
    else if (p[0] === 'length') cur.len = +p[1] * UNIT;
    else if (p[0] === 'axis') { cur.C = eulerMat(+p[1], +p[2], +p[3]); cur.Ci = cur.C.clone().invert(); }
    else if (p[0] === 'dof') cur.dof = p.slice(1);
  }
  // hierarchy
  for (i++; i < lines.length; i++) {
    const l = lines[i];
    if (l === 'begin') continue;
    if (l === 'end') break;
    const p = l.split(/\s+/);
    if (!p[0]) continue;
    for (const c of p.slice(1)) { bones[c].parent = p[0]; bones[p[0]].children.push(c); }
  }
  const order = [];
  const visit = n => { order.push(n); for (const c of bones[n].children) visit(c); };
  visit('root');
  return { bones, order };
}

export function parseAMC(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const frames = [];
  let cur = null;
  for (const ln of lines) {
    const l = ln.trim();
    if (!l || l.startsWith('#') || l.startsWith(':')) continue;
    if (/^\d+$/.test(l)) { cur = {}; frames.push(cur); continue; }
    if (!cur) continue;
    const p = l.split(/\s+/);
    cur[p[0]] = p.slice(1).map(Number);
  }
  return frames;
}

// Global rotation (rest = identity) of every ASF bone + root position (metres), per frame.
export function asfGlobals(skel, frame) {
  const G = {};
  const r = frame.root;
  const rootPos = new Vector3(r[0], r[1], r[2]).multiplyScalar(UNIT);
  G.root = eulerMat(r[3], r[4], r[5]);
  for (const n of skel.order) {
    if (n === 'root') continue;
    const b = skel.bones[n];
    const vals = frame[n] || [];
    let rx = 0, ry = 0, rz = 0;
    b.dof.forEach((d, k) => { if (d === 'rx') rx = vals[k] || 0; else if (d === 'ry') ry = vals[k] || 0; else if (d === 'rz') rz = vals[k] || 0; });
    const M = eulerMat(rx, ry, rz);
    G[n] = new Matrix4().multiplyMatrices(G[b.parent], b.C).multiply(M).multiply(b.Ci);
  }
  return { G, rootPos };
}

export const ASF2MH = {
  root: 'Hips', lhipjoint: 'LHipJoint', lfemur: 'LeftUpLeg', ltibia: 'LeftLeg', lfoot: 'LeftFoot', ltoes: 'LeftToeBase',
  rhipjoint: 'RHipJoint', rfemur: 'RightUpLeg', rtibia: 'RightLeg', rfoot: 'RightFoot', rtoes: 'RightToeBase',
  lowerback: 'LowerBack', upperback: 'Spine', thorax: 'Spine1', lowerneck: 'Neck', upperneck: 'Neck1', head: 'Head',
  lclavicle: 'LeftShoulder', lhumerus: 'LeftArm', lradius: 'LeftForeArm', lwrist: 'LeftHand', lhand: 'LeftFingerBase', lfingers: 'LeftHandFinger1', lthumb: 'LThumb',
  rclavicle: 'RightShoulder', rhumerus: 'RightArm', rradius: 'RightForeArm', rwrist: 'RightHand', rhand: 'RightFingerBase', rfingers: 'RightHandFinger1', rthumb: 'RThumb',
};
const RIGID = new Set(['root', 'lhipjoint', 'rhipjoint']);

// Retarget setup between one ASF skeleton and the MH body skeleton.
export function makeRetarget(skel, body) {
  const mh = body.bones;
  const idx = Object.fromEntries(mh.map((b, i) => [b.name, i]));
  const O = {}; // per ASF bone: rest offset rotation (ASF rest dir → MH rest dir)
  for (const [a, m] of Object.entries(ASF2MH)) {
    const b = skel.bones[a]; if (!b) continue;
    if (RIGID.has(a)) { O[a] = new Matrix4(); continue; }
    const bm = mh[idx[m]];
    const r = new Vector3(bm.tail[0] - bm.head[0], bm.tail[1] - bm.head[1], bm.tail[2] - bm.head[2]).normalize();
    const q = new Quaternion().setFromUnitVectors(b.dir, r);
    O[a] = new Matrix4().makeRotationFromQuaternion(q);
  }
  // Leg scale: MH hip→ankle vs ASF femur + tibia.
  const mhLeg = new Vector3(...mh[idx.LeftLeg].head).sub(new Vector3(...mh[idx.LeftUpLeg].head)).length() + new Vector3(...mh[idx.LeftFoot].head).sub(new Vector3(...mh[idx.LeftLeg].head)).length();
  const asfLeg = skel.bones.lfemur.len + skel.bones.ltibia.len;
  const legScale = mhLeg / asfLeg;
  const mh2asf = Object.fromEntries(Object.entries(ASF2MH).map(([a, m]) => [m, a]));
  return { O, legScale, idx, mh2asf };
}

// One frame → MH local quaternions (rest-relative; MH rest frames are world aligned) + root position.
export function retargetFrame(skel, rt, body, frame) {
  const { G, rootPos } = asfGlobals(skel, frame);
  const mh = body.bones;
  const Wm = new Array(mh.length);
  const qLocal = new Array(mh.length);
  const tmp = new Matrix4();
  for (let i = 0; i < mh.length; i++) {
    const a = rt.mh2asf[mh[i].name];
    if (a && G[a] && skel.bones[a]) Wm[i] = new Matrix4().multiplyMatrices(G[a], new Matrix4().copy(rt.O[a]).invert());
    else Wm[i] = mh[i].parent >= 0 ? Wm[mh[i].parent].clone() : new Matrix4();
    const parentW = mh[i].parent >= 0 ? Wm[mh[i].parent] : new Matrix4();
    tmp.copy(parentW).invert().multiply(Wm[i]);
    qLocal[i] = new Quaternion().setFromRotationMatrix(tmp);
  }
  return { q: qLocal, root: rootPos.multiplyScalar(rt.legScale) };
}

// Forward kinematics on the MH skeleton: world joint positions.
export function fk(body, q, root, yaw = 0) {
  const mh = body.bones;
  const Wq = new Array(mh.length), P = new Array(mh.length);
  const Y = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw);
  for (let i = 0; i < mh.length; i++) {
    const b = mh[i];
    if (b.parent < 0) {
      Wq[i] = Y.clone().multiply(q[i]);
      P[i] = new Vector3(...b.head).sub(new Vector3(0, b.head[1], 0)).add(root.clone().applyQuaternion(Y));
      // root.y already absolute height of the hips joint
    } else {
      const p = b.parent, off = new Vector3(b.head[0] - mh[p].head[0], b.head[1] - mh[p].head[1], b.head[2] - mh[p].head[2]);
      Wq[i] = Wq[p].clone().multiply(q[i]);
      P[i] = P[p].clone().add(off.applyQuaternion(Wq[p]));
    }
  }
  // tips (toe ends) for contact
  const tip = n => { const i = body.idx[n], b = mh[i]; return P[i].clone().add(new Vector3(b.tail[0] - b.head[0], b.tail[1] - b.head[1], b.tail[2] - b.head[2]).applyQuaternion(Wq[i])); };
  return { P, Wq, tip };
}
