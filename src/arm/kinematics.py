"""Kinematika maju (forward kinematics) lengan 6-DOF dengan parameter DH.

Konvensi Denavit-Hartenberg standar. Tabel DH memakai konstanta terukur CAD
di `config.py` untuk lengan antropomorfik dengan pergelangan bola
(spherical wrist: J4-J5-J6 berpotongan di satu titik).

    from arm.kinematics import forward_kinematics
    pose = forward_kinematics([0, 0, 0, 0, 0, 0])  # matriks 4x4 homogen
"""

from __future__ import annotations

import math

import numpy as np

from . import config as C

# Tabel DH: (a, alpha, d, theta_offset) dalam meter dan radian.
# Baris i menggambarkan transform dari frame i-1 ke frame i. Nilai diukur dari
# CAD (Testing Assembly.step), lihat tabel di config.py. Ada offset perpendicular
# siku a3 dan offset lateral bahu a1 yang dulu tidak dimodelkan (twin meleset
# ~66 mm dan ~50 mm). Pergelangan bola J4/J5/J6 concurrent (Pieper terpenuhi).
DH_TABLE = [
    (C.A1_SHOULDER_OFFSET, math.pi / 2,  C.D1_BASE,     0.0),  # J1 base yaw
    (C.A2_UPPER_ARM,       0.0,          0.0,           0.0),  # J2 shoulder pitch
    (C.A3_ELBOW_OFFSET,   -math.pi / 2,  0.0,           0.0),  # J3 elbow pitch
    (0.0,                  math.pi / 2,  C.D4_FOREARM,  0.0),  # J4 wrist roll
    (0.0,                 -math.pi / 2,  0.0,           0.0),  # J5 wrist pitch
    (0.0,                  0.0,          C.D6_WRIST_TCP, 0.0),  # J6 end roll
]


def dh_transform(a: float, alpha: float, d: float, theta: float) -> np.ndarray:
    """Matriks transformasi homogen 4x4 untuk satu baris DH."""
    ct, st = math.cos(theta), math.sin(theta)
    ca, sa = math.cos(alpha), math.sin(alpha)
    return np.array(
        [
            [ct, -st * ca,  st * sa, a * ct],
            [st,  ct * ca, -ct * sa, a * st],
            [0.0, sa,       ca,      d],
            [0.0, 0.0,      0.0,     1.0],
        ]
    )


def link_transforms(joint_angles_deg) -> list[np.ndarray]:
    """Daftar transform kumulatif [T0..T6] dari base ke tiap frame.

    T0 = identitas (base), T6 = pose TCP. Berguna untuk mengambil posisi tiap
    sumbu sendi (kolom translasi Ti[:3, 3]) dan sumbu putarnya (Ti[:3, 2]).
    """
    angles = list(joint_angles_deg)
    if len(angles) != 6:
        raise ValueError("Perlu tepat 6 sudut sendi (J1..J6)")
    frames = [np.eye(4)]
    T = np.eye(4)
    for (a, alpha, d, offset), q_deg in zip(DH_TABLE, angles):
        theta = offset + math.radians(q_deg)
        T = T @ dh_transform(a, alpha, d, theta)
        frames.append(T.copy())
    return frames


def forward_kinematics(joint_angles_deg) -> np.ndarray:
    """Pose end-effector (matriks homogen 4x4) dari 6 sudut sendi (derajat).

    joint_angles_deg: iterable berisi [J1..J6] dalam derajat.
    """
    return link_transforms(joint_angles_deg)[-1]


def end_effector_position(joint_angles_deg) -> np.ndarray:
    """Posisi (x, y, z) ujung end-effector dalam meter."""
    return forward_kinematics(joint_angles_deg)[:3, 3]


def joint_origins(joint_angles_deg) -> np.ndarray:
    """Titik asal tiap frame (7x3): base, J2, J3, J4, J5, J6, TCP dalam meter."""
    return np.array([T[:3, 3] for T in link_transforms(joint_angles_deg)])


def reach_at(joint_angles_deg) -> float:
    """Jarak radial ujung end-effector dari sumbu base (m)."""
    x, y, _ = end_effector_position(joint_angles_deg)
    return math.hypot(x, y)


if __name__ == "__main__":
    home = [0, 0, 0, 0, 0, 0]        # pose referensi DH (upper arm +X, forearm +Z)
    extended = [0, 0, -90, 0, 0, 0]  # forearm ikut horizontal -> mendekati reach maks
    print("Home pose     :", np.round(end_effector_position(home), 4))
    print("Extended pose :", np.round(end_effector_position(extended), 4))
    print(f"Reach (extended): {reach_at(extended):.3f} m (target {C.TOTAL_REACH:.3f} m)")
