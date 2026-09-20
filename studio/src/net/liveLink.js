/* ============================================================================
   LIVE LINK: satu satunya pintu perintah GERAK ke lengan, plus interlock ARM.

   Kenapa modul ini ada, dan kenapa dia satu satunya:

   Sebelum ini "kirim target" hidup di dua tempat yang tidak saling kenal.
   Runner punya `armed`, `live`, throttle 50 ms, dan `cmdPose` sendiri; tombol
   Send goto dan panel kalibrasi memanggil bridge langsung. Selama yang bisa
   mengirim cuma tombol, itu masih bisa dipertanggungjawabkan: satu klik, satu
   pesan. Begitu gizmo TCP boleh mengikuti mouse, tidak lagi: mouse menghasilkan
   puluhan perubahan pose per detik, dan dua sumber yang mengirim target ke
   sendi yang sama tanpa saling tahu adalah definisi tabrakan perintah.

   Karena itu SEMUA jalur target sekarang lewat sini, dan aturannya tiga:

     1 SATU PENGIRIM BERKALA. Cuma ada satu setInterval di seluruh studio yang
       boleh mengalirkan goto, yaitu tick() di bawah. Tidak ada modul lain yang
       punya timer kirim sendiri.
     2 SATU SUMBER KEBENARAN untuk "pose apa yang terakhir benar benar
       diperintahkan" (`cmd`). Siapa pun yang mengirim goto (runner, tombol,
       panel kalibrasi) ikut memperbarui `cmd` lewat event bridge, jadi aliran
       live selalu berangkat dari pose yang nyata, bukan dari pose yang dia
       kira. Tanpa ini, satu goto dari sumber lain akan langsung ditarik balik
       oleh tick berikutnya.
     3 TIDAK ADA PESAN KOSONG. Kalau `cmd` sudah sama dengan target, tick tidak
       mengirim apa apa. Link tidak diisi lalu lintas yang tidak mengubah apa
       pun, dan operator tidak melihat "sedang mengirim" padahal diam.

   -------------------------------------------------------------------------
   TARGET DIALIRKAN BERTAHAP, BUKAN DILOMPATKAN.

   Ini bagian yang membuat mode live boleh ada sama sekali. Firmware menulis
   pulsa servo J5/J6 ke target seketika tiap putaran loop, sedangkan stepper
   J1..J4 jalan pada profil kecepatan (8 dps TEACH, 25 dps RUN). Satu goto yang
   melompat jauh karena itu tidak pernah dijalankan sebagai satu gerakan:
   pergelangan menekuk penuh dulu di posisi lama, lengan menyusul. Kalau target
   itu datang dari mouse yang disentak, pergelangan menyentak juga.

   Jadi yang dialirkan bukan pose gizmo, melainkan `cmd` yang MERAYAP menuju
   pose gizmo sebesar (kecepatan profil x periode tick) per pesan: 0,4 derajat
   per sendi di TEACH, 1,25 di RUN. Efeknya servo tidak bisa lagi mendahului
   stepper, karena targetnya sendiri yang tidak pernah melompat. Menarik gizmo
   sejauh apa pun cuma membuat lengan berjalan lebih lama, bukan lebih cepat.

   Konsekuensi yang harus diterima: lengan TERTINGGAL di belakang gizmo saat
   ditarik cepat, dan baru menyusul setelah mouse berhenti. Itu memang yang
   diinginkan; alternatifnya adalah lengan yang mencoba mengejar pointer.

   -------------------------------------------------------------------------
   INTERLOCK. Sama seperti sebelumnya, tidak ada satu byte pun yang berangkat
   selama ARM mati, E-STOP aktif, atau link putus. Yang berubah cuma tempatnya:
   dulu milik panel runner, sekarang milik modul ini, sehingga tombol LIVE di
   gizmo TCP dan tombol kirim di panel rutin tunduk pada interlock yang sama.
   Sejak relayout 13 Agu 2026 tampilannya pun tinggal satu, yaitu lampu LIVE di
   bilah interlock: dua saklar yang kelihatan mirip tapi berdiri sendiri adalah
   cacat keselamatan, bukan kemudahan.
   ========================================================================== */
import { STATE } from '../config/arm.js';
import { SPEED } from '../config/routines.js';
import { isConnected, sendGoto, sendCalSet, onHwStatus, isDriverOk } from './bridge.js';
import { TICK_MS, planTick, stepPerTick } from './liveRamp.js';

export { TICK_MS };
const NJ = 6;

let armed = false;
let live = false;
let profile = 'teach';
let cmd = new Array(NJ).fill(0);   // pose TERAKHIR yang benar benar diperintahkan
let timer = null;
let armVeto = null;                // () => alasan menolak ARM, atau null

const listeners = new Set();
/** subscribe perubahan state: {armed, live, profile, why}. */
export function onLiveChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(why = '') {
  for (const fn of listeners) fn({ armed, live, profile, why });
}

export const isArmed = () => armed;
export const isLive = () => live;
export const getProfile = () => profile;
/** salinan pose terakhir yang diperintahkan (bukan pose aktual lengan). */
export const getCmd = () => cmd.slice();
/** samakan `cmd` dengan kenyataan (mis. sesudah sinkron dari feedback). */
export function setCmd(a) { if (Array.isArray(a) && a.length >= NJ) cmd = a.slice(0, NJ).map(Number); }

/** Pasang penolak ARM. Dipakai runner untuk mengunci ARM saat frame sudut
 *  sendi open-loop tidak lagi bisa dipertanggungjawabkan. Ditaruh sebagai hook,
 *  bukan disalin ke sini, karena alasan penguncian itu memang milik runner. */
export function setArmVeto(fn) { armVeto = fn; }
/** Alasan veto ARM yang SEDANG berlaku, atau null. Pembaca murni atas hook di
 *  atas, bukan cabang keputusan kedua: yang menolak tetap setArmed(). Ada supaya
 *  bilah interlock bisa menjelaskan lampu ARM yang terkunci tanpa menyuruh
 *  operator mengklik dan gagal dulu. Sengaja TIDAK ikut blockedReason(): veto
 *  menolak transisi ARM, bukan pengiriman, dan mencampurnya akan membuat pose
 *  yang sudah terlanjur ARMED ikut ditolak tanpa dasar. */
export const armVetoReason = () => (armVeto ? armVeto() : null);

/* Prasyarat DI LUAR ARM. Dipisah dari blockedReason() supaya setArmed() bisa
   memakai daftar yang sama persis tanpa ikut memeriksa ARM, yang justru sedang
   dinyalakan. Satu daftar, dua pemakai: tidak ada urutan yang disalin. */
function armPrereq() {
  if (STATE.estop) return 'E-STOP aktif. Tekan RESET dulu.';
  if (!isConnected()) return 'Belum terhubung. Sambungkan lewat lampu LINK di bilah interlock.';
  /* Driver yang belum terverifikasi bukan sekadar "belum siap": firmware
     mematikan tahap outputnya, jadi goto yang dikirim ke sana ditolak dan
     lengan diam tanpa gejala selain sunyi. Menyebutkannya di sini membuat
     penyebabnya muncul di tombol yang ditekan operator, bukan cuma di Serial. */
  if (!isDriverOk()) return 'Driver TMC belum siap. Periksa PSU 12 V; firmware mencoba memulihkan sendiri tiap 5 detik.';
  return null;
}

/** alasan kenapa perintah gerak tidak boleh berangkat sekarang, atau null. */
export function blockedReason() {
  const blok = armPrereq();
  if (blok) return blok;
  if (!armed) return 'ARMED masih mati. Nyalakan dulu sebelum mengirim.';
  return null;
}

/** Kirim satu pose sekarang juga. Mengembalikan alasan gagal, atau null bila
 *  terkirim. `src` menandai siapa yang mengirim supaya modul lain (dan modul
 *  ini sendiri) bisa membedakan aliran live dari perintah satu kali. */
export function sendPose(angles, { src = 'manual', keepDirty = false } = {}) {
  const why = blockedReason();
  if (why) return why;
  if (!sendGoto(angles, { src, keepDirty })) return 'Pengiriman gagal: link tertutup.';
  return null;
}

/* ---------------- aliran live ----------------
   Aturannya (rayapan sebesar jatah profil + ambang diam) ada di
   net/liveRamp.js sebagai fungsi murni, supaya bisa dibuktikan tanpa peramban
   dan tanpa lengan lewat `node studio/tools/verify_live.mjs`. Yang tersisa di
   sini cuma I/O dan interlock. */
function tick() {
  if (!live) return;
  const why = blockedReason();
  if (why) { setLive(false, why); return; }

  const msg = planTick({
    cmd,
    tgt: STATE.joints.map(j => j.a),
    step: stepPerTick((SPEED[profile] || SPEED.teach).speed),
    dirty: STATE.poseDirty,
  });
  if (msg) sendPose(msg.angles, { src: 'live', keepDirty: msg.keepDirty });
}

function startTimer() {
  clearInterval(timer);
  timer = setInterval(tick, TICK_MS);
}
function stopTimer() { clearInterval(timer); timer = null; }

/** Nyalakan/matikan aliran live. Mengembalikan alasan gagal, atau null. */
export function setLive(on, why = '') {
  if (on) {
    const block = blockedReason();
    if (block) { live = false; stopTimer(); emit(block); return block; }
    /* Berangkat dari pose yang SEDANG diperintahkan, bukan dari pose twin:
       kalau operator sempat menggeser twin jauh sebelum menyalakan live, tick
       pertama tidak boleh mengirim lompatan sebesar itu. Merayapnya dimulai
       dari sini. */
    live = true;
    startTimer();
    emit(why);
    return null;
  }
  live = false;
  stopTimer();
  emit(why);
  return null;
}

/** Nyalakan/matikan interlock ARM. Mengembalikan alasan penolakan, atau null. */
export function setArmed(on) {
  if (on) {
    /* ARM ikut tunduk pada prasyarat yang sama dengan pengiriman. Dulu tidak:
       setArmed() cuma menanyai veto, jadi ARM bisa dinyalakan selagi E-STOP
       tertekan atau link mati. Tidak ada gerak yang berangkat karena sendPose()
       tetap memeriksa, tapi tombolnya menyala "ARMED" di atas rantai yang mati,
       dan interlock yang menampilkan keadaan yang tidak dia miliki lebih buruk
       daripada tidak ada interlock. Ketahuan waktu bilah interlock dipasang:
       lampu ARM hijau sementara lampu LINK merah. */
    const blok = armPrereq();
    if (blok) return blok;
    const veto = armVeto && armVeto();
    if (veto) return veto;
    armed = true;
    pushSpeed();
    emit();
    return null;
  }
  armed = false;
  setLive(false);          // dilucuti = tidak boleh ada aliran yang tertinggal
  emit();
  return null;
}

/** Profil kecepatan. Ikut menentukan laju rayapan aliran live, jadi keduanya
 *  tidak bisa lagi berbeda diam diam dari yang dipakai firmware. */
export function setProfile(k) {
  if (!SPEED[k]) return;
  profile = k;
  pushSpeed();
  emit();
}
function pushSpeed() {
  const p = SPEED[profile];
  if (isConnected()) sendCalSet({ speed: p.speed, accel: p.accel });
}

/* ---------------- jaga supaya tidak ada dua sumber target ----------------
   Tiap goto yang benar benar berangkat dipancarkan bridge sebagai event, dari
   sumber mana pun. Dua hal dilakukan di sini:

   - `cmd` disamakan dengan pose yang BENAR BENAR berangkat, siapa pun
     pengirimnya. Ini yang membuat aliran live tidak pernah menarik lengan balik
     sesudah runner atau panel kalibrasi mengirim goto sendiri: tick berikutnya
     berangkat dari pose yang nyata, bukan dari pose yang modul ini kira.
     Dipasang di event, bukan di tiap tempat kirim, supaya tidak ada jalur
     kirim yang bisa lupa memperbaruinya. (setCmd juga dipakai runner untuk
     menyamakan `cmd` dengan feedback, dan itu memang bukan pengiriman.)
   - link putus melucuti ARM dan menghentikan aliran. Perintah gerak tidak
     boleh berangkat lagi diam diam saat link kembali. */
onHwStatus((ev) => {
  if (ev.type === 'goto') {
    if (Array.isArray(ev.angles)) setCmd(ev.angles);
  } else if (ev.type === 'link' && !ev.up) {
    armed = false;
    live = false;
    stopTimer();
    emit('Koneksi putus.');
  } else if (ev.type === 'drv' && !ev.ok) {
    /* Driver kehilangan tahap outputnya = jaminan yang jadi dasar ARM sudah
       hilang, sama seperti link putus. Dilucuti, bukan sekadar diblokir:
       firmware membekukan target dan menyamakannya dengan posisi nyata saat
       pulih, jadi ARM yang tertinggal menyala akan menyiratkan bahwa gerak
       sebelumnya masih akan dilanjutkan. Tidak akan. */
    armed = false;
    live = false;
    stopTimer();
    emit('Driver TMC belum siap, ARM dilucuti.');
  }
});
