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
 *   Position feedback (semua 6 joint punya feedback):
 *     - J1..J4 : AS5600 (absolut magnetik 12-bit) di OUTPUT sendi, via mux
 *                I2C TCA9548A (semua AS5600 ber-alamat sama 0x36).
 *     - J5..J6 : wiper potensiometer internal MG996R, kalibrasi 2 titik.
 *                SERVO_FEEDBACK 1 = aktif (default sekarang);
 *                0 -> lapor sudut commanded saja.
 *                KEPUTUSAN HARDWARE TERBARU: wiper masuk ke ADS1115 (ADC
 *                eksternal 16-bit, 0x48, menumpang bus I2C yang sama dengan
 *                mux), BUKAN ke ADC internal ESP32. Gripper MG90S ikut jalur
 *                itu di kanal A2. Kode di bawah BELUM dimigrasi: masih
 *                analogReadMilliVolts() di GPIO 34/35. Lihat pinout.md §3.
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
 *              {"cmd":"cal_zero"}                   pose sekarang = 0 (J1..J4)
 *              {"cmd":"cal_zero","joint":n}         idem satu joint (n=1..4)
 *              {"cmd":"cal_save"}                   simpan kalibrasi ke NVS
 *              {"cmd":"cal_reset"}                  kembali ke default + hapus NVS
 *              {"cmd":"diag"}                       snapshot diagnostik: magnet
 *                                                   AS5600 (MD/ML/MH+AGC+mag),
 *                                                   raw, StallGuard, load cell,
 *                                                   WiFi, status mux
 *              {"cmd":"load_tare"}                  nol-kan load cell (RAM)
 *              {"cmd":"load_scale","grams":m}       kalibrasi skala load cell
 *                                                   dengan massa known m gram
 *   ke web   : {"type":"feedback","angles":[a1..a6],"estop":b,"fault":[f1..f4]}
 *              {"type":"cal", ...seluruh kalibrasi...}      (balasan cal_get)
 *              {"type":"diag", ...}                          (balasan diag)
 *              {"type":"ack","cmd":"...","ok":b,"msg":"..."} (balasan command)
 *   Field cal_set yang dikenali (semua opsional, divalidasi sebelum dipakai):
 *     enc_offset[4] enc_sign[4] ratio[4] joint_min[6] joint_max[6]
 *     speed accel kp deadband
 *     servo_us_min[2] servo_us_max[2] servo_ang_min[2] servo_ang_max[2]
 *     servo_fb_mv_min[2] servo_fb_mv_max[2]
 *     tmc_ma[4] (100..1700 mA RMS)  tmc_microstep (1,2,4,...,256)
 *     tmc_spread (0=stealthChop, 1=spreadCycle)  tmc_hold (0..100 %)
 *   diag.drv[4] melaporkan balik kondisi tiap driver TMC2209: irun, cs
 *   (skala arus live), ma/macs (konversi ke mA), vref (bit I_scale_analog,
 *   true = pot VREF masih ikut mengali arus), ot/otpw (termal), s2g (coil
 *   short ke GND), ol (coil open / kabel lepas).
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
#else
#error "wifi_secrets.h tidak ada: salin wifi_secrets.h.example -> wifi_secrets.h lalu isi kredensial"
#endif
const char* MDNS_NAME = "armbot";   // -> ws://armbot.local:81 (mode STA)
const uint16_t WS_PORT = 81;

// --- Fitur opsional ---
#define SERVO_FEEDBACK 0    // 1 = baca wiper pot MG996R (butuh mod servo).
                            //     Jalur hardware final = ADS1115 di bus I2C.
                            //     Implementasi di sini MASIH ADC1 internal dan
                            //     belum dimigrasi; lihat pinout.md §3.
                            // SEKARANG 0 (fase bench motor telanjang): servo
                            // belum dipakai, dan implementasi ADC1 internal di
                            // GPIO34/35 satu bank dengan GPIO36 = HX711 DT.
                            // Erratum ESP32: menyalakan ADC1 bisa memunculkan
                            // pulsa LOW palsu di GPIO36/39, terbaca HX711
                            // sebagai data-ready bohongan -> berat ngawur
                            // sesekali tanpa error. Kembalikan ke 1 setelah
                            // feedback servo pindah ke ADS1115.
#define USE_TMC_UART   1    // 1 = kontrol penuh TMC2209 via UART: arus, microstep,
                            //     stealthChop, StallGuard, diagnostik (butuh TMCStepper)
#define USE_HX711      1    // 1 = baca load cell via HX711 (bench uji torsi)
#define ESTOP_AUTO_RESUME 0 // 0 = wajib {"cmd":"resume"} eksplisit (lebih aman;
                            //     tombol RESET di studio sudah mengirim resume)
                            // 1 = goto melepas e-stop (perilaku lama)

// --- Dimensi sistem ---
#define NUM_JOINTS  6
#define NUM_STEPPER 4      // J1..J4
#define NUM_SERVO   2      // J5..J6

// --- I2C (AS5600 via mux TCA9548A) ---
#define I2C_SDA       21
#define I2C_SCL       22
#define TCA9548A_ADDR 0x70
#define AS5600_ADDR   0x36
#define I2C_TIMEOUT_MS 5   // bus macet tak boleh membekukan loop (guardrail)

// --- Pin step/dir stepper J1..J4 (hindari GPIO 6-11 flash, 34-39 input-only) ---
// GPIO16/17 sengaja DIKOSONGKAN -> dicadangkan untuk Serial2 (TMC UART).
const uint8_t STEP_PIN[NUM_STEPPER] = {13, 14, 25, 26};
const uint8_t DIR_PIN[NUM_STEPPER]  = {27, 33, 32, 23};
const uint8_t EN_PIN = 5;   // ENABLE bersama TMC (active-LOW: LOW=enable, HIGH=disable)
                            // GPIO5 = strapping pin -> HIGH saat boot = driver
                            // OFF sampai firmware siap (aman, motor tak liar).

// --- Channel mux TCA9548A tiap AS5600 (J1..J4) ---
const uint8_t ENC_CHANNEL[NUM_STEPPER] = {0, 1, 2, 3};

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

// --- Servo J5..J6 ---
const uint8_t SERVO_PIN[NUM_SERVO] = {18, 19};

#if USE_HX711
// --- HX711 load cell (bench uji torsi) ---
// DT = GPIO36 (input-only, bebas; HX711 men-drive push-pull jadi tak butuh
// pull-up, GPIO 34-39 memang tak punya). SCK = GPIO4 (bebas, bukan strapping).
// Firmware hanya lapor counts + gram; konversi gram->torsi (x lengan tuas)
// dilakukan di studio.
#define HX711_DT   36
#define HX711_SCK  4
#endif

#if SERVO_FEEDBACK
// BELUM DIMIGRASI: jalur hardware final adalah ADS1115 di bus I2C (0x48,
// kanal A0=J5, A1=J6, A2=gripper). Sementara masih ADC1 internal ESP32.
// WAJIB ADC1 (GPIO 32-39): ADC2 mati saat WiFi aktif. 34/35 input-only = ideal.
const uint8_t SERVO_FB_PIN[NUM_SERVO] = {34, 35};
// PERINGATAN: jika tegangan wiper mendekati/melebihi 3300 mV, pasang voltage
// divider dulu! Nilai kalibrasi 2 titik ada di cal.servoFbMvMin/Max (runtime).
#endif

// ======================= KALIBRASI (RUNTIME + NVS) ========================
// Semua parameter yang dulunya konstanta compile-time dan butuh tuning di
// hardware nyata sekarang hidup di struct ini: bisa diubah via WebSocket
// (cal_set / cal_zero), disimpan permanen via cal_save (NVS "armcal").

#define CAL_MAGIC   0xCA11B007u
#define CAL_VERSION 3   // v2: + ratio[4] (bench: ganti reducer tanpa re-flash)
                        //     + loadOffset/loadScale (kalibrasi HX711)
                        // v3: + tmcMa[4]/tmcMicrostep/tmcSpread/tmcHoldPct
                        //     (arus & mode chopper dari studio, tanpa re-flash)
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
  const float jmin[NUM_JOINTS] = {-180, -95, -150, -180, -120, -180};
  const float jmax[NUM_JOINTS] = { 180,  95,  150,  180,  120,  180};
  for (int j = 0; j < NUM_JOINTS; j++) { cal.jointMin[j] = jmin[j]; cal.jointMax[j] = jmax[j]; }
  cal.maxSpeedDps  = 60.0f;
  cal.maxAccelDpss = 120.0f;
  cal.kp           = 0.4f;
  cal.deadbandDeg  = 0.3f;
  const float amin[NUM_SERVO] = {-120, -180}, amax[NUM_SERVO] = {120, 180};
  for (int s = 0; s < NUM_SERVO; s++) {
    cal.servoAngMin[s] = amin[s]; cal.servoAngMax[s] = amax[s];
    cal.servoUsMin[s]  = 500;     cal.servoUsMax[s]  = 2500;
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
FastAccelStepper* steppers[NUM_STEPPER] = {nullptr};
Servo servos[NUM_SERVO];
WebSocketsServer webSocket(WS_PORT);

float targetDeg[NUM_JOINTS] = {0};   // target semua sendi (J1..J6)
float actualDeg[NUM_JOINTS] = {0};   // aktual dari feedback
bool  estop = false;
unsigned long lastFeedback = 0;

// Guardrail encoder: hitung gagal-baca berturut-turut per joint stepper.
// >= ENC_FAULT_LIMIT -> encFault, koreksi closed-loop off (fallback step counter).
uint8_t  encFailCount[NUM_STEPPER] = {0};
bool     encFault[NUM_STEPPER]     = {false};
uint32_t encNextRetry[NUM_STEPPER] = {0};   // millis() percobaan ulang saat FAULT

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
  // Sudah FAULT: lewati bus sama sekali sampai jadwal coba-ulang. Selisih
  // dihitung bertanda supaya tetap benar saat millis() melewati batas 32 bit.
  if (encFault[s]) {
    if ((int32_t)(millis() - encNextRetry[s]) < 0) return NAN;
    encNextRetry[s] = millis() + ENC_RETRY_MS;
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

// Sudut aktual servo. Dengan SERVO_FEEDBACK: baca wiper pot + oversampling.
// Tanpa mod: kembalikan sudut commanded (best effort).
// TODO: ganti analogReadMilliVolts() dengan pembacaan ADS1115 (bus I2C),
// sesuai keputusan hardware di pinout.md §3. Antarmuka fungsi tetap sama.
float readServoAngle(int s, float commandedDeg) {
#if SERVO_FEEDBACK
  int spanMv = cal.servoFbMvMax[s] - cal.servoFbMvMin[s];
  if (spanMv == 0) return commandedDeg;  // kalibrasi rusak (guardrail div/0)
  const int N = 16;
  long acc = 0;
  for (int k = 0; k < N; k++) acc += analogReadMilliVolts(SERVO_FB_PIN[s]);
  int mv = acc / N;
  float t = (float)(mv - cal.servoFbMvMin[s]) / (float)spanMv;
  t = clampf(t, 0.0f, 1.0f);
  return cal.servoAngMin[s] + t * (cal.servoAngMax[s] - cal.servoAngMin[s]);
#else
  return commandedDeg;
#endif
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

TMC2209Stepper tmc[NUM_STEPPER] = {
  TMC2209Stepper(&TMC_SERIAL, TMC_R_SENSE, 0b00),
  TMC2209Stepper(&TMC_SERIAL, TMC_R_SENSE, 0b01),
  TMC2209Stepper(&TMC_SERIAL, TMC_R_SENSE, 0b10),
  TMC2209Stepper(&TMC_SERIAL, TMC_R_SENSE, 0b11),
};

// Dorong SELURUH parameter chopper dari cal.tmc* ke keempat driver. Dipanggil
// saat boot dan tiap cal_set mengubah field tmc_*.
//
// Urutan penting: toff(0) mematikan tahap output dulu supaya register tidak
// diubah sambil coil sedang di-drive, baru toff(4) menyalakan lagi di akhir.
void tmcApply() {
  uint16_t ms = cal.tmcMicrostep < 1 ? 1 : cal.tmcMicrostep;
  float hold = clampf(cal.tmcHoldPct / 100.0f, 0.0f, 1.0f);

  for (int i = 0; i < NUM_STEPPER; i++) {
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

    tmc[i].microsteps(ms);
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
    uint8_t conn = tmc[i].test_connection();  // 0 = OK
    Serial.printf("[TMC] J%d addr 0b%02d: conn=%u (0=OK) ms=%u I=%umA %s\n",
                  i + 1, i, conn, tmc[i].microsteps(), cal.tmcMa[i],
                  cal.tmcSpread ? "spreadCycle" : "stealthChop");
  }
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

void applyEstop(bool on) {
  estop = on;
  digitalWrite(EN_PIN, on ? HIGH : LOW);   // TMC active-LOW: HIGH = disable
  if (on) {
    for (int i = 0; i < NUM_STEPPER; i++) {
      if (steppers[i]) steppers[i]->forceStop();  // hentikan ramp seketika
    }
  }
}

// Terapkan cal.maxSpeedDps / maxAccelDpss ke semua stepper (dipanggil saat
// setup dan tiap cal_set mengubah speed/accel).
void applyMotionLimits() {
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
      if (steppers[i]) steppers[i]->setCurrentPosition((int32_t)(enc * STEPS_PER_DEG[i]));
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
  StaticJsonDocument<2048> doc;
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
  JsonArray am = doc.createNestedArray("servo_ang_min");
  JsonArray aM = doc.createNestedArray("servo_ang_max");
  JsonArray fm = doc.createNestedArray("servo_fb_mv_min");
  JsonArray fM = doc.createNestedArray("servo_fb_mv_max");
  for (int s = 0; s < NUM_SERVO; s++) {
    um.add(cal.servoUsMin[s]);   uM.add(cal.servoUsMax[s]);
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
  // 3072: enc[4] + sg[4] + drv[4] (11 field/driver) + load + wifi. Kekecilan
  // bikin serializeJson diam-diam memotong JSON dan studio gagal parse.
  StaticJsonDocument<3072> doc;
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
  JsonObject wf = doc.createNestedObject("wifi");
  wf["mode"] = runningAsAP ? "ap" : "sta";
  wf["ip"]   = runningAsAP ? WiFi.softAPIP().toString() : WiFi.localIP().toString();
  wf["rssi"] = runningAsAP ? 0 : WiFi.RSSI();
  doc["mux"] = muxPresent;
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
  cal = next;
  if (ratioChanged || msChanged) {
    // Rasio/microstep berubah -> skala step/derajat berubah -> step counter
    // lama tak valid. Guardrail: hitung ulang, re-sync counter dari sudut
    // aktual, dan tahan target = aktual supaya TIDAK ada gerak mendadak.
    recomputeStepsPerDeg();
    for (int i = 0; i < NUM_STEPPER; i++) {
      if (steppers[i]) steppers[i]->setCurrentPosition((int32_t)(actualDeg[i] * STEPS_PER_DEG[i]));
      targetDeg[i] = actualDeg[i];
    }
  }
  if (motionChanged || ratioChanged || msChanged) applyMotionLimits();
#if USE_TMC_UART
  // Dorong ke chip SETELAH target ditahan = aktual, supaya jeda toff(0) saat
  // reconfigure tidak bertepatan dengan perintah gerak yang masih tertunda.
  if (tmcChanged) tmcApply();
#else
  (void)tmcChanged;
#endif
  // Target lama bisa di luar limit baru -> clamp ulang.
  for (int j = 0; j < NUM_JOINTS; j++)
    targetDeg[j] = clampf(targetDeg[j], cal.jointMin[j], cal.jointMax[j]);
  return true;
}

// {"cmd":"cal_zero"[,"joint":n]} : definisikan pose sekarang sebagai 0 derajat.
// offset = sudut mentah AS5600 sekarang; step counter & target ikut di-nol-kan.
bool handleCalZero(int joint /*0-based, -1 = semua*/, const char** errMsg) {
  int from = (joint < 0) ? 0 : joint;
  int to   = (joint < 0) ? NUM_STEPPER - 1 : joint;
  if (from < 0 || to >= NUM_STEPPER) { *errMsg = "joint di luar 1..4"; return false; }
  for (int i = from; i <= to; i++) {
    float raw = NAN;
    for (int r = 0; r < 3 && isnan(raw); r++) raw = readAS5600Raw(ENC_CHANNEL[i]);
    if (isnan(raw)) { *errMsg = "encoder tak terbaca"; return false; }
    cal.encOffsetDeg[i] = raw;
    if (steppers[i]) steppers[i]->setCurrentPosition(0);
    actualDeg[i] = 0;
    targetDeg[i] = 0;
    Serial.printf("[CAL] J%d zero @ raw %.2f deg\n", i + 1, raw);
  }
  return true;
}

void handleText(uint8_t num, uint8_t* payload, size_t length) {
  StaticJsonDocument<1536> doc;
  if (deserializeJson(doc, payload, length)) return;   // JSON rusak -> abaikan

  const char* cmd = doc["cmd"] | "";

  if (strcmp(cmd, "goto") == 0) {
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
#if ESTOP_AUTO_RESUME
    if (estop) applyEstop(false);   // kompatibel UI lama: gerak baru melepas e-stop
#endif

  } else if (strcmp(cmd, "estop") == 0) {
    applyEstop(true);
    sendAck(num, cmd, true, "e-stop aktif");

  } else if (strcmp(cmd, "resume") == 0) {
    applyEstop(false);
    sendAck(num, cmd, true, "e-stop dilepas");

  } else if (strcmp(cmd, "cal_get") == 0) {
    sendCal(num);

  } else if (strcmp(cmd, "cal_set") == 0) {
    const char* err = "";
    bool ok = handleCalSet(doc, &err);
    sendAck(num, cmd, ok, ok ? "diterapkan (RAM, belum disimpan)" : err);

  } else if (strcmp(cmd, "cal_zero") == 0) {
    const char* err = "";
    bool ok;
    if (doc["joint"].isNull()) {
      ok = handleCalZero(-1, &err);            // semua J1..J4
    } else {
      int jv = doc["joint"].as<int>();         // 1-based (J1..J4)
      if (jv < 1 || jv > NUM_STEPPER) { ok = false; err = "joint di luar 1..4"; }
      else ok = handleCalZero(jv - 1, &err);
    }
    sendAck(num, cmd, ok, ok ? "pose sekarang = 0" : err);

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
      if (steppers[i]) steppers[i]->setCurrentPosition((int32_t)(actualDeg[i] * STEPS_PER_DEG[i]));
      targetDeg[i] = actualDeg[i];
    }
    applyMotionLimits();
#if USE_TMC_UART
    tmcApply();
#endif
    sendAck(num, cmd, true, "kalibrasi default (NVS dihapus)");

  } else if (strcmp(cmd, "diag") == 0) {
    sendDiag(num);

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
    if (MDNS.begin(MDNS_NAME)) MDNS.addService("ws", "tcp", WS_PORT);
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

  // FastAccelStepper: tiap stepper dapat kanal RMT/MCPWM hardware sendiri.
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
  applyMotionLimits();

  ESP32PWM::allocateTimer(0);
  ESP32PWM::allocateTimer(1);
  for (int i = 0; i < NUM_SERVO; i++) {
    servos[i].setPeriodHertz(50);
    servos[i].attach(SERVO_PIN[i], 500, 2500);
    servos[i].writeMicroseconds(servoAngleToUs(i, 0));
  }

#if SERVO_FEEDBACK
  for (int i = 0; i < NUM_SERVO; i++) {
    analogSetPinAttenuation(SERVO_FB_PIN[i], ADC_11db);  // rentang ~0..3.1 V
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
  digitalWrite(EN_PIN, LOW);   // baru sekarang enable driver

  setupWiFi();
  webSocket.begin();
  // Guardrail socket zombie: ping tiap 3 dtk, 2x pong hilang -> klien diputus.
  // Tanpa ini TCP stuck bisa menimbun perintah lalu membanjirkannya sekaligus
  // ("robot reog"); di sisi web ada watchdog kebalikannya (bridge.js).
  webSocket.enableHeartbeat(3000, 1500, 2);
  webSocket.onEvent(onWsEvent);
  Serial.println("[WS] server WebSocket aktif (heartbeat 3s).");

  // Guardrail hang: loop() macet (I2C/WiFi/lib) -> task WDT reboot ESP32.
  // Aman: EN_PIN strapping GPIO5 = driver off selama boot berikutnya.
  enableLoopWDT();
}

void loop() {
  webSocket.loop();

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

  // 1) Stepper J1..J4: closed-loop AS5600 + koreksi proporsional.
  // moveTo() cukup dipanggil saat target berubah; ramp & pulsa jalan di
  // background (hardware), tak perlu run() tiap loop.
  for (int i = 0; i < NUM_STEPPER; i++) {
    float enc = readStepperEncoder(i);
    if (!isnan(enc)) {
      actualDeg[i] = enc;
    } else if (encFault[i] && steppers[i]) {
      // Fallback open-loop: estimasi dari step counter (lebih baik daripada
      // membekukan nilai basi yang membuat koreksi mendorong terus).
      actualDeg[i] = steppers[i]->getCurrentPosition() / STEPS_PER_DEG[i];
    }
    if (!estop && steppers[i]) {
      long targetSteps = (long)(targetDeg[i] * STEPS_PER_DEG[i]);
      if (encFault[i]) {
        steppers[i]->moveTo(targetSteps);       // encoder mati: open-loop murni
      } else if (steppers[i]->isRunning()) {
        steppers[i]->moveTo(targetSteps);       // sedang ramp: jangan dikoreksi
                                                // (feedback lag bikin overshoot)
      } else {
        float err = targetDeg[i] - actualDeg[i];
        if (fabs(err) > cal.deadbandDeg) {
          // Koreksi P di-clamp (guardrail: sign/offset salah kalibrasi tidak
          // boleh melempar lengan jauh) dan tetap di dalam joint limit.
          float corr = clampf(cal.kp * err, -CORR_MAX_DEG, CORR_MAX_DEG);
          float corrDeg = clampf(targetDeg[i] + corr, cal.jointMin[i], cal.jointMax[i]);
          steppers[i]->moveTo((long)(corrDeg * STEPS_PER_DEG[i]));
        }
      }
    }
  }

  // 2) Servo J5..J6: kirim target (bila tidak e-stop), baca posisi aktual.
  for (int i = 0; i < NUM_SERVO; i++) {
    int j = NUM_STEPPER + i;
    if (!estop) servos[i].writeMicroseconds(servoAngleToUs(i, targetDeg[j]));
    actualDeg[j] = readServoAngle(i, targetDeg[j]);
  }

  // 3) Broadcast feedback ke semua klien web ~50 Hz (+ status guardrail).
  if (millis() - lastFeedback >= 20) {
    lastFeedback = millis();
    char buf[256];
    int n = snprintf(buf, sizeof(buf),
        "{\"type\":\"feedback\",\"angles\":[%.2f,%.2f,%.2f,%.2f,%.2f,%.2f],"
        "\"estop\":%s,\"fault\":[%d,%d,%d,%d]}",
        actualDeg[0], actualDeg[1], actualDeg[2],
        actualDeg[3], actualDeg[4], actualDeg[5],
        estop ? "true" : "false",
        encFault[0], encFault[1], encFault[2], encFault[3]);
    if (n > 0 && n < (int)sizeof(buf)) webSocket.broadcastTXT(buf, n);
  }
}
