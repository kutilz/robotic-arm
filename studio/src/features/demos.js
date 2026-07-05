/* ============================================================================
   Preset gerakan / demo (mirip demo programs Waldo Commander). Tiap demo
   mengisi timeline dengan keyframe lalu memutarnya.
   ========================================================================== */
import { THREE } from '../core/viewport.js';
import { STATE } from '../config/arm.js';
import { getTCP, solveIK, applyPose } from '../model/kinematics.js';
import { loadKeyframes, keysFromPoses } from './timeline.js';

// pose statik = [J1,J2,J3,J4,J5,J6] derajat
const SWEEP = [
  [0, 0, 0, 0, 0, 0], [90, 20, 0, 0, 0, 0], [-90, 40, 60, 0, 30, 0],
  [0, 80, 120, 120, 60, 90], [0, -40, 140, -120, -60, -90], [0, 0, 0, 0, 0, 0],
];
const PICK_PLACE = [
  [0, 0, 0, 0, 0, 0], [0, 60, 50, 0, 40, 0], [0, 75, 45, 0, 55, 0],
  [0, 55, 55, 0, 35, 0], [90, 55, 55, 0, 35, 0], [90, 72, 48, 0, 52, 0],
  [90, 50, 55, 0, 30, 0], [0, 0, 0, 0, 0, 0],
];
const SHOWCASE = [
  [0, 0, 0, 0, 0, 0], [60, 0, 0, 0, 0, 0], [-60, 0, 0, 0, 0, 0], [0, 60, 0, 0, 0, 0],
  [0, 30, 90, 0, 0, 0], [0, 30, 60, 150, 0, 0], [0, 30, 60, 0, 90, 0],
  [0, 30, 60, 0, 0, 150], [0, 0, 0, 0, 0, 0],
];

// lingkaran: TCP menggambar lingkaran di bidang pitch (Z-Y) yang natural terjangkau
function circlePoses() {
  const saved = STATE.joints.map(j => j.a);
  const seed = [0, 45, 70, 0, 30, 0];
  STATE.joints.forEach((j, i) => { j.a = seed[i]; });
  applyPose();
  const c = getTCP().pos.clone(), q = getTCP().quat.clone();
  const r = 45, N = 32, poses = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N * Math.PI * 2;
    // bidang Z-Y (sumbu ayun lengan), bukan lateral -> hanya butuh J2/J3/J5
    const target = c.clone().add(new THREE.Vector3(0, Math.sin(t) * r, Math.cos(t) * r));
    solveIK(target, q, { useOrient: false, iters: 24, partial: true });
    poses.push(STATE.joints.map(j => j.a));
  }
  STATE.joints.forEach((j, i) => { j.a = saved[i]; });
  applyPose();
  return poses;
}

export const DEMOS = {
  'Sapu penuh': () => loadKeyframes(keysFromPoses(SWEEP, 1.3)),
  'Pick & place': () => loadKeyframes(keysFromPoses(PICK_PLACE, 1.1)),
  'Showcase sendi': () => loadKeyframes(keysFromPoses(SHOWCASE, 1.0)),
  'Lingkaran (IK)': () => loadKeyframes(keysFromPoses(circlePoses(), 0.12)),
};
