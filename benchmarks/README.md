# Benchmarks

Mengukur performa aktual lengan dan membandingkannya dengan prediksi sizing.
Ini adalah bukti empiris untuk bab Pengujian/Pembahasan skripsi.

## 1. Benchmark torsi (`torque_test.py`)

**Metode tuas + timbangan** (HowToMechatronics, dokumen riset §Recommendations):
pasang tuas sepanjang `lever_arm_m` pada output sendi, tarik dengan timbangan
gantung sampai sendi mulai bergerak, catat `scale_kg`.

```
torsi_terukur (N·m) = scale_kg × 9.81 × lever_arm_m
```

```bash
python benchmarks/torque_test.py benchmarks/data/torque_sample.csv
```

Menghasilkan tabel terukur-vs-prediksi dan plot `data/torque_benchmark.png`.

## 2. Benchmark efisiensi (`efficiency_test.py`)

```
efisiensi = torsi_output_terukur / (torsi_input_motor × rasio_reduksi)
```

```bash
python benchmarks/efficiency_test.py benchmarks/data/efficiency_sample.csv
```

Validasi asumsi sizing η = 0.75. Bila efisiensi terukur ≥ 0.85, rasio bahu bisa
diturunkan ke ~1:50 (dokumen riset §Benchmarks).

## Format data

| File | Kolom |
|---|---|
| `torque_sample.csv` | `joint,lever_arm_m,scale_kg` |
| `efficiency_sample.csv` | `joint,output_nm,input_nm,ratio` |

CSV `*_sample.csv` adalah contoh format. Ganti dengan pengukuran nyata Anda;
file `*_run*.csv` dan `*.png` di-ignore git (lihat `.gitignore`).
