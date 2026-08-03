# Literatur Pembanding

Arsip dokumen penelitian dan proyek yang mirip dengan skripsi ini, dikumpulkan
3 Agustus 2026. Tujuannya satu: melihat **data dan metode pengujian** yang
mereka pakai, supaya Bab 2.1 punya pembanding yang jujur dan Bab 3.7 punya
protokol uji yang bisa dipertanggungjawabkan.

## Struktur

Rangkuman lintas dokumen: **[repeatability-ringkasan.md](repeatability-ringkasan.md)**,
berisi siapa yang benar-benar mengukur repeatability, angkanya, alat ukurnya,
dan mana yang cuma klaim spesifikasi.

| Folder    | Isi                                                       |
| --------- | --------------------------------------------------------- |
| `paper/`  | Jurnal dan konferensi peer reviewed                       |
| `lokal/`  | Jurnal dan skripsi Indonesia                              |
| `proyek/` | Dokumentasi proyek open source (manual, halaman proyek)   |
| `teks/`   | Hasil ekstraksi teks tiap PDF (`.txt`), buat dicari cepat |

Cari cepat lintas semua dokumen:

```bash
grep -ril "backlash" docs/research/literatur-pembanding/teks/
grep -i "repeatab" docs/research/literatur-pembanding/teks/helene-*.txt
```

---

## paper/ Jurnal dan konferensi

### roozing-2022-cycloidal-lowreduction-IROS.pdf

Roozing, W. dan Roozing, G. (2022). *3D-printable low-reduction cycloidal
gearing for robotics*. IEEE/RSJ IROS. 7 halaman.

**Ini dokumen paling penting di folder ini** untuk Bab 4.4. Cycloidal 11:1,
torsi nominal 36.4 Nm (dibatasi termal pada 40 A), puncak lebih dari 40 Nm,
kecepatan keluaran puncak 52.8 rad/s pada 48 V.

Data dan metode uji:

- **Backlash / play:** diukur sebagai selisih sudut keluaran dengan sudut motor
  tereduksi, yaitu `q - theta/n`. Hasil **RMS 0.92 derajat, puncak 1.8 derajat**,
  setara sekitar 9 persen variasi rasio gigi. Prototipe kedua 0.93 derajat RMS
  dan 1.9 derajat puncak, jadi hasilnya berulang.
- **Kekakuan torsional:** beban diangkat melawan gravitasi sampai 50 derajat
  dengan langkah 2 derajat, torsi maksimum 28.5 Nm, **diulang enam kali pada
  posisi keluaran berbeda tiap 60 derajat**. Fit linier torsi terhadap defleksi
  memberi kekakuan **633 Nm/rad**.
- **Gesekan:** model Coulomb ditambah viscous, dipisah per arah putaran.
- **Kendali posisi:** diuji dengan pendulum 380 g, inersia 0.025 kg m2, direkam
  posisi, kecepatan, dan arus motor terhadap waktu.

Yang bisa ditiru: metode ukur backlash dan kekakuan **tanpa alat mahal**, cuma
butuh beban mati, encoder di dua sisi, dan pengulangan pada beberapa posisi
keluaran. Ini persis situasimu karena AS5600 sudah ada di sisi keluaran.
Catatan penting mereka: efisiensi berbeban belum dikarakterisasi, jadi kalau
kamu ukur efisiensi cycloidal, itu justru nilai tambah.

### helene-2025-mdpi-hardware-6axis-opensource.pdf

Herbst, F. dkk. (2025). *HELENE: Six-Axis Accessible Open-Source 3D-Printed
Robotic Arm for Research and Education*. Hardware (MDPI), DOI
10.3390/hardware3030007. 15 halaman.

Pembanding utama di Tabel 2.1 dan satu-satunya yang menguji pakai standar.

- **ISO 9283:** akurasi posisi **8.4 mm**, repeatability **0.87 mm**, beban
  500 g, jangkauan 432 mm, suhu terkendali 20 plus minus 2 derajat C.
- Repeatability sekitar sepuluh kali lebih baik daripada akurasi absolut.
- Tabel repeatability per sumbu x, y, z untuk enam pose (Home dan lima titik
  uji) ada di Tabel 5 dokumen. Angka x berkisar 0.089 sampai 0.754 mm.
- **Sepuluh prototipe dibangun** dengan printer berbeda untuk melihat sebaran
  antar unit, dan tidak perlu tuning ulang pengendali per unit.
- Catatan mereka yang penting: kebanyakan proyek sejenis hanya melaporkan
  repeatability dengan setup ukur seadanya, jarang akurasi absolut.

Pada pose horizontal repeatability lebih baik meski akurasi absolut lebih
buruk, karena gravitasi menyeragamkan posisi akhir. Ini relevan buat menjelaskan
droop berbeban di Subbab 4.5.5 kamu.

### mdpi-2026-cycloidal-run-to-failure.pdf

Olejarczyk, K., Wiklo, M. dan Rucki, M. (2026). *Analysis of 3D-Printed
Cycloidal Gear Degradation in a Run-to-Failure Test*. Applied Sciences 16(6),
2866. 22 halaman.

Uji daya tahan gigi cycloidal cetak 3D berbahan PA12 dengan penguat serat
karbon (PA12CF15).

- Simulasi FEM ditambah uji fatik, lalu **run-to-failure pada beban gearbox
  32 Nm**, memakai rig khusus dengan akuisisi data, akselerometer, dan
  tachometer di poros masukan.
- **Gagal kritis setelah 10^5 siklus.** Kerusakan muncul di area dekat bearing,
  **bukan di gigi yang bergesekan dengan pin**, yang di luar dugaan penulis.
- Pengaruh suhu: deformasi plastis 0.2 mm tidak muncul pada 27 derajat C bahkan
  setelah 10^5 siklus, tercapai setelah sekitar 30.000 siklus pada 70 sampai
  90 derajat C, dan hampir seketika pada 140 derajat C.
- Analisis time synchronous averaging (TSA) dipakai untuk mendeteksi degradasi.

Langsung menyambung ke saran Bab 5.2 kamu soal PA-CF dan uji daya tahan siklus,
dan memberi angka konkret kalau ditanya "berapa lama gearbox cetak 3D bertahan".

### ijett-2025-latensi-websocket-digitaltwin.pdf

Hlayel, M. dkk. (2025). *Latency Analysis of WebSocket and Industrial Protocols
in Real-Time Digital Twin Integration*. IJETT 73(1), 120-135. 16 halaman.

Sumber terbaik untuk menetapkan ambang latensi digital twin di Tabel 3.10, biar
kriteria keberhasilanmu bukan angka karangan.

Round trip time rata-rata, kirim JSON tiap interval tetap 50 ms:

| Protokol      | RTT lokal   | RTT cloud |
| ------------- | ----------- | --------- |
| **WebSocket** | **43.8 ms** | **87 ms** |
| Modbus        | 70.8 ms     | 194 ms    |
| MQTT          | 94.1 ms     | 133 ms    |
| OPC UA        | 93.1 ms     | 162 ms    |

Acuan normatifnya: Precision Time Protocol mensyaratkan respon **100 ms untuk
pemakaian real-time** dan maksimum **200 ms untuk pemakaian simulasi**. Catatan
tambahan, implementasi lewat Node-RED sempat menembus 500 ms di awal.

Karena bridge kamu lokal (serial ke WebSocket di satu mesin), angka 43.8 ms itu
batas atas yang wajar untuk dilampaui, bukan target minimum.

### sirinterlikci-2009-repeatability-accuracy-industrial-robot.pdf

Sirinterlikci, A. dkk. (2009). *Repeatability and Accuracy of an Industrial
Robot*. Technology Interface International Journal. 10 halaman.

Metode pengukuran repeatability **murah** yang bisa langsung kamu tiru untuk
Subbab 4.5.1, karena kamu tidak punya laser tracker.

- Dial indicator dengan graduasi **0.0127 mm**, mampu membaca 0.0254 mm dengan
  akurat.
- Dial dipasang di dua area berbeda dalam ruang kerja, dikalibrasi ulang setiap
  run, titik ajar disimpan saat dial sedikit tertekan.
- Yang paling berguna: **tabel faktor pengganggu dan strategi penanganannya**
  (gesekan, perbedaan operator pembaca, kestabilan dudukan dial, perubahan
  distribusi beban gripper). Kalau kamu salin logika ini ke Bab 3.7, penguji
  susah membantah metode ukurmu.

### arxiv-2019-digital-controllers-robot-arm.pdf

Chowdhury, D. dkk. *Digital Controllers in Discrete and Continuous Time Domains
for a Robot Arm Manipulator*. 4 halaman. Rujukan untuk membenarkan kendali
**diskret** di Subbab 3.6.1, karena koreksimu dilakukan pasca-gerak, bukan
kontinu.

### arxiv-2024-6dof-hybrid-robotic-arm.pdf

Chen, Y. dkk. (2024). *Design and Control of a Novel Six-Degree-of-Freedom
Hybrid Robotic Arm*. 8 halaman. Pembanding perancangan 6-DOF serial versus
hibrida beserta pengujiannya.

### intechopen-2025-clay-printing-6dof-3dprinted-arm.html

*Accessible Six-DOF Clay-Printing Platform Using a 3D-Printed Robotic Arm*, DOI
10.5772/acrt20250181. Versi PDF-nya tidak bisa diunduh langsung, jadi yang
tersimpan halaman webnya. Contoh lain lengan 6-DOF cetak 3D untuk aplikasi
nyata.

---

## proyek/ Dokumentasi proyek open source

### ar4-annin-robot-manual-v1.5.pdf

Manual lengkap AR4 Annin Robotics, 292 halaman. **Spesifikasinya paling dekat
dengan lenganmu**, jadi ini pembanding paling berbahaya sekaligus paling
berguna.

Bab 6 Robot Specifications:

- Jangkauan **62.9 cm** (punyamu 60.4 cm)
- Payload **1.9 kg**
- Repeatability **0.2 mm**
- Berat robot 12.25 kg (aluminium)

Perhatikan: angka repeatability 0.2 mm itu **klaim spesifikasi tanpa protokol
uji yang didokumentasikan** di manual. Bandingkan dengan HELENE yang menempuh
ISO 9283 dan hanya dapat 0.87 mm. Ini poin bagus untuk pembahasanmu: angka
tanpa metode uji tidak setara dengan angka berstandar. Manual ini juga memuat
BOM, diagram wiring, dan pemasangan encoder (encoder 8 kabel, hanya 4 dipakai).

### atlas-6dof-hackaday-project.html

Proyek Atlas oleh Damian Lickindorf, **skripsi teknik**, lima cycloidal cetak
3D hollow shaft (OpenCyRe). **Ini yang paling menantang klaim novelty-mu**:
sumbu 2 dan 3 memakai **dua encoder**, satu di poros motor dan satu di sisi
sendi lewat belt tersendiri. Repeatability disebut di bawah 0.5 mm tanpa
perubahan beban, jangkauan 500 mm, payload nominal 2.5 kg, maksimum 4.5 kg.
Kendali lewat lima Teensy 3.2 di jaringan CAN.

Yang tidak dia punya: pengujian terkontrol yang dipublikasikan. Angkanya klaim
halaman proyek, bukan hasil prosedur uji yang bisa direplikasi.

### faze4-cycloidal-source-robotics.html

Faze4 oleh Petar Crnjak, skripsi S1, cycloidal cetak 3D. Sudah ada di Tabel 2.1.

### cybot-cycloidal-6axis-hackaday.html

CyBot, cycloidal cetak 3D, open loop. Sudah ada di Tabel 2.1.

### parol6-desktop-arm-hackaday-details.html

PAROL6, planetary dan belt, jangkauan 400 mm, repeatability diklaim 0.08 mm,
gearbox planetary dengan backlash 10 sampai 15 arcmin. Berguna sebagai batas
atas: itulah yang bisa dicapai kalau memakai gearbox presisi beli jadi, bukan
cetak sendiri.

### arctos-robotics-docs.html

Arctos, cycloidal cetak 3D 24:1 per tahap. Punya **kit v2 closed loop** dengan
encoder magnetik, tetapi encodernya **di poros motor**, bukan di keluaran
sendi. Ini pembeda yang bisa kamu tonjolkan: encoder di poros motor tidak
melihat backlash gearbox sama sekali.

### closed-loop-vs-open-loop-stepper-source-robotics.html

Pembahasan teknis open loop versus closed loop stepper dari Source Robotics,
mencakup percepatan, konsumsi daya, error posisi, panas, dan derau.

### howtomechatronics-harmonic-vs-cycloidal-test.html

Uji banding harmonic drive dan cycloidal drive cetak 3D: torsi, backlash, dan
keausan. Sudah dipakai sebagai sumber di `docs/research/`, arsip lokalnya ada
di sini biar tidak hilang.

### vinaylanka-closed-loop-stepper-as5600.html

Implementasi kendali posisi closed loop stepper memakai **AS5600**, resolusi
0.088 derajat, sama dengan sensor yang kamu pakai.

---

## lokal/ Jurnal dan skripsi Indonesia

### uny-2025-posisi-stepper-loadcell-encoder-pid.pdf

Gendhiawan dkk. (2025). *Pemodelan Sistem Posisi Menggunakan Stepper Motor yang
Terintegrasi Sensor Load Cell dan Encoder*. Jurnal Ilmu Fisika dan Terapannya
12(2), 80-94. DOI 10.21831/jifta.v12i2.25041. 15 halaman.

**Pembanding metodologi paling pas untuk Subbab 4.5.3 dan 4.5.4**, dan
berbahasa Indonesia jadi enak dikutip. Stepper dengan encoder, load cell, dan
ESP32, dikendalikan PID.

Struktur pengujiannya persis pola yang kamu butuhkan:

1. Kinerja tanpa beban
2. Kinerja dengan beban bertahap (sampai 1140 g)
3. Kinerja pada keadaan tunak

Hasil: error maksimum pada keadaan tunak **0.03 mm**, overshoot kecil **di
bawah 0.6 persen**, koefisien determinasi R2 bernilai 1 pada kondisi stabil.
Mereka juga jujur menyebut keterbatasannya, yaitu settling time yang lama pada
beban besar dan ketergantungan pada kalibrasi sensor. Cara melaporkan
keterbatasan seperti ini yang disukai penguji.

### jinteks-lengan-robot.pdf

Habibi, A. dkk. (2024). *Perbandingan Efektivitas Pengendalian Robot dengan
Penggunaan PID dan Tanpa PID pada Aplikasi Jarak Tertentu*. JINTEKS 6(4),
813-819.

Objeknya mobile robot ber-encoder, **bukan lengan robot**, jadi jangan dipakai
sebagai pembanding hasil. Yang berguna adalah **kerangka pengujiannya**: uji
jarak yang sama dengan dan tanpa PID, lalu tabel penyimpangan terhadap target
per jarak. Itu kerangka yang sama dengan open loop versus closed loop di
Subbab 4.5.2 kamu, dan sudah ada preseden lokalnya.

### progresif-2024-remote-control-lengan-6dof-espnow.pdf

Rancang bangun remote control robot lengan 6-DOF berbasis mikrokontroler dan
ESP-NOW. Contoh tipikal lengan 6-DOF skripsi Indonesia: servo, open loop, tanpa
gearbox rancangan sendiri.

### unsri-skripsi-lengan-service-robot-5dof-fuzzy.pdf

Ariwikri, A. (2024). *Implementasi Lengan Service Robot 5 Degree of Freedom
Menggunakan Metode Fuzzy Logic Type 2*. Skripsi, Universitas Sriwijaya.
30 halaman bagian depan. Berguna sebagai contoh format dan kedalaman skripsi
lengan robot yang lolos sidang.

### technobahari-trajectory-planning-robot-lengan-3dof.pdf

Sari, E.P. dkk. (2024). *Trajectory Planning pada Robot Lengan 3 DOF*. Techno
Bahari 11(2), 59-64. Relevan dengan saran Bab 5.2 soal trajectory planning.

### avitec-pemodelan-simulasi-robot-lengan-3dof.pdf

Uchrowi, A. dkk. (2019). *Pemodelan dan Simulasi Robot Lengan 3 DOF Menggunakan
V-REP*. AVITEC 1(1). Pembanding pendekatan simulasi sebelum realisasi fisik.

### sainsbertek-pengontrol-gerakan-robot-lengan-matlab.pdf

Winarta, D.K. dkk. (2024). *Rancang Bangun Pengontrol Gerakan Robot
OpenManipulator dengan MATLAB*. Sainsbertek 5(1), 83-91. Pembanding antarmuka
kendali, memakai MATLAB dan bukan web.

### saintek-2022-lengan-robot.pdf

Adam (2022). *Robot Paralel Konfigurasi Delta dengan Penggerak Motor Servo*.
SAINTEK 1(1), 13-26. Konfigurasi paralel sebagai pembanding manipulator serial.

### poltekba-kendali-kecepatan-motor-dc-pid.pdf

Wibowo, N.R. dkk. (2020). *Rancang Bangun Sistem Kendali Kecepatan Motor DC
sebagai Media Pembelajaran Praktikum Sistem Kendali Menggunakan LabVIEW*. Jurnal
Sains Terapan 6(2). Contoh pelaporan tuning PID dalam bahasa Indonesia.

---

## Gagal diunduh

| Dokumen                                                                       | Alasan                                   | Tautan                                                                       |
| ----------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------- |
| Implementasi Kendali PID pada Kecepatan Motor DC, JTECE                       | Server menolak akses otomatis (HTTP 403) | https://journal.ittelkom-pwt.ac.id/index.php/jtece/article/download/1461/475 |
| Design and Fabrication of Cycloidal Drive Using FDM 3D Printer, Springer 2025 | Berbayar                                 | https://link.springer.com/chapter/10.1007/978-3-031-80512-7_79               |
| Anti-Backlash Mechanisms for Cycloidal Drive Robotic Actuators                | Hanya di ResearchGate, butuh login       | https://www.researchgate.net/publication/396394421                           |

## Catatan

- Semua berkas ini karya pihak lain dan disimpan sebagai arsip bacaan pribadi.
  Kutip lewat sitasi normal di `thesis/draft/00-daftar-pustaka.md`, jangan
  disalin isinya.
- Total ukuran folder sekitar 67 MB. Kalau repo ini di-push ke remote,
  pertimbangkan menambahkan `docs/research/literatur-pembanding/` ke
  `.gitignore` supaya riwayat git tidak membengkak.
