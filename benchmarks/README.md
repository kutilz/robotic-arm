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

## 3. Benchmark akurasi posisi (`accuracy_test.py`) — pilar Position Feedback

Hasil pamungkas skripsi: membuktikan closed-loop (encoder) lebih akurat dari
open-loop. Metrik gaya ISO 9283 — akurasi (rata-rata |error|), repeatability
(SD pengulangan), dan perbandingan open vs closed-loop.

```bash
python benchmarks/accuracy_test.py benchmarks/data/accuracy_sample.csv
```

Menghasilkan tabel per sendi + plot `data/accuracy_benchmark.png`.

## 4. Benchmark latensi digital twin (`latency_test.py`) — pilar Digital Twin

Mengukur seberapa real-time model web mencerminkan lengan fisik: latensi
end-to-end (target <100 ms), update rate (target ≥30 Hz), dan sync error.

```bash
python benchmarks/latency_test.py benchmarks/data/latency_sample.csv
```

## Format data

| File | Kolom |
|---|---|
| `torque_sample.csv` | `joint,lever_arm_m,scale_kg` |
| `efficiency_sample.csv` | `joint,output_nm,input_nm,ratio` |
| `accuracy_sample.csv` | `joint,mode,commanded_deg,measured_deg,run` (mode=open\|closed) |
| `latency_sample.csv` | `sample,t_physical_ms,t_display_ms,angle_physical,angle_twin` |

CSV `*_sample.csv` adalah contoh format. Ganti dengan pengukuran nyata Anda;
file `*_run*.csv` dan `*.png` di-ignore git (lihat `.gitignore`).
