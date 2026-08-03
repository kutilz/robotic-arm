/*
 * tmc_bench.ino - bench test 1x TMC2209 (J1) via UART, ESP32 DevKit v1
 *
 * Tujuan: menentukan setting arus & chopper yang benar SEKALI, dengan angka
 * yang bisa dicek, bukan tuning coba-coba. Semua parameter bisa diubah lewat
 * Serial Monitor tanpa upload ulang.
 *
 * Dependensi: TMCStepper (teemuatlut) saja. Sengaja TIDAK pakai
 * FastAccelStepper supaya bisa dicompile walau library lain belum lengkap.
 *
 * Wiring (modul single-wire, sesuai hasil probing PDN):
 *   ESP32 TX (GPIO17) -> resistor 1k -> titik gabung
 *   ESP32 RX (GPIO16) -> titik gabung
 *   titik gabung      -> pin PDN modul TMC2209
 *   MS1 & MS2         -> GND  (alamat 0b00, HANYA untuk driver pertama)
 *   VIO               -> 3V3 ESP32 (JANGAN 5V)
 *   VM                -> PSU motor 24V, GND common dengan ESP32
 *
 * URUTAN NYALA (batas absolut VM = 29V, di rail 24V margin transien cuma 5V):
 *   1. Rangkai semua kabel dengan output PSU MATI.
 *   2. Baru tekan tombol OUTPUT di PSU.
 *   3. Jangan pernah cabut/pasang kabel daya atau motor saat power on.
 *   Colok ke sumber hidup memicu dering LC sampai ~2x nominal (~48V) selama
 *   beberapa mikrodetik. Driver mati tanpa satu pun flag di DRV_STATUS.
 *   Latar: docs/research/driver-stepper-tmc2209-vs-drv8825.md §6.
 *
 * Perintah Serial Monitor (115200, baris diakhiri newline):
 *   ?            status lengkap + verifikasi setting arus
 *   i <mA>       set arus RMS, contoh: i 1200
 *   h <0..1>     hold multiplier, contoh: h 0.4
 *   m <n>        microstep: 0(full),2,4,8,16,32,64,128,256
 *   p <0|1>      intpol (interpolasi 256 microstep) off/on
 *   c <0|1>      chopper: 0 = stealthChop, 1 = spreadCycle
 *   g <putaran>  gerak N putaran motor (boleh negatif), contoh: g 2
 *   v <us>       half-period step saat kecepatan puncak, default 250
 *   t <hz> <ms>  mainkan nada tanpa berpindah posisi, contoh: t 440 500
 *   w            sweep 200->2000 Hz (suara "robot")
 *   e <0|1>      enable driver
 */

#include <Arduino.h>
#include <TMCStepper.h>

// ---------------------------------------------------------------- konfigurasi
#define EN_PIN        5
#define DIR_PIN       27
#define STEP_PIN      13

#define TMC_RX        16
#define TMC_TX        17
#define TMC_SERIAL    Serial2      // Serial1 default ESP32 bentrok dgn flash
#define TMC_ADDR      0b00

// WAJIB dicocokkan dengan resistor sense fisik di modul. Lihat marking
// resistor kecil dekat pin motor: R110 = 0.11, R150 = 0.15, R050 = 0.05.
// Salah nilai di sini = arus salah proporsional, dan tidak ada error apa pun.
#define R_SENSE       0.11f

#define FULLSTEP_REV  200          // 1.8 derajat. Ganti 400 kalau motor 0.9 derajat.

TMC2209Stepper drv(&TMC_SERIAL, R_SENSE, TMC_ADDR);

// ------------------------------------------------------------- state runtime
uint16_t g_mA        = 1000;
float    g_hold      = 0.4f;
uint16_t g_microstep = 16;
bool     g_spread    = true;       // default spreadCycle: torsi > senyap
bool     g_intpol    = true;
uint16_t g_vDelay    = 250;        // half-period step (us) saat puncak

// ----------------------------------------------------------------- utilitas

// Arus RMS aktual yang dipakai chip, dihitung dari CS yang benar-benar aktif.
// Rumus datasheet TMC2209:
//   I_rms = (CS+1)/32 * V_fs / (R_SENSE + 0.02) / sqrt(2)
// CATATAN PENTING: angka ini hanya mencerminkan skala DIGITAL. Kalau
// I_scale_analog masih aktif, arus fisik masih dikali lagi (VREF/2.5V).
// Makanya status di bawah selalu ikut melaporkan bit I_scale_analog.
float csToMilliAmps(uint8_t cs, bool vsenseBit) {
  float vfs = vsenseBit ? 0.180f : 0.325f;
  return (cs + 1) / 32.0f * vfs / (R_SENSE + 0.02f) / 1.41421f * 1000.0f;
}

void applyConfig() {
  drv.toff(0);                     // matikan chopper saat rekonfigurasi

  // Baris paling penting di file ini. Default chip TMC2209 = VREF ikut
  // mengali arus, dan TMCStepper::begin() TIDAK mematikannya. Tanpa baris
  // ini, rms_current(1000) pada modul ber-VREF 1.2V hanya menghasilkan
  // 1000 * (1.2/2.5) = 480 mA.
  drv.I_scale_analog(false);
  drv.internal_Rsense(false);      // pakai sense resistor eksternal di modul

  drv.blank_time(24);
  drv.hysteresis_start(1);         // hstrt, dipakai spreadCycle
  drv.hysteresis_end(2);           // hend

  drv.rms_current(g_mA, g_hold);
  drv.iholddelay(6);
  drv.TPOWERDOWN(20);              // ~0.3 s sebelum turun ke arus hold

  drv.microsteps(g_microstep);
  drv.intpol(g_intpol);

  drv.en_spreadCycle(g_spread);
  if (!g_spread) {                 // stealthChop butuh autoscale + autograd
    drv.pwm_autoscale(true);
    drv.pwm_autograd(true);
  }

  drv.toff(4);                     // hidupkan chopper lagi
  delay(150);                      // beri >130 ms diam untuk autotune AT#1
}

void printStatus() {
  uint8_t  cs     = drv.cs_actual();
  uint8_t  irun   = drv.irun();
  bool     vs     = drv.vsense();
  bool     analog = drv.I_scale_analog();

  Serial.println(F("\n=============== STATUS TMC2209 ==============="));
  Serial.printf("version           : 0x%02X %s\n", drv.version(),
                drv.version() == 0x21 ? "(TMC2209 OK)" : "(TIDAK VALID)");
  Serial.printf("I_scale_analog    : %s\n",
                analog ? "AKTIF  <-- BAHAYA, VREF masih mengali arus!"
                       : "mati   (arus murni dari UART, benar)");
  Serial.printf("R_SENSE di kode   : %.3f ohm  (cocokkan dgn marking modul)\n", R_SENSE);
  Serial.printf("vsense            : %d  (Vfs = %s V)\n", vs, vs ? "0.180" : "0.325");
  Serial.printf("IRUN (diprogram)  : %u  -> %.0f mA RMS\n", irun, csToMilliAmps(irun, vs));
  Serial.printf("CS_ACTUAL (live)  : %u  -> %.0f mA RMS\n", cs,   csToMilliAmps(cs, vs));
  Serial.printf("   (saat diam CS_ACTUAL turun ke IHOLD, itu normal)\n");
  Serial.printf("diminta            : %u mA RMS, hold x%.2f\n", g_mA, g_hold);
  Serial.printf("microstep         : %u, intpol %s\n", drv.microsteps(),
                g_intpol ? "on" : "off");
  Serial.printf("chopper           : %s\n", g_spread ? "spreadCycle" : "stealthChop");
  Serial.printf("v_delay           : %u us  (~%.2f putaran/detik)\n", g_vDelay,
                1000000.0f / (2.0f * g_vDelay) / (FULLSTEP_REV * (float)g_microstep));
  Serial.printf("suhu driver       : %s\n",
                drv.ot() ? "OVERTEMP!" : (drv.otpw() ? "peringatan panas" : "normal"));
  Serial.printf("short / open coil : %s%s%s\n",
                drv.s2ga() || drv.s2gb() ? "SHORT KE GND " : "",
                drv.ola() || drv.olb()   ? "OPEN LOAD "    : "",
                (!drv.s2ga() && !drv.s2gb() && !drv.ola() && !drv.olb()) ? "bersih" : "");
  Serial.println(F("=============================================="));
  Serial.println(F("Ground truth: sisipkan multimeter mode DC A seri dengan"));
  Serial.println(F("satu coil, set 'm 0' (full step), driver enable, motor"));
  Serial.println(F("diam. Angkanya harus = IRUN mA di atas, +-5%.\n"));
}

// Gerak dengan ramp trapesium sederhana supaya motor tidak kaget.
void moveRamp(long steps) {
  if (steps == 0) return;
  digitalWrite(DIR_PIN, steps > 0 ? HIGH : LOW);
  long n = labs(steps);

  const uint16_t dSlow = 1200;                 // half-period awal (us)
  long ramp = min(n / 2, 600L);
  if (ramp < 1) ramp = 1;

  for (long i = 0; i < n; i++) {
    uint32_t d;
    if (i < ramp)            d = dSlow - (uint32_t)(dSlow - g_vDelay) * i / ramp;
    else if (i >= n - ramp)  d = dSlow - (uint32_t)(dSlow - g_vDelay) * (n - i) / ramp;
    else                     d = g_vDelay;
    digitalWrite(STEP_PIN, HIGH);
    delayMicroseconds(d);
    digitalWrite(STEP_PIN, LOW);
    delayMicroseconds(d);
  }
}

// Bunyikan nada tanpa berpindah posisi: arah dibalik tiap `swing` step,
// jadi rotor cuma bergetar bolak-balik di sekitar titik yang sama.
void playTone(uint32_t hz, uint32_t ms, uint16_t swing = 8) {
  if (hz < 40 || hz > 8000) { Serial.println(F("frekuensi 40-8000 Hz")); return; }
  uint32_t half  = 500000UL / hz;
  uint32_t total = (uint64_t)hz * ms / 1000;
  bool dir = false;
  uint16_t n = 0;
  digitalWrite(DIR_PIN, dir);
  for (uint32_t i = 0; i < total; i++) {
    digitalWrite(STEP_PIN, HIGH);
    delayMicroseconds(half);
    digitalWrite(STEP_PIN, LOW);
    delayMicroseconds(half);
    if (++n >= swing) { n = 0; dir = !dir; digitalWrite(DIR_PIN, dir); }
  }
}

// Sapuan frekuensi naik lalu turun. Ini yang bikin bunyi "robot" khas.
void chirp() {
  for (uint32_t f = 200; f < 2000; f += 40) playTone(f, 18);
  for (uint32_t f = 2000; f > 200; f -= 40) playTone(f, 12);
}

// ------------------------------------------------------------------- setup
void setup() {
  Serial.begin(115200);
  delay(400);

  pinMode(EN_PIN, OUTPUT);
  pinMode(STEP_PIN, OUTPUT);
  pinMode(DIR_PIN, OUTPUT);
  digitalWrite(EN_PIN, HIGH);              // driver OFF dulu, aman saat boot
  digitalWrite(STEP_PIN, LOW);

  TMC_SERIAL.begin(115200, SERIAL_8N1, TMC_RX, TMC_TX);
  delay(200);
  drv.begin();

  Serial.println(F("\n--- bench TMC2209 ---"));
  if (drv.version() != 0x21) {
    Serial.printf("UART GAGAL (version = 0x%02X)\n", drv.version());
    Serial.println(F("Cek: resistor 1k di jalur TX, MS1/MS2 ke GND, VM sudah nyala."));
    Serial.println(F("Lanjut tanpa motor, perintah tetap bisa dicoba.\n"));
  } else {
    Serial.println(F("UART OK (0x21)"));
  }

  applyConfig();
  digitalWrite(EN_PIN, LOW);               // enable
  delay(200);
  printStatus();
  Serial.println(F("Ketik ? untuk status, atau perintah lain (lihat header file)."));
}

// -------------------------------------------------------------------- loop
void loop() {
  if (!Serial.available()) return;
  String line = Serial.readStringUntil('\n');
  line.trim();
  if (line.length() == 0) return;

  char cmd = line.charAt(0);
  String arg = line.substring(1);
  arg.trim();

  switch (cmd) {
    case '?':
      printStatus();
      break;

    case 'i':
      g_mA = constrain(arg.toInt(), 100, 1700);
      applyConfig();
      Serial.printf("arus -> %u mA RMS\n", g_mA);
      printStatus();
      break;

    case 'h':
      g_hold = constrain(arg.toFloat(), 0.0f, 1.0f);
      applyConfig();
      Serial.printf("hold multiplier -> %.2f\n", g_hold);
      break;

    case 'm':
      g_microstep = arg.toInt();
      applyConfig();
      Serial.printf("microstep -> %u\n", drv.microsteps());
      break;

    case 'p':
      g_intpol = arg.toInt() != 0;
      applyConfig();
      Serial.printf("intpol -> %s\n", g_intpol ? "on" : "off");
      break;

    case 'c':
      g_spread = arg.toInt() != 0;
      applyConfig();
      Serial.printf("chopper -> %s\n", g_spread ? "spreadCycle" : "stealthChop");
      break;

    case 'v':
      g_vDelay = constrain(arg.toInt(), 60, 4000);
      Serial.printf("v_delay -> %u us\n", g_vDelay);
      break;

    case 'g': {
      float rev = arg.toFloat();
      long steps = (long)(rev * FULLSTEP_REV * (g_microstep == 0 ? 1 : g_microstep));
      Serial.printf("gerak %.2f putaran (%ld step)...\n", rev, steps);
      moveRamp(steps);
      Serial.println(F("selesai"));
      printStatus();
      break;
    }

    case 't': {
      int sp = arg.indexOf(' ');
      uint32_t hz = arg.toInt();
      uint32_t ms = sp > 0 ? arg.substring(sp + 1).toInt() : 400;
      Serial.printf("nada %u Hz, %u ms\n", hz, ms);
      playTone(hz, ms);
      break;
    }

    case 'w':
      Serial.println(F("sweep 200-2000 Hz"));
      chirp();
      break;

    case 'e':
      digitalWrite(EN_PIN, arg.toInt() ? LOW : HIGH);
      Serial.printf("driver %s\n", arg.toInt() ? "ENABLE" : "disable");
      break;

    default:
      Serial.println(F("perintah tidak dikenal. Lihat header file."));
  }
}
