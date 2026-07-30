# Driver Stepper: TMC2209 vs DRV8825 untuk 17HS6401S & 17HS2401

Riset referensi untuk sub-bab perangkat keras aktuator. Fokus: kenapa arus
terukur selalu kecil, cara set arus yang benar (deterministik, bukan trial and
error), dan batas fisik yang tidak bisa dilawan dengan software.

Tanggal riset: 2026-07-26. Sumber di bagian akhir.

---

## 1. Data motor

| Parameter | 17HS6401 (S) | 17HS2401 |
| --- | --- | --- |
| Frame / panjang body | NEMA17, 60 mm | NEMA17, 40 mm (alias 42BYGH40) |
| Step angle | 1.8° (ada varian `-09` = 0.9°) | 1.8° |
| Arus rated | 1.7 A/fasa | 1.7 A/fasa |
| Holding torque | 0.72 N·m (72 N·cm) | 0.45 N·m |
| Resistansi fasa | 3.0 Ω | ~1.5 Ω (kelas 42BYGH40, ukur sendiri) |
| Induktansi fasa | 6.2 mH | ~2.8 mH (ukur/estimasi) |
| Rotor inertia | 80 g·cm² | ~54 g·cm² |
| Lead | 4 kabel bipolar | 4 kabel bipolar |
| Berat | 480 g | ~280 g |

**Peringatan varian:** `17HS6401S-09` adalah versi **0.9°** (400 full-step/rev,
1.8 A, 0.70 N·m). Kalau motor yang dipakai varian ini tapi firmware mengasumsikan
200 step/rev, semua sudut sendi meleset **tepat 2x**. Cek dulu labelnya sebelum
menyalahkan kinematika.

Toleransi datasheet kelas ini: resistansi ±10%, induktansi ±20%. Jadi angka R
di tabel harus divalidasi dengan multimeter (ukur DC resistance antara A+/A-),
bukan dipakai mentah untuk perhitungan skripsi.

---

## 2. Kenapa power supply tidak pernah menarik 1 A

Ada dua sebab yang sama sekali berbeda. Keduanya berlaku di kasus ini.

### 2.1 Arus PSU ≠ arus coil (ini yang utama, dan ini normal)

Driver stepper modern adalah **constant-current chopper**, secara topologi
setara buck converter. Driver menurunkan tegangan supply jadi tegangan sekecil
apa pun yang dibutuhkan untuk mendorong arus target lewat coil. Yang diatur
konstan adalah arus di **coil**, bukan arus dari **supply**.

Keseimbangan daya (abaikan rugi-rugi):

```
V_supply x I_supply  ~=  P_coil / eta
P_coil (diam)        =   2 x I_rms^2 x R_fasa
```

Hitungan nyata untuk 17HS6401 (R = 3.0 Ω), motor diam, dua fasa aktif:

| Setting arus | P_coil | I_supply @12 V | I_supply @24 V |
| --- | --- | --- | --- |
| 600 mA RMS | 2.16 W | ~0.20 A | ~0.10 A |
| 900 mA RMS | 4.86 W | ~0.45 A | ~0.23 A |
| 1200 mA RMS | 8.64 W | ~0.80 A | ~0.40 A |
| 1700 mA RMS (rated) | 17.3 W | ~1.60 A | ~0.80 A |

Jadi dengan `rms_current(600)` di 12 V, angka **0.2 A di display PSU adalah
hasil yang benar**, bukan gejala kerusakan. Arus supply baru naik mendekati arus
coil kalau motor berputar cepat (back-EMF memaksa duty cycle chopper mendekati
100%) atau dibebani berat.

Konsekuensi lain: `rms_current(600)` di TMCStepper juga menyetel
`IHOLD = 0.5 x IRUN` secara default, jadi saat benar-benar diam arus turun lagi
jadi setengahnya. Display PSU makin kecil lagi.

**Aturan sizing PSU** (bukan aturan diagnosis): rating arus PSU cukup ~2/3 dari
total arus fasa rated kalau winding paralel, ~1/3 kalau seri.

### 2.2 Bug nyata: pin VREF masih ikut mengali arus meski mode UART

Ini penyebab kedua, dan ini **bug beneran** yang ada di kode uji maupun di
`firmware/arm_controller_esp32/`.

Di TMC2209, bit `I_scale_analog` (GCONF bit 0) menentukan sumber referensi arus.
**Default power-on chip ini = 1**, artinya arus full-scale diskalakan oleh
tegangan di pin VREF (potensio kecil di modul):

```
I_rms_aktual = I_rms_diminta x (V_REF / 2.5 V)
```

Library TMCStepper **tidak mematikan bit ini**. `TMC2208Stepper::begin()` isinya
cuma:

```cpp
void TMC2208Stepper::begin() {
    pdn_disable(true);
    mstep_reg_select(true);
}
```

dan `defaults()`-nya justru menyetel `GCONF_register.i_scale_analog = 1`. Jadi
begitu `begin()` menulis GCONF, VREF tetap aktif sebagai pengali.

Modul BIGTREETECH TMC2209 keluar pabrik dengan **VREF = 1.2 V ± 0.1 V**. Artinya:

| Yang diminta di kode | Faktor VREF (1.2 / 2.5) | Yang keluar sebenarnya |
| --- | --- | --- |
| `rms_current(600)` | 0.48 | **288 mA** |
| `rms_current(900)` (J1/J3 di repo) | 0.48 | **432 mA** |
| `rms_current(1200)` (J2 di repo) | 0.48 | **576 mA** |

Konsisten dengan tiga sumber independen: rumus Watterott `Irms = Vref x 0.71`
(pada CS maksimum), spec BTT `I_RMS = V_REF / sqrt(2)`, dan rumus datasheet.
Ketiganya bertemu di titik yang sama: VREF 2.5 V = 1.77 A RMS maksimum dengan
R_SENSE 0.11 Ω.

**Perbaikan:** panggil `I_scale_analog(false)` eksplisit setelah `begin()`.
Setelah itu potensio VREF tidak berpengaruh sama sekali dan `rms_current()`
jadi satu-satunya penentu.

### 2.3 Cek ketiga yang sering terlewat: PSU dalam mode CC

Bench PSU sering punya knob current limit yang tertinggal di angka rendah.
Kalau lampu **CC** menyala (bukan CV), PSU sedang membatasi dan tegangan sedang
drop. Setel current limit ke minimal 2x kebutuhan (misal 3 A) dan pastikan
indikator **CV** yang menyala.

---

## 3. TMC2209: yang wajib diketahui

### Batas listrik

| Parameter | Nilai |
| --- | --- |
| Tegangan motor (VM/VS) | 4.75 V - **28 V** |
| Arus maksimum IC | 2.0 A RMS / 2.8 A peak |
| Arus maksimum settable dengan R_SENSE 0.11 Ω | **1.77 A RMS** |
| Aman tanpa pendingin serius | ~1.0 A RMS (heatsink kecil) |
| >1.0 A RMS | butuh heatsink besar + kipas |

28 V itu **keras**. Jangan pakai supply 36 V. Back-EMF dari deselerasi juga bisa
mendorong VM naik, jadi 24 V nominal sudah dekat batas. Sediakan kapasitor bulk
low-ESR (≥100 µF, rating ≥35 V) sedekat mungkin ke tiap driver.

### R_SENSE: verifikasi, jangan asumsi

| Board | R_SENSE |
| --- | --- |
| BIGTREETECH TMC2209 v1.2/v1.3 | 0.11 Ω |
| Watterott SilentStepStick | 0.11 Ω |
| FYSETC Silent2209 | 0.11 Ω |
| Adafruit TMC2209 breakout | **0.05 Ω** |
| Klon murah | 0.11 atau **0.15 Ω** |

Salah R_SENSE = arus salah proporsional. Kode repo pakai `0.11f`. Kalau modulnya
ternyata 0.15 Ω, arus aktual jadi 0.11/0.15 = **73%** dari yang diminta, dan itu
menumpuk dengan bug VREF di atas.

### Rumus arus (untuk dilampirkan di skripsi)

```
I_rms = (CS + 1) / 32  x  V_fs / (R_SENSE + 0.02)  x  1/sqrt(2)

V_fs = 0.325 V  (vsense = 0)
V_fs = 0.180 V  (vsense = 1, high sensitivity untuk arus kecil)
```

TMCStepper otomatis pindah ke `vsense = 1` kalau CS hasil hitungan < 16, lalu
menghitung ulang CS. Offset `+0.02 Ω` adalah resistansi parasit MOSFET internal
yang selalu ditambahkan library.

Verifikasi balik ada dua lapis, dan keduanya perlu:

1. **Skala digital.** Baca `driver.cs_actual()` (atau `driver.irun()`) lewat
   UART, masukkan ke rumus di atas, bandingkan dengan yang diminta. Catatan:
   saat motor diam dan `TPOWERDOWN` sudah lewat, `cs_actual` turun ke IHOLD,
   jadi baca saat motor bergerak atau tepat setelah enable.
2. **Skala analog.** `cs_actual` **tidak** mencerminkan pengali VREF, karena
   penskalaan VREF terjadi di domain analog setelah CS. Jadi lapis ini harus
   dicek terpisah dengan membaca balik `driver.I_scale_analog()`; hasilnya
   wajib `false`.

Ground truth tetap multimeter seri dengan coil (lihat prosedur bagian 6).

### stealthChop vs spreadCycle

| | stealthChop | spreadCycle |
| --- | --- | --- |
| Suara | hampir senyap | terdengar jelas |
| Torsi | lebih rendah | lebih tinggi |
| Akurasi posisi | lebih rendah | lebih tinggi |
| Panas motor | bisa lebih tinggi | normal |
| Kecepatan tinggi | rawan lost step di atas ~60-100 RPM | stabil |
| Perlu tuning | ya, autotune AT#1/AT#2 | tidak |

**stealthChop butuh prosedur autotune** yang gampang dirusak:

- **AT#1**: arus harus sudah aktif dan motor **diam >130 ms** setelah enable.
- **AT#2**: setelah itu motor harus bergerak dengan kecepatan konstan wajar
  (homing sequence sudah cukup).
- Autotune **batal** kalau arus, VREF, atau tegangan supply diubah. Ganti
  microstep atau toggle mode di tengah gerakan juga mengacaukan model.

Ini persis yang terjadi di kode uji: `microsteps()` dan `en_spreadCycle()` ditoggle
berulang di dalam `loop()`. Motornya tidak pernah dapat kesempatan menyelesaikan
autotune, jadi torsi selalu di bawah potensinya.

**Rekomendasi untuk lengan robot:** pakai **spreadCycle sebagai default**. Alasan:
lengan bergerak lambat dan berbeban, torsi dan akurasi jauh lebih berharga
daripada senyap, dan spreadCycle menghapus seluruh kelas masalah tuning. Ini
langsung menjawab tujuan "optimal tanpa kalibrasi berulang".

**Pengecualian penting:** StallGuard4 di TMC2209 dioptimasi untuk stealthChop dan
praktis hanya berguna di mode itu (beda dengan StallGuard2 di TMC2130 yang butuh
spreadCycle). Jadi kalau sensorless homing dipakai, mode harus dipindah ke
stealthChop **khusus saat homing**, lalu balik ke spreadCycle untuk operasi
normal. Jangan campur.

### Wiring UART

- TX MCU -> resistor **1 kΩ** -> pin PDN_UART. RX MCU -> PDN_UART langsung.
  Resistor wajib, dia yang bikin satu kabel bisa dipakai dua arah.
- `driver.version()` harus mengembalikan **0x21** untuk TMC2209 (0x20 = TMC2208).
- Alamat lewat MS1/MS2: 00, 01, 10, 11. Saat UART aktif, MS1/MS2 **bukan lagi**
  pin microstep, jadi microstep harus di-set lewat register (`mstep_reg_select(true)`).
- **Jebakan saat menambah driver kedua:** saran umum "jumper MS1 dan MS2 ke GND"
  hanya benar untuk driver **pertama** (alamat `0b00`). Kalau keempat driver
  dijumper sama, semuanya beralamat `0b00`, saling menimpa di bus yang sama, dan
  gejalanya membingungkan (satu driver merespons, tiga lainnya diam atau ikut
  berubah setting). Sesuai `firmware/pinout.md`: J1 = LOW/LOW, J2 = HIGH/LOW,
  J3 = LOW/HIGH, J4 = HIGH/HIGH. Pin yang HIGH ditarik ke VIO 3.3 V, bukan
  dibiarkan mengambang.
- Resistor 1 kΩ cukup **satu buah** untuk seluruh bus, dipasang di jalur TX
  ESP32, bukan satu per driver.

### Penyebab driver mati

Penyebab nomor satu bukan overcurrent, tapi **melepas motor atau supply saat
driver hidup**. Induksi back-EMF langsung merusak output stage. Selalu matikan
VM sebelum mencabut apa pun.

---

## 4. DRV8825: yang wajib diketahui

| Parameter | Nilai |
| --- | --- |
| Tegangan motor | **8.2 V - 45 V** (tidak bisa 5 V) |
| Arus per fasa tanpa pendingin | ~1.5 A |
| Arus per fasa dengan pendingin memadai | 2.2 A |
| Sense resistor (carrier Pololu) | 0.100 Ω |
| Microstep | full, 1/2, 1/4, 1/8, 1/16, 1/32 |
| Antarmuka | STEP/DIR + MODE0-2 saja, **tanpa UART** |

### Set arus

```
Current limit = V_REF x 2        (dengan sense 0.1 Ω)
V_REF         = Current limit / 2
```

- Ukur VREF di **via yang dilingkari di silkscreen bawah** carrier Pololu, atau
  langsung di badan logam potensio. Referensi ke GND logic.
- Angka ini adalah **peak** per coil, bukan RMS.
- Di **full-step mode**, arus coil terukur hanya **0.7x** current limit. Datasheet
  memang mengatur begitu. Jangan bingung kalau pengukuran meleset 30%.
- Contoh untuk 17HS6401 (1.7 A rated): VREF = 0.85 V. Untuk margin termal di
  lengan robot, mulai dari 0.6 V (1.2 A peak).

### Tabel MODE

| MODE0 | MODE1 | MODE2 | Resolusi |
| --- | --- | --- | --- |
| L | L | L | full step |
| H | L | L | 1/2 |
| L | H | L | 1/4 |
| H | H | L | 1/8 |
| L | L | H | 1/16 |
| H | L | H | 1/32 |

Pin mengambang = full step. Ini sering jadi penyebab "kok kasar banget".

### Masalah mixed decay (relevan banget untuk lengan robot)

DRV8825 default ke **mixed decay** (pin DECAY mengambang; ada pull-up 130 kΩ dan
pull-down 80 kΩ internal yang saling mengimbangi). Di kecepatan rendah, mode ini
mendistorsi bentuk gelombang arus sampai **microstep hilang**:

- Di kecepatan rendah impedansi coil praktis hanya resistansi, back-EMF nyaris
  nol, jadi coil melihat hampir seluruh tegangan supply.
- Selama blanking time 4.7 µs tidak ada current control sama sekali, arus
  melonjak melewati target.
- Akibatnya microstep pertama setelah perubahan arah/level sering tidak
  terealisasi.

Perbaikan: paksa **fast decay** (DECAY = logic HIGH). Konsekuensinya lebih
berisik dan bergetar. Di carrier Pololu 2133 pin DECAY tidak diekspos ke header,
jadi perlu solder ke pad.

**Ini alasan teknis paling kuat kenapa DRV8825 kurang cocok untuk lengan robot
yang bergerak lambat.** Untuk 3D printer yang selalu bergerak cepat, masalahnya
tidak terlihat.

---

## 5. Batas fisik yang tidak bisa dilawan software

Waktu naik arus di coil dibatasi induktansi:

```
t_rise = L x I / V_supply
```

Untuk 17HS6401 (L = 6.2 mH, I = 1.7 A):

| V_supply | t_rise |
| --- | --- |
| 12 V | 878 µs |
| 24 V | 439 µs |

Satu siklus elektrik = 4 full-step. Di 24 V, ceiling teoretis (torsi nol) ada di
sekitar 570 siklus/s = ~680 RPM; realistis dengan margin torsi sekitar sepertiganya,
**~200-250 RPM di 24 V** dan **~100-150 RPM di 12 V**. Di atas itu torsi jatuh
apa pun setting drivernya.

Rule of thumb industri untuk chopper driver: `V_supply optimal ~= 32 x sqrt(L_mH)`.
Untuk 17HS6401 itu 32 x sqrt(6.2) = **80 V**, jauh di atas batas 28 V TMC2209.
Artinya motor ini memang **inductance-limited** di TMC2209. Ini bukan cacat
desain, tapi harus disebut eksplisit di skripsi sebagai batasan sistem.

Untungnya J2 punya reduksi 45:1, jadi 200 RPM motor = 4.4 RPM di sendi, lebih
dari cukup untuk lengan. Kesimpulan yang bisa ditulis: **naikkan supply dari
12 V ke 24 V** (dua kali lipat kecepatan sebelum torsi drop, dan setengah arus
supply untuk daya yang sama), jangan lebih.

---

## 6. Prosedur verifikasi deterministik

Urutan ini menggantikan tuning coba-coba. Tiap langkah punya angka yang bisa
dicek, bukan "rasanya kurang kuat".

1. **Ukur R coil.** Multimeter mode ohm antara A+ dan A-, lalu B+ dan B-.
   Harus ~3 Ω (17HS6401) / ~1.5 Ω (17HS2401), dan kedua pasang harus sama.
   Kalau open circuit, pasangan kabelnya salah.
2. **Baca R_SENSE fisik di modul.** Lihat marking resistor kecil dekat pin motor
   (R110 = 0.11 Ω, R150 = 0.15 Ω, R050 = 0.05 Ω). Cocokkan dengan `TMC_R_SENSE`.
3. **Pastikan PSU di mode CV,** current limit disetel ≥3 A.
4. **Set arus lewat UART** dengan `I_scale_analog(false)` sudah dipanggil.
5. **Baca balik `driver.cs_actual()`**, masukkan ke rumus bagian 3. Hasilnya harus
   cocok ±5% dengan yang diminta. Kalau tidak cocok, berhenti di sini, jangan
   lanjut. Ini gerbang utama.
6. **Ukur arus coil langsung.** Set `microsteps(0)` (full step), enable driver,
   motor diam. Di posisi full-step kedua coil membawa arus yang sama besar dan
   nilainya tepat `I_rms`. Sisipkan multimeter mode DC A seri dengan satu coil.
   Ripple chopper ada di sisi supply, arus coil-nya sendiri praktis DC, jadi
   multimeter biasa cukup akurat di sini.
7. **Cek arus supply** terhadap tabel di bagian 2.1. Kalau jauh lebih tinggi,
   berarti ada yang salah (short, decay mode salah). Kalau sesuai tabel, sistem
   sehat.
8. **Uji termal.** Jalankan 30 menit. Spec temperature rise motor 80 °C maksimum
   pada arus nominal. Kalau bodi motor terlalu panas untuk dipegang >3 detik,
   turunkan arus atau tambah pendinginan driver.

---

## 7. Rekomendasi untuk proyek ini

**Tetap pakai TMC2209, jangan pindah ke DRV8825.** Alasan yang bisa
dipertanggungjawabkan di sidang:

1. Arus diatur lewat register UART, bisa diubah per sendi saat runtime, dan bisa
   **dibaca balik** untuk verifikasi. DRV8825 hanya bisa potensio, tidak bisa
   diaudit oleh firmware.
2. Masalah mixed decay DRV8825 muncul justru di rentang kecepatan rendah, yaitu
   rentang kerja utama lengan robot.
3. StallGuard4 memberi deteksi beban/tabrakan tanpa sensor tambahan, sudah ada
   hook-nya di firmware (`SG_THRESHOLD[]`).
4. Interpolasi internal ke 256 microstep menghaluskan gerakan tanpa menaikkan
   beban step rate di ESP32.

Kekuatan DRV8825 yang tidak dimiliki TMC2209 adalah tegangan sampai 45 V dan
arus 2.2 A. Keduanya tidak terpakai di sini karena motornya 1.7 A dan supply
dibatasi 24 V.

Konfigurasi yang disarankan:

| Item | Nilai | Alasan |
| --- | --- | --- |
| V_supply | 24 V | 2x headroom kecepatan vs 12 V, masih di bawah batas 28 V |
| `I_scale_analog` | `false` | hilangkan VREF sebagai variabel liar |
| Mode chopper | spreadCycle (`en_spreadCycle(true)`) | torsi + akurasi, nol tuning |
| Mode saat homing | stealthChop | syarat StallGuard4 |
| Microstep | 16, `intpol(true)` | halus tanpa membebani step rate |
| `toff` | 4 | |
| `blank_time` | 24 | |
| holdMultiplier | 0.4 - 0.5 | tahan posisi tanpa panas berlebih |
| Arus J1/J3 (17HS4401/17HS2401, 1.7 A) | 1000-1200 mA RMS | ~60-70% rated, butuh heatsink |
| Arus J2 (17HS6401, 1.7 A) | 1200-1400 mA RMS | butuh heatsink + kipas |
| Kapasitor bulk per driver | ≥100 µF / 35 V low-ESR | |

Catat bahwa >1.0 A RMS **wajib** heatsink besar plus aliran udara. Kalau
pendinginan tidak memungkinkan, turunkan ke 900 mA dan kompensasi dengan rasio
reduksi, bukan dengan menaikkan arus di luar kemampuan termal.

---

## 8. Mengatur karakter suara motor

Suara "robot" yang terdengar di video lengan robot bukan efek tambahan. Itu
motor stepper yang memang berbunyi, dan sumbernya bisa dikendalikan.

### Sumber suara, dari yang paling berpengaruh

**1. Frekuensi step = pitch.** Motor bergetar di frekuensi microstep rate.
Kalau frekuensi step berada di 20 Hz - 20 kHz, frekuensi itu dan seluruh
harmoniknya masuk rentang dengar.

Untuk konfigurasi proyek ini (200 full-step/rev, microstep 16):

| Kecepatan motor | Step rate | Nada yang terdengar |
| --- | --- | --- |
| 0.05 rev/s | 160 Hz | dengung rendah |
| 0.2 rev/s | 640 Hz | nada tengah |
| 1.0 rev/s | 3.2 kHz | melengking |

Rentang kerja lengan robot jatuh persis di tengah pita audio. Itu sebabnya
lengan robot "bernyanyi" saat bergerak. Karena akselerasi mengubah step rate
secara kontinu, pitch-nya ikut menyapu naik dan turun. Sapuan inilah yang
terdengar seperti servo sci-fi.

Artinya: **karakter suara ditentukan oleh motion profile, bukan setting driver.**
Ramp panjang = sapuan panjang dan halus. Ramp pendek = bunyi tersentak.

**2. Mode chopper.** stealthChop dirancang khusus untuk **menghilangkan** suara
ini. Kalau suaranya diinginkan, spreadCycle adalah jawabannya. Kebetulan
spreadCycle juga yang dipilih demi torsi dan akurasi, jadi tidak ada trade-off
di sini.

**3. `intpol`.** Interpolasi internal ke 256 microstep menghaluskan gelombang
arus, hasilnya lebih halus dan lebih senyap. `intpol(false)` memberi karakter
lebih kasar dan mekanis.

**4. Resolusi microstep.** Makin sedikit microstep, makin besar amplitudo
getaran per langkah, makin keras dan makin "mekanis" bunyinya. Tapi ini juga
menaikkan resonansi dan menurunkan kehalusan gerakan, jadi jangan dikorbankan
demi suara. Trik standar untuk **mengurangi** noise justru sebaliknya: naikkan
level microstep dan step rate bersamaan sehingga frekuensi step keluar dari pita
audio, sementara kecepatan motor tetap.

### Membunyikan nada tanpa memindahkan sendi

Balik `DIR` tiap N step. Rotor bergetar bolak-balik di sekitar posisi yang sama,
perpindahan bersihnya nol, tapi frekuensi step tetap terdengar. Berguna untuk
chime saat boot atau bunyi konfirmasi. Implementasinya ada di
`firmware/tmc_bench/tmc_bench.ino` (`playTone()` dan `chirp()`).

### VACTUAL: generator step internal

TMC2209 punya generator pulsa step internal, jadi motor bisa diputar kecepatan
konstan murni lewat UART tanpa satu pun pulsa STEP dari MCU:

```
microstep_per_detik = VACTUAL x f_clk / 2^24
                    = VACTUAL x 0.715      (f_clk 12 MHz, clock internal)
```

f_clk internal nominal 12 MHz (4-16 MHz kalau pakai clock eksternal). Generator
ini **tidak punya fungsi ramp**, perubahan kecepatan terjadi seketika. Jadi
berguna untuk uji bench dan efek suara, tapi gerakan sendi sebenarnya tetap
harus lewat STEP/DIR dengan profil akselerasi.

---

## Sumber

- [TMC2209 Datasheet Rev 1.09, Analog Devices](https://www.analog.com/media/en/technical-documentation/data-sheets/TMC2209_datasheet_rev1.09.pdf)
- [SilentStepStick FAQ, Watterott](https://learn.watterott.com/silentstepstick/faq/)
- [TMC2209, BIGTREETECH Wiki](https://global.bttwiki.com/TMC2209.html)
- [TMC2209 UART RMS Current Calculation, OpenAstroTech Wiki](https://wiki.openastrotech.com/Knowledge/UART_RMS_Calculation)
- [TMCStepper library source, teemuatlut](https://github.com/teemuatlut/TMCStepper)
- [TMC Drivers, Klipper documentation](https://www.klipper3d.org/TMC_Drivers.html)
- [Tuning stepper motor drivers, Duet3D](https://docs.duet3d.com/User_manual/Connecting_hardware/Motors_tuning)
- [DRV8825 Stepper Motor Driver Carrier High Current, Pololu](https://www.pololu.com/product/2133)
- [DRV8825 Datasheet, Texas Instruments](https://www.ti.com/lit/ds/symlink/drv8825.pdf)
- [DRV8825 missing microsteps, Power Cabristor](http://cabristor.blogspot.com/2015/02/drv8825-missing-steps.html)
- [DRV8825 Fast vs Mixed Decay Current Waveforms, Softsolder](https://softsolder.com/2019/08/26/drv8825-stepper-driver-fast-vs-mixed-decay-current-waveforms/)
- [Constant Current Drive Principle of Stepper Motor, StepperOnline](https://help.stepperonline.com/en/article/constant-current-drive-principle-of-stepper-motor-dmstaq)
- [How to Reduce Audible Noise in Stepper Motors (SLVAES8), Texas Instruments](https://www.ti.com/lit/pdf/slvaes8)
- [Stepper Motor Audible Noise FAQ, TI E2E](https://e2e.ti.com/support/motor-drivers-group/motor-drivers/f/motor-drivers-forum/967854/faq-stepper-motor-audible-noise)
- [VACTUAL register reference, tmc2209-uart crate](https://docs.rs/tmc2209-uart/latest/tmc2209_uart/registers/struct.Vactual.html)
- [Stepper Information, LinuxCNC](https://linuxcnc.org/docs/html/integrator/steppers.html)
- [Nema 17 17HS6401 / 42HS60 specs, HTA3D](https://www.hta3d.com/en/nema-17-stepper-motor-17hs6401-42hs60-42-60-5mm-d-shaft)
- [17HS6401S 0.9 degree variant, S3D Design](https://www.s3d.design/product-page/17hs6401s-0-9-degree-nema17-stepper-motor-hybrid-1-8a-70n-cm-60mm)
- [17HS2401 / 42BYGH40 listing](https://www.amazon.com/Torque-Stepper-42BYGH40-0-45N-M-17HS2401/dp/B0CK5BH9BP)
