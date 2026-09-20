# Data kalibrasi dan galat sendi

Data mentah pengukuran kalibrasi di hardware asli. Prosedur dan jebakannya di
`firmware/kalibrasi.md`.

| Isi | Sendi | Perkakas | Alat ukur |
| --- | --- | --- | --- |
| `j1-*.csv` di folder ini | J1 stepper | `tools/kalibrasi_sendi.py` | AS5600 lewat mux TCA9548A |
| [`servo/`](servo/) | J5, J6, gripper | `tools/kalibrasi_servo.py` | pot internal servo lewat ADS1115 |

Keduanya dipisah karena besaran mentahnya beda: sendi stepper diukur langsung
dalam derajat oleh encoder absolut, sedangkan servo diukur dalam **milivolt**
tegangan wiper dan baru dikonversi ke derajat lewat kalibrasi dua titik. Jangan
mencampur kolomnya begitu saja.

Semua sudut dalam derajat pada sisi OUTPUT sendi. Kolom `sesi` adalah waktu
mulai skrip, `tahap` label percobaan yang diisi manual saat menjalankan, jadi
satu berkas memuat banyak percobaan tanpa saling menimpa.

## Berkas J1 (sendi stepper)

**`j1-sapuan.csv`** titik demi titik satu sapuan. Satu baris = satu posisi
berhenti.

| kolom | arti |
| --- | --- |
| `perintah_deg` | sudut yang diminta lewat `goto` |
| `encoder_deg` | sudut yang benar benar terbaca AS5600 |
| `galat_deg` | `encoder_deg - perintah_deg` |
| `sisa_linier_deg` | sisa terhadap garis lurus kuadrat terkecil sapuan itu |
| `rasio_terpasang` | nilai `ratio` di firmware saat data diambil |

**`j1-ringkas.csv`** satu baris per sapuan: kemiringan, rasio sejati yang
disimpulkan, rms sisa, galat rerata dan maksimum, backlash.

**`j1-pengulangan.csv`** mendatangi sasaran yang sama berulang kali dari dua
arah, dengan `kp=0` supaya yang terukur mekaniknya, bukan kemampuan loop
menutup selisih.

**`j1-loop-tertutup.csv`** galat akhir dengan loop tertutup hidup, tiap sasaran
didatangi dari bawah dan dari atas.

## Ringkasan J1, 7 Agustus 2026

Rasio reduksi **15**, sesuai rancangan. Ini baru bisa disimpulkan dari sapuan
satu putaran penuh; sapuan sempit memberi 15,14 sampai 15,59 dan semuanya
salah. Lihat `firmware/kalibrasi.md` bagian "rasio TIDAK bisa diukur di jendela
sempit".

| besaran | nilai |
| --- | --- |
| derau encoder saat diam | 0,006 deg rms, puncak 1 LSB (0,088 deg) |
| pengulangan satu arah | 0,054 deg simpangan baku |
| backlash | 0,617 deg |
| galat sistematis 2 siklus/putaran | 1,376 deg |
| galat sistematis 1 siklus/putaran | 0,871 deg |
| sisa sesudah model | 0,246 deg rms |
| galat loop tertutup, sebelum perbaikan | 1,201 deg rms, 2,101 deg maks |
| galat loop tertutup, sesudah perbaikan | 0,212 deg rms, 0,290 deg maks |

Dua baris terakhir mengapit satu perbaikan firmware: koreksi loop tertutup
ternyata dibatalkan sendiri oleh cabang `isRunning()` sebelum sempat ditempuh,
jadi galat loop tertutup sama persis dengan galat open-loop. Sesudah diperbaiki
seluruh titik masuk deadband 0,3 deg.

Yang membatasi ketelitian J1 sekarang bukan lagi kendali maupun mekanik,
melainkan **galat encoder**: 1,4 dan 0,9 derajat berpola dua dan satu siklus
per putaran. AS5600 melapor `ML=1` dengan `AGC=128` mentok, artinya magnetnya
terlalu jauh atau tidak sepusat sumbu. Menurunkan galat absolut di bawah 1
derajat menuntut perbaikan dudukan magnet, bukan perubahan perangkat lunak.
Pengulangannya sendiri sudah 0,054 deg dan tidak ikut terpengaruh.

## Cara membaca ulang

```
$env:SENDI=1
$env:RASIO=15
python tools/kalibrasi_analisa.py putaran-penuh
```

Perintah itu memecah kurva galat jadi offset, skala, dan harmonik 1 sampai 3,
lalu melaporkan sisa tiap model. Sisa yang sudah turun ke sekitar 0,1 deg
berarti modelnya sudah menangkap semua yang berpola.

## Ringkasan servo, 10 Agustus 2026

Detail lengkap dan penjelasan tiap kolom di [`servo/README.md`](servo/README.md).

Ketiga servo menempuh rentang perintah penuh 500 sampai 2500 µs tanpa menemukan
stop mekanis; travelnya 180° (terukur lewat kolinearitas horn di kedua ujung),
jadi skalanya 0,0900 °/µs dan titik tengahnya 1500 µs.

| besaran | J5 MG996R | J6 MG996R | Gripper MG90S |
| --- | --- | --- | --- |
| R² kurva µs ke mV | 0,99988 | 0,99991 | 0,99988 |
| galat linier maks | 0,58 % | 0,51 % | 0,79 % |
| histeresis maks | 1,72 % | 0,31 % | 1,17 % |
| derau saat diam | **41,471 mV** | 0,077 mV | 0,046 mV |
| pengulangan titik tengah | 5,985 mV | 2,476 mV | 4,068 mV |
| kecepatan | 0,211 s/60° | 0,218 s/60° | 0,077 s/60° |
| galat perintah lawan ukur | 0,59° rms | 0,74° rms | 1,33° rms |

Dua hal yang membatasi ketelitian, dan keduanya bukan ADC (1 LSB ADS1115 =
0,125 mV = 0,008°):

1. **J5 tidak pernah benar-benar diam**, derau diamnya 500 kali lipat J6 karena
   servonya terus berburu melawan beban wrist plus gripper. Pola yang sama
   muncul di histeresis dan pengulangannya.
2. **Ground bounce** dari arus motor servo lewat GND bersama, yang menggeser
   referensi ADS1115 sampai ratusan milivolt ke arah rendah selagi servo
   bergerak.
