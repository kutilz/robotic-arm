# Firmware: kontrol lengan 6-DOF

Empat sketch:

| Sketch                      | Board             | Status                                                               |
| --------------------------- | ----------------- | -------------------------------------------------------------------- |
| **`arm_controller_esp32/`** | ESP32 DevKit v1   | **AKTIF**: arsitektur fix 4 stepper + 2 servo, WiFi langsung ke web |
| `tmc_scan/`                 | ESP32 DevKit v1   | Diagnosis bus UART TMC2209 + uji gerak per driver, lihat di bawah   |
| `tmc_bench/`                | ESP32 DevKit v1   | Bench 1 driver: cari setting arus & chopper lewat Serial Monitor    |
| `arm_controller/`           | Arduino Mega 2560 | Legacy: desain lama 6 stepper hibrida (serial + Python bridge)      |

## Arsitektur fix (ESP32)

Selaras dengan `studio/src/config/arm.js` (arsitektur terkunci, Pre-CAD).

| Sendi          | Aktuator          | Reduksi | Driver     | Position feedback      |
| -------------- | ----------------- | ------- | ---------- | ---------------------- |
| J1 Base yaw    | stepper 17HS2401  | 1:15    | TMC2209    | AS5600 @ output (ch 0) |
| J2 Shoulder    | stepper 17HS6401S | 1:30    | TMC2209    | AS5600 @ output (ch 1) |
| J3 Elbow       | stepper 17HS2401  | 1:30    | TMC2209    | AS5600 @ output (ch 2) |
| J4 Wrist roll  | stepper 17HS2401  | 1:15    | TMC2209    | AS5600 @ output (ch 3) |
| J5 Wrist pitch | servo MG996R      | direct  | (internal) | pot internal → ADS1115  |
| J6 End roll    | servo MG996R      | direct  | (internal) | pot internal → ADS1115  |

- **4 stepper** semua pakai driver **TMC2209** dengan **kontrol penuh via UART**
  (arus per-motor, microstep, stealthChop, StallGuard, diagnostik). Step tetap
  lewat pin STEP/DIR; UART untuk konfigurasi & diagnostik. **4 encoder AS5600**
  (absolut 12-bit = 0.088°) di output sendi J1–J4, via mux I2C **TCA9548A**
  (semua AS5600 ber-alamat 0x36, channel 0–3).
- **2 servo MG996R** (J5/J6) via PWM 50 Hz, direct drive tanpa reduksi, plus
  **1 servo MG90S** untuk gripper (bukan DOF). Feedback posisi ketiganya dari
  potensiometer internal servo, dibaca **ADS1115** (ADC eksternal 16-bit,
  `0x48`) di bus I2C yang sama dengan mux: bukan AS5600, bukan ADC internal
  ESP32, dan tidak lewat channel mux. **Sudah dimigrasi** (`SERVO_FEEDBACK 1`);
  GPIO 34/35 yang dulu dipakai ADC1 internal kini bebas.

> **Yang benar-benar terpasang per 11 Agu 2026.** Aktuator lengkap: keempat
> driver TMC2209 (satu per sendi, alamat UART 0b00–0b11) plus ketiga servo.
> Sensornya belum: AS5600 baru **1 unit di J1**, jadi J2–J4 berjalan open-loop
> dan sudutnya dilaporkan dari step counter (sudut perintah, bukan hasil ukur).
> Tabel di atas adalah rancangan penuh, bukan isi papan hari ini.
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

> **Yang menentukan bukan nilai resistornya, tapi resistansi seri EFEKTIF jalur
> itu, dan salah nilai gagalnya menyamar jadi "driver rusak" atau "alamat
> bentrok".** Terbukti di bench 2026-08-06: 1 sampai 2 driver jalan normal,
> lalu driver **ketiga** mematikan SELURUH bus termasuk J1 dan J2 yang sehat.
> Tidak ada modul yang rusak, tidak ada alamat yang salah, keempat slot benar.
>
> Resistornya sendiri terukur 1,1 kΩ saat dilepas. Tapi diukur in-circuit dari
> GPIO16 ke GPIO17 hasilnya **4,4 kΩ**, dan itu mustahil: pengukuran in-circuit
> hanya bisa lebih KECIL dari nilai komponen karena jalur paralel, tidak pernah
> lebih besar. Selisihnya berarti ada sekitar 3 kΩ kontak resistif yang terangkai
> seri, yaitu sambungan busuk (solder dingin, crimp Dupont yang tidak menggigit,
> kaki teroksidasi). Diganti resistor 1,2 kΩ dengan sambungan yang dibuat ulang,
> dan hasilnya keempat driver 16/16 di tiga baud, 14 ronde, nol kegagalan.
>
> Sebabnya pembagi tegangan DC murni. Tiap TMC2209 menggantung sekitar 15 kΩ ke
> GND lewat PDN_UART (angka turunan dari pengukuran node, bukan dari datasheet),
> dan resistansi seri di TX itu satu satunya yang menarik jalur ke atas:
>
> | Modul di bus | Node PDN idle, Rs efektif 4,4 kΩ | Node PDN idle, Rs 1,2 kΩ |
> | ------------ | -------------------------------- | ------------------------ |
> | 1            | 2,60 V (jalan, terukur)          | 3,06 V                   |
> | 2            | 2,15 V (jalan)                   | 2,87 V                   |
> | 3            | 1,83 V (**bus mati**)            | 2,73 V                   |
> | 4            | 1,59 V (**bus mati**)            | 2,61 V                   |
>
> Ambang HIGH ESP32 jatuh di antara 2,15 V dan 1,83 V, jadi sekitar 1 kΩ masih
> menyisakan margin untuk keempat driver sedangkan 4,4 kΩ kehabisan margin tepat
> di driver ketiga. Menurunkan baud **tidak menolong sama sekali**, yang gagal
> level DC bukan kecepatan. Jangan turun di bawah 470 Ω juga: driver harus
> menyedot arus itu tiap kali menjawab (3,3 mA di 1 kΩ, 7 mA di 470 Ω).
>
> Ciri khas di log kalau ini terulang: `RX idle=LOW` dan byte yang masuk semuanya
> `0x00`, artinya ESP32 tidak bisa lagi mendengar echo-nya sendiri. Kalau echo
> sendiri sudah hilang, jangan buang waktu menyalahkan driver atau alamat. Ukur
> GPIO16 ke GPIO17 saat mati total, lalu bandingkan dengan nilai komponennya:
> kalau in-circuit lebih besar, yang salah sambungan, bukan resistor.

Alamat tiap driver di-set lewat **jumper MS1/MS2 di modul** (bukan pin ESP32);
saat UART aktif kedua pin itu jadi pin alamat, microstep di-set via register UART:

| Driver | MS1  | MS2  | Alamat |
| ------ | ---- | ---- | ------ |
| J1     | LOW  | LOW  | 0b00   |
| J2     | HIGH | LOW  | 0b01   |
| J3     | LOW  | HIGH | 0b10   |
| J4     | HIGH | HIGH | 0b11   |

Arus, microstep, mode chopper, dan arus tahan sekarang **runtime** (kalibrasi
`tmc_ma[4]` / `tmc_microstep` / `tmc_spread` / `tmc_hold`), atur dari studio
tab CAL, section "driver TMC2209", tanpa re-flash. `TMC_MA_DEFAULT[]` di sketch
hanya nilai awal. StallGuard opsional via `SG_THRESHOLD[]` untuk sensorless
homing / deteksi tabrakan. Saat boot, firmware log `test_connection()` tiap
driver, cek wiring UART di sini.

Default mode chopper = **spreadCycle**, bukan stealthChop: lengan bergerak
lambat dan berbeban, jadi torsi + akurasi posisi lebih berharga daripada senyap,
dan spreadCycle tidak butuh autotune. Kalau StallGuard dipakai, mode harus
dipindah ke stealthChop dulu (SG4 praktis hanya jalan di mode itu).

### Penjaga kesehatan driver saat jalan (13 Agu 2026)

TMC2209 mengambil supply logika internalnya (5VOUT) dari VM. ESP32 hidup sendiri
dari USB, jadi rail 12 V bisa mati berjam-jam sementara firmware terus jalan.
Begitu VM kembali, chip melakukan power-on reset dan **seluruh register balik ke
default pabrik**: `I_scale_analog` menyala lagi (pot VREF ikut mengali arus),
`IHOLD_IRUN` kembali default, dan `mstep_reg_select` mati sehingga microstep
diambil dari pin MS1/MS2, bukan lagi dari `tmc_microstep`.

Sampai 13 Agu 2026 `tmcApply()` hanya dipanggil saat boot dan saat `cal_set`
menyentuh field `tmc_*`, jadi firmware tidak punya cara tahu. Gejalanya:

> Ditinggal sejam dengan ESP32 nyala dan PSU mati. PSU dinyalakan lagi saat
> robot sedang homing: rail menarik **2 A**, padahal biasanya 400-an mA. Tidak
> ada satu pun pesan di layar. Penyebabnya firmware mengirim pulsa untuk
> microstep yang diyakininya sementara chip memakai skala lain, encoder
> melaporkan galat yang tidak pernah menutup, dan cabang koreksi menembak nudge
> terus menerus ke keempat motor.

Sekarang kesehatan driver **ditanyakan berkala**, bukan diingat dari boot:

| Parameter        | Nilai   | Arti                                                    |
| ---------------- | ------- | ------------------------------------------------------- |
| `TMC_CHECK_MS`   | 250 ms  | satu driver per tik, round-robin (siklus penuh ~1 dtk)   |
| `TMC_BAD_LIMIT`  | 3       | strike berturut-turut sebelum driver **bisu** ditindak   |
| `TMC_RETRY_MS`   | 5000 ms | jeda antar percobaan pemulihan selama masih gagal        |

Tiap tik membaca dua hal: `test_connection()` (driver menjawab sama sekali atau
tidak) dan bit `GSTAT.reset` (chip mati-nyala sesudah `tmcApply()` terakhir
membersihkannya). GSTAT saja tidak cukup, karena kalau VM masih mati
pembacaannya gagal dan bitnya terbaca nol, sehingga driver yang tidak ada justru
tampak sehat.

Dua bukti itu **tidak diperlakukan sama**, dan itu disengaja:

- **Driver bisu** bisa berarti bus half-duplex sedang tidak sinkron karena sisa
  echo, dan itu pulih sendiri. Butuh `TMC_BAD_LIMIT` kali berturut-turut, jadi
  ~3 dtk. Tidak apa apa lambat: kalau VM memang mati, tahap output yang masih
  enable pun tidak mengalirkan arus.
- **Bit `GSTAT.reset` menyala** datang dari balasan yang CRC-nya lolos, yaitu
  chip itu sendiri yang menyatakan pernah mati-nyala. Tidak ada tafsir lain,
  jadi langsung ditindak pada tik pertama (≤1 dtk). Jalur inilah yang menangkap
  kedipan VM yang pulih terlalu cepat untuk mengumpulkan tiga strike.

Begitu ditindak: `EN_PIN` HIGH → `forceStop()` → `tmcApply()` (sudah termasuk
baca-balik microstep) → verifikasi ulang keempat driver → `syncSteppersFromEncoders()`
→ EN kembali LOW hanya kalau **keempatnya** terverifikasi. Target **tidak**
dilanjutkan: sebagian jaraknya sudah ditempuh dengan skala microstep yang salah
dan sendi non self-locking bisa melorot selama tahap output mati.

`EN_PIN` sekarang punya satu penulis, `enUpdate()`, dengan aturan
`estop || tmcDown → disable`. Melepas e-stop saat driver masih hilang tidak lagi
bisa menyalakan tahap output. Aturan ini berlaku juga di boot: kalau `setupTMC()`
tidak berhasil memverifikasi keempat driver, tahap output tidak dinyalakan sama
sekali dan pemulihan dicoba tiap 5 dtk. **Menyalakan PSU sesudah ESP32 hidup
karena itu membuat lengan siap sendiri dalam beberapa detik, tanpa reboot.**

Kondisinya dilaporkan ke studio lewat `drvok` dan `drvrst` di `feedback`
(lihat tabel protokol). `drvrst` dihitung naik, bukan boolean sesaat, supaya
kejadian yang sudah pulih otomatis tetap meninggalkan jejak di layar.

### Diagnosis bus UART: `tmc_scan/`

`test_connection()` di firmware utama cuma bisa bilang "OK" atau "tidak
menjawab", dan itu tidak cukup buat menemukan penyebab. `tmc_scan/` merakit
datagram TMC sendiri byte per byte (tanpa TMCStepper) supaya bisa melaporkan
**gagal di mana**, bukan sekadar gagal:

| Yang terlihat di log                        | Artinya                                            |
| ------------------------------------------- | -------------------------------------------------- |
| `sunyi` / `echo-rusak`, byte masuk `00`     | jalur fisik bus, ESP32 tak dengar echo sendiri     |
| `tak-jawab` (echo utuh, balasan kosong)     | tidak ada driver di alamat itu, atau VM mati       |
| `crc-salah` atau byte lebih dari 12         | lebih dari satu driver menjawab di alamat yang sama |
| `RX idle=LOW`                               | ada yang menahan jalur PDN ke GND                  |

Tiap ronde otomatis diulang di 115200, 38400, dan 19200 baud. TMC2209 mendeteksi
baud sendiri dari byte sync, jadi menurunkan baud tidak perlu ubah apa pun di
driver. Kalau gagal di 115200 tapi lolos di baud rendah, penyebabnya sinyal
tumpul (kapasitansi bus). Kalau gagal sama saja di ketiga baud, penyebabnya
level DC, lihat kotak peringatan resistor 1 kΩ di atas.

Sketch ini juga bisa menguji satu driver sampai tuntas tanpa firmware utama:

```
python tools/remote_build.py --project tmc_scan --env scan --upload-port COM3
```

| Perintah         | Fungsi                                                            |
| ---------------- | ----------------------------------------------------------------- |
| `s`              | pindai sekali di baud sekarang                                    |
| `a`              | auto-scan on/off (default ON, siklus baud)                        |
| `b <baud>`       | kunci baud tertentu                                               |
| `n <1..64>`      | jumlah percobaan per alamat (default 16)                          |
| `d <addr>`       | dump byte mentah 5 percobaan, buat lihat echo vs balasan          |
| `w <addr>`       | uji jalur TULIS lewat IFCNT sebelum/sesudah                       |
| `g <addr>`       | uji gerak aman: bolak-balik 0,5 putaran, posisi akhir = awal      |
| `m <addr> <p10>` | gerak `p10/10` putaran motor, boleh negatif                       |
| `e <0\|1>`       | EN driver mati/hidup (mis. menahan sendi setelah gerak)           |

`g` dan `m` mengonfigurasi driver lewat UART dulu (1 A RMS, 16 microstep,
spreadCycle), membuktikan tulisannya mendarat lewat IFCNT dan baca balik
CHOPCONF, lalu melaporkan `DRV_STATUS`: open-load per kumparan, short ke GND
atau ke VS, dan flag suhu. Satu perintah sudah cukup untuk memvonis satu driver
plus kabel motornya sehat atau tidak. EN dipaksa HIGH saat boot dan dikembalikan
HIGH setelah gerak, jadi sketch ini tidak pernah menggerakkan motor tanpa
diperintah.

> Sendi yang tidak self-locking (J2, J3) bisa melorot begitu EN kembali HIGH di
> akhir `g`. Topang sendinya, atau susul dengan `e 1` supaya driver menahan.

`TMC_R_SENSE` **wajib** dicocokkan dengan resistor sense fisik di modul (marking
R110 = 0.11 Ω, R150 = 0.15 Ω, R050 = 0.05 Ω). Salah nilai = arus salah
proporsional tanpa error apa pun. Latar lengkap: `docs/research/driver-stepper-tmc2209-vs-drv8825.md`.

### Servo feedback via ADS1115 (`SERVO_FEEDBACK 1`)

MG996R dan MG90S punya potensiometer internal yang tegangan wiper-nya = posisi
poros. Wiper disolder keluar ke **ADS1115** → J5, J6, dan gripper punya position
feedback. **Sudah terpasang dan terkalibrasi 10 Agustus 2026.**

1. **Wiper masuk ke ADS1115, bukan ke pin ESP32.** ADS1115 (`0x48`) menumpang
   bus I2C yang sama dengan mux TCA9548A (`0x70`); kanal A0 = J5, A1 = J6,
   A2 = gripper. GPIO 34/35 yang dulu dipakai ADC1 internal kini bebas.
2. **Tegangan sudah diukur, aman tanpa divider.** ADS1115 di-supply 3,3 V dari
   ESP32 (terukur 3,294 V), jadi batas absolut input = 3,6 V. Wiper terukur
   berayun 0,20-3,06 V pada rentang perintah 500-2500 us, yaitu masih di bawah
   VDD. PGA dipasang ±4,096 V (0,125 mV/LSB).
3. **Ground common** antara catu servo, ADS1115, dan ESP32. Ini bukan formalitas:
   lihat catatan ground bounce di bawah.
4. Ini **pembacaan balik**, bukan kontrol: servo tetap menutup lingkar
   kendalinya sendiri terhadap PWM.
5. Kalibrasi 2 titik (`servo_fb_mv_min/max`) memetakan mV → derajat, diisi oleh
   `tools/kalibrasi_servo.py`.

> **Ground bounce, wajib tahu sebelum percaya angkanya.** Selama motor servo
> masih menarik arus untuk mengoreksi posisi, arus itu lewat kabel GND bersama
> dan menggeser referensi ADS1115. Gejalanya khas: simpangan baku satu
> pembacaan melompat dari ~0,1 mV ke 100-440 mV, dan nilainya **selalu meleset
> ke arah rendah** (IR drop di jalur GND). Karena itu semua pengukuran
> kalibrasi menunggu servo tenang dulu (`sd <= 5 mV`) sebelum dipakai, dan
> analisis kecepatan memakai median 5 titik + jendela 40 sampel. Tanpa
> penyaring itu, kecepatan MG996R terhitung 789 deg/s, yaitu 2,2x lebih cepat
> daripada spesifikasinya sendiri.

> **Jebakan pointer register ADS1115.** ADS1115 punya satu pointer register yang
> menentukan register mana yang keluar saat dibaca. Menulis CONFIG (untuk memulai
> konversi) meninggalkan pointer di `0x01`, jadi pembacaan berikutnya
> mengembalikan isi CONFIG, bukan hasil konversi, **tanpa error apa pun**. Cara
> mengenalinya: nilai antar kanal berbeda tepat 4096 hitungan (bit MUX bergeser
> satu kanal) dan semuanya negatif (bit OS selalu 1 saat dibaca balik). Terukur
> saat bring-up: A0 -15485, A1 -11389, A2 -7293, yaitu persis kata CONFIG
> `0xC383`/`0xD383`/`0xE383`. Semua pembacaan wajib lewat `adsReadConvAman()`.

## Pinout ESP32 (WROOM-32 DevKit)

Detail wiring per komponen (driver TMC2209, stepper, servo, encoder AS5600,
mux TCA9548A, power/grounding) ada di **[`pinout.md`](pinout.md)**, dipecah
per komponen supaya gampang ditelusuri "ini nyambung ke mana", bukan satu
tabel gepeng.

Ringkas: GPIO 13/14/25/26 = STEP J1-J4, 27/33/32/23 = DIR J1-J4, 5 = EN
bersama, 16/17 = UART TMC (Serial2), 21/22 = I2C bersama (AS5600 via TCA9548A
dan feedback servo via ADS1115), 18/19 = PWM servo J5/J6, **4 = PWM servo
gripper** (bekas HX711 SCK, modul sudah dilepas). Hindari GPIO 6–11 (flash),
0/2/12/15 (strapping), 39 (input-only sisa); 34/35/36 kini bebas. Servo &
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
tiap 3 dtk (2x gagal → klien diputus), web watchdog menutup socket yang **>4 dtk**
tanpa pesan (feedback normalnya 50 Hz) supaya auto-reconnect jalan dan perintah
tidak menumpuk lalu tumpah sekaligus. Reconnect memakai backoff 2/4/8...30 dtk.

> ⚠️ Ambang watchdog web (4 dtk) **harus tetap lebih longgar** daripada blok
> terpanjang di firmware, karena yang dihitung di sisi web cuma pesan teks
> (frame ping/pong tidak memicu `onmessage` di peramban). Blok terpanjang saat
> ini: `servo_capture` sampai **3,0 dtk** (settle ≤1500 ms + rekam ≤200+1300 ms,
> fase rekam sengaja tanpa `webSocket.loop()`), `servo_read` n=64 ~1,5 dtk,
> `nada`/`sweep` ~1,5 dtk. Dengan ambang 2 dtk yang lama, satu kali servo
> capture memutus linknya sendiri, dan itu ikut melucuti ARM.

**Dead-man klien:** kalau klien WebSocket terakhir hilang lebih dari 4 dtk
(`WS_DEADMAN_MS`) sesudah pernah ada yang tersambung, gerak stepper dihentikan
lewat ramp (`stopMove`) dan target dibekukan. Dilepas otomatis saat ada klien
lagi, bersama sinkronisasi ulang dari encoder. Grace period-nya lebih panjang
dari satu siklus reconnect studio supaya me-refresh halaman tidak dihitung
sebagai operator yang pergi.

Python bridge (`src/arm/bridge.py`) tidak dibutuhkan hardware ini, tapi tetap
berguna untuk mode `--simulate` (uji digital twin + tab CAL tanpa hardware,
protokol cal/diag/load ikut disimulasikan).

### Protokol WebSocket (JSON)

| Arah        | Format                                                                                                                              |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Web → ESP32 | `{"cmd":"goto","angles":[a1..a6]}`: target derajat; divalidasi (angka finite) lalu di-clamp ke joint limit. **Ditolak** (ack `ok:false`) saat e-stop aktif atau driver belum siap |
| Web → ESP32 | `{"cmd":"estop"}` / `{"cmd":"resume"}`: resume menyamakan target dengan posisi nyata (encoder) **lalu** melepas e-stop, jadi tidak ada gerak susulan |
| Web → ESP32 | `{"cmd":"nada","joint":1..4,"hz":40..4000,"ms":<=1500}`: bunyikan nada tanpa berpindah posisi (arah dibalik tiap 8 step)          |
| Web → ESP32 | `{"cmd":"sweep","joint":1..4}`: sapuan 200 sampai 2000 Hz, bunyi "robot" khas A4988, sekitar 1,4 detik                            |
| Web → ESP32 | `{"cmd":"cal_get"}`: minta seluruh kalibrasi                                                                                       |
| Web → ESP32 | `{"cmd":"cal_set", ...field...}`: ubah kalibrasi (RAM saja, all-or-nothing)                                                        |
| Web → ESP32 | `{"cmd":"cal_zero"}` / `{"cmd":"cal_zero","joint":1..4}`: pose sekarang = 0°                                                       |
| Web → ESP32 | `{"cmd":"cal_save"}` / `{"cmd":"cal_reset"}`: simpan ke NVS / kembali default                                                      |
| Web → ESP32 | `{"cmd":"diag"}`: snapshot diagnostik (dipoll tab CAL ~5 Hz saat SERVICE)                                                          |
| Web → ESP32 | `{"cmd":"load_tare"}` / `{"cmd":"load_scale","grams":m}`: nol-kan / kalibrasi load cell dengan massa known                         |
| Web → ESP32 | `{"cmd":"gripper","deg":x}`: gripper (bukan DOF, tidak lewat `angles[]`)                                                            |
| Web → ESP32 | `{"cmd":"servo_center"}`: ketiga servo ke titik tengah terukur, mode manual dilepas                                                 |
| Web → ESP32 | `{"cmd":"servo_us","servo":0..2,"us":400..2600}`: pulsa MENTAH, melewati pemetaan sudut; menahan loop kendali (mode manual)         |
| Web → ESP32 | `{"cmd":"servo_auto"}` / `{"cmd":"servo_auto","servo":s}`: lepas mode manual                                                       |
| Web → ESP32 | `{"cmd":"servo_read","n":1..64}`: oversample tiap kanal ADS1115 → `mv`, `sd`, `us`, `sat`                                          |
| Web → ESP32 | `{"cmd":"servo_capture","servo":s,"from_us":a,"to_us":b,...}`: burst 860 SPS satu kanal untuk step response (kalibrasi kecepatan)  |
| ESP32 → Web | `{"type":"feedback","angles":[a1..a6],"estop":b,"fault":[f1..f4],"grip":g,"drvok":b,"drvrst":n}` (~50 Hz; `fault`=1 bila encoder joint itu mati → open-loop; `drvok`=false bila tahap output driver dimatikan; `drvrst` = cacah pemulihan driver sejak boot) |
| ESP32 → Web | `{"type":"servo","ch":[{nama,ok,mv,sd,us,sat}...]}`: balasan `servo_read`                                                          |
| ESP32 → Web | `{"type":"cap","i":n,"t":[..],"raw":[..]}` lalu `{"type":"cap_end",...}`: potongan hasil `servo_capture`                           |
| ESP32 → Web | `{"type":"cal", ...}`: balasan `cal_get`                                                                                           |
| ESP32 → Web | `{"type":"diag", ...}`: balasan `diag`: per encoder `ok/md/ml/mh/agc/mag/raw/deg/fault`, `sg[4]` StallGuard, `load`, `wifi`, `mux` |
| ESP32 → Web | `{"type":"ack","cmd":"...","ok":b,"msg":"..."}`: balasan tiap command non-goto                                                     |

Field `cal_set` (semua opsional; ditolak seluruhnya bila ada satu yang invalid):
`enc_offset[4]`, `enc_sign[4]` (±1), `ratio[4]` (reduksi per joint, runtime,
ganti reducer bench tanpa re-flash; step counter di-resync dari encoder, tanpa
gerak mendadak), `joint_min[6]`, `joint_max[6]`, `speed`,
`accel`, `kp`, `deadband`, `servo_us_min[3]`, `servo_us_max[3]`,
`servo_us_center[3]`, `servo_ang_min[3]`, `servo_ang_max[3]`,
`servo_fb_mv_min[3]`, `servo_fb_mv_max[3]`. Indeks servo: 0 = J5, 1 = J6,
2 = gripper. Offset/skala load cell di-set lewat `load_tare`/`load_scale`
(bukan `cal_set`) dan ikut tersimpan saat `cal_save`.

`servo_us_center` divalidasi harus berada di dalam `servo_us_min..max`: pose
default saat boot memakai nilai itu, jadi titik tengah di luar travel berarti
lengan menyalakan diri langsung dalam keadaan stall.

`servo_capture` adalah **satu-satunya** bagian kalibrasi servo yang tinggal di
firmware, dan itu memang wajib: pada 860 SPS jarak antar sampel 1,16 ms,
sementara satu round trip WebSocket saja sudah lebih lama dari itu. Fase settle
memanggil `webSocket.loop()` supaya koneksi tidak dianggap mati; fase rekam
sengaja tidak, karena satu jeda merusak keseragaman jarak antar sampel yang
jadi dasar hitungan kecepatan. Total blocking dibatasi di bawah 3 detik.

Diagnostik magnet AS5600 (field `diag.enc[]`): `md` = magnet terdeteksi,
`ml` = terlalu lemah (magnet kejauhan), `mh` = terlalu kuat (kedekatan),
dipakai pilot lamp MAG di tab CAL untuk mengatur jarak magnet fisik saat
bring-up, plus `agc`/`mag` sebagai indikator kualitas.

`nada`/`sweep` **blocking** beberapa ratus ms sampai sekitar 1,4 detik: pulsa
STEP di-bit-bang langsung supaya frekuensinya bersih, dan memecahnya jadi
potongan non-blocking justru terdengar patah patah. Durasinya dibatasi jauh di
bawah timeout heartbeat WebSocket (3 s) dan loop WDT. Pin STEP dilepas dulu dari
FastAccelStepper (`detachFromPin`) lalu dikembalikan, karena selama pin itu
dipegang RMT/MCPWM, `digitalWrite` tidak terlihat sama sekali di pad. Keempat
sendi stepper bisa dibunyikan karena masing-masing punya drivernya sendiri.

Bunyi khas A4988 yang orang kenal itu bunyi chopper di **microstep rendah**,
bukan efek terpisah. Set `tmc_microstep` ke 1 atau 2 dengan `tmc_spread` 1
(spreadCycle) lalu gerakkan sendi, dan lengan terdengar seperti mesin CNC lama.
Microstep tinggi plus stealthChop membuatnya nyaris senyap. Keduanya runtime
lewat `cal_set`, tanpa re-flash, dan `STEPS_PER_DEG` ikut dihitung ulang jadi
sudut sendi tetap benar.

**Prinsip pembagian peran:** firmware = executor primitif + guardrail real-time
(ramp, closed-loop, e-stop, validasi/clamp). Semua sequencing kalibrasi,
perhitungan (uji rasio, gram→torsi), dan logging CSV ada di studio (tab CAL).

Kompatibilitas: pesan `feedback` cuma nambah field (`estop`, `fault`),
`studio/src/net/bridge.js` yang lama tetap jalan karena hanya membaca `angles`.
`ESTOP_AUTO_RESUME` kini default **0**: goto TIDAK melepas e-stop, wajib
`{"cmd":"resume"}` eksplisit (tombol RESET di studio sudah mengirimnya).

## Library (Library Manager / PlatformIO)

- **WebSockets** (Links2004 / arduinoWebSockets)
- **ArduinoJson** (v6+)
- **FastAccelStepper** (pembangkit step hardware RMT/MCPWM)
- **ESP32Servo**
- **TMCStepper** (kontrol UART TMC2209)
- WiFi, ESPmDNS, Wire: bawaan core ESP32

> **Timing step:** pulsa STEP dibangkitkan peripheral **hardware** (RMT/MCPWM)
> lewat FastAccelStepper, bukan software di `loop()`. Jadi timing kebal jitter
> WiFi dan sanggup step rate tinggi (J2 ≈ 4000 step/derajat). Inilah alasan
> **1 ESP32 cukup**, tidak perlu MCU kedua khusus WiFi.

### Perjalanan vs galat sisa (sendi ber-encoder)

Loop sendi membedakan dua hal yang dulu tercampur:

- **Perjalanan.** Step counter belum sampai di target, jadi sisanya adalah gerak
  yang diperintahkan operator. Dijalankan sebagai satu `moveTo` menerus, dengan
  satu ramp naik dan satu ramp turun untuk seluruh jarak.
- **Galat sisa.** Counter sudah di target dan motor sudah berhenti, jadi sisanya
  adalah selisih antara yang dikira firmware dan yang dilihat encoder (langkah
  hilang, lendutan, backlash). Hanya di sini pembacaan encoder boleh
  menggerakkan sendi, dan besarnya tetap dijepit `CORR_MAX_DEG` (5°).

> ⚠️ Sampai 12 Agustus 2026 cabang perjalanan itu tidak ada, sehingga **semua**
> gerak sendi ber-encoder jatuh ke cabang koreksi dan dipecah jadi potongan 5°.
> `goto` 10° → 50° ditempuh sebagai **delapan** gerak terpisah yang masing masing
> punya ramp naik-turun sendiri: berhenti, maju, berhenti, maju, dan tiap
> berhenti menendang inersia lengan. Halaman bawaan ESP32 lolos dari gejala ini
> bukan karena jalurnya beda, melainkan karena geseran slider mengirim target
> baru tiap 50 ms sehingga potongannya kecil kecil dan 20 kali per detik. Yang
> mengirim satu target besar sekaligus (Send goto di studio) mendapat tangganya
> utuh.

## Compile cepat lewat PC (remote build)

Compile di laptop lambat; kalau PC sebelah nyala dan satu jaringan WiFi,
`tools/remote_build.py` nyalain PC via SSH buat compile, terus tarik hasilnya
balik ke laptop buat di-flash lewat USB lokal (PC gak perlu nyolok ESP32 sama
sekali). Setup sekali:

1. Di PC: aktifkan OpenSSH Server (`Add-WindowsCapability -Online -Name
   OpenSSH.Server~~~~0.0.1.0`), `Start-Service sshd`, `Set-Service sshd
   -StartupType Automatic`, buka firewall port 22. Pastikan PlatformIO CLI ada
   (`%USERPROFILE%\.platformio\penv\Scripts\pio.exe --version`).
2. Otorisasi public key laptop (`~/.ssh/robotic-arm-pc.pub`) ke
   `authorized_keys` PC (akun biasa: `~/.ssh/authorized_keys`; akun admin:
   `C:\ProgramData\ssh\administrators_authorized_keys`).
3. Salin `tools/remote_build.config.example.json` → `tools/remote_build.config.json`
   (gitignored), isi IP + username Windows PC.

Pemakaian:

```
python tools/remote_build.py --upload-port COM7
python tools/remote_build.py --no-upload                 # compile doang, cek error
python tools/remote_build.py --project tmc_bench --env bench --upload-port COM7
python tools/remote_build.py --project tmc_scan  --env scan  --upload-port COM3
```

### Dari luar WiFi rumah (Tailscale)

PC dan laptop ada di satu tailnet Tailscale, jadi `host` di
`remote_build.config.json` diisi nama MagicDNS `pc-render`, bukan IP LAN.
Nama itu tetap sama entah laptop lagi di rumah, di kampus, atau nebeng
tethering, dan jalurnya WireGuard langsung (bukan port 22 yang dibuka ke
internet). `render_klip.py` ikut config yang sama, jadi render 3D juga jalan
dari luar.

Yang dipasang sekali di PC (semua lewat scheduled task SYSTEM karena sesi SSH
tidak dapat token admin):

- Tailscale mode unattended (`ForceDaemon`), biar tetap online walau tidak ada
  yang login ke desktop PC.
- `tailscale up --advertise-routes=192.168.1.0/24`, di-approve dari admin
  console. Ini yang bikin ESP32 di WiFi rumah bisa dijangkau dari luar; ESP32
  sendiri tidak bisa dipasangi klien VPN.
- Key expiry PC dimatikan, supaya PC tidak lepas dari tailnet pas kita lagi
  jauh dan tidak bisa login ulang.

Laptop di-`tailscale up --accept-routes`, jadi rute rumah otomatis kepakai.

Cloudflare WARP mode "Traffic and DNS" boleh nyala bareng Tailscale, sudah
diuji: MagicDNS tetap resolve, jalur tetap direct, compile jalan normal. WARP
tidak menelan trafik tailnet karena range CGNAT dan RFC1918 ada di exclude
list bawaannya, jadi paket WireGuard-nya tetap lewat Wi-Fi.

Batasannya:

- PC harus hidup. Sleep saat colok listrik sudah 0, tapi kalau PC mati total
  tidak ada cara membangunkannya dari jauh.
- `armbot.local` **tidak** jalan lewat rute subnet (mDNS itu multicast
  link-local). Dari luar pakai IP ESP32 langsung, jadi kunci IP-nya lewat DHCP
  reservation di router.
- Kalau jaringan tempat kita numpang kebetulan juga `192.168.1.0/24`, **rute
  rumah yang menang, bukan LAN lokal** (terukur di laptop: rute Tailscale total
  metric 5, rute Wi-Fi 311, karena Tailscale memasang interface metric 5 lawan
  55 milik Wi-Fi). Artinya ESP32 yang ada di depan mata malah tidak terjangkau
  karena paketnya dibelokkan ke rumah. Obatnya `tailscale set
  --accept-routes=false` selama di situ, atau permanen: ganti subnet rumah ke
  yang jarang dipakai (`192.168.77.0/24` misalnya).

## Kalibrasi

**Compile-time (sekali, sesuai wiring):**

1. WiFi: salin `wifi_secrets.h.example` → `wifi_secrets.h`, isi preset
   (jangan commit; `WIFI_FORCE_AP 1` bila mau langsung hotspot).
2. Set `STEP_PIN`/`DIR_PIN`/`EN_PIN` sesuai wiring, dan `TMC_R_SENSE` sesuai
   marking resistor sense di modul driver.
3. `RATIO[]`, `MICROSTEP`, dan `TMC_MA_DEFAULT[]` hanya **default awal**, nilai
   aktif ada di kalibrasi (`ratio`, `tmc_microstep`, `tmc_ma`) dan bisa diganti
   runtime (bench: pulley 15:1 ↔ cycloidal 25:1, atau cari arus optimal, tanpa
   re-flash).

**Runtime via WebSocket (tanpa re-flash), disimpan permanen di NVS, semua
langkah ini ada tombolnya di studio, tab CAL (mode SERVICE):**

4. Bring-up encoder: cek pilot lamp MAG (diag `md/ml/mh/agc`) → atur jarak
   magnet sampai hijau.
5. Set `ratio` sesuai reducer terpasang → JOG pelan → arah terbalik? flip DIR
   (`enc_sign`) → ZERO (`cal_zero`) → verifikasi tombol TEST (goto ±10°,
   bandingkan Δencoder vs Δcommanded).

   > ⚠️ Uji ±10° itu sah untuk memeriksa ARAH dan kewarasan, tapi **tidak sah
   > untuk menyimpulkan `ratio`**. Galat encoder yang berpola sekali dan dua
   > kali per putaran menyamar jadi galat skala di busur sempit: di J1, sapuan
   > ±20° memberi "rasio" 15,59 (berulang rapi, dan tetap salah 4 persen)
   > sedangkan satu putaran penuh memberi 15,0 yang benar. Rasio hanya boleh
   > disimpulkan dari sapuan satu putaran penuh, atau diambil dari hitungan
   > gigi. Prosedur lengkap: [`kalibrasi.md`](kalibrasi.md).
6. Servo (J5, J6, gripper): **jangan** diisi tangan. Jalankan
   `tools/kalibrasi_servo.py`, yang menyapu bertahap sambil memeriksa apakah
   wiper masih mengikuti, lalu mengisi `servo_us_min/max/center` dan
   `servo_fb_mv_min/max` dari hasil ukur. Prosedur, pagar pengaman, dan hasil
   10 Agustus 2026: [`kalibrasi.md`](kalibrasi.md).

   > ⚠️ Sapuan langsung 500 → 2500 µs bisa membuat servo menekan stop
   > internalnya terus menerus tanpa satu pun pesan kesalahan. Perkakas itu
   > melangkah 20 µs dan mundur begitu wiper berhenti mengikuti.
8. Load cell: TARE tanpa beban → CAL MASSA dengan massa known (gram).
9. Tuning `kp` dan `deadband` (juga `speed`/`accel`) via parameter panel untuk
   gerak halus tanpa osilasi.
10. COMMIT (`cal_save`), tanpa ini perubahan hilang saat reboot. Cek isi
    aktif kapan pun dengan READ (`cal_get`); kembali default dengan DEFAULTS
    (`cal_reset`).

Kalibrasi persisten disimpan sebagai blob di NVS (Preferences, namespace
`armcal`) dengan magic + versi; blob beda versi diabaikan (fallback default).

**Prosedur terukur + perkakasnya:** [`kalibrasi.md`](kalibrasi.md) memuat urutan
langkah yang sudah terbukti di hardware, daftar jebakan yang sudah memakan waktu,
dan hasil J1 lengkap. Skripnya `tools/kalibrasi_sendi.py` (jalankan per langkah)
dan `tools/kalibrasi_analisa.py` (bedah kurva galat jadi offset, skala, dan
harmonik). Datanya masuk `benchmarks/kalibrasi/`.

> ⚠️ Sesudah re-flash, kalibrasi kembali ke default dan `enc_sign` ikut balik ke
> +1. Karena koreksi loop tertutup kini benar benar bekerja, tanda yang salah
> berarti umpan balik positif. Pulihkan dengan urutan: `estop` → kirim
> `enc_sign`/`enc_offset` lama → `goto` ke sudut aktual selagi masih e-stop →
> `resume`. Tanpa itu sudut aktual melompat sementara target masih angka lama,
> dan lengan menempuh selisihnya.

> ⚠️ Skeleton perlu dikalibrasi & diuji bertahap. Mulai dari wrist cluster
> (J4/J5/J6), lalu siku, lalu bahu (lihat roadmap di README utama).
