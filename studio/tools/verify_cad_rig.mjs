#!/usr/bin/env node
/* ============================================================================
   verify_cad_rig.mjs - verifikasi rig CAD digital twin TANPA WebGL.

   Memuat studio/public/main-assembly.glb dengan GLTFLoader + MeshoptDecoder di
   Node, membangun rantai sendi lewat src/model/cadRig.js, lalu memeriksa
   angkanya: jumlah part per link, pencocokan nama, alas duduk di y=0, arah
   link saat home, panjang link, posisi TCP, arah gerak tiap sendi, penempatan
   lumped mass, dan keterjangkauan tiap preset pose.

   cadRig.js sengaja tidak menyentuh viewport/WebGL supaya file ini bisa
   memakainya langsung; rig.js (overlay + marker massa) tidak bisa diimpor di
   sini, jadi penempatan massa diperiksa secara numerik dari MASSES.

   Karena tidak ada renderer sama sekali, ini jauh lebih murah daripada
   screenshot Chrome headless yang harus merasterisasi ratusan ribu segitiga
   di CPU.

   Pemakaian:  node studio/tools/verify_cad_rig.mjs
   ========================================================================== */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import {
  buildChain, attachParts, poseRig, nameKey, CAD_JOINTS, CAD_PART_N,
} from '../src/model/cadRig.js';
import { MASSES, POSE_PRESETS, DEMO_POSES, CIRCLE_SEED, STATE } from '../src/config/arm.js';
import { staticRoutines, posesOf, ROUTINES } from '../src/config/routines.js';

const STUDIO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GLB = resolve(STUDIO, 'public/main-assembly.glb');

let fail = 0;
const f3 = (v) => `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`;

function check(label, ok, detail) {
  console.log(`  ${ok ? 'OK  ' : 'GAGAL'} ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) fail++;
}
/** cek vektor mendekati target (arah unit). */
function checkDir(label, v, target, tol = 0.01) {
  const t = new THREE.Vector3(...target);
  const d = v.clone().normalize();
  check(label, d.distanceTo(t) < tol, `${f3(d)} vs (${target.join(', ')})`);
}
function checkNum(label, got, want, tol, unit = 'mm') {
  check(label, Math.abs(got - want) <= tol, `${got.toFixed(2)} vs ${want} ${unit} (tol ${tol})`);
}

const buf = readFileSync(GLB);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

await MeshoptDecoder.ready;
const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
const gltf = await new Promise((res, rej) => loader.parse(ab, '', res, rej));

console.log(`\nGLB   : ${GLB} (${(buf.length / 1e6).toFixed(2)} MB)`);

let tri = 0, meshes = 0;
gltf.scene.traverse((o) => {
  if (!o.isMesh) return;
  meshes++;
  const g = o.geometry;
  tri += (g.index ? g.index.count : g.attributes.position.count) / 3;
});
console.log(`isi   : ${gltf.scene.children.length} part, ${meshes} mesh, ${tri.toLocaleString('id-ID')} segitiga\n`);

/* ---------------- bangun rig ---------------- */
const rig = buildChain();
const { pivots, links, partHosts, homeOff, geo } = rig;
const { warn, partCount, perLink } = attachParts(gltf.scene, partHosts);

// node TCP, sama seperti yang dipasang rig.js di link 6
const tcpNode = new THREE.Group();
tcpNode.position.copy(rig.tcpLocal);
tcpNode.quaternion.copy(rig.tcpQuat);
links[6].add(tcpNode);

console.log('== struktur ==');
check(`jumlah part = ${CAD_PART_N}`, partCount === CAD_PART_N, `dapat ${partCount}`);
check('semua part cocok nama + posisi', warn.length === 0, warn.length ? `\n     ${warn.join('\n     ')}` : '');
const want = [9, 11, 12, 8, 6, 2, 12];
check('sebaran part per link', perLink.every((n, i) => n === want[i]),
  `L0..L6 = ${perLink.join(' ')} (harap ${want.join(' ')})`);

/* ---------------- pose home ---------------- */
console.log('\n== pose home (semua sendi 0) ==');
const setPose = (a) => { poseRig(pivots, homeOff, a); rig.root.updateMatrixWorld(true); };
const HOME = [0, 0, 0, 0, 0, 0];
setPose(HOME);

const wp = (i) => pivots[i].getWorldPosition(new THREE.Vector3());
const wax = (i) => pivots[i].userData.axis.clone()
  .applyQuaternion(pivots[i].getWorldQuaternion(new THREE.Quaternion())).normalize();
const linkBox = (i) => new THREE.Box3().setFromObject(links[i]);
/** rata-rata pusat bbox dunia semua part di link li yang namanya cocok. */
function partPos(li, name) {
  const key = nameKey(name);
  const hits = partHosts[li].children.filter((o) => nameKey(o.name) === key);
  if (!hits.length) throw new Error(`part "${name}" tidak ada di L${li}`);
  const c = new THREE.Vector3();
  for (const p of hits) c.add(new THREE.Box3().setFromObject(p).getCenter(new THREE.Vector3()));
  return c.divideScalar(hits.length);
}
/* TCP = titik tengah UJUNG wedge jaw saat tertutup (docs/bom-main-assembly.md
   bagian 5), bukan pusat bbox part jaw. Dihitung cadRig dari frame J6. */
const tcp = () => tcpNode.getWorldPosition(new THREE.Vector3());
/** jarak antara dua garis sumbu sendi (jarak terpendek garis bersilangan). */
function axisDist(i, j) {
  const n = new THREE.Vector3().crossVectors(wax(i), wax(j));
  const d = wp(j).clone().sub(wp(i));
  return n.lengthSq() < 1e-9 ? d.clone().projectOnPlane(wax(i)).length() : Math.abs(d.dot(n.normalize()));
}

const base = linkBox(0);
checkNum('alas base duduk di grid', base.min.y, 0, 0.01);

const P = [0, 1, 2, 3, 4, 5].map(wp);
checkDir('arah lengan atas J2 -> J3 tegak', P[2].clone().sub(P[1]), [0, 1, 0]);
checkDir('arah lengan bawah J3 -> pergelangan tegak', P[3].clone().sub(P[2]), [0, 1, 0]);
checkNum('sumbu J1 di titik asal (x)', P[0].x, 0, 0.01);
checkNum('sumbu J1 di titik asal (z)', P[0].z, 0, 0.01);

console.log('\n== sumbu sendi di ruang studio (home) ==');
checkDir('J1 yaw  = +Y', wax(0), [0, 1, 0]);
/* J2 dan J3 = -X, bukan +X: dir keduanya -1 (lihat TWIN_CAL_DEFAULT). Sumbu
   CAD-nya sendiri tetap +X; yang bertanda di sini sumbu ROTASI pivot. */
checkDir('J2 pitch = -X (dir -1)', wax(1), [-1, 0, 0]);
checkDir('J3 pitch = -X (dir -1)', wax(2), [-1, 0, 0]);
checkDir('J4 roll  = +Y', wax(3), [0, 1, 0]);
checkDir('J5 pitch = +X', wax(4), [1, 0, 0], 0.02);
/* J6 = -Y, bukan +Y: TWIN_CAL_DEFAULT.dir[5] = -1 membalik arah putaran
   positifnya supaya twin berputar searah dengan servo di lengan terakit. Yang
   dicek di sini sumbu ROTASI pivot (sudah bertanda), sedangkan frame tool tetap
   memakai sumbu J6 asli. */
checkDir('J6 roll  = -Y (dir -1)', wax(5), [0, -1, 0], 0.02);

console.log('\n== panjang link (mm) ==');
checkNum('a1  jarak tegak lurus sumbu J1 -> J2', axisDist(0, 1), 65.85, 0.05);
checkNum('a2  J2 -> J3', P[2].distanceTo(P[1]), 288.0, 0.05);
checkNum('d4  J3 -> pusat pergelangan', P[3].distanceTo(P[2]), 269.76, 0.05);
checkNum('d6  pusat pergelangan -> TCP', tcp().distanceTo(P[3]), 174.94, 0.05);
// 815,69 mm di file CAD adalah tinggi pose SIMPAN; di pose home pergelangan
// diluruskan (J5 -3,04 deg) sehingga ujung jaw turun 0,7 mm.
const full = new THREE.Box3().setFromObject(rig.root);
checkNum('tinggi total tegak (pose home)', full.max.y - full.min.y, 815.0, 0.5);
// TCP harus jatuh di dalam bbox ujung jaw, bukan melayang di luar rakitan
const jaw = new THREE.Box3().setFromObject(partHosts[6].children
  .find((o) => nameKey(o.name) === nameKey('Wedge Jaw 1')));
check('TCP berada di rentang ujung jaw', tcp().y > jaw.max.y - 25 && tcp().y < jaw.max.y + 2,
  `TCP y ${tcp().y.toFixed(1)}, jaw y ${jaw.min.y.toFixed(1)}..${jaw.max.y.toFixed(1)}`);

console.log('\n== ukuran turunan yang dipakai UI (world.geo) ==');
checkNum('geo.a1', geo.a1, 65.85, 0.05);
checkNum('geo.a2', geo.a2, 288.0, 0.05);
checkNum('geo.d4', geo.d4, 269.76, 0.05);
checkNum('geo.d6', geo.d6, 174.94, 0.05);
checkNum('geo.reachFromJ2 (lengan lurus)', geo.reachFromJ2, 732.7, 0.5);
// cek silang: reach turunan harus cocok dengan jarak TCP nyata saat lengan lurus
setPose([0, 90, 0, 0, 0, 0]);
checkNum('reach terukur di pose lurus', tcp().distanceTo(wp(1)), 732.2, 1.0);
setPose(HOME);

console.log('\n== pergelangan spherical ==');
check('J4, J5, J6 satu titik', P[3].distanceTo(P[4]) < 0.01 && P[3].distanceTo(P[5]) < 0.01,
  `J4-J5 ${P[3].distanceTo(P[4]).toFixed(3)} mm, J4-J6 ${P[3].distanceTo(P[5]).toFixed(3)} mm`);

/* ---------------- arah gerak tiap sendi ---------------- */
console.log('\n== arah gerak (tiap sendi +90 deg dari home) ==');
// acuan pose home; MG90S dipakai karena jelas di luar sumbu J4/J6 sehingga
// gerakannya terlihat saat kedua roll itu diputar.
const homeWrist = P[3].clone(), homeTcp = tcp(), homeServo = partPos(6, 'MG90S');

setPose([90, 0, 0, 0, 0, 0]);
let w = wp(3);
check('J1 +90 memutar pergelangan mengelilingi +Y',
  Math.abs(w.y - homeWrist.y) < 0.5 && w.distanceTo(homeWrist) > 1,
  `pergelangan ${f3(homeWrist)} -> ${f3(w)}`);

/* J2 dan J3 mendatar ke -Z, bukan +Z: dir keduanya -1 sejak 12 Agu 2026 (uji
   per sendi di lengan terakit).

   -Z adalah arah DEPAN, yaitu ke meja. Jadi dua baris di bawah sekaligus
   menetapkan konvensi seluruh repo: pose kerja yang menjulur ke depan bersudut
   J2/J3 POSITIF. Catatan lama di sini menyimpulkan kebalikannya dan preset,
   demo, serta rutin sempat dibalik tandanya mengikuti kesimpulan itu; semuanya
   berakhir di belakang lengan sampai dibetulkan 13 Agu 2026. */
setPose([0, 90, 0, 0, 0, 0]);
checkDir('J2 +90 membuat lengan atas mendatar ke -Z', wp(2).clone().sub(wp(1)), [0, 0, -1]);

setPose([0, 0, 90, 0, 0, 0]);
checkDir('J3 +90 menekuk siku ke -Z', wp(3).clone().sub(wp(2)), [0, 0, -1]);

setPose([0, 0, 0, 90, 0, 0]);
w = wp(3);
check('J4 +90 memutar gripper, pusat pergelangan diam',
  w.distanceTo(homeWrist) < 0.01 && partPos(6, 'MG90S').distanceTo(homeServo) > 20,
  `geser MG90S ${partPos(6, 'MG90S').distanceTo(homeServo).toFixed(1)} mm`);
// rotasi +90 deg terhadap +Y memetakan +X ke -Z (kaidah tangan kanan), dan
// sumbu rotasi J5 di home memang +X.
checkDir('J4 +90 memutar sumbu J5 ke -Z', wax(4), [0, 0, -1], 0.02);

setPose([0, 0, 0, 0, 90, 0]);
check('J5 +90 mengayun gripper ke depan',
  wp(3).distanceTo(homeWrist) < 0.01 && Math.abs(tcp().y - homeTcp.y) > 100,
  `TCP ${f3(homeTcp)} -> ${f3(tcp())}`);

setPose([0, 0, 0, 0, 0, 90]);
check('J6 +90 memutar gripper pada sumbunya',
  wp(3).distanceTo(homeWrist) < 0.01 && partPos(6, 'MG90S').distanceTo(homeServo) > 20,
  `geser MG90S ${partPos(6, 'MG90S').distanceTo(homeServo).toFixed(1)} mm`);

setPose([0, 0, 0, 0, 90, 90]);
check('J5 + J6 tersusun benar', wp(3).distanceTo(homeWrist) < 0.01,
  `pusat pergelangan tetap ${f3(wp(3))}`);

/* ---------------- lumped mass ---------------- */
// MASSES ditempel rig.js di links[joint+1] pada P[joint] + (0, along, 0). Di
// sini penempatannya diperiksa numerik: tiap lump harus jatuh di dalam bbox
// rakitan (dengan toleransi), bukan melayang di luar lengan seperti lump wrist
// lama yang ada di `along` 294 dari J4 (24 mm melewati ujung lengan bawah).
console.log('\n== penempatan lumped mass ==');
setPose(HOME);
const asmBox = new THREE.Box3().setFromObject(rig.root).expandByScalar(30);
const massPos = (mm) => (mm.at === 'tcp'
  ? tcp()
  : links[mm.joint + 1].localToWorld(P[mm.joint].clone().add(new THREE.Vector3(0, mm.along, 0))));
let massBad = 0;
for (const mm of MASSES) {
  const p = massPos(mm);
  if (!asmBox.containsPoint(p)) { massBad++; console.log(`     di luar rakitan: ${mm.label} -> ${f3(p)}`); }
}
check('semua lumped mass di dalam rakitan', massBad === 0, `${MASSES.length - massBad}/${MASSES.length} oke`);
const payload = MASSES.find((m) => m.label === 'payload');
check('payload ditempel di node TCP', payload.at === 'tcp',
  'offset lateral tool 15,7 mm tidak boleh diwakili `along` di sumbu +Y saja');

/* ---------------- preset & trajektori demo ---------------- */
/* Tiap pose dicek: tidak ada PART yang menembus meja, sudut di dalam limit
   sendi, TCP masih di dalam jangkauan, dan J1 di dalam sektor kerja.

   Dulu yang dijaga cuma tinggi TCP (minimal 25 mm). Itu penjaga yang salah
   sasaran untuk lengan ini: rutin ambil MEMANG harus membawa ujung jaw sampai
   15 mm di atas meja, sedangkan yang benar benar berbahaya justru part yang
   BUKAN TCP. Contohnya pada sumbu tool mendatar, ujung jaw masih 15 mm di atas
   meja tetapi servo MG996R di pergelangan sudah 26 mm DI BAWAH permukaan meja.
   Jadi yang diukur sekarang titik terendah seluruh link bergerak, dari bbox
   mesh CAD-nya langsung. */
const PART_CLEAR = 5;   // mm, sisa minimum part terendah ke permukaan meja
/* L2 (housing bahu) dilewati: dia duduk permanen ~35 mm di atas meja tepat di
   kaki lengan dan tidak bisa menabrak apa pun di bidang kerja, tapi kalau ikut
   dihitung dia SELALU jadi yang terendah dan menutupi part yang betulan
   bergerak di atas meja. */
const MOVING_LINKS = [3, 4, 5, 6];
/** titik terendah semua part link bergerak pada pose yang sedang di-set. */
function lowestPart() {
  let y = Infinity, name = '';
  const b = new THREE.Box3();
  for (const li of MOVING_LINKS) {
    for (const part of partHosts[li].children) {
      b.setFromObject(part);
      if (b.min.y < y) { y = b.min.y; name = part.name; }
    }
  }
  return { y, name };
}

/* Sektor kerja di meja ini (13 Agu 2026): J1 cuma boleh 0 sampai -90, yaitu
   dari lurus ke depan (kertas milimeter) sampai 90 derajat ke kanan. Batas ini
   BUKAN limit mekanis - JDEF dan firmware dua-duanya masih mengizinkan +-180 -
   jadi tidak ada yang menjaganya selain pemeriksaan ini. */
const J1_MIN = -90, J1_MAX = 0, J1_TOL = 0.5;

function auditPoses(title, list, names) {
  let bad = 0;
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    setPose(a);
    const t = tcp();
    const lp = lowestPart();
    const overLimit = a.some((v, k) => v < STATE.joints[k].min || v > STATE.joints[k].max);
    const low = lp.y < PART_CLEAR;
    const far = t.distanceTo(wp(1)) > geo.reachFromJ2 + 1;
    const outSector = a[0] < J1_MIN - J1_TOL || a[0] > J1_MAX + J1_TOL;
    if (overLimit || low || far || outSector) bad++;
    console.log(`     ${String(names ? names[i] : '#' + i).padEnd(22)} TCP ${f3(t)}`
      + `  terendah ${lp.y.toFixed(0).padStart(4)} mm (${lp.name})`
      + `${low ? (lp.y < 0 ? '  MENEMBUS MEJA' : '  TERLALU DEKAT MEJA') : ''}`
      + `${overLimit ? '  DI LUAR LIMIT' : ''}${far ? '  DI LUAR JANGKAUAN' : ''}`
      + `${outSector ? `  J1 ${a[0]} DI LUAR SEKTOR ${J1_MIN}..${J1_MAX}` : ''}`);
  }
  check(`${title}: semua pose aman`, bad === 0, `${list.length - bad}/${list.length} oke`);
  setPose(HOME);
}

/* ---------------------------------------------------------------------------
   SERVO MENDAHULUI STEPPER.

   Satu goto tidak dieksekusi sebagai satu gerakan. J5/J6 servo MG996R ditulis
   ke target seketika oleh loop firmware (~0,2 s per 60 deg), sedangkan stepper
   J1..J4 jalan pada profil kecepatan (8 dps saat TEACH, 25 dps saat RUN), yaitu
   20 sampai 60 kali lebih lambat, dan masing masing dengan waktu tempuhnya
   sendiri karena tidak ada koordinasi antar sendi di firmware. Akibatnya pose
   antara yang benar benar dilewati lengan adalah "pergelangan sudah menekuk
   penuh, lengan masih di tempat lama". Kalau tempat lama itu dekat meja,
   gripper menghantam meja sebelum lengan sempat bergerak.

   Di sini jalur itu disusun ulang apa adanya: J5/J6 langsung di target sejak
   detik nol, tiap stepper berjalan sendiri sendiri pada dps yang sama, lalu
   dicari titik terendah seluruh rakitan sepanjang jalur.

   Yang dianggap gagal bukan sekadar "jalurnya lebih rendah dari ujungnya":
   turun 20 mm di ketinggian 200 mm tidak berbahaya. Yang gagal adalah jalur
   yang menembus lantai kerja (< PART_CLEAR), atau jalur yang melorot jauh di
   bawah kedua ujungnya SEKALIGUS berada di dekat meja - yaitu persis pola
   "servo menekuk duluan lalu menyapu meja".
   --------------------------------------------------------------------------- */
const DIP_TOL = 10;     // mm, seberapa dalam jalur boleh melorot di bawah ujungnya
const DIP_ZONE = 60;    // mm, melorot baru dihitung berbahaya di bawah ketinggian ini
const N_SERVO = [4, 5]; // J5, J6

function pathLowest(a, b, n = 60, dps = 25) {
  const dur = Math.max(...[0, 1, 2, 3].map(i => Math.abs(b[i] - a[i]) / dps));
  let worst = Infinity, at = 0, name = '';
  for (let s = 0; s <= n; s++) {
    const t = dur * s / n;
    const p = a.map((v, i) => {
      if (N_SERVO.includes(i)) return b[i];        // servo: sudah di target
      const d = b[i] - v, step = Math.sign(d) * dps * t;
      return Math.abs(step) >= Math.abs(d) ? b[i] : v + step;
    });
    setPose(p);
    const lp = lowestPart();
    if (lp.y < worst) { worst = lp.y; at = dur ? s / n : 0; name = lp.name; }
  }
  return { y: worst, at, name };
}

function auditTransitions(title, list, names) {
  let bad = 0;
  for (let i = 1; i < list.length; i++) {
    setPose(list[i - 1]); const la = lowestPart().y;
    setPose(list[i]);     const lb = lowestPart().y;
    const p = pathLowest(list[i - 1], list[i]);
    const floor = p.y < PART_CLEAR;
    const dip = p.y < Math.min(la, lb) - DIP_TOL && p.y < DIP_ZONE;
    if (floor || dip) {
      bad++;
      const nm = names ? `${names[i - 1]} -> ${names[i]}` : `#${i - 1} -> #${i}`;
      console.log(`     ${nm}: jalur turun ke ${p.y.toFixed(0)} mm @ ${(p.at * 100).toFixed(0)}%`
        + ` (${p.name}), ujung ${la.toFixed(0)} dan ${lb.toFixed(0)} mm`
        + `${floor ? '  MENABRAK MEJA' : '  MELOROT DI DEKAT MEJA'}`);
    }
  }
  check(`${title}: tiap perpindahan aman walau servo sampai duluan`, bad === 0,
    `${list.length - 1 - bad}/${list.length - 1} perpindahan oke`);
  setPose(HOME);
}

console.log('\n== preset pose ==');
auditPoses('preset', POSE_PRESETS.map((p) => p.angles), POSE_PRESETS.map((p) => p.name));

for (const [key, list] of Object.entries(DEMO_POSES)) {
  console.log(`\n== demo: ${key} ==`);
  auditPoses(`demo ${key}`, list);
}

/* Rutin hardware (config/routines.js). Ini yang benar-benar dikirim ke lengan,
   jadi audit yang sama berlaku dan tiap langkah dinamai supaya kalau ada yang
   gagal ketahuan langkah mana yang harus diperbaiki, bukan cuma nomornya. */
for (const [key, r] of staticRoutines()) {
  console.log(`\n== rutin: ${key} (${r.name}) ==`);
  const poseSteps = r.steps.filter(s => Array.isArray(s.a));
  const labels = poseSteps.map(s => s.label);
  auditPoses(`rutin ${key}`, posesOf(r), labels);
  /* Rutin `repeat` berputar: sesudah langkah terakhir dia kembali ke langkah
     loopFrom, jadi perpindahan penutup siklus itu ikut dilalui lengan dan ikut
     harus aman. Langkah gripper tidak menggeser sendi, jadi urutan pose saja
     yang relevan. */
  const seq = posesOf(r), seqLbl = labels.slice();
  if (r.cycles > 1) {
    const back = r.steps.slice(r.loopFrom || 0).filter(s => Array.isArray(s.a))[0];
    if (back) { seq.push(back.a); seqLbl.push('(balik ke awal siklus)'); }
  }
  auditTransitions(`rutin ${key}`, seq, seqLbl);
}

/* J6 mentok di lengan fisik (12 Agu 2026): sudut J6 di rutin ditahan kecil
   sampai pergelangan dibongkar. Batas ini dipertahankan di sini supaya tidak
   diam diam naik lagi saat pose disetel ulang nanti. */
const J6_MAX_ABS = 30;
{
  let worst = 0, where = '';
  for (const [key, r] of staticRoutines())
    for (const s of r.steps)
      if (Array.isArray(s.a) && Math.abs(s.a[5]) > worst) { worst = Math.abs(s.a[5]); where = `${key}/${s.label}`; }
  check(`J6 ditahan <= ${J6_MAX_ABS} deg (pergelangan mentok)`, worst <= J6_MAX_ABS,
    `maks ${worst} deg di ${where || '-'}`);
}

/* Langkah gripper wajib memakai aksi yang dikenal runner. Salah ketik di sini
   berarti langkah itu diam diam tidak melakukan apa apa saat rutin dijalankan. */
{
  const OK_GRIP = ['open', 'close'];
  let bad = [];
  for (const [key, r] of staticRoutines())
    for (const s of r.steps) {
      if (Array.isArray(s.a) === (s.grip !== undefined)) bad.push(`${key}/${s.label}: langkah harus punya a[] ATAU grip, tidak dua duanya`);
      if (s.grip !== undefined && !OK_GRIP.includes(s.grip)) bad.push(`${key}/${s.label}: grip "${s.grip}" tidak dikenal`);
    }
  check('bentuk tiap langkah rutin sah', bad.length === 0, bad.length ? `\n     ${bad.join('\n     ')}` : '');
}

/* Rutin dinamis (pose dihitung IK saat dipilih) tidak bisa diaudit di sini,
   tapi SEED-nya bisa: kalau seed sudah di luar limit, IK-nya mulai dari pose
   yang mustahil dan hasilnya tidak bisa dipercaya. */
{
  const dyn = Object.entries(ROUTINES).filter(([, r]) => r.dynamic);
  for (const [key, r] of dyn) {
    console.log(`\n== rutin dinamis: ${key} (${r.name}) ==`);
    auditPoses(`seed ${key}`, [r.line.seed], ['seed']);
  }
}

console.log('\n== seed lingkaran IK ==');
setPose(CIRCLE_SEED);
const cSeed = tcp();
// lingkaran radius 60 mm di bidang Z-Y; titik terendah = pusat - 60
// 25 mm: sisa TCP, bukan sisa part. Lingkaran ini murni peragaan 3D dan
// seluruh lintasannya ratusan mm di atas meja, jadi tidak perlu diaudit
// se-ketat pose rutin yang benar benar dikirim ke lengan.
check('lingkaran radius 60 mm tidak menyentuh meja', cSeed.y - 60 > 25,
  `pusat y ${cSeed.y.toFixed(0)} mm -> terendah ${(cSeed.y - 60).toFixed(0)} mm`);
setPose(HOME);

console.log('\n== offset home yang dihitung (derajat) ==');
console.log('   ' + homeOff.map((v, i) => `${CAD_JOINTS[i].id} ${(v * 180 / Math.PI).toFixed(2)}`).join('   '));
console.log(`\n${fail ? `${fail} PEMERIKSAAN GAGAL` : 'semua pemeriksaan lulus'}\n`);
process.exit(fail ? 1 : 0);
