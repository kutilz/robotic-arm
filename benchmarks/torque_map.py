"""Simulasi 2 - Peta torsi gravitasi J2 & J3 di seluruh workspace pitch.

Berbeda dengan `arm.torque` yang hanya menghitung satu pose horizontal
worst-case, skrip ini menyapu theta2 dan theta3 penuh (dalam joint limit) dan
menghitung torsi gravitasi J2 dan J3 di tiap pose dengan payload di flange.
Hasilnya ditimpa kontur kapasitas aktuator untuk melihat berapa persen
workspace yang benar-benar usable.

Temuan sizing yang disorot: kapasitas J2 (17HS6401S, 1:30 -> 7,88 N.m running)
hanya ~1,6x torsi statik worst-case (~4,8 N.m), masih di bawah target faktor
dinamis dokumen 2,5x. Artinya J2 sanggup menahan pose apa pun secara statik,
tapi cadangan untuk akselerasi/keamanan tipis di sekitar jangkauan penuh.
Angka faktor aktual dicetak ulang tiap run, jangan mengutip dari docstring ini.

Output:
  data/torque_map.csv  - theta2, theta3, tau_j2, tau_j3, usable statik/dinamis
  data/torque_map.png  - heatmap demand J2 & J3 + kontur kapasitas & target 2,5x

    python benchmarks/torque_map.py --help
    python benchmarks/torque_map.py --payload 0.2 --grid 141
"""

from __future__ import annotations

import argparse

import numpy as np

import armlib as A
import vizstyle as V
from arm import config as C


def compute_map(th2_deg: np.ndarray, th3_deg: np.ndarray, payload: float):
    """Grid torsi J2 & J3 (N.m) untuk semua kombinasi theta2 x theta3."""
    tau2 = np.zeros((th3_deg.size, th2_deg.size))
    tau3 = np.zeros_like(tau2)
    for iy, t3 in enumerate(th3_deg):
        for ix, t2 in enumerate(th2_deg):
            tau2[iy, ix], tau3[iy, ix] = A.gravity_torques(t2, t3, payload)
    return tau2, tau3


def usable_fraction(tau: np.ndarray, cap: float) -> float:
    """Persen sel grid dengan torsi <= kapasitas."""
    return 100.0 * float(np.mean(tau <= cap))


def report(tau2, tau3, cap, sf, payload):
    cap2, cap3 = cap["J2"], cap["J3"]
    dyn2, dyn3 = cap2 / sf, cap3 / sf
    print(f"Peta torsi workspace (payload {payload:.2f} kg, grid {tau2.size} pose)")
    print("-" * 62)
    print(f"{'Sendi':<6} {'Kapasitas':>10} {'Demand maks':>12} {'Margin min':>11} "
          f"{'Usable stat':>12} {'Usable 2.5x':>12}")
    for name, tau, capj in (("J2", tau2, cap2), ("J3", tau3, cap3)):
        dmax = float(tau.max())
        margin = capj / dmax if dmax else float("inf")
        us_stat = usable_fraction(tau, capj)
        us_dyn = usable_fraction(tau, capj / sf)
        print(f"{name:<6} {capj:>8.2f}N {dmax:>10.2f}N {margin:>9.2f}x "
              f"{us_stat:>10.1f}% {us_dyn:>10.1f}%")
    both_stat = 100.0 * float(np.mean((tau2 <= cap2) & (tau3 <= cap3)))
    both_dyn = 100.0 * float(np.mean((tau2 <= dyn2) & (tau3 <= dyn3)))
    print("-" * 62)
    print(f"Workspace usable statik (kedua sendi): {both_stat:.1f}%")
    print(f"Workspace usable target dinamis {sf:g}x (kedua sendi): {both_dyn:.1f}%")
    print(f"CATATAN: J2 pengikat. Demand statik maks {tau2.max():.2f} N.m < "
          f"kapasitas {cap2:.2f} N.m, tetapi faktor dinamis hanya "
          f"{cap2 / tau2.max():.2f}x (target dokumen {sf:g}x).")
    return both_dyn


def plot(th2, th3, tau2, tau3, cap, sf, payload, out_path):
    """Heatmap permintaan torsi + daerah yang gagal memenuhi target.

    Perubahan penting dari versi lama: ramp viridis diganti satu hue biru
    terang->gelap. Ramp pelangi memetakan besaran ke hue, sehingga urutan
    "makin berat" tidak lagi terbaca sendiri dan hilang saat naskah dicetak
    hitam-putih. Arsiran daerah gagal juga dibuat benar-benar terlihat (versi
    lama memakai alpha=0 sehingga arsirnya tidak pernah muncul).
    """
    plt = A.get_plt()
    if plt is None:
        return
    V.apply_rc(plt)
    cmap = V.sequential_cmap()

    fig, axes = plt.subplots(1, 2, figsize=(13.4, 5.9))
    for ax, name, tau in ((axes[0], "J2", tau2), (axes[1], "J3", tau3)):
        capj = cap[name]
        dynj = capj / sf
        im = ax.pcolormesh(th2, th3, tau, cmap=cmap, shading="auto", zorder=1)
        cb = fig.colorbar(im, ax=ax, pad=0.015, fraction=0.046)
        cb.set_label("torsi gravitasi diminta (N.m)", fontsize=8,
                     color=V.INK_SECOND)
        cb.ax.tick_params(labelsize=7, color=V.MUTED)
        cb.outline.set_visible(False)

        us_dyn = usable_fraction(tau, dynj)
        # Daerah yang tidak memenuhi target dinamis. Dipakai wash tipis PLUS
        # arsir: wash saja menutupi heatmap di bawahnya, arsir saja hilang
        # saat gambar diperkecil di naskah.
        has_fail = tau.max() > dynj
        if has_fail:
            ax.contourf(th2, th3, tau, levels=[dynj, tau.max() * 1.01],
                        colors=["none"], hatches=["///"], zorder=2)
            ax.contourf(th2, th3, tau, levels=[dynj, tau.max() * 1.01],
                        colors=[V.CRITICAL], alpha=0.16, zorder=2)
            ax.contour(th2, th3, tau, levels=[dynj], colors=[V.CRITICAL],
                       linewidths=2.2, zorder=3)
            ax.plot([], [], color=V.CRITICAL, linewidth=2.2,
                    label=f"batas target {sf:g}x = {dynj:.2f} N.m")
        if tau.max() >= capj:
            ax.contour(th2, th3, tau, levels=[capj], colors=[V.INK],
                       linewidths=2.0, linestyles="--", zorder=3)
            ax.plot([], [], color=V.INK, linewidth=2.0, linestyle="--",
                    label=f"batas kapasitas {capj:.2f} N.m")

        # sorot pose terberat: itu angka yang dikutip di naskah
        iy, ix = np.unravel_index(int(np.argmax(tau)), tau.shape)
        ax.plot([th2[ix]], [th3[iy]], marker="o", color=V.SURFACE,
                markersize=9, markeredgecolor=V.CRITICAL, markeredgewidth=2.2,
                zorder=6, label="pose paling berat")
        V.callout(ax, (th2[ix], th3[iy]),
                  f"pose terberat {tau.max():.2f} N.m\n"
                  f"faktor nyata {capj / tau.max():.2f}x",
                  xytext=(-160 if name == "J3" else 26, 44))

        note = " (area merah = gagal target)" if has_fail else " (seluruh pose lulus)"
        ax.set_title(f"{name}: kapasitas {capj:.2f} N.m, sanggup menahan seluruh pose secara statik\n"
                     f"memenuhi target {sf:g}x pada {us_dyn:.0f}% pose{note}")
        ax.set_xlabel("sudut bahu theta2 (derajat)")
        ax.set_ylabel("sudut siku theta3 (derajat)")
        ax.grid(False)
        ax.legend(loc="lower left", frameon=True, facecolor=V.SURFACE,
                  edgecolor="none", framealpha=0.88)

    both_dyn = 100.0 * float(np.mean((tau2 <= cap["J2"] / sf) & (tau3 <= cap["J3"] / sf)))
    V.suptitle(
        fig,
        f"Bahu J2 sanggup menahan seluruh pose, tetapi cadangan dinamisnya "
        f"{cap['J2'] / tau2.max():.2f}x (target {sf:g}x)",
        f"Payload {payload:.2f} kg di flange; {both_dyn:.0f}% kombinasi sudut bahu-siku "
        f"memenuhi target {sf:g}x pada kedua sendi sekaligus",
    )
    V.figure_caption(
        fig,
        "Sumber: benchmarks/torque_map.py. Torsi gravitasi dihitung dari model massa Tabel 3.3 pada tiap "
        "kombinasi sudut bahu dan siku. Kapasitas aktuator memakai holding torque datasheet pada arus rated; "
        "pada setelan arus firmware kapasitasnya lebih rendah (lihat current_derating.py).",
    )
    fig.subplots_adjust(top=0.845, bottom=0.145, wspace=0.26,
                        left=0.06, right=0.965)
    A.save_fig(fig, out_path, tight=False)


def main():
    p = argparse.ArgumentParser(
        description="Peta torsi gravitasi J2 & J3 di seluruh workspace pitch, "
                    "ditimpa kontur kapasitas aktuator.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--payload", type=float, default=0.2, help="massa payload di flange (kg)")
    p.add_argument("--grid", type=int, default=121, help="jumlah titik per sumbu sudut")
    p.add_argument("--safety", type=float, default=C.SAFETY_FACTOR,
                   help="target faktor dinamis (kapasitas/demand)")
    p.add_argument("--output-dir", type=str, default=str(A.DATA_DIR), help="folder output")
    p.add_argument("--no-plot", action="store_true", help="lewati pembuatan PNG")
    args = p.parse_args()

    from pathlib import Path
    out_dir = Path(args.output_dir)

    lim2 = C.JOINT_LIMITS_DEG["J2"]
    lim3 = C.JOINT_LIMITS_DEG["J3"]
    th2 = np.linspace(lim2[0], lim2[1], args.grid)
    th3 = np.linspace(lim3[0], lim3[1], args.grid)
    tau2, tau3 = compute_map(th2, th3, args.payload)
    cap = A.actuator_capacity_nm()

    report(tau2, tau3, cap, args.safety, args.payload)

    # CSV (subsample supaya file ringkas kalau grid besar, target ~60 titik/sumbu)
    step = max(1, args.grid // 60)
    rows = []
    dyn2, dyn3 = cap["J2"] / args.safety, cap["J3"] / args.safety
    for iy in range(0, args.grid, step):
        for ix in range(0, args.grid, step):
            t2v, t3v = tau2[iy, ix], tau3[iy, ix]
            rows.append([f"{th2[ix]:.2f}", f"{th3[iy]:.2f}", f"{t2v:.4f}", f"{t3v:.4f}",
                         int(t2v <= cap["J2"] and t3v <= cap["J3"]),
                         int(t2v <= dyn2 and t3v <= dyn3)])
    A.write_csv(out_dir / "torque_map.csv",
                ["theta2_deg", "theta3_deg", "tau_j2_nm", "tau_j3_nm",
                 "usable_static", "usable_dynamic"], rows)

    if not args.no_plot:
        plot(th2, th3, tau2, tau3, cap, args.safety, args.payload, out_dir / "torque_map.png")


if __name__ == "__main__":
    main()
