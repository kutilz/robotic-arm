# Rancang Bangun Robotic Arm 6-DOF 3D-Printed: Keputusan Komponen, Rasio Reduksi & Struktur Kinematika Konseptual (Tahap Pre-CAD)

## TL;DR
- **Shoulder J2 ~29 N·m TIDAK feasible dengan satu cycloidal printed standar** — masalahnya bukan di motor, tapi di **ceiling struktural cycloidal PLA+ pin-circle 22mm yang cuma ~13 N·m** (uji empiris HowToMechatronics). Keputusan final: **dual NEMA17 17HS4401 paralel + compound belt(±3:1) + cycloidal besar PA-CF (pin circle ~40mm, ~30:1), PLUS counterbalance spring/gas-strut di shoulder** untuk meng-offload gravitasi. Counterbalance bukan opsional.
- **Konfigurasi roll-pitch-yaw baseline (yaw–pitch–pitch–roll–pitch–roll) SUDAH BENAR**: ini persis anthropomorphic arm + spherical wrist standar industri (PUMA/ABB/PAROL6) dan menghasilkan closed-form inverse kinematics. Syarat: J4-J5-J6 wajib berpotongan di satu titik → **taruh semua offset besar di lengan (J1-J3), jaga wrist "bersih".**
- **MG996R: PAKAI untuk J6 (cukup), JANGAN untuk J5** (1.7 N·m melebihi torsi aman servo). Untuk memenuhi tema "Position Feedback" skripsi, pasang **AS5600 eksternal di output J6** — jangan andalkan potensiometer internal servo.

## Key Findings — Tabel Final Pemilihan Komponen FIX per Joint

Semua FULL NEMA17, tanpa NEMA23. Asumsi: running torque = 0.5 × holding; efisiensi cycloidal printed η = 0.75 (belt η ≈ 0.9).

| Joint | Sumbu | Motor (FIX) | Drive type | Rasio | Torsi output (running) | Target | Status |
|---|---|---|---|---|---|---|---|
| **J1 Base** | yaw | 17HS4401 (0.45 N·m hold) | HTD3M belt 2-stage | ~20:1 | ~3.6 N·m (≈7.3 holding) | 3 N·m | ✓ aman |
| **J2 Shoulder** | pitch | **2× 17HS4401 paralel** | compound belt ~3:1 + cycloidal ~30:1 (PA-CF, pin circle ~40mm) | ~90:1 | ~28–30 N·m | 29 N·m | ✓ **dgn counterbalance + cycloidal upsized** |
| **J3 Elbow** | pitch | 17HS6401S (~0.6 N·m hold) | compound belt ~2.2:1 + cycloidal ~25:1 (pin circle ~26mm) | ~55:1 | ~11.7 N·m | 11 N·m | ✓ |
| **J4 Wrist roll** | roll | 17PM-K054 (0.27 N·m, 226g) — mount proximal | cycloidal 15:1 + HTD3M transmisi 1:1 | 15:1 | ~1.5 N·m | 1 N·m | ✓ |
| **J5 Wrist pitch** | pitch | 17HS4401 | cycloidal 15:1 | 15:1 | ~2.5 N·m (holding ~5) | 1.7 N·m | ✓ |
| **J6 End roll** | roll | **MG996R servo (55g)** | reduksi internal ~300:1 + AS5600 eksternal | — | ~0.4–0.55 N·m kontinyu | 0.5 N·m | ✓ marginal-cukup |

## Details

### Q1 — OFFSET PADA JOINT: PERLU, dan ini keputusan finalnya
Ya, desain ini **perlu offset**, dan bukan sekadar meniru estetika video — ada alasan engineering nyata. PAROL6 menyatakan filosofinya verbatim: *"The design was so that motors are not on the axes that they are actuating. By doing that you remove mass to the bottom of the robot and reduce the inertia of the joints."*

Offset memberi: (1) clearance fisik untuk badan cycloidal/gearbox yang gemuk, (2) menghindari self-collision antar link saat elbow menekuk penuh, (3) jalur routing kabel + magnet AS5600 di sisi sendi, (4) menggeser CoM motor lebih dekat ke base sehingga **langsung menurunkan torsi statik di J2/J3**.

**Rekomendasi offset konseptual** (di-scale dari PAROL6 ~1.75× karena reach kamu 700mm vs PAROL6 400mm; nilai mm = perkiraan awal, finalisasi saat CAD):
- **J1→J2 (shoulder):** offset lateral **~30–40 mm** (acuan PAROL6 a2 = 23.42 mm). Menaruh bidang upper-arm di samping kolom base, clearance gearbox shoulder.
- **J2→J3 (elbow):** offset **~40–60 mm** (acuan PAROL6 a4 = 43.50 mm). Untuk badan cycloidal elbow + belt tensioner.
- **J3→J4 (pangkal forearm):** kecil, **~10–20 mm**, atau nol jika link bisa dijaga lurus.
- **Wrist (J4-J5-J6):** offset antar tiga sumbu **seminimal mungkin / nol**. Catatan: PAROL6 a7 = 45.25 mm dan a6 = 62.8 mm ada di region flange gripper, **bukan** di antara tiga sumbu wrist.

**Aturan emas: offset besar di J1-J3, wrist concurrent.**

### Q2 — KONFIGURASI ROLL-PITCH-YAW: sudah benar & membentuk spherical wrist yang valid
Baseline (J1 yaw, J2 pitch, J3 pitch, J4 roll, J5 pitch, J6 roll) = **persis konfigurasi anthropomorphic arm + spherical wrist standar industri** (PUMA 560, ABB IRB, dan PAROL6 sendiri). Dokumentasi resmi PAROL6: *"PAROL6 uses a popular configuration where the axes of rotation of the last 3 joints intersect. That configuration is called a spherical wrist and is one of the most common configurations you will see in industrial robots. A spherical wrist allows for much easier and faster calculation of inverse kinematics."*

Wrist J4-roll → J5-pitch → J6-roll = urutan Euler ZYZ — definisi spherical wrist klasik. Memenuhi **kriteria Pieper**: tiga sumbu konsekutif berpotongan di satu titik → IK bisa di-*decouple* jadi sub-problem posisi (J1-J3) + orientasi (J4-J6), dapat **closed-form** yang jalan dalam mikrodetik.

**Syarat kritis (harus dijaga di CAD):** sumbu J4, J5, J6 wajib berpotongan di satu titik dengan toleransi ketat (~0.1–1 mm pada arm 500-700 mm). Kalau drift 2 mm, kinematic decoupling pecah, closed-form IK gagal, dan kamu terpaksa pakai numerical solver yang lambat & rawan singularity. **Inilah alasan teknis kenapa semua offset besar harus ditaruh di J1-J3.** Konfirmasi: konfigurasi baseline **tidak perlu diubah, sudah optimal.**

### Q3 — MENIRU PAROL6: di mana motor di-offset & mekanismenya
Detail PAROL6 (Petar Crnjak / source-robotics) yang relevan:
- **Filosofi:** motor sengaja tidak di sumbu yang diaktuasi → mengurangi inersia & menggeser massa ke base.
- **Distribusi drive:** reducer planetary hanya di joint dengan torsi terbesar (J2 & J3) plus J6 (planetary kecil). J1 belt + motor lebih besar; J4 & J5 belt; motor J4/J5 di-mount remote di forearm.
- **Karena kamu pakai cycloidal print sendiri (bukan planetary beli jadi),** offset elbow harus dibuat lebih besar dari PAROL6 untuk mengakomodasi badan cycloidal + tensioner.

**Saran final meniru PAROL6 (di-scale):** offset utama di **shoulder ~35 mm** dan **elbow ~50 mm**; motor J3, J4, J5 dimundurkan/diparalelkan via belt; wrist dijaga concurrent. Ini mereplikasi strategi "mass-to-base" PAROL6 tanpa menyalin dimensinya mentah-mentah.

### Q4 — BELT J3 (ELBOW): HTD3M cocok sebagai PRE-STAGE, bukan final drive
Evaluasi usulan "belt HTD3M + tensioner 2-bearing" untuk 11 N·m:

**Belt HTD3M 3mm pitch TIDAK boleh menanggung 11 N·m sebagai output stage.** Hitungan: dengan driven pulley 60T (pitch dia ~57.3 mm, R ≈ 28.6 mm), gaya tangensial belt = 11 / 0.0286 ≈ **385 N**. Untuk belt 3M (light-to-medium duty), tension segini berisiko tooth-skip/jump, apalagi di bahan PLA pulley print. **Tidak aman sebagai final drive.**

**Solusi (rekomendasi tegas): belt = pre-stage high-speed/low-torque, cycloidal = final stage.** Ini persis pola PAROL6 J3 (compound: belt + reducer dekat output). Konfigurasi:
- **Stage belt:** HTD3M 12T → 27T (~2.2:1), **lebar 10 mm cukup** (cuma menyalurkan ~0.66 N·m).
- **Stage cycloidal:** ~25:1, **stage inilah yang menanggung 11 N·m di output.**
- **Total ~55:1** → output running 0.30 × 55 × 0.71 ≈ **11.7 N·m** (holding ~21 N·m). ✓
- **Cycloidal harus di-upsize:** ceiling 13 N·m itu hanya untuk pin circle 22 mm. Untuk membawa 11 N·m dengan margin aman, pakai **pin circle ~26 mm** (ceiling naik ke ~15-18 N·m).

**Lebar belt J3:** 10 mm cukup (15 mm tidak perlu di sini).

**Tensioner 2-bearing yang baik:** dua idler bearing pada plat geser (slotted mount) atau idler eksentrik yang menekan punggung halus belt; satu sisi fixed-adjust, satu sisi spring-loaded untuk auto-tension. Pelajaran dari AR4 Annin Robotics — Chris Annin memperingatkan eksplisit soal belt J3: *"I wanted to send out a note to everyone to make sure you get the J3 belt tensioned properly. It does need to be fairly tight and cannot have any [slack]."* Jadi tensioner yang bisa di-preload kuat itu penting untuk repeatability.

### Q5 — J4 (WRIST ROLL) REMOTE/PROXIMAL DRIVE: ide BAGUS — lakukan
Pendekatan "mundurkan motor+cycloidal J4 ke dekat J3 lalu teruskan rotasi roll ke link distal" adalah **ide bagus dan memang praktik standar**, bukan eksperimen berisiko. PAROL6 melakukan persis ini (motor wrist di-mount di forearm, rotasi diteruskan via belt). Banyak paten arm industri juga menaruh reducer wrist di proximal untuk menurunkan inersia distal.

**Manfaat:** mengurangi massa di ujung lengan → **langsung menurunkan torsi yang ditanggung J2 & J3.** Pada arm 0.7 m, setiap 100 g yang dipindah dari wrist ke proximal memangkas beberapa N·m di shoulder.

**Cara meneruskan rotasi roll (rekomendasi):** untuk roll (sumbu sepanjang link), opsi terbaik = **belt HTD3M sepanjang forearm dari output cycloidal proximal ke housing wrist distal, rasio 1:1** (reduksi sudah dilakukan di cycloidal proximal). Belt: ringan, toleran misalignment, simpel. Alternatif hollow-shaft/poros lebih kaku tapi lebih berat & butuh bearing presisi — tidak perlu untuk payload 0.5 kg. Dua pulley GT2 16T yang kamu punya bisa dipakai di transmisi 1:1 ini bila torsinya rendah, tapi HTD3M lebih aman. **Motor pilihan: 17PM-K054 (Minebea, real, ringan 226g)** karena J4 cuma butuh ~1 N·m.

### Q6 — MG996R: PAKAI untuk J6, TIDAK untuk J5
**Spesifikasi MG996R terverifikasi (datasheet resmi TowerPro):** stall torque **9.4 kgf·cm @4.8V (~0.92 N·m), 11 kgf·cm @6V (~1.08 N·m)**; berat **55 g**; dimensi 40.7×19.7×42.9 mm; gear logam; feedback internal via potensiometer. **Penting:** TowerPro menyatakan servo berputar *"approximately 120 degrees (60 in each direction)"* — jadi range kerja resmi **~120°, bukan 180°** (klaim 180° umumnya dari clone).

**J6 end-roll (target 0.5 N·m, sudah termasuk SF 2.5×):** torsi aman kontinyu servo ≈ 1/3–1/2 stall = ~0.4–0.55 N·m; demand aktual tanpa SF ~0.2 N·m. **MG996R CUKUP untuk J6 — pakai.** Menghemat ~250 g di ujung lengan dan menghilangkan kebutuhan membuat reducer cycloidal lagi di posisi paling distal (yang efeknya berlipat ke J5/J3/J2). Ini keputusan yang benar.

**J5 wrist-pitch (target 1.7 N·m):** stall MG996R 1.08 N·m **lebih kecil dari 1.7 N·m**, dan torsi aman kontinyunya cuma ~0.5 N·m. **MG996R TIDAK CUKUP — tetap pakai stepper 17HS4401 + cycloidal 15:1** (output ~2.5 N·m running). Memaksakan MG996R di J5 = risiko servo stall, overheat, dan gear strip saat lengan horizontal penuh.

**Position feedback dengan MG996R (kunci untuk tema skripsi):** pot internal MG996R adalah loop tertutup internal yang tidak terbaca dari luar secara default. Rekomendasi:
1. **(PILIH INI)** Mode positional + pasang **AS5600 eksternal** membaca magnet diametrik di flange output J6. Konsisten dengan tema skripsi (seluruh joint pakai AS5600 12-bit: 4096 step, resolusi 360°/4096 = **0.0879°/LSB**, akurasi tipikal ±0.5° menurut datasheet ams OSRAM — resolusi ≠ akurasi, sebut keduanya di skripsi). Ini tidak bergantung pada pot internal yang murah & drift-prone.
2. Alternatif: tap kabel pot internal ke ADC mikrokontroler (riset menunjukkan ini bisa dilakukan non-invasif untuk feedback sudut real-time) — tapi lebih hacky, kurang akurat, dan kurang "rapi" untuk skripsi.

**Catatan rotasi:** karena travel resmi MG996R ~120°, kalau J6 butuh roll lebih luas, gunakan versi 360°/continuous — TAPI itu menghapus feedback pot internal, sehingga **AS5600 eksternal jadi wajib** (justru memperkuat opsi 1). Untuk payload 0.5 kg, range roll ±90-150° biasanya cukup.

### Q7 — RASIO J1 (BASE YAW) dengan 17HS4401: pakai HTD3M 2-stage, BUKAN GT2 2-stage
Target J1 ~3 N·m (di-size oleh inersia/friksi, bukan gravitasi — base yaw tidak melawan grafitasi saat statis).

**GT2 2-stage (2× pulley 16T yang kamu punya): TIDAK direkomendasikan sebagai final drive.** Alasan: (1) GT2 2mm pitch = light-duty; output stage harus membawa 3 N·m — dengan driven 64T (R ≈ 20.4 mm) gaya belt = 3/0.0204 ≈ **147 N**, melebihi kapasitas aman GT2 6mm. (2) Dua driver 16T membatasi rasio total (~16:1 praktis).

**Rekomendasi: HTD3M 2-stage ~20:1.** Contoh: stage1 15T→60T (4:1) + stage2 12T→60T (5:1) = 20:1.
- Output running: 0.225 × 20 × 0.81 ≈ **3.6 N·m > 3** ✓
- Output holding: ~7.3 N·m (margin besar untuk hold statik).
- **Lebar belt:** stage output (membawa 3 N·m, gaya ~105 N di 60T HTD3M) pakai **15 mm**; stage input pakai **10 mm**.
- **Upgrade opsional akurasi:** karena error backlash di base diperbesar sepanjang reach 0.7 m, kalau mau akurasi ujung lebih ketat, ganti stage output dengan cycloidal kecil (belt 5:1 + cycloidal 4-5:1 ≈ 25:1) untuk backlash mendekati nol. Untuk skripsi, 2-stage HTD3M sudah memadai.

### Struktur Kinematika Konseptual (frame, sumbu, lokasi offset)
Konvensi: **Y up**; pitch = rotasi tentang X lokal; roll = tentang Y lokal (sumbu panjang link); yaw = tentang Y.
- **Frame 0 (base):** sumbu J1 = sumbu Y (yaw).
- **J1→J2:** offset lateral ~35 mm + naik ke ketinggian shoulder (tinggi kolom base). J2 pitch tentang X lokal.
- **J2→J3:** link upper-arm ~330 mm sepanjang sumbu link; offset elbow ~50 mm. J3 pitch tentang X lokal.
- **J3→J4:** link forearm ~270 mm; J4 roll tentang Y lokal. **Motor J4 di-mount proximal (dekat J3)**, rotasi diteruskan via belt.
- **J4→J5→J6:** wrist ~100 mm. J5 pitch tentang X; J6 roll tentang Y. **Ketiga sumbu J4/J5/J6 BERPOTONGAN di wrist center** (offset antar sumbu = 0, kritis). AS5600 + magnet diametrik di tiap sumbu.
- **Lokasi offset:** SEMUA offset signifikan di J1-J2-J3; wrist dijaga concurrent. (Forward kinematics penuh / tabel DH lengkap dikerjakan setelah CAD packaging selesai — tahap ini cukup konseptual.)

## Recommendations (langkah bertahap sebelum masuk CAD)
1. **Kunci desain shoulder J2 lebih dulu** (komponen paling berisiko). Keputusan utama: **pasang counterbalance spring/gas-strut di shoulder — YA, sangat disarankan.** Ini memangkas komponen gravitasi dari ~29 N·m ke ~12-15 N·m, sehingga dual NEMA17 + cycloidal besar punya margin sehat. *Benchmark:* jika setelah counterbalance torsi drive ≤ 13 N·m, satu cycloidal pin-circle ~26 mm cukup; jika tetap > 13 N·m, wajib cycloidal besar PA-CF (~40 mm) + dual motor.
2. **Cetak test coupon cycloidal** pin-circle 22 mm (PLA+) dan 26 mm (PETG/PA-CF), uji torsi destructive di printer & material kamu sendiri sebelum commit dimensi — angka ceiling 13 N·m dari HowToMechatronics adalah acuan, bukan jaminan untuk setup-mu. *Threshold:* jika coupon 22 mm gagal < 10 N·m, naikkan material J2/J3 ke PA-CF.
3. **Pengadaan motor:** beli 17HS6401S (1 buah, untuk J3); tambah 17HS4401 hingga total ~4-5 unit (J1, J2×2, J5); 17PM-K054 untuk J4; MG996R untuk J6.
4. **Standarisasi feedback:** AS5600 + magnet diametrik di OUTPUT tiap joint (termasuk eksternal di J6). Jaga jarak sensor > 20 mm dari stator stepper (hindari interferensi magnetik) dan clearance magnet 0.5–3 mm.
5. **Stok belt:** mayoritas HTD3M 10 mm + sedikit 15 mm (J1 output, J2 pre-stage). Semua pulley driven di-print agar ringan.

**Benchmark yang akan mengubah keputusan:**
- Turunkan payload 0.5→0.3 kg atau reach 0.7→0.55 m → J2 turun ke ~18-20 N·m → cukup single cycloidal besar, dual motor bisa jadi single.
- Test coupon cycloidal konsisten > 20 N·m (material/printer bagus) → J2 bisa single robust cycloidal + dual motor tanpa counterbalance.

## Caveats
- **Spesifikasi torsi 17HS6401S, 42BYG34, 42BYG48 berlabel "suspicious" (toko meragukan)** — jangan jadikan dasar sizing kritis. 17HS6401S (body 60 mm) realistiknya ~0.6-0.65 N·m holding (model 60mm sekelas 17HS24 umumnya 0.65 N·m), tapi verifikasi fisik dianjurkan sebelum commit ke J3. 42BYG34/48 sebaiknya dihindari untuk joint penting; pakai hanya sebagai cadangan low-load.
- **29 N·m untuk lengan 3D-printed itu di batas atas feasibility.** Ini honest-nya berat untuk PLA/PETG. Counterbalance adalah rekomendasi engineering utama, bukan tambahan opsional.
- **Asumsi running = 0.5 × holding adalah konservatif.** Di pose statik, holding torque penuh sebenarnya tersedia → ada margin tersembunyi. Untuk gerak dinamis mengangkat beban, faktor 0.5× adalah pelindung yang tepat.
- **MG996R rawan clone** dengan kualitas bervariasi; beli yang asli TowerPro untuk J6. Ingat travel resmi ~120° (bukan 180°).
- **PAROL6 per-joint ratios** (yang beredar: J1 belt 6.4:1, J2 planetary 20:1, J3 planetary×belt 18.1:1, J4/J5 belt 4:1, J6 planetary 10:1) tidak bisa diverifikasi 100% independen dari dokumen resmi pada pencarian ini — gunakan sebagai acuan strategi, bukan angka mutlak. Yang terkonfirmasi kuat adalah filosofi desain (motor offset, planetary di J2/J3/J6, belt di J1/J4/J5) dan struktur spherical wrist.
- **Nilai offset mm di laporan ini bersifat konseptual/perkiraan** (di-scale dari PAROL6), bukan hasil DH final — finalisasi setelah CAD packaging cycloidal & motor selesai.