// The draft board: pitch + player pool + drag & drop (ported from the single-player Starting XI game).
// Driven entirely by the server room state; local changes are applied optimistically.
import { animate, spring, stagger } from 'motion';
import { PLAYERS } from '../../shared/players.js';
import { FORMATIONS, GROUP, roleOf, fitOf, bestEmptySlot } from '../../shared/game.js';
import { CLUBS as CLUB_DATA, LEAGUES } from '../../shared/clubs.js';

export const byId = new Map(PLAYERS.map(p => [p.id, p]));
const $ = s => document.querySelector(s);

export const CLUBS = CLUB_DATA;
export { LEAGUES };
export const clubShort = p => p.clubShort || CLUBS[p.club]?.short || p.clubName.slice(0, 3).toUpperCase();
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function fmtEur(v) {
  if (v >= 1e9) return `€${(v / 1e9).toFixed(2)}bn`;
  if (v >= 1e8) return `€${Math.round(v / 1e6)}m`;
  if (v >= 1e6) return `€${(v / 1e6).toFixed(1).replace(/\.0$/, '')}m`;
  if (v >= 1e3) return `€${Math.round(v / 1e3)}k`;
  return '€0';
}
export const xiValue = xi => xi.reduce((a, id) => a + (id ? byId.get(id).valueEur : 0), 0);

export function pitchSVG() {
  return `<svg class="pitch-svg" viewBox="0 0 68 105" preserveAspectRatio="none" aria-hidden="true">
    <defs>
      <pattern id="mow" width="68" height="15" patternUnits="userSpaceOnUse"><rect width="68" height="7.5" fill="#2f8a47"/><rect y="7.5" width="68" height="7.5" fill="#2a7e41"/></pattern>
      <radialGradient id="flood" cx="50%" cy="45%" r="75%"><stop offset="0%" stop-color="#fff" stop-opacity=".10"/><stop offset="60%" stop-color="#000" stop-opacity="0"/><stop offset="100%" stop-color="#000" stop-opacity=".35"/></radialGradient>
    </defs>
    <rect width="68" height="105" fill="url(#mow)"/><rect width="68" height="105" fill="url(#flood)"/>
    <g fill="none" stroke="#e9f5ec" stroke-opacity=".78" stroke-width=".32">
      <rect x="2" y="2" width="64" height="101"/><line x1="2" y1="52.5" x2="66" y2="52.5"/><circle cx="34" cy="52.5" r="9.15"/>
      <rect x="13.84" y="2" width="40.32" height="16.5"/><rect x="24.84" y="2" width="18.32" height="5.5"/><path d="M26.7 18.5 A9.15 9.15 0 0 0 41.3 18.5"/>
      <rect x="13.84" y="86.5" width="40.32" height="16.5"/><rect x="24.84" y="97.5" width="18.32" height="5.5"/><path d="M26.7 86.5 A9.15 9.15 0 0 1 41.3 86.5"/>
      <rect x="30.34" y=".4" width="7.32" height="1.6"/><rect x="30.34" y="103" width="7.32" height="1.6"/>
    </g>
    <g fill="#e9f5ec" fill-opacity=".85"><circle cx="34" cy="52.5" r=".45"/><circle cx="34" cy="13" r=".4"/><circle cx="34" cy="92" r=".4"/></g>
  </svg>`;
}

// Canvas-based text fitting (no layout reads).
const mctx = document.createElement('canvas').getContext('2d');
const FONT = getComputedStyle(document.body).fontFamily;
function fitFont(text, w, h, maxFs, minFs, weight = 700, lh = 1.12) {
  for (let fs = maxFs; fs > minFs; fs -= 0.5) {
    mctx.font = `${weight} ${fs}px ${FONT}`;
    let lines = 1, line = '', ok = true;
    for (const word of text.split(/\s+/)) {
      if (mctx.measureText(word).width > w) { ok = false; break; }
      const t = line ? line + ' ' + word : word;
      if (line && mctx.measureText(t).width > w) { lines++; line = word; } else line = t;
    }
    if (ok && lines * fs * lh <= h + 0.5) return fs;
  }
  return minFs;
}

function cardHTML(p, extra = '') {
  return `<div class="ph"><img alt="" draggable="false" decoding="async" referrerpolicy="no-referrer" src="${p.img}"><span class="club">${esc(clubShort(p))}</span><span class="role">${roleOf(p)}${p.num != null ? `<i class="num">#${p.num}</i>` : ''}</span>${extra}</div>
    <div class="meta"><div class="nm"><span>${esc(p.name)}</span></div><div class="val${p.value ? '' : ' none'}">${p.value || '—'}</div></div>`;
}
const FOOT = { right: 'right-footed', left: 'left-footed', both: 'two-footed' };
export function playerTitle(p) {
  const bits = [p.clubName, p.pos, p.num != null ? `#${p.num}` : null, p.age ? `${p.age} y/o` : null, p.nat, p.height ? `${(p.height / 100).toFixed(2)} m` : null, FOOT[p.foot], p.value];
  return `${p.name} — ${bits.filter(Boolean).join(' · ')}`;
}
function styleClub(el, p) {
  const c = CLUBS[p.club] || CLUBS.other;
  el.style.setProperty('--club-bg', c.bg);
  el.style.setProperty('--club-fg', c.fg);
  el.style.setProperty('--club-line', c.line);
}

const tf = (x, y, s = 1) => `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)${s !== 1 ? ` scale(${s})` : ''}`;
const SPRING = { type: spring, stiffness: 520, damping: 40, mass: 1 };
const SOFT = { type: spring, stiffness: 300, damping: 30, mass: 1 };

export function createDraft({ actions, toast, onTurnBlocked }) {
  const pool = $('#pool'), layer = $('#layer'), pitch = $('#pitch'), pitchArea = $('#pitchArea');
  pitch.innerHTML = pitchSVG();
  const root = document.documentElement;
  const geo = { cardW: 84, cardH: 140, slotH: 109, rect: null, cardRatio: 0 };
  let room = null, role = null, view = 'me', visible = false;
  let localXi = null;           // optimistic copy of my XI
  let pendingOps = 0;           // in-flight mutations that changed my XI
  // Keep the optimistic XI until every in-flight change has settled (Convex has applied it by then).
  function track(promise) {
    pendingOps++;
    return promise.finally(() => {
      if (--pendingOps === 0) { localXi = null; placeAll(true); renderPool(); updateHeader(); }
    });
  }
  let seenPicks = 0;

  const mySide = () => room?.[role];
  const rivalRole = () => (role === 'host' ? 'guest' : 'host');
  const viewSide = () => (view === 'me' ? mySide() : room?.[rivalRole()]);
  const viewXi = () => (view === 'me' ? (localXi || mySide()?.xi) : viewSide()?.xi) || Array(11).fill(null);
  const viewFormation = () => FORMATIONS[viewSide()?.formation || '4-3-3'];
  const myTurn = () => room?.status === 'draft' && room.turn === role;
  const editable = () => view === 'me' && room?.status === 'draft';

  // ---------------------------------------------------------------- pool
  const poolCards = new Map();
  PLAYERS.forEach(p => {
    const el = document.createElement('div');
    el.className = 'pcard';
    el.dataset.id = p.id;
    el.title = playerTitle(p);
    styleClub(el, p);
    el.innerHTML = cardHTML(p);
    el.querySelector('img').loading = 'lazy';
    poolCards.set(p.id, el);
  });

  let leagueFilter = 'all', clubFilter = 'all', posFilter = 'all', sortBy = 'value';
  const searchEl = $('#search');
  const norm = s => s.toLocaleLowerCase('tr').replace(/ı/g, 'i').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // Pre-normalised search text (name, club, nationality) so filtering stays cheap with 600+ cards.
  const searchText = new Map(PLAYERS.map(p => [p.id, norm(`${p.name} ${p.clubName} ${p.nat || ''}`)]));
  function buildChips(container, items, get, set) {
    container.innerHTML = items.map(([k, label]) => `<button class="chip" data-k="${k}">${label}<span class="c"></span></button>`).join('');
    container.addEventListener('click', e => { const b = e.target.closest('.chip'); if (b) { set(b.dataset.k); renderPool(); } });
    return () => container.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c.dataset.k === get()));
  }
  const markLeague = buildChips($('#leagueChips'), [['all', 'All'], ...LEAGUES.map(l => [l.key, l.name])], () => leagueFilter, v => { leagueFilter = v; clubFilter = 'all'; fillClubSelect(); });
  const clubSel = $('#clubSelect');
  function fillClubSelect() {
    const keys = Object.keys(CLUBS).filter(k => PLAYERS.some(p => p.club === k) && (leagueFilter === 'all' || CLUBS[k].league === leagueFilter));
    keys.sort((a, b) => CLUBS[a].name.localeCompare(CLUBS[b].name, 'tr'));
    clubSel.innerHTML = `<option value="all">All clubs</option>` + keys.map(k => `<option value="${k}">${esc(k === 'other' ? 'Other Süper Lig' : CLUBS[k].name)}</option>`).join('');
    clubSel.value = clubFilter;
  }
  fillClubSelect();
  clubSel.addEventListener('change', () => { clubFilter = clubSel.value; renderPool(); });
  const markPos = buildChips($('#posChips'), [['all', 'All positions'], ['GK', 'GK'], ['DEF', 'DEF'], ['MID', 'MID'], ['FWD', 'FWD']], () => posFilter, v => { posFilter = v; });
  searchEl.addEventListener('input', () => renderPool());
  $('#sort').addEventListener('change', e => { sortBy = e.target.value; renderPool(true); });
  $('#hideTaken').addEventListener('change', e => pool.classList.toggle('hide-taken', e.target.checked));

  function sortedPlayers() {
    const list = [...PLAYERS];
    if (sortBy === 'value') list.sort((a, b) => b.valueEur - a.valueEur || a.name.localeCompare(b.name, 'tr'));
    if (sortBy === 'name') list.sort((a, b) => a.name.localeCompare(b.name, 'tr'));
    if (sortBy === 'club') list.sort((a, b) => a.clubName.localeCompare(b.clubName, 'tr') || b.valueEur - a.valueEur);
    if (sortBy === 'age') list.sort((a, b) => (a.age ?? 99) - (b.age ?? 99) || b.valueEur - a.valueEur);
    return list;
  }
  function renderPool(reorder) {
    if (reorder || !pool.firstChild) {
      const frag = document.createDocumentFragment();
      sortedPlayers().forEach(p => frag.appendChild(poolCards.get(p.id)));
      pool.textContent = '';
      pool.appendChild(frag);
    }
    const q = norm(searchEl.value.trim());
    const mine = new Set((localXi || mySide()?.xi || []).filter(Boolean));
    const theirs = new Set((room?.[rivalRole()]?.xi || []).filter(Boolean));
    const turnFree = myTurn();
    let visibleCount = 0;
    const counts = { all: 0 };
    LEAGUES.forEach(l => { counts[l.key] = 0; });
    PLAYERS.forEach(p => {
      const el = poolCards.get(p.id);
      const okText = !q || searchText.get(p.id).includes(q);
      const okPos = posFilter === 'all' || GROUP[roleOf(p)] === posFilter;
      const okClub = clubFilter === 'all' || p.club === clubFilter;
      if (okText && okPos && okClub) { counts.all++; counts[p.league]++; }
      const show = okText && okPos && okClub && (leagueFilter === 'all' || p.league === leagueFilter);
      el.classList.toggle('hidden', !show);
      el.classList.toggle('picked', mine.has(p.id));
      el.classList.toggle('taken', theirs.has(p.id));
      el.classList.toggle('wait', !turnFree && !mine.has(p.id) && !theirs.has(p.id));
      if (show) visibleCount++;
    });
    $('#leagueChips').querySelectorAll('.chip').forEach(c => { c.querySelector('.c').textContent = counts[c.dataset.k] ?? 0; });
    let empty = pool.querySelector('.pool-empty');
    if (!visibleCount && !empty) { empty = document.createElement('div'); empty.className = 'pool-empty'; empty.textContent = 'No players match.'; pool.appendChild(empty); }
    else if (visibleCount && empty) empty.remove();
    markLeague(); markPos();
  }

  // ---------------------------------------------------------------- pitch geometry
  const slots = Array.from({ length: 11 }, (_, i) => {
    const el = document.createElement('div');
    el.className = 'slot';
    el.dataset.slot = i;
    el.innerHTML = '<div class="glow"></div><div class="ring"><b></b><span>empty</span></div>';
    el.addEventListener('click', () => toggleSelectSlot(i));
    layer.appendChild(el);
    return el;
  });
  const pcs = new Map();

  function computeLayout() {
    const tabs = $('#pitchTabs'), hint = $('#pitchHint');
    const availH = pitchArea.clientHeight - tabs.offsetHeight - hint.offsetHeight - 16;
    const availW = pitchArea.clientWidth;
    let h = Math.max(240, availH), w = h * 68 / 105;
    if (w > availW) { w = availW; h = w * 105 / 68; }
    pitch.style.width = Math.round(w) + 'px';
    pitch.style.height = Math.round(h) + 'px';
    geo.cardW = Math.round(Math.max(46, Math.min(116, w * 0.152, geo.cardRatio ? h * 0.16 / geo.cardRatio : 999)));
    root.style.setProperty('--card-w', geo.cardW + 'px');
    geo.rect = pitch.getBoundingClientRect();
    geo.slotH = slots[0].offsetHeight || geo.cardW * 1.3;
    const any = pcs.values().next().value;
    if (any) { fitName(any, geo.cardW); geo.cardRatio = any.offsetHeight / geo.cardW; }
    geo.cardH = Math.round(geo.cardW * (geo.cardRatio || 1.6));
    pcs.forEach(el => fitName(el, geo.cardW));
    fitPoolNames();
  }
  const slotCenter = i => { const [, fx, fy] = viewFormation()[i]; return { x: geo.rect.left + geo.rect.width * fx / 100, y: geo.rect.top + geo.rect.height * fy / 100 }; };
  const cardTopLeft = i => { const c = slotCenter(i); return { x: c.x - geo.cardW / 2, y: c.y - geo.cardH / 2 }; };
  const slotTopLeft = i => { const c = slotCenter(i); return { x: c.x - geo.cardW / 2, y: c.y - geo.slotH / 2 }; };

  function stopAnim(el) { if (el._anim) { const a = el._anim; el._anim = null; try { a.stop(); } catch {} } }
  function currentPos(el) { const m = new DOMMatrixReadOnly(getComputedStyle(el).transform); return { x: m.m41, y: m.m42 }; }
  function setPos(el, x, y) { stopAnim(el); el.style.transform = tf(x, y); el._x = x; el._y = y; }
  function springTo(el, x, y, opts = SPRING) {
    const from = el._anim ? currentPos(el) : { x: el._x ?? x, y: el._y ?? y };
    stopAnim(el);
    el._x = x; el._y = y;
    const a = animate(el, { transform: [tf(from.x, from.y), tf(x, y)] }, opts);
    el._anim = a;
    a.finished.then(() => { if (el._anim === a) { el._anim = null; el.style.transform = tf(x, y); } }, () => {});
  }

  function fitName(cardEl, w) {
    const span = cardEl.querySelector('.nm span'), nm = cardEl.querySelector('.nm');
    const max = Math.max(9, Math.min(13.5, w * 0.125));
    nm.style.fontSize = fitFont(span.textContent, w - 10, max * 1.12 * 2, max, 7) + 'px';
    nm.style.height = (max * 1.12 * 2).toFixed(1) + 'px';
  }
  function fitPoolNames() {
    const cols = Math.max(1, Math.floor((pool.clientWidth - 20 + 8) / (92 + 8)));
    const w = (pool.clientWidth - 20 - (cols - 1) * 8) / cols;
    if (!w || w === fitPoolNames.w) return;
    fitPoolNames.w = w;
    poolCards.forEach(el => fitName(el, w));
  }

  function makePitchCard(id) {
    const p = byId.get(id);
    const el = document.createElement('div');
    el.className = 'pc';
    el.dataset.id = id;
    el.innerHTML = `<span class="slotrole"></span><div class="inner"><div class="pcard">${cardHTML(p, '<span class="fit"></span>')}</div></div>`;
    styleClub(el.querySelector('.pcard'), p);
    el.title = playerTitle(p);
    layer.appendChild(el);
    pcs.set(id, el);
    fitName(el, geo.cardW);
    return el;
  }
  function removeCard(id, animated) {
    const el = pcs.get(id);
    if (!el) return;
    pcs.delete(id);
    if (!animated) { el.remove(); return; }
    el.classList.add('leaving');
    animate(el, { opacity: 0 }, { duration: 0.2 }).finished.then(() => el.remove());
  }

  function refreshCard(i) {
    const xi = viewXi(), id = xi[i], slot = slots[i], f = viewFormation();
    slot.querySelector('b').textContent = f[i][0];
    slot.classList.toggle('filled', !!id);
    slot.style.display = visible ? '' : 'none';
    slot.style.pointerEvents = editable() ? '' : 'none';
    if (!id) return;
    const el = pcs.get(id);
    if (!el) return;
    el.dataset.slot = i;
    el.querySelector('.slotrole').textContent = f[i][0];
    const fit = fitOf(byId.get(id), f[i][0]);
    const dot = el.querySelector('.fit');
    dot.className = 'fit ' + fit;
    dot.title = fit === 'natural' ? 'Natural position' : fit === 'ok' ? 'Can play here' : 'Out of position';
    el.style.pointerEvents = editable() ? '' : 'none';
  }

  // Place every card/slot for the current view. Cards that changed slot spring to it.
  function placeAll(animated) {
    if (!visible) return;
    computeLayout();
    const xi = viewXi();
    const want = new Set(xi.filter(Boolean));
    [...pcs.keys()].forEach(id => { if (!want.has(id) && !(drag && drag.id === id)) removeCard(id, animated); });
    xi.forEach((id, i) => {
      const s = slotTopLeft(i);
      if (animated) springTo(slots[i], s.x, s.y, SOFT); else setPos(slots[i], s.x, s.y);
      if (id && !(drag && drag.id === id && drag.active)) {
        let el = pcs.get(id);
        const c = cardTopLeft(i);
        if (!el) {
          el = makePitchCard(id);
          setPos(el, c.x, c.y);
          if (animated) animate(el.querySelector('.inner'), { transform: ['scale(.6)', 'scale(1)'], opacity: [0, 1] }, { type: spring, stiffness: 420, damping: 22 });
        } else if (el._x !== c.x || el._y !== c.y) {
          if (animated) springTo(el, c.x, c.y, SOFT); else setPos(el, c.x, c.y);
        }
      }
      refreshCard(i);
    });
  }

  // ---------------------------------------------------------------- formations
  const formsEl = $('#formations');
  formsEl.innerHTML = '<span class="pill"></span>' + Object.keys(FORMATIONS).map(f => `<button role="radio" data-f="${f}">${f}</button>`).join('');
  const pill = formsEl.querySelector('.pill');
  function markFormation(animated) {
    const f = mySide()?.formation;
    formsEl.querySelectorAll('button').forEach(b => { b.setAttribute('aria-checked', String(b.dataset.f === f)); b.disabled = room?.status !== 'draft'; });
    const b = formsEl.querySelector(`[data-f="${f}"]`);
    if (!b) return;
    const to = { transform: `translateX(${b.offsetLeft}px)`, width: b.offsetWidth + 'px' };
    if (animated) animate(pill, to, { type: spring, stiffness: 600, damping: 42 }); else Object.assign(pill.style, to);
  }
  formsEl.addEventListener('click', e => {
    const b = e.target.closest('button[data-f]');
    if (!b || b.disabled || b.dataset.f === mySide()?.formation) return;
    if (view !== 'me') setView('me');
    actions.setFormation(b.dataset.f).catch(err => toast('Could not change formation', err));
  });

  // ---------------------------------------------------------------- pitch tabs
  const tabs = $('#pitchTabs');
  tabs.addEventListener('click', e => { const b = e.target.closest('button[data-v]'); if (b) setView(b.dataset.v); });
  function setView(v) {
    if (v === view) return;
    view = v;
    tabs.querySelectorAll('button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.v === v)));
    pitch.classList.toggle('rival-view', v === 'rival');
    clearSelectedSlot();
    [...pcs.keys()].forEach(id => removeCard(id, false));
    placeAll(false);
    animate([...pcs.values()].map(p => p.querySelector('.inner')), { opacity: [0, 1], transform: ['scale(.8)', 'scale(1)'] }, { delay: stagger(0.02), type: spring, stiffness: 420, damping: 26 });
    updateHint();
  }

  // ---------------------------------------------------------------- slot selection (click to pick)
  let selectedSlot = null, posBeforeSelect = null;
  function toggleSelectSlot(i) {
    if (!editable() || viewXi()[i]) return;
    if (selectedSlot === i) { clearSelectedSlot(); renderPool(); return; }
    clearSelectedSlot();
    selectedSlot = i;
    slots[i].classList.add('selected');
    animate(slots[i].querySelector('.ring'), { transform: ['scale(1)', 'scale(1.08)', 'scale(1)'] }, { duration: 0.35 });
    posBeforeSelect = posFilter;
    posFilter = GROUP[viewFormation()[i][0]];
    renderPool();
    pool.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function clearSelectedSlot() {
    if (selectedSlot == null) return;
    slots[selectedSlot].classList.remove('selected');
    selectedSlot = null;
    if (posBeforeSelect != null) { posFilter = posBeforeSelect; posBeforeSelect = null; }
  }

  // ---------------------------------------------------------------- picking
  function canPickNow(quiet) {
    if (room?.status !== 'draft') return false;
    if (room.turn === 'done') return false;
    if (!myTurn()) { if (!quiet) onTurnBlocked(); return false; }
    if ((localXi || mySide().xi).filter(Boolean).length >= 11) return false;
    return true;
  }

  // Optimistically put `id` into slot `i` (flying from the pool card), then confirm with the server.
  async function doPick(id, i, fromRect) {
    if (view !== 'me') setView('me');
    const xi = [...(localXi || mySide().xi)];
    xi[i] = id;
    localXi = xi;
    const el = pcs.get(id) || makePitchCard(id);
    const c = cardTopLeft(i);
    if (fromRect) {
      const s = fromRect.width / geo.cardW;
      const sx = fromRect.left + (fromRect.width - geo.cardW) / 2, sy = fromRect.top + (fromRect.height - geo.cardH) / 2;
      stopAnim(el);
      el._x = c.x; el._y = c.y;
      const a = animate(el, { transform: [tf(sx, sy, s), tf(c.x, c.y)] }, SPRING);
      el._anim = a;
      a.finished.then(() => { if (el._anim === a) { el._anim = null; el.style.transform = tf(c.x, c.y); } }, () => {});
    } else springTo(el, c.x, c.y);
    animate(el.querySelector('.inner'), { transform: ['scale(1.12)', 'scale(1)'] }, { type: spring, stiffness: 420, damping: 18 });
    refreshCard(i);
    renderPool();
    updateHeader();
    try {
      await track(actions.pick(id, i));
    } catch (err) {
      localXi = null;
      toast('Pick failed', err);
      placeAll(true);
      renderPool();
      updateHeader();
    }
  }

  // ---------------------------------------------------------------- drag & drop
  let drag = null;
  document.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !visible) return;
    const pc = e.target.closest('.pc:not(.leaving)');
    const card = !pc && e.target.closest('.pool .pcard');
    if (!pc && !card) return;
    if (card && (card.classList.contains('picked') || card.classList.contains('taken'))) return;
    if (pc && !editable()) return;
    e.preventDefault();
    drag = { id: (pc || card).dataset.id, from: pc ? 'pitch' : 'pool', srcEl: pc || card, sx: e.clientX, sy: e.clientY, x: e.clientX, y: e.clientY, active: false };
  });
  document.addEventListener('pointermove', e => {
    if (!drag) return;
    drag.x = e.clientX; drag.y = e.clientY;
    if (!drag.active && Math.hypot(drag.x - drag.sx, drag.y - drag.sy) > 4) {
      if (drag.from === 'pool' && !canPickNow(false)) { drag = null; return; }
      startDrag();
    }
  }, { passive: true });
  document.addEventListener('pointerup', () => endDrag(false));
  document.addEventListener('pointercancel', () => endDrag(true));

  function startDrag() {
    const d = drag;
    d.active = true;
    if (view !== 'me') setView('me');
    geo.rect = pitch.getBoundingClientRect();
    d.centers = viewFormation().map((_, i) => slotCenter(i));
    d.radius = geo.cardW * 0.95;
    if (d.from === 'pitch') {
      d.el = d.srcEl;
      d.fromSlot = viewXi().indexOf(d.id);
      const cur = d.el._anim ? currentPos(d.el) : { x: d.el._x, y: d.el._y };
      setPos(d.el, cur.x, cur.y);
      d.offX = d.sx - cur.x; d.offY = d.sy - cur.y;
    } else {
      const r = d.srcEl.getBoundingClientRect();
      d.srcRect = r;
      d.el = makePitchCard(d.id);
      const k = geo.cardW / r.width;
      d.offX = (d.sx - r.left) * k; d.offY = (d.sy - r.top) * k;
      animate(d.el, { opacity: [0, 1] }, { duration: 0.12 });
      d.srcEl.classList.add('picked');
    }
    d.el.classList.add('dragging');
    d.inner = d.el.querySelector('.inner');
    animate(d.inner, { transform: 'scale(1.07) rotate(-2.5deg)' }, { type: spring, stiffness: 500, damping: 26 });
    document.body.classList.add('dragging');
    d.target = null;
    d.raf = requestAnimationFrame(frame);
  }

  // One transform write + a hit test against cached slot centres per display frame.
  function frame() {
    const d = drag;
    if (!d?.active) return;
    if (d.x !== d.lx || d.y !== d.ly) {
      d.lx = d.x; d.ly = d.y;
      const x = d.x - d.offX, y = d.y - d.offY;
      d.el.style.transform = tf(x, y);
      d.el._x = x; d.el._y = y;
      const cx = x + geo.cardW / 2, cy = y + geo.cardH / 2;
      let best = null, bestD = d.radius;
      d.centers.forEach((c, i) => { const dist = Math.hypot(c.x - cx, c.y - cy); if (dist < bestD) { bestD = dist; best = i; } });
      if (best !== d.target) { if (d.target != null) highlight(d.target, false); d.target = best; if (best != null) highlight(best, true); }
    }
    d.raf = requestAnimationFrame(frame);
  }
  function highlight(i, on) {
    const xi = viewXi();
    const occupant = xi[i] && xi[i] !== drag?.id ? pcs.get(xi[i]) : null;
    if (occupant) animate(occupant.querySelector('.inner'), { transform: on ? 'scale(.9)' : 'scale(1)', opacity: on ? 0.75 : 1 }, { type: spring, stiffness: 500, damping: 30 });
    else {
      animate(slots[i].querySelector('.glow'), { opacity: on ? 1 : 0, transform: on ? 'scale(1)' : 'scale(.92)' }, { duration: 0.16 });
      animate(slots[i].querySelector('.ring'), { transform: on ? 'scale(1.08)' : 'scale(1)' }, { type: spring, stiffness: 600, damping: 28 });
    }
  }

  function flyBack(d) {
    const el = d.el, r = d.srcRect || poolCards.get(d.id).getBoundingClientRect();
    pcs.delete(d.id);
    el.classList.add('leaving');
    const from = { x: el._x, y: el._y }, s = r.width / geo.cardW;
    animate(el, { transform: [tf(from.x, from.y), tf(r.left + (r.width - geo.cardW) / 2, r.top + (r.height - geo.cardH) / 2, s)], opacity: [1, 0] }, { duration: 0.35, ease: [0.22, 1, 0.36, 1] })
      .finished.then(() => el.remove(), () => el.remove());
    d.srcEl.classList.remove('picked');
  }

  function endDrag(cancelled) {
    const d = drag;
    drag = null;
    if (!d) return;
    if (!d.active) { if (!cancelled) handleClick(d); return; }
    cancelAnimationFrame(d.raf);
    document.body.classList.remove('dragging');
    d.el.classList.remove('dragging');
    if (d.target != null) highlight(d.target, false);
    animate(d.inner, { transform: 'scale(1) rotate(0deg)' }, { type: spring, stiffness: 500, damping: 30 });
    const t = cancelled ? null : d.target;
    const xi = [...(localXi || mySide().xi)];

    if (d.from === 'pool') {
      if (t == null || !canPickNow(true)) { flyBack(d); return; }
      clearSelectedSlot();
      const occupant = xi[t];
      if (!occupant) { pcs.set(d.id, d.el); doPick(d.id, t); return; }
      // Dropped on a filled spot: the new player takes it, the occupant moves to the best free spot.
      const e = bestEmptySlot(byId.get(occupant), mySide().formation, xi);
      if (e == null) { flyBack(d); return; }
      xi[e] = occupant; xi[t] = d.id; localXi = xi;
      const oc = cardTopLeft(e); springTo(pcs.get(occupant), oc.x, oc.y);
      const c = cardTopLeft(t); springTo(d.el, c.x, c.y);
      refreshCard(e); refreshCard(t); renderPool(); updateHeader();
      track(actions.pick(d.id, e).then(() => actions.swap(e, t))).catch(err => { localXi = null; toast('Pick failed', err); placeAll(true); renderPool(); updateHeader(); });
      return;
    }

    // From the pitch: swap / move within my XI, otherwise spring back.
    if (t == null || t === d.fromSlot) { const c = cardTopLeft(d.fromSlot); springTo(d.el, c.x, c.y); return; }
    const other = xi[t];
    xi[t] = d.id; xi[d.fromSlot] = other; localXi = xi;
    const c = cardTopLeft(t); springTo(d.el, c.x, c.y);
    if (other) { const oc = cardTopLeft(d.fromSlot); springTo(pcs.get(other), oc.x, oc.y); }
    refreshCard(t); refreshCard(d.fromSlot);
    track(actions.swap(d.fromSlot, t)).catch(err => { localXi = null; toast('Could not move player', err); placeAll(true); });
  }

  function handleClick(d) {
    if (d.from !== 'pool') return;
    if (!canPickNow(false)) return;
    const xi = localXi || mySide().xi;
    const p = byId.get(d.id);
    const i = selectedSlot != null && !xi[selectedSlot] ? selectedSlot : bestEmptySlot(p, mySide().formation, xi);
    if (i == null) return;
    clearSelectedSlot();
    doPick(d.id, i, d.srcEl.getBoundingClientRect());
  }

  // ---------------------------------------------------------------- header bits owned by the draft
  let shownValue = 0;
  function updateHeader() {
    const xi = localXi || mySide()?.xi || [];
    const total = xiValue(xi);
    const numEl = $('#xiValue');
    if (shownValue !== total) { const from = shownValue; shownValue = total; animate(from, total, { duration: 0.6, ease: [0.22, 1, 0.36, 1], onUpdate: v => { numEl.textContent = fmtEur(v); } }); }
    const n = xi.filter(Boolean).length;
    $('#xiCount').textContent = n;
    $('#xiCount').parentElement.classList.toggle('full', n === 11);
  }
  function updateHint() {
    const h = $('#pitchHint');
    if (view === 'rival') { h.textContent = `${room?.[rivalRole()]?.teamName || 'Rival'} · ${viewSide()?.formation || ''} · ${fmtEur(xiValue(viewXi()))}`; return; }
    if (room?.status !== 'draft') { h.textContent = ''; return; }
    h.textContent = room.turn === 'done'
      ? 'Draft complete — drag players to swap positions or change formation before kick-off'
      : 'Drag a player onto the pitch on your turn · click an empty spot to filter by position · drag your players to swap spots';
  }

  // Pick feed + rival-pick effects.
  function updateFeed(animated) {
    const feed = $('#pickFeed');
    const recent = room.picks.slice(-6).reverse();
    feed.innerHTML = recent.map(pk => {
      const p = byId.get(pk.playerId), side = room[pk.side];
      return `<span class="pf ${pk.side === role ? 'me' : 'rival'}" style="--c:${side?.color}" title="${esc(side?.name)} picked ${esc(p.name)}${pk.auto ? ' (auto)' : ''}"><img src="${p.img}" alt="" referrerpolicy="no-referrer"><span class="n">${pk.n}</span>${esc(p.name)}</span>`;
    }).join('');
    if (animated && feed.firstElementChild) animate(feed.firstElementChild, { opacity: [0, 1], transform: ['translateX(-14px) scale(.9)', 'translateX(0) scale(1)'] }, { type: spring, stiffness: 420, damping: 26 });
  }

  // ---------------------------------------------------------------- public
  function update(next, nextRole) {
    const prev = room;
    room = next; role = nextRole;
    // Server state wins once nothing of mine is in flight.
    if (pendingOps === 0) localXi = null;
    pool.style.setProperty('--rival', room[rivalRole()]?.color || '#2563eb');
    pitch.style.setProperty('--rival', room[rivalRole()]?.color || '#2563eb');
    const newPicks = room.picks.length > seenPicks ? room.picks.slice(seenPicks) : [];
    const resetDraft = room.picks.length < seenPicks;
    seenPicks = room.picks.length;
    renderPool(!pool.firstChild);
    if (visible) {
      const formationChanged = prev && prev[role]?.formation !== room[role]?.formation;
      placeAll(!!prev && !resetDraft);
      if (formationChanged) markFormation(true); else markFormation(false);
    }
    updateHeader();
    updateHint();
    updateFeed(newPicks.length > 0);
    for (const pk of newPicks) {
      const card = poolCards.get(pk.playerId);
      if (pk.side !== role) {
        animate(card, { transform: ['scale(1.06)', 'scale(1)'] }, { type: spring, stiffness: 400, damping: 18 });
        if (prev) toast(`${room[pk.side].name} picked ${byId.get(pk.playerId).name}`, pk.auto ? 'Auto-picked when the timer ran out.' : '', 2600);
      } else if (pk.auto && prev) toast(`Auto-picked ${byId.get(pk.playerId).name} for you`, 'The pick timer ran out.', 3000);
    }
  }

  function show(on) {
    visible = on;
    $('#bar').hidden = !on; $('#stage').hidden = !on;
    layer.style.display = on ? '' : 'none';
    if (on) requestAnimationFrame(() => {
      if (!geo.cardRatio) { const probe = makePitchCard(PLAYERS[0].id); geo.cardRatio = probe.offsetHeight / geo.cardW; probe.remove(); pcs.delete(PLAYERS[0].id); }
      warmUp();
      placeAll(false); markFormation(false); renderPool();
    });
  }

  // Run the first drag's one-time work (card creation, spring easing generation, WAAPI setup) ahead of time,
  // off-screen, so the first real drag doesn't drop a frame.
  let warmed = false;
  function warmUp() {
    if (warmed) return;
    warmed = true;
    const run = () => {
      const id = PLAYERS[PLAYERS.length - 1].id;
      if (pcs.has(id)) return;
      const el = makePitchCard(id);
      el.style.visibility = 'hidden';
      el.style.transform = tf(-9999, -9999);
      pcs.delete(id);
      const a = animate(el.querySelector('.inner'), { transform: 'scale(1.07) rotate(-2.5deg)' }, { type: spring, stiffness: 500, damping: 26 });
      const b = animate(el, { transform: [tf(-9999, -9999), tf(-9990, -9990)] }, SPRING);
      Promise.all([a.finished, b.finished]).finally(() => el.remove());
    };
    (window.requestIdleCallback || (f => setTimeout(f, 200)))(run);
  }

  let resizeRaf = 0;
  addEventListener('resize', () => { cancelAnimationFrame(resizeRaf); resizeRaf = requestAnimationFrame(() => { placeAll(false); markFormation(false); fitPoolNames(); }); });

  return { update, show, setView, myTurn, get view() { return view; } };
}
