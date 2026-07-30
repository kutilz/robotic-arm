"""Parameter fisik lengan robot 6-DOF.

Geometri (tabel DH, panjang link, offset) DIUKUR LANGSUNG dari file STEP
assembly CAD (`Testing Assembly.step`; koordinat global CAD, Z ke atas, satuan
mm dikonversi ke m di sini). Rasio reduksi dihitung dari jumlah pin ring
cycloidal di STEP. Faktor sizing dan model massa mengikuti dokumen arsitektur
(`docs/research/arsitektur_final_robotic_arm_6dof.md`).

Aktuator FINAL (dikonfirmasi user 2026-07-27):
    J1, J3, J4 : stepper 17HS2401  (holding 0.45 N.m, 1.7 A)
    J2         : stepper 17HS6401S (holding 0.70 N.m, 2.0 A)
    J5, J6     : servo MG996R direct drive
Transmisi FINAL:
    J1 belt HTD3M 2 stage 1:15 (12T->60T lalu 20T->60T)
    J2 cycloidal 1:30 (roller pin dowel 5 mm)
    J3 belt HTD3M 20T->60T (3:1) + cycloidal 1:10 = 1:30
    J4 cycloidal 1:15 (TENTATIVE)
    J5/J6 servo direct, tanpa reduksi
Umpan balik FINAL: 4x AS5600 di output J1..J4 via mux TCA9548A (channel 0-3);
J5/J6 memakai potensiometer internal servo yang disadap ke ADC1 ESP32.

File ini satu-satunya sumber konstanta fisik: skrip simulasi di `benchmarks/`
mengimpor dari sini, jangan hardcode ulang. Sinkron dengan
`studio/src/config/arm.js`.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

GRAVITY = 9.81  # m/s^2

# --- Faktor sizing dan derating (dokumen riset §1) -----------------------
RUNNING_TORQUE_FRACTION = 0.5   # torsi running = 0.5 x holding (derate stepper)
CYCLOIDAL_EFFICIENCY = 0.75     # efisiensi cycloidal cetak 3D (konservatif)
BELT_EFFICIENCY = 0.90          # efisiensi per stage transmisi belt HTD3M
SERVO_DUTY_FRACTION = 0.45      # derate stall servo direct-drive (selaras arm.js)
SAFETY_FACTOR = 2.5             # TARGET faktor dinamis dokumen (lihat catatan J2)

# --- Geometri DH terukur dari CAD (m) ------------------------------------
# Tabel DH standar, baris i = transform frame i-1 -> i, diukur dari
# Testing Assembly.step. Sumbu: J1 vertikal lewat (X=-4.5, Y=0); J2 sejajar Y
# lewat (X=-70.4, Z=64.8); J3 sejajar Y lewat (X=-57.9, Z=352.6).
#   i | d (mm) | a (mm) | alpha | sumber
#   1 |  64.8  |  65.9  |  +90  | d1 = tinggi J1->J2, a1 = offset lateral X J1->J2
#   2 |   0    | 288.1  |   0   | a2 = upper arm J2->J3 (dX=+12.5, dZ=+287.8)
#   3 |   0    |  50.0  |  -90  | a3 = offset perpendicular siku (TERUKUR CAD)
#   4 | 220    |   0    |  +90  | d4 = forearm (USULAN, mudah diubah)
#   5 |   0    |   0    |  -90  |
#   6 |  90    |   0    |   0   | d6 = wrist-center -> TCP (USULAN, mudah diubah)
D1_BASE = 0.0648             # J1 -> J2 arah vertikal (d1)
A1_SHOULDER_OFFSET = 0.0659  # offset lateral X J1 -> J2 (a1)
A2_UPPER_ARM = 0.2881        # J2 -> J3 (a2), panjang upper arm
A3_ELBOW_OFFSET = 0.050      # offset perpendicular di siku (a3), TERUKUR CAD
D4_FOREARM = 0.220           # panjang forearm (d4), USULAN, mudah diubah
D6_WRIST_TCP = 0.090         # wrist-center -> TCP (d6), USULAN, mudah diubah
LATERAL_Y_OFFSET = 0.060     # bidang drive lengan di Y ~ -60 mm dari sumbu J1

# Alias kompatibilitas panjang link (dipakai kode lama / studio).
UPPER_ARM_LEN = A2_UPPER_ARM
FOREARM_LEN = D4_FOREARM
WRIST_LEN = D6_WRIST_TCP
BASE_HEIGHT = D1_BASE

# Jangkauan maksimum dari sumbu J2 saat lengan terentang penuh:
#   a2 + sqrt(a3^2 + d4^2) + d6 = 0.604 m (target desain 0.60 m).
REACH_FROM_J2 = A2_UPPER_ARM + math.hypot(A3_ELBOW_OFFSET, D4_FOREARM) + D6_WRIST_TCP
TOTAL_REACH = REACH_FROM_J2  # alias target jangkauan


@dataclass(frozen=True)
class PointMass:
    """Massa titik terkumpul (lumped) sepanjang lengan.

    position_m = jarak horizontal dari sumbu bahu (J2) saat lengan
    terentang penuh horizontal (pose worst-case torsi gravitasi).
    """

    name: str
    mass_kg: float
    position_m: float


# Model massa (dari dokumen riset §2, jarak diukur dari J2). Payload 0.2 kg,
# J2 DIRECT (motor coaxial di pivot, tanpa belt); motor J3/J4 direlokasi
# proksimal (mengurangi beban gravitasi di J2/J3).
MASSES: list[PointMass] = [
    PointMass("upper_arm_link", 0.18, 0.14),
    PointMass("j3_motor_relokasi", 0.28, 0.08),
    PointMass("elbow_cycloidal", 0.15, 0.28),
    PointMass("j4_motor_relokasi", 0.226, 0.31),
    PointMass("j4_cycloidal", 0.10, 0.29),
    PointMass("forearm_link", 0.12, 0.395),
    PointMass("wrist_cluster_ee", 0.25, 0.53),
    PointMass("payload", 0.20, 0.60),
]

# Sendi pitch memikul momen gravitasi; nilainya = posisi sumbu dari J2 (m).
PITCH_JOINTS: dict[str, float] = {"J2": 0.0, "J3": UPPER_ARM_LEN, "J5": UPPER_ARM_LEN + FOREARM_LEN}

# Sendi roll/yaw ~0 momen gravitasi di pose ini; target output (N.m) dari
# pertimbangan inersia/friksi (dokumen riset §2).
INERTIA_JOINT_TARGETS_NM: dict[str, float] = {"J1": 3.0, "J4": 1.0, "J6": 0.3}


@dataclass(frozen=True)
class Motor:
    model: str
    holding_torque_nm: float
    is_servo: bool = False
    rated_current_a: float = 0.0   # arus fasa rated datasheet (0 = tidak berlaku)

    @property
    def running_torque_nm(self) -> float:
        return self.holding_torque_nm * RUNNING_TORQUE_FRACTION


# Katalog aktuator FINAL. Hanya motor yang benar-benar dipakai yang terdaftar:
# 17HS4401, 17HS6401, dan 17PM-K054 DIHAPUS supaya tidak ada dua angka torsi
# yang mirip namanya (17HS6401 0.60 vs 17HS6401S 0.70) hidup berdampingan.
# J2 tidak lagi pakai NEMA23 - cycloidal DIRECT single-motor supaya motor
# duduk coaxial di pivot shoulder, moment arm ~0.
# Holding torque dan arus dari datasheet yang dikonfirmasi user 2026-07-27.
MOTORS: dict[str, Motor] = {
    "17HS2401": Motor("17HS2401 (NEMA17 40mm)", 0.45, rated_current_a=1.7),
    "17HS6401S": Motor("17HS6401S (NEMA17 60mm)", 0.70, rated_current_a=2.0),
    "MG996R": Motor("MG996R (servo, stall @6V)", 1.08, is_servo=True),
}


# --- Position feedback (encoder) -----------------------------------------
# Dua jalur umpan balik yang BERBEDA, jangan disamakan:
#   J1..J4 : 4x AS5600 magnetik absolut di OUTPUT sendi (ikut mengukur
#            backlash gearbox). Alamat I2C sama (0x36), diakses lewat
#            multiplekser TCA9548A, channel 0-3.
#   J5..J6 : potensiometer internal servo MG996R disadap, dibaca lewat ADC1
#            internal ESP32 (GPIO 34/35). BUKAN AS5600, BUKAN ADS1115, dan
#            tidak memakai channel mux.
ENC_AS5600 = "as5600"        # absolut, dipasang di output sendi (J1..J4)
ENC_SERVO_POT = "servo_pot"  # pot internal servo -> ADC1 ESP32 (J5, J6)

# --- Sumber error sudut per sendi (untuk propagasi error posisi) ---------
AS5600_COUNTS_PER_REV = 4096            # 12-bit
AS5600_LSB_DEG = 360.0 / AS5600_COUNTS_PER_REV   # kuantisasi 0.0879 deg/LSB
AS5600_ACCURACY_DEG = 0.5               # akurasi absolut datasheet (+-0.5 deg)
# Backlash gearbox belum diukur di hardware -> parameter yang di-sweep.
# Hanya berlaku untuk sendi bergearbox (J1..J4); J5/J6 direct drive.
CYCLOIDAL_BACKLASH_DEG_DEFAULT = 0.5    # tengah rentang sweep default
CYCLOIDAL_BACKLASH_SWEEP_DEG = (0.3, 1.0)  # rentang sweep asumsi

# Jalur umpan balik servo J5/J6, angka diambil dari firmware
# (`firmware/arm_controller_esp32/arm_controller_esp32.ino`), bukan dikarang:
#   - ADC1 ESP32 12-bit, attenuation ADC_11db -> full scale ~3100 mV
#   - kalibrasi 2 titik `cal.servoFbMvMin/Max`, default span 1000 mV
#   - firmware melakukan oversampling 16x; itu menekan NOISE, bukan menambah
#     resolusi kuantisasi, jadi tidak dihitung sebagai perbaikan LSB.
SERVO_ADC_BITS = 12
SERVO_ADC_COUNTS = 2 ** SERVO_ADC_BITS          # 4096
SERVO_ADC_FULLSCALE_MV = 3100.0                 # ADC_11db, rentang ~0..3.1 V
SERVO_ADC_LSB_MV = SERVO_ADC_FULLSCALE_MV / SERVO_ADC_COUNTS  # ~0.757 mV/LSB
SERVO_ADC_OVERSAMPLE = 16
# PLACEHOLDER kalibrasi firmware, BUKAN hasil ukur. Ganti setelah kalibrasi
# 2 titik dijalankan di hardware; resolusi servo di bawah ikut berubah.
SERVO_FB_SPAN_MV_DEFAULT = 1000.0
# Akurasi absolut jalur servo (nonlinearitas ADC + deadband servo + drift pot)
# BELUM diukur. Sengaja NaN supaya tidak ada yang memakainya sebagai angka.
SERVO_FB_ACCURACY_DEG = float("nan")    # [ISI: akurasi absolut jalur servo]


# Tipe transmisi per sendi (selaras field `drive` di arm.js): menentukan
# efisiensi yang dipakai saat menghitung torsi output tersedia.
DRIVE_BELT = "belt"        # reduksi belt saja (J1)
DRIVE_CYC = "cyc"          # cycloidal direct (J2, J4)
DRIVE_CYC_BELT = "cyc-belt"  # cycloidal + 1 stage belt (J3)
DRIVE_SERVO = "servo"      # servo direct-drive, tanpa reduksi (J5, J6)


@dataclass(frozen=True)
class JointSpec:
    """Konfigurasi rekomendasi per sendi (dokumen riset §6)."""

    name: str
    motor_key: str
    ratio: float          # reduksi total (mis. 30 berarti 1:30)
    encoder_type: str     # ENC_AS5600 (J1..J4) atau ENC_SERVO_POT (J5, J6)
    encoder_chan: int | None   # channel mux TCA9548A; None untuk sendi servo
    description: str
    drive: str = DRIVE_CYC     # tipe transmisi (lihat DRIVE_*)
    belt_stages: int = 0       # jumlah stage belt (untuk efisiensi)

    @property
    def has_gearbox(self) -> bool:
        """Sendi bereduksi mekanik -> punya backlash yang perlu dimodelkan."""
        return self.drive != DRIVE_SERVO

    @property
    def counts_per_rev(self) -> float:
        """Count per putaran penuh sensor. NaN kalau tidak terdefinisi."""
        if self.encoder_type == ENC_AS5600:
            return float(AS5600_COUNTS_PER_REV)
        # Servo pot: ADC hanya melihat sebagian rentang tegangan pot, jadi
        # count per putaran penuh tidak punya arti. Pakai output_resolution_deg.
        return float("nan")

    @property
    def resolution_deg(self) -> float:
        """Resolusi sudut di sisi disk encoder (derajat per count)."""
        return 360.0 / self.counts_per_rev

    @property
    def output_resolution_deg(self) -> float:
        """Resolusi efektif di OUTPUT sendi (derajat per count).

        AS5600 dipasang di output sendi, jadi resolusinya sama dengan
        resolusi disk dan TIDAK tergantung rasio reduksi. Servo pot:
        kuantisasi ADC1 dipetakan ke rentang sudut sendi lewat kalibrasi
        2 titik firmware, jadi resolusinya beda per sendi dan jauh lebih
        kasar daripada AS5600.
        """
        if self.encoder_type == ENC_AS5600:
            return self.resolution_deg
        if self.encoder_type == ENC_SERVO_POT:
            lo, hi = JOINT_LIMITS_DEG[self.name]
            return (hi - lo) / SERVO_FB_SPAN_MV_DEFAULT * SERVO_ADC_LSB_MV
        return float("nan")

    @property
    def transmission_efficiency(self) -> float:
        """Efisiensi rantai transmisi (cycloidal x belt^stage). Servo = 1."""
        eff = 1.0
        if "cyc" in self.drive:
            eff *= CYCLOIDAL_EFFICIENCY
        if "belt" in self.drive:
            eff *= BELT_EFFICIENCY ** self.belt_stages
        return eff


# Rasio drivetrain FINAL (dikonfirmasi user 2026-07-27):
#   J1: belt HTD3M 2 stage, 12T->60T (5:1) lalu 20T->60T (3:1) = 1:15
#   J2: 30 pin dowel 5 mm di pin circle -> cycloidal 1:30
#   J3: belt HTD3M 20T->60T (3:1) lalu cycloidal 1:10 = 1:30
#   J4: cycloidal 1:15 -- TENTATIVE, masih bisa berubah. Kalau rasio ini
#       berubah, ikut perbarui studio/src/config/arm.js, firmware RATIO[],
#       Tabel 3.4 Bab III, dan jalankan ulang benchmarks/torque_map.py.
#   J5/J6: servo MG996R direct drive, tanpa reduksi.
JOINTS: list[JointSpec] = [
    JointSpec("J1", "17HS2401", 15, ENC_AS5600, 0, "base yaw", DRIVE_BELT, belt_stages=2),
    JointSpec("J2", "17HS6401S", 30, ENC_AS5600, 1, "shoulder pitch", DRIVE_CYC),
    JointSpec("J3", "17HS2401", 30, ENC_AS5600, 2, "elbow pitch", DRIVE_CYC_BELT, belt_stages=1),
    JointSpec("J4", "17HS2401", 15, ENC_AS5600, 3, "wrist roll", DRIVE_CYC),
    JointSpec("J5", "MG996R", 1, ENC_SERVO_POT, None, "wrist pitch", DRIVE_SERVO),
    JointSpec("J6", "MG996R", 1, ENC_SERVO_POT, None, "end roll", DRIVE_SERVO),
]

# Sendi yang benar-benar punya AS5600 + channel mux (dipakai tes dan simulasi).
AS5600_JOINTS: list[JointSpec] = [j for j in JOINTS if j.encoder_type == ENC_AS5600]


# --- Batas sudut sendi (deg) ---------------------------------------------
# ASUMSI: hard-stop mekanik belum ditetapkan dari CAD. Dipakai rentang
# terdokumentasi di studio/src/config/arm.js sebagai default (dikonfirmasi
# user 2026-07-24). Konvensi sudut = tabel DH (pose nol: upper arm +X,
# forearm +Z). Tinjau ulang setelah hard-stop mekanik final ditentukan.
JOINT_LIMITS_DEG: dict[str, tuple[float, float]] = {
    "J1": (-180.0, 180.0),   # base yaw
    "J2": (-95.0, 95.0),     # shoulder pitch
    "J3": (-150.0, 150.0),   # elbow pitch
    "J4": (-180.0, 180.0),   # wrist roll
    "J5": (-120.0, 120.0),   # wrist pitch
    "J6": (-180.0, 180.0),   # end roll
}


ENCODER_LABEL: dict[str, str] = {
    ENC_AS5600: "AS5600",
    ENC_SERVO_POT: "pot+ADC1",
}


def print_encoder_map() -> None:
    """Cetak peta encoder + resolusi efektif per sendi."""
    print(f"{'Sendi':<5} {'Encoder':<9} {'Channel':>7} {'Res.out':>9}")
    print("-" * 33)
    for j in JOINTS:
        label = ENCODER_LABEL.get(j.encoder_type, j.encoder_type)
        chan = "-" if j.encoder_chan is None else str(j.encoder_chan)
        print(
            f"{j.name:<5} {label:<9} {chan:>7} "
            f"{j.output_resolution_deg:>7.4f}d"
        )


if __name__ == "__main__":
    print_encoder_map()
