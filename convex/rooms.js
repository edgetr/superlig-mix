import { ConvexError, v } from 'convex/values';
import { mutation, query, internalMutation } from './_generated/server';
import { internal } from './_generated/api';
import { PLAYERS } from '../shared/players.js';
import { FORMATIONS, DEFAULT_FORMATION, KIT_COLORS, bestEmptySlot, remapXi, fitOf } from '../shared/game.js';

const byId = new Map(PLAYERS.map(p => [p.id, p]));
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const TOTAL_PICKS = 22;
const fail = msg => { throw new ConvexError(msg); };

// ------------------------------------------------------------------ helpers

async function member(ctx, roomId, key) {
  const room = await ctx.db.get(roomId);
  if (!room) fail('This room no longer exists.');
  if (room.status === 'closed') fail('This game has ended.');
  if (key && key === room.hostKey) return { room, role: 'host' };
  if (key && key === room.guestKey) return { room, role: 'guest' };
  fail('You are not part of this room.');
}
const other = role => (role === 'host' ? 'guest' : 'host');
const cleanName = (s, fallback, max = 24) => (String(s || '').replace(/\s+/g, ' ').trim().slice(0, max) || fallback);
const emptyXi = () => Array(11).fill(null);
const takenIds = room => new Set([...room.host.xi, ...(room.guest?.xi || [])].filter(Boolean));
const count = xi => xi.filter(Boolean).length;

function newSide(name, teamName, color) {
  return { name, teamName, formation: DEFAULT_FORMATION, color, xi: emptyXi(), lastSeen: Date.now() };
}

// Sanitised room for clients (never leaks keys; only the host sees the helper's account email).
function view(room, role) {
  const strip = s => s && { name: s.name, teamName: s.teamName, formation: s.formation, color: s.color, xi: s.xi, lastSeen: s.lastSeen, away: !!s.awayAt };
  const c = room.companion;
  return {
    _id: room._id, code: room.code, round: room.round, status: room.status, you: role,
    closedBy: room.closedBy ?? null, closedReason: room.closedReason ?? null, closedByYou: room.closedRole === role,
    host: strip(room.host), guest: strip(room.guest) || null,
    pickTimer: room.pickTimer, pickNo: room.pickNo, turn: room.turn, turnDeadline: room.turnDeadline ?? null,
    picks: room.picks, guestReady: room.guestReady,
    companion: c ? { lastSeen: c.lastSeen, signedIn: c.signedIn, planUsage: c.planUsage, model: c.model, busy: c.busy, version: c.version, email: role === 'host' ? c.email ?? null : null } : null,
    sim: room.sim, playback: room.playback, serverNow: Date.now(),
  };
}

async function scheduleTimer(ctx, room) {
  if (!room.pickTimer || room.turn === 'done') return undefined;
  const deadline = Date.now() + room.pickTimer * 1000;
  await ctx.scheduler.runAfter(room.pickTimer * 1000, internal.rooms.autoPick, { roomId: room._id, pickNo: room.pickNo, round: room.round });
  return deadline;
}

// Applies a pick for `role`, validating every rule server-side.
async function applyPick(ctx, room, role, playerId, slot, auto) {
  if (room.status !== 'draft') fail('The draft is not running.');
  if (room.turn !== role) fail("It's not your turn.");
  const p = byId.get(playerId);
  if (!p) fail('Unknown player.');
  if (takenIds(room).has(playerId)) fail(`${p.name} has already been picked.`);
  const me = { ...room[role], xi: [...room[role].xi] };
  if (count(me.xi) >= 11) fail('Your XI is already full.');
  let i = Number.isInteger(slot) && slot >= 0 && slot < 11 && !me.xi[slot] ? slot : bestEmptySlot(p, me.formation, me.xi);
  if (i == null) fail('Your XI is already full.');
  me.xi[i] = playerId;

  const pickNo = room.pickNo + 1;
  const turn = pickNo >= TOTAL_PICKS ? 'done' : other(role);
  const patch = {
    [role]: me, pickNo, turn,
    picks: [...room.picks, { side: role, playerId, n: pickNo, at: Date.now(), auto }],
    updatedAt: Date.now(),
  };
  const next = { ...room, ...patch };
  patch.turnDeadline = await scheduleTimer(ctx, next);
  await ctx.db.patch(room._id, patch);
  return { slot: i, pickNo };
}

// "Pick for me" / timer auto-pick: the most valuable available player who naturally fits an open
// position in your formation (then an adapted fit, then anyone).
function bestAvailable(room, role) {
  const taken = takenIds(room);
  const me = room[role];
  const f = FORMATIONS[me.formation];
  const open = f.map(([r], i) => (me.xi[i] ? null : r)).filter(Boolean);
  const free = PLAYERS.filter(p => !taken.has(p.id)).sort((a, b) => b.valueEur - a.valueEur || a.name.localeCompare(b.name));
  for (const want of ['natural', 'ok']) {
    const hit = free.find(p => open.some(r => fitOf(p, r) === want));
    if (hit) return hit.id;
  }
  return free[0]?.id;
}

// ------------------------------------------------------------------ lobby

export const create = mutation({
  args: { key: v.string(), name: v.string() },
  handler: async (ctx, { key, name }) => {
    if (key.length < 20) fail('Bad key.');
    let code;
    for (let tries = 0; tries < 20; tries++) {
      code = Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
      const clash = await ctx.db.query('rooms').withIndex('by_code', q => q.eq('code', code)).first();
      if (!clash || clash.status === 'closed' || Date.now() - clash.updatedAt > 24 * 3600e3) break;
    }
    const n = cleanName(name, 'Host');
    const now = Date.now();
    const roomId = await ctx.db.insert('rooms', {
      code, round: 1, status: 'lobby', hostKey: key,
      host: newSide(n, `${n} XI`, KIT_COLORS[0]),
      pickTimer: 0, pickNo: 0, turn: 'host', picks: [], guestReady: false,
      sim: { state: 'idle', jobId: '' }, playback: { playing: false, pos: 0, at: now, rate: 1 },
      createdAt: now, updatedAt: now,
    });
    return { roomId, code };
  },
});

export const join = mutation({
  args: { code: v.string(), key: v.string(), name: v.string() },
  handler: async (ctx, { code, key, name }) => {
    const room = await ctx.db.query('rooms').withIndex('by_code', q => q.eq('code', code.toUpperCase().trim())).order('desc').first();
    if (!room) fail('No game with that code. Check the code and try again.');
    if (room.status === 'closed') fail('That game has ended. Ask your rival to start a new one.');
    if (room.hostKey === key) return { roomId: room._id, role: 'host' };
    if (room.guestKey === key) return { roomId: room._id, role: 'guest' };
    if (room.guestKey) fail('This game already has two players.');
    if (key.length < 20) fail('Bad key.');
    const n = cleanName(name, 'Rival');
    const color = KIT_COLORS.find(c => c !== room.host.color) || KIT_COLORS[1];
    await ctx.db.patch(room._id, { guestKey: key, guest: newSide(n, `${n} XI`, color === KIT_COLORS[0] ? KIT_COLORS[1] : color), updatedAt: Date.now() });
    return { roomId: room._id, role: 'guest' };
  },
});

export const get = query({
  args: { roomId: v.id('rooms'), key: v.string() },
  handler: async (ctx, { roomId, key }) => {
    const room = await ctx.db.get(roomId);
    if (!room) return null;
    const role = key === room.hostKey ? 'host' : key === room.guestKey ? 'guest' : null;
    if (!role) return null;
    return view(room, role);
  },
});

export const heartbeat = mutation({
  args: { roomId: v.id('rooms'), key: v.string() },
  handler: async (ctx, { roomId, key }) => {
    const { room, role } = await member(ctx, roomId, key);
    const { awayAt, ...side } = room[role];
    await ctx.db.patch(roomId, { [role]: { ...side, lastSeen: Date.now() } });
    return Date.now();
  },
});

// ------------------------------------------------------------------ leaving
// A game lives only while both players have it open: leaving (Menu), closing the page, or losing
// the connection ends it for both.
const STALE_MS = 150_000;  // no heartbeat for this long = gone (background tabs beat ~once a minute)
const AWAY_GRACE_MS = 20_000; // a reload sends "away" then a heartbeat within a few seconds

async function closeRoom(ctx, room, role, reason) {
  if (room.status === 'closed') return;
  await ctx.db.patch(room._id, {
    status: 'closed', closedBy: room[role]?.name ?? '', closedReason: reason, closedRole: role,
    turnDeadline: undefined, guestReady: false, updatedAt: Date.now(),
  });
}

export const leave = mutation({
  args: { roomId: v.id('rooms'), key: v.string() },
  handler: async (ctx, { roomId, key }) => {
    const room = await ctx.db.get(roomId);
    if (!room) return;
    const role = key === room.hostKey ? 'host' : key === room.guestKey ? 'guest' : null;
    if (role) await closeRoom(ctx, room, role, 'left');
  },
});

// Sent by the page as it closes (navigator.sendBeacon → http.js). Closes the game unless the same
// player comes back (a reload) within the grace period.
export const away = internalMutation({
  args: { roomId: v.string(), key: v.string() },
  handler: async (ctx, { roomId, key }) => {
    const id = ctx.db.normalizeId('rooms', roomId);
    const room = id && await ctx.db.get(id);
    if (!room || room.status === 'closed') return;
    const role = key === room.hostKey ? 'host' : key === room.guestKey ? 'guest' : null;
    if (!role) return;
    const at = Date.now();
    await ctx.db.patch(id, { [role]: { ...room[role], awayAt: at } });
    await ctx.scheduler.runAfter(AWAY_GRACE_MS, internal.rooms.closeIfAway, { roomId: id, role, at });
  },
});

export const closeIfAway = internalMutation({
  args: { roomId: v.id('rooms'), role: v.string(), at: v.number() },
  handler: async (ctx, { roomId, role, at }) => {
    const room = await ctx.db.get(roomId);
    if (room?.[role]?.awayAt === at) await closeRoom(ctx, room, role, 'away');
  },
});

// Cron: close games where someone vanished without the page saying goodbye (crash, sleep, offline).
export const sweep = internalMutation({
  args: {},
  handler: async ctx => {
    const now = Date.now();
    for (const status of ['lobby', 'draft', 'lineups', 'match']) {
      const rooms = await ctx.db.query('rooms').withIndex('by_status', q => q.eq('status', status)).collect();
      for (const room of rooms) {
        const gone = ['host', 'guest'].find(r => room[r] && now - room[r].lastSeen > STALE_MS);
        if (gone) await closeRoom(ctx, room, gone, 'timeout');
      }
    }
  },
});

// Server clock for syncing playback between the two players.
export const now = mutation({ args: {}, handler: async () => Date.now() });

export const updateSide = mutation({
  args: { roomId: v.id('rooms'), key: v.string(), teamName: v.optional(v.string()), name: v.optional(v.string()), color: v.optional(v.string()) },
  handler: async (ctx, { roomId, key, teamName, name, color }) => {
    const { room, role } = await member(ctx, roomId, key);
    const me = { ...room[role] };
    if (teamName !== undefined) me.teamName = cleanName(teamName, me.teamName, 28);
    if (name !== undefined) me.name = cleanName(name, me.name);
    if (color !== undefined) {
      if (!KIT_COLORS.includes(color)) fail('Unknown kit colour.');
      if (room[other(role)]?.color === color) fail('Your rival already wears that colour.');
      me.color = color;
    }
    await ctx.db.patch(roomId, { [role]: me, updatedAt: Date.now() });
  },
});

export const setPickTimer = mutation({
  args: { roomId: v.id('rooms'), key: v.string(), seconds: v.number() },
  handler: async (ctx, { roomId, key, seconds }) => {
    const { room, role } = await member(ctx, roomId, key);
    if (role !== 'host') fail('Only the host can change this.');
    if (room.status !== 'lobby') fail('The draft has already started.');
    if (![0, 30, 45, 60, 90].includes(seconds)) fail('Unsupported timer.');
    await ctx.db.patch(roomId, { pickTimer: seconds });
  },
});

export const startDraft = mutation({
  args: { roomId: v.id('rooms'), key: v.string() },
  handler: async (ctx, { roomId, key }) => {
    const { room, role } = await member(ctx, roomId, key);
    if (role !== 'host') fail('Only the host can start the draft.');
    if (!room.guest) fail('Wait for your rival to join.');
    if (room.status !== 'lobby') return;
    const next = { ...room, status: 'draft', pickNo: 0, turn: 'host' };
    await ctx.db.patch(roomId, { status: 'draft', pickNo: 0, turn: 'host', picks: [], turnDeadline: await scheduleTimer(ctx, next), updatedAt: Date.now() });
  },
});

// ------------------------------------------------------------------ draft

export const pick = mutation({
  args: { roomId: v.id('rooms'), key: v.string(), playerId: v.string(), slot: v.optional(v.number()) },
  handler: async (ctx, { roomId, key, playerId, slot }) => {
    const { room, role } = await member(ctx, roomId, key);
    return applyPick(ctx, room, role, playerId, slot, false);
  },
});

// "Pick for me": best available player by market value.
export const autoPickMine = mutation({
  args: { roomId: v.id('rooms'), key: v.string() },
  handler: async (ctx, { roomId, key }) => {
    const { room, role } = await member(ctx, roomId, key);
    const id = bestAvailable(room, role);
    if (!id) fail('No players left.');
    return applyPick(ctx, room, role, id, undefined, true);
  },
});

// Pick timer ran out.
export const autoPick = internalMutation({
  args: { roomId: v.id('rooms'), pickNo: v.number(), round: v.number() },
  handler: async (ctx, { roomId, pickNo, round }) => {
    const room = await ctx.db.get(roomId);
    if (!room || room.status !== 'draft' || room.pickNo !== pickNo || room.round !== round || room.turn === 'done') return;
    const id = bestAvailable(room, room.turn);
    if (id) await applyPick(ctx, room, room.turn, id, undefined, true);
  },
});

// Rearrange your own players (free, any time before kick-off). `to` may be an empty slot.
export const swapSlots = mutation({
  args: { roomId: v.id('rooms'), key: v.string(), from: v.number(), to: v.number() },
  handler: async (ctx, { roomId, key, from, to }) => {
    const { room, role } = await member(ctx, roomId, key);
    if (room.status === 'match' || room.status === 'lineups') fail('Line-ups are locked.');
    if (![from, to].every(n => Number.isInteger(n) && n >= 0 && n < 11)) fail('Bad slot.');
    const me = { ...room[role], xi: [...room[role].xi] };
    [me.xi[from], me.xi[to]] = [me.xi[to], me.xi[from]];
    await ctx.db.patch(roomId, { [role]: me, updatedAt: Date.now() });
  },
});

export const setFormation = mutation({
  args: { roomId: v.id('rooms'), key: v.string(), formation: v.string() },
  handler: async (ctx, { roomId, key, formation }) => {
    const { room, role } = await member(ctx, roomId, key);
    if (!FORMATIONS[formation]) fail('Unknown formation.');
    if (room.status === 'match' || room.status === 'lineups') fail('Line-ups are locked.');
    const me = room[role];
    await ctx.db.patch(roomId, { [role]: { ...me, formation, xi: remapXi(me.xi, me.formation, formation) }, updatedAt: Date.now() });
  },
});

export const setReady = mutation({
  args: { roomId: v.id('rooms'), key: v.string(), ready: v.boolean() },
  handler: async (ctx, { roomId, key, ready }) => {
    const { room, role } = await member(ctx, roomId, key);
    if (role !== 'guest') fail('Only the joining player sets Ready.');
    if (ready && (room.turn !== 'done' || count(room.guest.xi) !== 11)) fail('Finish your XI first.');
    await ctx.db.patch(roomId, { guestReady: ready });
  },
});

// ------------------------------------------------------------------ match

function newJob() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

export const simulate = mutation({
  args: { roomId: v.id('rooms'), key: v.string() },
  handler: async (ctx, { roomId, key }) => {
    const { room, role } = await member(ctx, roomId, key);
    if (role !== 'host') fail('Only the host can start the simulation.');
    if (room.turn !== 'done' || count(room.host.xi) !== 11 || count(room.guest?.xi || []) !== 11) fail('Both XIs must be complete.');
    if (!room.guestReady) fail('Your rival has not pressed Ready yet.');
    const c = room.companion;
    if (!c || Date.now() - c.lastSeen > 30_000) fail('Connect ChatGPT first: start the host helper on your computer.');
    if (!c.signedIn || !c.planUsage) fail('Sign in with ChatGPT in the host helper first.');
    const now = Date.now();
    await ctx.db.patch(roomId, {
      status: 'lineups',
      sim: { state: 'queued', jobId: newJob(), kickoff: Math.random() < 0.5 ? 'A' : 'B', phase: 'Waiting for the host helper…' },
      playback: { playing: false, pos: 0, at: now, rate: 1 },
      updatedAt: now,
    });
  },
});

export const retrySim = mutation({
  args: { roomId: v.id('rooms'), key: v.string() },
  handler: async (ctx, { roomId, key }) => {
    const { room, role } = await member(ctx, roomId, key);
    if (role !== 'host') fail('Only the host can do this.');
    if (room.status !== 'lineups' && room.status !== 'match') fail('No match to retry.');
    const now = Date.now();
    await ctx.db.patch(roomId, {
      sim: { state: 'queued', jobId: newJob(), kickoff: room.sim.kickoff || 'A', phase: 'Waiting for the host helper…' },
      playback: { playing: room.status === 'match', pos: 0, at: now, rate: room.playback.rate },
    });
  },
});

export const continueMatch = mutation({
  args: { roomId: v.id('rooms'), key: v.string() },
  handler: async (ctx, { roomId, key }) => {
    const { room, role } = await member(ctx, roomId, key);
    if (role !== 'host') fail('Only the host can continue.');
    if (room.status !== 'lineups') return;
    await ctx.db.patch(roomId, { status: 'match', playback: { playing: true, pos: 0, at: Date.now(), rate: 1 } });
  },
});

// Pause / resume / seek / speed — shared by both players.
export const setPlayback = mutation({
  args: { roomId: v.id('rooms'), key: v.string(), playing: v.boolean(), pos: v.number(), rate: v.optional(v.number()) },
  handler: async (ctx, { roomId, key, playing, pos, rate }) => {
    const { room } = await member(ctx, roomId, key);
    if (room.status !== 'match') return;
    const r = rate ?? room.playback.rate;
    if (![0.5, 1, 1.5, 2].includes(r)) fail('Unsupported speed.');
    await ctx.db.patch(roomId, { playback: { playing, pos: Math.max(0, pos), at: Date.now(), rate: r } });
  },
});

// New draft with the same two players.
export const rematch = mutation({
  args: { roomId: v.id('rooms'), key: v.string() },
  handler: async (ctx, { roomId, key }) => {
    const { room, role } = await member(ctx, roomId, key);
    if (role !== 'host') fail('Only the host can start a rematch.');
    const now = Date.now();
    const reset = s => s && { ...s, xi: emptyXi() };
    const next = { ...room, round: room.round + 1, pickNo: 0, turn: 'host' };
    await ctx.db.patch(roomId, {
      round: room.round + 1, status: 'draft', host: reset(room.host), guest: reset(room.guest),
      pickNo: 0, turn: 'host', picks: [], guestReady: false,
      turnDeadline: await scheduleTimer(ctx, next),
      sim: { state: 'idle', jobId: '' }, playback: { playing: false, pos: 0, at: now, rate: 1 }, updatedAt: now,
    });
  },
});

export const events = query({
  args: { roomId: v.id('rooms'), key: v.string(), jobId: v.string() },
  handler: async (ctx, { roomId, key, jobId }) => {
    const room = await ctx.db.get(roomId);
    if (!room || (key !== room.hostKey && key !== room.guestKey) || !jobId) return [];
    const rows = await ctx.db.query('events').withIndex('by_job', q => q.eq('roomId', roomId).eq('jobId', jobId)).collect();
    return rows.map(r => ({ seq: r.seq, kind: r.kind, data: r.data }));
  },
});
