"""Verifikasi perhitungan torsi cocok dengan dokumen sizing riset.

Angka acuan dari docs/research/motor-cycloidal-sizing.md §2.
"""

import math

import pytest

from arm import config as C
from arm import torque
from arm.kinematics import reach_at


@pytest.mark.parametrize(
    "joint, expected_nm",
    [("J2", 11.42), ("J3", 4.46), ("J5", 0.69)],
)
def test_static_torque_matches_research(joint, expected_nm):
    assert torque.static_torque(joint) == pytest.approx(expected_nm, abs=0.05)


def test_roll_yaw_joints_have_zero_gravity_torque():
    for joint in ("J1", "J4", "J6"):
        assert torque.static_torque(joint) == 0.0


def test_required_output_applies_safety_factor():
    # J2: 11.42 * 2.5 ~= 28.5 N.m (dokumen: ~29 N.m)
    assert torque.required_output_torque("J2") == pytest.approx(28.6, abs=0.5)


def test_shoulder_needs_high_reduction():
    # Bahu butuh ~1:50-60 dengan NEMA23 (dokumen §3)
    motor = C.MOTORS["NEMA23"]
    ratio = torque.required_ratio(torque.required_output_torque("J2"), motor)
    assert 50 <= ratio <= 70


def test_wrist_fine_on_existing_ratio():
    # J5 pada konfigurasi 1:15 harus punya margin >= 1
    report = {r.name: r for r in torque.build_report()}
    assert report["J5"].ok
    assert report["J5"].margin >= 1.0


def test_forward_kinematics_reach_within_envelope():
    # Pose lurus [0,0,0,0,0,0] -> jangkauan = total reach 0.70 m
    reach = reach_at([0, 0, 0, 0, 0, 0])
    assert reach == pytest.approx(C.TOTAL_REACH, abs=0.02)


def test_encoder_hybrid_mapping():
    # 4 sendi AS5600 + 2 sendi optik (sesuai budget)
    enc = {j.name: j.encoder_type for j in C.JOINTS}
    as5600 = [n for n, t in enc.items() if t == C.ENC_AS5600]
    optical = [n for n, t in enc.items() if t == C.ENC_OPTICAL]
    assert len(as5600) == 4
    assert set(optical) == {"J4", "J6"}  # encoder optik di sendi roll


def test_as5600_finer_than_optical_at_output():
    by_name = {j.name: j for j in C.JOINTS}
    # AS5600 12-bit di output (0.088°) lebih halus dari optik di poros motor
    assert by_name["J5"].output_resolution_deg < by_name["J4"].output_resolution_deg


def test_optical_output_resolution_matches_formula():
    # 24 lubang x4 quadrature = 96 cpr -> 3.75°/count di disk;
    # di output J4 (1:15) -> 3.75/15 = 0.25°
    j4 = next(j for j in C.JOINTS if j.name == "J4")
    assert j4.output_resolution_deg == pytest.approx(0.25, abs=1e-6)
