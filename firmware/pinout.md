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

| GPIO | Fungsi               | Nyambung ke                                   |
| ---- | -------------------- | --------------------------------------------- |
| 5    | EN stepper (bersama) | EN keempat driver TMC2209 (active-LOW)        |
| 13   | STEP J1              | STEP driver TMC2209 J1                        |
| 27   | DIR J1               | DIR driver TMC2209 J1                         |
| 14   | STEP J2              | STEP driver TMC2209 J2                        |
| 33   | DIR J2               | DIR driver TMC2209 J2                         |
| 25   | STEP J3              | STEP driver TMC2209 J3                        |
| 32   | DIR J3               | DIR driver TMC2209 J3                         |
| 26   | STEP J4              | STEP driver TMC2209 J4                        |
| 23   | DIR J4               | DIR driver TMC2209 J4                         |
| 16   | UART RX2 (TMC)       | bus PDN_UART (lihat §2)                       |
| 17   | UART TX2 (TMC)       | bus PDN_UART via resistor 1kΩ                 |
| 18   | Servo PWM J5         | pin sinyal MG996R J5                          |
| 19   | Servo PWM J6         | pin sinyal MG996R J6                          |
| 21   | I2C SDA              | SDA bus bersama: TCA9548A + ADS1115           |
| 22   | I2C SCL              | SCL bus bersama: TCA9548A + ADS1115           |
| 4    | Servo PWM gripper    | pin sinyal MG90S gripper (bekas HX711 SCK)    |
| 34   | bebas (input-only)   | bekas rencana feedback J5, kini lewat ADS1115 |
| 35   | bebas (input-only)   | bekas rencana feedback J6, kini lewat ADS1115 |
| 36   | bebas (input-only)   | bekas HX711 DT, modul sudah dilepas           |

**Satu driver per sendi (11 Agu 2026).** Keempat TMC2209 sudah terpasang, jadi
tiap sendi stepper punya jalur STEP/DIR dan alamat UART sendiri, dan keempatnya
bisa diperintah berbarengan. Sebelum ini papan cuma punya dua driver yang
dipakai bergantian oleh dua sendi (kabel motor dicolok ulang, kepemilikan kanal
diurus `klaimKanal()` di firmware). Mekanisme itu sudah dibuang seluruhnya dari
sketch, bukan sekadar dimatikan; riwayatnya ada di git.

> **Konsekuensi daya:** keempat sendi kini bisa bergerak serentak, jadi arus
> puncak rail motor adalah jumlah keempat driver, bukan dua. Cek §5 sebelum
> menjalankan gerakan multi-sendi berbeban penuh.

**Encoder baru dua.** Aktuatornya sudah lengkap, tetapi sensornya belum:
AS5600 terpasang di J1 dan J2 (`ENC_ADA[]` di `.ino`, sejak 12 Agu 2026).
J3 dan J4 berjalan open-loop dan sudut yang dilaporkan diambil dari step
counter, yaitu sudut perintah yang sedang dijalankan. Tampilan web tidak menandainya khusus, tetapi
kodenya jujur: tidak ada angka yang dikarang seolah-olah hasil ukur.

**Servo sudah ber-feedback.** Wiper potensiometer ketiga servo (J5, J6, gripper)
sudah disolder ke ADS1115 kanal A0/A1/A2, jadi sudut servo yang dilaporkan hasil
ukur, bukan sudut perintah. Lihat §3.

**Hindari:** GPIO 6–11 (flash internal), 0/2/12/15 (strapping, dipakai kalau
perlu tapi hati-hati), 39 (input-only, tidak dipakai sketch ini). GPIO5 dipakai
untuk EN, juga strapping pin, makanya firmware paksa `HIGH` (driver OFF) di awal
`setup()` sebelum apa pun lain jalan.

---

## 1. ESP32 DevKit v1 (WROOM-32): pusat kontrol

Satu-satunya MCU. Host WiFi + WebSocket server, generate step pulse via
hardware RMT/MCPWM (FastAccelStepper), baca encoder via I2C, kirim PWM servo,
dan jadi UART master untuk driver TMC2209 yang terpasang.

| Konsumen                 | Pin ESP32                         | Keterangan                             |
| ------------------------ | --------------------------------- | -------------------------------------- |
| 4× driver TMC2209        | 13,14,25,26 (STEP), 27,33,32,23 (DIR), 5 (EN) | satu driver per sendi, lihat §2 |
| Bus UART TMC2209         | 16 (RX2), 17 (TX2)                | lihat §2                               |
| Mux I2C TCA9548A         | 21 (SDA), 22 (SCL)                | lihat §4                               |
| ADS1115 (feedback servo) | 21 (SDA), 22 (SCL)                | bus I2C yang sama, lihat §3            |
| 2× servo MG996R (J5/J6)  | 18, 19                            | lihat §3                               |
| 1× servo MG90S (gripper) | 4                                 | bukan DOF, lihat §3                    |
| Laptop/browser (studio)  | - (WiFi)                          | WebSocket `ws://<ip>:81`, lihat README |

Power: ESP32 dari USB 5V (regulator on-board ke 3.3V). **Tidak** mensuplai
motor stepper maupun servo, itu rail terpisah, lihat §5.

---

## 2. Driver TMC2209 (×4, satu per sendi)

Keempat driver sudah terpasang, satu per sendi stepper. Semuanya berbagi
**satu bus UART single-wire** untuk konfigurasi (arus, microstep, stealthChop,
StallGuard). Step/Dir tetap jalur terpisah per driver, jadi keempat sendi bisa
bergerak berbarengan tanpa saling menunggu.

| Sinyal                 | Dari (ESP32)                                  | Ke (driver)             | Catatan                                            |
| ---------------------- | --------------------------------------------- | ----------------------- | -------------------------------------------------- |
| STEP                   | GPIO 13 / 14 / 25 / 26                        | pin STEP driver J1..J4  | pulsa hardware (RMT/MCPWM), bukan software loop    |
| DIR                    | GPIO 27 / 33 / 32 / 23                        | pin DIR driver J1..J4   |                                                    |
| EN                     | GPIO 5 (satu pin, diparalel ke semua driver)  | EN semua driver         | active-LOW: LOW=enable, HIGH=disable               |
| UART TX (ESP32→driver) | GPIO 17 → **resistor 1kΩ** →                  | PDN_UART (bus bersama)  | resistor wajib, supaya TX & RX bisa nebeng 1 kabel |
| UART RX (driver→ESP32) | GPIO 16 ←                                     | PDN_UART (bus bersama)  |                                                    |
| Alamat UART            | jumper **MS1/MS2 di modul** (bukan pin ESP32) | -                       | lihat tabel alamat di bawah                        |
| Motor output (4 kabel) | -                                             | ke kumparan NEMA17 (§3) | A+/A-/B+/B-                                        |
| Power                  | VM eksternal + GND                            | VM & GND tiap driver    | lihat §5, **bukan** dari 3.3V/5V ESP32             |

**Alamat UART per driver** (di-set jumper fisik, dibaca firmware saat UART aktif):

| Driver | MS1  | MS2  | Alamat (bin) | Melayani |
| ------ | ---- | ---- | ------------ | -------- |
| J1     | LOW  | LOW  | 0b00         | J1       |
| J2     | HIGH | LOW  | 0b01         | J2       |
| J3     | LOW  | HIGH | 0b10         | J3       |
| J4     | HIGH | HIGH | 0b11         | J4       |

**Arus per motor**: sekarang runtime (kalibrasi `tmc_ma[]`, atur dari studio
tab CAL). Angka di bawah = `TMC_MA_DEFAULT[]`, nilai awal saja.

Tiap sendi punya driver sendiri, jadi arus tiap chip ditulis sesuai motornya
masing-masing. Itu penting: motor kecil yang diberi arus motor besar jadi panas,
motor besar yang diberi arus kecil kehilangan langkah.

| Sendi | Arus RMS default | Motor             | Rating motor | Alamat driver |
| ----- | ---------------- | ----------------- | ------------ | ------------- |
| J1    | 1000 mA          | 17HS2401          | 1.7 A/fasa   | 0b00          |
| J2    | 1200 mA          | 17HS6401S (besar) | 2.0 A/fasa   | 0b01          |
| J3    | 1000 mA          | 17HS2401          | 1.7 A/fasa   | 0b10          |
| J4    | 1000 mA          | 17HS2401          | 1.7 A/fasa   | 0b11          |

> **Termal:** di atas 1000 mA RMS, TMC2209 wajib heatsink besar + aliran udara.
> Tanpa itu turunkan ke 900 mA dan kompensasi lewat rasio reduksi.

> **R_SENSE:** kode pakai 0.11 Ω. Cocokkan dengan marking resistor sense fisik
> di modul (R110 = 0.11, R150 = 0.15, R050 = 0.05). Salah nilai = arus salah
> proporsional, tanpa error apa pun.

**Alamat MS1/MS2:** tabel di atas berlaku per driver. Jangan jumper keempatnya
ke GND, itu bikin semuanya beralamat `0b00` dan saling menimpa di satu bus.
Pin yang HIGH ditarik ke VIO 3.3 V, bukan dibiarkan mengambang. Resistor 1 kΩ
cukup satu buah untuk seluruh bus, dipasang di jalur TX ESP32.

> ⚠️ **Yang wajib benar adalah resistansi seri EFEKTIF jalur itu (sekitar 1 kΩ),
> bukan sekadar nilai resistor yang dipasang.** Kejadian 2026-08-06: resistornya
> sendiri terukur 1,1 kΩ saat dilepas, tapi in-circuit GPIO16 ke GPIO17 terbaca
> 4,4 kΩ, artinya ada sekitar 3 kΩ **kontak resistif yang terangkai seri**
> (sambungan solder dingin atau crimp yang tidak menggigit kawat). Akibatnya 1
> sampai 2 driver jalan normal, lalu driver **ketiga** mematikan seluruh bus
> termasuk driver yang sehat. Tiap TMC2209 menggantung sekitar 15 kΩ ke GND
> lewat PDN_UART, jadi makin banyak modul makin turun level idle jalur: 2,60 V
> di 1 modul, 2,15 V di 2 modul, lalu 1,83 V di 3 modul yang sudah di bawah
> ambang HIGH ESP32. Setelah diganti 1,2 kΩ dengan sambungan dibuat ulang,
> keempat driver menjawab 16/16 di tiga baud tanpa satu pun kegagalan.
> 
> Dua cara mengenalinya tanpa membongkar apa apa. Pertama, kalau ESP32 tidak
> bisa mendengar **echo-nya sendiri** (byte masuk semua `0x00`, RX idle LOW),
> yang salah jalur fisik bus, bukan driver dan bukan alamat. Kedua, ukur GPIO16
> ke GPIO17 saat mati total lalu bandingkan dengan nilai komponennya: hasil
> in-circuit **hanya bisa lebih kecil** dari nilai komponen, jadi kalau lebih
> besar, yang bermasalah sambungannya. Menurunkan baud tidak akan menolong,
> karena yang gagal level DC.
> 
> Perkakasnya sudah ada: `firmware/tmc_scan/`, lihat `firmware/README.md`.

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

| Servo               | Pin PWM (ESP32) | Feedback posisi  |
| ------------------- | --------------- | ---------------- |
| J5 Wrist pitch      | GPIO 18         | ADS1115 kanal A0 |
| J6 End roll         | GPIO 19         | ADS1115 kanal A1 |
| Gripper (bukan DOF) | GPIO 4          | ADS1115 kanal A2 |

GPIO 4 dipilih untuk gripper karena bekas HX711 SCK yang sudah dilepas: bukan
strapping pin, bukan input-only, dan tidak bertetangga dengan bus flash. Sketch
menariknya LOW di awal `setup()` sebelum LEDC mengambil alih, supaya jalur yang
mengambang sejak reset tidak sempat menghasilkan pulsa liar.

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
  **Sudah diisi hasil ukur 10 Agustus 2026**, bukan placeholder lagi.

### Keputusan tegangan ADS1115: 3.3 V, TANPA voltage divider

Ketiganya sudah diputuskan dan dikerjakan 10 Agustus 2026.

**ADS1115 di-supply 3.3 V dari ESP32** (terukur 3,294 V). Batas absolut input
karena itu VDD + 0,3 = **3,6 V**. Pilihan ini aman setelah diukur: wiper ketiga
servo berayun **0,20–3,06 V** pada rentang perintah penuh 500–2500 µs, jadi
tidak pernah melewati VDD sekalipun. Divider **tidak dipasang** dan memang tidak
perlu. Konsekuensinya pull-up I2C tetap ke 3.3 V dan tidak ada level shifter di
jalur mana pun.

| Servo | Wiper @500 µs | Wiper @1500 µs | Wiper @2500 µs | Skala       |
| ----- | ------------- | -------------- | -------------- | ----------- |
| J5    | 285,5 mV      | 1657,9 mV      | 3044,5 mV      | 1,380 mV/µs |
| J6    | 299,9 mV      | 1667,2 mV      | 3056,8 mV      | 1,378 mV/µs |
| GRIP  | 201,6 mV      | 1598,8 mV      | 3022,7 mV      | 1,411 mV/µs |

PGA dipasang ±4,096 V → 1 LSB = **0,125 mV**. Pada skala di atas itu setara
**0,09 µs**, jauh lebih halus daripada resolusi mekanis servo itu sendiri, jadi
ADC bukan lagi faktor pembatas ketelitian (bandingkan ADC1 internal ESP32 12-bit
yang hanya memberi ~0,8 mV/LSB dan tidak linier di ujung rentang).

> ⚠️ **Yang membatasi ketelitian sekarang ground bounce, bukan ADC.** Selama
> motor servo masih menarik arus, arus itu lewat kabel GND bersama dan
> menggeser referensi ADS1115: simpangan baku satu pembacaan melompat dari
> ~0,1 mV ke 100–440 mV dan nilainya selalu meleset ke arah RENDAH. Setiap
> pengukuran wajib menunggu servo tenang (`sd ≤ 5 mV`) dulu. Kalau nanti mau
> diperbaiki secara hardware, yang perlu dibenahi adalah kabel GND terpisah
> dari titik catu servo ke GND ADS1115 (star ground), bukan menambah kapasitor
> di input ADC.

> ⚠️ **Batas 3,15 V yang dilaporkan firmware (`sat`) itu bendera LENGKET dan
> sengaja dipasang di bawah batas asli.** Bendera itu naik saat sapuan menuju
> 2500 µs karena lonjakan sesaat, bukan karena tegangan tenang wiper melewati
> batas. Jangan simpulkan butuh divider dari bendera itu saja: yang menentukan
> pembacaan yang sudah tenang.

---

## 4. Position feedback: AS5600 (×4) + mux TCA9548A

Tiap sendi stepper (J1–J4) punya encoder magnetik absolut AS5600 di
**output sendi** (setelah gearbox, bukan di shaft motor). Semua AS5600
beralamat I2C sama (`0x36`), jadi dipisah lewat mux `TCA9548A` (`0x70`).

| Dari               | Ke           | Pin/Channel           |
| ------------------ | ------------ | --------------------- |
| ESP32 GPIO21       | SDA TCA9548A | I2C SDA               |
| ESP32 GPIO22       | SCL TCA9548A | I2C SCL               |
| TCA9548A channel 0 | AS5600 J1    | @0x36 di belakang mux, TERPASANG       |
| TCA9548A channel 1 | AS5600 J4    | belum terpasang, kanalnya TERSANGKA    |
| TCA9548A channel 2 | AS5600 J3    | belum terpasang                        |
| TCA9548A channel 3 | AS5600 J2    | @0x36 di belakang mux, TERPASANG       |

**J2 dan J4 bertukar kanal (12 Agu 2026).** J2 semula dirancang di kanal 1 dan
tidak pernah meng-ACK di sana: `i2c_scan` menunjukkan bus utama bersih dan
kanal 1 kosong, baik dengan modul yang pertama, sesudah kabel SDA/SCL dibalik,
maupun sesudah GND yang copot dibetulkan. Modul lalu diganti dan dipindah ke
kanal 3, dan langsung terbaca. Yang BELUM terpisah: apakah yang rusak modul
lamanya atau pin SD1/SC1 mux itu sendiri. Karena itu, sebelum angka encoder J4
dipercaya nanti, jalankan `{"cmd":"i2c_scan"}` dan pastikan `0x36` benar-benar
muncul di kanal 1.

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
  feedback mereka lewat pot internal servo → ADS1115 di §3. Rancangan penuh
  butuh **4 unit** AS5600; yang **benar-benar terpasang sampai 11 Agu 2026 baru
  1 unit di J1** (lihat catatan "Encoder baru satu" di peta cepat).
- ADS1115 (`0x48`) duduk di bus I2C yang sama dengan TCA9548A (`0x70`), bukan
  di belakang salah satu channel mux. Alamatnya beda jadi tidak bentrok.
- Power AS5600 & TCA9548A: 3.3V/GND, catu terpisah dari motor, GND tetap
  wajib common dengan ESP32 (§5).

---

## 4b. Load cell + HX711 (opsional, `USE_HX711 1`, bench uji torsi)

| Dari              | Ke            | Catatan                                        |
| ----------------- | ------------- | ---------------------------------------------- |
| ESP32 GPIO36      | HX711 DT/DOUT | input-only OK, HX711 men-drive push-pull       |
| ~~ESP32 GPIO4~~   | HX711 SCK     | **SUDAH DIPAKAI servo gripper**, lihat catatan |
| HX711 VCC         | 3.3V ESP32    | supply 3.3V supaya level DT aman tanpa divider |
| HX711 E+/E-/A+/A- | load cell     | 4 kabel load cell (merah/hitam/putih/hijau)    |

Satu HX711 aktif; ganti load cell 1 kg ↔ 10 kg = TARE + CAL MASSA ulang di
tab CAL studio. Firmware hanya melaporkan counts + gram (`diag.load`);
konversi gram → Newton → torsi (× lengan tuas) dihitung di studio.

> **Uji torsi sudah selesai dan modulnya dilepas** (`USE_HX711 0`). GPIO 4 yang
> dulu jadi SCK sekarang jalur pulsa servo gripper. Menyalakan `USE_HX711 1`
> lagi tanpa memindahkan salah satu pin membuat dua peripheral menulis GPIO 4
> bersamaan, dan gejalanya menyesatkan: gripper kedutan tiap pembacaan load
> cell, berat ngawur tiap gripper bergerak. Sketch sudah memasang `#error`
> untuk menolak kombinasi itu saat compile, jadi kesalahan ini tidak bisa lolos
> diam-diam. Kalau load cell memang perlu dipasang lagi, pindahkan SCK ke
> GPIO 23/25/26/32 yang masih bebas.

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

### Rail 3.3V: AMS1117 bawaan board bench pernah cacat, sudah diganti

Riwayat bring-up 2026-07-31, disimpan karena gejalanya menyesatkan dan mahal
waktunya. Board bench (ESP32-D0WD-V3, MAC 30:76:f5:93:b0:e0) **boot loop
brownout** tiap kali `WiFi.mode()` dipanggil. Penyebabnya AMS1117 bawaan yang
di luar spesifikasi: keluarannya cuma 3.1–3.2 V (seharusnya 3.23–3.37 V) dan
tidak sanggup melayani lonjakan ~300–400 mA saat PHY radio menyala.

**Solusi akhir: AMS1117-nya diganti** (solder uap). Setelah itu 3V3 terukur
3.289 V dan board jalan stabil dengan WiFi hanya bermodal USB. Suntikan 3.3 V
eksternal ke pin `3V3` sempat dipakai sebagai penambal sementara dan berhasil,
tapi tidak lagi diperlukan.

Cara mengenali gejala ini kalau terulang di board lain:

- Brownout **hanya** saat WiFi. Sketch tanpa radio (mis. `tmc_bench`) berjalan
  stabil bermenit-menit sambil menggerakkan motor pada ~1 A.
- Ambruknya **di dalam `WiFi.mode()`**, bukan saat memancar. Sisipkan `Serial`
  print sebelum & sesudah baris itu untuk memastikan.
- Ukur `3V3` dengan multimeter. Di bawah 3.23 V = regulator tersangka utama.
  Ukur juga `V5`: kalau sehat (4.99–5.05 V), masalahnya di hilir, bukan di USB.

Yang **tidak** menolong, sudah diuji semua, jangan diulang: ganti kabel USB,
ganti port USB, kapasitor 2200 µF di 3V3 (yang kurang arus berkelanjutan, bukan
simpanan sesaat), `WiFi.setTxPower()` (brownout terjadi di dalam `WiFi.mode()`,
sebelum baris itu tercapai), erase + reflash total, dan menyuntik 5V ke `V5`.

Kalau perlu menambal sementara tanpa menyolder, 3.3 V eksternal ke pin `3V3`
memang bekerja: LDO tidak bisa menyerap arus, jadi AMS1117 menganggur sendiri
begitu node itu ditahan lebih tinggi dari yang sanggup dia hasilkan. Syaratnya
setel & ukur buck **dalam keadaan terlepas** dulu (sasaran 3.30–3.35 V;
absolute max ESP32 3.6 V dan pin itu masuk langsung ke chip tanpa proteksi),
lalu colok USB dulu baru 3.3 V, cabut 3.3 V dulu baru USB (kalau 3.3 V hidup
sementara masukan AMS1117 sudah 0 V, regulator itu terbias terbalik).

> ⚠️ Jangan pasang apa pun ke pin `SD0/SD1/SD2/SD3/CMD/CLK` (GPIO6–11): itu bus
> flash internal. Kapasitor yang salah mendarat di `CMD` (bersebelahan dengan
> pin `V5` di ujung bawah board) membuat flash berhenti menjawab: gejalanya
> `invalid header: 0xffffffff` + `flash read err`, dan `esptool flash_id`
> melaporkan Manufacturer `ff`.

---

## Urutan cek wiring saat bring-up

1. EN (GPIO5) harus HIGH saat power-on (driver off), verifikasi sebelum
   motor dapat power VM.
2. Boot firmware, cek Serial Monitor: `[TMC] J.. conn=0` tiap driver (0 =
   OK). Kalau gagal, jangan langsung menyalahkan driver: flash
   `firmware/tmc_scan/` dan baca laporannya, karena dia membedakan jalur bus
   rusak, alamat kosong, dan tabrakan alamat. Urutan menyalahkan yang terbukti
   hemat waktu: **jalur bus dulu** (echo sendiri kembali atau tidak), baru
   alamat MS1/MS2, baru modulnya. Lihat kotak peringatan resistor di §2.
3. Cek tiap AS5600 kebaca (`[SYNC] J.. = ... deg (encoder)`, bukan
   "encoder tak terbaca") → kalau gagal, cek channel mux §4 dan alamat
   0x36.
4. Baru gerakkan sendi satu-satu mulai dari wrist cluster (J4/J5/J6),
   sesuai urutan kalibrasi di `firmware/README.md`.
