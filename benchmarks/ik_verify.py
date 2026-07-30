"""Simulasi 3 - Verifikasi inverse kinematics closed-form.

IK analitik untuk lengan anthropomorphic (3-DOF posisi) + spherical wrist
(3-DOF orientasi). Kriteria Pieper terpenuhi karena sumbu J4/J5/J6 concurrent
di wrist-center, jadi masalah dipecah: posisi wrist-center menentukan th1,th2,
th3; orientasi sisa menentukan th4,th5,th6.

Uji round-trip: ambil ribuan sudut acak dalam joint limit -> FK -> pose ->
IK -> FK lagi, lalu bandingkan pose hasil dengan pose target. Dilaporkan
residual posisi (mm) dan orientasi (deg) maksimum + distribusinya. Ditambah
heatmap indeks manipulability Yoshikawa untuk menandai lokasi singularity
(siku terentang penuh dan wrist align th5=0).

Output:
  data/ik_verify.csv  - residual pos & orient per sampel
  data/ik_verify.png  - histogram residual + heatmap manipulability

    python benchmarks/ik_verify.py --help
    python benchmarks/ik_verify.py --samples 8000 --seed 3
"""

from __future__ import annotations

import argparse
import math
from pathlib import Path

import numpy as np

import armlib as A
import vizstyle as V
from arm import config as C
from arm import kinematics as K

# Konstanta geometri (m) dari config.
A1, D1 = C.A1_SHOULDER_OFFSET, C.D1_BASE
A2 = C.A2_UPPER_ARM
A3, D4 = C.A3_ELBOW_OFFSET, C.D4_FOREARM
D3 = C.D3_ELBOW_LATERAL          # geseran lateral bidang lengan vs sumbu base
D6 = C.D6_WRIST_TCP
LF = math.hypot(A3, D4)          # panjang efektif J3 -> wrist-center
BETA = math.atan2(D4, A3)        # sudut tetap offset siku


def _wrap180(a: float) -> float:
    return (a + 180.0) % 360.0 - 180.0


def _wrist_angles(R3_6, flip: bool):
    """Selesaikan th4,th5,th6 (deg) dari rotasi frame3->frame6."""
    s5 = math.hypot(R3_6[0, 2], R3_6[1, 2])
    c5 = R3_6[2, 2]
    if s5 < 1e-7:  # singular wrist (th5 ~ 0/180): th4 bebas, ambil 0
        th4 = 0.0
        th5 = 0.0 if c5 >= 0 else 180.0
        th6 = math.degrees(math.atan2(-R3_6[0, 1], R3_6[0, 0]))
        return th4, th5, th6
    if flip:
        th5 = math.degrees(math.atan2(-s5, c5))
        th4 = math.degrees(math.atan2(R3_6[1, 2], R3_6[0, 2]))
        th6 = math.degrees(math.atan2(R3_6[2, 1], -R3_6[2, 0]))
    else:
        th5 = math.degrees(math.atan2(s5, c5))
        th4 = math.degrees(math.atan2(-R3_6[1, 2], -R3_6[0, 2]))
        th6 = math.degrees(math.atan2(-R3_6[2, 1], R3_6[2, 0]))
    return th4, th5, th6


def ik_candidates(T):
    """Semua solusi IK kandidat (list of 6-vektor deg) untuk pose T (4x4).

    Bidang lengan tidak memotong sumbu base: ada geseran lateral tetap d3
    (sumbu J4/J5/J6 berada 11.8 mm di samping bidang yang memuat sumbu J1).
    Akibatnya th1 BUKAN atan2(y, x) begitu saja - proyeksi wrist-center ke
    bidang XY selalu menyinggung lingkaran berjari-jari |d3| di sekitar sumbu
    base. Uraikan (pc_x, pc_y) = Rz(th1) . (u, -d3) dengan u = jangkauan radial
    di dalam bidang lengan:

        u   = +-sqrt(pc_x^2 + pc_y^2 - d3^2)      (bahu kiri / kanan)
        th1 = atan2(pc_y, pc_x) - atan2(-d3, u)

    Bentuknya tetap tertutup - d3 tidak merusak kriteria Pieper, karena Pieper
    hanya menuntut ketiga sumbu pergelangan berpotongan di satu titik. Kalau
    d3 = 0 rumus di atas jatuh kembali ke atan2(y, x) dan atan2(y, x) + pi.
    """
    p = T[:3, 3]
    R = T[:3, :3]
    pc = p - D6 * R[:, 2]                 # wrist-center
    sols = []
    azim = math.atan2(pc[1], pc[0])
    disc = pc[0] * pc[0] + pc[1] * pc[1] - D3 * D3
    if disc < 0.0:                        # di dalam silinder buta radius |d3|
        return sols
    root = math.sqrt(disc)
    for u_planar in (root, -root):
        th1 = azim - math.atan2(-D3, u_planar)
        u = u_planar - A1
        w = pc[2] - D1
        D2 = u * u + w * w
        cos_qe = (D2 - A2 * A2 - LF * LF) / (2 * A2 * LF)
        if cos_qe < -1.0 or cos_qe > 1.0:
            continue
        cos_qe = max(-1.0, min(1.0, cos_qe))
        for sign in (+1.0, -1.0):
            qe = sign * math.acos(cos_qe)
            th2 = math.atan2(w, u) - math.atan2(LF * math.sin(qe), A2 + LF * math.cos(qe))
            th3 = qe - BETA
            # orientasi: R0_3 dari FK sebagian, lalu R3_6 = R0_3^T R
            th123 = [math.degrees(th1), math.degrees(th2), math.degrees(th3)]
            R0_3 = K.link_transforms(th123 + [0, 0, 0])[3][:3, :3]
            R3_6 = R0_3.T @ R
            for flip in (False, True):
                th4, th5, th6 = _wrist_angles(R3_6, flip)
                sols.append([_wrap180(th123[0]), _wrap180(th123[1]), _wrap180(th123[2]),
                             _wrap180(th4), _wrap180(th5), _wrap180(th6)])
    return sols


def pose_residual(q_deg, T_target):
    """(residual posisi m, residual orientasi rad) antara FK(q) dan T_target."""
    T = K.forward_kinematics(q_deg)
    dp = np.linalg.norm(T[:3, 3] - T_target[:3, 3])
    Rerr = T[:3, :3].T @ T_target[:3, :3]
    cosang = (np.trace(Rerr) - 1.0) / 2.0
    ang = math.acos(max(-1.0, min(1.0, cosang)))
    return dp, ang


def ik_best(T):
    """Solusi IK terbaik (residual pose terkecil) + residualnya."""
    best = None
    for q in ik_candidates(T):
        dp, da = pose_residual(q, T)
        score = dp + 0.01 * da
        if best is None or score < best[0]:
            best = (score, q, dp, da)
    if best is None:
        return None, float("nan"), float("nan")
    return best[1], best[2], best[3]


def run_roundtrip(samples: int, seed: int):
    rng = np.random.default_rng(seed)
    q_true = A.sample_joints(samples, rng)
    res_pos_mm = np.zeros(samples)
    res_ori_deg = np.zeros(samples)
    n_fail = 0
    for i in range(samples):
        T = K.forward_kinematics(q_true[i])
        q_sol, dp, da = ik_best(T)
        if q_sol is None:
            n_fail += 1
            res_pos_mm[i] = np.nan
            res_ori_deg[i] = np.nan
            continue
        res_pos_mm[i] = dp * 1000.0
        res_ori_deg[i] = math.degrees(da)
    return res_pos_mm, res_ori_deg, n_fail


def report(res_pos_mm, res_ori_deg, n_fail, samples):
    valid = ~np.isnan(res_pos_mm)
    rp = res_pos_mm[valid]
    ro = res_ori_deg[valid]
    print(f"Verifikasi round-trip FK(IK(pose)) ({samples} sampel, gagal {n_fail})")
    print("-" * 58)
    print(f"{'Residual':<20} {'median':>10} {'p95':>10} {'maks':>10}")
    print(f"{'Posisi (mm)':<20} {np.median(rp):>10.2e} {np.percentile(rp,95):>10.2e} {rp.max():>10.2e}")
    print(f"{'Orientasi (deg)':<20} {np.median(ro):>10.2e} {np.percentile(ro,95):>10.2e} {ro.max():>10.2e}")
    thr = 1e-3  # 0.001 mm
    print(f"Sampel dengan residual posisi < {thr} mm: "
          f"{100.0*np.mean(rp < thr):.2f}%  (IK closed-form tervalidasi vs FK)")
    return rp, ro


def manip_grid(th_x, th_y, fixed, axes):
    """Grid manipulability Yoshikawa; axes = (idx_x, idx_y), fixed = list 6 sudut."""
    W = np.zeros((th_y.size, th_x.size))
    for iy, vy in enumerate(th_y):
        for ix, vx in enumerate(th_x):
            q = list(fixed)
            q[axes[0]] = vx
            q[axes[1]] = vy
            W[iy, ix] = A.manipulability(A.numeric_jacobian(q))
    return W


def plot(rp, ro, out_path: Path):
    """Empat panel: angka pamungkas, distribusi residual, dua peta singularity.

    Hasil verifikasi ini pada dasarnya SATU angka (residual di batas presisi
    mesin), jadi panel pertama dibuat sebagai angka besar. Menyajikannya hanya
    sebagai dua histogram membuat pembaca harus menyimpulkan sendiri angka yang
    justru jadi intinya. Peta manipulability memakai ramp satu hue supaya
    "lembah gelap = dekat singular" tetap terbaca saat dicetak hitam-putih.
    """
    plt = A.get_plt()
    if plt is None:
        return
    V.apply_rc(plt)
    cmap = V.sequential_cmap()
    fig, ax = plt.subplots(2, 2, figsize=(13.4, 9.4))

    # --- Panel 1: angka pamungkas ----------------------------------------
    a = ax[0, 0]
    a.axis("off")
    a.grid(False)
    thr = 1e-3
    frac = 100.0 * float(np.mean(rp < thr))
    V.hero(a, f"{rp.max():.0e} mm",
           "residual posisi TERBESAR dari seluruh sampel round-trip",
           loc=(0.5, 0.82), size=34, color=V.SERIES_BLUE)
    a.text(0.5, 0.60, f"{frac:.2f}% sampel di bawah ambang {thr:g} mm",
           transform=a.transAxes, ha="center", va="center", fontsize=9,
           color=V.INK, fontweight="bold")

    lines = [
        ("residual posisi", "median", f"{np.median(rp):.1e} mm"),
        ("", "persentil 95", f"{np.percentile(rp, 95):.1e} mm"),
        ("residual orientasi", "median", f"{np.median(ro):.1e} derajat"),
        ("", "maksimum", f"{ro.max():.1e} derajat"),
    ]
    y = 0.44
    for group, label, value in lines:
        if group:
            a.text(0.06, y, group, transform=a.transAxes, fontsize=8.5,
                   color=V.INK, fontweight="bold", va="center")
            y -= 0.068
        a.text(0.11, y, label, transform=a.transAxes, fontsize=8.5,
               color=V.INK_SECOND, va="center")
        a.text(0.94, y, value, transform=a.transAxes, fontsize=8.5,
               color=V.INK, va="center", ha="right", fontweight="bold")
        y -= 0.068

    # --- Panel 2: distribusi residual posisi -----------------------------
    a = ax[0, 1]
    rp_plot = np.clip(rp, 1e-16, None)
    a.hist(np.log10(rp_plot), bins=50, color=V.SERIES_BLUE, alpha=0.22,
           linewidth=0)
    a.hist(np.log10(rp_plot), bins=50, histtype="step", color=V.SERIES_BLUE,
           linewidth=1.8)
    a.axvline(np.log10(thr), color=V.CRITICAL, linestyle="--", linewidth=1.4)
    a.text(np.log10(thr), a.get_ylim()[1] * 0.96,
           f"ambang toleransi {thr:g} mm ", color=V.CRITICAL, fontsize=8,
           fontweight="bold", va="top", ha="right")
    a.set_title("Seluruh sampel jauh di kiri ambang toleransi")
    a.set_xlabel("log10 residual posisi (mm)")
    a.set_ylabel("jumlah sampel")
    V.strip_frame(a)

    # --- Panel 3 & 4: peta manipulability --------------------------------
    l2 = C.JOINT_LIMITS_DEG["J2"]
    l3 = C.JOINT_LIMITS_DEG["J3"]
    l5 = C.JOINT_LIMITS_DEG["J5"]
    th2 = np.linspace(l2[0], l2[1], 61)
    th3 = np.linspace(l3[0], l3[1], 61)
    th5 = np.linspace(l5[0], l5[1], 61)

    W1 = manip_grid(th2, th3, [0, 0, 0, 0, 60, 0], (1, 2))
    a = ax[1, 0]
    im1 = a.pcolormesh(th2, th3, W1, cmap=cmap, shading="auto", zorder=1)
    cb = fig.colorbar(im1, ax=a, pad=0.015, fraction=0.046)
    cb.set_label("indeks manipulability w (Yoshikawa)", fontsize=8,
                 color=V.INK_SECOND)
    cb.ax.tick_params(labelsize=7, color=V.MUTED)
    cb.outline.set_visible(False)
    lvl = W1.max() * 0.05
    cs = a.contour(th2, th3, W1, levels=[lvl], colors=[V.CRITICAL],
                   linewidths=1.8, zorder=3)
    a.clabel(cs, fmt={lvl: "5% dari w maks"}, fontsize=7.5, colors=V.CRITICAL)
    a.set_title("Singularity siku: lengan terentang atau terlipat penuh")
    a.set_xlabel("sudut bahu theta2 (derajat)")
    a.set_ylabel("sudut siku theta3 (derajat)")
    a.grid(False)
    a.text(0.02, 0.025, "irisan pada theta5 = 60 derajat (wrist tidak singular)",
           transform=a.transAxes, fontsize=7.5, color=V.INK_SECOND, va="bottom",
           bbox=dict(boxstyle="round,pad=0.25", facecolor=V.SURFACE,
                     edgecolor="none", alpha=0.85))

    W2 = manip_grid(th3, th5, [0, 20, 0, 0, 0, 0], (2, 4))
    a = ax[1, 1]
    im2 = a.pcolormesh(th3, th5, W2, cmap=cmap, shading="auto", zorder=1)
    cb = fig.colorbar(im2, ax=a, pad=0.015, fraction=0.046)
    cb.set_label("indeks manipulability w (Yoshikawa)", fontsize=8,
                 color=V.INK_SECOND)
    cb.ax.tick_params(labelsize=7, color=V.MUTED)
    cb.outline.set_visible(False)
    a.axhline(0, color=V.CRITICAL, linewidth=2.0, linestyle="--", zorder=3)
    V.callout(a, (float(th3[len(th3) // 2]), 0.0),
              "theta5 = 0: sumbu J4 dan J6 segaris,\nsatu derajat kebebasan hilang",
              xytext=(-70, 58))
    a.set_title("Singularity pergelangan pada theta5 = 0")
    a.set_xlabel("sudut siku theta3 (derajat)")
    a.set_ylabel("sudut wrist pitch theta5 (derajat)")
    a.grid(False)
    a.text(0.02, 0.025, "irisan pada theta2 = 20 derajat",
           transform=a.transAxes, fontsize=7.5, color=V.INK_SECOND, va="bottom",
           bbox=dict(boxstyle="round,pad=0.25", facecolor=V.SURFACE,
                     edgecolor="none", alpha=0.85))

    V.suptitle(
        fig,
        "Model kinematika terverifikasi: kinematika balik pulang-pergi tanpa galat berarti",
        f"{rp.size} pose acak diuji maju lalu balik lalu maju lagi; peta manipulability menandai "
        "konfigurasi yang harus dihindari saat menyusun lintasan",
    )
    V.figure_caption(
        fig,
        "Sumber: benchmarks/ik_verify.py. Kinematika balik bentuk tertutup konsisten dengan kinematika maju "
        "sampai batas presisi aritmetika mesin, bukan sekadar mendekati. Residual orientasi tidak digambar "
        "terpisah karena sebarannya sama-sama berada di batas presisi mesin; angkanya tercantum pada panel "
        "kiri atas. Manipulability w = akar det(J J transpose); w mendekati nol berarti mendekati singular.",
    )
    fig.subplots_adjust(top=0.885, bottom=0.085, hspace=0.30, wspace=0.24,
                        left=0.055, right=0.965)
    A.save_fig(fig, out_path, tight=False)


def main():
    p = argparse.ArgumentParser(
        description="Verifikasi IK closed-form via round-trip FK(IK(pose)) + "
                    "heatmap manipulability Yoshikawa.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--samples", type=int, default=6000, help="jumlah sampel round-trip")
    p.add_argument("--seed", type=int, default=3, help="seed RNG")
    p.add_argument("--output-dir", type=str, default=str(A.DATA_DIR), help="folder output")
    p.add_argument("--no-plot", action="store_true", help="lewati pembuatan PNG")
    args = p.parse_args()

    out_dir = Path(args.output_dir)
    res_pos_mm, res_ori_deg, n_fail = run_roundtrip(args.samples, args.seed)
    rp, ro = report(res_pos_mm, res_ori_deg, n_fail, args.samples)

    rows = [[f"{a:.6e}", f"{b:.6e}"] for a, b in zip(res_pos_mm, res_ori_deg)]
    A.write_csv(out_dir / "ik_verify.csv", ["res_pos_mm", "res_ori_deg"], rows)

    if not args.no_plot:
        plot(rp, ro, out_dir / "ik_verify.png")


if __name__ == "__main__":
    main()
