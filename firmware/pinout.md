# Pinout: arm_controller_esp32

Referensi wiring per komponen untuk sketch **aktif** (`arm_controller_esp32/`,
board ESP32 DevKit v1 / WROOM-32). Sumber kebenaran = pin yang benar-benar
di-define di `.ino` (bagian `KONFIGURASI`), bukan diagram terpisah, jadi kalau
ubah pin, ubah di kode lalu update file ini.

Untuk protokol WebSocket, kalibrasi, dan library lihat `firmware/README.md`.
Legacy Mega (`arm_controller/`, 6 stepper hibrida + Python bridge) tidak dicakup
di sini.

---

## Peta cepat: 1 baris = 1 pin ESP32

| GPIO | Fungsi                    | Nyambung ke                          |
| ---- | ------------------------- | ------------------------------------ |
| 5    | EN stepper (bersama)      | EN semua driver TMC2209 (active-LOW) |
| 13   | STEP J1                   | STEP driver TMC2209 J1               |
| 14   | STEP J2                   | STEP driver TMC2209 J2               |
| 16   | UART RX2 (TMC)            | bus PDN_UART (lihat §2)              |
| 17   | UART TX2 (TMC)            | bus PDN_UART via resistor 1kΩ        |
| 18   | Servo PWM J5              | pin sinyal MG996R J5                 |
| 19   | Servo PWM J6              | pin sinyal MG996R J6                 |
| 21   | I2C SDA                   | SDA bus bersama: TCA9548A + ADS1115  |
| 22   | I2C SCL                   | SCL bus bersama: TCA9548A + ADS1115  |
| 23   | DIR J4                    | DIR driver TMC2209 J4                |
| 25   | STEP J3                   | STEP driver TMC2209 J3               |
| 26   | STEP J4                   | STEP driver TMC2209 J4               |
| 27   | DIR J1                    | DIR driver TMC2209 J1                |
| 32   | DIR J3                    | DIR driver TMC2209 J3                |
| 33   | DIR J2                    | DIR driver TMC2209 J2                |
| 34   | (bekas servo feedback J5) | tidak dipakai lagi, lihat §3         |
| 35   | (bekas servo feedback J6) | tidak dipakai lagi, lihat §3         |
| 36   | HX711 DT (opsional)       | pin DT/DOUT modul HX711 (load cell)  |
| 4    | HX711 SCK (opsional)      | pin SCK modul HX711                  |

**Hindari:** GPIO 6–11 (flash internal), 0/2/12/15 (strapping, dipakai kalau
perlu tapi hati-hati), 39 (input-only, tidak dipakai sketch ini). GPIO36
(input-only) dipakai HX711 DT, aman karena HX711 men-drive sinyalnya sendiri.
GPIO5 dipakai untuk EN, juga strapping pin, makanya firmware paksa `HIGH`
(driver OFF) di awal `setup()` sebelum apa pun lain jalan.

---

## 1. ESP32 DevKit v1 (WROOM-32): pusat kontrol

Satu-satunya MCU. Host WiFi + WebSocket server, generate step pulse via
hardware RMT/MCPWM (FastAccelStepper), baca semua encoder via I2C, kirim PWM
servo, dan jadi UART master untuk 4 driver TMC2209.

| Konsumen                 | Pin ESP32                                     | Keterangan                             |
| ------------------------ | --------------------------------------------- | -------------------------------------- |
| 4× driver TMC2209        | 13,14,25,26 (STEP), 27,33,32,23 (DIR), 5 (EN) | lihat §2                               |
| Bus UART TMC2209         | 16 (RX2), 17 (TX2)                            | lihat §2                               |
| Mux I2C TCA9548A         | 21 (SDA), 22 (SCL)                            | lihat §4                               |
| ADS1115 (feedback servo) | 21 (SDA), 22 (SCL)                            | bus I2C yang sama, lihat §3            |
| 2× servo MG996R (J5/J6)  | 18, 19                                        | lihat §3                               |
| Laptop/browser (studio)  | - (WiFi)                                      | WebSocket `ws://<ip>:81`, lihat README |

Power: ESP32 dari USB 5V (regulator on-board ke 3.3V). **Tidak** mensuplai
motor stepper maupun servo, itu rail terpisah, lihat §5.

---

## 2. Driver TMC2209 (×4: J1, J2, J3, J4)

Tiap sendi stepper punya 1 driver TMC2209 sendiri, tapi ke-4 nya berbagi
**satu bus UART single-wire** untuk konfigurasi (arus, microstep,
stealthChop, StallGuard). Step/Dir tetap jalur terpisah per driver.

| Sinyal                 | Dari (ESP32)                                  | Ke (driver)                        | Catatan                                            |
| ---------------------- | --------------------------------------------- | ---------------------------------- | -------------------------------------------------- |
| STEP                   | GPIO 13/14/25/26                              | pin STEP J1/J2/J3/J4 masing-masing | pulsa hardware (RMT/MCPWM), bukan software loop    |
| DIR                    | GPIO 27/33/32/23                              | pin DIR J1/J2/J3/J4 masing-masing  |                                                    |
| EN                     | GPIO 5 (satu pin, diparalel ke 4 driver)      | EN semua driver                    | active-LOW: LOW=enable, HIGH=disable               |
| UART TX (ESP32→driver) | GPIO 17 → **resistor 1kΩ** →                  | PDN_UART (bus bersama ke 4 driver) | resistor wajib, supaya TX & RX bisa nebeng 1 kabel |
| UART RX (driver→ESP32) | GPIO 16 ←                                     | PDN_UART (bus bersama)             |                                                    |
| Alamat UART            | jumper **MS1/MS2 di modul** (bukan pin ESP32) | -                                  | lihat tabel alamat di bawah                        |
| Motor output (4 kabel) | -                                             | ke kumparan NEMA17 (§3)            | A+/A-/B+/B-                                        |
| Power                  | VM eksternal + GND                            | VM & GND tiap driver               | lihat §5, **bukan** dari 3.3V/5V ESP32             |

**Alamat UART per driver** (di-set jumper fisik, dibaca firmware saat UART aktif):

| Driver | MS1  | MS2  | Alamat (bin) |
| ------ | ---- | ---- | ------------ |
| J1     | LOW  | LOW  | 0b00         |
| J2     | HIGH | LOW  | 0b01         |
| J3     | LOW  | HIGH | 0b10         |
| J4     | HIGH | HIGH | 0b11         |

**Arus per motor**: sekarang runtime (kalibrasi `tmc_ma[]`, atur dari studio
tab CAL). Angka di bawah = `TMC_MA_DEFAULT[]`, nilai awal saja.

| Driver | Arus RMS default | Motor tujuan      | Rating motor |
| ------ | ---------------- | ----------------- | ------------ |
| J1     | 1000 mA          | 17HS2401          | 1.7 A/fasa   |
| J2     | 1200 mA          | 17HS6401S (besar) | 2.0 A/fasa   |
| J3     | 1000 mA          | 17HS2401          | 1.7 A/fasa   |
| J4     | 1000 mA          | 17HS2401          | 1.7 A/fasa   |

> **Termal:** di atas 1000 mA RMS, TMC2209 wajib heatsink besar + aliran udara.
> Tanpa itu turunkan ke 900 mA dan kompensasi lewat rasio reduksi.

> **R_SENSE:** kode pakai 0.11 Ω. Cocokkan dengan marking resistor sense fisik
> di modul (R110 = 0.11, R150 = 0.15, R050 = 0.05). Salah nilai = arus salah
> proporsional, tanpa error apa pun.

**Alamat MS1/MS2:** tabel di atas berlaku per driver. Jangan jumper keempatnya
ke GND, itu bikin semuanya beralamat `0b00` dan saling menimpa di satu bus.
Pin yang HIGH ditarik ke VIO 3.3 V, bukan dibiarkan mengambang. Resistor 1 kΩ
cukup satu buah untuk seluruh bus, dipasang di jalur TX ESP32.

StallGuard (`SG_THRESHOLD[]`) tersedia untuk sensorless homing/deteksi tabrakan
tapi default nonaktif (0) di semua driver. Boot log `test_connection()` tiap
driver, kalau salah satu gagal, cek wiring UART/alamat MS1-MS2 dulu.

---

## 3. Aktuator sendi

### Stepper NEMA17 (×4: J1–J4)

| Joint         | Motor     | Driver      | Reduksi (`RATIO`) | Microstep |
| ------------- | --------- | ----------- | ----------------- | --------- |
| J1 Base yaw   | 17HS2401  | TMC2209 #J1 | 15                | 16        |
| J2 Shoulder   | 17HS6401S | TMC2209 #J2 | 30                | 16        |
| J3 Elbow      | 17HS2401  | TMC2209 #J3 | 30                | 16        |
| J4 Wrist roll | 17HS2401  | TMC2209 #J4 | 15                | 16        |

Reduksi: J1 belt HTD3M 2 stage (12T→60T lalu 20T→60T), J2 cycloidal 1:30
(roller pin dowel 5 mm), J3 belt HTD3M 20T→60T + cycloidal 1:10, J4 cycloidal
1:15 (**TENTATIVE**, masih bisa berubah).

4 kabel motor tiap NEMA17 → langsung ke output coil A+/A-/B+/B- driver
TMC2209 pasangannya (bukan ke ESP32).

### Servo: 2× MG996R (J5, J6) + 1× MG90S (gripper)

| Servo               | Pin PWM (ESP32)  | Feedback posisi  |
| ------------------- | ---------------- | ---------------- |
| J5 Wrist pitch      | GPIO 18          | ADS1115 kanal A0 |
| J6 End roll         | GPIO 19          | ADS1115 kanal A1 |
| Gripper (bukan DOF) | belum ditetapkan | ADS1115 kanal A2 |

- PWM 50 Hz standar, pulsa 500–2500 µs (default; bisa dikalibrasi via
  `cal_set servo_us_min/max`).
- Servo punya **catu daya sendiri** (5–6 V), sinyal PWM dari ESP32, tapi
  power **bukan** dari ESP32. GND wajib common (lihat §5).
- Feedback posisi: solder kabel ke wiper potensiometer internal tiap servo →
  **ADS1115** (ADC eksternal 16-bit, alamat `0x48`) yang menumpang bus I2C
  yang sama dengan mux TCA9548A. Wiper **tidak** masuk langsung ke ESP32.
  Ini readback saja, bukan jalur kontrol: servo tetap menutup lingkar
  kendalinya sendiri terhadap PWM.
- Kalibrasi 2 titik (`cal_set servo_fb_mv_min/max`) memetakan mV → derajat.
  Default pabrik firmware 1000–2000 mV hanyalah **placeholder**, belum hasil
  ukur.

> **Belum diputuskan / belum dikerjakan.**
> 
> 1. Tegangan kerja ADS1115: kalau di-supply 3.3 V, wiper servo 5–6 V tetap
>    butuh voltage divider. Kalau di-supply 5 V, input aman tanpa divider dan
>    I2C tetap kompatibel dengan logic 3.3 V, tapi pull-up bus harus tetap ke
>    3.3 V. Pilih satu lalu tulis di sini.
> 2. Pin PWM gripper belum dialokasikan.
> 3. **Firmware belum dimigrasi.** `arm_controller_esp32.ino` masih membaca
>    `analogReadMilliVolts()` di GPIO 34/35 (`SERVO_FEEDBACK`). Migrasi ke
>    ADS1115 butuh library ADC eksternal dan belum dikerjakan, jadi resolusi
>    efektif yang baru juga belum dihitung ulang.

---

## 4. Position feedback: AS5600 (×4) + mux TCA9548A

Tiap sendi stepper (J1–J4) punya encoder magnetik absolut AS5600 di
**output sendi** (setelah gearbox, bukan di shaft motor). Semua AS5600
beralamat I2C sama (`0x36`), jadi dipisah lewat mux `TCA9548A` (`0x70`).

| Dari               | Ke           | Pin/Channel           |
| ------------------ | ------------ | --------------------- |
| ESP32 GPIO21       | SDA TCA9548A | I2C SDA               |
| ESP32 GPIO22       | SCL TCA9548A | I2C SCL               |
| TCA9548A channel 0 | AS5600 J1    | @0x36 di belakang mux |
| TCA9548A channel 1 | AS5600 J2    | @0x36 di belakang mux |
| TCA9548A channel 2 | AS5600 J3    | @0x36 di belakang mux |
| TCA9548A channel 3 | AS5600 J4    | @0x36 di belakang mux |

**Per-pin AS5600** (modul breakout biasanya expose 7 pin, cuma 4 yang
kepake di proyek ini):

| Pin | Dipakai?       | Ke mana / catatan                                                                                                                                                                                                              |
| --- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| VCC | Ya             | 3.3V, satu rail dengan ESP32 & TCA9548A                                                                                                                                                                                        |
| GND | Ya             | GND common (§5)                                                                                                                                                                                                                |
| SDA | Ya             | ke channel TCA9548A masing-masing (bukan langsung ke GPIO21 ESP32)                                                                                                                                                             |
| SCL | Ya             | ke channel TCA9548A masing-masing (bukan langsung ke GPIO22 ESP32)                                                                                                                                                             |
| DIR | Tidak ke ESP32 | tie langsung ke GND (atau VCC untuk kebalik arah) di modulnya sendiri, pilih polaritas hardware. Firmware sudah punya `enc_sign[]` (software) untuk balik arah per joint, jadi cukup tie ke GND dan biarkan software yang atur |
| OUT | Tidak          | output analog/PWM sudut (alternatif I2C), firmware baca sudut lewat register I2C (`0x0C`), OUT dibiarkan *not connected*                                                                                                       |
| GPO | Tidak          | pin programming OTP (burn setting permanen ke chip, ireversibel), jangan disolder kecuali sengaja mau burn OTP; biarkan NC                                                                                                     |

- I2C pakai timeout pendek (5 ms), bus macet/AS5600 lepas tidak
  membekukan `loop()`.
- Gagal baca ≥25 kali berturut-turut pada satu joint → joint itu `FAULT`,
  firmware fallback ke open-loop (step counter), dilaporkan di
  `feedback.fault[]` lewat WebSocket.
- J5/J6 (servo) **tidak** pakai AS5600 dan **tidak** memakai channel mux,
  feedback mereka lewat pot internal servo → ADS1115 di §3. Total AS5600 yang
  dipasang = **4 unit**.
- ADS1115 (`0x48`) duduk di bus I2C yang sama dengan TCA9548A (`0x70`), bukan
  di belakang salah satu channel mux. Alamatnya beda jadi tidak bentrok.
- Power AS5600 & TCA9548A: 3.3V/GND, catu terpisah dari motor, GND tetap
  wajib common dengan ESP32 (§5).

---

## 4b. Load cell + HX711 (opsional, `USE_HX711 1`, bench uji torsi)

| Dari              | Ke            | Catatan                                        |
| ----------------- | ------------- | ---------------------------------------------- |
| ESP32 GPIO36      | HX711 DT/DOUT | input-only OK, HX711 men-drive push-pull       |
| ESP32 GPIO4       | HX711 SCK     | bit-bang dari firmware (~10 Hz data ready)     |
| HX711 VCC         | 3.3V ESP32    | supply 3.3V supaya level DT aman tanpa divider |
| HX711 E+/E-/A+/A- | load cell     | 4 kabel load cell (merah/hitam/putih/hijau)    |

Satu HX711 aktif; ganti load cell 1 kg ↔ 10 kg = TARE + CAL MASSA ulang di
tab CAL studio. Firmware hanya melaporkan counts + gram (`diag.load`);
konversi gram → Newton → torsi (× lengan tuas) dihitung di studio.

---

## 5. Distribusi power & grounding

| Rail                    | Menyuplai                       | Sumber                                                                           |
| ----------------------- | ------------------------------- | -------------------------------------------------------------------------------- |
| USB 5V → regulator 3.3V | ESP32, AS5600 ×4, TCA9548A      | USB/adaptor 5V ke ESP32                                                          |
| VM **24 V 5 A**         | 4× driver TMC2209 → coil NEMA17 | catu daya motor terpisah (perhitungan: ~1,5 A / 36 W)                            |
| 5–6 V servo             | 2× MG996R (J5, J6)              | catu daya servo terpisah (arus lonjak saat stall, jangan satu rail dengan logic) |

**Wajib:** GND ketiga rail (ESP32, driver/motor, servo) **common**,
tanpa ground bersama, pembacaan ADC feedback servo dan level sinyal
STEP/DIR/UART tidak valid meski secara visual "kelihatan nyambung".

### Aturan rail VM 24 V (jangan dilanggar, driver mati tanpa peringatan)

Batas absolut `VM` TMC2209 = **29 V**, jadi di rail 24 V margin transien tinggal
5 V. Semua kejadian di bawah ini menghasilkan lonjakan sekitar 2× nominal, yaitu
~48 V, dan tak satu pun memunculkan flag di `DRV_STATUS`:

1. **Nyalakan dan matikan lewat tombol OUTPUT di PSU, jangan lewat colokan.**
   Menyambung kabel ke sumber yang sudah hidup memicu dering LC pada induktansi
   kabel dan kapasitor bulk.
2. **Jangan pernah mencabut atau memasang motor saat power on.** Flyback coil
   yang terputus lewat body diode ke rail VM.
3. Kapasitor bulk **470–1000 µF / 50 V** di rail dekat driver, di samping 100 µF
   low-ESR yang diminta datasheet.
4. Cek rating kapasitor di modul driver, **wajib ≥35 V**. Modul klon kadang
   memasang 25 V, itu di luar spec pada rail 24 V.
5. `VCC_IO` dari **3.3 V ESP32**, jangan dari `5VOUT` driver (mengurangi
   disipasi regulator internal yang tegangan jatuhnya dobel di 24 V).

Latar dan hitungannya: `docs/research/driver-stepper-tmc2209-vs-drv8825.md` §6.

---

## Urutan cek wiring saat bring-up

1. EN (GPIO5) harus HIGH saat power-on (driver off), verifikasi sebelum
   motor dapat power VM.
2. Boot firmware, cek Serial Monitor: `[TMC] J.. conn=0` tiap driver (0 =
   OK). Kalau gagal → cek jumper MS1/MS2 dan resistor 1kΩ di §2.
3. Cek tiap AS5600 kebaca (`[SYNC] J.. = ... deg (encoder)`, bukan
   "encoder tak terbaca") → kalau gagal, cek channel mux §4 dan alamat
   0x36.
4. Baru gerakkan sendi satu-satu mulai dari wrist cluster (J4/J5/J6),
   sesuai urutan kalibrasi di `firmware/README.md`.
