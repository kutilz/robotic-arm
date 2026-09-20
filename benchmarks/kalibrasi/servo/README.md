# Data kalibrasi servo J5, J6, dan gripper

Pengukuran di hardware asli, 10 Agustus 2026. Diisi oleh
`tools/kalibrasi_servo.py`; prosedur dan jebakannya di `firmware/kalibrasi.md`
bagian "Kalibrasi servo".

Beda dengan `../j1-*.csv` (sendi stepper): servo tidak punya AS5600 dan tidak
punya step counter. Yang diukur tegangan wiper potensiometer internal servo,
dibaca **ADS1115** 16-bit di alamat `0x48` (kanal A0 = J5, A1 = J6,
A2 = gripper). Karena itu satuan mentahnya **milivolt**, bukan derajat.

Kolom `sesi` = waktu mulai skrip, jadi satu berkas bisa memuat beberapa
percobaan tanpa saling menimpa. Kolom `servo` berisi `J5`, `J6`, atau `GRIP`.

## Yang wajib dibaca sebelum memakai angka di sini

**Satu LSB ADS1115 = 0,125 mV = 0,09 µs = 0,008°.** ADC bukan faktor pembatas
ketelitian. Yang membatasi:

1. **Ground bounce.** Selama motor servo masih menarik arus untuk mengoreksi
   posisi, arus itu lewat kabel GND bersama dan menggeser referensi ADS1115.
   Gejalanya khas: simpangan baku satu pembacaan melompat dari ~0,1 mV ke
   100 sampai 440 mV, dan nilainya **selalu meleset ke arah rendah** (IR drop
   di jalur GND). Semua pengukuran di sini karena itu menunggu servo tenang
   (`sd <= 5 mV`) dulu, kecuali `derau_diam.csv` yang memang sengaja merekam
   sebaran apa adanya.
2. **Pemetaan dua titik.** mV ke derajat dipetakan lurus dari dua ujung saja,
   jadi lengkungan kurva pot tidak tertangkap. Ini yang muncul sebagai bias
   di `uji_sudut_ringkas.csv`.

**Skala derajat sudah terukur, bukan asumsi.** Pada 500 µs dan 2500 µs horn
ketiga servo berada tepat pada satu garis lurus, jadi travelnya 180° dan
skalanya 0,0900 °/µs (lihat `skala_busur.csv`). Metodenya kolinearitas, bukan
membaca busur derajat, karena mata jauh lebih teliti menilai lurus atau tidak
daripada menaksir besar sudut.

## Berkas

**`sapu_mentah.csv`** langkah demi langkah sapuan pencarian ujung travel, 20 µs
per langkah, 50 langkah turun + 50 naik per servo.

| kolom | arti |
| --- | --- |
| `arah` | `turun` (1500 µs ke bawah) atau `naik` (1500 µs ke atas) |
| `us` | lebar pulsa yang diperintahkan |
| `mv` | tegangan wiper hasil oversample |
| `sd_mv` | simpangan baku pembacaan itu, penanda ketenangan |
| `delta_mv` | perubahan terhadap langkah sebelumnya, dasar deteksi mentok |
| `n_coba` | berapa kali pembacaan diulang sampai tenang (1 = langsung bersih) |

**`sapu_hasil.csv`** satu baris per servo: titik awal, tengah, akhir, span, dan
simpangan titik tengah terukur terhadap dugaan linier.

**`linearitas.csv`** kurva 21 titik naik lalu turun. `sisa_mv` = simpangan
terhadap garis lurus kuadrat terkecil, `histeresis_mv` = selisih arah naik
lawan arah turun di lebar pulsa yang sama.

**`linearitas_ringkas.csv`** kemiringan, R², galat linier maksimum, histeresis
maksimum, per servo.

**`repeatability.csv`** titik tengah didatangi 20 kali, bergantian dari batas
bawah dan batas atas. Kolom `asal` menandai dari mana datangnya.

**`repeatability_ringkas.csv`** simpangan baku, puncak ke puncak, dan `beda_arah_mv`
yaitu histeresis di titik tengah.

**`derau_diam.csv`** sebaran 30 pembacaan saat servo menahan posisi 1500 µs.
Ini satu satunya berkas yang **tidak** menyaring pembacaan kotor, karena yang
diukur justru sebaran apa adanya.

**`kecepatan_mentah.csv`** step response, 845 sampel per uji pada 860 SPS.
`t_ms` sejak awal rekam, `t_cmd_ms` saat perintah lompat dikirim. Enam uji per
servo: penuh naik/turun, setengah naik/turun, 60° naik/turun.

**`kecepatan_ringkas.csv`** per uji: waktu naik 10-90 %, t50, settling ±2 %,
overshoot, laju dalam mV/ms dan deg/s, serta detik per 60°.

**`uji_sudut.csv`** dan **`uji_sudut_ringkas.csv`** uji ujung ke ujung: perintah
sudut masuk lewat `goto`, sudut terukur keluar dari umpan balik. Sembilan titik
per servo. Ini satu satunya uji yang melewati seluruh rantai sekaligus.

**`skala_busur.csv`** skala derajat terukur dan metodenya.

**`cek_awal.csv`** snapshot tegangan wiper saat diam, dipanggil sebelum dan
sesudah sesi. Read-only, tidak menggerakkan apa pun.

## Ringkasan hasil, 10 Agustus 2026

### Titik awal, tengah, akhir

Ketiga servo menempuh **rentang perintah penuh 500 sampai 2500 µs tanpa
menemukan stop mekanis**, jadi batas kerjanya sama dengan batas perintah dan
titik tengahnya 1500 µs. Nilai ini yang tersimpan di NVS sebagai pose default
saat boot.

| Servo | Awal | Tengah | Akhir | Skala | Simpangan tengah |
| --- | --- | --- | --- | --- | --- |
| J5 | 500 µs / 285,5 mV | 1500 / 1657,9 | 2500 / 3044,5 | 1,3795 mV/µs | −7,1 mV (−0,3 %) |
| J6 | 500 µs / 299,9 mV | 1500 / 1667,2 | 2500 / 3056,8 | 1,3785 mV/µs | −11,2 mV (−0,4 %) |
| GRIP | 500 µs / 201,6 mV | 1500 / 1598,8 | 2500 / 3022,7 | 1,4106 mV/µs | −13,4 mV (−0,5 %) |

Simpangan titik tengah selalu negatif dan konsisten: travel servo memang sedikit
tidak simetris, jadi titik tengah **terukur** lebih benar daripada (min+maks)/2.

### Linearitas, histeresis, derau, pengulangan

| Servo | R² | Galat linier maks | Histeresis maks | Derau diam (sd) | Ulang tengah (sd) |
| --- | --- | --- | --- | --- | --- |
| J5 | 0,99988 | 0,58 % | 1,72 % | **41,471 mV** | 5,985 mV |
| J6 | 0,99991 | 0,51 % | 0,31 % | 0,077 mV | 2,476 mV |
| GRIP | 0,99988 | 0,79 % | 1,17 % | 0,046 mV | 4,068 mV |

**J5 tidak pernah benar-benar diam.** Simpangan bakunya 41,5 mV, puncak ke
puncak 85,4 mV (≈62 µs ≈ 5,6°), sementara J6 dan gripper di bawah 0,1 mV.
Selisihnya 500 kali lipat. J5 adalah sendi yang menanggung beban wrist plus
gripper melawan gravitasi, jadi servonya terus berburu di sekitar target. Pola
yang sama muncul di histeresis (1,72 % lawan 0,31 % di J6) dan di pengulangan
(5,985 mV lawan 2,476 mV). Ini keterbatasan mekanis, bukan keterbatasan
instrumentasi.

### Kecepatan

| Servo | Penuh 180° naik | Penuh turun | s/60° | Spek pabrik |
| --- | --- | --- | --- | --- |
| J5 MG996R | 518 ms | 507 ms | 0,211 sampai 0,216 | 0,17 s/60° |
| J6 MG996R | 544 ms | 524 ms | 0,218 sampai 0,227 | 0,17 s/60° |
| GRIP MG90S | 197 ms | 186 ms | 0,077 sampai 0,082 | 0,10 s/60° |

MG996R **lebih lambat** daripada speknya, MG90S **lebih cepat**. Gerak naik
konsisten lebih lambat dan lebih banyak overshoot daripada gerak turun
(J5 +2,4 % lawan +0,6 %), yaitu tanda beban gravitasi.

Angka ini memakai laju rata-rata 10-90 %, bukan kemiringan sesaat. Kemiringan
sesaat pada data mentah memberi 789 deg/s untuk MG996R, yaitu 2,2 kali lebih
cepat daripada spesifikasinya sendiri, karena tertembus lonjakan ground bounce
yang justru paling besar saat servo sedang bergerak.

### Uji ujung ke ujung

| Servo | Galat rms | Galat maks | Bias |
| --- | --- | --- | --- |
| J5 | 0,59° | −1,00° | −0,19° |
| J6 | 0,74° | −1,50° | −0,50° |
| GRIP | 1,33° | −2,25° | −1,23° |

Sudah selevel deadband servo hobi itu sendiri, jadi yang membatasi servonya
bukan instrumentasinya. Bias gripper −1,23° konsisten dengan galat linieritasnya
0,79 % (≈1,4° pada travel 180°), yaitu lengkungan kurva yang tidak tertangkap
pemetaan dua titik.

## Pengukuran yang TIDAK ada di CSV

Dua pembacaan penting diambil dari log boot serial, bukan lewat perkakas, jadi
dicatat di sini supaya tidak hilang:

| Keadaan | J5 | J6 | GRIP |
| --- | --- | --- | --- |
| Catu servo MATI (pot tanpa eksitasi) | 1,4 mV | 1,8 mV | 7,8 mV |
| Catu servo HIDUP, diam di 1500 µs | 1656,4 mV | 1664,8 mV | 1606,2 mV |

Baris pertama dipakai membuktikan perbaikan bug pointer register ADS1115:
sebelum diperbaiki, ketiga kanal melaporkan −1935,6 / −1423,6 / −911,6 mV, yang
ternyata isi register CONFIG (`0xC383`, `0xD383`, `0xE383`) dan bukan hasil
konversi. Tandanya selisih antar kanal tepat 4096 hitungan.

Baris kedua dipakai memutuskan bahwa **voltage divider tidak diperlukan**:
wiper maksimum 3,06 V, masih di bawah VDD ADS1115 3,294 V dan jauh di bawah
batas absolut input 3,6 V.

## Cara mengambil ulang

```
$env:ARM_WS="ws://10.76.8.190:81"
python tools/kalibrasi_servo.py cek           # read-only, jalankan lebih dulu
python tools/kalibrasi_servo.py derau
python tools/kalibrasi_servo.py sapu 0        # 0=J5, 1=J6, 2=gripper
python tools/kalibrasi_servo.py terap 0,...   # perintahnya dicetak oleh `sapu`
python tools/kalibrasi_servo.py linear 0
python tools/kalibrasi_servo.py ulang 0
python tools/kalibrasi_servo.py cepat 0
python tools/kalibrasi_servo.py busur 0,-90,90
python tools/kalibrasi_servo.py uji 0
python tools/kalibrasi_servo.py simpan        # ke NVS
```

Semua perintah menambah baris, tidak menimpa, jadi sesi baru aman dijalankan
tanpa menghapus data lama.
