// Pitch, timing and shared helpers for the match engine.
export const L = 105, WD = 68, GOAL_W = 7.32, GOAL_H = 2.44;
export const POST_A = WD / 2 - GOAL_W / 2, POST_B = WD / 2 + GOAL_W / 2;
export const HZ = 30, DT = 1 / HZ;
export const N_AGENTS = 25, REF = 22, AR_FAR = 23, AR_NEAR = 24;

// Animation states recorded per agent per tick (the renderer poses players from these).
export const S = {
  RUN: 0, FALL: 1, DIVE_L: 2, DIVE_R: 3, CELEB: 4, KICK: 5, HEAD: 6, CARD_Y: 7, CARD_R: 8, FLAG: 9, HOLD: 10, SLIDE: 11, THROW: 12,
  APPEAL: 13, DEJECT: 14, WALL: 15, WHISTLE: 16, POINT: 17, KNEESLIDE: 18, LUNGE: 19, SET: 20,
  CALL: 21,      // arm up, asking for the ball
  JOCKEY: 22,    // side-on, knees bent, delaying the dribbler
  WALLJUMP: 23,  // jump on the spot (defensive wall)
  CATCH: 24,     // keeper gathering a ball at his body
  CHEST: 25,     // chest control
};

// Metres per full gait cycle at a given speed, measured from the motion-capture gait cycles the
// renderer plays (so the feet stay planted): walk 1.3 m/s ≈ 1.46 m, run 3.65 m/s ≈ 2.67 m, sprint ≈ 4.6 m.
export const GAIT = [[0, 0.9], [1.3, 1.46], [2.93, 2.31], [3.65, 2.67], [4.44, 3.02], [4.83, 3.1], [6.5, 3.75], [9.5, 4.6]];
export function cycleLen(v) {
  for (let i = 1; i < GAIT.length; i++) if (v <= GAIT[i][0]) { const [a, la] = GAIT[i - 1], [b, lb] = GAIT[i]; return la + ((v - a) / (b - a)) * (lb - la); }
  return GAIT[GAIT.length - 1][1];
}

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const angDiff = (a, b) => { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
export const smooth = x => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

export const other = side => (side === 'A' ? 'B' : 'A');
export const sideOf = agent => (agent < 11 ? 'A' : agent < 22 ? 'B' : null);
export const baseOf = side => (side === 'A' ? 0 : 11);

// Team frame: u = distance from own goal line towards the opponent's goal, v = across, measured
// from the team's left touchline when facing the attack.
export function toWorld(dir, u, v) { return dir > 0 ? { x: u, y: v } : { x: L - u, y: WD - v }; }
export function toTeam(dir, x, y) { return dir > 0 ? { u: x, v: y } : { u: L - x, v: WD - y }; }
