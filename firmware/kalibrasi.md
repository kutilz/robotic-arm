# Kalibrasi sendi stepper

Prosedur dan jebakan yang sudah terbukti di hardware. Ditulis sesudah kalibrasi
J1 tanggal 7 Agustus 2026, diperluas sesudah J2 tanggal 12 Agustus 2026. Data
hasilnya ada di `benchmarks/kalibrasi/`.

Perkakas:

```
$env:SENDI=2                                  # sendi yang dikalibrasi (1..4)
$env:TAHAP="magnet-terpasang"                 # label percobaan (opsional)
python tools/kalibrasi_sendi.py <perintah> [arg] [tahap]
python tools/kalibrasi_analisa.py <tahap>     # bedah kurva galat
```

`tahap` cuma label yang ikut masuk kolom CSV, supaya satu berkas bisa memuat
banyak percobaan tanpa saling menimpa. Pakai `$env:TAHAP`, bukan argumen
posisi: posisi ketiga hanya sampai pada perintah yang punya argumen kedua, jadi
`tutup magnet-terpasang` diam-diam tercatat dengan tahap `-`.

## Yang dikalibrasi, dan yang TIDAK

Kalibrasi sendi cuma mengurus tiga angka: `enc_sign`, `enc_offset`, `ratio`.
Sisanya (arus TMC, microstep, kp, deadband) parameter tuning, bukan kalibrasi,
dan tidak ditentukan oleh pengukuran di bawah.

`enc_offset` selalu dalam satuan sudut MENTAH AS5600 (0..360), bukan sudut
sendi. Karena encodernya absolut, offset ini cukup dicatat sekali: sesudah
re-flash, mengirim ulang `enc_offset` dan `enc_sign` yang sama akan
mengembalikan frame kalibrasi yang persis sama tanpa perlu memindahkan lengan.

## Urutan yang aman

Urutannya bukan selera. Tiap langkah menutup satu cara gagal yang sudah pernah
terjadi.

1. **`siap`** e-stop, `kp=0`, kecepatan diturunkan ke 8 deg/s, microstep 16.

   `kp=0` bukan sekadar kebersihan pengukuran. Kalau `enc_sign` terbalik,
   loop tertutup jadi umpan balik positif dan lengan lari sampai limit. Selama
   tanda belum dibuktikan, loop harus mati.

2. **`bising 5`** sebar bacaan encoder saat diam. Kalau sebarannya jauh di atas
   1 LSB (0,088 deg), berhenti dan betulkan magnetnya dulu; angka kalibrasi
   apa pun sesudah itu cuma menghias derau.

3. **`nol`** `cal_zero` sendi itu, lalu joint limit dipersempit ke +-40 **di
   firmware**. Firmware yang meng-clamp tiap `goto`, jadi ini pagar sungguhan,
   bukan kesopanan skrip.

   Urutannya penting: `cal_zero` DULU baru limit dipersempit. Kalau limit
   dipersempit lebih dulu, target lama (mis. -149 deg) langsung di-clamp ke
   -40 dan lengan menempuh selisihnya begitu e-stop dilepas.

4. **`lepas`** e-stop dilepas. Sendi biasanya bergeser 1-2 LSB saat driver
   hidup, itu motor menempel ke fase microstep terdekat, bukan kesalahan.

5. **`gerak 5`** gerakan uji lima derajat. Kecil sekali, dan memang sengaja:
   di sinilah tiga kesalahan besar ketahuan sebelum lengan berayun jauh.
   - encoder bergerak berlawanan arah   -> `enc_sign` terbalik
   - encoder bergerak ~15x lipat        -> magnet ada di poros MOTOR, bukan
     output; seluruh rencana pengukuran harus diganti
   - encoder nyaris tak bergerak        -> stall, slip, atau kanal belum diklaim

6. **`sign -1`** kalau arahnya terbalik. Ulangi `gerak` untuk memastikan.

7. **`sapu`** linieritas dan galat open-loop. Rasio hanya kalau sendinya bisa
   berputar penuh (lihat bagian berikut); backlash dari sini JANGAN dipakai.

8. **`ulang 5`** pengulangan mekanis, masih `kp=0`.

9. **`histeresis 20`** backlash yang dilaporkan, diukur di sudut berbeban.

10. **`pulih 175`** kembalikan `kp`, kecepatan, dan limit kerja.

11. **`magnet 80:20`** AGC dan magnitude di sepanjang travel. Magnet ikut
    berputar bersama sendi, jadi memeriksanya di satu pose saja bisa memberi
    lampu hijau palsu.

12. **`tutup`** galat loop tertutup, yaitu angka yang benar benar dirasakan
    pemakai. WAJIB dibandingkan dengan galat open-loop dari langkah 7: kalau
    keduanya sama, loopnya mati, bukan mekaniknya yang bagus.

13. **`simpan`** `cal_save` ke NVS. Sebelum ini semuanya cuma di RAM dan hilang
    saat reboot atau re-flash.

Kecepatan kerja ikut tersimpan, dan `pulih` menurunkannya ke 30 deg/s. Kalau
nilai kerja unitnya lebih tinggi, kembalikan dulu sebelum `simpan`, kalau tidak
lengan diam diam jadi separuh kecepatan sesudah kalibrasi.

## Jebakan besar: rasio TIDAK bisa diukur di jendela sempit

Ini kesalahan yang paling mahal waktunya, dan hasilnya kelihatan sangat
meyakinkan padahal salah.

Sapuan J1 di rentang berbeda memberi "rasio sejati" yang berbeda beda:

| rentang sapuan | kemiringan | "rasio sejati" |
| --- | --- | --- |
| -20 .. +20 | 0,9621 | 15,59 |
| -20 .. +20 (ulang) | 0,9627 | 15,58 |
| +20 .. +60 | 0,9908 | 15,14 |
| -60 .. -20 | 0,9875 | 15,19 |
| -85 .. +85 | 0,9850 | 15,23 |
| **-170 .. +170** | **1,0026** | **14,96** |

Dua sapuan pertama identik titik demi titik, jadi pengulangannya bagus dan
angkanya terasa kokoh. Tetap saja salah 4 persen. Sebabnya: galat encoder yang
berpola sekali dan dua kali per putaran menyamar jadi galat skala kalau yang
diamati cuma sepotong busur. Baru pada satu putaran penuh keduanya terpisah,
dan jawabannya rasio 15 persis seperti rancangan.

Akibatnya untuk J2 ke atas:

- **Putar satu putaran penuh, atau jangan sentuh angka `ratio` sama sekali.**
  Lebih baik memakai nilai rancangan daripada memaku artefak pengukuran ke
  dalam kalibrasi.
- Kalau sendinya tidak bisa berputar penuh (J2 dan J3 memang tidak bisa),
  rasio harus datang dari HITUNGAN GIGI, bukan dari sapuan. Hitung jumlah gigi
  pulley atau lobe cycloidal; angkanya eksak dan gratis.
- `tools/kalibrasi_analisa.py` sekarang mencetak PERINGATAN kalau liputan data
  di bawah 300 derajat. Peringatan itu jangan diabaikan: pada jendela sempit,
  pemisahan suku garis lurus dan suku sinus menghasilkan dua bilangan besar
  yang saling meniadakan (pernah keluar amplitudo 8,7 deg melawan skala +10
  persen) dan sisanya cuma turun 41 persen.

## Jebakan yang ditemukan saat J2 (12 Agustus 2026)

Tiga cacat berikut membuat sendi ber-encoder MUSTAHIL dikalibrasi sebelum
dibetulkan. Semuanya sudah diperbaiki, tetapi gejalanya perlu dikenali karena
tak satu pun tampak seperti penyebabnya.

**`kp = 0` membekukan sendi ber-encoder, bukan sekadar mematikan koreksi.**
Ini yang paling mahal. Seluruh prosedur di atas menyuruh `kp = 0` selama
pengukuran, padahal cabang koreksi loop kendali menghitung `corr = kp * err`,
lalu MENGGESER step counter ke `(target - corr)` dan memerintahkan
`moveTo(target)`. Dengan `kp = 0`, `corr` jadi nol, counter digeser tepat ke
target, dan `moveTo` menyuruh sendi ke tempat yang sudah ditempatinya. Sendi
tidak melangkah sama sekali sementara firmware yakin sudah sampai.

Gejalanya: `gerak 5` memberi faktor gerak 0,0000, encoder diam sempurna, dan
`cs` driver tidak pernah naik dari arus tahan. Mudah tertukar dengan motor
tidak tersambung; di J2 sempat tertuduh kabel motor karena drivernya juga
melapor `ol=true`. (Flag `ol` itu ternyata artefak standstill pada driver yang
sejak boot belum pernah melangkah, dan bersih sendiri sesudah motor berjalan.)

J1 lolos dari cacat ini hanya karena pengukurannya dilakukan SEBELUM
penggeseran counter diperkenalkan pada perbaikan 7 Agustus. Perbaikannya:
`kp <= 0` sekarang ikut jalur open-loop yang sama dengan encoder mati, karena
"koreksi dimatikan" memang berarti open-loop, bukan sendi dibekukan.

**AS5600 tanpa magnet tetap meng-ACK dan tetap mengeluarkan RAW ANGLE.**
Guardrail encoder yang lama hanya menghitung gagal-baca I2C, jadi encoder tanpa
magnet lolos ke loop kendali sebagai sudut yang sah. Terukur di J2: sudut
dilaporkan -43 deg dengan `fault=0` padahal magnetnya belum terpasang sama
sekali, dan sendi itu memikul seluruh lengan. Sekarang bit MD diperiksa berkala
(250 ms per sendi) dan MD=0 langsung jadi FAULT tanpa menunggu batas gagal
beruntun. `cal_zero` juga menolak mengambil offset dari encoder tanpa magnet,
sebab offset palsu jadi permanen begitu `cal_save` dipanggil.

Yang diperiksa hanya MD, BUKAN ML. Magnet J1 melapor ML=1 (medan lemah, AGC
mentok) tetapi sehat dan sudah terkalibrasi, jadi menolak ML akan mematikan
sendi yang baik-baik saja.

**Perkakas mengirim `goto` ke indeks 0, bukan ke sendi yang dipilih.**
`tools/kalibrasi_sendi.py` lahir waktu hanya J1 yang punya encoder, dan ketiga
pemanggil `goto` menulis `[t, None, None, None, None, None]` harfiah. Dengan
`$env:SENDI=2` seluruh pembacaan diambil dari J2 sementara yang digerakkan J1.
Gejalanya jahat: sendi yang diukur diam, sendi lain yang bergerak.

## Backlash dari sapuan MENGGELEMBUNG, ukur langsung dengan `histeresis`

`sapu` menaksir backlash dari SATU kaki pembalikan dibanding kemiringan hasil
fit, jadi taksirannya ikut memikul seluruh nonlinieritas encoder. Di J2 selisih
kedua metode itu empat kali lipat:

| cara ukur | hasil J2 |
| --- | --- |
| `sapu` (satu kaki lawan kemiringan fit) | 0,215 deg |
| `histeresis` (3x2 pendekatan, rerata dua arah) | **0,054 deg** |

Kaki-kaki sapuan J2 sendiri tersebar 7,29 sampai 7,74 deg untuk perintah yang
sama besar, dan kaki pembalikan 7,290 duduk di dalam sebaran itu. Artinya angka
0,215 tidak bisa dibedakan dari derau sapuannya sendiri.

Pakai `histeresis <sudut>[:<ulangan>]` untuk angka yang dilaporkan. Perintah itu
juga sengaja mengukur di sudut BERBEBAN, bukan di 0 deg: untuk sendi pitch,
0 deg justru pose tegak tempat torsi gravitasi nyaris nol, dan di sana tidak ada
yang menentukan sisi mana dari backlash yang tersentuh.

Konsekuensinya untuk J1: **backlash 0,617 deg di tabel bawah lahir dari metode
`sapu` yang sama dan perlu diukur ulang** dengan `histeresis` sebelum dipakai
sebagai angka final.

## Jebakan lain yang sudah memakan waktu

**Ambang "sudah berhenti" harus di atas 1 LSB encoder.** Bacaan yang benar
benar diam pun bergoyang antara dua LSB bertetangga (0,088 deg). Ambang 0,05
deg tidak pernah terpenuhi, dan tiap gerak dilaporkan "belum diam" padahal
sudah berhenti sejak tadi.

**Backlash harus diukur terpisah dari rasio.** Uji bolak balik mencampur
keduanya: backlash itu rugi tetap tiap pembalikan arah, galat rasio itu rugi
sebanding jarak. Sapuan SATU ARAH memisahkannya, asal kaki pertama dipakai
untuk memakan backlash (skripnya turun 3 deg di bawah titik awal dulu, baru
naik).

**Jangan tahan socket WebSocket tanpa dibaca.** `asyncio.sleep()` panjang tanpa
menguras socket membuat buffer penuh, task pembaca berhenti, ping dari ESP32
tak terbalas, dan sambungan diputus di tengah pengukuran. Kuras terus.

**Sesudah re-flash, kalibrasi kembali ke default dan itu berbahaya.**
`enc_sign` balik ke +1 sementara loop tertutup sekarang benar benar bekerja.
Urutan pemulihan yang aman: e-stop dulu, kirim `enc_sign` dan `enc_offset`
lama, samakan target dengan aktual lewat `goto` SELAGI masih e-stop, baru
`resume`. Tanpa itu, sudut aktual melompat saat kalibrasi dibetulkan sementara
target masih memakai angka lama, dan lengan menempuh selisihnya (di J1 selisih
itu 111 derajat).

## Hasil J1, 7 Agustus 2026

| besaran | nilai | catatan |
| --- | --- | --- |
| rasio | 15 (terukur 14,96) | sesuai rancangan, tidak diubah |
| `enc_sign` | -1 | semula +1, SALAH |
| `enc_offset` | 11,25 deg raw | |
| derau encoder diam | 0,006 deg rms, 1 LSB puncak | |
| pengulangan satu arah | 0,054 deg simpangan baku | lebih halus dari 1 LSB |
| backlash | 0,617 deg | beda rerata dua arah di titik yang sama |
| galat encoder sistematis | 1,38 deg (2/putaran) + 0,87 deg (1/putaran) | magnet |
| sisa sesudah model | 0,246 deg rms | |
| galat loop tertutup | 0,212 deg rms, 0,290 deg maks | sesudah perbaikan firmware |

Magnet AS5600 J1 melapor `ML=1` dengan `AGC=128` (mentok untuk suplai 3,3 V),
artinya medan terlalu lemah dan chip sudah menaikkan gain sampai batas. Itu
cocok dengan galat 1 dan 2 siklus per putaran di atas: magnetnya tidak sepusat
dan kemungkinan miring. Memperbaiki dudukan magnet adalah satu satunya cara
menurunkan galat absolut J1 di bawah 1 derajat; pengulangannya sudah bagus dan
tidak akan membaik dari sisi perangkat lunak.

## Bug loop tertutup yang ditemukan lewat kalibrasi ini

Sebelum 7 Agustus 2026, koreksi closed-loop **tidak mengoreksi apa pun**.
Galat loop tertutup terukur identik dengan galat open-loop di tiap titik
(rms 1,20 deg, maks 2,10 deg), dan sendinya diam saja pada galat tetap 2
derajat, bukan berosilasi mencari.

Sebabnya: koreksi dikirim sebagai `moveTo(target + koreksi)`. Begitu stepper
mulai jalan, cabang `isRunning()` satu iterasi loop berikutnya menimpanya
dengan `moveTo(target)`, jadi koreksi dibatalkan sebelum sempat ditempuh.
Sisa geraknya cuma beberapa step, di bawah 1 LSB AS5600, sehingga tidak
terlihat maupun terdengar.

Perbaikannya: koreksi diberikan dengan MENGGESER frame step counter ke
`(target - koreksi)` lalu memerintahkan `moveTo(targetSteps)` yang biasa. Kedua
cabang kini menuju tujuan yang SAMA, dan galat menutup secara geometris dengan
faktor `(1 - kp)` tiap siklus. Sesudah perbaikan: rms 0,212 deg, maks 0,290
deg, seluruh titik masuk deadband 0,3 deg.

Pelajarannya untuk sendi berikutnya: **selalu ukur galat loop tertutup dan
bandingkan dengan galat open-loop di titik yang sama.** Kalau keduanya sama,
loopnya mati, bukan mekaniknya yang bagus.

## Hasil J2, 12 Agustus 2026

Home = pose tegak atas, ditetapkan pemakai lewat slider studio. Rasio TIDAK
diukur: J2 tidak bisa berputar penuh, jadi 30 diambil dari hitungan pin
cycloidal, sesuai aturan di bagian jendela sempit di atas.

| besaran | nilai | catatan |
| --- | --- | --- |
| rasio | 30 | dari hitungan pin, tidak diukur |
| `enc_sign` | -1 | semula +1, SALAH (sama seperti J1) |
| `enc_offset` | 61,17 deg raw | |
| kanal mux | 3 | bukan 1, lihat `pinout.md` §4 |
| derau encoder diam | 0,020 deg sd, 2 nilai LSB bertetangga | |
| pengulangan satu arah | 0,009 - 0,012 deg sd | J1: 0,054 deg |
| histeresis di +20 deg | 0,054 deg | 0,6 LSB, metode `histeresis` |
| sisa terhadap garis lurus | 0,133 deg rms, 0,187 deg maks | sapuan +-30 |
| galat open-loop | -0,312 deg rerata, 0,500 deg maks | sapuan yang sama |
| galat loop tertutup | 0,189 deg rms, 0,226 deg maks | seluruh titik di dalam deadband |
| AGC magnet, -80..+80 deg | 101 - 103 (rentang 2) | J1 mentok 128 |
| magnitude magnet | 2055 - 2141 | J1: 1417 |

Magnet J2 jauh lebih sehat daripada J1: AGC tidak pernah mentok di sepanjang
travel dan MD/ML/MH bersih di semua titik, jadi tidak ada tanda magnet miring
atau kejauhan. Itu cocok dengan sisa linieritasnya yang setengah J1.

**Loop tertutupnya terbukti bekerja, bukan sekadar terlihat bagus.** Di sesi
yang sama, open-loop memberi galat maksimum 0,500 deg dan tertutup 0,226 deg.
Perbandingan itu wajib dilakukan tiap sendi: kalau keduanya sama, loopnya mati
(pelajaran J1 di bawah).

Sisa galat J2 sekarang dibatasi DEADBAND, bukan mekaniknya. Polanya sistematis:
didatangi dari bawah galatnya selalu negatif, dari atas selalu positif, dan
semuanya persis di bawah `deadband` 0,3 deg. Untuk lebih ketat, yang diturunkan
deadband-nya, dengan risiko sendi mulai berburu.

**Satu sesi pengukuran dibatalkan.** Magnet encoder sempat lepas di tengah
jalan dan baru ketahuan sesudahnya. Barisnya tidak dihapus tetapi diberi tahap
`BATAL-magnet-copot` di CSV. Bedanya besar dan berguna sebagai pembanding: sisa
linieritas 0,241 lawan 0,133 deg, sebaran antar kaki sapuan 1,23 lawan 0,45 deg,
dan AGC yang melonjak ke 128 di sebagian sudut. Tandanya di lapangan: pembacaan
diam TERLALU sempurna (satu nilai unik tanpa dither 1 LSB) dan histeresis persis
0,000 deg di semua ulangan. Bacaan yang lebih tenang daripada 1 LSB encoder itu
sendiri patut dicurigai, bukan disyukuri.

## Catatan khusus J2 ke atas

- `ENC_ADA[]` di `arm_controller_esp32.ino` sekarang `{true, true, false, false}`:
  J1 dan J2 punya encoder, J3 dan J4 belum. Untuk sendi yang belum punya,
  `cal_zero` tetap jalan tetapi memakai step counter dan melaporkannya sebagai
  open-loop, bukan mengarang offset encoder.
- Peta kanal mux bukan lagi 1:1 dengan nomor sendi. `ENC_CHANNEL[] = {0,3,2,1}`:
  J2 di kanal 3 karena kanal 1 tidak pernah meng-ACK. Sebelum memasang encoder
  J3 atau J4, jalankan `{"cmd":"i2c_scan"}` dan cocokkan hasilnya dengan
  `ENC_CHANNEL[]`; jangan percaya nomor kanal dari rancangan.
- Tanpa mux TCA9548A terpasang, `readAS5600Raw()` sengaja hanya mengakui kanal
  J1 dan mengembalikan NAN untuk sisanya, supaya empat sendi tidak diam diam
  "membaca" satu encoder yang sama.
- Sejak 11 Agu 2026 tiap sendi punya drivernya sendiri, jadi tidak ada lagi
  sendi yang "menunggu giliran kanal". Kalau satu sendi tidak bergerak, cek log
  boot `[TMC] J.. conn=` dan `[STEP] J.. gagal connect` dulu sebelum
  menyalahkan mekanik.
- J2 dan J3 tidak bisa berputar penuh, jadi rasionya WAJIB dari hitungan gigi.

---

# Kalibrasi servo (J5, J6, gripper)

Prosedur terpisah dari sendi stepper di atas: servo tidak punya AS5600 dan tidak
punya step counter. Yang dipakai potensiometer internal servo, dibaca ADS1115
lewat bus I2C yang sama (§3 `pinout.md`). Perkakas: `tools/kalibrasi_servo.py`.

## Yang dicari

1. **Titik awal, tengah, akhir travel** (permintaan utama): batas pulsa yang
   benar-benar bisa ditempuh servo, plus titik tengah yang jadi pose default
   saat boot.
2. **Karakterisasi**: linearitas, histeresis, repeatability, derau.
3. **Kecepatan**: step response direkam firmware pada 860 SPS.

## Urutan

```
python tools/kalibrasi_servo.py cek           # read-only, tidak menggerakkan apa pun
python tools/kalibrasi_servo.py derau         # batas bawah ketelitian
python tools/kalibrasi_servo.py sapu 0        # 0=J5, 1=J6, 2=gripper
python tools/kalibrasi_servo.py terap 0,...   # perintahnya dicetak oleh `sapu`
python tools/kalibrasi_servo.py linear 0
python tools/kalibrasi_servo.py ulang 0
python tools/kalibrasi_servo.py cepat 0
python tools/kalibrasi_servo.py simpan        # ke NVS
```

`cek` dijalankan **sebelum** apa pun bergerak: dia memastikan ADS1115 terdeteksi
dan tegangan wiper tidak melewati batas aman input.

## Pagar pengaman yang dipakai

- **Sapuan bertahap 20 µs, bukan lompat 500 → 2500.** Servo tidak melaporkan
  kegagalan; kalau diperintah melewati ujung travelnya dia menekan stop internal
  terus menerus dan panas. Perkakas melangkah kecil sambil memeriksa apakah
  wiper masih mengikuti, dan begitu berhenti mengikuti tiga langkah berturut
  turut, titik itu dianggap ujung dan servo langsung ditarik mundur.
- **Margin 40 µs hanya untuk ujung yang benar-benar mentok.** Kalau sapuan
  berhenti karena menyentuh batas perintah 500/2500 µs, tidak ada stop mekanis
  yang ditekan, jadi menarik masuk cuma membuang travel yang sehat.
- **Ketiga titik diukur ulang di posisi finalnya.** Memasangkan mV dari sapuan
  (diambil sebelum margin) dengan µs setelah margin akan menggeser seluruh
  pemetaan mV → derajat sebesar margin itu.
- **Henti darurat saturasi** pada pembacaan tenang ≥ 3250 mV.

## Jebakan yang sudah memakan waktu

**Pointer register ADS1115.** Menulis CONFIG untuk memulai konversi meninggalkan
pointer di `0x01`, jadi pembacaan berikutnya mengembalikan isi CONFIG dan bukan
hasil konversi, tanpa error apa pun. Tandanya: nilai antar kanal berbeda tepat
4096 hitungan dan semuanya negatif. Terukur A0 −15485, A1 −11389, A2 −7293,
yaitu persis kata CONFIG `0xC383`/`0xD383`/`0xE383`. Semua pembacaan wajib lewat
`adsReadConvAman()`.

**Ground bounce mengalahkan derau ADC.** Selama motor servo masih menarik arus
untuk mengoreksi posisi, arus itu lewat kabel GND bersama dan menggeser
referensi ADS1115: simpangan baku satu pembacaan melompat dari ~0,1 mV ke
100–440 mV, selalu meleset ke arah RENDAH. Karena itu setiap pengukuran menunggu
`sd ≤ 5 mV` dulu, dan analisis kecepatan memakai median 5 titik + jendela 40
sampel. Tanpa penyaring itu kecepatan MG996R terhitung 789 deg/s, yaitu 2,2×
lebih cepat daripada spesifikasinya sendiri (0,17 s/60° = 353 deg/s).

**Potensiometer memberi ukuran linier relatif, bukan sudut absolut**, jadi skala
derajat wajib diikat ke pengukuran fisik. Untuk mengisinya:

```
python tools/kalibrasi_servo.py busur 0,<deg_di_us_min>,<deg_di_us_max>
```

Perintah itu sekaligus merapatkan `joint_min/max` ke travel yang benar-benar
ada. Tanpa itu studio menawarkan sudut yang tidak bisa dicapai: perintahnya diam
diam ter-clamp di `servoAngleToUs()` dan sendi berhenti lebih awal tanpa ada
yang melaporkan bahwa batasnya tidak nyata.

**Metode yang dipakai: kolinearitas, bukan membaca busur derajat.** Mata manusia
buruk menaksir "ini berapa derajat" tetapi sangat tajam menilai lurus atau
tidak. Pada ketiga servo, posisi horn di 500 µs dan di 2500 µs berada tepat pada
satu garis lurus, jadi jaraknya 180° dan skalanya 0,0900 °/µs. Angka itu
kebetulan sama persis dengan asumsi standar servo hobi, sehingga seluruh angka
derajat yang sudah dihitung sebelumnya tidak berubah; yang berubah statusnya,
dari asumsi menjadi terukur.

## Hasil 10 Agustus 2026

Ketiga servo menempuh rentang perintah penuh 500–2500 µs **tanpa menemukan stop
mekanis**, jadi batas kerjanya = batas perintah.

| Servo | Awal (µs/mV) | Tengah (µs/mV) | Akhir (µs/mV) | Skala      | R²      |
| ----- | ------------ | -------------- | ------------- | ---------- | ------- |
| J5    | 500 / 285,5  | 1500 / 1657,9  | 2500 / 3044,5 | 1,380 mV/µs | 0,99988 |
| J6    | 500 / 299,9  | 1500 / 1667,2  | 2500 / 3056,8 | 1,378 mV/µs | 0,99991 |
| GRIP  | 500 / 201,6  | 1500 / 1598,8  | 2500 / 3022,7 | 1,411 mV/µs | 0,99988 |

Galat terhadap garis lurus: 0,51 % (J6), 0,58 % (J5), 0,79 % (GRIP) dari travel.
Titik tengah terukur meleset −0,3 % sampai −0,5 % dari dugaan linier, artinya
travel servo memang sedikit tidak simetris dan `servoUsCenter` yang terukur itu
lebih benar daripada (min+maks)/2.

Data lengkap: `benchmarks/kalibrasi/servo/`.

**J5 tidak pernah benar-benar diam.** Simpangan baku saat menahan posisi 41,5 mV
(puncak ke puncak 85,4 mV ≈ 62 µs ≈ 5,6°), sementara J6 0,077 mV dan gripper
0,046 mV. Selisihnya 500×. J5 adalah sendi yang menanggung beban wrist plus
gripper melawan gravitasi, jadi servonya terus berburu di sekitar target. Ini
juga terlihat di angka lain: histeresis maksimum J5 47,7 mV lawan 8,5 mV di J6,
dan repeatability titik tengah J5 sd 5,99 mV lawan 2,48 mV di J6.

### Skala derajat dan batas sendi (terukur 10 Agustus 2026)

| Servo | us_min → deg | us_max → deg | Skala      | Joint limit lama → baru |
| ----- | ------------ | ------------ | ---------- | ----------------------- |
| J5    | 500 → −90    | 2500 → +90   | 0,0900 °/µs | ±120 → **±90**          |
| J6    | 500 → −90    | 2500 → +90   | 0,0900 °/µs | ±180 → **±90**          |
| GRIP  | 500 → 0      | 2500 → +180  | 0,0900 °/µs | bukan sendi             |

Joint limit J5 dan J6 di studio (`JDEF` ±120 dan ±180) ternyata **melebihi
kemampuan fisik servonya**, jadi ikut diperbaiki ke ±90. Selisih ini penting
untuk kinematika: ruang kerja yang dihitung dengan ±120/±180 lebih besar
daripada yang benar-benar bisa dicapai lengan.

### Uji ujung ke ujung: perintah sudut lawan sudut terukur

Sapuan dan linearitas menguji potongan potongan rantai. Uji ini melewati seluruh
rantai sekaligus (sudut → pemetaan µs → servo → pot → ADS1115 → pemetaan mV →
sudut), 9 titik merata per servo:

| Servo | Galat rms | Galat maks | Bias   |
| ----- | --------- | ---------- | ------ |
| J5    | 0,59°     | −1,00°     | −0,19° |
| J6    | 0,74°     | −1,50°     | −0,50° |
| GRIP  | 1,33°     | −2,25°     | −1,23° |

Angka ini sudah selevel deadband servo hobi itu sendiri, jadi yang membatasi
sekarang servonya, bukan instrumentasinya. Bias gripper −1,23° konsisten dengan
galat linieritasnya yang 0,79 % (≈1,4° pada travel 180°): pemetaan dua titik
tidak menangkap lengkungan kurva, dan gripper yang paling melengkung di antara
ketiganya.

Jalankan ulang dengan `python tools/kalibrasi_servo.py uji <0|1|2>`.
