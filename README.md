# Robotic Arm 6-DOF 3D Printed — Cycloidal Drive

> **Skripsi:** *Rancang Bangun Robotic Arm 6-DOF 3D Printed dengan Mekanisme
> Position Feedback dan Interface Digital Twin Berbasis Web*

[![CI](https://github.com/kutilz/robotic-arm/actions/workflows/ci.yml/badge.svg)](https://github.com/kutilz/robotic-arm/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Lengan robot 6 derajat kebebasan (6-DOF) yang dicetak 3D sepenuhnya dengan
**reduksi cycloidal custom** + 4× stepper NEMA17 (J1-J4: 17HS2401 ×3 dan
17HS6401S ×1) & 2× servo MG996R (J5-J6), dilengkapi **position feedback**
(4× encoder magnetik AS5600 di output J1-J4, pot internal servo untuk J5/J6,
kontrol closed-loop) dan **digital twin berbasis web** yang mencerminkan posisi
lengan fisik secara real-time.

Proyek ini open source: silakan dipelajari, direplikasi, dan dikembangkan.

---

## Arsitektur sistem

```
   Lengan fisik (4x stepper NEMA17 + 2x servo MG996R + 4x encoder AS5600)
              |  step/dir (TMC2209) + PWM          ^ I2C (TCA9548A mux)
              |                                    ^ ADC1 (pot servo J5/J6)
              v                                     |
   Firmware ESP32  (closed-loop position control)   firmware/arm_controller_esp32/
              |  WebSocket ws://<esp32>:81  (JSON: goto/feedback/estop/cal)
              v
   Digital Twin Web  (Three.js, mirror real-time)    studio/index.html
```

ESP32 melayani WebSocket sendiri — tak perlu bridge untuk hardware nyata.
Bridge Python (`src/arm/bridge.py`) kini opsional, dipakai untuk mode
`--simulate` (digital twin tanpa hardware) atau board Mega legacy.

Tiga kontribusi skripsi yang tercermin di repo:

1. **Rancang bangun mekanik** — gearbox cycloidal cetak 3D, sizing motor/gearbox
   (`docs/research/`, dikodekan & diuji di `src/arm/torque.py`).
2. **Position feedback** — 4× encoder AS5600 di output J1-J4 + pot internal
   servo J5/J6, kontrol closed-loop (`firmware/`).
3. **Digital twin web** — visualisasi & kontrol real-time (`studio/`, opsional
   `bridge.py` untuk simulasi).

---

## Struktur repositori

| Folder           | Isi                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| `src/arm/`       | Paket Python: `config` (parameter), `torque` (sizing), `kinematics` (FK), `bridge` (digital twin) |
| `firmware/`      | Sketch ESP32 (aktif) + legacy Mega: kontrol stepper/servo closed-loop + encoder AS5600            |
| `benchmarks/`    | Skrip benchmark torsi & efisiensi (prediksi vs terukur)                                           |
| `studio/`        | Digital twin web (Three.js) — Cycloidal Arm Studio                                                |
| `thesis/`        | Outline & panduan penulisan skripsi (template Word)                                               |
| `docs/research/` | Dokumen riset sizing motor & cycloidal drive                                                      |
| `tests/`         | Uji otomatis (memverifikasi perhitungan = dokumen riset)                                          |

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

| Joint  | Fungsi       | Statik      | Target      | Rasio    | Drive                                 | Motor         | Keluaran | Margin    |
| ------ | ------------ | ----------- | ----------- | -------- | ------------------------------------- | ------------- | -------- | --------- |
| J1     | base yaw     | ~0          | 3 N·m       | 1:15     | belt HTD3M 2-stage (12→60, 20→60)     | 17HS2401      | 2.73 N·m | 0.91×     |
| **J2** | **shoulder** | **4.8 N·m** | **~12 N·m** | **1:30** | **cycloidal DIRECT, single motor**    | **17HS6401S** | 7.88 N·m | **0.66×** |
| J3     | elbow        | 1.38 N·m    | ~3.5 N·m    | 1:30     | motor relokasi + belt 3:1 + cyc 1:10  | 17HS2401      | 4.56 N·m | 1.32×     |
| J4     | wrist roll   | ~0          | 1 N·m       | 1:15     | motor relokasi + cycloidal (TENTATIF) | 17HS2401      | 2.53 N·m | 2.53×     |
| J5     | wrist pitch  | 0.23 N·m    | 0.59 N·m    | direct   | servo direct, feedback pot internal   | MG996R        | 0.49 N·m | **0.83×** |
| J6     | end roll     | ~0          | 0.3 N·m     | direct   | servo direct, feedback pot internal   | MG996R        | 0.49 N·m | 1.62×     |

Target J1/J4/J6 dari pertimbangan inersia; J2/J3/J5 = torsi statik × faktor
dinamis 2.5. Margin = keluaran / target.

Temuan kunci: **hanya bahu (J2) yang mendekati batas torsi PLA+ cetak** (ceiling
~13 N·m @ pin-circle 22mm, di-upsize khusus J2 ke ~28-30mm agar ceiling naik ke
~17 N·m). J3-J6 semua jauh di bawah ceiling → aman di PLA+/PETG. J2 dan J5
berstatus 🟡 *conditional* (marginal di faktor dinamis 2.5×; J2 sanggup menahan
100% workspace secara statik tetapi hanya 73.6% pada target 2.5×). J1 sedikit di
bawah target inersia (0.91×). Mitigasi opsional counterbalance/rasio/motor
cadangan — lihat dokumen. Rincian & sumber: lihat
[`docs/research/arsitektur_final_robotic_arm_6dof.md`](docs/research/arsitektur_final_robotic_arm_6dof.md).

---

## Roadmap skripsi

- [x] Riset & sizing motor/gearbox per sendi
- [x] Kode perhitungan torsi + kinematika + uji otomatis
- [x] Digital twin web (mode simulasi)
- [ ] Cetak & rakit wrist cluster — validasi J4 cycloidal 1:15 + J5/J6 servo direct
- [ ] Prototipe siku (J3) 1:30 — uji ke ~3.5 N·m
- [ ] Integrasi 4 encoder AS5600 (J1-J4) + closed-loop di firmware
- [ ] Bridge real-time hardware <-> digital twin
- [ ] Benchmark torsi & efisiensi (prediksi vs terukur)
- [ ] Penulisan bab skripsi

---

## Lisensi & sitasi

Dilisensikan di bawah [MIT](LICENSE). Bila proyek ini membantu riset Anda, mohon
sitasi (lihat [`CITATION.cff`](CITATION.cff)).

Kontribusi dipersilakan — lihat [`CONTRIBUTING.md`](CONTRIBUTING.md).
