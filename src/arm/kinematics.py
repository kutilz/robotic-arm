"""Kinematika maju (forward kinematics) lengan 6-DOF dengan parameter DH.

Konvensi Denavit-Hartenberg standar. Tabel DH diturunkan dari panjang link
di `config.py` untuk lengan antropomorfik dengan pergelangan bola
(spherical wrist: J4-J5-J6 berpotongan di satu titik).

    from arm.kinematics import forward_kinematics
    pose = forward_kinematics([0, 0, 0, 0, 0, 0])  # matriks 4x4 homogen
"""

from __future__ import annotations

import math

import numpy as np

from . import config as C

# Tabel DH: (a, alpha, d, theta_offset) dalam meter & radian.
# Baris i menggambarkan transform dari frame i-1 ke frame i.
# Pose nol [0,0,0,0,0,0] = lengan terentang lurus horizontal (worst-case torsi),
# jangkauan = UPPER_ARM + FOREARM + WRIST = 0.70 m.
DH_TABLE = [
    (0.0,             math.pi / 2,  C.BASE_HEIGHT,  0.0),  # J1 base yaw
    (C.UPPER_ARM_LEN, 0.0,          0.0,            0.0),  # J2 shoulder pitch
    (C.FOREARM_LEN,   0.0,          0.0,            0.0),  # J3 elbow pitch
    (0.0,            -math.pi / 2,  0.0,            0.0),  # J4 wrist roll
    (C.WRIST_LEN,     0.0,          0.0,            0.0),  # J5 wrist pitch
    (0.0,             0.0,          0.0,            0.0),  # J6 end roll
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


def forward_kinematics(joint_angles_deg) -> np.ndarray:
    """Pose end-effector (matriks homogen 4x4) dari 6 sudut sendi (derajat).

    joint_angles_deg: iterable berisi [J1..J6] dalam derajat.
    """
    angles = list(joint_angles_deg)
    if len(angles) != 6:
        raise ValueError("Perlu tepat 6 sudut sendi (J1..J6)")
    T = np.eye(4)
    for (a, alpha, d, offset), q_deg in zip(DH_TABLE, angles):
        theta = offset + math.radians(q_deg)
        T = T @ dh_transform(a, alpha, d, theta)
    return T


def end_effector_position(joint_angles_deg) -> np.ndarray:
    """Posisi (x, y, z) ujung end-effector dalam meter."""
    return forward_kinematics(joint_angles_deg)[:3, 3]


def reach_at(joint_angles_deg) -> float:
    """Jarak radial ujung end-effector dari sumbu base (m)."""
    x, y, _ = end_effector_position(joint_angles_deg)
    return math.hypot(x, y)


if __name__ == "__main__":
    straight = [0, 0, 0, 0, 0, 0]   # terentang lurus horizontal (worst-case)
    elbow_up = [0, -45, 90, 0, 0, 0]
    print("Straight pose :", np.round(end_effector_position(straight), 4))
    print("Elbow-up pose :", np.round(end_effector_position(elbow_up), 4))
    print(f"Reach (straight): {reach_at(straight):.3f} m (target {C.TOTAL_REACH:.2f} m)")
