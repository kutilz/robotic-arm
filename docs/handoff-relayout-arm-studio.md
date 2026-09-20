# Handoff: relayout Arm Studio

Status: **SUDAH DIIMPLEMENTASI 13 Agustus 2026.** Ditulis lebih dulu di hari yang
sama sesudah sesi pengerasan komunikasi firmware-studio. Keluhan yang memicu:
*"interface di web banyak birokrasi tombolnya, bikin pusing."*

Dokumen ini menjelaskan apa yang perlu dikerjakan, kenapa, dan apa yang tidak
boleh ikut dibongkar. Bagian keselamatan sudah dikerjakan terpisah, jadi
pekerjaan ini murni soal susunan.

Sisa dokumen dibiarkan dalam bentuk aslinya sebagai rancangan, karena alasan di
balik tiap keputusan masih berlaku. Yang berubah saat pengerjaan dicatat di
bagian 8 di bawah.

---

## 1. Diagnosis: masalahnya bukan jumlah tombol

Sekarang ada 5 tab (JOINT / CART / MOTION / CAL / SETUP) plus footer, timeline
bar, scene panel, icon strip, dan engineering drawer. Untuk satu gerakan nyata
operator harus menyentuh minimal tiga tempat berbeda:

1. **SETUP** untuk Connect
2. **MOTION** untuk ARM (dan kalau terkunci: baca peringatan, tekan "sudah
   di-home ulang")
3. **MOTION** lagi untuk pilih rutin dan jalankan, atau balik ke **JOINT/CART**
   untuk jog lalu ke **MOTION** lagi untuk LIVE

Mengurangi jumlah tombol tidak akan menyelesaikan ini, karena yang bikin pusing
adalah **saklar yang sama tersebar di tab berbeda dan saling memblokir tanpa
terlihat**. Operator tidak bisa menjawab "kenapa tombol ini mati" dari tempat
tombol itu berada.

### Inventaris saklar sekarang

| Saklar | Ada di | Yang diblokirnya | Alasan penolakan muncul di |
| --- | --- | --- | --- |
| Connect / Disconnect | SETUP saja | semua pengiriman | tidak ada, cuma badge |
| ARM | MOTION saja | LIVE di CART, semua goto | panel runner (MOTION) |
| LIVE | CART **dan** MOTION | (satu state, dua tampilan) | di masing-masing tempatnya |
| SERVICE | CAL saja | semua aksi tulis di CAL, slider gripper | hint di CAL |
| E-STOP | footer (selalu terlihat) | semuanya | badge + tombol berubah jadi RESET |
| Send goto | footer **dan** SETUP | - | alert |
| profil kecepatan | MOTION saja | laju rayapan LIVE di CART | tidak ada |

Tiga baris pertama adalah inti masalahnya: prasyarat berada di tab lain
daripada tempat konsekuensinya terasa.

### Isi tab CAL sekarang (semua terbuka sekaligus)

header MONITOR/SERVICE + lampu LINK/MOD/REC → info diag → step jog →
4 kartu axis (J1..J4) → kalibrasi twin → parameter → driver TMC2209 → gripper →
load cell → data log.

Sembilan blok dalam satu kolom yang harus digulung. Yang dipakai bersamaan
biasanya cuma dua.

---

## 2. Sasaran

### 2.1 Bilah interlock permanen

Satu bilah di atas kartu kontrol, **selalu terlihat di tab mana pun**, berisi
rantai izin gerak berurutan:

```
┌──────────────────────────────────────────────────────────────┐
│  LINK ●──▶ DRIVER ●──▶ ARM ●──▶ LIVE ●          [ E-STOP ]   │
│  ws://192.168.1.8:81   4/4 ok   armed   mati                 │
└──────────────────────────────────────────────────────────────┘
```

Aturannya:

- **Tiap lampu klik-able**, dan menggantikan tombol yang sekarang tersebar:
  LINK menggantikan Connect/Disconnect di SETUP, ARM menggantikan tombol ARM di
  MOTION, LIVE menggantikan **dua** tombol LIVE.
- **Lampu yang mati menampilkan alasannya di tempatnya**, diambil dari
  `blockedReason()` di `studio/src/net/liveLink.js`. Fungsi itu sudah
  mengembalikan kalimat siap tampil dan sudah memeriksa keempat prasyarat
  dengan urutan yang sama seperti bilah ini. Jangan tulis ulang logikanya.
- **DRIVER adalah lampu baru.** Datanya sudah ada: `isDriverOk()` dan
  `getDriverResets()` di `studio/src/net/bridge.js`, plus event
  `{type:'drv',ok,resets,baru}`. Insiden PSU 13 Agustus 2026 akan terlihat
  sebagai lampu merah sebelum ada satu pun gerakan.
- Rantainya berurutan, jadi lampu di kanan otomatis mati kalau yang di kiri
  mati. Ini yang membuat "kenapa LIVE tidak mau menyala" terjawab dengan
  melihat, bukan dengan mencari.

Kontrak DOM di `studio/index.html` menyebut `#connBadge` dan `#estop` dipakai
langsung oleh JS. **Jangan hapus id-nya**; bilah baru boleh membungkus keduanya,
tapi `bridge.js` masih menulis ke `#connBadge` dan `main.js` masih memasang
handler ke `#estop`.

### 2.2 Lima tab jadi tiga mode

| Mode | Gabungan dari | Untuk |
| --- | --- | --- |
| **GERAK** | JOINT + CART | pemakaian harian |
| **RUTIN** | MOTION | teach dan jalan penuh |
| **SERVICE** | CAL + SETUP | komisioning |

SETUP tidak layak jadi tab sendiri: isinya satu input URL yang disentuh sekali
seumur sesi, dua tombol, dan tiga baris status. URL-nya pindah ke popover kecil
di lampu LINK; baris status (`#bridgeDrv`, `#bridgeFault`, `#bridgeAck`) pindah
ke bawah bilah interlock, karena itu memang tempat status hardware dibaca.

Penggabungan JOINT + CART: slider sendi di kiri, pad kartesian dan toggle gizmo
di kanan. Keduanya sudah cuma menulis pose twin (`setJoint()` dan `doCartJog()`
sama-sama berakhir di `applyPose()`), jadi tidak ada state yang perlu
digabungkan, hanya tata letaknya.

### 2.3 Footer tinggal HOME dan E-STOP

Ikon send di footer dihapus. Satu satunya jalur kirim manual jadi tombol besar
di panel RUTIN dan mode LIVE. Satu perintah gerak, satu tempat.

Catatan: cacat keselamatannya **sudah ditutup** (lihat bagian 4), jadi
penghapusan ini murni penyederhanaan, bukan perbaikan bug.

### 2.4 Tahap bernomor runner: 3 jadi 2

Panel runner sekarang punya tiga tahap bernomor. Tahap "atur" dan "rekam"
sebenarnya satu aktivitas: geser slider lalu simpan. Gabungkan jadi satu kartu
langkah dengan `SIMPAN POSE` dan `TANDAI OK` berdampingan.

Tahap KIRIM tetap berdiri sendiri, dan itu disengaja: dia satu satunya yang
menggerakkan besi, dan memisahkannya secara visual adalah fitur, bukan
birokrasi.

### 2.5 Tab SERVICE jadi accordion

Sembilan blok CAL jadi accordion dengan **satu blok terbuka pada satu waktu**.
Urutan yang masuk akal untuk dibuka berurutan saat komisioning:

1. kartu axis J1..J4 (satu grup, karena dipakai bergantian cepat)
2. kalibrasi twin
3. parameter
4. driver TMC2209
5. gripper
6. load cell
7. data log

Saklar MONITOR/SERVICE naik ke bilah interlock sebagai lampu, bukan segmen
tersembunyi di dalam tab.

---

## 3. Berkas yang disentuh

| Berkas | Perubahan |
| --- | --- |
| `studio/src/features/controlCard.js` | `TABS` 5 jadi 3, bangun bilah interlock, pindahkan isi SETUP, hapus ikon send di footer |
| `studio/src/features/interlockBar.js` | **baru**: bilah + popover URL, langganan `onHwStatus` dan `onLiveChange` |
| `studio/src/features/jog.js` | tata ulang jointWrap/cartWrap jadi dua kolom dalam satu mode |
| `studio/src/features/runner.js` | tahap 1 dan 3 digabung, tombol ARM/LIVE dilepas ke bilah |
| `studio/src/features/calPanel.js` | bungkus tiap blok jadi accordion, lepas segmen MONITOR/SERVICE |
| `studio/src/styles/theme.css` | kelas bilah, accordion, grid dua kolom mode GERAK |
| `studio/index.html` | tempat bilah di dalam `#controlCard` (id `#connBadge`/`#estop` tetap) |

Yang **tidak** perlu disentuh: `studio/src/net/liveLink.js` dan
`studio/src/net/bridge.js`. Seluruh state dan alasan penolakan sudah ada di
sana dengan bentuk yang pas untuk bilah ini. Kalau relayout ini sampai perlu
mengubah salah satu dari keduanya, kemungkinan besar ada logika yang sedang
disalin ke UI padahal seharusnya dipanggil.

---

## 4. Sudah dikerjakan, jangan diulang

Perbaikan berikut sudah masuk 13 Agustus 2026 dan **bukan** bagian dari
relayout:

- Tombol Send goto di footer dan di SETUP dulu memanggil transport langsung
  sehingga melewati seluruh interlock termasuk E-STOP. Keduanya sekarang lewat
  `kirimPoseSekarang()` di `controlCard.js`, yang memakai `sendPose()` dan
  menampilkan alasan sebenarnya. Saat footer dihapus nanti, fungsi ini tinggal
  ikut hilang.
- `blockedReason()` sudah bertambah satu prasyarat: driver TMC belum siap.
  Urutannya sekarang E-STOP → link → driver → ARM, dan itu urutan yang sama
  yang harus dipakai bilah interlock.
- Studio sudah menampilkan status driver di tiga tempat: label badge (`driver`),
  baris `#bridgeDrv` di SETUP, dan pesan di panel runner. Setelah bilah ada,
  **dua yang pertama sebaiknya digabung ke lampu DRIVER** supaya tidak jadi
  tiga tempat yang bisa berbeda pendapat.

---

## 5. Yang tidak boleh disederhanakan

Sebagian "birokrasi" itu punya alasan yang dibayar mahal. Yang berikut wajib
tetap ada, boleh berpindah tempat tapi tidak boleh hilang:

- **ARM tidak boleh bisa dinyalakan dari tempat yang tidak menampilkan angka
  umpan balik.** Alasannya ada di komentar `controlCard.js` bagian LIVE. Kalau
  ARM naik ke bilah, bilah itu harus ikut menampilkan ringkasan aktual per
  sendi, atau ARM tetap tinggal di mode RUTIN.
- **Veto `needReHome`.** J3 dan J4 tidak punya encoder, jadi frame sudutnya
  hilang tiap ESP32 boot. Tombol "sudah di-home ulang" terlihat seperti
  birokrasi, dan memang begitu, tapi menghapusnya berarti lengan boleh bergerak
  dari nol yang tidak pernah diverifikasi.
- **Dua tombol LIVE harus tetap satu state.** Sekarang keduanya cuma tampilan
  atas `net/liveLink.js`. Kalau bilah menambah tampilan ketiga, aturan yang sama
  berlaku: baca dari `isLive()`, jangan simpan salinan.
- **E-STOP tanpa shortcut keyboard.** Disengaja, lihat `main.js`.
- **Tahap KIRIM berdiri sendiri.** Lihat 2.4.

---

## 6. Verifikasi

Tidak ada uji otomatis untuk tata letak, jadi urutannya:

1. `cd studio && npm run build` harus bersih.
2. `node studio/tools/verify_live.mjs` dan `verify_traj.mjs` harus tetap lulus.
   Keduanya tidak menyentuh DOM, jadi kalau gagal berarti ada logika kirim yang
   ikut terbawa saat memindahkan tombol, dan itu justru yang paling perlu
   ketahuan.
3. `python -m arm.bridge --simulate` lalu sambungkan studio ke
   `ws://localhost:8765`. Semua jalur UI bisa diuji tanpa lengan, termasuk tab
   CAL, karena protokol cal/diag/load ikut disimulasikan.
4. Uji manual yang wajib, karena persis di sinilah relayout bisa merusak
   keselamatan tanpa terlihat:
   - tekan E-STOP, lalu coba **setiap** tombol yang bisa mengirim gerak. Tidak
     boleh ada satu pun yang berhasil, dan tiap penolakan harus menyebut E-STOP.
   - matikan bridge saat ARM menyala. ARM harus mati sendiri dan bilah harus
     ikut menunjukkannya.
   - dengan lengan asli: matikan PSU 12 V, biarkan ESP32 hidup. Lampu DRIVER
     harus merah dalam ~2 detik. Nyalakan PSU lagi, lampu harus hijau sendiri
     dalam ~5 detik tanpa reboot dan tanpa lengan bergerak.

---

## 7. Risiko

Panel runner (`runner.js`, 1100+ baris) memegang state teach, penjaga sendi
open-loop, dan tombol ARM/LIVE sekaligus. Memindahkan tombolnya keluar berarti
menyentuh berkas paling padat di studio. Kerjakan **sesudah** bilah interlock
berdiri dan terbukti dengan tab lama masih utuh, jangan bersamaan.

Estimasi dampak kalau selesai: langkah untuk "gerakkan lengan dari nol" turun
dari 3 tab dan 6 klik jadi 1 bilah dan 3 klik, dan pertanyaan "kenapa tombol ini
mati" punya jawaban di tempat tombolnya.

---

## 8. Catatan pengerjaan (13 Agustus 2026)

Selesai seluruhnya. Sasaran 3 klik tercapai: LINK, ARM, LIVE, semuanya di bilah.

**Enam keputusan yang menyimpang dari atau melengkapi rancangan di atas:**

1. **ARM naik ke bilah, dan bilah ikut memajang strip sudut aktual per sendi.**
   Ini klausul pengecualian yang sudah disediakan bagian 5, dan satu satunya
   cara mencapai sasaran 3 klik. Sendi yang angkanya bukan hasil ukur (J5/J6)
   ditandai `*`, dibaca dari `isFbTrusted()`.

2. **E-STOP tetap di footer, tidak diduplikasi ke bilah.** Bagian 2.1
   menggambarnya di bilah sementara 2.3 menaruhnya di footer; keduanya di kartu
   yang sama dan cuma berjarak sekitar 40 px, jadi dua tombol E-STOP jelas
   salah. Bilah memerah dan menyebut E-STOP di baris alasan saat tertekan.
   Efek sampingnya bagus: `#estop` tidak berpindah, `main.js:89` tidak tersentuh.

3. **`net/liveLink.js` tetap disentuh, dua kali, dan keduanya disengaja.**
   Bagian 3 melarangnya dengan alasan "kalau perlu diubah, kemungkinan besar ada
   logika yang sedang disalin ke UI". Yang terjadi justru kebalikannya:

   - `armVetoReason()` ditambahkan, satu baris, pembaca murni atas hook
     `armVeto` yang sudah terdaftar runner. Tanpa ini bilah tidak bisa
     menjelaskan kunci `needReHome` kecuali dengan menyuruh operator mengklik
     dan gagal dulu.
   - **`setArmed(true)` dulu tidak memeriksa prasyarat apa pun selain veto**,
     jadi ARM bisa dinyalakan selagi E-STOP tertekan atau link mati. Tidak ada
     gerak yang berangkat (`sendPose()` tetap memeriksa), tapi tombolnya menyala
     "ARMED" di atas rantai yang mati. Ketahuan justru karena bilah dipasang:
     lampu ARM hijau sementara lampu LINK merah. Sekarang `blockedReason()`
     dipecah jadi `armPrereq()` + cabang ARM, dan `setArmed()` memakai daftar
     yang sama. Satu daftar, dua pemakai, tidak ada urutan yang disalin.

4. **Kartu kontrol dilebarkan 324 px jadi 360 px.** Dua kolom di 324 px
   menyisakan 143 px per kolom, terlalu sempit untuk pad kartesian 3 kolom. Di
   bawah 900 px lebar layar, `.mvGrid` jatuh kembali jadi satu kolom.

5. **Segmen step di mode GERAK digabung jadi satu**, di atas kedua kolom, karena
   `stepIdx` di `jog.js` memang dipakai bersama JOINT dan CART. Dua segmen yang
   menggerakkan variabel yang sama mengundang orang mengira keduanya bisa
   disetel berbeda. `#cartHint` tetap dibuat sebagai elemen terpisah supaya
   `flashUnreachable()` masih punya tempat menulis "target di luar jangkauan".

6. **MON/SVC ditaruh di ujung kanan bilah, bukan sebagai mata rantai kelima.**
   Izin tulis kalibrasi bukan prasyarat gerak. `service` tetap milik
   `calPanel.js`, yang sekarang mengekspor `setCalService()` / `isCalService()`.

**Verifikasi yang dijalankan.** `npm run build` bersih, `verify_live.mjs` dan
`verify_traj.mjs` tetap lulus. Selain itu ditulis dua smoke check playwright
(di scratchpad sesi, tidak ikut repo) berisi 40+ pemeriksaan terhadap studio
yang benar benar berjalan dan tersambung ke `python -m arm.bridge --simulate`,
mencakup: kontrak DOM dan id yang tidak boleh kembar, ukuran nyata elemen
(bukan sekadar keberadaannya), rantai lampu menyala berurutan, E-STOP menolak
setiap jalur kirim, link putus melucuti ARM, accordion satu-terbuka, dan
interlock SERVICE yang tetap mengunci tombol di dalam seksi yang tertutup.
Semuanya lulus.

Catatan untuk pemakaian dua tool itu lagi: `bounding_box()` dan `click()`
playwright sesekali menggantung di halaman ini karena render loop WebGL, jadi
keduanya diganti `evaluate()` dengan `getBoundingClientRect()` dan `.click()`
DOM langsung. Gejalanya sama dengan `page.screenshot` yang menggantung di
perkakas render CAD repo ini.

**Yang belum bisa diverifikasi tanpa hardware:** butir terakhir bagian 6, yaitu
mematikan PSU 12 V dengan ESP32 tetap hidup lalu memastikan lampu DRIVER merah
dalam ~2 detik dan hijau sendiri dalam ~5 detik. Jalur datanya sudah terbukti
di simulasi (lampu DRIVER membaca `isDriverOk()` dan event `drv`), tapi
pemulihan otomatisnya sendiri baru bisa dilihat di lengan asli.
