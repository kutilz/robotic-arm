/* ============================================================================
   cadRig: SATU-SATUNYA sumber geometri kinematik studio. Berisi data sumbu
   sendi hasil ukur CAD, peta part ke link, dan matematika rantai. Modul ini
   sengaja hanya bergantung pada `three` (bukan viewport/renderer) supaya bisa
   diuji di Node tanpa WebGL lewat `node studio/tools/verify_cad_rig.mjs`.

   SUMBER: onshape/Main Assembly (Complete).glb, rev 2026-08-03 (94 part,
   penamaan part jelas + mate connector lengkap). Disiapkan lewat
   `node tools/optimize_cad_glb.mjs "onshape/Main Assembly (Complete).glb"`:
   drop-parts -> prune -> weld -> join --keepNamed -> meshopt.
   33,2 MB / 94 part -> 1,80 MB / 60 part / 78 draw call. Yang dibuang hanya
   part yang terkurung rapat di dalam rakitan (cakram cycloidal, input cam,
   crown bola, pulley dan belt J1 di dalam casing, poros, spline servo); part
   yang tersisa tidak didesimasi sama sekali. Rincian isi rakitan dan hasil
   ukurnya ada di docs/bom-main-assembly.md.

   KONVENSI SUMBU: Onshape mengekspor dalam METER dan Z-UP; three.js Y-UP.
   CAD_BASIS memetakan CAD (x,y,z) -> studio (z,x,y). Efeknya di studio:
     J1 yaw  +Y      J2 pitch +X     J3 pitch +X
     J4 roll +Y      J5 pitch +X     J6 roll  +Y
   Jadi lengan berayun di bidang Y-Z dan offset bahu a1 terletak di sumbu -Z.
   Rantai DIBANGUN LANGSUNG DALAM MILIMETER STUDIO; part GLB (yang datang
   dalam meter, frame CAD) dimasukkan lewat `partHost` per link yang membawa
   rotasi basis + skala 1000, sehingga overlay, marker massa, dan skeleton
   bisa ditulis dalam mm studio apa adanya.

   SUMBU SENDI: diukur dari GLB, bukan ditebak.
     J1      dari kantong bola Stage 1/2 Crown (slewing bearing base)
     J2/3/4  dari lingkaran 30/10/15 lubang roller di Top Roller Cover
     J5/J6   dari silinder boss keluaran servo MG996R
   Deviasi standar fit lingkaran 0,000 mm. Cek silang: sumbu J4, J5, dan J6
   berpotongan dalam 0,05 mm di (-65,55, -12,45, 630,56), jadi pergelangan
   memang spherical. Titik p tiap sendi boleh titik mana saja di garis sumbu
   (rotasi terhadap sebuah garis tidak bergantung titik acuannya). Untuk J2 dan
   J3 dipilih y = -12,45, yaitu titik potong sumbu J3 dengan sumbu J4, supaya
   vektor lengan atas dan lengan bawah benar-benar tegak lurus sumbu sendinya
   dan offset home bisa dihitung tanpa sisa komponen ke samping.

   POSE NOL: rakitan Onshape disimpan tidak persis di nol (J4 sekitar -3 deg,
   J5 sekitar +3 deg, dan pergelangan ter-roll 90 deg terhadap konvensi
   studio). Offset home dihitung dari sudut antar link, jadi sudut sendi 0
   memberi lengan tegak dengan sumbu pitch pergelangan sejajar sumbu J2, dan
   tetap sah kalau CAD di-reexport dalam pose lain. Perhitungan ini murni dari
   CAD_JOINTS, jadi rantai tetap benar walau GLB belum tersedia.

   CATATAN: hanya rangka yang dirig. Sisi statik tiap reduktor (Top Base,
   Bottom Base, motor) ikut link INDUK, sedangkan Housing (output) + Top Roller
   Cover + pelat lanjutannya ikut link ANAK, sesuai topologi housing-output
   drive ini. Gripper MG90S ikut L6 sebagai benda kaku (buka-tutup rahang
   bukan DOF).
   ========================================================================== */
import * as THREE from 'three';

export const CAD_URL = '/main-assembly.glb';
export const CAD_SCALE = 1000;  // meter (Onshape) -> mm (studio)
export const CAD_PART_N = 60;   // jumlah part yang diharapkan setelah optimasi
export const CAD_GROUND_Z = -10; // z terendah rakitan (alas profil 2020) di frame CAD

// basis CAD -> studio: kolom = bayangan sumbu CAD x, y, z di studio.
export const CAD_BASIS = [
  new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0),
];

// Sumbu sendi dalam koordinat file CAD (mm, Z-up). p = satu titik di sumbu,
// a = arah sumbu (putaran positif = kaidah tangan kanan terhadap a). J4, J5,
// dan J6 memakai titik yang sama: pusat pergelangan.
export const CAD_JOINTS = [
  { id: 'J1', p: [0, 0, 0], a: [0, 0, 1] },
  { id: 'J2', p: [-65.85, -12.45, 72.80], a: [0, 1, 0] },
  { id: 'J3', p: [-65.61, -12.45, 360.80], a: [0, 1, 0] },
  { id: 'J4', p: [-65.55, -12.45, 630.56], a: [0.001, 0, 1] },
  { id: 'J5', p: [-65.55, -12.45, 630.56], a: [0.999, -0.053, -0.001] },
  { id: 'J6', p: [-65.55, -12.45, 630.56], a: [-0.002, -0.053, 0.999] },
];

/* TCP = titik tengah ujung wedge jaw saat jaw tertutup (docs/bom-main-assembly.md
   bagian 5). Dinyatakan di frame J6: origin = pusat pergelangan, z' = sumbu J6,
   x' = sumbu J5, y' = z' x x'. Ujung jaw dipilih (bukan tengah permukaan
   cengkeram) karena bisa disentuhkan ke referensi saat uji akurasi ISO 9283,
   dan karena titik terjauh ini bikin sizing torsi konservatif. */
export const CAD_TCP_J6 = [-0.80, 15.74, 174.23];

// Peta part -> link (0 = base diam, 1..6 = ikut sendi J1..J6). Dibangkitkan
// dari analisis bbox dunia tiap part: sisi statik tiap reduktor ikut link
// induk, sisi output ikut link anak. Kunci = nama part + pusat bounding box
// (mm, koordinat file CAD). Nama saja tidak cukup (ada 8 nama yang dipakai
// lebih dari sekali, tersebar di link berbeda) dan posisi saja juga tidak
// cukup (banyak part sepusat, mis. Top Base dan Top Roller Cover cuma
// berjarak 1,5 mm padahal beda link). Kombinasi keduanya aman: dua part
// dengan nama sama yang paling berdekatan masih terpisah 59,4 mm.
export const CAD_PARTS = [
  ['Aluminum 2020 11 cm', -65.0, 0.0, 0.0, 0],
  ['Aluminum 2020 11 cm', 65.0, 0.0, 0.0, 0],
  ['Aluminum 2020 20 cm', 0.0, 0.0, 0.0, 0],
  ['Base Plate', 0.0, 0.0, 12.5, 0],
  ['Diametric Magnet Holder', 0.0, 0.0, 72.9, 0],
  ['Holder extention', 0.0, 0.0, 25.0, 0],
  ['Stage 1 Holder', 0.0, 0.0, 18.0, 0],
  ['Stage 2 Holder', 0.0, 0.0, 32.0, 0],
  ['Stage 3 Holder', 0.0, 0.0, 30.0, 0],
  ['Bottom Base (Fastened to 17HS6401S)', -65.8, -53.8, 72.8, 1],
  ['Diametric Holder', -65.8, -82.7, 72.8, 1],
  ['Encoder Bearing Holder', 0.0, 0.0, 73.0, 1],
  ['J1', 0.0, 0.0, 30.2, 1],
  ['J1 Flange', 8.2, 30.5, 63.7, 1],
  ['J2 Stepper Gripper', -65.9, -20.0, 74.1, 1],
  ['Nema 17HS2401', -8.6, 0.0, 120.2, 1],
  ['Nema 17HS6401S', -65.8, -22.6, 76.3, 1],
  ['Pulley Casing', 35.2, 0.0, 79.5, 1],
  ['Pulley Casing Cover', 35.2, 0.0, 52.3, 1],
  ['Top Base', -65.8, -73.8, 72.8, 1],
  ['20T Motor Pulley', -65.8, -90.5, 181.8, 2],
  ['480mm Timing Belt', -65.6, -93.5, 280.9, 2],
  ['60T Driven Pulley', -65.6, -93.5, 360.8, 2],
  ['6906zz Inner Holder (Stage 1)', -65.6, -75.5, 360.8, 2],
  ['6906zz Inner Holder (Stage 2)', -65.6, -66.0, 360.8, 2],
  ['Arm Link (From J2)', -65.8, -80.3, 145.1, 2],
  ['Arm Link (To J3)', -65.6, -85.3, 268.4, 2],
  ['Housing (output)', -65.8, -60.3, 72.8, 2],
  ['Nema 17HS2401', -62.3, -61.0, 181.8, 2],
  ['Output Pulley & Shaft Holder', -65.6, -95.0, 360.8, 2],
  ['Top Base', -65.6, -44.3, 360.8, 2],
  ['Top Roller Cover', -65.8, -72.3, 72.8, 2],
  ['Bottom Base (Fastened to NEMA17)', -65.6, -12.5, 413.1, 3],
  ['Diametric Holder & J4 Stepper Gripper', -65.6, -14.8, 368.3, 3],
  ['Encoder Spacer', -65.6, -40.8, 360.8, 3],
  ['Housing (output, fit to outer ring 6906zz)', -65.6, -61.8, 360.8, 3],
  ['J4 Stepper Gripper', -65.6, -11.3, 390.5, 3],
  ['Nema 17HS2401', -65.6, -9.0, 391.3, 3],
  ['Top Base', -65.5, -12.5, 432.6, 3],
  ['Top Roller Cover', -65.6, -45.8, 360.8, 3],
  ['Encoder Spacer', -65.5, -12.5, 436.1, 4],
  ['Housing (output)', -65.6, -12.5, 419.6, 4],
  ['MG996R', -85.7, -11.4, 629.5, 4],
  ['Top Roller Cover', -65.5, -12.5, 431.1, 4],
  ['Wrist Link', -68.4, -12.2, 544.9, 4],
  ['Wrist Link Holder', -65.5, -12.5, 453.5, 4],
  ['MG996R', -64.4, -16.7, 700.6, 5],
  ['Only 1 part', -55.6, -15.3, 666.1, 5],
  ['Gear Gripper Holder', -65.7, -8.8, 745.2, 6],
  ['J6 Connector & Servo Holder', -65.7, -26.3, 746.0, 6],
  ['Jaw Link 2', -60.3, -8.9, 767.5, 6],
  ['Jaw Spacer 1', -50.9, -9.5, 779.5, 6],
  ['Jaw Spacer 2', -80.8, -9.5, 779.4, 6],
  ['Jaw link 1', -71.3, -8.9, 767.5, 6],
  ['MG90S', -76.6, -29.9, 754.3, 6],
  ['Only 1 part', -65.7, -17.4, 724.5, 6],
  ['Second Gear', -54.1, -13.5, 760.3, 6],
  ['Servo-Attatched Gear', -77.5, -13.5, 760.3, 6],
  ['Wedge Jaw 1', -75.3, -7.5, 790.8, 6],
  ['Wedge Jaw 2', -56.4, -7.5, 790.8, 6],
];

/* Internal reduktor cycloidal. optimize_cad_glb.mjs MEMBUANG ketiga nama ini
   dari GLB web karena terkurung rapat di dalam Housing (output) + Top Roller
   Cover, jadi CAD_PARTS tetap 60 baris dan verify_cad_rig.mjs tetap hijau.
   Baris di bawah cuma terpakai kalau GLB dibangun dengan --keep, yaitu varian
   yang dipakai gambar exploded view di thesis/figures/cycloidal-j2-exploded.html:

     node tools/optimize_cad_glb.mjs "onshape/Main Assembly (Complete).glb" \
          studio/public/main-assembly-cyc.glb --keep "Cycloid Disk,Input Cam,Crown"

   Angkanya dari `node studio/tools/daftar_part_cad.mjs public/main-assembly-cyc.glb
   --baru`. Kolom link SUDAH DIKOREKSI manual: tebakan sendi terdekat menaruh
   kelompok z sekitar 420 di link 3, padahal J4 adalah sendi roll yang sumbunya
   memanjang sepanjang lengan bawah, jadi gearbox-nya duduk di pangkal lengan
   (z sekitar 413 sampai 431) sementara titik sumbunya dipilih di pusat
   pergelangan (z 630,56). Pembanding: Housing (output) di (-65,6, -12,5, 419,6)
   dan Top Roller Cover di (-65,5, -12,5, 431,1) dua-duanya link 4. */
export const CAD_PARTS_EXTRA = [
  // J2, cycloidal 30 roller, sumbu z = 72,80
  ['Cycloid Disk', -65.0, -59.3, 72.4, 2],
  ['Cycloid Disk', -66.7, -65.6, 73.2, 2],
  ['Input Cam', -66.6, -65.6, 73.3, 2],
  ['Input Cam', -65.1, -59.3, 72.3, 2],
  ['Crown', -65.8, -71.7, 72.8, 2],
  ['Crown', -65.8, -53.9, 72.8, 2],
  // J3, cycloidal 10 roller, sumbu z = 360,80
  ['Cycloid Disk', -67.1, -52.3, 361.4, 3],
  ['Cycloid Disk', -64.1, -58.3, 360.2, 3],
  ['Input Cam', -67.1, -52.3, 360.8, 3],
  ['Input Cam', -64.1, -58.3, 360.8, 3],
  ['Crown', -65.6, -45.8, 360.8, 3],
  // J4, cycloidal 15 roller, gearbox di pangkal lengan bawah
  ['Cycloid Disk', -64.4, -12.5, 418.6, 4],
  ['Cycloid Disk', -66.8, -12.5, 424.6, 4],
  ['Input Cam', -66.8, -12.5, 424.6, 4],
  ['Input Cam', -64.4, -12.5, 418.6, 4],
  ['Crown', -65.5, -12.5, 431.0, 4],
  ['Crown', -65.6, -12.5, 413.2, 4],
];

/* Tabel gabungan yang dipakai linkOf(). Aman untuk GLB 60 part: nama ketiga
   part tambahan tidak bentrok dengan satu pun dari 60 nama itu, dan linkOf()
   selalu mengutamakan kecocokan nama, jadi baris tambahan tidak pernah ikut
   dipertimbangkan selama nama part-nya dikenal. */
const SEMUA_PARTS = CAD_PARTS.concat(CAD_PARTS_EXTRA);

export const MATCH_TOL = 5;  // mm; cocok yang benar selalu di bawah 0,1 mm

const vec = (a) => new THREE.Vector3(a[0], a[1], a[2]);
const clamp1 = (v) => Math.max(-1, Math.min(1, v));

/** kuaternion rotasi basis CAD -> studio. */
export function basisQuat() {
  return new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(...CAD_BASIS));
}
/** vektor frame CAD (mm) -> frame studio (mm). */
export function cadToStudio(v) { return v.clone().applyQuaternion(basisQuat()); }

/** sudut bertanda dari vektor a ke b, diukur mengelilingi sumbu ax. */
export function signedAngle(a, b, ax) {
  const n = ax.clone().normalize();
  const pa = a.clone().projectOnPlane(n);
  const pb = b.clone().projectOnPlane(n);
  if (pa.lengthSq() < 1e-9 || pb.lengthSq() < 1e-9) return 0;
  pa.normalize(); pb.normalize();
  const ang = Math.acos(clamp1(pa.dot(pb)));
  return new THREE.Vector3().crossVectors(pa, pb).dot(n) < 0 ? -ang : ang;
}

/** offset home: bawa lengan tegak dan pergelangan sejajar konvensi studio. */
export function computeHomeOffsets(P, A) {
  const up = new THREE.Vector3(0, 0, 1);   // "atas" di frame CAD
  const upper = P[2].clone().sub(P[1]);    // J2 -> J3
  const fore = P[3].clone().sub(P[2]);     // J3 -> pusat pergelangan
  return [
    0,                                  // J1 yaw: pose rakitan dianggap nol
    signedAngle(upper, up, A[1]),       // J2: lengan atas jadi tegak
    signedAngle(fore, upper, A[2]),     // J3: lengan bawah sejajar lengan atas
    signedAngle(A[4], A[1], A[3]),      // J4 roll: sumbu pitch wrist sejajar J2
    signedAngle(A[5], fore, A[4]),      // J5: sumbu gripper sejajar lengan bawah
    0,                                  // J6 roll: pose rakitan dianggap nol
  ];
}

/** TCP di frame CAD: pusat pergelangan + CAD_TCP_J6 diputar ke frame J6. */
export function cadTcpPoint(P, A) {
  const zc = A[5].clone().normalize();               // sumbu J6
  const xc = A[4].clone().normalize();               // sumbu J5
  const yc = new THREE.Vector3().crossVectors(zc, xc).normalize();
  return P[5].clone()
    .addScaledVector(xc, CAD_TCP_J6[0])
    .addScaledVector(yc, CAD_TCP_J6[1])
    .addScaledVector(zc, CAD_TCP_J6[2]);
}

/** nama part -> kunci pencocokan: samakan pemisah kata dan buang sufiks
    duplikat `_1` yang ditambahkan GLTFLoader untuk nama yang berulang. */
export const nameKey = (s) => String(s || '')
  .replace(/[^A-Za-z0-9]+/g, '_').replace(/_\d+$/, '').replace(/^_|_$/g, '').toLowerCase();

/** cocokkan mesh ke link lewat nama + pusat bbox (mm, koordinat file CAD).
    Kandidat dibatasi ke part bernama sama dulu, baru dipilih yang terdekat;
    kalau namanya tidak dikenal, jatuh ke tetangga terdekat apa pun sambil
    mencatat peringatan. */
export function linkOf(c, name, warn) {
  const key = nameKey(name);
  let best = 0, bestD = Infinity, named = false;
  for (const [n, x, y, z, L] of SEMUA_PARTS) {
    const same = nameKey(n) === key;
    if (named && !same) continue;
    const d = Math.hypot(c.x - x, c.y - y, c.z - z);
    if (same && !named) { named = true; best = L; bestD = d; continue; }
    if (d < bestD) { bestD = d; best = L; }
  }
  if (warn && (!named || bestD > MATCH_TOL)) {
    warn.push(`${name} @ ${c.x.toFixed(1)},${c.y.toFixed(1)},${c.z.toFixed(1)}`
      + ` -> L${best} (${named ? 'jarak' : 'nama tak dikenal, jarak'} ${bestD.toFixed(1)} mm)`);
  }
  return best;
}

/* ============================================================================
   Rantai kinematik. Dibangun TANPA GLB supaya studio tetap jalan (skeleton +
   jog + IK + timeline) di mesin yang belum punya main-assembly.glb; mesh CAD
   ditempelkan menyusul lewat attachParts().
   ========================================================================== */

/**
 * Bangun rantai sendi dalam mm studio.
 * @returns {{root, chain, pivots, links, partHosts, homeOff, P, A, tcpLocal, tcpQuat, geo}}
 *   root      grup terluar, sudah diturunkan supaya alas base duduk di y = 0
 *   pivots    6 grup sendi J1..J6 (userData.axis = sumbu di frame studio)
 *   links     7 grup link L0..L6, frame-nya sejajar dunia saat pose home
 *   partHosts 7 grup anak links[i] yang membawa rotasi basis + skala 1000,
 *             tempat part GLB (meter, frame CAD) ditempelkan apa adanya
 */
export function buildChain() {
  const Pc = CAD_JOINTS.map(j => vec(j.p));                 // titik sumbu, frame CAD
  const Ac = CAD_JOINTS.map(j => vec(j.a).normalize());     // arah sumbu, frame CAD
  const homeOff = computeHomeOffsets(Pc, Ac);
  const tcpCad = cadTcpPoint(Pc, Ac);

  const P = Pc.map(cadToStudio);                            // titik sumbu, frame studio
  const A = Ac.map(v => cadToStudio(v).normalize());        // arah sumbu, frame studio
  const tcp = cadToStudio(tcpCad);

  const qb = basisQuat();
  const root = new THREE.Group(); root.name = 'cadModel';
  const chain = new THREE.Group(); chain.name = 'cadChain';
  // sumbu J1 ke titik asal (horizontal saja; tinggi diatur lewat ground drop)
  chain.position.set(-P[0].x, 0, -P[0].z);
  root.add(chain);
  // alas rakitan (z = CAD_GROUND_Z di frame CAD) duduk tepat di y = 0
  root.position.y = -CAD_GROUND_Z;

  const links = [], partHosts = [], pivots = [];
  const mkLink = (i, parent, cancel) => {
    const lk = new THREE.Group(); lk.name = `cadL${i}`;
    if (cancel) lk.position.copy(cancel).negate();
    parent.add(lk);
    const host = new THREE.Group(); host.name = `cadParts${i}`;
    host.quaternion.copy(qb); host.scale.setScalar(CAD_SCALE);
    lk.add(host);
    links.push(lk); partHosts.push(host);
    return lk;
  };

  mkLink(0, chain, null);
  let parent = chain;
  for (let i = 0; i < 6; i++) {
    const pv = new THREE.Group();
    pv.name = `cadPivot${CAD_JOINTS[i].id}`;
    pv.position.copy(P[i]).sub(i === 0 ? new THREE.Vector3() : P[i - 1]);
    pv.userData.axis = A[i];
    parent.add(pv);
    mkLink(i + 1, pv, P[i]);
    pivots.push(pv);
    parent = pv;
  }

  // frame tool: z' sumbu J6, x' sumbu J5, y' = z' x x' (sama seperti CAD_TCP_J6)
  const zt = A[5].clone().normalize(), xt = A[4].clone().normalize();
  const yt = new THREE.Vector3().crossVectors(zt, xt).normalize();
  const tcpQuat = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(xt, yt, zt));

  return {
    root, chain, pivots, links, partHosts, homeOff, P, A,
    tcpLocal: tcp, tcpQuat, geo: deriveGeometry(Pc, Ac, tcpCad),
  };
}

/** Ukuran turunan (mm) yang dipakai label dimensi, HUD, dan dokumentasi.
    Semua dihitung dari sumbu terukur, bukan konstanta yang diketik ulang. */
export function deriveGeometry(Pc, Ac, tcpCad) {
  Pc = Pc || CAD_JOINTS.map(j => vec(j.p));
  Ac = Ac || CAD_JOINTS.map(j => vec(j.a).normalize());
  tcpCad = tcpCad || cadTcpPoint(Pc, Ac);
  // a1 = jarak tegak lurus antara garis sumbu J1 dan J2
  const n12 = new THREE.Vector3().crossVectors(Ac[0], Ac[1]).normalize();
  const a1 = Math.abs(Pc[1].clone().sub(Pc[0]).dot(n12));
  const a2 = Pc[2].distanceTo(Pc[1]);
  const d4 = Pc[3].distanceTo(Pc[2]);
  const d6 = tcpCad.distanceTo(Pc[5]);
  // offset lateral sepanjang sumbu pitch (penyebab d3 di tabel DH)
  const lateral = Pc[1].clone().sub(Pc[0]).dot(Ac[1]);
  return {
    a1, a2, d4, d6, lateral,
    reachFromJ2: a2 + d4 + d6,          // lengan lurus penuh, batas atas
    homeHeight: tcpCad.z - CAD_GROUND_Z, // tinggi TCP di pose rakitan tegak
  };
}

/** Tempelkan part GLB ke link masing-masing. Pipeline optimasi meratakan
    hirarki jadi satu node per part di akar scene, jadi children = daftar part.
    Dipanggil setelah buildChain(); aman dipanggil sekali saja. */
export function attachParts(gltfScene, partHosts) {
  const parts = [...gltfScene.children];
  const box = new THREE.Box3(), ctr = new THREE.Vector3(), warn = [];
  const perLink = [0, 0, 0, 0, 0, 0, 0];
  for (const part of parts) {
    box.setFromObject(part).getCenter(ctr);
    const L = linkOf(ctr.multiplyScalar(CAD_SCALE), part.name, warn);
    perLink[L]++;
    part.userData.homePos = part.position.clone();
    partHosts[L].add(part);
  }
  return { warn, partCount: parts.length, perLink };
}

/** salurkan sudut sendi (derajat) ke pivot. */
export function poseRig(pivots, homeOff, anglesDeg) {
  const d2r = Math.PI / 180;
  for (let i = 0; i < pivots.length; i++) {
    pivots[i].quaternion.setFromAxisAngle(pivots[i].userData.axis, anglesDeg[i] * d2r + homeOff[i]);
  }
}
