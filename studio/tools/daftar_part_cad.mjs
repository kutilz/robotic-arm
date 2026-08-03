#!/usr/bin/env node
/* ============================================================================
   daftar_part_cad.mjs - daftar isi sebuah GLB CAD: nama part + pusat kotak
   batas dalam mm koordinat file CAD, format yang sama persis dengan baris
   CAD_PARTS di src/model/cadRig.js.

   Kenapa ada: CAD_PARTS dulu disusun lewat analisis bbox sekali jalan dan
   tidak ada skrip yang bisa membangkitkannya ulang. Begitu rakitan diekspor
   ulang dari Onshape, atau begitu optimize_cad_glb.mjs dijalankan dengan
   --keep, daftar part berubah dan barisnya harus disusun ulang dengan tangan.
   Skrip ini mencetak barisnya siap tempel dan menandai part mana yang belum
   dikenal cadRig.js.

   Kolom `link` ditebak dari sendi terdekat, jadi WAJIB diperiksa manusia
   sebelum ditempel; part yang terkurung sering lebih dekat ke sendi tetangga.

   Pemakaian:
     node studio/tools/daftar_part_cad.mjs
     node studio/tools/daftar_part_cad.mjs public/main-assembly-cyc.glb
     node studio/tools/daftar_part_cad.mjs public/main-assembly-cyc.glb --baru
   ========================================================================== */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { CAD_PARTS, CAD_JOINTS, CAD_SCALE, nameKey } from '../src/model/cadRig.js';

const STUDIO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const hanyaBaru = args.includes('--baru');
const rel = args.find((a) => !a.startsWith('--')) || 'public/main-assembly.glb';
const GLB = resolve(STUDIO, rel);

await MeshoptDecoder.ready;
const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
const buf = readFileSync(GLB);
const gltf = await new Promise((res, rej) => loader.parse(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', res, rej));

/* Kunci nama yang sudah dikenal cadRig.js, supaya part tambahan gampang
   dipisahkan dari yang sudah terdaftar. */
const dikenal = new Set(CAD_PARTS.map(([n]) => nameKey(n)));

const box = new THREE.Box3(), ctr = new THREE.Vector3();
const baris = [];
for (const part of gltf.scene.children) {
  box.setFromObject(part).getCenter(ctr);
  const c = ctr.multiplyScalar(CAD_SCALE);          // meter -> mm frame CAD
  // tebak link dari sendi terdekat; sendi i mengendalikan link i+1
  let link = 0, jarak = Infinity;
  CAD_JOINTS.forEach((j, i) => {
    const d = Math.hypot(c.x - j.p[0], c.y - j.p[1], c.z - j.p[2]);
    if (d < jarak) { jarak = d; link = i + 1; }
  });
  baris.push({
    nama: part.name, x: c.x, y: c.y, z: c.z, link,
    baru: !dikenal.has(nameKey(part.name)),
  });
}

baris.sort((a, b) => (a.link - b.link) || a.nama.localeCompare(b.nama));
const dipakai = hanyaBaru ? baris.filter((b) => b.baru) : baris;

console.log(`GLB   : ${GLB}`);
console.log(`isi   : ${baris.length} part, ${baris.filter((b) => b.baru).length} belum ada di CAD_PARTS`);
console.log('');
console.log('// [nama, x, y, z, link] mm frame CAD. Kolom link cuma tebakan sendi');
console.log('// terdekat, PERIKSA MANUAL sebelum ditempel ke cadRig.js.');
for (const b of dipakai) {
  const tanda = b.baru ? '   // BARU' : '';
  console.log(`  ['${b.nama.replace(/'/g, "\\'")}', `
    + `${b.x.toFixed(1)}, ${b.y.toFixed(1)}, ${b.z.toFixed(1)}, ${b.link}],${tanda}`);
}
