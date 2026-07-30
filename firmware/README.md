# Firmware — kontrol lengan 6-DOF

Dua sketch:

| Sketch                      | Board             | Status                                                               |
| --------------------------- | ----------------- | -------------------------------------------------------------------- |
| **`arm_controller_esp32/`** | ESP32 DevKit v1   | **AKTIF** — arsitektur fix 4 stepper + 2 servo, WiFi langsung ke web |
| `arm_controller/`           | Arduino Mega 2560 | Legacy — desain lama 6 stepper hibrida (serial + Python bridge)      |

## Arsitektur fix (ESP32)

Selaras dengan `studio/src/config/arm.js` (arsitektur terkunci, Pre-CAD).

| Sendi          | Aktuator          | Reduksi | Driver     | Position feedback      |
| -------------- | ----------------- | ------- | ---------- | ---------------------- |
| J1 Base yaw    | stepper 17HS2401  | 1:15    | TMC2209    | AS5600 @ output (ch 0) |
| J2 Shoulder    | stepper 17HS6401S | 1:30    | TMC2209    | AS5600 @ output (ch 1) |
| J3 Elbow       | stepper 17HS2401  | 1:30    | TMC2209    | AS5600 @ output (ch 2) |
| J4 Wrist roll  | stepper 17HS2401  | 1:15    | TMC2209    | AS5600 @ output (ch 3) |
| J5 Wrist pitch | servo MG996R      | direct  | (internal) | pot internal via ADC1  |
| J6 End roll    | servo MG996R      | direct  | (internal) | pot internal via ADC1  |

- **4 stepper** semua pakai driver **TMC2209** dengan **kontrol penuh via UART**
  (arus per-motor, microstep, stealthChop, StallGuard, diagnostik). Step tetap
  lewat pin STEP/DIR; UART untuk konfigurasi & diagnostik. **4 encoder AS5600**
  (absolut 12-bit = 0.088°) di output sendi J1–J4, via mux I2C **TCA9548A**
  (semua AS5600 ber-alamat 0x36, channel 0–3).
- **2 servo MG996R** (J5/J6) via PWM 50 Hz, direct drive tanpa reduksi.
  Feedback posisinya dari potensiometer internal servo yang disadap ke **ADC1
  internal ESP32** (GPIO 34/35, `SERVO_FEEDBACK 1`) — bukan AS5600, bukan
  ADS1115, dan tidak lewat mux.
- **Load cell + HX711** (opsional, `USE_HX711 1`) untuk bench uji torsi:
  DT=GPIO36, SCK=GPIO4, bit-bang non-blocking (~10 Hz). Firmware lapor counts +
  gram; konversi gram→torsi di studio.
- **Mode bench tanpa mux:** TCA9548A di-probe saat boot; tak terdeteksi →
  AS5600 dianggap tunggal langsung di bus, hanya J1 ber-encoder, J2–J4
  langsung open-loop (guardrail: 4 joint tidak boleh diam-diam membaca satu
  chip yang sama).

### Bus UART TMC2209 (single-wire, 4 driver berbagi 1 UART)

```
ESP32 TX2 (GPIO17) --[1kΩ]--+-- PDN_UART J1..J4
ESP32 RX2 (GPIO16) ---------+
```

Alamat tiap driver di-set lewat **jumper MS1/MS2 di modul** (bukan pin ESP32);
saat UART aktif kedua pin itu jadi pin alamat, microstep di-set via register UART:

| Driver | MS1  | MS2  | Alamat |
| ------ | ---- | ---- | ------ |
| J1     | LOW  | LOW  | 0b00   |
| J2     | HIGH | LOW  | 0b01   |
| J3     | LOW  | HIGH | 0b10   |
| J4     | HIGH | HIGH | 0b11   |

Arus, microstep, mode chopper, dan arus tahan sekarang **runtime** (kalibrasi
`tmc_ma[4]` / `tmc_microstep` / `tmc_spread` / `tmc_hold`) — atur dari studio
tab CAL, section "driver TMC2209", tanpa re-flash. `TMC_MA_DEFAULT[]` di sketch
hanya nilai awal. StallGuard opsional via `SG_THRESHOLD[]` untuk sensorless
homing / deteksi tabrakan. Saat boot, firmware log `test_connection()` tiap
driver — cek wiring UART di sini.

Default mode chopper = **spreadCycle**, bukan stealthChop: lengan bergerak
lambat dan berbeban, jadi torsi + akurasi posisi lebih berharga daripada senyap,
dan spreadCycle tidak butuh autotune. Kalau StallGuard dipakai, mode harus
dipindah ke stealthChop dulu (SG4 praktis hanya jalan di mode itu).

`TMC_R_SENSE` **wajib** dicocokkan dengan resistor sense fisik di modul (marking
R110 = 0.11 Ω, R150 = 0.15 Ω, R050 = 0.05 Ω). Salah nilai = arus salah
proporsional tanpa error apa pun. Latar lengkap: `docs/research/driver-stepper-tmc2209-vs-drv8825.md`.

### Servo feedback hack (opsional, `SERVO_FEEDBACK 1`)

MG996R punya potensiometer internal yang tegangan wiper-nya = posisi poros.
Solder kabel ke pin tengah (wiper) pot, keluarkan ke ADC ESP32 → J5/J6 ikut
punya position feedback (semua 6 joint jadi konsisten). Wajib perhatikan:

1. **Pakai pin ADC1 (GPIO 32–39).** ADC2 mati saat WiFi aktif. Firmware pakai
   GPIO34 & GPIO35 (input-only, ideal).
2. **Amankan tegangan.** Ukur rentang wiper dulu; kalau mendekati/melebihi 3.3 V
   (servo di 5–6 V), pasang voltage divider / clamp sebelum ke ADC.
3. **Ground common** antara catu servo dan ESP32.
4. Ini **readback**, bukan kontrol — servo tetap closed-loop internal terhadap PWM.
5. ADC ESP32 nonlinear/noisy → kalibrasi 2 titik (`SERVO_FB_MV_MIN/MAX`) +
   oversampling (sudah ada di firmware).

## Pinout ESP32 (WROOM-32 DevKit)

Detail wiring per komponen (driver TMC2209, stepper, servo, encoder AS5600,
mux TCA9548A, power/grounding) ada di **[`pinout.md`](pinout.md)** — dipecah
per komponen supaya gampang ditelusuri "ini nyambung ke mana", bukan satu
tabel gepeng.

Ringkas: GPIO 13/14/25/26 = STEP J1-J4, 27/33/32/23 = DIR J1-J4, 5 = EN
bersama, 16/17 = UART TMC (Serial2), 21/22 = I2C (AS5600 via TCA9548A),
18/19 = PWM servo J5/J6, 34/35 = feedback pot servo (ADC1). Hindari
GPIO 6–11 (flash), 0/2/12/15 (strapping), 36/39 (input-only sisa). Servo &
AS5600 punya catu daya sendiri; **ground wajib common** dengan ESP32.

## WiFi: multi-preset + AP fallback (`wifi_secrets.h`)

Kredensial **tidak** ditulis di sketch (repo public). Salin
`wifi_secrets.h.example` → `wifi_secrets.h` (di-gitignore) lalu isi daftar
preset. Firmware mencoba **semua** preset via WiFiMulti (pilih sinyal terkuat);
gagal semua dalam 25 dtk → **fallback jadi Access Point** (`AP_SSID`,
`ws://192.168.4.1:81`) sampai reboot, jadi ESP32 tidak pernah unreachable.
STA putus di tengah operasi → auto-reconnect; kalau AP-nya hilang total, tiap
15 dtk dicoba ulang semua preset. `WIFI_FORCE_AP 1` = langsung AP tanpa coba
STA (untuk demo/sidang).

## Koneksi ke web (tanpa Python bridge)

ESP32 **host WebSocket server sendiri**. Web (`studio/src/net/bridge.js`)
tinggal disambungkan ke ESP32:

- Mode STA: `ws://<ip-esp32>:81` atau `ws://armbot.local:81`.
- Mode AP (fallback / `WIFI_FORCE_AP`): sambungkan laptop ke hotspot ESP32,
  lalu `ws://192.168.4.1:81`.

Link dijaga **dua arah** terhadap koneksi zombie: firmware ping/pong heartbeat
tiap 3 dtk (2x gagal → klien diputus), web watchdog menutup socket yang >2 dtk
tanpa pesan (feedback normalnya 50 Hz) supaya auto-reconnect jalan dan perintah
tidak menumpuk lalu tumpah sekaligus.

Python bridge (`src/arm/bridge.py`) tidak dibutuhkan hardware ini, tapi tetap
berguna untuk mode `--simulate` (uji digital twin + tab CAL tanpa hardware —
protokol cal/diag/load ikut disimulasikan).

### Protokol WebSocket (JSON)

| Arah        | Format                                                                                                                              |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Web → ESP32 | `{"cmd":"goto","angles":[a1..a6]}` — target derajat; divalidasi (angka finite) lalu di-clamp ke joint limit                         |
| Web → ESP32 | `{"cmd":"estop"}` / `{"cmd":"resume"}` — resume melepas e-stop eksplisit                                                            |
| Web → ESP32 | `{"cmd":"cal_get"}` — minta seluruh kalibrasi                                                                                       |
| Web → ESP32 | `{"cmd":"cal_set", ...field...}` — ubah kalibrasi (RAM saja, all-or-nothing)                                                        |
| Web → ESP32 | `{"cmd":"cal_zero"}` / `{"cmd":"cal_zero","joint":1..4}` — pose sekarang = 0°                                                       |
| Web → ESP32 | `{"cmd":"cal_save"}` / `{"cmd":"cal_reset"}` — simpan ke NVS / kembali default                                                      |
| Web → ESP32 | `{"cmd":"diag"}` — snapshot diagnostik (dipoll tab CAL ~5 Hz saat SERVICE)                                                          |
| Web → ESP32 | `{"cmd":"load_tare"}` / `{"cmd":"load_scale","grams":m}` — nol-kan / kalibrasi load cell dengan massa known                         |
| ESP32 → Web | `{"type":"feedback","angles":[a1..a6],"estop":b,"fault":[f1..f4]}` (~50 Hz; `fault`=1 bila encoder joint itu mati → open-loop)      |
| ESP32 → Web | `{"type":"cal", ...}` — balasan `cal_get`                                                                                           |
| ESP32 → Web | `{"type":"diag", ...}` — balasan `diag`: per encoder `ok/md/ml/mh/agc/mag/raw/deg/fault`, `sg[4]` StallGuard, `load`, `wifi`, `mux` |
| ESP32 → Web | `{"type":"ack","cmd":"...","ok":b,"msg":"..."}` — balasan tiap command non-goto                                                     |

Field `cal_set` (semua opsional; ditolak seluruhnya bila ada satu yang invalid):
`enc_offset[4]`, `enc_sign[4]` (±1), `ratio[4]` (reduksi per joint, runtime —
ganti reducer bench tanpa re-flash; step counter di-resync dari encoder, tanpa
gerak mendadak), `joint_min[6]`, `joint_max[6]`, `speed`,
`accel`, `kp`, `deadband`, `servo_us_min[2]`, `servo_us_max[2]`,
`servo_ang_min[2]`, `servo_ang_max[2]`, `servo_fb_mv_min[2]`, `servo_fb_mv_max[2]`.
Offset/skala load cell di-set lewat `load_tare`/`load_scale` (bukan `cal_set`)
dan ikut tersimpan saat `cal_save`.

Diagnostik magnet AS5600 (field `diag.enc[]`): `md` = magnet terdeteksi,
`ml` = terlalu lemah (magnet kejauhan), `mh` = terlalu kuat (kedekatan) —
dipakai pilot lamp MAG di tab CAL untuk mengatur jarak magnet fisik saat
bring-up, plus `agc`/`mag` sebagai indikator kualitas.

**Prinsip pembagian peran:** firmware = executor primitif + guardrail real-time
(ramp, closed-loop, e-stop, validasi/clamp). Semua sequencing kalibrasi,
perhitungan (uji rasio, gram→torsi), dan logging CSV ada di studio (tab CAL).

Kompatibilitas: pesan `feedback` cuma nambah field (`estop`, `fault`) —
`studio/src/net/bridge.js` yang lama tetap jalan karena hanya membaca `angles`.
`ESTOP_AUTO_RESUME` kini default **0**: goto TIDAK melepas e-stop, wajib
`{"cmd":"resume"}` eksplisit (tombol RESET di studio sudah mengirimnya).

## Library (Library Manager / PlatformIO)

- **WebSockets** (Links2004 / arduinoWebSockets)
- **ArduinoJson** (v6+)
- **FastAccelStepper** (pembangkit step hardware RMT/MCPWM)
- **ESP32Servo**
- **TMCStepper** (kontrol UART TMC2209)
- WiFi, ESPmDNS, Wire — bawaan core ESP32

> **Timing step:** pulsa STEP dibangkitkan peripheral **hardware** (RMT/MCPWM)
> lewat FastAccelStepper, bukan software di `loop()`. Jadi timing kebal jitter
> WiFi dan sanggup step rate tinggi (J2 ≈ 4000 step/derajat). Inilah alasan
> **1 ESP32 cukup** — tidak perlu MCU kedua khusus WiFi.

## Kalibrasi

**Compile-time (sekali, sesuai wiring):**

1. WiFi: salin `wifi_secrets.h.example` → `wifi_secrets.h`, isi preset
   (jangan commit; `WIFI_FORCE_AP 1` bila mau langsung hotspot).
2. Set `STEP_PIN`/`DIR_PIN`/`EN_PIN` sesuai wiring, dan `TMC_R_SENSE` sesuai
   marking resistor sense di modul driver.
3. `RATIO[]`, `MICROSTEP`, dan `TMC_MA_DEFAULT[]` hanya **default awal** — nilai
   aktif ada di kalibrasi (`ratio`, `tmc_microstep`, `tmc_ma`) dan bisa diganti
   runtime (bench: pulley 15:1 ↔ cycloidal 25:1, atau cari arus optimal, tanpa
   re-flash).

**Runtime via WebSocket (tanpa re-flash), disimpan permanen di NVS — semua
langkah ini ada tombolnya di studio, tab CAL (mode SERVICE):**

4. Bring-up encoder: cek pilot lamp MAG (diag `md/ml/mh/agc`) → atur jarak
   magnet sampai hijau.
5. Set `ratio` sesuai reducer terpasang → JOG pelan → arah terbalik? flip DIR
   (`enc_sign`) → ZERO (`cal_zero`) → verifikasi tombol TEST (goto ±10°,
   bandingkan Δencoder vs Δcommanded).
6. Endpoint servo: `cal_set` `servo_us_min/max` + `servo_ang_min/max`.
7. Bila pakai pot hack: `cal_set` `servo_fb_mv_min/max` dari pengukuran multimeter.
8. Load cell: TARE tanpa beban → CAL MASSA dengan massa known (gram).
9. Tuning `kp` dan `deadband` (juga `speed`/`accel`) via parameter panel untuk
   gerak halus tanpa osilasi.
10. COMMIT (`cal_save`) — tanpa ini perubahan hilang saat reboot. Cek isi
    aktif kapan pun dengan READ (`cal_get`); kembali default dengan DEFAULTS
    (`cal_reset`).

Kalibrasi persisten disimpan sebagai blob di NVS (Preferences, namespace
`armcal`) dengan magic + versi; blob beda versi diabaikan (fallback default).

> ⚠️ Skeleton perlu dikalibrasi & diuji bertahap. Mulai dari wrist cluster
> (J4/J5/J6), lalu siku, lalu bahu (lihat roadmap di README utama).
