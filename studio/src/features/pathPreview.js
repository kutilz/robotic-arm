/* ============================================================================
   Path preview + reachability — mengadopsi preview jalur & cek jangkauan Waldo.
   - Path: polyline posisi TCP sepanjang trajektori timeline.
   - Reachability: point cloud EE dari sampling ruang sendi (J1-J3, wrist 0).
   ========================================================================== */
import { THREE, scene } from '../core/viewport.js';
import { STATE } from '../config/arm.js';
import { SceneColors } from '../core/theme.js';
import { eePositionsFor } from '../model/kinematics.js';
import { sampleTrajectory, onKeysChange } from './timeline.js';

let pathLine = null, cloud = null;
const show = { path: false, reach: false };

/* ---------------- path ---------------- */
export function refreshPath() {
  if (pathLine) { scene.remove(pathLine); pathLine.geometry.dispose(); pathLine = null; }
  if (!show.path) return;
  const traj = sampleTrajectory(120);
  if (traj.length < 2) return;
  const pts = eePositionsFor(traj);
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  pathLine = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: SceneColors.accent, transparent: true, opacity: 0.9 }));
  pathLine.renderOrder = 930; scene.add(pathLine);
}

/* ---------------- reachability ---------------- */
function computeReach() {
  const J = STATE.joints;
  const list = [];
  // grid J2 x J3 direvolve oleh beberapa J1 -> shell volume reachable
  const nJ1 = 10, nJ2 = 26, nJ3 = 26;
  const lerp = (a, b, f) => a + (b - a) * f;
  for (let i1 = 0; i1 < nJ1; i1++) {
    const a1 = lerp(J[0].min, J[0].max, nJ1 === 1 ? 0 : i1 / (nJ1 - 1));
    for (let i2 = 0; i2 <= nJ2; i2++) {
      const a2 = lerp(J[1].min, J[1].max, i2 / nJ2);
      for (let i3 = 0; i3 <= nJ3; i3++) {
        const a3 = lerp(J[2].min, J[2].max, i3 / nJ3);
        list.push([a1, a2, a3, 0, 0, 0]);
      }
    }
  }
  return eePositionsFor(list);
}
export function refreshReach() {
  if (cloud) { scene.remove(cloud); cloud.geometry.dispose(); cloud = null; }
  if (!show.reach) return;
  const pts = computeReach();
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  cloud = new THREE.Points(geo, new THREE.PointsMaterial({ color: SceneColors.axisZ, size: 4, sizeAttenuation: true, transparent: true, opacity: 0.35 }));
  cloud.renderOrder = 5; scene.add(cloud);
}

export function setShow(key, v) {
  show[key] = v;
  if (key === 'path') refreshPath();
  if (key === 'reach') refreshReach();
}
export function getShow(key) { return show[key]; }

export function initPathPreview() {
  // path ikut berubah saat keyframe berubah
  onKeysChange(() => { if (show.path) refreshPath(); });
}
