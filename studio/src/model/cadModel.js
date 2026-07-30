/* ============================================================================
   cadModel — muat mesh CAD asli (Testing Assembly.glb, export Onshape) sebagai
   pengganti visual model parametrik lama.

   CATATAN penting:
   - three.js tidak bisa membaca .step; dipakai GLB hasil export Onshape
     (glTF 2.0) di studio/public/testing-assembly.glb (di-gitignore, ~21 MB).
   - Model ini STATIS: 67 solid belum dikelompokkan per-sendi, jadi jog/IK/
     timeline tidak menggerakkannya. Menyalakan CAD menyembunyikan twin
     parametrik (world.arm) dan sebaliknya, jadi bisa dibolak-balik.
   - Transform di bawah BELUM diverifikasi render (tidak ada browser saat dibuat).
     Onshape export GLB dalam meter dan Y-up; studio pakai mm. Kalau posisi/skala/
     orientasi meleset, cukup ubah konstanta CAD_* ini.
   ========================================================================== */
import { THREE, scene } from '../core/viewport.js';
import { world } from './arm.js';
// GLTFLoader di-import dinamis (code-split) supaya hanya dimuat saat CAD dipakai.

const CAD_URL = '/testing-assembly.glb';
const CAD_SCALE = 1000;   // meter (Onshape) -> mm (studio)
const CAD_ROT = { x: 0, y: 0, z: 0 };  // GLB Onshape umumnya sudah Y-up; nudge bila perlu
const CAD_POS = { x: 0, y: 0, z: 0 };
const DROP_TO_GROUND = true;  // geser supaya dasar bbox menyentuh grid y=0

let cadRoot = null;
let loading = false;

/** Muat GLB sekali (async). onDone(group|null) dipanggil setelah selesai/gagal. */
export function loadCadModel(onDone) {
  if (cadRoot) { onDone && onDone(cadRoot); return; }
  if (loading) { onDone && onDone(null); return; }
  loading = true;
  import('three/examples/jsm/loaders/GLTFLoader.js').then(({ GLTFLoader }) => {
    new GLTFLoader().load(
      CAD_URL,
      (gltf) => {
      const inner = gltf.scene;
      inner.scale.setScalar(CAD_SCALE);
      cadRoot = new THREE.Group();
      cadRoot.name = 'cadModel';
      cadRoot.rotation.set(CAD_ROT.x, CAD_ROT.y, CAD_ROT.z);
      cadRoot.position.set(CAD_POS.x, CAD_POS.y, CAD_POS.z);
      cadRoot.add(inner);
      if (DROP_TO_GROUND) {
        const box = new THREE.Box3().setFromObject(cadRoot);
        if (isFinite(box.min.y)) cadRoot.position.y -= box.min.y;
      }
      cadRoot.visible = false;  // twin parametrik tetap tampilan utama sampai di-toggle
      scene.add(cadRoot);
      loading = false;
      onDone && onDone(cadRoot);
      },
      undefined,
      (err) => {
        loading = false;
        console.warn('[cadModel] gagal memuat GLB; twin parametrik tetap jalan.', err);
        onDone && onDone(null);
      },
    );
  }).catch((err) => {
    loading = false;
    console.warn('[cadModel] GLTFLoader gagal di-import.', err);
    onDone && onDone(null);
  });
}

/** Tampilkan/sembunyikan CAD. Saat CAD tampil, twin parametrik disembunyikan. */
export function setCadVisible(v) {
  if (v && !cadRoot) {
    loadCadModel((r) => { if (r) applyVisibility(true); });
    return;
  }
  applyVisibility(v);
}

function applyVisibility(v) {
  if (cadRoot) cadRoot.visible = v;
  if (world.arm) world.arm.visible = !v;  // swap tampilan CAD <-> twin parametrik
}

export function isCadLoaded() { return !!cadRoot; }
