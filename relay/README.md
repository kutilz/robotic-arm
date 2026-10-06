# Relay: kendali lengan lewat internet

Worker + Durable Object Cloudflare yang menjembatani ESP32 dan digital twin di
browser, supaya lengan bisa dikendalikan dari mana saja tanpa memasang apa pun
di perangkat operator.

```
browser (https://robotic-arm-psi.vercel.app, HP, laptop mana pun)
   │  wss://<relay>/arm/<id>/ui?token=OP_TOKEN
   ▼
relay Cloudflare (folder ini)        ← token, satu operator, lease_drop, yang terbaru menang
   ▲
   │  wss://<relay>/arm/<id>/device?key=DEVICE_KEY   (ESP32 yang menelepon KELUAR)
ESP32 di WiFi apa pun yang punya internet (mis. hotspot HP)
```

Jalur lokal (`ws://<ip-esp32>:81` dan halaman bawaan ESP32) **tidak diganti**:
keduanya jalan berbarengan, dan jaringan lokal selalu boleh merebut kendali dari
cloud. Rancangan lengkapnya ada di [`docs/kontrol-jarak-jauh.md`](../docs/kontrol-jarak-jauh.md).

## Deploy (sekali)

Butuh akun Cloudflare gratis. Paket gratis cukup: Durable Object ber-SQLite,
100.000 request per hari, 13.000 GB-detik per hari (dicek 7 Okt 2026). Pesan
WebSocket masuk dihitung 20:1, dan ruang tanpa penonton tidur (hibernasi) tanpa
memakan kuota durasi.

```bash
cd relay
npm install
npx wrangler login                    # buka browser, izinkan
npx wrangler secret put DEVICE_KEY    # string acak panjang, sama dengan CLOUD_DEVICE_KEY di firmware
npx wrangler secret put OP_TOKEN      # token operator, diketik di studio
npx wrangler secret put VIEW_TOKEN    # opsional: token lihat saja (boleh e-stop, tidak boleh gerak)
npm run deploy                        # -> https://armbot-relay.<akun>.workers.dev
```

Buat rahasia acak misalnya dengan `python -c "import secrets;print(secrets.token_urlsafe(24))"`.

Lalu di firmware (`firmware/arm_controller_esp32/wifi_secrets.h`):

```c
#define CLOUD_HOST       "armbot-relay.<akun>.workers.dev"
#define CLOUD_ARM_ID     "armbot"
#define CLOUD_DEVICE_KEY "<DEVICE_KEY yang sama>"
```

plus SSID hotspot HP di `WIFI_PRESETS`, compile (`python tools/remote_build.py`),
flash. Di studio: tombol ▾ di sebelah lampu LINK, pilih **CLOUD**, isi host
relay, id lengan, dan token operator.

## Menjalankan lokal (tanpa akun)

```bash
cd relay
cp .dev.vars.example .dev.vars        # rahasia untuk dev
npm run dev                           # ws://127.0.0.1:8787
```

Simulator lengan yang menyambung ke relay lokal persis seperti ESP32, lengkap
dengan internet tiruan yang tersendat:

```bash
PYTHONPATH=src python -m arm.bridge --simulate --no-local \
  --cloud "ws://127.0.0.1:8787/arm/armbot/device?key=dev-device-key" \
  --delay 60 --jitter 40 --stall 20:2
```

Di studio isi host relay `127.0.0.1:8787`, id `armbot`, token `dev-op-token`.

## Uji

```bash
npm test                              # aturan relay di Node (room.js), tanpa Cloudflare
python tools/uji_relay_e2e.py         # ujung ke ujung: relay lokal + simulator + browser tiruan
```

`uji_relay_e2e.py` juga bisa diarahkan ke relay yang sudah di-deploy
(`--relay wss://... --key ... --token ...`).

## Apa yang dikerjakan relay, dan apa yang tidak

Relay **tidak** mengendalikan lengan. Lease, batas laju, pemegang kendali lokal
vs cloud, dan daftar perintah yang boleh dari cloud semuanya ditegakkan
firmware. Relay hanya mengurus hal yang cuma terlihat dari tengah:

| Aturan | Kenapa di relay |
| --- | --- |
| Alamat balasan `_c` | ESP32 punya satu koneksi ke relay, tidak bisa membedakan browser. Pong, ack, dan cal diantar ke browser yang bertanya saja. |
| Satu operator di antara browser cloud | Firmware melihat satu jalur "cloud"; dua browser yang sama sama ARM akan saling tarik tanpa firmware tahu. |
| `lease_drop` | Browser pemegang kendali menutup tab: firmware diberi tahu seketika, tidak menunggu lease habis. |
| Yang terbaru menang | `goto` lebih rapat dari 50 ms digabung; e-stop tidak pernah ditahan. |
| Laju feedback | ESP32 baru mengirim feedback ke cloud kalau ada yang menonton. |
| Autentikasi | Di Worker, sebelum Durable Object dibangunkan. Token salah tidak memakan kuota DO. |
