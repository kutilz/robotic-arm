"""Simulasi 1 - Peta workspace lengan via Monte Carlo.

Sampling sudut sendi acak uniform dalam joint limit -> point cloud posisi TCP.
Dari cloud dihitung: envelope (potongan bidang XZ dan proyeksi top-view XY),
estimasi volume reachable (voxel), reach maksimum terukur dari sumbu J2, dan
ukuran dead zone silinder di sekitar sumbu base akibat offset lateral bahu (a1).
Sekalian memverifikasi apakah reach 600 mm benar tercapai.

Output:
  data/workspace_sim.csv  - ringkasan metrik (volume, reach, dead zone, tinggi)
  data/workspace_sim.png  - potongan XZ + proyeksi XY dengan lingkaran envelope

    python benchmarks/workspace_sim.py --help
    python benchmarks/workspace_sim.py --samples 200000 --seed 1
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np

import armlib as A
import vizstyle as V
from arm import config as C


def voxel_volume(points_m: np.ndarray, cell_mm: float) -> float:
    """Estimasi volume reachable (m^3) via voxelisasi point cloud."""
    idx = np.floor(points_m * 1000.0 / cell_mm).astype(np.int64)
    occupied = np.unique(idx, axis=0).shape[0]
    return occupied * (cell_mm / 1000.0) ** 3


def analyze(samples: int, seed: int, cell_mm: float):
    rng = np.random.default_rng(seed)
    q = A.sample_joints(samples, rng)
    org = A.origins_batch(q)
    p_tcp = org[:, 6]          # posisi TCP (n,3)
    p_j2 = org[:, 1]           # posisi sumbu J2 (ikut berputar dengan J1)

    radial = np.hypot(p_tcp[:, 0], p_tcp[:, 1])         # jarak dari sumbu base (J1)
    reach_j2 = np.linalg.norm(p_tcp - p_j2, axis=1)      # jarak dari titik J2 (invarian J1)

    # Dead zone silinder. Dulu tabel DH memaksa d3=0 lalu dead zone-nya
    # ditambal manual dengan offset lateral ~60 mm. Sejak geometri di-rebase ke
    # CAD final, geseran lateral itu sudah masuk tabel DH sebagai d3 = -11.8 mm,
    # jadi radial.min() SUDAH mengandung efeknya - menambah hypot lagi berarti
    # menghitung ganda.
    dz_ideal = float(radial.min())
    dz_phys = dz_ideal

    metrics = {
        "samples": samples,
        "volume_m3": voxel_volume(p_tcp, cell_mm),
        "reach_max_from_j2_m": float(reach_j2.max()),
        "reach_max_from_base_m": float(radial.max()),
        "deadzone_ideal_m": dz_ideal,
        "deadzone_physical_m": dz_phys,
        "lateral_offset_m": C.LATERAL_Y_OFFSET,
        "z_min_m": float(p_tcp[:, 2].min()),
        "z_max_m": float(p_tcp[:, 2].max()),
        "target_reach_m": C.REACH_FROM_J2,
        "reach_600mm_tercapai": int(reach_j2.max() >= 0.600),
    }
    return q, p_tcp, p_j2, metrics


def report(metrics: dict):
    print(f"Workspace Monte Carlo ({metrics['samples']} sampel)")
    print("-" * 52)
    print(f"Volume reachable (voxel)   : {metrics['volume_m3']*1000:.1f} L "
          f"({metrics['volume_m3']:.4f} m^3)")
    print(f"Reach maks dari sumbu J2   : {metrics['reach_max_from_j2_m']*1000:.1f} mm "
          f"(target {metrics['target_reach_m']*1000:.0f} mm)")
    print(f"Reach maks dari sumbu base : {metrics['reach_max_from_base_m']*1000:.1f} mm")
    print(f"Dead zone silinder         : {metrics['deadzone_physical_m']*1000:.1f} mm radius "
          f"(offset lateral d3 {metrics['lateral_offset_m']*1000:.1f} mm sudah "
          f"masuk tabel DH)")
    print(f"Rentang tinggi TCP (z)     : {metrics['z_min_m']*1000:.1f} .. "
          f"{metrics['z_max_m']*1000:.1f} mm")
    ok = "YA" if metrics["reach_600mm_tercapai"] else "TIDAK"
    print(f"Reach 600 mm tercapai      : {ok}")


def plot(p_tcp, p_j2, metrics, out_path: Path, slice_mm: float, seed: int):
    """Dua panel: potongan meridian (rho, z) dan proyeksi top-view.

    Versi lama memotong pita tipis |y| < 15 mm sehingga hanya ~1% sampel yang
    terpakai dan awan titiknya nyaris tak terbaca. Karena J1 hanya memutar
    seluruh lengan terhadap sumbu vertikal base, ruang kerja adalah benda
    putar: memetakan tiap sampel ke (rho, z) dengan rho = jarak ke sumbu base
    memakai SELURUH sampel dan menghasilkan penampang yang padat dan jujur.
    Kerapatan digambar sebagai heatmap satu hue (besaran), bukan awan titik
    transparan.
    """
    plt = A.get_plt()
    if plt is None:
        return
    V.apply_rc(plt)
    cmap = V.sequential_cmap()

    rho = np.hypot(p_tcp[:, 0], p_tcp[:, 1]) * 1000.0
    z = p_tcp[:, 2] * 1000.0
    x = p_tcp[:, 0] * 1000.0
    y = p_tcp[:, 1] * 1000.0

    R = metrics["reach_max_from_j2_m"] * 1000
    rmax = metrics["reach_max_from_base_m"] * 1000
    rdead = metrics["deadzone_physical_m"] * 1000
    zmin, zmax = metrics["z_min_m"] * 1000, metrics["z_max_m"] * 1000

    fig, (axz, axy) = plt.subplots(1, 2, figsize=(13.6, 6.2))

    # --- Panel 1: penampang meridian (rho, z), seluruh sampel -------------
    hb = axz.hexbin(rho, z, gridsize=74, cmap=cmap, mincnt=1, linewidths=0,
                    bins="log")
    cb = fig.colorbar(hb, ax=axz, pad=0.015, fraction=0.045)
    cb.set_label("kerapatan sampel (skala log)", fontsize=8, color=V.INK_SECOND)
    cb.ax.tick_params(labelsize=7, color=V.MUTED)
    cb.outline.set_visible(False)

    axz.axhline(0, color=V.MUTED, linewidth=1.0, zorder=4)

    # batas jangkauan: busur berjari-jari reach maks, berpusat di sumbu J2
    th = np.linspace(-np.pi / 2, np.pi / 2, 200)
    axz.plot(C.A1_SHOULDER_OFFSET * 1000 + R * np.cos(th),
             C.D1_BASE * 1000 + R * np.sin(th), linestyle="--",
             color=V.CRITICAL, linewidth=1.6, zorder=5,
             label=f"batas jangkauan {R:.0f} mm dari J2")
    axz.plot([C.A1_SHOULDER_OFFSET * 1000], [C.D1_BASE * 1000], marker="o",
             color=V.CRITICAL, markersize=7, markeredgecolor=V.SURFACE,
             markeredgewidth=1.5, zorder=6, label="sumbu bahu J2")

    V.annotate_value(axz, C.A1_SHOULDER_OFFSET * 1000 + R, C.D1_BASE * 1000,
                     f"{R:.0f} mm", color=V.CRITICAL, dx=-6, dy=10, ha="right")
    V.callout(axz, (rho[np.argmax(z)], zmax),
              f"titik tertinggi {zmax:.0f} mm", xytext=(30, -10), color=V.INK)
    V.callout(axz, (rho[np.argmin(z)], zmin),
              f"titik terendah {zmin:.0f} mm", xytext=(38, 10), color=V.INK)

    axz.set_title("Penampang ruang kerja (semua sampel)")
    axz.set_xlabel("jarak radial dari sumbu base J1 (mm)")
    axz.set_ylabel("tinggi Z dari bidang meja (mm)")
    axz.set_aspect("equal", "box")
    axz.legend(loc="upper right", bbox_to_anchor=(1.0, 0.90), frameon=True,
               facecolor=V.SURFACE, edgecolor="none", framealpha=0.88)
    V.strip_frame(axz)

    # --- Panel 2: proyeksi top-view --------------------------------------
    hb2 = axy.hexbin(x, y, gridsize=64, cmap=cmap, mincnt=1, linewidths=0,
                     bins="log")
    cb2 = fig.colorbar(hb2, ax=axy, pad=0.015, fraction=0.045)
    cb2.set_label("kerapatan sampel (skala log)", fontsize=8, color=V.INK_SECOND)
    cb2.ax.tick_params(labelsize=7, color=V.MUTED)
    cb2.outline.set_visible(False)

    circ = np.linspace(0, 2 * np.pi, 240)
    axy.plot(rmax * np.cos(circ), rmax * np.sin(circ), linestyle="--",
             color=V.CRITICAL, linewidth=1.5, zorder=5,
             label=f"radial maks {rmax:.0f} mm")
    axy.plot(rdead * np.cos(circ), rdead * np.sin(circ), color=V.SERIES_ORANGE,
             linewidth=2.0, zorder=6, label=f"dead zone r = {rdead:.0f} mm")
    axy.plot([0], [0], marker="+", color=V.INK, markersize=9,
             markeredgewidth=1.6, zorder=6, label="sumbu base J1")

    V.callout(axy, (0, rdead),
              f"dead zone silinder r = {rdead:.0f} mm\n"
              f"akibat offset lateral {metrics['lateral_offset_m']*1000:.0f} mm",
              xytext=(-96, 96), color=V.SERIES_ORANGE)

    axy.set_title("Tampak atas: jangkauan 360 derajat")
    axy.set_xlabel("X (mm)")
    axy.set_ylabel("Y (mm)")
    axy.set_aspect("equal", "box")
    axy.legend(loc="lower left", frameon=True, facecolor=V.SURFACE,
               edgecolor="none", framealpha=0.88)
    V.strip_frame(axy)

    ok = "tercapai" if metrics["reach_600mm_tercapai"] else "TIDAK tercapai"
    V.suptitle(
        fig,
        f"Ruang kerja terverifikasi: jangkauan {R:.0f} mm, target 600 mm {ok}",
        f"{metrics['samples']:,} pose acak dalam batas sudut sendi; volume reachable "
        f"{metrics['volume_m3']*1000:.0f} L".replace(",", "."),
    )
    V.figure_caption(
        fig,
        "Sumber: benchmarks/workspace_sim.py. Volume diestimasi dengan voxelisasi awan titik TCP. "
        "Dead zone dihitung dari jari-jari radial terkecil digabung offset lateral bidang penggerak lengan. "
        "Kerapatan sampel mencerminkan sampling uniform di ruang sendi, bukan preferensi pose.",
    )
    fig.subplots_adjust(top=0.865, bottom=0.135, wspace=0.34,
                        left=0.06, right=0.965)
    A.save_fig(fig, out_path, tight=False)


def main():
    p = argparse.ArgumentParser(
        description="Peta workspace via Monte Carlo sampling sudut sendi.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--samples", type=int, default=100000, help="jumlah sampel Monte Carlo")
    p.add_argument("--seed", type=int, default=0, help="seed RNG (reproducible)")
    p.add_argument("--cell-mm", type=float, default=20.0, help="ukuran voxel untuk volume (mm)")
    p.add_argument("--slice-mm", type=float, default=15.0, help="tebal slice untuk potongan XZ (mm)")
    p.add_argument("--output-dir", type=str, default=str(A.DATA_DIR), help="folder output")
    p.add_argument("--no-plot", action="store_true", help="lewati pembuatan PNG")
    args = p.parse_args()

    out_dir = Path(args.output_dir)
    q, p_tcp, p_j2, metrics = analyze(args.samples, args.seed, args.cell_mm)
    report(metrics)

    A.write_csv(out_dir / "workspace_sim.csv", ["metrik", "nilai"],
                [[k, v] for k, v in metrics.items()])

    if not args.no_plot:
        plot(p_tcp, p_j2, metrics, out_dir / "workspace_sim.png", args.slice_mm, args.seed)


if __name__ == "__main__":
    main()
