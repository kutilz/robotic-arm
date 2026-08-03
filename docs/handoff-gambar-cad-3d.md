# Handoff: gambar skripsi dari render CAD 3D

Ditulis 3 Agustus 2026 di laptop, untuk dilanjutkan di PC. Isinya apa yang sudah
jadi, apa yang belum, dan apa yang harus dijalankan lebih dulu di PC.

Catatan riwayat: mulai commit ini `thesis/**` IKUT ke remote (sebelumnya sengaja
lokal saja). Repo private, dan kerjaan gambar seluruhnya ada di `thesis/figures/`
sehingga harus bisa dibuka dari PC.

---

## 1. Jalankan ini dulu di PC

`*.glb` di-gitignore, jadi model CAD-nya TIDAK ikut lewat git dan harus dibangun
ulang dari berkas Onshape:

```
node tools/optimize_cad_glb.mjs "onshape/Main Assembly (Complete).glb"
node tools/optimize_cad_glb.mjs "onshape/Main Assembly (Complete).glb" \
     studio/public/main-assembly-cyc.glb --keep "Cycloid Disk,Input Cam,Crown"
```

Yang kedua wajib khusus untuk gambar exploded J2: pipeline biasa MEMBUANG
`Cycloid Disk`, `Input Cam`, dan `Crown` karena terkurung di dalam rumahnya,
padahal justru ketiganya isi gambar itu.

Lalu pastikan rig-nya masih benar:

```
node studio/tools/verify_cad_rig.mjs
```

Harus keluar `semua pemeriksaan lulus`, dengan sebaran part `L0..L6 = 9 11 12 8 6 2 12`.

Membuka halaman gambar CAD 3D:

```
python tools/sajikan.py
```

lalu buka `http://127.0.0.1:8765/thesis/figures/index.html`. **Tidak bisa diklik
ganda**: modul ES dan pemuatan GLB dua-duanya diblokir di `file://` karena
origin-nya null.

Regenerate semua PNG cetak tanpa klik manual:

```
python tools/render_gambar.py
```

Di PC ini akan jauh lebih cepat daripada di laptop. Laptop tidak punya GPU untuk
Chrome headless sehingga jatuh ke SwiftShader, dan satu halaman butuh belasan
detik sambil membekukan main thread halaman.

---

## 2. Sudah jadi

Empat halaman gambar, semuanya lulus `python tools/cek_gambar.py`, PNG cetak
sudah ada di `thesis/figures/cad/` pada 642 sampai 724 dpi di kolom teks 14 cm:

| Halaman | Keluaran | Isi |
| --- | --- | --- |
| `lengan-dimensi.html` | `cad/lengan-dimensi.png` | garis ukur a1, a2, d4, d6; sumbu J1 sampai J6; penanda pergelangan spherical; strip angka |
| `lengan-pose-kerja.html` | `cad/lengan-pose-kerja.png` | 4 pose, kamera dan kotak bingkai dan skala sama persis |
| `lengan-mekanisme.html` | `cad/lengan-mekanisme.png`, `cad/lengan-mekanisme-legenda.png` | 9 penunjuk bernomor ke tiap subrakitan penggerak, dua varian |
| `cycloidal-j2-exploded.html` | `cad/cycloidal-j2-exploded.png` | exploded J2 dari GLB varian, urut aliran daya kiri ke kanan |

Cara kerjanya: render WebGL dijadikan raster lalu ditempel sebagai `data:` URI ke
dalam SVG `Fig.build()`, sementara seluruh anotasi tetap SVG asli memakai global
`_fig.js`. Akibatnya tombol Unduh PNG, pemilih skala, dan `cek_gambar.py` jalan
tanpa `_fig.js` disentuh sama sekali.

Modul bersama `thesis/figures/_cad3d.js`. Geometri TIDAK pernah diketik ulang di
sana; semuanya diimpor dari `studio/src/model/cadRig.js`.

Perkakas baru atau berubah:

- `tools/sajikan.py` (baru) server statis lokal. Memaksa MIME `.js` ke
  `text/javascript`, karena `mimetypes` di Windows membaca registry dan di
  sebagian mesin `.js` terdaftar `text/plain`, yang bikin Chrome menolak modul
  dengan pesan error yang tidak menyebut penyebabnya.
- `tools/render_gambar.py` (baru) menekan `#pngBtn` yang sudah ada lewat
  playwright, jadi berlaku untuk SEMUA halaman gambar, bukan cuma yang CAD.
- `tools/cek_gambar.py` pindah dari `file://` ke HTTP, menunggu `#card svg`
  muncul (bukan 350 ms buta), dan menyaring 404 GLB yang wajar.
- `tools/optimize_cad_glb.mjs` dapat flag `--keep "Nama,Nama"`.
- `studio/tools/daftar_part_cad.mjs` (baru) membangkitkan baris `CAD_PARTS` dari
  sebuah GLB. Dulu tidak ada skrip yang bisa menyusun ulang tabel itu.
- `studio/src/model/cadRig.js` dapat `CAD_PARTS_EXTRA` (17 baris internal
  cycloidal). `CAD_PARTS` tetap 60 baris supaya `verify_cad_rig.mjs` tetap hijau.

Integrasi draf yang sudah dikerjakan:

- `thesis/draft/bab-1-pendahuluan.md`: penanda Gambar 1.1 diisi
  `cad/lengan-mekanisme-legenda.png`. Penanda lamanya juga memang tidak pernah
  terpasang, karena ditulis `Gambar 1.1.` bertitik sedangkan `FIG_RE` di
  `build_draft.py` menuntut ` - `.
- `thesis/figures/index.html`: 4 kartu baru, `.lead` dan daftar `ul.sisa` diperbarui.
- `thesis/perubahan-log.md`: entri lengkap beserta dampak per bab.

---

## 3. BELUM dikerjakan, dan kenapa

### 3.1 Penyisipan ke Bab III dan renumber (belum)

Tiga penanda baru belum masuk `thesis/draft/bab-3-metode-penelitian.md`, dan
penomoran belum digeser. Rencananya:

| Baru | Isi | Dulu |
| --- | --- | --- |
| 3.2 | ukuran utama lengan | baru, di 3.3.1 sebelum Tabel 3.1 |
| 3.3 | empat pose kerja | baru, di 3.3.1 setelah paragraf jangkauan |
| 3.6 | subrakitan penggerak tiap sendi | baru, di kepala 3.3.3 |
| 3.7 | exploded cycloidal J2 | menggantikan sumber Gambar 3.4 lama |
| 3.4 sampai 3.18 | sisanya bergeser | 3.2 sampai 3.15 |

Empat belas gambar ikut berganti nomor, plus rujukan `(Gambar 3.x)` di dalam
teks. `build_draft.py` memvalidasi PATH, bukan nomor, jadi kesalahan penomoran
tidak akan tertangkap; periksa manual dengan
`grep -n "Gambar 3\." thesis/draft/bab-3-metode-penelitian.md` dan pastikan
urutannya naik ketat.

### 3.2 Tabel 3.1 dan Tabel 3.2 masih bertentangan dengan CAD (blocker)

Ini alasan kenapa penyisipan di atas ditahan. `lengan-dimensi.html` mencetak
audit ini sendiri di halamannya:

| Besaran | Tabel 3.1 draf | CAD terukur |
| --- | --- | --- |
| d1 tinggi base J1 ke J2 | 0,065 m | 0,0828 m |
| a1 offset lateral bahu | 0,066 m | 0,06585 m (cocok) |
| a2 upper arm | 0,288 m | 0,288 m (cocok) |
| a3 offset perpendicular siku | 0,050 m | **tidak ada**, sumbu J3 dan J4 berpotongan |
| d4 forearm | 0,220 m | 0,26976 m |
| d6 pergelangan ke TCP | 0,090 m | 0,17494 m |
| jangkauan dari sumbu J2 | 0,604 m | 0,7327 m |

Tabel 3.2 (DH) mengulang `a3 = 0,050`, `d4 = 0,220`, `d6 = 0,090` yang sama.

Membetulkannya bukan sekadar mengganti angka:

- `benchmarks/workspace_sim.py` harus dijalankan ulang. Klaim "jangkauan 604 mm",
  "volume 520 liter", dan "dead zone 60 mm" ikut berubah, begitu juga Gambar 3.2.
- `benchmarks/ik_verify.py` harus dijalankan ulang (Gambar 3.3).
- `studio/src/config/arm.js` sudah menandai target torsi tiap sendi dihitung
  untuk jangkauan 649 mm dan sekarang basi.
- Sisi Python (`src/arm/config.py`, `src/arm/kinematics.py`) masih pakai geometri
  lama juga.

Ini keputusan isi penelitian, bukan keputusan gambar, jadi sengaja tidak
disentuh sendirian.

### 3.3 Keterbacaan cetak gambar SVG lama (belum)

`build_draft.py` memancarkan `{width=100%}` ke kolom teks 14 cm dan
`format_docx.py` tidak menskalakan gambar sama sekali. Jadi satu satuan SVG
tercetak `140 / W` mm, dan rumusnya:

```
pt = size * 140 / (W * 0,3528)
```

Pada W 1280 itu berarti `pt = size * 0,3102`. Ukuran teks 11 yang dipakai 14
gambar SVG lama tercetak sekitar **3,4 pt**, judul ukuran 12,8 sekitar 4,0 pt.
Tidak terbaca di kertas. Empat halaman CAD baru sudah memakai tangga tipografi
sekitar 2,4 kali lebih besar (teks utama mendarat di 5,9 sampai 8,7 pt), tapi
gambar lama belum disentuh.

### 3.4 `komponen-utama.html` rusak (sudah rusak sebelum ini)

`cek_gambar.py` melaporkan 20 elemen keluar kanvas: barisan kartu ketiga jatuh
di bawah `H = 706`. Sudah diverifikasi ini bukan akibat perubahan apa pun di
sesi ini, hasilnya identik lewat jalur `file://` lama maupun HTTP baru.

---

## 4. Yang perlu diketahui sebelum menyentuh kode ini

- **`data:` URI wajib, bukan path berkas.** SVG yang dirasterisasi di dalam
  `<img>` (itulah jalur tombol Unduh PNG di `_fig.js`) berjalan tanpa akses
  sumber daya eksternal. `<image href="foo.png">` tidak akan tampil sama sekali,
  tanpa pesan error apa pun. Ini juga alasan `_foto.js` ada.
- **`preserveDrawingBuffer: true` wajib** di `WebGLRenderer`. Tanpa itu
  `toDataURL()` mengembalikan gambar putih kosong, diam-diam, tiap kali dipanggil
  di luar task yang sama dengan `render()`.
- **`THREE.Box3.setFromObject()` mengabaikan flag `visible`.** Menghitung kotak
  bingkai setelah menyembunyikan part akan tetap menghasilkan kotak seluruh
  lengan. Pakai `studio.kotakPart(daftar)`.
- **Membalik tanda sumbu tidak membalik tata letak exploded view.** Sumbu yang
  dinegatifkan membalik urutan pengurutan sekaligus arah pergeseran, dan keduanya
  saling meniadakan. Yang menentukan sisi mana motor muncul adalah azimut kamera.
- **Jangan bungkus panel dalam `<g transform=...>`.** `cek_gambar.py` melewati
  elemen yang punya `transform` tidak kosong (juga kalau induknya punya), jadi
  seluruh label di dalamnya berhenti diperiksa diam-diam. Hitung koordinat
  absolut di JS.
- **Pakai `console.warn`, jangan `console.error`.** `cek_gambar.py` menggagalkan
  berkas pada `console.error` apa pun, padahal GLB memang di-gitignore dan
  halaman punya jalur cadangan kerangka SVG.
- Kamera ortografis, bukan perspektif, supaya garis ukur sejajar sumbu aslinya
  dan panel pose bisa dibandingkan. Tinggi kotak gambar diturunkan dari aspek
  model lewat `bentangKotak()`, jangan ditebak.

---

## 5. Catatan lain di commit ini

- `cad/cycloidalDrive.fs` dan `pulleyHTD3M.fs` di root ikut ter-push di commit
  ini. **Keduanya versi lama**, sudah digantikan `onshape/Cycloidal Generator.fs`
  (v5) dan `onshape/HTD3M Pulley.fs`. Jangan disunting; kalau ragu, pakai yang di
  `onshape/`.
- `thesis/figures/_lib/` adalah salinan three.js r160 (sama persis dengan
  `studio/node_modules/three@0.160.1`) yang sengaja ikut di-repo supaya halaman
  gambar tetap bisa dirender bertahun-tahun ke depan tanpa `npm install`.
- Aturan penulisan repo: **em dash dilarang** di seluruh repo, termasuk kode,
  docs, dan draf.
