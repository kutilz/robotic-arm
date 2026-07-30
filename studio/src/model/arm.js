/* ============================================================================
   buildArm — FK hierarchy lengan 6-DOF. Diport dari legacy.
   Semua referensi node disimpan di `world` agar modul fitur (jog, inspector,
   timeline, path) bisa memakainya.
   ========================================================================== */
import { THREE, v3, M, cyl, makeLabel, scene } from '../core/viewport.js';
import { CYC, LINK, OFFS, STATE, MASSES } from '../config/arm.js';
import { SceneColors } from '../core/theme.js';
import {
  buildDrive, buildBelt, buildNema, buildServo, buildAS5600, beltAxial,
  orientDrive, orientPlate, orientPlate2,
} from './cycloidal.js';

export const world = {
  arm: null, jointRefs: [], massNodes: [], axisHelpers: [], dimGroup: null, eeNode: null,
  skelParts: [], wristAxisParts: [], regionObjs: [], anchorRefs: [], sweepGroup: null, wristDrift: 0,
};

export const ghostMat = new THREE.MeshStandardMaterial({ color: 0x5b6877, transparent: true, opacity: 0.16, roughness: .85, depthWrite: false });
export const sweepMat = new THREE.MeshBasicMaterial({ color: 0x7e9ab0, transparent: true, opacity: 0.10, depthWrite: false });

const SKEL = { link: 0x39c2e0, off: 0xf5a53c, col: 0x8fa3b8 };
const fmtOff = v => (v > 0 ? '+' : '') + v.toFixed(0);

function skelMat(color) { return new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: .95 }); }
function skelSeg(parent, a, b, color, label) {
  const v = new THREE.Vector3().subVectors(b, a), len = v.length(); if (len < 0.5) return;
  const m = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, len, 8), skelMat(color));
  m.position.copy(a).addScaledVector(v, 0.5);
  m.quaternion.setFromUnitVectors(v3(0, 1, 0), v.clone().normalize());
  m.renderOrder = 950; parent.add(m); world.skelParts.push(m);
  if (label) { const l = makeLabel(label, color === SKEL.off ? '#ffd18a' : color === SKEL.col ? '#b9c6d4' : '#aee9f7', 0.6); l.position.copy(a).addScaledVector(v, 0.5).add(v3(0, 10, 16)); parent.add(l); world.skelParts.push(l); }
}
function skelDot(parent, p) {
  const s = new THREE.Mesh(new THREE.SphereGeometry(3.4, 12, 12), skelMat(0xffffff));
  s.renderOrder = 951; s.position.copy(p); parent.add(s); world.skelParts.push(s);
}
function dogleg(pts, w, d, mat) {
  const g = new THREE.Group();
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], vv = new THREE.Vector3().subVectors(b, a), len = vv.length();
    if (len < 0.5) continue;
    const seg = new THREE.Mesh(new THREE.BoxGeometry(w, len, d), mat);
    seg.position.copy(a).addScaledVector(vv, 0.5);
    seg.quaternion.setFromUnitVectors(v3(0, 1, 0), vv.clone().normalize());
    g.add(seg);
  }
  for (let i = 1; i < pts.length - 1; i++) { const c = cyl(w * 0.55, w * 0.55, d, 20, mat); c.rotation.x = Math.PI / 2; c.position.copy(pts[i]); g.add(c); }
  return g;
}
function wristAxisLine(parent, a, b, color) {
  const v = new THREE.Vector3().subVectors(b, a), len = v.length();
  const m = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, len, 6), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: .8 }));
  m.position.copy(a).addScaledVector(v, 0.5);
  m.quaternion.setFromUnitVectors(v3(0, 1, 0), v.clone().normalize());
  m.renderOrder = 940; parent.add(m); world.wristAxisParts.push(m);
}
function beam(w, d, len, mat) {
  const g = new THREE.Group();
  const b = new THREE.Mesh(new THREE.BoxGeometry(w, len, d), mat); g.add(b);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(d * 0.5, d * 0.5, w, 18), mat);
  cap.rotation.z = Math.PI / 2; cap.position.y = len / 2; g.add(cap);
  const cap2 = cap.clone(); cap2.position.y = -len / 2; g.add(cap2);
  return g;
}
function addAxis(parent, axisLocal, text, color, len) {
  const dir = axisLocal.clone().normalize();
  const ar = new THREE.ArrowHelper(dir, new THREE.Vector3(0, 0, 0), len, color, len * 0.28, len * 0.16);
  const ar2 = new THREE.ArrowHelper(dir.clone().negate(), new THREE.Vector3(0, 0, 0), len * 0.55, color, len * 0.2, len * 0.12);
  parent.add(ar, ar2);
  const lab = makeLabel(text, '#cdeefa', 0.78); lab.position.copy(dir.clone().multiplyScalar(len + 22));
  parent.add(lab); world.axisHelpers.push(ar, ar2, lab);
}
function placeDrive(parent, axisDir, sc = 0.78, withMotor = true) {
  const d = buildDrive(sc, withMotor); orientDrive(d, axisDir);
  d.userData.role = 'fixed'; parent.add(d); parent.userData.drive = d;
}
function attachHub(pivot, axisDir, sc = 0.78) {
  const r = (CYC.outPinCircleR + 6) * sc; const hub = cyl(r, r, 4 * sc, 40, M.pla);
  orientPlate(hub, axisDir); pivot.add(hub); return hub;
}
function addSensor(anchor, pivot, axisDir, sc = 0.9, out = 18) {
  const dir = axisDir === 'x' ? new THREE.Vector3(1, 0, 0) : axisDir === 'z' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
  const s = buildAS5600(sc); orientPlate2(s, axisDir); s.position.copy(dir.clone().multiplyScalar(out)); anchor.add(s);
  const mag = cyl(3 * sc, 3 * sc, 1.5 * sc, 18, M.magnet); orientPlate2(mag, axisDir);
  mag.position.copy(dir.clone().multiplyScalar(out - 3.2 * sc)); pivot.add(mag);
  s.userData.isSensor = true;
}

function buildDims() {
  world.dimGroup = new THREE.Group(); world.arm.add(world.dimGroup);
  const wristEE = LINK.wrist + LINK.j6gap + LINK.ee;
  const segs = [[`upper arm ${LINK.upper}`, LINK.upper], [`forearm ${LINK.fore}`, LINK.fore], [`wrist->EE ${wristEE}`, wristEE]];
  let y = LINK.baseH + 14 + OFFS.colH;
  for (const [txt, L] of segs) { const lab = makeLabel(txt, '#9fb6c8', 0.7); lab.position.set(120, y + L / 2, 0); world.dimGroup.add(lab); y += L; }
  const reach = makeLabel('Sigma reach ~604 mm', '#7fe0f0', 0.78);
  reach.position.set(-160, LINK.baseH + 14 + OFFS.colH + 300, 0); world.dimGroup.add(reach);
}

export function buildArm() {
  if (world.arm) scene.remove(world.arm);
  world.jointRefs = []; world.massNodes = []; world.axisHelpers = []; world.skelParts = []; world.wristAxisParts = [];
  world.regionObjs = [[], [], [], [], [], []]; world.anchorRefs = []; world.sweepGroup = null;
  world.arm = new THREE.Group(); scene.add(world.arm);
  const oSh = OFFS.shoulder, oEl = OFFS.elbow, oFo = OFFS.fore, colH = OFFS.colH, fx = oEl + oFo;

  const ped = cyl(70, 82, LINK.baseH, 48, M.pla2); ped.position.y = LINK.baseH / 2; world.arm.add(ped);
  const plate = cyl(95, 95, 8, 48, M.motor); plate.position.y = 4; world.arm.add(plate);

  // J1 yaw (belt HTD3M 2-stage)
  const j1fix = new THREE.Group(); j1fix.position.y = LINK.baseH; world.arm.add(j1fix);
  const belt = buildBelt(); j1fix.add(belt);
  const j1 = new THREE.Group(); j1.position.y = LINK.baseH + 14; world.arm.add(j1);
  world.jointRefs.push({ def: STATE.joints[0], pivot: j1, axis: new THREE.Vector3(0, 1, 0) });
  addAxis(j1fix, new THREE.Vector3(0, 1, 0), 'J1·yaw', SceneColors.axisY, 60);
  addSensor(j1fix, j1, 'y', 0.95, 18);
  world.anchorRefs.push({ g: j1fix, axis: 'y', type: 'belt' });
  world.regionObjs[0].push(j1fix);

  const shLink = dogleg([v3(0, 0, 0), v3(0, colH, 0), v3(oSh, colH, 0)], 34, 34, M.link); j1.add(shLink);
  skelSeg(j1, v3(0, 0, 0), v3(0, colH, 0), SKEL.col, `kolom ${colH.toFixed(0)}`);
  skelSeg(j1, v3(0, colH, 0), v3(oSh, colH, 0), SKEL.off, `shoulder ${fmtOff(oSh)}`);
  skelDot(j1, v3(0, 0, 0)); skelDot(j1, v3(oSh, colH, 0));

  // J2 shoulder pitch (cycloidal direct, 17HS6401S)
  const j2anchor = new THREE.Group(); j2anchor.position.set(oSh, colH, 0); j1.add(j2anchor);
  placeDrive(j2anchor, 'x', 0.85, true);
  const j2 = new THREE.Group(); j2.position.set(oSh, colH, 0); j1.add(j2);
  world.jointRefs.push({ def: STATE.joints[1], pivot: j2, axis: new THREE.Vector3(1, 0, 0) });
  addAxis(j2anchor, new THREE.Vector3(1, 0, 0), 'J2·pitch', SceneColors.axisX, 78);
  const hub2 = attachHub(j2, 'x', 0.85);
  addSensor(j2anchor, j2, 'x', 0.95, 34);
  world.anchorRefs.push({ g: j2anchor, axis: 'x', sc: 0.85, type: 'cyc', motor: true });

  const upper = beam(40, 30, LINK.upper, M.link); upper.position.y = LINK.upper / 2; j2.add(upper);
  skelSeg(j2, v3(0, 0, 0), v3(0, LINK.upper, 0), SKEL.link, `upper ${LINK.upper}`);
  world.regionObjs[1].push(shLink, j2anchor, hub2, upper);

  const j3motor = buildNema(0.62, 40); j3motor.rotation.z = -Math.PI / 2; j3motor.position.set(0, 72, -30); j2.add(j3motor);
  const j3belt = beltAxial(LINK.upper - 72, 9, 'x'); j3belt.position.set(0, 72, -30); j2.add(j3belt);

  // J3 elbow pitch (cyc belt-driven)
  const j3anchor = new THREE.Group(); j3anchor.position.y = LINK.upper; j2.add(j3anchor);
  placeDrive(j3anchor, 'x', 0.7, false);
  const j3 = new THREE.Group(); j3.position.y = LINK.upper; j2.add(j3);
  world.jointRefs.push({ def: STATE.joints[2], pivot: j3, axis: new THREE.Vector3(1, 0, 0) });
  addAxis(j3anchor, new THREE.Vector3(1, 0, 0), 'J3·pitch', SceneColors.axisX, 62);
  const hub3 = attachHub(j3, 'x', 0.7);
  addSensor(j3anchor, j3, 'x', 0.9, 28);
  world.anchorRefs.push({ g: j3anchor, axis: 'x', sc: 0.7, type: 'cyc', motor: false });

  const elbowBridge = dogleg([v3(0, 0, 0), v3(oEl, 0, 0), v3(fx, 0, 0)], 30, 30, M.link); j3.add(elbowBridge);
  skelSeg(j3, v3(0, 0, 0), v3(oEl, 0, 0), SKEL.off, `elbow ${fmtOff(oEl)}`);
  if (Math.abs(oFo) > 0.5) skelSeg(j3, v3(oEl, 0, 0), v3(fx, 0, 0), SKEL.off, `fore ${fmtOff(oFo)}`);
  skelDot(j3, v3(0, 0, 0)); skelDot(j3, v3(fx, 0, 0));
  world.regionObjs[2].push(j3motor, j3belt, j3anchor, hub3, upper, elbowBridge);

  // J4 forearm roll (cyc @ elbow)
  const j4anchor = new THREE.Group(); j4anchor.position.x = fx; j3.add(j4anchor);
  placeDrive(j4anchor, 'y', 0.55, true);
  const j4 = new THREE.Group(); j4.position.x = fx; j3.add(j4);
  world.jointRefs.push({ def: STATE.joints[3], pivot: j4, axis: new THREE.Vector3(0, 1, 0) });
  addAxis(j4anchor, new THREE.Vector3(0, 1, 0), 'J4·roll', SceneColors.axisRY, 46);
  const hub4 = attachHub(j4, 'y', 0.55);
  addSensor(j4anchor, j4, 'y', 0.85, 26);
  world.anchorRefs.push({ g: j4anchor, axis: 'y', sc: 0.55, type: 'cyc', motor: true });

  const fore = beam(34, 26, LINK.fore, M.link); fore.position.y = LINK.fore / 2; j4.add(fore);
  skelSeg(j4, v3(0, 0, 0), v3(0, LINK.fore, 0), SKEL.link, `forearm ${LINK.fore}`);
  world.regionObjs[3].push(elbowBridge, j4anchor, hub4, fore);

  const wristY = LINK.fore;
  const wristStub = beam(24, 20, LINK.wrist, M.link); wristStub.position.y = wristY + LINK.wrist / 2; j4.add(wristStub);

  // J5 wrist pitch (MG996R servo direct; feedback = pot internal servo lewat
  // ADC1 ESP32, jadi TIDAK ada AS5600 fisik di sini -> tanpa addSensor)
  const j5anchor = new THREE.Group(); j5anchor.position.set(0, wristY + LINK.wrist, OFFS.w5); j4.add(j5anchor);
  const j5servo = buildServo(0.85); orientDrive(j5servo, 'x'); j5servo.position.set(0, 0, -6); j5anchor.add(j5servo);
  const j5 = new THREE.Group(); j5.position.set(0, wristY + LINK.wrist, OFFS.w5); j4.add(j5);
  world.jointRefs.push({ def: STATE.joints[4], pivot: j5, axis: new THREE.Vector3(1, 0, 0) });
  addAxis(j5anchor, new THREE.Vector3(1, 0, 0), 'J5·pitch', SceneColors.axisX, 40);
  const hub5 = attachHub(j5, 'x', 0.5);
  world.anchorRefs.push({ g: j5anchor, axis: 'x', type: 'servo' });
  if (Math.abs(OFFS.w5) > 0.5) skelSeg(j4, v3(0, wristY + LINK.wrist, 0), v3(0, wristY + LINK.wrist, OFFS.w5), SKEL.off, `w5 ${fmtOff(OFFS.w5)} !`);
  world.regionObjs[4].push(fore, wristStub, j5anchor, hub5);

  // J6 end roll (MG996R servo direct; feedback pot internal, tanpa AS5600)
  const j6anchor = new THREE.Group(); j6anchor.position.set(OFFS.w6, LINK.j6gap, 0); j5.add(j6anchor);
  const j6servo = buildServo(0.8); orientDrive(j6servo, 'y'); j6servo.position.set(0, 0, 0); j6anchor.add(j6servo);
  const j6 = new THREE.Group(); j6.position.set(OFFS.w6, LINK.j6gap, 0); j5.add(j6);
  world.jointRefs.push({ def: STATE.joints[5], pivot: j6, axis: new THREE.Vector3(0, 1, 0) });
  addAxis(j6anchor, new THREE.Vector3(0, 1, 0), 'J6·roll', SceneColors.axisRY, 34);
  const hub6 = attachHub(j6, 'y', 0.45);
  world.anchorRefs.push({ g: j6anchor, axis: 'y', type: 'servo' });
  if (Math.abs(OFFS.w6) > 0.5) skelSeg(j5, v3(0, LINK.j6gap, 0), v3(OFFS.w6, LINK.j6gap, 0), SKEL.off, `w6 ${fmtOff(OFFS.w6)} !`);

  skelSeg(j4, v3(0, wristY, 0), v3(0, wristY + LINK.wrist, 0), SKEL.link, null);
  skelSeg(j5, v3(0, 0, 0), v3(OFFS.w6, LINK.j6gap, 0), SKEL.link, null);
  skelDot(j5, v3(0, 0, 0));

  wristAxisLine(j4, v3(0, wristY - 70, 0), v3(0, wristY + LINK.wrist + 95, 0), SceneColors.axisX);
  wristAxisLine(j5, v3(-90, 0, 0), v3(90, 0, 0), SceneColors.axisY);
  wristAxisLine(j6, v3(0, -75, 0), v3(0, 85, 0), SceneColors.warn);

  world.eeNode = new THREE.Group(); world.eeNode.position.y = LINK.ee - 32; j6.add(world.eeNode);
  const fl = cyl(16, 16, 6, 28, M.pla2); world.eeNode.add(fl);
  for (const s of [1, -1]) { const f = beam(5, 8, 30, M.pla); f.position.set(s * 8, 18, 0); world.eeNode.add(f); }
  skelSeg(j6, v3(0, 0, 0), v3(0, LINK.ee - 32, 0), SKEL.link, `wrist->EE ${LINK.wrist + LINK.j6gap + LINK.ee}`);
  world.regionObjs[5].push(j6anchor, hub6, world.eeNode);

  const pivots = [j1, j2, j3, j4, j5, j6];
  for (const mm of MASSES) {
    const node = new THREE.Group(); node.position.y = mm.along; pivots[mm.joint].add(node);
    node.userData = { mass: mm.m, label: mm.label, key: mm.label };
    if (mm.label === 'payload') node.userData.payload = true;
    const dot = new THREE.Mesh(new THREE.SphereGeometry(9, 16, 16), new THREE.MeshStandardMaterial({ color: 0xf06c5e, emissive: 0x3a0d08, roughness: .5 }));
    node.add(dot); node.userData.dot = dot; dot.visible = false;
    world.massNodes.push(node);
  }

  buildDims();
}
