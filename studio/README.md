# Digital Twin Web: Cycloidal Arm Studio

Visualisasi 3D interaktif (Three.js) yang berperan sebagai **digital twin**:
mencerminkan posisi sendi lengan fisik secara real-time, menyediakan kontrol jog,
IK numerik, playback trajektori, dan mengirim perintah target balik ke lengan.

Layout mengikuti gaya Waldo Commander: scene 3D full-viewport dengan panel-panel
floating semi-transparan (dark-only):

- **Kiri-atas**: scene panel (collapsible): brand, view toggles, exploded view,
  mode pill (Full arm / Offsets / Drive, hanya tampil di Engineering mode).
- **Kanan-atas**: status card: nama lengan, badge koneksi, readout TCP besar
  X/Y/Z + RX/RY/RZ, baris reach / beban / tightest joint / wrist drift.
- **Kanan-bawah**: control card: **bilah interlock** permanen (LINK, DRIVER,
  ARM, LIVE) di atas, lalu mode **GERAK | RUTIN | SERVICE**, lalu footer
  home / E-STOP bulat merah.
- **Bawah-tengah**: timeline pill (transport + scrub + keyframe), redup saat kosong.
- **Kiri-bawah**: icon strip: kamera ISO/F/S/T, ortho, legend, wrench (Engineering).
- **Engineering drawer** (slide dari kanan, toggle wrench / tombol `E`): offsets
  packaging, offset inspector, sizing, joint torque check, cycloidal geometry.

Keyboard shortcut: `Space` play/pause, `H` home, `1-4` demo, `I/F/S/T` kamera,
`E` engineering, `G` gizmo drag TCP, `Esc` tutup drawer/legend. E-STOP sengaja
tanpa shortcut.

## Menjalankan (dev)

Aplikasi berbasis Vite + ES module, butuh Node.

```bash
cd studio
npm install
npm run dev      # http://localhost:5173
```

Build produksi statis:

```bash
npm run build    # output ke studio/dist
npm run preview  # sajikan hasil build
```

## Deploy web (Vercel)

`vercel.json` di root repo yang mengatur build-nya, karena root repo berisi
`pyproject.toml` sehingga Vercel salah menebak ini proyek Python:

```json
{ "framework": "vite",
  "installCommand": "npm --prefix studio ci",
  "buildCommand": "npm --prefix studio run build",
  "outputDirectory": "studio/dist" }
```

Alternatif tanpa `vercel.json`: set **Root Directory = `studio`** di setting
proyek Vercel, biar Vite terdeteksi otomatis dari `studio/package.json`.

`main-assembly.glb` gitignored (1,8 MB) sehingga tidak ikut ke repo maupun ke
build web. Supaya mesh CAD asli ikut tampil di web, GLB hasil
`tools/optimize_cad_glb.mjs` harus di-commit ke `studio/public/`.

## Model blok (fallback tanpa GLB)

Kalau GLB tidak ada, `previewModel.js` memasang **model blok sederhana**: satu
balok atau silinder per part, ditempel ke `partHost` yang sama dengan mesh CAD
sehingga rantai sendi, exploded view, x-ray, dan toggle tampilan tidak berubah.

Ini bukan mesh CAD dan tidak berpura-pura jadi mesh CAD: tidak ada fillet,
lubang, rusuk, atau kantong bola. Yang akurat cuma posisi (pusat bbox tiap part
dari `CAD_PARTS`) dan ukuran (bbox part dari `docs/bom-main-assembly.md`).
Satu-satunya baris yang sengaja menyimpang dari bbox terukur adalah J1 Flange,
yang ditipiskan dari 37 ke 10 mm karena aslinya pelat berongga.

```bash
node tools/verify_preview_model.mjs   # cakupan tabel + bbox rakitan, tanpa GLB
```

Verifier itu memeriksa tiap baris `CAD_PARTS` punya bentuk, tidak ada baris
`PREVIEW_SPEC` yang nganggur, dan bbox rakitan hasil blok mendekati bbox
terukur di BOM (dapat 226,0 x 250,7 x 815,6 mm vs 240 x 266 x 815,7 mm).
Berbeda dengan `verify_cad_rig.mjs`, verifier ini tidak butuh GLB.

## Struktur modul

```
src/
  main.js              bootstrap: mount, buildArm, wiring semua panel + render loop
  config/arm.js        data model murni (CYC, LINK, OFFS, MOTORS, JDEF, MASSES, STATE)
  core/
    viewport.js        renderer, kamera persp/ortho, lighting, grid, kontrol orbit,
                       material, render loop, primitive helper
    theme.js           warna scene + axis CVD-aware (dark-only)
  model/
    cadRig.js          SUMBER geometri: sumbu sendi terukur, peta part->link,
                       matematika rantai (tanpa WebGL, bisa diuji di Node)
    rig.js             rantai sendi + overlay (skeleton, sumbu, dimensi, massa),
                       exploded view, x-ray
    cadModel.js        pemuat main-assembly.glb + status 'ready' / 'preview'
    previewSpec.js     tabel bentuk model blok (data murni, tanpa import)
    previewModel.js    model blok sederhana kalau GLB tidak ada (lihat bawah)
    kinematics.js      FK pose, torsi gravitasi, wrist drift, IK DLS numerik
  features/
    jog.js             logika jog per-sendi + Cartesian, step size, home pose
    controlCard.js     control card kanan-bawah: mode GERAK/RUTIN/SERVICE
                       + footer (home, E-STOP)
    interlockBar.js    bilah interlock permanen: rantai LINK -> DRIVER -> ARM ->
                       LIVE, strip sudut aktual, popover alamat bridge
    scenePanel.js      scene panel kiri-atas (view toggles, mode pill) + icon strip
    tcpDrag.js         drag gizmo TransformControls -> IK (gerak bebas mouse)
    demos.js           preset gerakan (sapu, pick&place, showcase, lingkaran IK)
    timeline.js        rekam/interpolasi/playback keyframe (timeline pill)
    pathPreview.js     polyline jejak TCP + reachability envelope
    inspector.js       drive-inspect, x-ray, focus offset, sweep
    dataPanel.js       engineering drawer: offset, inspector, sizing, torsi, geometri
  net/
    bridge.js          klien WebSocket digital twin <-> lengan fisik/simulasi
    liveLink.js        SATU-SATUNYA pintu perintah gerak + interlock ARM/LIVE
    liveRamp.js        aturan aliran live sebagai fungsi murni (bisa diuji di Node)
  ui/
    panel.js           helper section/slider/toggle/button
    hud.js             status card TCP + legend card
    icons.js           inline SVG icons (gaya Lucide, tanpa dependency)
  styles/theme.css     design tokens + styling panel floating/tab/jog/timeline/estop
```

`legacy/index.html` adalah versi lama satu-file (Three.js r128 via CDN), disimpan
sebagai referensi. Aplikasi aktif adalah versi modular di `src/`.

## Fitur

- **Jog** per-sendi dan Cartesian (translasi/rotasi TCP lewat IK), step fine/med/coarse,
  hold-to-repeat, readout pose TCP real-time.
- **Drag TCP bebas** dengan mouse (gizmo TransformControls) yang menggerakkan lengan
  via IK numerik. Orbit kamera terkunci saat gizmo di-drag.
- **Mode LIVE**: lengan NYATA mengikuti pose twin terus menerus, tanpa klik kirim.
  Berlaku untuk gizmo TCP, slider sendi, dan pad Cartesian sekaligus. Lihat
  bagian "Mode LIVE" di bawah.
- **Rutin hardware** (mode RUTIN, paling atas): menjalankan preset di lengan
  NYATA satu langkah per klik. Lihat bagian "Rutin hardware" di bawah.
- **Demo / preset gerakan**: pratinjau 3D saja, tidak menyentuh lengan.
- **Timeline**: rekam pose sebagai keyframe, interpolasi, playback.
- **Path preview + reachability envelope**: jejak TCP dari timeline dan awan titik
  jangkauan.
- **Tema dark-only** dipoles untuk presentasi, warna axis CVD-aware
  (X `#e05a4e`, Y `#31c98a`, Z `#5b78ff`).
- **E-STOP**: menghentikan playback, mematikan jog/drag, mengirim `estop` ke bridge.
- **Engineering mode**: panel teknik (sizing, torsi, offsets, geometri cycloidal,
  offset inspector) tersembunyi di drawer terpisah supaya UI default bersih.
- **Inspector**: drive-inspect cycloidal, x-ray, focus offset, sweep envelope.

## IK numerik

`kinematics.js` memakai **Damped Least Squares** (DLS) dengan Jacobian numerik yang
beroperasi langsung pada scene graph Three.js sebagai FK. Dipakai jog Cartesian,
drag TCP, dan demo lingkaran. `solveIK(targetPos, targetQuat, opts)`:

- `useOrient`: sertakan error orientasi (6-DOF) atau posisi saja (3-DOF).
- `partial`: pertahankan hasil best-effort tanpa revert (untuk drag/trace lingkaran).

## Menyambung ke lengan fisik / simulasi

Dua cara, keduanya bicara protokol WebSocket yang sama:

**A. Langsung ke ESP32 (hardware nyata, tanpa Python bridge).** Firmware ESP32
(`firmware/arm_controller_esp32/`) host WebSocket server sendiri. Kotak alamat di
popover lampu **LINK** (tombol kecil di sebelahnya) sudah terisi
`ws://192.168.1.8:81`, yaitu ESP32 di WiFi rumah
(halaman bawaannya `http://192.168.1.8/`). Alternatifnya `ws://armbot.local:81`
(mDNS, cuma terjawab dari dalam WiFi yang sama) atau `ws://192.168.4.1:81` kalau
ESP32 gagal masuk WiFi dan jatuh ke mode AP.

**B. Lewat Python bridge (simulasi / MCU serial).** Jalankan
`python -m arm.bridge --simulate` (atau `--port COM5`), lalu sambungkan ke
`ws://localhost:8765`.

**Target vs actual.** Saat tersambung, feedback encoder menggerakkan model 3D
(badge `live`). Begitu pose diubah lokal (jog/slider/preset/IK/timeline), model
menampilkan TARGET dan feedback ditahan (badge `target`) supaya susunan pose
tidak ditindas feedback 50 Hz; tombol **Send goto** mengirim target lalu model
kembali mengikuti hardware. E-STOP di-assert ulang otomatis tiap koneksi
terbuka; RESET mengirim `resume` eksplisit.

Protokol pesan WebSocket (lengkap di `firmware/README.md`):

- Masuk (dari bridge): `{"type":"feedback","angles":[a1..a6],"estop":b,"fault":[f1..f4],"grip":g}`
  (field `estop`/`fault`/`grip` opsional, dikirim firmware ESP32; `estop` sinkron ke
  tombol E-STOP, `fault` encoder + `ack` command tampil di bawah bilah interlock, `grip` jadi
  readout `act` di blok gripper)
- Keluar (ke bridge): `{"cmd":"goto","angles":[a1..a6]}`, `{"cmd":"estop"}`,
  `{"cmd":"resume"}`, command kalibrasi `cal_*`, dan command gripper/servo
  `gripper` / `servo_us` / `servo_auto` (ESP32)

## Rutin hardware (mode RUTIN)

Tombol demo di mode RUTIN **tidak pernah menggerakkan lengan**: timeline hanya
menganimasikan model 3D. Untuk menjalankan gerakan di lengan fisik ada blok
**rutin hardware** di atasnya (`features/runner.js`), dan preset-nya di
`config/routines.js`: **pick & place**, **repeat position**, **showcase sendi**,
**lintasan lurus (uji IK)**.

Dua batasan membentuk semua pose di file itu, dan dua-duanya bukan limit sendi
sehingga tidak dijaga oleh apa pun kecuali `tools/verify_cad_rig.mjs`:

- **Sektor kerja J1 hanya 0 sampai -90** di meja sekarang: 0 menghadap kertas
  milimeter, -90 ke kanan. J1 positif terhalang.
- **Servo J5/J6 sampai duluan.** Firmware menulis pulsa target servo tiap
  putaran loop, jadi MG996R berangkat penuh (~0,2 detik per 60 deg) sementara
  stepper jalan 8 dps (TEACH) atau 25 dps (RUN). Satu `goto` yang menurunkan
  lengan **sambil** menekuk pergelangan tidak dijalankan sebagai satu gerakan:
  pergelangan menekuk penuh dulu di posisi lama, lengan menyusul. Karena itu
  tiap langkah turun disusun dengan J5 yang sudah sama dengan tujuannya, dan
  perubahan J5 yang besar hanya dilakukan selagi lengan masih tinggi.
  `verify_cad_rig.mjs` menyusun ulang jalur tiap perpindahan dengan model itu
  lalu memeriksa titik terendah seluruh rakitan sepanjang jalur.

Alur kerjanya bertingkat, tiap tingkat baru terbuka setelah tingkat sebelumnya
terbukti di lengan sungguhan:

1. **atur target** - slider per sendi, pose hanya diterapkan ke model 3D selama
   LIVE mati. Inilah yang memperlihatkan sendi mana yang menarik kabel, karena
   dengan LIVE menyala gerakannya kontinu dan berhenti begitu jari berhenti.
2. **KIRIM KEYFRAME** - seluruh langkah sekaligus.
3. **OK, TERVERIFIKASI** - langkah ditandai lulus (disimpan di `localStorage`).
4. **jalan penuh** - baru bisa ditekan setelah SEMUA langkah terverifikasi.

## Bilah interlock

Bilah permanen di atas control card, terlihat di mode mana pun
(`features/interlockBar.js`). Isinya rantai izin gerak berurutan:

```
LINK  ->  DRIVER  ->  ARM  ->  LIVE            [MON | SVC]
```

Tiap lampu adalah saklar, dan menggantikan tombol yang dulu tersebar di tab yang
berbeda: LINK menggantikan Connect/Disconnect di SETUP, ARM menggantikan tombol
ARM di MOTION, LIVE menggantikan dua tombol live sekaligus. Di bawahnya ada baris
alasan, strip sudut aktual per sendi, lalu status hardware (`#bridgeDrv`,
`#bridgeFault`, `#bridgeAck`).

Kenapa dibuat begini:

- **Lampu yang mati menjelaskan dirinya di tempatnya.** Alasannya diambil apa
  adanya dari `blockedReason()` di `net/liveLink.js`, fungsi yang sama yang
  dipakai jalur kirim, jadi UI tidak bisa berbeda pendapat dengan kenyataan.
  Dulu prasyaratnya ada di tab lain daripada tempat akibatnya terasa, dan
  "kenapa tombol ini mati" cuma bisa dijawab dengan mencari.
- **DRIVER adalah lampu yang dulu tidak ada.** Insiden 13 Agustus 2026 (PSU 12 V
  mati sejam sementara ESP32 hidup, rail menarik 2 A saat dinyalakan lagi)
  sekarang terlihat sebagai lampu merah sebelum ada satu pun gerakan. Cacah
  pemulihan otomatis ikut ditampilkan supaya kejadiannya meninggalkan bekas.
- **Rantainya mati ke kanan sendiri**, tanpa kode tambahan: `liveLink` memang
  sudah melucuti ARM dan LIVE begitu link atau driver hilang.
- **Strip sudut aktual ada supaya ARM boleh naik ke sini.** Aturannya: ARM tidak
  boleh dinyalakan dari tempat yang tidak menampilkan satu pun angka umpan
  balik. Sendi yang angkanya bukan hasil ukur (J5/J6, pot servo belum
  dikalibrasi) ditandai `*`.
- **MON/SVC sengaja bukan mata rantai**, cuma menempel di ujung kanan: izin tulis
  kalibrasi bukan prasyarat gerak, dan menaruhnya dalam rantai akan menyiratkan
  lengan tidak mau bergerak selama SERVICE mati.

E-STOP **tidak** ada di bilah. Tombolnya tetap di footer kartu yang sama, cuma
berjarak sekitar 40 px; dua tombol E-STOP membuat operator ragu mana yang benar
benar berhenti. Saat tertekan, seluruh bilah memerah dan baris alasannya
menyebut E-STOP.

## Mode LIVE (lengan mengikuti gizmo)

Saklarnya **lampu LIVE di bilah interlock**, dan sejak relayout 13 Agustus 2026
itu satu satunya (dulu ada dua tombol live, di tab CART dan di tab MOTION, yang
kebetulan menggerakkan state yang sama). Selama menyala, lengan mengikuti pose
twin terus menerus: gizmo TCP, slider sendi, dan pad Cartesian semuanya cuma
menulis pose twin, dan yang mengirim ke lengan cuma satu pihak.

Syaratnya tetap **ARM**, yang lampunya duduk tepat di sebelah kiri LIVE di bilah
yang sama, plus terhubung dan tidak E-STOP. Bilah itu ikut memajang sudut aktual
per sendi supaya ARM tidak pernah dinyalakan dari tempat yang tidak menampilkan
satu pun angka umpan balik.

Yang perlu diketahui sebelum memakainya:

- **Target dialirkan bertahap, tidak dilompatkan.** Yang dikirim bukan pose
  gizmo, melainkan pose perintah yang merayap menuju gizmo sebesar jatah satu
  tick: 0,4 deg per sendi di TEACH, 1,25 deg di RUN (kecepatan profil x 50 ms).
  Inilah yang membuat servo J5/J6 tidak bisa lagi mendahului stepper, karena
  targetnya sendiri tidak pernah melompat. Konsekuensinya lengan **tertinggal**
  di belakang gizmo kalau ditarik cepat, lalu menyusul setelah mouse berhenti.
- **Satu pengirim berkala di seluruh studio**, 20 Hz, laju yang sama dengan
  throttle slider di halaman bawaan ESP32. Tidak ada modul lain yang boleh
  punya timer kirim sendiri.
- **Tidak ada pesan kosong.** Begitu pose perintah sampai, pengiriman berhenti
  total. Ada ambang diam 0,2 deg supaya derau encoder tidak dibalas goto 20 kali
  per detik selamanya.
- **Mati sendiri** saat E-STOP, link putus, ARM dilucuti, atau `jalan penuh`
  dimulai (auto-run dan aliran live tidak boleh berebut target).

Sifat sifat di atas dibuktikan tanpa peramban dan tanpa lengan:
`node studio/tools/verify_live.mjs`.

Guardrail:

- **ARM** adalah interlock: selama mati, tidak ada satu byte pun dikirim.
- Kecepatan dipaksa ke profil **TEACH 8 dps** saat mengajar dan baru naik ke
  **RUN 25 dps** selama jalan penuh. Dikirim sebagai `cal_set` (RAM), jadi
  runner tidak pernah menulis ke NVS.
- **Tabel delta** menampilkan aktual -> target -> selisih per sendi. Yang
  menentukan aman atau tidak bukan angka targetnya, tapi selisihnya.
- E-STOP menghentikan rutin dan melucuti ARM. Firmware dibangun dengan
  `ESTOP_AUTO_RESUME 0`, jadi `goto` tidak melepas e-stop.
- **Penjaga sendi open-loop**: putusnya koneksi selalu melucuti ARM, dan saat
  tersambung lagi sudut J1..J4 dicocokkan dengan pose terakhir yang
  diperintahkan. Kalau J3 atau J4 tidak cocok, **ARM dikunci** sampai operator
  menekan `sudah di-home ulang`. Alasannya ada di bawah.
- **simpan sudut ini** menimpa sudut langkah dengan pose model saat ini (teach by
  showing) dan membatalkan verifikasi langkah itu; **ekspor rutin** menyalin
  hasilnya sebagai potongan siap tempel ke `config/routines.js`.

### Hasil teach hilang saat restart

Pose hasil teach dan tanda terverifikasi disimpan di `localStorage`, dan
`localStorage` terikat **origin**, bukan folder proyek. Studio yang tadi dibuka
di `http://localhost:5173` lalu sekarang di `:5174`, di `127.0.0.1`, di IP LAN,
atau langsung dari berkas `file://` adalah empat penyimpanan berbeda, dan yang
terlihat cuma panel yang terbuka dengan angka bawaan. Dua penjaga sekarang:

- `server.strictPort = true` di `vite.config.js`. Bawaan Vite menggeser port
  diam diam kalau 5173 masih dipegang proses lama; sekarang `npm run dev` gagal
  berisik kalau bentrok, jadi alamatnya tidak bisa berubah tanpa ketahuan.
- Panel RUTIN memajang baris keadaan: berapa pose hasil teach tersimpan dan jam
  berapa terakhir disimpan, dengan origin-nya di tooltip. Kalau browser menolak
  menulis (halaman `file://` di Chrome melempar SecurityError, jendela privat
  bisa berkuota nol), barisnya **merah** dan tombol simpan ikut mengatakannya.
  Versi lama menelan kegagalan itu diam diam.

Yang benar benar mengamankan hasil teach tetap **ekspor rutin**: angka yang
ditempel ke `config/routines.js` ikut git dan tidak peduli origin. Sesudah
menempel, jalankan `node studio/tools/verify_cad_rig.mjs`, karena pose hasil
teach tidak otomatis aman: hasil ekspor 13 Agu 2026 memulangkan J5 ke nilai lama
di dua langkah yang lengannya masih dekat meja, dan jalurnya melorot ke 7 mm
dari meja sebelum lengan sempat naik.

### Kenapa putus koneksi mengunci ARM

J3 dan J4 tidak punya encoder, jadi sudut yang dilaporkan firmware untuk keduanya
adalah isi step counter, dan step counter itu mulai dari nol tiap ESP32 boot
(`syncSteppersFromEncoders()` jatuh ke cabang "tak ada encoder"). Kalau ESP
restart di tengah sesi, urutan yang terjadi bukan sekadar "counter hilang":

1. driver mati, J2 dan J3 **melorot** karena tidak self-locking
2. ESP boot dan mengambil pose melorot itu sebagai **0 derajat**
3. twin dan lengan berbeda sebesar sudut melorotnya, dan **tidak ada satu pun
   angka di layar yang memperlihatkannya**: feedback J3 melapor 0,0 dengan yakin

Sesudah itu "kembali ke home" bukan lagi gerakan yang aman. J1 dan J2 selamat
karena AS5600-nya absolut dan dibacakan ulang saat boot; J3 dan J4 tidak punya
apa pun untuk pulih.

Firmware tidak mengirim uptime, jadi reboot tidak bisa dibuktikan dari studio.
Yang dipakai sebagai pemicu karena itu **putusnya link**, yaitu persis saat
studio kehilangan dasar untuk menjamin frame sudut open-loop. Pemulihannya:
jog manual ke home di halaman bawaan ESP32, jalankan `cal_zero`, baru bebaskan
kuncinya.

Catatan terkait: `cal_zero` di J1/J2 mengisi offset dari sudut **mentah**
encoder sehingga absolut dan bertahan lewat reboot maupun re-flash, tetapi hanya
kalau sudah di-**COMMIT** (`cal_save`) ke NVS. Untuk J3/J4 `cal_zero` sifatnya
RAM dan memang tidak ada angka absolut yang bisa disimpan.

Rutin `repeat` berhenti otomatis di langkah TITIK UKUR tiap siklus dan menunggu
tombol **lanjut**, supaya pembacaan dial/laser sempat dicatat. Ini rutin yang
menguji apakah J3/J4 yang open-loop kehilangan step: keduanya tanpa encoder,
jadi step yang hilang tidak akan pernah muncul di feedback dan hanya bisa
dibuktikan dengan mengukur dari luar.

Pose statik tiap rutin ikut diaudit `node studio/tools/verify_cad_rig.mjs`
(di atas meja, di dalam limit, di dalam jangkauan, dan J6 ditahan <= 30 deg
selama pergelangan masih mentok).

## Kalibrasi twin (mode SERVICE)

Blok **kalibrasi twin** menyetel cara model 3D MENGGAMBAR sudut, bukan lengannya.
Tidak ada satu byte pun yang dikirim ke firmware dari sana, dan sudut yang
dikirim studio tidak ikut berubah artinya, supaya tetap sama dengan sudut di
halaman bawaan ESP32 dan di data pengujian yang sudah tercatat.

Dua besaran per sendi, dua duanya cuma bisa ditentukan dengan melihat lengan:

| | arti |
|---|---|
| **arah** `+`/`−` | ke mana twin berputar saat sudut sendi naik |
| **trim** deg | sudut yang ditambahkan sebelum digambar, untuk sendi yang di lengan ada di home tapi di twin tampil bengkok |

Alurnya: putar satu sendi di lengan, bandingkan dengan twin, betulkan barisnya,
lalu ulangi. Setelan disimpan di localStorage dan lampu **belum masuk kode**
menyala selama hasilnya belum ditulis balik; tombol **SALIN** menyiapkan baris
`TWIN_CAL_DEFAULT` siap tempel ke `src/model/cadRig.js`. Yang tersimpan di kode
itulah yang ikut terbaca gambar skripsi, deck sidang, dan `verify_cad_rig.mjs`.

**Setelan yang berhenti di browser adalah jebakannya.** 13 Agu 2026 J4 digeser
180 di panel ini karena twin dikira salah menggambar pergelangan; yang salah
ternyata lengannya. Selama geseran itu cuma hidup di localStorage, kode bisa
benar sementara satu peramban menggambar pose yang lain, dan tidak ada yang bisa
melihatnya dari repo. Karena itu kunci penyimpanannya dinaikkan ke `v2`
(setelan runtime lama dibuang, semua peramban kembali ke `cadRig.js`), dan
J4 dikunci tanpa trim dengan alasan yang bisa dihitung: pose pick & place hasil
teach hanya masuk akal pada pergelangan sesuai CAD, karena pada pergelangan yang
ter-roll 180 pose yang sama menaruh ujung jaw 32 sampai 57 mm **di bawah** meja.

`arah` dan `trim` untuk **J4, J5, dan J6** diukur 12 Agu 2026, yaitu sebelum
pergelangan dibongkar pasang, jadi ketiganya wajib diuji ulang sebelum
dipercaya. Panel ini memajang pengingatnya sendiri. Yang paling patut dicurigai
`trim` 180 di J6: itu juga sebuah setengah putaran di rakitan yang sama.

## Interpolasi trajektori

Timeline memakai kubik Hermite **monoton** (Fritsch-Carlson), bukan interpolasi
linear. Linear menyambung keyframe dengan kecepatan tetap per ruas, jadi
kecepatan melompat di tiap keyframe (di demo `sweep`, lompatannya 234 deg/s) dan
lompatan itu terlihat sebagai sentakan tiap kali lengan berbelok. Monoton
membuat kecepatan ikut nyambung tanpa pernah menjulur melewati sudut keyframe
yang diminta, jadi tidak ada pose karangan yang bisa jatuh di bawah meja.

Waktu tiap ruas juga dibagi menurut jarak tempuh sendi terjauh, bukan dibagi
rata, supaya kecepatan sudut kira kira tetap sepanjang demo. Durasi totalnya
tidak berubah.

Matematikanya di `src/model/traj.js` (modul murni, tanpa DOM/WebGL) dan diperiksa
`node studio/tools/verify_traj.mjs`: kecepatan nyambung di tiap keyframe,
kurvanya tidak menjulur, dan tiap keyframe dilewati persis. Ini semua lapisan
pratinjau 3D; runner hardware tidak memakai timeline sama sekali.

Keyframe **bertahan lintas reload** (localStorage, sejak 13 Agu 2026). Sebelumnya
tombol `+` merekam ke memori saja, jadi seluruh lintasan hilang tiap F5 atau
restart `npm run dev` tanpa satu pun peringatan. Sidik jari kalibrasi twin ikut
disimpan: lintasan yang direkam sebelum arah sendi dibetulkan tidak dibuang,
tapi ditandai "tercermin" di audit lintasan mode RUTIN supaya kejanggalannya
punya nama. Tombol tong sampah di timeline menghapusnya.

## Gripper (mode SERVICE)

Gripper servo MG90S **bukan DOF**: tidak ada di `angles[]`, tidak punya joint
limit, dan tidak ikut Send goto. Kontrolnya berdiri sendiri di blok `gripper`
mode SERVICE dan butuh saklar SVC di bilah interlock seperti aksi tulis lainnya.

Dua slider, sengaja tidak digabung:

- **pulsa mentah (us)** -> `{"cmd":"servo_us","servo":2,"us":n}`. Lebar pulsa
  langsung, servo masuk mode manual (lamp `MAN` menyala) sehingga loop kendali
  tidak menimpanya. Artinya tidak bergantung kalibrasi, jadi inilah yang dipakai
  **sebelum rahang terpasang**.
- **sudut (deg)** -> `{"cmd":"gripper","deg":x}`. Lewat pemetaan
  `servoAngMin..servoAngMax`, dan melepas mode manual. Berguna hanya setelah
  min/max gripper benar; sebelum itu angkanya cuma nama lain dari persen travel.

Tombol **TENGAH** menahan gripper di `servoUsCenter` (titik tengah terukur, bukan
rata-rata min/max) lewat pulsa mentah: ini pose untuk memasang horn dan rahang.
**AUTO** melepas mode manual. Field `min °`/`max °` + **APPLY GRIPPER** menulis
`servo_ang_min/max` indeks 2 ke RAM firmware; **COMMIT** di blok parameter yang
menyimpannya ke NVS.
