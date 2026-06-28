"""Benchmark efisiensi cycloidal drive cetak 3D.

efisiensi = torsi_output_terukur / (torsi_input_motor * rasio_reduksi)

Torsi input motor diestimasi dari torsi running (0.5 x holding) atau diukur
langsung bila ada sensor arus. Bandingkan dengan asumsi sizing (eta = 0.75)
untuk memvalidasi apakah rasio bahu/siku bisa diturunkan (dokumen riset §5).

Input CSV: joint,output_nm,input_nm,ratio
    python benchmarks/efficiency_test.py benchmarks/data/efficiency_sample.csv
"""

from __future__ import annotations

import csv
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from arm import config as C  # noqa: E402


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    csv_path = Path(sys.argv[1])

    print(f"{'Joint':<6} {'Output':>8} {'Input':>8} {'Rasio':>6} {'Efisiensi':>10} {'vs 0.75':>9}")
    print("-" * 52)
    with csv_path.open(newline="") as f:
        for row in csv.DictReader(f):
            joint = row["joint"].strip().upper()
            out_nm = float(row["output_nm"])
            in_nm = float(row["input_nm"])
            ratio = float(row["ratio"])
            eff = out_nm / (in_nm * ratio)
            verdict = "lebih baik" if eff >= C.CYCLOIDAL_EFFICIENCY else "lebih buruk"
            print(
                f"{joint:<6} {out_nm:>6.2f}N {in_nm:>6.3f}N 1:{ratio:<4.0f} "
                f"{eff*100:>8.1f}%  {verdict:>9}"
            )

    print(
        f"\nAsumsi sizing: eta = {C.CYCLOIDAL_EFFICIENCY:.2f}. "
        "Bila terukur >= 0.85, rasio bahu bisa turun ke ~1:50 (riset §Benchmarks)."
    )


if __name__ == "__main__":
    main()
