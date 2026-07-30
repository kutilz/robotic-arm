"""Simulasi 6 - Kapasitas payload maksimum lengan.

Tabel 3.8 menargetkan payload minimum 0,2 kg tetapi belum pernah menyertakan
prediksi berapa payload yang sebenarnya sanggup ditahan. Skrip ini menutup
lubang itu supaya pengujian payload di Bab IV punya angka pembanding, bukan
sekadar lulus/gagal terhadap 0,2 kg.

Dua sudut pandang dihitung:

1. Pada pose terburuk (lengan terentang horizontal penuh), berapa faktor
   torsi tiap sendi pitch (J2, J3, J5) terhadap payload yang dibawa. Titik
   potong kurva dengan garis 1,0x adalah payload saat sendi mulai tidak
   sanggup menahan beban statiknya (mulai melorot); titik potong dengan garis
   2,5x adalah payload yang masih memenuhi target margin dinamis dokumen.
2. Payload maksimum sebagai fungsi jangkauan horizontal. Torsi gravitasi
   sebanding dengan lengan momen, jadi kapasitas payload naik tajam saat siku
   ditekuk. Ini yang menjelaskan kenapa "payload maksimum" tidak bermakna
   tanpa menyebutkan pada jangkauan berapa ia diukur.

Kapasitas aktuator dihitung dua versi: memakai holding torque datasheet penuh
(seperti Tabel 3.4) dan memakai setelan arus firmware yang nyata (lihat
`current_derating.py`). Keduanya ditampilkan karena selisihnya menentukan
apakah target 0,2 kg tercapai dengan cadangan atau nyaris pas.

Torsi gravitasi linear terhadap payload, jadi seluruh perpotongan diselesaikan
secara aljabar (bukan sweep numerik) dari dua evaluasi model massa.

Output:
  data/payload_map.csv  - kapasitas payload per sendi & per jangkauan
  data/payload_map.png  - faktor torsi vs payload + payload maks vs jangkauan

    python benchmarks/payload_map.py --help
    python benchmarks/payload_map.py --max-payload 1.2
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np

import armlib as A
import vizstyle as V
import current_derating as CD
from arm import config as C
from arm import kinematics as K
from arm import torque as T

DESIGN_PAYLOAD_KG = 0.20
PITCH_JOINTS = ["J2", "J3", "J5"]


def static_torque_at(joint: str, payload_kg: float) -> float:
    """Torsi statik gravitasi (N.m) sendi pitch pada payload tertentu.

    Menyalin metode `arm.torque.static_torque` tetapi massa payload boleh
    diganti, supaya kurva kapasitas bisa dibangun tanpa mengubah config.
    """
    axis_pos = C.PITCH_JOINTS[joint]
    moment = 0.0
    for m in C.MASSES:
        if m.position_m <= axis_pos:
            continue
        mass = payload_kg if m.name == "payload" else m.mass_kg
        moment += mass * (m.position_m - axis_pos)
    return C.GRAVITY * moment


def capacity_nm(use_firmware_current: bool) -> dict[str, float]:
    """Torsi keluaran tersedia per sendi (N.m).

    use_firmware_current=False -> holding datasheet penuh (asumsi Tabel 3.4).
    use_firmware_current=True  -> diskalakan ke setelan arus firmware
                                  (model A di current_derating.py).
    """
    caps = {r.name: r.delivered_nm for r in T.build_report()}
    if not use_firmware_current:
        return caps
    for j in C.JOINTS:
        if j.name in CD.FIRMWARE_MA:
            caps[j.name] = CD.delivered_at(j, CD.FIRMWARE_MA[j.name], "A")
    return caps


def payload_limit(joint: str, cap_nm: float, factor: float) -> float:
    """Payload (kg) saat torsi statik mencapai cap_nm / factor.

    Torsi statik linear terhadap payload: tau(p) = tau0 + k*p, jadi
    p_batas = (cap/factor - tau0) / k. Nilai negatif berarti sendi sudah
    gagal bahkan tanpa payload.
    """
    tau0 = static_torque_at(joint, 0.0)
    k = static_torque_at(joint, 1.0) - tau0
    if k <= 0:
        return float("inf")
    return (cap_nm / factor - tau0) / k


def reach_envelope(caps: dict[str, float], factor: float, grid: int = 61,
                   bins: int = 34):
    """Payload maksimum yang DIJAMIN pada tiap jangkauan horizontal.

    Jangkauan yang sama bisa dicapai banyak kombinasi sudut bahu-siku dengan
    lengan momen berbeda, jadi menyapu satu sudut saja menghasilkan kurva yang
    melipat ke belakang dan menyesatkan. Di sini seluruh grid (theta2, theta3)
    disapu, hasilnya dikelompokkan menurut jangkauan horizontal TCP, lalu tiap
    kelompok diambil nilai TERKECIL. Artinya: pada jangkauan tersebut, payload
    ini aman dipakai pose mana pun, bukan hanya pose yang kebetulan ringan.

    Hanya J2 dan J3 yang ditinjau di sini karena keduanya yang lengan momennya
    berubah terhadap pose. Batas J5 tidak bergantung pose dan digambar terpisah
    sebagai plafon mendatar.
    """
    th2 = np.linspace(*C.JOINT_LIMITS_DEG["J2"], grid)
    th3 = np.linspace(*C.JOINT_LIMITS_DEG["J3"], grid)
    reach, limit, who = [], [], []
    for t2 in th2:
        for t3 in th3:
            org = K.joint_origins([0.0, float(t2), float(t3), 0.0, 0.0, 0.0])
            r = abs(org[6][0] - org[1][0])
            tau0 = A.gravity_torques(float(t2), float(t3), 0.0)
            tau1 = A.gravity_torques(float(t2), float(t3), 1.0)
            best, name_best = float("inf"), "-"
            for k, name in enumerate(("J2", "J3")):
                slope = tau1[k] - tau0[k]
                lim = (float("inf") if slope <= 1e-9
                       else (caps[name] / factor - tau0[k]) / slope)
                if lim < best:
                    best, name_best = lim, name
            reach.append(r)
            limit.append(max(best, 0.0))
            who.append(name_best)

    reach = np.array(reach)
    limit = np.array(limit)
    edges = np.linspace(0.0, reach.max(), bins + 1)
    idx = np.clip(np.digitize(reach, edges) - 1, 0, bins - 1)
    out_r, out_l, out_w = [], [], []
    for b in range(bins):
        sel = idx == b
        if not sel.any():
            continue
        j = int(np.flatnonzero(sel)[np.argmin(limit[sel])])
        out_r.append(0.5 * (edges[b] + edges[b + 1]))
        out_l.append(limit[j])
        out_w.append(who[j])
    return np.array(out_r), np.array(out_l), out_w, float(reach.max())


def report(caps_full, caps_fw):
    print("Kapasitas payload pada pose terentang horizontal (worst case)")
    print("=" * 76)
    print(f"{'Sendi':<5} {'Kapasitas':>11} {'Statik@0,2kg':>13} "
          f"{'Faktor':>8} {'Maks 1,0x':>11} {'Maks 2,5x':>11}")
    out = {}
    for scen, caps in (("datasheet penuh", caps_full),
                       ("setelan arus firmware", caps_fw)):
        print(f"\n-- kapasitas aktuator: {scen} --")
        for name in PITCH_JOINTS:
            tau = static_torque_at(name, DESIGN_PAYLOAD_KG)
            p1 = payload_limit(name, caps[name], 1.0)
            p25 = payload_limit(name, caps[name], C.SAFETY_FACTOR)
            print(f"{name:<5} {caps[name]:>9.2f}N {tau:>11.2f}N "
                  f"{caps[name]/tau:>7.2f}x {p1:>9.3f}kg {p25:>9.3f}kg")
            out.setdefault(scen, {})[name] = (caps[name], tau, p1, p25)
    print("-" * 76)
    for scen, d in out.items():
        b1 = min(d, key=lambda n: d[n][2])
        print(f"{scen}: payload maksimum statik {d[b1][2]:.2f} kg, "
              f"dibatasi {b1}; pada target {C.SAFETY_FACTOR:g}x menjadi "
              f"{min(v[3] for v in d.values()):.2f} kg.")
    fw = out["setelan arus firmware"]
    worst = min(fw, key=lambda n: fw[n][2])
    print(f"\nTarget desain {DESIGN_PAYLOAD_KG:.2f} kg terpenuhi secara statik: "
          f"{'YA' if fw[worst][2] >= DESIGN_PAYLOAD_KG else 'TIDAK'} "
          f"(cadangan {fw[worst][2]/DESIGN_PAYLOAD_KG:.1f}x pada pose terburuk).")
    print("CATATAN: seluruh angka adalah prediksi model massa Tabel 3.3. "
          "Payload maksimum terukur dilaporkan di Bab IV.")
    return out


def plot(caps_full, caps_fw, payloads, out_path: Path):
    plt = A.get_plt()
    if plt is None:
        return
    V.apply_rc(plt)
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(13.0, 5.6))

    # --- Panel 1: faktor torsi vs payload, pose terburuk -----------------
    for i, name in enumerate(PITCH_JOINTS):
        tau = np.array([static_torque_at(name, p) for p in payloads])
        color = V.SERIES[i]
        ax1.fill_between(payloads, caps_fw[name] / tau, caps_full[name] / tau,
                         color=color, alpha=0.13, linewidth=0)
        ax1.plot(payloads, caps_fw[name] / tau, color=color,
                 linestyle=V.LINESTYLES[i], linewidth=2.0, zorder=3,
                 label=f"{name} (setelan arus firmware)")
        # tandai titik desain 0,2 kg
        f_design = caps_fw[name] / static_torque_at(name, DESIGN_PAYLOAD_KG)
        ax1.plot([DESIGN_PAYLOAD_KG], [f_design], marker=V.MARKERS[i],
                 color=color, markersize=8, markeredgecolor=V.SURFACE,
                 markeredgewidth=1.6, zorder=5)
        V.annotate_value(ax1, DESIGN_PAYLOAD_KG, f_design,
                         f"{name} {f_design:.2f}x", color=color, dx=8, dy=4, size=8)

    V.threshold_line(ax1, 1.0, "batas melorot 1,0x", color=V.CRITICAL)
    V.threshold_line(ax1, C.SAFETY_FACTOR, f"target {C.SAFETY_FACTOR:g}x",
                     color=V.MUTED, ls=":")
    ax1.axvline(DESIGN_PAYLOAD_KG, color=V.INK_SECOND, linewidth=1.0, alpha=0.5)
    ax1.text(DESIGN_PAYLOAD_KG, ax1.get_ylim()[1] * 0.98, " target 0,2 kg",
             color=V.INK_SECOND, fontsize=8, va="top", ha="left")
    ax1.set_title("Faktor torsi terhadap payload (pose terentang horizontal)")
    ax1.set_xlabel("payload di flange (kg)")
    ax1.set_ylabel("faktor = kapasitas / torsi statik")
    ax1.set_ylim(0, 6)
    ax1.set_xlim(payloads[0], payloads[-1])
    ax1.legend(loc="upper right")
    V.strip_frame(ax1)
    ax1.text(0.015, 0.02, "pita = selisih kapasitas datasheet vs setelan arus firmware",
             transform=ax1.transAxes, fontsize=7.5, color=V.MUTED, va="bottom")

    # --- Panel 2: payload maksimum vs jangkauan horizontal ---------------
    r_stat, lim_stat, binding, r_max = reach_envelope(caps_fw, 1.0)
    r_dyn, lim_dyn, _, _ = reach_envelope(caps_fw, C.SAFETY_FACTOR)

    ax2.plot(r_stat * 1000, lim_stat, color=V.SERIES_BLUE, linewidth=2.2,
             marker="o", markersize=3.5, zorder=3,
             label="batas statik J2/J3 (mulai melorot)")
    ax2.plot(r_dyn * 1000, lim_dyn, color=V.SERIES_ORANGE, linestyle="--",
             linewidth=2.0, zorder=3, label=f"batas target {C.SAFETY_FACTOR:g}x")
    ax2.fill_between(r_dyn * 1000, 0, lim_dyn, color=V.SERIES_ORANGE,
                     alpha=0.10, linewidth=0)

    # J5 tidak bergantung pose: plafon mendatar, dan ternyata dialah pengikat
    # sebenarnya di jangkauan menengah.
    j5_cap = payload_limit("J5", caps_fw["J5"], 1.0)
    ax2.axhline(j5_cap, color=V.SERIES_AQUA, linestyle="-.", linewidth=1.8,
                zorder=4, label=f"plafon J5 wrist pitch {j5_cap:.2f} kg")

    V.threshold_line(ax2, DESIGN_PAYLOAD_KG, "target 0,2 kg", color=V.CRITICAL)

    # sorot pose jangkauan penuh: itu angka yang dikutip di naskah
    i_full = int(np.argmax(r_stat))
    ax2.plot([r_stat[i_full] * 1000], [lim_stat[i_full]], marker="o",
             color=V.SERIES_BLUE, markersize=9, markeredgecolor=V.SURFACE,
             markeredgewidth=1.8, zorder=6)
    V.callout(ax2, (r_stat[i_full] * 1000, lim_stat[i_full]),
              f"jangkauan penuh {r_stat[i_full]*1000:.0f} mm: "
              f"payload maks {lim_stat[i_full]:.2f} kg\n"
              f"(dibatasi {binding[i_full]}; plafon J5 {j5_cap:.2f} kg tetap berlaku)",
              xytext=(-236, 52), color=V.INK)

    ax2.set_title("Payload maksimum yang dijamin pada tiap jangkauan")
    ax2.set_xlabel("jangkauan horizontal TCP dari sumbu bahu J2 (mm)")
    ax2.set_ylabel("payload maksimum (kg)")
    ax2.set_ylim(0, 1.6)
    ax2.set_xlim(0, r_max * 1000 * 1.04)
    ax2.legend(loc="upper right")
    V.strip_frame(ax2)
    ax2.text(0.015, 0.075,
             "tiap titik = pose terberat pada jangkauan itu (bukan pose termudah)",
             transform=ax2.transAxes, fontsize=7.5, color=V.MUTED, va="bottom")

    V.suptitle(
        fig,
        "Kapasitas payload: target 0,2 kg dan berapa cadangan yang tersisa",
        "Pose terentang horizontal adalah kondisi terburuk; kapasitas naik tajam begitu siku ditekuk",
    )
    V.figure_caption(
        fig,
        "Sumber: benchmarks/payload_map.py, memakai model massa Tabel 3.3 dan kapasitas aktuator "
        "pada setelan arus firmware (lihat current_derating.py). Torsi gravitasi linear terhadap payload, "
        "sehingga seluruh batas diselesaikan secara aljabar. Angka prediksi, bukan hasil ukur.",
    )
    fig.subplots_adjust(top=0.86, bottom=0.14)
    A.save_fig(fig, out_path, tight=False)


def main():
    p = argparse.ArgumentParser(
        description="Kapasitas payload maksimum lengan pada berbagai pose.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--max-payload", type=float, default=1.5,
                   help="payload terbesar pada sumbu grafik (kg)")
    p.add_argument("--steps", type=int, default=200, help="jumlah titik sweep payload")
    p.add_argument("--output-dir", type=str, default=str(A.DATA_DIR), help="folder output")
    p.add_argument("--no-plot", action="store_true", help="lewati pembuatan PNG")
    args = p.parse_args()

    out_dir = Path(args.output_dir)
    caps_full = capacity_nm(False)
    caps_fw = capacity_nm(True)
    report(caps_full, caps_fw)

    payloads = np.linspace(0.0, args.max_payload, args.steps)

    rows = []
    for scen, caps in (("datasheet", caps_full), ("firmware", caps_fw)):
        for name in PITCH_JOINTS:
            rows.append([
                scen, name, f"{caps[name]:.4f}",
                f"{static_torque_at(name, DESIGN_PAYLOAD_KG):.4f}",
                f"{caps[name] / static_torque_at(name, DESIGN_PAYLOAD_KG):.4f}",
                f"{payload_limit(name, caps[name], 1.0):.4f}",
                f"{payload_limit(name, caps[name], C.SAFETY_FACTOR):.4f}",
            ])
    A.write_csv(out_dir / "payload_map.csv",
                ["skenario_kapasitas", "joint", "kapasitas_nm", "statik_02kg_nm",
                 "faktor_02kg", "payload_maks_1x_kg", "payload_maks_2p5x_kg"],
                rows)

    if not args.no_plot:
        plot(caps_full, caps_fw, payloads, out_dir / "payload_map.png")


if __name__ == "__main__":
    main()
