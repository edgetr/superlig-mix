// Match screen: plays the GPT-6 Luna simulation as an animated canvas "video", synced between
// both players (pause / resume / seek / speed are shared), with a live commentary feed,
// spoiler-free stats/ratings/analysis after full time, and video download.
import { animate, spring, stagger } from 'motion';
import { createMatch, W, H } from './match/renderer.js';
import { esc } from './draft.js';
import { byId } from './draft.js';
import { FORMATIONS } from '../../shared/game.js';

const $ = s => document.querySelector(s);
const ICON = { goal: '⚽', penalty_goal: '⚽', own_goal: '⚽', yellow: '🟨', second_yellow: '🟨🟥', red: '🟥', save: '🧤', woodwork: '🥅', var: '📺', injury: '🩹', penalty_miss: '❌', half_time: '⏸', full_time: '🏁', kickoff: '▶', second_half: '▶', corner: '⛳', offside: '🚩', chance: '🔥', shot: '🎯', block: '🛡' };
const BIG = new Set(['goal', 'penalty_goal', 'own_goal', 'red', 'second_yellow', 'penalty_miss', 'half_time', 'full_time', 'var', 'woodwork']);
const fmtT = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export function createMatchScreen({ client, api, getSess, toast, serverNow }) {
  const canvas = $('#matchCanvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false });
  let room = null, visible = false;
  let match = null, jobId = null, items = [], unsubEvents = null;
  let raf = 0, lastDrawT = -1, lastDrawLen = -1;
  let seeking = null;           // local preview position while dragging the seek bar
  let autoPaused = false;       // host paused because GPT-6 Luna hasn't written that far yet
  let tab = 'live', revealed = false, exporting = null, lastFeedLen = -1;

  const sess = () => getSess();
  const isHost = () => sess()?.role === 'host';
  const setPlayback = (playing, pos, rate) => client.mutation(api.rooms.setPlayback, { roomId: sess().roomId, key: sess().key, playing, pos: Math.max(0, Math.round(pos)), ...(rate ? { rate } : {}) })
    .catch(e => toast('Playback', e));

  function teamsFrom(r) {
    const team = s => ({
      name: s.teamName, color: s.color, formation: s.formation,
      players: s.xi.map((id, i) => { const p = byId.get(id); return { id, name: p.name, role: FORMATIONS[s.formation][i][0], img: p.img, value: p.value }; }),
    });
    return { A: team(r.host), B: team(r.guest) };
  }

  // Current playback position from the shared (server) clock.
  function position() {
    if (seeking != null) return seeking;
    const pb = room.playback;
    const t = pb.playing ? pb.pos + (serverNow() - pb.at) * pb.rate : pb.pos;
    return Math.max(0, Math.min(t, match ? match.duration : 0));
  }
  const rawPosition = () => { const pb = room.playback; return pb.playing ? pb.pos + (serverNow() - pb.at) * pb.rate : pb.pos; };

  // ---------------------------------------------------------------- data
  function ensureMatch(r) {
    if (r.sim.jobId === jobId && match) return;
    jobId = r.sim.jobId;
    match = createMatch({ teams: teamsFrom(r) });
    match.preload?.().then(() => { lastDrawT = -1; });
    items = []; revealed = false; lastFeedLen = -1; tab = 'live';
    unsubEvents?.();
    unsubEvents = client.onUpdate(api.rooms.events, { roomId: sess().roomId, key: sess().key, jobId }, rows => {
      items = rows.map(r => ({ kind: r.kind, data: r.data }));
      match.setItems(items);
      lastDrawLen = -1;
      updateBuffer();
      renderSide(true);
    });
    renderTabs();
  }

  // ---------------------------------------------------------------- loop
  function loop() {
    raf = requestAnimationFrame(loop);
    if (!room || !match || exporting) return; // the exporter gets the CPU/GPU to itself
    const t = position();
    if (t !== lastDrawT || items.length !== lastDrawLen) {
      match.render(ctx, t);
      lastDrawT = t; lastDrawLen = items.length;
      updateProgress(t);
      renderSide(false);
    }
    handleBuffering();
  }

  function handleBuffering() {
    const pb = room.playback, raw = rawPosition(), dur = match.duration, complete = match.complete;
    const underrun = pb.playing && raw > dur + 250 && !complete;
    const ended = complete && raw >= dur - 30;
    const failed = room.sim.state === 'error';
    const wait = $('#mWait');
    const showWait = (underrun || (!pb.playing && autoPaused)) && !failed;
    if (wait.hidden === showWait) wait.hidden = !showWait;
    if (showWait) $('#mWaitText').textContent = room.sim.phase || 'GPT-6 Luna is writing the match…';
    if (failed && !handleBuffering.failShown) { handleBuffering.failShown = true; toast('The simulation stopped', room.sim.error || ''); }
    if (!failed) handleBuffering.failShown = false;
    $('#mBigPlay').hidden = !(ended && !pb.playing);
    $('#mPlay').textContent = pb.playing ? '❚❚' : '▶';
    if (!isHost()) return;
    // The host is the clock authority while GPT-6 Luna is still streaming.
    const now = performance.now();
    if (now - (handleBuffering.last || 0) < 500) return;
    if (underrun) { handleBuffering.last = now; autoPaused = true; setPlayback(false, dur); }
    else if (autoPaused && !pb.playing && (complete || dur - pb.pos > 4000)) { handleBuffering.last = now; autoPaused = false; setPlayback(true, pb.pos); }
    else if (ended && pb.playing) { handleBuffering.last = now; setPlayback(false, dur); }
  }

  // ---------------------------------------------------------------- controls
  function updateProgress(t) {
    const dur = match.duration || 1;
    const total = match.complete ? dur : Math.max(dur, 1);
    const seekW = $('#mSeek').clientWidth;
    $('#mProg').style.transform = `scaleX(${Math.min(1, t / total)})`;
    $('#mKnob').style.transform = `translateX(${Math.min(1, t / total) * seekW}px)`;
    const label = `${fmtT(t)} / ${match.complete ? fmtT(dur) : fmtT(dur) + '…'}`;
    if (label !== updateProgress.label) { updateProgress.label = label; $('#mTime').textContent = label; }
  }
  function updateBuffer() {
    $('#mBuf').style.transform = `scaleX(${match.complete ? 1 : 0.999})`;
    $('#mDownload').disabled = !match.complete || !!exporting;
    // Goal markers only once the match has been watched to the end (no spoilers).
    const marks = $('#mMarks');
    if (!revealed || !match.timeline) { marks.innerHTML = ''; return; }
    const dur = match.duration || 1;
    marks.innerHTML = match.timeline().filter(s => s.kind === 'ev' && /goal/.test(s.type || ''))
      .map(s => `<i style="left:${(s.start / dur) * 100}%;--c:${s.side === 'A' ? room.host.color : room.guest.color}" title="${esc(s.minute || '')}"></i>`).join('');
  }

  $('#mPlay').addEventListener('click', togglePlay);
  $('#mBigPlay').addEventListener('click', () => setPlayback(true, 0));
  $('#mRestart').addEventListener('click', () => { autoPaused = false; setPlayback(true, 0); });
  function togglePlay() {
    if (!match) return;
    const t = position();
    autoPaused = false;
    if (room.playback.playing) setPlayback(false, t);
    else setPlayback(true, match.complete && t >= match.duration - 50 ? 0 : t);
  }
  document.addEventListener('keydown', e => {
    if (!visible || e.target.closest('input, textarea, select')) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
      e.preventDefault();
      const t = Math.min(match.duration, Math.max(0, position() + (e.code === 'ArrowLeft' ? -5000 : 5000)));
      setPlayback(room.playback.playing, t);
    }
  });

  const speedEl = $('#mSpeed');
  speedEl.innerHTML = [0.5, 1, 1.5, 2].map(r => `<button data-r="${r}">${r}×</button>`).join('');
  speedEl.addEventListener('click', e => {
    const b = e.target.closest('button[data-r]');
    if (b) setPlayback(room.playback.playing, position(), Number(b.dataset.r));
  });

  // Seek bar: local preview while dragging, commit on release.
  const seekEl = $('#mSeek');
  seekEl.addEventListener('pointerdown', e => {
    if (!match?.duration) return;
    seekEl.setPointerCapture(e.pointerId);
    const r = seekEl.getBoundingClientRect();
    const at = ev => Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * match.duration;
    seeking = at(e);
    const move = ev => { seeking = at(ev); };
    const up = () => {
      seekEl.removeEventListener('pointermove', move);
      seekEl.removeEventListener('pointerup', up);
      const pos = seeking; seeking = null; autoPaused = false;
      setPlayback(room.playback.playing, pos);
    };
    seekEl.addEventListener('pointermove', move);
    seekEl.addEventListener('pointerup', up);
  });

  $('#mFull').addEventListener('click', () => {
    const v = $('#mVideo');
    if (document.fullscreenElement) document.exitFullscreen(); else v.requestFullscreen?.();
  });

  // ---------------------------------------------------------------- download video
  $('#mDownload').addEventListener('click', async () => {
    if (!match?.complete || exporting) return;
    const ctrl = new AbortController();
    exporting = ctrl;
    const btn = $('#mDownload');
    btn.disabled = true;
    const foot = $('#mFoot');
    const bar = document.createElement('div');
    bar.className = 'export-wrap';
    bar.innerHTML = `<div style="display:flex;justify-content:space-between;font-size:12px"><span>Rendering video… (the preview pauses meanwhile)</span><button class="link-btn" id="cancelExport">Cancel</button></div><div class="export-bar"><i></i></div>`;
    foot.after(bar);
    bar.querySelector('#cancelExport').addEventListener('click', () => ctrl.abort());
    try {
      const { exportVideo } = await import('./match/export.js');
      const { blob, extension } = await exportVideo(match, {
        fps: 30, signal: ctrl.signal,
        onProgress: p => { bar.querySelector('i').style.transform = `scaleX(${p})`; btn.textContent = `${Math.round(p * 100)}%`; },
      });
      const a = document.createElement('a');
      const slug = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ı/g, 'i').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      a.download = `${slug(room.host.teamName)}-vs-${slug(room.guest.teamName)}.${extension}`;
      a.href = URL.createObjectURL(blob);
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
      toast('Video ready', `Saved ${a.download} (${(blob.size / 1e6).toFixed(1)} MB)`);
    } catch (e) {
      if (e?.name !== 'AbortError') toast('Video export failed', e);
    } finally {
      exporting = null;
      lastDrawT = -1;
      bar.remove();
      btn.textContent = '⬇ Video';
      btn.disabled = !match?.complete;
    }
  });

  // ---------------------------------------------------------------- side panel
  const mTabs = $('#mTabs');
  function renderTabs() {
    const list = [['live', 'Live'], ['stats', 'Stats'], ['ratings', 'Ratings'], ['analysis', 'Analysis']];
    mTabs.innerHTML = list.map(([k, l]) => `<button data-t="${k}" class="${tab === k ? 'on' : ''}" ${k !== 'live' && !revealed ? 'disabled title="Revealed at full time"' : ''}>${l}${k !== 'live' && !revealed ? ' 🔒' : ''}</button>`).join('');
  }
  mTabs.addEventListener('click', e => {
    const b = e.target.closest('button[data-t]');
    if (!b || b.disabled) return;
    tab = b.dataset.t; renderTabs(); lastFeedLen = -1; renderSide(true);
    animate('#mPanel', { opacity: [0, 1], transform: ['translateY(6px)', 'translateY(0)'] }, { duration: 0.25 });
  });

  const kind = k => items.find(i => i.kind === k)?.data;
  function renderSide(force) {
    if (!room || !match) return;
    const t = position();
    const info = match.infoAt(t) || {};
    const score = info.score || [0, 0];
    const sc = $('#mScore');
    const scoreKey = `${score[0]}-${score[1]}-${info.minute}`;
    if (sc.dataset.k !== scoreKey) {
      const changed = sc.dataset.score && sc.dataset.score !== `${score[0]}-${score[1]}`;
      sc.dataset.k = scoreKey; sc.dataset.score = `${score[0]}-${score[1]}`;
      sc.innerHTML = `<div class="tm" style="--kit:${room.host.color}"><i></i>${esc(room.host.teamName)}</div>
        <div class="sc">${score[0]} – ${score[1]}</div>
        <div class="tm b" style="--kit:${room.guest.color}"><i></i>${esc(room.guest.teamName)}</div>
        <div class="min">${esc(info.minute || '')}</div>`;
      if (changed) animate(sc.querySelector('.sc'), { transform: ['scale(1.35)', 'scale(1)'] }, { type: spring, stiffness: 400, damping: 14 });
    }
    if (info.fullTimeReached && !revealed) {
      revealed = true; renderTabs(); updateBuffer();
      animate(mTabs.querySelectorAll('button'), { transform: ['scale(1)', 'scale(1.1)', 'scale(1)'] }, { delay: stagger(0.06), duration: 0.4 });
    }

    const panel = $('#mPanel');
    if (tab === 'live') {
      const tl = match.timeline ? match.timeline() : [];
      const shown = tl.filter(s => s.kind === 'ev' && s.start <= t && s.itemIndex >= 0);
      if (!force && shown.length === lastFeedLen) return;
      const row = s => {
        const d = items[s.itemIndex]?.data || {};
        const c = d.side === 'A' ? room.host.color : d.side === 'B' ? room.guest.color : '#888';
        return `<div class="feed-item${BIG.has(d.type) ? ' big' : ''}" style="--c:${c}"><span class="fm">${esc(s.minute || '')}</span><span class="ft">${ICON[d.type] ? `<span class="ic">${ICON[d.type]}</span>` : ''}${esc(d.text || '')}</span></div>`;
      };
      // Normal playback only appends: insert just the new rows at the top instead of rebuilding the list.
      if (!force && lastFeedLen > 0 && shown.length > lastFeedLen && panel.querySelector('.feed-item')) {
        const fresh = shown.slice(lastFeedLen).reverse();
        panel.insertAdjacentHTML('afterbegin', fresh.map(row).join(''));
        lastFeedLen = shown.length;
        animate(panel.firstElementChild, { opacity: [0, 1], transform: ['translateY(-8px)', 'translateY(0)'] }, { duration: 0.3 });
        return;
      }
      lastFeedLen = shown.length;
      panel.innerHTML = shown.length ? shown.slice().reverse().map(row).join('')
        : `<p class="muted" style="text-align:center;margin-top:30px">${room.sim.state === 'error' ? esc(room.sim.error) : 'Kick-off soon…'}</p>`;
      return;
    }
    if (!force) return;
    if (tab === 'stats') {
      const s = kind('stats');
      if (!s) { panel.innerHTML = '<p class="muted">No stats yet.</p>'; return; }
      const rows = [['possession', 'Possession', '%'], ['shots', 'Shots'], ['on_target', 'On target'], ['xg', 'xG'], ['corners', 'Corners'], ['fouls', 'Fouls'], ['offsides', 'Offsides'], ['yellow', 'Yellow cards'], ['red', 'Red cards']];
      panel.innerHTML = rows.filter(([k]) => Array.isArray(s[k])).map(([k, label, unit = '']) => {
        const [a, b] = s[k].map(Number), tot = (a + b) || 1;
        return `<div class="stat-row"><div class="k"><span>${a}${unit}</span><span>${label}</span><span>${b}${unit}</span></div>
          <div class="bars"><i style="width:${(a / tot) * 100}%;--c:${room.host.color}"></i><i style="width:${(b / tot) * 100}%;--c:${room.guest.color}"></i></div></div>`;
      }).join('') + (s.motm ? `<div class="an-card" style="--kit:${s.motm.side === 'B' ? room.guest.color : room.host.color};margin-top:12px"><div class="lbl">Man of the match</div><h4>${esc(s.motm.player)}</h4><p class="res" style="margin:0">${esc(s.motm.reason || '')}</p></div>` : '');
      animate(panel.querySelectorAll('.bars i'), { transform: ['scaleX(0)', 'scaleX(1)'] }, { delay: stagger(0.04), duration: 0.6, ease: [0.22, 1, 0.36, 1] });
    }
    if (tab === 'ratings') {
      const r = kind('ratings');
      if (!r) { panel.innerHTML = '<p class="muted">No ratings yet.</p>'; return; }
      const col = (list, side) => `<div class="an-card" style="--kit:${side.color}"><h4>${esc(side.teamName)}</h4>${(list || []).slice().sort((x, y) => y.rating - x.rating).map(x => `<div class="rt"><span>${esc(x.player)}</span><b style="color:${x.rating >= 8 ? 'var(--good)' : x.rating < 6 ? 'var(--bad)' : 'inherit'}">${Number(x.rating).toFixed(1)}</b></div>`).join('')}</div>`;
      panel.innerHTML = col(r.A, room.host) + col(r.B, room.guest);
    }
    if (tab === 'analysis') {
      const list = items.filter(i => i.kind === 'analysis').map(i => i.data);
      if (!list.length) { panel.innerHTML = '<p class="muted">No analysis yet.</p>'; return; }
      panel.innerHTML = list.map(a => {
        const side = a.side === 'B' ? room.guest : room.host;
        return `<div class="an-card" style="--kit:${side.color}"><h4>${esc(side.teamName)}</h4>
          ${a.resembles ? `<p class="res">Plays like <b>${esc(a.resembles.club)}</b> <span class="muted">(${esc(a.resembles.league)})</span><br><span class="muted">${esc(a.resembles.why)}</span></p>` : ''}
          <p style="font-size:12.5px;margin:0 0 6px">${esc(a.summary || '')}</p>
          <div class="lbl">Strengths</div><ul>${(a.strengths || []).map(x => `<li>${esc(x)}</li>`).join('')}</ul>
          <div class="lbl">Weaknesses</div><ul>${(a.weaknesses || []).map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
      }).join('');
      animate(panel.querySelectorAll('.an-card'), { opacity: [0, 1], transform: ['translateY(10px)', 'translateY(0)'] }, { delay: stagger(0.08), duration: 0.35 });
    }
  }

  function renderFoot() {
    const f = $('#mFoot');
    const key = `${isHost()}-${room.sim.state}`;
    if (f.dataset.k === key) return;
    f.dataset.k = key;
    f.innerHTML = (isHost() ? '<button class="btn" id="rematchBtn">Rematch (new draft)</button>' : '')
      + (isHost() && room.sim.state === 'error' ? '<button class="btn" id="retryBtn">Retry simulation</button>' : '');
    f.querySelector('#rematchBtn')?.addEventListener('click', () => {
      if (confirm('Start a new draft with the same rival?')) client.mutation(api.rooms.rematch, { roomId: sess().roomId, key: sess().key }).catch(e => toast('Rematch', e));
    });
    f.querySelector('#retryBtn')?.addEventListener('click', () => client.mutation(api.rooms.retrySim, { roomId: sess().roomId, key: sess().key }).catch(e => toast('Retry', e)));
  }

  // ---------------------------------------------------------------- public
  function update(r) {
    room = r;
    ensureMatch(r);
    speedEl.querySelectorAll('button').forEach(b => b.classList.toggle('on', Number(b.dataset.r) === r.playback.rate));
    if (r.playback.playing) autoPaused = false;
    renderFoot();
    lastDrawT = -1;
  }
  function show(on) {
    if (on === visible) return;
    visible = on;
    cancelAnimationFrame(raf);
    if (on) {
      raf = requestAnimationFrame(loop);
      animate('#mVideo', { opacity: [0, 1], transform: ['scale(.97)', 'scale(1)'] }, { type: spring, stiffness: 300, damping: 30 });
    } else if (!on) {
      unsubEvents?.(); unsubEvents = null; match = null; jobId = null;
    }
  }
  return { update, show };
}
