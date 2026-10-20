// Broadcast-style 3D drawing on a 2D canvas: perspective cameras, stadium, pitch, goals with
// nets, animated player figures (kits, shirt numbers, skin/hair from their photos) and the
// telestrator primitives used for freeze-frame analysis images.
import { L, WD, GOAL_W, GOAL_H, POST_A, POST_B, S } from './core.js';

export const W = 1280, H = 720;
export const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

// ------------------------------------------------------------------ cameras
function norm3(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
export function camera(pos, look, fovDeg) {
  const fwd = norm3([look[0] - pos[0], look[1] - pos[1], look[2] - pos[2]]);
  const right = norm3(cross([0, 0, 1], fwd));
  const up = cross(fwd, right);
  const f = (H / 2) / Math.tan((fovDeg * Math.PI) / 360);
  return { pos, look, fov: fovDeg, fwd, right, up, f };
}
// Main TV camera: high in the stand on the near touchline, panning with play.
export function broadcastCam(x, zoom = 1, ly = 29) { return camera([x, WD + 48, 29], [x, ly, 0], 17.5 / zoom); }
// Replay: low behind the goal the attack is heading to.
export function behindGoalCam(goalX, y = 34) {
  const s = goalX > L / 2 ? 1 : -1;
  return camera([goalX + s * 8.5, 34 + (y - 34) * 0.35, 5.6], [goalX - s * 24, 34 + (y - 34) * 0.25, 0.8], 56);
}
// Replay: reverse angle from the far side, closer (camera platform in front of the far stand).
export function reverseCam(x, y) { return camera([x + 5, -8, 8.5], [x, Math.min(y + 3, 60), 0.6], 42); }
// Close-up cam on a point (celebrations, cards).
export function closeCam(x, y, side = 1) { return camera([x + side * 9, y + 13, 4.2], [x, y, 1.1], 38); }

const P = [0, 0, 0];
export function project(cam, x, y, z, out = P) {
  const dx = x - cam.pos[0], dy = y - cam.pos[1], dz = z - cam.pos[2];
  const zc = dx * cam.fwd[0] + dy * cam.fwd[1] + dz * cam.fwd[2];
  const xc = dx * cam.right[0] + dy * cam.right[1] + dz * cam.right[2];
  const yc = dx * cam.up[0] + dy * cam.up[1] + dz * cam.up[2];
  const iz = 1 / Math.max(zc, 0.1);
  out[0] = W / 2 + cam.f * xc * iz; out[1] = H / 2 - cam.f * yc * iz; out[2] = zc;
  return out;
}
// Pixels per metre at a ground point.
export function scaleAt(cam, x, y) {
  const a = project(cam, x, y, 0, [0, 0, 0]), b = project(cam, x, y, 1, [0, 0, 0]);
  return Math.abs(a[1] - b[1]);
}

// ------------------------------------------------------------------ textures (built once)
function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
let crowdTex = null, boardTex = null, skyGrad = null;
function rand(seed) { let a = seed; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export function buildTextures(colors = ['#e3262f', '#2563eb'], boardText = ['SÜPER LIG MIX', 'DRAFT DUEL']) {
  const r = rand(7);
  crowdTex = canvas(1024, 256);
  const c = crowdTex.getContext('2d');
  const g = c.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, '#0b0f14'); g.addColorStop(1, '#1b2129');
  c.fillStyle = g; c.fillRect(0, 0, 1024, 256);
  const palette = [...colors, ...colors, '#e5e7eb', '#9ca3af', '#f59e0b', '#1f2937', '#374151', '#64748b'];
  for (let row = 0; row < 32; row++) {
    const y = 6 + row * 7.8;
    c.fillStyle = 'rgba(0,0,0,0.35)'; c.fillRect(0, y + 5.6, 1024, 1.4);
    for (let x = 0; x < 1024; x += 3.2) {
      if (r() < 0.12) continue;
      c.fillStyle = palette[Math.floor(r() * palette.length)];
      c.globalAlpha = 0.55 + r() * 0.45;
      c.fillRect(x + r() * 0.8, y + r() * 1.5, 2.2, 3.6);
      c.fillStyle = '#d6b8a0'; c.globalAlpha = 0.6;
      c.fillRect(x + 0.4, y - 1.2, 1.4, 1.4);
    }
  }
  c.globalAlpha = 1;
  // Aisles
  for (let x = 120; x < 1024; x += 170) { c.fillStyle = 'rgba(30,36,44,0.9)'; c.fillRect(x, 0, 6, 256); }
  boardTex = canvas(2048, 48);
  const b = boardTex.getContext('2d');
  b.fillStyle = '#05070a'; b.fillRect(0, 0, 2048, 48);
  const texts = [...boardText, 'GPT-6.1 SOL', 'TRANSFERMARKT DATA', ...boardText];
  let x = 10, i = 0;
  while (x < 2048) {
    const t = texts[i % texts.length];
    const col = i % 3 === 0 ? colors[0] : i % 3 === 1 ? colors[1] : '#f8fafc';
    b.fillStyle = col; b.font = `900 30px ${FONT}`; b.textBaseline = 'middle';
    b.fillText(t, x, 25); x += b.measureText(t).width + 60; i++;
  }
}

// Draw an image mapped onto a world-space quad (p0 = top-left, p1 = top-right, p2 = bottom-left),
// split into vertical strips so perspective looks right.
const qa = [0, 0, 0], qb = [0, 0, 0], qc = [0, 0, 0];
function texQuad(ctx, cam, img, p0, p1, p2, strips, srcW, srcH) {
  // Planes parallel to the camera's right axis project almost affinely: fewer strips needed.
  const ex = p1[0] - p0[0], ey = p1[1] - p0[1], el = Math.hypot(ex, ey) || 1;
  if (Math.abs((ex / el) * cam.right[0] + (ey / el) * cam.right[1]) > 0.985) strips = Math.min(strips, 6);
  for (let i = 0; i < strips; i++) {
    const t0 = i / strips, t1 = (i + 1) / strips;
    const a = [p0[0] + (p1[0] - p0[0]) * t0, p0[1] + (p1[1] - p0[1]) * t0, p0[2] + (p1[2] - p0[2]) * t0];
    const b = [p0[0] + (p1[0] - p0[0]) * t1, p0[1] + (p1[1] - p0[1]) * t1, p0[2] + (p1[2] - p0[2]) * t1];
    const c = [a[0] + (p2[0] - p0[0]), a[1] + (p2[1] - p0[1]), a[2] + (p2[2] - p0[2])];
    project(cam, a[0], a[1], a[2], qa); project(cam, b[0], b[1], b[2], qb); project(cam, c[0], c[1], c[2], qc);
    if (qa[2] < 1 || qb[2] < 1 || qc[2] < 1) continue;
    if (Math.max(qa[0], qb[0], qc[0]) < -50 || Math.min(qa[0], qb[0], qc[0]) > W + 50) continue;
    if (Math.max(qa[1], qb[1], qc[1]) < -10 || Math.min(qa[1], qb[1], qc[1]) > H + 10) continue;
    // Back-face: the textured side faces away from this camera.
    if ((qb[0] - qa[0]) * (qc[1] - qa[1]) - (qb[1] - qa[1]) * (qc[0] - qa[0]) < 0) continue;
    const sw = srcW / strips;
    ctx.save();
    ctx.transform((qb[0] - qa[0]) / sw, (qb[1] - qa[1]) / sw, (qc[0] - qa[0]) / srcH, (qc[1] - qa[1]) / srcH, qa[0], qa[1]);
    ctx.drawImage(img, (i * sw) % img.width, 0, Math.min(sw, img.width), srcH, 0, 0, sw + 0.6, srcH);
    ctx.restore();
  }
}

function poly(ctx, cam, pts) {
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) { project(cam, pts[i][0], pts[i][1], pts[i][2] || 0, qa); i ? ctx.lineTo(qa[0], qa[1]) : ctx.moveTo(qa[0], qa[1]); }
  ctx.closePath();
}

// ------------------------------------------------------------------ pitch geometry (world polylines)
const LINES = (() => {
  const out = [];
  const seg = (pts) => out.push(pts);
  seg([[0, 0], [L, 0], [L, WD], [0, WD], [0, 0]]);
  seg([[L / 2, 0], [L / 2, WD]]);
  const circle = (cx, cy, r, a0 = 0, a1 = Math.PI * 2, n = 40) => { const p = []; for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * (i / n); p.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); } return p; };
  seg(circle(L / 2, WD / 2, 9.15));
  for (const [gx, s] of [[0, 1], [L, -1]]) {
    seg([[gx, WD / 2 - 20.16], [gx + s * 16.5, WD / 2 - 20.16], [gx + s * 16.5, WD / 2 + 20.16], [gx, WD / 2 + 20.16]]);
    seg([[gx, WD / 2 - 9.16], [gx + s * 5.5, WD / 2 - 9.16], [gx + s * 5.5, WD / 2 + 9.16], [gx, WD / 2 + 9.16]]);
    const a = Math.acos(5.5 / 9.15);
    seg(s > 0 ? circle(gx + 11, WD / 2, 9.15, -a, a, 20) : circle(gx - 11, WD / 2, 9.15, Math.PI - a, Math.PI + a, 20));
    seg(circle(gx, 0, 1, s > 0 ? 0 : Math.PI / 2, s > 0 ? Math.PI / 2 : Math.PI, 8));
    seg(circle(gx, WD, 1, s > 0 ? -Math.PI / 2 : Math.PI, s > 0 ? 0 : Math.PI * 1.5, 8));
  }
  return out;
})();
const SPOTS = [[L / 2, WD / 2], [11, WD / 2], [L - 11, WD / 2]];

export function drawStadium(ctx, cam, t = 0) {
  // Night sky + floodlights
  if (!skyGrad) {
    skyGrad = ctx.createLinearGradient(0, 0, 0, H);
    skyGrad.addColorStop(0, '#05070c'); skyGrad.addColorStop(0.5, '#0b1220'); skyGrad.addColorStop(1, '#0b1220');
  }
  ctx.fillStyle = skyGrad; ctx.fillRect(0, 0, W, H);
  // Far stand (behind the far touchline), two tiers.
  texQuad(ctx, cam, crowdTex, [-30, -40, 30], [L + 30, -40, 30], [-30, -6, 2], 22, 1024, 256);
  // Ends (behind the goals)
  texQuad(ctx, cam, crowdTex, [-38, WD + 30, 24], [-38, -40, 24], [-8, WD + 30, 1.5], 14, 1024, 256);
  texQuad(ctx, cam, crowdTex, [L + 38, -40, 24], [L + 38, WD + 30, 24], [L + 8, -40, 1.5], 14, 1024, 256);
  // Roof edge
  ctx.fillStyle = '#020306';
  poly(ctx, cam, [[-40, -44, 34], [L + 40, -44, 34], [L + 40, -40, 30], [-40, -40, 30]]); ctx.fill();
}

const grassA = '#2f8a47', grassB = '#2a7d40';
export function drawPitch(ctx, cam) {
  // Surround
  ctx.fillStyle = '#25713a';
  poly(ctx, cam, [[-9, -6], [L + 9, -6], [L + 9, WD + 30], [-9, WD + 30]]); ctx.fill();
  // Mowing stripes
  const n = 18, w = L / n;
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = i % 2 ? grassA : grassB;
    poly(ctx, cam, [[i * w, -2], [(i + 1) * w, -2], [(i + 1) * w, WD + 2], [i * w, WD + 2]]); ctx.fill();
  }
  // Ad boards along the far touchline and behind the goals
  texQuad(ctx, cam, boardTex, [-6, -4, 1], [L + 6, -4, 1], [-6, -4, 0], 18, 2048, 48);
  texQuad(ctx, cam, boardTex, [-5, WD + 6, 1], [-5, -3, 1], [-5, WD + 6, 0], 8, 1024, 48);
  texQuad(ctx, cam, boardTex, [L + 5, -3, 1], [L + 5, WD + 6, 1], [L + 5, -3, 0], 8, 1024, 48);
  // Lines
  const k = scaleAt(cam, L / 2, WD / 2);
  ctx.strokeStyle = 'rgba(240,248,242,0.88)';
  ctx.lineWidth = Math.max(1.2, k * 0.12);
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (const pts of LINES) {
    for (let i = 0; i < pts.length; i++) { project(cam, pts[i][0], pts[i][1], 0, qa); i ? ctx.lineTo(qa[0], qa[1]) : ctx.moveTo(qa[0], qa[1]); }
  }
  ctx.stroke();
  ctx.fillStyle = 'rgba(240,248,242,0.9)';
  for (const [x, y] of SPOTS) { project(cam, x, y, 0, qa); const r = Math.max(1.4, scaleAt(cam, x, y) * 0.2); ctx.beginPath(); ctx.ellipse(qa[0], qa[1], r, r * 0.45, 0, 0, Math.PI * 2); ctx.fill(); }
}

// Goal frame + net. ripple = { at:{y,z}, t } for a goal bulge.
export function drawGoal(ctx, cam, goalX, ripple) {
  const s = goalX > L / 2 ? 1 : -1, d = 2.0;
  project(cam, goalX, WD / 2, 1.2, qa);
  if (qa[2] < 1 || qa[0] < -220 || qa[0] > W + 220) return;
  const k = scaleAt(cam, goalX, WD / 2);
  const bulge = (y, z) => {
    if (!ripple) return 0;
    const dd = Math.hypot(y - ripple.at.y, z - ripple.at.z);
    return Math.exp(-dd * dd / 3) * Math.max(0, Math.sin(ripple.t * 14) * Math.exp(-ripple.t * 3.2)) * 0.9 + Math.exp(-dd * dd / 2) * Math.exp(-ripple.t * 1.2) * 0.6;
  };
  ctx.strokeStyle = 'rgba(255,255,255,0.32)';
  ctx.lineWidth = Math.max(0.6, k * 0.025);
  ctx.beginPath();
  const bx = (y, z) => goalX + s * (d - (z / GOAL_H) * 0.6 + bulge(y, z));
  for (let y = POST_A; y <= POST_B + 0.01; y += 0.45) {
    project(cam, goalX, y, GOAL_H, qa); ctx.moveTo(qa[0], qa[1]);
    for (let z = GOAL_H; z >= -0.01; z -= 0.4) { project(cam, bx(y, z), y, Math.max(0, z), qa); ctx.lineTo(qa[0], qa[1]); }
  }
  for (let z = 0; z <= GOAL_H + 0.01; z += 0.4) {
    project(cam, bx(POST_A, z), POST_A, z, qa); ctx.moveTo(qa[0], qa[1]);
    for (let y = POST_A; y <= POST_B + 0.01; y += 0.45) { project(cam, bx(y, z), y, z, qa); ctx.lineTo(qa[0], qa[1]); }
  }
  for (const y of [POST_A, POST_B]) for (let z = 0; z <= GOAL_H; z += 0.4) {
    project(cam, goalX, y, z, qa); ctx.moveTo(qa[0], qa[1]); project(cam, bx(y, z), y, z, qa); ctx.lineTo(qa[0], qa[1]);
  }
  ctx.stroke();
  // Frame
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = Math.max(1.6, k * 0.12);
  ctx.lineCap = 'round';
  ctx.beginPath();
  project(cam, goalX, POST_A, 0, qa); ctx.moveTo(qa[0], qa[1]);
  project(cam, goalX, POST_A, GOAL_H, qa); ctx.lineTo(qa[0], qa[1]);
  project(cam, goalX, POST_B, GOAL_H, qa); ctx.lineTo(qa[0], qa[1]);
  project(cam, goalX, POST_B, 0, qa); ctx.lineTo(qa[0], qa[1]);
  ctx.stroke();
}

// ------------------------------------------------------------------ players
// o: { shirt, shorts, socks, skin, hair, num, state, stT, run, speed, fx (screen facing -1..1), label, glow }
export function drawFigure(ctx, x, y, k, o, t) {
  const s = o.state, tt = o.stT || 0;
  ctx.save();
  ctx.translate(x, y);
  // Shadow
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath(); ctx.ellipse(0, 0, 0.42 * k, 0.12 * k, 0, 0, Math.PI * 2); ctx.fill();
  let lift = 0, rot = 0;
  const fx = o.fx >= 0 ? 1 : -1;
  if (s === S.HEAD) lift = Math.max(0, Math.sin(Math.min(tt / 0.6, 1) * Math.PI)) * 0.55 * k;
  if (s === S.CELEB) lift = Math.max(0, Math.sin(tt * 6)) * 0.18 * k;
  if (s === S.DIVE_L || s === S.DIVE_R) {
    const dirS = o.diveScreen || (s === S.DIVE_L ? -1 : 1);
    const p = Math.min(tt / 0.32, 1);
    rot = dirS * p * 1.35;
    lift = Math.sin(Math.min(tt / 0.7, 1) * Math.PI) * 0.55 * k;
    ctx.translate(dirS * p * 0.7 * k, 0);
  }
  if (s === S.FALL || s === S.SLIDE) {
    const p = Math.min(tt / 0.3, 1);
    rot = fx * p * (s === S.SLIDE ? 1.15 : 1.5);
  }
  ctx.translate(0, -lift);
  if (rot) { ctx.translate(0, -0.25 * k); ctx.rotate(rot); ctx.translate(0, 0.25 * k); }

  const lw = Math.max(1.6, 0.14 * k);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const phase = (o.run || 0) * (Math.PI * 2 / 1.9);
  const amp = Math.min(1, (o.speed || 0) / 6.5) * 0.36;
  const hipY = -0.92 * k;
  // Legs
  for (let i = 0; i < 2; i++) {
    let sw = Math.sin(phase + i * Math.PI) * amp;
    let footLift = Math.max(0, Math.cos(phase + i * Math.PI)) * amp * 0.5;
    if (s === S.KICK && i === 0) { const p = Math.min(tt / 0.15, 1); sw = 0.55 * p; footLift = 0.35 * p; }
    if (s === S.WALL || s === S.HOLD || s === S.CARD_Y || s === S.CARD_R || s === S.FLAG || s === S.WHISTLE) { sw = (i ? 0.06 : -0.06); footLift = 0; }
    const footX = sw * k * fx, footY = -footLift * k;
    const kneeX = footX * 0.45 + fx * Math.abs(sw) * 0.12 * k, kneeY = hipY * 0.48 + footY * 0.4;
    const hx = (i ? 0.07 : -0.07) * k;
    ctx.strokeStyle = o.skin; ctx.lineWidth = lw;
    ctx.beginPath(); ctx.moveTo(hx, hipY); ctx.lineTo(kneeX + hx * 0.5, kneeY); ctx.stroke();
    ctx.strokeStyle = o.socks;
    ctx.beginPath(); ctx.moveTo(kneeX + hx * 0.5, kneeY); ctx.lineTo(footX + hx * 0.3, footY - 0.06 * k); ctx.stroke();
    ctx.strokeStyle = '#111'; ctx.lineWidth = lw * 0.9;
    ctx.beginPath(); ctx.moveTo(footX + hx * 0.3, footY - 0.04 * k); ctx.lineTo(footX + hx * 0.3 + fx * 0.1 * k, footY - 0.02 * k); ctx.stroke();
  }
  // Shorts
  ctx.fillStyle = o.shorts;
  ctx.fillRect(-0.19 * k, -1.02 * k, 0.38 * k, 0.26 * k);
  // Torso
  ctx.fillStyle = o.shirt;
  const tw = 0.42 * k, th = 0.56 * k, ty = -1.52 * k;
  ctx.beginPath();
  ctx.moveTo(-tw / 2, ty + 0.06 * k); ctx.quadraticCurveTo(-tw / 2, ty, -tw / 2 + 0.08 * k, ty);
  ctx.lineTo(tw / 2 - 0.08 * k, ty); ctx.quadraticCurveTo(tw / 2, ty, tw / 2, ty + 0.06 * k);
  ctx.lineTo(tw / 2 * 0.9, ty + th); ctx.lineTo(-tw / 2 * 0.9, ty + th); ctx.closePath(); ctx.fill();
  if (o.trim) { ctx.fillStyle = o.trim; ctx.fillRect(-tw / 2 * 0.9, ty + th - 0.05 * k, tw * 0.9, 0.05 * k); }
  if (o.num != null && k > 18) {
    ctx.fillStyle = o.numColor || '#fff';
    ctx.font = `800 ${Math.round(0.24 * k)}px ${FONT}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(o.num), 0, ty + th * 0.45);
  }
  // Arms
  const shY = -1.44 * k;
  const armL = 0.62 * k;
  const armSwing = Math.sin(phase) * amp * 1.2;
  const arm = (side, ang, len = armL) => {
    const sx = side * 0.22 * k;
    const ex = sx + Math.sin(ang) * len * 0.5, ey = shY + Math.cos(ang) * len * 0.5;
    const hx = sx + Math.sin(ang) * len, hy = shY + Math.cos(ang) * len;
    ctx.strokeStyle = o.shirt; ctx.lineWidth = lw * 0.95;
    ctx.beginPath(); ctx.moveTo(sx, shY); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.strokeStyle = o.skin; ctx.lineWidth = lw * 0.8;
    ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(hx, hy); ctx.stroke();
    return [hx, hy];
  };
  if (s === S.CELEB) { arm(-1, Math.PI * 0.82 + Math.sin(tt * 8) * 0.1); arm(1, -Math.PI * 0.82 - Math.sin(tt * 8) * 0.1); }
  else if (s === S.CARD_Y || s === S.CARD_R) {
    arm(-1, 0.15);
    const [hx, hy] = arm(1, -Math.PI * 0.97);
    ctx.fillStyle = s === S.CARD_R ? '#ef1c1c' : '#ffd400';
    ctx.fillRect(hx - 0.07 * k, hy - 0.26 * k, 0.16 * k, 0.22 * k);
  } else if (s === S.FLAG) {
    arm(-1, 0.1);
    const [hx, hy] = arm(1, -Math.PI * 0.95);
    ctx.strokeStyle = '#333'; ctx.lineWidth = Math.max(1, 0.03 * k);
    ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(hx, hy - 0.5 * k); ctx.stroke();
    const wave = Math.sin(t * 9) * 0.04 * k;
    ctx.fillStyle = '#ff2d2d'; ctx.fillRect(hx, hy - 0.5 * k + wave, 0.3 * k, 0.2 * k);
    ctx.fillStyle = '#ffd400'; ctx.fillRect(hx + 0.15 * k, hy - 0.5 * k + wave, 0.15 * k, 0.1 * k); ctx.fillRect(hx, hy - 0.4 * k + wave, 0.15 * k, 0.1 * k);
  } else if (s === S.POINT) { arm(-1, 0.1); arm(1, -Math.PI * 0.55 * fx); }
  else if (s === S.WHISTLE) { arm(-1, 0.15); arm(1, -Math.PI * 0.7, armL * 0.8); }
  else if (s === S.HOLD) {
    arm(-1, -Math.PI * 0.42 * -1, armL * 0.75); arm(1, -Math.PI * 0.42, armL * 0.75);
  } else if (s === S.WALL) { arm(-1, 0.55, armL * 0.85); arm(1, -0.55, armL * 0.85); }
  else if (s === S.APPEAL) { arm(-1, Math.PI * 0.55 + Math.sin(tt * 5) * 0.2); arm(1, -Math.PI * 0.55 - Math.sin(tt * 5) * 0.2); }
  else if (s === S.DEJECT) { arm(-1, 0.05, armL * 0.95); arm(1, -0.05, armL * 0.95); }
  else if (s === S.DIVE_L || s === S.DIVE_R) { arm(-1, Math.PI * 0.85); arm(1, -Math.PI * 0.85); }
  else if (s === S.HEAD) { arm(-1, Math.PI * 0.35); arm(1, -Math.PI * 0.35); }
  else { arm(-1, armSwing * fx + 0.12); arm(1, -armSwing * fx - 0.12); }
  // Head
  const hr = 0.125 * k, hy = (s === S.DEJECT ? -1.6 : -1.66) * k;
  ctx.fillStyle = o.skin;
  ctx.beginPath(); ctx.arc(0, hy, hr, 0, Math.PI * 2); ctx.fill();
  if (o.hair) {
    ctx.fillStyle = o.hair;
    ctx.beginPath(); ctx.arc(0, hy - hr * 0.08, hr * 1.04, Math.PI * 1.02, Math.PI * 1.98); ctx.closePath(); ctx.fill();
  }
  if (o.gloves && (s === S.DIVE_L || s === S.DIVE_R || s === S.HOLD)) { /* gloves implied by kit colour */ }
  ctx.restore();
}

// Floating name tag above a player.
export function drawTag(ctx, x, y, k, text, color, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `700 12px ${FONT}`;
  const w = ctx.measureText(text).width + 12;
  const ty = y - 2.05 * k - 16;
  ctx.fillStyle = 'rgba(8,12,10,0.82)';
  roundRect(ctx, x - w / 2, ty, w, 18, 9); ctx.fill();
  ctx.fillStyle = color; ctx.fillRect(x - w / 2 + 5, ty + 15, w - 10, 2);
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, x, ty + 8.5);
  ctx.restore();
}

export function drawBall(ctx, cam, x, y, z, spin) {
  project(cam, x, y, 0, qa);
  const k = scaleAt(cam, x, y);
  const r = Math.max(2.4, 0.14 * k);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath(); ctx.ellipse(qa[0], qa[1], r * (1 + z * 0.08), r * 0.4, 0, 0, Math.PI * 2); ctx.fill();
  project(cam, x, y, z + 0.11, qb);
  ctx.fillStyle = '#f8fafc';
  ctx.beginPath(); ctx.arc(qb[0], qb[1], r, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(40,40,40,0.55)'; ctx.lineWidth = 1; ctx.stroke();
  if (r > 4) {
    ctx.fillStyle = '#1f2937';
    const a = spin || 0;
    ctx.beginPath(); ctx.arc(qb[0] + Math.cos(a) * r * 0.35, qb[1] + Math.sin(a) * r * 0.35, r * 0.28, 0, Math.PI * 2); ctx.fill();
  }
  return [qb[0], qb[1], r];
}

export function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y); ctx.lineTo(x + w - rr, y); ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr); ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr); ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

// ------------------------------------------------------------------ telestrator primitives
export function worldArrow(ctx, cam, from, to, color, { dashed = false, loft = 0, width = 3.5, head = true } = {}) {
  ctx.save();
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round';
  if (dashed) ctx.setLineDash([10, 8]);
  ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 6;
  ctx.beginPath();
  const n = 24; let px = 0, py = 0, lx = 0, ly = 0;
  for (let i = 0; i <= n; i++) {
    const e = i / n;
    const x = from.x + (to.x - from.x) * e, y = from.y + (to.y - from.y) * e;
    const z = (from.z || 0) + ((to.z || 0) - (from.z || 0)) * e + loft * 4 * e * (1 - e);
    project(cam, x, y, z + 0.05, qa);
    if (i === 0) ctx.moveTo(qa[0], qa[1]); else ctx.lineTo(qa[0], qa[1]);
    lx = px; ly = py; px = qa[0]; py = qa[1];
  }
  ctx.stroke();
  ctx.setLineDash([]);
  if (head) {
    const a = Math.atan2(py - ly, px - lx), hl = 14;
    ctx.beginPath(); ctx.moveTo(px, py);
    ctx.lineTo(px - Math.cos(a - 0.45) * hl, py - Math.sin(a - 0.45) * hl);
    ctx.lineTo(px - Math.cos(a + 0.45) * hl, py - Math.sin(a + 0.45) * hl);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}
export function spotlight(ctx, cam, x, y, color, pulse = 0) {
  project(cam, x, y, 0, qa);
  const k = scaleAt(cam, x, y);
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.ellipse(qa[0], qa[1], (0.95 + pulse * 0.15) * k, (0.32 + pulse * 0.05) * k, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.globalAlpha = 0.18; ctx.fillStyle = color; ctx.fill();
  ctx.restore();
}
export function worldLine(ctx, cam, x0, y0, x1, y1, color, width = 3, dash) {
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = width;
  if (dash) ctx.setLineDash(dash);
  ctx.beginPath();
  project(cam, x0, y0, 0.02, qa); ctx.moveTo(qa[0], qa[1]);
  project(cam, x1, y1, 0.02, qa); ctx.lineTo(qa[0], qa[1]);
  ctx.stroke(); ctx.restore();
}

// ------------------------------------------------------------------ 3D player rig
// Procedural skeleton in world space (metres): pelvis, hips, knees (2-bone IK), ankles + boots,
// chest, shoulders, elbows (IK), hands, head. Gait from speed and phase; actions (kick, header,
// slide, lunge, fall, dive, knee slide, …) override the pose. Every joint is projected through the
// same camera as the pitch, so movement reads correctly from any angle.
const V3 = (x, y, z) => [x, y, z];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = a => Math.hypot(a[0], a[1], a[2]);
const nrm = a => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cr = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const cl = (v, a, b) => (v < a ? a : v > b ? b : v);
const sstep = t => t * t * (3 - 2 * t);

// Two-bone IK: joint between root and end, bending towards `pole`.
function ik(root, end, l1, l2, pole) {
  let d = sub(end, root); let dl = len(d);
  const maxL = l1 + l2 - 1e-3;
  if (dl > maxL) { end = add(root, mul(d, maxL / dl)); d = sub(end, root); dl = maxL; }
  if (dl < 1e-4) return { joint: add(root, mul(pole, l1)), end };
  const dir = mul(d, 1 / dl);
  const a = (l1 * l1 - l2 * l2 + dl * dl) / (2 * dl);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  let p = sub(pole, mul(dir, dot(pole, dir)));
  const pl = len(p);
  p = pl < 1e-4 ? [0, 0, 1] : mul(p, 1 / pl);
  return { joint: add(add(root, mul(dir, a)), mul(p, h)), end };
}

const THIGH = 0.47, SHIN = 0.46, UPPER = 0.3, FORE = 0.29;

// a: { x, y, hd, ph, v, vx, vy, acc, st, stT, idx, diveY, look }
export function rigPose(a, t) {
  const F = V3(Math.cos(a.hd), Math.sin(a.hd), 0), Z = V3(0, 0, 1);
  const G = V3(a.x, a.y, 0);
  const v = a.v || 0;
  const M = v > 0.2 ? V3(a.vx / v, a.vy / v, 0) : F;
  const s = cl(v / 8.5, 0, 1);
  const c = a.ph - Math.floor(a.ph);
  const st = a.st || 0, tt = a.stT || 0;
  const side = a.look?.foot === 'left' ? -1 : 1;            // kicking side (+1 = right)
  const back = dot(M, F) < -0.35 && v > 0.6;                // back-pedalling
  // --- gait
  const duty = 0.62 - 0.28 * cl((v - 1.6) / 3, 0, 1);
  const A = cl(0.1 + 0.085 * v, 0.06, 0.8);
  const lift = 0.06 + 0.26 * s;
  const footCurve = cc => {
    cc -= Math.floor(cc);
    if (cc < duty) return [A - 2 * A * (cc / duty), 0];
    const q = (cc - duty) / (1 - duty);
    return [-A + 2 * A * (0.5 - 0.5 * Math.cos(Math.PI * q)), Math.sin(Math.PI * q) * lift];
  };
  let hp = 0.97 - 0.06 * s + (v > 2.6 ? 0.035 : 0.012) * Math.cos(4 * Math.PI * c) * cl(v, 0, 1);
  let lean = back ? -0.06 : 0.04 + 0.2 * s + cl(a.acc || 0, -4, 4) * 0.022;
  const idle = v < 0.25 && !st;
  let pelvis, U, Rb;
  let feet = null, hands = null, knees = null, elbows = null, headOff = [0, 0, 0];

  const standLegs = (P, w = 0.11, fw = 0) => [add(add(G, mul(Rb, -w)), mul(F, fw)), add(add(G, mul(Rb, w)), mul(F, -fw))];
  const setBody = (P, up) => { pelvis = P; U = nrm(up); Rb = nrm(cr(F, U)); };

  // Default: locomotion
  const fwdLean = add(mul(Z, Math.cos(lean)), mul(back ? M : F, Math.sin(lean)));
  const sway = idle ? Math.sin(t * 1.3 + (a.idx || 0)) * 0.02 : 0;
  setBody(add(G, add(mul(Z, hp), mul(V3(F[1], -F[0], 0), sway))), fwdLean);
  if (idle) feet = standLegs(pelvis, 0.12, 0.04);
  else {
    const fl = footCurve(c), fr = footCurve(c + 0.5);
    feet = [add(add(add(G, mul(M, fl[0])), mul(Rb, -0.11)), V3(0, 0, fl[1])), add(add(add(G, mul(M, fr[0])), mul(Rb, 0.11)), V3(0, 0, fr[1]))];
  }
  // arms swing opposite to the legs
  const armSwing = (sideSign, footX) => {
    const sh = add(add(pelvis, mul(U, 0.5)), mul(Rb, 0.19 * sideSign));
    const w = idle ? 0 : footX / (A || 1);
    return add(add(add(sh, mul(Z, -0.44 + 0.16 * s)), mul(M, -w * (0.1 + 0.3 * s))), mul(Rb, sideSign * (0.05 + 0.04 * s)));
  };
  {
    const fl = footCurve(c), fr = footCurve(c + 0.5);
    hands = [armSwing(-1, fr[0]), armSwing(1, fl[0])];
  }

  // --- actions
  if (st === 5) { // KICK: backswing → strike at 0.28 s → follow-through
    let th;
    if (tt < 0.2) th = -0.3 - 0.9 * (tt / 0.2); else if (tt < 0.28) th = -1.2 + 1.2 * ((tt - 0.2) / 0.08); else th = Math.min(1.05, (tt - 0.28) / 0.18 * 1.05);
    setBody(add(G, mul(Z, hp - 0.04)), add(mul(Z, Math.cos(0.1 - 0.12 * cl((tt - 0.28) / 0.2, 0, 1))), mul(F, Math.sin(0.1 - 0.12 * cl((tt - 0.28) / 0.2, 0, 1)))));
    const hipK = add(pelvis, mul(Rb, 0.1 * side));
    const kickFoot = add(hipK, add(mul(F, Math.sin(th) * 0.9), mul(Z, -Math.cos(th) * 0.9)));
    kickFoot[2] = Math.max(0.05, kickFoot[2]);
    const plant = add(add(G, mul(Rb, -0.24 * side)), mul(F, -0.06));
    feet = side > 0 ? [plant, kickFoot] : [kickFoot, plant];
    hands = [add(add(add(pelvis, mul(U, 0.42)), mul(Rb, -0.62)), mul(F, side > 0 ? 0.12 : -0.08)), add(add(add(pelvis, mul(U, 0.42)), mul(Rb, 0.62)), mul(F, side > 0 ? -0.08 : 0.12))];
  } else if (st === 6) { // HEADER: jump, tuck, snap
    const j = 0.55 * Math.sin(Math.PI * cl(tt / 0.72, 0, 1));
    const snap = Math.exp(-Math.pow((tt - 0.32) / 0.1, 2));
    setBody(add(G, mul(Z, hp + j)), add(mul(Z, 1), mul(F, -0.15 + 0.5 * snap)));
    feet = [add(add(pelvis, mul(Rb, -0.12)), add(mul(Z, -0.66), mul(F, -0.22))), add(add(pelvis, mul(Rb, 0.12)), add(mul(Z, -0.6), mul(F, -0.12)))];
    hands = [add(add(add(pelvis, mul(U, 0.55)), mul(Rb, -0.38)), mul(F, 0.2)), add(add(add(pelvis, mul(U, 0.55)), mul(Rb, 0.38)), mul(F, 0.2))];
    headOff = mul(F, 0.07 * snap);
  } else if (st === 11) { // SLIDE TACKLE
    const q = sstep(cl(tt / 0.25, 0, 1)), r = sstep(cl((tt - 1.1) / 0.5, 0, 1)), low = q * (1 - r);
    const up = nrm(add(mul(Z, Math.cos(1.1 * low)), mul(F, -Math.sin(1.1 * low))));
    setBody(add(G, mul(Z, hp + (0.24 - hp) * low)), up);
    const lead = add(add(G, mul(F, 0.95 * low + 0.05)), add(mul(Rb, 0.12 * side), V3(0, 0, 0.06)));
    const trail = add(add(G, mul(F, 0.1)), add(mul(Rb, -0.28 * side), V3(0, 0, 0.03)));
    feet = side > 0 ? [mix3(feet[0], trail, low), mix3(feet[1], lead, low)] : [mix3(feet[0], lead, low), mix3(feet[1], trail, low)];
    const groundHand = add(add(G, mul(F, -0.35)), mul(Rb, -0.32 * side));
    hands = side > 0 ? [mix3(hands[0], groundHand, low), mix3(hands[1], add(add(pelvis, mul(U, 0.6)), mul(Rb, 0.5)), low)] : [mix3(hands[0], add(add(pelvis, mul(U, 0.6)), mul(Rb, -0.5)), low), mix3(hands[1], groundHand, low)];
    knees = 'up';
  } else if (st === 19) { // LUNGE (standing tackle / block)
    const q = sstep(cl(tt / 0.2, 0, 1)) * (1 - sstep(cl((tt - 0.55) / 0.3, 0, 1)));
    const up = nrm(add(mul(Z, Math.cos(0.4 * q)), mul(F, Math.sin(0.4 * q))));
    setBody(add(G, mul(Z, hp - 0.2 * q)), up);
    const reach = add(add(G, mul(F, 0.75 * q)), mul(Rb, 0.32 * side * q));
    const plant = add(add(G, mul(F, -0.25 * q)), mul(Rb, -0.2 * side));
    feet = side > 0 ? [mix3(feet[0], plant, q), mix3(feet[1], reach, q)] : [mix3(feet[0], reach, q), mix3(feet[1], plant, q)];
    hands = [mix3(hands[0], add(add(pelvis, mul(U, 0.4)), mul(Rb, -0.6)), q), mix3(hands[1], add(add(pelvis, mul(U, 0.4)), mul(Rb, 0.6)), q)];
  } else if (st === 1) { // FALL: stumble, go down, lie
    const q1 = sstep(cl(tt / 0.35, 0, 1)), q2 = sstep(cl((tt - 0.28) / 0.42, 0, 1));
    const ang = 0.25 * q1 + 1.32 * q2;
    const up = nrm(add(mul(Z, Math.cos(ang)), mul(F, Math.sin(ang))));
    setBody(add(G, mul(Z, hp + (0.17 - hp) * q2)), up);
    const writhe = tt > 1.3 ? Math.sin(tt * 3.2) * 0.12 : 0;
    const lying = [add(add(pelvis, mul(U, -0.86)), add(mul(Rb, -0.13), V3(0, 0, 0.06 + Math.max(0, writhe)))), add(add(pelvis, mul(U, -0.82)), add(mul(Rb, 0.14), V3(0, 0, 0.06 + Math.max(0, -writhe))))];
    feet = [mix3(feet[0], lying[0], q2), mix3(feet[1], lying[1], q2)];
    const headPos = add(pelvis, mul(U, 0.72));
    hands = [mix3(hands[0], add(add(headPos, mul(U, 0.2)), add(mul(Rb, -0.3), V3(0, 0, -0.1))), q2), mix3(hands[1], add(add(headPos, mul(U, 0.2)), add(mul(Rb, 0.3), V3(0, 0, -0.1))), q2)];
  } else if (st === 2 || st === 3) { // GOALKEEPER DIVE
    const D = V3(0, a.diveY || (st === 2 ? -1 : 1), 0);
    const q = sstep(cl(tt / 0.3, 0, 1)), air = Math.sin(Math.PI * cl(tt / 0.62, 0, 1));
    const up = nrm(add(mul(Z, Math.cos(1.38 * q)), mul(D, Math.sin(1.38 * q))));
    setBody(add(add(G, mul(D, 0.35 * q)), mul(Z, 0.9 - 0.62 * q + 0.42 * air)), up);
    const headPos = add(pelvis, mul(U, 0.72));
    hands = [add(add(headPos, mul(U, 0.42)), mul(F, 0.13)), add(add(headPos, mul(U, 0.42)), mul(F, -0.13))];
    feet = [add(add(pelvis, mul(U, -0.86)), mul(F, 0.1)), add(add(pelvis, mul(U, -0.8)), mul(F, -0.14))];
  } else if (st === 18) { // KNEE SLIDE celebration
    const up = nrm(add(mul(Z, Math.cos(0.32)), mul(F, -Math.sin(0.32))));
    setBody(add(G, mul(Z, 0.46)), up);
    feet = [add(add(G, mul(F, -0.48)), add(mul(Rb, -0.16), V3(0, 0, 0.03))), add(add(G, mul(F, -0.48)), add(mul(Rb, 0.16), V3(0, 0, 0.03)))];
    knees = [add(add(G, mul(F, 0.1)), add(mul(Rb, -0.15), V3(0, 0, 0.05))), add(add(G, mul(F, 0.1)), add(mul(Rb, 0.15), V3(0, 0, 0.05)))];
    const sh = add(pelvis, mul(U, 0.5));
    hands = [add(add(sh, mul(Z, 0.52)), mul(Rb, -0.42)), add(add(sh, mul(Z, 0.52)), mul(Rb, 0.42))];
    headOff = mul(F, -0.05);
  } else if (st === 20) { // KEEPER SET
    setBody(add(G, mul(Z, 0.78)), add(mul(Z, Math.cos(0.25)), mul(F, Math.sin(0.25))));
    feet = standLegs(pelvis, 0.27, 0);
    const sh = add(pelvis, mul(U, 0.5));
    hands = [add(add(add(sh, mul(F, 0.22)), mul(Rb, -0.32)), mul(Z, -0.3)), add(add(add(sh, mul(F, 0.22)), mul(Rb, 0.32)), mul(Z, -0.3))];
  } else if (st === 10) { // HOLD (keeper with the ball)
    const sh = add(pelvis, mul(U, 0.5));
    hands = [add(add(add(sh, mul(F, 0.26)), mul(Rb, -0.09)), mul(Z, -0.13)), add(add(add(sh, mul(F, 0.26)), mul(Rb, 0.09)), mul(Z, -0.13))];
  } else if (st === 15) { // WALL: hands protecting
    feet = standLegs(pelvis, 0.08, 0);
    hands = [add(add(pelvis, mul(F, 0.16)), add(mul(Rb, -0.05), V3(0, 0, -0.1))), add(add(pelvis, mul(F, 0.16)), add(mul(Rb, 0.05), V3(0, 0, -0.1)))];
  } else if (st === 4) { // CELEBRATION run
    const sh = add(pelvis, mul(U, 0.5));
    const plane = (a.idx || 0) % 2 === 0;
    hands = plane ? [add(add(sh, mul(Rb, -0.62)), V3(0, 0, 0.04)), add(add(sh, mul(Rb, 0.62)), V3(0, 0, 0.04))]
      : [add(add(sh, mul(Z, 0.56)), mul(Rb, -0.14)), add(add(sh, mul(Z, 0.56 + 0.05 * Math.sin(tt * 9))), mul(Rb, 0.14))];
  } else if (st === 14) { // DEJECTED: hands on head
    const hd = add(add(pelvis, mul(U, 0.72)), mul(F, 0.05));
    hands = [add(add(hd, mul(Rb, -0.15)), V3(0, 0, 0.07)), add(add(hd, mul(Rb, 0.15)), V3(0, 0, 0.07))];
    headOff = add(mul(F, 0.06), V3(0, 0, -0.03));
    elbows = 'out';
  } else if (st === 13) { // APPEAL
    const sh = add(pelvis, mul(U, 0.5)), o = Math.sin(tt * 5) * 0.06;
    hands = [add(add(add(sh, mul(Rb, -0.5)), mul(F, 0.15)), V3(0, 0, -0.06 + o)), add(add(add(sh, mul(Rb, 0.5)), mul(F, 0.15)), V3(0, 0, -0.06 - o))];
  } else if (st === 7 || st === 8 || st === 9) { // CARD / FLAG: arm straight up
    const sh = add(add(pelvis, mul(U, 0.5)), mul(Rb, 0.19));
    hands[1] = add(sh, V3(0, 0, 0.6));
  } else if (st === 16) { // WHISTLE
    hands[1] = add(add(add(pelvis, mul(U, 0.68)), mul(F, 0.14)), mul(Rb, 0.03));
  } else if (st === 17) { // POINT
    hands[1] = add(add(add(pelvis, mul(U, 0.5)), mul(Rb, 0.19)), add(mul(F, 0.58), V3(0, 0, 0.18)));
  } else if (st === 12) { // THROW-IN
    const sh = add(pelvis, mul(U, 0.5));
    hands = [add(add(sh, mul(Z, 0.55)), mul(Rb, -0.1)), add(add(sh, mul(Z, 0.55)), mul(Rb, 0.1))];
  }

  // --- assemble skeleton
  const hipL = add(pelvis, mul(Rb, -0.1)), hipR = add(pelvis, mul(Rb, 0.1));
  // Knees bend forward when upright, towards the ground when lying face-down, up when sliding.
  const kneePole = knees === 'up' ? Z : st === 1 && U[2] < 0.7 ? V3(0, 0, -1) : (st === 2 || st === 3) ? F : F;
  let legL, legR;
  if (Array.isArray(knees)) { legL = { joint: knees[0], end: feet[0] }; legR = { joint: knees[1], end: feet[1] }; }
  else { legL = ik(hipL, feet[0], THIGH, SHIN, kneePole); legR = ik(hipR, feet[1], THIGH, SHIN, kneePole); }
  const chest = add(pelvis, mul(U, 0.5));
  const shL = add(chest, mul(Rb, -0.19)), shR = add(chest, mul(Rb, 0.19));
  const head = add(add(chest, mul(U, 0.24)), headOff);
  const elbowPole = l => (elbows === 'out' ? nrm(add(mul(Rb, l), Z)) : nrm(add(mul(F, -1), add(mul(Rb, l * 0.4), V3(0, 0, -0.2)))));
  const armL = ik(shL, hands[0], UPPER, FORE, elbowPole(-1));
  const armR = ik(shR, hands[1], UPPER, FORE, elbowPole(1));
  return { pelvis, U, Rb, F, hipL, hipR, kneeL: legL.joint, footL: legL.end, kneeR: legR.joint, footR: legR.end, shL, shR, elbL: armL.joint, handL: armL.end, elbR: armR.joint, handR: armR.end, head, M };
}

const PJ = {};
const PK = ['pelvis', 'hipL', 'hipR', 'kneeL', 'footL', 'kneeR', 'footR', 'shL', 'shR', 'elbL', 'handL', 'elbR', 'handR', 'head'];
for (const k of PK) PJ[k] = [0, 0, 0];
const toeL = [0, 0, 0], toeR = [0, 0, 0], tmp = [0, 0, 0];

export function drawRig(ctx, cam, a, t) {
  const j = rigPose(a, t);
  const lk = a.look;
  for (const k of PK) { const w = j[k]; project(cam, w[0], w[1], w[2], PJ[k]); }
  const kpx = scaleAt(cam, a.x, a.y);
  const toeDir = j.M && a.v > 0.3 ? j.M : j.F;
  project(cam, j.footL[0] + toeDir[0] * 0.2, j.footL[1] + toeDir[1] * 0.2, j.footL[2] + 0.02, toeL);
  project(cam, j.footR[0] + toeDir[0] * 0.2, j.footR[1] + toeDir[1] * 0.2, j.footR[2] + 0.02, toeR);
  // Shadow (stretched along the body when on the ground)
  project(cam, j.pelvis[0], j.pelvis[1], 0, tmp);
  const lying = j.U[2] < 0.6;
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath(); ctx.ellipse(tmp[0], tmp[1], (lying ? 0.95 : 0.45) * kpx, 0.14 * kpx, 0, 0, Math.PI * 2); ctx.fill();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const line = (p, q, w, col) => { ctx.strokeStyle = col; ctx.lineWidth = Math.max(1, w * kpx); ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.stroke(); };
  const legDraw = (hip, knee, foot, toe) => {
    line(hip, knee, 0.17, lk.skin);
    line(knee, foot, 0.13, lk.socks);
    line(foot, toe, 0.11, lk.boots || '#111');
  };
  const sleeve = lk.longSleeve ? 1 : 0.42;
  const armDraw = (sh, el, hand) => {
    line(sh, el, 0.105, lk.skin);
    const mid = [sh[0] + (el[0] - sh[0]) * sleeve, sh[1] + (el[1] - sh[1]) * sleeve];
    line(sh, mid, 0.125, lk.shirt);
    line(el, hand, 0.09, lk.longSleeve ? lk.shirt : lk.skin);
    if (lk.gloves) { ctx.fillStyle = lk.gloves; ctx.beginPath(); ctx.arc(hand[0], hand[1], Math.max(1.2, 0.065 * kpx), 0, Math.PI * 2); ctx.fill(); }
  };
  // Draw the far side first.
  const leftFar = PJ.shL[2] > PJ.shR[2];
  const far = leftFar ? 'L' : 'R', near = leftFar ? 'R' : 'L';
  const leg = s => legDraw(PJ['hip' + s], PJ['knee' + s], PJ['foot' + s], s === 'L' ? toeL : toeR);
  const arm = s => armDraw(PJ['sh' + s], PJ['elb' + s], PJ['hand' + s]);
  arm(far); leg(far); leg(near);
  // Shorts
  const kL = [PJ.hipL[0] + (PJ.kneeL[0] - PJ.hipL[0]) * 0.42, PJ.hipL[1] + (PJ.kneeL[1] - PJ.hipL[1]) * 0.42];
  const kR = [PJ.hipR[0] + (PJ.kneeR[0] - PJ.hipR[0]) * 0.42, PJ.hipR[1] + (PJ.kneeR[1] - PJ.hipR[1]) * 0.42];
  ctx.fillStyle = lk.shorts;
  ctx.beginPath(); ctx.moveTo(PJ.hipL[0], PJ.hipL[1]); ctx.lineTo(PJ.hipR[0], PJ.hipR[1]); ctx.lineTo(kR[0], kR[1]); ctx.lineTo(kL[0], kL[1]); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = lk.shorts; ctx.lineWidth = Math.max(1, 0.14 * kpx); ctx.stroke();
  // Torso (shirt)
  const waistL = [PJ.hipL[0] + (PJ.hipL[0] - PJ.pelvis[0]) * 0.2, PJ.hipL[1] + (PJ.hipL[1] - PJ.pelvis[1]) * 0.2 - 0.04 * kpx];
  const waistR = [PJ.hipR[0] + (PJ.hipR[0] - PJ.pelvis[0]) * 0.2, PJ.hipR[1] + (PJ.hipR[1] - PJ.pelvis[1]) * 0.2 - 0.04 * kpx];
  ctx.fillStyle = lk.shirt;
  ctx.beginPath(); ctx.moveTo(PJ.shL[0], PJ.shL[1]); ctx.lineTo(PJ.shR[0], PJ.shR[1]); ctx.lineTo(waistR[0], waistR[1]); ctx.lineTo(waistL[0], waistL[1]); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = lk.shirt; ctx.lineWidth = Math.max(1, 0.12 * kpx); ctx.stroke();
  // Shirt number on the back when the back faces the camera
  const backToCam = j.F[0] * cam.fwd[0] + j.F[1] * cam.fwd[1] > 0.2;
  if (lk.num != null && kpx > 16 && !lying) {
    const cx = (PJ.shL[0] + PJ.shR[0] + waistL[0] + waistR[0]) / 4, cy = (PJ.shL[1] + PJ.shR[1] + waistL[1] + waistR[1]) / 4;
    ctx.fillStyle = lk.numColor || '#fff';
    ctx.font = `800 ${Math.round((backToCam ? 0.25 : 0.12) * kpx)}px ${FONT}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (backToCam) ctx.fillText(String(lk.num), cx, cy + 0.02 * kpx);
    else { ctx.fillText(String(lk.num), cx + (PJ.shR[0] - PJ.shL[0]) * 0.22, cy - 0.12 * kpx); }
  }
  arm(near);
  // Head: face from the front, hair from behind
  const r = Math.max(1.6, 0.125 * kpx), hx = PJ.head[0], hy = PJ.head[1];
  ctx.fillStyle = lk.skin;
  ctx.beginPath(); ctx.arc(hx, hy, r, 0, Math.PI * 2); ctx.fill();
  if (lk.hair) {
    project(cam, j.head[0] - j.F[0] * 0.12 + j.U[0] * 0.06, j.head[1] - j.F[1] * 0.12 + j.U[1] * 0.06, j.head[2] + j.U[2] * 0.06, tmp);
    ctx.save(); ctx.beginPath(); ctx.arc(hx, hy, r * 1.02, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = lk.hair;
    ctx.beginPath(); ctx.arc(tmp[0], tmp[1], r * (backToCam ? 1.05 : 0.95), 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  // Props: referee card, assistant's flag
  if (a.st === 7 || a.st === 8) {
    ctx.fillStyle = a.st === 8 ? '#ef1c1c' : '#ffd400';
    ctx.fillRect(PJ.handR[0] - 0.07 * kpx, PJ.handR[1] - 0.24 * kpx, 0.15 * kpx, 0.21 * kpx);
  }
  if (a.st === 9) {
    const wave = Math.sin(t * 9) * 0.04 * kpx;
    ctx.fillStyle = '#ff2d2d'; ctx.fillRect(PJ.handR[0], PJ.handR[1] - 0.42 * kpx + wave, 0.3 * kpx, 0.2 * kpx);
    ctx.fillStyle = '#ffd400'; ctx.fillRect(PJ.handR[0] + 0.15 * kpx, PJ.handR[1] - 0.42 * kpx + wave, 0.15 * kpx, 0.1 * kpx);
  }
  return PJ.head;
}
