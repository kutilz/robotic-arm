#!/usr/bin/env node
/* ============================================================================
   optimize_cad_glb.mjs - siapkan GLB export Onshape untuk studio digital twin.

   Export mentah Onshape memecah tiap face jadi primitive terpisah dan
   menyertakan TEXCOORD yang tidak dipakai (semua material warna solid tanpa
   tekstur). Untuk rev 2026-08-03 "Main Assembly (Complete)": 31,7 MB /
   548.704 tri / 94 part.

   Pipeline:
     drop-parts           - buang part yang tertutup rapat di dalam rakitan
     prune                - buang node kosong + atribut/aksesor tak terpakai
     weld                 - gabung vertex identik jadi indexed geometry
     join --keepNamed     - gabung primitive dalam satu part; nama part tetap
     meshopt              - kompresi EXT_meshopt_compression + kuantisasi

   Tahap drop-parts hanya membuang part yang TIDAK KELIHATAN dari luar (sudah
   dicek lewat bbox: tiap kandidat terkurung part lain di link yang sama).
   Segitiga part yang tersisa tidak didesimasi sama sekali.

   Pemakaian:
     node tools/optimize_cad_glb.mjs "onshape/Main Assembly (Complete).glb"
     node tools/optimize_cad_glb.mjs <input.glb> [output.glb] [--keep-all]
     node tools/optimize_cad_glb.mjs <input.glb> <output.glb> --keep "Nama,Nama"

   Default output: studio/public/main-assembly.glb (di-gitignore, dimuat
   src/model/cadModel.js). Butuh koneksi internet sekali untuk menarik
   @gltf-transform/cli lewat npx; tidak ditambahkan ke dependency studio.

   CATATAN: hasil meshopt WAJIB dibaca dengan GLTFLoader yang sudah dipasangi
   MeshoptDecoder. Kalau pipeline ini diganti, samakan juga cadModel.js.
   ========================================================================== */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, copyFileSync, existsSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = ['--yes', '@gltf-transform/cli@4'];

/* Part yang dibuang untuk tampilan web. Semuanya terkurung rapat di dalam
   part lain pada link yang sama, jadi tidak pernah terlihat dari luar. */
const DROP = new Set([
  // internal reduktor cycloidal: terkurung Housing (output) + Top Roller Cover
  // + Top/Bottom Base di ketiga sendi J2, J3, J4.
  'Cycloid Disk', 'Input Cam', 'Crown',
  // slewing bearing bola J1: terjepit antara Stage 1/2/3 Holder dan kolom J1.
  'Stage 1 Crown', 'Stage 2 Crown', 'Stage 3 Crown', 'Encoder Bearing Crown',
  // drivetrain belt J1: seluruhnya di dalam Pulley Casing + Pulley Casing Cover.
  'Input Pulley 12T', 'Stage 2 Pulley 60T -> 20T', 'Output Pulley 60T',
  'Stage 1 270mm Belt', 'Stage 2 270mm Belt', 'Oldham Coupler',
  // poros dan spline servo: kecil dan tertutup rumahnya masing-masing.
  'D-shaft', 'D-Shaft', 'Output Gear',
]);

const args = process.argv.slice(2);
const keepAll = args.includes('--keep-all');

/* --keep "Nama,Nama": kecualikan beberapa nama dari DROP tanpa membawa serta
   semua 34 part internal seperti --keep-all. Dipakai varian exploded view
   cycloidal, yang justru butuh Cycloid Disk, Input Cam, dan Crown:
     node tools/optimize_cad_glb.mjs "onshape/Main Assembly (Complete).glb" \
          studio/public/main-assembly-cyc.glb --keep "Cycloid Disk,Input Cam,Crown"
   Nama harus persis seperti di Onshape, termasuk huruf besar kecilnya. */
const iKeep = args.indexOf('--keep');
if (iKeep >= 0) {
  const daftar = (args[iKeep + 1] || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!daftar.length) {
    console.error('--keep butuh daftar nama, contoh: --keep "Cycloid Disk,Input Cam"');
    process.exit(1);
  }
  for (const nama of daftar) {
    if (!DROP.has(nama)) {
      console.error(`--keep: "${nama}" memang tidak ada di daftar DROP, salah ketik?`);
      process.exit(1);
    }
    DROP.delete(nama);
  }
  console.log(`--keep: ${daftar.length} nama dipertahankan (${daftar.join(', ')})`);
}

const positional = args.filter((a, i) => !a.startsWith('--') && i !== iKeep + 1);
const input = positional[0];
const output = resolve(REPO, positional[1] || 'studio/public/main-assembly.glb');

if (!input) {
  console.error('pakai: node tools/optimize_cad_glb.mjs <input.glb> [output.glb]'
    + ' [--keep-all] [--keep "Nama,Nama"]');
  process.exit(1);
}
const src = resolve(REPO, input);
if (!existsSync(src)) {
  console.error(`input tidak ditemukan: ${src}`);
  process.exit(1);
}

const mb = (p) => (statSync(p).size / 1e6).toFixed(2) + ' MB';
const tmp = mkdtempSync(join(tmpdir(), 'cadglb-'));

/** jalankan satu tahap gltf-transform; keluar kalau gagal. */
function stage(label, args) {
  process.stdout.write(`  ${label} ... `);
  // shell:true, jadi argumen berspasi (mis. "Main Assembly (Complete).glb" saat
  // --keep-all memakai path sumber langsung) harus dikutip sendiri.
  const q = args.map((a) => (/[\s()]/.test(a) ? `"${a}"` : a));
  const r = spawnSync('npx', [...CLI, ...q], { shell: true, encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`GAGAL\n${r.stdout || ''}${r.stderr || ''}`);
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
  console.log('ok');
}

/* --------------------------------------------------------------------------
   drop-parts: lepas referensi mesh dari node yang namanya ada di DROP. Node
   jadi kosong, lalu `prune` di tahap berikutnya yang membuang node kosong,
   mesh, accessor, dan bufferView yang sudah tidak dipakai. Chunk BIN disalin
   apa adanya di sini.
   -------------------------------------------------------------------------- */
function dropParts(srcPath, dstPath) {
  const buf = readFileSync(srcPath);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('bukan file GLB');
  const total = buf.readUInt32LE(8);
  const chunks = [];
  for (let o = 12; o < total;) {
    const len = buf.readUInt32LE(o), type = buf.readUInt32LE(o + 4);
    chunks.push({ type, data: buf.subarray(o + 8, o + 8 + len) });
    o += 8 + len;
  }
  const jsonChunk = chunks.find((c) => c.type === 0x4e4f534a);
  const binChunk = chunks.find((c) => c.type === 0x004e4942);
  const gltf = JSON.parse(jsonChunk.data.toString('utf8'));

  let dropped = 0, kept = 0;
  for (const node of gltf.nodes || []) {
    if (node.mesh === undefined) continue;
    if (DROP.has(node.name)) { delete node.mesh; dropped++; } else kept++;
  }
  console.log(`  drop-parts: ${dropped} part dibuang, ${kept} part disimpan`);

  // rakit ulang GLB: chunk JSON dipad spasi, chunk BIN dipad nol, keduanya 4 byte
  const jsonBuf = Buffer.from(JSON.stringify(gltf), 'utf8');
  const jsonPad = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
  const binPad = binChunk
    ? Buffer.concat([binChunk.data, Buffer.alloc((4 - (binChunk.data.length % 4)) % 4, 0)])
    : Buffer.alloc(0);
  const size = 12 + 8 + jsonPad.length + (binChunk ? 8 + binPad.length : 0);
  const out = Buffer.alloc(size);
  out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(size, 8);
  let p = 12;
  out.writeUInt32LE(jsonPad.length, p); out.writeUInt32LE(0x4e4f534a, p + 4);
  jsonPad.copy(out, p + 8); p += 8 + jsonPad.length;
  if (binChunk) {
    out.writeUInt32LE(binPad.length, p); out.writeUInt32LE(0x004e4942, p + 4);
    binPad.copy(out, p + 8);
  }
  writeFileSync(dstPath, out);
  return dropped;
}

const p0 = join(tmp, '0.glb'), a = join(tmp, 'a.glb'), b = join(tmp, 'b.glb');
const c = join(tmp, 'c.glb'), d = join(tmp, 'd.glb');

console.log(`input : ${src} (${mb(src)})`);
let first = src;
if (!keepAll) { dropParts(src, p0); first = p0; }
else console.log('  drop-parts: dilewati (--keep-all)');
stage('prune (node kosong + TEXCOORD)   ', ['prune', first, a]);
stage('weld  (gabung vertex identik)    ', ['weld', a, b]);
stage('join  (gabung primitive per part)', ['join', b, c, '--keepNamed', 'true']);
stage('meshopt (kompresi + kuantisasi)  ', ['meshopt', c, d, '--level', 'high',
  '--quantize-position', '14', '--quantize-normal', '10']);

copyFileSync(d, output);
rmSync(tmp, { recursive: true, force: true });
console.log(`output: ${output} (${mb(output)})`);
