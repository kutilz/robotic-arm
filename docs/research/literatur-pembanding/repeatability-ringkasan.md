# Ringkasan Data Repeatability dan Backlash Pembanding

Hasil pembongkaran seluruh dokumen di folder ini, 3 Agustus 2026. Fokusnya satu
pertanyaan: **siapa yang benar-benar mengukur repeatability, dan pakai cara apa.**

## Ringkasan cepat

| Sumber | Angka | Kondisi uji | Alat ukur | Status |
| ------ | ----- | ----------- | --------- | ------ |
| HELENE (Hardware/MDPI 2025) | Repeatability **0.87 mm**, akurasi **8.4 mm** | Beban 0.5 kg, jangkauan 432 mm, 20 plus minus 2 derajat C | **CMM WENZEL LH87 + probe Renishaw PH10**, kubus referensi 15 mm di end-effector | **Diukur**, ISO 9283 |
| Chen dkk. (arXiv 2024, lengan hibrida) | Repeatability **0.109 mm** di ujung lengan, 0.017 dan 0.03 mm di dua slider | 20 percobaan, kecepatan maks 150 mm/s, normalisasi zero-mean | Tidak disebut eksplisit di kutipan | **Diukur** |
| Sirinterlikci dkk. (TIIJ 2009) | Robot industri Fanuc M16iL | DOE faktorial pecahan 2^(6-2) | **Dial indicator graduasi 0.0127 mm** | **Diukur**, fokus ke metode |
| Roozing & Roozing (IROS 2022) | Play **0.92 derajat RMS**, puncak 1.8 derajat | Cycloidal cetak 3D 11:1 | Selisih dua encoder, `q - theta/n` | **Diukur** (level sendi, bukan end-effector) |
| HowToMechatronics | Cycloidal cetak 3D: **6.5 mm** play berbeban di lengan 15 cm, **2 mm** free play. Harmonic: 8 mm | Reduksi 25:1, NEMA17 | Gaya dua arah di lengan 15 cm, ukur pergeseran | **Diukur** (cara sederhana) |
| Atlas (skripsi, Hackaday.io) | "**di bawah 0.5 mm** tanpa perubahan beban" | Jangkauan 500 mm | Tidak disebut | **Klaim**, penulis menulis sendiri bahwa uji dengan perubahan beban **belum dilakukan** |
| AR4 Annin (manual v1.5) | **0.2 mm** | Jangkauan 62.9 cm, payload 1.9 kg | Tidak ada di manual 292 halaman | **Klaim spesifikasi** |
| PAROL6 | "**0.08 mm**" (halaman produk); halaman proyek hanya menulis "setara robot industri" | Jangkauan 400 mm | Tidak ada | **Klaim** |
| Arctos | Tidak ada angka repeatability sama sekali di dokumentasi | | | **Tidak ada data** |
| Faze4, CyBot | Tidak ada angka repeatability | | | **Tidak ada data** |

## Detail yang perlu dibaca utuh

### HELENE: satu-satunya yang benar-benar berstandar

Prosedur ujinya:

- Lima posisi uji berkoordinat tetap ditambah Home.
- Urutan yang sama dijalankan **30 kali**, tiap kali terdiri dari **tiga siklus**
  melewati seluruh posisi pada **100 persen, 50 persen, dan 10 persen kecepatan
  maksimum**.
- Referensi posisi diukur dengan mesin ukur koordinat (CMM) WENZEL LH87 dan
  probe head Renishaw PH10, menyentuh kubus referensi bersisi 15 mm yang
  dipasang di end-effector.
- Akurasi dan repeatability dihitung dari seluruh siklus mengikuti prosedur
  ISO 9283.

Tabel 5 dokumen, repeatability dalam mm:

| | Home | 1 | 2 | 3 | 4 | 5 | Rata-rata |
| --- | --- | --- | --- | --- | --- | --- | --- |
| x | 0.14 | 0.269 | 0.256 | 0.089 | 0.688 | 0.754 | |
| y | 0.173 | 0.155 | 0.116 | 0.111 | 0.837 | 2.556 | |
| z | 0.255 | 0.131 | 0.111 | 0.112 | 0.69 | 0.813 | |
| **total** | 0.338 | 0.337 | 0.302 | 0.181 | **1.285** | **2.786** | **0.872** |

Tabel 4, akurasi posisi (mm), total per posisi: 9.765, 6.900, 4.860, 8.338,
12.101, rata-rata 8.393.

Tiga catatan penting dari mereka:

1. Resolusi encoder 0.05 derajat membatasi presisi maksimum ke **plus minus
   0.38 mm pada posisi terjulur**. Jadi angka repeatability yang mungkin dicapai
   memang dibatasi resolusi sensor, bukan cuma mekanik.
2. Pada pose horizontal repeatability lebih baik walau akurasi absolut lebih
   buruk, karena gravitasi **memberi preload pada sendi sehingga backlash tidak
   muncul**. Sebaliknya pada pose vertikal terjulur, sendi tidak terbebani dan
   backlash muncul penuh.
3. Faktor pembatas payload adalah **sendi keenam yang kehilangan langkah** saat
   beban berat, tanpa kerusakan permanen.

Poin nomor 2 dan 3 itu langsung relevan ke Subbab 4.5.5 kamu (koreksi droop
berbeban dan pemulihan kehilangan langkah).

Kritik mereka terhadap proyek open source lain, kutip kalau perlu: sebagian
besar hanya menentukan repeatability dengan setup ukur seadanya, yaitu simpangan
saat mendekati **satu titik** berulang kali, dan tidak diuji di beberapa posisi
dalam ruang kerja.

### Sirinterlikci: metode murah yang bisa kamu tiru

Karena kamu tidak punya CMM, ini rujukan metodenya. Dial indicator graduasi
0.0127 mm, mampu membaca 0.0254 mm dengan andal, dipasang di dua area berbeda
dalam ruang kerja dan dikalibrasi ulang tiap run.

**Enam faktor yang mereka variasikan** (dari literatur yang mereka rangkum,
semuanya terbukti memengaruhi repeatability):

1. Kecepatan robot
2. Payload
3. Lokasi dalam ruang kerja (tinggi titik target adalah faktor dominan)
4. Jenis gerakan
5. Derajat deselerasi
6. Ada atau tidaknya titik antara (intermediate points)

Temuan literatur yang mereka kutip: repeatability dipengaruhi kecepatan
manipulator, sedangkan akurasi dipengaruhi kecepatan **dan** pembebanan.

Kalau uji repeatability-mu memvariasikan minimal kecepatan, beban, dan posisi
dalam ruang kerja, metodenya sudah setara praktik yang diterima.

### HowToMechatronics: cara paling murah mengukur backlash

Metodenya cuma memberi gaya dua arah pada lengan sepanjang 15 cm lalu mengukur
pergeseran ujungnya:

- Cycloidal cetak 3D 25:1: **6.5 mm** play saat dibebani dua arah, dan sekitar
  **2 mm** free play tanpa beban.
- Harmonic drive cetak 3D: **8 mm** play pada kondisi sama.

Dikonversi ke sudut: 6.5 mm pada radius 150 mm setara **2.5 derajat**, dan free
play 2 mm setara **0.76 derajat**. Bandingkan dengan Roozing yang mendapat 0.92
derajat RMS memakai metode selisih encoder. Urutan besarannya konsisten, jadi
kalau nanti angkamu jatuh di rentang 0.5 sampai 2.5 derajat, itu wajar untuk
cycloidal cetak 3D.

Torsi dan efisiensi dari sumber yang sama: keluaran maksimum 32 N pada lengan
15 cm, yaitu **4.8 Nm**, sedangkan NEMA17 tanpa gearbox sekitar 2 N pada 15 cm
atau 0.3 Nm. Kenaikan sekitar 16 kali pada reduksi 25:1, jadi **efisiensi
sekitar 65 persen**.

### Atlas: klaim, bukan hasil uji

Kutipan persisnya dari halaman proyek: "The positional repeatability is below
0.5 mm without changing the load, **I haven't yet tested repeatability with vs.
without load**." Di bagian lain dia menulis masih "aiming at" angka tersebut.
Jadi Atlas **tidak punya data uji repeatability yang terdokumentasi**. Ini
memperkuat posisimu: encoder sisi sendi memang sudah pernah dipakai orang, tapi
dampaknya belum pernah diukur secara terkontrol.

### Temuan yang paling perlu kamu antisipasi

Di halaman proyek PAROL6, **Petar Crnjak (pembuat Faze4)** menjelaskan alasan
dia meninggalkan gearbox cetak 3D:

> "Printed gearboxes flex and make precision and repeatability terrible."

Dia lalu pindah ke planetary gearbox presisi dengan backlash 10 sampai 15
arcmin. Ini pernyataan dari orang yang membangun lengan cycloidal cetak 3D
paling terkenal, jadi penguji yang membaca literatur bisa memakainya untuk
menyerang premis skripsimu.

Jawaban yang benar bukan membantahnya, tetapi menempatkannya sebagai **latar
belakang masalah**: gearbox cetak 3D memang lentur dan ber-backlash, dan justru
karena itulah umpan balik posisi dipasang **di sisi keluaran sendi**, supaya
kelenturan dan backlash tersebut **ikut terukur dan terkoreksi**, bukan
diabaikan seperti pada encoder di poros motor. Kalau kamu bisa menunjukkan
penurunan error dari open loop ke closed loop, kamu secara efektif menjawab
kritik Crnjak dengan data.

## Konsekuensi praktis untuk pengujianmu

1. **Jangan janjikan angka sub-milimeter.** Resolusi AS5600 12-bit adalah 0.088
   derajat. Pada jangkauan 604 mm, satu LSB saja sudah setara sekitar **0.93 mm**
   di ujung lengan. Itu batas granularitas koreksi closed-loop-mu, sebelum
   memperhitungkan kelenturan struktur. HELENE dengan encoder 14-bit (0.05
   derajat) dan CMM hanya mencapai 0.87 mm. Target realistismu ada di orde
   milimeter, dan itu wajar untuk lengan cetak 3D.
2. **Gunakan dial indicator, bukan penggaris.** Metode Sirinterlikci memberi
   pijakan rujukan, dan alatnya murah.
3. **Uji di lebih dari satu titik.** Kritik HELENE terhadap proyek open source
   adalah pengujian di satu titik saja. Minimal tiru polanya: beberapa posisi,
   beberapa kecepatan, dengan dan tanpa beban.
4. **Laporkan repeatability dan akurasi absolut terpisah.** Keduanya bisa
   berbeda sepuluh kali lipat, seperti pada HELENE (0.87 mm lawan 8.4 mm).
5. **Catat kondisi lingkungan.** HELENE mencantumkan 20 plus minus 2 derajat C.
   Murah dilakukan, dan menambah kredibilitas.

## Pembanding lokal (supaya kamu tahu standar yang berlaku)

| Sumber | Data akurasi yang dilaporkan |
| ------ | ----------------------------- |
| Lengan 6-DOF ESP-NOW (Progresif 2024) | Target 90 derajat tercapai 89.5 derajat (deviasi 0.5 derajat), berbeban 500 g jadi 89.3 derajat, stabilitas 89.5 sampai 89.7 derajat, respon 0 ke 90 derajat dalam 0.5 detik, "akurasi 80 persen" |
| Robot delta servo (SAINTEK 2022) | Error akurasi rata-rata sekitar 3 mm pada sumbu Z |
| Trajectory planning 3-DOF (Techno Bahari 2024) | Error 4.88 mm garis vertikal, 0.65 mm garis horizontal |
| Lengan 5-DOF fuzzy (Skripsi UNSRI 2024) | Rata-rata error tiga servo 12.68 persen |
| Posisi stepper + encoder + PID (UNY 2025) | Error posisi rata-rata 0.003 sampai 0.008 mm, RMSE tanpa beban 0.0055 mm, error maksimum berbeban stabil 0.03 mm, error maksimum saat beban berubah 301 g mencapai 13.80 mm |
| Simulasi 3-DOF V-REP (AVITEC 2019) | Tabel repeatability berbasis simpangan baku koordinat, tetapi **hasil simulasi**, bukan perangkat keras |

Perhatikan bahwa mayoritas skripsi lengan robot Indonesia melaporkan akurasi
**sudut per sendi**, bukan repeatability pose end-effector, dan tanpa alat ukur
independen. Kalau kamu mengukur pose end-effector dengan dial indicator dan
melaporkan repeatability terpisah dari akurasi, kedalaman datamu sudah di atas
rata-rata pembanding lokal.

Catatan untuk UNY 2025: angka 0.003 sampai 0.008 mm itu untuk **linear actuator
sumbu tunggal**, bukan lengan enam sendi. Jangan dibandingkan langsung dengan
repeatability lenganmu, pakai saja struktur pengujiannya (tanpa beban, beban
bertahap, keadaan tunak).
