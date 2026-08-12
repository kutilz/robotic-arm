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
- **Kanan-bawah**: control card ber-tab **JOINT | CARTESIAN | MOTION | SETUP**
  dengan footer home / send-goto / E-STOP bulat merah.
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
build web: situs hasil deploy jalan sebagai **skeleton**. Supaya mesh CAD ikut
tampil di web, GLB hasil `tools/optimize_cad_glb.mjs` harus di-commit ke
`studio/public/`.

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
    cycloidal.js       geometri cycloidal drive, belt, NEMA, servo, AS5600
    arm.js             hierarki FK lengan 6-DOF (world.jointRefs, eeNode, dst.)
    kinematics.js      FK pose, torsi gravitasi, wrist drift, IK DLS numerik
  features/
    jog.js             logika jog per-sendi + Cartesian, step size, home pose
    controlCard.js     control card kanan-bawah: tab JOINT/CARTESIAN/MOTION/SETUP
                       + footer (home, send goto, E-STOP)
    scenePanel.js      scene panel kiri-atas (view toggles, mode pill) + icon strip
    tcpDrag.js         drag gizmo TransformControls -> IK (gerak bebas mouse)
    demos.js           preset gerakan (sapu, pick&place, showcase, lingkaran IK)
    timeline.js        rekam/interpolasi/playback keyframe (timeline pill)
    pathPreview.js     polyline jejak TCP + reachability envelope
    inspector.js       drive-inspect, x-ray, focus offset, sweep
    dataPanel.js       engineering drawer: offset, inspector, sizing, torsi, geometri
  net/bridge.js        klien WebSocket digital twin <-> lengan fisik/simulasi
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
- **Demo / preset gerakan**: sapu penuh, pick & place, showcase sendi, lingkaran (IK).
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
(`firmware/arm_controller_esp32/`) host WebSocket server sendiri. Di tab
**SETUP** control card, sambungkan ke `ws://<ip-esp32>:81` (mode STA /
`ws://armbot.local:81`) atau `ws://192.168.4.1:81` (mode AP).

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

- Masuk (dari bridge): `{"type":"feedback","angles":[a1..a6],"estop":b,"fault":[f1..f4]}`
  (field `estop`/`fault` opsional, dikirim firmware ESP32; `estop` sinkron ke
  tombol E-STOP, `fault` encoder + `ack` command tampil di tab SETUP)
- Keluar (ke bridge): `{"cmd":"goto","angles":[a1..a6]}`, `{"cmd":"estop"}`,
  `{"cmd":"resume"}`, dan command kalibrasi `cal_*` (ESP32)
