// Pose sampling and blending on the motion library.
// A pose is { q: Float32Array(B*4) local rotations, r: Float32Array(3) root position }.
export function makePose(B) { return { q: new Float32Array(B * 4), r: new Float32Array(3) }; }

export function copyPose(dst, src) { dst.q.set(src.q); dst.r.set(src.r); return dst; }

// Spherical blend of two unit quaternions stored in arrays.
function slerpInto(out, o, a, ao, b, bo, t) {
  let ax = a[ao], ay = a[ao + 1], az = a[ao + 2], aw = a[ao + 3];
  let bx = b[bo], by = b[bo + 1], bz = b[bo + 2], bw = b[bo + 3];
  let d = ax * bx + ay * by + az * bz + aw * bw;
  if (d < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; d = -d; }
  let s0, s1;
  if (d > 0.9995) { s0 = 1 - t; s1 = t; }
  else { const th = Math.acos(d), sn = Math.sin(th); s0 = Math.sin((1 - t) * th) / sn; s1 = Math.sin(t * th) / sn; }
  let x = ax * s0 + bx * s1, y = ay * s0 + by * s1, z = az * s0 + bz * s1, w = aw * s0 + bw * s1;
  const l = 1 / Math.hypot(x, y, z, w);
  out[o] = x * l; out[o + 1] = y * l; out[o + 2] = z * l; out[o + 3] = w * l;
}

// Frame-interpolated sample of a clip at fractional frame f (wraps for cycles/loops).
function sampleFrames(clip, f, out, wrap) {
  const n = clip.n, B = clip.B;
  let i = Math.floor(f), a = f - i;
  let j = i + 1;
  if (wrap) { i = ((i % n) + n) % n; j = (i + 1) % n; }
  else { if (i < 0) { i = 0; j = 0; a = 0; } if (i >= n - 1) { i = n - 1; j = n - 1; a = 0; } }
  const q = clip.q, r = clip.r;
  for (let b = 0; b < B; b++) slerpInto(out.q, b * 4, q, (i * B + b) * 4, q, (j * B + b) * 4, a);
  for (let k = 0; k < 3; k++) out.r[k] = r[i * 3 + k] + (r[j * 3 + k] - r[i * 3 + k]) * a;
  // Cycles store the root relative to the strike position; travel is supplied by the engine.
  return out;
}

export function sampleCycle(clip, phase, out) { return sampleFrames(clip, (phase - Math.floor(phase)) * clip.n, out, true); }
export function sampleAction(clip, time, out) {
  const f = time * clip.fps;
  return sampleFrames(clip, clip.loop ? f : f, out, !!clip.loop);
}

// out = blend(a, b, t)
export function blendPose(out, a, b, t) {
  if (t <= 0) return copyPose(out, a);
  if (t >= 1) return copyPose(out, b);
  const B = a.q.length / 4;
  for (let i = 0; i < B; i++) slerpInto(out.q, i * 4, a.q, i * 4, b.q, i * 4, t);
  for (let k = 0; k < 3; k++) out.r[k] = a.r[k] + (b.r[k] - a.r[k]) * t;
  return out;
}

// Blend only a subset of bones (mask: Uint8Array per bone, 1 = take b).
export function blendMasked(out, a, b, t, mask) {
  const B = a.q.length / 4;
  for (let i = 0; i < B; i++) {
    const w = t * mask[i];
    if (w <= 0) { for (let k = 0; k < 4; k++) out.q[i * 4 + k] = a.q[i * 4 + k]; }
    else slerpInto(out.q, i * 4, a.q, i * 4, b.q, i * 4, w);
  }
  if (out !== a) out.r.set(a.r);
  return out;
}

// Multiply a local rotation by an extra rotation (axis-angle, in the bone's rest frame = world axes).
export function rotateBone(pose, b, ax, ay, az, angle) {
  if (!angle) return;
  const s = Math.sin(angle / 2), c = Math.cos(angle / 2);
  const rx = ax * s, ry = ay * s, rz = az * s, rw = c;
  const o = b * 4, q = pose.q;
  const x = q[o], y = q[o + 1], z = q[o + 2], w = q[o + 3];
  // pre-multiply: r * q (rotation applied in the parent's frame)
  q[o] = rw * x + rx * w + ry * z - rz * y;
  q[o + 1] = rw * y - rx * z + ry * w + rz * x;
  q[o + 2] = rw * z + rx * y - ry * x + rz * w;
  q[o + 3] = rw * w - rx * x - ry * y - rz * z;
}
