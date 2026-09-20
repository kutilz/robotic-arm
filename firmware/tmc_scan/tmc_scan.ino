/*
 * tmc_scan.ino - pemindai bus UART TMC2209, sketch DIAGNOSIS (bukan firmware kerja)
 *
 * Dibuat untuk kasus: 1 driver terpasang = UART jalan, 4 driver terpasang =
 * komunikasi mati total. Sketch ini TIDAK memakai TMCStepper: datagram UART
 * dirakit sendiri byte per byte, supaya yang dilaporkan bukan cuma "gagal",
 * tapi GAGAL DI MANA. Itu yang membedakan penyebab satu sama lain:
 *
 *   gejala di log                         | artinya
 *   --------------------------------------+------------------------------------
 *   echo kita sendiri ikut rusak          | masalah listrik di bus (kapasitansi
 *                                         | 4 modul, PDN kena beban, short),
 *                                         | bukan soal alamat
 *   echo utuh, balasan 0 byte             | tidak ada driver di alamat itu
 *                                         | (jumper MS1/MS2 belum di-set)
 *   echo utuh, balasan ada tapi CRC salah | 2 driver+ menjawab bareng di alamat
 *   atau jumlah byte aneh                 | yang sama (tabrakan bus)
 *   semua alamat bisu + RX idle LOW       | ada yang menahan jalur PDN ke GND
 *
 * Setiap ronde juga diulang di beberapa baud. TMC2209 mendeteksi baud sendiri
 * dari byte sync, jadi menurunkan baud TIDAK perlu ubah apa pun di driver.
 * Kalau 4 driver gagal di 115200 tapi lolos di 19200, penyebabnya kapasitansi
 * bus / sinyal tumpul, bukan alamat.
 *
 * KEAMANAN: EN dipaksa HIGH (semua driver disable) sebelum apa pun lain jalan,
 * dan sketch ini tidak pernah mengeluarkan pulsa STEP. Motor tidak akan
 * bergerak. Aturan power tetap berlaku: nyalakan/matikan lewat tombol OUTPUT
 * PSU, dan JANGAN cabut/pasang driver atau motor saat power hidup
 * (lihat firmware/pinout.md §5).
 *
 * Perintah Serial Monitor (115200, akhiri newline):
 *   s          pindai sekali di baud sekarang
 *   a          auto-scan on/off (default ON, siklus 115200 -> 38400 -> 19200)
 *   b <baud>   kunci baud tertentu (mematikan siklus otomatis)
 *   n <1..64>  jumlah percobaan per alamat (default 16)
 *   d <addr>   dump byte mentah 5 percobaan di satu alamat (0..3)
 *   w <addr>   uji TULIS: IFCNT sebelum/sesudah tulis TPOWERDOWN (tanpa efek gerak)
 *   ?          bantuan
 */

#include <Arduino.h>

// ---------------------------------------------------------------- konfigurasi
#define TMC_SERIAL Serial2
#define TMC_RX     16
#define TMC_TX     17

const uint8_t EN_PIN       = 5;                    // active-LOW, HIGH = semua driver mati
const uint8_t STEP_PINS[4] = {13, 14, 25, 26};     // J1..J4
const uint8_t DIR_PINS[4]  = {27, 33, 32, 23};     // J1..J4

// Register TMC2209 yang dipakai di sini.
const uint8_t REG_GCONF      = 0x00;
const uint8_t REG_IFCNT      = 0x02;   // naik 1 tiap datagram TULIS yang diterima
const uint8_t REG_IOIN       = 0x06;   // status pin fisik + VERSION (0x21)
const uint8_t REG_TPOWERDOWN = 0x11;   // write-only, dipakai buat uji tulis
const uint8_t REG_CHOPCONF   = 0x6C;

const uint32_t BAUD_CYCLE[] = {115200, 38400, 19200};
const uint8_t  N_BAUD       = sizeof(BAUD_CYCLE) / sizeof(BAUD_CYCLE[0]);

// -------------------------------------------------------------- state runtime
bool     g_auto      = true;
uint8_t  g_baudIdx   = 0;
uint32_t g_baud      = 115200;
uint8_t  g_tries     = 16;
uint32_t g_round     = 0;

// Hasil satu percobaan baca.
enum ReadStat : uint8_t {
  RS_OK = 0,       // balasan lengkap, CRC cocok
  RS_SUNYI,        // 0 byte masuk, echo kita sendiri pun tidak kembali
  RS_ECHO_RUSAK,   // ada byte, tapi echo TX kita sendiri sudah tidak utuh
  RS_TAK_JAWAB,    // echo utuh, tidak ada balasan sama sekali
  RS_CRC,          // balasan ada, CRC salah (tabrakan / sinyal rusak)
  RS_BENTUK,       // jumlah byte / header balasan tidak masuk akal
};

const char *STAT_NAMA[] = {"ok", "sunyi", "echo-rusak", "tak-jawab", "crc-salah", "bentuk-aneh"};

// ------------------------------------------------------------------ utilitas

// CRC8 datagram TMC (poly x^8+x^2+x^1+1), persis algoritma di datasheet.
static uint8_t tmcCRC(const uint8_t *d, uint8_t n) {
  uint8_t crc = 0;
  for (uint8_t i = 0; i < n; i++) {
    uint8_t b = d[i];
    for (uint8_t j = 0; j < 8; j++) {
      if ((crc >> 7) ^ (b & 0x01)) crc = (uint8_t)((crc << 1) ^ 0x07);
      else                         crc = (uint8_t)(crc << 1);
      b >>= 1;
    }
  }
  return crc;
}

static void busFlush() {
  while (TMC_SERIAL.available()) TMC_SERIAL.read();
}

// JEBAKAN arduino-esp32: HardwareSerial::flush() TANPA argumen memanggil
// uartFlushTxOnly(uart, false) yang IKUT me-reset FIFO RX. Di bus single-wire,
// echo TX kita sendiri mendarat di RX persis saat TX masih jalan, jadi flush()
// menelan echo itu dan uji keutuhan echo jadi bohong (semua kelihatan "sunyi").
// Jadi jangan flush: tunggu manual selama durasi n byte di baud sekarang.
static void tungguKirim(uint8_t n) {
  delayMicroseconds((uint32_t)n * 10UL * 1000000UL / g_baud + 200);
}

// Baca satu register. Mengembalikan kode ReadStat, mengisi *out kalau OK,
// dan menyalin byte mentah yang masuk ke raw[] (maks 24) kalau raw != nullptr.
static uint8_t tmcRead(uint8_t addr, uint8_t reg, uint32_t *out,
                       uint8_t *raw = nullptr, uint8_t *rawLen = nullptr) {
  uint8_t req[4] = {0x05, addr, (uint8_t)(reg & 0x7F), 0};
  req[3] = tmcCRC(req, 3);

  busFlush();
  TMC_SERIAL.write(req, 4);

  // Kumpulkan sampai sunyi. Normal = 4 echo + 8 balasan = 12 byte.
  // Timeout dibuat longgar supaya tetap sah di 19200 (12 byte = 6,3 ms).
  uint8_t  buf[24];
  uint8_t  n       = 0;
  uint32_t t0      = millis();
  uint32_t tAkhir  = t0;
  while (millis() - t0 < 40 && n < sizeof(buf)) {
    if (TMC_SERIAL.available()) {
      buf[n++] = (uint8_t)TMC_SERIAL.read();
      tAkhir = millis();
    } else if (n > 0 && millis() - tAkhir > 8) {
      break;                          // jeda 8 ms setelah byte terakhir = selesai
    }
  }
  if (raw) { memcpy(raw, buf, n); if (rawLen) *rawLen = n; }

  if (n == 0) return RS_SUNYI;
  // Echo TX sendiri harus kembali persis: ini uji kesehatan fisik bus.
  if (n < 4 || memcmp(buf, req, 4) != 0) return RS_ECHO_RUSAK;
  if (n == 4) return RS_TAK_JAWAB;
  if (n < 12) return RS_BENTUK;
  if (buf[4] != 0x05 || buf[5] != 0xFF || buf[6] != (reg & 0x7F)) return RS_BENTUK;
  if (tmcCRC(&buf[4], 7) != buf[11]) return RS_CRC;
  if (n > 12) return RS_CRC;          // ada byte ekstra: penjawab lebih dari satu

  if (out) *out = ((uint32_t)buf[7] << 24) | ((uint32_t)buf[8] << 16) |
                  ((uint32_t)buf[9] << 8)  | (uint32_t)buf[10];
  return RS_OK;
}

static bool tmcWrite(uint8_t addr, uint8_t reg, uint32_t val) {
  uint8_t pkt[8] = {0x05, addr, (uint8_t)(reg | 0x80),
                    (uint8_t)(val >> 24), (uint8_t)(val >> 16),
                    (uint8_t)(val >> 8),  (uint8_t)val, 0};
  pkt[7] = tmcCRC(pkt, 7);
  busFlush();
  TMC_SERIAL.write(pkt, 8);
  tungguKirim(8);
  delay(2);
  busFlush();                          // buang echo tulis
  return true;
}

static void setBaud(uint32_t baud) {
  g_baud = baud;
  TMC_SERIAL.end();
  delay(5);
  TMC_SERIAL.begin(baud, SERIAL_8N1, TMC_RX, TMC_TX);
  delay(20);
  uint32_t dummy;
  tmcRead(0, REG_IOIN, &dummy);        // datagram pertama sesudah ganti baud dibuang
  busFlush();
}

static void cetakHex(const uint8_t *b, uint8_t n) {
  for (uint8_t i = 0; i < n; i++) {
    if (i == 4) Serial.print("| ");    // pemisah echo vs balasan
    Serial.printf("%02X ", b[i]);
  }
  if (n == 0) Serial.print("(kosong)");
}

// ------------------------------------------------------------------- pemindai

uint16_t g_sunyiRonde = 0;   // total percobaan tanpa satu byte pun (echo ikut hilang)
uint16_t g_okRonde    = 0;

static void pindaiAlamat(uint8_t addr) {
  uint16_t tally[6] = {0, 0, 0, 0, 0, 0};
  uint32_t ioin = 0, gconf = 0, chop = 0;
  bool     adaIoin = false;
  uint8_t  rawGagal[24];
  uint8_t  rawGagalLen = 0;
  uint8_t  statGagal = RS_OK;

  for (uint8_t t = 0; t < g_tries; t++) {
    uint32_t v = 0;
    uint8_t  raw[24];
    uint8_t  rawLen = 0;
    uint8_t  st = tmcRead(addr, REG_IOIN, &v, raw, &rawLen);
    tally[st]++;
    if (st == RS_OK) { ioin = v; adaIoin = true; }
    else if (rawGagalLen == 0 || (statGagal == RS_TAK_JAWAB && st != RS_TAK_JAWAB)) {
      memcpy(rawGagal, raw, rawLen);
      rawGagalLen = rawLen;
      statGagal   = st;
    }
    delay(2);
  }

  g_sunyiRonde += tally[RS_SUNYI];
  g_okRonde    += tally[RS_OK];

  Serial.printf("  addr 0b%d%d (J%d): ok %2u/%2u", (addr >> 1) & 1, addr & 1,
                addr + 1, tally[RS_OK], g_tries);
  for (uint8_t s = 1; s < 6; s++)
    if (tally[s]) Serial.printf("  %s=%u", STAT_NAMA[s], tally[s]);

  if (adaIoin) {
    tmcRead(addr, REG_GCONF, &gconf);
    tmcRead(addr, REG_CHOPCONF, &chop);
    uint8_t ver = (uint8_t)(ioin >> 24);
    uint8_t ms1 = (ioin >> 2) & 1, ms2 = (ioin >> 3) & 1;
    Serial.printf("\n      IOIN=0x%08X ver=0x%02X%s  MS1=%u MS2=%u -> alamat pin 0b%u%u%s",
                  ioin, ver, ver == 0x21 ? "(TMC2209)" : "(BUKAN 0x21!)",
                  ms1, ms2, ms2, ms1,
                  ((ms2 << 1) | ms1) == addr ? "" : "  <- TIDAK COCOK dgn alamat jawab!");
    Serial.printf("\n      ENN=%u PDN=%u STEP=%u DIR=%u DIAG=%u  GCONF=0x%08X CHOPCONF=0x%08X",
                  (unsigned)(ioin & 1), (unsigned)((ioin >> 6) & 1),
                  (unsigned)((ioin >> 7) & 1), (unsigned)((ioin >> 9) & 1),
                  (unsigned)((ioin >> 4) & 1), gconf, chop);
  } else if (rawGagalLen > 0 && statGagal != RS_TAK_JAWAB) {
    Serial.print("\n      mentah: ");
    cetakHex(rawGagal, rawGagalLen);
  }
  Serial.println();
}

static void pindai() {
  g_round++;
  // digitalRead saja, TANPA pinMode: pinMode(INPUT) melepas pull-up yang
  // dipasang Serial2.begin dan bisa mengubah perilaku bus yang lagi diukur.
  int idle = digitalRead(TMC_RX);

  Serial.printf("\n=== RONDE %u @ %u baud, %u percobaan/alamat, RX idle=%s ===\n",
                g_round, g_baud, g_tries, idle ? "HIGH (normal)" : "LOW (!! ada yg menahan bus)");
  g_sunyiRonde = 0;
  g_okRonde    = 0;
  for (uint8_t a = 0; a < 4; a++) pindaiAlamat(a);

  if (g_sunyiRonde == (uint16_t)g_tries * 4) {
    Serial.println("  >> ECHO TX SENDIRI TIDAK KEMBALI. Yang gagal jalur fisik bus, bukan driver:");
    Serial.println("     cek kabel RX GPIO16 ke titik gabung, resistor 1k di TX GPIO17, dan GND common.");
    Serial.println("     Selama baris ini muncul, hasil per alamat belum bisa dipakai menilai driver.");
  } else if (g_okRonde == 0) {
    Serial.println("  >> Echo kembali (jalur bus sehat) tapi tidak ada driver yang menjawab:");
    Serial.println("     cek VM driver hidup, VIO 3.3V nyambung, dan PDN_UART benar-benar ke bus.");
  }
}

static void dumpAlamat(uint8_t addr) {
  Serial.printf("\n--- dump mentah addr 0b%d%d @ %u baud ---\n",
                (addr >> 1) & 1, addr & 1, g_baud);
  for (uint8_t t = 0; t < 5; t++) {
    uint32_t v = 0;
    uint8_t raw[24], rawLen = 0;
    uint8_t st = tmcRead(addr, REG_IOIN, &v, raw, &rawLen);
    Serial.printf("  #%u %-11s (%2u byte) ", t + 1, STAT_NAMA[st], rawLen);
    cetakHex(raw, rawLen);
    Serial.println();
    delay(5);
  }
}

// Uji jalur TULIS: IFCNT naik 1 tiap datagram tulis yang diterima chip.
static void ujiTulis(uint8_t addr) {
  uint32_t a = 0, b = 0;
  Serial.printf("\n--- uji tulis addr 0b%d%d ---\n", (addr >> 1) & 1, addr & 1);
  if (tmcRead(addr, REG_IFCNT, &a) != RS_OK) {
    Serial.println("  IFCNT tidak terbaca, jalur BACA belum jalan, uji tulis tidak berarti.");
    return;
  }
  tmcWrite(addr, REG_TPOWERDOWN, 20);         // nilai default, tidak mengubah perilaku
  delay(5);
  if (tmcRead(addr, REG_IFCNT, &b) != RS_OK) {
    Serial.println("  IFCNT hilang sesudah tulis (bus goyah).");
    return;
  }
  Serial.printf("  IFCNT %u -> %u : tulis %s\n", a & 0xFF, b & 0xFF,
                ((b - a) & 0xFF) == 1 ? "DITERIMA" : "TIDAK diterima");
}

// ---------------------------------------------------------------- uji gerak
// Nilai register dihitung tangan (sketch ini sengaja tanpa TMCStepper).
//   GCONF     = spreadCycle + pdn_disable + mstep_reg_select + multistep_filt,
//               I_scale_analog SENGAJA 0. Kalau dibiarkan 1, arus fisik masih
//               dikali (VREF/2.5V) lagi dan itu tidak terlihat di register mana pun.
//   CHOPCONF  = 16 microstep (MRES=4), intpol, TBL=2, toff=3.
//   IHOLD_IRUN: I_rms = (CS+1)/32 * 0.325 / (0.11+0.02) / sqrt(2)
//               CS=17 -> 0,99 A RMS. IHOLD=7 (~40%), IHOLDDELAY=6.
const uint32_t GCONF_UART   = 0x000001C4;
const uint32_t CHOPCONF_16  = 0x14010053;
const uint32_t IHOLD_IRUN_1A = (6UL << 16) | (17UL << 8) | 7UL;
const uint8_t  REG_IHOLD_IRUN = 0x10;

const uint16_t USTEP_PER_REV = 200 * 16;   // motor 1,8 derajat @ 16 microstep

static void cetakDrvStatus(uint8_t addr) {
  uint32_t st = 0;
  if (tmcRead(addr, 0x6F, &st) != RS_OK) { Serial.println("  DRV_STATUS tidak terbaca."); return; }
  uint8_t cs = (st >> 16) & 0x1F;
  Serial.printf("  DRV_STATUS=0x%08X cs_actual=%u (~%u mA RMS)\n", st, cs,
                (unsigned)((cs + 1) / 32.0f * 0.325f / 0.13f / 1.41421f * 1000.0f));
  Serial.printf("  kumparan: olA=%u olB=%u (open-load)  s2gA=%u s2gB=%u s2vsA=%u s2vsB=%u (short)\n",
                (unsigned)((st >> 6) & 1), (unsigned)((st >> 7) & 1),
                (unsigned)((st >> 2) & 1), (unsigned)((st >> 3) & 1),
                (unsigned)((st >> 4) & 1), (unsigned)((st >> 5) & 1));
  Serial.printf("  suhu: otpw=%u ot=%u t120=%u t143=%u  stst=%u\n",
                (unsigned)(st & 1), (unsigned)((st >> 1) & 1),
                (unsigned)((st >> 8) & 1), (unsigned)((st >> 9) & 1),
                (unsigned)((st >> 31) & 1));
  if ((st >> 6) & 1 || (st >> 7) & 1)
    Serial.println("  >> open-load menyala: cek 4 kabel motor. Wajar juga kalau motor diam.");
  if (((st >> 2) & 3) || ((st >> 4) & 3))
    Serial.println("  >> SHORT terdeteksi, MATIKAN PSU dan cek kabel kumparan.");
}

// Konfigurasi satu driver lewat UART lalu buktikan tulisannya mendarat.
static bool siapkanDriver(uint8_t addr) {
  uint32_t if0 = 0, if1 = 0, chop = 0;
  if (tmcRead(addr, REG_IFCNT, &if0) != RS_OK) {
    Serial.printf("  driver 0b%02d tidak menjawab, gerak dibatalkan.\n", addr);
    return false;
  }
  tmcWrite(addr, REG_GCONF, GCONF_UART);
  tmcWrite(addr, REG_IHOLD_IRUN, IHOLD_IRUN_1A);
  tmcWrite(addr, REG_TPOWERDOWN, 20);
  tmcWrite(addr, REG_CHOPCONF, CHOPCONF_16);
  delay(5);
  tmcRead(addr, REG_IFCNT, &if1);
  tmcRead(addr, REG_CHOPCONF, &chop);
  uint8_t naik = (uint8_t)((if1 - if0) & 0xFF);
  Serial.printf("  konfigurasi: IFCNT %u -> %u (naik %u dari 4 tulisan), CHOPCONF=0x%08X %s\n",
                if0 & 0xFF, if1 & 0xFF, naik, chop,
                chop == CHOPCONF_16 ? "COCOK" : "<- TIDAK COCOK!");
  if (naik != 4) Serial.println("  >> tidak semua tulisan diterima chip.");
  return chop == CHOPCONF_16;
}

// Pulsa step dengan ramp trapesium sederhana, blocking.
static void pulsa(uint8_t addr, uint32_t total, bool maju) {
  digitalWrite(DIR_PINS[addr], maju ? HIGH : LOW);
  delayMicroseconds(20);
  const uint32_t dMin = 250, dMax = 900;      // half-period us
  uint32_t ramp = total / 4;
  if (ramp < 1) ramp = 1;
  if (ramp > 800) ramp = 800;
  for (uint32_t i = 0; i < total; i++) {
    uint32_t d;
    if (i < ramp)                 d = dMax - (dMax - dMin) * i / ramp;
    else if (i + ramp >= total)   d = dMax - (dMax - dMin) * (total - i) / ramp;
    else                          d = dMin;
    digitalWrite(STEP_PINS[addr], HIGH);
    delayMicroseconds(3);
    digitalWrite(STEP_PINS[addr], LOW);
    delayMicroseconds(d);
  }
}

// putaran10 = putaran motor dikali 10 (biar tidak perlu parsing pecahan).
// bolakBalik: maju lalu mundur sejumlah sama, jadi posisi akhir = posisi awal.
static void gerak(uint8_t addr, int32_t putaran10, bool bolakBalik) {
  g_auto = false;                              // biar log bersih & baud tidak berganti
  if (g_baud != 115200) setBaud(115200);

  int32_t mut = putaran10 < 0 ? -putaran10 : putaran10;
  Serial.printf("\n--- UJI GERAK addr 0b%d%d (J%d): %s%s%d.%d putaran motor, STEP=GPIO%u DIR=GPIO%u ---\n",
                (addr >> 1) & 1, addr & 1, addr + 1,
                bolakBalik ? "bolak-balik " : "", putaran10 < 0 ? "-" : "",
                (int)(mut / 10), (int)(mut % 10),
                STEP_PINS[addr], DIR_PINS[addr]);
  if (!siapkanDriver(addr)) return;

  uint32_t total = (uint32_t)((uint32_t)mut * USTEP_PER_REV / 10);
  if (total == 0) { Serial.println("  0 langkah, batal."); return; }

  digitalWrite(EN_PIN, LOW);                   // enable (active-LOW)
  delay(200);                                  // syarat autotune stealthChop & arus naik
  Serial.println("  EN=LOW, motor jalan...");

  pulsa(addr, total, putaran10 >= 0);
  if (bolakBalik) { delay(400); pulsa(addr, total, putaran10 < 0); }

  delay(100);
  cetakDrvStatus(addr);
  digitalWrite(EN_PIN, HIGH);                  // matikan lagi, motor tidak dibiarkan panas
  Serial.println("  selesai, EN=HIGH lagi (driver dimatikan). Pakai 'e 1' kalau mau ditahan.");
}

static void bantuan() {
  Serial.println(
    "\nperintah: s=pindai  a=auto on/off  b <baud>  n <1..64>  d <addr>  w <addr>\n"
    "          g <addr>          uji gerak aman: bolak-balik 0,5 putaran (balik ke posisi awal)\n"
    "          m <addr> <p10>    gerak p10/10 putaran motor, boleh negatif (mis. m 0 -20)\n"
    "          e <0|1>           EN driver mati/hidup\n"
    "          ?                 bantuan");
}

static void tanganiPerintah(String s) {
  s.trim();
  if (s.length() == 0) return;
  char c = s[0];
  String sisa = s.substring(1);
  sisa.trim();

  // pisah maksimum 2 argumen angka
  long arg = -1, arg2 = 0;
  bool ada2 = false;
  int spasi = sisa.indexOf(' ');
  if (sisa.length() > 0) {
    if (spasi < 0) arg = sisa.toInt();
    else {
      arg  = sisa.substring(0, spasi).toInt();
      arg2 = sisa.substring(spasi + 1).toInt();
      ada2 = true;
    }
  }

  switch (c) {
    case 's': pindai(); break;
    case 'a':
      g_auto = !g_auto;
      Serial.printf("[cmd] auto-scan %s\n", g_auto ? "ON (siklus baud)" : "OFF");
      break;
    case 'b':
      if (arg >= 9600 && arg <= 500000) {
        g_auto = false;
        setBaud((uint32_t)arg);
        Serial.printf("[cmd] baud dikunci %u, auto-scan OFF\n", g_baud);
      } else Serial.println("[cmd] baud harus 9600..500000");
      break;
    case 'n':
      if (arg >= 1 && arg <= 64) { g_tries = (uint8_t)arg; Serial.printf("[cmd] percobaan=%u\n", g_tries); }
      break;
    case 'd': if (arg >= 0 && arg <= 3) dumpAlamat((uint8_t)arg); break;
    case 'w': if (arg >= 0 && arg <= 3) ujiTulis((uint8_t)arg); break;
    case 'g': if (arg >= 0 && arg <= 3) gerak((uint8_t)arg, 5, true); break;
    case 'm':
      if (arg >= 0 && arg <= 3 && ada2 && arg2 >= -100 && arg2 <= 100)
        gerak((uint8_t)arg, (int32_t)arg2, false);
      else Serial.println("[cmd] pakai: m <addr 0..3> <putaran x10, -100..100>");
      break;
    case 'e':
      digitalWrite(EN_PIN, arg == 1 ? LOW : HIGH);
      Serial.printf("[cmd] EN=%s (driver %s)\n", arg == 1 ? "LOW" : "HIGH",
                    arg == 1 ? "hidup" : "mati");
      break;
    default:  bantuan(); break;
  }
}

// ---------------------------------------------------------------------- setup

void setup() {
  // Driver mati duluan, sebelum apa pun. Sketch ini tidak pernah menggerakkan motor.
  pinMode(EN_PIN, OUTPUT);
  digitalWrite(EN_PIN, HIGH);
  for (uint8_t i = 0; i < 4; i++) {
    pinMode(STEP_PINS[i], OUTPUT); digitalWrite(STEP_PINS[i], LOW);
    pinMode(DIR_PINS[i], OUTPUT);  digitalWrite(DIR_PINS[i], LOW);
  }

  Serial.begin(115200);
  delay(300);
  Serial.println("\n\n================ TMC2209 BUS SCANNER ================");
  Serial.println("EN=HIGH (semua driver disable), tidak ada pulsa STEP.");
  Serial.println("Bus: TX2 GPIO17 --[1k]--+-- PDN semua driver, RX2 GPIO16 --+");
  bantuan();

  setBaud(BAUD_CYCLE[0]);
  pindai();
}

void loop() {
  static String jalur;
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') { tanganiPerintah(jalur); jalur = ""; }
    else if (jalur.length() < 32) jalur += c;
  }

  static uint32_t tLalu = 0;
  if (g_auto && millis() - tLalu > 2500) {
    tLalu = millis();
    g_baudIdx = (uint8_t)((g_baudIdx + 1) % N_BAUD);
    setBaud(BAUD_CYCLE[g_baudIdx]);
    pindai();
  }
}
