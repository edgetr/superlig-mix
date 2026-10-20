import * as THREE from 'three';
import { loadAssets, makeSkeleton } from './assets.js';
import { createKitMaterial, numberTexture } from './kit.js';
import { makePose, sampleCycle, sampleAction } from './pose.js';
import { PLAYERS } from '../../../../shared/players.js';

const qs = new URLSearchParams(location.search);
const cv = document.getElementById('cv');
const renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true });
renderer.setPixelRatio(Number(qs.get('dpr') || devicePixelRatio));
renderer.setSize(1280, 720, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#1b2a3a');
const cam = new THREE.PerspectiveCamera(30, 16 / 9, 0.1, 200);
const view = qs.get('cam') || 'front';
scene.add(new THREE.HemisphereLight('#cfe3ff', '#2b4a2b', 1.2));
const sun = new THREE.DirectionalLight('#ffffff', 2.4);
sun.position.set(-6, 14, 9); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12 });
scene.add(sun);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ color: '#2f7d3f', roughness: 0.95 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
const grid = new THREE.GridHelper(80, 80, '#9fd3a8', '#4f9a5c'); grid.position.y = 0.002; scene.add(grid);

const { body, lib } = await loadAssets();
const names = (qs.get('clips') || 'idle,walk,jog,run,run_fast,sprint,walk_back,kick_r').split(',');
const travel = qs.get('travel') === '1';
const actors = names.map((n, i) => {
  const bones = makeSkeleton(body);
  const mat = createKitMaterial(body);
  const u = mat.userData.uniforms;
  u.uNum.value = numberTexture(7 + i, ['ARDA', 'KEREM', 'ICARDI', 'OSIMHEN', 'MERTENS', 'TORREIRA', 'SANE', 'BARIS'][i % 8]); u.uHasNum.value = 1;
  if (i % 2) { u.uShirt.value.set('#1d3fbf'); u.uSocks.value.set('#1d3fbf'); u.uShirt2.value.set('#facc15'); u.uPattern.value = 1; }
  const faceName = (qs.get('faces') || '').split(',')[i];
  if (faceName) {
    const p = PLAYERS.find(x => x.name.toLowerCase().includes(faceName.toLowerCase()));
    if (p) {
      const img = new Image(); img.crossOrigin = 'anonymous'; img.src = p.img;
      img.onload = () => { const t = new THREE.Texture(img); t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true; u.uFace.value = t; u.uHasFace.value = 1; window.__faces = (window.__faces || 0) + 1; };
      const xf = (qs.get('xf') || '0.86,0.07,0.78,0.14').split(',').map(Number);
      u.uFaceXf.value.set(...xf);
    }
  }
  const mesh = new THREE.SkinnedMesh(body.geo, mat);
  mesh.add(bones[0]);
  mesh.bind(new THREE.Skeleton(bones));
  mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false;
  const g = new THREE.Group(); g.add(mesh);
  g.position.x = (i - (names.length - 1) / 2) * 1.6;
  scene.add(g);
  return { name: n, clip: lib.clips[n], bones, g, pose: makePose(lib.B), x0: g.position.x };
});
if (view === 'side') { cam.position.set(16, 1.6, 6); cam.lookAt(0, 0.9, 0); }
else if (view === 'back') { cam.position.set(0, 2.2, -14); cam.lookAt(0, 0.9, 0); }
else if (view === 'broadcast') { cam.position.set(0, 18, 34); cam.lookAt(0, 0, 0); cam.fov = 18; }
else if (view === 'face') { cam.position.set(0, 1.62, 5.2); cam.lookAt(0, 1.6, 0); cam.fov = 28; }
else if (view === 'faceclose') { cam.position.set(0, 1.63, 1.25); cam.lookAt(0, 1.61, 0); cam.fov = 26; }
else if (view === 'face34') { cam.position.set(3.5, 1.65, 4.2); cam.lookAt(0, 1.6, 0); cam.fov = 28; }
else { cam.position.set(0, 1.9, 14); cam.lookAt(0, 0.95, 0); }
cam.updateProjectionMatrix();

function apply(a, t) {
  const c = a.clip;
  if (!c) return;
  if (c.kind === 'cycle') sampleCycle(c, t / c.dur, a.pose);
  else sampleAction(c, c.loop ? t : t % c.dur, a.pose);
  const q = a.pose.q;
  a.bones.forEach((b, i) => b.quaternion.set(q[i * 4], q[i * 4 + 1], q[i * 4 + 2], q[i * 4 + 3]));
  a.bones[0].position.set(a.pose.r[0], a.pose.r[1], a.pose.r[2]);
  if (travel && c.kind === 'cycle') { a.g.position.z = ((t * c.speed) % 10) - 5; }
}
const fixed = qs.get('t');
const t0 = performance.now();
function frame() {
  const t = fixed != null ? Number(fixed) : (performance.now() - t0) / 1000;
  for (const a of actors) apply(a, t);
  renderer.render(scene, cam);
  document.getElementById('info').textContent = names.join(' · ') + ` t=${t.toFixed(2)}`;
  requestAnimationFrame(frame); window.__done = true;
}
frame();
window.__ready = true;
