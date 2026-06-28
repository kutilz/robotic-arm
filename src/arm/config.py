"""Parameter fisik lengan robot 6-DOF.

Semua angka di sini berasal dari dokumen sizing
(`docs/research/motor-cycloidal-sizing.md`). Ubah nilai di sini setelah
menimbang part hasil cetak yang sebenarnya — torsi bahu (J2) skala hampir
linear terhadap massa & jarak distal, jadi recompute §torque setelah update.
"""

from __future__ import annotations

from dataclasses import dataclass

GRAVITY = 9.81  # m/s^2

# --- Faktor sizing (lihat dokumen riset §1) ------------------------------
RUNNING_TORQUE_FRACTION = 0.5   # torsi running = 0.5 x holding (derate stepper)
CYCLOIDAL_EFFICIENCY = 0.75     # efisiensi cycloidal cetak 3D (konservatif)
SAFETY_FACTOR = 2.5             # faktor dinamis/keamanan pada torsi statik

# --- Panjang link (m), proporsi antropomorfik untuk jangkauan 0.70 m -----
UPPER_ARM_LEN = 0.33   # J2 -> J3
FOREARM_LEN = 0.27     # J3 -> J5
WRIST_LEN = 0.10       # J5 -> end-effector
TOTAL_REACH = UPPER_ARM_LEN + FOREARM_LEN + WRIST_LEN  # 0.70 m
BASE_HEIGHT = 0.15     # J1 -> J2 (tinggi kolom base, estimasi)


@dataclass(frozen=True)
class PointMass:
    """Massa titik terkumpul (lumped) sepanjang lengan.

    position_m = jarak horizontal dari sumbu bahu (J2) saat lengan
    terentang penuh horizontal (pose worst-case torsi gravitasi).
    """

    name: str
    mass_kg: float
    position_m: float


# Model massa (dari dokumen riset §1, jarak diukur dari J2)
MASSES: list[PointMass] = [
    PointMass("upper_arm_link", 0.20, 0.165),
    PointMass("elbow_drive", 0.55, 0.330),
    PointMass("forearm_link", 0.15, 0.465),
    PointMass("wrist_pitch_drive", 0.45, 0.600),
    PointMass("wrist_cluster_ee", 0.40, 0.650),
    PointMass("payload", 0.50, 0.700),
]

# Sendi pitch memikul momen gravitasi; nilainya = posisi sumbu dari J2 (m).
PITCH_JOINTS: dict[str, float] = {"J2": 0.0, "J3": 0.330, "J5": 0.600}

# Sendi roll/yaw ~0 momen gravitasi di pose ini; target output (N.m) dari
# pertimbangan inersia/friksi (dokumen riset §2).
INERTIA_JOINT_TARGETS_NM: dict[str, float] = {"J1": 3.0, "J4": 1.0, "J6": 0.5}


@dataclass(frozen=True)
class Motor:
    model: str
    holding_torque_nm: float

    @property
    def running_torque_nm(self) -> float:
        return self.holding_torque_nm * RUNNING_TORQUE_FRACTION


MOTORS: dict[str, Motor] = {
    "17HS4401": Motor("17HS4401 (NEMA17 40mm)", 0.40),
    "17HS8401": Motor("17HS8401 (NEMA17 48mm)", 0.52),
    "17HS19-2004S1": Motor("17HS19-2004S1 (NEMA17 48mm)", 0.59),
    "NEMA23": Motor("NEMA23 (57x56mm, 1.26 N.m)", 1.26),
}


# --- Position feedback (encoder) -----------------------------------------
# Arsitektur HIBRIDA (sesuai budget: beli 4 AS5600):
#   - 4 sendi: AS5600 (absolut magnetik 12-bit, I2C via mux TCA9548A),
#              dipasang di OUTPUT sendi -> ikut mengukur backlash gearbox.
#   - 2 sendi: encoder optik incremental = disk cetak 24 lubang + 2x TLP1025
#              (photo-interrupter), quadrature -> 4x = 96 count/rev,
#              dipasang di POROS MOTOR -> resolusi output halus (/ratio).
OPTICAL_DISK_SLOTS = 24
ENC_AS5600 = "as5600"      # absolut, dipasang di output sendi
ENC_OPTICAL = "optical_quad"  # incremental, dipasang di poros motor


@dataclass(frozen=True)
class JointSpec:
    """Konfigurasi rekomendasi per sendi (dokumen riset §6)."""

    name: str
    motor_key: str
    ratio: float          # reduksi cycloidal (mis. 50 berarti 1:50)
    encoder_type: str     # ENC_AS5600 | ENC_OPTICAL
    encoder_chan: int     # AS5600: channel mux TCA9548A; optik: indeks pasangan opto
    description: str

    @property
    def counts_per_rev(self) -> float:
        return 4096.0 if self.encoder_type == ENC_AS5600 else OPTICAL_DISK_SLOTS * 4

    @property
    def resolution_deg(self) -> float:
        """Resolusi sudut di sisi disk encoder (derajat per count)."""
        return 360.0 / self.counts_per_rev

    @property
    def output_resolution_deg(self) -> float:
        """Resolusi efektif di output sendi (memperhitungkan lokasi pasang).

        AS5600 di output -> resolusi = resolusi disk.
        Optik di poros motor -> resolusi output = resolusi disk / rasio reduksi.
        """
        if self.encoder_type == ENC_AS5600:
            return self.resolution_deg
        return self.resolution_deg / self.ratio


# AS5600 (absolut) di sendi pitch + base; optik incremental di roll (J4, J6).
# Ubah encoder_type di sini bila ingin pemetaan berbeda.
JOINTS: list[JointSpec] = [
    JointSpec("J1", "17HS19-2004S1", 20, ENC_AS5600, 0, "base yaw"),
    JointSpec("J2", "NEMA23", 55, ENC_AS5600, 1, "shoulder pitch"),
    JointSpec("J3", "17HS19-2004S1", 50, ENC_AS5600, 2, "elbow pitch"),
    JointSpec("J4", "17HS4401", 15, ENC_OPTICAL, 0, "wrist roll"),
    JointSpec("J5", "17HS4401", 15, ENC_AS5600, 3, "wrist pitch"),
    JointSpec("J6", "17HS4401", 15, ENC_OPTICAL, 1, "end roll"),
]


def print_encoder_map() -> None:
    """Cetak peta encoder + resolusi efektif per sendi."""
    print(f"{'Sendi':<5} {'Encoder':<13} {'Pasang':<11} {'Res. output':>12}")
    print("-" * 44)
    for j in JOINTS:
        mount = "output" if j.encoder_type == ENC_AS5600 else "poros motor"
        print(
            f"{j.name:<5} {j.encoder_type:<13} {mount:<11} "
            f"{j.output_resolution_deg:>9.4f} deg"
        )


if __name__ == "__main__":
    print_encoder_map()
