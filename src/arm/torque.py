"""Perhitungan torsi statik & sizing reduksi cycloidal per sendi.

Mereproduksi metode dokumen riset §2-§4:
  tau_j = g * sum_(i distal ke j) m_i * d_i          (momen gravitasi)
  ratio = T_required / (T_running * efisiensi)        (reduksi diperlukan)

Jalankan langsung untuk mencetak tabel rekomendasi:
    python -m arm.torque
"""

from __future__ import annotations

from dataclasses import dataclass

from . import config as C


def static_torque(joint: str) -> float:
    """Torsi statik gravitasi (N.m) pada sendi pitch (J2/J3/J5)."""
    if joint not in C.PITCH_JOINTS:
        return 0.0  # sendi roll/yaw: ~0 momen gravitasi di pose horizontal
    axis_pos = C.PITCH_JOINTS[joint]
    moment = 0.0
    for m in C.MASSES:
        if m.position_m > axis_pos:  # hanya massa distal terhadap sumbu
            moment += m.mass_kg * (m.position_m - axis_pos)
    return C.GRAVITY * moment


def required_output_torque(joint: str) -> float:
    """Torsi output yang harus disediakan gearbox (N.m), termasuk safety factor."""
    if joint in C.INERTIA_JOINT_TARGETS_NM:
        return C.INERTIA_JOINT_TARGETS_NM[joint]
    return static_torque(joint) * C.SAFETY_FACTOR


def required_ratio(required_nm: float, motor: C.Motor) -> float:
    """Reduksi minimum agar motor mencapai torsi output yang diperlukan."""
    return required_nm / (motor.running_torque_nm * C.CYCLOIDAL_EFFICIENCY)


def delivered_output_torque(motor: C.Motor, ratio: float) -> float:
    """Torsi output yang benar-benar dihasilkan motor pada reduksi tertentu."""
    return motor.running_torque_nm * ratio * C.CYCLOIDAL_EFFICIENCY


def output_speed_dps(ratio: float, input_rpm: float = 300.0) -> float:
    """Kecepatan output (derajat/detik) pada input_rpm tertentu."""
    output_rpm = input_rpm / ratio
    return output_rpm * 360.0 / 60.0


@dataclass
class JointReport:
    name: str
    description: str
    static_nm: float
    required_nm: float
    motor: str
    ratio: float
    delivered_nm: float
    speed_dps: float
    margin: float  # delivered / required

    @property
    def ok(self) -> bool:
        return self.margin >= 1.0


def build_report() -> list[JointReport]:
    rows: list[JointReport] = []
    for j in C.JOINTS:
        motor = C.MOTORS[j.motor_key]
        req = required_output_torque(j.name)
        delivered = delivered_output_torque(motor, j.ratio)
        rows.append(
            JointReport(
                name=j.name,
                description=j.description,
                static_nm=static_torque(j.name),
                required_nm=req,
                motor=motor.model,
                ratio=j.ratio,
                delivered_nm=delivered,
                speed_dps=output_speed_dps(j.ratio),
                margin=delivered / req if req else float("inf"),
            )
        )
    return rows


def print_report() -> None:
    rows = build_report()
    header = (
        f"{'Joint':<5} {'Fungsi':<14} {'Statik':>7} {'Perlu':>7} "
        f"{'Rasio':>6} {'Output':>7} {'deg/s':>6} {'Margin':>7}  Motor"
    )
    print(header)
    print("-" * len(header))
    for r in rows:
        flag = "" if r.ok else "  <-- KURANG"
        print(
            f"{r.name:<5} {r.description:<14} {r.static_nm:>6.2f}N {r.required_nm:>6.2f}N "
            f"1:{r.ratio:<4.0f} {r.delivered_nm:>6.2f}N {r.speed_dps:>5.0f} "
            f"{r.margin:>6.2f}x  {r.motor}{flag}"
        )
    print()
    arm_mass = sum(m.mass_kg for m in C.MASSES)
    print(f"Total massa bergerak (model): {arm_mass:.2f} kg | Jangkauan: {C.TOTAL_REACH:.2f} m")


if __name__ == "__main__":
    print_report()
