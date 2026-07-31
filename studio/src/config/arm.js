/* ============================================================================
   DATA / MODEL: geometri & rasio DIUKUR dari CAD (Testing Assembly.step,
   rev FINAL 2026-07-30); payload 0.2 kg, reach ~649 mm dari J2.
   Drivetrain FINAL: J1 belt HTD3M 2 stage 1:15 (17HS2401), J2 cycloidal DIRECT
   1:30 (17HS6401S), J3 belt 3:1 + cycloidal 1:10 = 1:30 (17HS2401),
   J4 cycloidal 1:15 (17HS2401, terkonfirmasi CAD), J5/J6 MG996R servo direct.
   Feedback: AS5600 di output J1..J4 (mux TCA9548A ch 0-3); J5/J6 pot internal
   servo -> ADC1 ESP32, tanpa mux. Faktor sizing & massa dari
   docs/research/arsitektur_final_robotic_arm_6dof.md. Sinkron src/arm/config.py.
   ========================================================================== */

// Cycloidal geometry: terukur dari drive J2 di STEP (30 pin Ø5, pin circle Ø76)
export const CYC = {
  N: 30,             // ring pin count J2 -> reduction 1:30, lobes = N-1
  pinCircleR: 38,    // pin circle dia 76 / 2 (terukur CAD J2)
  pinR: 2.5,         // Ø5 steel dowel roller / 2 (terukur CAD)
  ecc: 1.1,          // eccentricity (terukur CAD J2)
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

// link segments (mm), TERUKUR CAD: upper a2=288.0, forearm d4=270, wrist->EE d6=90.6
// wrist + j6gap + ee = 90 mm supaya rantai visual sama panjang dengan d6.
export const LINK = { upper: 288, fore: 270, wrist: 14, j6gap: 14, ee: 62, baseH: 140 };
// reach (J2->tip) = a2 288 + d4 270 + d6 90.6 = ~649 mm (a3 = 0, sumbu J3 & J4
// berpotongan di CAD final; dulu a3 50 mm bikin reach ~604 mm)

// parametric packaging offsets (mm), TERUKUR CAD: shoulder a1=65.9, elbow a3=0
// (d1 base = 64.8 mm, base visual masih artistik menunggu impor mesh STEP)
export const OFFS = { colH: 120, shoulder: 66, elbow: 0, fore: 0, w5: 0, w6: 0 };
export const OFFS_RESEARCH = { colH: 120, shoulder: 66, elbow: -50, fore: 0, w5: 0, w6: 0 };
export const OFFS_SEARAH = { colH: 120, shoulder: 35, elbow: 50, fore: 0, w5: 0, w6: 0 };
export const OFFS_LAMA = { colH: 64, shoulder: 30, elbow: -26, fore: 0, w5: 0, w6: 0 };

// actuator catalogue FINAL: holding/stall torque (N·m). steppers: running =
// 0.5*holding. Key HARUS sama persis dengan MOTORS di src/arm/config.py.
export const MOTORS = {
  '17HS2401': 0.45,   // NEMA17 40mm, 1.7 A, J1, J3, J4
  '17HS6401S': 0.70,  // NEMA17 60mm, 2.0 A, J2
  'MG996R': 1.08,     // stall @6V, J5/J6
};

// tipe umpan balik posisi (selaras ENC_* di src/arm/config.py)
export const FB_AS5600 = 'as5600';       // magnetik absolut di output sendi
export const FB_SERVO_POT = 'servo_pot'; // pot internal servo -> ADC1 ESP32

// joint definitions. axis: Y up. pitch=X, roll=Y, yaw=Y.
// drive: belt | cyc | cyc-belt | servo
// ratio: reduksi total drivetrain FINAL (lihat header).
// fb/encChan: tipe umpan balik + channel mux TCA9548A (null = tanpa mux).
// target: torsi output yang dibutuhkan (N·m), selaras torque.py.
export const JDEF = [
  { id: 'J1', name: 'Base yaw',    kind: 'yaw',   drive: 'belt',     motor: '17HS2401',  ratio: 15, min: -180, max: 180, a: 0, target: 3,     fb: FB_AS5600,    encChan: 0 },
  { id: 'J2', name: 'Shoulder',    kind: 'pitch', drive: 'cyc',      motor: '17HS6401S', ratio: 30, min: -95,  max: 95,  a: 0, target: 12.78, fb: FB_AS5600,    encChan: 1 },
  { id: 'J3', name: 'Elbow',       kind: 'pitch', drive: 'cyc-belt', motor: '17HS2401',  ratio: 30, min: -150, max: 150, a: 0, target: 4.19,  fb: FB_AS5600,    encChan: 2 },
  { id: 'J4', name: 'Wrist roll',  kind: 'roll',  drive: 'cyc',      motor: '17HS2401',  ratio: 15, min: -180, max: 180, a: 0, target: 1,     fb: FB_AS5600,    encChan: 3 },
  { id: 'J5', name: 'Wrist pitch', kind: 'pitch', drive: 'servo',    motor: 'MG996R',    ratio: 1,  min: -120, max: 120, a: 0, target: 0.59,  fb: FB_SERVO_POT, encChan: null },
  { id: 'J6', name: 'End roll',    kind: 'roll',  drive: 'servo',    motor: 'MG996R',    ratio: 1,  min: -180, max: 180, a: 0, target: 0.3,   fb: FB_SERVO_POT, encChan: null },
];

// lumped masses (kg) + attach joint (0-based) + jarak sepanjang link pivot (mm).
// `along` di-rebase ke panjang link CAD final (upper 288, forearm 270) dengan
// fraksi yang sama seperti MASSES di src/arm/config.py. Angka kg masih estimasi
// dokumen riset, ganti setelah part tercetak ditimbang.
export const MASSES = [
  { label: 'upper-arm link',          m: 0.18,  joint: 1, along: 144 },
  { label: 'J3 motor (proximal)',     m: 0.28,  joint: 1, along: 82 },
  { label: 'elbow cycloidal',         m: 0.15,  joint: 2, along: 0 },
  { label: 'J4 motor (proximal)',     m: 0.226, joint: 2, along: 35 },
  { label: 'J4 cycloidal',            m: 0.10,  joint: 2, along: 12 },
  { label: 'forearm link',            m: 0.12,  joint: 2, along: 135 },
  { label: 'J5 servo + roll housing', m: 0.12,  joint: 3, along: 294 },
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
  // true = ada edit pose lokal yang belum dikirim ke hardware; bridge menahan
  // feedback selama flag ini aktif (di-set applyPose, dilepas sendGoto/connect).
  poseDirty: false,
  show: { axes: true, masses: false, dims: false, skeleton: true, xray: false, wristAxes: true, sweep: false, cad: false },
  joints: JDEF.map(j => ({ ...j })),
};

// Deteksi servo lewat tipe drive, bukan cocok-cocokan nama motor: nama motor
// pernah berubah (`MG996R (servo)` -> `MG996R`) dan regex-nya ikut patah.
export function isServo(j) { return j.drive === 'servo'; }
/** true kalau sendi punya AS5600 di output (J1..J4). */
export function hasAS5600(j) { return j.fb === FB_AS5600; }
