/* ============================================================================
   previewModel: model blok sederhana yang dipakai KALAU main-assembly.glb tidak
   tersedia (mis. build web hasil deploy, karena GLB-nya gitignored 1,8 MB).

   Ini BUKAN mesh CAD. Tiap part digambar sebagai satu balok atau silinder, jadi
   fillet, lubang, rusuk, dan kantong bola tidak ada. Yang dijaga akurat hanya
   dua hal, dan keduanya diambil dari data terukur, bukan dikarang:

     posisi   pusat bounding box tiap part dari CAD_PARTS di cadRig.js, yaitu
              hasil ukur `onshape/Main Assembly (Complete).glb` rev 2026-08-03
     ukuran   dimensi bounding box part dari docs/bom-main-assembly.md, lihat
              tabel PREVIEW_SPEC di previewSpec.js

   Akibatnya siluet, proporsi, dan letak tiap subrakitan cocok dengan rakitan
   asli, sementara detail permukaannya hilang.

   Part ditempel ke `partHost` yang sama dengan mesh CAD asli, sehingga rantai
   sendi, exploded view, x-ray, dan toggle tampilan bekerja tanpa perlakuan
   khusus. Host membawa rotasi basis CAD->studio dan skala 1000, jadi isinya
   dinyatakan dalam METER pada frame file CAD; konversi dari mm ditangani mm().
   ========================================================================== */
import { THREE, M } from '../core/viewport.js';
import { CAD_PARTS, CAD_SCALE, nameKey } from './cadRig.js';
import { previewSpecFor } from './previewSpec.js';

/** mm (frame CAD) -> unit partHost (meter). */
const mm = (v) => v / CAD_SCALE;

/** nama material di previewSpec.js -> material three.js dari palet viewport. */
const MAT = {
  pla: M.pla, pla2: M.pla2, housing: M.housing, steel: M.steel,
  motor: M.motor, servo: M.servo, magnet: M.magnet, belt: M.belt, link: M.link,
};

/** balok, ukuran mm pada sumbu file CAD. */
function mkBox(sx, sy, sz, mat) {
  return new THREE.Mesh(new THREE.BoxGeometry(mm(sx), mm(sy), mm(sz)), mat);
}

/** silinder tegak lurus `axis`; CylinderGeometry bersumbu Y, jadi diputar. */
function mkCyl(d, t, axis, mat) {
  const g = new THREE.CylinderGeometry(mm(d / 2), mm(d / 2), mm(t), 40);
  if (axis === 'z') g.rotateX(Math.PI / 2);
  else if (axis === 'x') g.rotateZ(Math.PI / 2);
  return new THREE.Mesh(g, mat);
}

function mkPart(spec) {
  const mat = MAT[spec[4]] || M.pla2;
  return spec[0] === 'cyl'
    ? mkCyl(spec[1], spec[2], spec[3], mat)
    : mkBox(spec[1], spec[2], spec[3], mat);
}

/**
 * Bangun model blok dan tempel ke partHosts (indeks = link 0..6).
 * @param {THREE.Group[]} partHosts dari buildChain()
 * @returns {{partCount:number, perLink:number[], warn:string[]}}
 */
export function buildPreviewParts(partHosts) {
  const perLink = [0, 0, 0, 0, 0, 0, 0];
  const warn = [];
  let partCount = 0;

  for (const [name, x, y, z, L] of CAD_PARTS) {
    const spec = previewSpecFor(nameKey(name), L);
    if (!spec) {
      // Blok penanda 30 mm supaya part yang belum ditabelkan tetap kelihatan
      // (dan ketahuan) daripada hilang diam-diam dari model.
      // verify_preview_model.mjs menjaga daftar ini tetap kosong.
      warn.push(`${name} (L${L}) belum punya bentuk, dipakai balok 30 mm`);
    }
    const part = spec ? mkPart(spec) : mkBox(30, 30, 30, M.pla2);
    part.name = name;
    part.position.set(mm(x), mm(y), mm(z));
    part.userData.homePos = part.position.clone();
    partHosts[L].add(part);
    perLink[L]++;
    partCount++;
  }
  return { partCount, perLink, warn };
}
