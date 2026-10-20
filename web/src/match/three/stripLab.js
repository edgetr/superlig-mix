import * as THREE from 'three';
import { loadAssets, loadLibrary, makeSkeleton } from './assets.js';
import { createKitMaterial } from './kit.js';
import { makePose, sampleAction, sampleCycle } from './pose.js';
const qs = new URLSearchParams(location.search);
const cv = document.getElementById('cv');
const renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true });
renderer.setSize(1600, 600, false);
const scene = new THREE.Scene(); scene.background = new THREE.Color('#1b2a3a');
scene.add(new THREE.HemisphereLight('#cfe3ff', '#2b4a2b', 1.4));
const sun = new THREE.DirectionalLight('#fff', 2.2); sun.position.set(-5, 10, 8); scene.add(sun);
const grid = new THREE.GridHelper(80, 80, '#9fd3a8', '#4f9a5c'); scene.add(grid);
const { body, lib } = await loadAssets();
const src = qs.get('lib') === 'main' ? lib : await loadLibrary('/models-dev/', 'raw');
const clip = src.clips[qs.get('clip')];
const n = Number(qs.get('n') || 10), t0 = Number(qs.get('t0') || 0), t1 = Number(qs.get('t1') || clip.dur);
const gap = Number(qs.get('gap') || 1.3);
const view = qs.get('cam') || 'side';
for (let i = 0; i < n; i++) {
  const t = t0 + (t1 - t0) * (n > 1 ? i / (n - 1) : 0);
  const bones = makeSkeleton(body);
  const mat = createKitMaterial(body);
  const mesh = new THREE.SkinnedMesh(body.geo, mat); mesh.add(bones[0]); mesh.bind(new THREE.Skeleton(bones)); mesh.frustumCulled = false;
  const g = new THREE.Group(); g.add(mesh);
  const pose = makePose(src.B);
  if (clip.kind === 'cycle') sampleCycle(clip, t / clip.dur, pose); else sampleAction(clip, t, pose);
  bones.forEach((b, k) => b.quaternion.set(pose.q[k * 4], pose.q[k * 4 + 1], pose.q[k * 4 + 2], pose.q[k * 4 + 3]));
  bones[0].position.set(pose.r[0], pose.r[1], pose.r[2]);
  const x = (i - (n - 1) / 2) * gap;
  if (view === 'side') { g.position.set(0, 0, x); g.rotation.y = 0; } else g.position.set(x, 0, 0);
  scene.add(g);
  // time label
  const c = document.createElement('canvas'); c.width = 128; c.height = 40; const cx = c.getContext('2d'); cx.fillStyle = '#fff'; cx.font = '28px sans-serif'; cx.fillText(t.toFixed(2), 4, 30);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c) })); sp.scale.set(0.8, 0.25, 1);
  sp.position.set(view === 'side' ? 0 : x, 2.25, view === 'side' ? x : 0); scene.add(sp);
}
const cam = new THREE.PerspectiveCamera(20, 1600 / 600, 0.1, 400);
const span = n * gap, D = Math.max(6, span / 0.94 * 1.08);
if (view === 'side') { cam.position.set(D, 1.2, 0); cam.lookAt(0, 0.95, 0); }
else if (view === 'back') { cam.position.set(0, 1.2, -D); cam.lookAt(0, 0.95, 0); }
else if (view === 'top') { cam.position.set(0, D * 0.9, D * 0.5); cam.lookAt(0, 0.3, 0); }
else { cam.position.set(0, 1.2, D); cam.lookAt(0, 0.95, 0); }
cam.updateProjectionMatrix();
renderer.render(scene, cam);
document.getElementById('info').textContent = `${qs.get('clip')} ${t0}-${t1} (dur ${clip.dur.toFixed(2)})`;
window.__done = true;
