/*
 * cloud_link.h: jalur CLOUD, yaitu ESP32 yang menelepon KELUAR ke relay.
 *
 * Kenapa arahnya dibalik. Jalur lokal (server WebSocket :81) hanya terjangkau
 * dari WiFi yang sama, dan halaman https:// (twin di Vercel) tidak boleh
 * membuka ws:// sama sekali. Lewat jalur ini ESP32 sendiri yang membuka wss://
 * ke relay Cloudflare (folder relay/ di repo), jadi lengan cukup tersambung ke
 * WiFi apa pun yang punya internet, mis. hotspot HP: tidak butuh IP publik,
 * port forwarding, PC, atau WiFi rumah.
 *
 * Jalur lokal TIDAK diganti. Keduanya jalan berbarengan dan memakai protokol
 * JSON yang sama persis; aturan siapa yang boleh menggerakkan lengan ada di
 * ino (blok JALUR), bukan di sini.
 *
 * KENAPA TASK SENDIRI DI CORE 0. Handshake TLS ke relay makan 1 sampai 2
 * detik dan sifatnya blocking. Di loop() itu berarti servo, koreksi encoder,
 * feedback lokal, dan loop WDT 5 detik ikut tersendat setiap kali sinyal HP
 * putus lalu tersambung lagi. Pulsa step memang aman (RMT/MCPWM), tapi sisanya
 * tidak. Karena itu seluruh I/O cloud hidup di task ini, dan task ini TIDAK
 * PERNAH menyentuh state lengan: pesan masuk cuma disalin ke antrean, lalu
 * loop() di core 1 yang memprosesnya lewat handleText() yang sama dengan
 * jalur lokal. Satu penulis untuk targetDeg, cal, dan estop, jadi tidak ada
 * race yang perlu dikunci.
 *
 * Satu pengecualian: e-stop. Kalau antrean penuh, yang dibuang adalah pesan
 * tertua, dan pesan tertua itu bisa saja e-stop. Jadi e-stop ikut dicatat di
 * bendera terpisah (cloudEstopPending) yang loop() periksa lebih dulu daripada
 * antrean. E-stop dari cloud tidak bisa hilang karena antrean.
 *
 * Aktif hanya kalau CLOUD_HOST didefinisikan di wifi_secrets.h. Tanpanya
 * firmware sama persis dengan sebelumnya.
 */
#pragma once

#if defined(CLOUD_HOST)
#define CLOUD_ENABLED 1
#else
#define CLOUD_ENABLED 0
#endif

#if CLOUD_ENABLED
#include <WebSocketsClient.h>
#include "cloud_ca.h"

#ifndef CLOUD_PORT
#define CLOUD_PORT 443
#endif
#ifndef CLOUD_ARM_ID
#define CLOUD_ARM_ID "armbot"
#endif
#ifndef CLOUD_DEVICE_KEY
#error "CLOUD_HOST ada tapi CLOUD_DEVICE_KEY tidak: isi keduanya di wifi_secrets.h"
#endif

#define CLOUD_RX_MAX   1536   // = kapasitas StaticJsonDocument di handleText
#define CLOUD_TX_MAX   6144   // cal dan diag jauh lebih besar dari pesan masuk
#define CLOUD_RXQ_LEN  12
#define CLOUD_TXQ_LEN  16
#define CLOUD_STACK    12288  // handshake mbedTLS ECDSA P-384 butuh stack lega

struct CloudMsg { char* p; uint16_t n; };

static WebSocketsClient cloudWs;
static QueueHandle_t cloudRxQ = nullptr;
static QueueHandle_t cloudTxQ = nullptr;
static volatile bool     cloudUp           = false;
static volatile bool     cloudEstopPending = false;
static volatile uint32_t cloudConnCount    = 0;
static volatile uint32_t cloudRxDrop       = 0;
static volatile uint32_t cloudTxDrop       = 0;
static uint32_t cloudRetryMs = 2000;
static char     cloudPath[192];

/* Masukkan pesan yang SUDAH dialokasikan ke antrean. Penuh = buang yang
   tertua: perintah gerak bersifat absolut (yang terbaru menang) dan feedback
   basi tidak berguna, jadi pesan lama yang paling layak dikorbankan. */
static void cloudQueueOwned(QueueHandle_t q, char* p, uint16_t n, volatile uint32_t* drop) {
  CloudMsg m = { p, n };
  if (xQueueSend(q, &m, 0) == pdTRUE) return;
  CloudMsg old;
  if (xQueueReceive(q, &old, 0) == pdTRUE) { free(old.p); (*drop)++; }
  if (xQueueSend(q, &m, 0) != pdTRUE) { free(p); (*drop)++; }
}

static void cloudQueueCopy(QueueHandle_t q, const char* src, size_t n, size_t max,
                           volatile uint32_t* drop) {
  if (!q || n == 0 || n > max) { (*drop)++; return; }
  char* p = (char*)malloc(n + 1);
  if (!p) { (*drop)++; return; }
  memcpy(p, src, n);
  p[n] = 0;
  cloudQueueOwned(q, p, (uint16_t)n, drop);
}

static void cloudEvent(WStype_t type, uint8_t* payload, size_t len) {
  switch (type) {
    case WStype_CONNECTED:
      cloudUp = true;
      cloudConnCount++;
      cloudRetryMs = 2000;
      cloudWs.setReconnectInterval(cloudRetryMs);
      Serial.printf("[CLOUD] tersambung ke relay %s (koneksi ke-%u)\n",
                    CLOUD_HOST, (unsigned)cloudConnCount);
      break;
    case WStype_DISCONNECTED:
      if (cloudUp) Serial.println("[CLOUD] relay putus");
      cloudUp = false;
      /* Backoff supaya HP yang sinyalnya hilang semalaman tidak membuat ESP32
         mengulang handshake TLS tiap 2 detik. */
      cloudRetryMs = cloudRetryMs * 2 > 30000 ? 30000 : cloudRetryMs * 2;
      cloudWs.setReconnectInterval(cloudRetryMs);
      break;
    case WStype_TEXT:
      // Pustaka menjamin payload[len] = 0, jadi strstr aman.
      if (strstr((const char*)payload, "\"cmd\":\"estop\"")) cloudEstopPending = true;
      cloudQueueCopy(cloudRxQ, (const char*)payload, len, CLOUD_RX_MAX, &cloudRxDrop);
      break;
    default:
      break;
  }
}

static void cloudTask(void*) {
  snprintf(cloudPath, sizeof(cloudPath), "/arm/%s/device?key=%s",
           CLOUD_ARM_ID, CLOUD_DEVICE_KEY);
  // Protokol "" = tanpa header Sec-WebSocket-Protocol. Bawaan pustaka
  // ("arduino") minta subprotocol yang tidak dijawab relay.
  cloudWs.beginSslWithCA(CLOUD_HOST, CLOUD_PORT, cloudPath, CLOUD_CA, "");
  cloudWs.onEvent(cloudEvent);
  cloudWs.setReconnectInterval(cloudRetryMs);
  /* Ping tiap 15 dtk: NAT operator seluler menutup koneksi TCP yang diam,
     dan tanpa lalu lintas berkala ESP32 baru tahu koneksinya mati saat
     mencoba mengirim. 2 pong hilang = putus, lalu tersambung ulang. */
  cloudWs.enableHeartbeat(15000, 6000, 2);

  for (;;) {
    bool net = !runningAsAP && WiFi.status() == WL_CONNECTED;
    if (net) {
      cloudWs.loop();
      CloudMsg m;
      while (xQueueReceive(cloudTxQ, &m, 0) == pdTRUE) {
        if (cloudUp) cloudWs.sendTXT((uint8_t*)m.p, m.n);
        free(m.p);
      }
    } else {
      if (cloudUp) { cloudWs.disconnect(); cloudUp = false; }
      CloudMsg m;
      while (xQueueReceive(cloudTxQ, &m, 0) == pdTRUE) free(m.p);
    }
    vTaskDelay(pdMS_TO_TICKS(4));
  }
}

void cloudSetup() {
  cloudRxQ = xQueueCreate(CLOUD_RXQ_LEN, sizeof(CloudMsg));
  cloudTxQ = xQueueCreate(CLOUD_TXQ_LEN, sizeof(CloudMsg));
  if (!cloudRxQ || !cloudTxQ) { Serial.println("[CLOUD] antrean gagal dibuat, jalur cloud mati"); return; }
  // Prioritas 1: di atas idle (supaya jalan) tapi jauh di bawah stack WiFi.
  xTaskCreatePinnedToCore(cloudTask, "cloud", CLOUD_STACK, nullptr, 1, nullptr, 0);
  Serial.printf("[CLOUD] jalur cloud aktif -> wss://%s/arm/%s/device\n", CLOUD_HOST, CLOUD_ARM_ID);
}

/* Dipanggil dari loop() (core 1). Pesan disalin, jadi pemanggil boleh
   langsung memakai ulang buffernya. */
void cloudSendRaw(const char* p, size_t n) {
  if (!cloudUp) return;
  cloudQueueCopy(cloudTxQ, p, n, CLOUD_TX_MAX, &cloudTxDrop);
}

/* Balasan untuk SATU browser lewat relay. Relay menandai tiap pesan dari
   browser dengan "_c" (nomor koneksinya); balasan menyisipkan nomor yang
   sama di depan supaya relay tahu ke mana pong, ack, atau cal harus pergi.
   Broadcast (feedback) tidak bertanda dan disebar ke semua browser. */
void cloudReply(uint32_t to, const char* p, size_t n) {
  if (!cloudUp || n < 2 || p[0] != '{' || n > CLOUD_TX_MAX - 24) return;
  char* q = (char*)malloc(n + 24);
  if (!q) { cloudTxDrop++; return; }
  int k = snprintf(q, 24, "{\"_c\":%lu%s", (unsigned long)to, n > 2 ? "," : "");
  memcpy(q + k, p + 1, n - 1);
  q[k + n - 1] = 0;
  cloudQueueOwned(cloudTxQ, q, (uint16_t)(k + n - 1), &cloudTxDrop);
}

/* Ambil satu pesan masuk. true = ada, *p wajib di-free() pemanggil. */
bool cloudPop(char** p, uint16_t* n) {
  CloudMsg m;
  if (!cloudRxQ || xQueueReceive(cloudRxQ, &m, 0) != pdTRUE) return false;
  *p = m.p; *n = m.n;
  return true;
}

#else   // !CLOUD_ENABLED: stub supaya ino tidak dipenuhi #if
static const bool cloudUp = false;
static volatile bool cloudEstopPending = false;
static const uint32_t cloudConnCount = 0, cloudRxDrop = 0, cloudTxDrop = 0;
void cloudSetup() {}
void cloudSendRaw(const char*, size_t) {}
void cloudReply(uint32_t, const char*, size_t) {}
bool cloudPop(char**, uint16_t*) { return false; }
#endif
