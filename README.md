# Robotic Arm 6-DOF 3D Printed — Cycloidal Drive

> **Skripsi:** *Rancang Bangun Robotic Arm 6-DOF 3D Printed dengan Mekanisme
> Position Feedback dan Interface Digital Twin Berbasis Web*

[![CI](https://github.com/kutilz/robotic-arm/actions/workflows/ci.yml/badge.svg)](https://github.com/kutilz/robotic-arm/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Lengan robot 6 derajat kebebasan (6-DOF) yang dicetak 3D sepenuhnya dengan
**reduksi cycloidal custom** + stepper NEMA17/23, dilengkapi **position feedback**
(encoder magnetik AS5600, kontrol closed-loop) dan **digital twin berbasis web**
yang mencerminkan posisi lengan fisik secara real-time.

Proyek ini open source: silakan dipelajari, direplikasi, dan dikembangkan.

---

## Arsitektur sistem

```
   Lengan fisik (6x stepper + 6x encoder AS5600)
              |  step/dir          ^ I2C (TCA9548A mux)
              v                    |
   Firmware Arduino  (closed-loop position control)   firmware/
              |  serial 115200  "GO,.."  /  "FB,.."
              v
   Bridge Python  (serial  <->  WebSocket)            src/arm/bridge.py
              |  WebSocket ws://localhost:8765
              v
   Digital Twin Web  (Three.js, mirror real-time)     studio/index.html
```

Tiga kontribusi skripsi yang tercermin di repo:
1. **Rancang bangun mekanik** — gearbox cycloidal cetak 3D, sizing motor/gearbox
   (`docs/research/`, dikodekan & diuji di `src/arm/torque.py`).
2. **Position feedback** — encoder AS5600 + kontrol closed-loop (`firmware/`).
3. **Digital twin web** — visualisasi & kontrol real-time (`studio/` + `bridge.py`).

---

## Struktur repositori

| Folder | Isi |
|---|---|
| `src/arm/` | Paket Python: `config` (parameter), `torque` (sizing), `kinematics` (FK), `bridge` (digital twin) |
| `firmware/` | Sketch Arduino: kontrol stepper closed-loop + encoder AS5600 |
| `benchmarks/` | Skrip benchmark torsi & efisiensi (prediksi vs terukur) |
| `studio/` | Digital twin web (Three.js) — Cycloidal Arm Studio |
| `thesis/` | Outline & panduan penulisan skripsi (template Word) |
| `docs/research/` | Dokumen riset sizing motor & cycloidal drive |
| `tests/` | Uji otomatis (memverifikasi perhitungan = dokumen riset) |

---

## Mulai cepat (quick start)

```bash
# 1. Pasang dependensi Python
pip install -e ".[dev]"          # atau: pip install -r requirements.txt

# 2. Cetak tabel sizing motor/gearbox per sendi
python -m arm.torque

# 3. Jalankan uji (memverifikasi perhitungan cocok dokumen riset)
pytest -q

# 4. Jalankan digital twin tanpa hardware (mode simulasi)
python -m arm.bridge --simulate
#    lalu buka studio/index.html di browser, sambungkan ke ws://localhost:8765

# 5. Dengan hardware nyata:
python -m arm.bridge --port COM5     # Windows  (atau /dev/ttyUSB0 di Linux)
```

---

## Ringkasan hasil sizing (output `python -m arm.torque`)

| Joint | Fungsi | Statik | Perlu (×2.5) | Rasio | Motor |
|---|---|---|---|---|---|
| J1 | base yaw | ~0 | 3.0 N·m | 1:20 | 17HS19-2004S1 |
| **J2** | **shoulder** | **11.4 N·m** | **~29 N·m** | **1:55** | **NEMA23** |
| **J3** | **elbow** | **4.5 N·m** | **~11 N·m** | **1:50** | 17HS19-2004S1 |
| J4 | wrist roll | ~0 | 1.0 N·m | 1:15 | 17HS4401 |
| J5 | wrist pitch | 0.69 N·m | 1.7 N·m | 1:15 | 17HS4401 |
| J6 | end roll | ~0 | 0.5 N·m | 1:15 | 17HS4401 |

Temuan kunci: **bahu (J2) dan siku (J3) adalah inti masalah desain** — keduanya
mendekati/melebihi batas torsi PLA+ cetak (~13 N·m). Rincian & sumber: lihat
[`docs/research/motor-cycloidal-sizing.md`](docs/research/motor-cycloidal-sizing.md).

---

## Roadmap skripsi

- [x] Riset & sizing motor/gearbox per sendi
- [x] Kode perhitungan torsi + kinematika + uji otomatis
- [x] Digital twin web (mode simulasi)
- [ ] Cetak & rakit wrist cluster (J4/J5/J6) — validasi 1:15
- [ ] Prototipe siku (J3) 1:50 — uji ke ~11 N·m
- [ ] Integrasi encoder AS5600 + closed-loop di firmware
- [ ] Bridge real-time hardware <-> digital twin
- [ ] Benchmark torsi & efisiensi (prediksi vs terukur)
- [ ] Penulisan bab skripsi

---

## Lisensi & sitasi

Dilisensikan di bawah [MIT](LICENSE). Bila proyek ini membantu riset Anda, mohon
sitasi (lihat [`CITATION.cff`](CITATION.cff)).

Kontribusi dipersilakan — lihat [`CONTRIBUTING.md`](CONTRIBUTING.md).
