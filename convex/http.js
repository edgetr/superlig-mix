import { httpRouter } from 'convex/server';
import { httpAction } from './_generated/server';
import { internal } from './_generated/api';

const http = httpRouter();

// navigator.sendBeacon target for a page that is closing: body is JSON text { roomId, key }.
http.route({
  path: '/away',
  method: 'POST',
  handler: httpAction(async (ctx, req) => {
    try {
      const { roomId, key } = JSON.parse(await req.text());
      if (typeof roomId === 'string' && typeof key === 'string') await ctx.runMutation(internal.rooms.away, { roomId, key });
    } catch {}
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*' } });
  }),
});

export default http;
