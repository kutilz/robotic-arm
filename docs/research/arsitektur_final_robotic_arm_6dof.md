# Arsitektur Final (Hampir): Robotic Arm 6-DOF 3D-Printed

**Skripsi:** Rancang Bangun Robotic Arm 6-DOF 3D Printed dengan Mekanisme Position Feedback dan Interface Digital Twin Berbasis Web
**Tahap:** Pre-CAD, komponen FIX + rasio + kinematika konseptual (1 langkah sebelum desain 3D)
**Basis:** Laporan riset *"6-DOF 3D-Printed Robotic Arm: Component Selection, Reduction Ratios, and Kinematic Structure"* + revisi target (payload 200g, reach 600mm) + koreksi arsitektur J2/J3.

> Dokumen ini menggantikan angka-angka di laporan riset awal pada bagian sizing torsi (laporan awal pakai 500g/700cm/wrist-stepper). Yang **tidak berubah** dari riset awal: filosofi offset PAROL6, validasi spherical wrist, ceiling cycloidal printed ~13 N·m, spek MG996R & AS5600, praktik belt sebagai pre-stage.

---

## 0. Apa yang berubah dari laporan riset awal

| Aspek | Riset awal | Sekarang (terkunci) | Konsekuensi |
|---|---|---|---|
| Payload | 0.5 kg | **0.2 kg** | torsi semua pitch-joint turun >2× |
| Reach | 0.70 m (fixed) | **0.60 m** (batas max 0.70, di-tweak ke 0.60) | moment arm lebih pendek |
| Wrist drive | stepper + cycloidal (berat ~0.45 kg) | **MG996R servo (2× ~55g)** | massa ujung kolaps → J2/J3 turun drastis |
| Motor J3 | cycloidal lokal di elbow | **relokasi ke pangkal upper-arm + belt** | massa motor J3 pindah ke ~80mm dari J2 |
| Motor J4 | (in-line di wrist) | **relokasi proximal (dekat elbow)** | massa keluar dari ujung |
| Drive J2 | belt 3:1 + cycloidal + 2 motor + counterbalance | **DIRECT cycloidal, SINGLE motor, NO belt** | J2 coaxial di pivot, moment arm motor ~0 |

**Kenapa J2 direct (koreksi penting):** motor J2 duduk coaxial di sumbu pivot shoulder → moment arm-nya ~0, ga ada massa yang bisa dihemat dengan mindahin lewat belt. Belt itu buat mindahin motor yang *jauh* dari base dan nge-beban-in shoulder. Itu **motor J3**, bukan J2. Maka J3 yang dapat perlakuan remote+belt; J2 cukup direct.

---

## 1. Parameter Global (TERKUNCI)

- **Payload:** 0.2 kg di flange tool
- **Reach total:** 600 mm (upper-arm 280 + forearm 230 + wrist→EE 90)
- **Konvensi sumbu:** Y up; **pitch** = rotasi tentang X lokal; **roll** = tentang Y lokal (sumbu panjang link); **yaw** = tentang Y
- **Asumsi sizing:**
  - Running torque stepper = **0.5 × holding** (konservatif; di pose statik holding penuh sebenarnya tersedia → margin tersembunyi)
  - Efisiensi cycloidal printed **η = 0.75**; belt per-stage **η = 0.9**
  - Faktor dinamis/keamanan **2.5×** (primer); 2.0× ditampilkan sebagai pembanding
- **Pose worst-case:** lengan horizontal penuh (memaksimalkan moment gravitasi di tiap pitch-joint)

---

## 2. Model Massa & Target Torsi (RECOMPUTED)

Massa lumped, jarak horizontal dari sumbu J2 (shoulder). **Semua angka ESTIMASI, finalisasi dengan timbang part nyata setelah print.**

| Item | m (kg) | d dari J2 (m) | m·d |
|---|---|---|---|
| Upper-arm link (PLA+) | 0.18 | 0.14 | 0.0252 |
| **J3 motor** (relokasi pangkal upper-arm) | 0.28 | 0.08 | 0.0224 |
| Elbow cycloidal (reducer J3) | 0.15 | 0.28 | 0.0420 |
| **J4 motor** (relokasi dekat elbow) | 0.226 | 0.31 | 0.0701 |
| J4 cycloidal | 0.10 | 0.29 | 0.0290 |
| Forearm link | 0.12 | 0.395 | 0.0474 |
| Wrist cluster (J5+J6 servo + struktur + EE) | 0.25 | 0.53 | 0.1325 |
| Payload | 0.20 | 0.60 | 0.1200 |
| | | **Σ** | **≈ 0.489 kg·m** |

**τ_static J2 = 9.81 × 0.489 ≈ 4.8 N·m**

### Target torsi output per joint

| Joint | Sumbu | τ_static (N·m) | **Target ×2.5 (N·m)** | (×2.0) | Disized oleh |
|---|---|---|---|---|---|
| J1 base | yaw | ~0 | **~3** | ~3 | inersia/friksi |
| **J2 shoulder** | pitch | 4.8 | **~12** | ~9.6 | gravitasi (semua distal) |
| **J3 elbow** | pitch | 1.45 | **~3.8** | ~2.9 | gravitasi (forearm+wrist+payload) |
| J4 wrist | roll | ~0 | **~1** | ~1 | inersia/friksi |
| **J5 wrist** | pitch | 0.26 | **~0.65** | ~0.5 | gravitasi (J6+EE+payload) |
| J6 end | roll | ~0 | **~0.3** | ~0.3 | friksi (roll, no gravity arm) |

**Vs ceiling cycloidal PLA+ printed (~13 N·m @ pin-circle 22mm, dari riset HowToMechatronics):** J3/J4/J5/J6 semua jauh di bawah → **PLA+ aman**. Hanya **J2 (~12 N·m)** yang mendekati ceiling → butuh pin-circle di-upsize (lihat §3).

---

## 3. Arsitektur Drivetrain Final (per joint)

🟢 = FINAL (arsitektur & komponen beli terkunci) · 🟡 = CONDITIONAL (tweakable post-test)

| Joint | Motor | Drive | Rasio | Out running | Out holding | Target | Status |
|---|---|---|---|---|---|---|---|
| **J1** | 17HS4401 | HTD3M belt 2-stage | ~20:1 | **3.65** | 7.3 | 3 | 🟢 |
| **J2** | 17HS6401 (1×) | **cycloidal DIRECT** (no belt) | ~40–50:1 | **10–12** | 18–21 | 12 | 🟢 arch / 🟡 geo |
| **J3** | 17HS4401 (relokasi) | HTD3M transmit ~1.67:1 + cycloidal 15:1 | ~25:1 | **3.8** | 7.6 | 3.8 | 🟢 |
| **J4** | 17PM-K054 (punya, relokasi) | cycloidal 15:1 + HTD3M 1:1 | 15:1 | **1.37** | 2.7 | 1 | 🟢 |
| **J5** | MG996R servo | servo direct + AS5600 output | - | ~0.5 sust. | stall 1.08 | 0.65 | 🟡 |
| **J6** | MG996R servo | servo direct + AS5600 output | - | ~0.5 sust. | stall 1.08 | 0.3 | 🟢 |

Out running pakai T_run = 0.5×holding, η_cyc 0.75, η_belt 0.9/stage. Angka 17HS6401 pakai holding realistik 0.6 N·m (bukan klaim suspicious 0.7).

### Detail per joint

**🟢 J1: Base yaw**
HTD3M 2-stage ~20:1, contoh 15T→60T (4:1) lalu 12T→60T (5:1). Out running 0.225×20×0.81 ≈ **3.65 N·m > 3** ✓. Inertia-sized → payload ga ngaruh, jadi **paling aman, nol regret beli motornya.** Belt: **output stage 15mm** (bawa 3 N·m, ~105 N di pulley 60T), **input stage 10mm**. *Bukan GT2 2-stage*, GT2 2mm pitch terlalu light buat output 3 N·m (~147 N di GT2 6mm, lewat batas aman). Driven pulley di-print.

**🟢 arch / 🟡 geo, J2: Shoulder pitch (DIRECT, koreksi utama)**
Cycloidal **direct, single motor, TANPA belt**. 17HS6401 langsung ke input cycloidal. Rasio **~1:45** (tweakable 40–50 lewat geometri disk, ini di-*print*, gratis di-iterate).
- Out running ~10–12 N·m, holding ~18–21 N·m. Vs static 4.8 → holding aman besar; dynamic di 2.5× marginal-tipis (mitigasi di §6).
- **Geometri cycloidal (🟡):** pin-circle **~28–30mm** (naikin ceiling dari 13 → ~16–18 N·m), tebal disk tebal, ≥50% infill / 6 perimeter. Material **PLA+/PETG dulu**; naik PA-CF **hanya kalau** coupon test gagal.
- Speed @300 RPM input = 6.7 RPM out = **40°/s**, wajar buat shoulder ber-beban.
- **Counterbalance:** **OPSIONAL** sekarang (dulu wajib @29 N·m). Pasang spring/gas-strut hanya kalau 17HS6401 lemah pas dites → static drop ke ~2.7 N·m, super lega.

**🟢 J3: Elbow pitch (motor relokasi + belt, persis usulan Q4)**
Motor 17HS4401 di **pangkal upper-arm** (~80mm dari J2), belt HTD3M jalan sepanjang upper-arm ke elbow, cycloidal di elbow yang nanggung beban. Inilah yang **motong beban J2.**
- Stage belt: HTD3M **12T→20T (~1.67:1)**, hanya menyalurkan rotasi high-speed/low-torque (~0.34 N·m) → **10mm cukup**.
- Stage cycloidal di elbow: **15:1**, pin-circle **22mm PLA+ cukup** (3.8 N·m << ceiling 13).
- Total ~25:1, out running 0.225×25×0.675 ≈ **3.8 N·m** ✓.
- **Tensioner 2-bearing:** dua idler bearing di plat geser (slotted), satu sisi fixed-adjust + satu sisi spring-loaded. *Belt elbow wajib di-preload kuat & no-slack* (pelajaran AR4/Annin: J3 belt harus tegang, ga boleh ada slack, demi repeatability).

**🟢 J4: Wrist roll (remote/proximal drive, persis usulan Q5)**
Motor **17PM-K054 (sudah punya, 226g, ringan)** di-mount proximal (dekat elbow), cycloidal 15:1 di sana, lalu rotasi roll diteruskan ke housing wrist distal via **HTD3M 1:1** sepanjang forearm. Out running 0.135×15×0.675 ≈ **1.37 N·m > 1** ✓. Manfaat: massa keluar dari ujung → langsung mengurangi beban J2/J3. Motor sudah dimiliki → **ga beli.**

**🟡 J5: Wrist pitch (MG996R, conditional)**
MG996R direct + AS5600 eksternal di output. Target 0.65 N·m (static cuma 0.26). Stall MG996R 1.08 → **cukup buat holding, marginal buat pitching cepat ber-beban** (0.65 ≈ 60% stall, agak panas kalau sustained). **Beli servo buat dicoba**; **fallback 17HS4401 + cycloidal 15:1** (sudah ada di stok) kalau gerak dinamisnya kurang. Status conditional bukan karena ragu komponen beli (servo murah), tapi karena pilihan aktuator final-nya nunggu uji gerak.

**🟢 J6: End roll (MG996R)**
MG996R direct + AS5600 eksternal. Target 0.3 N·m, roll murni (no gravity arm) → **lega**. Hemat ~250g di posisi paling distal + ga perlu bikin reducer lagi di ujung (efeknya berlipat balik ke J5/J3/J2). Catatan: travel resmi MG996R ~120° (bukan 180°); kalau butuh roll lebih luas pakai versi continuous + **AS5600 wajib** (justru sejalan dgn rencana feedback).

---

## 4. Position Feedback (inti tema skripsi)

**AS5600 12-bit magnetik di OUTPUT tiap joint** (6 unit), magnet diametrik 6mm. **Eksternal bahkan di J5/J6 servo**, jangan andalkan potensiometer internal MG996R (drift-prone, ga kebaca dari luar by default).

- Resolusi **0.0879°/LSB** (4096 step/putaran); akurasi tipikal **±~0.5°** (datasheet ams OSRAM). *Sebut keduanya di skripsi: resolusi ≠ akurasi.*
- Clearance magnet ke sensor 0.5–3mm; jaga sensor **>20mm dari stator stepper** (hindari interferensi magnetik).
- **Nilai jual skripsi:** dengan AS5600 di semua output, cerita "position feedback" jadi **seragam di 6 joint apapun jenis aktuatornya** (stepper open-loop, stepper+cycloidal, atau servo), closing the loop di sisi output, bukan motor. Ini juga yang nyuapin **digital twin** dengan sudut sendi real.

---

## 5. Struktur Kinematika Konseptual (frame + sumbu + offset)

Konfigurasi **anthropomorphic arm + spherical wrist**, terkonfirmasi standar industri (PUMA/ABB/PAROL6) dan **menghasilkan closed-form inverse kinematics** (memenuhi kriteria Pieper: 3 sumbu wrist berpotongan di 1 titik). **Konfigurasi RPY baseline TIDAK perlu diubah.**

### Tabel frame konseptual (DH-style, belum final, finalisasi setelah CAD packaging)

| i | Joint | Sumbu lokal | Link length a (mm) | Offset perp (mm) | Catatan |
|---|---|---|---|---|---|
| 1 | J1 yaw | Y (vertikal) | 0 | kolom base ~120 (vert) | belt 2-stage di base |
| 2 | J2 pitch | X | 0 | **lateral ~35** | shoulder, **cycloidal direct** |
| 3 | J3 pitch | X | **280** (upper-arm) | **~50 perp** | motor di pangkal upper-arm |
| 4 | J4 roll | Y | **230** (forearm) | ~0–15 | motor proximal, transmit belt 1:1 |
| 5 | J5 pitch | X | ~0 | **0** | wrist center |
| 6 | J6 roll | Y | ~0 | **0** | concurrent dgn J4,J5 |
| EE | flange tool | - | **90** (wrist→EE) | - | MG996R J6 + gripper |

### Aturan offset (TERKUNCI)

**Semua offset signifikan ditaruh di J1–J2–J3. Wrist (J4-J5-J6) dijaga CONCURRENT (offset antar 3 sumbu = 0).**

- Alasan: kalau sumbu J4/J5/J6 drift >~1–2mm dari satu titik, kinematic decoupling pecah → closed-form IK gagal → terpaksa numerical solver yang lambat & rawan singularity. Maka wrist wajib bersih.
- Offset di lengan (J1-J3) justru *menguntungkan*: clearance badan cycloidal/gearbox, hindari self-collision saat elbow menekuk penuh, routing kabel + magnet AS5600, dan geser CoM motor lebih dekat base (turunin beban J2/J3).
- Nilai mm di atas = **konseptual, di-scale ~1.75× dari PAROL6** (PAROL6 reach ~400mm). Finalisasi exact setelah CAD packaging motor+cycloidal selesai. Catatan: offset besar PAROL6 (a6/a7 ~45–63mm) ada di **region flange gripper, BUKAN antar sumbu wrist.**

### Side-view konseptual (skematik)

```
              [EE + gripper + J6 servo]
                       |  ~90mm
                  (J4=J5=J6 concurrent)  ← wrist center, offset 0
                       |
   forearm 230mm  =====|=====  ← J4 motor (17PM-K054) di sini (proximal)
                       |
                    (J3 elbow) ← cycloidal 15:1; offset perp ~50mm
                       |
   upper-arm 280mm =========  ← J3 motor (17HS4401) di pangkal sini
                       |        belt HTD3M jalan ke elbow ↑
                    (J2 shoulder) ← cycloidal DIRECT, single 17HS6401
                       |  lateral offset ~35mm
                  [kolom base ~120mm]
                       |
                    (J1 base yaw) ← HTD3M 2-stage 20:1
              =================  ← dasar
```

---

## 6. BOM: Beli Sekarang vs Ditunda

### 🟢 Beli SEKARANG (low/zero regret, design-independent)

| Item | Qty | Untuk | Catatan |
|---|---|---|---|
| 17HS4401 | **+2** (total 3 dgn yg punya) | J1, J3, +1 spare | spek real, reusable, sekaligus fallback J5 / motor-2 J2. **Nol regret.** |
| 17HS6401 | **1** | J2 | satu-satunya slot masuk akal buat 60mm. Worst-case jadi spare. |
| MG996R | **2** | J5, J6 | murah; J5 buat dicoba, J6 final |
| AS5600 + magnet diametrik 6mm | **6 + 6** | semua joint | cheap, selalu butuh, bikin feedback seragam |
| HTD3M pulley 10mm assorted (12/15/20T) | beberapa | J1, J3, J4 | driven di-print |
| HTD3M pulley 15mm (≥60T) | 1–2 | J1 output stage | margin bawa 3 N·m |
| Bearing: 608ZZ + 6700/6800 thin + idler kecil | stok | cycloidal, pivot, tensioner | standar |
| Dowel pin baja Ø3mm | stok | roller cycloidal | standar |

### 🟡 DITUNDA (tunggu CAD / tes, tweakable)

| Item | Kenapa ditunda | Lever penyesuaian |
|---|---|---|
| Panjang belt HTD3M (keliling) | tergantung center distance | fix saat CAD layout |
| Geometri cycloidal (pin-circle, tebal, rasio, material) | **di-print, gratis di-iterate** | J3/J4/J5 = PLA+ aman; J2 = upsize 28–30mm, PA-CF hanya kalau coupon gagal |
| Counterbalance J2 | opsional @ ~12 N·m | pasang hanya kalau J2 tes marginal |
| Motor-2 di J2 | hanya kalau 17HS6401 lemah | spare 17HS4401 sudah ada → ga beli baru |
| Fallback J5 (17HS4401+cyc) | hanya kalau servo kurang | motor sudah ada di stok |

---

## 7. Keputusan Tersisa & Threshold

Tinggal **2 hal**, dan keduanya **tidak nge-block pembelian** (semua jalur pakai komponen yang sama):

**(A) Geometri & strategi J2**, default: **17HS6401 single, cycloidal pin-circle ~28mm, rasio ~1:45, no counterbalance.**
- *Threshold:* setelah print + tes torsi, kalau out running < ~9 N·m atau disk aus/jamming →
  - opsi termurah: **tambah counterbalance** (static drop ke ~2.7 N·m), atau
  - **naikkan rasio** ke ~1:50 (print ulang disk), atau
  - **upgrade material** disk ke PA-CF, atau
  - **pasang motor-2** (spare 17HS4401 sudah ada).
- *Lever ekstra:* tarik reach 600→550mm → J2 turun ~2 N·m lagi.

**(B) Aktuator J5**, default: **MG996R + AS5600.**
- *Threshold:* kalau pitching cepat ber-beban bikin servo stall/overheat/gear-strip → swap ke **17HS4401 + cycloidal 15:1** (stok ada). AS5600 tetap dipakai → cerita feedback ga berubah.

---

## 8. Referensi (anchor dari laporan riset)

- **Ceiling cycloidal PLA+ printed ~13 N·m @ pin-circle 22mm**: uji printed-vs-CNC HowToMechatronics (PLA ~13 N·m vs CNC ~34 N·m, identik 19:1).
- **Spherical wrist + closed-form IK**: dokumentasi PAROL6 (3 sumbu wrist berpotongan) + kriteria Pieper.
- **Filosofi offset / mass-to-base**: PAROL6 (Petar Crnjak, source-robotics): motor sengaja tidak di sumbu yang diaktuasi untuk mengurangi inersia joint.
- **Belt sebagai pre-stage + tensioning ketat**: pola compound PAROL6 J3 + peringatan tensioning AR4/Annin Robotics.
- **MG996R:** stall ~0.92 N·m @4.8V / ~1.08 N·m @6V, 55g, travel ~120°, gear logam (datasheet TowerPro).
- **AS5600:** 12-bit, 0.0879°/LSB, akurasi ~±0.5° (ams OSRAM).
- **17HS6401 (60mm):** spek toko suspicious (klaim 0.7 N·m); realistik ~0.6 N·m holding, **verifikasi fisik sebelum commit ke J2.**

---

## 9. Caveats (jujur)

- **Semua massa & CoM = estimasi.** τ_J2 skala langsung dgn ini; error 20% massa = error 20% torsi. Re-run §2 dengan part yang ditimbang setelah print.
- **Spek 17HS6401/42BYG34/42BYG48 "suspicious"**, jangan jadikan dasar sizing kritis tanpa verifikasi. 42BYG dihindari untuk joint penting; pakai hanya cadangan low-load.
- **Faktor 0.5× running konservatif** → ada margin tersembunyi di holding statik; faktor 2.5× sudah membungkus dinamika+friksi.
- **Backlash cycloidal printed signifikan**, fine buat positioning lambat + feedback AS5600 di output (yang mengoreksi backlash di sisi output), kurang ideal buat kontrol high-bandwidth.
- **Nilai offset mm = konseptual**, bukan DH final. FK penuh + tabel DH lengkap dikerjakan **setelah** CAD packaging cycloidal & motor beres.
