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
import {
  isConnected, sendGoto, sendCalSet, onHwStatus, isDriverOk,
  getMode, getLevel, getNet, getP95, setLeaseProvider, getActual, isFbTrusted,
} from './bridge.js';
import { TICK_MS, planTick, stepPerTick } from './liveRamp.js';
import { PROFILE, CLOUD_TICK_MS, leaseFor } from './netQuality.js';

export { TICK_MS };
const NJ = 6;

/* -------------------------------------------------------------------------
   LINK INTERNET (7 Okt 2026). Tiga tambahan, semuanya di modul ini karena
   di sinilah satu satunya pintu perintah gerak:

   1 LEASE. Selama ARM menyala, setiap goto dan setiap ping membawa lease
     (net/netQuality.js leaseFor). Firmware merem lengan begitu lease habis
     tanpa perpanjangan. ARM dimatikan = ping berhenti membawa lease = lengan
     berhenti dalam hitungan lease, bukan menuntaskan target lama.
   2 PERIODE KIRIM PER JALUR. Lokal tetap 50 ms (terbukti). Cloud 200 ms
     dengan jatah per pesan yang ikut membesar: yang menjaga kehalusan di
     jalur cloud adalah batas laju di firmware, bukan kerapatan pesan.
   3 TINGKAT LINK MEMBATASI. LIVE dan profil RUN hanya boleh di tingkat yang
     mengizinkannya (PROFILE); turun tingkat mematikannya saat itu juga dan
     menyebutkan alasannya. Link yang putus menolak gerak sama sekali.
   ------------------------------------------------------------------------- */
const tickMs = () => (getMode() === 'cloud' ? CLOUD_TICK_MS : TICK_MS);

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
  const net = getNet();
  if (net.level === 'putus') {
    return `Link tersendat: ping terakhir belum dijawab ${(net.overdue / 1000).toFixed(1)} detik. `
      + 'Firmware sudah merem lengan sendiri; tunggu link pulih.';
  }
  if (net.mode === 'cloud') {
    if (net.relay.role === 'viewer') return 'Token ini mode LIHAT SAJA. Pakai token operator untuk mengendalikan.';
    if (net.relay.ctrl === 'other') return 'Lengan sedang dikendalikan browser lain lewat relay.';
    if (net.own === 'local') {
      return 'Lengan sedang dikendalikan dari jaringan lokal. Jalur lokal selalu didahulukan; '
        + 'tunggu sampai di sana dilucuti.';
    }
  }
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
    step: stepPerTick((SPEED[profile] || SPEED.teach).speed, tickMs()),
    dirty: STATE.poseDirty,
  });
  if (msg) sendPose(msg.angles, { src: 'live', keepDirty: msg.keepDirty });
}

function startTimer() {
  clearInterval(timer);
  timer = setInterval(tick, tickMs());
}
function stopTimer() { clearInterval(timer); timer = null; }

/** Nyalakan/matikan aliran live. Mengembalikan alasan gagal, atau null. */
export function setLive(on, why = '') {
  if (on) {
    const block = blockedReason() || levelBlocksLive();
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
  if (!SPEED[k]) return null;
  if (k === 'run' && !PROFILE[getLevel()].run) {
    const why = `Link ${PROFILE[getLevel()].label.toLowerCase()}: profil RUN ditahan, TEACH saja sampai link membaik.`;
    emit(why);
    return why;
  }
  profile = k;
  pushSpeed();
  emit();
  return null;
}

/** Alasan tingkat link menolak LIVE, atau null. */
function levelBlocksLive() {
  const lv = getLevel();
  if (PROFILE[lv].live) return null;
  const net = getNet();
  return `Link ${PROFILE[lv].label.toLowerCase()} (RTT p95 ${Number.isFinite(net.p95) ? Math.round(net.p95) : '?'} ms): `
    + 'LIVE dimatikan supaya lengan tidak mengejar target yang datang tersendat. '
    + 'Kirim pose satu per satu.';
}

/* Pose perintah disamakan dengan pose NYATA. Dipakai sesudah firmware merem
   lengan karena lease habis: aliran live yang dinyalakan lagi harus merayap
   dari tempat lengan berhenti, bukan dari target lama yang tidak pernah
   dicapai. Sendi yang umpan baliknya tidak dipercaya (pot servo placeholder)
   tetap memakai pose perintahnya sendiri, bukan angka karangan. */
function resyncCmdFromActual() {
  const a = getActual();
  if (!a) return;
  setCmd(cmd.map((c, i) => (a[i] != null && isFbTrusted(i) ? a[i] : c)));
}

/* Lease yang diminta ke firmware/relay. null selama ARM mati: ping tetap
   jalan (RTT), tapi tidak lagi memperpanjang apa pun. */
setLeaseProvider(() => (armed ? leaseFor(getMode(), getP95()) : null));
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
  } else if (ev.type === 'net') {
    const p = PROFILE[ev.level];
    if (live && !p.live) setLive(false, levelBlocksLive());
    if (profile === 'run' && !p.run) {
      profile = 'teach';
      pushSpeed();
      emit(`Link ${p.label.toLowerCase()}: profil turun ke TEACH.`);
    }
    if (ev.level === 'putus' && armed) {
      armed = false;
      live = false;
      stopTimer();
      emit('Link tersendat terlalu lama, ARM dilucuti. Lengan sudah direm firmware (lease habis).');
    }
    // Periode kirim ikut jalur; timer yang sedang jalan disetel ulang.
    if (live) startTimer();
  } else if (ev.type === 'hold') {
    if (ev.on) {
      resyncCmdFromActual();
      if (live) {
        live = false;
        stopTimer();
        emit('Lease habis: perintah tidak sampai tepat waktu, lengan direm firmware. '
          + 'Nyalakan LIVE lagi untuk melanjutkan dari posisi sekarang.');
      }
    }
  } else if (ev.type === 'own' || ev.type === 'relay') {
    const why = armed ? armPrereq() : null;
    if (why) {
      armed = false;
      live = false;
      stopTimer();
      emit(why + ' ARM dilucuti.');
    }
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
