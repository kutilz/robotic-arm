/* ============================================================================
   DATA / MODEL — sinkron dengan docs/research/arsitektur_final_robotic_arm_6dof.md
   (Pre-CAD, terkunci): payload 0.2 kg, reach 600 mm, J2 cycloidal DIRECT 17HS6401,
   J3/J4 motor relokasi proximal + belt HTD3M, J5/J6 MG996R servo, AS5600 di output
   tiap joint. Diekstrak dari studio/legacy/index.html tanpa mengubah nilai.
   ========================================================================== */

// Cycloidal geometry defaults — representative of the J2-class drive (pin-circle ~30 mm)
export const CYC = {
  N: 25,             // ring pin count -> reduction N:1, lobes = N-1
  pinCircleR: 30,    // pin circle dia 60 / 2 (J2 upsized 28-30mm untuk angkat ceiling PLA+)
  pinR: 1.6,         // Ø3 steel dowel roller / 2
  ecc: 1.0,          // eccentricity
  diskT: 6,          // disk thickness
  flangeT: 5,        // flange thickness
  wallT: 2,          // wall thickness
  dualDisk: true,
  diskGap: 1.0,
  outPinN: 6,
  outPinR: 2.5,      // output dowel 5 / 2
  outPinCircleR: 18, // output pin circle dia 36 / 2
  bearOuter: 14, bearInner: 7, bearW: 5, // 6700 thin eccentric bearing
};
/** hitung ulang nilai turunan CYC (dipanggil setelah slider geometry berubah). */
export function recalcCyc() {
  CYC.outerR = CYC.pinCircleR + CYC.pinR + CYC.wallT;              // ~33.6
  CYC.ringH = CYC.dualDisk ? (2 * CYC.diskT + CYC.diskGap) : CYC.diskT; // 13
  CYC.housingH = CYC.flangeT + CYC.ringH;                         // 18
}
recalcCyc();

// link segments (mm) — anthropomorphic 600mm split (LOCKED)
export const LINK = { upper: 280, fore: 230, wrist: 14, j6gap: 14, ee: 62, baseH: 140 };
// reach (J2->tip) = upper 280 + forearm 230 + wrist->EE (14+14+62 = 90) = 600

// parametric packaging offsets (mm) — research §5
export const OFFS = { colH: 120, shoulder: 35, elbow: -50, fore: 0, w5: 0, w6: 0 };
export const OFFS_RESEARCH = { colH: 120, shoulder: 35, elbow: -50, fore: 0, w5: 0, w6: 0 };
export const OFFS_SEARAH = { colH: 120, shoulder: 35, elbow: 50, fore: 0, w5: 0, w6: 0 };
export const OFFS_LAMA = { colH: 64, shoulder: 30, elbow: -26, fore: 0, w5: 0, w6: 0 };

// actuator catalogue: holding/stall torque (N·m). steppers: running = 0.5*holding.
export const MOTORS = {
  '17HS4401': 0.45,        // NEMA17 40mm — J1, J3
  '17HS6401': 0.60,        // NEMA17 60mm — J2
  '17PM-K054': 0.27,       // Minebea 226g — J4
  'MG996R (servo)': 1.08,  // stall @6V — J5/J6
};

// joint definitions. axis: Y up. pitch=X, roll=Y, yaw=Y.
// drive: belt | cyc | cyc-belt | servo
export const JDEF = [
  { id: 'J1', name: 'Base yaw',    kind: 'yaw',   drive: 'belt',     motor: '17HS4401',       ratio: 20, min: -180, max: 180, a: 0, target: 3 },
  { id: 'J2', name: 'Shoulder',    kind: 'pitch', drive: 'cyc',      motor: '17HS6401',       ratio: 45, min: -95,  max: 95,  a: 0, target: 12 },
  { id: 'J3', name: 'Elbow',       kind: 'pitch', drive: 'cyc-belt', motor: '17HS4401',       ratio: 25, min: -150, max: 150, a: 0, target: 3.8 },
  { id: 'J4', name: 'Wrist roll',  kind: 'roll',  drive: 'cyc',      motor: '17PM-K054',      ratio: 15, min: -180, max: 180, a: 0, target: 1 },
  { id: 'J5', name: 'Wrist pitch', kind: 'pitch', drive: 'servo',    motor: 'MG996R (servo)', ratio: 1,  min: -120, max: 120, a: 0, target: 0.65 },
  { id: 'J6', name: 'End roll',    kind: 'roll',  drive: 'servo',    motor: 'MG996R (servo)', ratio: 1,  min: -180, max: 180, a: 0, target: 0.3 },
];

// lumped masses (kg) + attach joint (0-based) + jarak sepanjang link pivot (mm).
export const MASSES = [
  { label: 'upper-arm link',          m: 0.18,  joint: 1, along: 140 },
  { label: 'J3 motor (proximal)',     m: 0.28,  joint: 1, along: 80 },
  { label: 'elbow cycloidal',         m: 0.15,  joint: 2, along: 0 },
  { label: 'J4 motor (proximal)',     m: 0.226, joint: 2, along: 30 },
  { label: 'J4 cycloidal',            m: 0.10,  joint: 2, along: 10 },
  { label: 'forearm link',            m: 0.12,  joint: 2, along: 115 },
  { label: 'J5 servo + roll housing', m: 0.12,  joint: 3, along: 244 },
  { label: 'J6 servo + EE struct',    m: 0.13,  joint: 4, along: 50 },
  { label: 'payload',                 m: 0.20,  joint: 5, along: 62 },
];

export const G = 9.81;
export const d2r = Math.PI / 180;

// printed-PLA+ cycloidal torque ceiling (~13 N·m @ 22mm pin circle), skala ~pin circle
export function plaCeiling() { return 13 * (CYC.pinCircleR / 22); }

// preset pose [J1..J6] derajat; payload (kg) opsional ikut di-set
export const POSE_PRESETS = [
  { name: 'Home',       full: 'Home (up)',             angles: [0, 0, 0, 0, 0, 0] },
  { name: 'Horizontal', full: 'Horizontal worst-case', angles: [0, 90, 0, 0, 0, 0],   payload: 0.20 },
  { name: 'Reach fwd',  full: 'Reach forward',         angles: [0, 60, 60, 0, 30, 0], payload: 0.10 },
  { name: 'Folded',     full: 'Folded / park',         angles: [0, -80, 140, 0, 60, 0] },
  { name: 'Pick low',   full: 'Pick low',              angles: [30, 75, 40, 0, 55, 0], payload: 0.10 },
];

/** state aplikasi bersama (satu instance, di-share antar modul). */
export const STATE = {
  mode: 'arm', explode: 0, payload: 0.20, eta: 0.75, sf: 2.5, plaCeil: plaCeiling(),
  estop: false, engineering: false,
  show: { axes: true, masses: false, dims: false, skeleton: true, xray: false, wristAxes: true, sweep: false },
  joints: JDEF.map(j => ({ ...j })),
};

export function isServo(j) { return /MG996R|servo/i.test(j.motor); }
