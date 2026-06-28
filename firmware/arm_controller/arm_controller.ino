/*
 * arm_controller.ino — Firmware kontrol lengan robot 6-DOF cycloidal
 *
 * Skripsi: Rancang Bangun Robotic Arm 6-DOF 3D Printed dengan Mekanisme
 *          Position Feedback dan Interface Digital Twin Berbasis Web
 *
 * Position feedback HIBRIDA (selaras src/arm/config.py):
 *   - J1,J2,J3,J5 : AS5600 (absolut magnetik 12-bit) via mux I2C TCA9548A,
 *                   dipasang di OUTPUT sendi (ikut mengukur backlash gearbox).
 *   - J4,J6       : encoder optik incremental = disk cetak 24 lubang + 2x
 *                   TLP1025 (quadrature -> 96 count/rev), di POROS MOTOR.
 *                   INCREMENTAL -> butuh HOMING saat boot (lihat catatan).
 *
 * Aktuator: 6 stepper (NEMA17/23) via driver step/dir (DM542T/TMC2209), 24 V+.
 *
 * Protokol serial ke bridge Python (115200 baud):
 *   masuk : "GO,a1,a2,a3,a4,a5,a6\n"   (sudut target derajat)
 *   keluar: "FB,a1,a2,a3,a4,a5,a6\n"   (sudut aktual dari encoder)
 *
 * Dependensi (Library Manager): AccelStepper, Encoder (Paul Stoffregen), Wire
 * Board acuan: Arduino Mega 2560.
 * SCAFFOLD: kalibrasi pin, STEPS_PER_DEG, KP, dan offset homing untuk hardware nyata.
 */

#include <AccelStepper.h>
#include <Encoder.h>
#include <Wire.h>

#define NUM_JOINTS 6
#define TCA9548A_ADDR 0x70
#define AS5600_ADDR 0x36
#define BAUD 115200

// --- Pin step/dir per sendi (sesuaikan dengan wiring) ---------------------
const uint8_t STEP_PIN[NUM_JOINTS] = {2, 4, 6, 8, 10, 12};
const uint8_t DIR_PIN[NUM_JOINTS]  = {3, 5, 7, 9, 11, 13};

// --- Tipe encoder per sendi ----------------------------------------------
// 0 = AS5600 (absolut, I2C via mux) ; 1 = optik quadrature (TLP1025 x2)
const uint8_t ENC_TYPE[NUM_JOINTS]    = {0, 0, 0, 1, 0, 1};  // J4 & J6 = optik
// AS5600: channel mux TCA9548A. Optik: indeks pasangan opto (0/1).
const uint8_t ENC_CHANNEL[NUM_JOINTS] = {0, 1, 2, 0, 3, 1};

// --- Encoder optik incremental -------------------------------------------
// Disk cetak 24 lubang + 2 sensor quadrature -> 4x = 96 count/rev.
// Pin A/B pasangan opto. 18/19 = pin interrupt Mega (kinerja terbaik);
// 22/23 pin biasa (cukup untuk laju rendah). Hindari 20/21 (dipakai I2C).
#define OPTICAL_CPR (24.0 * 4.0)
Encoder optEnc[2] = {Encoder(18, 19), Encoder(22, 23)};

// Langkah motor per derajat OUTPUT = (200 * microstep * rasio) / 360
const float RATIO[NUM_JOINTS] = {20, 55, 50, 15, 15, 15};
const float MICROSTEP = 16.0;
float STEPS_PER_DEG[NUM_JOINTS];

const float KP = 0.4;            // gain koreksi closed-loop (P)
const float DEADBAND_DEG = 0.3;  // toleransi sebelum koreksi

AccelStepper steppers[NUM_JOINTS];
float targetDeg[NUM_JOINTS] = {0};
float actualDeg[NUM_JOINTS] = {0};

void tcaSelect(uint8_t ch) {
  Wire.beginTransmission(TCA9548A_ADDR);
  Wire.write(1 << ch);
  Wire.endTransmission();
}

// Baca sudut absolut AS5600 (0..360 derajat) pada channel mux tertentu
float readAS5600(uint8_t channel) {
  tcaSelect(channel);
  Wire.beginTransmission(AS5600_ADDR);
  Wire.write(0x0C);  // register RAW ANGLE (high byte)
  if (Wire.endTransmission(false) != 0) return NAN;
  Wire.requestFrom(AS5600_ADDR, 2);
  if (Wire.available() < 2) return NAN;
  uint16_t raw = (Wire.read() << 8) | Wire.read();
  return (raw & 0x0FFF) * 360.0 / 4096.0;
}

// Baca sudut OUTPUT sendi (derajat). Optik: relatif terhadap titik homing,
// disk di poros motor -> bagi rasio reduksi.
float readEncoder(int j) {
  if (ENC_TYPE[j] == 0) {
    return readAS5600(ENC_CHANNEL[j]);
  }
  uint8_t i = ENC_CHANNEL[j];                 // indeks pasangan opto (0/1)
  long counts = optEnc[i].read();
  return (counts * 360.0 / OPTICAL_CPR) / RATIO[j];
}

void setup() {
  Serial.begin(BAUD);
  Wire.begin();
  for (int i = 0; i < NUM_JOINTS; i++) {
    steppers[i] = AccelStepper(AccelStepper::DRIVER, STEP_PIN[i], DIR_PIN[i]);
    steppers[i].setMaxSpeed(1500);
    steppers[i].setAcceleration(800);
    STEPS_PER_DEG[i] = (200.0 * MICROSTEP * RATIO[i]) / 360.0;
  }
  // HOMING (wajib untuk sendi optik incremental): gerakkan tiap sendi optik
  // ke limit switch / lubang indeks, lalu reset hitungannya. Skeleton:
  //   optEnc[0].write(0); optEnc[1].write(0);
  optEnc[0].write(0);
  optEnc[1].write(0);
}

void parseCommand(const String &line) {
  if (!line.startsWith("GO,")) return;
  int idx = 3, joint = 0;
  while (joint < NUM_JOINTS && idx > 0) {
    int comma = line.indexOf(',', idx);
    String tok = (comma == -1) ? line.substring(idx) : line.substring(idx, comma);
    targetDeg[joint++] = tok.toFloat();
    idx = (comma == -1) ? -1 : comma + 1;
  }
}

unsigned long lastFeedback = 0;

void loop() {
  // 1) Terima perintah target dari bridge
  if (Serial.available()) {
    String line = Serial.readStringUntil('\n');
    line.trim();
    parseCommand(line);
  }

  // 2) Closed-loop: baca encoder, koreksi target stepper bila menyimpang
  for (int i = 0; i < NUM_JOINTS; i++) {
    float enc = readEncoder(i);
    if (!isnan(enc)) actualDeg[i] = enc;
    float err = targetDeg[i] - actualDeg[i];
    if (fabs(err) > DEADBAND_DEG) {
      float corrDeg = targetDeg[i] + KP * err;  // koreksi proporsional
      steppers[i].moveTo((long)(corrDeg * STEPS_PER_DEG[i]));
    }
    steppers[i].run();
  }

  // 3) Kirim feedback encoder ke bridge ~50 Hz
  if (millis() - lastFeedback >= 20) {
    lastFeedback = millis();
    Serial.print("FB");
    for (int i = 0; i < NUM_JOINTS; i++) {
      Serial.print(',');
      Serial.print(actualDeg[i], 2);
    }
    Serial.print('\n');
  }
}
