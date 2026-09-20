/*
 * arm_controller_esp32.ino: Firmware kontrol lengan robot 6-DOF (ESP32)
 *
 * Skripsi: Rancang Bangun Robotic Arm 6-DOF 3D Printed dengan Mekanisme
 *          Position Feedback dan Interface Digital Twin Berbasis Web
 *
 * Arsitektur FIX (selaras studio/src/config/arm.js dan src/arm/config.py):
 *   Aktuator:
 *     - J1, J3, J4 : stepper 17HS2401 (NEMA17 40mm, 0.45 N.m, 1.7 A)
 *     - J2         : stepper 17HS6401S (NEMA17 60mm, 0.70 N.m, 2.0 A)
 *       Keempatnya via driver TMC2209 (step/dir; opsi UART).
 *     - J5..J6 : 2x servo MG996R direct drive (PWM standar 50 Hz).
 *     - Gripper: 1x servo MG90S (BUKAN DOF, tidak masuk angles[]).
 *
 *   KEADAAN PERANGKAT KERAS SEKARANG (11 Agu 2026):
 *     - Aktuator LENGKAP TERPASANG: empat driver TMC2209, satu per sendi
 *       stepper (J1..J4, alamat UART 0b00..0b11), plus ketiga servo J5, J6,
 *       dan gripper. Tidak ada lagi kanal driver yang dipakai bergantian dan
 *       tidak ada lagi kabel motor yang dicolok ulang: keempat sendi stepper
 *       bisa diperintah berbarengan.
 *     - AS5600 yang terpasang baru SATU, di J1. J2..J4 berjalan open-loop dan
 *       posisinya dilaporkan dari step counter, yaitu sudut perintah yang
 *       sedang dijalankan. Tidak ada angka yang dikarang seolah hasil ukur.
 *     - Wiper potensiometer ketiga servo SUDAH disolder ke ADS1115
 *       (SERVO_FEEDBACK 1), jadi sudut servo yang dilaporkan hasil UKUR,
 *       bukan sudut perintah. Lihat catatan batas tegangan di bawah.
 *     - HX711 sudah dilepas (USE_HX711 0). GPIO 36 bebas; GPIO 4 sekarang
 *       dipakai servo gripper (bekas HX711 SCK).
 *
 *   Position feedback (rancangan penuh, dicapai bertahap):
 *     - J1..J4 : AS5600 (absolut magnetik 12-bit) di OUTPUT sendi, via mux
 *                I2C TCA9548A (semua AS5600 ber-alamat sama 0x36).
 *     - J5..J6 + gripper : wiper potensiometer internal servo -> ADS1115
 *                (ADC eksternal 16-bit, 0x48, menumpang bus I2C yang sama
 *                dengan mux TCA9548A), kanal A0=J5, A1=J6, A2=gripper.
 *                SUDAH DIMIGRASI dari analogReadMilliVolts() GPIO 34/35;
 *                GPIO 34/35 kini bebas. Kalibrasi 2 titik mV -> derajat.
 *
 *   BATAS TEGANGAN ADS1115 (jangan dilanggar, chip rusak tanpa peringatan):
 *     ADS1115 di-supply 3.3 V dari ESP32 (terukur 3,294 V), jadi batas absolut
 *     tegangan input = VDD + 0,3 V = 3,6 V. Wiper pot servo mengambang di rail
 *     servo 5 V, dan pada sebagian MG996R wiper bisa melewati 3,3 V di ujung
 *     travel. Karena itu firmware memantau saturasi: pembacaan di atas
 *     ADS_SATURASI_MV dilaporkan sebagai `sat` di servo_read/diag, dan
 *     perkakas kalibrasi (tools/kalibrasi_servo.py) menghentikan sapuan
 *     seketika saat bendera itu naik. Kalau `sat` pernah naik, wiper WAJIB
 *     diberi voltage divider dulu (atau ADS1115 dipindah ke rail 5 V) sebelum
 *     sapuan diteruskan, karena di atas 3,6 V dioda clamp input yang menahan
 *     tegangan, bukan lagi ADC yang mengukur.
 *
 * BEDA UTAMA vs sketch Mega (arm_controller.ino, kini legacy):
 *   ESP32 HOST WebSocket server sendiri lewat WiFi -> web nyambung LANGSUNG ke
 *   ws://<ip-esp32>:81. Python bridge (src/arm/bridge.py) TIDAK diperlukan lagi
 *   untuk hardware ini (bridge tetap berguna untuk mode --simulate).
 *
 * Protokol WebSocket (JSON):
 *   dari web : {"cmd":"goto","angles":[a1..a6]}     sudut target derajat
 *              {"cmd":"estop"}                      hentikan semua gerak
 *              {"cmd":"resume"}                     lepas e-stop eksplisit
 *              {"cmd":"cal_get"}                    minta seluruh kalibrasi
 *              {"cmd":"cal_set", ...field...}       ubah kalibrasi (RAM saja)
 *              {"cmd":"cal_zero"}                   pose sekarang = 0, semua
 *                                                   stepper J1..J4 (servo TIDAK
 *                                                   ikut, harus diminta sendiri)
 *              {"cmd":"cal_zero","joint":n}         idem satu sendi, n=1..6.
 *                                                   Stepper ber-encoder: offset
 *                                                   AS5600. Stepper open-loop:
 *                                                   step counter. Servo J5/J6:
 *                                                   sumbu sudut digeser, servo
 *                                                   sendiri tidak bergerak.
 *                                                   Lihat handleCalZero().
 *              {"cmd":"cal_save"}                   simpan kalibrasi ke NVS
 *              {"cmd":"cal_reset"}                  kembali ke default + hapus NVS
 *              {"cmd":"diag"}                       snapshot diagnostik: magnet
 *                                                   AS5600 (MD/ML/MH+AGC+mag),
 *                                                   raw, StallGuard, load cell,
 *                                                   WiFi, status mux
 *              {"cmd":"i2c_scan"}                   pindai bus I2C utama + ke-8
 *                                                   kanal mux; memisahkan chip
 *                                                   mati dari chip yang salah
 *                                                   kanal
 *              {"cmd":"load_tare"}                  nol-kan load cell (RAM)
 *              {"cmd":"load_scale","grams":m}       kalibrasi skala load cell
 *                                                   dengan massa known m gram
 *   Perintah KALIBRASI SERVO (dipakai tools/kalibrasi_servo.py):
 *              {"cmd":"servo_us","servo":s,"us":n}  set lebar pulsa MENTAH,
 *                                                   melewati pemetaan sudut.
 *                                                   s = 0..2 (0=J5,1=J6,
 *                                                   2=gripper). Mode manual
 *                                                   ini menahan loop kendali
 *                                                   agar tidak menimpa pulsa.
 *              {"cmd":"servo_limp","servo":s}       HENTIKAN pulsa: servo lemas
 *                                                   dan bebas diputar tangan,
 *                                                   pot internal tetap terbaca.
 *                                                   Dipakai mencari ujung travel
 *                                                   tanpa menekan stop mekanis.
 *                                                   Menulis pulsa apa pun
 *                                                   menghidupkannya lagi.
 *              {"cmd":"servo_auto","servo":s}       lepas mode manual, kembali
 *                                                   ke pemetaan sudut biasa
 *                                                   (tanpa "servo" = semua)
 *              {"cmd":"servo_center"}               semua servo ke titik tengah
 *              {"cmd":"servo_read","n":k}           k kali oversample tiap
 *                                                   kanal ADS1115 -> mV, raw,
 *                                                   simpangan baku, bendera sat
 *              {"cmd":"gripper","deg":x}            gripper (bukan DOF). Torsi
 *                                                   dilepas OTOMATIS begitu
 *                                                   sampai, dan paling lama
 *                                                   3 detik kalau tidak pernah
 *                                                   sampai. Lihat AUTO-LEMAS.
 *              {"cmd":"grip_limits","min":a,"max":b} sempitkan rentang kerja
 *                                                   gripper: sudut, pulsa, dan
 *                                                   mV digeser bersama supaya
 *                                                   skala fisiknya tetap
 *              {"cmd":"servo_capture", ...}         burst sampling 860 SPS satu
 *                                                   kanal untuk step response
 *                                                   (kalibrasi KECEPATAN), lihat
 *                                                   handleServoCapture()
 *   ke web   : {"type":"feedback","angles":[a1..a6],"estop":b,"fault":[f1..f4],
 *                                                   "grip":g}
 *              {"type":"servo","ch":[{mv,raw,sd,sat}...]}    (balasan servo_read)
 *              {"type":"cap","i":n,"t":[..],"raw":[..]}      (potongan capture)
 *              {"type":"cap_end","n":N,"t_cmd":t,...}        (akhir capture)
 *              {"type":"cal", ...seluruh kalibrasi...}      (balasan cal_get)
 *              {"type":"diag", ...}                          (balasan diag)
 *              {"type":"ack","cmd":"...","ok":b,"msg":"..."} (balasan command)
 *   Field cal_set yang dikenali (semua opsional, divalidasi sebelum dipakai):
 *     enc_offset[4] enc_sign[4] ratio[4] joint_min[6] joint_max[6]
 *     speed accel kp deadband
 *     servo_us_min[3] servo_us_max[3] servo_us_center[3]
 *     servo_ang_min[3] servo_ang_max[3]
 *     servo_fb_mv_min[3] servo_fb_mv_max[3]
 *     (indeks servo: 0=J5, 1=J6, 2=gripper)
 *     tmc_ma[4] (100..1700 mA RMS)  tmc_microstep (1,2,4,...,256)
 *     tmc_spread (0=stealthChop, 1=spreadCycle)  tmc_hold (0..100 %)
 *   diag.drv[4] melaporkan balik kondisi tiap driver TMC2209: ms (microstep
 *   yang BENAR-BENAR aktif, dibaca dari CHOPCONF) + msok (cocok dengan
 *   tmc_microstep atau tidak), irun, cs (skala arus live), ma/macs (konversi
 *   ke mA), vref (bit I_scale_analog, true = pot VREF masih ikut mengali
 *   arus), ot/otpw (termal), s2g (coil short ke GND), ol (coil open / kabel
 *   lepas). msok=false = firmware dan chip beda pendapat soal microstep,
 *   jadi semua konversi step/derajat sedang meleset; kirim ulang cal_set
 *   tmc_microstep untuk sinkron paksa.
 *   (Offset/skala load cell di-set lewat load_tare/load_scale, bukan cal_set,
 *    dan ikut tersimpan saat cal_save.)
 *
 *   PRINSIP: firmware = EXECUTOR primitif + guardrail. Semua logika tingkat
 *   tinggi (sequencing kalibrasi, uji rasio, konversi gram->torsi, logging)
 *   hidup di studio (web). Yang tinggal di firmware hanya yang wajib real-time
 *   lokal: ramp step, koreksi closed-loop, e-stop, validasi & clamp input.
 *
 * Kalibrasi PERSISTEN: disimpan sebagai blob di NVS (Preferences, namespace
 * "armcal") dengan magic + versi. Boot: NVS valid -> pakai; tidak -> default.
 * cal_set hanya mengubah RAM; kirim cal_save untuk permanen.
 *
 * GUARDRAIL komunikasi & gerak (sistem hardware-software, jangan mudah tumbang):
 *   - Semua input goto divalidasi (numerik, finite) lalu di-clamp ke joint limit.
 *   - Encoder gagal baca berturut-turut -> joint itu FAULT: koreksi closed-loop
 *     dimatikan (fallback open-loop step counter), dilaporkan di feedback.fault.
 *   - Koreksi closed-loop hanya saat stepper idle + besaran koreksi di-clamp,
 *     supaya feedback lag saat bergerak tidak memicu overshoot/osilasi.
 *   - Boot: posisi stepper disinkronkan dari encoder absolut, dan target awal =
 *     posisi aktual -> lengan TIDAK menyentak ke 0 saat power-up.
 *   - I2C pakai timeout pendek -> bus macet tidak membekukan loop utama.
 *   - Task watchdog (enableLoopWDT) -> firmware hang = auto-reboot; EN_PIN di
 *     strapping pin GPIO5 menjamin driver OFF selama boot.
 *   - WiFi STA auto-reconnect + mDNS didaftarkan ulang saat dapat IP lagi.
 *   - E-stop: default masih dilepas oleh goto (kompatibel UI lama). Set
 *     ESTOP_AUTO_RESUME 0 agar wajib {"cmd":"resume"} eksplisit (lebih aman;
 *     aktifkan setelah UI punya tombol resume).
 *
 * Pembangkitan step: FastAccelStepper -> pulsa STEP dihasilkan peripheral
 * HARDWARE (RMT/MCPWM), bukan software di loop(). Jadi timing step KEBAL
 * terhadap jitter WiFi dan sanggup step rate tinggi yang rasio gearbox tuntut.
 *
 * Dependensi (Library Manager / PlatformIO):
 *   - WiFi, ESPmDNS, Wire, Preferences  (bawaan core ESP32)
 *   - WebSockets (Links2004 / arduinoWebSockets)
 *   - ArduinoJson (v6+)
 *   - FastAccelStepper
 *   - ESP32Servo
 *   - TMCStepper
 * Board acuan: ESP32 DevKit v1 (ESP32-WROOM-32).
 *
 * SCAFFOLD: kalibrasi pin, RATIO/MICROSTEP, arus TMC untuk hardware nyata.
 * Offset/sign encoder, joint limit, endpoint servo, ADC feedback servo kini
 * bisa di-set RUNTIME lewat protokol cal_* di atas (tak perlu re-flash).
 */

#include <WiFi.h>
#include <WiFiMulti.h>
#include <ESPmDNS.h>
#include <Wire.h>
#include <Preferences.h>
#include <WebSocketsServer.h>
#include <WebServer.h>
#include <ArduinoJson.h>
#include <FastAccelStepper.h>
#include <ESP32Servo.h>

// ======================= KONFIGURASI (SESUAIKAN) ==========================

// --- WiFi ---
// Kredensial TIDAK ditulis di sini (repo public!): salin wifi_secrets.h.example
// -> wifi_secrets.h lalu isi daftar preset WiFi + SSID/pass AP fallback.
// Urutan: coba SEMUA preset (WiFiMulti pilih sinyal terkuat). Gagal semua dalam
// WIFI_STA_TIMEOUT_MS -> fallback jadi Access Point (ws://192.168.4.1:81)
// sampai reboot, guardrail supaya ESP32 tidak pernah unreachable.
// WIFI_FORCE_AP 1 -> langsung AP tanpa coba STA (andal untuk demo/sidang).
#define WIFI_FORCE_AP 0
#define WIFI_STA_TIMEOUT_MS 25000
#if __has_include("wifi_secrets.h")
#include "wifi_secrets.h"
#include "webui.h"          // halaman kontrol bawaan yang di-serve di port 80
#else
#error "wifi_secrets.h tidak ada: salin wifi_secrets.h.example -> wifi_secrets.h lalu isi kredensial"
#endif
const char* MDNS_NAME = "armbot";   // -> ws://armbot.local:81 (mode STA)
const uint16_t WS_PORT = 81;
const uint16_t HTTP_PORT = 80;      // halaman kontrol bawaan, lihat webui.h

// --- Fitur opsional ---
#define SERVO_FEEDBACK 1    // 1 = baca wiper pot servo lewat ADS1115 (0x48) di
                            //     bus I2C bersama. Wiper sudah disolder
                            //     8 Agu 2026: A0=J5, A1=J6, A2=gripper.
                            // Sudah TIDAK memakai ADC1 internal ESP32, jadi
                            // erratum ADC1 vs GPIO36/39 (yang dulu merusak
                            // pembacaan HX711) tidak berlaku lagi di sini dan
                            // GPIO 34/35 kembali bebas.
#define USE_TMC_UART   1    // 1 = kontrol penuh TMC2209 via UART: arus, microstep,
                            //     stealthChop, StallGuard, diagnostik (butuh TMCStepper)
#define USE_HX711      0    // 1 = baca load cell via HX711 (bench uji torsi).
                            // Uji torsi sudah selesai dan modulnya dilepas.
                            // GPIO 36 (DT) bebas, TAPI GPIO 4 (SCK) sekarang
                            // sudah dipakai servo gripper. Menyalakan ini lagi
                            // tanpa memindah salah satu pin = dua peripheral
                            // menulis GPIO4 bersamaan. Dijaga #error di bawah.
#define ESTOP_AUTO_RESUME 0 // 0 = wajib {"cmd":"resume"} eksplisit (lebih aman;
                            //     tombol RESET di studio sudah mengirim resume)
                            // 1 = goto melepas e-stop (perilaku lama)

// --- Dimensi sistem ---
#define NUM_JOINTS  6
#define NUM_STEPPER 4      // J1..J4, satu sendi = satu driver TMC2209 sendiri
#define NUM_SERVO   3      // 0 = J5, 1 = J6, 2 = gripper (bukan DOF)
#define SERVO_GRIP  2      // indeks servo gripper di dalam array servo

/* ---------------------------------------------------------------------------
   SATU DRIVER PER SENDI (keadaan perangkat keras 11 Agu 2026)

   Keempat driver TMC2209 sudah terpasang, jadi tiap sendi stepper punya jalur
   STEP/DIR dan alamat UART sendiri:

       J1 -> STEP 13, DIR 27, alamat UART 0b00
       J2 -> STEP 14, DIR 33, alamat UART 0b01
       J3 -> STEP 25, DIR 32, alamat UART 0b10
       J4 -> STEP 26, DIR 23, alamat UART 0b11

   Sebelum ini papan cuma punya dua driver dan tiap kanal dipakai bergantian
   oleh dua sendi (kabel motor dicolok ulang, kepemilikan kanal diurus
   firmware). Seluruh mekanisme itu SUDAH DIBUANG, bukan sekadar dimatikan:
   indeks driver sekarang sama dengan indeks sendi, jadi tidak ada lagi
   pemeriksaan "sendi ini sedang memegang kanalnya atau tidak" yang harus
   dilewati tiap perintah gerak. Riwayatnya ada di git kalau perlu dibaca lagi.

   Konsekuensi yang perlu diingat: keempat sendi kini bisa bergerak berbarengan,
   jadi arus puncak rail motor adalah jumlah keempatnya, bukan dua.
   --------------------------------------------------------------------------- */

// --- Pin step/dir per SENDI (hindari GPIO 6-11 flash, 34-39 input-only) ---
// GPIO16/17 sengaja DIKOSONGKAN -> dicadangkan untuk Serial2 (TMC UART).
const uint8_t STEP_PIN[NUM_STEPPER] = {13, 14, 25, 26};
const uint8_t DIR_PIN[NUM_STEPPER]  = {27, 33, 32, 23};

// Encoder AS5600 yang BENAR-BENAR terpasang. Sisanya berjalan open-loop dan
// posisinya dilaporkan dari step counter (itu sudut perintah yang sedang
// dijalankan, bukan hasil ukur yang dikarang).
// 12 Agu 2026: J2 menyusul (kanal mux 1). J3 dan J4 masih kosong.
const bool ENC_ADA[NUM_STEPPER] = {true, true, false, false};

// --- I2C (AS5600 via mux TCA9548A) ---
#define I2C_SDA       21
#define I2C_SCL       22
#define TCA9548A_ADDR 0x70
#define AS5600_ADDR   0x36
#define I2C_TIMEOUT_MS 5   // bus macet tak boleh membekukan loop (guardrail)

const uint8_t EN_PIN = 5;   // ENABLE bersama TMC (active-LOW: LOW=enable, HIGH=disable)
                            // GPIO5 = strapping pin -> HIGH saat boot = driver
                            // OFF sampai firmware siap (aman, motor tak liar).

// --- Channel mux TCA9548A tiap AS5600 (J1..J4) ---
// J2 duduk di kanal 3, BUKAN kanal 1 seperti rancangan awal. Kanal 1 tidak
// pernah meng-ACK (dibuktikan i2c_scan 12 Agu 2026, dengan modul lama maupun
// sesudah GND dibetulkan), lalu modul diganti dan dipindah ke kanal 3 dan
// langsung menjawab. Belum terpisah apakah yang rusak modul lamanya atau pin
// SD1/SC1 mux itu sendiri.
// J2 dan J4 karena itu BERTUKAR kanal, bukan sekadar J2 pindah: dua sendi tidak
// boleh menunjuk kanal yang sama, sebab diag membaca ENC_CHANNEL[] tanpa peduli
// ENC_ADA[], sehingga kanal kembar membuat dua sendi melaporkan satu chip yang
// sama seolah dua pengukuran bebas.
// PERINGATAN untuk pemasangan encoder J4 nanti: kanal 1 masih tersangka.
// Jalankan {"cmd":"i2c_scan"} dulu dan pastikan 0x36 benar-benar muncul di
// kanal 1 sebelum angka J4 dipercaya.
const uint8_t ENC_CHANNEL[NUM_STEPPER] = {0, 3, 2, 1};

// --- Reduksi & microstep stepper (dari studio/src/config/arm.js JDEF) ---
// Drivetrain FINAL: J1 belt HTD3M 2 stage 1:15, J2 cycloidal 1:30,
// J3 belt 3:1 + cycloidal 1:10 = 1:30, J4 cycloidal 1:15 (TENTATIVE).
// RATIO[] hanya DEFAULT kalibrasi, nilai aktif ada di cal.ratio dan bisa
// diubah runtime via cal_set "ratio" (bench: ganti pulley 15:1 <-> cycloidal
// 30:1 tanpa re-flash).
// PENTING: unit yang sudah pernah menyimpan kalibrasi di NVS TIDAK ikut
// berubah hanya karena di-flash ulang, cal.ratio lama tetap dipakai.
// Set lewat tab CAL studio (cal_set "ratio") atau hapus blob NVS dulu.
const float RATIO[NUM_STEPPER] = {15, 30, 30, 15};
// MICROSTEP hanya DEFAULT kalibrasi, nilai aktif ada di cal.tmcMicrostep dan
// bisa diubah runtime via cal_set "tmc_microstep" (butuh USE_TMC_UART).
const uint16_t MICROSTEP = 16;
float STEPS_PER_DEG[NUM_STEPPER];   // diisi recomputeStepsPerDeg() dari cal.ratio

// --- Default driver TMC2209 (nilai aktif di cal.tmc*, lihat docs/research/
//     driver-stepper-tmc2209-vs-drv8825.md) ---
// Arus RMS per driver, ~60% dari rating fasa datasheet:
//   J1/J3/J4 = 17HS2401, rated 1.7 A/fasa -> 1000 mA
//   J2       = 17HS6401S, rated 2.0 A/fasa -> 1200 mA
// J4 naik 400 -> 1000 mA karena motornya berganti dari 17PM-K054 (Minebea
// kecil) ke 17HS2401; 400 mA akan membuat J4 kehilangan sebagian besar torsi.
// PERINGATAN TERMAL: di atas 1000 mA RMS, TMC2209 WAJIB heatsink besar +
// aliran udara. Tanpa itu turunkan ke 900 dan kompensasi lewat rasio reduksi.
const uint16_t TMC_MA_DEFAULT[NUM_STEPPER] = {1000, 1200, 1000, 1000};
// spreadCycle (1) sebagai default, BUKAN stealthChop. Lengan bergerak lambat
// dan berbeban: torsi + akurasi posisi lebih berharga daripada senyap, dan
// spreadCycle tidak butuh autotune sama sekali. stealthChop hanya dipakai
// kalau StallGuard diaktifkan (SG4 praktis cuma jalan di stealthChop).
const uint8_t  TMC_SPREAD_DEFAULT   = 1;
const uint8_t  TMC_HOLD_PCT_DEFAULT = 40;   // arus tahan 40% dari arus jalan

// --- Guardrail closed-loop ---
const int   ENC_FAULT_LIMIT = 25;    // gagal baca berturut-turut -> joint FAULT
const float CORR_MAX_DEG    = 5.0;   // clamp besaran koreksi per update (derajat)
// Joint yang sudah FAULT tidak di-poll tiap siklus lagi. Satu transaksi I2C
// yang gagal memakan waktu bus DAN memuntahkan satu baris error Wire.cpp;
// dengan 3 joint tanpa encoder itu ~375 baris/detik, cukup untuk menenggelamkan
// log pengukuran dan mencuri waktu loop dari joint yang encodernya sehat.
// Percobaan ulang tiap 2 s masih cukup cepat mendeteksi kabel yang dicolok
// balik di tengah sesi.
const uint32_t ENC_RETRY_MS = 2000;

// --- Servo J5, J6, gripper ---
// GPIO4 (gripper) bekas HX711 SCK. Bukan strapping pin dan bebas dipakai
// sebagai output, tapi saat boot ia mengambang sampai LEDC menyalakan pulsa.
// Servo yang tidak menerima pulsa valid TIDAK bergerak (dia diam tanpa torsi),
// jadi mengambang sesaat aman; setup() tetap menariknya LOW lebih dulu supaya
// tidak ada pulsa acak dari kapasitansi jalur.
#define SERVO_PIN_J5    18
#define SERVO_PIN_J6    19
#define SERVO_PIN_GRIP  4
const uint8_t SERVO_PIN[NUM_SERVO] = {SERVO_PIN_J5, SERVO_PIN_J6, SERVO_PIN_GRIP};

// Sendi yang dilayani tiap servo (indeks 0-based ke targetDeg[]).
// -1 = bukan sendi: gripper tidak masuk angles[] dan tidak punya joint limit.
const int8_t SERVO_JOINT[NUM_SERVO] = {4, 5, -1};
const char* const SERVO_NAMA[NUM_SERVO] = {"J5", "J6", "GRIP"};

#if USE_HX711
// --- HX711 load cell (bench uji torsi) ---
// DT = GPIO36 (input-only, bebas; HX711 men-drive push-pull jadi tak butuh
// pull-up, GPIO 34-39 memang tak punya). SCK = GPIO4 (bebas, bukan strapping).
// Firmware hanya lapor counts + gram; konversi gram->torsi (x lengan tuas)
// dilakukan di studio.
#define HX711_DT   36
#define HX711_SCK  4
// Bekas pin HX711 sudah dipakai lagi: GPIO4 kini jalur pulsa servo gripper.
// Tanpa penjaga ini, keduanya menulis pin yang sama dan gejalanya menyesatkan
// (gripper kedutan tiap pembacaan load cell, berat ngawur tiap gripper gerak).
#if HX711_SCK == SERVO_PIN_GRIP
#error "HX711 SCK dan servo gripper sama-sama di GPIO4: pindahkan salah satu dulu"
#endif
#endif

#if SERVO_FEEDBACK
// --- ADS1115: ADC eksternal 16-bit untuk wiper pot servo ---
// Duduk di bus I2C yang SAMA dengan mux TCA9548A (0x70), bukan di belakang
// salah satu kanal mux. Alamat beda (0x48 vs 0x70) jadi tidak bentrok.
#define ADS_ADDR        0x48
#define ADS_REG_CONV    0x00
#define ADS_REG_CONFIG  0x01

// Kanal single-ended AINx yang dipakai tiap servo (A0=J5, A1=J6, A2=gripper).
const uint8_t SERVO_FB_CH[NUM_SERVO] = {0, 1, 2};

// PGA +-4,096 V -> 1 LSB = 4096/32768 = 0,125 mV. Dipilih (bukan +-2,048 V)
// karena wiper servo bisa melewati 2 V, dan bukan +-6,144 V karena resolusinya
// separuh tanpa manfaat: input fisik tetap tidak boleh lewat VDD+0,3 = 3,6 V.
#define ADS_PGA_BITS    0x0200        // bit 11:9 = 001, +-4.096 V
#define ADS_MV_PER_LSB  0.125f

// Laju konversi. 128 SPS (bit 100) untuk pembacaan biasa: 7,8 ms/konversi,
// derau paling rendah. 860 SPS (bit 111) hanya saat servo_capture, supaya
// step response servo (orde 200-500 ms) terekam cukup rapat.
#define ADS_DR_128      0x0080
#define ADS_DR_860      0x00E0
#define ADS_CONV_MS_128 10            // 7,8 ms + margin
#define ADS_MODE_SINGLE 0x0100        // bit 8 = 1, single-shot
#define ADS_OS_START    0x8000        // bit 15 = 1, mulai konversi
#define ADS_COMP_OFF    0x0003        // comparator dimatikan

// Ambang saturasi. ADS1115 di-supply 3,3 V, jadi apa pun di atas ini berarti
// wiper sudah mendekati batas absolut input (VDD+0,3 = 3,6 V) dan yang menahan
// tegangan mulai dioda clamp, bukan ADC. Angkanya = 3,15 V: masih 450 mV di
// bawah batas, cukup jauh untuk memberi waktu sapuan berhenti.
#define ADS_SATURASI_MV 3150

// Berapa lama satu joint dianggap kehilangan ADS1115 sebelum jatuh ke sudut
// perintah (mirip guardrail encoder: bus lepas != angka karangan).
const uint8_t ADS_FAULT_LIMIT = 10;
#endif

// ======================= KALIBRASI (RUNTIME + NVS) ========================
// Semua parameter yang dulunya konstanta compile-time dan butuh tuning di
// hardware nyata sekarang hidup di struct ini: bisa diubah via WebSocket
// (cal_set / cal_zero), disimpan permanen via cal_save (NVS "armcal").

#define CAL_MAGIC   0xCA11B007u
#define CAL_VERSION 4   // v2: + ratio[4] (bench: ganti reducer tanpa re-flash)
                        //     + loadOffset/loadScale (kalibrasi HX711)
                        // v3: + tmcMa[4]/tmcMicrostep/tmcSpread/tmcHoldPct
                        //     (arus & mode chopper dari studio, tanpa re-flash)
                        // v4: NUM_SERVO 2 -> 3 (gripper MG90S) sehingga SEMUA
                        //     array servo berubah panjang, + servoUsCenter[3]
                        //     (titik tengah hasil kalibrasi = pose default).
                        //     Wajib naik: blob v3 punya array servo 2 elemen,
                        //     dibaca sebagai v4 akan menggeser seluruh field
                        //     sesudahnya (ratio, arus TMC) tanpa gejala jelas.
                        // NAIKKAN versi tiap kali layout struct berubah: blob
                        // NVS lama otomatis ditolak calLoad() -> pakai default,
                        // jadi tidak ada pembacaan sampah lintas versi.

struct Calibration {
  uint32_t magic;
  uint16_t version;
  // Encoder AS5600: actual = sign * wrap180(raw - offset). Set via cal_zero.
  float  encOffsetDeg[NUM_STEPPER];
  int8_t encSign[NUM_STEPPER];
  // Batas sudut tiap sendi (derajat, sisi OUTPUT). Default = JDEF studio.
  float  jointMin[NUM_JOINTS];
  float  jointMax[NUM_JOINTS];
  // Batas gerak & gain closed-loop.
  float  maxSpeedDps;    // kecepatan maks (derajat/detik)
  float  maxAccelDpss;   // akselerasi maks (derajat/detik^2)
  float  kp;             // gain koreksi closed-loop (P)
  float  deadbandDeg;    // toleransi sebelum koreksi
  // Pemetaan servo: sudut sendi (deg) -> lebar pulsa (us). MG996R ~0..180 fisik.
  float   servoAngMin[NUM_SERVO];
  float   servoAngMax[NUM_SERVO];
  int16_t servoUsMin[NUM_SERVO];
  int16_t servoUsMax[NUM_SERVO];
  // Titik tengah travel hasil kalibrasi sapuan, dalam us. Ini pose default
  // saat boot dan tujuan servo_center. Disimpan TERPISAH dari (min+max)/2
  // karena travel servo tidak selalu simetris terhadap pulsa: yang dipakai
  // harus titik yang benar-benar terukur, bukan rata-rata dua ujung.
  int16_t servoUsCenter[NUM_SERVO];
  // Kalibrasi 2 titik ADC feedback servo (mV di ANG_MIN & ANG_MAX). Dipakai
  // hanya bila SERVO_FEEDBACK 1; tetap disimpan agar layout blob stabil.
  int16_t servoFbMvMin[NUM_SERVO];
  int16_t servoFbMvMax[NUM_SERVO];
  // Reduksi tiap joint stepper, runtime supaya bench bisa ganti reducer tanpa
  // re-flash. Perubahan men-trigger recompute STEPS_PER_DEG + re-sync step
  // counter dari sudut aktual (lihat handleCalSet).
  float ratio[NUM_STEPPER];
  // Load cell HX711: gram = (raw - loadOffset) / loadScale.
  // loadScale 0 = belum dikalibrasi (isi via load_tare + load_scale).
  float loadOffset;
  float loadScale;
  // Driver TMC2209, runtime supaya arus & karakter chopper bisa dicari dari
  // studio tanpa re-flash. Hanya dipakai bila USE_TMC_UART 1; tetap disimpan
  // agar layout blob stabil.
  uint16_t tmcMa[NUM_STEPPER];   // arus RMS per driver (mA)
  uint16_t tmcMicrostep;         // 1,2,4,...,256 (1 = full step)
  uint8_t  tmcSpread;            // 0 = stealthChop (senyap), 1 = spreadCycle
  uint8_t  tmcHoldPct;           // arus tahan = tmcHoldPct% dari arus jalan
};

Calibration cal;
Preferences prefs;

void calDefaults() {
  cal.magic   = CAL_MAGIC;
  cal.version = CAL_VERSION;
  for (int i = 0; i < NUM_STEPPER; i++) { cal.encOffsetDeg[i] = 0; cal.encSign[i] = 1; }
  // Selaras studio/src/config/arm.js JDEF (J1..J6).
  // J2 = +-90 dari pose home (tegak atas), diukur pada lengan terakit
  // 12 Agu 2026; sebelumnya +-95 yang cuma angka rancangan.
  const float jmin[NUM_JOINTS] = {-180, -90, -150, -180, -120, -180};
  const float jmax[NUM_JOINTS] = { 180,  90,  150,  180,  120,  180};
  for (int j = 0; j < NUM_JOINTS; j++) { cal.jointMin[j] = jmin[j]; cal.jointMax[j] = jmax[j]; }
  cal.maxSpeedDps  = 60.0f;
  cal.maxAccelDpss = 120.0f;
  cal.kp           = 0.4f;
  cal.deadbandDeg  = 0.3f;
  // Rentang sudut J5/J6 mengikuti JDEF studio; gripper dinyatakan 0..90 derajat
  // (0 = menutup, 90 = membuka) dan BUKAN sendi, jadi tidak ada di angles[].
  const float amin[NUM_SERVO] = {-120, -180, 0}, amax[NUM_SERVO] = {120, 180, 90};
  for (int s = 0; s < NUM_SERVO; s++) {
    cal.servoAngMin[s] = amin[s]; cal.servoAngMax[s] = amax[s];
    // 500..2500 us = rentang PENUH standar servo hobi, sengaja dipakai sebagai
    // nilai awal supaya sapuan kalibrasi punya ruang mencari ujung sebenarnya.
    // Nilai ini BUKAN hasil ukur; kalibrasi sapuan yang menggantinya.
    cal.servoUsMin[s]  = 500;     cal.servoUsMax[s]  = 2500;
    cal.servoUsCenter[s] = 1500;  // netral standar, diganti hasil kalibrasi
    // 1000/2000 mV masih PLACEHOLDER (bukan hasil ukur). Sudut servo yang
    // dilaporkan sebelum kalibrasi sapuan karena itu belum boleh dipercaya.
    cal.servoFbMvMin[s] = 1000;   cal.servoFbMvMax[s] = 2000;
  }
  for (int i = 0; i < NUM_STEPPER; i++) cal.ratio[i] = RATIO[i];
  cal.loadOffset = 0;
  cal.loadScale  = 0;   // 0 = belum dikalibrasi
  for (int i = 0; i < NUM_STEPPER; i++) cal.tmcMa[i] = TMC_MA_DEFAULT[i];
  cal.tmcMicrostep = MICROSTEP;
  cal.tmcSpread    = TMC_SPREAD_DEFAULT;
  cal.tmcHoldPct   = TMC_HOLD_PCT_DEFAULT;
}

// true bila blob NVS valid (magic + versi + ukuran cocok).
bool calLoad() {
  prefs.begin("armcal", true);
  Calibration tmp;
  size_t n = prefs.getBytes("cal", &tmp, sizeof(tmp));
  prefs.end();
  if (n != sizeof(tmp) || tmp.magic != CAL_MAGIC || tmp.version != CAL_VERSION) return false;
  cal = tmp;
  return true;
}

bool calSave() {
  prefs.begin("armcal", false);
  size_t n = prefs.putBytes("cal", &cal, sizeof(cal));
  prefs.end();
  return n == sizeof(cal);
}

void calErase() {
  prefs.begin("armcal", false);
  prefs.clear();
  prefs.end();
}

// STEPS_PER_DEG dari cal.ratio (bukan RATIO[] compile-time). Panggil setelah
// kalibrasi dimuat dan tiap field ratio berubah.
// Catatan: 200 = full-step/putaran motor 1.8 derajat. Kalau suatu saat dipakai
// motor 0.9 derajat (mis. varian 17HS6401S-09), angka ini jadi 400 dan SEMUA
// sudut sendi meleset tepat 2x kalau lupa diubah.
void recomputeStepsPerDeg() {
  float ms = (float)(cal.tmcMicrostep < 1 ? 1 : cal.tmcMicrostep);
  for (int i = 0; i < NUM_STEPPER; i++)
    STEPS_PER_DEG[i] = (200.0f * ms * cal.ratio[i]) / 360.0f;
}

// ======================= STATE GLOBAL =====================================

FastAccelStepperEngine engine = FastAccelStepperEngine();
// Satu objek stepper per sendi, masing-masing terikat ke pin STEP/DIR sendiri.
FastAccelStepper* steppers[NUM_STEPPER] = {nullptr};
Servo servos[NUM_SERVO];
WebSocketsServer webSocket(WS_PORT);
WebServer http(HTTP_PORT);

// Gripper bukan sendi: targetnya hidup sendiri, di luar targetDeg[NUM_JOINTS].
float gripTargetDeg = 0;
float gripActualDeg = 0;

/* Mode manual per servo (dipakai kalibrasi).
   Selama servoManual[s] true, loop kendali TIDAK menulis pulsa servo s, jadi
   lebar pulsa yang di-set servo_us bertahan apa adanya. Tanpa ini, tiap putaran
   loop akan langsung menimpanya dengan hasil pemetaan sudut dan sapuan
   kalibrasi tidak akan pernah bergerak dari titik target lamanya. */
bool    servoManual[NUM_SERVO] = {false};
int16_t servoUsNow[NUM_SERVO]  = {0};   // pulsa terakhir yang benar-benar ditulis

/* Servo LEMAS: pulsa dihentikan sama sekali (kanal LEDC di-detach), bukan
   sekadar ditahan di satu nilai. Servo hobi yang tidak menerima pulsa valid
   melepas torsinya dan bebas diputar tangan.

   Kenapa perlu: mencari ujung travel dengan MENGGERAKKAN servo berarti
   menekan stop mekanis rahang sampai ketemu, dan MG90S tidak melaporkan
   kegagalan, dia cuma menekan terus lalu panas dan gigi plastiknya aus.
   Dengan lemas, tangan yang menggerakkan dan servo cuma jadi sensor.

   Potensiometer internal tetap terbaca selama servo masih dapat 5 V, karena
   dia pembagi tegangan pasif yang tidak butuh pulsa. Jadi readServoAngle()
   tetap melaporkan posisi sebenarnya sepanjang sesi ini. */
bool    servoLimp[NUM_SERVO] = {false};

/* ---------------------------------------------------------------------------
   AUTO-LEMAS GRIPPER (perilaku default, bukan opsi)

   Rahang gripper seret dan torsi MG90S kecil, jadi menahan pulsa terus menerus
   adalah cara tercepat membakarnya: servo yang tidak sampai ke target akan
   mendorong tanpa henti, panas, lalu giginya aus. Karena itu perintah gripper
   TIDAK PERNAH menahan tanpa batas.

   Aturannya tidak melihat arah buka atau tutup, melainkan apakah rahang SAMPAI:

     sampai target      -> torsi dilepas setelah GRIP_SETTLE_MS.
                           Ini kasus membuka: rahang bergerak bebas, sampai,
                           lalu dibiarkan lemas. Tidak ada alasan menahan.
     tidak pernah sampai -> ditahan paling lama GRIP_HOLD_MAX_MS lalu dilepas.
                           Ini kasus mencengkeram benda (rahang berhenti lebih
                           awal karena ada yang dipegang) dan juga kasus titik
                           macet. Keduanya butuh perlakuan sama: beri torsi
                           secukupnya, lalu berhenti sebelum servo panas.

   Efeknya: berapa pun perintahnya, servo gripper tidak pernah dialiri lebih
   dari GRIP_HOLD_MAX_MS. Yang menahan benda setelah itu adalah gesekan
   mekanismenya sendiri, yang justru seret.

   Jalur servo_us TIDAK ikut aturan ini: itu jalur kalibrasi manual yang memang
   perlu pulsa bertahan (dipakai tools/kalibrasi_servo.py). */
#define GRIP_TOL_DEG     2.0f    // selisih yang sudah dianggap sampai
#define GRIP_SETTLE_MS   150     // harus bertahan di toleransi selama ini
#define GRIP_HOLD_MAX_MS 3000    // batas mutlak torsi ke servo gripper

bool     gripDriving  = false;   // gripper sedang sengaja diberi pulsa
uint32_t gripDriveT0  = 0;       // kapan perintah gripper terakhir masuk
uint32_t gripArriveT0 = 0;       // kapan mulai masuk toleransi (0 = belum)

// Hasil test_connection() tiap driver saat boot (0 = menjawab). Disimpan supaya
// halaman kontrol bisa menampilkan driver mana yang benar-benar hidup, bukan
// memberi kesan keempat sendi siap padahal sebagian busnya bisu.
uint8_t tmcConn[NUM_STEPPER] = {2, 2, 2, 2};

/* ---- Driver kehilangan VM = seluruh setelannya hilang, dan firmware tidak
   punya cara tahu tanpa bertanya ---------------------------------------------

   TMC2209 mengambil supply logika internalnya (5VOUT) dari VM. ESP32 hidup
   sendiri dari USB, jadi rail 12 V bisa mati berjam-jam sementara firmware
   terus jalan seolah tidak terjadi apa-apa. Begitu VM kembali chip melakukan
   power-on reset dan SELURUH register balik ke default pabrik:
   I_scale_analog menyala lagi (pot VREF ikut mengali arus), IHOLD_IRUN kembali
   ke default, mstep_reg_select mati sehingga microstep diambil dari pin MS1/MS2
   dan bukan lagi dari cal.tmcMicrostep.

   Yang terjadi sesudah itu tidak kelihatan sebagai error di mana pun: firmware
   mengirim jumlah pulsa untuk microstep yang diyakininya, chip menempuh jarak
   yang lain, encoder melaporkan galat yang tidak pernah menutup, dan cabang
   koreksi di loop() menembak nudge terus menerus. Empat motor menarik arus
   penuh tanpa henti sambil lengan tampak "sedang homing". Terukur 13 Agu 2026:
   2 A pada rail yang biasanya 400 mA, tanpa satu pun pesan di layar.

   Karena itu kesehatan driver diperiksa BERKALA, bukan sekali saat boot, dan
   EN_PIN digerbangi hasilnya. Selama driver belum terbukti terkonfigurasi,
   tahap outputnya tetap mati: PSU yang belum dinyalakan jadi kondisi yang
   kelihatan dan aman, bukan lengan yang diam-diam salah skala. */
bool     tmcDown      = false;   // driver belum terbukti sesuai konfigurasi
uint16_t tmcResetSeen = 0;       // berapa kali pemulihan driver dijalankan

/* ---- Dead-man: tidak ada klien = tidak ada yang menonton ------------------
   Sampai 13 Agu 2026 putusnya klien terakhir cuma dicetak ke Serial, jadi
   studio yang mati, ter-refresh, atau ditutup di tengah gerak besar
   meninggalkan lengan menuntaskan target terakhirnya tanpa penonton. Sesudah
   grace period, gerak dihentikan dengan ramp dan target dibekukan di posisi
   nyata. Baru dilepas saat ada klien lagi, bersama sinkronisasi encoder.

   Grace period sengaja lebih panjang dari satu siklus reconnect studio (~2 dtk)
   supaya me-refresh halaman tidak dihitung sebagai operator yang pergi. */
#define WS_DEADMAN_MS 4000
bool     wsFreeze     = false;   // gerak dibekukan karena tidak ada klien
bool     wsEverConn   = false;   // pernah ada klien (dead-man baru aktif sesudah ini)
uint32_t wsEmptySince = 0;       // sejak kapan tidak ada klien (0 = ada)

float targetDeg[NUM_JOINTS] = {0};   // target semua sendi (J1..J6)
float actualDeg[NUM_JOINTS] = {0};   // aktual dari feedback
bool  estop = false;
unsigned long lastFeedback = 0;

// Guardrail encoder: hitung gagal-baca berturut-turut per joint stepper.
// >= ENC_FAULT_LIMIT -> encFault, koreksi closed-loop off (fallback step counter).
uint8_t  encFailCount[NUM_STEPPER] = {0};
bool     encFault[NUM_STEPPER]     = {false};
uint32_t encNextRetry[NUM_STEPPER] = {0};   // millis() percobaan ulang saat FAULT

// Guardrail magnet. AS5600 tanpa magnet TETAP meng-ACK dan TETAP mengeluarkan
// RAW ANGLE, hanya saja angkanya mengambang dan bukan sudut apa pun. Gagal-baca
// I2C di atas tidak menangkapnya, jadi tanpa pemeriksaan ini sebuah encoder
// tanpa magnet lolos ke loop kendali sebagai sudut yang sah dan sendinya
// mengejar derau. Terbukti 12 Agu 2026: J2 dilaporkan -43 deg, fault=0, magnet
// belum terpasang sama sekali.
// Yang diperiksa hanya bit MD (magnet terdeteksi), BUKAN ML. Magnet J1 memang
// melapor ML=1 (medan lemah, AGC mentok) tetapi tetap terpakai dan sudah
// terkalibrasi, jadi menolak ML akan mematikan sendi yang sehat.
const uint32_t ENC_MD_PERIOD_MS = 250;  // pemeriksaan berkala, bukan tiap siklus
bool     encMagnetOk[NUM_STEPPER] = {false};
uint32_t encMdNext[NUM_STEPPER]   = {0};

// Mux TCA9548A terdeteksi saat boot? false = mode bench "AS5600 tunggal":
// encoder langsung di bus, hanya J1 (channel 0) dianggap ber-encoder.
bool muxPresent = false;

// WiFi: WiFiMulti mencoba semua preset; runningAsAP = sedang jadi Access Point
// (WIFI_FORCE_AP atau fallback karena semua preset gagal) sampai reboot.
WiFiMulti wifiMulti;
bool runningAsAP = false;
unsigned long lastWifiRetry = 0;

#if USE_HX711
// Load cell: sampel HX711 terakhir (~10 Hz). loadOk turun bila >500 ms tanpa
// data ready (kabel lepas / HX711 tak terpasang / DT floating).
long loadRaw = 0;
bool loadOk  = false;
unsigned long loadLastReady = 0;
#endif

// ======================= UTILITAS =========================================

// Bungkus sudut ke rentang [-180, 180].
static float wrap180(float deg) {
  while (deg > 180.0f)  deg -= 360.0f;
  while (deg < -180.0f) deg += 360.0f;
  return deg;
}

static float clampf(float v, float lo, float hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

// ======================= ENCODER (AS5600) =================================

void tcaSelect(uint8_t ch) {
  if (!muxPresent) return;   // bench tanpa mux: AS5600 langsung di bus
  Wire.beginTransmission(TCA9548A_ADDR);
  Wire.write(1 << ch);
  Wire.endTransmission();
}

// Sudut mentah AS5600 (0..360 derajat) pada channel mux tertentu, NAN bila gagal.
float readAS5600Raw(uint8_t channel) {
  // Guardrail bench: tanpa mux semua channel menunjuk chip yang sama, jadi
  // hanya channel 0 (J1) yang diaku valid, sisanya langsung NAN (fault ->
  // open-loop), daripada 4 joint diam-diam "membaca" satu encoder.
  if (!muxPresent && channel != ENC_CHANNEL[0]) return NAN;
  tcaSelect(channel);
  Wire.beginTransmission(AS5600_ADDR);
  Wire.write(0x0C);  // register RAW ANGLE (high byte)
  if (Wire.endTransmission(false) != 0) return NAN;
  Wire.requestFrom(AS5600_ADDR, (uint8_t)2);
  if (Wire.available() < 2) return NAN;
  uint16_t raw = (Wire.read() << 8) | Wire.read();
  return (raw & 0x0FFF) * 360.0f / 4096.0f;
}

// Register 8-bit / 12-bit AS5600 pada channel yang SEDANG terpilih (panggil
// tcaSelect dulu); -1 bila gagal. Dipakai diag: STATUS 0x0B (bit5 MD=magnet
// terdeteksi, bit4 ML=terlalu lemah/jauh, bit3 MH=terlalu kuat/dekat),
// AGC 0x1A, MAGNITUDE 0x1B.
int readAS5600Reg(uint8_t reg, bool word) {
  Wire.beginTransmission(AS5600_ADDR);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return -1;
  uint8_t n = word ? 2 : 1;
  Wire.requestFrom(AS5600_ADDR, n);
  if (Wire.available() < n) return -1;
  int v = Wire.read();
  if (word) v = ((v << 8) | Wire.read()) & 0x0FFF;
  return v;
}

// Sudut OUTPUT sendi stepper (derajat), sudah dikoreksi offset & arah.
// Sekalian memelihara counter fault (guardrail encoder mati/copot).
float readStepperEncoder(int s) {
  // Sendi yang encodernya memang BELUM terpasang bukan kegagalan: tidak ada
  // yang perlu dicoba, tidak ada yang perlu dihitung sebagai fault, dan
  // posisinya nanti diambil dari step counter di loop kendali.
  if (!ENC_ADA[s]) return NAN;
  // Sudah FAULT: lewati bus sama sekali sampai jadwal coba-ulang. Selisih
  // dihitung bertanda supaya tetap benar saat millis() melewati batas 32 bit.
  if (encFault[s]) {
    if ((int32_t)(millis() - encNextRetry[s]) < 0) return NAN;
    encNextRetry[s] = millis() + ENC_RETRY_MS;
    encMdNext[s] = millis();   // saat coba-ulang, magnet diperiksa lagi SEKARANG
  }
  float raw = readAS5600Raw(ENC_CHANNEL[s]);
  if (isnan(raw)) {
    if (encFailCount[s] < 255) encFailCount[s]++;
    if (encFailCount[s] >= ENC_FAULT_LIMIT && !encFault[s]) {
      encFault[s] = true;
      Serial.printf("[ENC] J%d FAULT: %d gagal baca beruntun -> open-loop\n",
                    s + 1, ENC_FAULT_LIMIT);
    }
    return NAN;
  }
  // Magnet masih di tempat? Kanalnya sudah dipilih readAS5600Raw() barusan,
  // jadi STATUS bisa dibaca langsung. Berkala saja: satu byte tiap 250 ms per
  // sendi, cukup cepat menangkap magnet yang copot tetapi tidak menambah beban
  // bus di tiap siklus loop kendali.
  if ((int32_t)(millis() - encMdNext[s]) >= 0) {
    encMdNext[s] = millis() + ENC_MD_PERIOD_MS;
    int st = readAS5600Reg(0x0B, false);
    encMagnetOk[s] = (st >= 0) && (st & 0x20);   // bit5 MD
  }
  if (!encMagnetOk[s]) {
    // Beda dari gagal-baca: langsung FAULT tanpa menunggu ENC_FAULT_LIMIT.
    // Tidak ada gunanya menoleransi 25 kali berturut-turut, sebab chipnya
    // menjawab dengan sempurna dan yang hilang justru sumber sudutnya.
    if (!encFault[s]) {
      encFault[s] = true;
      encNextRetry[s] = millis() + ENC_RETRY_MS;
      Serial.printf("[ENC] J%d MAGNET TIDAK TERDETEKSI (MD=0) -> open-loop\n",
                    s + 1);
    }
    return NAN;
  }
  if (encFault[s]) Serial.printf("[ENC] J%d pulih, closed-loop lagi\n", s + 1);
  encFailCount[s] = 0;
  encFault[s] = false;
  return cal.encSign[s] * wrap180(raw - cal.encOffsetDeg[s]);
}

// ======================= SERVO ============================================

int servoAngleToUs(int s, float deg) {
  float span = cal.servoAngMax[s] - cal.servoAngMin[s];
  if (span <= 0.0f) return 1500;  // kalibrasi rusak -> netral (guardrail div/0)
  deg = clampf(deg, cal.servoAngMin[s], cal.servoAngMax[s]);
  float t = (deg - cal.servoAngMin[s]) / span;
  return (int)(cal.servoUsMin[s] + t * (cal.servoUsMax[s] - cal.servoUsMin[s]));
}

// Tulis pulsa ke servo lewat satu pintu, supaya servoUsNow[] selalu mencerminkan
// apa yang benar-benar keluar dari LEDC (dipakai laporan diag & kalibrasi).
void servoWriteUs(int s, int us) {
  us = (int)clampf((float)us, 400.0f, 2600.0f);   // guardrail: di luar ini
                                                  // servo hobi bisa membentur
                                                  // stop internal & stall
  // Menulis pulsa ke servo yang sedang lemas otomatis menghidupkannya lagi.
  // detach() melepas kanal LEDC, jadi wajib attach ulang dengan parameter yang
  // sama seperti saat setup, kalau tidak writeMicroseconds() jatuh ke kanal
  // yang tidak ada dan servo diam tanpa satu pun pesan error.
  if (servoLimp[s]) {
    servos[s].setPeriodHertz(50);
    servos[s].attach(SERVO_PIN[s], 500, 2500);
    servoLimp[s] = false;
  }
  servos[s].writeMicroseconds(us);
  servoUsNow[s] = (int16_t)us;
}

// Hentikan pulsa ke servo s: torsi lepas, servo bebas diputar tangan, dan
// potensiometer internalnya TETAP terbaca karena dia pembagi tegangan pasif
// yang tidak butuh pulsa, cuma butuh rail 5 V.
void servoLepas(int s) {
  servoManual[s] = true;      // loop kendali jangan menulis pulsa lagi
  servoLimp[s]   = true;
  servos[s].detach();
  // Jalur sinyal dijaga LOW, bukan dibiarkan mengambang: pin mengambang bisa
  // menangkap derau yang terbaca servo sebagai pulsa dan bikin dia menyentak.
  pinMode(SERVO_PIN[s], OUTPUT);
  digitalWrite(SERVO_PIN[s], LOW);
  servoUsNow[s] = 0;          // 0 = tidak ada pulsa, jujur di diag
}

// Mulai sesi dorong gripper. Dipanggil tiap perintah yang menggerakkan gripper
// lewat pemetaan sudut, supaya pewaktu auto-lemas selalu dihitung dari perintah
// terakhir dan bukan dari perintah pertama yang sudah lama lewat.
void gripMulaiDorong() {
  servoManual[SERVO_GRIP] = false;   // loop kendali ambil alih (ikut attach ulang)
  gripDriving  = true;
  gripDriveT0  = millis();
  gripArriveT0 = 0;
}


// ======================= ADS1115 (feedback pot servo) =====================
#if SERVO_FEEDBACK

bool    adsPresent = false;
int16_t adsRaw[NUM_SERVO]  = {0};       // hasil konversi terakhir per kanal
bool    adsOk[NUM_SERVO]   = {false};
uint8_t adsFail[NUM_SERVO] = {0};
bool    adsSatPernah[NUM_SERVO] = {false};   // pernah menyentuh ambang saturasi

static inline float adsRawToMv(int16_t raw) { return raw * ADS_MV_PER_LSB; }

bool adsWriteConfig(uint16_t cfg) {
  Wire.beginTransmission(ADS_ADDR);
  Wire.write(ADS_REG_CONFIG);
  Wire.write((uint8_t)(cfg >> 8));
  Wire.write((uint8_t)(cfg & 0xFF));
  return Wire.endTransmission() == 0;
}

// Arahkan pointer register ke conversion register sekali saja; setelah ini
// cukup requestFrom() berulang tanpa menulis pointer lagi (dipakai capture).
bool adsPointConv() {
  Wire.beginTransmission(ADS_ADDR);
  Wire.write(ADS_REG_CONV);
  return Wire.endTransmission() == 0;
}

bool adsReadConv(int16_t* out) {
  if (Wire.requestFrom((uint8_t)ADS_ADDR, (uint8_t)2) != 2) return false;
  uint16_t v = ((uint16_t)Wire.read() << 8);
  v |= Wire.read();
  *out = (int16_t)v;
  return true;
}

/* Arahkan pointer ke conversion register LALU baca.

   JEBAKAN YANG SUDAH MEMAKAN KORBAN (bring-up 10 Agu 2026): ADS1115 punya satu
   pointer register yang menentukan register mana yang keluar saat dibaca.
   adsStartSingle() menulis CONFIG, jadi pointer tertinggal di 0x01. Membaca
   tanpa mengembalikannya ke 0x00 akan mengembalikan isi CONFIG, bukan hasil
   konversi, DAN TIDAK ADA ERROR APA PUN: angkanya terlihat seperti pembacaan
   ADC biasa. Cara mengenalinya kalau terulang: nilai antar kanal berbeda tepat
   4096 hitungan (= 1 << 12, yaitu bit MUX yang bergeser satu kanal), dan
   nilainya negatif karena bit 15 (OS) selalu 1 pada pembacaan balik.
   Terukur waktu itu: A0 -15485, A1 -11389, A2 -7293 = persis 0xC383, 0xD383,
   0xE383, yaitu kata CONFIG itu sendiri. */
bool adsReadConvAman(int16_t* out) {
  if (!adsPointConv()) return false;
  return adsReadConv(out);
}

// Mulai satu konversi single-shot di kanal single-ended ch (0..3).
bool adsStartSingle(uint8_t ch, uint16_t drBits) {
  uint16_t cfg = ADS_OS_START | ADS_PGA_BITS | ADS_MODE_SINGLE | drBits |
                 ADS_COMP_OFF | ((uint16_t)(0x4 | (ch & 0x3)) << 12);
  return adsWriteConfig(cfg);
}

// Baca satu kanal secara blocking (single-shot). Dipakai saat butuh angka
// bersih sekarang juga: kalibrasi, diag, sinkronisasi boot. Bukan di loop
// kendali, karena satu konversi 128 SPS memakan ~8 ms.
bool adsReadChannel(uint8_t ch, int16_t* out) {
  if (!adsStartSingle(ch, ADS_DR_128)) return false;
  delay(ADS_CONV_MS_128);
  return adsReadConvAman(out);
}

/* Round-robin non-blocking untuk loop kendali.

   Kenapa tidak blocking saja: satu konversi 128 SPS ~8 ms, dikali 3 kanal jadi
   24 ms per putaran loop. Itu menggeser broadcast feedback 50 Hz dan mencuri
   waktu dari poll encoder. Dengan state machine ini loop tidak pernah menunggu:
   tiap kanal diperbarui ~33 Hz dan loop tetap berjalan penuh. */
uint8_t  adsCur   = 0;
uint32_t adsDueMs = 0;

void pollADS() {
  if (!adsPresent) return;
  if ((int32_t)(millis() - adsDueMs) < 0) return;

  int16_t v;
  if (adsReadConvAman(&v)) {     // pointer WAJIB dikembalikan ke 0x00 dulu
    adsRaw[adsCur] = v;
    adsOk[adsCur]  = true;
    adsFail[adsCur] = 0;
    if (adsRawToMv(v) >= ADS_SATURASI_MV) adsSatPernah[adsCur] = true;
  } else {
    if (adsFail[adsCur] < 255) adsFail[adsCur]++;
    if (adsFail[adsCur] >= ADS_FAULT_LIMIT) adsOk[adsCur] = false;
  }
  adsCur = (adsCur + 1) % NUM_SERVO;
  adsStartSingle(SERVO_FB_CH[adsCur], ADS_DR_128);
  adsDueMs = millis() + ADS_CONV_MS_128;
}
#endif  // SERVO_FEEDBACK

// Sudut aktual servo dari wiper pot lewat ADS1115, kalibrasi 2 titik.
// Tanpa feedback (atau saat ADS1115 hilang): kembalikan sudut commanded, dan
// itu ditandai jujur lewat adsOk[] di diag, bukan disamarkan jadi hasil ukur.
float readServoAngle(int s, float commandedDeg) {
#if SERVO_FEEDBACK
  if (!adsPresent || !adsOk[s]) return commandedDeg;
  int spanMv = cal.servoFbMvMax[s] - cal.servoFbMvMin[s];
  if (spanMv == 0) return commandedDeg;  // kalibrasi rusak (guardrail div/0)
  float t = (adsRawToMv(adsRaw[s]) - cal.servoFbMvMin[s]) / (float)spanMv;
  t = clampf(t, 0.0f, 1.0f);
  return cal.servoAngMin[s] + t * (cal.servoAngMax[s] - cal.servoAngMin[s]);
#else
  return commandedDeg;
#endif
}

// Auto-lemas gripper. Dipanggil tiap putaran loop SETELAH gripActualDeg
// diperbarui, karena keputusannya bergantung pada sudut hasil ukur.
void gripAutoLemasTick() {
  if (!gripDriving) return;
  // E-stop sudah menghentikan penulisan pulsa di loop, tapi servo masih
  // terpasang di pulsa terakhirnya. Lepaskan supaya e-stop benar benar berarti
  // tidak ada torsi tersisa di gripper.
  if (estop) { servoLepas(SERVO_GRIP); gripDriving = false; return; }

  uint32_t now = millis();

  // "Sampai" hanya boleh dinilai kalau sudutnya benar benar HASIL UKUR. Tanpa
  // ADS1115, readServoAngle() mengembalikan sudut perintah, jadi selisihnya
  // selalu nol dan gripper akan lepas seketika tanpa pernah mencengkeram apa
  // pun. Dalam kondisi itu biarkan batas waktu yang menghentikannya.
  bool fbHidup = false;
#if SERVO_FEEDBACK
  fbHidup = adsPresent && adsOk[SERVO_GRIP];
#endif
  if (fbHidup && fabsf(gripActualDeg - gripTargetDeg) <= GRIP_TOL_DEG) {
    if (gripArriveT0 == 0) gripArriveT0 = now;
    if (now - gripArriveT0 >= GRIP_SETTLE_MS) {
      servoLepas(SERVO_GRIP); gripDriving = false; return;
    }
  } else {
    gripArriveT0 = 0;         // keluar lagi dari toleransi: hitung dari awal
  }

  // Tidak pernah sampai: mencengkeram benda, atau kena titik macet. Dua duanya
  // berhenti di sini supaya servo tidak pernah dialiri lebih lama dari batas.
  if (now - gripDriveT0 >= GRIP_HOLD_MAX_MS) {
    servoLepas(SERVO_GRIP); gripDriving = false;
  }
}

// ======================= TMC2209 UART =====================================
// Kontrol penuh 4 driver lewat SATU bus UART single-wire (Serial2).
// Wiring bus:
//   ESP32 TX2 (GPIO17) --[1k]--+-- PDN_UART semua driver
//   ESP32 RX2 (GPIO16) --------+
// Alamat tiap driver di-set lewat jumper MS1/MS2 di modul (BUKAN pin ESP32):
//   J1 = 0b00 (MS1=L, MS2=L)   J2 = 0b01 (MS1=H, MS2=L)
//   J3 = 0b10 (MS1=L, MS2=H)   J4 = 0b11 (MS1=H, MS2=H)
// (Saat UART aktif, MS1/MS2 = pin alamat; microstep di-set via register UART.)
#if USE_TMC_UART
#include <TMCStepper.h>
#define TMC_SERIAL   Serial2
#define TMC_RX2      16
#define TMC_TX2      17
// WAJIB dicocokkan dengan resistor sense FISIK di modul: lihat marking
// resistor kecil dekat pin motor (R110 = 0.11, R150 = 0.15, R050 = 0.05).
// Salah nilai di sini = arus salah proporsional, tanpa error apa pun.
#define TMC_R_SENSE  0.11f       // Ohm, cek modul (0.11 utk BTT/SilentStepStick)

// Arus RMS per motor sekarang RUNTIME di cal.tmcMa[] (default TMC_MA_DEFAULT
// di bagian konfigurasi atas). J1 17HS2401, J2 17HS6401S (besar),
// J3 17HS2401, J4 17HS2401.

// StallGuard: ambang deteksi beban (0..255, makin kecil makin sensitif).
// Dipakai untuk sensorless homing / deteksi tabrakan. 0 = nonaktif.
const uint8_t SG_THRESHOLD[NUM_STEPPER] = {0, 0, 0, 0};

// Satu chip per sendi, alamat UART berurutan. Alamat di-set jumper MS1/MS2 di
// modul; kalau dua modul kebetulan beralamat sama, keduanya menjawab bersamaan
// dan gejalanya CRC salah, bukan diam (lihat firmware/tmc_scan/).
TMC2209Stepper tmc[NUM_STEPPER] = {
  TMC2209Stepper(&TMC_SERIAL, TMC_R_SENSE, 0b00),   // J1
  TMC2209Stepper(&TMC_SERIAL, TMC_R_SENSE, 0b01),   // J2
  TMC2209Stepper(&TMC_SERIAL, TMC_R_SENSE, 0b10),   // J3
  TMC2209Stepper(&TMC_SERIAL, TMC_R_SENSE, 0b11),   // J4
};

// JEBAKAN TMCStepper: setter microsteps() memakai 0 sebagai kode "full step",
// dan nilai 1 TIDAK dikenali sama sekali (switch-nya jatuh ke `default: break`).
// Jadi microsteps(1) DIAM-DIAM TIDAK MENULIS APA PUN: chip tetap memakai
// microstep lama sementara firmware sudah menghitung pulsa untuk full step,
// dan gerakan meleset sebesar rasio microstep lama (terukur: minta 1 saat chip
// di 2 -> lengan cuma bergerak setengah perintah). Getter-nya juga melaporkan
// full step sebagai 0. Semua konversi microstep WAJIB lewat dua helper ini.
static inline uint16_t msToLib(uint16_t ms)   { return ms <= 1 ? 0 : ms; }
static inline uint16_t msFromLib(uint16_t v)  { return v == 0  ? 1 : v; }

// Microstep yang BENAR-BENAR dipakai chip, hasil baca balik register CHOPCONF
// saat tmcApply() terakhir (0 = driver bisu / tak terbaca). Dilaporkan di diag.
uint16_t tmcMsActual[NUM_STEPPER] = {0};
// Percobaan yang dibutuhkan sampai verifikasi lolos (0 = tetap gagal).
uint8_t  tmcApplyTries[NUM_STEPPER] = {0};
const uint8_t TMC_APPLY_RETRY = 3;

// Parameter penjaga kesehatan driver saat jalan. Fungsinya (tmcHealthTick,
// tmcRecover) ada di bawah setupTMC(); yang di sini cuma keadaannya, karena
// setupTMC() sendiri sudah memakainya untuk menjadwalkan percobaan ulang.
#define TMC_CHECK_MS   250    // satu driver per ini (siklus penuh 4 x 250 ms)
#define TMC_BAD_LIMIT  3      // strike berturut-turut sebelum driver BISU ditindak
#define TMC_RETRY_MS   5000   // jeda antar percobaan pemulihan selama masih gagal

static uint32_t tmcNextCheck   = 0;
static uint32_t tmcNextRecover = 0;
static uint8_t  tmcCheckIdx    = 0;
static uint8_t  tmcBadStreak[NUM_STEPPER] = {0};

// Tulis satu paket parameter penuh ke SATU driver.
//
// Urutan penting: toff(0) mematikan tahap output dulu supaya register tidak
// diubah sambil coil sedang di-drive, baru toff(4) menyalakan lagi di akhir.
// Bus single-wire memantulkan SETIAP byte yang kita kirim kembali ke RX kita
// sendiri. Sisa echo yang tertinggal di FIFO akan dibaca datagram berikutnya
// sebagai awal balasan, lalu transaksi itu gagal, dan kegagalannya menumpuk
// makin parah tiap driver berikutnya. Persis pola yang terlihat di log boot:
// J1 selalu lolos, sisanya gugur satu per satu. Kuras dulu sebelum tiap
// transaksi. Terbukti di firmware/tmc_scan: dengan pengurasan eksplisit,
// keempat driver dapat 16/16 di tiga baud tanpa satu pun meleset.
static inline void tmcBusFlush() {
  while (TMC_SERIAL.available()) TMC_SERIAL.read();
}

static void tmcWriteAll(int i, uint16_t ms, float hold) {
  {
    tmcBusFlush();
    tmc[i].toff(0);

    // Default chip TMC2209: arus diskalakan tegangan pin VREF. TMCStepper
    // TIDAK mematikannya di begin(), jadi tanpa baris ini rms_current() hanya
    // menghasilkan (VREF/2.5V) x nilai yang diminta, pada modul ber-VREF
    // 1.2 V itu cuma 48%. Ini penyebab klasik "arus tidak pernah naik".
    tmc[i].I_scale_analog(false);
    tmc[i].internal_Rsense(false);   // pakai sense resistor eksternal di modul
    tmc[i].pdn_disable(true);        // aktifkan interface UART (matikan PDN)
    tmc[i].mstep_reg_select(true);   // microstep dari register UART, bukan pin

    tmc[i].blank_time(24);
    tmc[i].hysteresis_start(1);      // hstrt, dipakai spreadCycle
    tmc[i].hysteresis_end(2);        // hend

    tmc[i].rms_current(cal.tmcMa[i], hold);
    tmc[i].iholddelay(6);
    tmc[i].TPOWERDOWN(20);           // ~0.3 s sebelum turun ke arus tahan

    tmc[i].microsteps(msToLib(ms));  // WAJIB lewat helper, lihat catatan di atas
    tmc[i].intpol(true);             // MicroPlyer: interpolasi ke 256 -> halus

    tmc[i].en_spreadCycle(cal.tmcSpread != 0);
    if (cal.tmcSpread == 0) {        // stealthChop butuh autoscale + autograd
      tmc[i].pwm_autoscale(true);
      tmc[i].pwm_autograd(true);
    }
    if (SG_THRESHOLD[i] > 0) {       // aktifkan StallGuard bila di-set
      tmc[i].TCOOLTHRS(0xFFFFF);
      tmc[i].SGTHRS(SG_THRESHOLD[i]);
    }
    tmc[i].toff(4);
  }
}

// Baca balik microstep yang benar-benar aktif di chip i. TMC2209 hanya bisa
// membaca sebagian register: CHOPCONF (microstep, toff) dan GCONF (mstep_reg_
// select) BISA, sedangkan IHOLD_IRUN write-only sehingga arus tidak mungkin
// diverifikasi lewat UART (pakai cs_actual di diag sebagai gantinya).
// Return 0 bila driver bisu.
static uint16_t tmcReadMicrostep(int i) {
  // Jeda SEBELUM menguras, bukan sesudah. Byte echo dari datagram tulis
  // terakhir masih dalam perjalanan saat write() kembali (flush hanya menunggu
  // FIFO kirim kosong, byte terakhirnya baru sedang digeser keluar), jadi
  // menguras seketika tidak menangkap apa-apa dan byte susulan itu tiba tepat
  // saat kita menunggu balasan, lalu terbaca sebagai awal balasan yang rusak.
  delay(2);
  tmcBusFlush();
  if (tmc[i].test_connection() != 0) return 0;
  return msFromLib(tmc[i].microsteps());
}

// Dorong SELURUH parameter chopper dari cal.tmc* ke keempat driver, LALU baca
// balik untuk memastikan benar-benar mendarat. Dipanggil saat boot dan tiap
// cal_set menyentuh field tmc_*.
//
// Kenapa perlu verifikasi: bus UART single-wire (TX2/RX2 digabung lewat 1k,
// half-duplex dengan self-echo) bisa kehilangan paket saat ada derau listrik,
// dan TMCStepper tidak melaporkan kegagalan tulis sama sekali. Tanpa baca
// balik, firmware dan chip bisa diam-diam berbeda pendapat soal microstep dan
// SEMUA perhitungan step/derajat ikut meleset tanpa satu pun pesan error.
void tmcApply() {
  uint16_t ms = cal.tmcMicrostep < 1 ? 1 : cal.tmcMicrostep;
  float hold = clampf(cal.tmcHoldPct / 100.0f, 0.0f, 1.0f);

  for (int i = 0; i < NUM_STEPPER; i++) {
    bool ok = false;
    for (uint8_t t = 1; t <= TMC_APPLY_RETRY; t++) {
      tmcWriteAll(i, ms, hold);
      tmcMsActual[i] = tmcReadMicrostep(i);
      // Driver bisu TIDAK lagi dianggap kasus hopeless. Penyebab paling sering
      // ternyata bus yang sesaat tidak sinkron karena sisa echo, dan itu pulih
      // begitu FIFO dikuras lalu dicoba lagi. Dulu di sini ada break, dan itu
      // yang membuat J2/J3/J4 menyerah di percobaan pertama saat boot.
      ok = (tmcMsActual[i] != 0) && (tmcMsActual[i] == ms) && tmc[i].mstep_reg_select();
      if (ok) { tmcApplyTries[i] = t; break; }
      delay(5);
    }
    if (!ok) {
      tmcApplyTries[i] = 0;
      if (tmcMsActual[i] != 0)
        Serial.printf("[TMC] J%d VERIFIKASI GAGAL: minta ms=%u, chip lapor ms=%u "
                      "(%u percobaan)\n", i + 1, ms, tmcMsActual[i], TMC_APPLY_RETRY);
    }
    // Bendera GSTAT.reset dibersihkan TEPAT sesudah konfigurasi mendarat, jadi
    // bendera yang menyala berikutnya pasti reset yang terjadi SESUDAH ini.
    // Tanpa pembersihan di sini, bendera dari power-on saat boot tetap menyala
    // dan penjaga di bawah akan mengira driver baru saja hilang tiap kali.
    tmcBusFlush();
    tmc[i].GSTAT(0b111);   // write-to-clear, argumennya diabaikan pustaka
  }
  // stealthChop autotune AT#1 mensyaratkan arus sudah aktif dan motor DIAM
  // >130 ms sebelum gerakan pertama. Perubahan arus/mode membatalkan hasil
  // tuning sebelumnya, jadi jeda ini diulang tiap apply.
  if (cal.tmcSpread == 0) delay(150);
}

void setupTMC() {
  TMC_SERIAL.begin(115200, SERIAL_8N1, TMC_RX2, TMC_TX2);
  delay(200);
  for (int i = 0; i < NUM_STEPPER; i++) tmc[i].begin();
  tmcApply();
  for (int i = 0; i < NUM_STEPPER; i++) {
    // conn: 0 = OK, 1 = bus mati (baca 0xFFFFFFFF), 2 = tak ada balasan.
    // Dua percobaan dengan pengurasan bus di antaranya: satu kegagalan tunggal
    // di bus half-duplex bukan bukti driver mati, dan laporan boot yang salah
    // menuduh driver sehat itu mahal (satu sesi penuh sudah terbuang begitu).
    tmcBusFlush();
    uint8_t conn = tmc[i].test_connection();
    if (conn != 0) { delay(5); tmcBusFlush(); conn = tmc[i].test_connection(); }
    tmcConn[i] = conn;
    if (conn != 0) {
      // %02d dulu mencetak alamat dalam DESIMAL berawalan "0b", jadi J3 tampil
      // "0b02" padahal alamatnya 0b10. Menyesatkan persis saat orang sedang
      // mencocokkan jumper MS1/MS2 dengan log.
      Serial.printf("[TMC] J%d addr 0b%d%d: TIDAK MENJAWAB (conn=%u)\n",
                    i + 1, (i >> 1) & 1, i & 1, conn);
      continue;
    }
    Serial.printf("[TMC] J%d addr 0b%d%d: OK ms=%u (diminta %u)%s I=%umA %s\n",
                  i + 1, (i >> 1) & 1, i & 1, tmcMsActual[i], cal.tmcMicrostep,
                  tmcApplyTries[i] == 0 ? " <- TIDAK COCOK!" : "",
                  cal.tmcMa[i], cal.tmcSpread ? "spreadCycle" : "stealthChop");
  }

  /* Boot tunduk aturan yang sama dengan runtime: tahap output hanya menyala
     kalau KEEMPAT driver menjawab DAN microstep-nya terverifikasi. EN_PIN
     dipakai bersama keempat driver, jadi tidak ada cara menyalakan tiga dan
     mematikan satu; dan satu driver yang bisu berarti microstep-nya diambil
     dari pin MS1/MS2 tanpa ada yang tahu berapa, sehingga seluruh perhitungan
     step/derajat sendi itu menjadi tebakan.

     Ini bukan jalan buntu: penjaga di tmcHealthTick() mencoba lagi tiap
     TMC_RETRY_MS, jadi menyalakan PSU sesudah ESP32 sudah hidup akan membuat
     lengan siap sendiri dalam beberapa detik, tanpa perlu reboot. */
  int sehat = 0;
  for (int i = 0; i < NUM_STEPPER; i++)
    if (tmcConn[i] == 0 && tmcApplyTries[i] != 0) sehat++;
  tmcDown = (sehat != NUM_STEPPER);
  if (tmcDown) {
    tmcNextRecover = millis() + TMC_RETRY_MS;
    Serial.printf("[TMC] cuma %d/%d driver terverifikasi saat boot, tahap output "
                  "TIDAK dinyalakan. Periksa rail VM (PSU 12 V); pemulihan dicoba "
                  "ulang tiap %d detik.\n", sehat, NUM_STEPPER, TMC_RETRY_MS / 1000);
  }
}

/* ---- Penjaga kesehatan driver saat jalan ---------------------------------
   Alasannya panjang lebar ada di deklarasi tmcDown. Ringkasnya: konfigurasi
   yang mendarat saat boot tidak bertahan melewati matinya rail VM, jadi
   "sudah dikonfigurasi" harus ditanyakan ulang, bukan diingat.

   Dua pembacaan per driver, satu driver per panggilan:
     test_connection()  -> driver menjawab sama sekali atau tidak (bus/VM mati)
     reset()            -> bit GSTAT.reset, menyala kalau chip mati-nyala
                           SESUDAH tmcApply() terakhir membersihkannya
   GSTAT saja tidak cukup: kalau VM masih mati, pembacaan gagal dan bit-nya
   terbaca nol, jadi driver yang tidak ada akan tampak sehat. Keduanya perlu. */
void syncSteppersFromEncoders();   // definisi di blok GERAK
void enUpdate();

/* Pulihkan keempat driver: matikan tahap output, tulis ulang seluruh
   konfigurasi, samakan step counter dengan encoder, baru izinkan arus lagi.

   Gerak yang sedang berjalan SENGAJA tidak dilanjutkan. Sebagian jaraknya
   sudah ditempuh dengan skala microstep yang salah dan sendi non self-locking
   bisa melorot selama tahap output mati, jadi target lama tidak lagi berarti
   apa-apa. Yang bisa dipertanggungjawabkan cuma berhenti di posisi nyata. */
static void tmcRecover() {
  digitalWrite(EN_PIN, HIGH);     // apa pun hasilnya nanti, arus dimatikan dulu
  for (int i = 0; i < NUM_STEPPER; i++) if (steppers[i]) steppers[i]->forceStop();

  tmcApply();                     // sudah termasuk baca-balik microstep + clear GSTAT

  int sehat = 0;
  for (int i = 0; i < NUM_STEPPER; i++) {
    tmcBusFlush();
    uint8_t conn = tmc[i].test_connection();
    if (conn != 0) { delay(5); tmcBusFlush(); conn = tmc[i].test_connection(); }
    tmcConn[i] = conn;
    tmcBadStreak[i] = 0;
    if (conn == 0 && tmcApplyTries[i] != 0) sehat++;
  }

  if (sehat == NUM_STEPPER) {
    syncSteppersFromEncoders();   // target = posisi nyata, jadi tidak ada yang menyentak
    tmcDown = false;
    tmcNextRecover = 0;
    Serial.printf("[TMC] driver dikonfigurasi ulang dan pulih (kejadian ke-%u). "
                  "Target dibekukan di posisi sekarang.\n", tmcResetSeen);
  } else {
    tmcDown = true;
    tmcNextRecover = millis() + TMC_RETRY_MS;
    Serial.printf("[TMC] cuma %d/%d driver menjawab, tahap output TETAP MATI. "
                  "Periksa rail VM (PSU 12 V).\n", sehat, NUM_STEPPER);
  }
  enUpdate();
}

void tmcHealthTick() {
  uint32_t now = millis();

  if (tmcDown) {   // sudah tahu rusak: yang tersisa cuma mencoba lagi berkala
    if (tmcNextRecover && now >= tmcNextRecover) tmcRecover();
    return;
  }
  if (now < tmcNextCheck) return;
  tmcNextCheck = now + TMC_CHECK_MS;

  const int i = tmcCheckIdx;
  tmcCheckIdx = (tmcCheckIdx + 1) % NUM_STEPPER;

  delay(2);          // jeda SEBELUM menguras, alasannya di tmcReadMicrostep()
  tmcBusFlush();
  const bool bisu = (tmc[i].test_connection() != 0);

  /* Dua bukti ini TIDAK setara, jadi tidak diperlakukan sama.

     Driver BISU bisa berarti bus half-duplex sedang tidak sinkron karena sisa
     echo (lihat catatan di tmcWriteAll), dan itu pulih sendiri. Butuh beberapa
     kali berturut-turut sebelum boleh disebut hilang.

     Bit GSTAT.reset yang menyala datang dari balasan yang CRC-nya lolos: chip
     itu sendiri yang menyatakan pernah mati-nyala sesudah tmcApply() terakhir
     membersihkan bendera ini. Tidak ada tafsir lain, jadi langsung ditindak.
     Inilah jalur yang menangkap kedipan VM yang pulih terlalu cepat untuk
     mengumpulkan tiga strike. */
  bool porBaru = false;
  if (!bisu) { tmcBusFlush(); porBaru = tmc[i].reset(); }

  if (!bisu && !porBaru) { tmcBadStreak[i] = 0; return; }
  if (bisu && ++tmcBadStreak[i] < TMC_BAD_LIMIT) return;

  tmcResetSeen++;
  Serial.printf("[TMC] J%d %s. Tahap output dimatikan, konfigurasi ditulis ulang.\n",
                i + 1, porBaru ? "melaporkan power-on reset (GSTAT.reset)"
                               : "tidak menjawab tiga kali berturut-turut");
  tmcDown = true;
  tmcRecover();
}

// Baca hasil StallGuard driver (beban). Makin kecil = makin terbebani.
uint16_t tmcStallGuard(int i) { return tmc[i].SG_RESULT(); }

// Arus RMS (mA) yang benar-benar dipakai chip, dihitung balik dari CS:
//   I_rms = (CS+1)/32 * V_fs / (R_SENSE + 0.02) / sqrt(2)
// V_fs = 0.325 V (vsense 0) atau 0.180 V (vsense 1, mode sensitif arus kecil).
// CATATAN: angka ini hanya skala DIGITAL. Kalau I_scale_analog masih aktif,
// arus fisik masih dikali (VREF/2.5V) lagi dan itu TIDAK terlihat di sini.
float tmcCsToMa(int i, uint8_t cs) {
  float vfs = tmc[i].vsense() ? 0.180f : 0.325f;
  return (cs + 1) / 32.0f * vfs / (TMC_R_SENSE + 0.02f) / 1.41421f * 1000.0f;
}
#endif

#if USE_HX711
// ======================= LOAD CELL (HX711) ================================
// Bit-bang non-blocking: DT LOW = data ready (~10 Hz), lalu clock 24 bit +
// 1 pulsa gain (128, channel A). Critical section dijaga pendek (~100 us)
// supaya pulsa SCK tidak molor >60 us, HX711 masuk power-down kalau molor.

void setupHX711() {
  pinMode(HX711_DT, INPUT);
  pinMode(HX711_SCK, OUTPUT);
  digitalWrite(HX711_SCK, LOW);
}

void pollHX711() {
  if (digitalRead(HX711_DT) != LOW) {
    // Guardrail: lama tak ada data ready -> tandai load cell hilang, bukan
    // membekukan nilai basi seolah masih valid.
    if (loadOk && millis() - loadLastReady > 500) loadOk = false;
    return;
  }
  noInterrupts();
  long v = 0;
  for (int i = 0; i < 24; i++) {
    digitalWrite(HX711_SCK, HIGH); delayMicroseconds(1);
    v = (v << 1) | digitalRead(HX711_DT);
    digitalWrite(HX711_SCK, LOW);  delayMicroseconds(1);
  }
  digitalWrite(HX711_SCK, HIGH); delayMicroseconds(1);   // pulsa ke-25: gain 128 ch A
  digitalWrite(HX711_SCK, LOW);
  interrupts();
  if (v & 0x800000L) v |= ~0xFFFFFFL;   // sign-extend 24 -> 32 bit (two's complement)
  loadRaw = v;
  loadOk = true;
  loadLastReady = millis();
}

// Rata-rata `want` sampel segar (blocking maks ~600 ms, jauh di bawah WDT 5 dtk).
// false bila load cell tidak menghasilkan data sama sekali.
bool hx711Average(float* out, int want) {
  long long acc = 0; int got = 0;
  unsigned long t0 = millis();
  while (got < want && millis() - t0 < 600) {
    unsigned long before = loadLastReady;
    pollHX711();
    if (loadLastReady != before) { acc += loadRaw; got++; }
    delay(5);
  }
  if (!got) return false;
  *out = (float)(acc / got);
  return true;
}

// Gram dari sampel terakhir; 0 bila belum dikalibrasi (loadScale 0, guardrail div/0).
float loadGrams() {
  return (cal.loadScale != 0.0f) ? (loadRaw - cal.loadOffset) / cal.loadScale : 0.0f;
}
#endif

// ======================= GERAK ============================================

/* Satu-satunya penulis EN_PIN sesudah setup(). Dulu pin ini cuma disentuh
   applyEstop(), sehingga "boleh ada arus" identik dengan "e-stop tidak
   ditekan". Itu tidak cukup: driver yang belum terbukti terkonfigurasi juga
   tidak boleh dialiri arus, kalau tidak ia energize dengan register default
   begitu VM kembali (lihat catatan di deklarasi tmcDown). Menaruh keputusannya
   di satu fungsi mencegah dua penulis saling menimpa: melepas e-stop saat
   driver masih hilang TIDAK boleh menyalakan tahap output. */
void enUpdate() {
  digitalWrite(EN_PIN, (estop || tmcDown) ? HIGH : LOW);   // active-LOW: HIGH = disable
}

void applyEstop(bool on) {
  estop = on;
  enUpdate();
  if (on) {
    for (int i = 0; i < NUM_STEPPER; i++) {
      if (steppers[i]) steppers[i]->forceStop();  // hentikan ramp seketika
    }
  }
}

// Terapkan cal.maxSpeedDps / maxAccelDpss ke semua stepper (dipanggil saat
// setup dan tiap cal_set mengubah speed/accel).
void applyMotionLimits() {
  // Batas kecepatan/percepatan dihitung per sendi karena reduksinya berbeda:
  // maxSpeedDps yang sama menghasilkan step rate yang berbeda di tiap sendi.
  for (int i = 0; i < NUM_STEPPER; i++) {
    if (!steppers[i]) continue;
    steppers[i]->setSpeedInHz((uint32_t)(cal.maxSpeedDps * STEPS_PER_DEG[i]));
    steppers[i]->setAcceleration((uint32_t)(cal.maxAccelDpss * STEPS_PER_DEG[i]));
  }
}

// Sinkronkan step counter internal dgn encoder absolut + target = posisi
// sekarang. Guardrail boot: tanpa ini stepper menganggap posisi nyala = 0
// dan lengan menyentak ke "0" saat power-up.
void syncSteppersFromEncoders() {
  for (int i = 0; i < NUM_STEPPER; i++) {
    float enc = NAN;
    for (int r = 0; r < 3 && isnan(enc); r++) enc = readStepperEncoder(i);
    if (!isnan(enc)) {
      actualDeg[i] = enc;
      targetDeg[i] = enc;
      if (steppers[i])
        steppers[i]->setCurrentPosition((int32_t)(enc * STEPS_PER_DEG[i]));
      Serial.printf("[SYNC] J%d = %.2f deg (encoder)\n", i + 1, enc);
    } else {
      targetDeg[i] = actualDeg[i];  // tak ada encoder: tahan posisi anggapan
      Serial.printf("[SYNC] J%d encoder tak terbaca, asumsi %.2f deg\n",
                    i + 1, actualDeg[i]);
    }
  }
}

// ======================= WEBSOCKET ========================================

// Balasan ke SATU klien: {"type":"ack","cmd":..,"ok":..,"msg":..}
void sendAck(uint8_t num, const char* cmd, bool ok, const char* msg) {
  char buf[160];
  int n = snprintf(buf, sizeof(buf),
                   "{\"type\":\"ack\",\"cmd\":\"%s\",\"ok\":%s,\"msg\":\"%s\"}",
                   cmd, ok ? "true" : "false", msg);
  if (n > 0) webSocket.sendTXT(num, buf, n);
}

// Kirim seluruh kalibrasi ke satu klien sebagai {"type":"cal",...}.
void sendCal(uint8_t num) {
  // static, alasan sama dengan sendDiag: dipanggil dari handleText yang sudah
  // memakai 1536 byte stack sendiri, jadi doc besar di stack menggerus sisa
  // ruang loopTask yang cuma 8 KB.
  // 2560 (naik dari 2048): array servo bertambah jadi 3 elemen dan bertambah
  // satu field (servo_us_center). Kekecilan = serializeJson memotong JSON diam
  // diam dan studio gagal parse seluruh kalibrasi.
  static StaticJsonDocument<2560> doc;
  doc.clear();
  doc["type"] = "cal";
  JsonArray eo = doc.createNestedArray("enc_offset");
  JsonArray es = doc.createNestedArray("enc_sign");
  for (int i = 0; i < NUM_STEPPER; i++) { eo.add(cal.encOffsetDeg[i]); es.add(cal.encSign[i]); }
  JsonArray ra = doc.createNestedArray("ratio");
  for (int i = 0; i < NUM_STEPPER; i++) ra.add(cal.ratio[i]);
  JsonArray jmin = doc.createNestedArray("joint_min");
  JsonArray jmax = doc.createNestedArray("joint_max");
  for (int j = 0; j < NUM_JOINTS; j++) { jmin.add(cal.jointMin[j]); jmax.add(cal.jointMax[j]); }
  doc["speed"]    = cal.maxSpeedDps;
  doc["accel"]    = cal.maxAccelDpss;
  doc["kp"]       = cal.kp;
  doc["deadband"] = cal.deadbandDeg;
  doc["load_offset"] = cal.loadOffset;
  doc["load_scale"]  = cal.loadScale;
  JsonArray tm = doc.createNestedArray("tmc_ma");
  for (int i = 0; i < NUM_STEPPER; i++) tm.add(cal.tmcMa[i]);
  doc["tmc_microstep"] = cal.tmcMicrostep;
  doc["tmc_spread"]    = cal.tmcSpread;
  doc["tmc_hold"]      = cal.tmcHoldPct;
#if USE_TMC_UART
  doc["tmc_rsense"] = TMC_R_SENSE;   // supaya studio bisa cek asumsi arus
#endif
  JsonArray um = doc.createNestedArray("servo_us_min");
  JsonArray uM = doc.createNestedArray("servo_us_max");
  JsonArray uc = doc.createNestedArray("servo_us_center");
  JsonArray am = doc.createNestedArray("servo_ang_min");
  JsonArray aM = doc.createNestedArray("servo_ang_max");
  JsonArray fm = doc.createNestedArray("servo_fb_mv_min");
  JsonArray fM = doc.createNestedArray("servo_fb_mv_max");
  for (int s = 0; s < NUM_SERVO; s++) {
    um.add(cal.servoUsMin[s]);   uM.add(cal.servoUsMax[s]);
    uc.add(cal.servoUsCenter[s]);
    am.add(cal.servoAngMin[s]);  aM.add(cal.servoAngMax[s]);
    fm.add(cal.servoFbMvMin[s]); fM.add(cal.servoFbMvMax[s]);
  }
  String out;
  serializeJson(doc, out);
  webSocket.sendTXT(num, out);
}

// Snapshot diagnostik ke satu klien: {"type":"diag",...}, magnet AS5600 per
// joint (MD/ML/MH + AGC + magnitude, buat atur jarak magnet fisik), sudut raw &
// terkoreksi, StallGuard TMC, load cell, WiFi, status mux. Read-only: dipoll
// UI CAL (~5 Hz) tanpa efek samping ke gerak.
void sendDiag(uint8_t num) {
  // 3584: enc[4] + sg[4] + drv[4] (13 field/driver) + load + wifi. Kekecilan
  // bikin serializeJson diam-diam memotong JSON dan studio gagal parse.
  //
  // WAJIB static. StaticJsonDocument hidup di STACK, sedangkan loopTask hanya
  // punya 8 KB: versi 3072 sudah mepet, dan menaikkannya ke 3584 langsung
  // memicu "stack overflow in task loopTask" + reboot pada diag pertama.
  // Sebagai static ia pindah ke .bss, jadi tidak menyentuh stack maupun heap
  // (tak ada risiko fragmentasi walau UI CAL poll ~5 Hz). Aman karena sendDiag
  // hanya dipanggil dari satu task, yaitu loop().
  // 4352 (naik dari 3584): + blok "ads" (3 kanal x 7 field). Tetap static,
  // jadi tambahan ini masuk .bss dan bukan ke stack loopTask yang cuma 8 KB.
  static StaticJsonDocument<4352> doc;
  doc.clear();
  doc["type"] = "diag";
  JsonArray enc = doc.createNestedArray("enc");
  for (int i = 0; i < NUM_STEPPER; i++) {
    JsonObject e = enc.createNestedObject();
    bool reachable = muxPresent || i == 0;   // tanpa mux hanya J1 valid
    int st = -1, agc = -1, mag = -1;
    if (reachable) {
      tcaSelect(ENC_CHANNEL[i]);
      st  = readAS5600Reg(0x0B, false);
      agc = readAS5600Reg(0x1A, false);
      mag = readAS5600Reg(0x1B, true);
    }
    float raw = readAS5600Raw(ENC_CHANNEL[i]);
    e["ok"]  = st >= 0;
    e["md"]  = st >= 0 && (st & 0x20);   // magnet terdeteksi
    e["ml"]  = st >= 0 && (st & 0x10);   // terlalu lemah (magnet kejauhan)
    e["mh"]  = st >= 0 && (st & 0x08);   // terlalu kuat (magnet kedekatan)
    e["agc"] = agc;
    e["mag"] = mag;
    if (isnan(raw)) e["raw"] = nullptr; else e["raw"] = raw;
    e["deg"]   = actualDeg[i];
    e["fault"] = encFault[i];
  }
#if USE_TMC_UART
  JsonArray sg = doc.createNestedArray("sg");
  for (int i = 0; i < NUM_STEPPER; i++) sg.add(tmcStallGuard(i));
  // Readback driver: bukti bahwa setting arus benar-benar sampai ke chip,
  // plus proteksi termal & deteksi kabel coil. Semua read-only lewat UART.
  JsonArray drv = doc.createNestedArray("drv");
  for (int i = 0; i < NUM_STEPPER; i++) {
    JsonObject d = drv.createNestedObject();
    uint8_t conn = tmc[i].test_connection();     // 0 = OK
    d["ok"] = (conn == 0);
    if (conn != 0) continue;                     // driver bisu: sisanya sampah
    // Microstep yang BENAR-BENAR aktif di chip, dibaca live dari CHOPCONF.
    // msok=false berarti chip melenceng dari cal.tmc_microstep: semua
    // perhitungan step/derajat sedang salah sebesar rasio ms/tmc_microstep.
    // Pemulihan: kirim cal_set tmc_microstep lagi (nilai sama pun memaksa
    // tmcApply ulang).
    uint16_t msNow = msFromLib(tmc[i].microsteps());
    d["ms"]   = msNow;
    d["msok"] = (msNow == cal.tmcMicrostep);
    uint8_t irun = tmc[i].irun();
    uint8_t cs   = tmc[i].cs_actual();
    d["irun"] = irun;
    d["cs"]   = cs;
    d["ma"]   = tmcCsToMa(i, irun);              // arus jalan terprogram
    d["macs"] = tmcCsToMa(i, cs);                // arus yang aktif saat ini
    // Bit analog scaling: kalau true, pot VREF masih ikut mengali arus dan
    // semua angka mA di atas jadi terlalu optimistis.
    d["vref"] = tmc[i].I_scale_analog();
    d["ot"]   = tmc[i].ot();                     // overtemp shutdown
    d["otpw"] = tmc[i].otpw();                   // peringatan pra-overtemp
    d["s2g"]  = tmc[i].s2ga() || tmc[i].s2gb();  // coil short ke GND
    d["ol"]   = tmc[i].ola()  || tmc[i].olb();   // coil open / kabel lepas
  }
#endif
#if USE_HX711
  JsonObject ld = doc.createNestedObject("load");
  ld["ok"]  = loadOk;
  ld["raw"] = loadRaw;
  ld["g"]   = loadGrams();
  ld["cal"] = cal.loadScale != 0.0f;
#endif
#if SERVO_FEEDBACK
  // Feedback servo: kondisi ADS1115 + angka mentah tiap kanal. `sat` sengaja
  // "pernah pernah tersentuh", bukan keadaan sesaat, supaya saturasi yang cuma
  // muncul sekejap di ujung sapuan tidak hilang sebelum sempat terbaca.
  JsonObject ad = doc.createNestedObject("ads");
  ad["ok"] = adsPresent;
  JsonArray ach = ad.createNestedArray("ch");
  for (int s = 0; s < NUM_SERVO; s++) {
    JsonObject c = ach.createNestedObject();
    c["nama"] = SERVO_NAMA[s];
    c["ok"]   = adsOk[s];
    c["raw"]  = adsRaw[s];
    c["mv"]   = adsRawToMv(adsRaw[s]);
    c["sat"]  = adsSatPernah[s];
    c["us"]   = servoUsNow[s];
    c["man"]  = servoManual[s];
    c["limp"] = servoLimp[s];
  }
#endif
  JsonObject wf = doc.createNestedObject("wifi");
  wf["mode"] = runningAsAP ? "ap" : "sta";
  wf["ip"]   = runningAsAP ? WiFi.softAPIP().toString() : WiFi.localIP().toString();
  wf["rssi"] = runningAsAP ? 0 : WiFi.RSSI();
  doc["mux"] = muxPresent;
  String out;
  serializeJson(doc, out);
  webSocket.sendTXT(num, out);
}

// {"cmd":"i2c_scan"} -> {"type":"i2c","mux":b,"bus":[..],"ch":[[..] x8]}
//
// Memisahkan tiga sebab yang gejalanya identik di diag ("encoder tak
// menjawab"): chip mati/tak berdaya, chip hidup tapi di kanal mux yang lain,
// atau chip nyantol langsung di bus utama (alamat 0x36 bentrok dengan J1).
// Diag biasa tak bisa membedakannya karena hanya melihat ENC_CHANNEL[] yang
// sudah diasumsikan benar.
//
// "bus" dipindai dengan SEMUA kanal mux ditutup, jadi isinya benar-benar
// penghuni bus utama (mux 0x70, ADS1115 0x48). Tiap entri "ch" dipindai dengan
// satu kanal terbuka, sehingga 0x70 dan 0x48 tetap ikut muncul di sana: yang
// dicari adalah alamat TAMBAHAN, terutama 0x36.
void sendI2CScan(uint8_t num) {
  static StaticJsonDocument<1024> doc;
  doc.clear();
  doc["type"] = "i2c";
  doc["mux"]  = muxPresent;

  // Tutup semua kanal dulu supaya isi bus utama tidak tercampur isi kanal.
  if (muxPresent) {
    Wire.beginTransmission(TCA9548A_ADDR);
    Wire.write((uint8_t)0x00);
    Wire.endTransmission();
  }
  JsonArray bus = doc.createNestedArray("bus");
  for (uint8_t a = 0x08; a <= 0x77; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) bus.add(a);
  }

  JsonArray ch = doc.createNestedArray("ch");
  if (muxPresent) {
    for (uint8_t c = 0; c < 8; c++) {
      JsonArray satu = ch.createNestedArray();
      tcaSelect(c);
      for (uint8_t a = 0x08; a <= 0x77; a++) {
        if (a == TCA9548A_ADDR) continue;   // mux sendiri, selalu ada
        Wire.beginTransmission(a);
        if (Wire.endTransmission() == 0) satu.add(a);
      }
    }
    tcaSelect(ENC_CHANNEL[0]);              // kembalikan ke kanal J1
  }
  String out;
  serializeJson(doc, out);
  webSocket.sendTXT(num, out);
}

// Helper cal_set: salin array angka JSON ke float[] bila field ada & valid.
// Return: -1 field absen, 0 invalid, 1 sukses. Validasi: numerik & finite.
int readFloatArray(JsonVariantConst v, float* dst, int len, float lo, float hi) {
  if (v.isNull()) return -1;
  JsonArrayConst a = v.as<JsonArrayConst>();
  if (a.isNull() || (int)a.size() != len) return 0;
  float tmp[NUM_JOINTS];
  int i = 0;
  for (JsonVariantConst x : a) {
    if (!x.is<float>()) return 0;
    float f = x.as<float>();
    if (!isfinite(f) || f < lo || f > hi) return 0;
    tmp[i++] = f;
  }
  for (i = 0; i < len; i++) dst[i] = tmp[i];
  return 1;
}

// Skalar cal_set dengan rentang sehat. Return sama dgn readFloatArray.
int readScalar(JsonVariantConst v, float* dst, float lo, float hi) {
  if (v.isNull()) return -1;
  if (!v.is<float>()) return 0;
  float f = v.as<float>();
  if (!isfinite(f) || f < lo || f > hi) return 0;
  *dst = f;
  return 1;
}

// {"cmd":"cal_set", ...}: terapkan tiap field yang hadir; tolak seluruh command
// bila ADA field invalid (all-or-nothing biar kalibrasi tak setengah jadi).
bool handleCalSet(JsonDocument& doc, const char** errMsg) {
  Calibration next = cal;   // kerjakan di salinan, commit bila semua valid
  int r;

  #define CHK(call, name) do { r = (call); if (r == 0) { *errMsg = name; return false; } } while (0)

  CHK(readFloatArray(doc["enc_offset"], next.encOffsetDeg, NUM_STEPPER, 0, 360), "enc_offset");
  // enc_sign: hanya -1 / +1.
  if (!doc["enc_sign"].isNull()) {
    JsonArrayConst a = doc["enc_sign"].as<JsonArrayConst>();
    if (a.isNull() || (int)a.size() != NUM_STEPPER) { *errMsg = "enc_sign"; return false; }
    int i = 0;
    for (JsonVariantConst x : a) {
      int s = x.as<int>();
      if (s != 1 && s != -1) { *errMsg = "enc_sign"; return false; }
      next.encSign[i++] = (int8_t)s;
    }
  }
  CHK(readFloatArray(doc["ratio"], next.ratio, NUM_STEPPER, 1, 300), "ratio");
  CHK(readFloatArray(doc["joint_min"], next.jointMin, NUM_JOINTS, -360, 360), "joint_min");
  CHK(readFloatArray(doc["joint_max"], next.jointMax, NUM_JOINTS, -360, 360), "joint_max");
  CHK(readScalar(doc["speed"],    &next.maxSpeedDps,  1.0f, 180.0f),  "speed");
  CHK(readScalar(doc["accel"],    &next.maxAccelDpss, 1.0f, 720.0f),  "accel");
  CHK(readScalar(doc["kp"],       &next.kp,           0.0f, 2.0f),    "kp");
  CHK(readScalar(doc["deadband"], &next.deadbandDeg,  0.05f, 5.0f),   "deadband");

  float f2[NUM_SERVO];
  CHK(readFloatArray(doc["servo_ang_min"], next.servoAngMin, NUM_SERVO, -360, 360), "servo_ang_min");
  CHK(readFloatArray(doc["servo_ang_max"], next.servoAngMax, NUM_SERVO, -360, 360), "servo_ang_max");
  r = readFloatArray(doc["servo_us_min"], f2, NUM_SERVO, 400, 2600);
  if (r == 0) { *errMsg = "servo_us_min"; return false; }
  if (r == 1) for (int s = 0; s < NUM_SERVO; s++) next.servoUsMin[s] = (int16_t)f2[s];
  r = readFloatArray(doc["servo_us_max"], f2, NUM_SERVO, 400, 2600);
  if (r == 0) { *errMsg = "servo_us_max"; return false; }
  if (r == 1) for (int s = 0; s < NUM_SERVO; s++) next.servoUsMax[s] = (int16_t)f2[s];
  r = readFloatArray(doc["servo_us_center"], f2, NUM_SERVO, 400, 2600);
  if (r == 0) { *errMsg = "servo_us_center"; return false; }
  if (r == 1) for (int s = 0; s < NUM_SERVO; s++) next.servoUsCenter[s] = (int16_t)f2[s];
  r = readFloatArray(doc["servo_fb_mv_min"], f2, NUM_SERVO, 0, 3300);
  if (r == 0) { *errMsg = "servo_fb_mv_min"; return false; }
  if (r == 1) for (int s = 0; s < NUM_SERVO; s++) next.servoFbMvMin[s] = (int16_t)f2[s];
  r = readFloatArray(doc["servo_fb_mv_max"], f2, NUM_SERVO, 0, 3300);
  if (r == 0) { *errMsg = "servo_fb_mv_max"; return false; }
  if (r == 1) for (int s = 0; s < NUM_SERVO; s++) next.servoFbMvMax[s] = (int16_t)f2[s];

  // --- driver TMC2209 ---
  // Batas atas 1700 mA: rating fasa 17HS2401 (1.7 A) sekaligus di bawah
  // maksimum settable TMC2209 dengan R_SENSE 0.11 ohm (1.77 A RMS).
  // 17HS6401S rated 2.0 A, tetapi plafon tetap 1700 mA karena batasnya
  // driver + termal, bukan motor.
  float f4[NUM_STEPPER];
  r = readFloatArray(doc["tmc_ma"], f4, NUM_STEPPER, 100, 1700);
  if (r == 0) { *errMsg = "tmc_ma (100..1700 mA)"; return false; }
  if (r == 1) for (int i = 0; i < NUM_STEPPER; i++) next.tmcMa[i] = (uint16_t)f4[i];
  if (!doc["tmc_microstep"].isNull()) {
    int msv = doc["tmc_microstep"].as<int>();
    bool okMs = false;
    for (int m = 1; m <= 256; m <<= 1) if (msv == m) okMs = true;
    if (!okMs) { *errMsg = "tmc_microstep (1,2,4,...,256)"; return false; }
    next.tmcMicrostep = (uint16_t)msv;
  }
  if (!doc["tmc_spread"].isNull()) {
    int sp = doc["tmc_spread"].as<int>();
    if (sp != 0 && sp != 1) { *errMsg = "tmc_spread (0=stealth, 1=spread)"; return false; }
    next.tmcSpread = (uint8_t)sp;
  }
  float hpct;
  r = readScalar(doc["tmc_hold"], &hpct, 0.0f, 100.0f);
  if (r == 0) { *errMsg = "tmc_hold (0..100 %)"; return false; }
  if (r == 1) next.tmcHoldPct = (uint8_t)hpct;

  #undef CHK

  // Konsistensi silang: min < max di semua pasangan (guardrail div/0 & clamp).
  for (int j = 0; j < NUM_JOINTS; j++)
    if (next.jointMin[j] >= next.jointMax[j]) { *errMsg = "joint_min>=joint_max"; return false; }
  for (int s = 0; s < NUM_SERVO; s++) {
    if (next.servoAngMin[s] >= next.servoAngMax[s]) { *errMsg = "servo_ang_min>=max"; return false; }
    if (next.servoUsMin[s] >= next.servoUsMax[s])   { *errMsg = "servo_us_min>=max"; return false; }
    if (next.servoFbMvMin[s] == next.servoFbMvMax[s]) { *errMsg = "servo_fb_mv_min==max"; return false; }
    // Titik tengah WAJIB di dalam travel terukur. Kalau tidak, pose default saat
    // boot berada di luar jangkauan servo dan lengan menyalakan diri langsung
    // dalam keadaan stall, persis kondisi yang paling merusak servo.
    if (next.servoUsCenter[s] < next.servoUsMin[s] ||
        next.servoUsCenter[s] > next.servoUsMax[s]) { *errMsg = "servo_us_center di luar min..max"; return false; }
  }

  bool motionChanged = (next.maxSpeedDps != cal.maxSpeedDps) ||
                       (next.maxAccelDpss != cal.maxAccelDpss);
  bool ratioChanged = false;
  for (int i = 0; i < NUM_STEPPER; i++)
    if (next.ratio[i] != cal.ratio[i]) ratioChanged = true;
  // Microstep ikut menskala step/derajat, jadi diperlakukan sama dgn rasio.
  bool msChanged  = (next.tmcMicrostep != cal.tmcMicrostep);
  bool tmcChanged = msChanged ||
                    (next.tmcSpread != cal.tmcSpread) ||
                    (next.tmcHoldPct != cal.tmcHoldPct);
  for (int i = 0; i < NUM_STEPPER; i++)
    if (next.tmcMa[i] != cal.tmcMa[i]) tmcChanged = true;
  // Dorong ulang ke chip kapan pun payload MENYEBUT field tmc_*, walau nilainya
  // sama persis. Tanpa ini chip yang diam-diam melenceng tidak bisa dipulihkan
  // lewat cal_set: firmware menyimpulkan "tidak ada perubahan" lalu melewati
  // tmcApply(), dan satu-satunya jalan sinkron ulang cuma reboot. Jadi mengirim
  // nilai yang sama = tombol "sinkronkan ulang driver".
  bool tmcTouched = !doc["tmc_ma"].isNull()     || !doc["tmc_microstep"].isNull() ||
                    !doc["tmc_spread"].isNull() || !doc["tmc_hold"].isNull();
  cal = next;
  if (ratioChanged || msChanged) {
    // Rasio/microstep berubah -> skala step/derajat berubah -> step counter
    // lama tak valid. Guardrail: hitung ulang, re-sync counter dari sudut
    // aktual, dan tahan target = aktual supaya TIDAK ada gerak mendadak.
    recomputeStepsPerDeg();
    for (int i = 0; i < NUM_STEPPER; i++) {
      if (steppers[i])
        steppers[i]->setCurrentPosition((int32_t)(actualDeg[i] * STEPS_PER_DEG[i]));
      targetDeg[i] = actualDeg[i];
    }
  }
  if (motionChanged || ratioChanged || msChanged) applyMotionLimits();
#if USE_TMC_UART
  // Dorong ke chip SETELAH target ditahan = aktual, supaya jeda toff(0) saat
  // reconfigure tidak bertepatan dengan perintah gerak yang masih tertunda.
  if (tmcChanged || tmcTouched) tmcApply();
#else
  (void)tmcChanged; (void)tmcTouched;
#endif
  // Target lama bisa di luar limit baru -> clamp ulang.
  for (int j = 0; j < NUM_JOINTS; j++)
    targetDeg[j] = clampf(targetDeg[j], cal.jointMin[j], cal.jointMax[j]);
  return true;
}

/* {"cmd":"cal_zero"[,"joint":n]} : definisikan pose FISIK sekarang sebagai 0.

   "Nol" artinya berbeda tergantung sendinya, dan ketiga artinya sama sahnya.
   Yang tidak boleh cuma satu: menyamarkan yang satu jadi yang lain.

   1. Stepper ber-encoder (AS5600 menjawab). Offset diisi sudut MENTAH encoder
      sekarang, jadi frame sudutnya absolut, ikut tersimpan ke NVS lewat
      cal_save, dan bertahan sesudah reboot maupun re-flash.

   2. Stepper open-loop (ENC_ADA false, ATAU encoder terdaftar tapi bisu).
      Tidak ada yang bisa diukur, jadi yang di-nol-kan step counter + target.
      Untuk sendi tanpa encoder justru INILAH satu-satunya arti homing yang
      punya makna: "pose fisik yang sekarang, itulah 0". Sifatnya RAM dan
      hilang saat reboot, karena memang tidak ada angka absolut untuk disimpan.

      Jalur ini dulu ditolak mentah dengan alasan jangan sampai ada yang
      mengira sendi tanpa encoder sudah terkalibrasi. Ongkos penolakannya
      ternyata lebih mahal daripada penyakit yang dicegah: J2..J4 cuma bisa
      di-nol-kan dengan me-reboot ESP32, padahal J2 dan J3 tidak self-locking
      sehingga melorot tiap kali e-stop mematikan driver, yaitu persis saat
      sendi itu dipindah tangan. Bedanya sekarang dinyatakan di isi ack
      ("open-loop"), bukan dengan menggagalkan homing-nya.

   3. Servo J5/J6. Poros servo tidak punya counter dan tidak bisa "di-nol-kan":
      posisinya ditentukan lebar pulsa. Jadi yang digeser SUMBU SUDUTNYA, yaitu
      servoAngMin/Max (plus jointMin/Max supaya amplop kerjanya ikut, bukan
      malah menyempit sepihak). Sesudah digeser sejauh -offset, perintah 0
      derajat memetakan ke pulsa yang persis sama dengan yang sedang menahan
      pose sekarang, sehingga servo TIDAK bergerak saat di-nol-kan.

      Offset diambil dari targetDeg (sudut yang diperintahkan), bukan dari
      sudut hasil ukur pot: pose fisik yang sedang dilihat operator itu hasil
      dari pulsa yang dikirim, sedangkan pembacaan pot bisa saja belum
      terkalibrasi (servoFbMv default) dan nilainya terjepit di ujung rentang.
      Menomori ulang sumbu sudut memakai angka yang terjepit akan mengunci
      kesalahan itu jadi permanen.

   Bentuk tanpa "joint" sengaja hanya menyentuh J1..J4. Menggeser sumbu sudut
   servo itu operasi yang menomori ulang seluruh rentang kerja, jadi harus
   diminta per sendi dan tidak boleh kejadian sebagai efek samping "nol semua".
*/
bool handleCalZero(int joint /*0-based, -1 = semua stepper*/, const char** msg) {
  static char ringkas[96];

  // --- Servo: geser sumbu sudut, bukan nol-kan counter (lihat butir 3) ---
  if (joint >= NUM_STEPPER) {
    int j = joint;                       // indeks sendi 0-based (4 = J5, 5 = J6)
    int s = -1;
    for (int k = 0; k < NUM_SERVO; k++) if (SERVO_JOINT[k] == j) s = k;
    if (s < 0) { *msg = "sendi ini bukan servo"; return false; }
    if (servoManual[s]) {
      // Di mode manual, pulsa yang keluar di-set servo_us dan targetDeg tidak
      // lagi mewakili pose fisik. Menggeser sumbu sudut dari angka yang sudah
      // tidak nyambung akan menghasilkan nol yang salah tanpa gejala apa pun.
      *msg = "servo di mode manual (servo_us), kirim servo_auto dulu";
      return false;
    }
    float off = targetDeg[j];
    if (fabs(off) < 1e-4f) { *msg = "sudah 0, sumbu sudut tidak digeser"; return true; }
    cal.servoAngMin[s] -= off;
    cal.servoAngMax[s] -= off;
    cal.jointMin[j]    -= off;
    cal.jointMax[j]    -= off;
    targetDeg[j] = 0;                    // pulsa hasil pemetaan tetap sama
    actualDeg[j] -= off;                 // supaya feedback tidak melompat sesaat
    snprintf(ringkas, sizeof(ringkas),
             "J%d: sumbu sudut digeser %.1f deg, rentang jadi %.0f..%.0f",
             j + 1, -off, cal.servoAngMin[s], cal.servoAngMax[s]);
    *msg = ringkas;
    Serial.printf("[CAL] %s\n", ringkas);
    return true;
  }

  // --- Stepper: encoder kalau ada, counter kalau tidak ---
  int from = (joint < 0) ? 0 : joint;
  int to   = (joint < 0) ? NUM_STEPPER - 1 : joint;
  if (from < 0 || to >= NUM_STEPPER) { *msg = "joint di luar 1..6"; return false; }
  int nEnc = 0, nOpen = 0;
  for (int i = from; i <= to; i++) {
    float raw = NAN;
    if (ENC_ADA[i])
      for (int r = 0; r < 3 && isnan(raw); r++) raw = readAS5600Raw(ENC_CHANNEL[i]);
    // Magnet wajib diperiksa DI SINI juga, bukan cuma di loop kendali: chip
    // tanpa magnet menjawab dengan sempurna dan RAW ANGLE-nya tetap keluar,
    // sehingga offset yang diambil darinya adalah angka mengambang yang jadi
    // permanen begitu cal_save dipanggil. Kanalnya sudah dipilih oleh
    // readAS5600Raw() barusan. Perhatikan readAS5600Reg() memberi -1 saat
    // gagal, dan -1 & 0x20 bernilai benar, jadi st < 0 harus diuji terpisah.
    if (!isnan(raw)) {
      int st = readAS5600Reg(0x0B, false);
      if (st < 0 || !(st & 0x20)) {
        Serial.printf("[CAL] J%d MAGNET TIDAK TERDETEKSI (MD=0), "
                      "zero encoder ditolak\n", i + 1);
        raw = NAN;      // jatuh ke cabang open-loop di bawah
      }
    }
    if (!isnan(raw)) {
      cal.encOffsetDeg[i] = raw;
      nEnc++;
      Serial.printf("[CAL] J%d zero @ raw %.2f deg (encoder)\n", i + 1, raw);
    } else {
      // Encoder terdaftar tapi bisu diperlakukan sama dengan tidak ada: loop
      // kendali memang sudah pindah ke step counter lewat encFault, jadi
      // menggagalkan homing di sini cuma menghukum sendi yang sudah cacat.
      nOpen++;
      Serial.printf("[CAL] J%d zero: open-loop, counter di-nol-kan\n", i + 1);
    }
    if (steppers[i]) steppers[i]->setCurrentPosition(0);
    actualDeg[i] = 0;
    targetDeg[i] = 0;
  }
  snprintf(ringkas, sizeof(ringkas),
           "pose sekarang = 0 (%d encoder, %d open-loop)", nEnc, nOpen);
  *msg = ringkas;
  return true;
}

// ======================= KALIBRASI SERVO ==================================
#if SERVO_FEEDBACK

/* Burst sampling satu kanal ADS1115 pada 860 SPS untuk merekam step response
   servo. Ini satu satunya bagian kalibrasi servo yang WAJIB tinggal di
   firmware: pada 860 SPS jarak antar sampel 1,16 ms, dan tidak ada cara
   mengambilnya dari Python lewat WiFi karena satu round trip WebSocket saja
   sudah lebih lama dari itu. Sisa logikanya (analisis, keputusan) tetap di
   studio/perkakas, sesuai prinsip firmware = executor.

   Urutan: parkir di from_us -> diamkan settle_ms -> rekam pre_ms sebagai garis
   dasar -> lompat ke to_us -> rekam dur_ms. Hasil dikirim potongan demi
   potongan supaya tidak ada satu pesan WebSocket raksasa.

   Fase settle memanggil webSocket.loop() supaya koneksi tidak dianggap mati;
   fase rekam sengaja TIDAK, karena satu jeda saja merusak keseragaman jarak
   antar sampel yang jadi dasar hitungan kecepatan. */
#define CAP_MAX 1200          // 1200 sampel @860 SPS = 1,4 detik
static int16_t  capRaw[CAP_MAX];
static uint16_t capT[CAP_MAX];    // satuan 100 us sejak awal rekam

void handleServoCapture(uint8_t num, JsonDocument& doc) {
  int s = doc["servo"] | -1;
  if (s < 0 || s >= NUM_SERVO) { sendAck(num, "servo_capture", false, "servo di luar 0..2"); return; }
  if (!adsPresent)             { sendAck(num, "servo_capture", false, "ADS1115 tidak ada"); return; }

  int fromUs   = doc["from_us"]   | 1500;
  int toUs     = doc["to_us"]     | 1500;
  int settleMs = doc["settle_ms"] | 600;
  int preMs    = doc["pre_ms"]    | 80;
  int durMs    = doc["dur_ms"]    | 900;
  // Guardrail: pulsa di luar rentang servo hobi = benturan stop internal.
  if (fromUs < 400 || fromUs > 2600 || toUs < 400 || toUs > 2600) {
    sendAck(num, "servo_capture", false, "us di luar 400..2600"); return;
  }
  // Guardrail waktu: fase rekam memblokir loop(), jadi dibatasi jauh di bawah
  // task WDT (5 s) dan di bawah heartbeat WebSocket (3 s).
  settleMs = (int)clampf((float)settleMs, 0,  1500);
  preMs    = (int)clampf((float)preMs,    0,  200);
  durMs    = (int)clampf((float)durMs,    50, 1300);

  bool manualSebelum = servoManual[s];
  servoManual[s] = true;             // loop kendali jangan menimpa pulsa
  servoWriteUs(s, fromUs);

  uint32_t tSettle = millis();
  while (millis() - tSettle < (uint32_t)settleMs) {
    webSocket.loop();
    http.handleClient();
    delay(1);
  }

  // Continuous mode: konversi jalan sendiri pada 860 SPS, kita tinggal membaca
  // register hasil berulang kali tanpa memicu tiap konversi satu satu.
  uint16_t cfg = ADS_PGA_BITS | ADS_DR_860 | ADS_COMP_OFF |
                 ((uint16_t)(0x4 | (SERVO_FB_CH[s] & 0x3)) << 12);   // MODE=0
  if (!adsWriteConfig(cfg) || !adsPointConv()) {
    servoManual[s] = manualSebelum;
    sendAck(num, "servo_capture", false, "ADS1115 gagal masuk mode kontinu");
    return;
  }
  delay(2);

  int n = 0;
  uint32_t t0 = micros();
  uint32_t batasPre = (uint32_t)preMs * 1000UL;
  uint32_t batasTot = batasPre + (uint32_t)durMs * 1000UL;
  uint32_t tCmd = 0;
  bool sudahLompat = false;

  /* Pacing 1160 us = 1/860 SPS. Tanpa ini loop membaca register jauh lebih
     cepat daripada ADS1115 menghasilkan konversi baru, jadi sampel yang sama
     tercatat berkali kali: buffer 1200 habis dalam ~0,5 detik dan ekor gerakan
     servo tidak pernah terekam. Target waktu dihitung ulang dari dt (bukan
     ditambahkan ke target lama) supaya keterlambatan sesaat tidak dibalas
     ledakan pembacaan beruntun. */
  const uint32_t PERIODE_US = 1160;
  uint32_t berikut = 0;

  while (n < CAP_MAX) {
    uint32_t dt = micros() - t0;
    if (!sudahLompat && dt >= batasPre) {
      servoWriteUs(s, toUs);
      tCmd = micros() - t0;          // stempel waktu perintah, bukan asumsi
      sudahLompat = true;
    }
    if (dt >= batasTot) break;
    if (dt < berikut) continue;
    berikut = dt + PERIODE_US;
    int16_t v;
    if (adsReadConv(&v)) {           // pointer sudah di 0x00 sejak adsPointConv()
      capRaw[n] = v;
      capT[n]   = (uint16_t)(dt / 100);   // 100 us per hitungan
      n++;
    }
  }

  // Kembalikan ADS1115 ke single-shot round-robin seperti semula.
  adsCur = 0;
  adsStartSingle(SERVO_FB_CH[0], ADS_DR_128);
  adsDueMs = millis() + ADS_CONV_MS_128;
  servoManual[s] = manualSebelum;

  // Kirim bertahap. 100 sampel/pesan menahan tiap pesan di bawah ~1,3 KB.
  const int PER = 100;
  static char buf[1600];
  for (int i = 0; i < n; i += PER) {
    int akhir = (i + PER < n) ? i + PER : n;
    int p = snprintf(buf, sizeof(buf), "{\"type\":\"cap\",\"i\":%d,\"t\":[", i);
    for (int k = i; k < akhir && p < (int)sizeof(buf) - 16; k++)
      p += snprintf(buf + p, sizeof(buf) - p, "%s%u", k > i ? "," : "", capT[k]);
    p += snprintf(buf + p, sizeof(buf) - p, "],\"raw\":[");
    for (int k = i; k < akhir && p < (int)sizeof(buf) - 16; k++)
      p += snprintf(buf + p, sizeof(buf) - p, "%s%d", k > i ? "," : "", capRaw[k]);
    p += snprintf(buf + p, sizeof(buf) - p, "]}");
    if (p > 0 && p < (int)sizeof(buf)) webSocket.sendTXT(num, buf, p);
    webSocket.loop();
  }

  static char akhirBuf[256];
  int p = snprintf(akhirBuf, sizeof(akhirBuf),
      "{\"type\":\"cap_end\",\"servo\":%d,\"n\":%d,\"t_cmd\":%u,"
      "\"from_us\":%d,\"to_us\":%d,\"mv_per_lsb\":%.4f,\"penuh\":%s}",
      s, n, (unsigned)(tCmd / 100), fromUs, toUs, ADS_MV_PER_LSB,
      n >= CAP_MAX ? "true" : "false");
  if (p > 0 && p < (int)sizeof(akhirBuf)) webSocket.sendTXT(num, akhirBuf, p);
}

// {"cmd":"servo_read","n":k} : k kali oversample tiap kanal, blocking.
// Melaporkan simpangan baku juga, karena tanpa itu tidak ada cara membedakan
// "servo diam di titik X" dari "pembacaan berisik yang kebetulan rata rata X".
void handleServoRead(uint8_t num, JsonDocument& doc) {
  int N = doc["n"] | 16;
  N = (int)clampf((float)N, 1, 64);
  if (!adsPresent) { sendAck(num, "servo_read", false, "ADS1115 tidak ada"); return; }

  static char buf[512];
  int p = snprintf(buf, sizeof(buf), "{\"type\":\"servo\",\"ch\":[");
  for (int s = 0; s < NUM_SERVO; s++) {
    double jml = 0, jmlKuadrat = 0;
    int ok = 0;
    for (int k = 0; k < N; k++) {
      int16_t v;
      if (!adsReadChannel(SERVO_FB_CH[s], &v)) continue;
      double mv = adsRawToMv(v);
      jml += mv; jmlKuadrat += mv * mv; ok++;
      if (mv >= ADS_SATURASI_MV) adsSatPernah[s] = true;
    }
    double rata = ok ? jml / ok : 0;
    double varian = ok > 1 ? (jmlKuadrat / ok - rata * rata) : 0;
    if (varian < 0) varian = 0;      // pembulatan bisa membuatnya negatif tipis
    p += snprintf(buf + p, sizeof(buf) - p,
        "%s{\"nama\":\"%s\",\"ok\":%d,\"mv\":%.3f,\"sd\":%.3f,\"us\":%d,\"sat\":%s}",
        s ? "," : "", SERVO_NAMA[s], ok, rata, sqrt(varian), servoUsNow[s],
        adsSatPernah[s] ? "true" : "false");
  }
  p += snprintf(buf + p, sizeof(buf) - p, "]}");
  if (p > 0 && p < (int)sizeof(buf)) webSocket.sendTXT(num, buf, p);
  // Round-robin dimulai ulang: pembacaan blocking di atas meninggalkan ADS1115
  // pada kanal terakhir, bukan pada kanal yang sedang ditunggu state machine.
  adsCur = 0;
  adsStartSingle(SERVO_FB_CH[0], ADS_DR_128);
  adsDueMs = millis() + ADS_CONV_MS_128;
}
#endif  // SERVO_FEEDBACK

void handleText(uint8_t num, uint8_t* payload, size_t length) {
  StaticJsonDocument<1536> doc;
  if (deserializeJson(doc, payload, length)) return;   // JSON rusak -> abaikan

  const char* cmd = doc["cmd"] | "";

  if (strcmp(cmd, "goto") == 0) {
#if !ESTOP_AUTO_RESUME
    /* Sampai 13 Agu 2026 cabang ini menulis targetDeg tanpa melihat estop.
       Lengan memang tidak bergerak saat itu (loop kendali dilewati), tapi
       targetnya TERSIMPAN, dan {"cmd":"resume"} berikutnya menjalankannya
       seketika. Operator menekan RESET mengira melepas rem, yang didapat gerak
       besar tiba tiba menuju pose yang dikirim entah kapan selama e-stop.
       Perintah gerak selama e-stop sekarang ditolak, bukan diantre. */
    if (estop) { sendAck(num, cmd, false, "e-stop aktif, goto ditolak"); return; }
#endif
    // Tahap output driver mati (mis. rail VM belum menyala): step counter tidak
    // boleh dijalankan menjauh dari posisi fisik yang tidak berubah.
    if (tmcDown) { sendAck(num, cmd, false, "driver belum siap, goto ditolak"); return; }

    JsonArray a = doc["angles"].as<JsonArray>();
    if (a.isNull()) return;
    int n = 0;
    for (JsonVariant v : a) {
      if (n >= NUM_JOINTS) break;
      // Guardrail input: hanya angka finite, lalu clamp ke joint limit.
      if (v.is<float>()) {
        float f = v.as<float>();
        if (isfinite(f)) targetDeg[n] = clampf(f, cal.jointMin[n], cal.jointMax[n]);
      }
      n++;
    }
    // Tiap sendi punya drivernya sendiri, jadi pose enam sendi sekaligus
    // langsung dieksekusi apa adanya: tidak ada kanal yang harus diklaim dulu
    // dan tidak ada sendi yang perlu menunggu giliran.
#if ESTOP_AUTO_RESUME
    if (estop) applyEstop(false);   // kompatibel UI lama: gerak baru melepas e-stop
#endif

  } else if (strcmp(cmd, "estop") == 0) {
    applyEstop(true);
    sendAck(num, cmd, true, "e-stop aktif");

  } else if (strcmp(cmd, "resume") == 0) {
    /* Target disamakan dengan posisi nyata SEBELUM arus kembali. Selama e-stop
       tahap output mati dan J2/J3 tidak self-locking, jadi lengan bisa melorot
       atau digeser tangan. Tanpa sinkronisasi ini, melepas e-stop berarti
       memerintahkan lengan kembali ke target lama secepat profil kecepatan
       mengizinkan, dan itu justru gerak paling tidak diduga di seluruh sesi. */
    syncSteppersFromEncoders();
    applyEstop(false);
    sendAck(num, cmd, true, "e-stop dilepas, target disamakan dgn posisi sekarang");

  } else if (strcmp(cmd, "nada") == 0 || strcmp(cmd, "sweep") == 0) {
    // Blocking beberapa ratus ms sampai ~1,4 detik. Sengaja: memotong nada jadi
    // potongan non-blocking akan terdengar patah patah, dan durasinya sudah
    // dibatasi jauh di bawah timeout heartbeat WebSocket (3 s) maupun loop WDT.
    bool sweep = (strcmp(cmd, "sweep") == 0);
    int j = doc["joint"] | 1;
    const char* err = "";
    bool ok = mainkanSuara(j - 1, doc["hz"] | 440, doc["ms"] | 400, sweep, &err);
    sendAck(num, cmd, ok, ok ? "selesai" : err);

  } else if (strcmp(cmd, "cal_get") == 0) {
    sendCal(num);

  } else if (strcmp(cmd, "cal_set") == 0) {
    const char* err = "";
    bool ok = handleCalSet(doc, &err);
    sendAck(num, cmd, ok, ok ? "diterapkan (RAM, belum disimpan)" : err);

  } else if (strcmp(cmd, "cal_zero") == 0) {
    // Pesan ack diisi handleCalZero baik saat sukses maupun gagal: yang perlu
    // diketahui pemakai bukan cuma berhasil atau tidak, tapi CARA sendi itu
    // di-nol-kan (encoder, open-loop, atau geser sumbu sudut servo).
    const char* msg = "";
    bool ok;
    if (doc["joint"].isNull()) {
      ok = handleCalZero(-1, &msg);            // semua stepper J1..J4
    } else {
      int jv = doc["joint"].as<int>();         // 1-based (J1..J6)
      if (jv < 1 || jv > NUM_JOINTS) { ok = false; msg = "joint di luar 1..6"; }
      else ok = handleCalZero(jv - 1, &msg);
    }
    sendAck(num, cmd, ok, msg);

  } else if (strcmp(cmd, "cal_save") == 0) {
    bool ok = calSave();
    sendAck(num, cmd, ok, ok ? "tersimpan di NVS" : "gagal tulis NVS");

  } else if (strcmp(cmd, "cal_reset") == 0) {
    calErase();
    calDefaults();
    // Rasio & microstep ikut kembali default -> perlakukan seperti ratio
    // berubah: recompute + re-sync counter dari sudut aktual (tanpa gerak
    // mendadak), lalu dorong ulang setting chopper ke driver.
    recomputeStepsPerDeg();
    for (int i = 0; i < NUM_STEPPER; i++) {
      if (steppers[i])
        steppers[i]->setCurrentPosition((int32_t)(actualDeg[i] * STEPS_PER_DEG[i]));
      targetDeg[i] = actualDeg[i];
    }
    applyMotionLimits();
#if USE_TMC_UART
    tmcApply();
#endif
    sendAck(num, cmd, true, "kalibrasi default (NVS dihapus)");

  } else if (strcmp(cmd, "diag") == 0) {
    sendDiag(num);

  } else if (strcmp(cmd, "i2c_scan") == 0) {
    sendI2CScan(num);

  } else if (strcmp(cmd, "gripper") == 0) {
    float d = doc["deg"] | NAN;
    if (!isfinite(d)) { sendAck(num, cmd, false, "deg bukan angka"); return; }
    gripTargetDeg = clampf(d, cal.servoAngMin[SERVO_GRIP], cal.servoAngMax[SERVO_GRIP]);
    gripMulaiDorong();                 // torsi dilepas otomatis, lihat AUTO-LEMAS
    sendAck(num, cmd, true, "target gripper diterima");

  } else if (strcmp(cmd, "grip_limits") == 0) {
    /* Sempitkan rentang kerja gripper ke batas yang benar benar bisa ditempuh
       rahang terpasang. Perhitungannya ADA DI SINI, bukan di halaman web,
       karena sudut, pulsa, dan mV wajib digeser BERSAMA.

       Kalau hanya servo_ang_min/max yang ditulis, pemetaan sudut ke pulsa ikut
       meregang: rentang kerja yang sempit itu terbentang ke seluruh span pulsa,
       dan perintah "buka" justru mendorong servo jauh melewati stop fisiknya.
       Persis kebalikan dari maksud menyempitkan batas. */
    const int G = SERVO_GRIP;
    float lo = doc["min"] | NAN, hi = doc["max"] | NAN;
    if (!isfinite(lo) || !isfinite(hi)) { sendAck(num, cmd, false, "min/max bukan angka"); return; }
    if (lo >= hi) { sendAck(num, cmd, false, "min harus lebih kecil dari max"); return; }
    float angLo = cal.servoAngMin[G], angHi = cal.servoAngMax[G];
    float span = angHi - angLo;
    if (span <= 0) { sendAck(num, cmd, false, "kerangka sudut gripper rusak"); return; }
    // Batas baru harus DI DALAM kerangka yang berlaku sekarang. Di luar itu
    // artinya menebak posisi yang belum pernah diukur.
    if (lo < angLo || hi > angHi) { sendAck(num, cmd, false, "di luar travel terkalibrasi"); return; }

    float tLo = (lo - angLo) / span, tHi = (hi - angLo) / span;
    int usLo = (int)roundf(cal.servoUsMin[G] + tLo * (cal.servoUsMax[G] - cal.servoUsMin[G]));
    int usHi = (int)roundf(cal.servoUsMin[G] + tHi * (cal.servoUsMax[G] - cal.servoUsMin[G]));
    if (usHi - usLo < 50) { sendAck(num, cmd, false, "rentang pulsa hasilnya di bawah 50 us"); return; }
    int mvLo = (int)roundf(cal.servoFbMvMin[G] + tLo * (cal.servoFbMvMax[G] - cal.servoFbMvMin[G]));
    int mvHi = (int)roundf(cal.servoFbMvMin[G] + tHi * (cal.servoFbMvMax[G] - cal.servoFbMvMin[G]));

    cal.servoAngMin[G]  = lo;             cal.servoAngMax[G]  = hi;
    cal.servoUsMin[G]   = (int16_t)usLo;  cal.servoUsMax[G]   = (int16_t)usHi;
    cal.servoFbMvMin[G] = (int16_t)mvLo;  cal.servoFbMvMax[G] = (int16_t)mvHi;
    // Titik tengah wajib tetap di dalam min..max, kalau tidak handleCalSet
    // berikutnya menolak seluruh kalibrasi dengan "us_center di luar min..max".
    cal.servoUsCenter[G] = (int16_t)clampf((float)cal.servoUsCenter[G], (float)usLo, (float)usHi);
    gripTargetDeg = clampf(gripTargetDeg, lo, hi);

    char msg[104];
    snprintf(msg, sizeof(msg),
             "gripper %.1f..%.1f deg = %d..%d us (RAM, cal_save utk permanen)",
             lo, hi, usLo, usHi);
    sendAck(num, cmd, true, msg);

  } else if (strcmp(cmd, "servo_center") == 0) {
    // Semua servo ke titik tengah TERUKUR, dan mode manual dilepas supaya
    // loop kendali kembali memegang kendali setelah sesi kalibrasi.
    for (int s = 0; s < NUM_SERVO; s++) {
      servoManual[s] = false;
      int j = SERVO_JOINT[s];
      // Target logis ikut digeser ke tengah, kalau tidak loop kendali langsung
      // menarik servo balik ke target lama begitu mode manual dilepas.
      float t = 0.5f * (cal.servoAngMin[s] + cal.servoAngMax[s]);
      if (j >= 0) targetDeg[j] = t; else gripTargetDeg = t;
      servoWriteUs(s, cal.servoUsCenter[s]);
    }
    // Gripper tetap tunduk pada auto-lemas: dia boleh berjalan ke tengah, tapi
    // tidak boleh ditinggal menahan di situ.
    gripMulaiDorong();
    sendAck(num, cmd, true, "semua servo ke titik tengah");

#if SERVO_FEEDBACK
  } else if (strcmp(cmd, "servo_us") == 0) {
    int s  = doc["servo"] | -1;
    int us = doc["us"] | -1;
    if (s < 0 || s >= NUM_SERVO)  { sendAck(num, cmd, false, "servo di luar 0..2"); return; }
    if (us < 400 || us > 2600)    { sendAck(num, cmd, false, "us di luar 400..2600"); return; }
    servoManual[s] = true;
    servoWriteUs(s, us);
    sendAck(num, cmd, true, "pulsa mentah diterapkan (mode manual)");

  } else if (strcmp(cmd, "servo_limp") == 0) {
    // Hentikan pulsa supaya servo bebas diputar tangan. Mode manual ikut
    // dinyalakan, kalau tidak loop kendali langsung menulis pulsa lagi di
    // putaran berikutnya dan servo mengeras sebelum tangan sempat menyentuhnya.
    int s = doc["servo"] | -1;
    if (s < 0 || s >= NUM_SERVO) { sendAck(num, cmd, false, "servo di luar 0..2"); return; }
    servoLepas(s);
    if (s == SERVO_GRIP) gripDriving = false;   // batalkan sesi dorong berjalan
    sendAck(num, cmd, true, "servo lemas, bebas diputar tangan");

  } else if (strcmp(cmd, "servo_auto") == 0) {
    if (doc["servo"].isNull()) {
      for (int s = 0; s < NUM_SERVO; s++) servoManual[s] = false;
    } else {
      int s = doc["servo"].as<int>();
      if (s < 0 || s >= NUM_SERVO) { sendAck(num, cmd, false, "servo di luar 0..2"); return; }
      servoManual[s] = false;
    }
    sendAck(num, cmd, true, "mode manual dilepas");

  } else if (strcmp(cmd, "servo_read") == 0) {
    handleServoRead(num, doc);

  } else if (strcmp(cmd, "servo_capture") == 0) {
    handleServoCapture(num, doc);
#endif

#if USE_HX711
  } else if (strcmp(cmd, "load_tare") == 0) {
    float avg;
    if (hx711Average(&avg, 4)) {
      cal.loadOffset = avg;
      sendAck(num, cmd, true, "tare OK (RAM, cal_save utk permanen)");
    } else sendAck(num, cmd, false, "load cell tak terbaca");

  } else if (strcmp(cmd, "load_scale") == 0) {
    float grams = doc["grams"] | 0.0f;
    float avg;
    if (!(grams >= 1.0f && grams <= 20000.0f)) {
      sendAck(num, cmd, false, "grams di luar 1..20000");
    } else if (!hx711Average(&avg, 4)) {
      sendAck(num, cmd, false, "load cell tak terbaca");
    } else if (fabs(avg - cal.loadOffset) < 100.0f) {
      // Guardrail div/0 + salah urutan pakai: delta counts terlalu kecil.
      sendAck(num, cmd, false, "beban tak terdeteksi (tare dulu, lalu taruh massa)");
    } else {
      cal.loadScale = (avg - cal.loadOffset) / grams;
      sendAck(num, cmd, true, "skala OK (RAM, cal_save utk permanen)");
    }
#endif

  } else {
    sendAck(num, cmd[0] ? cmd : "?", false, "command tak dikenal");
  }
}

void onWsEvent(uint8_t num, WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED: {
      IPAddress ip = webSocket.remoteIP(num);
      Serial.printf("[WS] klien #%u tersambung dari %s\n", num, ip.toString().c_str());
      break;
    }
    case WStype_DISCONNECTED:
      // Dead-man TIDAK dipasang di sini: cacah klien saat event ini dipancarkan
      // bergantung pada urutan internal pustaka. Penghitungannya ada di loop(),
      // lihat blok WS_DEADMAN_MS.
      Serial.printf("[WS] klien #%u putus\n", num);
      break;
    case WStype_TEXT:
      handleText(num, payload, length);
      break;
    default:
      break;
  }
}

// ======================= WIFI =============================================

// Jadi Access Point, dipakai WIFI_FORCE_AP, atau fallback saat semua preset
// gagal (guardrail: ESP32 tidak boleh unreachable). Bertahan sampai reboot,
// supaya koneksi klien stabil (AP+STA scan bikin channel loncat, klien drop).
// Daya pancar WiFi. Default penuh 19.5 dBm; turunkan (mis. WIFI_POWER_11dBm)
// hanya kalau ada alasan jangkauan/termal, BUKAN sebagai obat brownout.
//
// Catatan hasil bench 2026-07-31, supaya tidak dicoba ulang sia-sia: board
// bench brownout DI DALAM WiFi.mode() sendiri, saat PHY radio dinyalakan.
// setTxPower() wajib dipanggil SETELAH WiFi.mode() (sebelum itu radio belum
// diinisialisasi dan panggilannya ditolak), jadi menurunkannya tidak pernah
// sempat berlaku dan sama sekali tidak menolong. Obat brownout ada di catu
// daya: 5V >=2 A ke pin V5, bukan di sini.
#define WIFI_TX_POWER WIFI_POWER_19_5dBm

void applyWifiTxPower() {
  WiFi.setTxPower(WIFI_TX_POWER);
  Serial.printf("[WiFi] daya pancar %d (skala 0.25 dBm; 78 = 19.5 dBm penuh)\n",
                (int)WiFi.getTxPower());
}

void startAP(const char* why) {
  runningAsAP = true;
  WiFi.mode(WIFI_AP);
  applyWifiTxPower();
  WiFi.softAP(AP_SSID, AP_PASS);
  Serial.printf("[WiFi] %s -> Access Point '%s' aktif. Web -> ws://%s:%u\n",
                why, AP_SSID, WiFi.softAPIP().toString().c_str(), WS_PORT);
  Serial.println("[WiFi] (mode AP bertahan sampai reboot; reboot utk coba STA lagi)");
}

void setupWiFi() {
#if WIFI_FORCE_AP
  startAP("WIFI_FORCE_AP");
#else
  WiFi.mode(WIFI_STA);
  applyWifiTxPower();
  // Guardrail: putus di tengah operasi -> auto-reconnect ke AP terakhir + mDNS
  // daftar ulang; kalau AP-nya hilang total, loop() mencoba ulang SEMUA preset.
  WiFi.setAutoReconnect(true);
  WiFi.onEvent([](WiFiEvent_t, WiFiEventInfo_t) {
    Serial.println("[WiFi] putus, mencoba reconnect...");
  }, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);
  WiFi.onEvent([](WiFiEvent_t, WiFiEventInfo_t) {
    Serial.printf("[WiFi] IP: %s (SSID '%s')\n",
                  WiFi.localIP().toString().c_str(), WiFi.SSID().c_str());
    MDNS.end();
    if (MDNS.begin(MDNS_NAME)) {
      MDNS.addService("ws", "tcp", WS_PORT);
      MDNS.addService("http", "tcp", HTTP_PORT);   // -> http://armbot.local/
    }
  }, ARDUINO_EVENT_WIFI_STA_GOT_IP);

  const int nPreset = sizeof(WIFI_PRESETS) / sizeof(WIFI_PRESETS[0]);
  for (int i = 0; i < nPreset; i++) wifiMulti.addAP(WIFI_PRESETS[i].ssid, WIFI_PRESETS[i].pass);
  Serial.printf("[WiFi] mencoba %d preset (pilih sinyal terkuat)", nPreset);

  uint32_t t0 = millis();
  while (wifiMulti.run() != WL_CONNECTED && millis() - t0 < WIFI_STA_TIMEOUT_MS) {
    delay(300);
    Serial.print('.');
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[WiFi] tersambung ke '%s'. Web -> ws://%s:%u (atau ws://%s.local:%u)\n",
                  WiFi.SSID().c_str(), WiFi.localIP().toString().c_str(),
                  WS_PORT, MDNS_NAME, WS_PORT);
  } else {
    startAP("semua preset gagal");
  }
#endif
}

// ======================= SUARA: NADA & SWEEP ==============================
// Bunyi "robot" yang orang kenal dari A4988 itu sebenarnya bunyi chopper di
// microstep rendah. TMC2209 dengan stealthChop nyaris senyap, jadi untuk demo
// bunyi itu harus dibuat sengaja: pulsa STEP di frekuensi audio dengan arah
// dibalik tiap beberapa step, supaya rotor bergetar di tempat dan sudut sendi
// tidak berpindah. Diporting dari playTone()/chirp() di firmware/tmc_bench.
//
// FastAccelStepper MEMILIKI pin STEP lewat RMT/MCPWM, jadi pin itu wajib
// dilepas dulu (detachFromPin) sebelum di-bit-bang lalu dikembalikan. Tanpa
// itu digitalWrite tidak akan terlihat sama sekali di pin: yang men-drive pad
// bukan register GPIO, tapi peripheral.
const uint32_t NADA_HZ_MIN = 40, NADA_HZ_MAKS = 4000;
const uint32_t NADA_MS_MAKS = 1500;   // loop() berhenti selama nada, jangan lama

static void nadaPulsa(uint8_t d, uint32_t hz, uint32_t ms, uint16_t swing) {
  uint32_t half  = 500000UL / hz;              // setengah periode, us
  uint32_t total = (uint64_t)hz * ms / 1000;
  bool dir = false;
  uint16_t n = 0;
  digitalWrite(DIR_PIN[d], dir);
  for (uint32_t i = 0; i < total; i++) {
    digitalWrite(STEP_PIN[d], HIGH);
    delayMicroseconds(half);
    digitalWrite(STEP_PIN[d], LOW);
    delayMicroseconds(half);
    if (++n >= swing) { n = 0; dir = !dir; digitalWrite(DIR_PIN[d], dir); }
  }
}

bool mainkanSuara(int j, uint32_t hz, uint32_t ms, bool sweep, const char** err) {
  if (estop)                     { *err = "e-stop aktif, lepas dulu"; return false; }
  if (j < 0 || j >= NUM_STEPPER) { *err = "joint harus 1..4";         return false; }
  if (!sweep && (hz < NADA_HZ_MIN || hz > NADA_HZ_MAKS)) { *err = "hz 40..4000"; return false; }
  if (ms > NADA_MS_MAKS) ms = NADA_MS_MAKS;

  const int d = j;                       // satu driver per sendi
  FastAccelStepper* st = steppers[d];
  if (!st) { *err = "stepper sendi ini tidak aktif"; return false; }

  st->forceStop();
  int32_t posAwal = st->getCurrentPosition();
  st->detachFromPin();
  pinMode(STEP_PIN[d], OUTPUT); digitalWrite(STEP_PIN[d], LOW);
  pinMode(DIR_PIN[d], OUTPUT);

  if (sweep) {   // naik lalu turun: ini yang bikin bunyi "robot" khas
    for (uint32_t f = 200; f < 2000; f += 40) nadaPulsa(d, f, 18, 8);
    for (uint32_t f = 2000; f > 200; f -= 40) nadaPulsa(d, f, 12, 8);
  } else {
    nadaPulsa(d, hz, ms, 8);
  }

  st->reAttachToPin();
  // Arah dibalik simetris tiap `swing` step, jadi rotor kembali ke titik awal.
  // Counter tetap dipulihkan eksplisit supaya sisa step ganjil tidak menumpuk
  // jadi galat posisi yang diam-diam membesar tiap kali tombol suara ditekan.
  st->setCurrentPosition(posAwal);
  return true;
}

// ======================= HALAMAN KONTROL BAWAAN (HTTP :80) ================
// Latar lengkap di webui.h. Ringkasnya: demo tidak boleh bergantung pada Arm
// Studio yang belum full fungsional, jadi ESP32 menyajikan pengendali minimum
// sendiri di port 80. Halaman itu memakai WebSocket :81 yang SAMA dengan
// studio, jadi tidak ada protokol kedua yang harus dirawat, dan keduanya bisa
// tersambung berbarengan.

// Nomor pin sengaja dilaporkan dari konstanta firmware, bukan ditulis ulang di
// HTML: yang ditunjukkan ke orang lain harus tidak mungkin basi terhadap kode.
void handleApiInfo() {
#if USE_TMC_UART
  const int uartTx = TMC_TX2, uartRx = TMC_RX2;
#else
  const int uartTx = -1, uartRx = -1;
#endif
  // Dirakit ke buffer STATIS, bukan JsonDocument di stack: loopTask ESP32 cuma
  // 8 KB dan dokumen JSON besar di stack pernah menyebabkan stack overflow.
  // Dirakit lewat loop supaya tidak mungkin membaca di luar batas array kalau
  // NUM_STEPPER berubah.
  char stepArr[40] = "", dirArr[40] = "";
  for (int i = 0; i < NUM_STEPPER; i++) {
    snprintf(stepArr + strlen(stepArr), sizeof(stepArr) - strlen(stepArr),
             "%s%u", i ? "," : "", STEP_PIN[i]);
    snprintf(dirArr + strlen(dirArr), sizeof(dirArr) - strlen(dirArr),
             "%s%u", i ? "," : "", DIR_PIN[i]);
  }

  static char buf[820];
  String ip = runningAsAP ? WiFi.softAPIP().toString() : WiFi.localIP().toString();
  int n = snprintf(buf, sizeof(buf),
    "{\"mode\":\"%s\",\"ip\":\"%s\",\"ws_port\":%u,"
    "\"num_driver\":%u,\"num_stepper\":%u,"
    "\"drv_step\":[%s],\"drv_dir\":[%s],"
    "\"en_pin\":%u,\"servo_pin\":[%u,%u,%u],\"servo_us\":[%d,%d,%d,%d,%d,%d],"
    "\"uart_tx\":%d,\"uart_rx\":%d,\"tmc_conn\":[%u,%u,%u,%u],"
    "\"i2c_sda\":%u,\"i2c_scl\":%u}",
    runningAsAP ? "Access Point" : "WiFi STA", ip.c_str(), WS_PORT,
    NUM_STEPPER, NUM_STEPPER,
    stepArr, dirArr,
    EN_PIN, SERVO_PIN[0], SERVO_PIN[1], SERVO_PIN[2],
    cal.servoUsMin[0], cal.servoUsMax[0], cal.servoUsMin[1], cal.servoUsMax[1],
    cal.servoUsMin[2], cal.servoUsMax[2],
    uartTx, uartRx,
    tmcConn[0], tmcConn[1], tmcConn[2], tmcConn[3],
    I2C_SDA, I2C_SCL);
  if (n <= 0 || n >= (int)sizeof(buf)) { http.send(500, "text/plain", "info overflow"); return; }
  http.send(200, "application/json", buf);
}

void setupHttp() {
  http.on("/", HTTP_GET, []() {
    http.sendHeader("Cache-Control", "no-store");
    http.send_P(200, "text/html", WEBUI_HTML);
  });
  http.on("/api/info", HTTP_GET, handleApiInfo);
  // Apa pun yang nyasar diarahkan ke halaman kontrol: saat demo, salah ketik
  // alamat tidak boleh berakhir di layar 404 kosong.
  http.onNotFound([]() {
    http.sendHeader("Location", "/");
    http.send(302, "text/plain", "");
  });
  http.begin();
}

// ======================= SETUP & LOOP =====================================

void setup() {
  Serial.begin(115200);
  Wire.begin(I2C_SDA, I2C_SCL);
  Wire.setTimeOut(I2C_TIMEOUT_MS);   // bus macet != loop beku (guardrail)

  pinMode(EN_PIN, OUTPUT);
  digitalWrite(EN_PIN, HIGH);  // driver TETAP off sampai akhir setup

  // Kalibrasi: NVS bila valid, kalau tidak default compile-time.
  calDefaults();
  if (calLoad()) Serial.println("[CAL] kalibrasi dimuat dari NVS");
  else           Serial.println("[CAL] kalibrasi default (NVS kosong/beda versi)");

  // Probe mux TCA9548A: tak terdeteksi -> mode bench AS5600 tunggal (J1 saja),
  // J2..J4 langsung open-loop daripada 4 joint membaca chip yang sama.
  Wire.beginTransmission(TCA9548A_ADDR);
  muxPresent = (Wire.endTransmission() == 0);
  if (!muxPresent)
    Serial.println("[I2C] TCA9548A tidak terdeteksi -> mode bench: "
                   "AS5600 tunggal di bus (J1 saja, J2-J4 open-loop)");

  // FastAccelStepper: satu kanal RMT/MCPWM per sendi. ESP32 menyediakan cukup
  // kanal untuk keempatnya; kalau ada yang gagal connect, sendi itu tetap
  // dilaporkan tetapi tidak akan bergerak, jadi kegagalannya harus kelihatan
  // di log boot dan bukan muncul belakangan sebagai "sendi kok diam saja".
  engine.init();
  recomputeStepsPerDeg();   // dari cal.ratio (NVS/default), bukan RATIO[] statis
  for (int i = 0; i < NUM_STEPPER; i++) {
    steppers[i] = engine.stepperConnectToPin(STEP_PIN[i]);
    if (steppers[i]) {
      steppers[i]->setDirectionPin(DIR_PIN[i]);
    } else {
      Serial.printf("[STEP] J%d gagal connect (kanal RMT/MCPWM habis?)\n", i + 1);
    }
  }
  Serial.printf("[STEP] %d sendi stepper, satu driver masing-masing\n", NUM_STEPPER);
  applyMotionLimits();

  ESP32PWM::allocateTimer(0);
  ESP32PWM::allocateTimer(1);
  for (int i = 0; i < NUM_SERVO; i++) {
    // Tarik LOW dulu: GPIO4 (gripper) mengambang sejak reset, dan jalur yang
    // mengambang bisa menangkap pulsa liar sebelum LEDC mengambil alih pin.
    pinMode(SERVO_PIN[i], OUTPUT);
    digitalWrite(SERVO_PIN[i], LOW);
    servos[i].setPeriodHertz(50);
    servos[i].attach(SERVO_PIN[i], 500, 2500);
    // Pose default = TITIK TENGAH hasil kalibrasi, bukan 0 derajat. Sebelum
    // dikalibrasi nilainya 1500 us (netral standar). Alasannya: 0 derajat lewat
    // servoAngleToUs() bergantung pada servoAngMin/Max yang belum tentu sudah
    // benar, sedangkan titik tengah adalah satu-satunya pose yang dijamin ada
    // di dalam travel servo, jadi lengan tidak pernah boot ke ujung stall.
    servoWriteUs(i, cal.servoUsCenter[i]);
  }
  gripTargetDeg = 0.5f * (cal.servoAngMin[SERVO_GRIP] + cal.servoAngMax[SERVO_GRIP]);
  // Pose boot pun tunduk auto-lemas. Tanpa baris ini gripDriving tetap false,
  // loop kendali menulis pulsa tiap putaran, dan gripper ditahan SELAMANYA
  // sejak menyala tanpa ada satu pun perintah masuk. Justru kondisi paling
  // lama yang bisa membakar servo, karena tidak ada yang menyadarinya.
  gripMulaiDorong();

#if SERVO_FEEDBACK
  // Probe ADS1115. Tidak terdeteksi bukan alasan berhenti: firmware jalan terus
  // dengan sudut servo = sudut perintah, dan kondisi itu dilaporkan apa adanya
  // di diag (ads.ok) supaya tidak ada angka yang tampak seperti hasil ukur.
  Wire.beginTransmission(ADS_ADDR);
  adsPresent = (Wire.endTransmission() == 0);
  if (adsPresent) {
    Serial.println("[ADS] ADS1115 0x48 terdeteksi (A0=J5, A1=J6, A2=gripper)");
    for (int i = 0; i < NUM_SERVO; i++) {
      int16_t v;
      if (adsReadChannel(SERVO_FB_CH[i], &v)) {
        adsRaw[i] = v; adsOk[i] = true;
        float mv = adsRawToMv(v);
        if (mv >= ADS_SATURASI_MV) adsSatPernah[i] = true;
        Serial.printf("[ADS] %s A%d = %.1f mV (raw %d)%s\n",
                      SERVO_NAMA[i], SERVO_FB_CH[i], mv, v,
                      mv >= ADS_SATURASI_MV ? "  *** SATURASI, wiper > 3,15 V ***" : "");
      } else {
        Serial.printf("[ADS] %s A%d GAGAL dibaca\n", SERVO_NAMA[i], SERVO_FB_CH[i]);
      }
    }
    adsCur = 0;
    adsStartSingle(SERVO_FB_CH[0], ADS_DR_128);
    adsDueMs = millis() + ADS_CONV_MS_128;
  } else {
    Serial.println("[ADS] ADS1115 TIDAK terdeteksi di 0x48 -> sudut servo = sudut perintah");
  }
#endif

#if USE_TMC_UART
  setupTMC();
#endif

#if USE_HX711
  setupHX711();
#endif

  // Guardrail boot: posisi & target awal = pembacaan encoder absolut,
  // bukan 0 -> tidak ada gerak menyentak saat driver di-enable.
  syncSteppersFromEncoders();
  // Lewat enUpdate(), bukan digitalWrite langsung: kalau setupTMC() tidak bisa
  // memverifikasi keempat driver (mis. PSU 12 V belum dinyalakan), tahap output
  // tetap mati dan tmcHealthTick() yang akan menyalakannya begitu driver benar
  // benar menjawab.
  enUpdate();

  setupWiFi();
  webSocket.begin();
  // Guardrail socket zombie: ping tiap 3 dtk, 2x pong hilang -> klien diputus.
  // Tanpa ini TCP stuck bisa menimbun perintah lalu membanjirkannya sekaligus
  // ("robot reog"); di sisi web ada watchdog kebalikannya (bridge.js).
  webSocket.enableHeartbeat(3000, 1500, 2);
  webSocket.onEvent(onWsEvent);
  Serial.println("[WS] server WebSocket aktif (heartbeat 3s).");

  setupHttp();
  Serial.printf("[WEB] halaman kontrol -> http://%s/  (buka dari HP/laptop sejaringan)\n",
                (runningAsAP ? WiFi.softAPIP() : WiFi.localIP()).toString().c_str());

  // Guardrail hang: loop() macet (I2C/WiFi/lib) -> task WDT reboot ESP32.
  // Aman: EN_PIN strapping GPIO5 = driver off selama boot berikutnya.
  enableLoopWDT();
}

void loop() {
  webSocket.loop();
  http.handleClient();

  /* Dead-man klien. Dihitung di sini, bukan di WStype_DISCONNECTED, supaya
     tidak bergantung pada apakah pustaka sudah mengurangi cacahnya saat event
     itu dipancarkan. Pembekuan sengaja lewat ramp (stopMove), bukan forceStop:
     ini bukan e-stop, cuma "tidak ada lagi yang menonton". */
  {
    uint8_t klien = webSocket.connectedClients();
    if (klien > 0) {
      wsEverConn = true;
      wsEmptySince = 0;
      if (wsFreeze) {          // ada yang menonton lagi: mulai dari posisi nyata
        wsFreeze = false;
        syncSteppersFromEncoders();
        Serial.println("[WS] klien kembali, pembekuan dead-man dilepas.");
      }
    } else if (wsEverConn && !wsFreeze) {
      if (!wsEmptySince) wsEmptySince = millis();
      else if (millis() - wsEmptySince > WS_DEADMAN_MS) {
        wsFreeze = true;
        for (int i = 0; i < NUM_STEPPER; i++)
          if (steppers[i]) steppers[i]->stopMove();
        Serial.printf("[WS] tidak ada klien selama %d ms: gerak dibekukan "
                      "(dead-man).\n", WS_DEADMAN_MS);
      }
    }
  }

#if USE_TMC_UART
  // Driver diperiksa berkala, bukan cuma saat boot: setelan chopper tidak
  // bertahan melewati matinya rail VM. Lihat catatan di deklarasi tmcDown.
  tmcHealthTick();
#endif

#if !WIFI_FORCE_AP
  // Guardrail WiFi: STA hilang & auto-reconnect (SSID lama) belum berhasil ->
  // tiap 15 dtk coba ulang SEMUA preset (mis. bench pindah jangkauan WiFi lain).
  // wifiMulti.run() blocking beberapa detik -> loopWDT dimatikan sementara
  // supaya percobaan reconnect tidak dihitung sebagai hang.
  if (!runningAsAP && WiFi.status() != WL_CONNECTED &&
      millis() - lastWifiRetry > 15000) {
    lastWifiRetry = millis();
    disableLoopWDT();
    wifiMulti.run(6000);
    enableLoopWDT();
  }
#endif

#if USE_HX711
  pollHX711();
#endif

#if SERVO_FEEDBACK
  pollADS();     // round-robin non-blocking, ~33 Hz per kanal
#endif

  // 1) Stepper J1..J4: closed-loop AS5600 + koreksi proporsional.
  // moveTo() cukup dipanggil saat target berubah; ramp & pulsa jalan di
  // background (hardware), tak perlu run() tiap loop.
  for (int i = 0; i < NUM_STEPPER; i++) {
    float enc = readStepperEncoder(i);
    if (!isnan(enc)) {
      actualDeg[i] = enc;
    } else if ((encFault[i] || !ENC_ADA[i]) && steppers[i]) {
      // Open-loop: posisi diambil dari step counter. Itu sudut perintah yang
      // sedang dijalankan, jadi twin ikut ramp-nya dan tidak melompat, tanpa
      // satu pun angka yang dikarang seolah hasil ukur.
      actualDeg[i] = steppers[i]->getCurrentPosition() / STEPS_PER_DEG[i];
    }
    // tmcDown: tahap output mati, jadi memerintahkan moveTo cuma membuat step
    // counter merayap menjauh dari posisi fisik yang sebenarnya tidak berubah.
    // wsFreeze: tidak ada yang menonton, gerak sedang di-ramp turun.
    if (!estop && !tmcDown && !wsFreeze && steppers[i]) {
      long targetSteps = (long)(targetDeg[i] * STEPS_PER_DEG[i]);
      // kp = 0 berarti "koreksi encoder dimatikan", BUKAN "sendi dibekukan",
      // jadi ia harus ikut jalur open-loop yang sama dengan encoder mati.
      // Tanpa syarat kp di sini, cabang koreksi di bawah menghitung corr = 0,
      // menggeser step counter TEPAT ke target, lalu memerintahkan moveTo ke
      // tempat yang sudah ditempatinya, sehingga sendi tidak pernah melangkah
      // sama sekali sementara firmware mengira sudah sampai.
      // Terbukti di J2, 12 Agu 2026: `gerak 5` memberi faktor gerak 0,0000,
      // encoder diam di 0, dan cs driver tidak pernah naik dari arus tahan.
      // Seluruh prosedur di firmware/kalibrasi.md menyuruh kp = 0 selama
      // pengukuran, jadi cacat ini membuat kalibrasi sendi ber-encoder mustahil
      // dijalankan. J1 lolos dulu hanya karena pengukurannya dilakukan SEBELUM
      // penggeseran counter itu diperkenalkan (perbaikan 7 Agu 2026).
      if (encFault[i] || !ENC_ADA[i] || cal.kp <= 0.0f) {
        steppers[i]->moveTo(targetSteps);       // open-loop murni
      } else if (steppers[i]->isRunning()) {
        steppers[i]->moveTo(targetSteps);       // sedang ramp: jangan dikoreksi
                                                // (feedback lag bikin overshoot)
      } else if (labs(targetSteps - steppers[i]->getCurrentPosition())
                 > (long)(cal.deadbandDeg * STEPS_PER_DEG[i])) {
        /* PERJALANAN, BUKAN GALAT SISA.
           Step counter sendiri belum sampai di target, artinya yang tersisa
           adalah gerak yang DIPERINTAHKAN operator, bukan simpangan yang
           dilaporkan encoder. Jalankan sebagai satu moveTo menerus: FastAccel
           yang mengurus satu ramp naik dan satu ramp turun untuk seluruh jarak.

           Sampai 12 Agu 2026 cabang ini tidak ada, sehingga SEMUA gerak sendi
           ber-encoder jatuh ke cabang koreksi di bawah dan dipecah jadi
           potongan sebesar CORR_MAX_DEG. Akibatnya goto 10 -> 50 derajat tidak
           ditempuh sekali jalan melainkan sebagai DELAPAN gerak 5 derajat yang
           masing masing punya ramp naik-turun sendiri: berhenti, maju,
           berhenti, maju, dan tiap berhenti menendang inersia lengan. Halaman
           bawaan ESP32 lolos dari gejala ini bukan karena jalurnya beda,
           melainkan karena menggeser slider mengirim target baru tiap 50 ms
           sehingga potongannya kecil kecil dan 20 kali per detik, jadi terbaca
           menerus. Yang mengirim satu target besar sekaligus, seperti Send goto
           di studio, mendapat tangganya utuh.

           Guardrail lama tidak dilonggarkan sedikit pun: tujuan gerak ini
           adalah targetSteps, yang sudah dijepit ke jointMin/jointMax saat
           masuk, dan step counter TIDAK disamakan dengan pembacaan encoder di
           sini. Jadi encoder dengan tanda atau offset yang salah tetap hanya
           bisa menyumbang gerak sebesar CORR_MAX_DEG lewat cabang di bawah,
           persis seperti sebelumnya. */
        steppers[i]->moveTo(targetSteps);
      } else {
        /* GALAT SISA. Sampai di sini artinya step counter SUDAH di target dan
           motor sudah berhenti, jadi apa pun yang tersisa adalah selisih antara
           yang dikira firmware dan yang dilihat encoder: langkah yang hilang,
           lendutan, atau backlash. Inilah satu satunya tempat pembacaan encoder
           boleh menggerakkan sendi, dan besarnya tetap dijepit CORR_MAX_DEG.
           Sejak cabang perjalanan di atas ada, galat yang masuk ke sini praktis
           selalu di bawah satu derajat, jadi nudge-nya tidak terlihat mata. */
        float err = targetDeg[i] - actualDeg[i];
        if (fabs(err) > cal.deadbandDeg) {
          // Koreksi P di-clamp (guardrail: sign/offset salah kalibrasi tidak
          // boleh melempar lengan jauh).
          float corr = clampf(cal.kp * err, -CORR_MAX_DEG, CORR_MAX_DEG);
          // Koreksi diberikan dengan MENGGESER frame step counter, bukan dengan
          // moveTo(target + corr). Sebabnya: begitu stepper mulai jalan, cabang
          // isRunning() di atas menimpa tujuannya dengan moveTo(targetSteps)
          // pada iterasi loop berikutnya, jadi koreksi dibatalkan sebelum
          // sempat ditempuh. Gerak sisanya cuma beberapa step, di bawah satu
          // LSB AS5600 (0,088 deg), sehingga galat tidak pernah menutup dan
          // sendi tampak diam saja pada galat tetap. Terukur di J1 5 Agu 2026:
          // galat loop tertutup identik dengan galat open-loop di tiap titik.
          // Dengan counter digeser ke (target - corr), moveTo(targetSteps) yang
          // biasa itu sendiri yang menempuh tepat sejauh corr, dan cabang
          // isRunning() ikut memerintahkan tujuan yang SAMA, bukan yang lain.
          steppers[i]->setCurrentPosition(
              (long)((targetDeg[i] - corr) * STEPS_PER_DEG[i]));
          steppers[i]->moveTo(targetSteps);
        }
      }
    }
  }

  // 2) Servo J5/J6/gripper: kirim target (bila tidak e-stop), baca posisi aktual.
  //    Servo dalam mode manual (kalibrasi) dilewati: pulsanya sudah di-set
  //    servo_us dan tidak boleh ditimpa pemetaan sudut tiap putaran loop.
  for (int i = 0; i < NUM_SERVO; i++) {
    int j = SERVO_JOINT[i];
    float cmd = (j >= 0) ? targetDeg[j] : gripTargetDeg;
    if (!estop && !servoManual[i]) servoWriteUs(i, servoAngleToUs(i, cmd));
    float akt = readServoAngle(i, cmd);
    if (j >= 0) actualDeg[j] = akt; else gripActualDeg = akt;
  }
  // Setelah sudut gripper terbaru masuk: putuskan apakah torsinya sudah boleh
  // dilepas. Perilaku default, lihat blok AUTO-LEMAS GRIPPER di atas.
  gripAutoLemasTick();

  // 3) Broadcast feedback ke semua klien web ~50 Hz (+ status guardrail).
  if (millis() - lastFeedback >= 20) {
    lastFeedback = millis();
    char buf[256];
    // drvok/drvrst ditambahkan 13 Agu 2026: tanpa keduanya, driver yang
    // kehilangan VM lalu kembali dengan register default sama sekali tidak
    // punya wakil di layar, dan satu-satunya gejalanya adalah arus catu daya
    // yang cuma kelihatan di alat ukur. drvrst dihitung naik, bukan boolean
    // sesaat, supaya kejadian yang sudah pulih sendiri tetap meninggalkan jejak.
    int n = snprintf(buf, sizeof(buf),
        "{\"type\":\"feedback\",\"angles\":[%.2f,%.2f,%.2f,%.2f,%.2f,%.2f],"
        "\"estop\":%s,\"fault\":[%d,%d,%d,%d],\"grip\":%.2f,"
        "\"drvok\":%s,\"drvrst\":%u}",
        actualDeg[0], actualDeg[1], actualDeg[2],
        actualDeg[3], actualDeg[4], actualDeg[5],
        estop ? "true" : "false",
        encFault[0], encFault[1], encFault[2], encFault[3],
        gripActualDeg,
        tmcDown ? "false" : "true", tmcResetSeen);
    if (n > 0 && n < (int)sizeof(buf)) webSocket.broadcastTXT(buf, n);
  }
}
