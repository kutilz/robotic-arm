"""Simulasi 5 - Derating torsi stepper terhadap setelan arus driver TMC2209.

LATAR MASALAH. Tabel sizing (`src/arm/torque.py`) memakai holding torque
datasheet: 0,45 N.m untuk 17HS2401 dan 0,70 N.m untuk 17HS6401S. Angka
datasheet itu berlaku PADA ARUS RATED (1,7 A dan 2,0 A per fasa). Firmware
justru menyetel driver di bawah rated karena batas termal:

    TMC_MA_DEFAULT[] = {1000, 1200, 1000, 1000}  mA RMS   (J1..J4)

Torsi stepper kira-kira sebanding dengan arus fasa selama inti belum jenuh,
jadi seluruh kolom "Keluaran" pada tabel sizing OPTIMIS selama driver tidak
dijalankan pada arus rated. Skrip ini menghitung besar optimismenya dan
menentukan arus minimum yang masih memenuhi kebutuhan torsi tiap sendi.

DUA TAFSIR "ARUS RATED", DIHITUNG KEDUANYA. Datasheet stepper bipolar
umumnya menyebut arus per fasa sebagai nilai PUNCAK, sedangkan pustaka
TMCStepper menyetel nilai RMS, sehingga:

    Model A (acuan) : I_puncak = I_RMS * sqrt(2), skala = I_puncak / I_rated
    Model B (batas bawah) : skala = I_RMS / I_rated   (tanpa faktor sqrt(2))

Model A adalah tafsir standar dan dipakai sebagai kurva acuan. Model B
disertakan sebagai batas bawah pesimistis; selisih keduanya adalah rentang
ketidakpastian yang HANYA dapat diselesaikan oleh pengukuran torsi di
hardware. Justru itu yang membuat uji torsi Bab IV punya daya pisah: hasil
ukur akan menunjukkan model mana yang berlaku.

Skrip ini murni model, tidak membaca hardware. Servo J5/J6 tidak ikut karena
tidak digerakkan driver stepper.

Output:
  data/current_derating.csv  - skala torsi & margin per sendi vs arus RMS
  data/current_derating.png  - margin vs arus + perbandingan tiga skenario arus

    python benchmarks/current_derating.py --help
    python benchmarks/current_derating.py --max-ma 1600
"""

from __future__ import annotations

import argparse
import math
from pathlib import Path

import numpy as np

import armlib as A
import vizstyle as V
from arm import config as C
from arm import torque as T

# Setelan arus bawaan firmware (mA RMS), urut J1..J4. Disalin dari
# firmware/arm_controller_esp32/arm_controller_esp32.ino: TMC_MA_DEFAULT[].
# Kalau firmware berubah, perbarui di sini juga.
FIRMWARE_MA = {"J1": 1000, "J2": 1200, "J3": 1000, "J4": 1000}

# Plafon termal driver: di atas nilai ini TMC2209 butuh heatsink besar dan
# pendinginan aktif (peringatan ada di komentar firmware).
THERMAL_CEILING_MA = 1700

SQRT2 = math.sqrt(2.0)

STEPPER_JOINTS = [j for j in C.JOINTS if not C.MOTORS[j.motor_key].is_servo]


def torque_scale(rms_ma: float, rated_a: float, model: str) -> float:
    """Skala torsi terhadap holding datasheet pada setelan arus tertentu.

    Linear terhadap arus fasa (asumsi inti belum jenuh), dipotong di 1.0
    karena menaikkan arus melewati rated tidak menambah torsi sebanding.
    """
    rated_ma = rated_a * 1000.0
    peak_ma = rms_ma * SQRT2 if model == "A" else rms_ma
    return min(peak_ma / rated_ma, 1.0)


def delivered_at(joint: C.JointSpec, rms_ma: float, model: str) -> float:
    """Torsi keluaran sendi (N.m) pada setelan arus tertentu."""
    motor = C.MOTORS[joint.motor_key]
    scale = torque_scale(rms_ma, motor.rated_current_a, model)
    return (motor.holding_torque_nm * scale * C.RUNNING_TORQUE_FRACTION
            * joint.ratio * joint.transmission_efficiency)


def min_current_for(joint: C.JointSpec, required_nm: float, model: str,
                    hi_ma: float = 4000.0) -> float:
    """Arus RMS minimum (mA) agar torsi keluaran mencapai required_nm.

    NaN bila kebutuhan tidak tercapai bahkan pada arus rated penuh.
    """
    if delivered_at(joint, hi_ma, model) < required_nm:
        return float("nan")
    lo, hi = 0.0, hi_ma
    for _ in range(80):
        mid = 0.5 * (lo + hi)
        if delivered_at(joint, mid, model) < required_nm:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def build_rows(currents_ma: np.ndarray):
    """Baris CSV: satu baris per (sendi, arus) untuk kedua model."""
    reports = {r.name: r for r in T.build_report()}
    rows = []
    for j in STEPPER_JOINTS:
        req = reports[j.name].required_nm
        for ma in currents_ma:
            for model in ("A", "B"):
                d = delivered_at(j, ma, model)
                rows.append([
                    j.name, model, f"{ma:.0f}",
                    f"{torque_scale(ma, C.MOTORS[j.motor_key].rated_current_a, model):.4f}",
                    f"{d:.4f}", f"{req:.4f}", f"{d / req:.4f}",
                ])
    return rows


def report(currents_ma):
    reports = {r.name: r for r in T.build_report()}
    print("Derating torsi terhadap setelan arus driver TMC2209")
    print("=" * 78)
    print(f"{'Sendi':<5} {'Motor':<11} {'Rated':>6} {'Setelan':>8} "
          f"{'Skala A':>8} {'Keluaran A':>11} {'Margin A':>9} {'Margin B':>9}")
    print("-" * 78)
    summary = {}
    for j in STEPPER_JOINTS:
        motor = C.MOTORS[j.motor_key]
        ma = FIRMWARE_MA[j.name]
        req = reports[j.name].required_nm
        dA, dB = delivered_at(j, ma, "A"), delivered_at(j, ma, "B")
        sA = torque_scale(ma, motor.rated_current_a, "A")
        print(f"{j.name:<5} {j.motor_key:<11} {motor.rated_current_a:>5.1f}A "
              f"{ma:>6.0f}mA {sA:>7.1%} {dA:>9.2f}N.m {dA/req:>8.2f}x "
              f"{dB/req:>8.2f}x")
        summary[j.name] = {
            "ma": ma, "req": req, "full": reports[j.name].delivered_nm,
            "dA": dA, "dB": dB, "scaleA": sA,
            "minA": min_current_for(j, req, "A"),
            "minB": min_current_for(j, req, "B"),
        }
    print("-" * 78)
    print("Kolom 'Keluaran A' memakai tafsir standar I_puncak = I_RMS * sqrt(2).")
    print("Margin B adalah batas bawah pesimistis (tanpa faktor sqrt(2)).\n")

    print("Arus RMS minimum agar tiap sendi memenuhi kebutuhan torsinya:")
    for name, s in summary.items():
        def fmt(v):
            if math.isnan(v):
                return "tidak tercapai pada arus rated"
            flag = "" if v <= THERMAL_CEILING_MA else "  (DI ATAS PLAFON TERMAL)"
            return f"{v:.0f} mA{flag}"
        print(f"  {name}: model A {fmt(s['minA'])} | model B {fmt(s['minB'])}")

    worst = min(summary.items(), key=lambda kv: kv[1]["dA"] / kv[1]["req"])
    print(f"\nSendi pengikat: {worst[0]} (margin model A "
          f"{worst[1]['dA']/worst[1]['req']:.2f}x pada setelan sekarang).")
    opt = 100.0 * (1.0 - summary["J2"]["dA"] / summary["J2"]["full"])
    print(f"Tabel sizing yang mengasumsikan arus rated penuh melebihkan torsi "
          f"J2 sekitar {opt:.0f}% pada model A "
          f"({100.0*(1.0-summary['J2']['dB']/summary['J2']['full']):.0f}% pada model B).")
    print("CATATAN: seluruh angka di atas adalah model. Pengukuran torsi "
          "(Tabel 4.4) yang menentukan model mana yang berlaku.")
    return summary


def plot(currents_ma, summary, out_path: Path):
    plt = A.get_plt()
    if plt is None:
        return
    V.apply_rc(plt)
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(13.0, 5.6),
                                   gridspec_kw={"width_ratios": [1.15, 1.0]})

    # --- Panel 1: margin vs arus (satu sumbu, tak berdimensi) ------------
    for i, j in enumerate(STEPPER_JOINTS):
        s = summary[j.name]
        mA = np.array([delivered_at(j, m, "A") / s["req"] for m in currents_ma])
        mB = np.array([delivered_at(j, m, "B") / s["req"] for m in currents_ma])
        color = V.SERIES[i]
        ax1.fill_between(currents_ma, mB, mA, color=color, alpha=0.13, linewidth=0)
        ax1.plot(currents_ma, mA, color=color, linestyle=V.LINESTYLES[i],
                 linewidth=2.0, zorder=3, label=f"{j.name} ({j.motor_key})")
        # titik kerja setelan firmware
        ax1.plot([s["ma"]], [s["dA"] / s["req"]], marker=V.MARKERS[i],
                 color=color, markersize=8, markeredgecolor=V.SURFACE,
                 markeredgewidth=1.6, zorder=5)
        V.annotate_value(ax1, s["ma"], s["dA"] / s["req"],
                         f"{j.name} {s['dA']/s['req']:.2f}x", color=color,
                         dy=8 if j.name != "J2" else -18,
                         va="bottom" if j.name != "J2" else "top", size=8)

    V.threshold_line(ax1, 1.0, "batas kritis 1,0x", color=V.CRITICAL)
    V.threshold_line(ax1, C.SAFETY_FACTOR, f"target {C.SAFETY_FACTOR:g}x",
                     color=V.MUTED, ls=":")
    ax1.set_ylim(0, 4.0)
    ax1.axvline(THERMAL_CEILING_MA, color=V.WARNING, linestyle="--", linewidth=1.2)
    ax1.text(THERMAL_CEILING_MA - 25, 3.42, "plafon termal\n1700 mA",
             color="#a06f00", fontsize=8, fontweight="bold", va="top", ha="right",
             bbox=dict(boxstyle="round,pad=0.24", facecolor=V.SURFACE,
                       edgecolor="none", alpha=0.9))
    ax1.set_title("Margin torsi terhadap setelan arus driver")
    ax1.set_xlabel("setelan arus TMC2209 (mA RMS per fasa)")
    ax1.set_ylabel("margin = torsi keluaran / kebutuhan")
    ax1.legend(loc="upper left", ncol=2)
    V.strip_frame(ax1)
    ax1.text(0.015, 0.015,
             "pita = rentang antara tafsir arus rated (puncak vs RMS)",
             transform=ax1.transAxes, fontsize=7.5, color=V.MUTED, va="bottom")

    # --- Panel 2: torsi keluaran pada tiga skenario arus -----------------
    names = [j.name for j in STEPPER_JOINTS]
    x = np.arange(len(names))
    w = 0.26
    full = [summary[n]["full"] for n in names]
    dA = [summary[n]["dA"] for n in names]
    dB = [summary[n]["dB"] for n in names]
    req = [summary[n]["req"] for n in names]

    ax2.bar(x - w, full, w * 0.92, color=V.MUTED, alpha=0.45,
            label="asumsi arus rated penuh (Tabel 3.4)")
    ax2.bar(x, dA, w * 0.92, color=V.SERIES_BLUE,
            label="setelan firmware, model A")
    ax2.bar(x + w, dB, w * 0.92, color=V.SERIES_ORANGE,
            label="setelan firmware, model B (batas bawah)")

    for k, n in enumerate(names):
        # ambang kebutuhan per sendi digambar sebagai garis pendek, bukan bar
        ax2.plot([x[k] - 1.55 * w, x[k] + 1.55 * w], [req[k], req[k]],
                 color=V.CRITICAL, linewidth=1.8, zorder=5)
        gap = 100.0 * (1.0 - dA[k] / full[k])
        V.annotate_value(ax2, x[k], dA[k], f"-{gap:.0f}%", color=V.INK,
                         dx=0, dy=5, ha="center", size=8)
    ax2.plot([], [], color=V.CRITICAL, linewidth=1.8, label="kebutuhan torsi sendi")

    ax2.set_xticks(x)
    ax2.set_xticklabels([f"{n}\n{summary[n]['ma']} mA" for n in names])
    ax2.set_title("Torsi keluaran: asumsi datasheet vs setelan nyata")
    ax2.set_ylabel("torsi keluaran sendi (N.m)")
    ax2.set_ylim(0, max(req) * 1.42)
    ax2.legend(loc="upper right", fontsize=7.5)
    V.strip_frame(ax2)

    j2 = summary["J2"]
    V.callout(ax2, (x[1] + w, j2["dB"]),
              f"J2 pengikat: {j2['dA']:.2f} N.m (model A)\n"
              f"vs kebutuhan {j2['req']:.2f} N.m",
              xytext=(6, 62))

    V.suptitle(
        fig,
        "Torsi yang tersedia bergantung setelan arus driver, bukan hanya datasheet motor",
        "Holding torque datasheet berlaku pada arus rated (1,7 A dan 2,0 A); firmware menyetel "
        "1000-1200 mA RMS karena batas termal",
    )
    V.figure_caption(
        fig,
        "Sumber: benchmarks/current_derating.py. Model linear torsi terhadap arus fasa, dipotong di arus rated. "
        "Model A: I_puncak = I_RMS x akar 2 (tafsir standar). Model B: skala langsung terhadap I_RMS (batas bawah). "
        "Seluruh nilai adalah prediksi model; pengukuran torsi Bab IV yang menentukan model mana yang berlaku.",
    )
    fig.subplots_adjust(top=0.86, bottom=0.14)
    A.save_fig(fig, out_path, tight=False)


def main():
    p = argparse.ArgumentParser(
        description="Derating torsi stepper terhadap setelan arus driver TMC2209.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--min-ma", type=float, default=400.0, help="arus RMS terkecil (mA)")
    p.add_argument("--max-ma", type=float, default=1800.0, help="arus RMS terbesar (mA)")
    p.add_argument("--steps", type=int, default=141, help="jumlah titik sweep arus")
    p.add_argument("--output-dir", type=str, default=str(A.DATA_DIR), help="folder output")
    p.add_argument("--no-plot", action="store_true", help="lewati pembuatan PNG")
    args = p.parse_args()

    out_dir = Path(args.output_dir)
    currents = np.linspace(args.min_ma, args.max_ma, args.steps)
    summary = report(currents)

    csv_currents = np.unique(np.concatenate([
        np.arange(400, args.max_ma + 1, 100.0),
        np.array([FIRMWARE_MA[j.name] for j in STEPPER_JOINTS], dtype=float),
    ]))
    A.write_csv(out_dir / "current_derating.csv",
                ["joint", "model", "rms_ma", "torque_scale", "delivered_nm",
                 "required_nm", "margin"],
                build_rows(csv_currents))

    if not args.no_plot:
        plot(currents, summary, out_dir / "current_derating.png")


if __name__ == "__main__":
    main()
