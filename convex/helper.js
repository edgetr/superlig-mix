// Functions used by the host helper (companion/host.mjs), which runs on the host's own
// computer, signs in with ChatGPT and streams GPT-6 Luna's match into the room.
// Every call is authenticated with the room's host key.
import { ConvexError, v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { PLAYERS } from '../shared/players.js';
import { FORMATIONS, fitOf } from '../shared/game.js';

const byId = new Map(PLAYERS.map(p => [p.id, p]));
const fail = msg => { throw new ConvexError(msg); };

async function hostRoom(ctx, roomId, key) {
  const room = await ctx.db.get(roomId);
  if (!room) fail('Room not found.');
  if (key !== room.hostKey) fail('Only the host helper may do this.');
  return room;
}

function team(side) {
  const f = FORMATIONS[side.formation];
  return {
    name: side.teamName, formation: side.formation, color: side.color,
    players: side.xi.map((id, i) => {
      const p = byId.get(id);
      return { id, name: p.name, role: f[i][0], pos: p.pos, club: p.clubName, value: p.value, fit: fitOf(p, f[i][0]) };
    }),
  };
}

// What the helper watches: just enough to know when a job is waiting.
export const watch = query({
  args: { roomId: v.id('rooms'), key: v.string() },
  handler: async (ctx, { roomId, key }) => {
    const room = await ctx.db.get(roomId);
    if (!room || key !== room.hostKey) return null;
    return { code: room.code, status: room.status, sim: room.sim, host: room.host.teamName, guest: room.guest?.teamName ?? null };
  },
});

export const heartbeat = mutation({
  args: {
    roomId: v.id('rooms'), key: v.string(),
    signedIn: v.boolean(), planUsage: v.boolean(), email: v.optional(v.string()), model: v.string(), busy: v.boolean(), version: v.string(),
  },
  handler: async (ctx, { roomId, key, ...c }) => {
    await hostRoom(ctx, roomId, key);
    await ctx.db.patch(roomId, { companion: { ...c, lastSeen: Date.now() } });
  },
});

export const claim = mutation({
  args: { roomId: v.id('rooms'), key: v.string(), jobId: v.string() },
  handler: async (ctx, { roomId, key, jobId }) => {
    const room = await hostRoom(ctx, roomId, key);
    if (room.sim.jobId !== jobId || room.sim.state !== 'queued') return null;
    await ctx.db.patch(roomId, { sim: { ...room.sim, state: 'running', phase: 'GPT-6 Luna is reading both line-ups…', startedAt: Date.now() } });
    return { jobId, kickoff: room.sim.kickoff || 'A', teams: { A: team(room.host), B: team(room.guest) } };
  },
});

export const progress = mutation({
  args: { roomId: v.id('rooms'), key: v.string(), jobId: v.string(), phase: v.string() },
  handler: async (ctx, { roomId, key, jobId, phase }) => {
    const room = await hostRoom(ctx, roomId, key);
    if (room.sim.jobId !== jobId) return false;
    await ctx.db.patch(roomId, { sim: { ...room.sim, phase: phase.slice(0, 120) } });
    return true;
  },
});

export const append = mutation({
  args: { roomId: v.id('rooms'), key: v.string(), jobId: v.string(), startSeq: v.number(), items: v.array(v.object({ kind: v.string(), data: v.any() })) },
  handler: async (ctx, { roomId, key, jobId, startSeq, items }) => {
    const room = await hostRoom(ctx, roomId, key);
    if (room.sim.jobId !== jobId || room.sim.state !== 'running') return false;
    if (items.length > 200) fail('Too many items in one batch.');
    // Idempotent: skip sequence numbers that already exist (helper retries after network blips).
    const last = await ctx.db.query('events').withIndex('by_job', q => q.eq('roomId', roomId).eq('jobId', jobId)).order('desc').first();
    const from = last ? last.seq + 1 : 0;
    for (let i = 0; i < items.length; i++) {
      const seq = startSeq + i;
      if (seq < from) continue;
      await ctx.db.insert('events', { roomId, jobId, seq, kind: items[i].kind.slice(0, 20), data: items[i].data });
    }
    return true;
  },
});

export const finish = mutation({
  args: { roomId: v.id('rooms'), key: v.string(), jobId: v.string(), ok: v.boolean(), error: v.optional(v.string()) },
  handler: async (ctx, { roomId, key, jobId, ok, error }) => {
    const room = await hostRoom(ctx, roomId, key);
    if (room.sim.jobId !== jobId) return;
    await ctx.db.patch(roomId, {
      sim: { ...room.sim, state: ok ? 'done' : 'error', error: ok ? undefined : (error || 'Simulation failed.').slice(0, 300), phase: ok ? 'Full time' : 'Failed', finishedAt: Date.now() },
    });
  },
});
