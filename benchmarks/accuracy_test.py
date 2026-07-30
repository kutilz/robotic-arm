"""Benchmark akurasi & repeatability posisi (pilar Position Feedback).

Menjawab rumusan masalah #2: apakah closed-loop (umpan balik encoder)
meningkatkan akurasi dibanding open-loop. Ini hasil pamungkas skripsi.

METRIK MENGIKUTI ISO 9283 YANG DIADAPTASI KE RUANG SENDI (Bab III §3.7.2):

    AP_theta = |rata-rata(measured) - commanded|      (akurasi, per posisi)
    RP_theta = 3 * S_theta                            (repeatability, per posisi)

dengan S_theta simpangan baku SAMPEL (pembagi n-1) dari pengulangan pada
posisi perintah yang SAMA. Ini penting: repeatability hanya bermakna kalau
dihitung per posisi perintah lalu digabung, bukan dari simpangan baku seluruh
pembacaan yang mencampur banyak posisi berbeda. Versi awal skrip ini keliru
menggabungkan semuanya sehingga angka repeatability-nya ikut memuat rentang
gerak, bukan sebaran pengulangan.

Penggabungan antarposisi memakai pooled standard deviation, yaitu akar
rata-rata varians berbobot derajat kebebasan, supaya posisi dengan jumlah
pengulangan berbeda tidak menimbang secara tidak adil.

CATATAN VALIDITAS YANG WAJIB DIINGAT SAAT MENULIS BAB IV. Encoder AS5600
adalah sekaligus sensor umpan balik loop kontrol dan alat ukur di sini. Untuk
mode open-loop hal ini sah, karena encoder tidak ikut menentukan perintah
sehingga pembacaannya independen terhadap jalur perintah. Untuk mode
closed-loop, selisih perintah dan pembacaan encoder adalah residual loop
kontrol, BUKAN akurasi absolut sendi. Angka closed-loop harus dilaporkan
sebagai residual kontrol, dan klaim akurasi absolut hanya boleh dibuat kalau
ada alat ukur independen (mis. pointer laser di layar berjarak tetap).

Input CSV: joint,mode,commanded_deg,measured_deg,run
  mode = open | closed   (open-loop tanpa koreksi encoder vs closed-loop)
  run  = indeks pengulangan pada posisi perintah yang sama

    python benchmarks/accuracy_test.py benchmarks/data/accuracy_sample.csv
"""

from __future__ import annotations

import csv
import math
import statistics
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import datacheck  # noqa: E402

TARGET_AP_DEG = 1.0    # target akurasi Tabel 3.9
TARGET_RP_DEG = 0.5    # target repeatability Tabel 3.9
MODES = ("open", "closed")
MODE_LABEL = {"open": "open-loop", "closed": "closed-loop"}


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


def per_position(rows: list[dict]) -> dict[tuple[str, str, float], dict]:
    """Statistik per (sendi, mode, posisi perintah)."""
    groups: dict[tuple[str, str, float], list[float]] = defaultdict(list)
    for r in rows:
        groups[(r["joint"], r["mode"], r["commanded"])].append(r["measured"])

    out = {}
    for (joint, mode, cmd), vals in groups.items():
        n = len(vals)
        mean = statistics.fmean(vals)
        sd = statistics.stdev(vals) if n > 1 else 0.0   # pembagi n-1
        out[(joint, mode, cmd)] = {
            "n": n,
            "mean": mean,
            "sd": sd,
            "ap": abs(mean - cmd),          # akurasi posisi
            "rp": 3.0 * sd,                 # repeatability posisi
            "max_err": max(abs(v - cmd) for v in vals),
        }
    return out


def summarize(rows: list[dict]) -> dict[tuple[str, str], dict]:
    """Gabungkan statistik per posisi menjadi satu angka per (sendi, mode)."""
    pos = per_position(rows)
    grouped: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for (joint, mode, _cmd), s in pos.items():
        grouped[(joint, mode)].append(s)

    out = {}
    for key, items in grouped.items():
        dof = sum(max(i["n"] - 1, 0) for i in items)
        pooled_var = (sum(max(i["n"] - 1, 0) * i["sd"] ** 2 for i in items) / dof
                      if dof > 0 else 0.0)
        pooled_sd = math.sqrt(pooled_var)
        out[key] = {
            "n_pos": len(items),
            "n_total": sum(i["n"] for i in items),
            "n_per_pos": min(i["n"] for i in items),
            "ap_mean": statistics.fmean(i["ap"] for i in items),
            "ap_max": max(i["ap"] for i in items),
            "rp": 3.0 * pooled_sd,
            "sd": pooled_sd,
            "max_err": max(i["max_err"] for i in items),
        }
    return out


def report(summary: dict[tuple[str, str], dict]) -> None:
    print(f"{'Sendi':<6} {'Mode':<12} {'Pos':>4} {'n/pos':>6} {'AP rata2':>10} "
          f"{'AP maks':>9} {'RP=3S':>8} {'Err maks':>9}")
    print("-" * 70)
    for (joint, mode), s in sorted(summary.items()):
        print(f"{joint:<6} {MODE_LABEL.get(mode, mode):<12} {s['n_pos']:>4} "
              f"{s['n_per_pos']:>6} {s['ap_mean']:>8.3f}d {s['ap_max']:>7.3f}d "
              f"{s['rp']:>6.3f}d {s['max_err']:>7.3f}d")

    low_n = [f"{j} {MODE_LABEL.get(m, m)} (n={s['n_per_pos']})"
             for (j, m), s in sorted(summary.items()) if s["n_per_pos"] < 30]
    if low_n:
        print("\nPERINGATAN JUMLAH ULANGAN: ISO 9283 menganjurkan n = 30 per posisi. "
              "Di bawah itu angkanya tetap boleh dilaporkan, tetapi harus disertai "
              "jumlah ulangan yang sebenarnya dan disebut sebagai keterbatasan.")
        for item in low_n:
            print(f"  - {item}")

    joints = sorted({j for j, _ in summary})
    print("\nPerbaikan closed-loop terhadap open-loop:")
    for j in joints:
        o, c = summary.get((j, "open")), summary.get((j, "closed"))
        if not (o and c):
            print(f"  {j}: data kedua mode belum lengkap, belum bisa dibandingkan.")
            continue
        d_ap = ((1 - c["ap_mean"] / o["ap_mean"]) * 100 if o["ap_mean"] > 0 else float("nan"))
        d_rp = ((1 - c["rp"] / o["rp"]) * 100 if o["rp"] > 0 else float("nan"))
        print(f"  {j}: AP {o['ap_mean']:.3f}d -> {c['ap_mean']:.3f}d (turun {d_ap:.0f}%) | "
              f"RP {o['rp']:.3f}d -> {c['rp']:.3f}d (turun {d_rp:.0f}%)")

    print("\nCATATAN VALIDITAS: angka closed-loop adalah residual loop kontrol, "
          "karena encoder yang dipakai mengukur juga dipakai sebagai umpan balik. "
          "Klaim akurasi absolut hanya sah untuk mode open-loop, atau untuk "
          "closed-loop bila diverifikasi alat ukur independen.")


def write_summary_csv(summary: dict[tuple[str, str], dict], out_path: Path) -> None:
    """CSV ringkas yang kolomnya sudah sesuai Tabel 4.6 Bab IV."""
    with out_path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["joint", "mode", "n_posisi", "n_per_posisi", "AP_mean_deg",
                    "AP_max_deg", "RP_deg", "SD_deg", "err_maks_deg"])
        for (joint, mode), s in sorted(summary.items()):
            w.writerow([joint, mode, s["n_pos"], s["n_per_pos"],
                        f"{s['ap_mean']:.4f}", f"{s['ap_max']:.4f}",
                        f"{s['rp']:.4f}", f"{s['sd']:.4f}", f"{s['max_err']:.4f}"])
    print(f"Ringkasan CSV disimpan: {out_path}")


def plot(summary: dict[tuple[str, str], dict], out_path: Path) -> None:
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        import vizstyle as V
    except ImportError:
        print("matplotlib belum terpasang; lewati plot.")
        return

    V.apply_rc(plt)
    joints = sorted({j for j, _ in summary})
    x = list(range(len(joints)))
    w = 0.36

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(13.0, 5.4))

    panels = (
        (ax1, "ap_mean", TARGET_AP_DEG, "Akurasi posisi AP",
         "akurasi AP (derajat)", f"target {TARGET_AP_DEG:g} derajat"),
        (ax2, "rp", TARGET_RP_DEG, "Repeatability RP = 3S",
         "repeatability RP (derajat)", f"target {TARGET_RP_DEG:g} derajat"),
    )
    for ax, key, target, title, ylab, tlabel in panels:
        vals_o = [summary.get((j, "open"), {}).get(key, 0.0) for j in joints]
        vals_c = [summary.get((j, "closed"), {}).get(key, 0.0) for j in joints]
        ax.bar([i - w / 2 for i in x], vals_o, w * 0.92, color=V.MUTED,
               alpha=0.55, label="open-loop")
        ax.bar([i + w / 2 for i in x], vals_c, w * 0.92, color=V.SERIES_BLUE,
               label="closed-loop")
        V.threshold_line(ax, target, tlabel, color=V.CRITICAL)

        for i, j in enumerate(joints):
            if vals_o[i] > 0 and vals_c[i] > 0:
                drop = (1 - vals_c[i] / vals_o[i]) * 100
                V.annotate_value(ax, i, max(vals_o[i], vals_c[i]),
                                 f"turun {drop:.0f}%", dx=0, dy=7, ha="center",
                                 size=8.5,
                                 color=V.GOOD if drop > 0 else V.CRITICAL)
        ax.set_xticks(x)
        ax.set_xticklabels(joints)
        ax.set_title(title)
        ax.set_ylabel(ylab)
        ax.set_ylim(0, max(vals_o + vals_c + [target]) * 1.32 or 1.0)
        ax.legend(loc="upper right")
        V.strip_frame(ax)

    n_min = min((s["n_per_pos"] for s in summary.values()), default=0)
    V.suptitle(
        fig,
        "Umpan balik posisi menekan error: open-loop dibanding closed-loop",
        f"Metrik ISO 9283 diadaptasi ke ruang sendi; minimal {n_min} pengulangan "
        f"per posisi perintah",
    )
    V.figure_caption(
        fig,
        "Sumber: benchmarks/accuracy_test.py. AP = selisih rata-rata pembacaan terhadap perintah; "
        "RP = 3 kali simpangan baku sampel pengulangan pada posisi perintah yang sama, digabung "
        "antarposisi secara pooled. Angka closed-loop adalah residual loop kontrol karena encoder yang "
        "mengukur juga dipakai sebagai umpan balik; lihat pembahasan validitas di Bab III.",
    )
    fig.subplots_adjust(top=0.855, bottom=0.155, wspace=0.22, left=0.06, right=0.98)
    fig.savefig(out_path, dpi=200)
    print(f"Plot disimpan: {out_path}")


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    csv_path = Path(sys.argv[1])
    datacheck.warn_if_sample(csv_path)
    rows = load(csv_path)
    summary = summarize(rows)
    report(summary)
    write_summary_csv(summary, csv_path.parent / "accuracy_summary.csv")
    plot(summary, csv_path.parent / "accuracy_benchmark.png")


if __name__ == "__main__":
    main()
