// A realistic mock match in the GPT-6.1 Sol JSON Lines format, used by the lab page and tests.
import { PLAYERS } from '../../../shared/players.js';
import { FORMATIONS } from '../../../shared/game.js';

const byName = n => PLAYERS.find(p => p.name === n);
function team(name, color, formation, names) {
  return {
    name, color, formation,
    players: names.map((n, i) => {
      const p = byName(n) || PLAYERS[i];
      return { id: p.id, name: p.name, role: FORMATIONS[formation][i][0], img: p.img, value: p.value, num: p.num, foot: p.foot, age: p.age, height: p.height, club: p.clubName };
    }),
  };
}
const gk = (club) => PLAYERS.find(p => p.club === club && p.pos === 'Goalkeeper').name;
const pickPos = (club, pos, n = 1, skip = 0) => PLAYERS.filter(p => p.club === club && p.pos === pos).slice(skip, skip + n).map(p => p.name);

const A_NAMES = [gk('mci'), ...pickPos('ars', 'Left-Back'), ...pickPos('liv', 'Centre-Back'), ...pickPos('rma', 'Centre-Back'), ...pickPos('bar', 'Right-Back'),
  ...pickPos('mci', 'Central Midfield'), ...pickPos('liv', 'Defensive Midfield'), ...pickPos('ars', 'Central Midfield'), ...pickPos('bar', 'Left Winger'), ...pickPos('mci', 'Centre-Forward'), ...pickPos('liv', 'Right Winger')];
const B_NAMES = [gk('gs'), ...pickPos('fb', 'Left-Back'), ...pickPos('gs', 'Centre-Back'), ...pickPos('bjk', 'Centre-Back'), ...pickPos('ts', 'Right-Back'),
  ...pickPos('fb', 'Defensive Midfield'), ...pickPos('bjk', 'Central Midfield'), ...pickPos('gs', 'Left Winger'), ...pickPos('fb', 'Attacking Midfield'), ...pickPos('gs', 'Right Winger'), ...pickPos('gs', 'Centre-Forward')];

export const MOCK_TEAMS = {
  A: team('Ege Galácticos', '#e3262f', '4-3-3', A_NAMES),
  B: team('Burak Boğazları', '#2563eb', '4-2-3-1', B_NAMES),
};
const A = MOCK_TEAMS.A.players.map(p => p.name), B = MOCK_TEAMS.B.players.map(p => p.name);
const ev = (d) => ({ kind: 'ev', data: d });
export const MOCK_ITEMS = [
  { kind: 'meta', data: { kickoff: 'A', referee: 'Cüneyt Çakır', weather: 'Clear, 14°C, light breeze', headline: 'Premier League polish against Süper Lig fire on neutral ground.', styles: {
    A: { style: 'possession', line: 'high', press: 'high', width: 'wide', tempo: 'medium', build: 'short' },
    B: { style: 'counter-attack', line: 'deep', press: 'mid', width: 'narrow', tempo: 'fast', build: 'direct' } } } },
  { kind: 'flow', data: { from: 1, to: 10, momentum: 'A', possession: [64, 36], note: `${MOCK_TEAMS.A.name} keep the ball, ${MOCK_TEAMS.B.name} sit in a compact block.` } },
  ev({ min: 4, add: 0, type: 'foul', side: 'A', player: A[8], offender: B[4], x: 58, y: 18, card: null, text: `${B[4]} clips ${A[8]} on the touchline.` }),
  ev({ min: 9, add: 0, type: 'shot', side: 'A', player: A[9], assist: A[5], x: 89, y: 46, outcome: 'goal', target: 'bottom_left', body: 'right', technique: 'placed', assist_type: 'through_ball', build_up: 'possession', xg: 0.42, text: `${A[5]} threads it through and ${A[9]} slots it into the bottom corner!` }),
  ev({ min: 17, add: 0, type: 'shot', side: 'B', player: B[10], assist: B[7], x: 93, y: 41, outcome: 'saved', target: 'top_left', body: 'head', technique: 'header', assist_type: 'cross', build_up: 'counter', xg: 0.31, text: `${B[7]} whips it in, ${B[10]} heads goalwards — brilliant save from ${A[0]}!` }),
  ev({ min: 23, add: 0, type: 'offside', side: 'B', player: B[10], assist: B[8], x: 84, y: 36, text: `${B[10]} is caught a yard offside as he breaks clear.` }),
  ev({ min: 29, add: 0, type: 'foul', side: 'A', player: A[10], offender: B[5], x: 79, y: 40, card: 'yellow', text: `${B[5]} cynically drags back ${A[10]} — booked.` }),
  ev({ min: 30, add: 0, type: 'shot', side: 'A', player: A[7], x: 79, y: 40, outcome: 'woodwork', target: 'top_right', technique: 'free_kick', assist_type: 'free_kick', body: 'right', xg: 0.07, text: `${A[7]} curls the free kick over the wall… off the crossbar!` }),
  ev({ min: 38, add: 0, type: 'shot', side: 'B', player: B[8], x: 75, y: 50, outcome: 'off_target', target: 'wide_right', technique: 'long_range', build_up: 'counter', assist_type: 'solo', xg: 0.04, text: `${B[8]} lets fly from distance, just wide.` }),
  ev({ min: 45, add: 1, type: 'corner', side: 'A', player: A[7], y: 92, text: 'Corner for the Galácticos, headed away.' }),
  ev({ min: 45, add: 2, type: 'half_time', text: 'Half-time: the Galácticos lead through that early goal.' }),
  { kind: 'flow', data: { from: 46, to: 55, momentum: 'B', possession: [45, 55], note: `${MOCK_TEAMS.B.name} come out flying after the break.` } },
  ev({ min: 52, add: 0, type: 'foul', side: 'B', player: B[10], offender: A[3], x: 92, y: 30, penalty: true, card: null, text: `${A[3]} brings down ${B[10]} in the box — penalty!` }),
  ev({ min: 53, add: 0, type: 'shot', side: 'B', player: B[10], x: 89, y: 50, outcome: 'goal', target: 'bottom_right', technique: 'penalty', assist_type: 'penalty', body: 'right', xg: 0.79, text: `${B[10]} sends ${A[0]} the wrong way. All square!` }),
  ev({ min: 61, add: 0, type: 'foul', side: 'A', player: A[9], offender: B[5], x: 66, y: 55, card: 'yellow', text: `${B[5]} goes through the back of ${A[9]} — second yellow, he's off!` }),
  ev({ min: 70, add: 0, type: 'shot', side: 'A', player: A[10], assist: A[1], x: 88, y: 30, outcome: 'disallowed', reason: 'offside', target: 'bottom_right', assist_type: 'cross', body: 'left', xg: 0.35, text: `${A[10]} finishes — but the flag is up. Offside, no goal.` }),
  ev({ min: 78, add: 0, type: 'shot', side: 'A', player: A[8], assist: A[6], x: 86, y: 22, outcome: 'parried', target: 'bottom_left', assist_type: 'short_pass', body: 'right', xg: 0.22, text: `${A[8]} cuts inside and drills it low — parried wide.` }),
  ev({ min: 84, add: 0, type: 'shot', side: 'A', player: A[9], assist: A[10], x: 91, y: 37, outcome: 'goal', target: 'top_left', body: 'head', technique: 'header', assist_type: 'cross', build_up: 'possession', xg: 0.38, text: `${A[10]} crosses and ${A[9]} rises to power a header into the top corner!` }),
  ev({ min: 90, add: 3, type: 'shot', side: 'B', player: B[10], x: 84, y: 34, outcome: 'blocked', assist_type: 'short_pass', assist: B[8], xg: 0.12, text: 'Last-gasp effort blocked!' }),
  ev({ min: 90, add: 4, type: 'full_time', text: 'Full time! The Galácticos edge it.' }),
  { kind: 'stats', data: { possession: [61, 39], shots: [13, 8], on_target: [6, 3], xg: [1.92, 1.31], corners: [7, 3], fouls: [9, 14], offsides: [2, 3], yellow: [0, 2], red: [0, 1], motm: { side: 'A', player: A[9], reason: 'Two clinical finishes and a constant threat in behind.' } } },
  { kind: 'ratings', data: { A: A.map((p, i) => ({ player: p, rating: [7.4, 6.8, 7.0, 6.2, 6.9, 7.6, 7.1, 7.3, 7.5, 8.9, 7.8][i] })), B: B.map((p, i) => ({ player: p, rating: [7.2, 6.3, 6.6, 6.5, 6.0, 4.9, 6.4, 6.8, 6.9, 6.7, 7.4][i] })) } },
  { kind: 'analysis', data: { side: 'A', summary: 'Patient possession with a high press and quick combinations around the box.', strengths: ['Press wins the ball high', 'Overloads the half-spaces', 'Ruthless finishing'], weaknesses: ['High line exposed by direct balls', 'Conceded a soft penalty', 'Slow to kill the game'], resembles: { club: 'Manchester City', league: 'Premier League', why: 'Positional play, inverted full-backs and a striker who lives in the box.' } } },
  { kind: 'analysis', data: { side: 'B', summary: 'Compact and direct, dangerous on the break until the red card.', strengths: ['Fast transitions', 'Aerial threat from crosses', 'Spirited after half-time'], weaknesses: ['Indiscipline in midfield', 'Too passive without the ball', 'Isolated striker'], resembles: { club: 'Atlético Madrid', league: 'LaLiga', why: 'A deep, narrow block that springs forward through quick wide runners.' } } },
  { kind: 'end', data: {} },
];
