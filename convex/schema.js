import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

const side = v.object({
  name: v.string(),        // player's display name
  teamName: v.string(),
  formation: v.string(),
  color: v.string(),       // kit colour
  xi: v.array(v.union(v.string(), v.null())), // 11 slots of player ids
  lastSeen: v.number(),
  awayAt: v.optional(v.number()), // the page was closed at this time (cleared by the next heartbeat)
});

export default defineSchema({
  rooms: defineTable({
    code: v.string(),
    round: v.number(),
    status: v.string(), // 'lobby' | 'draft' | 'lineups' | 'match' | 'closed'
    closedBy: v.optional(v.string()),     // name of the player who left
    closedReason: v.optional(v.string()), // 'left' | 'away' | 'timeout'
    closedRole: v.optional(v.string()),   // 'host' | 'guest'
    hostKey: v.string(),
    guestKey: v.optional(v.string()),
    host: side,
    guest: v.optional(side),
    pickTimer: v.number(), // seconds per pick, 0 = off
    pickNo: v.number(),    // picks made so far (0..22)
    turn: v.string(),      // 'host' | 'guest' | 'done'
    turnDeadline: v.optional(v.number()),
    picks: v.array(v.object({ side: v.string(), playerId: v.string(), n: v.number(), at: v.number(), auto: v.boolean() })),
    guestReady: v.boolean(),
    companion: v.optional(v.object({
      lastSeen: v.number(), signedIn: v.boolean(), planUsage: v.boolean(), email: v.optional(v.string()),
      model: v.string(), busy: v.boolean(), version: v.string(),
    })),
    sim: v.object({
      state: v.string(), // 'idle' | 'queued' | 'running' | 'done' | 'error'
      jobId: v.string(),
      kickoff: v.optional(v.string()),
      phase: v.optional(v.string()),
      error: v.optional(v.string()),
      startedAt: v.optional(v.number()),
      finishedAt: v.optional(v.number()),
    }),
    playback: v.object({ playing: v.boolean(), pos: v.number(), at: v.number(), rate: v.number() }),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('by_code', ['code']).index('by_status', ['status']),

  // Match items streamed from GPT-6.1 Sol by the host helper (append-only).
  events: defineTable({
    roomId: v.id('rooms'),
    jobId: v.string(),
    seq: v.number(),
    kind: v.string(),
    data: v.any(),
  }).index('by_job', ['roomId', 'jobId', 'seq']),
});
