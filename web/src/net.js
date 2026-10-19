// Convex connection, session persistence and server-clock sync.
import { ConvexClient } from 'convex/browser';
import { api } from '../../convex/_generated/api.js';

export const CONVEX_URL = import.meta.env.VITE_CONVEX_URL;
export const client = new ConvexClient(CONVEX_URL);
export { api };

const SESSION_KEY = 'slmx-duel-session';

export function randomKey() {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const session = {
  get() { try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; } },
  set(s) { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); },
  clear() { localStorage.removeItem(SESSION_KEY); },
};

export const prefs = {
  get name() { return localStorage.getItem('slmx-name') || ''; },
  set name(v) { localStorage.setItem('slmx-name', v); },
};

// Human-friendly message from a Convex error.
export function errMsg(e) {
  if (e?.data && typeof e.data === 'string') return e.data;
  const m = String(e?.message || e || 'Something went wrong.');
  const uncaught = /Uncaught ConvexError: (.*?)(\n|$)/.exec(m);
  if (uncaught) return uncaught[1];
  return m.replace(/^\[CONVEX [^\]]+\]\s*/, '').replace(/\[Request ID: [^\]]+\]\s*/, '').split('\n')[0];
}

// Server clock offset (NTP-style, best of 3 round trips).
let offset = 0;
export const serverNow = () => Date.now() + offset;
export async function syncClock() {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    const s = await client.mutation(api.rooms.now, {});
    const t1 = Date.now();
    if (t1 - t0 < best) { best = t1 - t0; offset = s - (t0 + t1) / 2; }
  }
  return offset;
}

export const isOnline = lastSeen => !!lastSeen && serverNow() - lastSeen < 25_000;
