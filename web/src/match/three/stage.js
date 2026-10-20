// WebGL stadium: floodlit pitch with shader-drawn markings, stands, LED boards, goals with nets
// that ripple, a stitched ball, and 25 skinned mocap players (22 + referee + assistants).
// Coordinates: the football engine uses x along the pitch, y across it and z up; the scene uses
// three.js axes X = x, Y = z (up), Z = y, which gives exactly the same picture as the 2D
// projection in ../../sim/draw.js, so telestrator overlays line up with the 3D image.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { L, WD, GOAL_W, GOAL_H, POST_A, POST_B, HZ, N_AGENTS, S } from '../../sim/core.js';
import { loadAssets, makeSkeleton } from './assets.js';
import { createKitMaterial, numberTexture } from './kit.js';
import { createController } from './controller.js';

const ASPECT = 16 / 9;
let singleton = null;

export function getStage() { return (singleton ||= createStage()); }

async function createStage() {
  const { body, lib } = await loadAssets();
  const canvas = document.createElement('canvas');
  canvas.width = 1280; canvas.height = 720;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance', preserveDrawingBuffer: false });
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = true;
  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  const scene = new THREE.Scene();
  const world = new THREE.Group();   // static scenery (hidden when drawing highlighted players only)
  scene.background = new THREE.Color('#070b14');
  scene.fog = new THREE.Fog('#0a0f1a', 160, 420);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.18;

  // ---------------------------------------------------------------- lights (night match, floodlit)
  const hemi = new THREE.HemisphereLight('#c7d8ff', '#24402a', 0.4);
  scene.add(hemi);
  const key = new THREE.DirectionalLight('#fff6e8', 2.1);
  key.castShadow = true;
  const mobile = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  key.shadow.mapSize.set(mobile ? 2048 : 4096, mobile ? 2048 : 4096);
  key.shadow.bias = -0.0004; key.shadow.normalBias = 0.02;
  Object.assign(key.shadow.camera, { left: -48, right: 48, top: 48, bottom: -48, near: 1, far: 260 });
  key.shadow.radius = 2.5;
  scene.add(key, key.target);
  const fill = new THREE.DirectionalLight('#dfe9ff', 0.7);
  fill.position.set(L / 2 + 60, 70, -60); fill.target.position.set(L / 2, 0, WD / 2);
  scene.add(fill, fill.target);
  const KEY_DIR = new THREE.Vector3(-0.35, 1.0, 0.75).normalize();

  // ---------------------------------------------------------------- pitch
  const pitchMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.92, metalness: 0 });
  pitchMat.onBeforeCompile = sh => {
    sh.vertexShader = 'varying vec3 vW;\n' + sh.vertexShader.replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n vW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = 'varying vec3 vW;\n' + PITCH_GLSL + sh.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\n diffuseColor.rgb = pitchColor(vW.xz);');
  };
  pitchMat.customProgramCacheKey = () => 'pitch-v1';
  const pitch = new THREE.Mesh(new THREE.PlaneGeometry(L + 24, WD + 26, 1, 1), pitchMat);
  pitch.rotation.x = -Math.PI / 2; pitch.position.set(L / 2, 0, WD / 2);
  pitch.receiveShadow = true;
  world.add(pitch);
  // Track / surround beyond the grass
  const apron = new THREE.Mesh(new THREE.PlaneGeometry(L + 90, WD + 90), new THREE.MeshStandardMaterial({ color: '#1d4a2a', roughness: 1 }));
  apron.rotation.x = -Math.PI / 2; apron.position.set(L / 2, -0.02, WD / 2);
  world.add(apron);

  // ---------------------------------------------------------------- stands, roof, floodlights
  const crowdTex = makeCrowdTexture();
  crowdTex.anisotropy = maxAniso;
  const standMat = new THREE.MeshBasicMaterial({ map: crowdTex, color: '#b9c2d0', side: THREE.DoubleSide });
  const darkMat = new THREE.MeshBasicMaterial({ color: '#06080d', side: THREE.DoubleSide });
  const fasciaMat = new THREE.MeshBasicMaterial({ color: '#10141c', side: THREE.DoubleSide });
  const wallMat = new THREE.MeshBasicMaterial({ color: '#1b2430', side: THREE.DoubleSide });
  const lampMat = new THREE.MeshBasicMaterial({ color: '#fffbe8', side: THREE.DoubleSide, fog: false });
  const stands = new THREE.Group();
  // A stand: inclined plane rising away from the pitch, plus front wall and roof.
  function quad(a, b, c, d, mat, uScale = 1, vScale = 1) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([...a, ...b, ...c, ...d], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, uScale, 0, uScale, vScale, 0, vScale], 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    return new THREE.Mesh(geo, mat);
  }
  // A stand in local space: the pitch is towards −Z, rows rise towards +Z.
  function stand(cx, cz, rotY, width, depth = 34, h0 = 2.2, h1 = 26) {
    const g = new THREE.Group(), hw = width / 2;
    const run = Math.hypot(depth, h1 - h0);
    g.add(quad([-hw, h0, 0], [hw, h0, 0], [hw, h1, depth], [-hw, h1, depth], standMat, width / 18, run / 9));
    g.add(quad([-hw, 0, -0.01], [hw, 0, -0.01], [hw, h0, -0.01], [-hw, h0, -0.01], wallMat));
    g.add(quad([-hw - 2, h1 + 7, -8], [hw + 2, h1 + 7, -8], [hw + 2, h1 + 7, depth + 4], [-hw - 2, h1 + 7, depth + 4], darkMat));
    g.add(quad([-hw - 2, h1 + 4.9, -8], [hw + 2, h1 + 4.9, -8], [hw + 2, h1 + 7, -8], [-hw - 2, h1 + 7, -8], fasciaMat));
    g.add(quad([-hw * 0.92, h1 + 4.3, -8.05], [hw * 0.92, h1 + 4.3, -8.05], [hw * 0.92, h1 + 4.85, -8.05], [-hw * 0.92, h1 + 4.85, -8.05], lampMat));
    g.position.set(cx, 0, cz); g.rotation.y = rotY;
    stands.add(g);
  }
  // Far side (beyond y = -), near side (behind the main camera), and both ends.
  stand(L / 2, -9, Math.PI, L + 40);
  stand(L / 2, WD + 9, 0, L + 40);
  stand(-10, WD / 2, -Math.PI / 2, WD + 30, 30, 2.2, 22);
  stand(L + 10, WD / 2, Math.PI / 2, WD + 30, 30, 2.2, 22);
  world.add(stands);
  // Glow sprites for the floodlights (visible from low cameras)
  const glowTex = makeGlowTexture();
  const glowMat = new THREE.SpriteMaterial({ map: glowTex, color: '#fff6dc', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.55, fog: false });
  for (const [x, z] of [[-6, -12], [L + 6, -12], [-6, WD + 12], [L + 6, WD + 12], [L / 2, -14]]) {
    const s = new THREE.Sprite(glowMat); s.position.set(x, 36, z); s.scale.set(16, 16, 1); world.add(s);
  }

  // ---------------------------------------------------------------- LED boards
  const boardTex = new THREE.CanvasTexture(makeBoardCanvas(['SÜPER LIG MIX', 'DRAFT DUEL'], ['#e3262f', '#2563eb']));
  boardTex.colorSpace = THREE.SRGBColorSpace; boardTex.wrapS = THREE.RepeatWrapping; boardTex.anisotropy = maxAniso;
  const boardMat = new THREE.MeshBasicMaterial({ map: boardTex, color: '#d8d8d8' });
  const boardBack = new THREE.MeshStandardMaterial({ color: '#0d1117', roughness: 0.8 });
  function board(x0, z0, x1, z1) {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const geo = new THREE.BoxGeometry(len, 0.95, 0.12);
    const mats = [boardBack, boardBack, boardBack, boardBack, boardMat, boardBack];
    const m = new THREE.Mesh(geo, mats);
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * (len / 34));
    m.position.set((x0 + x1) / 2, 0.475, (z0 + z1) / 2);
    m.rotation.y = -Math.atan2(z1 - z0, x1 - x0);
    m.castShadow = true;
    world.add(m);
  }
  board(-6, -4.2, L + 6, -4.2);          // far touchline, faces +Z
  board(L + 6, WD + 5.2, -6, WD + 5.2);  // near touchline, faces −Z
  board(-5.5, WD + 4, -5.5, -3);          // left end, faces +X
  board(L + 5.5, -3, L + 5.5, WD + 4);    // right end, faces −X

  // ---------------------------------------------------------------- goals
  const goals = [makeGoal(0, -1), makeGoal(L, 1)];
  for (const g of goals) world.add(g.group);
  // Corner flags
  const flagPoleMat = new THREE.MeshStandardMaterial({ color: '#f4f4f4', roughness: 0.5 });
  const flagMat = new THREE.MeshStandardMaterial({ color: '#ffcc00', side: THREE.DoubleSide, roughness: 0.8 });
  for (const [x, z] of [[0, 0], [L, 0], [0, WD], [L, WD]]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.5, 8), flagPoleMat);
    pole.position.set(x, 0.75, z); pole.castShadow = true; world.add(pole);
    const fl = new THREE.Mesh(new THREE.PlaneGeometry(0.35, 0.25), flagMat);
    fl.position.set(x + 0.18, 1.35, z); world.add(fl);
  }
  scene.add(world);
  {
  }

  // ---------------------------------------------------------------- ball
  const ballTex = new THREE.CanvasTexture(makeBallCanvas());
  ballTex.colorSpace = THREE.SRGBColorSpace; ballTex.anisotropy = maxAniso;
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.11, 40, 24), new THREE.MeshStandardMaterial({ map: ballTex, roughness: 0.35, metalness: 0 }));
  ball.castShadow = true;
  scene.add(ball);

  // ---------------------------------------------------------------- people
  const ctrl = createController(lib, body);
  const people = [];
  const cardMatY = new THREE.MeshBasicMaterial({ color: '#ffd400', side: THREE.DoubleSide });
  const cardMatR = new THREE.MeshBasicMaterial({ color: '#ef1c1c', side: THREE.DoubleSide });
  for (let a = 0; a < N_AGENTS; a++) {
    const bones = makeSkeleton(body);
    const mat = createKitMaterial(body);
    const mesh = new THREE.SkinnedMesh(body.geo, mat);
    mesh.add(bones[0]);
    mesh.bind(new THREE.Skeleton(bones));
    mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false;
    const g = new THREE.Group(); g.add(mesh);
    // Props: card (referee), flag (assistants)
    const hand = bones[body.idx.RightHand];
    let card = null, flag = null;
    if (a === 22) { card = new THREE.Mesh(new THREE.PlaneGeometry(0.075, 0.105), cardMatY); card.position.set(-0.02, 0.0, 0.11); card.visible = false; hand.add(card); }
    if (a > 22) {
      flag = new THREE.Group();
      const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.55, 6), flagPoleMat);
      stick.position.set(0, 0.2, 0.05); flag.add(stick);
      const cloth = new THREE.Mesh(new THREE.PlaneGeometry(0.32, 0.24), new THREE.MeshStandardMaterial({ map: makeFlagTexture(), side: THREE.DoubleSide, roughness: 0.8 }));
      cloth.position.set(0.16, 0.36, 0.05); flag.add(cloth);
      hand.add(flag);
    }
    scene.add(g);
    people.push({ g, mesh, bones, mat, u: mat.userData.uniforms, card, flag });
  }

  // ---------------------------------------------------------------- per-match cast (kits, faces)
  let castKey = null;
  const faceTex = new Map();
  function setCast(key, looks, photos, teamNames) {
    if (key === castKey) return;
    castKey = key;
    for (let a = 0; a < N_AGENTS; a++) {
      const lk = looks[a], p = people[a], u = p.u;
      u.uShirt.value.set(lk.shirt); u.uShirt2.value.set(lk.shirt2 || lk.trim || '#ffffff');
      u.uShorts.value.set(lk.shorts); u.uSocks.value.set(lk.socks); u.uBoots.value.set(lk.boots || '#111111');
      u.uSkin.value.set(lk.skin || '#c8956b'); u.uHasHair.value = lk.hair ? 1 : 0; if (lk.hair) u.uHair.value.set(lk.hair);
      u.uNumCol.value.set(lk.numColor || '#ffffff'); u.uTrim.value.set(/^#/.test(lk.trim || '') ? lk.trim : lk.numColor || '#ffffff');
      u.uSleeve.value = lk.longSleeve ? 0.985 : 0.27;
      u.uHasGlove.value = lk.gloves ? 1 : 0; if (lk.gloves) u.uGlove.value.set(lk.gloves);
      u.uPattern.value = lk.pattern || 0;
      if (lk.num != null) { u.uNum.value?.dispose?.(); u.uNum.value = numberTexture(lk.num, lk.backName || surname(lk.name)); u.uHasNum.value = 1; }
      else u.uHasNum.value = 0;
      const img = lk.id != null ? photos?.get?.(lk.id) : null;
      if (img) {
        let t = faceTex.get(img);
        if (!t) { t = new THREE.Texture(img); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; t.needsUpdate = true; faceTex.set(img, t); }
        u.uFace.value = t; u.uHasFace.value = 1;
        const xf = lk.faceXf || [0.86, 0.07, 0.78, 0.14];
        u.uFaceXf.value.set(xf[0], xf[1], xf[2], xf[3]);
      } else u.uHasFace.value = 0;
      const h = lk.height || 1.8;
      p.g.scale.setScalar(h / body.height);
    }
    if (teamNames) {
      const c = makeBoardCanvas(teamNames.texts, teamNames.colors);
      boardTex.image = c; boardTex.needsUpdate = true;
    }
  }

  // ---------------------------------------------------------------- per-frame
  const cam3 = new THREE.PerspectiveCamera(30, ASPECT, 0.3, 700);
  cam3.up.set(0, 1, 0);
  const ballQ = new WeakMap();
  function ballOrientation(clip, f) {
    let arr = ballQ.get(clip);
    if (!arr) {
      arr = new Float32Array(clip.N * 4);
      const q = new THREE.Quaternion(), dq = new THREE.Quaternion(), ax = new THREE.Vector3();
      for (let k = 0; k < clip.N; k++) {
        if (k > 0) {
          const dx = clip.ball[k * 3] - clip.ball[(k - 1) * 3], dy = clip.ball[k * 3 + 1] - clip.ball[(k - 1) * 3 + 1];
          const d = Math.hypot(dx, dy);
          if (d > 1e-4 && d < 3) {
            // rolling axis: horizontal, perpendicular to travel (three coords: X = x, Z = y)
            ax.set(dy, 0, -dx).normalize();
            dq.setFromAxisAngle(ax, d / 0.11);
            q.premultiply(dq);
          }
        }
        arr[k * 4] = q.x; arr[k * 4 + 1] = q.y; arr[k * 4 + 2] = q.z; arr[k * 4 + 3] = q.w;
      }
      ballQ.set(clip, arr);
    }
    const i = Math.min(clip.N - 1, Math.max(0, Math.round(f)));
    return arr.subarray(i * 4, i * 4 + 4);
  }

  function setCamera(cam) {
    // cam from draw.js: { pos:[x,y,z], look:[x,y,z], fov }
    cam3.fov = cam.fov; cam3.position.set(cam.pos[0], cam.pos[2], cam.pos[1]);
    cam3.lookAt(cam.look[0], cam.look[2], cam.look[1]);
    cam3.updateProjectionMatrix();
    // Shadow frustum follows what the camera is looking at.
    const tx = cam.look[0], tz = cam.look[1];
    key.target.position.set(tx, 0, tz);
    key.position.set(tx + KEY_DIR.x * 120, KEY_DIR.y * 120, tz + KEY_DIR.z * 120);
    key.target.updateMatrixWorld();
  }

  // Draw one engine frame into a 2D context. opts: { only:Set, transparent, ripple, looksFoot }
  const v3 = new THREE.Vector3();
  function draw(ctx, cam, clip, t, opts = {}) {
    const w = ctx.canvas.width, h = ctx.canvas.height;
    if (canvas.width < w || canvas.height < h) renderer.setSize(Math.max(canvas.width, w), Math.max(canvas.height, h), false);
    renderer.setViewport(0, canvas.height - h, w, h);
    renderer.setScissor(0, canvas.height - h, w, h);
    renderer.setScissorTest(true);
    setCamera(cam);
    const N = clip.N, f = Math.max(0, Math.min(N - 1, t * HZ)), i = Math.floor(f), j = Math.min(i + 1, N - 1), a = f - i;
    const bx = clip.ball[i * 3] + (clip.ball[j * 3] - clip.ball[i * 3]) * a;
    const by = clip.ball[i * 3 + 1] + (clip.ball[j * 3 + 1] - clip.ball[i * 3 + 1]) * a;
    const bz = clip.ball[i * 3 + 2] + (clip.ball[j * 3 + 2] - clip.ball[i * 3 + 2]) * a;
    const only = opts.only || null;
    ball.position.set(bx, bz + 0.11, by);
    const bq = ballOrientation(clip, f);
    ball.quaternion.set(bq[0], bq[1], bq[2], bq[3]);
    ball.visible = !only;
    const ballPt = { x: bx, y: by };
    for (let ag = 0; ag < N_AGENTS; ag++) {
      const p = people[ag];
      const r = ctrl.agentPose(clip, ag, t, opts.looks?.[ag], ballPt);
      p.g.visible = r.visible && (!only || only.has(ag));
      if (!p.g.visible) continue;
      const q = r.pose.q;
      for (let b = 0; b < p.bones.length; b++) p.bones[b].quaternion.set(q[b * 4], q[b * 4 + 1], q[b * 4 + 2], q[b * 4 + 3]);
      p.bones[0].position.set(r.pose.r[0], r.pose.r[1], r.pose.r[2]);
      p.g.position.set(r.x, 0, r.y);
      p.g.rotation.y = Math.PI / 2 - r.yaw;
      // props
      if (p.card) {
        const st = clip.st[i * N_AGENTS + ag];
        p.card.visible = st === S.CARD_Y || st === S.CARD_R;
        p.card.material = st === S.CARD_R ? cardMatR : cardMatY;
      }
    }
    // Net ripple
    for (const g of goals) g.setRipple(opts.ripple && Math.abs(opts.ripple.x - g.x) < 1 ? opts.ripple : null);
    // Static scenery is hidden when only a few players are drawn (freeze-frame highlights).
    world.visible = !only;
    scene.background = opts.transparent ? null : BG;
    renderer.setClearColor(0x000000, opts.transparent ? 0 : 1);
    renderer.render(scene, cam3);
    renderer.setScissorTest(false);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(canvas, 0, 0, w, h, 0, 0, w, h);
    ctx.restore();
    world.visible = true;
  }
  const BG = scene.background;

  // Compile every shader up front so the first frame of each scene doesn't stall.
  function warm() {
    renderer.setSize(Math.max(canvas.width, 1280), Math.max(canvas.height, 720), false);
    cam3.position.set(L / 2, 29, WD + 48); cam3.lookAt(L / 2, 0, 29);
    renderer.compile(scene, cam3);
  }
  warm();

  return { draw, setCast, renderer, canvas, scene, people, ctrl, body, lib };
}

const surname = n => { const p = String(n || '').trim().split(/\s+/); return p.length > 1 ? p.slice(-1)[0] : p[0] || ''; };

// ---------------------------------------------------------------- pitch shader
const PITCH_GLSL = /* glsl */`
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y); }
float segD(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h); }
float arcD(vec2 p, vec2 c, float r) { return abs(length(p - c) - r); }
float lineDist(vec2 p) {
  float d = 1e3;
  d = min(d, segD(p, vec2(0.0, 0.0), vec2(105.0, 0.0)));
  d = min(d, segD(p, vec2(0.0, 68.0), vec2(105.0, 68.0)));
  d = min(d, segD(p, vec2(0.0, 0.0), vec2(0.0, 68.0)));
  d = min(d, segD(p, vec2(105.0, 0.0), vec2(105.0, 68.0)));
  d = min(d, segD(p, vec2(52.5, 0.0), vec2(52.5, 68.0)));
  d = min(d, arcD(p, vec2(52.5, 34.0), 9.15));
  vec2 q = vec2(min(p.x, 105.0 - p.x), p.y);
  d = min(d, segD(q, vec2(0.0, 13.84), vec2(16.5, 13.84)));
  d = min(d, segD(q, vec2(16.5, 13.84), vec2(16.5, 54.16)));
  d = min(d, segD(q, vec2(0.0, 54.16), vec2(16.5, 54.16)));
  d = min(d, segD(q, vec2(0.0, 24.84), vec2(5.5, 24.84)));
  d = min(d, segD(q, vec2(5.5, 24.84), vec2(5.5, 43.16)));
  d = min(d, segD(q, vec2(0.0, 43.16), vec2(5.5, 43.16)));
  if (q.x > 16.5) d = min(d, arcD(q, vec2(11.0, 34.0), 9.15));
  vec2 qc = vec2(q.x, min(p.y, 68.0 - p.y));
  if (qc.x >= 0.0 && qc.y >= 0.0) d = min(d, arcD(qc, vec2(0.0), 1.0));
  return d;
}
float spotDist(vec2 p) {
  float d = length(p - vec2(52.5, 34.0));
  d = min(d, length(p - vec2(11.0, 34.0)));
  d = min(d, length(p - vec2(94.0, 34.0)));
  return d - 0.12;
}
vec3 pitchColor(vec2 p) {
  vec3 a = vec3(0.060, 0.215, 0.070), b = vec3(0.047, 0.180, 0.058);
  float sw = 105.0 / 18.0;
  float s = p.x / sw;
  float fw = fwidth(s);
  float stripe = smoothstep(0.5 - fw, 0.5 + fw, abs(fract(s) - 0.5) * 2.0);
  // stripes stop at the edge of the field of play (plus a little run-off)
  float inField = step(-2.5, p.x) * step(p.x, 107.5) * step(-2.5, p.y) * step(p.y, 70.5);
  vec3 c = mix(a, b, stripe * inField);
  c = mix(c, vec3(0.045, 0.16, 0.055), 1.0 - inField);
  float n = vnoise(p * 0.9) * 0.6 + vnoise(p * 3.7) * 0.3 + vnoise(p * 17.0) * 0.1;
  c *= 0.88 + 0.24 * n;
  // wear in the goalmouths and centre circle
  float wear = exp(-pow(length((vec2(min(p.x, 105.0 - p.x), p.y) - vec2(4.0, 34.0)) * vec2(0.35, 0.22)), 2.0)) * 0.35;
  c = mix(c, vec3(0.12, 0.16, 0.07), wear);
  float d = lineDist(p);
  float lw = fwidth(d) + 1e-4;
  float line = 1.0 - smoothstep(0.06 - lw, 0.06 + lw, d);
  float sd = spotDist(p); float sw2 = fwidth(sd) + 1e-4;
  line = max(line, 1.0 - smoothstep(-sw2, sw2, sd));
  return mix(c, vec3(0.75, 0.78, 0.75), line * 0.95);
}
`;

// ---------------------------------------------------------------- goal + net
function makeGoal(gx, s) {
  const group = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.35 });
  const r = 0.06;
  const post = (y0, y1, z0, z1, x0 = gx, x1 = gx) => {
    const a = new THREE.Vector3(x0, z0, y0), b = new THREE.Vector3(x1, z1, y1);
    const len = a.distanceTo(b);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 16), white);
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    m.castShadow = true;
    group.add(m);
  };
  post(POST_A, POST_A, 0, GOAL_H + r);
  post(POST_B, POST_B, 0, GOAL_H + r);
  post(POST_A - r, POST_B + r, GOAL_H, GOAL_H);
  // back stanchions (thin)
  const depthTop = 1.4, depthBot = 2.0;
  const thin = (x0, y0, z0, x1, y1, z1) => {
    const a = new THREE.Vector3(x0, z0, y0), b = new THREE.Vector3(x1, z1, y1);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, a.distanceTo(b), 8), white);
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    group.add(m);
  };
  for (const y of [POST_A, POST_B]) { thin(gx, y, GOAL_H, gx + s * depthTop, y, GOAL_H); thin(gx + s * depthTop, y, GOAL_H, gx + s * depthBot, y, 0); }
  // Net: one mesh, three panels (back, top, sides) in a shared (y, z) parameterisation.
  const uni = { uRipple: { value: new THREE.Vector4(34, 1, -10, 0) }, uS: { value: s }, uGX: { value: gx } };
  const netMat = new THREE.ShaderMaterial({
    uniforms: uni, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: /* glsl */`
      uniform vec4 uRipple; uniform float uS; uniform float uGX;
      attribute vec2 netUV; attribute float netBack;
      varying vec2 vUV;
      void main() {
        vec3 p = position;
        float dd = length(vec2(p.z, p.y) - uRipple.xy);
        float t = uRipple.z;
        float bulge = t >= 0.0 ? (exp(-dd * dd / 3.0) * max(0.0, sin(t * 14.0) * exp(-t * 3.2)) * 0.9 + exp(-dd * dd / 2.0) * exp(-t * 1.2) * 0.6) : 0.0;
        p.x += uS * bulge * netBack;
        vUV = netUV;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */`
      varying vec2 vUV;
      void main() {
        vec2 g = vUV / 0.14;
        vec2 f = abs(fract(g) - 0.5);
        vec2 w = fwidth(g);
        // ~1 cm cords on a 14 cm mesh; anti-aliased, fading to a light haze at distance
        float hw = 0.035;
        float lx = 1.0 - smoothstep(hw - w.x, hw + w.x, 0.5 - f.x);
        float ly = 1.0 - smoothstep(hw - w.y, hw + w.y, 0.5 - f.y);
        float a = max(lx, ly);
        float far = clamp(max(w.x, w.y) * 1.8, 0.0, 1.0);
        a = mix(a, 0.22, far);
        gl_FragColor = vec4(vec3(0.93), a * 0.75);
      }`,
  });
  const pos = [], uv = [], back = [], idx = [];
  const panel = (fn, nu, nv, isBack) => {
    const base = pos.length / 3;
    for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
      const [x, y, z, u, v] = fn(i / nu, j / nv);
      pos.push(x, z, y); uv.push(u, v); back.push(isBack);
    }
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const a = base + j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
      idx.push(a, b, d, a, d, c);
    }
  };
  const depthAt = z => depthBot + (depthTop - depthBot) * (z / GOAL_H);
  panel((u, v) => { const y = POST_A + u * GOAL_W, z = v * GOAL_H; return [gx + s * depthAt(z), y, z, y, z]; }, 40, 14, 1);
  panel((u, v) => { const y = POST_A + u * GOAL_W, d = v * depthTop; return [gx + s * d, y, GOAL_H, y, GOAL_H + d]; }, 40, 6, 0.5);
  for (const y of [POST_A, POST_B]) panel((u, v) => { const z = v * GOAL_H, d = u * depthAt(z); return [gx + s * d, y, z, d, z]; }, 8, 12, 0);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('netUV', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('netBack', new THREE.Float32BufferAttribute(back, 1));
  geo.setIndex(idx);
  const net = new THREE.Mesh(geo, netMat);
  net.renderOrder = 2;
  group.add(net);
  return {
    group, x: gx,
    setRipple(r) {
      if (!r) { uni.uRipple.value.z = -1; return; }
      uni.uRipple.value.set(r.at.y, r.at.z, r.t, 0);
    },
  };
}

// ---------------------------------------------------------------- textures
function makeCrowdTexture() {
  // 1024×512 px covers 18 m of a row × 9 m of the rake: ~0.55 m seats, ~0.85 m rows.
  const c = document.createElement('canvas'); c.width = 1024; c.height = 512;
  const x = c.getContext('2d');
  let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  x.fillStyle = '#10151d'; x.fillRect(0, 0, 1024, 512);
  const shirts = ['#d4d4d8', '#1f2937', '#991b1b', '#1d4ed8', '#facc15', '#f8fafc', '#334155', '#7c2d12', '#065f46', '#4b5563', '#b91c1c', '#e5e7eb'];
  const skins = ['#e0b896', '#c99a74', '#8d5a3b', '#f0cfb0', '#6b4226'];
  const hair = ['#1c1410', '#3b2a1e', '#5a4632', '#111', '#8a7a62'];
  const rowH = 48, seatW = 31;
  for (let row = 0; row < 11; row++) {
    const y = row * rowH - 6;
    x.fillStyle = '#1a2029'; x.fillRect(0, y + rowH - 10, 1024, 10);           // seat row / step
    x.fillStyle = 'rgba(0,0,0,0.5)'; x.fillRect(0, y + rowH - 2, 1024, 2);
    for (let i = 0; i < 34; i++) {
      if (rnd() < 0.06) continue;
      const cx = i * seatW + seatW / 2 + (rnd() - 0.5) * 6, stand = rnd() < 0.25 ? -6 : 0;
      const sh = shirts[Math.floor(rnd() * shirts.length)];
      x.fillStyle = sh;
      x.beginPath(); x.roundRect(cx - 10, y + 18 + stand, 20, 24, 6); x.fill();
      if (rnd() < 0.18) { x.fillRect(cx - 13, y + 2 + stand, 4, 18); x.fillRect(cx + 9, y + 2 + stand, 4, 18); }  // arms up
      x.fillStyle = skins[Math.floor(rnd() * skins.length)];
      x.beginPath(); x.arc(cx, y + 12 + stand, 6.5, 0, Math.PI * 2); x.fill();
      x.fillStyle = hair[Math.floor(rnd() * hair.length)];
      x.beginPath(); x.arc(cx, y + 10 + stand, 6.5, Math.PI, Math.PI * 2); x.fill();
    }
  }
  // soften: crowds are slightly out of focus on TV
  const c2 = document.createElement('canvas'); c2.width = 1024; c2.height = 512;
  const x2 = c2.getContext('2d'); x2.filter = 'blur(1.2px)'; x2.drawImage(c, 0, 0);
  const t = new THREE.CanvasTexture(c2);
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
function makeGlowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.15, 'rgba(255,250,230,0.6)'); g.addColorStop(1, 'rgba(255,240,200,0)');
  x.fillStyle = g; x.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}
export function makeBoardCanvas(texts, colors) {
  const c = document.createElement('canvas'); c.width = 2048; c.height = 64;
  const x = c.getContext('2d');
  x.fillStyle = '#05070a'; x.fillRect(0, 0, 2048, 64);
  const all = [...texts, 'GPT-6.1 SOL', 'TRANSFERMARKT DATA'];
  let px = 30, i = 0;
  while (px < 2048) {
    const t = all[i % all.length];
    const col = i % 3 === 0 ? colors[0] : i % 3 === 1 ? colors[1] : '#f8fafc';
    x.fillStyle = col; x.font = '900 40px system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif'; x.textBaseline = 'middle';
    x.fillText(t, px, 34); px += x.measureText(t).width + 80; i++;
  }
  // LED pixel grid
  x.fillStyle = 'rgba(0,0,0,0.18)';
  for (let yy = 0; yy < 64; yy += 3) x.fillRect(0, yy, 2048, 1);
  return c;
}
function makeFlagTexture() {
  const c = document.createElement('canvas'); c.width = 64; c.height = 48;
  const x = c.getContext('2d');
  for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) { x.fillStyle = (i + j) % 2 ? '#ffd400' : '#ff2d2d'; x.fillRect(i * 16, j * 16, 16, 16); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
// Classic 32-panel ball: Voronoi cells of the truncated icosahedron (12 black pentagons).
function makeBallCanvas() {
  const W = 512, H = 256;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  const img = x.createImageData(W, H);
  const p = (1 + Math.sqrt(5)) / 2;
  const ico = [[0, 1, p], [0, -1, p], [0, 1, -p], [0, -1, -p], [1, p, 0], [-1, p, 0], [1, -p, 0], [-1, -p, 0], [p, 0, 1], [-p, 0, 1], [p, 0, -1], [-p, 0, -1]].map(v => { const l = Math.hypot(...v); return v.map(a => a / l); });
  const dod = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) dod.push([sx, sy, sz]);
  for (const a of [-1, 1]) for (const b of [-1, 1]) { dod.push([0, a / p, b * p]); dod.push([a / p, b * p, 0]); dod.push([a * p, 0, b / p]); }
  const hex = dod.map(v => { const l = Math.hypot(...v); return v.map(a => a / l); });
  const centers = [...ico.map(v => [v, 1]), ...hex.map(v => [v, 0])];
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const lon = (i / W) * Math.PI * 2, lat = (j / H) * Math.PI;
    const d = [Math.sin(lat) * Math.cos(lon), Math.cos(lat), Math.sin(lat) * Math.sin(lon)];
    let b1 = -2, b2 = -2, k1 = 0;
    for (const [v, k] of centers) { const dt = d[0] * v[0] + d[1] * v[1] + d[2] * v[2]; if (dt > b1) { b2 = b1; b1 = dt; k1 = k; } else if (dt > b2) b2 = dt; }
    const seam = Math.acos(Math.min(1, b2)) - Math.acos(Math.min(1, b1)) < 0.03;
    let r = 245, g = 245, bb = 245;
    if (k1) { r = 24; g = 24; bb = 30; }
    if (seam) { r *= 0.55; g *= 0.55; bb *= 0.55; }
    const o = (j * W + i) * 4;
    img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = bb; img.data[o + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  return c;
}
