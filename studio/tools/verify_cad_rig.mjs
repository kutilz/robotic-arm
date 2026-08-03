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
checkDir('J2 pitch = +X', wax(1), [1, 0, 0]);
checkDir('J3 pitch = +X', wax(2), [1, 0, 0]);
checkDir('J4 roll  = +Y', wax(3), [0, 1, 0]);
checkDir('J5 pitch = +X', wax(4), [1, 0, 0], 0.02);
checkDir('J6 roll  = +Y', wax(5), [0, 1, 0], 0.02);

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

setPose([0, 90, 0, 0, 0, 0]);
checkDir('J2 +90 membuat lengan atas mendatar ke +Z', wp(2).clone().sub(wp(1)), [0, 0, 1]);

setPose([0, 0, 90, 0, 0, 0]);
checkDir('J3 +90 menekuk siku ke +Z', wp(3).clone().sub(wp(2)), [0, 0, 1]);

setPose([0, 0, 0, 90, 0, 0]);
w = wp(3);
check('J4 +90 memutar gripper, pusat pergelangan diam',
  w.distanceTo(homeWrist) < 0.01 && partPos(6, 'MG90S').distanceTo(homeServo) > 20,
  `geser MG90S ${partPos(6, 'MG90S').distanceTo(homeServo).toFixed(1)} mm`);
// rotasi +90 deg terhadap +Y memetakan +X ke -Z (kaidah tangan kanan)
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
// Preset dan demo dulu disusun untuk rantai lama yang 85 mm lebih pendek di
// pergelangan dan 200 mm lebih tinggi di base, jadi banyak yang jatuh menembus
// meja. Di sini tiap pose dicek: TCP tetap di atas grid, tidak melewati limit
// sendi, dan masih di dalam jangkauan.
const CLEAR = 25;   // mm, jarak aman minimum TCP ke grid
function auditPoses(title, list, names) {
  let bad = 0;
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    setPose(a);
    const t = tcp();
    const overLimit = a.some((v, k) => v < STATE.joints[k].min || v > STATE.joints[k].max);
    const low = t.y < CLEAR;
    const far = t.distanceTo(wp(1)) > geo.reachFromJ2 + 1;
    if (overLimit || low || far) bad++;
    console.log(`     ${String(names ? names[i] : '#' + i).padEnd(12)} TCP ${f3(t)}`
      + `${low ? (t.y < 0 ? '  MENEMBUS MEJA' : '  TERLALU DEKAT MEJA') : ''}`
      + `${overLimit ? '  DI LUAR LIMIT' : ''}${far ? '  DI LUAR JANGKAUAN' : ''}`);
  }
  check(`${title}: semua pose aman`, bad === 0, `${list.length - bad}/${list.length} oke`);
  setPose(HOME);
}

console.log('\n== preset pose ==');
auditPoses('preset', POSE_PRESETS.map((p) => p.angles), POSE_PRESETS.map((p) => p.name));

for (const [key, list] of Object.entries(DEMO_POSES)) {
  console.log(`\n== demo: ${key} ==`);
  auditPoses(`demo ${key}`, list);
}

console.log('\n== seed lingkaran IK ==');
setPose(CIRCLE_SEED);
const cSeed = tcp();
// lingkaran radius 60 mm di bidang Z-Y; titik terendah = pusat - 60
check('lingkaran radius 60 mm tidak menyentuh meja', cSeed.y - 60 > CLEAR,
  `pusat y ${cSeed.y.toFixed(0)} mm -> terendah ${(cSeed.y - 60).toFixed(0)} mm`);
setPose(HOME);

console.log('\n== offset home yang dihitung (derajat) ==');
console.log('   ' + homeOff.map((v, i) => `${CAD_JOINTS[i].id} ${(v * 180 / Math.PI).toFixed(2)}`).join('   '));
console.log(`\n${fail ? `${fail} PEMERIKSAAN GAGAL` : 'semua pemeriksaan lulus'}\n`);
process.exit(fail ? 1 : 0);
