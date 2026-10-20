// Runs the football engine off the main thread so playback never stutters while
// GPT's script streams in. Results come back as transferable typed arrays.
import * as C from './core.js';

let M0 = null;
self.onmessage = ({ data }) => {
  if (data.type === 'init') { M0 = C.makeMatch(data.teams, data.styles); return; }
  if (data.type !== 'build') return;
  const { id, half, ev, ctx } = data;
  try {
    const clip = C.buildMoment(C.withHalf(M0, half), ev, { ...ctx, sent: new Set(ctx.sent || []) });
    const bufs = [clip.pos, clip.st, clip.stT, clip.run, clip.ball, clip.cam, clip.poss, clip.offX].map(a => a.buffer);
    self.postMessage({ id, clip }, bufs);
  } catch (e) {
    self.postMessage({ id, error: String(e?.stack || e) });
  }
};
