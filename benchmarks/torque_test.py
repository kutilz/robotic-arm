"""Benchmark torsi output terukur vs prediksi.

Metode tuas + timbangan (HowToMechatronics, lihat dokumen riset §Recommendations):
pasang tuas sepanjang `lever_arm_m` pada output sendi, tarik dengan timbangan
gantung sampai sendi mulai bergerak, catat `scale_kg`.

    torsi_terukur (N.m) = scale_kg * 9.81 * lever_arm_m

Input: CSV dengan kolom  joint,lever_arm_m,scale_kg  (lihat data/torque_sample.csv)
Output: tabel terukur vs prediksi + plot ke data/torque_benchmark.png

    python benchmarks/torque_test.py benchmarks/data/torque_sample.csv
"""

from __future__ import annotations

import csv
import sys
from pathlib import Path

# pastikan paket 'arm' bisa diimpor saat dijalankan langsung
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from arm import config as C  # noqa: E402
from arm import torque  # noqa: E402

GRAVITY = C.GRAVITY


def measured_torque(scale_kg: float, lever_arm_m: float) -> float:
    return scale_kg * GRAVITY * lever_arm_m


def load_measurements(csv_path: Path) -> list[dict]:
    rows: list[dict] = []
    with csv_path.open(newline="") as f:
        for row in csv.DictReader(f):
            joint = row["joint"].strip().upper()
            lever = float(row["lever_arm_m"])
            scale = float(row["scale_kg"])
            rows.append(
                {
                    "joint": joint,
                    "lever_arm_m": lever,
                    "scale_kg": scale,
                    "measured_nm": measured_torque(scale, lever),
                }
            )
    return rows


def analyze(csv_path: Path) -> list[dict]:
    rows = load_measurements(csv_path)
    predicted = {r.name: r.delivered_nm for r in torque.build_report()}
    print(f"{'Joint':<6} {'Terukur':>9} {'Prediksi':>9} {'Selisih':>9} {'Rasio':>7}")
    print("-" * 44)
    for r in rows:
        pred = predicted.get(r["joint"], float("nan"))
        diff = r["measured_nm"] - pred
        ratio = r["measured_nm"] / pred if pred else float("nan")
        r["predicted_nm"] = pred
        print(
            f"{r['joint']:<6} {r['measured_nm']:>7.2f}N {pred:>7.2f}N "
            f"{diff:>+7.2f}N {ratio:>6.2f}x"
        )
    return rows


def plot(rows: list[dict], out_path: Path) -> None:
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        print("matplotlib belum terpasang; lewati plot.")
        return

    joints = [r["joint"] for r in rows]
    measured = [r["measured_nm"] for r in rows]
    predicted = [r["predicted_nm"] for r in rows]
    x = range(len(joints))
    width = 0.38

    fig, ax = plt.subplots(figsize=(8, 4.5))
    ax.bar([i - width / 2 for i in x], predicted, width, label="Prediksi", color="#39c2e0")
    ax.bar([i + width / 2 for i in x], measured, width, label="Terukur", color="#e08a3c")
    ax.set_xticks(list(x))
    ax.set_xticklabels(joints)
    ax.set_ylabel("Torsi output (N.m)")
    ax.set_title("Benchmark torsi: prediksi vs terukur")
    ax.legend()
    fig.tight_layout()
    fig.savefig(out_path, dpi=130)
    print(f"\nPlot disimpan: {out_path}")


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    csv_path = Path(sys.argv[1])
    rows = analyze(csv_path)
    plot(rows, csv_path.parent / "torque_benchmark.png")


if __name__ == "__main__":
    main()
