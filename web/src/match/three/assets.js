// Player body + motion library loader.
// Body: MakeHuman HM08 base mesh shaped as an athletic male, with the CMU-compatible skeleton and
// skin weights from MPFB2 (all CC0). Motion: CMU Graphics Lab Motion Capture Database takes,
// retargeted offline to that skeleton (tools/mocap). See README › Credits.
import * as THREE from 'three';

const BASE = `${import.meta.env?.BASE_URL || '/'}models/`;
let loading = null;

export function loadAssets() {
  return (loading ||= (async () => {
    const [bj, bb, aj, ab] = await Promise.all([
      fetch(BASE + 'body.json').then(r => r.json()),
      fetch(BASE + 'body.bin').then(r => r.arrayBuffer()),
      fetch(BASE + 'anims.json').then(r => r.json()),
      fetch(BASE + 'anims.bin').then(r => r.arrayBuffer()),
    ]);
    return { body: makeBody(bj, bb), lib: makeLibrary(aj, ab, bj) };
  })());
}

const TYPES = { Float32Array, Uint8Array, Uint16Array, Int16Array, Uint32Array };
function view(buf, l) { const T = TYPES[l.type]; return new T(buf, l.offset, l.length); }

function makeBody(meta, buf) {
  const L = meta.layout;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(view(buf, L.position), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(view(buf, L.normal), 3));
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(view(buf, L.skinIndex), 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(view(buf, L.skinWeight), 4, true));
  geo.setAttribute('region', new THREE.BufferAttribute(view(buf, L.region), 1));
  geo.setAttribute('armT', new THREE.BufferAttribute(view(buf, L.armT), 1));
  geo.setAttribute('legT', new THREE.BufferAttribute(view(buf, L.legT), 1));
  geo.setIndex(new THREE.BufferAttribute(view(buf, L.index), 1));
  geo.computeBoundingSphere();
  geo.boundingSphere.radius = 2.2; // posed limbs reach further than the rest pose
  const bones = meta.bones;
  const idx = Object.fromEntries(bones.map((b, i) => [b.name, i]));
  return { geo, bones, idx, head: meta.head, height: meta.height };
}

// Skeleton instance: THREE.Bone hierarchy whose rest frames are world-aligned (identity rotations).
export function makeSkeleton(body) {
  const bones = body.bones.map(b => { const o = new THREE.Bone(); o.name = b.name; return o; });
  body.bones.forEach((b, i) => {
    if (b.parent >= 0) {
      const p = body.bones[b.parent];
      bones[i].position.set(b.head[0] - p.head[0], b.head[1] - p.head[1], b.head[2] - p.head[2]);
      bones[b.parent].add(bones[i]);
    } else bones[i].position.set(b.head[0], b.head[1], b.head[2]);
  });
  return bones;
}

export async function loadLibrary(base, name) {
  const [aj, ab] = await Promise.all([fetch(base + name + '.json').then(r => r.json()), fetch(base + name + '.bin').then(r => r.arrayBuffer())]);
  return makeLibrary(aj, ab);
}

// ---------------------------------------------------------------- motion library
// Each clip: samples × bones quaternions (Int16, rest-relative local rotations) + root position (mm).
function makeLibrary(meta, buf, bodyMeta) {
  const B = meta.bones.length;
  const Q = new Int16Array(buf, 0, meta.frames * B * 4);
  const R = new Int16Array(buf, meta.quatBytes, meta.frames * 3);
  const clips = {};
  for (const [name, c] of Object.entries(meta.clips)) {
    // Decode to floats once (small: a few hundred frames).
    const q = new Float32Array(c.n * B * 4), r = new Float32Array(c.n * 3);
    for (let i = 0; i < c.n * B * 4; i++) q[i] = Q[c.frame * B * 4 + i] / 32767;
    for (let i = 0; i < c.n * 3; i++) r[i] = R[c.frame * 3 + i] / 1000;
    clips[name] = { ...c, name, q, r, B };
  }
  return { clips, B, bones: meta.bones };
}
