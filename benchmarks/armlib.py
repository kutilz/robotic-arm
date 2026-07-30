"""Modul bersama untuk simulasi di `benchmarks/`.

Berisi util yang dipakai ulang beberapa skrip simulasi: sampling sudut sendi
dalam batas joint limit, forward kinematics batch (numpy), Jacobian numerik,
indeks manipulability, model torsi gravitasi J2/J3, plus pembantu plot dan CSV.

Semua konstanta fisik (geometri DH, massa, batas sudut, spec encoder) diambil
dari `src/arm/config.py`. Jangan hardcode ulang di skrip simulasi.
"""

from __future__ import annotations

import csv
import math
import sys
from pathlib import Path

import numpy as np

# pastikan paket 'arm' bisa diimpor saat skrip dijalankan langsung
_SRC = Path(__file__).resolve().parents[1] / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from arm import config as C  # noqa: E402
from arm import kinematics as K  # noqa: E402

DATA_DIR = Path(__file__).resolve().parent / "data"

JOINT_NAMES = [j.name for j in C.JOINTS]  # ['J1'..'J6']

# Batas sudut (deg) sebagai array (6, 2), urut J1..J6.
LIMITS_DEG = np.array([C.JOINT_LIMITS_DEG[n] for n in JOINT_NAMES], dtype=float)

# Baris DH (a, alpha, d, offset) dari kinematics (satu sumber).
_DH = np.array(K.DH_TABLE, dtype=float)


# --------------------------------------------------------------------------
# Sampling sudut sendi
# --------------------------------------------------------------------------
def sample_joints(n: int, rng: np.random.Generator) -> np.ndarray:
    """n set sudut acak uniform (deg) dalam batas joint limit -> (n, 6)."""
    lo, hi = LIMITS_DEG[:, 0], LIMITS_DEG[:, 1]
    return lo + (hi - lo) * rng.random((n, 6))


# --------------------------------------------------------------------------
# Forward kinematics batch (numpy)
# --------------------------------------------------------------------------
def _dh_batch(a: float, alpha: float, d: float, theta: np.ndarray) -> np.ndarray:
    """Transform DH satu baris untuk vektor theta (n,) -> (n, 4, 4)."""
    n = theta.shape[0]
    ct, st = np.cos(theta), np.sin(theta)
    ca, sa = math.cos(alpha), math.sin(alpha)
    T = np.zeros((n, 4, 4))
    T[:, 0, 0] = ct
    T[:, 0, 1] = -st * ca
    T[:, 0, 2] = st * sa
    T[:, 0, 3] = a * ct
    T[:, 1, 0] = st
    T[:, 1, 1] = ct * ca
    T[:, 1, 2] = -ct * sa
    T[:, 1, 3] = a * st
    T[:, 2, 1] = sa
    T[:, 2, 2] = ca
    T[:, 2, 3] = d
    T[:, 3, 3] = 1.0
    return T


def fk_batch(q_deg: np.ndarray) -> np.ndarray:
    """Pose TCP (matriks 4x4) untuk banyak set sudut sekaligus -> (n, 4, 4)."""
    q = np.radians(np.asarray(q_deg, dtype=float))
    n = q.shape[0]
    T = np.broadcast_to(np.eye(4), (n, 4, 4)).copy()
    for i in range(6):
        a, alpha, d, offset = _DH[i]
        T = T @ _dh_batch(a, alpha, d, q[:, i] + offset)
    return T


def tcp_batch(q_deg: np.ndarray) -> np.ndarray:
    """Posisi TCP (x, y, z) untuk banyak set sudut -> (n, 3)."""
    return fk_batch(q_deg)[:, :3, 3]


def origins_batch(q_deg: np.ndarray) -> np.ndarray:
    """Titik asal tiap frame untuk banyak set sudut -> (n, 7, 3).

    Indeks kolom: 0 base, 1 J2, 2 J3, 3 frame3, 4 wrist-center, 5 wc, 6 TCP.
    """
    q = np.radians(np.asarray(q_deg, dtype=float))
    n = q.shape[0]
    T = np.broadcast_to(np.eye(4), (n, 4, 4)).copy()
    out = np.zeros((n, 7, 3))
    out[:, 0] = T[:, :3, 3]
    for i in range(6):
        a, alpha, d, offset = _DH[i]
        T = T @ _dh_batch(a, alpha, d, q[:, i] + offset)
        out[:, i + 1] = T[:, :3, 3]
    return out


# --------------------------------------------------------------------------
# Jacobian numerik + manipulability
# --------------------------------------------------------------------------
def numeric_jacobian(q_deg, dq_deg: float = 1e-3) -> np.ndarray:
    """Jacobian geometrik 6x6 (baris: vx,vy,vz,wx,wy,wz) via beda hingga.

    Baris translasi dalam m/rad, baris rotasi dalam rad/rad.
    """
    q = np.asarray(q_deg, dtype=float)
    T0 = K.forward_kinematics(q)
    p0, R0 = T0[:3, 3], T0[:3, :3]
    dq = math.radians(dq_deg)
    J = np.zeros((6, 6))
    for i in range(6):
        qp = q.copy()
        qp[i] += dq_deg
        T = K.forward_kinematics(qp)
        J[:3, i] = (T[:3, 3] - p0) / dq
        dR = T[:3, :3] @ R0.T
        w = np.array([dR[2, 1] - dR[1, 2], dR[0, 2] - dR[2, 0], dR[1, 0] - dR[0, 1]]) / 2.0
        J[3:, i] = w / dq
    return J


def manipulability(J: np.ndarray) -> float:
    """Indeks manipulability Yoshikawa w = sqrt(det(J J^T)). 0 = singular."""
    det = np.linalg.det(J @ J.T)
    return math.sqrt(det) if det > 0 else 0.0


# --------------------------------------------------------------------------
# Model torsi gravitasi J2 & J3 di sembarang pose (untuk torque_map)
# --------------------------------------------------------------------------
def gravity_torques(theta2_deg: float, theta3_deg: float, payload_kg: float | None = None):
    """Torsi gravitasi (N.m) di J2 dan J3 untuk pose (0, th2, th3, 0, 0, 0).

    Massa lumped dari config.MASSES ditempatkan dengan interpolasi sepanjang
    link (upper arm J2->J3, forearm J3->TCP) memakai posisi sumbu hasil FK,
    jadi konsisten dengan `arm.torque.static_torque` pada pose lengan lurus.
    Lengan pitch: torsi = g * sum(m_i * lengan_horizontal_i).
    """
    q = [0.0, theta2_deg, theta3_deg, 0.0, 0.0, 0.0]
    org = K.joint_origins(q)
    p_j2, p_j3, p_tcp = org[1], org[2], org[6]
    upper_span = C.UPPER_ARM_LEN
    fore_span = C.REACH_FROM_J2 - C.UPPER_ARM_LEN
    tau2 = tau3 = 0.0
    for m in C.MASSES:
        mass = payload_kg if (m.name == "payload" and payload_kg is not None) else m.mass_kg
        if m.position_m <= upper_span:
            f = m.position_m / upper_span
            pos = p_j2 + f * (p_j3 - p_j2)
        else:
            f = (m.position_m - upper_span) / fore_span
            pos = p_j3 + f * (p_tcp - p_j3)
            tau3 += mass * (pos[0] - p_j3[0])  # hanya massa distal J3
        tau2 += mass * (pos[0] - p_j2[0])
    return C.GRAVITY * abs(tau2), C.GRAVITY * abs(tau3)


# Kapasitas output aktuator (N.m running) hasil model sizing (arm.torque).
def actuator_capacity_nm() -> dict[str, float]:
    from arm import torque as T  # import lokal, hindari siklus

    return {r.name: r.delivered_nm for r in T.build_report()}


# --------------------------------------------------------------------------
# Util plot & CSV
# --------------------------------------------------------------------------
def get_plt():
    """Kembalikan pyplot (backend Agg) atau None bila matplotlib absen."""
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt

        plt.rcParams.update({"figure.dpi": 110, "font.size": 9})
        return plt
    except ImportError:
        print("matplotlib belum terpasang; lewati plot.")
        return None


def save_fig(fig, out_path: Path, dpi: int = 200, tight: bool = True) -> None:
    """Simpan figure.

    tight=False dipakai saat tata letak sudah diatur manual lewat
    `subplots_adjust` (mis. figure dengan suptitle dua baris dan catatan kaki),
    karena tight_layout akan menabrak keduanya.
    """
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if tight:
        fig.tight_layout()
    fig.savefig(out_path, dpi=dpi)
    print(f"Plot disimpan: {out_path}")


def write_csv(out_path: Path, header: list[str], rows) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)
    print(f"CSV disimpan: {out_path}")
