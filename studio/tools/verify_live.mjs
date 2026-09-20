/* ============================================================================
   Buktikan sifat aliran LIVE (net/liveLink.js) TANPA peramban dan TANPA lengan:

     node studio/tools/verify_live.mjs

   Mode live membuat lengan mengikuti gizmo TCP terus menerus, tanpa klik kirim.
   Itu berarti studio berubah dari "mengirim kalau diklik" menjadi "mengirim
   terus menerus", dan tiga hal yang selama ini dijaga oleh jari operator
   sekarang harus dijaga oleh kode:

     1 TIDAK ADA LOMPATAN. Firmware menulis pulsa servo J5/J6 ke target
       seketika, sedangkan stepper jalan pada profil kecepatan. Target yang
       melompat karena itu tidak dieksekusi sebagai satu gerakan: pergelangan
       menekuk penuh dulu, lengan menyusul. Jadi tiap pesan tidak boleh
       menggeser satu sendi pun lebih dari jatah satu tick, berapa pun jauhnya
       gizmo ditarik.
     2 TIDAK ADA PESAN KOSONG. Sesudah pose perintah sampai, model kembali
       mengikuti feedback, dan feedback itu selalu bergoyang sedikit. Tanpa
       ambang diam, tiap goyangan encoder akan dibalas satu goto, 20 kali per
       detik, selamanya. Yang diuji di sini persis skenario itu.
     3 SAMPAI TEPAT DAN BERHENTI. Rayapan harus berakhir di target, bukan
       berosilasi di sekitarnya, dan pesan terakhirnya yang melepas poseDirty.

   Yang diuji adalah planTick(), yaitu SELURUH keputusan aliran itu sebagai
   fungsi murni. Bagian yang tersisa di tick() cuma pemanggilan I/O.
   ========================================================================== */
import { planTick, DEADBAND, TICK_MS, stepPerTick } from '../src/net/liveRamp.js';
import { SPEED } from '../src/config/routines.js';

let bad = 0;
const check = (nama, ok, detail = '') => {
  console.log(`  ${ok ? 'OK  ' : 'GAGAL'} ${nama}${detail ? '  ' + detail : ''}`);
  if (!ok) bad++;
};

const NJ = 6;
const stepOf = (profil) => stepPerTick(SPEED[profil].speed);
const maxDelta = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

/** Jalankan aliran sampai benar benar diam. `tgt` boleh berubah tiap tick (mis.
 *  gizmo yang masih ditarik) lewat `tgtAt(k)`.
 *
 *  poseDirty ikut disimulasikan apa adanya, karena dia bagian dari perilaku
 *  yang diuji: dia naik tiap pose twin berubah (applyPose) dan turun tiap ada
 *  pesan yang dikirim tanpa keepDirty (bridge.sendGoto). Kalau bagian ini
 *  dipalsukan jadi "selalu dirty", aliran tidak akan pernah berhenti dan
 *  ujinya justru menyembunyikan cacat yang paling penting. */
function alirkan({ cmd0, tgtAt, step, maxTick = 4000 }) {
  let cmd = cmd0.slice();
  let dirty = true;
  let prevTgt = null;
  const pesan = [];
  for (let k = 0; k < maxTick; k++) {
    const tgt = tgtAt(k);
    if (prevTgt && maxDelta(tgt, prevTgt) > 0) dirty = true;
    prevTgt = tgt;
    const msg = planTick({ cmd, tgt, step, dirty });
    if (!msg) break;                      // diam: tidak ada lagi yang dikirim
    pesan.push({ k, ...msg });
    cmd = msg.angles.slice();
    if (!msg.keepDirty) dirty = false;
  }
  return { pesan, cmd };
}

console.log('\n== 1 tidak ada lompatan, berapa pun jauhnya gizmo ditarik ==');
for (const profil of ['teach', 'run']) {
  const step = stepOf(profil);
  // gizmo disentak: satu sendi lompat 120 deg sekaligus, sendi lain diam
  const tgt = [0, 0, 0, 0, 120, 0];
  const { pesan } = alirkan({ cmd0: new Array(NJ).fill(0), tgtAt: () => tgt, step });
  let worst = 0, prev = new Array(NJ).fill(0);
  for (const m of pesan) { worst = Math.max(worst, maxDelta(m.angles, prev)); prev = m.angles; }
  check(`${profil}: tiap pesan <= jatah satu tick (${step.toFixed(2)} deg)`,
    worst <= step + 1e-9, `lompatan terbesar ${worst.toFixed(3)} deg`);
  // 120 deg pada kecepatan profil = durasi yang bisa dihitung di muka
  const durasi = pesan.length * TICK_MS / 1000;
  const harap = 120 / SPEED[profil].speed;
  check(`${profil}: J5 120 deg butuh ~${harap.toFixed(1)} detik (bukan seketika)`,
    Math.abs(durasi - harap) < 0.2, `${durasi.toFixed(2)} detik, ${pesan.length} pesan`);
}

console.log('\n== 2 tidak ada pesan kosong ==');
{
  const step = stepOf('teach');
  const cmd = [10, 20, 30, 0, 15, 0];
  // Sudah sampai DAN tidak ada edit lokal: harus benar benar diam.
  check('diam total saat pose perintah = pose twin',
    planTick({ cmd, tgt: cmd.slice(), step, dirty: false }) === null);

  /* Derau encoder sesudah sampai. Ini yang paling penting: kalau planTick
     membalas derau, studio mengirim 20 goto per detik selamanya untuk mengejar
     posisinya sendiri, dan itu umpan balik positif, bukan mode live.
     Amplitudo 0,05 deg dipilih 5x lebih besar daripada pengulangan J2 yang
     terukur (0,01 deg), jadi ujinya tidak longgar. */
  let kirim = 0;
  for (let k = 0; k < 400; k++) {
    const derau = cmd.map((v, i) => v + 0.05 * Math.sin(k * 1.7 + i));
    if (planTick({ cmd, tgt: derau, step, dirty: false })) kirim++;
  }
  check('derau encoder +-0,05 deg tidak memicu satu pesan pun',
    kirim === 0, `${kirim} pesan dari 400 tick (= ${(400 * TICK_MS / 1000).toFixed(0)} detik)`);

  // Tapi edit lokal sekecil apa pun tetap berangkat, sekali saja.
  const nudge = planTick({ cmd, tgt: cmd.map((v, i) => v + (i === 0 ? 0.1 : 0)), step, dirty: true });
  check('geseran kecil dengan edit lokal tetap dikirim, sekali', !!nudge && nudge.keepDirty === false);
}

console.log('\n== 3 sampai tepat lalu berhenti ==');
{
  const step = stepOf('run');
  const tgt = [-45, 22.7, 129.5, 0, 24.1, 0];
  const { pesan, cmd } = alirkan({ cmd0: [0, 0, 0, 0, 0, 0], tgtAt: () => tgt, step });
  const akhir = pesan[pesan.length - 1];
  check('pesan terakhir mendarat tepat di target', maxDelta(akhir.angles, tgt) < 1e-9,
    `selisih ${maxDelta(akhir.angles, tgt).toExponential(1)} deg`);
  check('pesan terakhir melepas poseDirty (model kembali ikut lengan)', akhir.keepDirty === false);
  check('semua pesan sebelumnya menahan poseDirty',
    pesan.slice(0, -1).every(m => m.keepDirty === true));
  check('sesudah sampai tidak ada pesan lagi',
    planTick({ cmd, tgt, step, dirty: false }) === null);
  // monoton: tidak pernah melewati target lalu balik
  let lewat = 0;
  let prev = [0, 0, 0, 0, 0, 0];
  for (const m of pesan) {
    m.angles.forEach((v, i) => {
      const arahAwal = Math.sign(tgt[i] - prev[i]);
      if (arahAwal && Math.sign(tgt[i] - v) === -arahAwal) lewat++;
    });
    prev = m.angles;
  }
  check('tidak pernah melewati target lalu balik', lewat === 0, `${lewat} kali melewati`);
}

console.log('\n== 4 gizmo yang ditarik terus menerus ==');
{
  /* Skenario nyata: operator menarik gizmo selama 2 detik, jauh lebih cepat
     daripada lengan bisa mengikuti, lalu melepas. Yang harus terjadi: lengan
     tertinggal selama ditarik, tetap tidak pernah melompat, lalu menyusul
     sampai tepat sesudah mouse berhenti. */
  const step = stepOf('teach');
  const TARIK = 40;                       // 40 tick = 2 detik
  const akhirTarik = [0, 30, 60, 0, 40, 0];
  const tgtAt = (k) => akhirTarik.map(v => v * Math.min(1, k / TARIK));
  const { pesan, cmd } = alirkan({ cmd0: [0, 0, 0, 0, 0, 0], tgtAt, step });
  let worst = 0, prev = [0, 0, 0, 0, 0, 0];
  for (const m of pesan) { worst = Math.max(worst, maxDelta(m.angles, prev)); prev = m.angles; }
  check('tetap tidak ada lompatan selama ditarik cepat', worst <= step + 1e-9,
    `lompatan terbesar ${worst.toFixed(3)} deg`);
  check('tertinggal saat ditarik, lalu menyusul sampai tepat',
    maxDelta(cmd, akhirTarik) < 1e-9 && pesan.length > TARIK,
    `${pesan.length} pesan (${(pesan.length * TICK_MS / 1000).toFixed(1)} detik) untuk tarikan 2 detik`);
}

console.log('\n== 5 laju kirim ==');
{
  check(`satu pesan per ${TICK_MS} ms (${(1000 / TICK_MS).toFixed(0)} Hz), sama dengan throttle webui.h`,
    TICK_MS === 50);
  check('ambang diam di bawah deadband firmware 0,3 deg', DEADBAND < 0.3, `${DEADBAND} deg`);
  /* Pesan penutup MENYERGAP sisa jarak sampai target sekaligus, jadi besarnya
     sama dengan ambang diam. Kalau ambang itu lebih besar daripada jatah satu
     tick di profil paling lambat, pesan penutup jadi satu satunya pesan yang
     boleh melompat, dan servo bisa mendahului stepper tepat di ujung gerakan.
     Di situlah dua konstanta ini terikat satu sama lain. */
  check('pesan penutup tidak bisa melompati jatah satu tick di profil terlambat',
    DEADBAND <= stepOf('teach'), `ambang ${DEADBAND} vs jatah ${stepOf('teach').toFixed(2)} deg`);
}

console.log('\n' + (bad === 0 ? 'semua pemeriksaan lulus' : `${bad} PEMERIKSAAN GAGAL`));
process.exit(bad === 0 ? 0 : 1);
