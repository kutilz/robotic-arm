/* ============================================================================
   traj: interpolasi trajektori keyframe. Modul MURNI (tidak menyentuh DOM,
   WebGL, atau three), sengaja dipisah dari features/timeline.js supaya bisa
   diuji di Node lewat `node studio/tools/verify_traj.mjs`. timeline.js tinggal
   jadi transport: play, pause, scrub, dan gambar bar.

   INTERPOLASINYA BUKAN LINEAR. Dulu iya, dan itu yang bikin gerakan tersendat
   tiap kali lengan berbelok: interpolasi linear menyambung keyframe dengan
   kecepatan TETAP di dalam tiap ruas, jadi di setiap keyframe kecepatannya
   melompat seketika. Posisinya nyambung, kecepatannya tidak, dan mata membaca
   patahan kecepatan itu sebagai sentakan. Makin tajam beloknya makin kelihatan.

   Penggantinya kubik Hermite MONOTON (Fritsch-Carlson 1980): kecepatan ikut
   nyambung melewati keyframe, tetapi tangennya dibatasi supaya kurvanya tidak
   pernah melewati nilai keyframe yang diapitnya. Batas itu bukan hiasan. Spline
   biasa (Catmull-Rom) akan membuat sendi menjulur melewati sudut yang diminta
   di sekitar belokan tajam, dan lintasan yang menembus meja atau melewati limit
   sendi persis seperti itu bentuknya. Monoton berarti: mulus saat menerus, dan
   saat sendi berbalik arah ia melambat sampai berhenti dulu lalu berangkat
   lagi, sama seperti sendi sungguhan.

   Ini murni lapisan pratinjau 3D. Runner hardware (features/runner.js) tidak
   memakai timeline sama sekali, jadi tidak ada satu pun perintah ke lengan yang
   berubah karena file ini.
   ========================================================================== */

/**
 * Tangen Hermite monoton per sendi.
 * @param keys [{t, angles:[]}] terurut menaik menurut t
 * @returns array per SENDI berisi tangen per keyframe (derajat/detik)
 */
export function hermiteTangents(keys) {
  const n = keys.length, nj = n ? keys[0].angles.length : 0;
  const out = [];
  if (n < 2) return out;

  const h = [];
  for (let i = 0; i < n - 1; i++) h.push(Math.max(1e-6, keys[i + 1].t - keys[i].t));

  for (let j = 0; j < nj; j++) {
    const d = [];               // kemiringan tiap ruas (derajat/detik)
    for (let i = 0; i < n - 1; i++) d.push((keys[i + 1].angles[j] - keys[i].angles[j]) / h[i]);

    const m = new Array(n);
    /* Ujung dipatok nol, bukan disamakan dengan kemiringan ruas terluar. Ini
       yang membuat demo berangkat dan berhenti dengan halus alih alih menyala
       langsung di kecepatan penuh dan mati mendadak di keyframe terakhir. */
    m[0] = 0; m[n - 1] = 0;
    for (let i = 1; i < n - 1; i++) {
      // Ganti tanda = sendi berbalik arah di keyframe ini -> tangen nol, yaitu
      // berhenti sesaat. Tanpa ini kurvanya menjulur melewati titik balik.
      m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    }
    // Pembatas Fritsch-Carlson: jaga (m[i], m[i+1]) di dalam lingkaran radius 3
    // terhadap kemiringan ruasnya, syarat cukup supaya ruas itu tetap monoton.
    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
      const a = m[i] / d[i], b = m[i + 1] / d[i];
      const s = a * a + b * b;
      if (s > 9) { const tau = 3 / Math.sqrt(s); m[i] = tau * a * d[i]; m[i + 1] = tau * b * d[i]; }
    }
    out.push(m);
  }
  return out;
}

/**
 * Pose pada waktu t.
 * @param tang hasil hermiteTangents(keys); boleh null (dihitung ulang, mahal)
 */
export function sampleAt(keys, t, tang) {
  const last = keys.length - 1;
  if (last < 0) return null;
  if (t <= keys[0].t) return keys[0].angles.slice();
  if (t >= keys[last].t) return keys[last].angles.slice();
  const m = tang || hermiteTangents(keys);
  for (let i = 0; i < last; i++) {
    const a = keys[i], b = keys[i + 1];
    if (t < a.t || t > b.t) continue;
    const h = b.t - a.t || 1, s = (t - a.t) / h, s2 = s * s, s3 = s2 * s;
    // basis Hermite
    const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s;
    const h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
    return a.angles.map((v, k) => h00 * v + h10 * h * m[k][i]
      + h01 * b.angles[k] + h11 * h * m[k][i + 1]);
  }
  return keys[last].angles.slice();
}

/* Bagian waktu terkecil yang dijamin didapat sebuah ruas, dijumlahkan untuk
   semua ruas. 0,18 berarti 18% durasi dibagi rata dan 82% sisanya dibagi
   menurut jarak tempuh. Murni proporsional (0) membuat ruas pendek lewat
   secepat kedipan sehingga terbaca sebagai lompatan; murni rata (1) adalah
   perilaku lama yang justru jadi sumber masalahnya. */
export const SEG_FLOOR = 0.18;

/**
 * Bangun keyframe dari daftar pose (array sudut).
 *
 * Waktu tiap ruas dibagi menurut JARAK TEMPUH, bukan dibagi rata. Dulu dibagi
 * rata, dan itu sumber kedua gerakan yang tersendat: di showcase, ruas
 * `home -> J1 +60` (60 deg) dan `J1 +60 -> J1 -60` (120 deg) sama sama dapat
 * 1,0 detik, jadi kecepatan sendi berlipat dua di tengah demo tanpa alasan apa
 * pun. Sekarang ruas yang jauh dapat waktu lebih banyak, sehingga kecepatan
 * sudutnya kira kira tetap sepanjang demo.
 *
 * Ukurannya jarak sendi TERJAUH (norma maks), bukan jumlah semua sendi, karena
 * sendi bergerak berbarengan: yang menentukan lama sebuah ruas adalah sendi
 * yang paling jauh perjalanannya, persis seperti gerak terkoordinasi di lengan.
 *
 * @param dt detik per ruas RATA RATA. Durasi total tetap (n-1)*dt seperti dulu,
 *           jadi pembagian baru ini tidak memperpanjang demo mana pun.
 */
export function keysFromPoses(poses, dt = 1.2) {
  const n = poses.length;
  const rata = () => poses.map((a, i) => ({ t: i * dt, angles: a.slice() }));
  if (n < 2) return rata();

  const seg = [];
  for (let i = 0; i < n - 1; i++) {
    let d = 0;
    for (let k = 0; k < poses[i].length; k++) d = Math.max(d, Math.abs(poses[i + 1][k] - poses[i][k]));
    seg.push(d);
  }
  const sum = seg.reduce((a, b) => a + b, 0);
  if (!(sum > 1e-6)) return rata();   // semua pose sama: tidak ada yang dibagi

  const total = (n - 1) * dt;
  const out = [];
  let t = 0;
  for (let i = 0; i < n; i++) {
    out.push({ t, angles: poses[i].slice() });
    // bobot menjumlah tepat 1: SEG_FLOOR dibagi rata + sisanya menurut jarak
    if (i < n - 1) t += total * (SEG_FLOOR / (n - 1) + (1 - SEG_FLOOR) * seg[i] / sum);
  }
  return out;
}
