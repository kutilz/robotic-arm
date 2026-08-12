/* ============================================================================
   rig: satu-satunya rantai kinematik studio. Menggantikan model/arm.js lama
   (twin parametrik dari primitif) yang geometrinya sudah tidak cocok dengan
   CAD: kolom base 120 mm vs 72,8 mm terukur, wrist->TCP 90 mm vs 174,9 mm,
   dan offset bahu dipasang sejajar sumbu pitch sehingga tidak ikut mengayun.
   Sekarang rantainya dibangun dari sumbu hasil ukur di cadRig.js, jadi FK,
   IK, torsi, envelope, dan mesh CAD memakai geometri yang persis sama.

   Isi modul: rantai sendi + node TCP + marker massa + overlay engineering
   (panah sumbu, skeleton, label dimensi) + exploded view yang bekerja pada
   part CAD. Mesh CAD-nya sendiri dimuat oleh cadModel.js dan ditempelkan ke
   `partHosts` lewat attachCad(); kalau GLB belum ada, rantai + overlay tetap
   jalan sebagai tampilan skeleton.
   ========================================================================== */
import { THREE, v3, makeLabel, scene } from '../core/viewport.js';
import { STATE, MASSES } from '../config/arm.js';
import { SceneColors } from '../core/theme.js';
import { buildChain, attachParts, CAD_JOINTS } from './cadRig.js';

export const world = {
  root: null, chain: null, pivots: [], links: [], partHosts: [],
  jointRefs: [], massNodes: [], axisHelpers: [], skelParts: [], dimGroup: null,
  eeNode: null, homeOff: [], geo: null,
  cadParts: [], cadMats: [], cadLoaded: false,
};

const SKEL = { link: 0x39c2e0, off: 0xf5a53c, col: 0x8fa3b8 };
const EXPLODE_SPACING = 22;   // mm antar part sepanjang sumbu link saat slider = 1

function skelMat(color) { return new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: .95 }); }

/** segmen skeleton a->b (koordinat lokal link) + label opsional di tengahnya. */
function skelSeg(parent, a, b, color, label) {
  const v = new THREE.Vector3().subVectors(b, a), len = v.length();
  if (len < 0.5) return;
  const m = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, len, 8), skelMat(color));
  m.position.copy(a).addScaledVector(v, 0.5);
  m.quaternion.setFromUnitVectors(v3(0, 1, 0), v.clone().normalize());
  m.renderOrder = 950; parent.add(m); world.skelParts.push(m);
  if (label) {
    const l = makeLabel(label, color === SKEL.off ? '#ffd18a' : color === SKEL.col ? '#b9c6d4' : '#aee9f7', 0.6);
    l.position.copy(a).addScaledVector(v, 0.5).add(v3(26, 0, 26));
    parent.add(l); world.skelParts.push(l);
  }
}
function skelDot(parent, p) {
  const s = new THREE.Mesh(new THREE.SphereGeometry(3.4, 12, 12), skelMat(0xffffff));
  s.renderOrder = 951; s.position.copy(p); parent.add(s); world.skelParts.push(s);
}
/** panah dua arah di sumbu sendi, ditempel pada link anak supaya ikut bergerak. */
function addAxis(parent, at, dir, text, color, len) {
  const d = dir.clone().normalize();
  const ar = new THREE.ArrowHelper(d, at, len, color, len * 0.28, len * 0.16);
  const ar2 = new THREE.ArrowHelper(d.clone().negate(), at, len * 0.55, color, len * 0.2, len * 0.12);
  parent.add(ar, ar2);
  const lab = makeLabel(text, '#cdeefa', 0.78);
  lab.position.copy(at).addScaledVector(d, len + 22);
  parent.add(lab);
  world.axisHelpers.push(ar, ar2, lab);
}

/* ---------------- label dimensi ---------------- */
function buildDims(P, tcp) {
  world.dimGroup = new THREE.Group();
  world.root.add(world.dimGroup);
  const g = world.geo;
  const put = (txt, a, b, color) => {
    const l = makeLabel(txt, color, 0.7);
    l.position.copy(a).add(b).multiplyScalar(0.5).add(v3(150, 0, 0));
    world.dimGroup.add(l);
  };
  put(`a1 bahu ${g.a1.toFixed(1)}`, P[0], P[1], '#ffd18a');
  put(`upper arm ${g.a2.toFixed(1)}`, P[1], P[2], '#9fb6c8');
  put(`forearm ${g.d4.toFixed(1)}`, P[2], P[3], '#9fb6c8');
  put(`wrist->TCP ${g.d6.toFixed(1)}`, P[5], tcp, '#9fb6c8');
  const reach = makeLabel(`reach J2->TCP ${g.reachFromJ2.toFixed(0)} mm`, '#7fe0f0', 0.78);
  reach.position.set(-260, P[3].y, P[3].z);
  world.dimGroup.add(reach);
}

/* ============================================================================
   build
   ========================================================================== */
export function buildRig() {
  if (world.root) scene.remove(world.root);
  world.jointRefs = []; world.massNodes = []; world.axisHelpers = []; world.skelParts = [];
  world.cadParts = []; world.cadMats = []; world.cadLoaded = false;

  const rig = buildChain();
  Object.assign(world, {
    root: rig.root, chain: rig.chain, pivots: rig.pivots, links: rig.links,
    partHosts: rig.partHosts, homeOff: rig.homeOff, geo: rig.geo,
  });
  scene.add(rig.root);

  const P = rig.P, A = rig.A, tcp = rig.tcpLocal;

  // rantai sendi untuk kinematics.js. `axis` = sumbu di frame lokal pivot;
  // kinematics memakainya untuk arah torsi dan Jacobian numerik.
  rig.pivots.forEach((pv, i) => {
    world.jointRefs.push({ def: STATE.joints[i], pivot: pv, axis: pv.userData.axis.clone() });
  });

  // node TCP: titik tengah ujung wedge jaw, orientasi = frame tool (z' sumbu J6)
  world.eeNode = new THREE.Group();
  world.eeNode.name = 'tcp';
  world.eeNode.position.copy(tcp);
  world.eeNode.quaternion.copy(rig.tcpQuat);
  rig.links[6].add(world.eeNode);

  /* ---- panah sumbu, ditempel di link anak tiap sendi ---- */
  const AX = [
    ['J1·yaw', SceneColors.axisY, 70], ['J2·pitch', SceneColors.axisX, 84],
    ['J3·pitch', SceneColors.axisX, 68], ['J4·roll', SceneColors.axisRY, 54],
    ['J5·pitch', SceneColors.axisX, 46], ['J6·roll', SceneColors.axisRY, 38],
  ];
  AX.forEach(([txt, col, len], i) => addAxis(rig.links[i + 1], P[i], A[i], txt, col, len));

  /* ---- skeleton: kolom base, offset bahu, upper arm, forearm, tool ---- */
  const kneeP = v3(P[0].x, P[1].y, P[0].z);   // siku kolom base -> offset bahu
  skelSeg(rig.links[1], P[0], kneeP, SKEL.col, `kolom ${(P[1].y - P[0].y).toFixed(0)}`);
  skelSeg(rig.links[1], kneeP, P[1], SKEL.off, `a1 ${world.geo.a1.toFixed(0)}`);
  skelDot(rig.links[1], P[0]);
  skelSeg(rig.links[2], P[1], P[2], SKEL.link, `upper ${world.geo.a2.toFixed(0)}`);
  skelDot(rig.links[2], P[1]);
  skelSeg(rig.links[3], P[2], P[3], SKEL.link, `forearm ${world.geo.d4.toFixed(0)}`);
  skelDot(rig.links[3], P[2]);
  skelSeg(rig.links[6], P[5], tcp, SKEL.link, `tool ${world.geo.d6.toFixed(0)}`);
  skelDot(rig.links[6], P[5]);
  skelDot(rig.links[6], tcp);

  buildDims(P, tcp);

  /* ---- marker massa (sumber torsi gravitasi) ---- */
  for (const mm of MASSES) {
    const node = new THREE.Group();
    if (mm.at === 'tcp') {
      world.eeNode.add(node);
    } else {
      node.position.copy(P[mm.joint]).addScaledVector(v3(0, 1, 0), mm.along);
      rig.links[mm.joint + 1].add(node);
    }
    node.userData = { mass: mm.m, label: mm.label, key: mm.label };
    if (mm.label === 'payload') node.userData.payload = true;
    const dot = new THREE.Mesh(new THREE.SphereGeometry(9, 16, 16),
      new THREE.MeshStandardMaterial({ color: 0xf06c5e, emissive: 0x3a0d08, roughness: .5 }));
    node.add(dot); node.userData.dot = dot; dot.visible = false;
    world.massNodes.push(node);
  }
  return world;
}

/* ============================================================================
   mesh CAD
   ========================================================================== */
/** Tempelkan scene GLB ke link masing-masing dan siapkan arah exploded view. */
export function attachCad(gltfScene) {
  const res = attachParts(gltfScene, world.partHosts);
  indexParts();
  world.cadLoaded = true;
  return res;
}

/** Sama seperti attachCad tapi untuk model blok previewModel.js, yang part-nya
    sudah ditempel sendiri ke partHosts. `cadLoaded` sengaja tetap false: yang
    tampil bukan mesh CAD. */
export function attachPreview() {
  indexParts();
}

/** Daftarkan apa pun yang sudah menempel di partHosts sebagai part tampilan:
    hitung arah exploded view, kumpulkan material untuk x-ray. Idempoten. */
function indexParts() {
  const mats = new Set();
  world.cadParts = [];

  // arah explode = sumbu sendi induk link tersebut, di frame file CAD (partHost
  // membawa rotasi basis + skala, jadi offset harus dinyatakan di frame itu).
  world.partHosts.forEach((host, L) => {
    const axCad = v3(...(L === 0 ? [0, 0, 1] : CAD_JOINTS[L - 1].a)).normalize();
    const parts = host.children.slice();
    parts.sort((a, b) => a.position.dot(axCad) - b.position.dot(axCad));
    const mid = (parts.length - 1) / 2;
    parts.forEach((p, i) => {
      p.userData.explodeDir = axCad.clone().multiplyScalar((i - mid) * EXPLODE_SPACING / 1000);
      p.traverse(o => { if (o.material) mats.add(o.material); });
      world.cadParts.push(p);
    });
  });

  world.cadMats = [...mats];
  applyExplode();
}

/** geser part CAD sepanjang sumbu link-nya sesuai slider exploded view. */
export function applyExplode() {
  const ex = STATE.explode;
  for (const p of world.cadParts) {
    if (!p.userData.homePos) continue;
    p.position.copy(p.userData.homePos).addScaledVector(p.userData.explodeDir, ex);
  }
}

/** tampilkan/sembunyikan mesh CAD tanpa menyentuh overlay (skeleton, sumbu). */
export function setCadPartsVisible(v) {
  for (const h of world.partHosts) h.visible = v;
}

/** x-ray: mesh CAD jadi tembus pandang supaya skeleton dan sumbu terbaca. */
export function setXray(on) {
  for (const m of world.cadMats) {
    m.transparent = on; m.opacity = on ? 0.22 : 1; m.depthWrite = !on; m.needsUpdate = true;
  }
}
