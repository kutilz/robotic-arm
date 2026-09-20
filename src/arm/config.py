"""Parameter fisik lengan robot 6-DOF.

Geometri (tabel DH, panjang link, offset) DIUKUR LANGSUNG dari file STEP
assembly CAD (`Main Assembly (Complete).step`; koordinat global CAD, Z ke atas,
satuan mm dikonversi ke m di sini). Rasio reduksi dihitung dari jumlah pin ring
cycloidal dan jumlah gigi pulley di STEP. Faktor sizing dan model massa
mengikuti dokumen arsitektur
(`docs/research/arsitektur_final_robotic_arm_6dof.md`).

Angka geometri terakhir di-rebase 2026-08-03 ke assembly CAD FINAL
`Main Assembly (Complete)` (94 part, penamaan jelas + mate connector lengkap).
Jalankan `python tools/measure_cad_geometry.py "onshape/Main Assembly (Complete).step"`
untuk mengukur ulang dari STEP kalau desain berubah lagi; bagian akhir
keluarannya membandingkan hasil ukur dengan angka di file ini.

Angka di sini harus sama dengan `studio/src/model/cadRig.js`, yang mengukur
rakitan yang sama lewat jalur berbeda (fit mesh GLB, bukan lingkaran STEP).
Per rev 2026-08-03 kedua jalur cocok dalam 0.25 mm di semua besaran.

Aktuator FINAL (dikonfirmasi user 2026-07-27):
    J1, J3, J4 : stepper 17HS2401  (holding 0.45 N.m, 1.7 A)
    J2         : stepper 17HS6401S (holding 0.70 N.m, 2.0 A)
    J5, J6     : servo MG996R direct drive
                 (gripper MG90S di luar 6 DOF, tidak masuk JOINTS)
Transmisi FINAL:
    J1 belt HTD3M 2 stage 1:15 (12T->60T lalu 20T->60T)
    J2 cycloidal 1:30 (roller pin dowel 5 mm)
    J3 belt HTD3M 20T->60T (3:1) + cycloidal 1:10 = 1:30
    J4 cycloidal 1:15 (dikonfirmasi CAD final, tidak lagi tentatif)
    J5/J6 servo direct, tanpa reduksi
Keenam rasio di atas terverifikasi dari CAD final: pin ring cycloidal
J2=30 @R38, J3=10 @R30, J4=15 @R35; gigi pulley 12/60 dan 20/60 (J1),
20/60 (belt J3).
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
# Tabel DH standar, baris i = transform frame i-1 -> i. Diukur ulang dari
# assembly CAD FINAL (rev 2026-07-30, lengan sudah tercetak penuh) dengan
# `tools/measure_cad_geometry.py`: sumbu sendi di-fit dari pusat lingkaran
# bearing/pin di STEP, bukan dari bounding box.
#
# Sumbu hasil fit (frame global CAD, mm), rev 2026-08-03:
#   J1 arah (0, 0, 1)                    lewat (   0.00,   0.00,  42.31)
#   J2 arah (0, 1, 0)                    lewat ( -65.85, -65.29,  72.80)
#   J3 arah (0, 1, 0)                    lewat ( -65.61, -73.03, 360.80)
#   J4 arah ( 0.000847, 0, 1)            lewat ( -65.55, -12.46, 425.17)
#   J5 arah ( 0.998615,-0.052600,-0.0008) lewat (-65.30, -12.46, 630.56)
#   J6 arah ( 0.001923, 0.052572,-0.9986) lewat (-65.70, -17.25, 721.72)
#   wrist center = (-65.301, -12.463, 630.562)
#
#   i | d (mm) | a (mm) | alpha | sumber
#   1 |  72.80 |  65.85 |  +90  | d1 = tinggi J1->J2, a1 = offset lateral X J1->J2
#   2 |   0    | 288.00 |   0   | a2 = upper arm J2->J3 (common normal, 2 sumbu //Y)
#   3 | -12.46 |   0.00 |  -90  | a3 = 0: sumbu J3 & J4 BERPOTONGAN (dulu 50 mm);
#     |        |        |       | d3 = geseran lateral Y bidang forearm vs base
#   4 | 269.76 |   0    |  +90  | d4 = forearm, dari titik potong J3xJ4 ke wrist center
#   5 |   0    |   0    |  -90  | J4/J5/J6 concurrent (lihat CATATAN PIEPER)
#   6 |  90.55 |   0    |   0   | d6 = wrist center -> permukaan flange gripper
#
# CATATAN PIEPER (kriteria closed-form IK): jarak common normal terukur
# J4-J5 = 0.000 mm, J5-J6 = 0.000 mm, J4-J6 = 0.150 mm. Ketiga sumbu praktis
# berpotongan di satu titik (wrist center) -> Pieper terpenuhi di CAD.
#
# d6 = jarak ke PERMUKAAN FLANGE gripper (lingkaran Ø50 terukur), bukan ke
# titik cengkeram. Badan gripper masih menjulur ~84 mm lagi di luar flange,
# dan sisa itu dimodelkan terpisah lewat TOOL_TCP_FROM_FLANGE di bawah.
D1_BASE = 0.07280            # J1 -> J2 arah vertikal (d1)
A1_SHOULDER_OFFSET = 0.06585  # offset lateral X J1 -> J2 (a1)
A2_UPPER_ARM = 0.28800       # J2 -> J3 (a2), panjang upper arm
A3_ELBOW_OFFSET = 0.0        # a3 = 0: sumbu J3 dan J4 berpotongan di CAD FINAL
D3_ELBOW_LATERAL = -0.012463  # d3, geseran lateral bidang forearm vs bidang base
D4_FOREARM = 0.269762        # panjang forearm (d4), TERUKUR CAD
D6_WRIST_TCP = 0.09055       # wrist-center -> muka flange gripper (d6), TERUKUR CAD
# Dulu parameter tambal (0.060) karena d3 dipaksa 0 di tabel DH. Sekarang
# geseran lateralnya dimodelkan langsung lewat D3_ELBOW_LATERAL, jadi nilai
# ini cuma besarannya saja - jangan dipakai lagi untuk mengoreksi hasil DH.
LATERAL_Y_OFFSET = abs(D3_ELBOW_LATERAL)

# --- Frame tool: flange -> TCP -------------------------------------------
# Tabel DH BERHENTI DI MUKA FLANGE, dan gripper diperlakukan sebagai tool yang
# dipasang di atasnya. Alasannya bukan kerapian: gripper itu bagian yang bisa
# diganti. Kalau d6 menelan gripper, tiap ganti gripper harus mengubah tabel
# DH, firmware, dan digital twin sekaligus. Dengan DH berhenti di flange, ganti
# gripper cuma menyentuh satu transform di bawah ini. Itu juga sebabnya tiap
# controller robot industri punya tool frame terpisah.
#
# Dinyatakan di frame J6: origin = pusat pergelangan, z' = sumbu J6,
# x' = sumbu J5, y' = z' x x'. Sama persis dengan CAD_TCP_J6 di
# studio/src/model/cadRig.js, yang mengukur dari PUSAT PERGELANGAN:
#   CAD_TCP_J6 = (-0.80, 15.74, 174.23) mm
# Komponen z' di bawah = 174.23 - 90.55 = 83.68 mm, yaitu sisa julur gripper
# di luar muka flange. Dua komponen lainnya memang offset lateral, jadi TCP
# tidak berada di sumbu J6 dan tidak boleh diwakili satu skalar `along` saja.
TOOL_TCP_FROM_FLANGE = (-0.00080, 0.01574, 0.08368)  # (x', y', z') meter

# Jarak lurus pusat pergelangan -> TCP (ujung wedge jaw saat tertutup). Ini
# yang dipakai statika sebagai lengan momen payload, BUKAN d6. Endpoint d6
# urusan pembukuan kinematika; letak massa payload urusan statika, dan
# keduanya bebas satu sama lain.
WRIST_TO_TCP = math.dist(
    (0.0, 0.0, 0.0),
    (TOOL_TCP_FROM_FLANGE[0], TOOL_TCP_FROM_FLANGE[1],
     TOOL_TCP_FROM_FLANGE[2] + D6_WRIST_TCP),
)

# Alias kompatibilitas panjang link (dipakai kode lama / studio).
UPPER_ARM_LEN = A2_UPPER_ARM
FOREARM_LEN = D4_FOREARM
WRIST_LEN = D6_WRIST_TCP
BASE_HEIGHT = D1_BASE

# Jangkauan maksimum dari sumbu J2 saat lengan terentang penuh. Ada DUA angka
# dan keduanya dipakai di tempat berbeda, jadi jangan dicampur:
#   REACH_FROM_J2     ke MUKA FLANGE, a2 + sqrt(a3^2 + d4^2) + d6 = 0.6483 m
#   REACH_FROM_J2_TCP ke TCP ujung jaw, memakai WRIST_TO_TCP      = 0.7325 m
# Angka pertama batas rantai DH (yang dipakai IK); angka kedua yang dilihat
# orang sebagai "jangkauan lengan" dan yang muncul di gambar lengan-dimensi.
# Keduanya NAIK dari 0.604 m di dokumen riset lama: forearm CAD final 269.8 mm
# (dulu diasumsikan 220 mm) dan offset siku a3 50 mm ternyata tidak ada.
REACH_FROM_J2 = A2_UPPER_ARM + math.hypot(A3_ELBOW_OFFSET, D4_FOREARM) + D6_WRIST_TCP
REACH_FROM_J2_TCP = A2_UPPER_ARM + math.hypot(A3_ELBOW_OFFSET, D4_FOREARM) + WRIST_TO_TCP
TOTAL_REACH = REACH_FROM_J2  # alias target jangkauan (rantai DH, ke flange)


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
#
# NILAI MASSA masih ESTIMASI dokumen riset - BELUM ditimbang. Lengan sekarang
# sudah tercetak penuh, jadi langkah berikutnya: timbang tiap part dan ganti
# angka kg di bawah (dokumen riset §9 sudah mewanti-wanti tau_J2 berskala
# langsung dengan ini).
#
# POSISI di-rebase ke panjang link CAD final: fraksi sepanjang link dijaga
# persis sama dengan dokumen riset (yang memakai upper 280 / forearm 230 /
# wrist-EE 90 mm), lalu dikalikan panjang terukur. Ditulis sebagai rumus, bukan
# angka mati, supaya ikut bergerak sendiri kalau geometri CAD berubah lagi.
_ELBOW_FROM_J2 = A2_UPPER_ARM                  # sumbu J3
_WRIST_FROM_J2 = _ELBOW_FROM_J2 + D4_FOREARM   # wrist center (J4=J5=J6)
MASSES: list[PointMass] = [
    PointMass("upper_arm_link", 0.18, 0.5000 * A2_UPPER_ARM),        # 140/280
    PointMass("j3_motor_relokasi", 0.28, 0.2857 * A2_UPPER_ARM),     #  80/280
    PointMass("elbow_cycloidal", 0.15, _ELBOW_FROM_J2),              # di sumbu J3
    PointMass("j4_motor_relokasi", 0.226, _ELBOW_FROM_J2 + 0.1304 * D4_FOREARM),   #  30/230
    PointMass("j4_cycloidal", 0.10, _ELBOW_FROM_J2 + 0.0435 * D4_FOREARM),         #  10/230
    PointMass("forearm_link", 0.12, _ELBOW_FROM_J2 + 0.5000 * D4_FOREARM),         # 115/230
    PointMass("wrist_cluster_ee", 0.25, _ELBOW_FROM_J2 + 1.0870 * D4_FOREARM),     # 250/230
    # Payload duduk di TCP (ujung wedge jaw), bukan di muka flange. Benda yang
    # dicengkeram memang ada di ujung jaw, jadi lengan momennya WRIST_TO_TCP.
    # Ini keputusan STATIKA dan sengaja tidak ikut endpoint d6, yang cuma
    # pembukuan kinematika. Efeknya: lengan momen J2 648.3 -> 732.1 mm dan
    # tau_J2 naik sekitar 3 persen, tidak mengubah pemilihan motor mana pun.
    PointMass("payload", 0.20, _WRIST_FROM_J2 + WRIST_TO_TCP),
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
    # Badan diukur jangka sorong 4 Agu 2026: 43 mm (bukan 24 mm seperti yang
    # sempat dikhawatirkan dari penomoran seri). Resistansi fasa 1.85 ohm.
    "17HS2401": Motor("17HS2401 (NEMA17, 43 mm)", 0.45, rated_current_a=1.7),
    "17HS6401S": Motor("17HS6401S (NEMA17 60mm)", 0.70, rated_current_a=2.0),
    "MG996R": Motor("MG996R (servo, stall @6V)", 1.08, is_servo=True),
}


# --- Position feedback (encoder) -----------------------------------------
# Dua jalur umpan balik yang BERBEDA, jangan disamakan:
#   J1..J4 : 4x AS5600 magnetik absolut di OUTPUT sendi (ikut mengukur
#            backlash gearbox). Alamat I2C sama (0x36), diakses lewat
#            multiplekser TCA9548A, channel 0-3.
#   J5..J6 : potensiometer internal servo MG996R dibaca lewat ADS1115 (ADC
#            eksternal 16-bit, alamat 0x48) yang menumpang bus I2C yang sama
#            dengan mux. BUKAN AS5600, BUKAN ADC internal ESP32, dan tidak
#            memakai channel mux. Gripper MG90S ikut jalur ini (kanal A2),
#            tapi tidak masuk JOINTS karena bukan derajat kebebasan.
ENC_AS5600 = "as5600"        # absolut, dipasang di output sendi (J1..J4)
ENC_SERVO_POT = "servo_pot"  # pot internal servo -> ADS1115 (J5, J6)

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
#   J4: 15 pin roller di pin circle R35 -> cycloidal 1:15. Terkonfirmasi dari
#       CAD final 2026-07-30 (status TENTATIVE dicabut). Kalau rasio ini
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
    "J2": (-90.0, 90.0),     # shoulder pitch, DITETAPKAN di lengan terakit
                             # 12 Agu 2026 (+-90 dari home tegak atas), bukan
                             # lagi asumsi rancangan +-95
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
