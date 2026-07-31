/*
 * arm_controller.ino: Firmware kontrol lengan robot 6-DOF cycloidal
 *
 * Skripsi: Rancang Bangun Robotic Arm 6-DOF 3D Printed dengan Mekanisme
 *          Position Feedback dan Interface Digital Twin Berbasis Web
 *
 * ============================ LEGACY / TIDAK DIPAKAI ======================
 * Sketch ini adalah arsitektur LAMA (Arduino Mega, 6 stepper, 6 AS5600) dan
 * SUDAH TIDAK selaras dengan hardware final. Firmware aktif proyek ini ada di
 * `firmware/arm_controller_esp32/`. Konstanta di bawah (RATIO[], ENC_CHANNEL[],
 * jumlah aktuator) sengaja DIBIARKAN apa adanya sebagai arsip; JANGAN dipakai
 * sebagai rujukan angka. Sumber kebenaran = `src/arm/config.py`.
 *
 * Hardware final: J1/J3/J4 stepper 17HS2401, J2 17HS6401S, J5/J6 servo MG996R;
 * AS5600 hanya 4 unit (J1-J4, mux channel 0-3), J5/J6 pakai pot internal servo
 * yang dibaca ADS1115 di bus I2C (lihat pinout.md §3).
 * ==========================================================================
 *
 * Position feedback (arsitektur lama sketch ini):
 *   - J1-J6 : AS5600 (absolut magnetik 12-bit) via mux I2C TCA9548A,
 *             dipasang di OUTPUT sendi (ikut mengukur backlash gearbox).
 *             Absolut -> tidak perlu homing saat boot.
 *
 * Aktuator (lama): 6 stepper via driver step/dir (DM542T/TMC2209), 24 V+.
 *
 * Protokol serial ke bridge Python (115200 baud):
 *   masuk : "GO,a1,a2,a3,a4,a5,a6\n"   (sudut target derajat)
 *   keluar: "FB,a1,a2,a3,a4,a5,a6\n"   (sudut aktual dari encoder)
 *
 * Dependensi (Library Manager): AccelStepper, Wire
 * Board acuan: Arduino Mega 2560.
 * SCAFFOLD: kalibrasi pin, STEPS_PER_DEG, KP untuk hardware nyata.
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

// --- Channel mux TCA9548A tiap AS5600 (semua sendi sama alamat I2C 0x36) --
const uint8_t ENC_CHANNEL[NUM_JOINTS] = {0, 1, 2, 3, 4, 5};

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

// Baca sudut OUTPUT sendi (derajat).
float readEncoder(int j) {
  return readAS5600(ENC_CHANNEL[j]);
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
