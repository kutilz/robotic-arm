/* ============================================================================
   cadModel: memuat mesh CAD (Main Assembly, export Onshape) dan menempelkannya
   ke rantai sendi yang sudah dibangun rig.js. Mesh CAD adalah tampilan DEFAULT
   studio; twin parametrik dari primitif sudah dihapus.

   Rantai kinematik TIDAK bergantung pada GLB ini: sumbu sendi dihitung dari
   tabel terukur di cadRig.js, jadi kalau main-assembly.glb belum ada di mesin
   ini (file-nya gitignored, 1,8 MB, tidak ikut ke remote) studio tetap jalan
   penuh sebagai tampilan skeleton dan memunculkan banner cara membuatnya.

   Modul ini hanya mengurus pemuatan GLB, banner status, dan toggle tampilan.
   Data sumbu sendi, peta part ke link, dan matematika rig ada di cadRig.js
   supaya bisa diverifikasi di Node tanpa WebGL lewat
   `node studio/tools/verify_cad_rig.mjs`.
   ========================================================================== */
import { STATE } from '../config/arm.js';
import { world, attachCad, setCadPartsVisible } from './rig.js';
import { CAD_URL, CAD_PART_N } from './cadRig.js';
// GLTFLoader + MeshoptDecoder di-import dinamis (code-split) supaya bundel
// utama tetap ramping.

let status = 'idle';   // idle | loading | ready | missing
const listeners = new Set();
/** subscribe status pemuatan CAD: 'loading' | 'ready' | 'missing'. */
export function onCadStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function setStatus(s, detail) { status = s; for (const fn of listeners) fn(s, detail); }
export function getCadStatus() { return status; }

/** Muat GLB sekali (async). Aman dipanggil berkali-kali: sekali gagal statusnya
    jadi 'missing' dan tidak dicoba ulang otomatis (refreshVisToggles memanggil
    setCadVisible tiap kali toggle disentuh), kecuali retry=true. */
export function loadCadModel(onDone, retry = false) {
  if (status === 'ready' || status === 'loading') { onDone && onDone(status === 'ready'); return; }
  if (status === 'missing' && !retry) { onDone && onDone(false); return; }
  setStatus('loading');
  Promise.all([
    import('three/examples/jsm/loaders/GLTFLoader.js'),
    import('three/examples/jsm/libs/meshopt_decoder.module.js'),
  ]).then(([{ GLTFLoader }, { MeshoptDecoder }]) => {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);  // GLB dikompresi EXT_meshopt_compression
    loader.load(CAD_URL,
      (gltf) => { build(gltf); onDone && onDone(true); },
      undefined,
      (err) => { fail('GLB tidak bisa dimuat', err); onDone && onDone(false); });
  }).catch((err) => {
    fail('GLTFLoader / MeshoptDecoder gagal di-import', err);
    onDone && onDone(false);
  });
}

function fail(msg, err) {
  console.warn(`[cadModel] ${msg}; studio jalan sebagai skeleton.`, err);
  setStatus('missing', msg);
}

function build(gltf) {
  const res = attachCad(gltf.scene);

  if (res.partCount !== CAD_PART_N) {
    console.warn(`[cadModel] jumlah part ${res.partCount}, diharapkan ${CAD_PART_N}.`
      + ' GLB dan tabel CAD_PARTS mungkin sudah tidak sinkron.');
  }
  if (res.warn.length) {
    console.warn(`[cadModel] ${res.warn.length}/${res.partCount} part tidak cocok di peta link:`, res.warn);
  }

  setCadPartsVisible(STATE.show.cad);
  setStatus('ready', res);
}

/** Tampilkan/sembunyikan mesh CAD. Skeleton dan overlay tidak ikut disembunyikan
    karena keduanya memang dipakai bersamaan (mis. x-ray + skeleton). */
export function setCadVisible(v) {
  STATE.show.cad = v;
  if (status === 'ready') { setCadPartsVisible(v); return; }
  if (v) loadCadModel();
}

export function isCadLoaded() { return world.cadLoaded; }
