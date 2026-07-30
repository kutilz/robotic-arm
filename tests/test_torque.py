"""Verifikasi perhitungan torsi cocok dengan dokumen sizing riset.

Angka acuan dari docs/research/arsitektur_final_robotic_arm_6dof.md §2-3.
"""

import math

import pytest

from arm import config as C
from arm import torque
from arm.kinematics import reach_at


# Torsi statik gravitasi worst-case (lengan horizontal) dari model massa lumped
# di config.py, dengan sumbu sendi geometri DH terukur CAD.
@pytest.mark.parametrize(
    "joint, expected_nm",
    [("J2", 4.79), ("J3", 1.38), ("J5", 0.23)],
)
def test_static_torque_matches_research(joint, expected_nm):
    assert torque.static_torque(joint) == pytest.approx(expected_nm, abs=0.05)


def test_roll_yaw_joints_have_zero_gravity_torque():
    for joint in ("J1", "J4", "J6"):
        assert torque.static_torque(joint) == 0.0


def test_required_output_applies_safety_factor():
    # J2: 4.79 * 2.5 ~= 12 N.m (dokumen: target ~12 N.m)
    assert torque.required_output_torque("J2") == pytest.approx(12.0, abs=0.5)


def test_shoulder_is_direct_cycloidal_single_motor():
    # J2 = 17HS6401S tunggal, cycloidal DIRECT. Rasio dihitung dari jumlah pin
    # dowel ring di STEP = 30 pin -> 1:30 (bukan 1:45 seperti angka lama).
    j2 = next(j for j in C.JOINTS if j.name == "J2")
    assert j2.motor_key == "17HS6401S"
    assert j2.drive == C.DRIVE_CYC
    assert j2.ratio == 30


def test_final_reduction_ratios():
    # Drivetrain FINAL (dikonfirmasi user 2026-07-27). Mengunci keenam sendi,
    # bukan hanya yang bercycloidal, supaya perubahan diam-diam ketahuan.
    ratios = {j.name: j.ratio for j in C.JOINTS}
    assert ratios["J1"] == 15   # belt 2 stage: 12T->60T (5:1) x 20T->60T (3:1)
    assert ratios["J2"] == 30   # cycloidal 30 pin dowel -> 1:30
    assert ratios["J3"] == 30   # belt 20T->60T (3:1) x cycloidal 1:10
    assert ratios["J4"] == 15   # cycloidal 1:15 (TENTATIVE)
    assert ratios["J5"] == 1    # servo direct drive
    assert ratios["J6"] == 1    # servo direct drive


def test_final_motor_assignment():
    # Aktuator FINAL per sendi. Mengunci juga bahwa motor yang tidak jadi
    # dipakai sudah hilang dari katalog, supaya tidak ada dua angka torsi
    # mirip nama (17HS6401 0.60 vs 17HS6401S 0.70) yang hidup berdampingan.
    motors = {j.name: j.motor_key for j in C.JOINTS}
    assert motors == {
        "J1": "17HS2401",
        "J2": "17HS6401S",
        "J3": "17HS2401",
        "J4": "17HS2401",
        "J5": "MG996R",
        "J6": "MG996R",
    }
    assert C.MOTORS["17HS2401"].holding_torque_nm == pytest.approx(0.45)
    assert C.MOTORS["17HS6401S"].holding_torque_nm == pytest.approx(0.70)
    for retired in ("17HS4401", "17HS6401", "17PM-K054", "NEMA23"):
        assert retired not in C.MOTORS


def test_no_joint_still_uses_nema23():
    assert "NEMA23" not in C.MOTORS
    assert all(j.motor_key != "NEMA23" for j in C.JOINTS)


def test_wrist_roll_and_end_roll_clear_margin():
    # J4 (cycloidal relokasi) dan J6 (servo) berstatus final (bukan
    # conditional) di dokumen riset -> harus clear margin >= 1.
    report = {r.name: r for r in torque.build_report()}
    assert report["J4"].ok
    assert report["J6"].ok


def test_forward_kinematics_home_pose_matches_cad_dh():
    # Pose nol DH (upper arm +X, forearm +Z): hasil rantai DH terukur CAD.
    # Menjaga agar offset bahu a1 dan siku a3 tidak hilang lagi dari tabel.
    from arm.kinematics import end_effector_position

    pos = end_effector_position([0, 0, 0, 0, 0, 0])
    assert list(pos) == pytest.approx([0.4040, 0.0, 0.3748], abs=1e-3)


def test_max_reach_from_j2_reaches_design_target():
    # Verifikasi jangkauan 600 mm benar tercapai: jarak maksimum TCP dari
    # sumbu J2 harus mendekati REACH_FROM_J2 (~604 mm) dan >= target 600 mm.
    import numpy as np

    from arm.kinematics import end_effector_position, joint_origins

    p_j2 = joint_origins([0, 0, 0, 0, 0, 0])[1]  # sumbu J2 konstan saat J1=0
    best = 0.0
    for th2 in range(-180, 181, 6):
        for th3 in range(-180, 181, 6):
            tcp = end_effector_position([0, th2, th3, 0, 0, 0])
            best = max(best, float(np.linalg.norm(tcp - p_j2)))
    assert best >= 0.600
    assert best == pytest.approx(C.REACH_FROM_J2, abs=0.01)


def test_as5600_only_on_stepper_joints():
    # Umpan balik FINAL: AS5600 hanya di J1..J4 (sendi stepper bergearbox).
    # J5/J6 servo memakai pot internal yang disadap ke ADC1 ESP32.
    enc = {j.name: j.encoder_type for j in C.JOINTS}
    assert enc == {
        "J1": C.ENC_AS5600,
        "J2": C.ENC_AS5600,
        "J3": C.ENC_AS5600,
        "J4": C.ENC_AS5600,
        "J5": C.ENC_SERVO_POT,
        "J6": C.ENC_SERVO_POT,
    }


def test_exactly_four_as5600_units():
    # Jumlah AS5600 yang dibeli/dipasang = 4, bukan 6. Mengunci BOM.
    assert len(C.AS5600_JOINTS) == 4
    assert [j.name for j in C.AS5600_JOINTS] == ["J1", "J2", "J3", "J4"]


def test_encoder_channels_unique():
    # Tiap AS5600 punya channel mux TCA9548A sendiri (0-3, tak boleh bentrok).
    chans = [j.encoder_chan for j in C.AS5600_JOINTS]
    assert sorted(chans) == list(range(4))


def test_servo_joints_have_no_mux_channel():
    # Sendi servo tidak lewat TCA9548A sama sekali -> channel harus None,
    # supaya kode yang mengiterasi mux tidak diam-diam ikut menyapu J5/J6.
    servo = [j for j in C.JOINTS if j.encoder_type == C.ENC_SERVO_POT]
    assert [j.name for j in servo] == ["J5", "J6"]
    assert all(j.encoder_chan is None for j in servo)


def test_as5600_resolution_uniform_at_output():
    # AS5600 12-bit (0.0879°) di output -> resolusi sama untuk J1..J4,
    # tak tergantung rasio reduksi (beda dengan encoder di poros motor).
    for j in C.AS5600_JOINTS:
        assert j.output_resolution_deg == pytest.approx(
            360.0 / C.AS5600_COUNTS_PER_REV, abs=1e-6
        )


def test_servo_pot_resolution_is_coarser_than_as5600():
    # Jalur pot+ADC1 jauh lebih kasar daripada AS5600; klaim "resolusi seragam
    # 0,088° di keenam sendi" tidak lagi benar dan tidak boleh muncul lagi.
    for j in C.JOINTS:
        if j.encoder_type != C.ENC_SERVO_POT:
            continue
        res = j.output_resolution_deg
        assert math.isfinite(res)
        assert res > C.AS5600_LSB_DEG


def test_only_geared_joints_carry_backlash():
    # Backlash gearbox hanya ada di sendi bereduksi. Servo direct drive
    # tidak boleh ikut diberi backlash di model error.
    geared = {j.name for j in C.JOINTS if j.has_gearbox}
    assert geared == {"J1", "J2", "J3", "J4"}
