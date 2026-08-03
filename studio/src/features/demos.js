/* ============================================================================
   Preset gerakan / demo (mirip demo programs Waldo Commander). Tiap demo
   mengisi timeline dengan keyframe lalu memutarnya.

   SEMUA POSE DI SINI DI-TUNING ULANG untuk rantai CAD 2026-08-03. Pose lama
   disusun saat rantai parametrik masih memakai wrist->TCP 90 mm dan kolom base
   120 mm; di rantai terukur (wrist->TCP 174,9 mm, kolom 72,8 mm) TCP-nya turun
   lebih dari 100 mm sehingga banyak pose menembus meja: Pick & place punya 3
   pose di bawah y=0, Sapu penuh 1 pose, dan seed lingkaran cuma 39 mm di atas
   grid sehingga lingkarannya terpotong.

   Pose pick & place dihitung lewat IK ke titik meja nyata (tinggi ambil 165 mm,
   tinggi angkat 330 mm), bukan diketik manual. Tabel pose-nya sendiri ada di
   config/arm.js (DEMO_POSES) supaya bisa divalidasi tanpa WebGL:
   `node studio/tools/verify_cad_rig.mjs` memeriksa tiap pose masih di atas meja
   dan di dalam limit sendi.
   ========================================================================== */
import { THREE } from '../core/viewport.js';
import { STATE, DEMO_POSES, CIRCLE_SEED, CIRCLE_R } from '../config/arm.js';
import { getTCP, solveIK, applyPose } from '../model/kinematics.js';
import { loadKeyframes, keysFromPoses } from './timeline.js';

function circlePoses() {
  const saved = STATE.joints.map(j => j.a);
  STATE.joints.forEach((j, i) => { j.a = CIRCLE_SEED[i]; });
  applyPose();
  const c = getTCP().pos.clone(), q = getTCP().quat.clone();
  const N = 32, poses = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N * Math.PI * 2;
    // bidang Z-Y (sumbu ayun lengan), bukan lateral -> hanya butuh J2/J3/J5
    const target = c.clone().add(new THREE.Vector3(0, Math.sin(t) * CIRCLE_R, Math.cos(t) * CIRCLE_R));
    solveIK(target, q, { useOrient: false, iters: 24, partial: true });
    poses.push(STATE.joints.map(j => j.a));
  }
  STATE.joints.forEach((j, i) => { j.a = saved[i]; });
  applyPose();
  return poses;
}

export const DEMOS = {
  'Sapu penuh': () => loadKeyframes(keysFromPoses(DEMO_POSES.sweep, 1.3)),
  'Pick & place': () => loadKeyframes(keysFromPoses(DEMO_POSES.pickPlace, 1.1)),
  'Showcase sendi': () => loadKeyframes(keysFromPoses(DEMO_POSES.showcase, 1.0)),
  'Lingkaran (IK)': () => loadKeyframes(keysFromPoses(circlePoses(), 0.12)),
};
