# Outline Skripsi — Panduan Penulisan

> **Judul:** Rancang Bangun Robotic Arm 6-DOF 3D Printed dengan Mekanisme
> Position Feedback dan Interface Digital Twin Berbasis Web

Dokumen ini adalah **kerangka isi** yang dipindahkan ke template Word kampus.
Tiap bagian berisi poin yang harus ditulis + petunjuk sumber data dari repo.
Hapus petunjuk dalam *italic* saat menyalin ke naskah final.

---

## Halaman Awal (Front Matter)

- Halaman judul (sesuai format kampus)
- Lembar pengesahan
- Lembar pernyataan keaslian
- Abstrak (ID + EN) — *tulis terakhir; 200–250 kata: masalah, metode, hasil utama (mis. validasi torsi & latensi digital twin), kesimpulan*
- Kata pengantar
- Daftar isi, daftar gambar, daftar tabel, daftar lambang/singkatan

---

## BAB I — PENDAHULUAN

### 1.1 Latar Belakang
- Lengan robot industri mahal & tertutup; kebutuhan alternatif murah, open source,
  dapat direplikasi (manufaktur cetak 3D).
- Tantangan lengan cetak 3D: torsi rendah & backlash pada gearbox → solusi
  **cycloidal drive** + **position feedback** (closed-loop) untuk akurasi.
- Kebutuhan monitoring/kontrol jarak jauh & visualisasi → **digital twin web**.

### 1.2 Rumusan Masalah
1. Bagaimana merancang & membangun lengan 6-DOF cetak 3D dengan cycloidal drive
   yang mampu menahan beban kerja (payload 0.5 kg pada jangkauan 0.70 m)?
2. Bagaimana menerapkan mekanisme position feedback (encoder + closed-loop) untuk
   meningkatkan akurasi posisi?
3. Bagaimana membangun interface digital twin berbasis web yang mencerminkan dan
   mengendalikan lengan fisik secara real-time?

### 1.3 Tujuan Penelitian
*Sejajarkan satu-per-satu dengan rumusan masalah di atas.*

### 1.4 Batasan Masalah
- 6-DOF, jangkauan ~0.70 m, payload uji 0.5 kg.
- Material cetak: PLA+/ABS/PETG (sesuai sendi).
- Aktuator: stepper NEMA17/23; encoder AS5600.
- Digital twin: web (Three.js), komunikasi serial↔WebSocket lokal.

### 1.5 Manfaat Penelitian
- Akademis: referensi desain cycloidal cetak 3D + digital twin.
- Praktis: platform open source murah untuk edukasi/riset robotika.

### 1.6 Sistematika Penulisan

---

## BAB II — TINJAUAN PUSTAKA / LANDASAN TEORI

### 2.1 Penelitian Terdahulu (state of the art)
*Tabel perbandingan: lengan cetak 3D open source lain (mis. proyek serupa),
metode reduksi, ada/tidaknya feedback & digital twin. Tonjolkan celah yang diisi.*

### 2.2 Robot Manipulator & Derajat Kebebasan (DOF)
- Definisi manipulator serial, konfigurasi antropomorfik, spherical wrist.

### 2.3 Kinematika
- Parameter Denavit-Hartenberg (DH), forward kinematics.
- *Sumber implementasi: `src/arm/kinematics.py` (tabel DH & matriks transformasi).*

### 2.4 Cycloidal Drive
- Prinsip kerja, rasio reduksi, load-sharing pin, efisiensi.
- Kelebihan vs planetary/harmonic: backlash rendah, kompak, dapat dicetak.

### 2.5 Aktuator Stepper & Sizing Torsi
- Holding vs running torque, kurva torsi-kecepatan, microstepping.
- Metode sizing momen statik: τ = g·Σ(m·d), faktor keamanan, derate.
- *Sumber: `docs/research/motor-cycloidal-sizing.md` + `src/arm/torque.py`.*

### 2.6 Position Feedback & Kontrol Closed-Loop
- Encoder magnetik absolut AS5600, I2C multiplexer TCA9548A.
- Konsep kontrol P/PID untuk koreksi posisi.

### 2.7 Sifat Material Cetak 3D
- Anisotropi FDM, kekuatan tarik & bearing PLA+/ABS/PETG, orientasi layer.
- *Sumber: dokumen riset §5 (termasuk Khosravani et al. 2023, Polymers).*

### 2.8 Digital Twin & Teknologi Web
- Konsep digital twin (mirror + kontrol real-time).
- Three.js (render 3D), WebSocket (komunikasi real-time), arsitektur bridge.

---

## BAB III — METODOLOGI / PERANCANGAN

### 3.1 Diagram Blok Sistem
*Gunakan diagram arsitektur dari README (lengan→firmware→bridge→digital twin).*

### 3.2 Perancangan Mekanik
- Proporsi link (upper arm 0.33 m, forearm 0.27 m, wrist 0.10 m).
- Desain cycloidal per sendi (pin circle, jumlah lobe, rasio).
- *Parameter: `src/arm/config.py`.*

### 3.3 Perhitungan & Sizing
- Hitung torsi statik tiap sendi, tentukan rasio & motor.
- *Tabel hasil: output `python -m arm.torque` (lampirkan ke naskah).*
- Analisis tegangan kontak (Hertzian) & kelayakan material.

### 3.4 Perancangan Elektronik & Wiring
- Skema daya 24 V, driver, MCU, encoder + mux, diagram pengkabelan.

### 3.5 Perancangan Perangkat Lunak
- **Firmware**: closed-loop, protokol serial (`firmware/`).
- **Bridge**: serial↔WebSocket (`src/arm/bridge.py`).
- **Digital twin**: model 3D & UI (`studio/`).

### 3.6 Metode Pengujian
- Uji torsi (tuas + timbangan), uji efisiensi, uji akurasi posisi (target vs
  encoder), uji latensi digital twin (real-time mirror).
- *Skrip: `benchmarks/` + uji otomatis `tests/`.*

### 3.7 Jadwal Penelitian
*Selaraskan dengan roadmap di README utama.*

---

## BAB IV — HASIL DAN PEMBAHASAN

### 4.1 Realisasi Mekanik
*Foto hasil cetak & rakitan tiap sendi, terutama wrist cluster → siku → bahu.*

### 4.2 Hasil Sizing & Validasi Torsi
- Tabel torsi terukur vs prediksi (`benchmarks/torque_test.py`), plot.
- Pembahasan deviasi (efisiensi nyata, load-sharing, backlash).

### 4.3 Hasil Efisiensi Cycloidal
- `benchmarks/efficiency_test.py`; bandingkan dengan asumsi η = 0.75.

### 4.4 Pengujian Position Feedback
- Akurasi & repeatability posisi (target vs aktual encoder), grafik error.

### 4.5 Pengujian Digital Twin
- Latensi & kesesuaian visual mirror; skenario kontrol dari web.

### 4.6 Pembahasan Keseluruhan
- Sendi mana yang memenuhi/marginal/kurang (bahu & siku = titik kritis).
- Keterbatasan: backlash, batas torsi PLA+, dll.

---

## BAB V — PENUTUP

### 5.1 Kesimpulan
*Jawab tiap rumusan masalah dengan angka hasil.*

### 5.2 Saran
- Material PA-CF/PETG-CF untuk bahu, pin circle lebih besar, dua tahap reduksi,
  kontrol PID lebih canggih, kinematika balik (IK) & trajectory planning.

---

## DAFTAR PUSTAKA
*Gunakan gaya sitasi sesuai kampus (IEEE/APA). Kelola referensi di `refs.bib`
atau Mendeley/Zotero. Sumber awal sudah terkumpul di
`docs/research/motor-cycloidal-sizing.md` (HowToMechatronics, eSUN TDS,
Khosravani et al. 2023, StepperOnline, dll).*

## LAMPIRAN
- A. Kode program (atau tautan repo GitHub).
- B. Tabel sizing lengkap (output `arm.torque`).
- C. Skema wiring & BOM.
- D. Gambar teknik / CAD.

---

### Tips alur kerja
- Tulis BAB III–IV paralel dengan progres repo; tiap milestone roadmap →
  satu sub-bab hasil.
- Simpan semua gambar di `thesis/figures/`.
- Naskah final `.docx` di-ignore git; outline `.md` ini tetap di-track sebagai
  sumber kebenaran struktur.
