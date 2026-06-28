# Firmware — kontrol lengan 6-DOF

Sketch Arduino untuk kontrol stepper closed-loop dengan position feedback.

## Hardware

| Komponen | Detail |
|---|---|
| MCU | Arduino Mega 2560 (≥6 pasang pin step/dir) atau setara |
| Driver stepper | DM542T (J1–J3) / TMC2209 (J4–J6), **24 V+** |
| Stepper | NEMA23 (J2), 17HS19-2004S1 (J1, J3), 17HS4401 (J4–J6) |
| Encoder | 6× AS5600 (magnetik absolut 12-bit) |
| I2C mux | TCA9548A (semua AS5600 ber-alamat sama 0x36) |

## Library

Pasang via Arduino Library Manager:
- **AccelStepper** (akselerasi/kecepatan stepper)
- **Wire** (bawaan, I2C)

## Protokol serial (115200 baud)

| Arah | Format | Arti |
|---|---|---|
| Host → MCU | `GO,a1,a2,a3,a4,a5,a6\n` | sudut target tiap sendi (derajat) |
| MCU → Host | `FB,a1,a2,a3,a4,a5,a6\n` | sudut aktual dari encoder (~50 Hz) |

Bridge Python (`src/arm/bridge.py`) berbicara protokol ini dan menjembatani ke
digital twin web.

## Kalibrasi (wajib sebelum hardware nyata)

1. Set `STEP_PIN`/`DIR_PIN` sesuai wiring.
2. Sesuaikan `MICROSTEP` dengan setting driver.
3. Verifikasi `RATIO[]` cocok dengan reduksi cycloidal terpasang (lihat
   `src/arm/config.py`).
4. Tuning `KP` dan `DEADBAND_DEG` untuk gerak halus tanpa osilasi.
5. Set offset nol encoder tiap sendi (homing).

> ⚠️ Skeleton ini perlu dikalibrasi & diuji bertahap. Mulai dari wrist cluster
> (J4/J5/J6) yang sudah terbukti, lalu siku, lalu bahu (lihat roadmap di README utama).
