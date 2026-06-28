"""Benchmark latensi & sinkronisasi digital twin (pilar Digital Twin Web).

Menjawab rumusan masalah #3: apakah digital twin mencerminkan lengan fisik
secara real-time. Metrik:
  * Latensi end-to-end = t_display - t_physical (ms) per sampel
  * Update rate        = jumlah sampel / rentang waktu (Hz)
  * Sync error         = |angle_twin - angle_physical| (derajat)

Cara ambil data: catat timestamp saat sendi fisik mencapai sudut tertentu
(dari feedback encoder) dan saat model 3D di web menampilkannya. Bisa lewat
log bridge atau stopwatch frame video.

Input CSV: sample,t_physical_ms,t_display_ms,angle_physical,angle_twin
    python benchmarks/latency_test.py benchmarks/data/latency_sample.csv
"""

from __future__ import annotations

import csv
import statistics
import sys
from pathlib import Path

TARGET_LATENCY_MS = 100.0
TARGET_RATE_HZ = 30.0


def load(csv_path: Path) -> list[dict]:
    rows = []
    with csv_path.open(newline="") as f:
        for r in csv.DictReader(f):
            rows.append(
                {
                    "t_phys": float(r["t_physical_ms"]),
                    "t_disp": float(r["t_display_ms"]),
                    "a_phys": float(r["angle_physical"]),
                    "a_twin": float(r["angle_twin"]),
                }
            )
    return rows


def analyze(rows: list[dict]) -> dict:
    latencies = [r["t_disp"] - r["t_phys"] for r in rows]
    sync_err = [abs(r["a_twin"] - r["a_phys"]) for r in rows]
    span_s = (rows[-1]["t_phys"] - rows[0]["t_phys"]) / 1000.0
    rate = (len(rows) - 1) / span_s if span_s > 0 else float("nan")
    return {
        "n": len(rows),
        "latency_mean": statistics.fmean(latencies),
        "latency_max": max(latencies),
        "latency_p95": sorted(latencies)[max(0, int(0.95 * len(latencies)) - 1)],
        "rate_hz": rate,
        "sync_mean": statistics.fmean(sync_err),
        "sync_max": max(sync_err),
    }


def report(s: dict) -> None:
    def verdict(ok: bool) -> str:
        return "OK" if ok else "DI ATAS TARGET"

    print(f"Sampel              : {s['n']}")
    print(
        f"Latensi rata-rata   : {s['latency_mean']:.1f} ms   "
        f"({verdict(s['latency_mean'] <= TARGET_LATENCY_MS)}, target <{TARGET_LATENCY_MS:.0f})"
    )
    print(f"Latensi p95 / maks  : {s['latency_p95']:.1f} / {s['latency_max']:.1f} ms")
    print(
        f"Update rate         : {s['rate_hz']:.1f} Hz   "
        f"({verdict(s['rate_hz'] >= TARGET_RATE_HZ)}, target >{TARGET_RATE_HZ:.0f})"
    )
    print(f"Sync error rata2/max: {s['sync_mean']:.2f}° / {s['sync_max']:.2f}°")


def plot(rows: list[dict], out_path: Path) -> None:
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        print("matplotlib belum terpasang; lewati plot.")
        return

    latencies = [r["t_disp"] - r["t_phys"] for r in rows]
    fig, ax = plt.subplots(figsize=(8, 4.5))
    ax.hist(latencies, bins=15, color="#39c2e0", edgecolor="#141b22")
    ax.axvline(TARGET_LATENCY_MS, ls="--", color="#f06c5e", label=f"Target {TARGET_LATENCY_MS:.0f} ms")
    ax.set_xlabel("Latensi end-to-end (ms)")
    ax.set_ylabel("Frekuensi")
    ax.set_title("Distribusi latensi digital twin")
    ax.legend()
    fig.tight_layout()
    fig.savefig(out_path, dpi=130)
    print(f"\nPlot disimpan: {out_path}")


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    csv_path = Path(sys.argv[1])
    rows = load(csv_path)
    report(analyze(rows))
    plot(rows, csv_path.parent / "latency_benchmark.png")


if __name__ == "__main__":
    main()
