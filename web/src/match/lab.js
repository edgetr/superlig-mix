import { createMatch, W, H } from './renderer.js';
import { exportVideo } from './export.js';
import { MOCK_TEAMS, MOCK_ITEMS } from './mock.js';

const cv = document.getElementById('cv');
const ctx = cv.getContext('2d', { alpha: false });
let match = createMatch({ teams: MOCK_TEAMS });
match.setItems(MOCK_ITEMS);
window.__lab = { createMatch, MOCK_TEAMS, MOCK_ITEMS, exportVideo, get match() { return match; }, W, H };
await match.preload();
window.__labReady = true;

let t = 0, playing = true, speed = 1, last = performance.now(), streamN = MOCK_ITEMS.length;
const $ = id => document.getElementById(id);
const fmt = ms => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

$('play').onclick = () => { playing = !playing; $('play').textContent = playing ? 'Pause' : 'Play'; };
$('scrub').oninput = e => { t = (e.target.value / 1000) * match.duration; };
document.querySelectorAll('[data-speed]').forEach(b => b.onclick = () => {
  speed = Number(b.dataset.speed);
  document.querySelectorAll('[data-speed]').forEach(x => x.classList.toggle('on', x === b));
});
$('stream').onchange = e => {
  match = createMatch({ teams: MOCK_TEAMS }); match.preload();
  streamN = e.target.checked ? 1 : MOCK_ITEMS.length;
  match.setItems(MOCK_ITEMS.slice(0, streamN)); t = 0;
};
setInterval(() => {
  if (!$('stream').checked || streamN >= MOCK_ITEMS.length) return;
  streamN = Math.min(MOCK_ITEMS.length, streamN + 3);
  match.setItems(MOCK_ITEMS.slice(0, streamN));
}, 700);

$('export').onclick = async () => {
  const p = $('prog'); p.hidden = false; $('export').disabled = true;
  try {
    const r = await exportVideo(match, { onProgress: v => { p.value = v; } });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(r.blob); a.download = `match.${r.extension}`; a.click();
    $('info').textContent = `Exported ${r.frames} frames as ${r.mimeType} (${(r.blob.size / 1e6).toFixed(1)} MB) in ${(r.ms / 1000).toFixed(1)}s`;
  } catch (e) { $('info').textContent = 'Export failed: ' + e.message; }
  p.hidden = true; $('export').disabled = false;
};

function frame(now) {
  const dt = now - last; last = now;
  if (playing) t = Math.min(match.duration, t + dt * speed);
  match.render(ctx, t);
  const info = match.infoAt(t);
  $('time').textContent = `${fmt(t)} / ${fmt(match.duration)}${match.complete ? '' : ' (streaming…)'}`;
  $('scrub').value = match.duration ? Math.round((t / match.duration) * 1000) : 0;
  if (!$('info').textContent.startsWith('Export')) $('info').textContent = `${info.minute} · ${info.score.join('-')} · ${info.sceneType} · ${info.text}`;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
