// A realistic full mock match for developing / testing the renderer (not used in production).
import { PLAYERS } from '../../../shared/players.js';
import { FORMATIONS } from '../../../shared/game.js';

const byName = new Map(PLAYERS.map(p => [p.name, p]));
function team(name, color, formation, names) {
  const f = FORMATIONS[formation];
  return {
    name, color, formation,
    players: names.map((n, i) => {
      const p = byName.get(n);
      return { id: p?.id || n, name: n, role: f[i][0], img: p?.img || '', value: p?.value || null };
    }),
  };
}

export const MOCK_TEAMS = {
  A: team('Ege Galácticos', '#e3262f', '4-3-3', [
    'Uğurcan Çakır', 'Ismail Jakobs', 'Davinson Sánchez', 'Milan Škriniar', 'Nélson Semedo',
    'Gabriel Sara', "N'Golo Kanté", 'İlkay Gündoğan', 'Rafael Leão', 'Victor Osimhen', 'Mason Greenwood',
  ]),
  B: team('Boğaz United', '#2563eb', '4-2-3-1', [
    'Ederson', 'Archie Brown', 'Nathan Aké', 'Abdülkerim Bardakcı', 'Wilfried Singo',
    'Wilfred Ndidi', 'Orkun Kökçü', 'Leandro Trossard', 'Marco Asensio', 'Mohamed Salah', 'Dušan Vlahović',
  ]),
};

// Key moments; every other minute gets a generated commentary beat.
const KEY = [
  [1, 0, 'kickoff', 'A', null, null, 'center', 'Osimhen rolls it back to Gündoğan and we are under way on neutral ground!'],
  [4, 0, 'chance', 'B', 'Mohamed Salah', 'Orkun Kökçü', 'right', 'Kökçü threads it to Salah, who cuts inside and curls just wide.'],
  [7, 0, 'corner', 'A', 'Davinson Sánchez', 'Mason Greenwood', 'left', 'Greenwood whips in a corner, Sánchez rises but heads over.'],
  [9, 0, 'foul', 'B', 'Wilfred Ndidi', null, 'center', 'Ndidi clips Kanté in midfield. Free kick.'],
  [12, 0, 'save', 'A', 'Victor Osimhen', 'Rafael Leão', 'left', 'Leão bursts down the left, squares for Osimhen — Ederson spreads himself and saves!'],
  [16, 0, 'goal', 'B', 'Dušan Vlahović', 'Leandro Trossard', 'left', 'Trossard cuts back and Vlahović smashes it into the roof of the net! 0-1!'],
  [19, 0, 'yellow', 'A', 'Nélson Semedo', null, 'left', 'Semedo goes into the book for a cynical tug on Trossard.'],
  [22, 0, 'free_kick', 'A', 'Mason Greenwood', null, 'right', 'Greenwood steps up from 25 yards… Ederson tips it over!'],
  [25, 0, 'woodwork', 'B', 'Marco Asensio', null, 'center', 'Asensio lets fly from distance — it cannons back off the post!'],
  [28, 0, 'offside', 'A', 'Victor Osimhen', null, 'center', 'Osimhen times his run a fraction early. Flag up.'],
  [31, 0, 'goal', 'A', 'Rafael Leão', 'İlkay Gündoğan', 'left', 'Gündoğan finds Leão in stride, he skips past Singo and slots it home! 1-1!'],
  [34, 0, 'block', 'B', 'Mohamed Salah', null, 'right', 'Salah shapes to shoot but Škriniar throws himself in the way.'],
  [37, 0, 'injury', 'B', 'Nathan Aké', null, null, 'Aké needs treatment after a clash of heads. He will carry on.'],
  [40, 0, 'shot', 'A', 'Gabriel Sara', null, 'center', 'Sara tries his luck from range, dragging it wide.'],
  [43, 0, 'yellow', 'B', 'Orkun Kökçü', null, 'center', 'Kökçü booked for stopping a counter.'],
  [45, 2, 'chance', 'A', 'Mason Greenwood', 'Victor Osimhen', 'right', 'Last action of the half: Greenwood cuts in, his shot flashes past the far post.'],
  [45, 3, 'half_time', null, null, null, null, 'Half-time: 1-1 after an end-to-end 45 minutes.'],
  [46, 0, 'second_half', null, null, null, null, 'We go again — Boğaz United get the second half started.'],
  [49, 0, 'corner', 'B', 'Nathan Aké', 'Marco Asensio', 'left', 'Asensio corner, Aké meets it — Çakır claims under pressure.'],
  [52, 0, 'var', 'A', 'Victor Osimhen', null, 'center', 'VAR checking a possible penalty after Bardakcı went through Osimhen…'],
  [53, 0, 'penalty_goal', 'A', 'Victor Osimhen', null, 'center', 'Penalty given! Osimhen sends Ederson the wrong way. 2-1!'],
  [57, 0, 'save', 'B', 'Dušan Vlahović', 'Mohamed Salah', 'right', 'Salah slips Vlahović in, but Çakır is out quickly to block with his legs!'],
  [61, 0, 'second_yellow', 'B', 'Orkun Kökçü', null, 'center', 'Second yellow for Kökçü — a late lunge on Kanté. Boğaz United down to ten!'],
  [64, 0, 'free_kick', 'A', 'İlkay Gündoğan', null, 'center', 'Gündoğan over the free kick… it curls wide of the post.'],
  [68, 0, 'goal', 'B', 'Mohamed Salah', 'Leandro Trossard', 'right', 'Ten men level it! Salah dances past Jakobs and bends it in. 2-2!'],
  [71, 0, 'shot', 'B', 'Marco Asensio', null, 'center', 'Asensio skies one from the edge of the box.'],
  [74, 0, 'chance', 'A', 'Rafael Leão', 'Victor Osimhen', 'left', 'Osimhen lays it off to Leão, whose shot is deflected wide.'],
  [77, 0, 'red', 'A', 'Davinson Sánchez', null, 'center', 'Straight red for Sánchez! Last man, denying Vlahović a clear run on goal.'],
  [80, 0, 'save', 'B', 'Leandro Trossard', null, 'left', 'Trossard\'s low drive is turned around the post by Çakır.'],
  [83, 0, 'penalty_miss', 'B', 'Dušan Vlahović', null, 'center', 'Penalty to Boğaz United… Vlahović hits it high — Çakır saves!'],
  [87, 0, 'goal', 'A', 'Mason Greenwood', 'Rafael Leão', 'right', 'Greenwood! A stunning half-volley from Leão\'s cross. 3-2!'],
  [90, 2, 'own_goal', 'B', 'Milan Škriniar', null, 'right', 'Drama! Salah\'s cross deflects off Škriniar and into his own net. 3-3!'],
  [90, 4, 'woodwork', 'A', 'Victor Osimhen', null, 'center', 'Osimhen\'s header crashes against the bar with the last touch!'],
  [90, 5, 'full_time', null, null, null, null, 'Full-time! A breathless 3-3 on neutral ground.'],
];

const FILLER = [
  ['possession', 'patient spell of possession, probing for an opening.'],
  ['possession', 'switch the play from flank to flank.'],
  ['foul', 'concede a soft free kick in midfield.'],
  ['possession', 'press high and win it back quickly.'],
  ['possession', 'work it out from the back under pressure.'],
];

function buildItems() {
  const items = [{ kind: 'meta', data: { kickoff: 'A', referee: 'Clément Turpin', weather: 'Clear, 18°C', headline: 'Süper Lig all-stars collide on neutral ground' } }];
  const keyAt = new Map();
  KEY.forEach(k => { const key = `${k[0]}+${k[1]}`; if (!keyAt.has(key)) keyAt.set(key, []); keyAt.get(key).push(k); });
  const names = { A: MOCK_TEAMS.A.name, B: MOCK_TEAMS.B.name };
  const push = (min, add, type, side, player, assist, zone, text) => items.push({ kind: 'ev', data: { min, add, type, side, player, assist, zone, text } });
  const stoppage = { 45: 3, 90: 5 };
  for (let m = 1; m <= 90; m++) {
    const adds = stoppage[m] ? Array.from({ length: stoppage[m] + 1 }, (_, i) => i) : [0];
    for (const a of adds) {
      const keys = keyAt.get(`${m}+${a}`);
      if (keys) keys.forEach(k => push(...k));
      else if (!(m === 46 && a === 0)) {
        const [type, tail] = FILLER[(m * 7 + a) % FILLER.length];
        const side = (m * 3 + a) % 5 < 3 ? 'A' : 'B';
        const zone = ['left', 'center', 'right'][(m + a) % 3];
        push(m, a, type, side, null, null, zone, `${names[side]} ${tail}`);
        if (m % 6 === 0 && a === 0) push(m, 0, 'possession', side === 'A' ? 'B' : 'A', null, null, zone, `${names[side === 'A' ? 'B' : 'A']} try to slow the tempo.`);
      }
    }
  }
  items.push({ kind: 'stats', data: {
    possession: [54, 46], shots: [14, 12], on_target: [6, 5], xg: [2.41, 2.08], corners: [6, 4], fouls: [11, 14], offsides: [3, 1], yellow: [1, 2], red: [1, 1],
    motm: { side: 'A', player: 'Rafael Leão', reason: 'A goal and an assist, constantly isolating Singo and creating the best chances of the night.' },
  } });
  items.push({ kind: 'ratings', data: {
    A: MOCK_TEAMS.A.players.map((p, i) => ({ player: p.name, rating: [6.8, 6.6, 5.1, 6.4, 6.5, 6.9, 7.2, 7.4, 8.7, 7.9, 8.1][i] })),
    B: MOCK_TEAMS.B.players.map((p, i) => ({ player: p.name, rating: [6.9, 6.7, 6.6, 5.9, 6.3, 6.8, 5.4, 7.6, 6.9, 8.4, 7.7][i] })),
  } });
  items.push({ kind: 'analysis', data: {
    side: 'A', summary: 'Explosive on the break, fragile when stretched.',
    strengths: ['Elite transition speed through Leão and Greenwood', 'Kanté and Gündoğan control the tempo', 'Osimhen gives a constant aerial outlet'],
    weaknesses: ['High line exposed by quick through balls', 'Centre-backs prone to rash challenges', 'Little creativity once the press is beaten'],
    resembles: { club: 'Napoli', league: 'Serie A', why: 'Direct, vertical football built around a powerful No.9 and wide runners who attack space.' },
  } });
  items.push({ kind: 'analysis', data: {
    side: 'B', summary: 'Technical and patient, but lacking legs in midfield.',
    strengths: ['Salah and Trossard are lethal cutting inside', 'Vlahović finishes everything in the box', 'Comfortable building from Ederson'],
    weaknesses: ['Kökçü–Ndidi pivot overrun in transition', 'Discipline: two bookings cost them a man', 'Full-backs leave space behind'],
    resembles: { club: 'Aston Villa', league: 'Premier League', why: 'Possession-based with inverted wingers and a classic target striker leading the line.' },
  } });
  items.push({ kind: 'end', data: {} });
  return items;
}

export const MOCK_ITEMS = buildItems();
