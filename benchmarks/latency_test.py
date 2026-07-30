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

sys.path.insert(0, str(Path(__file__).resolve().parent))

import datacheck  # noqa: E402

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


def write_summary_csv(s: dict, out_path: Path) -> None:
    """CSV ringkas yang kolomnya sudah sesuai Tabel 4.9 Bab IV."""
    with out_path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["metrik", "nilai", "satuan", "target", "lulus"])
        w.writerow(["latensi_rata2", f"{s['latency_mean']:.2f}", "ms",
                    f"<{TARGET_LATENCY_MS:.0f}",
                    int(s["latency_mean"] <= TARGET_LATENCY_MS)])
        w.writerow(["latensi_p95", f"{s['latency_p95']:.2f}", "ms",
                    f"<{TARGET_LATENCY_MS:.0f}",
                    int(s["latency_p95"] <= TARGET_LATENCY_MS)])
        w.writerow(["latensi_maks", f"{s['latency_max']:.2f}", "ms", "-", ""])
        w.writerow(["update_rate", f"{s['rate_hz']:.2f}", "Hz",
                    f">{TARGET_RATE_HZ:.0f}", int(s["rate_hz"] >= TARGET_RATE_HZ)])
        w.writerow(["sync_error_rata2", f"{s['sync_mean']:.3f}", "derajat", "<=2", ""])
        w.writerow(["sync_error_maks", f"{s['sync_max']:.3f}", "derajat", "<=2", ""])
        w.writerow(["n_sampel", s["n"], "buah", "-", ""])
    print(f"Ringkasan CSV disimpan: {out_path}")


def plot(rows: list[dict], s: dict, out_path: Path) -> None:
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        import vizstyle as V
    except ImportError:
        print("matplotlib belum terpasang; lewati plot.")
        return

    V.apply_rc(plt)
    latencies = [r["t_disp"] - r["t_phys"] for r in rows]
    sync_err = [abs(r["a_twin"] - r["a_phys"]) for r in rows]

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(13.0, 5.2))

    # --- Panel 1: distribusi latensi -------------------------------------
    ax1.hist(latencies, bins=20, color=V.SERIES_BLUE, alpha=0.22, linewidth=0)
    ax1.hist(latencies, bins=20, histtype="step", color=V.SERIES_BLUE,
             linewidth=1.8)
    for val, label, color in ((s["latency_mean"], "rata-rata", V.SERIES_BLUE),
                              (s["latency_p95"], "p95", V.SERIES_ORANGE)):
        ax1.axvline(val, color=color, linestyle="--", linewidth=1.4, zorder=4)
        V.annotate_value(ax1, val, ax1.get_ylim()[1] * 0.92,
                         f"{label}\n{val:.1f} ms", color=color, dx=6, dy=0,
                         va="top", size=8)
    ax1.axvline(TARGET_LATENCY_MS, color=V.CRITICAL, linestyle="-", linewidth=2.0,
                zorder=5)
    ax1.text(TARGET_LATENCY_MS, ax1.get_ylim()[1] * 0.99,
             f" batas target {TARGET_LATENCY_MS:.0f} ms", color=V.CRITICAL,
             fontsize=8, fontweight="bold", va="top", ha="left")
    ax1.set_title("Distribusi latensi end-to-end")
    ax1.set_xlabel("latensi gerak fisik sampai tampil di peramban (ms)")
    ax1.set_ylabel("jumlah sampel")
    V.strip_frame(ax1)

    # --- Panel 2: sync error ---------------------------------------------
    ax2.hist(sync_err, bins=20, color=V.SERIES_AQUA, alpha=0.22, linewidth=0)
    ax2.hist(sync_err, bins=20, histtype="step", color=V.SERIES_AQUA,
             linewidth=1.8)
    ax2.axvline(s["sync_mean"], color=V.SERIES_AQUA, linestyle="--", linewidth=1.4)
    V.annotate_value(ax2, s["sync_mean"], ax2.get_ylim()[1] * 0.92,
                     f"rata-rata\n{s['sync_mean']:.2f} derajat", color="#12805a",
                     dx=6, dy=0, va="top", size=8)
    ax2.axvline(2.0, color=V.CRITICAL, linestyle="-", linewidth=2.0)
    ax2.text(2.0, ax2.get_ylim()[1] * 0.99, " batas target 2 derajat",
             color=V.CRITICAL, fontsize=8, fontweight="bold", va="top", ha="left")
    ax2.set_title("Sync error sudut: model virtual vs lengan fisik")
    ax2.set_xlabel("selisih sudut twin terhadap fisik (derajat)")
    ax2.set_ylabel("jumlah sampel")
    V.strip_frame(ax2)

    ok_lat = s["latency_mean"] <= TARGET_LATENCY_MS
    ok_rate = s["rate_hz"] >= TARGET_RATE_HZ
    V.suptitle(
        fig,
        f"Digital twin: latensi rata-rata {s['latency_mean']:.0f} ms, update rate "
        f"{s['rate_hz']:.0f} Hz",
        f"Target latensi di bawah {TARGET_LATENCY_MS:.0f} ms "
        f"{'terpenuhi' if ok_lat else 'BELUM terpenuhi'}; target update rate "
        f"{TARGET_RATE_HZ:.0f} Hz {'terpenuhi' if ok_rate else 'BELUM terpenuhi'}",
    )
    V.figure_caption(
        fig,
        "Sumber: benchmarks/latency_test.py. Latensi dihitung dari selisih stempel waktu saat sendi fisik "
        f"mencapai sudut tertentu dan saat model di peramban menampilkannya, {s['n']} sampel. "
        "Sync error dihitung pada pasangan sampel yang sama.",
    )
    fig.subplots_adjust(top=0.845, bottom=0.155, wspace=0.22, left=0.06, right=0.98)
    fig.savefig(out_path, dpi=200)
    print(f"Plot disimpan: {out_path}")


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    csv_path = Path(sys.argv[1])
    datacheck.warn_if_sample(csv_path)
    rows = load(csv_path)
    s = analyze(rows)
    report(s)
    write_summary_csv(s, csv_path.parent / "latency_summary.csv")
    plot(rows, s, csv_path.parent / "latency_benchmark.png")


if __name__ == "__main__":
    main()
