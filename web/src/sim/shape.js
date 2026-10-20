// Teams, roles, playing styles and team shape (where each player wants to be).
import { FORMATIONS } from '../../../shared/game.js';
import { L, WD, clamp, other, baseOf, sideOf, toWorld, toTeam } from './const.js';

export const ROLE = {
  GK:  { depth: 0, push: 0 },
  CB:  { depth: 0, push: 0.02 },
  LB:  { depth: 0.05, push: 0.34, wide: true }, RB: { depth: 0.05, push: 0.34, wide: true },
  LWB: { depth: 0.2, push: 0.42, wide: true }, RWB: { depth: 0.2, push: 0.42, wide: true },
  CDM: { depth: 0.3, push: 0.06 },
  CM:  { depth: 0.46, push: 0.14 },
  CAM: { depth: 0.66, push: 0.12 },
  LM:  { depth: 0.52, push: 0.2, wide: true }, RM: { depth: 0.52, push: 0.2, wide: true },
  LW:  { depth: 0.84, push: 0.12, wide: true }, RW: { depth: 0.84, push: 0.12, wide: true },
  ST:  { depth: 1, push: 0 },
};
export const DEFENDERS = new Set(['CB', 'LB', 'RB', 'LWB', 'RWB']);
export const FORWARDS = new Set(['ST', 'LW', 'RW', 'CAM']);
// Top speed (m/s) by role; age adjusts it.
export const ROLE_SPEED = { GK: 7.0, CB: 7.6, LB: 8.4, RB: 8.4, LWB: 8.5, RWB: 8.5, CDM: 7.8, CM: 8.0, CAM: 8.1, LM: 8.3, RM: 8.3, LW: 8.8, RW: 8.8, ST: 8.5 };

const DEFAULT_STYLE = { line: 'mid', press: 'mid', width: 'normal', tempo: 'medium', build: 'mixed' };
export function normStyle(s = {}) {
  const pick = (v, ok, d) => (ok.includes(v) ? v : d);
  return {
    line: pick(s.line, ['high', 'mid', 'deep'], 'mid'),
    press: pick(s.press, ['high', 'mid', 'low'], 'mid'),
    width: pick(s.width, ['wide', 'normal', 'narrow'], 'normal'),
    tempo: pick(s.tempo, ['fast', 'medium', 'slow'], 'medium'),
    build: pick(s.build, ['short', 'mixed', 'direct'], 'mixed'),
    label: typeof s.style === 'string' ? s.style.slice(0, 40) : '',
  };
}

export function prepareTeam(side, team, style) {
  const f = FORMATIONS[team.formation] || FORMATIONS['4-3-3'];
  return {
    side, name: team.name, color: team.color, formation: team.formation,
    style: normStyle(style || DEFAULT_STYLE),
    players: team.players.map((p, i) => {
      const role = f[i][0];
      return { ...p, role, slot: i, agent: baseOf(side) + i, v0: (f[i][1] / 100) * WD, info: ROLE[role] || ROLE.CM };
    }),
  };
}
export function makeMatch(teamsIn, styles) {
  return { teams: { A: prepareTeam('A', teamsIn.A, styles?.A), B: prepareTeam('B', teamsIn.B, styles?.B) }, dir: { A: 1, B: -1 } };
}
export function withHalf(M, half) { return { ...M, dir: half === 1 ? { A: 1, B: -1 } : { A: -1, B: 1 } }; }

export function defLineOf(team, bu, inPos) {
  const off = team.style.line === 'high' ? 7 : team.style.line === 'deep' ? -7 : 0;
  if (inPos) return clamp(bu - 30 + off, 16, 55);
  return Math.min(clamp(bu - 21 + off * 0.6, 7.5, 46), Math.max(7.5, bu - 4));
}
// Where a player wants to stand given the ball and who has it (pure function).
export function shapeTarget(M, side, slot, ball, possSide) {
  const team = M.teams[side], p = team.players[slot], dir = M.dir[side];
  const { u: bu, v: bv } = toTeam(dir, ball.x, ball.y);
  const inPos = possSide === side;
  if (p.role === 'GK') {
    if (inPos) {
      const u = clamp(bu * 0.17, 4, team.style.line === 'high' ? 17 : 12);
      return toWorld(dir, u, 34 + (bv - 34) * 0.12);
    }
    const dx = bu, dy = bv - 34, d = Math.hypot(dx, dy) || 1;
    const gd = bu < 36 ? clamp(1.1 + d * 0.1, 1.1, 5.5) : clamp(5 + (bu - 36) * 0.1, 5, team.style.line === 'high' ? 13 : 10);
    const u = clamp((dx / d) * gd, 0.6, 16), v = clamp(34 + (dy / d) * gd, 15, 53);
    return toWorld(dir, u, v);
  }
  const opp = M.teams[other(side)];
  const defLine = defLineOf(team, bu, inPos);
  if (inPos) {
    const oppLine = L - defLineOf(opp, L - bu, false);
    const limit = Math.max(52.5, oppLine - 0.7, bu - 1);
    const attLine = Math.min(clamp(bu + 13, defLine + 24, 96), limit);
    const d = clamp(p.info.depth + p.info.push, 0, 1.05);
    const u = Math.min(defLine + d * (attLine - defLine), limit);
    const wf = team.style.width === 'wide' ? 1.2 : team.style.width === 'narrow' ? 0.95 : 1.1;
    const v = 34 + (p.v0 - 34) * wf + (bv - 34) * 0.22;
    return toWorld(dir, clamp(u, 2, 103), clamp(v, 1.5, 66.5));
  }
  const compact = team.style.press === 'high' ? 33 : team.style.press === 'low' ? 23 : 28;
  const attLine = defLine + compact;
  const u = defLine + p.info.depth * (attLine - defLine);
  const wf = team.style.width === 'narrow' ? 0.74 : 0.82;
  const v = 34 + (p.v0 - 34) * wf + (bv - 34) * 0.42;
  return toWorld(dir, clamp(u, 1.5, 103), clamp(v, 2, 66));
}

const norm = s => String(s || '').toLocaleLowerCase('tr').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ı/g, 'i').trim();
export function findAgent(M, side, name) {
  if (!name || !side) return null;
  const n = norm(name), team = M.teams[side];
  let p = team.players.find(x => norm(x.name) === n);
  if (!p) { const last = n.split(' ').pop(); p = team.players.find(x => norm(x.name).split(' ').pop() === last) || team.players.find(x => norm(x.name).includes(n) || n.includes(norm(x.name))); }
  return p ? p.agent : null;
}
export function byRoles(M, side, roles, sent, exclude = []) {
  const out = [];
  for (const r of roles) for (const p of M.teams[side].players) if (p.role === r && !sent.has(p.agent) && !exclude.includes(p.agent) && !out.includes(p.agent)) out.push(p.agent);
  return out;
}
export function pick(M, side, roles, sent, exclude = []) {
  const r = byRoles(M, side, roles, sent, exclude)[0];
  if (r != null) return r;
  const any = M.teams[side].players.find(p => p.role !== 'GK' && !sent.has(p.agent) && !exclude.includes(p.agent));
  return any ? any.agent : baseOf(side) + 1;
}
export const playerOf = (M, a) => M.teams[sideOf(a)].players[a - baseOf(sideOf(a))];
export const roleOf = (M, a) => (a < 22 ? playerOf(M, a).role : 'REF');
export const gkOf = (M, side) => M.teams[side].players.find(p => p.role === 'GK')?.agent ?? baseOf(side);
