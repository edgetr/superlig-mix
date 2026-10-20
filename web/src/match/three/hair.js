// Real hair: per-player hair cards grown from the scalp, plus beard fuzz and eyebrows.
//
// The style comes from the photo analysis (faceFit.js): length and volume on top and at the sides,
// curliness (structure tensor of the hair), strand direction over the front, the hairline, hair
// hanging beside the neck (long hair, locs), and the hair colours (top, sides, roots → tips).
// Strands are grown from the scalp of the player's own (reshaped) head: a few thousand thin cards,
// each carrying a dozen strands in an alpha texture (alpha-to-coverage), combed along a style
// flow field, kept at the right height above the skull by a head-shaped shell, curled, clumped and
// with a few flyaways. They are drawn with a Kajiya-Kay shader (two shifted specular lobes, root
// darkening) and hang from the head bone, swaying a little with the player's movement. They only
// render when the head is big enough on screen; further away the baked head texture and the
// shader's hair volume carry it (same look, no geometry).
import * as THREE from 'three';
import { FILL_GLSL, PLAYER_FILL } from './kit.js';
export { INFLATE_UNDER } from './hairGen.js';


const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const ss = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ---------------------------------------------------------------- strand texture
// Left half: a card of fine strands (alpha + per-strand brightness). Right half: a lock / dread
// (a rope with twisted segments).
function strandTexture() {
  const W = 256, H = 256, c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.clearRect(0, 0, W, H);
  const r = rng(7);
  // fine strands: v (canvas y) from root (top) to tip (bottom)
  for (let i = 0; i < 26; i++) {
    const x0 = 6 + r() * 116, wob = (r() - 0.5) * 10, w = 1.1 + r() * 2.2, b = Math.round(150 + r() * 105), end = H * (0.82 + r() * 0.18);
    const g = x.createLinearGradient(0, 0, 0, end);
    g.addColorStop(0, `rgba(${b},${b},${b},1)`); g.addColorStop(0.75, `rgba(${b},${b},${b},0.95)`); g.addColorStop(1, `rgba(${b},${b},${b},0)`);
    x.strokeStyle = g; x.lineWidth = w; x.lineCap = 'round';
    x.beginPath(); x.moveTo(x0, 0);
    x.bezierCurveTo(x0 + wob, end * 0.33, x0 - wob, end * 0.66, x0 + wob * 0.5, end);
    x.stroke();
  }
  // lock / dread: twisted rope
  for (let y = 0; y < H; y++) {
    const t = y / H, wv = 0.42 + 0.06 * Math.sin(t * 50) - 0.16 * ss(0.85, 1, t);
    for (let xx = 0; xx < 128; xx++) {
      const u = (xx + 0.5) / 128 - 0.5, d = Math.abs(u) / wv;
      if (d > 1) continue;
      const tw = 0.75 + 0.25 * Math.sin((u * 6 + t * 45) * Math.PI);
      const shade = Math.sqrt(1 - d * d) * tw;
      const b = Math.round(90 + 160 * shade);
      x.fillStyle = `rgba(${b},${b},${b},${clamp((1 - d) * 6, 0, 1)})`;
      x.fillRect(128 + xx, y, 1, 1);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 4; t.wrapS = THREE.ClampToEdgeWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

// ---------------------------------------------------------------- material
const VS = /* glsl */`
attribute vec3 aTan;
attribute vec3 aNrm;
attribute vec4 aUV;    // u across the card, t root → tip, texture half (0 strands, 1 lock), random
attribute vec3 aCol;   // sqrt of the linear colour
uniform vec3 uSway;    // head-local sway of the tips (m)
varying vec3 vTan;
varying vec3 vNrm;
varying vec3 vView;
varying vec4 vUV;
varying vec3 vCol;
#include <common>
#include <fog_pars_vertex>
void main() {
  vec3 p = position + uSway * (aUV.y * aUV.y) * (0.6 + 0.8 * aUV.w);
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  vTan = normalize((modelViewMatrix * vec4(aTan, 0.0)).xyz);
  vNrm = normalize((modelViewMatrix * vec4(aNrm, 0.0)).xyz);
  vView = -mvPosition.xyz;
  vUV = aUV; vCol = aCol * aCol;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const FS = /* glsl */`
uniform sampler2D uStrands;
varying vec3 vTan;
varying vec3 vNrm;
varying vec3 vView;
varying vec4 vUV;
varying vec3 vCol;
#include <common>
#include <lights_pars_begin>
#include <fog_pars_fragment>
${FILL_GLSL}
void main() {
  vec2 uv = vec2(vUV.x * 0.5 + vUV.z * 0.5, vUV.y);
  vec4 tx = texture2D(uStrands, uv);
  // Alpha to coverage, sharpened so thin strands stay crisp instead of going soft.
  float a = (tx.a - 0.45) / max(fwidth(tx.a), 1e-4) + 0.5;
  if (a <= 0.02) discard;
  vec3 T = normalize(vTan), N = normalize(vNrm), V = normalize(vView);
  if (dot(N, V) < 0.0) N = -N;
  float t = vUV.y;
  vec3 base = vCol * tx.r * mix(0.42, 1.0, smoothstep(0.0, 0.6, t));   // roots sit in shadow
  float sh1 = -0.08 + 0.1 * (vUV.w - 0.5), sh2 = 0.12 + 0.1 * (vUV.w - 0.5);
  vec3 T1 = normalize(T + N * sh1), T2 = normalize(T + N * sh2);
  vec3 tint = base / max(max(base.r, base.g), max(base.b, 1e-3));
  vec3 col = vec3(0.0);
  #if NUM_DIR_LIGHTS > 0
  for (int i = 0; i < NUM_DIR_LIGHTS; i++) {
    vec3 L = directionalLights[i].direction;
    vec3 lc = directionalLights[i].color;
    float tl = dot(T, L);
    float diff = sqrt(max(0.0, 1.0 - tl * tl)) * (0.35 + 0.65 * clamp(dot(N, L) * 0.6 + 0.4, 0.0, 1.0));
    vec3 H = normalize(L + V);
    float t1 = dot(T1, H), t2 = dot(T2, H);
    float s1 = pow(sqrt(max(0.0, 1.0 - t1 * t1)), 110.0) * 0.06;
    float s2 = pow(sqrt(max(0.0, 1.0 - t2 * t2)), 28.0) * 0.07;
    float vis = clamp(dot(N, L) * 0.7 + 0.3, 0.0, 1.0);
    col += lc * (base * diff * RECIPROCAL_PI + (vec3(s1) + s2 * tint * 0.8) * vis);
  }
  #endif
  vec3 irr = ambientLightColor;
  #if NUM_HEMI_LIGHTS > 0
  for (int i = 0; i < NUM_HEMI_LIGHTS; i++) irr += getHemisphereLightIrradiance(hemisphereLights[i], N);
  #endif
  col += irr * base * RECIPROCAL_PI * 0.85 + playerFill(N) * base;
  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

let strandsTex = null;
export function createHairMaterial() {
  strandsTex ||= strandTexture();
  const m = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.lights, THREE.UniformsLib.fog, { uStrands: { value: null }, uSway: { value: new THREE.Vector3() } }]),
    vertexShader: VS, fragmentShader: FS, lights: true, fog: true, side: THREE.DoubleSide, alphaToCoverage: true,
  });
  m.uniforms.uStrands.value = strandsTex;
  Object.assign(m.uniforms, PLAYER_FILL);
  return m;
}

// Packed arrays from hairGen.buildHair → geometry.
export function hairGeometry(h) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(h.pos, 3));
  g.setAttribute('aTan', new THREE.BufferAttribute(h.tan, 3, true));
  g.setAttribute('aNrm', new THREE.BufferAttribute(h.nrm, 3, true));
  g.setAttribute('aUV', new THREE.BufferAttribute(h.uv, 4, true));
  g.setAttribute('aCol', new THREE.BufferAttribute(h.col, 3, true));
  g.setIndex(new THREE.BufferAttribute(h.idx, 1));
  g.computeBoundingSphere();
  g.userData = { style: h.style, tris: h.tris };
  return g;
}
