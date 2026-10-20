// Deterministic football match engine — public interface.
//
// GPT writes the match script (who did what, where, how). The engine plays every scripted moment
// out as real football: a 30 Hz world simulation (./world.js) with ball physics (./ball.js),
// human-limited bodies and an AI for all 22 players plus the officials, steered by a director
// (./director.js) that turns each scripted event into objectives and orders. Restarts follow the
// Laws of the Game. Everything is a pure function of (teams, event, match context, seed), so the
// "video" is reproducible and exportable.
import { FORMATIONS } from '../../../shared/game.js';
export const FORMATION_TABLE = FORMATIONS;
export * from './const.js';
export { ROLE, normStyle, prepareTeam, makeMatch, withHalf, shapeTarget, findAgent } from './shape.js';
export { buildMoment, freeKickPositions, penaltyPositions } from './director.js';
