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

import datacheck  # noqa: E402
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


def _model_predictions() -> tuple[dict[str, float], dict[str, float], dict[str, float]]:
    """(prediksi datasheet, prediksi setelan arus firmware, kebutuhan) per sendi.

    Dua prediksi sengaja dibawa sekaligus. Prediksi datasheet mengandaikan
    driver berjalan pada arus rated; setelan firmware nyata lebih rendah karena
    batas termal. Selisih keduanya adalah hipotesis yang justru diuji oleh
    pengukuran ini, jadi jangan dihilangkan salah satunya.
    """
    reports = torque.build_report()
    datasheet = {r.name: r.delivered_nm for r in reports}
    required = {r.name: r.required_nm for r in reports}
    firmware = dict(datasheet)
    try:
        import current_derating as CD

        for j in C.JOINTS:
            if j.name in CD.FIRMWARE_MA:
                firmware[j.name] = CD.delivered_at(j, CD.FIRMWARE_MA[j.name], "A")
    except ImportError:
        pass
    return datasheet, firmware, required


def analyze(csv_path: Path) -> list[dict]:
    rows = load_measurements(csv_path)
    datasheet, firmware, required = _model_predictions()
    print(f"{'Joint':<6} {'Terukur':>9} {'Datasheet':>10} {'Arus fw':>9} "
          f"{'Perlu':>8} {'vs fw':>7} {'Lulus':>7}")
    print("-" * 62)
    for r in rows:
        j = r["joint"]
        pred_d = datasheet.get(j, float("nan"))
        pred_f = firmware.get(j, float("nan"))
        req = required.get(j, float("nan"))
        r["predicted_nm"] = pred_d
        r["predicted_fw_nm"] = pred_f
        r["required_nm"] = req
        ratio = r["measured_nm"] / pred_f if pred_f else float("nan")
        lulus = "YA" if r["measured_nm"] >= req else "TIDAK"
        print(f"{j:<6} {r['measured_nm']:>7.2f}N {pred_d:>8.2f}N {pred_f:>7.2f}N "
              f"{req:>6.2f}N {ratio:>6.2f}x {lulus:>7}")
    print("-" * 62)
    print("Kolom 'Arus fw' = prediksi pada setelan arus driver yang benar-benar "
          "dipakai firmware (model A di current_derating.py).")
    print("Kalau terukur mendekati kolom 'Datasheet', berarti derating arus "
          "tidak sebesar yang dimodelkan; kalau mendekati 'Arus fw', model "
          "derating terkonfirmasi. Tulis kesimpulan ini di Bab IV.")
    return rows


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
    measured = [r["measured_nm"] for r in rows]
    pred_d = [r["predicted_nm"] for r in rows]
    pred_f = [r["predicted_fw_nm"] for r in rows]
    req = [r["required_nm"] for r in rows]
    x = list(range(len(joints)))
    w = 0.26

    fig, ax = plt.subplots(figsize=(10.4, 5.4))
    ax.bar([i - w for i in x], pred_d, w * 0.92, color=V.MUTED, alpha=0.45,
           label="prediksi pada arus rated (Tabel 3.4)")
    ax.bar(x, pred_f, w * 0.92, color=V.SERIES_BLUE,
           label="prediksi pada setelan arus firmware")
    ax.bar([i + w for i in x], measured, w * 0.92, color=V.SERIES_ORANGE,
           label="TERUKUR (metode tuas)")

    for i, r in enumerate(rows):
        ax.plot([i - 1.55 * w, i + 1.55 * w], [req[i], req[i]],
                color=V.CRITICAL, linewidth=1.8, zorder=5)
        if pred_f[i]:
            V.annotate_value(ax, i + w, measured[i],
                             f"{measured[i] / pred_f[i]:.2f}x", dx=0, dy=5,
                             ha="center", size=8,
                             color=V.INK if measured[i] >= req[i] else V.CRITICAL)
    ax.plot([], [], color=V.CRITICAL, linewidth=1.8, label="kebutuhan torsi sendi")

    ax.set_xticks(x)
    ax.set_xticklabels(joints)
    ax.set_ylabel("torsi keluaran sendi (N.m)")
    ax.set_xlabel("angka di atas batang terukur = rasio terhadap prediksi setelan arus firmware")
    ax.legend(loc="upper right", fontsize=8)
    V.strip_frame(ax)

    V.suptitle(fig, "Validasi sizing torsi: pengukuran menentukan model mana yang berlaku",
               "Torsi keluaran terukur dibanding prediksi pada arus rated dan pada setelan arus firmware")
    V.figure_caption(
        fig,
        "Sumber: benchmarks/torque_test.py. Torsi terukur = massa timbangan x g x panjang tuas, "
        "dicatat saat sendi mulai bergerak. Garis merah = kebutuhan torsi tiap sendi menurut Tabel 3.4.",
    )
    fig.subplots_adjust(top=0.86, bottom=0.18, left=0.075, right=0.98)
    fig.savefig(out_path, dpi=200)
    print(f"\nPlot disimpan: {out_path}")


def write_summary_csv(rows: list[dict], out_path: Path) -> None:
    """CSV ringkas yang kolomnya sudah sesuai Tabel 4.4 Bab IV."""
    with out_path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["joint", "lever_arm_m", "scale_kg", "terukur_nm",
                    "prediksi_datasheet_nm", "prediksi_arus_firmware_nm",
                    "kebutuhan_nm", "selisih_vs_firmware_persen", "memenuhi"])
        for r in rows:
            pf = r["predicted_fw_nm"]
            dev = (r["measured_nm"] / pf - 1.0) * 100 if pf else float("nan")
            w.writerow([r["joint"], f"{r['lever_arm_m']:.4f}", f"{r['scale_kg']:.4f}",
                        f"{r['measured_nm']:.4f}", f"{r['predicted_nm']:.4f}",
                        f"{pf:.4f}", f"{r['required_nm']:.4f}", f"{dev:+.2f}",
                        int(r["measured_nm"] >= r["required_nm"])])
    print(f"Ringkasan CSV disimpan: {out_path}")


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    csv_path = Path(sys.argv[1])
    datacheck.warn_if_sample(csv_path)
    rows = analyze(csv_path)
    write_summary_csv(rows, csv_path.parent / "torque_summary.csv")
    plot(rows, csv_path.parent / "torque_benchmark.png")


if __name__ == "__main__":
    main()
