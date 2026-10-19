// Shared game rules used by the web app, the Convex backend and the host helper.

// [role, x%, y%] on a vertical pitch: own goal at the bottom (y=100), attacking upwards.
export const FORMATIONS = {
  '4-3-3':   [['GK', 50, 90], ['LB', 13, 68], ['CB', 37, 72], ['CB', 63, 72], ['RB', 87, 68], ['CM', 25, 47], ['CDM', 50, 53], ['CM', 75, 47], ['LW', 17, 22], ['ST', 50, 16], ['RW', 83, 22]],
  '4-4-2':   [['GK', 50, 90], ['LB', 13, 68], ['CB', 37, 72], ['CB', 63, 72], ['RB', 87, 68], ['LM', 13, 44], ['CM', 37, 49], ['CM', 63, 49], ['RM', 87, 44], ['ST', 36, 18], ['ST', 64, 18]],
  '4-2-3-1': [['GK', 50, 90], ['LB', 13, 69], ['CB', 37, 73], ['CB', 63, 73], ['RB', 87, 69], ['CDM', 36, 54], ['CDM', 64, 54], ['LW', 15, 33], ['CAM', 50, 35], ['RW', 85, 33], ['ST', 50, 15]],
  '3-5-2':   [['GK', 50, 90], ['CB', 25, 71], ['CB', 50, 73], ['CB', 75, 71], ['LWB', 9, 47], ['CM', 31, 48], ['CDM', 50, 54], ['CM', 69, 48], ['RWB', 91, 47], ['ST', 37, 18], ['ST', 63, 18]],
  '3-4-3':   [['GK', 50, 90], ['CB', 25, 71], ['CB', 50, 73], ['CB', 75, 71], ['LM', 11, 46], ['CM', 37, 51], ['CM', 63, 51], ['RM', 89, 46], ['LW', 18, 22], ['ST', 50, 16], ['RW', 82, 22]],
  '5-3-2':   [['GK', 50, 90], ['LWB', 9, 63], ['CB', 29, 71], ['CB', 50, 73], ['CB', 71, 71], ['RWB', 91, 63], ['CM', 27, 46], ['CM', 50, 51], ['CM', 73, 46], ['ST', 37, 18], ['ST', 63, 18]],
};
export const DEFAULT_FORMATION = '4-3-3';

export const POS_ROLE = {
  'Goalkeeper': 'GK', 'Centre-Back': 'CB', 'Left-Back': 'LB', 'Right-Back': 'RB',
  'Defensive Midfield': 'CDM', 'Central Midfield': 'CM', 'Attacking Midfield': 'CAM',
  'Left Midfield': 'LM', 'Right Midfield': 'RM', 'Left Winger': 'LW', 'Right Winger': 'RW',
  'Centre-Forward': 'ST', 'Second Striker': 'ST',
};
export const GROUP = { GK: 'GK', CB: 'DEF', LB: 'DEF', RB: 'DEF', LWB: 'DEF', RWB: 'DEF', CDM: 'MID', CM: 'MID', CAM: 'MID', LM: 'MID', RM: 'MID', LW: 'FWD', RW: 'FWD', ST: 'FWD' };
const ADJ = {
  GK: [], CB: ['CDM', 'LB', 'RB'], LB: ['LWB', 'RB', 'CB', 'LM'], RB: ['RWB', 'LB', 'CB', 'RM'],
  LWB: ['LB', 'LM', 'LW'], RWB: ['RB', 'RM', 'RW'],
  CDM: ['CM', 'CB'], CM: ['CDM', 'CAM'], CAM: ['CM', 'LW', 'RW', 'ST'],
  LM: ['LW', 'LB', 'LWB', 'CM'], RM: ['RW', 'RB', 'RWB', 'CM'],
  LW: ['LM', 'RW', 'CAM', 'ST'], RW: ['RM', 'LW', 'CAM', 'ST'], ST: ['LW', 'RW', 'CAM'],
};
export const roleOf = p => POS_ROLE[p.pos] || 'CM';
export const fitOf = (p, role) => roleOf(p) === role ? 'natural' : (ADJ[role] || []).includes(roleOf(p)) ? 'ok' : 'off';

// Best empty slot index for a player in a given formation/XI (null if full).
export function bestEmptySlot(p, formation, xi) {
  let best = null, bestScore = -1;
  FORMATIONS[formation].forEach(([role], i) => {
    if (xi[i]) return;
    const fit = fitOf(p, role);
    const score = fit === 'natural' ? 3 : fit === 'ok' ? 2 : GROUP[role] === GROUP[roleOf(p)] ? 1 : 0;
    if (score > bestScore) { bestScore = score; best = i; }
  });
  return best;
}

// Re-seat an XI into a new formation: same position group first, then the closest spot.
export function remapXi(xi, fromFormation, toFormation) {
  const oldF = FORMATIONS[fromFormation], newF = FORMATIONS[toFormation];
  const placed = xi.map((id, i) => id && { id, role: oldF[i][0], x: oldF[i][1], y: oldF[i][2] }).filter(Boolean);
  const pairs = [];
  placed.forEach(p => newF.forEach(([role, x, y], j) => {
    pairs.push({ p, j, cost: (GROUP[role] === GROUP[p.role] ? 0 : 1000) + (role === p.role ? 0 : 20) + Math.abs(x - p.x) + Math.abs(y - p.y) * 0.6 });
  }));
  pairs.sort((a, b) => a.cost - b.cost);
  const out = Array(11).fill(null), used = new Set();
  for (const { p, j } of pairs) { if (out[j] || used.has(p.id)) continue; out[j] = p.id; used.add(p.id); }
  return out;
}

// Kit colours each side can choose from (host defaults to red, guest to blue).
export const KIT_COLORS = ['#e3262f', '#2563eb', '#f5b301', '#16a34a', '#f8fafc', '#111827', '#7c3aed', '#ea580c', '#0891b2', '#db2777'];
