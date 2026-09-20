/* ============================================================================
   previewSpec: tabel bentuk model blok sederhana (dipakai previewModel.js saat
   main-assembly.glb tidak tersedia, mis. di build web hasil deploy).

   Modul ini sengaja DATA MURNI tanpa import apa pun, sama alasannya dengan
   cadRig.js: supaya `node studio/tools/verify_preview_model.mjs` bisa
   memeriksanya di Node tanpa WebGL. Material disebut sebagai nama; pemetaan ke
   material three.js ada di previewModel.js.

   Kunci = `${nameKey(nama)}|${link}`, karena 8 nama part dipakai lebih dari
   sekali di link yang berbeda dengan ukuran DAN sumbu yang berbeda (mis.
   'Housing (output)' di L2 adalah reduktor J2 bersumbu y, di L4 reduktor J4
   bersumbu z). Kalau kunci ber-link tidak ketemu, nameKey polos dicoba.

   PERHATIAN soal kunci: nameKey() membuang sufiks angka hanya kalau angkanya
   benar-benar di ujung nama, jadi 'Jaw Link 2' jatuh ke 'jaw_link' (satu baris
   untuk sepasang part) sementara '6906zz Inner Holder (Stage 1)' tetap
   bernomor karena namanya ditutup kurung. Kunci di bawah mengikuti keluaran
   nameKey apa adanya, dan verify_preview_model.mjs yang menjaganya tetap cocok.

     ['box', sx, sy, sz, material]           balok, ukuran pada sumbu file CAD (mm)
     ['cyl', diameter, tebal, sumbu, material]   silinder, sumbu 'x' | 'y' | 'z'

   Sumbu silinder = sumbu sendi tempat part itu bekerja (reduktor J2/J3 bersumbu
   y, tumpukan base J1 dan reduktor J4 bersumbu z), bukan sumbu link tempatnya
   digantung: sisi statik sebuah reduktor ikut link induk tapi orientasinya
   mengikuti sendinya sendiri.

   SUMBER UKURAN: docs/bom-main-assembly.md bagian 3 dan 4, yang diukur dari
   geometri file CAD. Dua dudukan stepper ditandai TAKSIRAN karena dimensinya
   memang tidak pernah dicatat di BOM.
   ========================================================================== */

export const PREVIEW_SPEC = {
  /* ---- L0: rangka meja + tumpukan slewing bearing base (sumbu J1 = z) ---- */
  'aluminum_2020_11_cm|0': ['box', 20, 110, 20, 'steel'],
  'aluminum_2020_20_cm|0': ['box', 200, 20, 20, 'steel'],
  'base_plate|0':          ['box', 180, 180, 5, 'pla'],
  'holder_extention|0':    ['cyl', 108, 8, 'z', 'pla'],
  'stage_1_holder|0':      ['cyl', 108, 6, 'z', 'pla'],
  'stage_2_holder|0':      ['cyl', 108, 6, 'z', 'pla'],
  'stage_3_holder|0':      ['cyl', 56, 30, 'z', 'pla2'],
  'diametric_magnet_holder|0': ['cyl', 26, 5.2, 'z', 'magnet'],

  /* ---- L1: kolom J1 + casing belt J1 + sisi STATIK reduktor J2 (sumbu y) ---- */
  'j1|1':                     ['cyl', 82, 30, 'z', 'pla'],     // kolom putar J1
  // Bbox J1 Flange 208 x 231 x 37, tapi part aslinya pelat berongga yang
  // melebar, bukan bongkahan pejal: kalau digambar setebal bbox ia menelan
  // seluruh tumpukan base. Tebalnya dipangkas ke 10 mm supaya terbaca sebagai
  // pelat. Ini satu-satunya baris yang sengaja menyimpang dari bbox terukur.
  'j1_flange|1':              ['box', 208, 231, 10, 'pla2'],
  'encoder_bearing_holder|1': ['cyl', 41.6, 5, 'z', 'pla2'],
  'pulley_casing|1':          ['box', 154, 84, 45, 'pla2'],
  'pulley_casing_cover|1':    ['box', 154, 84, 10, 'pla'],
  'nema_17hs2401|1':          ['box', 42.3, 42.3, 40, 'motor'],   // motor J1, poros z
  'nema_17hs6401s|1':         ['box', 42.3, 60, 42.3, 'motor'],   // motor J2, poros y
  'j2_stepper_gripper|1':     ['box', 50, 46, 50, 'pla2'],        // TAKSIRAN
  'bottom_base_fastened_to_17hs6401s|1': ['cyl', 85, 10, 'y', 'housing'],
  'top_base|1':               ['cyl', 85, 8, 'y', 'housing'],
  'diametric_holder|1':       ['cyl', 65.3, 6.8, 'y', 'pla2'],

  /* ---- L2: sisi OUTPUT reduktor J2 + lengan atas + drive belt J3 ---- */
  'housing_output|2':          ['cyl', 85, 18, 'y', 'housing'],
  'top_roller_cover|2':        ['cyl', 85, 6, 'y', 'housing'],
  'arm_link_from_j2|2':        ['box', 96, 10, 229, 'link'],
  'arm_link_to_j3|2':          ['box', 84, 10, 275, 'link'],
  'nema_17hs2401|2':           ['box', 42.3, 40, 42.3, 'motor'],  // motor J3, poros y
  '20t_motor_pulley|2':        ['cyl', 19.1, 12, 'y', 'steel'],
  '60t_driven_pulley|2':       ['cyl', 57.3, 12, 'y', 'steel'],
  '480mm_timing_belt|2':       ['box', 34, 9, 179, 'belt'],
  'output_pulley_shaft_holder|2':  ['cyl', 78, 19.4, 'y', 'pla2'],
  '6906zz_inner_holder_stage_1|2': ['cyl', 30.05, 4.5, 'y', 'pla2'],
  '6906zz_inner_holder_stage_2|2': ['cyl', 30.05, 4.5, 'y', 'pla2'],
  'top_base|2':                ['cyl', 70, 8, 'y', 'housing'],

  /* ---- L3: sisi OUTPUT reduktor J3 (sumbu y) + sisi STATIK reduktor J4 (z) ---- */
  'housing_output_fit_to_outer_ring_6906zz|3': ['cyl', 70, 27, 'y', 'housing'],
  'top_roller_cover|3':                    ['cyl', 70, 6, 'y', 'housing'],
  'encoder_spacer|3':                      ['cyl', 89.7, 5, 'y', 'pla2'],
  'diametric_holder_j4_stepper_gripper|3': ['box', 85, 80, 47, 'pla2'],
  'j4_stepper_gripper|3':                  ['box', 50, 50, 40, 'pla2'],  // TAKSIRAN
  'nema_17hs2401|3':                       ['box', 42.3, 42.3, 40, 'motor'],  // motor J4, poros z
  'bottom_base_fastened_to_nema17|3':      ['cyl', 89.7, 10, 'z', 'housing'],
  'top_base|3':                            ['cyl', 89.7, 8, 'z', 'housing'],

  /* ---- L4: sisi OUTPUT reduktor J4 + lengan bawah + servo J5 ---- */
  'housing_output|4':     ['cyl', 89.7, 18, 'z', 'housing'],
  'top_roller_cover|4':   ['cyl', 89.7, 6, 'z', 'housing'],
  'encoder_spacer|4':     ['cyl', 89.7, 5, 'z', 'pla2'],
  'wrist_link_holder|4':  ['box', 89.7, 79, 30, 'pla'],
  'wrist_link|4':         ['box', 10, 60, 212.7, 'link'],
  'mg996r|4':             ['box', 19.7, 40.7, 42.9, 'servo'],   // servo J5, poros x

  /* ---- L5: bracket J5 + servo J6 ---- */
  'only_1_part|5': ['box', 22, 56.7, 86.8, 'pla'],
  'mg996r|5':      ['box', 40.7, 19.7, 42.9, 'servo'],          // servo J6, poros z

  /* ---- L6: gripper MG90S + sepasang roda gigi sektor + rahang ---- */
  'only_1_part|6':                ['cyl', 50, 7, 'z', 'pla2'],  // flange J6
  'j6_connector_servo_holder|6':  ['box', 60, 23.7, 37, 'pla'],
  'gear_gripper_holder|6':        ['box', 60, 12, 27.6, 'pla'],
  'mg90s|6':                      ['box', 22.5, 12.2, 28, 'servo'],
  'servo_attatched_gear|6':       ['box', 29.5, 5, 43.6, 'pla2'],
  'second_gear|6':                ['box', 29.5, 5, 43, 'pla2'],
  // sepasang, ukurannya sama persis (lihat catatan sufiks angka di header)
  'jaw_link|6':                   ['box', 15.6, 5, 30, 'pla2'],
  'jaw_spacer|6':                 ['box', 7.4, 5, 7.4, 'pla2'],
  'wedge_jaw|6':                  ['box', 19.1, 11, 29.6, 'pla'],
};

/** Bentuk untuk sebuah part: coba kunci ber-link dulu, lalu nameKey polos. */
export function previewSpecFor(key, link) {
  return PREVIEW_SPEC[`${key}|${link}`] || PREVIEW_SPEC[key] || null;
}

/** Setengah-ukuran (mm) sebuah spec pada sumbu file CAD; dipakai membangun
    geometri sekaligus menghitung bbox rakitan di verify_preview_model.mjs. */
export function specHalfExtent(spec) {
  if (spec[0] === 'cyl') {
    const [, d, t, axis] = spec;
    const r = d / 2;
    return axis === 'x' ? [t / 2, r, r] : axis === 'y' ? [r, t / 2, r] : [r, r, t / 2];
  }
  return [spec[1] / 2, spec[2] / 2, spec[3] / 2];
}
