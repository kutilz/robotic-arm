"""Simulasi 4 - Propagasi error sudut sendi ke error posisi TCP.

Sumber error sudut BERBEDA per sendi, mengikuti jalur umpan balik di
config.py (jangan disamaratakan seperti versi lama):

  J1..J4 (AS5600 di output sendi, bergearbox):
    * kuantisasi AS5600   : 12-bit, 0.0879 deg/LSB -> error uniform +-LSB/2
    * akurasi AS5600      : +-0.5 deg absolut (akurasi, bukan repeatability)
    * backlash gearbox    : lost motion, di-sweep 0.3..1.0 deg (default 0.5),
                            error uniform +-backlash/2

  J5..J6 (pot internal servo -> ADC1 ESP32, direct drive):
    * kuantisasi ADC saja : LSB ADC dipetakan lewat kalibrasi 2 titik
                            (J5 ~0.18 deg, J6 ~0.27 deg per count)
    * TANPA backlash      : servo direct drive, tidak ada gearbox eksternal
    * akurasi absolut     : BELUM DIUKUR (config.SERVO_FB_ACCURACY_DEG = NaN),
                            jadi dianggap 0 di sini. Konsekuensinya kurva
                            "total" MENGECILKAN error nyata J5/J6 -- ini batas
                            model, bukan hasil. Perbarui setelah diukur.

Error sudut dipropagasi ke error posisi TCP lewat Jacobian (dp = J_pos * dtheta)
secara Monte Carlo di seluruh workspace. Dipisah dua komponen supaya bisa
di-overlay dengan hasil ukur hardware:
  * repeatability (kuantisasi + backlash)  -> bandingkan dengan repeatability ukur
  * total (plus akurasi absolut)           -> bandingkan dengan akurasi absolut ukur

Output:
  data/error_model.csv  - sweep backlash: mean/p95/max error TCP (repeat & total)
  data/error_model.png  - histogram error TCP, kontribusi per sendi, kurva vs backlash

    python benchmarks/error_model.py --help
    python benchmarks/error_model.py --samples 5000 --backlash 0.3 1.0
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np

import armlib as A
import vizstyle as V
from arm import config as C

DEG2RAD = np.pi / 180.0

# --- Parameter error per sendi, diturunkan dari config.JOINTS ------------
# Disusun sekali di import supaya urutan kolom persis mengikuti C.JOINTS.
QUANT_DEG = np.array([j.output_resolution_deg for j in C.JOINTS])
# Backlash hanya untuk sendi bergearbox; servo direct drive = 0.
BACKLASH_MASK = np.array([1.0 if j.has_gearbox else 0.0 for j in C.JOINTS])
# Akurasi absolut: hanya AS5600 yang punya angka datasheet. Jalur servo NaN
# (belum diukur) -> dipakai 0.0 supaya tidak meracuni seluruh statistik, dan
# dicatat di ACCURACY_UNKNOWN untuk dilaporkan apa adanya.
ACCURACY_DEG = np.array([
    C.AS5600_ACCURACY_DEG if j.encoder_type == C.ENC_AS5600 else 0.0
    for j in C.JOINTS
])
ACCURACY_UNKNOWN = [
    j.name for j in C.JOINTS if j.encoder_type != C.ENC_AS5600
]


def build_jacobians(samples: int, seed: int):
    """Sampel pose acak + Jacobian posisi (3x6) tiap pose -> (n,3,6)."""
    rng = np.random.default_rng(seed)
    q = A.sample_joints(samples, rng)
    Jp = np.zeros((samples, 3, 6))
    for i in range(samples):
        Jp[i] = A.numeric_jacobian(q[i])[:3, :]
    return q, Jp


def sample_angle_errors(shape, backlash_deg, rng, include_accuracy):
    """Error sudut (deg) per (sampel, sendi) dari sumber yang dipilih.

    Tiap kolom memakai parameter sendi masing-masing: kuantisasi sesuai
    resolusi sensornya, backlash hanya di sendi bergearbox, akurasi absolut
    hanya di sendi ber-AS5600.
    """
    quant = (rng.random(shape) - 0.5) * QUANT_DEG
    back = (rng.random(shape) - 0.5) * backlash_deg * BACKLASH_MASK
    err = quant + back
    if include_accuracy:
        err = err + (rng.random(shape) - 0.5) * (2.0 * ACCURACY_DEG)
    return err


def tcp_error_mm(Jp, ang_err_deg):
    """Norma error posisi TCP (mm) untuk tiap sampel."""
    dp = np.einsum("nij,nj->ni", Jp, ang_err_deg * DEG2RAD)  # meter
    return np.linalg.norm(dp, axis=1) * 1000.0


def joint_contributions_mm(Jp, backlash_deg, rng, include_accuracy):
    """RMS kontribusi error TCP (mm) tiap sendi (disolasi per kolom Jacobian)."""
    n = Jp.shape[0]
    ang = sample_angle_errors((n, 6), backlash_deg, rng, include_accuracy)
    out = []
    for j in range(6):
        dp = Jp[:, :, j] * (ang[:, j] * DEG2RAD)[:, None]  # (n,3)
        out.append(float(np.sqrt(np.mean(np.sum(dp ** 2, axis=1))) * 1000.0))
    return out


def sweep(Jp, backlash_values, seed):
    rng = np.random.default_rng(seed + 100)
    n = Jp.shape[0]
    rows = []
    for b in backlash_values:
        rep = tcp_error_mm(Jp, sample_angle_errors((n, 6), b, rng, False))
        tot = tcp_error_mm(Jp, sample_angle_errors((n, 6), b, rng, True))
        rows.append({
            "backlash_deg": b,
            "repeat_mean_mm": float(rep.mean()),
            "repeat_p95_mm": float(np.percentile(rep, 95)),
            "repeat_max_mm": float(rep.max()),
            "total_mean_mm": float(tot.mean()),
            "total_p95_mm": float(np.percentile(tot, 95)),
            "total_max_mm": float(tot.max()),
        })
    return rows


def report(rows, joints, default_b):
    print(f"Propagasi error posisi TCP (Monte Carlo, backlash default {default_b} deg)")
    print("-" * 70)
    print(f"{'backlash':>9} {'repeat mean':>12} {'repeat p95':>11} "
          f"{'total mean':>11} {'total p95':>10} {'total maks':>11}")
    for r in rows:
        print(f"{r['backlash_deg']:>7.2f}d {r['repeat_mean_mm']:>10.3f}mm "
              f"{r['repeat_p95_mm']:>9.3f}mm {r['total_mean_mm']:>9.3f}mm "
              f"{r['total_p95_mm']:>8.3f}mm {r['total_max_mm']:>9.3f}mm")
    print("\nKontribusi RMS error TCP per sendi (backlash default, termasuk akurasi):")
    for name, c in zip(A.JOINT_NAMES, joints):
        print(f"  {name}: {c:.3f} mm")
    dom = A.JOINT_NAMES[int(np.argmax(joints))]
    print(f"Sendi dominan: {dom}. Repeatability (tanpa akurasi absolut) jadi acuan "
          f"overlay dengan hasil ukur hardware.")
    if ACCURACY_UNKNOWN:
        print(f"CATATAN: akurasi absolut {', '.join(ACCURACY_UNKNOWN)} (jalur pot "
              f"servo + ADC1) BELUM diukur dan dihitung 0 -> kolom 'total' "
              f"mengecilkan error nyata di sendi tersebut.")


def plot(Jp, rows, joints, default_b, seed, out_path: Path):
    plt = A.get_plt()
    if plt is None:
        return
    rng = np.random.default_rng(seed + 200)
    n = Jp.shape[0]
    rep = tcp_error_mm(Jp, sample_angle_errors((n, 6), default_b, rng, False))
    tot = tcp_error_mm(Jp, sample_angle_errors((n, 6), default_b, rng, True))

    V.apply_rc(plt)
    fig, ax = plt.subplots(1, 3, figsize=(15.2, 5.4))

    # --- Panel 1: distribusi error ---------------------------------------
    rep_p95, tot_p95 = np.percentile(rep, 95), np.percentile(tot, 95)
    bins = np.linspace(0, max(tot.max(), rep.max()), 60)
    for data, color, label in ((rep, V.SERIES_BLUE, "repeatability (kuantisasi + backlash)"),
                               (tot, V.SERIES_ORANGE, "total (+akurasi absolut AS5600)")):
        ax[0].hist(data, bins=bins, color=color, alpha=0.22, linewidth=0)
        ax[0].hist(data, bins=bins, histtype="step", color=color,
                   linewidth=1.8, label=label)
    for val, color, tag in ((rep_p95, V.SERIES_BLUE, "repeat"),
                            (tot_p95, V.SERIES_ORANGE, "total")):
        ax[0].axvline(val, color=color, linestyle="--", linewidth=1.3, zorder=4)
        V.annotate_value(ax[0], val, ax[0].get_ylim()[1] * 0.94,
                         f"p95 {tag}\n{val:.2f} mm", color=color, dx=6, dy=0,
                         va="top", size=8)
    ax[0].set_title(f"Distribusi error posisi TCP (backlash {default_b:g} derajat)")
    ax[0].set_xlabel("error posisi TCP (mm)")
    ax[0].set_ylabel("jumlah sampel")
    ax[0].legend(loc="upper right", bbox_to_anchor=(1.0, 0.80))
    V.strip_frame(ax[0])

    # --- Panel 2: kontribusi per sendi, satu sendi disorot ---------------
    dom = A.JOINT_NAMES[int(np.argmax(joints))]
    ax[1].bar(A.JOINT_NAMES, joints, color=V.emphasise(A.JOINT_NAMES, dom),
              width=0.62)
    for name, val in zip(A.JOINT_NAMES, joints):
        V.annotate_value(ax[1], name, val, f"{val:.2f}",
                         color=V.INK if name == dom else V.INK_SECOND,
                         dx=0, dy=4, ha="center", size=8,
                         weight="bold" if name == dom else "normal", box=False)
    ax[1].set_title(f"Bahu {dom} menyumbang error TCP terbesar")
    ax[1].set_ylabel("kontribusi RMS ke error TCP (mm)")
    ax[1].set_ylim(0, max(joints) * 1.22)
    ax[1].set_xlabel("J5 dan J6 kecil karena lengan momennya pendek,\n"
                     "bukan karena sensornya lebih baik", fontsize=7.5,
                     color=V.MUTED)
    V.strip_frame(ax[1])

    # --- Panel 3: sensitivitas terhadap backlash -------------------------
    b = np.array([r["backlash_deg"] for r in rows])
    rp = np.array([r["repeat_p95_mm"] for r in rows])
    tp = np.array([r["total_p95_mm"] for r in rows])
    ax[2].plot(b, rp, marker="o", color=V.SERIES_BLUE, label="repeatability p95")
    ax[2].plot(b, tp, marker="s", color=V.SERIES_ORANGE, linestyle="--",
               label="total p95")
    ax[2].fill_between(b, rp, tp, color=V.SERIES_ORANGE, alpha=0.08, linewidth=0)

    ax[2].axvline(default_b, color=V.INK_SECOND, linewidth=1.0, alpha=0.55)
    i_def = int(np.argmin(np.abs(b - default_b)))
    ax[2].plot([b[i_def]], [rp[i_def]], marker="o", color=V.SERIES_BLUE,
               markersize=9, markeredgecolor=V.SURFACE, markeredgewidth=1.8,
               zorder=6)
    V.callout(ax[2], (b[i_def], rp[i_def]),
              f"asumsi kerja {default_b:g} derajat\nrepeatability p95 {rp[i_def]:.2f} mm",
              xytext=(16, -46), color=V.INK)
    ax[2].set_title("Backlash gearbox menentukan repeatability")
    ax[2].set_xlabel("backlash gearbox J1-J4 (derajat)")
    ax[2].set_ylabel("error posisi TCP persentil-95 (mm)")
    ax[2].set_ylim(0, max(tp) * 1.15)
    ax[2].legend(loc="upper left")
    V.strip_frame(ax[2])

    V.suptitle(
        fig,
        f"Prediksi error posisi TCP: repeatability p95 {rep_p95:.2f} mm sebelum lengan diukur",
        "Propagasi error sudut tiap sendi melalui Jacobian, Monte Carlo. Sumber error dibedakan "
        "menurut jalur umpan baliknya, bukan disamaratakan",
    )
    unknown = ", ".join(ACCURACY_UNKNOWN) if ACCURACY_UNKNOWN else "-"
    V.figure_caption(
        fig,
        "Sumber: benchmarks/error_model.py. J1-J4: kuantisasi AS5600 0,088 derajat, akurasi absolut "
        "plus minus 0,5 derajat, dan backlash gearbox. J5/J6: kuantisasi ADC saja, tanpa backlash karena "
        f"servo direct drive. Akurasi absolut {unknown} BELUM diukur dan dihitung nol, sehingga kurva "
        "total pada kedua sendi itu adalah batas bawah, bukan estimasi penuh.",
    )
    fig.subplots_adjust(top=0.845, bottom=0.16, wspace=0.24,
                        left=0.05, right=0.985)
    A.save_fig(fig, out_path, tight=False)


def main():
    p = argparse.ArgumentParser(
        description="Propagasi error sudut sendi (AS5600 + backlash gearbox di "
                    "J1-J4, kuantisasi ADC pot servo di J5/J6) ke error posisi "
                    "TCP lewat Jacobian, Monte Carlo.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--samples", type=int, default=5000, help="jumlah pose Monte Carlo")
    p.add_argument("--seed", type=int, default=4, help="seed RNG")
    p.add_argument("--backlash", type=float, nargs=2, default=list(C.CYCLOIDAL_BACKLASH_SWEEP_DEG),
                   metavar=("MIN", "MAX"), help="rentang sweep backlash (deg)")
    p.add_argument("--backlash-steps", type=int, default=8, help="jumlah titik sweep backlash")
    p.add_argument("--default-backlash", type=float, default=C.CYCLOIDAL_BACKLASH_DEG_DEFAULT,
                   help="backlash untuk histogram & kontribusi sendi (deg)")
    p.add_argument("--output-dir", type=str, default=str(A.DATA_DIR), help="folder output")
    p.add_argument("--no-plot", action="store_true", help="lewati pembuatan PNG")
    args = p.parse_args()

    out_dir = Path(args.output_dir)
    q, Jp = build_jacobians(args.samples, args.seed)

    b_values = list(np.linspace(args.backlash[0], args.backlash[1], args.backlash_steps))
    if args.default_backlash not in b_values:
        b_values = sorted(set(b_values + [args.default_backlash]))
    rows = sweep(Jp, b_values, args.seed)

    rng = np.random.default_rng(args.seed + 300)
    joints = joint_contributions_mm(Jp, args.default_backlash, rng, True)
    report(rows, joints, args.default_backlash)

    header = ["backlash_deg", "repeat_mean_mm", "repeat_p95_mm", "repeat_max_mm",
              "total_mean_mm", "total_p95_mm", "total_max_mm"]
    A.write_csv(out_dir / "error_model.csv", header,
                [[f"{r[k]:.5f}" for k in header] for r in rows])

    if not args.no_plot:
        plot(Jp, rows, joints, args.default_backlash, args.seed, out_dir / "error_model.png")


if __name__ == "__main__":
    main()
