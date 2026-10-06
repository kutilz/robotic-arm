# Kendali jarak jauh: jalur LOKAL dan CLOUD

Ditulis 7 Okt 2026. Pertanyaan awalnya: bisakah digital twin dibuka dari mana
saja, tanpa memasang apa pun, dan langsung mengendalikan lengan?

Bisa, dengan dua syarat yang tidak bisa ditawar:

1. **Halaman https tidak boleh membuka `ws://`.** Twin di Vercel adalah
   halaman https, dan ESP32 tidak punya TLS untuk servernya sendiri. Jadi
   jalur lokal tidak pernah bisa dipakai dari twin yang di-host.
2. **ESP32 di WiFi rumah tidak terjangkau dari internet.** Relay di PC rumah
   atau Tailscale menyelesaikan ini, tapi bergantung pada PC, WiFi rumah, atau
   instalasi di perangkat operator.

Jawabannya: **ESP32 yang menelepon keluar.** Lengan cukup tersambung ke WiFi
apa pun yang punya internet (hotspot HP), membuka `wss://` ke relay Cloudflare,
dan browser menyambung ke relay yang sama. Tidak ada PC, port forwarding, atau
instalasi di sisi mana pun.

Jalur lokal **tetap ada** dan tetap jadi jalur utama di samping lengan. Pilihan
jalur ada di tombol ▾ sebelah lampu LINK (desktop) atau ikon koneksi (HP).

| | LOKAL | CLOUD |
| --- | --- | --- |
| Alamat | `ws://<ip-esp32>:81` | `wss://<relay>/arm/<id>/ui?token=...` |
| Dari mana | WiFi yang sama, halaman `http://` | mana saja, termasuk twin di `https://` |
| Bergantung pada | WiFi lokal | internet + Cloudflare |
| RTT khas | belasan ms | 100 sampai 250 ms (dua kaki 4G) |
| Kalibrasi, servo mentah, nada | boleh | ditolak firmware |
| Rebutan kendali | selalu menang | kalah dari lokal |

## Masalah sebenarnya bukan latensi, tapi jitter

Latensi rata rata internet tidak berbahaya untuk lengan ini: TEACH 8 deg/s,
jadi telat 200 ms setara 1,6 derajat. Yang berbahaya adalah **stall**: 4G
menahan paket setengah sampai beberapa detik lalu menumpahkannya bersamaan.
Desain lama (studio mengalirkan target kecil 20 kali per detik, firmware
menuliskan pulsa servo seketika) bergantung pada pesan yang datang rata. Di
internet, sepuluh pesan yang tertumpuk tiba sekaligus dan pergelangan melompat.

Penanganannya ditaruh di lapisan yang bisa menjaminnya:

### Firmware (guardrail, berlaku di kedua jalur)

- **Lease.** Perintah gerak membawa `lease` (ms): berlaku sejak diterima,
  diperpanjang ping selama ARM menyala. Habis = stepper direm dengan ramp,
  target dibekukan di posisi sekarang, `hold:true` di feedback. Ini mengganti
  dead-man lama yang menghitung jumlah klien, yang buta di jalur cloud (link ke
  relay bisa tetap hidup walau browser operatornya hilang).
- **Batas laju servo.** J5/J6 kini dibatasi `cal.maxSpeedDps` yang sama dengan
  stepper. Paket yang menumpuk tidak lagi bisa membuat pergelangan melompat.
- **Satu pemegang kendali.** Gerak hanya dari jalur yang memegang kendali;
  e-stop dari mana pun; lokal selalu boleh merebut dari cloud.
- **Daftar putih cloud.** Dari cloud hanya `goto`, `gripper`, `servo_us`
  (gripper saja, dijepit ke rentang kalibrasinya), `estop`, `resume`, `ping`,
  `cal_get`, `diag`, dan `cal_set {speed, accel}` (dijepit ke profil RUN).
- **Klien cloud di task sendiri (core 0).** Handshake TLS 1 sampai 2 detik
  tidak menahan loop kendali. Pesan cloud diantre dan diproses `loop()` lewat
  `handleText()` yang sama dengan jalur lokal. E-stop punya bendera sendiri,
  jadi tidak bisa terbuang dari antrean yang penuh.
- **TLS diverifikasi** terhadap root CA Cloudflare (`cloud_ca.h`, dibangkitkan
  `tools/gen_cloud_ca.py`). Tanpa itu siapa pun di hotspot yang sama bisa
  menyamar jadi relay.

### Relay (`relay/`)

Alamat balasan per browser, satu operator di antara browser cloud,
`lease_drop` saat operator menutup tab, `goto` yang terbaru menang, laju
feedback sesuai ada tidaknya penonton. Rinciannya di
[`relay/README.md`](../relay/README.md).

### Studio

- **Ukur, jangan tebak.** Ping tiap 500 ms ke ESP32 (lewat relay kalau cloud),
  RTT p50/p95/jitter tampil di bilah interlock dan bisa diunduh sebagai CSV.
  Sampel yang melintasi kemacetan main thread halaman sendiri (mis. parse model
  CAD) ditandai dan tidak ikut statistik.
- **Tingkat link** (`studio/src/net/netQuality.js`):

  | Tingkat | Syarat | LIVE | RUN | Feedback cloud |
  | --- | --- | --- | --- | --- |
  | LAN | p95 < 40 ms | ya, 20 Hz | ya | 20 Hz |
  | Baik | p95 < 300 ms | ya, target 5 Hz | ya | 20 Hz |
  | Buruk | p95 ≥ 300, loss > 10%, atau pong telat > 1 s | tidak | TEACH saja | 10 Hz |
  | Putus | pong telat > lease | gerak ditolak, ARM dilucuti | | |

  Turun seketika, naik setelah bertahan 5 detik.
- **Lease** = 1 s di lokal; di cloud `3 x p95 + 2 x 500 ms`, antara 1,5 dan 5 s.
- **Periode kirim cloud 200 ms** dengan jatah per pesan yang membesar, jadi
  laju gerak per detik identik dengan jalur lokal (dibuktikan `verify_net.mjs`).
- **Penanda TCP aktual** (bola oranye + garis) saat model menampilkan target:
  operator melihat seberapa jauh lengan tertinggal di ruang 3D, bukan cuma di
  deretan angka.

## Alamat relay dan blokir operator

Relay di-deploy 7 Okt 2026 ke akun Cloudflare user. Alamat yang dipakai
studio dan firmware: **`armbot-relay.pages.dev`**. Alamat Worker aslinya
(`armbot-relay.kutilz.workers.dev`) diblokir DNS oleh XL Axiata, termasuk
kueri ke 1.1.1.1, jadi tidak bisa dipakai dari HP atau ESP32 di hotspot XL.
Rinciannya dan jalan keluar kalau `pages.dev` ikut diblokir ada di
[`relay/README.md`](../relay/README.md).

Hasil ukur 7 Okt 2026, laptop di hotspot XL memainkan lengan (simulator) DAN
operator sekaligus, jadi dua kaki seluler lewat satu uplink:

| Pengukur | RTT p50 | p95 | Tingkat |
| --- | --- | --- | --- |
| klien Python, 30 ping | 126 ms | 186 ms | Baik |
| twin publik di Vercel, Edge headless | 132 ms | 284 ms | Baik |
| twin publik, sesi lain beberapa menit sebelumnya | 519 sampai 951 ms | 1,2 sampai 1,8 s | Buruk (LIVE ditahan) |

Baris terakhir menunjukkan kenapa tingkat link perlu ada: di jaringan yang
sama, dalam beberapa menit, RTT bisa naik lima kali lipat.

## Keterbatasan yang harus diketahui

- Ketergantungannya pindah, tidak hilang: bebas dari PC dan WiFi rumah, tapi
  bergantung pada internet dan Cloudflare. WiFi kampus dengan halaman login
  (captive portal) tidak bisa dilewati ESP32; pakai hotspot HP.
- **Untuk sidang atau pengambilan data, pakai jalur lokal.** Cloud untuk
  pantau dan kontrol santai.
- E-stop dari browser lewat internet ikut telat 100 sampai 300 ms. Kalau lengan
  dikendalikan dari jauh, e-stop fisik di dekat lengan jadi wajib.
- Twin hanya menampilkan feedback. J5/J6 masih memakai kalibrasi pot
  placeholder. Kendali tanpa melihat lengan (tanpa kamera) sebaiknya dibatasi
  ke TEACH.
- Berubah untuk jalur lokal juga: **ARM dimatikan = lengan berhenti dalam
  satu lease (1 s)**, tidak lagi menuntaskan target terakhir. Dan J5/J6 sekarang
  bergerak pada laju profil, bukan melompat ke target.
- Belum diuji di lengan asli. Yang sudah terbukti: aturan relay (14 uji Node),
  blok JALUR di simulator (14 uji pytest), ujung ke ujung relay lokal +
  simulator + browser tiruan, dan studio di peramban lewat relay lokal.
  Firmware lolos compile dengan dan tanpa jalur cloud, tapi belum di-flash.

## Uji

```bash
node studio/tools/verify_net.mjs          # tingkat link, histeresis, lease, laju sama di dua jalur
cd relay && npm test                      # aturan relay
python -m pytest tests/test_bridge_jalur.py   # blok JALUR (simulator = cermin firmware)
python tools/uji_relay_e2e.py             # ujung ke ujung (butuh `npm run dev` di relay/)
```

Langkah uji di lengan asli (belum dilakukan):

1. Flash tanpa `CLOUD_HOST`. Pastikan jalur lokal tidak berubah selain dua hal
   di atas (lease saat ARM mati, laju J5/J6).
2. Isi `CLOUD_HOST`, flash, cek Serial: `[CLOUD] tersambung ke relay`. Cek
   `diag.heap_min` tetap di atas 40 KB sesudah handshake.
3. Dari HP dengan data seluler: sambung CLOUD, ARM, jog J1 kecil. Matikan data
   HP di tengah gerak: lengan harus direm dalam satu lease.
4. Saat cloud memegang kendali, gerakkan dari halaman lokal: lokal harus
   merebut, studio cloud harus dilucuti dengan alasan.
5. Unduh log RTT dari kedua jalur untuk Bab IV.
