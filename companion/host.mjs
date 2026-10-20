#!/usr/bin/env node
// Süper Lig Mix — host helper.
//
// Runs on the HOST's computer. It signs in with ChatGPT (OpenAI's "Sign in with ChatGPT"
// flow for open-source apps: OAuth 2.0 + PKCE with a 127.0.0.1 loopback redirect, tokens kept
// in a 0600 file under ~/.superlig-mix — never sent anywhere else), then watches the rooms you
// link from the website and streams GPT-6.1 Sol's minute-by-minute match into them.
//
//   npx github:edgetr/superlig-mix        (or: npm run host)
//
// Docs: https://developers.openai.com/siwc/token-sharing-open-source/sign-in

import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { ConvexClient } from 'convex/browser';
import { anyApi } from 'convex/server';

const VERSION = '1.1.0';
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 1457);
const ORIGIN = `http://${HOST}:${PORT}`;
const REDIRECT_URI = `${ORIGIN}/auth/callback`;
const GAME_URL = process.env.GAME_URL || 'https://superlig-mix.vercel.app';

const ISSUER = 'https://auth.openai.com';
const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const RESOURCE = 'https://api.openai.com/v1';
const API_BASE = process.env.SIWC_API_BASE || 'https://api.openai.com/v1';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const REGISTRATION_CLIENT_ID = 'dynamic_agent_client';
const APP_NAME = 'Süper Lig Mix Host';
const MODEL = 'gpt-6.1-sol';
const REASONING_EFFORT = 'high';

const DATA_DIR = process.env.SUPERLIG_MIX_HOME || path.join(os.homedir(), '.superlig-mix');
const CRED_FILE = path.join(DATA_DIR, 'credentials.json');
const LINKS_FILE = path.join(DATA_DIR, 'links.json');
const CONVEX_URL_RE = /^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.convex\.cloud$|^https:\/\/[a-z0-9-]+\.convex\.cloud$/;

const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

// ---------------------------------------------------------------- storage

async function readJson(file, fallback) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; } }
async function writeJson(file, data) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600);
}
const loadCreds = () => readJson(CRED_FILE, {});
const saveCreds = c => writeJson(CRED_FILE, c);
async function hostId() {
  const c = await loadCreds();
  if (!c.ext_agent_host_id) { c.ext_agent_host_id = `urn:uuid:${crypto.randomUUID()}`; await saveCreds(c); }
  return c.ext_agent_host_id;
}

// ---------------------------------------------------------------- OIDC

const b64url = buf => Buffer.from(buf).toString('base64url');
let discoveryCache = null, jwksCache = null;
async function discovery() {
  if (!discoveryCache) {
    const r = await fetch(DISCOVERY_URL);
    if (!r.ok) throw new Error(`OpenID discovery failed (${r.status})`);
    discoveryCache = await r.json();
  }
  return discoveryCache;
}
async function jwks(force) {
  if (!jwksCache || force) {
    const r = await fetch((await discovery()).jwks_uri);
    if (!r.ok) throw new Error(`JWKS fetch failed (${r.status})`);
    jwksCache = await r.json();
  }
  return jwksCache;
}
function decodeJwt(token) {
  const [h, p, s] = String(token).split('.');
  return { header: JSON.parse(Buffer.from(h, 'base64url')), payload: JSON.parse(Buffer.from(p, 'base64url')), signingInput: `${h}.${p}`, signature: Buffer.from(s || '', 'base64url') };
}
async function verifyIdToken(idToken, { clientId, nonce }) {
  const { header, payload, signingInput, signature } = decodeJwt(idToken);
  let jwk = (await jwks()).keys.find(k => k.kid === header.kid) || (await jwks(true)).keys.find(k => k.kid === header.kid);
  if (!jwk) throw new Error('ID token signing key not found');
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const ok = header.alg === 'RS256' ? crypto.verify('RSA-SHA256', Buffer.from(signingInput), key, signature)
    : header.alg === 'ES256' ? crypto.verify('SHA256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' }, signature)
    : false;
  if (!ok) throw new Error(`ID token signature invalid (${header.alg})`);
  const { issuer } = await discovery();
  if (payload.iss !== issuer) throw new Error('ID token issuer mismatch');
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(clientId)) throw new Error('ID token audience mismatch');
  if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now() - 60_000) throw new Error('ID token expired');
  if (nonce && payload.nonce !== nonce) throw new Error('ID token nonce mismatch');
  return payload;
}
const normalizeTime = t => (typeof t === 'number' ? (t < 1e12 ? t * 1000 : t) : Date.parse(t) || null);
function tokenRecord(tok, prev = {}) {
  return {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || prev.refresh_token,
    id_token: tok.id_token || prev.id_token,
    scope: tok.scope ?? prev.scope ?? '',
    expires_at: Date.now() + (Number(tok.expires_in) || 3600) * 1000,
    earliest_refresh_at: tok.earliest_refresh_at ? normalizeTime(tok.earliest_refresh_at) : null,
  };
}
async function postForm(url, params) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(params) });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { error: 'non_json_response', error_description: text.slice(0, 300) }; }
  return { ok: r.ok, status: r.status, json };
}

// ---------------------------------------------------------------- sign in with ChatGPT

const pending = new Map();

async function startAuth(res) {
  const c = await loadCreds();
  const clientId = c.client_id || REGISTRATION_CLIENT_ID;
  const verifier = b64url(crypto.randomBytes(48));
  const state = b64url(crypto.randomBytes(24));
  const nonce = b64url(crypto.randomBytes(24));
  for (const [k, v] of pending) if (Date.now() - v.created > 15 * 60_000) pending.delete(k);
  pending.set(state, { verifier, nonce, clientId, created: Date.now() });
  const q = new URLSearchParams({
    client_id: clientId, ext_agent_host_id: await hostId(), response_type: 'code', redirect_uri: REDIRECT_URI,
    scope: SCOPES, resource: RESOURCE, state, nonce, code_challenge_method: 'S256',
    code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
  });
  if (clientId === REGISTRATION_CLIENT_ID) q.set('agent_name_hint', APP_NAME);
  else if (c.user?.email) q.set('login_hint', c.user.email);
  res.writeHead(302, { Location: `${AUTHORIZE_URL}?${q}`, 'Cache-Control': 'no-store' });
  res.end();
}

async function handleCallback(url, res) {
  const p = url.searchParams;
  const attempt = pending.get(p.get('state') || '');
  if (!attempt) return redirectHome(res, 'This sign-in link expired or was already used. Please try again.');
  pending.delete(p.get('state'));
  if (p.get('error')) return redirectHome(res, p.get('error') === 'access_denied' ? 'Sign-in was cancelled.' : `Sign-in failed: ${p.get('error_description') || p.get('error')}`);
  const code = p.get('code');
  const clientId = p.get('client_id') || (attempt.clientId !== REGISTRATION_CLIENT_ID ? attempt.clientId : null);
  if (!code || !clientId) return redirectHome(res, 'OpenAI did not return an authorization code. Please try again.');
  try {
    const ex = await postForm(TOKEN_URL, { grant_type: 'authorization_code', client_id: clientId, code, code_verifier: attempt.verifier, redirect_uri: REDIRECT_URI, resource: RESOURCE });
    if (!ex.ok) {
      if (ex.json.error === 'invalid_grant') return redirectHome(res, 'That sign-in code was no longer valid. Please sign in again.');
      throw new Error(`Token exchange failed (${ex.status}): ${ex.json.error_description || ex.json.error}`);
    }
    const claims = await verifyIdToken(ex.json.id_token, { clientId, nonce: attempt.nonce });
    const c = await loadCreds();
    c.client_id = clientId;
    c.tokens = tokenRecord(ex.json);
    c.user = { email: claims.email || null, name: claims.name || null };
    c.plan_usage = (c.tokens.scope || '').split(/\s+/).includes(PLAN_SCOPE);
    await saveCreds(c);
    log(`Signed in with ChatGPT as ${c.user.email || c.user.name || 'unknown'}${c.plan_usage ? '' : ' (plan usage NOT granted)'}`);
    heartbeatAll();
    redirectHome(res, c.plan_usage ? 'signed-in' : 'Signed in, but ChatGPT plan usage was not granted. Sign in again and allow it.');
  } catch (e) {
    log('[auth]', e.message);
    redirectHome(res, e.message);
  }
}
function redirectHome(res, msg) {
  res.writeHead(302, { Location: `/?msg=${encodeURIComponent(msg)}`, 'Cache-Control': 'no-store' });
  res.end();
}

let refreshing = null;
const TERMINAL_REFRESH = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);
async function accessToken() {
  const c = await loadCreds();
  if (!c.tokens?.access_token) throw Object.assign(new Error('Not signed in with ChatGPT.'), { code: 'signed_out' });
  if (c.tokens.expires_at - Date.now() > 120_000) return c.tokens.access_token;
  refreshing ||= (async () => {
    try {
      const fresh = await loadCreds();
      if (fresh.tokens.expires_at - Date.now() > 120_000) return fresh.tokens.access_token;
      const r = await postForm(TOKEN_URL, { grant_type: 'refresh_token', client_id: fresh.client_id, refresh_token: fresh.tokens.refresh_token, resource: RESOURCE });
      if (!r.ok) {
        if (TERMINAL_REFRESH.has(r.json.error)) {
          delete fresh.tokens; fresh.plan_usage = false; await saveCreds(fresh); heartbeatAll();
          throw Object.assign(new Error('Your ChatGPT session expired. Sign in again in the host helper.'), { code: 'signed_out' });
        }
        throw new Error(`Token refresh failed: ${r.json.error || r.status}`);
      }
      fresh.tokens = tokenRecord(r.json, fresh.tokens);
      if (r.json.scope) fresh.plan_usage = r.json.scope.split(/\s+/).includes(PLAN_SCOPE);
      await saveCreds(fresh);
      return fresh.tokens.access_token;
    } finally { refreshing = null; }
  })();
  return refreshing;
}

async function signOut() {
  const c = await loadCreds();
  if (c.tokens?.refresh_token) {
    try {
      const { revocation_endpoint } = await discovery();
      if (revocation_endpoint) await postForm(revocation_endpoint, { token: c.tokens.refresh_token, token_type_hint: 'refresh_token', client_id: c.client_id });
    } catch (e) { log('[auth] revoke failed:', e.message); }
  }
  delete c.tokens; delete c.plan_usage; delete c.notice_seen;
  await saveCreds(c);
  heartbeatAll();
}

async function status() {
  const c = await loadCreds();
  const signedIn = !!c.tokens?.refresh_token || !!c.tokens?.access_token;
  return {
    signedIn, planUsage: signedIn && !!c.plan_usage, email: signedIn ? c.user?.email || c.user?.name || null : null, noticeSeen: !!c.notice_seen,
    model: MODEL, effort: REASONING_EFFORT, version: VERSION,
    rooms: [...links.values()].map(l => ({ code: l.code, status: l.status || 'connecting', busy: !!l.busy, error: l.error || null, linkedAt: l.linkedAt })),
  };
}

// ---------------------------------------------------------------- rooms (Convex)

const links = new Map(); // roomId -> { convexUrl, roomId, key, code, client, unsub, busy, handled:Set }
const clients = new Map(); // convexUrl -> ConvexClient

function clientFor(url) {
  if (!clients.has(url)) clients.set(url, new ConvexClient(url));
  return clients.get(url);
}

async function persistLinks() {
  await writeJson(LINKS_FILE, [...links.values()].map(({ convexUrl, roomId, key, code, linkedAt }) => ({ convexUrl, roomId, key, code, linkedAt })));
}

async function linkRoom({ convexUrl, roomId, key, code }, persist = true) {
  if (!CONVEX_URL_RE.test(convexUrl)) throw new Error('Unexpected game server URL.');
  if (typeof roomId !== 'string' || typeof key !== 'string' || key.length < 20) throw new Error('Bad room link.');
  const existing = links.get(roomId);
  if (existing) { existing.unsub?.(); }
  const client = clientFor(convexUrl);
  const link = { convexUrl, roomId, key, code: String(code || '').slice(0, 8), client, busy: false, handled: new Set(), linkedAt: existing?.linkedAt || Date.now() };
  links.set(roomId, link);
  link.unsub = client.onUpdate(anyApi.helper.watch, { roomId, key }, room => onRoom(link, room), err => { link.error = err.message; });
  if (persist) await persistLinks();
  await heartbeat(link);
  log(`Linked room ${link.code}`);
}

async function unlinkRoom(roomId) {
  const l = links.get(roomId);
  if (!l) return;
  l.unsub?.();
  links.delete(roomId);
  await persistLinks();
}

async function heartbeat(link) {
  const s = await status();
  try {
    await link.client.mutation(anyApi.helper.heartbeat, {
      roomId: link.roomId, key: link.key, signedIn: s.signedIn, planUsage: s.planUsage, email: s.email || undefined,
      model: MODEL, busy: link.busy, version: VERSION,
    });
    link.error = null;
  } catch (e) {
    link.error = e.message;
    if (/no longer exists|not found/i.test(e.message)) unlinkRoom(link.roomId);
  }
}
function heartbeatAll() { links.forEach(l => heartbeat(l)); }
setInterval(heartbeatAll, 10_000).unref();

function onRoom(link, room) {
  if (!room) { link.status = 'not found'; return; }
  link.status = room.status;
  link.code = room.code;
  if (room.sim.state === 'queued' && !link.busy && !link.handled.has(room.sim.jobId)) {
    link.handled.add(room.sim.jobId);
    runJob(link, room.sim.jobId).catch(e => log('[job]', e.message));
  }
}

// ---------------------------------------------------------------- the match

const KINDS = new Set(['meta', 'flow', 'ev', 'stats', 'ratings', 'analysis', 'end']);

const INSTRUCTIONS = `You are a professional football match engine, tactics analyst and TV commentator.
Two friends drafted these starting XIs (players from the Turkish Süper Lig and Europe's big five leagues, 2026/27). Simulate ONE realistic 90-minute match between them and write it as a precise match script. A game engine will turn your script into a broadcast with real positions, so locations and details must be football-accurate.

GROUND RULES
- Neutral ground: no home side, no home advantage. Judge strength only on quality, form, age, positional fit (OUT OF POSITION players perform clearly worse; a non-goalkeeper in goal is a disaster), formation balance, chemistry and the tactics you choose for each side.
- Realism first. Typical totals: 8–30 shots for both sides combined, 2–10 corners, 15–30 fouls, 0–6 goals, 0–5 yellow cards, offsides 1–6. Big chances get missed; keepers make saves; elite attackers convert more. Upsets are possible but must be earned.
- All Laws of the Game apply: kick-off restarts after goals (the engine adds them), free kicks are taken from where the foul happened, fouls inside the penalty area are penalties, two yellows = red (then that team plays with 10), the same XI plays all 90 minutes (no substitutions), offside is judged when the ball is played.
- Use player names EXACTLY as listed. Team A and Team B are labels; use real team names in text.

COORDINATES (for "x","y"): always from the perspective of the team in "side", attacking towards the opponent's goal. x = 0 at their own goal line … 100 at the opponent's goal line (penalty spot ≈ 89.5, edge of the box ≈ 84, halfway = 50). y = 0 at their left touchline … 100 at their right touchline (goal centre = 50, box spans y 20–80, six-yard box y 37–63).

OUTPUT — JSON Lines only (one compact JSON object per line; no markdown, no prose, no code fences), in this order:
1) {"kind":"meta","data":{"kickoff":"A"|"B","referee":"<name>","weather":"<short>","headline":"<one-line pre-match hook>","styles":{"A":{"style":"<e.g. possession, counter-attack, high press, direct, wing play>","line":"high|mid|deep","press":"high|mid|low","width":"wide|normal|narrow","tempo":"fast|medium|slow","build":"short|mixed|direct"},"B":{...}}}}
   Choose each team's tactics to suit its players.
2) The match, chronologically. For each block of roughly 5–10 minutes write a flow line, then that block's key events:
   {"kind":"flow","data":{"from":<min>,"to":<min>,"momentum":"A"|"B"|null,"possession":[a,b],"note":"<one sentence on how play is going>"}}
   {"kind":"ev","data":{...}} with these types (only log meaningful moments, not every pass):
   • shot — every shot. Fields: "min","add","type":"shot","side","player","assist" (exact name or null),"x","y" (where the shot is taken),
     "outcome":"goal"|"saved"|"parried"|"tipped"|"off_target"|"blocked"|"woodwork"|"disallowed",
     "reason" (only for disallowed: "offside"|"foul"|"handball"),
     "body":"right"|"left"|"head" (respect each player's preferred foot),
     "technique":"placed"|"power"|"curl"|"chip"|"volley"|"tap_in"|"long_range"|"header"|"penalty"|"free_kick",
     "target":"bottom_left"|"bottom_right"|"top_left"|"top_right"|"middle"|"high"|"wide_left"|"wide_right" (from the shooter's view; off_target must use high/wide_*),
     "assist_type":"through_ball"|"cross"|"cutback"|"short_pass"|"long_ball"|"corner"|"free_kick"|"penalty"|"rebound"|"solo",
     "build_up":"possession"|"counter"|"long_ball"|"press_win"|"set_piece","xg":<0.01–0.95>,"text":"<commentary, max 140 chars>"
   • foul — fouls that matter: every card, every penalty, and free kicks in the attacking third. "side" = the team that WINS the free kick, "player" = the fouled player, "offender" = who committed it (other team), "x","y" = where it happened (side's perspective), "card":"yellow"|"red"|null, "penalty":true|false.
     If the free kick or penalty leads to a shot, the NEXT line is that shot with the same minute, "assist_type":"free_kick" (direct: technique "free_kick", x/y = the foul spot) or "penalty" (technique "penalty").
   • offside — "side" = attacking team flagged, "player" = the runner, "assist" = the passer, "x","y" = where the runner was.
   • corner — only corners that do NOT lead to a shot ("side" = team taking it, "y" ≈ 0 or 100 for the flag). A corner that leads to a shot is just the shot with "assist_type":"corner".
   • injury — "side","player" (brief stoppage, the player continues).
   • half_time — {"min":45,"add":<first-half stoppage minutes>,"type":"half_time","text":...}. First-half stoppage events use "min":45,"add":1..N. Second half starts at minute 46.
   • full_time — {"min":90,"add":<second-half stoppage>,"type":"full_time","text":...}. Second-half stoppage events use "min":90,"add":1..N.
3) {"kind":"stats","data":{"possession":[a,b],"shots":[a,b],"on_target":[a,b],"xg":[a,b],"corners":[a,b],"fouls":[a,b],"offsides":[a,b],"yellow":[a,b],"red":[a,b],"motm":{"side":"A"|"B","player":"<name>","reason":"<short>"}}} — consistent with your events.
4) {"kind":"ratings","data":{"A":[{"player":"<name>","rating":<1.0-10.0>}, ... all 11],"B":[... all 11]}}
5) {"kind":"analysis","data":{"side":"A","summary":"<2 sentences on how they played>","strengths":["...","...","..."],"weaknesses":["...","...","..."],"resembles":{"club":"<a real club from the Premier League, LaLiga, Serie A, Bundesliga or Ligue 1>","league":"<that league>","why":"<1 sentence on why this XI plays like that club>"}}}
6) The same analysis object for side "B".
7) {"kind":"end","data":{}}`;

function teamBlock(label, t) {
  const info = p => [p.club, `natural position ${p.pos}`, p.fit === 'off' ? 'OUT OF POSITION' : p.fit === 'ok' ? 'adapted position' : null,
    p.foot ? `${p.foot}-footed` : null, p.age ? `age ${p.age}` : null, p.height ? `${p.height} cm` : null, `value ${p.value || 'unknown'}`].filter(Boolean).join(', ');
  return `Team ${label}: ${t.name} — formation ${t.formation}
${t.players.map(p => `- ${p.role}${p.num != null ? ` #${p.num}` : ''}: ${p.name} (${info(p)})`).join('\n')}`;
}

const INFERENCE_ERRORS = {
  subscription_sharing_user_not_eligible: 'This ChatGPT account is not eligible to use its plan in other apps.',
  subscription_sharing_usage_limit_exceeded: 'The host has reached their ChatGPT plan usage limit for now (see chatgpt.com/settings/usage).',
  subscription_sharing_usage_unavailable: 'ChatGPT plan usage is temporarily unavailable. Try again in a bit.',
  subscription_sharing_user_unavailable: 'ChatGPT plan usage is temporarily unavailable. Try again in a bit.',
  subscription_sharing_invalid_user: 'OpenAI did not accept this ChatGPT session. Sign out and in again in the host helper.',
  subscription_sharing_unsupported_capability: 'This request uses a feature the ChatGPT plan route does not support.',
};

async function runJob(link, jobId) {
  const { client, roomId, key } = link;
  const job = await client.mutation(anyApi.helper.claim, { roomId, key, jobId });
  if (!job) return;
  link.busy = true; heartbeat(link);
  log(`Room ${link.code}: simulating ${job.teams.A.name} vs ${job.teams.B.name} with ${MODEL} (${REASONING_EFFORT})`);

  let seq = 0, queue = [], flushing = Promise.resolve(), lastPhase = 0, sawEnd = false, sawFullTime = false;
  const setPhase = (phase, force) => {
    if (!force && Date.now() - lastPhase < 2500) return;
    lastPhase = Date.now();
    client.mutation(anyApi.helper.progress, { roomId, key, jobId, phase }).catch(() => {});
  };
  const flush = () => {
    if (!queue.length) return flushing;
    const items = queue; queue = [];
    const startSeq = seq; seq += items.length;
    flushing = flushing.then(async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        try { await client.mutation(anyApi.helper.append, { roomId, key, jobId, startSeq, items }); return; }
        catch (e) { if (attempt === 3) throw e; await new Promise(r => setTimeout(r, 600 * (attempt + 1))); }
      }
    });
    return flushing;
  };
  const flushTimer = setInterval(flush, 700);

  const onLine = line => {
    const s = line.trim().replace(/^data:\s*/, '').replace(/,$/, '');
    if (!s || s.startsWith('```')) return;
    let item; try { item = JSON.parse(s); } catch { return; }
    if (!item || !KINDS.has(item.kind) || typeof item.data !== 'object' || item.data === null) return;
    if (item.kind === 'ev') {
      const d = item.data;
      if (typeof d.text === 'string') d.text = d.text.slice(0, 200);
      setPhase(`Writing minute ${d.min}${d.add ? '+' + d.add : ''}…`);
      if (d.type === 'full_time') sawFullTime = true;
    }
    if (item.kind === 'flow') setPhase(`Writing minutes ${item.data.from}–${item.data.to}…`);
    if (item.kind === 'stats') setPhase('Full time — writing the analysis…', true);
    if (item.kind === 'end') sawEnd = true;
    queue.push(item);
    if (queue.length >= 12) flush();
  };

  try {
    const token = await accessToken();
    setPhase('GPT-6.1 Sol is reading both line-ups (high reasoning)…', true);
    const r = await fetch(`${API_BASE}/responses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        model: MODEL,
        instructions: INSTRUCTIONS,
        input: [{ role: 'user', content: `${teamBlock('A', job.teams.A)}\n\n${teamBlock('B', job.teams.B)}\n\nKick-off: Team ${job.kickoff} (decided by coin toss). Venue: neutral ground.` }],
        reasoning: { effort: REASONING_EFFORT },
        store: false,
        stream: true,
      }),
    });
    if (!r.ok) {
      const text = await r.text();
      let err = {}; try { const j = JSON.parse(text); err = j.error || j; } catch {}
      const code = err.code || `http_${r.status}`;
      throw new Error(INFERENCE_ERRORS[code] || err.message || err.detail || `OpenAI returned HTTP ${r.status}.`);
    }
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = '', text = '', failed = null, completed = false, thinkingSince = Date.now();
    const thinkTimer = setInterval(() => { if (!text) setPhase(`GPT-6.1 Sol is planning the match (high reasoning)… ${Math.round((Date.now() - thinkingSince) / 1000)}s`, true); }, 5000);
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = chunk.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
          if (!data || data === '[DONE]') continue;
          let ev; try { ev = JSON.parse(data); } catch { continue; }
          if (ev.type === 'response.output_text.delta') {
            text += ev.delta || '';
            let nl;
            while ((nl = text.indexOf('\n')) >= 0) { onLine(text.slice(0, nl)); text = text.slice(nl + 1); }
          } else if (ev.type === 'response.completed') { completed = true; if (text.trim()) onLine(text); text = ''; }
          else if (ev.type === 'response.failed') { const code = ev.response?.error?.code; failed = INFERENCE_ERRORS[code] || ev.response?.error?.message || 'The model run failed.'; }
          else if (ev.type === 'response.incomplete') { failed = `The model stopped early (${ev.response?.incomplete_details?.reason || 'incomplete'}).`; }
          else if (ev.type === 'error') { failed = INFERENCE_ERRORS[ev.code] || ev.message || 'Stream error.'; }
        }
      }
    } finally { clearInterval(thinkTimer); }
    if (failed && !sawFullTime) throw new Error(failed);
    if (!completed && !sawFullTime) throw new Error('The connection to OpenAI ended before full time.');
    if (!sawEnd) queue.push({ kind: 'end', data: {} });
    clearInterval(flushTimer);
    await flush(); await flushing;
    await client.mutation(anyApi.helper.finish, { roomId, key, jobId, ok: true });
    log(`Room ${link.code}: full time (${seq} items).`);
  } catch (e) {
    clearInterval(flushTimer);
    await flush().catch(() => {}); await flushing.catch(() => {});
    log(`Room ${link.code}: failed — ${e.message}`);
    await client.mutation(anyApi.helper.finish, { roomId, key, jobId, ok: false, error: e.message }).catch(() => {});
  } finally {
    link.busy = false; heartbeat(link);
  }
}

// ---------------------------------------------------------------- local web UI

// Official ChatGPT logo from OpenAI's approved sign-in button assets.
const LOGO_SVG = (await fs.readFile(new URL('../shared/chatgpt-logo-black.svg', import.meta.url), 'utf8')).replace(/<\?xml[^>]*>/, '').trim();

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Süper Lig Mix — Host helper</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(120% 80% at 30% 0%,#10241a,#070b09 60%);color:#eef4f0;font:15px/1.5 system-ui,-apple-system,sans-serif}
.card{width:min(560px,92vw);background:#0f1512;border:1px solid #22302a;border-radius:18px;padding:28px;box-shadow:0 30px 80px rgba(0,0,0,.5)}
h1{margin:0 0 4px;font-size:22px}.sub{color:#8b9a92;margin:0 0 20px;font-size:13.5px}.badge{background:#e30a17;color:#fff;font-weight:800;font-size:11px;padding:3px 7px;border-radius:5px;margin-right:8px;vertical-align:2px}
.row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 0;border-top:1px solid #22302a}
.siwc{display:inline-flex;align-items:center;gap:10px;height:42px;padding:0 18px 0 14px;border-radius:999px;background:#fff;color:#0d0d0d;border:0;font:600 14.5px system-ui;cursor:pointer;text-decoration:none}
.siwc svg{width:19px!important;height:19px!important;flex:none}.btn{background:#18211c;border:1px solid #2c3a33;color:#eef4f0;border-radius:9px;padding:8px 12px;font:600 13px system-ui;cursor:pointer}
.ok{color:#3ddc84}.warn{color:#f5b942}.muted{color:#8b9a92;font-size:13px}a{color:#8fe3b5}
.room{display:flex;justify-content:space-between;align-items:center;padding:9px 12px;border-radius:10px;background:#121a16;border:1px solid #22302a;margin-top:8px}
.code{font-weight:800;letter-spacing:.12em}.msg{padding:10px 12px;border-radius:10px;background:#1b2a22;border:1px solid #2f4a3c;margin-bottom:14px;font-size:13.5px}
.msg.err{background:#2a1b1b;border-color:#4a2f2f}
</style></head><body><div class="card">
<h1><span class="badge">TSL</span>Süper Lig Mix — host helper</h1>
<p class="sub">Keep this running while you host. It signs in with ChatGPT on <b>this computer</b> and lets GPT-6.1 Sol (high reasoning) simulate your matches on your ChatGPT plan. Your ChatGPT tokens stay in <code>~/.superlig-mix</code>.</p>
<div id="msg"></div>
<div id="acct"></div>
<div class="row" style="display:block"><div><b>Linked games</b></div><div id="rooms" class="muted">None yet. In the game, click <b>Connect ChatGPT → Link this game</b>.</div></div>
<p class="muted" style="margin:16px 0 0">Open the game: <a href="${GAME_URL}" target="_blank" rel="noopener">${GAME_URL.replace('https://', '')}</a> · v${VERSION}</p>
</div>
<script>
const LOGO=${JSON.stringify(LOGO_SVG)};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function post(u){const r=await fetch(u,{method:'POST'});return r.json()}
async function load(){
  const s=await (await fetch('/api/status',{cache:'no-store'})).json();
  const a=document.getElementById('acct');
  if(!s.signedIn){a.innerHTML='<div class="row"><span>Not signed in</span><a class="siwc" href="/auth/start">'+LOGO+'Sign in with ChatGPT</a></div>';}
  else{a.innerHTML='<div class="row"><div><b>'+esc(s.email||'ChatGPT account')+'</b><br><span class="'+(s.planUsage?'ok':'warn')+'">'+(s.planUsage?'Using ChatGPT plan':'ChatGPT plan usage not granted')+'</span> · <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener">Manage usage</a></div><button class="btn" id="out">Sign out</button></div>'
    +'<div class="row"><span class="muted">Model</span><span>GPT-6.1 Sol · '+esc(s.effort)+' reasoning</span></div>'
    +(s.planUsage&&!s.noticeSeen?'<div class="msg"><b>You\\'re using your ChatGPT plan</b><br>Matches simulated by this helper count toward your ChatGPT plan usage. <button class="btn" id="got">Got it</button></div>':'')
    +(s.planUsage?'':'<div class="row"><span class="warn">Plan usage is needed to simulate matches.</span><a class="siwc" href="/auth/start">'+LOGO+'Sign in with ChatGPT</a></div>');
    document.getElementById('out').onclick=async()=>{await post('/api/signout');load()};
    const g=document.getElementById('got'); if(g) g.onclick=async()=>{await post('/api/notice-seen');load()};
  }
  const r=document.getElementById('rooms');
  if(s.rooms.length) r.innerHTML=s.rooms.map(x=>'<div class="room"><span class="code">'+esc(x.code)+'</span><span class="muted">'+(x.busy?'⚽ simulating…':esc(x.error||x.status))+'</span></div>').join('');
}
const p=new URLSearchParams(location.search);const m=p.get('msg');
if(m){const el=document.getElementById('msg');const ok=m==='signed-in'||m.startsWith('Linked');el.innerHTML='<div class="msg'+(ok?'':' err')+'">'+esc(m==='signed-in'?'You\\'re signed in with ChatGPT. You can go back to the game.':m)+'</div>';history.replaceState(null,'','/')}
load();setInterval(load,3000);
</script></body></html>`;

const LINK_PAGE = `<!doctype html><meta charset="utf-8"><title>Linking…</title><body style="background:#070b09;color:#eef4f0;font:15px system-ui;display:grid;place-items:center;height:100vh">Linking your game…
<script>
const f=new URLSearchParams(location.hash.slice(1));history.replaceState(null,'','/link');
fetch('/api/link',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({convexUrl:f.get('convex'),roomId:f.get('room'),key:f.get('key'),code:f.get('code')})})
.then(r=>r.json()).then(j=>location.replace('/?msg='+encodeURIComponent(j.ok?'Linked game '+(f.get('code')||'')+'. Keep this window open while you play.':(j.error||'Could not link the game.'))));
</script>`;

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = ''; req.on('data', c => { s += c; if (s.length > 8000) { reject(new Error('Too large')); req.destroy(); } });
    req.on('end', () => resolve(s)); req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.headers.host !== `${HOST}:${PORT}` && req.headers.host !== `localhost:${PORT}`) return send(res, 421, { error: 'Wrong host' });
    const url = new URL(req.url, ORIGIN);
    if (req.method === 'POST') {
      if (req.headers.origin !== ORIGIN) return send(res, 403, { error: 'Forbidden origin' });
      if (url.pathname === '/api/link') {
        try { await linkRoom(JSON.parse(await readBody(req))); return send(res, 200, { ok: true }); }
        catch (e) { return send(res, 400, { ok: false, error: e.message }); }
      }
      if (url.pathname === '/api/signout') { await signOut(); return send(res, 200, await status()); }
      if (url.pathname === '/api/notice-seen') { const c = await loadCreds(); c.notice_seen = true; await saveCreds(c); return send(res, 200, { ok: true }); }
      return send(res, 404, { error: 'Not found' });
    }
    if (url.pathname === '/') return send(res, 200, PAGE, 'text/html; charset=utf-8');
    if (url.pathname === '/link') return send(res, 200, LINK_PAGE, 'text/html; charset=utf-8');
    if (url.pathname === '/api/status') return send(res, 200, await status());
    if (url.pathname === '/auth/start') return await startAuth(res);
    if (url.pathname === '/auth/callback') return await handleCallback(url, res);
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    log(e);
    if (!res.headersSent) send(res, 500, { error: e.message }); else res.end();
  }
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.error(`\nPort ${PORT} is busy. Is the host helper already running? Otherwise start it with PORT=<another port>.\n`);
  else console.error(e);
  process.exit(1);
});

server.listen(PORT, HOST, async () => {
  for (const l of await readJson(LINKS_FILE, [])) linkRoom(l, false).catch(() => {});
  console.log(`\n  ⚽  Süper Lig Mix host helper v${VERSION}\n  →  ${ORIGIN}\n\n  Sign in with ChatGPT there, then in the game click "Connect ChatGPT → Link this game".\n  Keep this terminal open while you host. Ctrl+C to stop.\n`);
  if (!process.env.NO_OPEN) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', ORIGIN] : [ORIGIN];
    try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch {}
  }
});
