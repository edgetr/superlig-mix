// Hair generator (pure maths, runs in the face worker): grows hair cards, beard fuzz and eyebrows
// on the player's reshaped head and returns packed vertex arrays (see hair.js for the look).
export const INFLATE_UNDER = 0.55; // shader hair volume kept under the cards (the rest is real hair)

// ---------------------------------------------------------------- small helpers
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const ss = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = a => Math.hypot(a[0], a[1], a[2]);
const norm = a => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const tangentOf = (d, n) => norm(sub(d, mul(n, dot(d, n))));

// ---------------------------------------------------------------- style
export function chooseStyle(p) {
  const st = p.style || {};
  const top = p.hairTop || 0, side = p.hairSideVol || 0;
  if (p.bald) return { kind: 'none' };
  if (st.hang > 0.05) return { kind: st.curl > 0.45 ? 'locs' : 'long', top, side, hang: st.hang, curl: st.curl };
  if (top < 0.006 && side < 0.005) return { kind: 'buzz', top, side, curl: st.curl };
  if (st.curl > 0.4) return { kind: 'curly', top, side, curl: st.curl };
  const flow = p.front < 1.676 ? 'forward' : st.vert > 0.62 ? 'back' : 'radial';
  return { kind: 'crop', flow, top, side, curl: st.curl || 0 };
}

// ---------------------------------------------------------------- generator
// info: head vertices (headModel.headInfo) + local / bodyIndex; face: { pos, nrm (head vertices,
// reshaped), hairW, beardD, browPts, params }. Returns packed arrays in rest (body) space, or null.
export function buildHair(info, face, seed = 1) {
  const p = face.params, style = chooseStyle(p);
  const pos = face.pos, nrm = face.nrm;
  const r = rng(seed);
  const nv = info.idx.length;
  const P = k => [pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]];
  const Nn = k => [nrm[k * 3], nrm[k * 3 + 1], nrm[k * 3 + 2]];
  const lin2 = c => c.map(v => Math.sqrt(Math.max(0, v)));
  // The head shell: an ellipsoid through the cranium of this head.
  let x0 = 9, x1 = -9, z0 = 9, z1 = -9, top = -9;
  for (let k = 0; k < nv; k++) {
    if (info.R[k] !== 0 || info.UV[k * 2] > 0.55) continue;
    const q = P(k);
    top = Math.max(top, q[1]);
    if (q[1] > 1.63) { x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); z0 = Math.min(z0, q[2]); z1 = Math.max(z1, q[2]); }
  }
  const C = [(x0 + x1) / 2, 1.615, (z0 + z1) / 2], RAD = [(x1 - x0) / 2, top - 1.615, (z1 - z0) / 2];
  const shellS = q => len([(q[0] - C[0]) / RAD[0], (q[1] - C[1]) / RAD[1], (q[2] - C[2]) / RAD[2]]);
  const outward = q => norm([(q[0] - C[0]) / (RAD[0] * RAD[0]), (q[1] - C[1]) / (RAD[1] * RAD[1]), (q[2] - C[2]) / (RAD[2] * RAD[2])]);
  const volAt = n => (p.hairSideVol || 0.002) + (Math.min(0.022, p.hairTop || 0.01) - (p.hairSideVol || 0.002)) * ss(-0.4, 0.95, n[1]);

  const out = { pos: [], tan: [], nrm: [], uv: [], col: [], idx: [] };
  // One card: a ribbon along pts (each a point + its direction), width w → w·taper at the tip.
  function card(pts, side, w, taper, nOut, cRoot, cTip, half, rnd) {
    const base = out.pos.length / 3, n = pts.length;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1), q = pts[i].p, d = pts[i].d, ww = w * (1 - (1 - taper) * t) * 0.5;
      const sd = pts[i].side || side;
      const c = [0, 1, 2].map(k => cRoot[k] + (cTip[k] - cRoot[k]) * t);
      for (const s of [-1, 1]) {
        out.pos.push(q[0] + sd[0] * ww * s, q[1] + sd[1] * ww * s, q[2] + sd[2] * ww * s);
        out.tan.push(...d); out.nrm.push(...nOut); out.uv.push(s < 0 ? 0 : 1, t, half, rnd); out.col.push(...c);
      }
      if (i) { const a = base + (i - 1) * 2; out.idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    }
  }
  // Scalp triangles with their hair weight (roots are spread by area × weight).
  const tris = [], areas = [];
  let total = 0;
  const bi = info.bodyIndex;
  for (let t = 0; t < bi.length; t += 3) {
    const a = info.local[bi[t]], b = info.local[bi[t + 1]], c = info.local[bi[t + 2]];
    if (a < 0 || b < 0 || c < 0) continue;
    if (info.R[a] !== 0 || info.R[b] !== 0 || info.R[c] !== 0) continue;
    tris.push([a, b, c]);
  }
  function sampler(weight) {
    tris.length; areas.length = 0; total = 0;
    for (const [a, b, c] of tris) {
      const w = (weight[a] + weight[b] + weight[c]) / 3;
      const A = w > 0.02 ? len(cross(sub(P(b), P(a)), sub(P(c), P(a)))) * 0.5 * w : 0;
      total += A; areas.push(total);
    }
    return () => {
      const x = r() * total;
      let lo = 0, hi = areas.length - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (areas[m] < x) lo = m + 1; else hi = m; }
      const [a, b, c] = tris[lo];
      let u = r(), v = r(); if (u + v > 1) { u = 1 - u; v = 1 - v; }
      const wa = 1 - u - v;
      const q = add(add(mul(P(a), wa), mul(P(b), u)), mul(P(c), v));
      const n = norm(add(add(mul(Nn(a), wa), mul(Nn(b), u)), mul(Nn(c), v)));
      const hw = weight[a] * wa + weight[b] * u + weight[c] * v;
      return { q, n, hw };
    };
  }

  // ------------------------------------------------ scalp hair
  const hairTop = lin2(p.hair), hairSide = lin2(p.hairSide || p.hair);
  const twoTone = (p.hair[0] + p.hair[1] + p.hair[2]) > 1.8 * (((p.hairSide || p.hair)[0] + (p.hairSide || p.hair)[1] + (p.hairSide || p.hair)[2]) + 0.01);
  if (style.kind !== 'none') {
    const pick = sampler(face.hairW);
    const crown = [C[0], top - 0.012, C[2] - 0.035];
    const K = style.kind;
    const count = { buzz: 3600, crop: 3000, curly: 1500, long: 1700, locs: 300 }[K];
    const segs = { buzz: 1, crop: 5, curly: 10, long: 10, locs: 10 }[K];
    // clumps: strands rooted in the same ~1.5 cm cell share a bend (hair falls in locks)
    const cellDir = new Map();
    const clumpOf = q => {
      const key = `${Math.floor(q[0] / 0.015)},${Math.floor(q[1] / 0.015)},${Math.floor(q[2] / 0.015)}`;
      let v = cellDir.get(key); if (!v) cellDir.set(key, (v = [r() - 0.5, r() - 0.5, r() - 0.5]));
      return v;
    };
    for (let s = 0; s < count && total > 0; s++) {
      const { q: root0, n, hw } = pick();
      if (r() > Math.min(1, hw * 1.4)) continue;
      const root = add(root0, mul(n, hw * volAt(n) * INFLATE_UNDER));   // on the shader's hair volume
      const out0 = outward(root), topness = ss(-0.4, 0.95, n[1]);
      const vol = volAt(n);
      const front = ss(C[2] + 0.02, C[2] + 0.08, root[2]);
      // strand length and how it leaves the scalp
      let L, lift, curlR = 0, curlF = 0, grav = 0, layer = 0.15 + 0.85 * Math.pow(r(), 1.6);
      let flow;
      const away = tangentOf(sub(root, crown), n);
      const back = tangentOf([0, 0.15, -1], n), fwd = tangentOf([0, -0.35, 1], n), down = tangentOf([0, -1, -0.35], n);
      const fringe = style.flow === 'forward';
      if (K === 'buzz') { L = 0.0025 + 0.004 * r() + vol * 0.6; lift = 0.9; flow = away; }
      else if (K === 'crop') {
        const Ltop = clamp(p.hairTop * 2.4, 0.01, 0.065), Lside = clamp((p.hairSideVol || 0.002) * 2.5, 0.003, 0.03);
        L = (Lside + (Ltop - Lside) * topness * topness) * (0.8 + 0.4 * r()) * (0.6 + 0.4 * ss(0.3, 0.9, hw));
        lift = 0.12 + (fringe ? 0.03 : 0.15) * ss(0.4, 1, front);
        flow = fringe ? norm(add(mul(fwd, topness), mul(down, 1 - topness))) : norm(add(mul(back, topness), mul(down, 1 - topness)));
        if (L < 0.008) lift = 0.75;
        curlR = style.curl * 0.0015; curlF = 2.5;
      } else if (K === 'curly') {
        // ringlets: coils a few millimetres wide, one to two turns over their length
        L = clamp(vol * 1.4 + 0.006, 0.008, 0.06) * (0.75 + 0.5 * r()) * (0.5 + 0.5 * topness);
        lift = 0.8; flow = norm(add(mul(out0, 0.6), mul(fwd, 0.3 + front * 0.5)));
        curlR = 0.003 + 0.0035 * style.curl; curlF = 1.2 + 1.2 * r(); layer = 0.5 + 0.5 * r();
      } else {
        // long hair / locs: combed back over the head, hugging it, then hanging to the hang length
        L = clamp((top - root[1]) * 0.8 + 0.07 + style.hang * (0.7 + 0.5 * r()), 0.06, 0.32);
        lift = 0.25; flow = norm(add(mul(back, topness), mul(down, 1 - topness)));
        grav = 1; curlR = K === 'locs' ? 0.0008 : 0.003 * style.curl; curlF = 1.5;
      }
      const thick = Math.max(0.0025, vol) * layer;
      // grow
      const seg = L / segs, s0 = shellS(root), rr = len(sub(root, C));
      let d = norm(add(mul(flow, Math.cos(lift)), mul(n, Math.sin(lift))));
      let q = add(root, mul(n, 0.0004));
      const clump = K === 'buzz' ? 0 : 0.25 + 0.2 * r();
      const cd = clumpOf(root);
      flow = norm(add(flow, mul(tangentOf(cd, n), clump)));
      const ph = r() * 6.28;
      const pts = [{ p: q, d }];
      let hanging = false;
      for (let i = 1; i <= segs; i++) {
        const t = i / segs;
        const oq = outward(q);
        if (grav) {
          // over the skull: follow the combing direction along the head; below it: hang
          if (!hanging && q[1] < C[1] - 0.005) hanging = true;
          d = hanging ? norm(add(add(mul(d, 0.35), [0, -1, 0]), mul(oq, 0.12)))
            : norm(add(mul(tangentOf(d, oq), 0.6), mul(tangentOf(flow, oq), 0.4)));
        } else if (K === 'crop') d = norm(add(mul(tangentOf(d, oq), 0.65), add(mul(tangentOf(flow, oq), 0.35), mul(oq, 0.15 * (1 - t)))));
        else d = norm(add(mul(d, 0.7), mul(K === 'curly' ? norm(add(oq, mul(flow, 0.3))) : oq, 0.3)));
        q = add(q, mul(d, seg));
        // shell: stay above the skull at this strand's layer height (lying hair hugs it)
        const sMin = s0 + (thick * Math.min(1, t * 2.5)) / rr;
        const sMax = sMin + (K === 'crop' ? 0.006 : grav ? 0.012 : 0.05) / rr;
        const sq = shellS(q);
        if (sq < sMin) q = add(C, mul(sub(q, C), sMin / sq));
        else if (sq > sMax && K !== 'curly' && K !== 'buzz' && !hanging) q = add(C, mul(sub(q, C), sMax / sq));
        pts.push({ p: q, d: norm(sub(q, pts[i - 1].p)) });
      }
      // curls: a helix around the path
      if (curlR > 0) {
        for (let i = 1; i < pts.length; i++) {
          const t = i / segs, dd = pts[i].d, b1 = norm(cross(dd, out0)), b2 = cross(dd, b1);
          const a = ph + t * curlF * 6.283;
          pts[i].p = add(pts[i].p, add(mul(b1, Math.cos(a) * curlR * Math.min(1, t * 3)), mul(b2, Math.sin(a) * curlR * Math.min(1, t * 3))));
        }
        for (let i = 1; i < pts.length; i++) pts[i].d = norm(sub(pts[i].p, pts[i - 1].p));
      }
      // flyaway
      if (K !== 'buzz' && K !== 'locs' && r() < 0.012) { const e = pts[pts.length - 1]; e.p = add(e.p, mul(add(out0, [r() - 0.5, r() - 0.5, r() - 0.5]), L * 0.25)); }
      // card orientation: flat on the head for lying hair, any angle for standing / curly hair
      const flat = K === 'crop' && L > 0.008 ? 0.85 : K === 'long' ? 0.7 : 0;
      const a0 = (r() - 0.5) * Math.PI * (1 - flat);
      const sideFlat = norm(cross(pts[1].d, out0));
      const up2 = cross(sideFlat, pts[1].d);
      const side = norm(add(mul(sideFlat, Math.cos(a0)), mul(up2, Math.sin(a0))));
      const yTop = ss(1.66, 1.7, root[1]);
      const cBase = [0, 1, 2].map(k => hairSide[k] + (hairTop[k] - hairSide[k]) * yTop);
      const vr = 0.85 + 0.3 * r();
      const cRoot = twoTone && yTop > 0.5 ? hairSide.map(v => v * 0.9) : cBase.map(v => v * vr);
      const cTip = cBase.map(v => Math.min(1, v * vr * (twoTone ? 1.05 : 1.08)));
      const width = { buzz: 0.0016, crop: 0.003, curly: 0.0045, long: 0.0042, locs: 0.0068 }[K] * (0.8 + 0.4 * r());
      card(pts, side, width, K === 'locs' ? 0.7 : 0.45, out0, cRoot, cTip, K === 'locs' ? 1 : 0, r());
      if (K === 'locs') card(pts, norm(cross(pts[1].d, side)), width, 0.7, out0, cRoot, cTip, 1, r());
    }
  }

  // ------------------------------------------------ beard and stubble
  const bK = p.beardK || 0;
  if (face.beardD) {
    let any = 0; for (let k = 0; k < nv; k++) any += face.beardD[k];
    if (any > 8) {
      const pick = sampler(face.beardD);
      const Lb = 0.0016 + 0.011 * Math.pow(bK, 1.5);
      const cnt = Math.round(clamp(any * 9, 300, 2600));
      const bc = lin2(p.beard);
      for (let s = 0; s < cnt && total > 0; s++) {
        const { q: root, n, hw } = pick();
        if (r() > hw) continue;
        const L = Lb * (0.6 + 0.7 * r()) * (0.5 + 0.5 * hw);
        const down = tangentOf([0, -1, 0.25], n);
        let d = norm(add(mul(down, 0.75), mul(n, 0.65)));
        const segs = L > 0.006 ? 3 : 1;
        const pts = [{ p: add(root, mul(n, 0.0003)), d }];
        for (let i = 1; i <= segs; i++) { d = norm(add(mul(d, 0.8), mul(down, 0.2))); pts.push({ p: add(pts[i - 1].p, mul(d, L / segs)), d }); }
        const side = norm(cross(d, n)), a0 = (r() - 0.5) * 2.4;
        const sd = norm(add(mul(side, Math.cos(a0)), mul(cross(side, d), Math.sin(a0))));
        const c = bc.map(v => v * (0.8 + 0.35 * r()));
        card(pts, sd, 0.0011 + 0.0007 * r(), 0.5, n, c, c, 0, r());
      }
    }
  }

  // ------------------------------------------------ eyebrows
  if (face.browPts && (p.browContrast || 0) > 0.12) {
    const bc = lin2(p.brow || p.hair);
    for (const sideK of [0, 1]) {
      const B = face.browPts.slice(sideK * 10, sideK * 10 + 10);
      const U = B.slice(0, 5), Lo = B.slice(5, 10);          // lateral → medial
      for (let s = 0; s < 90; s++) {
        const f = r() * 4, i = Math.floor(f), u = f - i, j = Math.min(4, i + 1);
        const a = add(mul(U[i], 1 - u), mul(U[j], u)), b = add(mul(Lo[i], 1 - u), mul(Lo[j], u));
        const m = 0.15 + 0.7 * r();
        const q0 = add(mul(a, 1 - m), mul(b, m));
        const n = norm([q0[0] * 0.8, 0.25, 1]);
        const lateral = norm(sub(U[0], U[4]));
        const medial = 1 - f / 4; // 1 at the medial end: hairs point up there
        const d = norm(add(mul(lateral, 1 - medial * 0.6), [0, 0.35 + medial * 0.6, 0]));
        const L = 0.006 + 0.004 * r();
        const p0 = add(q0, mul(n, 0.0008));
        const pts = [{ p: p0, d }, { p: add(add(p0, mul(d, L)), mul(n, 0.0006)), d }];
        const c = bc.map(v => v * (0.8 + 0.3 * r()));
        card(pts, norm(cross(d, n)), 0.0012, 0.4, n, c, c, 0, r());
      }
    }
  }

  if (!out.idx.length) return null;
  const nOut = out.pos.length / 3;
  return {
    pos: new Float32Array(out.pos),
    tan: new Int8Array(out.tan.map(v => Math.round(clamp(v, -1, 1) * 127))),
    nrm: new Int8Array(out.nrm.map(v => Math.round(clamp(v, -1, 1) * 127))),
    uv: new Uint8Array(out.uv.map(v => Math.round(clamp(v, 0, 1) * 255))),
    col: new Uint8Array(out.col.map(v => Math.round(clamp(v, 0, 1) * 255))),
    idx: nOut > 65535 ? new Uint32Array(out.idx) : new Uint16Array(out.idx),
    style, tris: out.idx.length / 3,
  };
}
