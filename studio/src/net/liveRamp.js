/* ============================================================================
   Aturan aliran LIVE, tanpa satu pun ketergantungan pada peramban.

   Modul ini sengaja berdiri sendiri dan cuma berisi aritmetika: seluruh
   keputusan "pesan apa yang berangkat pada tick ini" ada di planTick(), dan
   dia tidak tahu apa apa tentang WebSocket, scene graph, maupun DOM. Alasannya
   sama dengan cadRig.js yang cuma bergantung pada three: bagian yang menentukan
   apakah lengan aman digerakkan harus bisa dibuktikan di Node, bukan cuma
   dicoba sambil melihat lengan bergerak.

   Buktinya: `node studio/tools/verify_live.mjs`.
   Pemakainya: net/liveLink.js (yang memegang interlock dan I/O).

   -------------------------------------------------------------------------
   KENAPA TARGET DIRAYAPKAN, BUKAN DILOMPATKAN

   Firmware menulis pulsa servo J5/J6 ke target seketika tiap putaran loop
   (servoWriteUs di arm_controller_esp32.ino), sedangkan stepper J1..J4 jalan
   pada profil kecepatan: 8 dps saat TEACH, 25 dps saat RUN. Selisihnya 20
   sampai 60 kali. Jadi satu goto yang melompat jauh tidak pernah dieksekusi
   sebagai satu gerakan: pergelangan menekuk penuh lebih dulu di posisi lama,
   lengan menyusul. Kalau target itu datang dari mouse yang disentak,
   pergelangan ikut menyentak.

   Yang dialirkan karena itu bukan pose gizmo, melainkan pose perintah yang
   MERAYAP menuju pose gizmo sebesar (kecepatan profil x periode tick) per
   pesan. Servo tidak bisa lagi mendahului stepper karena targetnya sendiri
   yang tidak pernah melompat.
   ========================================================================== */

/* 50 ms = 20 Hz, angka yang sama dengan throttle slider di halaman bawaan
   ESP32 (webui.h). Bukan pilihan estetis: itu laju yang sudah terbukti bisa
   diladeni firmware sambil tetap melayani WebSocket, HTTP, encoder, dan step
   generator di ESP32 yang sama. */
export const TICK_MS = 50;

/* Ambang diam. WAJIB ada, dan bukan sekadar penghemat lalu lintas.

   Begitu pose perintah sampai di target, poseDirty dilepas dan model kembali
   mengikuti feedback. Sejak saat itu pose twin berisi angka HASIL UKUR yang
   selalu bergoyang sedikit. Tanpa ambang, tiap goyangan encoder terbaca sebagai
   "target berubah", jadi studio akan mengirim goto 20 kali per detik SELAMANYA
   untuk mengejar deraunya sendiri, dan lengan diperintah ke posisinya sendiri
   yang bergetar. Itu umpan balik positif, bukan mode live.

   0,2 derajat: di atas derau encoder (pengulangan J2 terukur 0,01 derajat) dan
   masih di bawah deadband firmware 0,3 derajat, jadi ambang ini tidak pernah
   menahan gerakan yang sebenarnya akan dieksekusi lengan. */
export const DEADBAND = 0.2;

/** derajat maksimum yang boleh ditambahkan ke tiap sendi per pesan. */
export function stepPerTick(dps) {
  return Math.max(0.05, dps * TICK_MS / 1000);
}

/**
 * Keputusan satu tick aliran live.
 *
 * @param cmd       pose yang terakhir benar benar diperintahkan ke lengan
 * @param tgt       pose twin sekarang (hasil gizmo/slider/IK)
 * @param step      jatah gerak per sendi untuk satu pesan, dari stepPerTick()
 * @param dirty     STATE.poseDirty: masih ada edit lokal yang belum berangkat
 * @param deadband  ambang diam
 * @returns {{angles:number[], keepDirty:boolean}|null} null = jangan kirim
 */
export function planTick({ cmd, tgt, step, dirty, deadband = DEADBAND }) {
  const err = Math.max(...tgt.map((v, i) => Math.abs(v - cmd[i])));
  if (err < deadband) {
    /* Sudah sampai. Satu pesan penutup dikirim HANYA kalau masih ada edit lokal
       yang belum pernah berangkat; sesudah itu poseDirty lepas, model kembali
       mengikuti lengan, dan tick berhenti mengirim apa pun sampai operator
       menggerakkan sesuatu lagi. */
    return dirty ? { angles: tgt.slice(), keepDirty: false } : null;
  }
  /* keepDirty: model harus tetap menampilkan pose TARGET yang sedang disusun
     operator selama perintahnya masih merayap. Melepas dirty di tengah tarikan
     membuat feedback menindas pose itu dan gizmo berkedut. Yang melepasnya
     nanti cabang "sudah sampai" di atas. */
  return {
    angles: cmd.map((v, i) => {
      const d = tgt[i] - v;
      return Math.abs(d) <= step ? tgt[i] : v + Math.sign(d) * step;
    }),
    keepDirty: true,
  };
}
