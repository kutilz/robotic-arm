/* ============================================================================
   Inspector: mode (arm/offsets/drive), offset-focus per joint (ghost + envelope),
   sweep ghost J3, inspect-drive scene, dan rebuild. Port dari legacy.
   ========================================================================== */
import { THREE, scene, cam, camTarget, applyCam, M, cyl, makeLabel } from '../core/viewport.js';
import { CYC, OFFS, STATE, d2r } from '../config/arm.js';
import { world, buildArm, ghostMat, sweepMat } from '../model/arm.js';
import { applyPose, applyExplode } from '../model/kinematics.js';
import { buildDrive, orientDrive } from '../model/cycloidal.js';

const fmtOff = v => (v > 0 ? '+' : '') + v.toFixed(0);
let inspectGroup = null;
let focusI = -1, savedMats = null, envGroup = null;
const focusListeners = new Set();
export function onFocusChange(fn) { focusListeners.add(fn); return () => focusListeners.delete(fn); }
export function getFocus() { return focusI; }

/* ---------------- inspect-drive scene ---------------- */
export function buildInspect() {
  if (inspectGroup) scene.remove(inspectGroup);
  inspectGroup = new THREE.Group(); inspectGroup.position.y = 180; scene.add(inspectGroup);
  const d = buildDrive(2.4, true); inspectGroup.add(d); inspectGroup.userData.drive = d;
  const sc = 2.4, topY = CYC.housingH * sc;
  const labs = [
    ['NEMA stepper (direct/belt input)', new THREE.Vector3(150, -CYC.flangeT * sc - 46 * sc, 0), '#9fb6c8'],
    ['base / flange', new THREE.Vector3(150, CYC.flangeT * sc * 0.5, 0), '#e0a96d'],
    [CYC.N + ' steel ring pins (Ø3 dowel)', new THREE.Vector3(150, CYC.flangeT * sc + CYC.ringH * sc * 0.5, 0), '#b9c2cb'],
    ['cycloidal disk ×2 (' + (CYC.N - 1) + ' lobes, PLA+)', new THREE.Vector3(-160, CYC.flangeT * sc + CYC.ringH * sc * 0.5, 0), '#e08a3c'],
    ['eccentric bearing 6700', new THREE.Vector3(0, CYC.flangeT * sc + CYC.ringH * sc + 30, 0), '#b9c2cb'],
    ['output hub + ' + CYC.outPinN + ' dowels -> AS5600', new THREE.Vector3(150, topY + 30, 0), '#cf9a5e'],
  ];
  for (const [t, p, c] of labs) { const l = makeLabel(t, c, 0.95); l.position.copy(p); inspectGroup.add(l); }
  inspectGroup.visible = (STATE.mode === 'drive');
}

/* ---------------- visibility ---------------- */
export function setXray(on) {
  for (const k in M) { M[k].transparent = on; M[k].opacity = on ? 0.22 : 1; M[k].depthWrite = !on; M[k].needsUpdate = true; }
}
export function refreshVisToggles() {
  for (const n of world.massNodes) if (n.userData.dot) n.userData.dot.visible = STATE.show.masses;
  if (world.dimGroup) world.dimGroup.visible = (STATE.mode !== 'drive' && STATE.show.dims);
  for (const a of world.axisHelpers) a.visible = (STATE.show.axes && STATE.mode !== 'drive');
  for (const s of world.skelParts) s.visible = (STATE.show.skeleton && STATE.mode !== 'drive');
  for (const w of world.wristAxisParts) w.visible = (STATE.show.wristAxes && STATE.mode !== 'drive');
  if (world.sweepGroup) world.sweepGroup.visible = (STATE.show.sweep && STATE.mode !== 'drive');
  setXray(STATE.show.xray);
}

/* ---------------- offset focus ---------------- */
function offsetInfo(i) {
  const O = OFFS;
  return [
    ['J1 base yaw: belt HTD3M 2-stage di base', 'keluar: kolom vertikal ' + O.colH.toFixed(0) + ' mm ke J2'],
    ['J2 shoulder: lekukan #1', 'kolom ' + O.colH.toFixed(0) + ' mm naik, lateral ' + fmtOff(O.shoulder) + ' mm (sumbu pitch X)', 'clearance body cycloidal + motor 60mm coaxial'],
    ['J3 elbow: lekukan #2', 'lateral elbow ' + fmtOff(O.elbow) + ' mm dari centerline upper-arm', 'motor J3 remote di pangkal, belt naik ke sini'],
    ['J4 forearm roll', 'inset ' + fmtOff(O.fore) + ' mm dari bridge elbow ke sumbu roll', 'sumbu roll = centerline forearm'],
    ['J5 wrist pitch: MG996R', 'off-axis w5 = ' + fmtOff(O.w5) + ' mm (WAJIB 0)', 'wrist concurrent = syarat closed-form IK'],
    ['J6 end roll: MG996R', 'off-axis w6 = ' + fmtOff(O.w6) + ' mm (WAJIB 0)', 'offset flange boleh SETELAH J6, bukan antar sumbu wrist'],
  ][i];
}
function buildEnvelope(i) {
  const a = world.anchorRefs[i]; if (!a) return null;
  const wrap = new THREE.Group();
  const wire = new THREE.MeshBasicMaterial({ color: 0x38bdf8, wireframe: true, transparent: true, opacity: 0.25 });
  const g = new THREE.Group();
  if (a.type === 'cyc') {
    const sc = a.sc, rr = CYC.outerR * sc + 4;
    const body = cyl(rr, rr, CYC.housingH * sc + 12, 32, wire); body.position.y = CYC.housingH * sc * 0.5; g.add(body);
    if (a.motor) { const mL = 46 * sc + 8; const mbx = new THREE.Mesh(new THREE.BoxGeometry(42.3 * sc + 8, mL, 42.3 * sc + 8), wire); mbx.position.y = -(CYC.flangeT * sc + mL / 2); g.add(mbx); }
  } else if (a.type === 'servo') {
    g.add(new THREE.Mesh(new THREE.BoxGeometry(48, 45, 28), wire));
  } else {
    const c = cyl(66, 66, 34, 32, wire); c.position.y = 6; g.add(c);
    const mbx = new THREE.Mesh(new THREE.BoxGeometry(52, 58, 52), wire); mbx.position.set(73, -27, 8); g.add(mbx);
  }
  orientDrive(g, a.axis); wrap.add(g);
  const info = offsetInfo(i);
  info.forEach((t, k) => { const l = makeLabel(t, k === 0 ? '#7fe0f0' : '#c3d2df', 0.72); l.position.set(0, 120 + (info.length - 1 - k) * 26, 0); wrap.add(l); });
  a.g.add(wrap); return wrap;
}
export function clearFocus() {
  if (savedMats) { for (const [o, mat] of savedMats) o.material = mat; savedMats = null; }
  if (envGroup && envGroup.parent) envGroup.parent.remove(envGroup);
  envGroup = null; focusI = -1; for (const fn of focusListeners) fn(-1);
}
export function focusJoint(i) {
  clearFocus(); focusI = i;
  const keep = new Set();
  for (const o of world.regionObjs[i]) o.traverse(x => keep.add(x));
  for (const s of world.skelParts) keep.add(s);
  for (const w of world.wristAxisParts) keep.add(w);
  savedMats = [];
  world.arm.traverse(o => { if ((o.isMesh || o.isInstancedMesh) && !keep.has(o)) { savedMats.push([o, o.material]); o.material = ghostMat; } });
  const p = new THREE.Vector3(); world.jointRefs[i].pivot.getWorldPosition(p);
  camTarget.copy(p); camTarget.y += 40; cam.rad = (i === 0 ? 600 : i === 1 ? 480 : 440); applyCam();
  envGroup = buildEnvelope(i);
  for (const fn of focusListeners) fn(i);
}

/* ---------------- sweep ghost J3 ---------------- */
export function rebuildSweep() {
  if (world.sweepGroup && world.sweepGroup.parent) world.sweepGroup.parent.remove(world.sweepGroup);
  world.sweepGroup = null;
  if (!STATE.show.sweep || world.jointRefs.length < 3) return;
  const j3p = world.jointRefs[2].pivot, parent = j3p.parent;
  const sg = new THREE.Group(); sg.position.copy(j3p.position); parent.add(sg);
  for (const ang of [-120, -60, 60, 120]) {
    const c = j3p.clone(true); c.position.set(0, 0, 0); c.rotation.set(ang * d2r, 0, 0);
    c.traverse(o => { if (o.isSprite) o.visible = false; else if (o.isMesh || o.isInstancedMesh) { o.material = sweepMat; o.renderOrder = 0; } });
    sg.add(c);
  }
  sg.visible = (STATE.show.sweep && STATE.mode !== 'drive');
  world.sweepGroup = sg;
}

/* ---------------- rebuild ---------------- */
export function rebuildArmOnly() {
  savedMats = null; envGroup = null;
  const fi = (STATE.mode === 'offsets') ? focusI : -1;
  focusI = -1;
  buildArm(); applyPose(); applyExplode(); rebuildSweep();
  if (fi >= 0) focusJoint(fi);
}
export function rebuildGeo() {
  buildInspect(); rebuildArmOnly();
  world.arm.visible = (STATE.mode !== 'drive');
}

/* ---------------- mode ---------------- */
export function setMode(m) {
  STATE.mode = m;
  document.querySelectorAll('#modePill button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
  world.arm.visible = (m !== 'drive');
  if (inspectGroup) inspectGroup.visible = (m === 'drive');
  if (m !== 'offsets') clearFocus();
  if (m === 'drive') { camTarget.set(0, 260, 0); cam.rad = 620; }
  else if (m === 'arm') { camTarget.set(0, 360, 0); cam.rad = 1500; }
  else if (focusI < 0) { focusJoint(1); }
  applyCam(); applyExplode(); refreshVisToggles();
}
