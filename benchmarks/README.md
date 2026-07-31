# Benchmarks

Dua kelompok skrip:

1. **Benchmark hardware** (`torque_test`, `efficiency_test`, `accuracy_test`,
   `latency_test`): membaca CSV hasil ukur nyata lalu membandingkan dengan
   prediksi. Bukti empiris untuk Bab IV.
2. **Simulasi desain** (`workspace_sim`, `torque_map`, `ik_verify`,
   `error_model`, `current_derating`, `payload_map`): menghasilkan sendiri data
   dari parameter CAD di `src/arm/config.py` (via modul bersama `armlib.py`).
   Dipakai untuk analisis workspace, sizing, kinematika, anggaran error,
   derating arus, dan kapasitas payload sebelum hardware jadi.

Semua parameter fisik dibaca dari `src/arm/config.py`; jangan hardcode ulang.
Tiap skrip punya `--help`, menulis CSV + PNG ke `benchmarks/data/`.

**Gaya grafik** diatur terpusat di `vizstyle.py`: palet kategorikal tervalidasi
CVD, colormap sekuensial satu hue untuk besaran, dan helper penyorotan angka
kunci. Jangan menambah warna ad hoc di skrip; ambil dari `vizstyle`.

**Pengaman data contoh**: `datacheck.warn_if_sample()` mencetak peringatan
mencolok bila masukan berupa `*_sample.csv`, supaya data contoh tidak pernah
tersalin ke Bab IV.

---

## Benchmark hardware

Mengukur performa aktual lengan dan membandingkannya dengan prediksi sizing.
Selain tabel di terminal dan PNG, tiap skrip kini juga menulis **CSV ringkasan**
yang kolomnya sudah sesuai tabel Bab IV, jadi pengisian tabel tinggal menyalin.

### 1. Benchmark torsi (`torque_test.py`)

**Metode tuas + timbangan**: pasang tuas sepanjang `lever_arm_m` pada output
sendi, tarik dengan timbangan gantung sampai sendi mulai bergerak, catat
`scale_kg`.

```
torsi_terukur (N·m) = scale_kg × 9.81 × lever_arm_m
```

```bash
python benchmarks/torque_test.py benchmarks/data/torque_run1.csv
```

Dibandingkan dengan **dua** prediksi sekaligus: torsi pada arus rated (asumsi
Tabel 3.4) dan torsi pada setelan arus firmware yang nyata. Hasil ukur inilah
yang menentukan model mana yang berlaku. Keluaran: `data/torque_summary.csv`
(Tabel 4.4) dan `data/torque_benchmark.png`.

### 2. Benchmark efisiensi (`efficiency_test.py`)

```
efisiensi = torsi_output_terukur / (torsi_input_motor × rasio_reduksi)
```

```bash
python benchmarks/efficiency_test.py benchmarks/data/efficiency_run1.csv
```

Validasi asumsi sizing η = 0,75. Bila efisiensi terukur ≥ 0,85, rasio bahu bisa
diturunkan. Keluaran: `data/efficiency_summary.csv` (Tabel 4.5) dan
`data/efficiency_benchmark.png`.

Kolom `ratio` harus berisi rasio tahap yang benar-benar diukur. Untuk J3 yang
memakai belt 3:1 lalu cycloidal 1:10, mengukur dari poros motor berarti rasio 30
dan yang terhitung adalah efisiensi gabungan, bukan cycloidal saja.

### 3. Benchmark akurasi posisi (`accuracy_test.py`): pilar Position Feedback

Hasil pamungkas skripsi. Metrik ISO 9283 diadaptasi ke ruang sendi:

```
AP_theta = |rata-rata(measured) - commanded|     per posisi perintah
RP_theta = 3 × S_theta                           S = SD sampel (pembagi n-1)
```

Repeatability dihitung **per posisi perintah** lalu digabung antarposisi secara
pooled. Menghitung SD dari seluruh pembacaan sekaligus salah, karena angkanya
ikut memuat rentang gerak, bukan sebaran pengulangan.

```bash
python benchmarks/accuracy_test.py benchmarks/data/accuracy_run1.csv
```

Keluaran: `data/accuracy_summary.csv` (Tabel 4.6) dan
`data/accuracy_benchmark.png`. Skrip memperingatkan bila n per posisi di bawah
30 (anjuran ISO 9283).

> **Validitas.** AS5600 adalah sekaligus sensor umpan balik dan alat ukur. Untuk
> open-loop ini sah karena encoder tidak menentukan perintah. Untuk closed-loop,
> selisih perintah dan pembacaan encoder adalah **residual loop kontrol**, bukan
> akurasi absolut. Laporkan apa adanya di Bab IV.

### 4. Benchmark latensi digital twin (`latency_test.py`): pilar Digital Twin

Latensi end-to-end (target < 100 ms), update rate (target ≥ 30 Hz), dan sync
error sudut twin terhadap fisik.

```bash
python benchmarks/latency_test.py benchmarks/data/latency_run1.csv
```

Keluaran: `data/latency_summary.csv` (Tabel 4.9) dan
`data/latency_benchmark.png`.

### Format data (benchmark hardware)

| File masukan | Kolom |
|---|---|
| `torque_*.csv` | `joint,lever_arm_m,scale_kg` |
| `efficiency_*.csv` | `joint,output_nm,input_nm,ratio` |
| `accuracy_*.csv` | `joint,mode,commanded_deg,measured_deg,run` (mode=open\|closed) |
| `latency_*.csv` | `sample,t_physical_ms,t_display_ms,angle_physical,angle_twin` |

CSV `*_sample.csv` adalah contoh format saja, **bukan hasil**. File `*_run*.csv`
dan `*.png` di-ignore git (lihat `.gitignore`).

---

## Simulasi desain

Modul bersama `armlib.py`: sampling sudut dalam joint limit, FK batch (numpy),
Jacobian numerik, indeks manipulability, model torsi gravitasi, util plot/CSV.
Batas sudut (ASUMSI, dari `arm.js`) ada di `config.JOINT_LIMITS_DEG`.

### 5. Peta workspace (`workspace_sim.py`)

Monte Carlo sudut sendi -> point cloud TCP. Melapor volume reachable (voxel),
reach maksimum dari sumbu J2 (verifikasi target 600 mm), dan dead zone silinder
akibat offset lateral bidang drive.

Grafik memakai penampang meridian (rho, z) dengan rho jarak radial ke sumbu
base, sehingga **seluruh** sampel terpakai. Versi lama memotong pita tipis
|y| < 15 mm sehingga hanya sekitar satu persen sampel yang tergambar.

```bash
python benchmarks/workspace_sim.py --samples 120000 --seed 1
```

### 6. Peta torsi workspace (`torque_map.py`)

Sweep theta2 x theta3 penuh, hitung torsi gravitasi J2 dan J3 (payload 0,2 kg),
ditimpa kontur kapasitas aktuator. Melapor persen pose yang memenuhi target
dinamis dan faktor nyata pada pose terberat.

```bash
python benchmarks/torque_map.py --payload 0.2 --grid 121
```

### 7. Verifikasi IK (`ik_verify.py`)

IK closed-form (anthropomorphic + spherical wrist, kriteria Pieper). Round-trip
FK(IK(pose)) di ribuan pose acak, lapor residual posisi dan orientasi, plus peta
manipulability Yoshikawa untuk lokasi singularity (siku terentang, wrist th5=0).

```bash
python benchmarks/ik_verify.py --samples 6000 --seed 3
```

### 8. Propagasi error posisi (`error_model.py`)

Error sudut per sendi dipropagasi ke error posisi TCP lewat Jacobian, Monte
Carlo. Sumber error dibedakan per jalur umpan balik: J1-J4 kuantisasi AS5600 +
akurasi absolut + backlash gearbox; J5/J6 kuantisasi ADC saja tanpa backlash.

```bash
python benchmarks/error_model.py --samples 5000 --backlash 0.3 1.0
```

### 9. Derating arus driver (`current_derating.py`)

Menjawab masalah yang tidak terlihat di tabel sizing: holding torque datasheet
berlaku pada **arus rated**, sedangkan firmware menyetel TMC2209 di bawah rated
karena batas termal (`TMC_MA_DEFAULT = {1000, 1200, 1000, 1000}` mA RMS untuk
motor rated 1,7 dan 2,0 A). Skrip menghitung margin torsi tiap sendi sebagai
fungsi setelan arus, dan arus minimum yang masih memenuhi kebutuhan.

Dua tafsir "arus rated" dihitung keduanya: model A (I_puncak = I_RMS × √2,
tafsir standar) dan model B (skala langsung terhadap I_RMS, batas bawah
pesimistis). Selisihnya diselesaikan oleh pengukuran torsi di Bab IV.

```bash
python benchmarks/current_derating.py --max-ma 1800
```

### 10. Kapasitas payload (`payload_map.py`)

Prediksi payload maksimum, yang sebelumnya tidak pernah dihitung padahal Tabel
3.8 menargetkan 0,2 kg. Dua sudut pandang: faktor torsi terhadap payload pada
pose terberat, dan payload maksimum yang **dijamin** pada tiap jangkauan
horizontal (tiap titik diambil dari pose terberat pada jangkauan itu, bukan pose
termudah). Batas J5 digambar sebagai plafon mendatar karena tidak bergantung
pose.

```bash
python benchmarks/payload_map.py --max-payload 1.5
```

Output `*.csv`/`*.png` seluruh simulasi di-ignore git (regenerable).

---

## Urutan menjalankan ulang seluruh simulasi desain

```bash
python benchmarks/workspace_sim.py --samples 120000 --seed 1
python benchmarks/torque_map.py --payload 0.2 --grid 121
python benchmarks/ik_verify.py --samples 6000 --seed 3
python benchmarks/error_model.py --samples 5000 --backlash 0.3 1.0
python benchmarks/current_derating.py --max-ma 1800
python benchmarks/payload_map.py --max-payload 1.5
```
