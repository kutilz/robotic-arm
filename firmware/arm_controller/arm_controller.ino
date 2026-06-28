/*
 * arm_controller.ino — Firmware kontrol lengan robot 6-DOF cycloidal
 *
 * Skripsi: Rancang Bangun Robotic Arm 6-DOF 3D Printed dengan Mekanisme
 *          Position Feedback dan Interface Digital Twin Berbasis Web
 *
 * Fitur:
 *   - 6 stepper (NEMA17/23) via driver step/dir (DM542T / TMC2209) — AccelStepper
 *   - Position feedback: 6x encoder magnetik AS5600 lewat multiplexer I2C TCA9548A
 *   - Kontrol closed-loop sederhana (P) yang mengoreksi target stepper dari encoder
 *   - Protokol serial baris-teks ke bridge Python (115200 baud):
 *       masuk : "GO,a1,a2,a3,a4,a5,a6\n"   (sudut target derajat)
 *       keluar: "FB,a1,a2,a3,a4,a5,a6\n"   (sudut aktual dari encoder)
 *
 * Catatan sizing per sendi ada di docs/research/motor-cycloidal-sizing.md
 * dan dikodekan di src/arm/config.py (rasio reduksi, motor).
 *
 * Dependensi (Library Manager): AccelStepper, Wire (bawaan)
 * SCAFFOLD: kalibrasi STEPS_PER_DEG, pin, dan PID untuk hardware nyata.
 */

#include <AccelStepper.h>
#include <Wire.h>

#define NUM_JOINTS 6
#define TCA9548A_ADDR 0x70
#define AS5600_ADDR 0x36
#define BAUD 115200

// --- Pin step/dir per sendi (sesuaikan dengan wiring) ---------------------
const uint8_t STEP_PIN[NUM_JOINTS] = {2, 4, 6, 8, 10, 12};
const uint8_t DIR_PIN[NUM_JOINTS]  = {3, 5, 7, 9, 11, 13};

// Channel TCA9548A untuk tiap encoder AS5600 (selaras config.py encoder_addr)
const uint8_t ENC_CHANNEL[NUM_JOINTS] = {0, 1, 2, 3, 4, 5};

// Langkah motor per derajat OUTPUT = (200 * microstep * rasio) / 360
// Contoh: 200 langkah * 16 microstep * rasio / 360. Rasio dari config.py.
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
float readEncoder(uint8_t channel) {
  tcaSelect(channel);
  Wire.beginTransmission(AS5600_ADDR);
  Wire.write(0x0C);  // register RAW ANGLE (high byte)
  if (Wire.endTransmission(false) != 0) return NAN;
  Wire.requestFrom(AS5600_ADDR, 2);
  if (Wire.available() < 2) return NAN;
  uint16_t raw = (Wire.read() << 8) | Wire.read();
  return (raw & 0x0FFF) * 360.0 / 4096.0;
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
    float enc = readEncoder(ENC_CHANNEL[i]);
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
