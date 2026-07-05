/* ============================================================================
   Cycloidal drive + sub-assembly (motor NEMA17, servo MG996R, AS5600, belt).
   Diport dari legacy. Frame lokal: output axis = +Y.
   ========================================================================== */
import { THREE, M, cyl, ringMesh } from '../core/viewport.js';
import { CYC } from '../config/arm.js';

/* ---------------- cycloidal disk shape ---------------- */
export function diskShape(sc = 1) {
  const N = CYC.N, Rr = CYC.pinCircleR * sc, e = CYC.ecc * sc, Rp = CYC.pinR * sc;
  const steps = 360, pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps * Math.PI * 2;
    const x = Rr * Math.sin(t) + e * Math.sin(N * t), y = Rr * Math.cos(t) + e * Math.cos(N * t);
    const dx = Rr * Math.cos(t) + e * N * Math.cos(N * t), dy = -Rr * Math.sin(t) - e * N * Math.sin(N * t);
    const len = Math.hypot(dx, dy) || 1; let nx = dy / len, ny = -dx / len;
    if (nx * x + ny * y < 0) { nx = -nx; ny = -ny; }
    pts.push(new THREE.Vector2(x - nx * Rp, y - ny * Rp));
  }
  const sh = new THREE.Shape(pts);
  const bore = new THREE.Path(); bore.absarc(0, 0, CYC.bearOuter / 2 * sc, 0, Math.PI * 2, true); sh.holes.push(bore);
  for (let i = 0; i < CYC.outPinN; i++) {
    const ang = i / CYC.outPinN * Math.PI * 2, hx = Math.cos(ang) * CYC.outPinCircleR * sc, hy = Math.sin(ang) * CYC.outPinCircleR * sc;
    const h = new THREE.Path(); h.absarc(hx, hy, (CYC.outPinR + CYC.ecc + 0.4) * sc, 0, Math.PI * 2, true); sh.holes.push(h);
  }
  return sh;
}

/* ---------------- satu cycloidal drive lengkap ---------------- */
export function buildDrive(sc = 1, withMotor = true) {
  const g = new THREE.Group();
  const flangeT = CYC.flangeT * sc, ringH = CYC.ringH * sc, outerR = CYC.outerR * sc, pinR = CYC.pinR * sc;
  const layers = { motor: new THREE.Group(), housing: new THREE.Group(), disk: new THREE.Group(), hub: new THREE.Group() };

  if (withMotor) {
    const mb = 42.3 * sc, ml = 46 * sc;
    const body = new THREE.Mesh(new THREE.BoxGeometry(mb, ml, mb), M.motor);
    body.rotation.x = Math.PI / 2; body.position.y = -(flangeT + ml / 2 + 1 * sc);
    layers.motor.add(body);
    const boss = cyl(11 * sc, 11 * sc, 2 * sc, 24, M.steel); boss.position.y = -flangeT - 0.5 * sc; layers.motor.add(boss);
    const shaft = cyl(2.5 * sc, 2.5 * sc, flangeT + 10 * sc, 16, M.steel); shaft.position.y = (10 * sc - flangeT) / 2; layers.motor.add(shaft);
  }

  const flange = cyl(outerR, outerR, flangeT, 64, M.housing); flange.position.y = flangeT / 2; layers.housing.add(flange);
  const wallOuter = outerR, wallInner = (CYC.pinCircleR + CYC.pinR + 0.4) * sc;
  const ring = ringMesh(wallInner, wallOuter, ringH, M.housing); ring.position.y = flangeT + ringH / 2; layers.housing.add(ring);

  const pinGeo = new THREE.CylinderGeometry(pinR, pinR, ringH * 0.96, 12);
  const pins = new THREE.InstancedMesh(pinGeo, M.steel, CYC.N); const mtx = new THREE.Matrix4();
  for (let i = 0; i < CYC.N; i++) {
    const a = i / CYC.N * Math.PI * 2;
    mtx.makeTranslation(Math.cos(a) * CYC.pinCircleR * sc, flangeT + ringH / 2, Math.sin(a) * CYC.pinCircleR * sc);
    pins.setMatrixAt(i, mtx);
  }
  pins.instanceMatrix.needsUpdate = true; layers.housing.add(pins);

  const bear = ringMesh(CYC.bearInner / 2 * sc, CYC.bearOuter / 2 * sc, CYC.bearW * sc, M.steel);
  bear.position.y = flangeT + ringH * 0.5; layers.housing.add(bear);

  const shp = diskShape(sc);
  const dgeo = new THREE.ExtrudeGeometry(shp, { depth: CYC.diskT * sc, bevelEnabled: false, curveSegments: 24 });
  dgeo.rotateX(-Math.PI / 2);
  const d1 = new THREE.Mesh(dgeo, M.pla); d1.position.set(CYC.ecc * sc, flangeT + 0.3 * sc, 0); layers.disk.add(d1);
  if (CYC.dualDisk) {
    const d2 = new THREE.Mesh(dgeo, M.pla2);
    d2.position.set(-CYC.ecc * sc, flangeT + CYC.diskT * sc + CYC.diskGap * sc + 0.3 * sc, 0);
    d2.rotation.y = Math.PI / (CYC.N - 1); layers.disk.add(d2);
  }

  const hubR = (CYC.outPinCircleR + 5) * sc, hubT = 5 * sc, topY = flangeT + ringH;
  const hub = cyl(hubR, hubR, hubT, 48, M.pla2); hub.position.y = topY + hubT / 2; layers.hub.add(hub);
  const center = cyl(CYC.bearInner / 2 * sc + 1 * sc, CYC.bearInner / 2 * sc + 1 * sc, 3 * sc, 24, M.pla2);
  center.position.y = topY + hubT + 1 * sc; layers.hub.add(center);
  const dwGeo = new THREE.CylinderGeometry(CYC.outPinR * sc, CYC.outPinR * sc, ringH * 0.9, 14);
  const dw = new THREE.InstancedMesh(dwGeo, M.steel, CYC.outPinN); const m2 = new THREE.Matrix4();
  for (let i = 0; i < CYC.outPinN; i++) { const a = i / CYC.outPinN * Math.PI * 2; m2.makeTranslation(Math.cos(a) * CYC.outPinCircleR * sc, flangeT + ringH * 0.5, Math.sin(a) * CYC.outPinCircleR * sc); dw.setMatrixAt(i, m2); }
  dw.instanceMatrix.needsUpdate = true; layers.hub.add(dw);

  g.add(layers.motor, layers.housing, layers.disk, layers.hub);
  g.userData.layers = layers; g.userData.sc = sc; g.userData.topY = topY;
  return g;
}

/* ---------------- belt stage J1 ---------------- */
export function buildBelt() {
  const g = new THREE.Group();
  const bigR = 44, smR = 15;
  const big = cyl(bigR, bigR, 12, 40, M.pla); big.position.y = 6; g.add(big);
  const teeth = ringMesh(bigR - 3, bigR, 13, M.pla2); teeth.position.y = 6.5; g.add(teeth);
  const off = new THREE.Vector3(bigR + smR + 14, 0, 8);
  const mb = 42.3, ml = 46;
  const body = new THREE.Mesh(new THREE.BoxGeometry(mb, ml, mb), M.motor);
  body.rotation.x = Math.PI / 2; body.position.set(off.x, -ml / 2 - 2, off.z); g.add(body);
  const sm = cyl(smR, smR, 12, 28, M.steel); sm.position.set(off.x, 6, off.z); g.add(sm);
  for (const s of [1, -1]) {
    const dx = off.x, dz = off.z, len = Math.hypot(dx, dz), ang = Math.atan2(dz, dx);
    const belt = new THREE.Mesh(new THREE.BoxGeometry(len, 9, 2.4), M.belt);
    belt.position.set(dx / 2, 6, dz / 2); belt.rotation.y = -ang;
    const px = -Math.sin(ang) * s * (smR * 0.9), pz = Math.cos(ang) * s * (smR * 0.9);
    belt.position.x += px; belt.position.z += pz; g.add(belt);
  }
  g.userData.belt = true; return g;
}

/* ---------------- sub-assembly ---------------- */
export function buildNema(sc = 1, bodyLen = 40) {
  const g = new THREE.Group();
  const mb = 42.3 * sc, ml = bodyLen * sc;
  g.add(new THREE.Mesh(new THREE.BoxGeometry(mb, ml, mb), M.motor));
  const boss = cyl(11 * sc, 11 * sc, 2 * sc, 24, M.steel); boss.position.y = ml / 2 + 1 * sc; g.add(boss);
  const shaft = cyl(2.5 * sc, 2.5 * sc, 16 * sc, 16, M.steel); shaft.position.y = ml / 2 + 9 * sc; g.add(shaft);
  g.userData.len = ml; return g;
}
export function buildServo(sc = 1) {
  const g = new THREE.Group();
  const bw = 40.7 * sc, bd = 19.7 * sc, bh = 37 * sc;
  g.add(new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), M.servo));
  const tab = new THREE.Mesh(new THREE.BoxGeometry(bw + 15 * sc, 3 * sc, bd), M.servo); tab.position.y = bh * 0.16; g.add(tab);
  const boss = cyl(6 * sc, 6 * sc, 5 * sc, 20, M.servo); boss.position.set(bw * 0.27, bh / 2 + 2 * sc, 0); g.add(boss);
  const spline = cyl(2.8 * sc, 2.8 * sc, 5 * sc, 14, M.steel); spline.position.set(bw * 0.27, bh / 2 + 6 * sc, 0); g.add(spline);
  g.userData.out = new THREE.Vector3(bw * 0.27, bh / 2, 0); return g;
}
export function buildAS5600(sc = 1) {
  const g = new THREE.Group();
  const pcb = cyl(7 * sc, 7 * sc, 1.3 * sc, 6, M.pcb); g.add(pcb);
  const chip = new THREE.Mesh(new THREE.BoxGeometry(3 * sc, 1.1 * sc, 3 * sc), M.motor); chip.position.y = 1.1 * sc; g.add(chip);
  g.userData.sensor = true; return g;
}
export function beltAxial(len, r, axisDir) {
  const g = new THREE.Group();
  const mk = () => { const p = cyl(r, r, 7, 24, M.pla2); if (axisDir === 'x') p.rotation.z = Math.PI / 2; return p; };
  const p1 = mk(), p2 = mk(); p2.position.y = len; g.add(p1, p2);
  for (const s of [1, -1]) {
    const strand = new THREE.Mesh(new THREE.BoxGeometry(3, len, 3), M.belt); strand.position.y = len / 2;
    if (axisDir === 'x') strand.position.z = s * r; else strand.position.x = s * r;
    g.add(strand);
  }
  return g;
}

/* ---------------- orientasi ---------------- */
export function orientDrive(d, axisDir) {
  if (axisDir === 'x') { d.rotation.z = Math.PI / 2; }
  else if (axisDir === 'z') { d.rotation.x = -Math.PI / 2; }
}
export function orientPlate(m, axisDir) { if (axisDir === 'x') { m.rotation.z = Math.PI / 2; } }
export function orientPlate2(m, axisDir) { if (axisDir === 'x') m.rotation.z = -Math.PI / 2; else if (axisDir === 'z') m.rotation.x = Math.PI / 2; }
