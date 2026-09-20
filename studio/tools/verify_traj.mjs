/* ============================================================================
   Periksa interpolasi trajektori (src/model/traj.js) TANPA WebGL:

     node studio/tools/verify_traj.mjs

   Yang dibuktikan di sini adalah tiga hal yang menentukan halus tidaknya gerak
   di layar, dan ketiganya bisa diperiksa dari angka saja:

     1 KECEPATAN NYAMBUNG di tiap keyframe. Ini inti masalahnya: interpolasi
       linear membuat kecepatan MELOMPAT di tiap keyframe, dan lompatan itulah
       yang terlihat sebagai sentakan waktu lengan berbelok. Diukur dengan beda
       maju: kecepatan sesaat sebelum dan sesudah tiap keyframe harus cocok.

     2 TIDAK MENJULUR melewati sudut keyframe. Spline yang mulus tapi menjulur
       akan mengarang pose yang tidak pernah diminta, dan pose karangan itu bisa
       jatuh di bawah meja atau di luar limit sendi. Diperiksa dengan menyapu
       rapat tiap ruas dan membandingkannya dengan kotak nilai kedua ujungnya.

     3 PEMBAGIAN WAKTU ikut jarak tempuh, dan durasi totalnya tetap sama dengan
       cara lama sehingga tidak ada demo yang diam diam jadi lebih panjang.

   Demo dan rutin yang sesungguhnya (config/arm.js, config/routines.js) ikut
   diuji, bukan cuma data karangan, supaya pose yang benar benar dipakai yang
   dijamin.
   ========================================================================== */
import { hermiteTangents, sampleAt, keysFromPoses, SEG_FLOOR } from '../src/model/traj.js';
import { DEMO_POSES } from '../src/config/arm.js';
import { staticRoutines, posesOf } from '../src/config/routines.js';

let bad = 0;
const check = (nama, ok, detail = '') => {
  console.log(`  ${ok ? 'OK  ' : 'GAGAL'} ${nama}${detail ? '  ' + detail : ''}`);
  if (!ok) bad++;
};
const checkNum = (nama, got, want, tol) =>
  check(nama, Math.abs(got - want) <= tol, `${got.toFixed(4)} vs ${want} (tol ${tol})`);

/** kecepatan numerik tiap sendi di waktu t (beda pusat, derajat/detik). */
function vel(keys, t, tang, e) {
  const a = sampleAt(keys, t - e, tang), b = sampleAt(keys, t + e, tang);
  return a.map((v, i) => (b[i] - v) / (2 * e));
}

/* ---------------------------------------------------------------------------
   1 kecepatan nyambung di keyframe
   --------------------------------------------------------------------------- */
/** beda kecepatan sesaat sebelum vs sesudah tiap keyframe, diukur dengan
 *  celah `gap` detik di kedua sisi. */
function lompatanKecepatan(keys, tang, gap) {
  let worst = 0, dimana = '';
  // keyframe ujung dilewati: di sana memang tidak ada "sesudah"/"sebelum"
  for (let i = 1; i < keys.length - 1; i++) {
    const t = keys[i].t, e = gap / 8;
    const before = vel(keys, t - gap, tang, e);
    const after = vel(keys, t + gap, tang, e);
    before.forEach((v, j) => {
      const d = Math.abs(after[j] - v);
      if (d > worst) { worst = d; dimana = `keyframe ${i}, J${j + 1}`; }
    });
  }
  return { worst, dimana };
}

/* Nilai sisa selalu ada dan itu BUKAN patahan: percepatannya berhingga, jadi
   mengukur kecepatan di t-gap dan t+gap otomatis memberi selisih sebesar
   percepatan x 2 gap. Yang membedakan fungsi C1 dari C0 karena itu bukan
   besarnya sisa melainkan SIFATNYA: pada C1 sisa itu menyusut sebanding dengan
   gap, sedangkan interpolasi linear meninggalkan lompatan yang besarnya tetap
   berapa pun gap-nya. Itulah yang diuji di sini, dan itu juga sebabnya angka
   "lompatan 0,9 deg/s" di gap besar tidak boleh dibaca sebagai kegagalan. */
function cekMulus(nama, poses, dt) {
  const keys = keysFromPoses(poses, dt);
  const tang = hermiteTangents(keys);
  const kasar = lompatanKecepatan(keys, tang, 8e-4);
  const halus = lompatanKecepatan(keys, tang, 1e-4);   // gap 8x lebih kecil
  const rasio = kasar.worst > 1e-9 ? halus.worst / kasar.worst : 0;
  // C1: sisa menyusut ~8x jadi rasio ~0,125. C0 (linear): rasio ~1.
  check(`${nama}: kecepatan nyambung di tiap keyframe`, rasio < 0.3,
    `sisa ${kasar.worst.toFixed(3)} -> ${halus.worst.toFixed(4)} deg/s saat gap dikecilkan 8x`
    + ` (rasio ${rasio.toFixed(3)}, linear akan ~1)${kasar.dimana ? ', ' + kasar.dimana : ''}`);
  return keys;
}

/* ---------------------------------------------------------------------------
   2 tidak menjulur melewati sudut keyframe
   --------------------------------------------------------------------------- */
function cekMonoton(nama, keys) {
  const tang = hermiteTangents(keys);
  let worst = 0, dimana = '';
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i].angles, b = keys[i + 1].angles;
    for (let s = 0; s <= 40; s++) {
      const p = sampleAt(keys, keys[i].t + (keys[i + 1].t - keys[i].t) * (s / 40), tang);
      p.forEach((v, j) => {
        const lo = Math.min(a[j], b[j]), hi = Math.max(a[j], b[j]);
        const over = Math.max(lo - v, v - hi);
        if (over > worst) { worst = over; dimana = `ruas ${i}, J${j + 1}`; }
      });
    }
  }
  check(`${nama}: tidak menjulur keluar kotak keyframe`, worst < 1e-6,
    `julur terbesar ${worst.toExponential(2)} deg${dimana ? ' di ' + dimana : ''}`);
}

/* ---------------------------------------------------------------------------
   3 melewati tiap keyframe persis (interpolasi, bukan aproksimasi)
   --------------------------------------------------------------------------- */
function cekLewatKeyframe(nama, keys) {
  const tang = hermiteTangents(keys);
  let worst = 0;
  for (const k of keys) {
    const p = sampleAt(keys, k.t, tang);
    p.forEach((v, j) => { worst = Math.max(worst, Math.abs(v - k.angles[j])); });
  }
  check(`${nama}: lewat tepat di tiap keyframe`, worst < 1e-9,
    `simpangan ${worst.toExponential(2)} deg`);
}

console.log('== sifat dasar interpolasi ==');
{
  // Segitiga: naik lalu turun. Inilah bentuk "belok" yang dikeluhkan. Spline
  // biasa akan menjulur melewati puncak; monoton tidak boleh.
  const keys = [
    { t: 0, angles: [0] }, { t: 1, angles: [30] }, { t: 2, angles: [0] },
  ];
  const tang = hermiteTangents(keys);
  let puncak = -Infinity;
  for (let s = 0; s <= 400; s++) puncak = Math.max(puncak, sampleAt(keys, 2 * s / 400, tang)[0]);
  checkNum('titik balik tidak dilewati (puncak tetap 30)', puncak, 30, 1e-9);
  checkNum('tangen di titik balik = 0 (berhenti dulu, lalu balik)', tang[0][1], 0, 1e-12);
  checkNum('tangen di awal = 0 (berangkat halus)', tang[0][0], 0, 1e-12);
  checkNum('tangen di akhir = 0 (berhenti halus)', tang[0][2], 0, 1e-12);
}
{
  // Menerus naik: TIDAK boleh berhenti di keyframe tengah, kalau tidak gerakan
  // jadi stop-and-go di tiap keyframe (bug yang berlawanan).
  const keys = [
    { t: 0, angles: [0] }, { t: 1, angles: [10] }, { t: 2, angles: [20] },
  ];
  const tang = hermiteTangents(keys);
  check('gerak menerus tidak berhenti di keyframe tengah', tang[0][1] > 5,
    `tangen tengah ${tang[0][1].toFixed(2)} deg/s`);
}
{
  const keys = [{ t: 0, angles: [0, 0] }, { t: 1, angles: [10, -4] }];
  const p = sampleAt(keys, 0.5, hermiteTangents(keys));
  check('dua keyframe: tengah tetap di antara keduanya',
    p[0] > 0 && p[0] < 10 && p[1] < 0 && p[1] > -4, `[${p.map(v => v.toFixed(2))}]`);
}

console.log('\n== pembagian waktu menurut jarak tempuh ==');
{
  // Ruas kedua dua kali lebih jauh dari yang pertama.
  const poses = [[0, 0, 0, 0, 0, 0], [30, 0, 0, 0, 0, 0], [-30, 0, 0, 0, 0, 0]];
  const keys = keysFromPoses(poses, 1.0);
  checkNum('durasi total tetap (n-1)*dt', keys[2].t, 2.0, 1e-9);
  const r1 = keys[1].t, r2 = keys[2].t - keys[1].t;
  check('ruas yang lebih jauh dapat waktu lebih banyak', r2 > r1 * 1.5,
    `${r1.toFixed(3)} s vs ${r2.toFixed(3)} s`);
  // dengan SEG_FLOOR, ruas terpendek tetap kebagian
  check('ruas pendek tidak dipangkas habis', r1 > 0.18 * SEG_FLOOR, `${r1.toFixed(3)} s`);
}
{
  const sama = [[0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0]];
  const keys = keysFromPoses(sama, 1.2);
  check('semua pose sama: jatuh ke spasi seragam',
    Math.abs(keys[1].t - 1.2) < 1e-9 && Math.abs(keys[2].t - 2.4) < 1e-9,
    keys.map(k => k.t.toFixed(2)).join(', '));
}
{
  const keys = keysFromPoses([[1, 2, 3, 4, 5, 6]], 1.2);
  check('satu pose saja tidak bikin error', keys.length === 1 && keys[0].t === 0);
}

console.log('\n== demo 3D yang sebenarnya ==');
for (const [nama, poses] of Object.entries(DEMO_POSES)) {
  const keys = cekMulus(`demo ${nama}`, poses, 1.3);
  cekMonoton(`demo ${nama}`, keys);
  cekLewatKeyframe(`demo ${nama}`, keys);
}

console.log('\n== pratinjau rutin hardware ==');
for (const [key, r] of staticRoutines()) {
  const poses = posesOf(r);
  if (poses.length < 3) continue;
  const keys = cekMulus(`rutin ${key}`, poses, 1.1);
  cekMonoton(`rutin ${key}`, keys);
  cekLewatKeyframe(`rutin ${key}`, keys);
}

console.log('\n' + (bad === 0 ? 'semua pemeriksaan lulus' : `${bad} PEMERIKSAAN GAGAL`));
process.exit(bad === 0 ? 0 : 1);
