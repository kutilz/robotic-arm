"""Benchmark akurasi & repeatability posisi (pilar Position Feedback).

Menjawab rumusan masalah #2: apakah closed-loop (encoder) meningkatkan akurasi
dibanding open-loop. Ini hasil pamungkas skripsi.

Metrik (gaya ISO 9283):
  * Akurasi (accuracy)      = rata-rata |commanded - measured|  -> seberapa dekat ke target
  * Repeatability (presisi) = simpangan baku measured saat target sama diulang
  * Open-loop vs closed-loop: bandingkan keduanya pada perintah yang sama

Input CSV: joint,mode,commanded_deg,measured_deg,run
  mode = open | closed   (open-loop tanpa koreksi encoder vs closed-loop)
  run  = indeks pengulangan (untuk repeatability)

    python benchmarks/accuracy_test.py benchmarks/data/accuracy_sample.csv
"""

from __future__ import annotations

import csv
import statistics
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))


def load(csv_path: Path) -> list[dict]:
    rows = []
    with csv_path.open(newline="") as f:
        for r in csv.DictReader(f):
            rows.append(
                {
                    "joint": r["joint"].strip().upper(),
                    "mode": r["mode"].strip().lower(),
                    "commanded": float(r["commanded_deg"]),
                    "measured": float(r["measured_deg"]),
                    "run": int(r["run"]),
                }
            )
    return rows


def summarize(rows: list[dict]) -> dict[tuple[str, str], dict]:
    """Kelompokkan per (sendi, mode) -> akurasi & repeatability."""
    groups: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for r in rows:
        groups[(r["joint"], r["mode"])].append(r)

    out: dict[tuple[str, str], dict] = {}
    for key, items in groups.items():
        errors = [abs(i["commanded"] - i["measured"]) for i in items]
        measured = [i["measured"] for i in items]
        out[key] = {
            "n": len(items),
            "accuracy_deg": statistics.fmean(errors),
            "max_error_deg": max(errors),
            "repeatability_deg": statistics.pstdev(measured) if len(measured) > 1 else 0.0,
        }
    return out


def report(summary: dict[tuple[str, str], dict]) -> None:
    print(f"{'Sendi':<6} {'Mode':<8} {'N':>3} {'Akurasi':>9} {'Maks err':>9} {'Repeat(SD)':>11}")
    print("-" * 50)
    for (joint, mode), s in sorted(summary.items()):
        print(
            f"{joint:<6} {mode:<8} {s['n']:>3} {s['accuracy_deg']:>7.3f}° "
            f"{s['max_error_deg']:>7.3f}° {s['repeatability_deg']:>9.3f}°"
        )

    # Ringkas perbandingan open vs closed per sendi
    joints = sorted({j for j, _ in summary})
    print("\nPerbaikan akurasi closed-loop vs open-loop:")
    for j in joints:
        o = summary.get((j, "open"))
        c = summary.get((j, "closed"))
        if o and c and o["accuracy_deg"] > 0:
            reduction = (1 - c["accuracy_deg"] / o["accuracy_deg"]) * 100
            print(
                f"  {j}: error {o['accuracy_deg']:.3f}° -> {c['accuracy_deg']:.3f}° "
                f"(turun {reduction:.0f}%)"
            )


def plot(summary: dict[tuple[str, str], dict], out_path: Path) -> None:
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        print("matplotlib belum terpasang; lewati plot.")
        return

    joints = sorted({j for j, _ in summary})
    open_acc = [summary.get((j, "open"), {}).get("accuracy_deg", 0) for j in joints]
    closed_acc = [summary.get((j, "closed"), {}).get("accuracy_deg", 0) for j in joints]
    x = range(len(joints))
    w = 0.38

    fig, ax = plt.subplots(figsize=(8, 4.5))
    ax.bar([i - w / 2 for i in x], open_acc, w, label="Open-loop", color="#f06c5e")
    ax.bar([i + w / 2 for i in x], closed_acc, w, label="Closed-loop", color="#4ade80")
    ax.axhline(1.0, ls="--", lw=1, color="#7e8ea0", label="Target ±1°")
    ax.set_xticks(list(x))
    ax.set_xticklabels(joints)
    ax.set_ylabel("Akurasi posisi |error| (°)")
    ax.set_title("Akurasi posisi: open-loop vs closed-loop")
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
    summary = summarize(rows)
    report(summary)
    plot(summary, csv_path.parent / "accuracy_benchmark.png")


if __name__ == "__main__":
    main()
