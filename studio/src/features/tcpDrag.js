/* ============================================================================
   Drag TCP bebas dengan mouse (gizmo) -> IK numerik. Mengadopsi TCP transform
   controls Waldo Commander. Translate = geser posisi TCP; Rotate = putar
   orientasi TCP. Orbit kamera dimatikan saat gizmo di-drag.

   MODUL INI TIDAK PERNAH MENGIRIM APA APA KE LENGAN, dan jangan ditambahi
   pengiriman. Saat mode LIVE menyala, lengan mengikuti gizmo karena
   net/liveLink.js membaca pose twin tiap 50 ms dan mengalirkannya bertahap;
   gizmo cukup menulis pose twin seperti biasa. Menaruh sendGoto di sini
   (mis. di objectChange) akan membuat dua sumber target mengirim ke sendi yang
   sama tanpa saling tahu, dan objectChange dipanggil sekali per gerakan mouse,
   yaitu jauh lebih rapat daripada yang bisa diladeni ESP32.
   ========================================================================== */
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { THREE, scene, renderer, camera, curCam, onFrame, setControlsEnabled } from '../core/viewport.js';
import { STATE } from '../config/arm.js';
import { getTCP, solveIK, applyPose } from '../model/kinematics.js';

let tc = null, target = null, enabled = false, dragging = false;

export function initTcpDrag() {
  target = new THREE.Mesh(
    new THREE.SphereGeometry(9, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0x38bdf8, depthTest: false, transparent: true, opacity: 0.85 })
  );
  target.renderOrder = 998; target.visible = false; scene.add(target);

  tc = new TransformControls(camera, renderer.domElement);
  tc.setSize(0.85); tc.setSpace('world'); tc.enabled = false; tc.visible = false;
  tc.addEventListener('dragging-changed', e => { dragging = e.value; setControlsEnabled(!e.value); });
  tc.addEventListener('objectChange', () => {
    if (!enabled || STATE.estop) return;
    const useOrient = tc.getMode() === 'rotate';
    solveIK(target.position.clone(), target.quaternion.clone(), { useOrient, iters: 18, partial: true });
    applyPose();
  });
  scene.add(tc);

  onFrame(() => {
    tc.camera = curCam();
    if (enabled && !dragging) { const t = getTCP(); target.position.copy(t.pos); target.quaternion.copy(t.quat); }
    if (STATE.estop && enabled) setTcpDrag(false); // E-STOP mematikan drag
  });
}

export function setTcpDrag(on) {
  if (!tc) return;
  enabled = on; target.visible = on; tc.visible = on; tc.enabled = on;
  if (on) { const t = getTCP(); target.position.copy(t.pos); target.quaternion.copy(t.quat); tc.attach(target); }
  else { tc.detach(); }
}
export function setTcpMode(mode) { if (tc) tc.setMode(mode); }
export function getTcpEnabled() { return enabled; }
