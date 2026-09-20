/* ============================================================================
   Timeline / playback (bottom bar): mengadopsi fitur 3D simulation Waldo.
   Rekam keyframe pose sendi, play/pause/scrub, plus sumber sampel trajektori
   untuk path preview.

   Matematikanya TIDAK di sini melainkan di model/traj.js, yang murni dan bisa
   diuji tanpa WebGL (`node studio/tools/verify_traj.mjs`). File ini tinggal
   transport dan gambar bar. Ringkasnya: interpolasi kubik Hermite monoton,
   bukan linear, karena linear membuat kecepatan melompat di tiap keyframe dan
   itulah sentakan yang terlihat saat lengan berbelok. Alasan lengkapnya ada di
   kepala traj.js.

   KEYFRAME BERTAHAN LINTAS RELOAD sejak 13 Agu 2026. Sebelumnya `keys` cuma
   variabel modul, jadi tombol `+` merekam ke MEMORI saja dan seluruh lintasan
   hilang tiap kali halaman dimuat ulang: F5, restart `npm run dev`, atau
   reload penuh dari HMR. Tidak ada peringatan apa pun karena memang tidak ada
   yang gagal, cuma tidak pernah ada yang disimpan.
   ========================================================================== */
import { STATE } from '../config/arm.js';
import { applyPose } from '../model/kinematics.js';
import { onFrame } from '../core/viewport.js';
import { icon } from '../ui/icons.js';
import { hermiteTangents, sampleAt as trajSampleAt, keysFromPoses as trajKeys } from '../model/traj.js';
import { getTwinCal } from '../model/cadRig.js';
import { isLive, setLive } from '../net/liveLink.js';

const LS_KEY = 'armstudio.timeline.v1';

let keys = [];               // { t, angles:[6] }
let cursor = 0;              // detik
let playing = false;
let lastNow = 0;
let tang = null;             // tangen Hermite per keyframe per sendi; null = basi
/* Kalibrasi twin yang berlaku saat keyframe direkam. Sudut keyframe adalah
   sudut PERINTAH, sedangkan kalibrasi twin menentukan bagaimana sudut itu
   digambar, jadi lintasan yang direkam sambil melihat twin dengan arah sendi
   lain akan terlihat cermin saat diputar sekarang. Keyframe-nya TIDAK dibuang
   karena ini murni pratinjau 3D dan membuang pekerjaan orang diam diam lebih
   buruk daripada menampilkan pratinjau yang perlu direkam ulang; yang dilakukan
   cuma menandainya supaya kejanggalannya punya nama. Dibaca controlCard. */
let calSaat = null;
const keyListeners = new Set();
export function onKeysChange(fn) { keyListeners.add(fn); return () => keyListeners.delete(fn); }
function keysChanged() { tang = null; save(); drawKeys(); for (const fn of keyListeners) fn(keys); }

/** sidik jari kalibrasi twin, untuk menandai keyframe yang direkam di konvensi
 *  arah sendi yang berbeda. */
function calFinger() {
  const c = getTwinCal();
  return c.dir.join(',') + '|' + c.trim.join(',');
}
/** true bila keyframe yang ada direkam dengan kalibrasi twin yang berbeda. */
export function keysStale() { return !!(keys.length && calSaat && calSaat !== calFinger()); }

function save() {
  try {
    if (!keys.length) { localStorage.removeItem(LS_KEY); calSaat = null; return; }
    // Direkam ulang di kalibrasi sekarang: begitu keyframe berubah, sidik
    // jarinya ikut segar, jadi tanda "cermin" tidak menempel selamanya.
    calSaat = calFinger();
    localStorage.setItem(LS_KEY, JSON.stringify({ cal: calSaat, keys }));
  } catch { /* kuota penuh / mode privat: lintasan tidak persisten, bukan fatal */ }
}

/** Pulihkan keyframe dari sesi sebelumnya. Sengaja TIDAK mem-pose model: pose
 *  yang sedang dipegang (atau feedback yang sedang masuk) tidak boleh tergeser
 *  hanya karena ada lintasan tersimpan. */
function restore() {
  try {
    const o = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (!o || !Array.isArray(o.keys) || !o.keys.length) return;
    const ok = o.keys.every(k => Number.isFinite(k.t) && Array.isArray(k.angles)
      && k.angles.length === STATE.joints.length && k.angles.every(Number.isFinite));
    if (!ok) return;   // isi rusak/format lama: mulai bersih, jangan crash
    keys = o.keys.map(k => ({ t: k.t, angles: k.angles.slice() }));
    cursor = 0;
    tang = null;
    drawKeys(); drawCursor();
    for (const fn of keyListeners) fn(keys);
    calSaat = typeof o.cal === 'string' ? o.cal : null;
  } catch { /* localStorage rusak/diblokir: jalan tanpa lintasan tersimpan */ }
}

export function duration() { return keys.length ? keys[keys.length - 1].t : 0; }

function snapshot() { return STATE.joints.map(j => j.a); }
function applyAngles(a) { STATE.joints.forEach((j, i) => { j.a = a[i]; }); applyPose(); }

/* Tangen dihitung sekali per perubahan keyframe, bukan per frame: playback
   memanggil sampleAt 60 kali per detik dan path preview 120 kali sekaligus. */
function sampleAt(t) {
  if (!keys.length) return snapshot();
  if (!tang) tang = hermiteTangents(keys);
  return trajSampleAt(keys, t, tang);
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
  /* Playback MEMATIKAN mode live. Timeline menulis pose twin 60 kali per detik,
     dan aliran live mengirim apa pun yang ada di pose twin, jadi tanpa baris
     ini tombol play di blok yang dilabeli "pratinjau 3D (tidak menggerakkan
     lengan)" akan menjalankan seluruh demo di lengan sungguhan. Beberapa demo
     memang tidak boleh dikirim ke sana (sapu memutar J4 sampai +-120 dan J6
     +-60, sedangkan J6 fisik masih mentok), jadi label itu harus tetap benar. */
  if (isLive()) setLive(false, 'Playback timeline dimulai: mode LIVE dimatikan, '
    + 'pratinjau 3D tidak boleh ikut dikirim ke lengan.');
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
/** bangun keyframe dari daftar pose; waktu tiap ruas ikut jarak tempuh
 *  (lihat traj.js untuk alasannya). */
export const keysFromPoses = trajKeys;
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
  // Dipanggil PALING AKHIR: pelanggan onKeysChange (path preview, audit
  // lintasan di mode RUTIN) sudah terpasang saat ini, jadi lintasan yang
  // dipulihkan langsung ikut tergambar tanpa perlu disentuh dulu.
  restore();
}
