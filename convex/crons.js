import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();
crons.interval('close abandoned games', { minutes: 1 }, internal.rooms.sweep, {});
export default crons;
