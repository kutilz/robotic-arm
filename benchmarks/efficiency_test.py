"""Benchmark efisiensi cycloidal drive cetak 3D.

    efisiensi = torsi_output_terukur / (torsi_input_motor * rasio_reduksi)

Torsi input motor diestimasi dari torsi running (0,5 x holding) atau diukur
langsung bila ada sensor arus. Dibandingkan dengan asumsi sizing
(eta = 0,75) untuk memvalidasi apakah rasio bahu dan siku bisa diturunkan.

CATATAN PENTING SOAL RASIO DI CSV. Kolom `ratio` harus berisi rasio tahap
yang benar-benar diukur. Untuk J3 yang memakai belt 3:1 lalu cycloidal 1:10,
mengukur dari poros motor sampai keluaran sendi berarti rasio 30 dan efisiensi
yang terhitung adalah efisiensi GABUNGAN belt dan cycloidal, bukan efisiensi
cycloidal saja. Tulis di Bab IV yang mana yang diukur; keduanya sah asal
dinyatakan.

Input CSV: joint,output_nm,input_nm,ratio
    python benchmarks/efficiency_test.py benchmarks/data/efficiency_sample.csv
"""

from __future__ import annotations

import csv
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import datacheck  # noqa: E402
from arm import config as C  # noqa: E402


def load(csv_path: Path) -> list[dict]:
    rows = []
    with csv_path.open(newline="") as f:
        for row in csv.DictReader(f):
            out_nm = float(row["output_nm"])
            in_nm = float(row["input_nm"])
            ratio = float(row["ratio"])
            rows.append({
                "joint": row["joint"].strip().upper(),
                "output_nm": out_nm,
                "input_nm": in_nm,
                "ratio": ratio,
                "eff": out_nm / (in_nm * ratio) if in_nm and ratio else float("nan"),
            })
    return rows


def report(rows: list[dict]) -> None:
    print(f"{'Joint':<6} {'Output':>9} {'Input':>9} {'Rasio':>7} "
          f"{'Efisiensi':>10} {'vs asumsi':>11}")
    print("-" * 58)
    for r in rows:
        delta = r["eff"] - C.CYCLOIDAL_EFFICIENCY
        verdict = f"{delta*100:+.1f} poin"
        print(f"{r['joint']:<6} {r['output_nm']:>7.2f}N {r['input_nm']:>7.3f}N "
              f"1:{r['ratio']:<5.0f} {r['eff']*100:>8.1f}% {verdict:>11}")
    print("-" * 58)
    print(f"Asumsi sizing: eta = {C.CYCLOIDAL_EFFICIENCY:.2f}.")
    better = [r["joint"] for r in rows if r["eff"] >= 0.85]
    worse = [r["joint"] for r in rows if r["eff"] < C.CYCLOIDAL_EFFICIENCY]
    if better:
        print(f"Sendi dengan efisiensi >= 0,85 ({', '.join(better)}): rasio "
              f"reduksinya berpotensi diturunkan tanpa kehilangan torsi keluaran.")
    if worse:
        print(f"Sendi di bawah asumsi ({', '.join(worse)}): torsi keluaran nyata "
              f"lebih kecil daripada Tabel 3.4; sebutkan ini saat membahas Tabel 4.4.")


def write_summary_csv(rows: list[dict], out_path: Path) -> None:
    """CSV ringkas yang kolomnya sudah sesuai Tabel 4.5 Bab IV."""
    with out_path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["joint", "ratio", "input_nm", "output_nm", "efisiensi",
                    "asumsi", "selisih_poin"])
        for r in rows:
            w.writerow([r["joint"], f"{r['ratio']:.0f}", f"{r['input_nm']:.4f}",
                        f"{r['output_nm']:.4f}", f"{r['eff']:.4f}",
                        f"{C.CYCLOIDAL_EFFICIENCY:.2f}",
                        f"{(r['eff']-C.CYCLOIDAL_EFFICIENCY)*100:+.2f}"])
    print(f"Ringkasan CSV disimpan: {out_path}")


def plot(rows: list[dict], out_path: Path) -> None:
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        import vizstyle as V
    except ImportError:
        print("matplotlib belum terpasang; lewati plot.")
        return

    V.apply_rc(plt)
    joints = [r["joint"] for r in rows]
    effs = [r["eff"] * 100 for r in rows]
    x = list(range(len(joints)))

    fig, ax = plt.subplots(figsize=(9.6, 5.2))
    colors = [V.SERIES_BLUE if e >= C.CYCLOIDAL_EFFICIENCY * 100 else V.SERIES_ORANGE
              for e in effs]
    ax.bar(x, effs, 0.52, color=colors)
    for i, e in enumerate(effs):
        V.annotate_value(ax, i, e, f"{e:.1f}%", dx=0, dy=5, ha="center",
                         size=9, box=False)

    V.threshold_line(ax, C.CYCLOIDAL_EFFICIENCY * 100,
                     f"asumsi sizing {C.CYCLOIDAL_EFFICIENCY:.2f}", color=V.CRITICAL)
    V.threshold_line(ax, 85.0, "ambang 0,85: rasio bisa diturunkan",
                     color=V.MUTED, ls=":")

    ax.set_xticks(x)
    ax.set_xticklabels([f"{r['joint']}\n1:{r['ratio']:.0f}" for r in rows])
    ax.set_ylabel("efisiensi transmisi terukur (%)")
    ax.set_ylim(0, max(effs + [90.0]) * 1.22)
    V.strip_frame(ax)

    V.suptitle(fig, "Efisiensi cycloidal drive cetak 3D: asumsi 0,75 diuji langsung",
               "Batang oranye berarti efisiensi terukur di bawah asumsi sizing")
    V.figure_caption(
        fig,
        "Sumber: benchmarks/efficiency_test.py. Efisiensi = torsi keluaran terukur dibagi hasil kali "
        "torsi masukan dan rasio reduksi. Batang oranye berarti di bawah asumsi sizing, sehingga torsi "
        "keluaran nyata lebih kecil daripada Tabel 3.4.",
    )
    fig.subplots_adjust(top=0.86, bottom=0.16, left=0.085, right=0.975)
    fig.savefig(out_path, dpi=200)
    print(f"Plot disimpan: {out_path}")


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    csv_path = Path(sys.argv[1])
    datacheck.warn_if_sample(csv_path)
    rows = load(csv_path)
    report(rows)
    write_summary_csv(rows, csv_path.parent / "efficiency_summary.csv")
    plot(rows, csv_path.parent / "efficiency_benchmark.png")


if __name__ == "__main__":
    main()
