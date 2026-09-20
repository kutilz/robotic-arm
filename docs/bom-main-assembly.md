# BOM: Main Assembly (Complete)

Sumber: `onshape/Main Assembly (Complete).glb` dan `.step`, export Onshape
2026-08-03 (revisi penamaan ulang + mate connector tambahan). Kedua file
gitignored, jadi dokumen ini yang jadi rekaman isinya di repo.

Semua angka di bawah **diukur dari geometri file**, bukan dari nama part:
diameter dan kedalaman didapat dengan mem-fit silinder ke tiap muka (Onshape
mengekspor satu primitive per face), pusat dan sumbu sendi didapat dengan
mem-fit lingkaran ke ring lubang roller, dan jumlah bola didapat dengan mem-fit
bola ke tiap kantong crown. Satuan mm, koordinat file CAD (Z-up, origin di
sumbu J1 setinggi garis tengah profil 2020).

Statistik file: 194 node, 94 part instance, 88 mesh, 548.704 segitiga,
16 material. Bbox rakitan 240 x 266 x 815,7 mm (z -10 sampai +805,7).

---

## 1. Ringkasan drivetrain (terukur)

| Sendi           | Penggerak                            | Reduksi terukur                | Total    | Umpan balik  |
| --------------- | ------------------------------------ | ------------------------------ | -------- | ------------ |
| J1 base yaw     | 17HS2401 + belt HTD3M 2 stage        | 12T->60T (5:1), 20T->60T (3:1) | **15:1** | AS5600       |
| J2 shoulder     | 17HS6401S + cycloidal direct         | N = 30 roller                  | **30:1** | AS5600       |
| J3 elbow        | 17HS2401 + belt 20T->60T + cycloidal | 3:1 x N = 10 roller            | **30:1** | AS5600       |
| J4 forearm roll | 17HS2401 + cycloidal direct          | N = 15 roller                  | **15:1** | AS5600       |
| J5 wrist pitch  | MG996R direct                        | 1:1                            | **1:1**  | pot internal |
| J6 end roll     | MG996R direct                        | 1:1                            | **1:1**  | pot internal |
| Gripper         | MG90S + sepasang roda gigi sektor    | -                              | -        | -            |

Semua rasio ini cocok dengan `JDEF` di `studio/src/config/arm.js`, jadi tabel
rasio yang sudah ada di draf tidak perlu diubah.

---

## 2. Mekanisme cycloidal: housing output, dowel statik

Ini topologi v4 di `onshape/Cycloidal Generator.fs` (`CycloOutputMode.HOUSING_OUTPUT`),
bukan hub output gaya v2/v3. Rantai dayanya:

1. **Input Cam** (O10 x 6 mm) duduk di poros motor lewat D-bore O5,14 mm.
   Sumbu luar cam offset terhadap bore sebesar eksentrisitas `e`.
2. **6900ZZ (10x22x6)** dipasang di cam: bore 10 mm ke cam, outer 22 mm ke
   bore tengah **Cycloid Disk**. Satu bearing per disk, dan tiap sendi pakai
   2 disk beda fase 180 derajat. Tebal disk 6 mm = lebar bearing 6 mm.
3. **Bottom Base + Top Base = STATIK**, dibaut ke rumah motor. Dowel/baut
   output menembus base atas dan bawah lewat lubang disk yang di-oversize
   sebesar `2e`. Dowel inilah yang mengunci rotasi disk sehingga disk cuma
   boleh mengorbit, tidak boleh berputar pada sumbunya sendiri.
4. **Housing (output) + roller pin + Top Roller Cover = OUTPUT.** Ring luar
   yang berputar, bukan carrier.

Konsekuensi yang perlu dicatat karena berbeda dari cycloidal "buku teks":

- Rasio = **N : 1** dengan N = jumlah roller pin, bukan N-1 : 1. Jumlah lobe
  disk tetap N-1, tapi yang jadi rasio adalah N.
- Turunan kinematiknya (disk terkunci, ring sebagai output) memberi arah putar
  output **searah** input, bukan berlawanan seperti mode hub output. Ini perlu
  dicek ulang terhadap konvensi arah di firmware sebelum dipakai.
- Beban output ditumpu ring luar, jadi bearing utama sendi ada di sisi housing
  (crown bola cetak, plus 6906ZZ di J3), bukan di carrier.

### Angka cycloidal terukur per sendi

|                        | J2                        | J3                                | J4              |
| ---------------------- | ------------------------- | --------------------------------- | --------------- |
| Roller pin N           | **30**                    | **10**                            | **15**          |
| Pin circle Rr          | 38,0 mm (O76)             | 30,0 mm (O60)                     | 35,0 mm (O70)   |
| Diameter lubang roller | O5,14                     | O5,14                             | O5,14           |
| Panjang kantong roller | 15,9 + 2,9 mm             | 15,9 + 2,9 mm                     | 15,7 + 2,7 mm   |
| Eksentrisitas e        | **1,0 mm**                | **1,5 mm**                        | **1,2 mm**      |
| Tebal disk             | 6,0 mm (x2)               | 6,0 mm (x2)                       | 6,0 mm (x2)     |
| Bore disk              | O22,0 (6900ZZ)            | O22,0 (6900ZZ)                    | O22,0 (6900ZZ)  |
| Pin output statik      | **12 x dowel O5** @ R26,4 | 12 x M3 @ R17,0                   | 12 x M3 @ R17,0 |
| Baut base              | 8 x M3 @ R15,45           | (satu ring, jadi satu dengan pin) | (satu ring)     |
| Lubang pin di disk     | O7,20                     | O6,37                             | O5,70           |
| Baut housing ke link   | 12 x M3 @ R44,2           | 12 x M3 @ R36,2                   | 12 x M3 @ R41,2 |

Cek konsistensi: lubang pin di disk = diameter pin + 2e + clearance.
J2 = 5 + 2,0 + 0,2 = 7,2. J3 = 3 + 3,0 + 0,37 = 6,37. J4 = 3 + 2,4 + 0,3 = 5,7.
Ketiganya cocok, jadi nilai e di atas bisa dipakai.

J2 pakai dua ring terpisah (12 dowel O5 pemikul beban di R26,4 plus 8 baut M3
pengikat base di R15,45) karena torsinya paling besar. J3 dan J4 pakai layout
satu ring: 12 baut M3 sekaligus jadi pin statik.

---

## 3. Part cetak (per subrakitan)

### J1 Assembly (27 instance)

| Qty | Part                      | Catatan                      |
| --- | ------------------------- | ---------------------------- |
| 1   | Base Plate                | 180 x 180 x 5                |
| 1   | J1 Flange                 | 208 x 231 x 37, plat dudukan |
| 1   | Holder extention          | O108 x 8                     |
| 1   | Stage 1 Holder            | O108 x 6                     |
| 1   | Stage 1 Crown             | 20 kantong bola O4,5 @ R42,0 |
| 1   | Stage 2 Holder            | O108 x 6                     |
| 1   | Stage 2 Crown             | 20 kantong bola O4,5 @ R42,0 |
| 1   | Stage 3 Holder            | O56 x 30                     |
| 1   | Stage 3 Crown             | 14 kantong bola O4,5 @ R29,0 |
| 1   | J1                        | kolom putar O82 x 30         |
| 1   | Input Pulley 12T          | HTD3M                        |
| 1   | Stage 2 Pulley 60T -> 20T | pulley majemuk               |
| 1   | Output Pulley 60T         | di sumbu J1                  |
| 1   | Pulley Casing             | 154 x 84 x 45                |
| 1   | Pulley Casing Cover       | 154 x 84 x 10                |
| 1   | Oldham Coupler            | O16 x 4,6                    |
| 1   | Encoder Bearing Holder    | O41,6 x 5                    |
| 1   | Encoder Bearing Crown     | 8 kantong bola O3,5 @ R14,0  |
| 1   | Diametric Magnet Holder   | O26 x 5,2                    |
| 1   | J2 Stepper Gripper        | dudukan 17HS6401S            |

### J2 Assembly (23 instance)

| Qty | Part                                | Catatan                                    |
| --- | ----------------------------------- | ------------------------------------------ |
| 2   | Cycloid Disk                        | O72,8 x 6, beda fase 180                   |
| 2   | Input Cam                           | O10 x 6, e = 1,0                           |
| 2   | Crown                               | 18 kantong bola O4,5 @ R31,6 masing-masing |
| 1   | Housing (output)                    | 85 x 95,6 x 18, 30 kantong roller          |
| 1   | Top Roller Cover                    | 30 lubang roller @ R38                     |
| 1   | Top Base                            | statik                                     |
| 1   | Bottom Base (Fastened to 17HS6401S) | statik, dudukan NEMA17                     |
| 1   | Diametric Holder                    | O65,3 x 6,8, dudukan magnet AS5600         |
| 1   | Arm Link (From J2)                  | 229 x 96 x 10                              |
| 1   | Arm Link (To J3)                    | 275 x 84 x 10                              |
| 1   | 20T Motor Pulley                    | drive J3, di pangkal lengan atas           |
| 1   | 60T Driven Pulley                   | drive J3, di sumbu J3                      |
| 1   | Output Pulley & Shaft Holder        | O78 x 19,4                                 |
| 1   | 6906zz Inner Holder (Stage 1)       | boss O30,05 x 4,5                          |
| 1   | 6906zz Inner Holder (Stage 2)       | boss O30,05 x 4,5                          |

Dua inner holder itu menjepit satu 6906ZZ dari kedua sisi (4,5 + 4,5 = 9,0 mm
= lebar bearing), jadi bukan dua bearing.

### J3 Assembly (11 instance)

| Qty | Part                                       | Catatan                         |
| --- | ------------------------------------------ | ------------------------------- |
| 2   | Cycloid Disk                               | O57,5 x 6, e = 1,5              |
| 2   | Input Cam                                  | O10 x 6                         |
| 1   | Crown                                      | 10 kantong bola O4,5 @ R21,2    |
| 1   | Housing (output, fit to outer ring 6906zz) | 70 x 79,7 x 27                  |
| 1   | Top Roller Cover                           | 10 lubang roller @ R30          |
| 1   | Top Base                                   | dudukan 625ZZ O16 x 5 di tengah |
| 1   | Encoder Spacer                             | O89,7 x 5                       |
| 1   | Diametric Holder & J4 Stepper Gripper      | 85 x 80 x 47                    |
| 1   | J4 Stepper Gripper                         | dudukan 17HS2401                |

J3 tidak punya Bottom Base sendiri: sisi statiknya dipegang oleh Output Pulley
& Shaft Holder di J2 Assembly.

### J4 Assembly (15 instance)

| Qty | Part                             | Catatan                                    |
| --- | -------------------------------- | ------------------------------------------ |
| 2   | Cycloid Disk                     | O66 x 6, e = 1,2                           |
| 2   | Input Cam                        | O10 x 6                                    |
| 2   | Crown                            | 14 kantong bola O4,0 @ R26,0 masing-masing |
| 1   | Housing (output)                 | 89,7 x 79 x 18, 15 kantong roller          |
| 1   | Top Roller Cover                 | 15 lubang roller @ R35                     |
| 1   | Top Base                         | dudukan 625ZZ O16 x 5 di tengah            |
| 1   | Bottom Base (Fastened to NEMA17) | statik                                     |
| 1   | Encoder Spacer                   | O89,7 x 5                                  |
| 1   | Wrist Link Holder                | 89,7 x 79 x 30                             |
| 1   | Wrist Link                       | 10 x 60 x 212,7                            |

### Pergelangan J5/J6 (5 instance, di level atas rakitan)

| Qty | Part                     | Catatan                                       |
| --- | ------------------------ | --------------------------------------------- |
| 1   | `Only 1 part` (node 6)   | 22 x 56,7 x 86,8, bracket J5, 2 bore O12 x 22 |
| 1   | `Only 1 part` (node 166) | O50 x 7, flange J6, seat O11,6 x 5            |
| 2   | MG996R                   | badan servo                                   |
| 2   | Output Gear              | spline keluaran O5,90 (bagian dari servo)     |

### Gripper Assembly (13 instance)

| Qty | Part                        | Catatan               |
| --- | --------------------------- | --------------------- |
| 1   | J6 Connector & Servo Holder | 60 x 23,7 x 37        |
| 1   | Gear Gripper Holder         | 60 x 12 x 27,6        |
| 1   | Servo-Attatched Gear        | 29,5 x 5 x 43,6       |
| 1   | Second Gear                 | 29,5 x 5 x 43,0       |
| 2   | Jaw Link (1 dan 2)          | 15,6 x 5 x 30         |
| 2   | Jaw Spacer (1 dan 2)        | 7,4 x 5 x 7,4         |
| 2   | Wedge Jaw (1 dan 2)         | 19,1 x 11 x 29,6      |
| 1   | MG90S                       | badan servo           |
| 1   | Output Gear                 | spline keluaran O4,90 |

Gripper paralel: MG90S memutar Servo-Attatched Gear, meshing ke Second Gear,
masing-masing membawa satu jaw link. Ujung jaw ada di z = 805,7.

---

## 4. Komponen beli

### Motor dan servo

| Qty | Item           | Lokasi     |
| --- | -------------- | ---------- |
| 3   | NEMA 17HS2401  | J1, J3, J4 |
| 1   | NEMA 17HS6401S | J2         |
| 2   | MG996R         | J5, J6     |
| 1   | MG90S          | gripper    |

### Bearing bola

Seluruh robot hanya memakai **tiga tipe bearing** (dikonfirmasi 2026-08-03).

| Qty   | Bearing            | Fungsi dan lokasi                                                                                                                            |
| ----- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 6     | **6900ZZ** 10x22x6 | eksentrik di **tiap** cycloid disk. Bore 10 ke Input Cam, outer 22 ke bore disk. J2, J3, J4 masing-masing 2                                  |
| 2     | **6906ZZ** 30x47x9 | bantalan output utama: sumbu J1 (dudukan di Pulley Casing Cover, z = 51,9) dan output J3 (dijepit dua 6906zz Inner Holder, 4,5 + 4,5 = 9 mm) |
| 6 (7) | **625ZZ** 5x16x5   | penahan shaft O5, lihat rincian di bawah                                                                                                     |

Rincian 625ZZ, dua kelompok yang masing-masing menjaga satu shaft tetap lurus:

| Lokasi dudukan               | Shaft yang ditahan                                |
| ---------------------------- | ------------------------------------------------- |
| Pulley Casing                | shaft Stage 2 Pulley 60T -> 20T di J1 (x = 72,47) |
| Pulley Casing Cover          | shaft yang sama, sisi seberang                    |
| Output Pulley & Shaft Holder | shaft tunggal dari output pulley J2 ...           |
| Arm Link (To J3)             | ... menerus ...                                   |
| Top Base (J3)                | ... sampai masuk cycloidal J3                     |
| Top Base (J4)                | shaft input cycloidal J4                          |
| Top Base (J2), **belum ada** | rencana tambah, sekarang bore-nya masih O17,90    |

Catatan revisi: Top Base J2 belum punya dudukan 625ZZ (bore tengahnya O17,90).
Akan ditambahkan lalu dicetak ulang, jadi hitung **7 buah 625ZZ** untuk belanja.

Dua fitur yang sempat saya kira bearing ternyata bukan: seat O28 x 7 (x2) di
J1 Flange, dan seat O22 x 6 di Pulley Casing pada sumbu pulley input J1.
Keduanya lubang lewat atau clearance, bukan dudukan bearing.

### Bola baja untuk crown cetak

| Qty | Ukuran  | Sebaran                                                           |
| --- | ------- | ----------------------------------------------------------------- |
| 100 | O4,5 mm | J1 stage 1 (20), stage 2 (20), stage 3 (14), J2 (18 x 2), J3 (10) |
| 28  | O4,0 mm | J4 (14 x 2)                                                       |
| 8   | O3,5 mm | crown bearing encoder J1                                          |

### Sabuk dan poros

| Qty | Item                          | Catatan                                 |
| --- | ----------------------------- | --------------------------------------- |
| 2   | Sabuk HTD3M 270 mm (90T)      | stage 1 dan stage 2 J1                  |
| 1   | Sabuk HTD3M 480 mm (160T)     | drive J3                                |
| 55  | Dowel roller O5 x ~19 mm      | J2 30, J3 10, J4 15                     |
| 12  | Dowel output O5 x ~22 mm      | J2 saja                                 |
| 4   | D-shaft O5                    | J1, J2 (x2), J4                         |
| 2   | Profil aluminium 2020, 110 mm | rangka dasar                            |
| 1   | Profil aluminium 2020, 240 mm | rangka dasar (nama part bilang "20 cm") |

### Elektronik posisi

4 x AS5600 plus 4 x magnet diametral di J1 sampai J4 (dudukannya ada:
Diametric Magnet Holder di J1, Diametric Holder di J2, Encoder Spacer plus
Diametric Holder di J3 dan J4). Magnetnya sendiri tidak dimodelkan di CAD.

### Baut (yang terhitung dari lubang)

| Qty | Item | Lokasi                                    |
| --- | ---- | ----------------------------------------- |
| 8   | M3   | baut base J2 @ R15,45                     |
| 12  | M3   | pin statik sekaligus baut base J3 @ R17,0 |
| 12  | M3   | pin statik sekaligus baut base J4 @ R17,0 |
| 36  | M3   | housing ke link, 12 per sendi cycloidal   |
| 16  | M3   | dudukan 4 motor NEMA17 @ R21,9            |

Baut sisanya (casing pulley, jaw, bracket wrist, rangka) belum saya hitung
satu per satu.

---

## 5. Geometri kinematik terukur

Sumbu sendi difit dari fitur nyata: ring lubang roller untuk J2/J3/J4, kantong
bola crown untuk J1, silinder boss keluaran servo untuk J5/J6. Deviasi standar
fit lingkaran 0,000 mm, jadi angka ini bukan perkiraan kasar.

| Sendi | Titik pada sumbu (mm)    | Arah sumbu              |
| ----- | ------------------------ | ----------------------- |
| J1    | x 0, y 0                 | (0, 0, 1)               |
| J2    | x -65,85, z 72,80        | (0, 1, 0)               |
| J3    | x -65,61, z 360,80       | (0, 1, 0)               |
| J4    | x -65,55, y -12,46       | (0, 0, 1)               |
| J5    | (-65,55, -12,46, 630,56) | (0,999, -0,053, -0,001) |
| J6    | (-65,55, -12,46, 630,56) | (-0,002, -0,053, 0,999) |

**Pergelangan spherical terkonfirmasi.** Sumbu J4, J5, dan J6 berpotongan di
(-65,55, -12,45, 630,56) dengan simpangan maksimum 0,05 mm. Syarat closed-form
IK aman.

Panjang link:

| Besaran                                           | Nilai terukur | Nilai di kode |
| ------------------------------------------------- | ------------- | ------------- |
| a1 (jarak tegak lurus sumbu J1 ke J2)             | 65,85 mm      | 66            |
| tinggi J2 dari garis tengah profil 2020           | 72,80 mm      | -             |
| a2 (J2 ke J3)                                     | 288,00 mm     | 288           |
| d4 (J3 ke pusat pergelangan)                      | 269,76 mm     | 270           |
| d6 (pusat pergelangan ke TCP, sepanjang sumbu J6) | 174,23 mm     | -             |
| offset lateral tool (tegak lurus sumbu J6)        | 15,74 mm      | -             |
| tinggi total tegak                                | 815,69 mm     | -             |

### Definisi TCP

TCP ditetapkan di **titik tengah ujung wedge jaw saat jaw tertutup**. Diukur di
frame J6 (origin pusat pergelangan, sumbu z' = sumbu J6, sumbu x' = sumbu J5),
posisinya:

```
TCP = (x' -0,80 ; y' +15,74 ; z' +174,23) mm terhadap pusat pergelangan
|pusat pergelangan -> TCP| = 174,94 mm
```

Pada pose simpan rakitan, jarak antar ujung jaw cuma 1,91 mm, jadi gripper
memang tersimpan dalam keadaan hampir tertutup dan angka di atas sudah mewakili
kondisi "jaw tertutup".

Alasan memilih ujung jaw, bukan tengah permukaan cengkeram:

1. **Bisa diukur di robot fisik.** Uji akurasi dan repeatability gaya ISO 9283
   butuh titik yang bisa disentuhkan ke referensi. Ujung jaw tertutup bisa,
   tengah permukaan cengkeram tidak.
2. **Konservatif untuk sizing torsi.** Ini titik terjauh, jadi lengan momennya
   maksimum. Titik berat payload sebenarnya sekitar 15 mm lebih dekat, jadi
   hitungan torsi otomatis punya margin.
3. **Reproducible dari CAD** tanpa asumsi tambahan soal bentuk benda kerja.

Yang penting dicatat untuk Bab III: **offset lateral 15,74 mm itu terjadi
SETELAH J6**, jadi ini transform tool tetap, bukan offset antar sumbu
pergelangan. Pergelangan spherical tetap utuh dan IK closed-form tetap sah:
selesaikan IK untuk pusat pergelangan dulu, baru terapkan transform tool.

Reach dari J2 ke TCP saat lengan lurus = 288,0 + 269,8 + 174,2 = 732,0 mm
sepanjang lengan, plus 15,7 mm lateral, jadi jarak lurusnya **732,2 mm**.
Dokumen lama memakai reach 649 mm dari J2 karena gripper belum termodelkan
penuh. Ini menaikkan lengan momen sekitar 13 persen, jadi hitungan torsi J2
dan J3 perlu ditinjau ulang.

Pose simpan rakitan tidak persis nol: matriks node menunjukkan J4 sekitar
3,0 derajat dan J5 sekitar 3,0 derajat dari nol. Ini normal untuk rakitan
Onshape dan sudah ditangani oleh kalibrasi offset home di digital twin.

---

## 6. Status pertanyaan

### Sudah terjawab (2026-08-03)

| Pertanyaan                                  | Jawaban                                                                                                                            |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Dua part bernama `Only 1 part`              | Benar dugaannya: node 6 = bracket MG996R J5 ke Wrist Link, node 166 = flange output J6. Nama part masih perlu dirapikan di Onshape |
| Seat O28 x 7 di J1 Flange (dikira 6902ZZ)   | Bukan bearing. Robot cuma pakai 3 tipe: 6906ZZ, 625ZZ, 6900ZZ                                                                      |
| Seat O22 x 6 di Pulley Casing (dikira 6900) | Bukan bearing. 6900ZZ hanya dipakai di cycloid disk                                                                                |
| Bore tengah Top Base J2 = O17,90            | Kelewatan waktu desain. Akan diganti dudukan 625ZZ, CAD diedit dan part dicetak ulang                                              |
| Titik TCP untuk d6                          | Diserahkan ke pertimbangan skripsi. Dipilih ujung jaw tertutup, alasan di bagian 5                                                 |

### Masih terbuka

1. **Panjang profil 2020**: part bernama "Aluminum 2020 20 cm" tapi geometrinya
   240 mm. Perlu dipastikan sebelum masuk tabel belanja.
2. **Lebar sabuk HTD3M**: bbox model 10,4 mm. Sabuk 9 mm atau 10 mm?
3. **Bola crown**: bola baja beli jadi, atau ikut dicetak?
4. **J3 cuma punya 1 Crown**, sedangkan J2 dan J4 masing-masing 2. Disengaja
   karena satu sisi sudah ditumpu 6906ZZ, atau memang belum lengkap?
5. **Arah putar output cycloidal.** Mode housing output membuat output searah
   input, kebalikan dari mode hub. Perlu dipastikan cocok dengan tanda arah
   di firmware dan di studio.

### Penyimpangan yang diketahui dan sengaja dibiarkan (2026-08-05)

Revisi `Main Assembly (Complete v2)` menebalkan crown, di CAD dan di lengan
fisik. Yang paling berdampak ada di J4, dan efeknya menaikkan seluruh susunan
di atasnya. Dibandingkan revisi 2026-08-03 yang jadi sumber angka di seluruh
dokumen ini:

| Besaran                  | Revisi 03 Agu      | Revisi 05 Agu (v2)  |
| ------------------------ | ------------------ | ------------------- |
| Crown J4 bawah           | O53,5 x 4,8        | O57,4 x **5,8**     |
| Crown J4 atas            | O53,4 x 4,8        | O56,1 x **5,9**     |
| Crown J2 (x2)            | O64,6 x 4,8        | O64,6 x 5,0 dan 5,1 |
| Crown J3                 | O43,8 x 5,0        | O43,8 x 5,3         |
| Pusat pergelangan (z)    | 630,56 mm          | sekitar 632,8 mm    |
| d4 (J3 ke pergelangan)   | 269,76 mm          | sekitar 271,96 mm   |
| Ujung jaw / tinggi total | 805,7 / 815,7 mm   | 807,9 / 817,9 mm    |

Geserannya bertingkat, bukan seragam (cycloid disk +0,2 mm, crown atas +1,8 mm,
encoder spacer +2,2 mm, wrist link +2,3 mm), yang menandai susunan tebal berubah
dan bukan rakitan bergeser.

**Yang sengaja TIDAK diubah, beserta alasannya:**

- **Naskah skripsi.** Jangkauan dilaporkan sebagai hasil pengukuran, dan 2,2 mm
  pada lengan 733 mm berada di dalam ketelitian cara mengukurnya, yaitu 0,3
  persen. Tidak ada margin torsi, status lulus, maupun simpulan Bab IV dan V yang
  berbalik arah karenanya. Draf dikumpulkan 6 Agustus 2026.
- **`studio/src/config/arm.js`** masih memakai d4 = 270 mm. Tidak berpengaruh
  pada hasil yang dilaporkan, sebab sync error digital twin diukur di ruang sendi
  dalam satuan derajat dan tidak melewati d4. Penyesuaian dikerjakan sesudah
  sidang.
- **Angka di bagian 1 sampai 5 dokumen ini** tetap merujuk revisi 03 Agustus,
  karena revisi itulah yang menjadi sumber angka naskah.

Pekerjaan susulan sesudah sidang: jalankan `tools/measure_cad_geometry.py` pada
revisi v2, perbarui d4 di konfigurasi studio, lalu perbarui bagian 5 dokumen ini.

---

## 7. Rekap slicer: filamen dan waktu cetak

Sumber: panel estimasi proyek `onshape/3d print robot arm.3mf` di Bambu Studio,
dibaca 4 Agustus 2026. Sepuluh plate, profil cetak seragam (Bambu Lab A1,
nozzle 0,4 mm, layer 0,16 mm, dua dinding, infill 15% gyroid, PLA+ eSUN).

### Filamen

| Bagian  | Panjang  | Massa      |
| ------- | -------- | ---------- |
| Model   | 347,90 m | 1054,36 g  |
| Support | 0,94 m   | 2,83 g     |
| **Total** | **348,83 m** | **1057,20 g** |

Support cuma 0,27 persen dari total massa, jadi orientasi cetak tiap part
memang sudah dipilih supaya nyaris tidak butuh penopang.

Angka 1054,36 g yang dipakai mengalibrasi model massa di `tools/measure_print_mass.py`
adalah **massa model saja**, tidak termasuk 2,83 g support. Ini yang benar,
karena support dibuang setelah cetak dan tidak ikut jadi massa lengan.

Biaya filamen menurut slicer: 26,42 (satuan mata uangnya ikut setelan slicer,
perlu dipastikan sebelum dikutip di draf).

### Waktu cetak per plate

| Plate | Waktu   |
| ----- | ------- |
| 1     | 6j 28m  |
| 2     | 11j 01m |
| 3     | 5j 31m  |
| 4     | 5j 33m  |
| 5     | 5j 03m  |
| 6     | 5j 01m  |
| 7     | 4j 46m  |
| 8     | 4j 14m  |
| 9     | 3j 48m  |
| 10    | 2j 13m  |
| **Total** | **53j 38m** |

Slicer melaporkan total 2d5h37m, yaitu 53 jam 37 menit. Penjumlahan kolom di
atas memberi 53 jam 38 menit; selisih satu menit berasal dari pembulatan
per plate. Yang dilaporkan di draf adalah **53 jam 38 menit** karena angka itu
yang dapat diperiksa ulang dari kolomnya.

Waktu ini adalah waktu mesin, bukan waktu kalender: belum termasuk penggantian
plate, pembersihan, dan cetak ulang part yang gagal.
