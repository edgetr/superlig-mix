import { animate, spring, stagger } from 'motion';
import { client, api, session, prefs, randomKey, errMsg, syncClock, serverNow, isOnline, CONVEX_URL } from './net.js';
import { createDraft, byId, esc, fmtEur, xiValue, pitchSVG } from './draft.js';
import { createMatchScreen } from './matchScreen.js';
import { FORMATIONS, KIT_COLORS, fitOf } from '../../shared/game.js';

const $ = s => document.querySelector(s);
const HELPER_ORIGIN = 'http://127.0.0.1:1457';
const HELPER_CMD = 'npx github:edgetr/superlig-mix';
const REPO_URL = 'https://github.com/edgetr/superlig-mix';

let sess = null;      // { roomId, key, code, role }
let room = null;
let unsub = null, hbTimer = null;

// ------------------------------------------------------------------ toast
let toastTimer;
function toast(title, body = '', ms = 4200) {
  const t = $('#toast');
  const text = body instanceof Error || (body && typeof body === 'object') ? errMsg(body) : body;
  t.innerHTML = `<div class="t-body"><b>${esc(title)}</b>${text ? `<span>${esc(text)}</span>` : ''}</div>`;
  t.hidden = false;
  animate(t, { opacity: [0, 1], transform: ['translateX(-50%) translateY(16px)', 'translateX(-50%) translateY(0)'] }, { type: spring, stiffness: 420, damping: 32 });
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => {
    animate(t, { opacity: 0, transform: 'translateX(-50%) translateY(12px)' }, { duration: 0.2 }).finished.then(() => { t.hidden = true; });
  }, ms);
}
async function copy(text, what) {
  try { await navigator.clipboard.writeText(text); toast(`${what} copied`, text, 2200); }
  catch { prompt(`Copy the ${what.toLowerCase()}:`, text); }
}
const inviteLink = code => `${location.origin}/?join=${code}`;

// ------------------------------------------------------------------ mutations
const call = (fn, args = {}) => client.mutation(fn, { roomId: sess.roomId, key: sess.key, ...args });
const actions = {
  pick: (playerId, slot) => call(api.rooms.pick, { playerId, slot }),
  swap: (from, to) => call(api.rooms.swapSlots, { from, to }),
  setFormation: formation => call(api.rooms.setFormation, { formation }),
};
const run = async (p, title) => { try { return await p; } catch (e) { toast(title || 'Something went wrong', e); } };

// ------------------------------------------------------------------ screens
const draft = createDraft({
  actions,
  toast: (t, b, ms) => toast(t, b, ms),
  onTurnBlocked: () => {
    animate('#turnChip', { transform: ['translateX(0)', 'translateX(-6px)', 'translateX(6px)', 'translateX(-3px)', 'translateX(0)'] }, { duration: 0.35 });
    if (room?.turn === 'done') return;
    toast('Not your turn yet', `${room?.[rival()]?.name || 'Your rival'} is picking.`, 1800);
  },
});
const matchScreen = createMatchScreen({ client, api, getSess: () => sess, toast, serverNow });

let current = null;
function showScreen(name) {
  if (name === current) return;
  const prev = current;
  current = name;
  for (const id of ['home', 'lobby', 'lineups', 'match']) $('#' + id).hidden = id !== name;
  draft.show(name === 'draft');
  matchScreen.show(name === 'match');
  const el = name === 'draft' ? $('#stage') : $('#' + name);
  if (prev && el) animate(el, { opacity: [0, 1] }, { duration: 0.3 });
}

const me = () => room?.[sess.role];
const rival = () => (sess?.role === 'host' ? 'guest' : 'host');
const helperOk = r => !!(r.companion && isOnline(r.companion.lastSeen) && r.companion.signedIn && r.companion.planUsage);

// ------------------------------------------------------------------ home
function showHome(joinCode) {
  showScreen('home');
  $('#yourName').value = prefs.name;
  if (joinCode) { $('#joinCode').value = joinCode.toUpperCase(); (prefs.name ? $('#joinBtn') : $('#yourName')).focus(); }
  if (!showHome.animated) {
    showHome.animated = true;
    animate('.home-card', { opacity: [0, 1], transform: ['translateY(18px) scale(.98)', 'translateY(0) scale(1)'] }, { type: spring, stiffness: 300, damping: 28 });
    animate('.how li', { opacity: [0, 1], transform: ['translateX(-10px)', 'translateX(0)'] }, { delay: stagger(0.08, { startDelay: 0.2 }) });
  }
}
function needName() {
  const n = $('#yourName').value.trim();
  if (!n) { $('#yourName').focus(); animate('#yourName', { transform: ['translateX(0)', 'translateX(-6px)', 'translateX(6px)', 'translateX(0)'] }, { duration: 0.3 }); toast('Enter your name first'); return null; }
  prefs.name = n;
  return n;
}
$('#createBtn').addEventListener('click', async () => {
  const name = needName(); if (!name) return;
  const key = randomKey();
  const res = await run(client.mutation(api.rooms.create, { key, name }), 'Could not create the game');
  if (res) enterRoom({ roomId: res.roomId, key, code: res.code, role: 'host' });
});
async function joinWithCode() {
  const name = needName(); if (!name) return;
  const code = $('#joinCode').value.trim().toUpperCase();
  if (code.length !== 5) { $('#joinCode').focus(); toast('Enter the 5-letter game code'); return; }
  const key = randomKey();
  const res = await run(client.mutation(api.rooms.join, { code, key, name }), "Couldn't join");
  if (res) enterRoom({ roomId: res.roomId, key, code, role: res.role });
}
$('#joinBtn').addEventListener('click', joinWithCode);
$('#joinCode').addEventListener('keydown', e => { if (e.key === 'Enter') joinWithCode(); });
$('#joinCode').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });

function enterRoom(s) {
  sess = s;
  session.set(s);
  history.replaceState(null, '', `/?game=${s.code}`);
  subscribe();
}
function leaveRoom() {
  unsub?.(); unsub = null;
  clearInterval(hbTimer);
  session.clear();
  sess = null; room = null;
  history.replaceState(null, '', '/');
  showHome();
}

function subscribe() {
  unsub?.();
  unsub = client.onUpdate(api.rooms.get, { roomId: sess.roomId, key: sess.key }, r => {
    if (r === null) { toast('That game is no longer available'); leaveRoom(); return; }
    sess.role = r.you;
    onRoom(r);
  }, err => toast('Connection problem', err));
  clearInterval(hbTimer);
  const beat = () => client.mutation(api.rooms.heartbeat, { roomId: sess.roomId, key: sess.key }).catch(() => {});
  beat();
  hbTimer = setInterval(beat, 10_000);
}

// ------------------------------------------------------------------ room rendering
function onRoom(r) {
  const prev = room;
  room = r;
  const screen = r.status === 'lobby' ? 'lobby' : r.status === 'draft' ? 'draft' : r.status;
  showScreen(screen);
  if (screen === 'lobby') renderLobby(prev);
  if (screen === 'draft') { draft.update(r, sess.role); renderHeader(prev); }
  if (screen === 'lineups') renderLineups(prev);
  if (screen === 'match') matchScreen.update(r);
  if (!$('#modal').hidden && modalKind === 'ai') renderAiModal();
  if (prev && prev.guest == null && r.guest && sess.role === 'host') toast(`${r.guest.name} joined!`, 'Pick your kit, then start the draft.');
}

// ---------- lobby
function kitButtons(side, otherColor) {
  return `<div class="kits">${KIT_COLORS.map(c => `<button class="kit${c === side.color ? ' on' : ''}" style="background:${c}" data-kit="${c}" ${c === otherColor ? 'disabled title="Your rival wears this"' : `title="${c}"`}></button>`).join('')}</div>`;
}
function mgrCard(r, roleName) {
  const s = r[roleName];
  if (!s) return `<div class="who">Rival</div><div class="nm">Waiting for a rival…</div><p class="muted" style="margin:6px 0 0;font-size:12.5px">Share the code or invite link.</p>`;
  const mine = roleName === sess.role;
  const otherColor = r[roleName === 'host' ? 'guest' : 'host']?.color;
  return `<div class="who"><span>${roleName === 'host' ? 'Host' : 'Rival'}${mine ? ' · you' : ''}</span><span class="online${isOnline(s.lastSeen) ? ' on' : ''}" title="${isOnline(s.lastSeen) ? 'Online' : 'Offline'}"></span></div>
    <div class="nm">${esc(s.name)}</div>
    ${mine ? `<input class="tn" id="lobbyTeamName" maxlength="28" value="${esc(s.teamName)}" aria-label="Team name">${kitButtons(s, otherColor)}`
           : `<div class="tn-ro">${esc(s.teamName)}</div><div class="kits"><span class="kit on" style="background:${s.color};cursor:default"></span></div>`}`;
}
function renderLobby(prev) {
  const r = room;
  const codeEl = $('#bigCode');
  if (codeEl.dataset.code !== r.code) {
    codeEl.dataset.code = r.code;
    codeEl.innerHTML = [...r.code].map(c => `<span>${c}</span>`).join('');
    animate(codeEl.querySelectorAll('span'), { opacity: [0, 1], transform: ['translateY(18px) rotateX(70deg)', 'translateY(0) rotateX(0)'] }, { delay: stagger(0.06), type: spring, stiffness: 380, damping: 22 });
  }
  const focusedName = document.activeElement?.id === 'lobbyTeamName';
  const hostEl = $('#mgrHost'), guestEl = $('#mgrGuest');
  hostEl.style.setProperty('--kit', r.host.color);
  guestEl.style.setProperty('--kit', r.guest?.color || '#444');
  guestEl.classList.toggle('empty', !r.guest);
  if (!(focusedName && sess.role === 'host')) hostEl.innerHTML = mgrCard(r, 'host');
  if (!(focusedName && sess.role === 'guest')) guestEl.innerHTML = mgrCard(r, 'guest');
  if (prev && !prev.guest && r.guest) animate(guestEl, { opacity: [0, 1], transform: ['scale(.94)', 'scale(1)'] }, { type: spring, stiffness: 400, damping: 22 });

  const seg = $('#timerSeg');
  seg.innerHTML = [[0, 'Off'], [30, '30s'], [45, '45s'], [60, '60s'], [90, '90s']]
    .map(([s, l]) => `<button data-s="${s}" class="${r.pickTimer === s ? 'on' : ''}" ${sess.role !== 'host' ? 'disabled' : ''}>${l}</button>`).join('');

  $('#aiRow').innerHTML = sess.role === 'host'
    ? `<span>Match simulation · GPT-6 Luna on your ChatGPT plan</span>${aiChipHTML(r)}`
    : `<span>Match simulation · GPT-6 Luna (host's ChatGPT)</span><span class="${helperOk(r) ? 'ok' : 'muted'}" style="font-weight:700;color:${helperOk(r) ? 'var(--good)' : 'var(--muted)'}">${helperOk(r) ? 'Connected' : 'Host will connect it'}</span>`;
  $('#aiRow').querySelector('.ai-chip')?.addEventListener('click', openAiModal);

  const actionsEl = $('#lobbyActions');
  actionsEl.innerHTML = sess.role === 'host'
    ? `<button class="btn primary big" id="startDraft" ${r.guest ? '' : 'disabled'}>${r.guest ? 'Start the draft' : 'Waiting for your rival…'}</button>`
    : `<p class="muted">Waiting for ${esc(r.host.name)} to start the draft…</p>`;
  $('#startDraft')?.addEventListener('click', () => run(call(api.rooms.startDraft), 'Could not start'));
}
$('#lobby').addEventListener('click', e => {
  const kit = e.target.closest('[data-kit]');
  if (kit && !kit.disabled) run(call(api.rooms.updateSide, { color: kit.dataset.kit }), 'Could not change kit');
  const t = e.target.closest('#timerSeg button[data-s]');
  if (t && !t.disabled) run(call(api.rooms.setPickTimer, { seconds: Number(t.dataset.s) }), 'Could not change timer');
});
$('#lobby').addEventListener('change', e => {
  if (e.target.id === 'lobbyTeamName') run(call(api.rooms.updateSide, { teamName: e.target.value }), 'Could not rename');
});
$('#copyCode').addEventListener('click', () => copy(room.code, 'Code'));
$('#copyLink').addEventListener('click', () => copy(inviteLink(room.code), 'Invite link'));
$('#leaveBtn').addEventListener('click', () => { if (confirm('Leave this game? You can rejoin with the code.')) leaveRoom(); });

// ---------- header (draft)
function aiChipHTML(r) {
  const c = r.companion, online = c && isOnline(c.lastSeen);
  const [cls, st] = !online ? ['off', 'Connect ChatGPT'] : !c.signedIn ? ['warn', 'Sign in needed'] : !c.planUsage ? ['warn', 'Plan usage off'] : c.busy ? ['ok', 'Simulating…'] : ['ok', 'ChatGPT connected'];
  return `<button class="ai-chip ${cls}" title="GPT-6 Luna via the host's ChatGPT plan"><img src="/chatgpt-logo-white.svg" alt=""><span class="st">${st}</span></button>`;
}
const teamNameEl = $('#teamName');
teamNameEl.addEventListener('change', () => run(call(api.rooms.updateSide, { teamName: teamNameEl.value }), 'Could not rename'));
teamNameEl.addEventListener('keydown', e => { if (e.key === 'Enter') teamNameEl.blur(); });
$('#roomChip').addEventListener('click', () => copy(inviteLink(room.code), 'Invite link'));

function renderHeader() {
  const r = room, mine = me(), riv = r[rival()];
  if (document.activeElement !== teamNameEl) teamNameEl.value = mine.teamName;
  $('#subline').innerHTML = `vs ${esc(riv?.teamName || '…')} <span class="online${riv && isOnline(riv.lastSeen) ? ' on' : ''}"></span>`;
  $('#roomChip').textContent = r.code;
  $('#aiChip').innerHTML = sess.role === 'host' ? aiChipHTML(r) : '';
  $('#aiChip').querySelector('.ai-chip')?.addEventListener('click', openAiModal);
  renderTurn();

  const btn = $('#mainAction');
  const n = mine.xi.filter(Boolean).length, done = r.turn === 'done';
  let label = 'Ready', sub = '', disabled = true, kind = '';
  if (!done) {
    if (r.turn === sess.role) { label = 'Pick for me'; sub = 'best available'; disabled = false; kind = 'auto'; }
    else { label = 'Waiting'; sub = `${riv?.name || 'Rival'} is picking`; }
  } else if (sess.role === 'guest') {
    label = r.guestReady ? 'Ready ✓' : 'Ready'; sub = r.guestReady ? 'click to undo' : 'lock in your XI'; disabled = n !== 11; kind = 'ready';
  } else {
    label = 'Simulate'; kind = 'simulate';
    sub = !r.guestReady ? `waiting for ${riv?.name || 'rival'}` : !helperOk(r) ? 'connect ChatGPT first' : 'GPT-6 Luna · High';
    disabled = false;
  }
  btn.dataset.kind = kind;
  btn.disabled = disabled;
  btn.querySelector('.guess-label').textContent = label;
  btn.querySelector('.guess-sub').textContent = sub;
}
$('#mainAction').addEventListener('click', async () => {
  const kind = $('#mainAction').dataset.kind;
  if (kind === 'auto') run(call(api.rooms.autoPickMine), 'Could not pick');
  if (kind === 'ready') run(call(api.rooms.setReady, { ready: !room.guestReady }), 'Could not set ready');
  if (kind === 'simulate') {
    if (!room.guestReady) { toast(`Waiting for ${room.guest?.name || 'your rival'}`, 'They need to press Ready first.'); return; }
    if (!helperOk(room)) { openAiModal(); return; }
    run(call(api.rooms.simulate), 'Could not start the simulation');
  }
});

function renderTurn() {
  const r = room, el = $('#turnChip');
  if (!r || r.status !== 'draft') { el.innerHTML = ''; return; }
  const myN = me().xi.filter(Boolean).length;
  let html;
  if (r.turn === 'done') html = `<span class="dot"></span>Draft complete`;
  else {
    const left = r.turnDeadline ? Math.max(0, Math.ceil((r.turnDeadline - serverNow()) / 1000)) : null;
    const timer = left != null ? ` <span class="timer${left <= 10 ? ' low' : ''}">${left}s</span>` : '';
    html = r.turn === sess.role
      ? `<span class="dot"></span>Your pick <span class="lbl-long">· ${Math.min(11, myN + 1)}/11</span>${timer}`
      : `<span class="dot"></span>${esc(r[rival()]?.name || 'Rival')} is picking${timer}`;
  }
  const mineNow = r.turn === sess.role;
  if (el.innerHTML !== html) el.innerHTML = html;
  if (el.classList.contains('mine') !== mineNow) {
    el.classList.toggle('mine', mineNow);
    if (mineNow) animate(el, { transform: ['scale(1)', 'scale(1.08)', 'scale(1)'] }, { duration: 0.45 });
  }
}
setInterval(() => { if (current === 'draft' && room?.turnDeadline) renderTurn(); }, 250);

// ---------- Connect ChatGPT modal (host)
let modalKind = null;
function openModal(kind, render) {
  modalKind = kind;
  $('#modal').hidden = false;
  render();
  animate('#modal .sheet-backdrop', { opacity: [0, 1] }, { duration: 0.2 });
  animate('#modal .sheet-panel', { opacity: [0, 1], transform: ['scale(.96) translateY(10px)', 'scale(1) translateY(0)'] }, { type: spring, stiffness: 420, damping: 32 });
}
function closeModal() {
  if ($('#modal').hidden) return;
  modalKind = null;
  animate('#modal .sheet-panel', { opacity: 0, transform: 'scale(.97)' }, { duration: 0.15 }).finished.then(() => { $('#modal').hidden = true; });
}
$('#modal').addEventListener('click', e => { if (e.target.closest('[data-close]')) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

function openAiModal() { if (sess?.role === 'host') openModal('ai', renderAiModal); }
function renderAiModal() {
  const c = room.companion, online = !!(c && isOnline(c.lastSeen));
  const linkUrl = `${HELPER_ORIGIN}/link#${new URLSearchParams({ convex: CONVEX_URL, room: sess.roomId, key: sess.key, code: room.code })}`;
  $('#modalBody').innerHTML = `
    <h2 style="margin:0 0 4px">Connect ChatGPT</h2>
    <p class="muted" style="margin:0;font-size:13.5px">GPT-6 Luna simulates the match on <b>your</b> ChatGPT plan. OpenAI's Sign in with ChatGPT for open-source apps runs on your own computer, so a tiny open-source helper does the sign-in and the model calls — your ChatGPT tokens never leave your machine.</p>
    <div class="steps">
      <div class="step ${online ? 'done' : ''}"><span class="n">${online ? '✓' : 1}</span><div>
        <b>Start the host helper</b>
        <p>In Terminal (Node.js 20+):</p>
        <div class="cmd"><code>${HELPER_CMD}</code><button class="btn" id="copyCmd">Copy</button></div>
        <p class="muted" style="font-size:12px">Open source: <a href="${REPO_URL}" target="_blank" rel="noopener">${REPO_URL.replace('https://', '')}</a>. It opens ${HELPER_ORIGIN.replace('http://', '')}.</p>
      </div></div>
      <div class="step ${online ? 'done' : ''}"><span class="n">${online ? '✓' : 2}</span><div>
        <b>Link this game to the helper</b>
        <p>${online ? 'Linked — the helper is watching this game.' : 'Opens the helper in a new tab and connects it to this game.'}</p>
        <a class="btn" href="${linkUrl}" target="_blank" rel="noopener" id="linkBtn">${online ? 'Link again' : 'Link this game'}</a>
      </div></div>
      <div class="step ${online && c.signedIn && c.planUsage ? 'done' : ''}"><span class="n">${online && c.signedIn && c.planUsage ? '✓' : 3}</span><div>
        <b>Sign in with ChatGPT</b>
        <p>${!online ? 'In the helper window.' : !c.signedIn ? 'Click “Sign in with ChatGPT” in the helper window.' : !c.planUsage ? 'Signed in, but plan usage was not granted — sign in again in the helper and allow it.' : `Signed in${c.email ? ' as <b>' + esc(c.email) + '</b>' : ''} · Using ChatGPT plan · <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener">Manage usage</a>`}</p>
      </div></div>
    </div>
    ${helperOk(room) ? '<p style="margin:10px 0 0;color:var(--good);font-weight:700">All set — GPT-6 Luna (high reasoning) is ready.</p>' : ''}`;
  $('#copyCmd').addEventListener('click', () => copy(HELPER_CMD, 'Command'));
}

// ---------- line-ups (after Simulate)
function luTeam(side, label) {
  const f = FORMATIONS[side.formation];
  return `<div class="lu-name"><i></i>${esc(side.teamName)}</div>
    <div class="lu-meta">${esc(side.name)} · ${side.formation} · ${fmtEur(xiValue(side.xi))}</div>
    <div class="lu-pitch">${pitchSVG()}${side.xi.map((id, i) => {
      const p = byId.get(id), [role, x, y] = f[i], fit = fitOf(p, role);
      return `<div class="lu-card" style="left:${x}%;top:${y}%"><img src="${p.img}" alt="" referrerpolicy="no-referrer"><b>${esc(p.name.split(' ').slice(-1)[0])}</b><span>${role}${fit === 'off' ? ' ⚠' : ''}</span></div>`;
    }).join('')}</div>`;
}
function renderLineups(prev) {
  const r = room;
  const first = !prev || prev.status !== 'lineups';
  if (first) {
    const A = $('#luA'), B = $('#luB');
    A.style.setProperty('--kit', r.host.color); B.style.setProperty('--kit', r.guest.color);
    A.innerHTML = luTeam(r.host, 'A'); B.innerHTML = luTeam(r.guest, 'B');
    $('#luTitle').innerHTML = `${esc(r.host.teamName)} <span style="color:var(--muted)">vs</span> ${esc(r.guest.teamName)}`;
    animate(A, { opacity: [0, 1], transform: ['translateX(-60px)', 'translateX(0)'] }, { type: spring, stiffness: 220, damping: 26 });
    animate(B, { opacity: [0, 1], transform: ['translateX(60px)', 'translateX(0)'] }, { type: spring, stiffness: 220, damping: 26 });
    animate('#luVs', { opacity: [0, 1], transform: ['scale(2.4) rotate(-12deg)', 'scale(1) rotate(0deg)'] }, { delay: 0.25, type: spring, stiffness: 300, damping: 14 });
    animate(document.querySelectorAll('.lu-card'), { opacity: [0, 1], transform: ['translate(-50%, -50%) scale(.4)', 'translate(-50%, -50%) scale(1)'] }, { delay: stagger(0.03, { startDelay: 0.3 }), type: spring, stiffness: 380, damping: 20 });
  }
  const s = r.sim;
  $('#luStatus').innerHTML = s.state === 'error'
    ? `<span class="err">Simulation failed: ${esc(s.error)}</span>`
    : s.state === 'done' ? 'Match simulated — ready when you are.'
    : `<span class="spin" style="display:inline-block;vertical-align:-3px;margin-right:6px"></span>${esc(s.phase || 'Preparing…')}`;
  $('#luFoot').innerHTML = sess.role === 'host'
    ? `${s.state === 'error' ? '<button class="btn" id="retrySim">Retry simulation</button>' : ''}<button class="btn primary big" id="continueBtn">Continue ▶<small>${s.state === 'done' ? 'watch the match' : 'starts while GPT-6 Luna writes it'}</small></button>`
    : `<p class="muted">Waiting for ${esc(r.host.name)} to continue…</p>`;
  $('#continueBtn')?.addEventListener('click', () => run(call(api.rooms.continueMatch), 'Could not continue'));
  $('#retrySim')?.addEventListener('click', () => run(call(api.rooms.retrySim), 'Could not retry'));
}

// ------------------------------------------------------------------ boot
syncClock().catch(() => {});
setInterval(() => syncClock().catch(() => {}), 60_000);
(function boot() {
  const params = new URLSearchParams(location.search);
  const join = params.get('join');
  const saved = session.get();
  if (saved && (!join || join.toUpperCase() === saved.code)) { sess = saved; subscribe(); return; }
  showHome(join);
})();
