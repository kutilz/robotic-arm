/* ============================================================================
   Tab RUTIN: menjalankan rutin hardware dari HP, plus pratinjau 3D.

   Sumber langkahnya config/routines.js, satu satunya tempat. Yang TIDAK ikut ke
   sini adalah dua hal yang di desktop hidup di localStorage: `overrides` (pose
   hasil teach) dan `verified` (tanda langkah sudah dibuktikan). Keduanya tidak
   bisa menyeberang ke HP, karena localStorage terikat origin DAN perangkat.
   Konsekuensinya harus disebut terang terangan, bukan disamarkan:

     Yang dijalankan HP adalah pose di REPO, bukan pose hasil teach terakhir di
     laptop. Selama hasil teach sudah dikembalikan ke config/routines.js lewat
     "ekspor rutin" di studio desktop, keduanya sama. Kalau belum, HP menjalankan
     angka yang lebih lama.

   Panel ini karena itu memajang cap waktu sumbernya sebagai peringatan tetap,
   dan gerbang "jalan penuh baru terbuka setelah semua langkah terverifikasi"
   milik desktop DIGANTI, bukan dihapus: di sini yang menggantikannya adalah
   pratinjau 3D wajib-lihat plus tombol jalan yang menyebut jumlah langkah dan
   siklusnya. Verifikasi per langkah tetap pekerjaan studio desktop di depan
   lengan, bukan pekerjaan layar 6 inci di tangan orang yang sedang bicara.

   Mesin auto-run-nya (urutan, deteksi tiba, titik ukur) disalin dari runFull()
   di features/runner.js dengan konstanta yang sama persis. Yang penting bukan
   kemiripan kodenya melainkan satu sifat: deteksi "sudah sampai" hanya memakai
   J1..J4. J5/J6 memakai pot servo yang belum terkalibrasi, jadi menunggunya
   berarti menunggu angka yang belum tentu berarti; servo diberi waktu tetap.
   Dan untuk J3/J4 yang open-loop, yang terbukti cuma "profil geraknya selesai
   dijalankan", bukan "lengannya ada di sana": step counter tiba di target
   meskipun langkahnya hilang. Celah itu tidak bisa ditutup dari sisi layar.
   ========================================================================== */
import { STATE } from '../config/arm.js';
import { ROUTINES, SPEED } from '../config/routines.js';
import { applyPose } from '../model/kinematics.js';
import { onFrame } from '../core/viewport.js';
import { hermiteTangents, sampleAt, keysFromPoses } from '../model/traj.js';
import { lineSteps } from '../features/demos.js';
import { sendPose, setLive, setProfile, blockedReason, isLive } from '../net/liveLink.js';
import { getActual, isDriverOk, sendServoUs, SERVO_GRIP } from '../net/bridge.js';
import { el, sec, btn, note, toast, row } from './ui.js';
import { gripPulses } from './grip.js';

const NSTEP_ENC = 4;          // J1..J4 stepper; J5/J6 servo tidak dipakai deteksi tiba
const ARRIVE_TOL = 1.5;       // deg
const ARRIVE_TIMEOUT = 20000; // ms
const SERVO_SETTLE = 700;     // ms
const GRIP_SETTLE = 800;      // ms

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const isPose = (s) => Array.isArray(s.a);

let key = 'pickPlace';
let steps = [];
let idx = 0;
let running = false;
let abortRun = false;
let continueResolve = null;
let els = {};

/* ---------------- pratinjau 3D ---------------- */
/* Timeline desktop (features/timeline.js) TIDAK dipakai ulang di sini meskipun
   matematikanya sama. Modul itu menulis ke DOM bar-nya sendiri lewat `els` yang
   diisi buildTimeline(), jadi memanggil loadKeyframes() tanpa bar itu langsung
   melempar. Yang dipakai ulang adalah lapisan yang memang murni: model/traj.js. */
let pv = null;   // { keys, tang, t, dur }

function stopPreview(why) {
  if (!pv) return;
  pv = null;
  drawStep();
  if (why) toast(why, 'warn');
}

function startPreview() {
  if (running) { toast('Rutin sedang jalan di lengan. Hentikan dulu.', 'warn'); return; }
  const poses = steps.filter(isPose).map(s => s.a.slice());
  if (poses.length < 2) { toast('Rutin ini tidak punya cukup pose untuk dianimasikan.', 'warn'); return; }
  const keys = keysFromPoses(poses, 1.1);
  pv = { keys, tang: hermiteTangents(keys), t: 0, dur: keys[keys.length - 1].t };
  drawStep();
  toast('Pratinjau 3D: model saja, tidak ada satu byte pun dikirim ke lengan.', 'ok');
}

function previewTick(dt) {
  if (!pv) return;
  pv.t += dt;
  if (pv.t >= pv.dur) { pv.t = pv.dur; }
  const a = sampleAt(pv.keys, pv.t, pv.tang);
  STATE.joints.forEach((j, i) => { j.a = a[i]; });
  applyPose();
  if (pv.t >= pv.dur) stopPreview();
  else if (els.prevBtn) els.prevBtn.textContent = `PRATINJAU 3D  ${pv.t.toFixed(1)}/${pv.dur.toFixed(1)} s`;
}

/* ---------------- langkah ---------------- */
function buildSteps() {
  const r = ROUTINES[key];
  steps = r.dynamic === 'line' ? lineSteps(r.line) : r.steps.map(s => ({ ...s }));
  idx = 0;
}

/** tunggu J1..J4 masuk toleransi. null = timeout, false = dibatalkan. */
async function waitArrive(tgt) {
  const t0 = Date.now();
  for (;;) {
    if (abortRun || STATE.estop) return false;
    /* Driver hilang di tengah langkah: pulsa keluar, poros tidak ikut. Menunggu
       step counter di sini sama dengan menunggu bukti yang dibuat sendiri. */
    if (!isDriverOk()) { toast('Driver TMC hilang di tengah gerak, rutin dihentikan.', 'bad'); return false; }
    const act = getActual();
    if (act) {
      let ok = true;
      for (let i = 0; i < NSTEP_ENC; i++) {
        const a = act[i];
        if (!Number.isFinite(a) || Math.abs(tgt[i] - a) > ARRIVE_TOL) { ok = false; break; }
      }
      if (ok) { await sleep(SERVO_SETTLE); return true; }
    }
    if (Date.now() - t0 > ARRIVE_TIMEOUT) return null;
    await sleep(80);
  }
}

function waitForContinue() { return new Promise(res => { continueResolve = res; }); }
function doContinue(ok) {
  if (!continueResolve) return;
  const r = continueResolve; continueResolve = null; r(ok);
}

async function runFull() {
  if (running) return;
  const why = blockedReason();
  if (why) { toast(why, 'bad'); return; }
  stopPreview();

  const r = ROUTINES[key];
  running = true; abortRun = false;
  /* Auto-run dan aliran live tidak boleh berebut target: dua sumber yang jalan
     berbarengan akan saling menimpa tiap 50 ms. Dimatikan SEBELUM langkah
     pertama berangkat, sama seperti di runner desktop. */
  const wasLive = isLive();
  setLive(false, 'rutin dimulai: aliran LIVE dimatikan supaya tidak berebut target.');
  setProfile('run');
  drawStep();

  const cycles = r.cycles || 1;
  const loopFrom = r.loopFrom || 0;
  try {
    for (let c = 0; c < cycles; c++) {
      const start = c === 0 ? 0 : loopFrom;
      for (let i = start; i < steps.length; i++) {
        if (abortRun || STATE.estop) { toast('Dihentikan.', 'warn'); return; }
        const blok = blockedReason();
        if (blok) { toast(`Rutin dihentikan: ${blok}`, 'bad'); return; }
        idx = i; drawStep();
        const s = steps[i];

        if (isPose(s)) {
          const tgt = s.a.slice();
          const gagal = sendPose(tgt, { src: 'pocket-routine' });
          if (gagal) { toast(`Rutin dihentikan: ${gagal}`, 'bad'); return; }
          // twin ikut ke target supaya layar tidak tertinggal di pose lama
          STATE.joints.forEach((j, k) => { if (Number.isFinite(tgt[k])) j.a = tgt[k]; });
          applyPose();
          const arr = await waitArrive(tgt);
          if (arr === false) { toast('Dihentikan di tengah gerak.', 'warn'); return; }
          if (arr === null) { toast(`Timeout menunggu "${s.label}". Rutin dihentikan.`, 'bad'); return; }
        } else {
          const g = gripPulses();
          sendServoUs(SERVO_GRIP, g[s.grip]);
          await sleep(GRIP_SETTLE);
        }

        /* Titik ukur: rutin BERHENTI dan menunggu manusia. Pengujian
           pengulangan tidak ada gunanya kalau lengan sudah pergi lagi sebelum
           angkanya sempat dibaca. */
        if (r.measureAt === i) {
          toast(`Siklus ${c + 1}/${cycles}: TITIK UKUR. Catat pembacaan lalu tekan LANJUT.`, 'warn', 9000);
          drawStep();
          const ok = await waitForContinue();
          if (!ok) { toast('Dihentikan di titik ukur.', 'warn'); return; }
        }
      }
    }
    toast(`Rutin selesai (${cycles} siklus).`, 'ok');
  } finally {
    running = false; abortRun = false;
    doContinue(false);
    setProfile('teach');
    /* LIVE tidak dinyalakan ulang sendiri. Rutin baru saja memindahkan lengan
       ke pose yang mungkin jauh dari pose twin sebelumnya, dan menyalakan
       aliran otomatis di keadaan itu berarti lengan langsung berangkat lagi ke
       tempat yang tidak diminta siapa pun. Operator yang menyalakannya lagi. */
    if (wasLive) toast('Rutin selesai. LIVE tetap MATI: nyalakan lagi kalau mau jog.', 'warn');
    drawStep();
  }
}

function stopRun() {
  if (!running) return;
  abortRun = true;
  doContinue(false);
  toast('STOP: rutin dihentikan. Lengan berhenti di ujung gerak terakhir (ini bukan e-stop).', 'warn');
}

/** dipanggil main.js saat E-STOP ditekan. */
export function routineEstop() {
  abortRun = true;
  doContinue(false);
  stopPreview();
}

/* ---------------- gambar ---------------- */
function drawStep() {
  if (!els.dots) return;

  els.dots.innerHTML = '';
  steps.forEach((_, i) => {
    els.dots.appendChild(el('div', 'mDot' + (running && i < idx ? ' done' : '') + (i === idx ? ' cur' : '')));
  });

  const s = steps[idx] || {};
  els.stepLab.textContent = `${idx + 1}/${steps.length}  ${s.label || ''}`;
  els.stepNote.textContent = s.warn || s.note || '';
  els.stepNote.className = 'mNote' + (s.warn ? ' warn' : '');

  els.run.disabled = running;
  els.run.textContent = running ? 'SEDANG JALAN...' : `JALAN (${steps.length} langkah)`;
  els.stop.disabled = !running;
  els.next.hidden = !continueResolve;
  if (els.prevBtn && !pv) els.prevBtn.textContent = 'PRATINJAU 3D';
  els.prevBtn.disabled = running;
}

function pickRoutine(k) {
  if (running) { toast('Rutin sedang jalan. Hentikan dulu.', 'warn'); return; }
  key = k;
  stopPreview();
  buildSteps();
  els.list.querySelectorAll('.mChip').forEach(c => c.classList.toggle('on', c.dataset.k === k));
  els.desc.textContent = ROUTINES[k].desc || '';
  drawStep();
}

/* Dipanggil dari render loop 8 Hz. drawStep() membangun ulang deretan titik
   langkah, jadi memanggilnya tiap kali berarti DOM dibongkar pasang delapan
   kali per detik untuk menggambar hal yang sama; di HP itu terlihat sebagai
   titik yang berkedip. Yang dibandingkan sidik jari keadaan, bukan waktunya. */
let sig = '';
export function refresh() {
  if (!els.dots) return;
  const now = `${key}|${idx}|${running}|${!!continueResolve}|${pv ? pv.t.toFixed(1) : '-'}`;
  if (now === sig) return;
  sig = now;
  drawStep();
}

export function buildRoutine(body) {
  els = {};
  buildSteps();

  const b1 = sec(body, 'rutin');
  els.list = el('div', 'mChips');
  Object.entries(ROUTINES).forEach(([k, r]) => {
    const n = (r.dynamic === 'line' ? lineSteps(r.line) : r.steps).length;
    const c = el('button', 'mChip' + (k === key ? ' on' : ''),
      `<b>${r.name}</b><span>${n} langkah${r.cycles ? ` x${r.cycles}` : ''}</span>`);
    c.type = 'button';
    c.dataset.k = k;
    c.onclick = () => pickRoutine(k);
    els.list.appendChild(c);
  });
  b1.appendChild(els.list);
  els.desc = note(b1, ROUTINES[key].desc || '');

  const b2 = sec(body, 'langkah');
  els.dots = el('div', 'mDots');
  b2.appendChild(els.dots);
  els.stepLab = el('div', 'mJog');
  els.stepLab.style.cssText = 'font-family:var(--mono);font-size:12px;color:var(--head);padding:0';
  b2.appendChild(els.stepLab);
  els.stepNote = note(b2, '');

  const b3 = sec(body, '');
  els.run = btn('JALAN', 'primary', runFull);
  els.stop = btn('STOP', 'danger', stopRun);
  b3.appendChild(row(els.run, els.stop));
  els.next = btn('LANJUT', '', () => doContinue(true));
  els.next.hidden = true;
  els.next.style.marginTop = '8px';
  els.next.style.width = '100%';
  b3.appendChild(els.next);

  els.prevBtn = btn('PRATINJAU 3D', '', () => (pv ? stopPreview('Pratinjau dihentikan.') : startPreview()));
  els.prevBtn.style.marginTop = '8px';
  els.prevBtn.style.width = '100%';
  b3.appendChild(els.prevBtn);

  note(b3, `JALAN mengirim seluruh langkah otomatis pada profil RUN ${SPEED.run.speed} dps, `
    + 'menunggu tiap langkah sampai sebelum mengirim yang berikutnya. STOP menghentikan '
    + 'di ujung gerak terakhir; yang memotong daya driver hanya E-STOP.', 'warn');
  note(b3, 'Pose yang dijalankan adalah pose di config/routines.js, bukan hasil teach terakhir '
    + 'di laptop. Keduanya sama hanya kalau hasil teach sudah dikembalikan ke repo lewat '
    + '"ekspor rutin" di studio desktop.');

  let last = performance.now();
  onFrame(() => {
    const now = performance.now();
    const dt = (now - last) / 1000; last = now;
    if (pv && !STATE.estop) previewTick(Math.min(dt, 0.1));
    else if (pv && STATE.estop) stopPreview('E-STOP: pratinjau dihentikan.');
  });

  drawStep();
}

export const isRunning = () => running;
