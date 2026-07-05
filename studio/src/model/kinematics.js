/* ============================================================================
   Kinematics — FK pose, torsi gravitasi, wrist drift (port dari legacy) plus
   IK numerik damped-least-squares (baru) untuk jog Cartesian + TCP readout.
   ========================================================================== */
import { THREE, scene, camTarget } from '../core/viewport.js';
import { STATE, MOTORS, G, d2r, isServo } from '../config/arm.js';
import { world } from './arm.js';

export let lastTorques = [];
const listeners = new Set();
/** subscribe update kinematics (pose/torsi berubah). */
export function onUpdate(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { for (const fn of listeners) fn(); }

/* ---------------- FK ---------------- */
function setRotations() {
  for (const jr of world.jointRefs) {
    const a = jr.def.a * d2r;
    jr.pivot.rotation.set(0, 0, 0);
    if (jr.axis.x) jr.pivot.rotation.x = a;
    else if (jr.axis.z) jr.pivot.rotation.z = a;
    else jr.pivot.rotation.y = a;
  }
  scene.updateMatrixWorld(true);
}
export function applyPose() { setRotations(); computeTorques(); emit(); }

export function applyExplode() {
  const ex = STATE.explode;
  const drives = [];
  scene.traverse(o => { if (o.userData && o.userData.layers) drives.push(o); });
  for (const d of drives) {
    const L = d.userData.layers, sc = d.userData.sc || 1, s = 18 * sc;
    L.motor.position.y = -ex * s * 2.2; L.housing.position.y = 0;
    L.disk.position.y = ex * s * 1.2; L.hub.position.y = ex * s * 2.4;
  }
}

/* ---------------- torsi gravitasi ---------------- */
function isDescendant(node, anc) { let p = node; while (p) { if (p === anc) return true; p = p.parent; } return false; }
export function computeTorques() {
  const gvec = new THREE.Vector3(0, -G, 0);
  for (const n of world.massNodes) if (n.userData.payload) n.userData.mass = STATE.payload;
  const mp = world.massNodes.map(n => { const p = new THREE.Vector3(); n.getWorldPosition(p); return { p, m: n.userData.mass, node: n }; });
  lastTorques = [];
  for (const jr of world.jointRefs) {
    const jp = new THREE.Vector3(); jr.pivot.getWorldPosition(jp);
    const axisW = jr.axis.clone().applyQuaternion(jr.pivot.getWorldQuaternion(new THREE.Quaternion())).normalize();
    let tau = 0;
    for (const o of mp) {
      if (!isDescendant(o.node, jr.pivot)) continue;
      const r = o.p.clone().sub(jp).multiplyScalar(0.001);
      const F = gvec.clone().multiplyScalar(o.m);
      const mom = new THREE.Vector3().crossVectors(r, F);
      tau += mom.dot(axisW);
    }
    lastTorques.push(Math.abs(tau));
  }
  computeWristDrift();
}

export function computeWristDrift() {
  if (world.jointRefs.length < 6) { world.wristDrift = 0; return; }
  const L = [3, 4, 5].map(i => {
    const p = new THREE.Vector3(); world.jointRefs[i].pivot.getWorldPosition(p);
    const d = world.jointRefs[i].axis.clone().applyQuaternion(world.jointRefs[i].pivot.getWorldQuaternion(new THREE.Quaternion())).normalize();
    return { p, d };
  });
  const dd = (a, b) => {
    const n = new THREE.Vector3().crossVectors(a.d, b.d), nl = n.length();
    const w = new THREE.Vector3().subVectors(b.p, a.p);
    if (nl < 1e-6) return new THREE.Vector3().crossVectors(w, a.d).length();
    return Math.abs(w.dot(n)) / nl;
  };
  world.wristDrift = Math.max(dd(L[0], L[1]), dd(L[0], L[2]), dd(L[1], L[2]));
}

/* ---------------- torsi tersedia ---------------- */
export function haveTorque(j) {
  if (isServo(j)) return MOTORS[j.motor] * 0.45;
  const ratio = j.drive === 'servo' ? 15 : j.ratio;
  return MOTORS[j.motor] * 0.5 * ratio * STATE.eta;
}

/* ---------------- TCP readout ---------------- */
export function getTCP() {
  const pos = new THREE.Vector3(); const quat = new THREE.Quaternion();
  if (world.eeNode) { world.eeNode.getWorldPosition(pos); world.eeNode.getWorldQuaternion(quat); }
  const e = new THREE.Euler().setFromQuaternion(quat, 'XYZ');
  return {
    pos, quat,
    reach: Math.hypot(pos.x, pos.z), height: pos.y,
    rx: e.x / d2r, ry: e.y / d2r, rz: e.z / d2r,
  };
}

/** hitung posisi world EE untuk daftar set sudut (mm), lalu pulihkan pose. */
export function eePositionsFor(anglesList) {
  const saved = STATE.joints.map(j => j.a);
  const out = anglesList.map(a => {
    STATE.joints.forEach((j, i) => { j.a = a[i]; });
    setRotations();
    const p = new THREE.Vector3(); world.eeNode.getWorldPosition(p); return p;
  });
  STATE.joints.forEach((j, i) => { j.a = saved[i]; });
  setRotations();
  return out;
}

/* ============================================================================
   IK numerik — damped least squares dengan Jacobian numerik.
   Beroperasi langsung pada STATE.joints[i].a (derajat) memakai scene graph nyata
   sebagai FK. Dipakai jog Cartesian (translasi + orientasi TCP).
   ========================================================================== */
function fkEE() {
  setRotations();
  const p = new THREE.Vector3(); world.eeNode.getWorldPosition(p);
  const q = new THREE.Quaternion(); world.eeNode.getWorldQuaternion(q);
  return { p, q };
}
function orientErr(cur, target) {
  const qErr = target.clone().multiply(cur.clone().invert());
  if (qErr.w < 0) { qErr.x *= -1; qErr.y *= -1; qErr.z *= -1; qErr.w *= -1; }
  const ang = 2 * Math.acos(Math.min(1, qErr.w));
  const s = Math.sqrt(1 - Math.min(1, qErr.w * qErr.w));
  if (s < 1e-6 || ang < 1e-6) return new THREE.Vector3(0, 0, 0);
  return new THREE.Vector3(qErr.x, qErr.y, qErr.z).multiplyScalar(ang / s);
}
// solve A x = b (N x N) via Gaussian elimination with partial pivot
function matSolve(A, b) {
  const n = b.length; const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) M[c][c] = 1e-12;
    for (let r = 0; r < n; r++) { if (r === c) continue; const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}

const WR = 57.3; // bobot orientasi (rad -> ~mm-equiv)
/**
 * Gerakkan TCP ke target. Mengubah STATE.joints[*].a in place.
 * @returns {boolean} true jika konvergen dalam toleransi.
 */
export function solveIK(targetPos, targetQuat, { useOrient = true, iters = 24, tolPos = 0.4, partial = false } = {}) {
  const joints = STATE.joints;
  const saved = joints.map(j => j.a);
  const dq = 0.35; // derajat, untuk Jacobian numerik
  for (let it = 0; it < iters; it++) {
    const cur = fkEE();
    const ep = targetPos.clone().sub(cur.p);
    const eo = useOrient ? orientErr(cur.q, targetQuat).multiplyScalar(WR) : new THREE.Vector3();
    const err = useOrient ? [ep.x, ep.y, ep.z, eo.x, eo.y, eo.z] : [ep.x, ep.y, ep.z];
    const emag = Math.hypot(...err);
    if (!Number.isFinite(emag)) break;   // divergen -> pulihkan di bawah
    if (emag < tolPos) return true;
    const rows = err.length;
    // Jacobian numerik: kolom per joint
    const J = Array.from({ length: rows }, () => new Array(6).fill(0));
    for (let c = 0; c < 6; c++) {
      const base = joints[c].a; joints[c].a = base + dq;
      const f = fkEE();
      joints[c].a = base;
      const dp = f.p.clone().sub(cur.p).divideScalar(dq);
      J[0][c] = dp.x; J[1][c] = dp.y; J[2][c] = dp.z;
      if (useOrient) {
        const dr = orientErr(cur.q, f.q).multiplyScalar(-WR / dq); // d(err_o)/dq
        J[3][c] = dr.x; J[4][c] = dr.y; J[5][c] = dr.z;
      }
    }
    // DLS: dTheta = J^T (J J^T + lambda^2 I)^-1 err
    const lambda = 6.0;
    const JJt = Array.from({ length: rows }, () => new Array(rows).fill(0));
    for (let i = 0; i < rows; i++) for (let k = 0; k < rows; k++) { let s = 0; for (let c = 0; c < 6; c++) s += J[i][c] * J[k][c]; JJt[i][k] = s + (i === k ? lambda * lambda : 0); }
    const y = matSolve(JJt, err);
    if (y.some(v => !Number.isFinite(v))) break;   // JJt buruk kondisi -> stop, jangan corrupt
    const dTheta = new Array(6).fill(0);
    for (let c = 0; c < 6; c++) { let s = 0; for (let i = 0; i < rows; i++) s += J[i][c] * y[i]; dTheta[c] = s; }
    for (let c = 0; c < 6; c++) {
      const step = Math.max(-6, Math.min(6, dTheta[c]));   // clamp step
      if (!Number.isFinite(step)) continue;                // lindungi dari NaN/Inf (JJt singular)
      const v = Math.max(joints[c].min, Math.min(joints[c].max, joints[c].a + step));
      if (Number.isFinite(v)) joints[c].a = v;
    }
  }
  // safety: sanitasi per-joint (bukan revert total) supaya progress best-effort tetap terjaga
  joints.forEach((j, i) => { if (!Number.isFinite(j.a)) j.a = saved[i]; });
  const cur = fkEE();
  const ok = targetPos.clone().sub(cur.p).length() < 2.0;
  // partial: pertahankan hasil best-effort (untuk drag TCP / trace lingkaran).
  // non-partial (tombol jog): batalkan bila target di luar jangkauan agar tidak melompat.
  if (!ok && !partial) { joints.forEach((j, i) => j.a = saved[i]); return false; }
  return ok;
}

/** target = pose TCP sekarang + delta translasi world (mm) dan/atau delta rotasi world (deg). */
export function jogCartesian(dPos, dRotDeg) {
  const t = getTCP();
  const targetPos = t.pos.clone().add(dPos || new THREE.Vector3());
  let targetQuat = t.quat.clone();
  if (dRotDeg && (dRotDeg.x || dRotDeg.y || dRotDeg.z)) {
    const e = new THREE.Euler(dRotDeg.x * d2r, dRotDeg.y * d2r, dRotDeg.z * d2r, 'XYZ');
    const dq = new THREE.Quaternion().setFromEuler(e);
    targetQuat = dq.multiply(t.quat); // rotasi di frame world
  }
  const ok = solveIK(targetPos, targetQuat, { useOrient: true });
  applyPose();
  return ok;
}

export { camTarget };
