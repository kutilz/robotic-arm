#!/usr/bin/env node
/* ============================================================================
   verify_preview_model.mjs - verifikasi tabel bentuk model blok sederhana
   (src/model/previewSpec.js) TANPA GLB dan TANPA WebGL.

   Model blok itu yang tampil kalau main-assembly.glb tidak ada, jadi ia harus
   tetap benar di mesin yang tidak punya GLB-nya sama sekali. Itulah kenapa
   pemeriksaannya dipisah dari verify_cad_rig.mjs, yang wajib memuat GLB.

   Yang diperiksa:
     1. tiap baris CAD_PARTS punya bentuk (tidak ada yang jatuh ke balok 30 mm)
     2. tidak ada baris PREVIEW_SPEC yang tidak terpakai (sisa salah ketik kunci)
     3. tiap spec bentuk/sumbu/material sah dan ukurannya positif
     4. bbox rakitan hasil blok mendekati bbox terukur di docs/bom-main-assembly.md
        (240 x 266 x 815,7 mm, z -10 sampai +805,7)

   Pemeriksaan 4 yang paling ampuh: salah sumbu silinder atau salah urutan
   dimensi balok langsung membesarkan bbox di sumbu yang salah.

   Pemakaian:  node studio/tools/verify_preview_model.mjs
   ========================================================================== */
import { CAD_PARTS, nameKey } from '../src/model/cadRig.js';
import { PREVIEW_SPEC, previewSpecFor, specHalfExtent } from '../src/model/previewSpec.js';

let fail = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? 'OK  ' : 'GAGAL'} ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) fail++;
}

/* ---------------- 1 + 2: cakupan tabel ---------------- */
console.log('\n== cakupan tabel bentuk ==');
const dipakai = new Set();
const tanpaBentuk = [];
for (const [name, , , , L] of CAD_PARTS) {
  const key = nameKey(name);
  if (previewSpecFor(key, L)) {
    dipakai.add(PREVIEW_SPEC[`${key}|${L}`] ? `${key}|${L}` : key);
  } else {
    tanpaBentuk.push(`${name} (L${L}) -> kunci '${key}|${L}'`);
  }
}
check(`${CAD_PARTS.length} part CAD_PARTS punya bentuk`, tanpaBentuk.length === 0,
  tanpaBentuk.length ? `\n     ${tanpaBentuk.join('\n     ')}` : '');

const nganggur = Object.keys(PREVIEW_SPEC).filter((k) => !dipakai.has(k));
check('tidak ada baris PREVIEW_SPEC yang nganggur', nganggur.length === 0,
  nganggur.length ? nganggur.join(', ') : '');

/* ---------------- 3: bentuk, sumbu, material, ukuran ---------------- */
console.log('\n== kesahihan tiap spec ==');
const MATERIAL = ['pla', 'pla2', 'housing', 'steel', 'motor', 'servo', 'magnet', 'belt', 'link'];
const salah = [];
for (const [k, s] of Object.entries(PREVIEW_SPEC)) {
  const bentukOk = s[0] === 'box' || s[0] === 'cyl';
  const sumbuOk = s[0] === 'box' || ['x', 'y', 'z'].includes(s[3]);
  const matOk = MATERIAL.includes(s[s.length - 1]);
  const angka = s[0] === 'cyl' ? [s[1], s[2]] : [s[1], s[2], s[3]];
  const ukuranOk = angka.every((v) => typeof v === 'number' && v > 0);
  if (!bentukOk || !sumbuOk || !matOk || !ukuranOk) salah.push(`${k} -> ${JSON.stringify(s)}`);
}
check(`${Object.keys(PREVIEW_SPEC).length} spec sah`, salah.length === 0,
  salah.length ? `\n     ${salah.join('\n     ')}` : '');

/* ---------------- 4: bbox rakitan ---------------- */
console.log('\n== bbox rakitan hasil blok (frame CAD, mm) ==');
const lo = [Infinity, Infinity, Infinity];
const hi = [-Infinity, -Infinity, -Infinity];
for (const [name, x, y, z, L] of CAD_PARTS) {
  const spec = previewSpecFor(nameKey(name), L);
  if (!spec) continue;
  const h = specHalfExtent(spec);
  const c = [x, y, z];
  for (let i = 0; i < 3; i++) {
    lo[i] = Math.min(lo[i], c[i] - h[i]);
    hi[i] = Math.max(hi[i], c[i] + h[i]);
  }
}
const size = hi.map((v, i) => v - lo[i]);
const f1 = (v) => v.toFixed(1);
console.log(`   x ${f1(lo[0])} .. ${f1(hi[0])}   y ${f1(lo[1])} .. ${f1(hi[1])}   z ${f1(lo[2])} .. ${f1(hi[2])}`);
console.log(`   ukuran ${size.map(f1).join(' x ')} mm`);

// BOM: 240 x 266 x 815,7 mm, z -10 sampai +805,7. Toleransi longgar (15%)
// karena model blok memang menyederhanakan part berongga jadi kotak penuh.
const TOL = 0.15;
const BOM_SIZE = [240, 266, 815.7];
['x', 'y', 'z'].forEach((ax, i) => {
  const beda = Math.abs(size[i] - BOM_SIZE[i]) / BOM_SIZE[i];
  check(`ukuran ${ax} mendekati BOM`, beda <= TOL,
    `${f1(size[i])} vs ${BOM_SIZE[i]} mm (beda ${(beda * 100).toFixed(1)}%)`);
});
check('ujung jaw dekat z 805,7', Math.abs(hi[2] - 805.7) <= 25, `${f1(hi[2])} mm`);

console.log(`\n${fail ? `${fail} PEMERIKSAAN GAGAL` : 'semua pemeriksaan lulus'}\n`);
process.exit(fail ? 1 : 0);
