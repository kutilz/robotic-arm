/* ============================================================================
   DATA / MODEL: rasio, motor, massa, dan batas sendi.

   GEOMETRI TIDAK LAGI DI SINI. Panjang link dan offset dulu diketik ulang di
   file ini (LINK/OFFS) dan sudah menyimpang jauh dari CAD: kolom base 120 mm
   vs 72,8 mm terukur, wrist->TCP 90 mm vs 174,9 mm, dan offset bahu dipasang
   sejajar sumbu pitch sehingga tidak ikut mengayun. Sekarang satu-satunya
   sumber geometri adalah sumbu hasil ukur di src/model/cadRig.js; ukuran
   turunan (a1, a2, d4, d6, reach) dibaca lewat `world.geo`.

   Drivetrain FINAL: J1 belt HTD3M 2 stage 1:15 (17HS2401), J2 cycloidal DIRECT
   1:30 (17HS6401S), J3 belt 3:1 + cycloidal 1:10 = 1:30 (17HS2401),
   J4 cycloidal 1:15 (17HS2401, terkonfirmasi CAD), J5/J6 MG996R servo direct.
   Feedback: AS5600 di output J1..J4 (mux TCA9548A ch 0-3); J5/J6 pot internal
   servo -> ADC1 ESP32, tanpa mux. Sinkron src/arm/config.py.
   ========================================================================== */

// Cycloidal geometry drive J2, terukur di docs/bom-main-assembly.md bagian 2.
// Dipakai untuk plafon torsi PLA+; J3 (N=10, Rr 30, e 1,5) dan J4 (N=15,
// Rr 35, e 1,2) angkanya beda, lihat tabel di BOM.
export const CYC = {
  N: 30,             // roller pin J2 -> reduksi 1:30 (topologi housing output)
  pinCircleR: 38,    // pin circle Ø76 / 2
  pinR: 2.57,        // lubang roller Ø5,14 / 2
  ecc: 1.0,          // eksentrisitas J2
  diskT: 6,          // tebal disk (x2, beda fase 180 deg)
  outPinN: 12,       // dowel output statik J2
  outPinCircleR: 26.4,
};

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
// target: torsi output rujukan (N·m) dari src/arm/torque.py. Angka ini dihitung
// untuk reach J2->TCP 649 mm; rakitan CAD 2026-08-03 mengukur 732 mm, jadi
// lengan momennya ~13% lebih panjang dan `target` J2/J3 di bawah SUDAH BASI.
// Studio tidak memakainya untuk apa pun (cek torsi di drawer engineering pakai
// torsi gravitasi live dari MASSES), jadi ini murni catatan; nilainya ikut
// diperbarui saat src/arm/torque.py dihitung ulang.
export const JDEF = [
  { id: 'J1', name: 'Base yaw',    kind: 'yaw',   drive: 'belt',     motor: '17HS2401',  ratio: 15, min: -180, max: 180, a: 0, target: 3,     fb: FB_AS5600,    encChan: 0 },
  { id: 'J2', name: 'Shoulder',    kind: 'pitch', drive: 'cyc',      motor: '17HS6401S', ratio: 30, min: -95,  max: 95,  a: 0, target: 12.78, fb: FB_AS5600,    encChan: 1 },
  { id: 'J3', name: 'Elbow',       kind: 'pitch', drive: 'cyc-belt', motor: '17HS2401',  ratio: 30, min: -150, max: 150, a: 0, target: 4.19,  fb: FB_AS5600,    encChan: 2 },
  { id: 'J4', name: 'Wrist roll',  kind: 'roll',  drive: 'cyc',      motor: '17HS2401',  ratio: 15, min: -180, max: 180, a: 0, target: 1,     fb: FB_AS5600,    encChan: 3 },
  { id: 'J5', name: 'Wrist pitch', kind: 'pitch', drive: 'servo',    motor: 'MG996R',    ratio: 1,  min: -120, max: 120, a: 0, target: 0.59,  fb: FB_SERVO_POT, encChan: null },
  { id: 'J6', name: 'End roll',    kind: 'roll',  drive: 'servo',    motor: 'MG996R',    ratio: 1,  min: -180, max: 180, a: 0, target: 0.3,   fb: FB_SERVO_POT, encChan: null },
];

// lumped masses (kg) + attach joint (0-based, indeks pivot) + jarak sepanjang
// sumbu +Y lokal pivot saat pose home (mm).
//
// `joint` dan `along` di-rebase ke rakitan CAD 2026-08-03: tiap lump ditaruh di
// link CAD tempat part-nya benar-benar berada (peta CAD_PARTS di cadRig.js) dan
// `along` = jarak pusat part dari sumbu sendi induknya. Perhatikan pivot J4, J5,
// dan J6 semuanya duduk di PUSAT PERGELANGAN (z 630,56) karena wrist-nya
// spherical, jadi part L4 yang letaknya di bawah pergelangan punya `along`
// NEGATIF. Sebelumnya lump wrist ditaruh di `along` 294 dari J4, yaitu 24 mm di
// luar lengan bawah, dan payload cuma 62 mm dari J6 padahal TCP 175 mm.
//
// TODO: angka kg masih estimasi sebelum rakitan ini dibangun ulang. Timbang
// ulang per link dari slicer (tools/measure_print_mass.py) supaya torsi yang
// dihitung studio ikut ter-update.
export const MASSES = [
  { label: 'upper-arm link',          m: 0.18,  joint: 1, along: 134 },  // Arm Link From/To J2..J3
  { label: 'J3 motor + belt',         m: 0.28,  joint: 1, along: 109 },  // 17HS2401 @ z 181,8
  { label: 'elbow cycloidal',         m: 0.15,  joint: 2, along: 0 },    // housing output J3 @ z 360,8
  { label: 'J4 motor (proximal)',     m: 0.226, joint: 2, along: 30 },   // 17HS2401 @ z 391,3
  { label: 'J4 cycloidal',            m: 0.10,  joint: 2, along: 62 },   // base statik J4 @ z ~423
  { label: 'forearm / wrist link',    m: 0.12,  joint: 3, along: -174 }, // Wrist Link @ z 544,9
  { label: 'J5 servo + roll housing', m: 0.12,  joint: 3, along: 0 },    // MG996R J5 @ z 629,5
  { label: 'J6 servo + EE struct',    m: 0.13,  joint: 4, along: 55 },   // MG996R J6 @ z 700,6
  // at:'tcp' -> ditempel persis di node TCP, bukan di sumbu +Y pivot. Perlu
  // karena TCP punya offset lateral 15,7 mm terhadap sumbu J6, dan payload
  // adalah massa terbesar sehingga lengan momennya tidak boleh dibulatkan.
  { label: 'payload',                 m: 0.20,  joint: 5, along: 0, at: 'tcp' },
];

export const G = 9.81;
export const d2r = Math.PI / 180;

// printed-PLA+ cycloidal torque ceiling (~13 N·m @ 22mm pin circle), skala ~pin circle
export function plaCeiling() { return 13 * (CYC.pinCircleR / 22); }

// preset pose [J1..J6] derajat; payload (kg) opsional ikut di-set.
// Di-tuning ulang untuk rantai CAD 2026-08-03: dengan wrist->TCP 174,9 mm
// (dulu 90 mm) dan kolom base 72,8 mm (dulu 120 mm), 'Reach fwd' lama berakhir
// di y -51 mm dan 'Pick low' lama di y -126 mm, dua-duanya menembus meja.
// Angka baru dicari lewat IK ke titik nyata dan diperiksa
// `node studio/tools/verify_cad_rig.mjs`.
export const POSE_PRESETS = [
  { name: 'Home',       full: 'Home (tegak)',             angles: [0, 0, 0, 0, 0, 0] },
  { name: 'Horizontal', full: 'Horizontal worst-case',    angles: [0, 90, 0, 0, 0, 0],   payload: 0.20 },
  { name: 'Reach fwd',  full: 'Reach forward (y 340)',    angles: [0, 31, 49, 0, 27, 0], payload: 0.10 },
  { name: 'Folded',     full: 'Folded / park',            angles: [0, -80, 140, 0, 60, 0] },
  { name: 'Pick low',   full: 'Pick low (y 126, J1 30)',  angles: [30, 35, 61, 0, 69, 0], payload: 0.10 },
];

/* Trajektori demo, [J1..J6] derajat per keyframe. Ditaruh di config (bukan di
   features/demos.js) supaya `node studio/tools/verify_cad_rig.mjs` bisa
   memeriksanya tanpa WebGL: tiap pose wajib di atas meja dan di dalam limit.
   Semua di-tuning ulang untuk rantai CAD 2026-08-03; lihat catatan di demos.js. */
export const DEMO_POSES = {
  // sapu penuh: rentang J1 penuh lalu roll + pitch pergelangan
  sweep: [
    [0, 0, 0, 0, 0, 0],
    [90, 25, 15, 0, 20, 0],
    [-90, 45, 55, 0, 30, 0],
    [0, 45, 55, 120, 60, 90],
    [0, -40, 120, -120, -45, -90],
    [0, 0, 0, 0, 0, 0],
  ],
  // pick & place: ambil di depan (z +470), taruh di samping (x +455); tinggi
  // ambil 165 mm dan angkat 330 mm dari grid, dihitung lewat IK bukan diketik.
  pickPlace: [
    [0, 0, 0, 0, 0, 0],
    [0, 21, 60, 0, 34, 0],    // atas titik ambil
    [0, 32, 66, 0, 46, 0],    // turun, ambil
    [0, 21, 60, 0, 34, 0],    // angkat
    [90, 19, 63, 0, 36, 0],   // putar ke titik taruh
    [90, 29, 68, 0, 48, 0],   // turun, taruh
    [90, 19, 63, 0, 36, 0],   // angkat
    [0, 0, 0, 0, 0, 0],
  ],
  // showcase: satu sendi bergerak per langkah dari pose dasar yang aman
  showcase: [
    [0, 0, 0, 0, 0, 0], [60, 0, 0, 0, 0, 0], [-60, 0, 0, 0, 0, 0], [0, 60, 0, 0, 0, 0],
    [0, 30, 90, 0, 0, 0], [0, 30, 60, 150, 0, 0], [0, 30, 60, 0, 90, 0],
    [0, 30, 60, 0, 0, 150], [0, 0, 0, 0, 0, 0],
  ],
};

// Seed lingkaran IK: pose "reach forward" (TCP sekitar y 340, z 519). Radius 60
// mm di bidang Z-Y menaruh titik terendah di y 280 mm, jadi lingkarannya utuh.
// Seed lama [0,45,70,0,30,0] TCP-nya cuma y 39 mm sehingga separuh lingkaran
// jatuh di bawah meja dan IK-nya mentok.
export const CIRCLE_SEED = [0, 31, 49, 0, 27, 0];
export const CIRCLE_R = 60;

/** state aplikasi bersama (satu instance, di-share antar modul). */
export const STATE = {
  explode: 0, payload: 0.20, eta: 0.75, sf: 2.5, plaCeil: plaCeiling(),
  estop: false, engineering: false,
  // true = ada edit pose lokal yang belum dikirim ke hardware; bridge menahan
  // feedback selama flag ini aktif (di-set applyPose, dilepas sendGoto/connect).
  poseDirty: false,
  // cad: true = mesh CAD jadi tampilan default. Kalau GLB gagal dimuat, rantai
  // skeleton + panah sumbu tetap tampil sebagai fallback (lihat cadModel.js).
  show: { cad: true, axes: false, skeleton: true, dims: false, masses: false, xray: false },
  joints: JDEF.map(j => ({ ...j })),
};

// Deteksi servo lewat tipe drive, bukan cocok-cocokan nama motor: nama motor
// pernah berubah (`MG996R (servo)` -> `MG996R`) dan regex-nya ikut patah.
export function isServo(j) { return j.drive === 'servo'; }
/** true kalau sendi punya AS5600 di output (J1..J4). */
export function hasAS5600(j) { return j.fb === FB_AS5600; }
