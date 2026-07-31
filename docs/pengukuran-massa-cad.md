# Pengukuran Massa dan Torsi dari CAD + Proyek Slicer

Sesi 2026-07-31. Mengganti model massa hasil ESTIMASI di dokumen riset dengan
angka terukur, tanpa timbangan. Semua angka di sini bisa dihasilkan ulang:

```bash
python tools/measure_print_mass.py
```

Status: **hasil tingkat link sudah bisa dipakai menulis skripsi.** Ada tiga
pertanyaan terbuka di bagian akhir, satu di antaranya (spesifikasi motor
17HS2401) berpotensi mengubah kesimpulan sizing secara menyeluruh, jadi baca
bagian itu sebelum mengutip Tabel 3.4.

---

## 1. Metode

Lengan sudah tercetak penuh tapi tidak ada timbangan yang cukup teliti. Massa
diambil dari geometri, bukan dari timbangan:

1. **Volume dan luas permukaan** tiap part dihitung dari mesh di
   `onshape/3d print robot arm.3mf` (divergence theorem, 74 objek).
2. **Massa** dimodelkan sebagai shell padat + rongga infill, satu parameter
   (tebal shell efektif `t`):
   ```
   massa = rho_filament * (shell + infill * core)
   shell = min(luas * t, volume)
   core  = volume - shell
   ```
3. **Kalibrasi**: `t` dicari dengan bisection sampai total 74 part sama dengan
   angka slicer. Bambu Studio melaporkan Model 1054.36 g, Support 2.83 g,
   Total 1057.20 g. Support cuma 0.27% jadi diabaikan. Hasil `t = 1.067 mm`,
   wajar terhadap nominal 2 wall (0.42 + 0.45 = 0.87 mm); selisihnya sumbangan
   top 6 layer dan bottom 4 layer.
4. **Posisi** tiap part diambil dari centroid awan titik di
   `onshape/Testing Assembly.step`. File 3mf tidak tahu posisi part di lengan,
   cuma tahu part digeletakkan di plate mana.
5. **Torsi** dihitung pada pose terentang horizontal penuh, bukan pose CAD.
   Di CAD lengannya setengah terlipat sehingga momennya kekecilan dan bukan
   worst case.

Profil print yang terbaca otomatis dari 3mf: Bambu Lab A1, nozzle 0.4,
layer 0.16 mm, 2 wall, infill 15% gyroid, top 6 / bottom 4, PLA density
1.26 g/cm3.

### Kenapa tidak pakai satu density efektif

Rencana awalnya menimbang satu part, membagi dengan volumenya, lalu memakai
density itu untuk semua part. **Itu salah** dan sempat hampir dilakukan.
Density efektif ternyata terentang **0.50 sampai 1.26 g/cm3** antar part,
karena rasio volume/luas-permukaan tiap part beda jauh. Part gempal berongga
(pulley, cycloid disk) turun ke 0.50 sampai 0.75; part tipis dan part kecil
habis dimakan wall + top/bottom shell sehingga nyaris padat. Kalau density
Pulley Casing (0.94) dipakai untuk semua, Stage 2 Pulley kelebihan 88%.

---

## 2. Verifikasi yang sudah lulus

| Uji | Hasil |
|---|---|
| 87 instance STEP dikurangi 13 part beli = 74, vs 74 objek 3mf | **identik**, termasuk himpunan namanya |
| volume mesh Cycloid Disk J2 vs B-rep Onshape | 19370 vs **19362.441 mm3**, meleset 0.04% |
| volume 2 bodi `Cycloid Disk-3` di SolidWorks | 38723.00 = 2 x 19361.5, cocok dengan sepasang disk |
| tau_J2 hasil skrip vs hitungan manual | **sama persis** (5.24 N.m) |

Tiga belas part beli itu: 3x Nema 17HS2401, 1x 17HS6401S, 2x MG996R, 1x MG90S,
3x Aluminum 2020, 3x belt. Proyek print dan assembly CAD konsisten sempurna.

---

## 3. Hasil: massa per link

Total part cetak **1054.4 g**, fraksi padat rata-rata 0.647
(volume 1292.7 cm3, kalau dicetak padat 1628.8 g).

| Grup | #part | Massa (g) |
|---|---:|---:|
| BASE, tak dibawa J2 | 20 | **476.4** |
| L2 upper arm | 13 | 145.9 |
| L3 elbow | 16 | 205.5 |
| J4 gearbox | 12 | 130.6 |
| L4 forearm | 1 | 48.0 |
| L5/L6 wrist + gripper | 12 | 48.0 |
| **TOTAL** | **74** | **1054.4** |

**Hampir separuh massa cetak (476 g, 45%) ada di base dan tidak dibawa J2.**
Part terberat seluruh lengan adalah `J1 Flange` 141.8 g, dan dia duduk di bawah
J2 sehingga sumbangannya ke torsi bahu nol.

Bandingkan asumsi dokumen riset (`src/arm/config.py` MASSES):

| Bagian | Asumsi | Terukur | |
|---|---:|---:|---|
| upper arm link | 180 g | 145.9 | dekat |
| elbow cycloidal | 150 g | 205.5 | +37% |
| J4 cycloidal | 100 g | 130.6 | +31% |
| forearm link | 120 g | 48.0 | **-60%** |
| wrist cluster (bagian cetak) | ~250 g | 48.0 | jauh lebih ringan |
| **total cetak dibawa J2** | **~800 g** | **578** | **-28%** |

### Dowel

SS304 Ø5 x 20 mm. Massa per batang = `pi * 2.5^2 * 20 * 0.008` = **pi gram
tepat** (kebetulan, karena rho SS304 = 8.0 g/cm3).

| Sendi | Pin ring | Pin output | Massa | Lengan momen | tau ke J2 |
|---|---:|---:|---:|---|---:|
| J2 | 30 | 6 | 113.1 g | di sumbu J2 | **0.000** |
| J3 | 10 | 6 | 50.3 g | 288 mm | 0.142 |
| J4 | 15 | 6 | 66.0 g | 353 mm | 0.228 |
| **Total** | **55** | **18** | **229.3 g** | | **0.370** |

Dowel J2 berbobot 113 g tapi **sumbangan torsinya nol**: pin tersusun melingkar
simetris mengelilingi sumbu, jadi titik beratnya jatuh tepat di sumbu. Dia tetap
membebani J1 dan menambah berat total. Pola yang sama berlaku untuk pin output
di ketiga sendi.

Total dowel 229.3 g itu **22% dari massa seluruh part cetak**, dari komponen
yang gampang terlupakan dari daftar massa.

---

## 4. Hasil: torsi gravitasi worst-case

```
tau_J2 = 5.24 N.m     (dokumen riset: 4.80)
tau_J3 = 1.50 N.m     (dokumen riset: 1.38)
tau_J5 = 0.21 N.m     (dokumen riset: 0.23)
```

Massa yang dibawa J2 (cetak + beli + dowel + payload 0.2 kg) = **1971 g**.

### Margin per sendi setelah diperbarui

| Sendi | Target lama | Target baru | Keluaran | Margin lama | Margin baru |
|---|---:|---:|---:|---:|---:|
| J2 | 12.00 | **13.10** | 7.88 | 0.66x | **0.60x** |
| J3 | 3.45 | 3.75 | 4.56 | 1.32x | 1.22x |
| J5 | 0.59 | **0.53** | 0.49 | 0.83x | **0.93x** |

Target = torsi statik x 2.5 (faktor dinamis dokumen). J5 justru **membaik**,
karena cluster pergelangan cetak ternyata jauh lebih ringan dari asumsi.

### Neraca, tiap kali sesuatu yang nyata masuk hitungan

| Tahap | tau_J2 | Margin J2 |
|---|---:|---:|
| dokumen riset (asumsi) | 4.80 | 0.66x |
| + massa cetak terukur (74 part) | 4.87 | 0.65x |
| + dowel pin ring (55 batang) | 5.12 | 0.62x |
| + dowel output (18 batang) | **5.24** | **0.60x** |
| + bearing, belt, baut (belum) | ~5.5 perkiraan | ~0.57x |

### Temuan: angka dokumen riset kokoh, tapi bukan karena tebakannya pas

Massa yang dibawa J2 ternyata **16% lebih berat** dari asumsi dokumen, tapi
distribusinya jauh **lebih proksimal**. Dua kesalahan itu saling meniadakan
sehingga tau_J2 cuma bergeser 1.5% (4.80 ke 4.87 sebelum dowel). Artinya angka
sizing-nya tidak sensitif terhadap tebakan yang meleset, dan itu justru bagus
untuk dipertahankan di sidang.

### Penyumbang torsi J2 terbesar

| Item | Massa | Lengan momen | tau | share |
|---|---:|---:|---:|---:|
| payload | 0.200 kg | 649 mm | 1.273 | 24% |
| motor J4 (17HS2401) | 0.280 kg | 316 mm | 0.867 | 17% |
| motor J3 (17HS2401) | 0.280 kg | 115 mm | 0.316 | 6% |
| MG996R x2 | 0.110 kg | 547, 582 mm | 0.609 | 12% |
| dowel J4 (21 batang) | 0.066 kg | 353 mm | 0.228 | 4% |
| Part 8 (forearm) | 0.048 kg | 494 mm | 0.233 | 4% |

**Seluruh 74 part cetak digabung hanya menyumbang ~1.3 N.m dari 5.24.** Yang
menentukan nasib J2 adalah payload dan motor J4, bukan struktur cetak.
Konsekuensi desain: kalau J2 perlu diselamatkan, **memindahkan motor J4 lebih
proksimal jauh lebih ampuh daripada menipiskan atau meringankan part.**

---

## 5. FEA disk cycloidal J2 (SolidWorks 2025)

Study statik pada satu keping `Cycloid Disk` J2 (19.362 cm3).

**Setelan:**

| | |
|---|---|
| Material | custom `PLA+ cetak 15% infill` |
| Elastic Modulus | 2.1e9 N/m2 (PLA pejal 3.5 GPa x 0.6 fraksi padat) |
| Poisson | 0.36 |
| Mass Density | 756 kg/m3 (ρ_eff disk terukur) |
| Yield Strength | 1.9e7 N/m2 (lihat penurunan di bawah) |
| Fixture | 6 permukaan lubang dowel output (R18), Fixed Geometry |
| Beban | Torque 6.55 N.m di bore tengah (13.10 N.m dibagi 2 disk) |
| Mesh | curvature-based, Fine |

Penurunan batas luluh, tulis eksplisit di skripsi:

```
45 MPa   yield PLA pejal (library SolidWorks)
x 0.60   fraksi padat disk (rho_eff 0.756 / 1.26)
x 0.70   adhesi antar-layer, FDM patah di batas layer
= 18.9   -> dipakai 19 MPa
```

**Hasil:**

```
von Mises maksimum = 5.67 MPa   vs batas 19 MPa
Faktor keamanan    = 3.35x
Luluh diperkirakan di ~43.9 N.m  (6.55 x 3.35 x 2 disk)
Displacement maks  = 13.1 mikrometer
```

Tegangan puncak terkonsentrasi di sekeliling bore tengah tempat bearing
eksentrik duduk, bukan di pangkal lobe.

### Kesimpulan yang penting

**Plastik bukan titik lemah J2.** Disk baru luluh di ~43.9 N.m sementara yang
dibutuhkan 13.10 N.m. Margin J2 yang 0.60x itu **murni masalah torsi motor**;
mempertebal atau memperkuat part tidak akan menolong sama sekali.

Rumus `plaCeiling()` di `studio/src/config/arm.js` menaksir ceiling J2 di
22.4 N.m (13 x 38/22). FEA memberi 43.9 N.m, jadi rumus kasar itu **terlalu
pesimis hampir 2x**. Sekarang ada angka hasil analisis untuk menggantikannya.

### Displacement dan implikasinya ke error model

Puntiran relatif disk terhadap output, dari 13.1 um di jari-jari bore 7 mm:

```
0.107 derajat @ 13.10 N.m (target dinamis)
0.043 derajat @  5.24 N.m (statik)
```

| Sumber error | Besar |
|---|---|
| kuantisasi AS5600 | 0.088° |
| defleksi elastis disk (statik) | 0.043° |
| defleksi elastis disk (target 2.5x) | 0.107° |
| backlash cycloidal (asumsi) | 0.3 - 1.0° |

**Nuansa yang menyelamatkan desain ini:** AS5600 dipasang di **output** sendi
(`src/arm/config.py`), bukan di poros motor. Encoder itu **ikut mengukur**
lenturan tersebut, jadi defleksinya berada **di dalam loop kendali** dan
dikoreksi closed-loop.

Konsekuensinya, dan ini pembedaan yang layak ditulis eksplisit:

- **akurasi posisi statik**: defleksi ini **tidak** menambah error
- **kekakuan dan respons dinamis**: defleksi ini **berpengaruh**, menambah
  kepatuhan di dalam loop, bisa memperlambat settling atau memicu osilasi kalau
  Kp dinaikkan

Kalau encoder dipasang di poros motor, kesimpulannya terbalik total. Ini
keunggulan nyata dari pilihan desain, dan sekarang ada angkanya.

### Batasan FEA ini, tulis apa adanya

1. **Beban diidealkan.** Torsi disebar merata di seluruh permukaan bore.
   Aslinya bearing eksentrik mendorong ke **satu sisi** saja, jadi tegangan
   puncak sebenarnya lebih tinggi dari 5.67 MPa. Dengan FOS 3.35 kemungkinan
   besar tetap aman, tapi jangan diklaim angka pasti.
2. **Baru satu part yang diuji.** Jalur beban berlanjut ke dowel output, housing
   output, lalu pin ring. Yang paling sering patah di cycloidal cetak 3D justru
   **housing**, bukan disk.
3. **Hanya sekitar sepertiga pin ring** menahan beban pada satu saat. Tidak
   masuk model, tapi pengaruhnya kecil karena pembebanan lewat bore bukan lewat
   lobe.

---

## 6. Pertanyaan terbuka

### 6.1 PRIORITAS: spesifikasi motor 17HS2401 belum dipastikan

`src/arm/config.py` menyebut 17HS2401 sebagai "NEMA17 40mm" dengan holding
**0.45 N.m**. Tapi kode "24" pada 17HS**24**01 lazimnya berarti badan 24 mm,
dan motor NEMA17 24 mm umumnya cuma **~0.13 N.m** dan ~0.15 kg.

`config.py` juga tidak konsisten sendiri: memberi **0.28 kg** ke
`j3_motor_relokasi` dan **0.226 kg** ke `j4_motor_relokasi`, padahal keduanya
model yang sama. Skrip ini memakai 0.28 untuk keduanya.

**Aksi: ukur panjang badan motor fisik dengan jangka sorong.** Kalau ternyata
24 mm, keluaran J3 bukan 4.56 N.m melainkan ~1.3 N.m dan **J3 jatuh dari 1.22x
ke ~0.35x**, dari yang tadinya kelihatan paling aman. Seluruh Tabel 3.4 harus
dirombak. Ini taruhannya jauh lebih besar daripada semua angka lain di dokumen
ini.

### 6.2 Validasi distribusi massa per part

Total 1054.36 g pasti benar karena itu patokan kalibrasi. Yang belum teruji
adalah **pembagiannya antar part**. Prediksi model per plate:

| Plate | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| prediksi (g) | 101.6 | **194.8** | 155.0 | 108.4 | 107.8 | 89.9 | 96.6 | 68.0 | 74.2 | 58.1 |

**Aksi:** di Bambu Studio, slice satu plate saja (mis. Plate 2), baca gramnya,
bandingkan dengan prediksi. Selisih di bawah ~5% berarti distribusinya bisa
dipercaya.

### 6.3 Anomali tebal instance Cycloid Disk di STEP

Dimensi robust dari awan titik STEP menunjukkan:

| Lokasi | OD | Tebal terbaca | Tebal cetak |
|---|---:|---:|---:|
| J2 (2 instance) | 72.0 | 6.0 mm | 6.0 mm |
| J3 (2 instance) | 56.9 | 6.0 mm | 6.0 mm |
| J4 (2 instance) | 66.5 | **14.1 mm** | 6.0 mm |

Instance J4 tebalnya kira-kira dua kali keping cetak, tapi part yang dibuka di
SolidWorks (`Cycloid Disk-3`, 2 bodi, total 38723 mm3 = 2 x 19362) justru
berukuran **J2**. Kedua fakta itu belum bisa didamaikan dari file saja.

Dampaknya ke agregat kecil (pencocokan sekarang memakai OD, bukan tebal, jadi
kebal terhadap anomali ini), tapi **jumlah keping disk sebenarnya per sendi
perlu dipastikan** sebelum jumlah disk dikutip di Bab III.

**Aksi:** di SolidWorks, buka satu instance Cycloid Disk di tiap sendi lalu
hitung jumlah solid body-nya.

### 6.4 Belum masuk hitungan sama sekali

Bearing, belt HTD3M, dan baut. Perkiraan menambah **0.2 sampai 0.4 N.m** ke
tau_J2, cukup menggeser margin J2 dari 0.60x ke sekitar 0.57x. Bearing yang
paling berpengaruh karena berat dan sering duduk jauh dari sumbu.

Butuh: tipe dan jumlah bearing per sendi, panjang closed-loop dan lebar belt
tiap stage, perkiraan gelondongan jumlah dan ukuran baut.

---

## 7. Yang SENGAJA belum diubah

`src/arm/config.py` **belum disentuh**. `MASSES`, `JOINT_LIMITS_DEG`, dan
katalog `MOTORS` masih berisi angka lama.

Alasannya pertanyaan 6.1: kalau motor 17HS2401 ternyata 24 mm, yang berubah
bukan cuma massa melainkan holding torque, tabel sizing, target per sendi, dan
seluruh kesimpulan Bab IV. Mengganti massa duluan lalu motor belakangan berarti
menjalankan ulang seluruh `benchmarks/` dua kali dan menerbitkan satu putaran
angka yang salah.

Urutan yang benar: **pastikan spesifikasi motor dulu**, baru perbarui
`config.py` sekali jalan. Setelah itu jalankan ulang `python -m arm.torque`,
seluruh `benchmarks/`, dan perbarui tabel di `README.md` serta Tabel 3.4 Bab III.

Batas sendi (`JOINT_LIMITS_DEG`) juga masih asumsi. Jangan dikerjakan di
SolidWorks: semua part di import STEP statusnya fixed tanpa mate sama sekali,
jadi harus di-mate ulang seluruh lengan. **Kerjakan di Onshape**, di sana
assembly-nya punya mate asli, tinggal putar tiap sendi sampai bentrok.
