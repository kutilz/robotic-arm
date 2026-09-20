/* ============================================================================
   Preset gerakan untuk MODEL 3D (mirip demo programs Waldo Commander). Tiap
   demo mengisi timeline dengan keyframe lalu memutarnya.

   PENTING: yang di sini TIDAK menyentuh hardware sama sekali. Timeline cuma
   menganimasikan scene graph; tidak ada satu pun WebSocket yang ditulis. Untuk
   menjalankan gerakan di lengan NYATA, pakai runner di features/runner.js
   (blok "rutin hardware" di mode RUTIN), yang mengirim langkah per langkah
   dengan konfirmasi manusia.

   Sumber pose rutin adalah config/routines.js, satu satunya tempat. Dulu pose
   pick & place dan showcase hidup di DEMO_POSES di config/arm.js; begitu rutin
   hardware lahir, menyalinnya ke dua tempat berarti pose yang dibetulkan di
   lapangan lewat "pakai pose skrg" akan menyimpang dari yang dianimasikan di
   sini. Jadi DEMO_POSES sekarang hanya menyimpan yang murni peragaan 3D.

   Pose statik divalidasi tanpa WebGL: `node studio/tools/verify_cad_rig.mjs`.
   ========================================================================== */
import { THREE } from '../core/viewport.js';
import { STATE, DEMO_POSES, CIRCLE_SEED, CIRCLE_R } from '../config/arm.js';
import { ROUTINES, posesOf } from '../config/routines.js';
import { getTCP, solveIK, applyPose } from '../model/kinematics.js';
import { loadKeyframes, keysFromPoses } from './timeline.js';

/** jalankan fn dengan pose sementara, lalu kembalikan pose semula. */
function withPose(seed, fn) {
  const saved = STATE.joints.map(j => j.a);
  STATE.joints.forEach((j, i) => { j.a = seed[i]; });
  applyPose();
  const out = fn();
  STATE.joints.forEach((j, i) => { j.a = saved[i]; });
  applyPose();
  return out;
}

function circlePoses() {
  return withPose(CIRCLE_SEED, () => {
    const c = getTCP().pos.clone(), q = getTCP().quat.clone();
    const N = 32, poses = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N * Math.PI * 2;
      // bidang Z-Y (sumbu ayun lengan), bukan lateral -> hanya butuh J2/J3/J5
      const target = c.clone().add(new THREE.Vector3(0, Math.sin(t) * CIRCLE_R, Math.cos(t) * CIRCLE_R));
      solveIK(target, q, { useOrient: false, iters: 24, partial: true });
      poses.push(STATE.joints.map(j => j.a));
    }
    return poses;
  });
}

/* ---------------------------------------------------------------------------
   Lintasan lurus (rutin `line`). TCP menempuh garis lurus pada ketinggian
   TETAP, jadi kelurusannya bisa diukur dari luar dengan mistar atau garis
   laser tanpa perlu percaya pada satu pun sensor di lengan. Itu sebabnya
   rutin ini yang dipilih sebagai uji IK: kesalahan IK, kesalahan geometri,
   dan step yang hilang semuanya muncul sebagai simpangan dari satu garis
   yang bisa dilihat mata.

   Pose dihitung IK saat rutin dipilih (butuh scene graph), sehingga tidak bisa
   ikut diaudit verify_cad_rig.mjs; yang diaudit di sana adalah SEED-nya.
   Waypoint sengaja sedikit (default 5): tiap waypoint harus diverifikasi satu
   per satu oleh manusia, dan 33 titik seperti demo lingkaran tidak mungkin
   dijalani dengan cara itu.
   --------------------------------------------------------------------------- */
const AXIS_VEC = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

export function lineSteps({ seed, axis = 'z', span = 160, points = 5 }) {
  const dir = new THREE.Vector3(...AXIS_VEC[axis]);
  const poses = withPose(seed, () => {
    const c = getTCP().pos.clone(), q = getTCP().quat.clone();
    const out = [];
    for (let i = 0; i < points; i++) {
      const t = -span / 2 + span * (i / (points - 1));
      solveIK(c.clone().addScaledVector(dir, t), q, { useOrient: false, iters: 32, partial: true });
      out.push(STATE.joints.map(j => +j.a.toFixed(2)));
    }
    return out;
  });

  const half = span / 2;
  const steps = [{ a: [0, 0, 0, 0, 0, 0], label: 'home', note: 'titik awal, lengan tegak' }];
  poses.forEach((a, i) => {
    const t = -half + span * (i / (points - 1));
    steps.push({
      a,
      label: `titik ${i + 1} (${t >= 0 ? '+' : ''}${t.toFixed(0)} mm)`,
      note: i === 0
        ? 'ujung awal garis. Tandai posisi TCP di sini sebagai acuan.'
        : `TCP harus bergeser ${axis.toUpperCase()} saja, ketinggian tidak berubah.`,
      ...(i === 0 ? { warn: 'Perpindahan dari home ke ujung garis adalah gerak terbesar di rutin ini.' } : {}),
    });
  });
  steps.push({ a: [0, 0, 0, 0, 0, 0], label: 'home', note: 'kembali tegak' });
  return steps;
}

/* Demo 3D. Empat rutin hardware ada di urutan pertama supaya shortcut 1-4 di
   main.js memutar pratinjau rutin yang benar benar dipakai, bukan peragaan
   yang tidak pernah dikirim ke lengan. */
const routinePreview = (k, dt) => () => {
  const r = ROUTINES[k];
  const poses = r.dynamic === 'line'
    ? lineSteps(r.line).filter(s => s.a).map(s => s.a)
    : posesOf(r);
  loadKeyframes(keysFromPoses(poses, dt));
};

export const DEMOS = {
  'Pick & place': routinePreview('pickPlace', 1.1),
  'Repeat position': routinePreview('repeat', 1.2),
  'Showcase sendi': routinePreview('showcase', 1.0),
  'Lintasan lurus': routinePreview('line', 0.9),
  'Sapu penuh': () => loadKeyframes(keysFromPoses(DEMO_POSES.sweep, 1.3)),
  'Lingkaran (IK)': () => loadKeyframes(keysFromPoses(circlePoses(), 0.12)),
};
