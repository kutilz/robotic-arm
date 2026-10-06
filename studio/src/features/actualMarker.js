/* ============================================================================
   Penanda TCP AKTUAL: bola kecil di posisi ujung lengan menurut feedback,
   plus garis ke TCP yang sedang ditampilkan model.

   Kenapa ada. Selama operator menyusun pose (poseDirty), model menampilkan
   TARGET, bukan lengan. Di WiFi rumah selisih keduanya cuma sekejap. Lewat
   internet tidak: feedback itu sendiri sudah setengah RTT basi, dan lengan
   merayap pada laju profil di belakang target. Tanpa penanda ini satu satunya
   tempat operator bisa melihat "lengan sebenarnya ada di mana" adalah deretan
   angka di bilah interlock. Bola dan garis ini menunjukkan jaraknya langsung
   di ruang 3D, dan garis yang memendek adalah bukti lengan sedang menyusul.

   Posisinya dihitung dari sudut feedback lewat FK yang sama dengan model
   (eePositionsFor). Sendi yang umpan baliknya tidak dipercaya (pot servo
   placeholder) memakai sudut yang ditampilkan model, bukan angka karangan.
   Tampil hanya saat link hidup DAN model sedang menampilkan target yang
   berbeda dari lengan; saat model mengikuti feedback keduanya berimpit dan
   penanda cuma akan menutupi ujung gripper.
   ========================================================================== */
import { THREE, scene } from '../core/viewport.js';
import { STATE } from '../config/arm.js';
import { eePositionsFor, getTCP } from '../model/kinematics.js';
import { isConnected, getActual, isFbTrusted, getNet } from '../net/bridge.js';

const TICK_MS = 120;
const MIN_GAP_MM = 3;          // di bawah ini target dan lengan dianggap berimpit

let ball = null, line = null;

function build() {
  ball = new THREE.Mesh(
    new THREE.SphereGeometry(9, 18, 14),
    new THREE.MeshBasicMaterial({ color: 0xf5a53c, transparent: true, opacity: 0.85, depthTest: false }),
  );
  ball.renderOrder = 960;
  const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
  line = new THREE.Line(geo, new THREE.LineDashedMaterial({
    color: 0xf5a53c, dashSize: 8, gapSize: 6, transparent: true, opacity: 0.8, depthTest: false,
  }));
  line.renderOrder = 959;
  ball.visible = line.visible = false;
  scene.add(ball, line);
}

function tick() {
  const a = isConnected() ? getActual() : null;
  if (!a || !STATE.poseDirty) { ball.visible = line.visible = false; return; }
  const angles = STATE.joints.map((j, i) => (a[i] != null && isFbTrusted(i) ? a[i] : j.a));
  const [p] = eePositionsFor([angles]);
  const tcp = getTCP().pos;
  if (p.distanceTo(tcp) < MIN_GAP_MM) { ball.visible = line.visible = false; return; }
  ball.position.copy(p);
  line.geometry.setFromPoints([p, tcp]);
  line.computeLineDistances();
  // Feedback yang sudah basi (link tersendat) digambar pudar: posisinya lama.
  const n = getNet();
  const basi = n.fbAge != null && n.fbAge > 1000;
  ball.material.opacity = basi ? 0.3 : 0.85;
  ball.visible = line.visible = true;
}

export function initActualMarker() {
  build();
  setInterval(tick, TICK_MS);
}
