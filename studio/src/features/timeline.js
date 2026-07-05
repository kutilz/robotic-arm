/* ============================================================================
   Timeline / playback (bottom bar) — mengadopsi fitur 3D simulation Waldo.
   Rekam keyframe pose sendi, interpolasi linear, play/pause/scrub.
   Juga sumber sampel trajektori untuk path preview.
   ========================================================================== */
import { STATE } from '../config/arm.js';
import { applyPose } from '../model/kinematics.js';
import { onFrame } from '../core/viewport.js';
import { icon } from '../ui/icons.js';

let keys = [];               // { t, angles:[6] }
let cursor = 0;              // detik
let playing = false;
let lastNow = 0;
const keyListeners = new Set();
export function onKeysChange(fn) { keyListeners.add(fn); return () => keyListeners.delete(fn); }
function keysChanged() { drawKeys(); for (const fn of keyListeners) fn(keys); }

export function duration() { return keys.length ? keys[keys.length - 1].t : 0; }

function snapshot() { return STATE.joints.map(j => j.a); }
function applyAngles(a) { STATE.joints.forEach((j, i) => { j.a = a[i]; }); applyPose(); }

function sampleAt(t) {
  if (!keys.length) return snapshot();
  if (t <= keys[0].t) return keys[0].angles.slice();
  if (t >= keys[keys.length - 1].t) return keys[keys.length - 1].angles.slice();
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (t >= a.t && t <= b.t) { const f = (t - a.t) / (b.t - a.t || 1); return a.angles.map((v, k) => v + (b.angles[k] - v) * f); }
  }
  return keys[keys.length - 1].angles.slice();
}

/** sampel N pose sepanjang trajektori (untuk path preview). */
export function sampleTrajectory(n = 80) {
  const d = duration(); if (d <= 0 || keys.length < 2) return [];
  const out = [];
  for (let i = 0; i <= n; i++) out.push(sampleAt(d * i / n));
  return out;
}
export function keyframes() { return keys; }

/* ---------------- transport ---------------- */
let els = {};
function seek(t) {
  cursor = Math.max(0, Math.min(duration(), t));
  applyAngles(sampleAt(cursor));
  drawCursor();
}
function play() {
  if (keys.length < 2 || STATE.estop) return;
  if (cursor >= duration()) cursor = 0;
  playing = true; lastNow = performance.now();
  els.play.innerHTML = icon('pause', 13); els.play.classList.add('primary');
}
function pause() { playing = false; els.play.innerHTML = icon('play', 13); els.play.classList.remove('primary'); }
export function stopPlayback() { pause(); }
export function togglePlay() { playing ? pause() : play(); }

export function addKey() {
  const t = keys.length ? duration() + 1.5 : 0;
  keys.push({ t, angles: snapshot() });
  cursor = t; keysChanged(); drawCursor();
}
export function clearKeys() { keys = []; cursor = 0; playing = false; pause(); keysChanged(); drawCursor(); }

/** muat set keyframe {t, angles} (mis. dari preset demo), opsional langsung play. */
export function loadKeyframes(newKeys, autoplay = true) {
  keys = newKeys.map(k => ({ t: k.t, angles: k.angles.slice() }));
  cursor = 0; keysChanged(); drawCursor();
  if (autoplay) { seek(0); play(); }
}
/** bangun keyframe dari daftar pose (array sudut) dengan spasi waktu dt (detik). */
export function keysFromPoses(poses, dt = 1.2) { return poses.map((a, i) => ({ t: i * dt, angles: a })); }
export function playFromStart() { seek(0); play(); }

function tick() {
  if (!playing) return;
  if (STATE.estop) { pause(); return; }
  const now = performance.now(); const dt = (now - lastNow) / 1000; lastNow = now;
  cursor += dt;
  if (cursor >= duration()) { cursor = duration(); pause(); }
  applyAngles(sampleAt(cursor)); drawCursor();
}

/* ---------------- drawing ---------------- */
function pct(t) { const d = duration(); return d > 0 ? (t / d) * 100 : 0; }
function drawCursor() {
  els.fill.style.width = pct(cursor) + '%';
  els.handle.style.left = pct(cursor) + '%';
  els.time.textContent = cursor.toFixed(2) + ' / ' + duration().toFixed(2) + ' s';
}
function drawKeys() {
  els.track.querySelectorAll('.tlKey').forEach(e => e.remove());
  for (const k of keys) { const m = document.createElement('div'); m.className = 'tlKey'; m.style.left = pct(k.t) + '%'; els.track.appendChild(m); }
  if (els.bar) els.bar.classList.toggle('empty', keys.length === 0);
}

export function buildTimeline(bar) {
  bar.innerHTML = `
    <button class="tlBtn" id="tlStart" title="Ke awal">${icon('skipBack', 13)}</button>
    <button class="tlBtn" id="tlPlay" title="Play / pause (Space)">${icon('play', 13)}</button>
    <div id="tlTrack"><div id="tlFill"></div><div id="tlHandle"></div></div>
    <span class="tlTime">0.00 / 0.00 s</span>
    <button class="tlBtn" id="tlAdd" title="Rekam keyframe pose sekarang">${icon('plus', 13)}</button>
    <button class="tlBtn" id="tlClear" title="Hapus semua keyframe">${icon('trash', 13)}</button>`;
  els = {
    bar,
    play: bar.querySelector('#tlPlay'),
    track: bar.querySelector('#tlTrack'),
    fill: bar.querySelector('#tlFill'),
    handle: bar.querySelector('#tlHandle'),
    time: bar.querySelector('.tlTime'),
  };
  bar.querySelector('#tlStart').onclick = () => { seek(0); pause(); };
  els.play.onclick = () => { playing ? pause() : play(); };
  bar.querySelector('#tlAdd').onclick = addKey;
  bar.querySelector('#tlClear').onclick = clearKeys;
  const trackSeek = (e) => { const r = els.track.getBoundingClientRect(); const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); seek(f * duration()); };
  let dragging = false;
  els.track.addEventListener('pointerdown', e => { dragging = true; els.track.setPointerCapture(e.pointerId); pause(); trackSeek(e); });
  els.track.addEventListener('pointermove', e => { if (dragging) trackSeek(e); });
  els.track.addEventListener('pointerup', () => dragging = false);

  onFrame(tick);
  drawCursor(); drawKeys();
}
