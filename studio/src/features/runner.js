/* ============================================================================
   RUNNER RUTIN HARDWARE: menjalankan config/routines.js di lengan NYATA,
   satu langkah per klik, dengan manusia sebagai interlock di tiap langkah.

   Kenapa ini ada terpisah dari timeline.js: timeline hanya menganimasikan model
   3D. Ia tidak pernah menyentuh WebSocket, jadi menekan play di sana tidak
   menggerakkan apa pun di lengan.

   BENTUK PANEL: tiga tahap bernomor, bukan sebaris tombol yang semuanya
   kelihatan sama penting.

     1 ATUR    slider per sendi, sama seperti halaman bawaan ESP32. Ini yang
               dipakai membetulkan keyframe yang meleset, langsung di tempat.
     2 KIRIM   satu tombol besar untuk seluruh keyframe. Mode LIVE membuat
               geseran slider langsung sampai ke lengan (throttle 50 ms).
     3 REKAM   simpan sudut hasil betulan ke langkah, lalu tandai terverifikasi.

   Tombol "kirim per sendi" DIHAPUS. Maksudnya dulu adalah supaya sendi yang
   menarik kabel ketahuan sebelum seluruh pose dijalankan, tapi slider dengan
   mode LIVE melakukan hal yang sama dengan lebih baik: gerakannya kontinu dan
   berhenti begitu jari berhenti, bukan menunggu satu perintah selesai. Yang
   hilang cuma klik, bukan penjaganya.

   Guardrail yang tidak berubah:
   - ARMED: tidak ada satu byte pun dikirim selama interlock ini mati.
   - Kecepatan dipaksa ke profil TEACH (8 dps) selama mengajar; profil RUN baru
     dipakai saat JALAN PENUH. Firmware menerimanya lewat cal_set, RAM saja.
   - E-STOP menghentikan auto-run dan mengunci semua jalur kirim. Firmware
     dibangun dengan ESTOP_AUTO_RESUME 0, jadi goto TIDAK melepas e-stop.
   - PUTUS LINK melucuti ARM, dan kalau J3/J4 kembali dengan sudut yang bukan
     sudut terakhir yang diperintahkan, ARM dikunci sampai operator menyatakan
     lengan sudah di-home ulang. Lihat catatan di sentSinceLink.
   ========================================================================== */
import { STATE } from '../config/arm.js';
import { ROUTINES, GRIP_US_DEFAULT, SPEED } from '../config/routines.js';
import { applyPose } from '../model/kinematics.js';
import { icon } from '../ui/icons.js';
import {
  isConnected, getActual, sendServoUs, SERVO_GRIP,
  isFbTrusted, getCal, onHwStatus, isDriverOk,
} from '../net/bridge.js';
import {
  isArmed, setArmed, isLive, setLive, getProfile, setProfile, getCmd, setCmd,
  setArmVeto, blockedReason, sendPose, onLiveChange,
} from '../net/liveLink.js';
import { lineSteps } from './demos.js';

const NJ = 6;
const NSTEP_ENC = 4;          // J1..J4 = stepper; J5/J6 servo, tidak dipakai untuk deteksi tiba
const ARRIVE_TOL = 1.5;       // deg, ambang "sudah sampai" untuk auto-run
const ARRIVE_TIMEOUT = 20000; // ms, batas tunggu sebelum auto-run menyerah
const SERVO_SETTLE = 700;     // ms, servo tidak punya umpan balik yang bisa dipercaya
const GRIP_SETTLE = 800;      // ms
const UI_MS = 180;            // refresh kolom aktual
const LINK_TOL = 2.0;         // deg, ambang "lengan tidak lagi di tempat yang diperintahkan"
const OPEN_LOOP = [2, 3];     // J3, J4: tanpa encoder, frame sudutnya hilang saat ESP boot
const ENC_JOINT = [0, 1];     // J1, J2: AS5600 absolut, pulih sendiri sesudah boot

/* v4: naik dari v3 karena seluruh isi config/routines.js disusun ulang 13 Agu
   2026 (arah depan dibetulkan ke J2/J3 positif, sektor kerja dibatasi J1 0..-90,
   dan urutan langkah ditata supaya servo J5 tidak sampai duluan di dekat meja).
   Jumlah DAN urutan langkah tiap rutin berubah, sedangkan `overrides` dan
   `verified` disimpan per INDEKS langkah: kalau kunci lama dipakai terus, pose
   hasil teach untuk "turun ambil" akan menempel diam diam di langkah yang
   sekarang berisi hal lain, dan tanda TERVERIFIKASI ikut pindah bersamanya.
   Menaikkan versi kunci membuang semuanya sekaligus, tanpa bergantung pada
   operator ingat menekan reset.

   Pose "dekat titik ambil" yang diajarkan operator di lengan tidak ikut hilang:
   dia sekarang jadi angka bawaan di config/routines.js.

   v5 (13 Agu 2026, sore): jumlah dan urutan langkah TETAP, yang berubah nilai
   posenya. Pose ambil dan taruh hasil teach sesi ini (J5 43 dan 45, plus pulsa
   gripper terukur 1406/1856) sudah jadi angka bawaan di config/routines.js,
   dan J5 itu ikut dibawa ke pose transit supaya servo tidak bergerak saat
   lengan dekat meja. Override lama tidak boleh ikut hidup di atasnya: yang
   tersimpan di v4 masih memulangkan J5 ke 24,1 tepat di dua langkah yang
   berbahaya, dan karena override menang atas routines.js, perbaikannya akan
   diam diam tidak berlaku di browser yang sempat menyimpannya. Menaikkan kunci
   membuangnya sekaligus, dan tidak ada yang hilang: angkanya sudah di repo. */
const LS_KEY = 'armstudio.runner.v5';

/* ---------------- state ----------------
   ARM, LIVE, profil kecepatan, dan "pose terakhir yang diperintahkan" TIDAK
   lagi tinggal di sini: keempatnya milik net/liveLink.js. Alasannya ada di
   kepala modul itu, ringkasnya begini. Sejak gizmo TCP boleh mengikuti mouse,
   ada dua panel yang bisa mengalirkan target ke sendi yang sama. Kalau
   masing-masing memegang interlock dan throttle sendiri, dua saklar yang
   kelihatan mirip akan berdiri sendiri dan lalu lintasnya bisa tumpang tindih.
   Sekarang saklar LIVE tinggal satu, yaitu lampu LIVE di bilah interlock, dan
   saklar yang sama, dan cuma ada satu pengirim berkala di seluruh studio. */
let key = 'pickPlace';        // rutin aktif
let steps = [];               // langkah rutin aktif (bisa hasil override user)
let idx = 0;                  // langkah sekarang
let editPose = [0, 0, 0, 0, 0, 0];  // sudut yang sedang diatur slider (TARGET langkah)
let running = false;          // auto-run sedang jalan
let abortRun = false;
let gripUs = { ...GRIP_US_DEFAULT };
let verified = {};            // { routineKey: [idx,...] }
let overrides = {};           // { routineKey: { stepIdx: [J1..J6] } }

/* ---- penjaga sendi open-loop sesudah link putus ----------------------------
   Satu satunya kegagalan senyap yang tersisa di rantai ini. J3 dan J4 tidak
   punya encoder, jadi sudut yang mereka laporkan adalah isi step counter, dan
   step counter itu mulai dari nol tiap ESP32 boot. Kalau ESP sempat restart di
   tengah sesi, pose fisik saat itu menjadi "0 derajat" tanpa satu pun angka di
   layar yang berubah mencurigakan: J3 tetap melapor 0,0 dengan yakin.

   Pemicunya bukan "reboot terdeteksi": firmware tidak mengirim uptime, jadi
   reboot tidak bisa dibuktikan dari sini. Yang dipakai adalah putusnya link,
   yaitu persis saat studio kehilangan dasar untuk menjamin frame open-loop.
   Konsekuensinya dua tingkat, dan sengaja dibedakan:

     link putus              -> ARM dilucuti. Selalu, tanpa syarat.
     open-loop tidak cocok   -> ARM DIKUNCI sampai operator menyatakan sudah
                                home ulang.

   Yang dibandingkan adalah pose terakhir yang benar benar DIPERINTAHKAN, jadi
   penjaga ini diam kalau belum ada satu pun goto sejak tersambung. */
let sentSinceLink = false;    // sudah pernah kirim goto di koneksi ini
let pendingCheck = null;      // pose yang harus dicocokkan begitu feedback segar masuk
let needReHome = false;       // ARM dikunci sampai operator menyatakan sudah home ulang

/* Jendela pulsa gripper yang BOLEH dikirim. Nilai awal = rentang penuh servo
   hobi, tapi begitu cal_get masuk ia diganti travel hasil kalibrasi
   (servo_us_min/max indeks SERVO_GRIP). Di lengan ini travel terukurnya
   1406..1859 us, sedangkan tebakan "aman" 1300 us ada di LUAR travel itu. */
let gripLim = { min: 500, max: 2500, calibrated: false };

/* ---------------- persistensi ----------------
   HASIL TEACH HILANG SAAT RESTART: dua jebakan, dua duanya diam.

   1 localStorage terikat ORIGIN, bukan folder proyek. Studio yang tadi dibuka
     di http://localhost:5173 dan sekarang di :5174 (Vite diam diam menggeser
     port kalau 5173 masih dipegang proses lama), di 127.0.0.1, di IP LAN, atau
     langsung dari file:// adalah EMPAT penyimpanan yang berbeda. Tidak ada
     pesan salah: panel cuma terbuka dengan angka bawaan seolah belum pernah
     ada yang diajarkan. Pengunci portnya sekarang ada di vite.config.js
     (strictPort), jadi alamatnya tidak bisa bergeser tanpa ketahuan.

   2 Penulisannya bisa DITOLAK. Di halaman file:// Chrome melempar SecurityError
     begitu localStorage disentuh, dan di jendela privat kuotanya bisa nol.
     Versi lama menelan kedua kesalahan itu di blok catch kosong, jadi "simpan
     sudut ini" tetap menjawab seolah berhasil sementara tidak satu byte pun
     ditulis. Sekarang kegagalannya dinaikkan ke layar lewat storeOk.

   Yang benar benar mengamankan hasil teach tetap "ekspor rutin": angka yang
   ditempel ke config/routines.js ikut git dan tidak peduli origin. */
let storeOk = true;    // localStorage di origin ini benar benar bisa ditulis
let savedAt = 0;       // stempel waktu simpan terakhir (ms epoch), 0 = belum pernah

let migrasi = null;    // hasil pemulihan otomatis dari kunci versi sebelumnya

function load() {
  try {
    const o = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    if (o.gripUs) gripUs = { ...gripUs, ...o.gripUs };
    verified = o.verified || {};
    overrides = o.overrides || {};
    savedAt = o.savedAt || 0;
  } catch { /* isinya rusak: jalan dengan default, storeOk diuji terpisah */ }

  /* Kunci sekarang kosong sementara kunci versi sebelumnya berisi: pulihkan
     SENDIRI, tanpa menunggu tombol ditekan. Menaikkan versi kunci adalah
     keputusan pengembang, jadi biayanya tidak boleh dibebankan ke operator
     dalam bentuk panel yang terbuka kosong plus tugas mencari tombol. Tombol
     manualnya tetap ada untuk kasus sebaliknya, yaitu kunci sekarang sudah
     berisi dan menimpanya harus disengaja. */
  const okSekarang = Object.values(verified).reduce((s, x) => s + (x ? x.length : 0), 0);
  {
    /* Bukan cuma "kunci sekarang kosong": pemulihan juga jalan kalau kunci lama
       memuat LEBIH BANYAK daripada yang sekarang. Pemulihan pertama yang cuma
       menemukan sebagian (karena satu nama kunci ditebak) tidak boleh mengunci
       sisanya cuma karena sesudah itu kunci sekarang tidak kosong lagi. */
    const lama = bacaLama();
    if (lama && (lama.nPose > teachCount() || lama.nOk > okSekarang)) {
      Object.entries(lama.data.overrides || {}).forEach(([k, o]) => {
        overrides[k] = { ...(overrides[k] || {}), ...o };
      });
      Object.entries(lama.data.verified || {}).forEach(([k, v]) => {
        if (Array.isArray(v)) verified[k] = [...new Set([...(verified[k] || []), ...v])];
      });
      if (lama.data.gripUs) gripUs = { ...gripUs, ...lama.data.gripUs };
      savedAt = lama.data.savedAt || 0;
      migrasi = lama;
      try {
        localStorage.setItem(LS_KEY, JSON.stringify({ gripUs, verified, overrides, savedAt }));
      } catch { /* ditolak: state RAM sudah benar, storeOk yang melaporkannya */ }
    }
  }
  // Uji tulis beneran, bukan sekadar `'localStorage' in window`: yang menolak
  // adalah operasinya, dan penolakannya baru muncul saat dipakai.
  try {
    localStorage.setItem(LS_KEY + '.probe', '1');
    localStorage.removeItem(LS_KEY + '.probe');
  } catch { storeOk = false; }
}

/** @returns {boolean} true kalau benar benar tertulis ke localStorage. */
function save() {
  savedAt = Date.now();
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ gripUs, verified, overrides, savedAt }));
    storeOk = true;
  } catch { storeOk = false; }
  drawTeach();
  return storeOk;
}

/** jumlah langkah yang punya pose hasil teach, di seluruh rutin. */
const teachCount = () => Object.values(overrides)
  .reduce((n, o) => n + Object.keys(o || {}).length, 0);

/* ---- pemulihan hasil teach dari kunci versi sebelumnya ---------------------
   Menaikkan versi kunci TIDAK pernah menghapus isi kunci lama; yang terjadi
   cuma panel berhenti membacanya. Bedanya besar buat operator: yang terlihat
   adalah pekerjaan mengajar yang lenyap tanpa jejak, padahal datanya masih
   utuh satu baris di sebelahnya. Jadi sisa itu dicari, dan kalau ada,
   pemulihnya muncul sebagai tombol, bukan sebagai tugas menggali DevTools.

   Cuma v4 yang ditawarkan. Kunci di bawah v4 memakai jumlah dan urutan langkah
   yang berbeda, jadi pose-nya akan menempel di langkah yang sekarang berisi hal
   lain; itu bukan pemulihan, itu kerusakan yang kelihatan seperti pemulihan. */
const LS_PREFIX = 'armstudio.runner.';

/** Gabungan SELURUH kunci runner versi lain di origin ini, bukan cuma satu
 *  versi yang ditebak namanya. Kunci sudah pernah naik v3 -> v4 -> v5, dan
 *  hasil kerja bisa tertinggal di mana saja di antaranya; menghardcode satu
 *  nama berarti memulihkan sebagian lalu menyatakan itu semuanya. Pose dari
 *  versi lebih baru menang, tanda terverifikasi digabung (union). */
function bacaLama() {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LS_PREFIX) && k !== LS_KEY && !k.endsWith('.probe')) keys.push(k);
    }
    if (!keys.length) return null;
    keys.sort();                       // v3 < v4 < v5 secara leksikal
    const o = { overrides: {}, verified: {}, gripUs: null, savedAt: 0 };
    for (const k of keys) {
      let d = null;
      try { d = JSON.parse(localStorage.getItem(k) || 'null'); } catch { /* isi rusak */ }
      if (!d) continue;
      Object.entries(d.overrides || {}).forEach(([r, ov]) => {
        o.overrides[r] = { ...(o.overrides[r] || {}), ...ov };
      });
      Object.entries(d.verified || {}).forEach(([r, v]) => {
        if (Array.isArray(v)) o.verified[r] = [...new Set([...(o.verified[r] || []), ...v])];
      });
      if (d.gripUs) o.gripUs = { ...(o.gripUs || {}), ...d.gripUs };
      if (d.savedAt > o.savedAt) o.savedAt = d.savedAt;
    }
    o.dari = keys;
    /* Tanda terverifikasi ikut dihitung, bukan cuma pose. Kerja mengajar yang
       paling banyak memakan waktu justru melewati tiap langkah satu per satu
       lalu menandainya; kalau pemulihnya cuma muncul saat ada pose tersimpan,
       operator yang kehilangan 13 tanda centang akan melihat panel yang
       menyatakan tidak ada apa apa untuk dipulihkan. */
    const nPose = Object.values(o.overrides || {})
      .reduce((s, x) => s + Object.keys(x || {}).length, 0);
    const nOk = Object.values(o.verified || {})
      .reduce((s, x) => s + (Array.isArray(x) ? x.length : 0), 0);
    return (nPose || nOk) ? { data: o, nPose, nOk } : null;
  } catch { return null; }
}

/** salin hasil kerja dari kunci lama ke kunci sekarang: pose, tanda
 *  terverifikasi, dan pulsa gripper, semuanya.
 *
 *  Tanda terverifikasi IKUT DIPULIHKAN UTUH, dan itu keputusan sadar. Sebagian
 *  tanda memang menunjuk pose yang isinya berubah 13 Agu 2026 (enam langkah
 *  pick & place ikut J5 hasil teach), jadi ada tanda yang menyatakan "sudah
 *  dilihat" untuk angka yang sedikit berbeda. Yang menahan konsekuensinya bukan
 *  tanda itu satu per satu, melainkan syarat JALAN PENUH: tombolnya baru
 *  terbuka kalau SELURUH langkah terverifikasi, jadi rutin tetap tidak bisa
 *  berjalan otomatis tanpa operator melewati sisanya sekarang juga.
 *
 *  Menahan tanda yang tidak bisa dibuktikan terdengar lebih aman, tapi harganya
 *  dibayar di tempat yang salah: operator kehilangan kerja yang benar benar
 *  sudah dilakukannya, dan panel yang membuang pekerjaan orang tanpa jalan
 *  pulang justru berhenti dipercaya. Yang ditahan cukup pintunya. */
function pulihkanLama() {
  const lama = bacaLama();
  if (!lama) return;
  if (!confirm('Pulihkan hasil kerja dari penyimpanan versi sebelumnya?\n\n'
    + `  ${lama.nPose} pose hasil teach\n  ${lama.nOk} tanda terverifikasi\n\n`
    + 'Pose menimpa angka di config/routines.js untuk langkah yang sama. Sebagian tanda '
    + 'menunjuk pose yang isinya sempat berubah (J5 pick & place), jadi periksa lagi '
    + 'langkah yang menyentuh meja sebelum JALAN PENUH.')) return;

  Object.entries(lama.data.overrides || {}).forEach(([k, o]) => {
    overrides[k] = { ...(overrides[k] || {}), ...o };
  });
  Object.entries(lama.data.verified || {}).forEach(([k, list]) => {
    if (Array.isArray(list)) verified[k] = [...new Set([...(verified[k] || []), ...list])];
  });
  if (lama.data.gripUs) gripUs = { ...gripUs, ...lama.data.gripUs };
  save();
  buildSteps(); loadEditPose(); drawStep(); drawGripRows();
  say(`Dipulihkan: ${lama.nPose} pose hasil teach dan ${lama.nOk} tanda terverifikasi.`, 'ok');
}
const vset = () => (verified[key] ||= []);
const isVerified = (i) => vset().includes(i);

/* ---------------- helper ---------------- */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fmt = (v, d = 1) => (v == null || !Number.isFinite(v) ? '--' : v.toFixed(d));
const cur = () => steps[idx] || {};
const isPose = (s) => Array.isArray(s.a);

/** batas sendi. Diambil dari firmware kalau ada, persis seperti halaman bawaan
 *  ESP32: slider tidak boleh bisa meminta sudut yang firmware sendiri tolak. */
function jointLim(i) {
  const cal = getCal();
  const lo = cal && cal.joint_min, hi = cal && cal.joint_max;
  if (Array.isArray(lo) && Array.isArray(hi) && Number.isFinite(lo[i]) && Number.isFinite(hi[i]) && lo[i] < hi[i]) {
    return { min: lo[i], max: hi[i], dari: 'firmware' };
  }
  const j = STATE.joints[i];
  return { min: j.min, max: j.max, dari: 'model' };
}

/** pose target langkah i setelah override user diterapkan. */
function stepPose(i) {
  const ov = overrides[key] && overrides[key][i];
  return ov ? ov.slice() : (steps[i].a || []).slice();
}

/** bangun ulang daftar langkah untuk rutin aktif (rutin dinamis dihitung IK). */
function buildSteps() {
  const r = ROUTINES[key];
  steps = r.dynamic === 'line' ? lineSteps(r.line) : r.steps.map(s => ({ ...s }));
  idx = 0;
}

let els = {};
function say(msg, kind = '') {
  els.status.textContent = msg;
  els.status.style.color = kind === 'bad' ? 'var(--over)' : kind === 'warn' ? 'var(--warn)' : kind === 'ok' ? 'var(--ok)' : '';
}

/** syarat kirim: terhubung, ARMED, tidak e-stop. Alasannya dari liveLink
 *  supaya panel ini dan bilah interlock tidak pernah punya jawaban berbeda. */
function canSend(quiet = false) {
  const why = blockedReason();
  if (why && !quiet) say(why, STATE.estop || !isConnected() ? 'bad' : 'warn');
  return !why;
}

/** kirim profil kecepatan ke firmware (RAM, lewat cal_set). Profil ini juga
 *  yang menentukan laju rayapan aliran live, jadi keduanya tidak bisa berbeda. */
function pushSpeed(which) {
  setProfile(which);
  els.spdSeg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.k === which));
}

/** sinkronkan pose perintah ke posisi lengan yang sebenarnya. Sendi yang umpan
 *  baliknya tidak dipercaya (pot servo belum terkalibrasi) tidak boleh ikut. */
function syncCmdFromHw() {
  const act = getActual();
  setCmd(STATE.joints.map((j, i) => {
    const a = act && act[i];
    return (Number.isFinite(a) && isFbTrusted(i)) ? a : j.a;
  }));
}

/* ---- penjaga link (lihat catatan panjang di deklarasi sentSinceLink) ----
   `sentSinceLink` sekarang dinaikkan oleh event `goto` dari bridge, bukan oleh
   pemanggilan manual di tiap tempat kirim. Itu disengaja: sejak aliran live
   ada, goto juga berangkat dari modul lain, dan penjaga sendi open-loop harus
   ikut menghitungnya. Penanda yang dipasang tangan pasti akan terlewat di
   jalur yang lupa memanggilnya. */

function onLinkDown() {
  const wasArmed = isArmed();
  abortRun = true; doContinue(false);   // ARM/LIVE sudah dilucuti liveLink
  syncArmButton();
  // Snapshot diambil hanya kalau ada yang bisa dicocokkan nanti.
  pendingCheck = sentSinceLink ? getCmd() : null;
  sentSinceLink = false;
  if (els.status) {
    say(wasArmed
      ? 'Koneksi putus. ARM dilucuti otomatis. Sendi open-loop akan diperiksa saat tersambung lagi.'
      : 'Koneksi putus.', wasArmed ? 'warn' : '');
  }
  drawRehome();
}

/** cocokkan pose fisik sesudah link kembali dengan pose terakhir yang
 *  diperintahkan. return true bila sudah selesai diperiksa. */
function runLinkCheck() {
  const act = getActual();
  if (!act) return false;              // feedback segar belum masuk, tunggu
  const was = pendingCheck;
  pendingCheck = null;

  const off = [];
  for (const i of [...ENC_JOINT, ...OPEN_LOOP]) {
    const a = act[i];
    if (!Number.isFinite(a)) continue;
    const d = a - was[i];
    if (Math.abs(d) > LINK_TOL) off.push({ i, d, was: was[i], now: a });
  }
  const ol = off.filter(o => OPEN_LOOP.includes(o.i));
  const detail = (list) => list
    .map(o => `J${o.i + 1} ${fmt(o.was)} -> ${fmt(o.now)}`).join(', ');

  if (ol.length) {
    /* Sendi tanpa encoder tidak mungkin "kembali sendiri" ke angka lain: kalau
       nilainya berubah tanpa ada perintah, step counter-nya sudah dinolkan
       ulang, dan itu berarti seluruh frame sudut sendi itu bergeser. */
    needReHome = true;
    say(`FRAME SUDUT BERGESER: ${detail(ol)}. `
      + 'J3/J4 tanpa encoder, jadi pose fisik saat ESP boot menjadi nol. '
      + 'Home ulang manual lalu cal_zero SEBELUM mengirim apa pun.', 'bad');
  } else if (off.length) {
    say(`Lengan berpindah selama putus: ${detail(off)}. Frame J1/J2 pulih dari `
      + 'encoder, jadi angkanya benar. Periksa pose sebelum ARM lagi.', 'warn');
  } else {
    say('Tersambung lagi. Sendi open-loop masih cocok dengan pose terakhir yang '
      + 'diperintahkan. ARM tetap dilucuti, nyalakan lagi kalau lengan terlihat benar.', 'ok');
  }
  syncCmdFromHw();
  drawRehome();
  return true;
}

/** ambil travel gripper hasil kalibrasi dari cal firmware. */
function syncGripLimits() {
  const cal = getCal();
  const lo = cal && cal.servo_us_min, hi = cal && cal.servo_us_max;
  if (!Array.isArray(lo) || !Array.isArray(hi)) return;
  const min = lo[SERVO_GRIP], max = hi[SERVO_GRIP];
  if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) return;
  // Travel penuh 500..2500 = default pabrik, artinya gripper BELUM disapu.
  gripLim = { min, max, calibrated: !(min === 500 && max === 2500) };
  if (gripLim.calibrated && (gripUs.open < min || gripUs.open > max
      || gripUs.close < min || gripUs.close > max)) {
    /* Nilai di luar travel TIDAK boleh sekadar dijepit satu per satu: menjepit
       nilai yang meleset ke ujung terdekat bisa mendarat di ujung yang salah,
       dan rahang jadi terbalik arti tanpa satu pun pesan salah. Jadi keduanya
       ditulis ulang sekaligus ke dua ujung travel.

       ARAHNYA HASIL UKUR, BUKAN TEBAKAN: di gripper ini pulsa kecil MEMBUKA dan
       pulsa besar MENUTUP (teach 13 Agu 2026, open 1406 / close 1856 pada
       travel 1406..1859). Versi lama menulis kebalikannya, close = min dan
       open = max, yaitu satu satunya jalur di panel ini yang bisa menukar arti
       kedua langkah gripper tanpa ada yang mengetiknya. */
    gripUs = { open: min, close: max };
    save();
    say(`Pulsa gripper diturunkan ulang dari travel terkalibrasi: buka ${min}, tutup ${max} us. `
      + 'Cek dengan tombol "coba" sebelum menjalankan rutin.', 'warn');
  }
  if (els.gripHint) {
    els.gripHint.textContent = gripLim.calibrated
      ? `Travel terkalibrasi ${min}..${max} us.`
      : 'Gripper belum disapu (masih 500..2500 default). Naikkan pelan pelan dan hentikan begitu rahang menyentuh ujung.';
    els.gripHint.style.color = gripLim.calibrated ? '' : 'var(--warn)';
  }
  drawGripRows();
  drawSliders();
}

/** tulis ulang batas + nilai slider gripper dari gripLim/gripUs. Terpisah dari
 *  syncGripLimits karena reset menyeluruh juga harus menyegarkannya, termasuk
 *  saat belum terhubung sehingga syncGripLimits keluar lebih awal. */
function drawGripRows() {
  els.gripRows?.forEach(({ sl, num, which }) => {
    sl.min = gripLim.min; sl.max = gripLim.max; sl.value = gripUs[which];
    num.min = gripLim.min; num.max = gripLim.max; num.value = gripUs[which];
  });
}

/* ---------------- slider sendi ----------------
   Bentuknya sengaja meniru halaman bawaan ESP32 (webui.h): satu baris per
   sendi berisi slider, TARGET, dan AKTUAL berdampingan. Menaruh keduanya di
   satu baris menghilangkan tabel delta yang dulu terpisah: yang dibutuhkan
   operator adalah "berapa yang kuminta" vs "di mana lengannya", dan dua angka
   itu tidak boleh berjauhan di layar. */
/** slider/angka diubah manusia -> model 3D ikut. Kalau LIVE menyala, lengan
 *  ikut dengan sendirinya: aliran di net/liveLink.js membaca pose twin, jadi
 *  panel ini tidak lagi punya throttle atau pengirim sendiri. Itu juga yang
 *  membuat slider di sini dan gizmo TCP di mode GERAK tidak bisa saling
 *  mendahului: keduanya cuma menulis pose twin, dan yang mengirim satu. */
function setJoint(i, v) {
  const lim = jointLim(i);
  editPose[i] = clamp(+v || 0, lim.min, lim.max);
  STATE.joints.forEach((j, k) => { j.a = editPose[k]; });
  applyPose();                          // poseDirty -> model menampilkan TARGET
  drawSliders();
}

/** muat sudut langkah sekarang ke slider (dan ke model 3D). */
function loadEditPose() {
  const s = cur();
  if (!isPose(s)) return;
  editPose = stepPose(idx);
  STATE.joints.forEach((j, k) => { j.a = editPose[k]; });
  applyPose();
  drawSliders();
}

function drawSliders() {
  const act = getActual();
  els.jRows?.forEach((r, i) => {
    const lim = jointLim(i);
    if (+r.sl.min !== lim.min || +r.sl.max !== lim.max) { r.sl.min = lim.min; r.sl.max = lim.max; }
    if (document.activeElement !== r.sl) r.sl.value = editPose[i];
    if (document.activeElement !== r.num) r.num.value = +editPose[i].toFixed(1);

    /* Sendi tanpa umpan balik yang bisa dipercaya (pot servo J5/J6 selama
       kalibrasi mV-nya masih placeholder) tidak boleh memajang angka pot di
       kolom AKTUAL: delta J6 akan terbaca -121 deg padahal pergelangan tidak
       akan bergerak sejauh itu, dan justru kolom inilah yang dipakai operator
       untuk memutuskan aman atau tidak. */
    const trusted = isFbTrusted(i);
    const hw = act && Number.isFinite(act[i]) ? act[i] : null;
    if (!trusted) {
      r.act.textContent = 'buta';
      r.act.style.color = 'var(--dim)';
      r.act.title = 'pot servo belum terkalibrasi: sudut sendi ini tidak terukur';
    } else if (hw == null) {
      r.act.textContent = '--';
      r.act.style.color = 'var(--dim)';
      r.act.title = '';
    } else {
      const d = Math.abs(editPose[i] - hw);
      r.act.textContent = fmt(hw);
      r.act.style.color = d > 25 ? 'var(--over)' : d > 2 ? 'var(--warn)' : 'var(--ok)';
      r.act.title = `selisih ${fmt(editPose[i] - hw)} deg dari target`;
    }
  });
}

/* ---------------- render ---------------- */
function drawStep() {
  const s = cur();
  const n = steps.length;
  els.stepNo.textContent = `${n ? idx + 1 : 0}/${n}`;
  els.stepLbl.textContent = s.label || '-';
  els.stepNote.textContent = s.note || '';
  els.warn.textContent = s.warn || '';
  els.warn.style.display = s.warn ? '' : 'none';
  els.chk.classList.toggle('on', isVerified(idx));
  els.chk.textContent = isVerified(idx) ? 'TERVERIFIKASI' : 'OK, tandai';

  const pose = isPose(s);
  els.jWrap.style.display = pose ? '' : 'none';
  els.gripWrap.style.display = pose ? 'none' : '';
  els.bSave.style.display = pose ? '' : 'none';
  els.bSend.textContent = pose ? 'KIRIM KEYFRAME' : 'JALANKAN GRIPPER';
  if (!pose) els.gripAct.textContent = `langkah ini: ${s.grip === 'open' ? 'BUKA' : 'TUTUP'} -> ${gripUs[s.grip]} us`;

  els.bPrev.disabled = idx <= 0;
  els.bNextNav.disabled = idx >= n - 1;

  drawProgress();
  drawSliders();
}

/* Yang tersisa untuk disinkronkan panel ini tinggal segmen profil kecepatan:
   ARM dan LIVE sudah jadi lampu di bilah interlock, dan bilah itu menggambar
   dirinya sendiri dari liveLink. Fungsinya sengaja tidak dibuang supaya semua
   pemanggil lama (drawRehome, onLiveChange, cabang drv, runnerEstop) tetap
   punya satu tempat untuk memanggil kalau nanti ada tampilan lain di sini. */
function syncArmButton() {
  if (els.spdSeg) {
    els.spdSeg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.k === getProfile()));
  }
}
function drawRehome() {
  if (els.rehome) els.rehome.style.display = needReHome ? '' : 'none';
  syncArmButton();
}

/* Baris keadaan hasil teach. Ada supaya "hilang saat restart" tidak pernah lagi
   berbentuk panel yang terbuka polos tanpa keterangan: kalau penyimpanannya
   ditolak browser, yang terbaca merah di sini, dan kalau kosong karena
   alamatnya berganti, origin-nya tertulis apa adanya untuk dibandingkan. */
function drawTeach() {
  if (!els.teach) return;
  const n = teachCount();
  const jam = savedAt
    ? new Date(savedAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
    : null;
  if (!storeOk) {
    els.teach.textContent = 'TIDAK TERSIMPAN: browser menolak localStorage di alamat ini. '
      + 'Hasil teach hilang begitu halaman ditutup. Pakai "ekspor rutin" sebelum keluar.';
    els.teach.style.color = 'var(--over)';
  } else if (!n) {
    const lama = bacaLama();
    els.teach.textContent = lama
      ? `Kunci sekarang kosong, tapi ${lama.nPose} pose dan ${lama.nOk} tanda terverifikasi `
        + 'masih tersimpan di kunci versi sebelumnya. Lihat "pulihkan hasil kerja lama" di atas.'
      : 'Belum ada pose hasil teach tersimpan di alamat ini.';
    els.teach.style.color = lama ? 'var(--warn)' : 'var(--dim)';
  } else {
    els.teach.textContent = `${n} pose hasil teach tersimpan${jam ? `, terakhir ${jam}` : ''}.`;
    els.teach.style.color = 'var(--ok)';
  }
  els.teach.title = `Disimpan per alamat: ${location.origin}. Halaman yang sama di port, `
    + 'host, atau skema lain punya penyimpanan sendiri, dan hasil teach tidak ikut pindah. '
    + 'Yang ikut ke repo cuma hasil "ekspor rutin".';
}

function drawProgress() {
  els.prog.innerHTML = '';
  steps.forEach((s, i) => {
    const d = document.createElement('span');
    d.className = 'rnDot' + (isVerified(i) ? ' ok' : '') + (i === idx ? ' cur' : '');
    d.title = `${i + 1}. ${s.label || ''}`;
    d.onclick = () => { if (!running) go(i - idx); };
    els.prog.appendChild(d);
  });
  const done = steps.filter((_, i) => isVerified(i)).length;
  els.progTxt.textContent = `${done}/${steps.length} terverifikasi`;
  els.bFull.disabled = done < steps.length || !steps.length;
  els.bFull.title = els.bFull.disabled
    ? 'Verifikasi semua langkah dulu sebelum rutin boleh jalan penuh.'
    : 'Jalankan seluruh rutin otomatis.';
}

/* ---------------- aksi ---------------- */
function sendStep() {
  const s = cur();
  if (!canSend()) return;
  if (isPose(s)) {
    /* Satu keyframe utuh, sekali kirim: ini LOMPATAN target, bukan aliran yang
       merayap seperti mode LIVE. Servo J5/J6 karena itu tetap sampai duluan di
       sini, dan urutan langkah di config/routines.js memang disusun dengan
       kenyataan itu. */
    sendPose(editPose.slice(), { src: 'runner' });
    say(`Terkirim: ${s.label}. Lihat lengan, jangan lihat layar.`, 'ok');
  } else {
    sendServoUs(SERVO_GRIP, gripUs[s.grip]);
    say(`Gripper ${s.grip === 'open' ? 'BUKA' : 'TUTUP'} @ ${gripUs[s.grip]} us.`, 'ok');
  }
  drawStep();
}

/** teach by showing: sudut slider sekarang menggantikan sudut langkah ini. */
function saveStepPose() {
  const s = cur();
  if (!isPose(s)) { say('Langkah gripper tidak menyimpan pose sendi.', 'warn'); return; }
  (overrides[key] ||= {})[idx] = editPose.map(v => +v.toFixed(2));
  const v = vset(); const at = v.indexOf(idx);
  if (at >= 0) v.splice(at, 1);      // pose berubah -> verifikasi lama tidak berlaku lagi
  const ok = save(); drawStep();
  /* Kalau localStorage menolak, ini HARUS kelihatan sekarang juga: pose-nya
     tetap dipakai sesi ini, tapi ia akan hilang tanpa jejak begitu halaman
     ditutup, dan operator berhak tahu sebelum mengajarkan sepuluh langkah lagi. */
  say(ok
    ? 'Sudut langkah ini diganti nilai slider sekarang. Kirim ulang lalu tandai OK.'
    : 'Sudut langkah diganti TAPI GAGAL DISIMPAN: browser menolak localStorage di alamat ini. '
      + 'Hasil teach akan hilang saat halaman ditutup. Salin sekarang lewat "ekspor rutin".',
  ok ? 'warn' : 'bad');
}

/** buang override langkah ini, kembali ke angka di config/routines.js. */
function revertStepPose() {
  if (overrides[key]) delete overrides[key][idx];
  save(); loadEditPose(); drawStep();
  say('Kembali ke sudut asli dari routines.js.');
}

function markOk() {
  const v = vset();
  const at = v.indexOf(idx);
  if (at >= 0) v.splice(at, 1); else v.push(idx);
  save(); drawStep();
  if (isVerified(idx) && idx < steps.length - 1) go(1);
}

function go(delta) {
  if (running) return;
  idx = clamp(idx + delta, 0, Math.max(0, steps.length - 1));
  loadEditPose();
  drawStep();
}

/* ---------------- auto-run ---------------- */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** tunggu sampai stepper J1..J4 masuk toleransi. Servo tidak ikut: pot internal
 *  J5/J6 belum terkalibrasi, jadi menunggunya berarti menunggu angka yang belum
 *  tentu berarti. Servo diberi waktu tetap.
 *
 *  YANG DIBUKTIKAN TIAP SENDI TIDAK SAMA, dan itu tidak boleh disamarkan:
 *  - J1/J2 (ENC_JOINT) punya AS5600 absolut, jadi "sampai" di sini benar benar
 *    hasil ukur poros.
 *  - J3/J4 (OPEN_LOOP) melaporkan isi step counter, yaitu jumlah pulsa yang
 *    SUDAH DIKELUARKAN firmware. Angka itu selalu tiba di target apa pun yang
 *    terjadi secara fisik: langkah yang hilang, kopling slip, atau motor yang
 *    sama sekali tidak berputar tidak mengubahnya sedikit pun. Jadi untuk dua
 *    sendi itu yang terbukti cuma "profil geraknya selesai dijalankan", bukan
 *    "lengannya ada di sana". Tidak ada cara menutup celah ini dari sisi studio;
 *    yang bisa dilakukan adalah tidak berpura pura sudah tertutup.
 *
 *  Karena itu kondisi yang membuat angka open-loop jadi omong kosong diperiksa
 *  terpisah: driver yang tahap outputnya mati mengeluarkan pulsa yang tidak
 *  menggerakkan apa apa, dan counter tetap tiba di target dengan yakin. */
async function waitArrive(tgt) {
  const t0 = Date.now();
  for (;;) {
    if (abortRun || STATE.estop) return false;
    // Driver hilang di tengah langkah: pulsa keluar, poros tidak ikut. Menunggu
    // step counter di sini sama dengan menunggu bukti yang dibuat sendiri.
    if (!isDriverOk()) { say('Driver TMC hilang di tengah gerak, rutin dihentikan.', 'bad'); return false; }
    const act = getActual();
    if (act) {
      let ok = true;
      for (let i = 0; i < NSTEP_ENC; i++) {
        const a = act[i];
        if (!Number.isFinite(a) || Math.abs(tgt[i] - a) > ARRIVE_TOL) { ok = false; break; }
      }
      if (ok) { await sleep(SERVO_SETTLE); return true; }
    }
    if (Date.now() - t0 > ARRIVE_TIMEOUT) return null;   // null = timeout
    await sleep(80);
  }
}

async function runFull() {
  if (running) return;
  if (!canSend()) return;
  const r = ROUTINES[key];
  running = true; abortRun = false;
  /* Auto-run dan aliran live tidak boleh berebut: dua sumber target yang jalan
     berbarengan akan saling menimpa tiap 50 ms. Ini satu satunya tempat live
     dimatikan paksa, dan disengaja terjadi SEBELUM langkah pertama dikirim. */
  setLive(false, 'jalan penuh dimulai');
  els.bFull.disabled = true; els.bStop.disabled = false;
  els.runRow.classList.add('on');
  pushSpeed('run');
  const cycles = r.cycles || 1;
  const loopFrom = r.loopFrom || 0;

  try {
    for (let c = 0; c < cycles; c++) {
      const start = c === 0 ? 0 : loopFrom;
      for (let i = start; i < steps.length; i++) {
        if (abortRun || STATE.estop) { say('Dihentikan.', 'warn'); return; }
        idx = i; loadEditPose(); drawStep();
        const s = steps[i];
        if (isPose(s)) {
          const tgt = stepPose(i);
          sendPose(tgt, { src: 'runner' });
          say(`siklus ${c + 1}/${cycles} - ${s.label}`, 'ok');
          const arr = await waitArrive(tgt);
          if (arr === false) { say('Dihentikan di tengah gerak.', 'warn'); return; }
          if (arr === null) { say(`Timeout menunggu "${s.label}". Rutin dihentikan.`, 'bad'); return; }
        } else {
          sendServoUs(SERVO_GRIP, gripUs[s.grip]);
          say(`siklus ${c + 1}/${cycles} - gripper ${s.grip}`, 'ok');
          await sleep(GRIP_SETTLE);
        }
        /* Titik ukur: rutin BERHENTI dan menunggu manusia. Pengujian
           pengulangan tidak ada gunanya kalau lengan sudah pergi lagi sebelum
           angkanya sempat dibaca. */
        if (r.measureAt === i) {
          say(`siklus ${c + 1}/${cycles}: di TITIK UKUR. Catat pembacaan, lalu tekan LANJUT.`, 'warn');
          els.bNext.disabled = false;
          const ok = await waitForContinue();
          if (!ok) { say('Dihentikan di titik ukur.', 'warn'); return; }
        }
      }
    }
    say(`Rutin selesai (${cycles} siklus).`, 'ok');
  } finally {
    running = false; abortRun = false;
    els.bStop.disabled = true;
    els.runRow.classList.remove('on');
    pushSpeed('teach');
    syncArmButton();
    drawProgress();
  }
}

let continueResolve = null;
function waitForContinue() {
  return new Promise(res => { continueResolve = res; });
}
function doContinue(ok) {
  if (!continueResolve) return;
  const r = continueResolve; continueResolve = null; r(ok);
}

function stopRun() {
  abortRun = true;
  doContinue(false);
  say('STOP: rutin dihentikan. Lengan berhenti di ujung gerak terakhir (bukan e-stop).', 'warn');
}

/* ---------------- ekspor ----------------
   Pose hasil betulan di lapangan harus bisa kembali ke repo. Yang dicetak
   adalah bentuk yang bisa langsung ditempel ke config/routines.js. */
function exportRoutine() {
  const out = steps.map((s, i) => (isPose(s)
    ? { a: stepPose(i), label: s.label, ...(s.note ? { note: s.note } : {}), ...(s.warn ? { warn: s.warn } : {}) }
    : { grip: s.grip, label: s.label, ...(s.note ? { note: s.note } : {}) }));
  const txt = `// ${ROUTINES[key].name} - hasil teach di lengan fisik\n`
    + `// gripper: open ${gripUs.open} us, close ${gripUs.close} us\n`
    + `steps: [\n${out.map(o => '  ' + JSON.stringify(o)).join(',\n')},\n],\n`;
  navigator.clipboard?.writeText(txt).then(
    () => say('Rutin disalin ke clipboard, siap ditempel ke config/routines.js.', 'ok'),
    () => { console.log(txt); say('Clipboard ditolak browser. Isinya dicetak di console.', 'warn'); },
  );
}

/* ---------------- build UI ---------------- */
/** judul tahap bernomor. Alur panel ini yang dulu hilang: tombolnya ada semua
 *  tapi tidak ada yang memberi tahu mana dulu yang ditekan. */
function stage(parent, no, title) {
  const d = document.createElement('div'); d.className = 'rnStage';
  d.innerHTML = `<span class="rnNum">${no}</span><span>${title}</span>`;
  parent.appendChild(d);
  return d;
}

export function buildRunner(parent) {
  load();

  const cap = document.createElement('div'); cap.className = 'segRow';
  cap.innerHTML = '<span class="cap">rutin hardware</span>';
  parent.appendChild(cap);

  /* pilih rutin */
  const sel = document.createElement('select'); sel.className = 'rnSel';
  Object.entries(ROUTINES).forEach(([k, r]) => {
    const o = document.createElement('option'); o.value = k; o.textContent = r.name; sel.appendChild(o);
  });
  sel.value = key;
  sel.onchange = () => {
    if (running) { sel.value = key; return; }
    key = sel.value; buildSteps(); syncCmdFromHw(); loadEditPose();
    desc.textContent = ROUTINES[key].desc; drawStep();
    say('Rutin dipilih. Mulai dari langkah 1.');
  };
  parent.appendChild(sel);

  const desc = document.createElement('div'); desc.className = 'mini'; desc.style.margin = '5px 0 8px';
  desc.textContent = ROUTINES[key].desc;
  parent.appendChild(desc);

  /* Profil kecepatan. Tombol ARM yang dulu berdampingan di sini sudah naik ke
     bilah interlock bersama LINK, DRIVER, dan LIVE: prasyarat gerak tidak boleh
     tinggal di dalam satu mode sementara akibatnya terasa di mode lain. Yang
     tetap tinggal justru profil kecepatan, karena dia bukan izin melainkan
     setelan rutin, dan tempatnya memang di sebelah langkah yang dijalankan. */
  const armRow = document.createElement('div'); armRow.className = 'rnArm';
  const spdCap = document.createElement('span'); spdCap.className = 'cap';
  spdCap.textContent = 'profil kecepatan';
  armRow.appendChild(spdCap);
  const spdSeg = document.createElement('div'); spdSeg.className = 'segsm';
  [['teach', `TEACH ${SPEED.teach.speed}`], ['run', `RUN ${SPEED.run.speed}`]].forEach(([k, lbl]) => {
    const b = document.createElement('button'); b.textContent = lbl; b.dataset.k = k;
    b.className = k === getProfile() ? 'on' : '';
    b.onclick = () => { if (!running) pushSpeed(k); };
    spdSeg.appendChild(b);
  });
  armRow.appendChild(spdSeg);
  parent.appendChild(armRow);

  /* baris pembebas kunci home ulang. Tombol terpisah dan bukan sekadar klik ARM
     kedua kali: yang dikonfirmasi bukan "saya sudah baca", melainkan "saya
     sudah benar benar menghomekan ulang lengannya". */
  const rehome = document.createElement('div'); rehome.className = 'rnRehome';
  rehome.style.display = 'none';
  const rehomeTxt = document.createElement('div'); rehomeTxt.className = 'mini';
  rehomeTxt.textContent = 'J3/J4 tanpa encoder: nol mereka hilang saat ESP restart. '
    + 'Jog manual ke home di halaman ESP32, jalankan cal_zero, baru bebaskan.';
  const rehomeBtn = document.createElement('button'); rehomeBtn.className = 'rnMini';
  rehomeBtn.textContent = 'sudah di-home ulang';
  rehomeBtn.onclick = () => {
    needReHome = false;
    syncCmdFromHw();
    drawRehome(); drawStep();
    say('Kunci dibebaskan. Periksa kolom aktual sebelum ARM.', 'warn');
  };
  rehome.append(rehomeTxt, rehomeBtn);
  parent.appendChild(rehome);

  /* langkah sekarang: navigasi jadi panah kecil di judul, bukan dua tombol
     penuh yang berebut perhatian dengan tombol kirim. */
  const head = document.createElement('div'); head.className = 'rnHead';
  const bPrev = document.createElement('button'); bPrev.className = 'rnNav'; bPrev.textContent = '<';
  bPrev.title = 'langkah sebelumnya'; bPrev.onclick = () => go(-1);
  const bNextNav = document.createElement('button'); bNextNav.className = 'rnNav'; bNextNav.textContent = '>';
  bNextNav.title = 'langkah berikutnya'; bNextNav.onclick = () => go(1);
  const stepNo = document.createElement('span'); stepNo.className = 'rnNo';
  const stepLbl = document.createElement('b'); stepLbl.className = 'rnLbl';
  head.append(bPrev, stepNo, stepLbl, bNextNav);
  parent.appendChild(head);
  const stepNote = document.createElement('div'); stepNote.className = 'mini rnNote';
  parent.appendChild(stepNote);
  const warn = document.createElement('div'); warn.className = 'rnWarn';
  parent.appendChild(warn);

  /* ---- tahap 1: atur target lalu rekam ----
     Dulu ini dua tahap bernomor terpisah ("atur target" dan "rekam hasil")
     dengan tahap KIRIM terjepit di antaranya. Keduanya sebenarnya satu
     aktivitas, geser slider lalu simpan, jadi nomornya cuma menambah birokrasi
     tanpa menambah kejelasan. Yang TIDAK digabung adalah KIRIM: dia satu
     satunya tahap yang menggerakkan besi, dan memisahkannya secara visual
     adalah fitur. */
  stage(parent, 1, 'atur target dan rekam');
  const jWrap = document.createElement('div'); jWrap.className = 'rnJoints';
  const jHdr = document.createElement('div'); jHdr.className = 'rnJRow rnJHdr';
  jHdr.innerHTML = '<span></span><span></span><span>target</span><span>aktual</span>';
  jWrap.appendChild(jHdr);
  const jRows = [];
  STATE.joints.forEach((j, i) => {
    const row = document.createElement('div'); row.className = 'rnJRow';
    const k = document.createElement('span'); k.className = 'rnJk'; k.textContent = j.id; k.title = j.name;
    const sl = document.createElement('input'); sl.type = 'range'; sl.step = 0.5;
    const lim = jointLim(i); sl.min = lim.min; sl.max = lim.max; sl.value = 0;
    sl.oninput = () => setJoint(i, +sl.value);
    const num = document.createElement('input'); num.type = 'number'; num.className = 'rnJn'; num.step = 0.5;
    num.onchange = () => setJoint(i, +num.value);
    const act = document.createElement('span'); act.className = 'rnJa';
    row.append(k, sl, num, act);
    jWrap.appendChild(row);
    jRows.push({ sl, num, act });
  });
  parent.appendChild(jWrap);

  /* ---- langkah gripper: slider us, bukan dua kotak angka ---- */
  const gripWrap = document.createElement('div'); gripWrap.className = 'rnGrip';
  const gripAct = document.createElement('div'); gripAct.className = 'mini';
  gripWrap.appendChild(gripAct);
  const gripRows = [];
  [['open', 'buka'], ['close', 'tutup']].forEach(([which, label]) => {
    const row = document.createElement('div'); row.className = 'rnJRow';
    const k = document.createElement('span'); k.className = 'rnJk'; k.textContent = label;
    const sl = document.createElement('input'); sl.type = 'range'; sl.step = 5;
    sl.min = gripLim.min; sl.max = gripLim.max; sl.value = gripUs[which];
    const num = document.createElement('input'); num.type = 'number'; num.className = 'rnJn'; num.step = 5;
    num.min = gripLim.min; num.max = gripLim.max; num.value = gripUs[which];
    const setG = (v) => {
      gripUs[which] = clamp(Math.round(+v || gripLim.min), gripLim.min, gripLim.max);
      sl.value = gripUs[which]; num.value = gripUs[which];
      save(); drawStep();
      if (isLive() && canSend(true)) sendServoUs(SERVO_GRIP, gripUs[which]);
    };
    sl.oninput = () => setG(sl.value);
    num.onchange = () => setG(num.value);
    const test = document.createElement('button'); test.className = 'rnMini rnJa';
    test.textContent = 'coba';
    test.onclick = () => { if (canSend()) { sendServoUs(SERVO_GRIP, gripUs[which]); say(`gripper ${which} @ ${gripUs[which]} us`, 'ok'); } };
    row.append(k, sl, num, test);
    gripWrap.appendChild(row);
    gripRows.push({ sl, num, which });
  });
  const gHint = document.createElement('div'); gHint.className = 'mini';
  gHint.textContent = 'Pulsa mentah (us), bukan derajat: tidak bergantung kalibrasi sudut gripper.';
  gripWrap.appendChild(gHint);
  parent.appendChild(gripWrap);

  const conf = document.createElement('div'); conf.className = 'btns rnBtns';
  const bSave = document.createElement('button'); bSave.textContent = 'simpan sudut ini';
  bSave.title = 'sudut slider sekarang menggantikan sudut langkah ini';
  bSave.onclick = saveStepPose;
  const chk = document.createElement('button'); chk.className = 'rnChk'; chk.onclick = markOk;
  conf.append(bSave, chk);
  parent.appendChild(conf);

  /* ---- tahap 2: kirim ----
     Tombol LIVE yang dulu berdampingan dengan KIRIM di sini DIHAPUS, bukan
     dipindah. Dulu ada dua tombol LIVE (di sini dan di tab CART) yang keduanya
     cuma tampilan atas satu state di net/liveLink.js; sekarang tampilannya
     tinggal satu, lampu LIVE di bilah interlock. */
  stage(parent, 2, 'kirim ke lengan');
  const sendRow = document.createElement('div'); sendRow.className = 'rnSend';
  const bSend = document.createElement('button'); bSend.className = 'rnGo prim';
  bSend.onclick = sendStep;
  sendRow.append(bSend);
  parent.appendChild(sendRow);

  /* progress + jalan penuh */
  const progRow = document.createElement('div'); progRow.className = 'rnProgRow';
  const prog = document.createElement('div'); prog.className = 'rnProg';
  const progTxt = document.createElement('span'); progTxt.className = 'mini';
  progRow.append(prog, progTxt);
  parent.appendChild(progRow);

  const runRow = document.createElement('div'); runRow.className = 'btns rnBtns rnRun';
  const bFull = document.createElement('button'); bFull.className = 'rnGo';
  bFull.innerHTML = icon('play', 11) + ' jalan penuh';
  bFull.style.display = 'flex'; bFull.style.alignItems = 'center'; bFull.style.gap = '6px';
  bFull.onclick = runFull;
  const bNext = document.createElement('button'); bNext.textContent = 'lanjut'; bNext.disabled = true;
  bNext.onclick = () => { bNext.disabled = true; doContinue(true); };
  const bStop = document.createElement('button'); bStop.className = 'rnStop'; bStop.textContent = 'stop'; bStop.disabled = true;
  bStop.onclick = stopRun;
  runRow.append(bFull, bNext, bStop);
  parent.appendChild(runRow);

  /* footer: yang jarang dipakai turun ke sini sebagai teks, bukan tombol yang
     ikut berebut perhatian dengan alur di atasnya. */
  const foot = document.createElement('div'); foot.className = 'rnFoot';
  const mkLink = (label, fn, title) => {
    const a = document.createElement('button'); a.className = 'rnLink'; a.textContent = label;
    if (title) a.title = title;
    a.onclick = fn; foot.appendChild(a); return a;
  };
  mkLink('ekspor rutin', exportRoutine, 'salin pose hasil teach untuk ditempel ke config/routines.js');
  /* Muncul HANYA kalau memang ada sisa di kunci versi sebelumnya. Tombol yang
     selalu ada tapi biasanya tidak melakukan apa apa akan berhenti dibaca
     justru di hari ia dibutuhkan. */
  const lama = bacaLama();
  if (lama) {
    mkLink(`pulihkan hasil kerja lama (${lama.nPose} pose, ${lama.nOk} tanda)`, pulihkanLama,
      `Masih tersimpan di kunci versi lain di alamat ini (${(lama.data.dari || []).join(', ')}). `
      + 'Kunci penyimpanan pernah dinaikkan saat isi rutin berubah, jadi panel berhenti '
      + 'membacanya. Isinya tidak pernah dihapus.');
  }
  mkLink('sudut asli', revertStepPose, 'buang hasil teach langkah INI, kembali ke angka di routines.js');
  mkLink('reset verifikasi', () => {
    if (running) return;
    verified[key] = []; delete overrides[key];
    buildSteps(); save(); loadEditPose(); drawStep();
    say('Verifikasi dan pose hasil teach untuk rutin ini dihapus.', 'warn');
  }, 'hapus semua tanda terverifikasi dan pose hasil teach di rutin ini');
  /* Reset menyeluruh berdiri terpisah dari "reset verifikasi" yang cuma
     menyentuh rutin aktif. Yang ini dipakai sesudah sesuatu yang mendasar
     berubah (arah sendi twin dibalik, home digeser): pada saat itu SEMUA hasil
     teach di semua rutin ikut kehilangan artinya, dan membersihkannya satu
     rutin per satu rutin berarti sisa yang terlewat akan diam diam dipercaya.
     Confirm-nya disengaja: ini satu satunya tombol di panel yang membuang
     pekerjaan mengajar yang tidak bisa dikembalikan. */
  mkLink('reset SEMUA rutin', () => {
    if (running) return;
    if (!confirm('Hapus SELURUH pose hasil teach, tanda verifikasi, dan pulsa gripper '
      + 'di semua rutin? Angka akan kembali ke config/routines.js.')) return;
    verified = {}; overrides = {}; gripUs = { ...GRIP_US_DEFAULT }; savedAt = 0;
    try { localStorage.removeItem(LS_KEY); } catch { /* diblokir: state RAM sudah bersih */ }
    drawTeach();
    syncGripLimits();          // pulsa gripper kembali dijepit travel hasil cal
    drawGripRows();            // ...dan tetap tersegarkan walau belum terhubung
    buildSteps(); loadEditPose(); drawStep();
    say('Semua rutin dikembalikan ke angka di config/routines.js. Jalani ulang di TEACH.', 'warn');
  }, 'buang hasil teach di SEMUA rutin dan kembali ke angka di config/routines.js');
  parent.appendChild(foot);

  const teach = document.createElement('div'); teach.className = 'mini';
  parent.appendChild(teach);

  const status = document.createElement('div'); status.className = 'mini rnStatus';
  parent.appendChild(status);

  els = {
    stepNo, stepLbl, stepNote, warn, jWrap, jRows, gripWrap, gripAct, gripRows,
    bSend, bSave, bFull, bStop, bNext, bPrev, bNextNav, chk, prog, progTxt,
    status, spdSeg, gripHint: gHint, rehome, runRow, teach,
  };

  buildSteps();
  syncCmdFromHw();
  loadEditPose();
  syncArmButton();
  drawStep();
  drawTeach();
  if (migrasi) {
    say(`Hasil kerja dari penyimpanan versi sebelumnya dipulihkan otomatis: `
      + `${migrasi.nPose} pose hasil teach dan ${migrasi.nOk} tanda terverifikasi. `
      + 'Sebagian tanda dibuat sebelum J5 pose ambil dan taruh berubah, jadi periksa lagi '
      + 'langkah yang mendekati meja sebelum JALAN PENUH.', 'ok');
  } else {
    say(storeOk
      ? 'Atur target di slider, ARM, lalu KIRIM. Betulkan langsung di slider kalau meleset.'
      : 'Browser menolak menyimpan di alamat ini: hasil teach TIDAK akan bertahan sampai '
        + 'halaman berikutnya. Buka studio lewat `npm run dev`, bukan dari berkas dist/ '
        + 'langsung.', storeOk ? '' : 'bad');
  }

  /* Kunci home ulang dipasang sebagai veto di liveLink, bukan diperiksa di
     tombol ARM saja. Sejak gizmo TCP juga bisa menyalakan aliran ke lengan,
     penjaga yang cuma hidup di satu tombol berarti penjaga yang bisa dilewati
     lewat tombol yang lain. */
  setArmVeto(() => (needReHome
    ? 'ARM dikunci: frame sudut sendi open-loop bergeser. Home ulang lengan, '
      + 'jalankan cal_zero, lalu tekan tombol pembebas di mode RUTIN.'
    : null));

  /* State ARM/LIVE/profil sekarang milik bersama, jadi tombol di panel ini
     harus ikut berubah kalau yang mengubahnya bilah interlock (atau liveLink sendiri,
     mis. saat link putus). */
  onLiveChange(({ why }) => {
    syncArmButton();
    if (why && els.status) say(why, 'warn');
  });

  /* Penanda untuk penjaga sendi open-loop: goto dari SUMBER MANA PUN dihitung,
     termasuk aliran live dan panel kalibrasi. */
  onHwStatus(ev => { if (ev.type === 'goto') sentSinceLink = true; });

  /* Kalibrasi firmware menentukan tiga hal di panel ini: travel gripper, batas
     slider sendi, dan sendi mana yang umpan baliknya boleh dipercaya. Semuanya
     baru diketahui setelah cal_get dijawab, jadi UI-nya disegarkan di sini,
     bukan sekali saat dibangun. */
  onHwStatus(ev => {
    if (ev.type === 'link') {
      if (!ev.up) onLinkDown();
      // Saat link kembali TIDAK ada yang diputuskan di sini: feedback pertama
      // belum tentu sudah datang, dan memeriksa pose memakai angka basi justru
      // melahirkan kesimpulan palsu. Pemeriksaannya dijalankan di tik UI di
      // bawah, saat getActual() sudah berisi data segar sesudah reconnect.
      return;
    }
    if (ev.type === 'cal') { syncGripLimits(); drawStep(); }
    else if (ev.type === 'drv') {
      /* Pemulihan driver berlangsung otomatis dan cepat, jadi tanpa baris ini
         kejadiannya lewat begitu saja. Yang harus sampai ke operator bukan cuma
         "sempat bermasalah", melainkan konsekuensinya: firmware menyamakan
         target dengan posisi nyata, jadi langkah rutin yang sedang berjalan
         TIDAK diselesaikan dan pose sekarang bukan pose yang diperintahkan. */
      if (!ev.ok) {
        abortRun = true;
        say('Driver TMC belum siap: tahap output dimatikan firmware dan ARM dilucuti. '
          + 'Periksa PSU 12 V, pemulihan dicoba otomatis tiap 5 detik.', 'bad');
      } else if (ev.baru) {
        abortRun = true;
        say(`Driver sempat hilang atau reset (kejadian ke-${ev.resets}) lalu dikonfigurasi ulang otomatis. `
          + 'Target dibekukan di posisi nyata, jadi gerak yang sedang berjalan tidak dilanjutkan. '
          + 'Periksa pose lengan sebelum ARM lagi.', 'warn');
      }
      syncArmButton();
    }
    else if (ev.type === 'fbtrust') {
      const buta = [4, 5].filter(i => !isFbTrusted(i)).map(i => 'J' + (i + 1));
      if (buta.length) {
        say(`${buta.join(' dan ')} tanpa umpan balik terpercaya (pot belum dikalibrasi). `
          + 'Kolom aktual untuk sendi itu ditandai "buta": cuma mata yang bisa menilainya.', 'warn');
      }
      drawStep();
    }
  });
  syncGripLimits();

  /* Refresh kolom aktual dari feedback hardware. Nilai aktual berubah 50 Hz;
     UI-nya tidak perlu secepat itu, yang penting operator melihat angkanya
     mendekat ke target saat sendi benar-benar sampai. */
  setInterval(() => {
    if (pendingCheck && isConnected()) runLinkCheck();
    if (steps.length) drawSliders();
  }, UI_MS);
}

/** dipanggil main.js saat E-STOP: putus auto-run dan lucuti interlock.
 *  setArmed(false) ikut mematikan aliran live, jadi gizmo TCP di mode GERAK juga
 *  berhenti mengirim tanpa perlu tahu apa apa tentang E-STOP. */
export function runnerEstop() {
  abortRun = true;
  doContinue(false);
  setArmed(false);
  if (els.status) say('E-STOP: rutin dihentikan dan interlock dilucuti.', 'bad');
  syncArmButton();
}
