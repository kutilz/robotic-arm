"""Ukur massa tiap part cetak dari proyek slicer + posisinya dari STEP assembly.

Kenapa ada: `src/arm/config.py` memodelkan massa lengan sebagai delapan titik
massa hasil ESTIMASI dokumen riset, belum pernah ditimbang. Lengan sudah
tercetak penuh tapi tidak ada timbangan yang cukup teliti. Skrip ini menggantikan
timbangan: massa tiap part dihitung dari geometri mesh + profil print, lalu
DIKALIBRASI ke satu angka yang dilaporkan slicer (total filament seluruh plate).

    python tools/measure_print_mass.py [--total-g 1054.36]

Kenapa tidak pakai satu density efektif untuk semua part: tidak bisa. Rasio
volume/luas-permukaan tiap part beda jauh, jadi density efektifnya terentang
0.50 sampai 1.26 g/cm3. Part gempal berongga (pulley, disk) turun ke 0.50-0.75,
part tipis dan part kecil habis dimakan wall + top/bottom shell sehingga nyaris
padat. Memakai satu konstanta bikin error puluhan persen di part individual.

Modelnya satu parameter, tebal shell efektif t:

    massa = rho_filament * (shell + infill * core)
    shell = min(luas_permukaan * t, volume)
    core  = volume - shell

t dicari dengan bisection sampai total 74 part = angka slicer. Nilai
terkalibrasi ~1.067 mm, wajar terhadap nominal 2 wall (0.42+0.45 = 0.87 mm):
selisihnya sumbangan top 6 layer dan bottom 4 layer.

Lokasi tiap part diambil dari STEP assembly, bukan dari 3mf. File 3mf cuma tahu
part digeletakkan di plate mana, tidak tahu posisinya di lengan. Ini penting:
`J1 Flange` adalah part terberat (141.8 g) tapi duduk di BAWAH J2, jadi tidak
menyumbang sama sekali ke torsi bahu.

Verifikasi yang sudah lulus (rev 2026-07-31):
  * 87 instance STEP dikurangi 13 part beli (4 stepper, 2 MG996R, 1 MG90S,
    3 Aluminum 2020, 3 belt) = 74, persis sama dengan jumlah objek di 3mf,
    dan himpunan namanya identik.
  * Volume mesh Cycloid Disk J2 = 19370 mm3 vs volume B-rep Onshape
    19362.441 mm3, meleset 0.04% (galat tesselasi). Dasar volume seluruh
    tabel tervalidasi.

BATASAN yang diketahui, untuk nama part yang berulang (mis. enam `Cycloid Disk`):
pemasangan objek-3mf ke instance-STEP dicocokkan lewat ukuran. Dua jebakan sudah
ditangani, satu belum.

  1. SUDAH: bbox min/max dari awan titik STEP tidak andal karena memuat titik
     kendali B-spline yang melayang di luar geometri (disk OD 57.5 mm terbaca
     116 mm). Diganti persentil 1-99, hasilnya cocok dalam ~1 mm.
  2. SUDAH : sebagian instance STEP memuat lebih dari satu solid body sehingga
     tebalnya berlipat (disk J4 terbaca 14.1 mm padahal keping cetaknya 6.0 mm).
     Pencocokan karena itu hanya memakai DUA DIMENSI TERBESAR, bukan tebal.
  3. BELUM: bbox tetap bergantung orientasi, dan part diputar saat di-print,
     jadi bbox di plate tidak sebanding dengan bbox di assembly untuk part yang
     tidak simetris. Perbaikan yang tepat adalah mengukur bbox pada frame sumbu
     utama (PCA) awan titik supaya kebal rotasi. Sampai itu dikerjakan, angka
     "selisih ukuran" yang dicetak hanyalah diagnostik lemah.

Agregat per grup dan tau_J2/J3/J5 sudah dicocokkan dengan hitungan manual dan
sama persis, jadi kesimpulan tingkat link aman dipakai. Baris per-part untuk
nama yang berulang perlu dicek dulu sebelum dikutip di skripsi.
"""

from __future__ import annotations

import argparse
import collections
import json
import math
import re
import sys
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "tools"))
sys.path.insert(0, str(REPO / "src"))
import measure_cad_geometry as M  # noqa: E402  (dipakai untuk parser STEP)
from arm import config as C  # noqa: E402  (satu-satunya sumber geometri)

DEFAULT_3MF = REPO / "onshape" / "3d print robot arm.3mf"
# JANGAN ganti ke "Main Assembly (Complete).step". Berkas 3mf di atas di-slice
# dari export "Testing Assembly", dan pemasangan part 3mf ke instance STEP
# dilakukan lewat NAMA. Rakitan final menamai ulang banyak part, sehingga
# hanya 31 dari 74 objek yang berpasangan dan tiga grup distal jadi kosong.
# Keduanya rakitan fisik yang sama; yang berbeda cuma penamaan dan pose export.
DEFAULT_STEP = REPO / "onshape" / "Testing Assembly.step"
# Total filament MODEL (bukan termasuk support) seluruh plate, dari Bambu Studio.
# Support terukur 2.83 g dari 1057.20 g total, yaitu 0.27%, jadi diabaikan.
DEFAULT_TOTAL_G = 1054.36

GRAVITY = 9.81

# Part yang dibeli, bukan dicetak. Dikenali dari nama instance di STEP.
BOUGHT_RE = re.compile(r"Nema|MG996R|MG90S|Aluminum|Belt")
# Massa part beli (kg). ASUMSI datasheet, BELUM ditimbang atau diverifikasi.
# Lihat CATATAN MOTOR di bawah sebelum memakai angka 17HS2401.
BOUGHT_KG = {
    "Nema 17HS2401": 0.28,
    "Nema 17HS6401S": 0.60,
    "MG996R": 0.055,
    "MG90S": 0.0134,
}
# CATATAN MOTOR (belum tuntas per 2026-07-31): config.py menyebut 17HS2401
# sebagai NEMA17 40mm dengan holding 0.45 N.m, tapi kode "24" pada 17HS2401
# lazimnya berarti badan 24 mm, dan motor 24 mm umumnya cuma ~0.13 N.m dan
# ~0.15 kg. config.py sendiri tidak konsisten: memberi 0.28 kg ke motor J3 dan
# 0.226 kg ke motor J4 padahal keduanya model yang sama. Ukur panjang badan
# motor fisik dengan jangka sorong sebelum angka di sini dipercaya.

# Dowel SS304 Ø5 x 20 mm, dikonfirmasi user 2026-07-31. Massa per batang
# = pi * 2.5^2 * 20 * 0.008 = pi gram tepat (kebetulan, karena rho = 8.0).
DOWEL_G = math.pi * 2.5**2 * 20 * 0.008 / 1.0
DOWEL_COUNT = {"J2": 30 + 6, "J3": 10 + 6, "J4": 15 + 6}  # pin ring + pin output

# Density filament dan setelan infill dibaca dari profil di 3mf, bukan dihardcode.
# Yang di bawah cuma fallback kalau key-nya tidak ketemu.
FALLBACK_RHO = 1.26
FALLBACK_INFILL = 0.15

# Sumbu sendi dalam koordinat global export "Testing Assembly" (mm). HARUS
# sepose dengan DEFAULT_STEP di atas, karena dipakai untuk memproyeksikan
# centroid part dari STEP yang sama ke sepanjang lengan. Jangan diganti dengan
# koordinat rakitan final: itu export lain dengan pose lain, dan mencampur
# centroid pose lama dengan sumbu pose baru menghasilkan lengan momen yang
# tidak berarti apa-apa.
J2P = (-70.35, 0.0, 64.84)
J3P = (-54.74, 0.0, 352.42)
J5P = (-321.25, -11.88, 309.14)
D6_FLANGE = C.D6_WRIST_TCP * 1000     # wrist center -> muka flange gripper (mm)
WRIST_TO_TCP = C.WRIST_TO_TCP * 1000  # wrist center -> TCP ujung jaw (mm)
PAYLOAD_KG = 0.20

# Ambang selisih ukuran mesh-cetak vs STEP yang masih dianggap pasangan sah.
FIT_TOL = 0.05


# --------------------------------------------------------------------------
# geometri mesh 3mf
# --------------------------------------------------------------------------
_VERT = re.compile(r'<vertex x="([-\d.eE+]+)" y="([-\d.eE+]+)" z="([-\d.eE+]+)"')
_TRI = re.compile(r'<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"')


def mesh_props(z: zipfile.ZipFile, path: str):
    """Volume (mm3), luas (mm2), dan dimensi bbox terurut satu mesh."""
    txt = z.read(path.lstrip("/")).decode("utf-8", errors="replace")
    v = [(float(a), float(b), float(c)) for a, b, c in _VERT.findall(txt)]
    dims = sorted(max(p[i] for p in v) - min(p[i] for p in v) for i in range(3))
    vol = area = 0.0
    for ia, ib, ic in _TRI.findall(txt):
        p, q, r = v[int(ia)], v[int(ib)], v[int(ic)]
        vol += (p[0] * (q[1] * r[2] - q[2] * r[1])
                - p[1] * (q[0] * r[2] - q[2] * r[0])
                + p[2] * (q[0] * r[1] - q[1] * r[0])) / 6.0
        u = (q[0] - p[0], q[1] - p[1], q[2] - p[2])
        w = (r[0] - p[0], r[1] - p[1], r[2] - p[2])
        cx, cy, cz = (u[1] * w[2] - u[2] * w[1],
                      u[2] * w[0] - u[0] * w[2],
                      u[0] * w[1] - u[1] * w[0])
        area += 0.5 * math.sqrt(cx * cx + cy * cy + cz * cz)
    return abs(vol), area, dims


def read_3mf(path: Path):
    """[(nama, volume mm3, luas mm2)] + (rho filament, fraksi infill) dari profil."""
    z = zipfile.ZipFile(path)
    root = z.read("3D/3dmodel.model").decode("utf-8", errors="replace")
    ms = z.read("Metadata/model_settings.config").decode("utf-8", errors="replace")
    cfg = json.loads(z.read("Metadata/project_settings.config").decode("utf-8"))

    rho = float(cfg.get("filament_density", [FALLBACK_RHO])[0])
    infill = float(str(cfg.get("sparse_infill_density", "15%")).rstrip("%")) / 100.0

    path_of = {}
    for m in re.finditer(
            r'<object id="(\d+)"[^>]*>\s*<components>\s*<component[^>]*p:path="([^"]+)"',
            root, re.S):
        path_of[int(m.group(1))] = m.group(2)

    name_of = {}
    for blk in re.split(r"(?=<object id=)", ms):
        mid = re.match(r'<object id="(\d+)"', blk)
        if not mid:
            continue
        mn = re.search(r'<metadata key="name" value="([^"]+)"', blk)
        name_of[int(mid.group(1))] = mn.group(1) if mn else "?"

    out = []
    for oid, p in sorted(path_of.items()):
        vol, area, dims = mesh_props(z, p)
        nm = name_of.get(oid, "?").replace("Testing Assembly - ", "").replace(".stl", "")
        out.append(dict(name=nm, base=re.sub(r"\s*\(\d+\)$", "", nm).strip(),
                        V=vol, A=area, dims=dims))
    return out, rho, infill


# --------------------------------------------------------------------------
# lokasi part dari STEP
# --------------------------------------------------------------------------
_SKIP = {"DIRECTION", "CARTESIAN_POINT"}


def _robust_dims(pts, lo=0.01, hi=0.99):
    """Dimensi bbox terurut, memakai persentil bukan min/max.

    Awan titik STEP memuat titik kendali B-spline yang melayang jauh di luar
    geometri sebenarnya: disk ber-OD 57.5 mm pernah terbaca bbox 116 mm kalau
    dipakai min/max mentah. Pemangkasan 1% di tiap ujung membuang outlier itu
    dan mengembalikan dimensi yang cocok dengan mesh cetak dalam ~1 mm.
    """
    out = []
    for i in range(3):
        v = sorted(p[i] for p in pts)
        n = len(v)
        out.append(v[min(n - 1, int(hi * n))] - v[int(lo * n)])
    return sorted(out)


def step_instances(path: Path):
    """[(nama, centroid mm, dimensi bbox robust mm)] tiap instance di assembly."""
    step = M.Step(path)
    out = []
    for label, frame, geo in step.instances():
        o, fx, fy, fz = frame
        seen, stack, pts = set(), [geo], []
        while stack:
            e = stack.pop()
            if e in seen:
                continue
            seen.add(e)
            t = step.type_of(e)
            if t == "CARTESIAN_POINT":
                val = step._floats(e)
                if len(val) >= 3:
                    q = val[-3:]
                    pts.append(tuple(
                        (o[i] + q[0] * fx[i] + q[1] * fy[i] + q[2] * fz[i]) * 1000.0
                        for i in range(3)))
                continue
            if t in _SKIP:
                continue
            stack.extend(step.refs(e))
        if not pts:
            continue
        n = len(pts)
        out.append((label, tuple(sum(p[i] for p in pts) / n for i in range(3)),
                    _robust_dims(pts)))
    return out


# --------------------------------------------------------------------------
# rantai kinematik
# --------------------------------------------------------------------------
def _sub(a, b): return tuple(a[i] - b[i] for i in range(3))
def _dot(a, b): return sum(a[i] * b[i] for i in range(3))


def _nrm(v):
    n = math.sqrt(_dot(v, v))
    return tuple(x / n for x in v)


U2 = _nrm(_sub(J3P, J2P))                       # arah upper arm
U3 = _nrm(_sub(J5P, J3P))                       # arah forearm
A2 = math.sqrt(_dot(_sub(J3P, J2P), _sub(J3P, J2P)))
D4 = math.sqrt(_dot(_sub(J5P, J3P), _sub(J5P, J3P)))


def group_of(c):
    """Link tempat part menempel, dari centroid-nya di koordinat global CAD."""
    x, y, z = c
    if z < 95 and abs(y) < 25:
        return "BASE"          # base + drivetrain J1, tidak dibawa J2
    if x < -300:
        return "W"             # cluster pergelangan J5/J6 + gripper
    if x < -150:
        return "F"             # forearm distal
    if x < -85:
        return "J4"            # gearbox J4
    if z > 300:
        return "E"             # siku J3
    return "U"                 # upper arm


DISTAL_OF_J3 = {"E", "J4", "F", "W"}
ORDER = ["BASE", "U", "E", "J4", "F", "W"]
LABEL = {
    "BASE": "BASE (tak dibawa J2)", "U": "L2 upper arm", "E": "L3 elbow",
    "J4": "J4 gearbox", "F": "L4 forearm", "W": "L5/L6 wrist + gripper",
}


def arm_from_J2(c, distal):
    """Lengan momen terhadap J2 saat lengan terentang horizontal penuh (mm).

    Untuk part di hilir J3 dipakai koordinat sepanjang rantai (a2 + jarak
    sepanjang forearm), bukan jarak pada pose CAD. Pose CAD lengannya setengah
    terlipat, jadi momennya kekecilan dan bukan worst case.
    """
    if distal:
        return A2 + _dot(_sub(c, J3P), U3)
    return _dot(_sub(c, J2P), U2)


def _fit_cost(part_dims, inst_dims):
    """Selisih relatif ukuran, HANYA dua dimensi terbesar.

    Dimensi terkecil (tebal) sengaja diabaikan: sebagian instance STEP memuat
    lebih dari satu solid body sehingga tebalnya berlipat, sementara mesh cetak
    selalu satu keping. Contoh terukur: dua instance `Cycloid Disk` di J4 tebal
    14.1 mm padahal disk cetaknya 6.0 mm, sedangkan OD-nya cocok dalam 1 mm.
    Mencocokkan lewat OD kebal terhadap anomali itu.
    """
    num = 0.0
    for pd, idm in zip(part_dims[1:], inst_dims[1:]):
        num += abs(pd - idm) / max(pd, idm, 1e-9)
    return num / 2.0


def _assign(ps, ins):
    """Pasangkan part cetak ke instance STEP dalam satu grup nama.

    Grup kecil (<= 7) diselesaikan brute force, sisanya greedy. Pencocokan lewat
    ukuran, bukan lewat urutan kemunculan: urutan instance di file STEP tidak
    berhubungan sama sekali dengan urutan objek di 3mf.
    """
    import itertools
    if len(ps) != len(ins):
        n = min(len(ps), len(ins))
        ps, ins = ps[:n], ins[:n]
    idx = range(len(ps))
    if len(ps) <= 7:
        best = min(itertools.permutations(idx),
                   key=lambda pm: sum(_fit_cost(ps[i]["dims"], ins[pm[i]][2])
                                      for i in idx))
    else:
        best, taken = [], set()
        for i in idx:
            j = min((j for j in idx if j not in taken),
                    key=lambda j: _fit_cost(ps[i]["dims"], ins[j][2]))
            taken.add(j)
            best.append(j)
    return [(ps[i], ins[best[i]][1], ins[best[i]][2],
             _fit_cost(ps[i]["dims"], ins[best[i]][2])) for i in idx]


# --------------------------------------------------------------------------
def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--3mf", dest="tmf", type=Path, default=DEFAULT_3MF)
    ap.add_argument("--step", type=Path, default=DEFAULT_STEP)
    ap.add_argument("--total-g", type=float, default=DEFAULT_TOTAL_G,
                    help="total filament MODEL semua plate dari slicer (gram)")
    args = ap.parse_args(argv)

    parts, rho, infill = read_3mf(args.tmf)
    print(f"profil print: rho filament {rho} g/cm3, infill {infill:.0%}")
    print(f"{len(parts)} objek cetak di 3mf, kalibrasi ke {args.total_g} g\n")

    def total(t):
        s = 0.0
        for p in parts:
            shell = min(p["A"] * t, p["V"])
            s += rho * (shell + infill * (p["V"] - shell)) / 1000.0
        return s

    lo, hi = 0.01, 20.0
    for _ in range(200):
        mid = (lo + hi) / 2
        if total(mid) < args.total_g:
            lo = mid
        else:
            hi = mid
    t_shell = (lo + hi) / 2

    for p in parts:
        shell = min(p["A"] * t_shell, p["V"])
        p["m"] = rho * (shell + infill * (p["V"] - shell)) / 1000.0
        p["rho_eff"] = p["m"] / (p["V"] / 1000.0)

    vtot = sum(p["V"] for p in parts) / 1000.0
    print(f"tebal shell efektif terkalibrasi = {t_shell:.3f} mm "
          f"(nominal 2 wall = 0.87 mm)")
    print(f"volume total = {vtot:.1f} cm3, kalau padat = {vtot * rho:.1f} g")
    print(f"fraksi padat rata-rata = {args.total_g / (vtot * rho):.3f}\n")

    all_inst = step_instances(args.step)
    inst = [t for t in all_inst if not BOUGHT_RE.search(t[0])]
    a = collections.Counter(p["base"] for p in parts)
    b = collections.Counter(t[0] for t in inst)
    if a == b:
        print(f"OK: {len(inst)} part cetak di STEP, nama dan jumlahnya "
              f"identik dengan 3mf\n")
    else:
        print("PERINGATAN: nama part 3mf dan STEP tidak cocok:")
        for k in sorted(set(a) | set(b)):
            if a.get(k, 0) != b.get(k, 0):
                print(f"   {k:<24} 3mf={a.get(k, 0)} step={b.get(k, 0)}")
        print()

    matched, worst = [], []
    for nm in a:
        ps = [p for p in parts if p["base"] == nm]
        ins = [t for t in inst if t[0] == nm]
        for p, c, d, err in _assign(ps, ins):
            matched.append({**p, "c": c, "fit_err": err})
            worst.append((err, nm))

    worst.sort(reverse=True)
    dup = {n for n, k in a.items() if k > 1}
    bad = [(e, n) for e, n in worst if e > FIT_TOL and n in dup]
    if bad:
        print(f"CATATAN: {len(bad)} instance bernama ganda selisih ukurannya "
              f"> {FIT_TOL:.0%} setelah dipasangkan:")
        for e, n in bad[:8]:
            print(f"   {n:<24} {e:.1%}")
        print("  Angka ini diagnostik lemah, bukan bukti salah pasang: bbox\n"
              "  bergantung orientasi, dan part diputar saat di-print sehingga\n"
              "  bbox di plate memang beda dengan bbox di assembly. Agregat per\n"
              "  grup sudah tervalidasi terhadap hitungan manual; baris per-part\n"
              "  untuk nama ganda perlu dicek sebelum dikutip.\n")

    for m in matched:
        m["g"] = group_of(m["c"])

    print(f"{'grup':<26} {'#':>3} {'massa(g)':>9}")
    for g in ORDER:
        sel = [m for m in matched if m["g"] == g]
        print(f"{LABEL[g]:<26} {len(sel):>3} {sum(x['m'] for x in sel):>9.1f}")
    print(f"{'TOTAL':<26} {len(matched):>3} "
          f"{sum(m['m'] for m in matched):>9.1f}\n")

    # --- torsi gravitasi worst-case ---------------------------------------
    items = [(m["base"], m["m"] / 1000.0,
              arm_from_J2(m["c"], m["g"] in DISTAL_OF_J3), m["g"])
             for m in matched if m["g"] != "BASE"]

    for nm, c, _d in all_inst:
        if nm not in BOUGHT_KG:
            continue
        g = group_of(c)
        if g == "BASE":
            continue
        items.append((nm, BOUGHT_KG[nm], arm_from_J2(c, g in DISTAL_OF_J3), g))

    # Dowel: tersusun melingkar simetris terhadap sumbu sendinya, jadi titik
    # beratnya jatuh tepat di sumbu. Yang di J2 lengan momennya nol.
    for j, n in DOWEL_COUNT.items():
        s = {"J2": 0.0, "J3": A2, "J4": A2 + 65.0}[j]
        g = {"J2": "U", "J3": "E", "J4": "J4"}[j]
        items.append((f"dowel {j} ({n}x)", n * DOWEL_G / 1000.0, s, g))

    # Payload duduk di TCP (ujung wedge jaw), bukan di muka flange: benda yang
    # dicengkeram memang ada di ujung rahang. Selaras dengan MASSES di
    # src/arm/config.py. Endpoint d6 sendiri tetap berhenti di flange, itu
    # urusan pembukuan kinematika dan tidak menentukan letak massa.
    items.append(("payload", PAYLOAD_KG, A2 + D4 + WRIST_TO_TCP, "W"))

    tau2 = sum(m * GRAVITY * s / 1000 for _, m, s, _ in items)
    tau3 = sum(m * GRAVITY * (s - A2) / 1000
               for _, m, s, g in items if g in DISTAL_OF_J3)
    tau5 = sum(m * GRAVITY * (s - A2 - D4) / 1000
               for _, m, s, g in items if g == "W")

    print(f"{'penyumbang torsi J2 terbesar':<26} {'m(kg)':>7} {'s(mm)':>8} "
          f"{'tau(N.m)':>9}")
    for nm, m, s, _ in sorted(items, key=lambda t: -t[1] * t[2])[:8]:
        print(f"{nm:<26} {m:>7.3f} {s:>8.1f} {m * GRAVITY * s / 1000:>9.3f}")

    print(f"\nmassa dibawa J2 (cetak + beli + dowel + payload) = "
          f"{sum(m for _, m, _, _ in items) * 1000:.0f} g")
    print(f"tau_J2 = {tau2:.2f} N.m")
    print(f"tau_J3 = {tau3:.2f} N.m")
    print(f"tau_J5 = {tau5:.2f} N.m")
    print("\nBELUM termasuk: bearing, belt, baut. Perkiraan menambah "
          "0.2-0.4 N.m ke tau_J2.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
