// Player material: one skinned body, dressed per player in the shader — shirt (sleeve length,
// name + number on the back), shorts, socks, boots, goalkeeper gloves, skin tone, and the head:
// a per-player texture baked from his photo (face, hairline, hair — see face.js) laid out on the
// head's UV atlas, shaded eyeballs, and hair volume from a per-vertex hair weight.
import * as THREE from 'three';

const VERT_DECL = /* glsl */`
uniform float uSleeve, uShortsLen, uSockTop, uWaist, uHasHair, uHairTop, uHairSide;
attribute float region;
attribute float armT;
attribute float legT;
attribute vec2 headUV;
attribute vec3 faceUVW;
attribute float hairW;
varying vec3 vFace;
varying vec3 vRest;
varying vec3 vRestN;
flat varying float vRegion;
varying float vArm;
varying float vLeg;
varying vec2 vHeadUV;
varying float vHairW;
// Kit cloth sits a little off the skin: shirt ~1 cm, shorts ~2.5 cm (loose), socks ~0.4 cm.
float clothInflate(float region, vec3 p, float arm, float leg) {
  float r = floor(region + 0.5);
  if (r > 0.5 && r < 1.5) {
    float neck = smoothstep(0.065, 0.085, length(vec2(p.x, p.z - 0.0)));
    float shorts = 1.0 - smoothstep(uWaist - 0.01, uWaist + 0.01, p.y);
    // A shirt hangs from the chest: fill the crease under the pecs and the waist so the cloth
    // reads as fabric, not skin.
    float front = smoothstep(0.1, 0.6, normal.z);
    float crease = exp(-pow((p.y - 1.235) / 0.06, 2.0)) * 0.02 + smoothstep(1.24, 1.05, p.y) * smoothstep(0.95, 1.05, p.y) * 0.012;
    float sides = exp(-pow((p.y - 1.12) / 0.12, 2.0)) * 0.014;
    return mix(0.011 * (p.y > 1.40 ? neck : 1.0) + crease * front + sides, 0.024, shorts);
  }
  if (r > 1.5 && r < 2.5) return arm < uSleeve ? 0.012 : 0.0;
  if (r > 2.5 && r < 3.5) return leg < uShortsLen ? 0.026 * (1.0 - smoothstep(uShortsLen - 0.12, uShortsLen, leg) * 0.35) : (leg > uSockTop ? 0.004 : 0.0);
  if (r > 4.5) return 0.0;
  if (r > 3.5) return p.y < 0.11 ? 0.006 : 0.004;
  // Hair has volume: the scalp is pushed out where the hair is (thicker on top).
  if (r < 0.5) return hairW * uHasHair * mix(uHairSide, uHairTop, smoothstep(0.1, 0.85, normal.y));
  return 0.0;
}
`;
const FRAG_DECL = /* glsl */`
varying vec3 vRest;
varying vec3 vRestN;
flat varying float vRegion;
varying float vArm;
varying float vLeg;
varying vec2 vHeadUV;
varying float vHairW;
varying vec3 vFace;
uniform vec3 uShirt, uShirt2, uShorts, uSocks, uBoots, uSkin, uHair, uNumCol, uGlove, uTrim, uIris, uSclera;
uniform float uSleeve, uShortsLen, uSockTop, uWaist, uNeckY, uHasHair, uHasGlove, uHasFace, uPattern, uHasNum;
uniform vec4 uEyeL, uEyeR; // eyeball centre (rest metres) + radius
uniform sampler2D uNum;
uniform sampler2D uFace;   // baked head atlas (rgb albedo, a = 0.5 + hair / 2)
uniform sampler2D uFaceHi; // baked front view of the face (same content, higher resolution)

float edgeAA(float x, float e) { float w = fwidth(x) * 1.25 + 1e-4; return smoothstep(e - w, e + w, x); }

vec3 headColor(inout float rough) {
  // Mouth interior (behind the lips).
  if (vHeadUV.x < -1.5) { rough = 0.6; return uSkin * vec3(0.32, 0.16, 0.15); }
  if (uHasFace > 0.5 && vHeadUV.x > -0.5) {
    vec4 t = texture2D(uFace, vHeadUV);
    if (vFace.z > 0.001) t = mix(t, texture2D(uFaceHi, vFace.xy), vFace.z);
    float hair = clamp(t.a * 2.0 - 1.0, 0.0, 1.0);
    rough = mix(0.52, 0.78, hair);
    return t.rgb;
  }
  float hair = vHairW * uHasHair;
  rough = mix(0.52, 0.78, hair);
  return mix(uSkin, uHair, hair);
}

// Eyeball: wet sclera, iris with radial fibres and a dark limbal ring, pupil (looking along +z).
vec3 eyeColor(inout float rough) {
  vec4 e = vRest.x > 0.0 ? uEyeL : uEyeR;
  vec3 d = normalize(vRest - e.xyz);
  float a = acos(clamp(d.z, -1.0, 1.0));
  float ang = atan(d.y, d.x);
  float fib = 0.85 + 0.15 * sin(ang * 23.0 + sin(ang * 7.0) * 2.0);
  float rI = 0.56, rP = 0.2;
  float iris = 1.0 - edgeAA(a, rI);
  float pupil = 1.0 - edgeAA(a, rP);
  vec3 irisC = uIris * fib * mix(1.0, 0.45, smoothstep(rI - 0.14, rI, a)) * mix(0.8, 1.15, smoothstep(rP, rP + 0.12, a));
  vec3 scl = uSclera * mix(1.0, 0.82, smoothstep(0.9, 1.6, a));
  vec3 c = mix(scl, irisC, iris);
  c = mix(c, vec3(0.012), pupil);
  rough = 0.12;
  return c;
}

// Shirt body colour incl. stripes / halves on the torso; sleeves stay the main colour.
vec3 shirtColor() {
  float torso = 1.0 - edgeAA(abs(vRest.x), 0.175);
  vec3 sc = uShirt;
  if (uPattern > 0.5 && uPattern < 1.5) sc = mix(uShirt, mix(uShirt, uShirt2, edgeAA(abs(fract(vRest.x / 0.11 + 0.25) - 0.5) * 2.0, 0.5)), torso);
  if (uPattern > 1.5) sc = mix(uShirt, mix(uShirt, uShirt2, edgeAA(vRest.x, 0.0)), torso);
  return sc;
}

vec3 kitColor(out float rough) {
  float r = floor(vRegion + 0.5);
  vec3 c = uSkin; rough = 0.5;
  if (r < 0.5) {
    c = headColor(rough);
  } else if (r > 4.5) {
    c = eyeColor(rough);
  } else if (r < 1.5) {
    float nd = length(vec2(vRest.x, vRest.z - 0.0)) - mix(0.072, 0.085, step(0.0, vRest.z));
    float shirt = 1.0 - (1.0 - edgeAA(nd, 0.0)) * edgeAA(vRest.y, uNeckY - 0.05);
    float shorts = 1.0 - edgeAA(vRest.y, uWaist);
    vec3 sc = shirtColor();
    c = mix(uSkin, sc, shirt);
    // Collar trim
    float collar = shirt * (1.0 - edgeAA(nd, 0.016)) * edgeAA(vRest.y, uNeckY - 0.05);
    c = mix(c, uTrim, collar * 0.9);
    rough = mix(0.5, 0.82, shirt);
    if (uHasNum > 0.5) {
      // Name and number on the back (read from behind: u runs towards -x).
      if (vRestN.z < -0.1) {
        vec2 nuv = vec2(0.5 - vRest.x / 0.38, (vRest.y - 1.05) / 0.40);
        if (nuv.x > 0.0 && nuv.x < 1.0 && nuv.y > 0.0 && nuv.y < 1.0) {
          float a = texture2D(uNum, nuv).a;
          c = mix(c, uNumCol, a * shirt);
        }
      } else if (vRestN.z > 0.2) {
        // Small number on the chest (wearer's right).
        vec2 nuv = vec2((vRest.x + 0.115) / 0.075, (vRest.y - 1.30) / 0.075);
        if (nuv.x > 0.0 && nuv.x < 1.0 && nuv.y > 0.0 && nuv.y < 1.0) {
          float a = texture2D(uNum, vec2(0.22 + nuv.x * 0.56, 0.09 + nuv.y * 0.6)).a;
          c = mix(c, uNumCol, a * shirt);
        }
      }
    }
    c = mix(c, uShorts, shorts);
    rough = mix(rough, 0.7, shorts);
  } else if (r < 2.5) {
    float sleeve = 1.0 - edgeAA(vArm, uSleeve);
    float cuff = sleeve * (1.0 - edgeAA(uSleeve - vArm, 0.025));
    c = mix(uSkin, shirtColor(), sleeve);
    c = mix(c, uTrim, cuff * 0.8 * step(uSleeve, 0.9));
    rough = mix(0.5, 0.82, sleeve);
    if (uHasGlove > 0.5) { float g = edgeAA(vArm, 0.97); c = mix(c, uGlove, g); rough = mix(rough, 0.6, g); }
  } else if (r < 3.5) {
    float sh = 1.0 - edgeAA(vLeg, uShortsLen);
    float sock = edgeAA(vLeg, uSockTop);
    c = mix(mix(uSkin, uShorts, sh), uSocks, sock);
    float band = sock * (1.0 - edgeAA(vLeg, uSockTop + 0.03));
    c = mix(c, uTrim, band * 0.7);
    rough = mix(0.5, 0.75, max(sh, sock));
  } else {
    float boot = 1.0 - edgeAA(vRest.y, 0.11);
    c = mix(uSocks, uBoots, boot);
    rough = mix(0.75, 0.35, boot);
  }
  return c;
}
`;

const col = h => new THREE.Color(h);

export function createKitMaterial(body) {
  const u = {
    uShirt: { value: col('#c81e2c') }, uShirt2: { value: col('#ffffff') }, uShorts: { value: col('#ffffff') }, uSocks: { value: col('#c81e2c') },
    uBoots: { value: col('#111111') }, uSkin: { value: col('#c8956b') }, uHair: { value: col('#2b1d14') }, uNumCol: { value: col('#ffffff') },
    uGlove: { value: col('#f1f5f9') }, uTrim: { value: col('#ffffff') },
    uSleeve: { value: 0.27 }, uShortsLen: { value: 0.33 }, uSockTop: { value: 0.56 },
    uWaist: { value: 0.97 }, uNeckY: { value: 1.455 },
    uHasHair: { value: 1 }, uHairTop: { value: 0.012 }, uHairSide: { value: 0.006 }, uHasGlove: { value: 0 }, uHasFace: { value: 0 }, uPattern: { value: 0 }, uHasNum: { value: 0 },
    uIris: { value: col('#3a2416') }, uSclera: { value: col('#d9d2cb') },
    uEyeL: { value: eyeVec(body, 0) }, uEyeR: { value: eyeVec(body, 1) },
    uFaceXf: { value: new THREE.Vector4(1, 0, 1, 0) }, // unused (old planar photo mapping), kept for the labs
    uNum: { value: blankTex },
    uFace: { value: blankTex }, uFaceHi: { value: blankTex },
  };
  const m = new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0 });
  m.userData.uniforms = u;
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = VERT_DECL + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      vRest = position; vRestN = normal; vRegion = region; vArm = armT; vLeg = legT; vHeadUV = headUV; vHairW = hairW; vFace = faceUVW;
      transformed += normal * clothInflate(region, position, armT, legT);`);
    sh.fragmentShader = FRAG_DECL + sh.fragmentShader
      .replace('#include <color_fragment>', `#include <color_fragment>
        float kitRough; diffuseColor.rgb = kitColor(kitRough);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = kitRough;`);
  };
  m.customProgramCacheKey = () => 'kit-v9';
  return m;
}

function eyeVec(body, k) {
  const e = body.eyes?.[k] || { c: [k ? -0.03 : 0.03, 1.62, 0.12], r: 0.0158 };
  return new THREE.Vector4(e.c[0], e.c[1], e.c[2], e.r);
}

const blankTex = (() => { const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1); t.needsUpdate = true; return t; })();

// Name + number for the back of the shirt (alpha mask).
export function numberTexture(num, name) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 256;
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.textAlign = 'center'; x.textBaseline = 'middle';
  const nm = String(name || '').toUpperCase();
  if (nm) {
    let s = 34; x.font = `800 ${s}px "Arial Narrow", "Roboto Condensed", Arial, sans-serif`;
    while (x.measureText(nm).width > 220 && s > 14) { s -= 1; x.font = `800 ${s}px "Arial Narrow", "Roboto Condensed", Arial, sans-serif`; }
    x.fillText(nm, 128, 40);
  }
  if (num != null) {
    x.font = `900 150px "Arial Narrow", "Roboto Condensed", Arial, sans-serif`;
    x.fillText(String(num), 128, 158);
  }
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 4;
  return t;
}
