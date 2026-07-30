"""Ukur geometri sendi langsung dari STEP assembly Onshape.

Kenapa ada: `src/arm/config.py` mengklaim geometri DH-nya "terukur CAD", tapi
file STEP-nya sendiri di-gitignore (regenerable, 14 MB). Skrip ini yang jadi
jejaknya - jalankan ulang kapan pun desain 3D berubah, lalu salin angkanya ke
config.py.

    python tools/measure_cad_geometry.py [path/ke/Testing Assembly.step]

Cara kerjanya: setiap part di STEP flat Onshape punya transform sendiri. Skrip
membaca semua CIRCLE dan CYLINDRICAL_SURFACE tiap part, memindahnya ke koordinat
assembly global, lalu:

  1. mem-fit sumbu putar tiap sendi dari kumpulan lingkaran yang koaksial
     (bukan dari bounding box - bbox meleset kalau part-nya tidak simetris),
  2. menghitung parameter DH dari jarak common normal antar sumbu,
  3. menguji kriteria Pieper (sumbu J4/J5/J6 berpotongan di satu titik),
  4. menghitung jumlah pin ring cycloidal dan gigi pulley HTD3M -> rasio reduksi,
  5. membandingkan semuanya dengan nilai yang sedang dipakai di config.py.

SEED_AXES di bawah cuma tebakan awal supaya fit tahu harus mencari di mana.
Kalau desain bergeser jauh, perbarui seed-nya; skrip mencetak jumlah lingkaran
dan simpangan tiap fit, jadi seed yang meleset langsung kelihatan.
"""

from __future__ import annotations

import collections
import math
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DEFAULT_STEP = REPO / "onshape" / "Testing Assembly.step"

# Tebakan awal sumbu tiap sendi: (arah, satu titik di sumbu), mm, frame CAD.
SEED_AXES = {
    "J1": ((0.0, 0.0, 1.0), (-4.50, 0.00, 20.00)),
    "J2": ((0.0, 1.0, 0.0), (-70.35, 0.00, 64.85)),
    "J3": ((0.0, 1.0, 0.0), (-54.74, 0.00, 352.42)),
    "J4": ((0.98707, 0.0, 0.16027), (-118.42, -11.80, 342.08)),
    "J5": ((0.01283, -0.99679, -0.07903), (-321.25, -11.88, 309.14)),
    "J6": ((0.20175, -0.07483, 0.97657), (-339.66, -4.82, 220.01)),
}
# Radius lingkaran minimum yang dianggap fitur struktural, per sendi (mm).
SEED_RMIN = {"J1": 8.0, "J2": 8.0, "J3": 8.0, "J4": 8.0, "J5": 2.5, "J6": 2.5}


# --------------------------------------------------------------------------
# aljabar vektor kecil (sengaja tanpa numpy: skrip ini alat, bukan dependensi)
# --------------------------------------------------------------------------
def dot(a, b): return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
def sub(a, b): return (a[0] - b[0], a[1] - b[1], a[2] - b[2])
def add(a, b): return (a[0] + b[0], a[1] + b[1], a[2] + b[2])
def mul(a, s): return (a[0] * s, a[1] * s, a[2] * s)


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0])


def nrm(v):
    n = math.sqrt(dot(v, v)) or 1.0
    return (v[0] / n, v[1] / n, v[2] / n)


def perp_dist(point, axis_dir, axis_pt):
    """Jarak tegak lurus sebuah titik ke garis sumbu."""
    w = sub(point, axis_pt)
    p = sub(w, mul(axis_dir, dot(w, axis_dir)))
    return math.sqrt(dot(p, p))


def line_distance(d1, p1, d2, p2):
    """Jarak common normal 2 garis + titik terdekat di masing-masing garis."""
    n = cross(d1, d2)
    ln = math.sqrt(dot(n, n))
    w = sub(p2, p1)
    if ln < 1e-9:                                   # sumbu sejajar
        return perp_dist(p2, d1, p1), None, None
    dist = abs(dot(w, mul(n, 1.0 / ln)))
    a11, a12, a22 = dot(d1, d1), dot(d1, d2), dot(d2, d2)
    b1, b2 = dot(w, d1), dot(w, d2)
    det = a11 * a22 - a12 * a12
    t1 = (b1 * a22 - a12 * b2) / det
    t2 = (a11 * b2 - a12 * b1) / det
    return dist, add(p1, mul(d1, t1)), add(p2, mul(d2, t2))


# --------------------------------------------------------------------------
# parser STEP seperlunya
# --------------------------------------------------------------------------
CIRCULAR = {"CIRCLE", "CYLINDRICAL_SURFACE"}
# entitas daun: tidak perlu ditelusuri lebih dalam saat mencari lingkaran
LEAF = {
    "CARTESIAN_POINT", "DIRECTION", "AXIS2_PLACEMENT_3D", "VERTEX_POINT",
    "VECTOR", "LINE", "PLANE", "B_SPLINE_CURVE_WITH_KNOTS", "ELLIPSE",
    "B_SPLINE_SURFACE_WITH_KNOTS", "TOROIDAL_SURFACE", "CONICAL_SURFACE",
    "SPHERICAL_SURFACE",
}


class Step:
    """Indeks entitas STEP + ekstraksi lingkaran per instance (mm, global)."""

    _ENT = re.compile(r"#(\d+)\s*=\s*(.*?);", re.S)
    _NAME = re.compile(r"^\(?\s*([A-Z_0-9]+)\s*\(")
    _REF = re.compile(r"#(\d+)")
    _NUM = re.compile(r"-?\d+\.?\d*(?:[eE][-+]?\d+)?")

    def __init__(self, path: Path):
        src = path.read_text(encoding="utf-8", errors="replace")
        src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
        src = src[src.index("DATA;") + 5:]
        self.ents = {int(m.group(1)): m.group(2) for m in self._ENT.finditer(src)}
        self._by_type = collections.defaultdict(list)
        for eid in self.ents:
            self._by_type[self.type_of(eid)].append(eid)

    def type_of(self, eid):
        body = self.ents.get(eid)
        if body is None:
            return ""
        m = self._NAME.match(body.strip())
        return m.group(1) if m else ""

    def refs(self, eid):
        return [int(x) for x in self._REF.findall(self.ents.get(eid, ""))]

    def _floats(self, eid):
        return [float(x) for x in self._NUM.findall(self.ents[eid])]

    def _point(self, eid):
        v = self._floats(eid)
        return tuple(v[-3:]) if len(v) >= 3 else (0.0, 0.0, 0.0)

    def placement(self, eid):
        """AXIS2_PLACEMENT_3D -> frame (origin, x, y, z) di koordinat induknya."""
        r = self.refs(eid)
        o = self._point(r[0])
        z = nrm(self._point(r[1])) if len(r) > 1 else (0.0, 0.0, 1.0)
        x = self._point(r[2]) if len(r) > 2 else (1.0, 0.0, 0.0)
        x = nrm(sub(x, mul(z, dot(x, z))))
        return o, x, cross(z, x), z

    def instances(self):
        """[(nama, frame global, id rep geometri)] untuk tiap part di assembly."""
        srr = {}
        for eid in self._by_type["SHAPE_REPRESENTATION_RELATIONSHIP"]:
            r = self.refs(eid)
            if len(r) == 2:
                srr[r[0]] = r[1]
        pds_nauo = {}
        for eid in self._by_type["PRODUCT_DEFINITION_SHAPE"]:
            r = self.refs(eid)
            if r and self.type_of(r[0]) == "NEXT_ASSEMBLY_USAGE_OCCURRENCE":
                pds_nauo[eid] = r[0]

        out = []
        for eid in self._by_type["CONTEXT_DEPENDENT_SHAPE_REPRESENTATION"]:
            rel, pds = self.refs(eid)[:2]
            nauo = pds_nauo.get(pds)
            geo = srr.get(self.refs(rel)[0])
            if nauo is None or geo is None:
                continue
            names = re.findall(r"'([^']*)'", self.ents[nauo])
            label = names[1] if len(names) > 1 else "?"
            idt = self.refs(rel)[2]
            out.append((label, self.placement(self.refs(idt)[1]), geo))
        return out

    def circles(self, geo_root, frame):
        """Semua lingkaran di bawah geo_root, dipindah ke koordinat global (mm)."""
        o, fx, fy, fz = frame
        found, seen, stack = [], set(), [geo_root]
        while stack:
            e = stack.pop()
            if e in seen:
                continue
            seen.add(e)
            t = self.type_of(e)
            if t in CIRCULAR:
                r = self.refs(e)
                nums = self._floats(e)
                po, _, _, pz = self.placement(r[0])
                g_o = tuple(
                    (o[i] + po[0] * fx[i] + po[1] * fy[i] + po[2] * fz[i]) * 1000.0
                    for i in range(3))
                g_z = nrm(tuple(pz[0] * fx[i] + pz[1] * fy[i] + pz[2] * fz[i]
                                for i in range(3)))
                found.append((g_o, g_z, nums[-1] * 1000.0 if nums else 0.0))
            elif t not in LEAF:
                stack.extend(self.refs(e))
        return found


# --------------------------------------------------------------------------
# pengukuran
# --------------------------------------------------------------------------
def fit_axis(circles, seed_dir, seed_pt, rmin, angtol=1.0, postol=1.0):
    """Rata-ratakan semua lingkaran yang koaksial dengan sumbu tebakan."""
    sd = nrm(seed_dir)
    ca = math.cos(math.radians(angtol))
    dirs, pts, who, worst = [], [], collections.Counter(), 0.0
    for label, o, z, r in circles:
        if r < rmin or abs(dot(z, sd)) < ca:
            continue
        e = perp_dist(o, sd, seed_pt)
        if e > postol:
            continue
        dirs.append(z if dot(z, sd) > 0 else mul(z, -1))
        pts.append(o)
        who[label] += 1
        worst = max(worst, e)
    if not dirs:
        return None
    n = len(dirs)
    axis = nrm(tuple(sum(d[i] for d in dirs) / n for i in range(3)))
    point = tuple(sum(p[i] for p in pts) / n for i in range(3))
    resid = max(perp_dist(p, axis, point) for p in pts)
    return {"dir": axis, "pt": point, "n": n, "parts": dict(who),
            "resid": resid, "seed_off": worst}


def count_holes(circles, axis, rmin_from_axis=8.0):
    """Kelompokkan lubang yang tersusun melingkar terhadap satu sumbu.

    Kunci = (part, diameter lubang, radius pin-circle); nilai = jumlah sudut
    unik. Dipakai untuk menghitung pin ring cycloidal.
    """
    d, pt = axis["dir"], axis["pt"]
    tmp = (1.0, 0.0, 0.0) if abs(d[0]) < 0.9 else (0.0, 1.0, 0.0)
    u = nrm(sub(tmp, mul(d, dot(tmp, d))))
    w = cross(d, u)
    groups = collections.defaultdict(set)
    for label, o, z, r in circles:
        if abs(dot(z, d)) < 0.999:
            continue
        v = sub(o, pt)
        p = sub(v, mul(d, dot(v, d)))
        rad = math.hypot(dot(p, u), dot(p, w))
        if rad < rmin_from_axis:
            continue
        ang = round(math.degrees(math.atan2(dot(p, w), dot(p, u))), 1)
        groups[(label, round(2 * r, 2), round(rad, 1))].add(ang)
    return groups


def htd3m_teeth(tip_radius_mm):
    """Perkiraan jumlah gigi HTD3M dari radius ujung gigi (PLD offset 0.381)."""
    return (2 * tip_radius_mm + 0.762) * math.pi / 3.0


def main(argv):
    step_path = Path(argv[1]) if len(argv) > 1 else DEFAULT_STEP
    if not step_path.exists():
        print(f"STEP tidak ditemukan: {step_path}")
        print("File CAD di-gitignore. Export ulang dari Onshape dulu, atau "
              "beri path-nya sebagai argumen.")
        return 1

    print(f"Membaca {step_path.name} ...")
    step = Step(step_path)
    circles = []
    for label, frame, geo in step.instances():
        for o, z, r in step.circles(geo, frame):
            circles.append((label, o, z, r))
    print(f"{len(circles)} lingkaran dari {len(step.instances())} instance part\n")

    axes = {}
    print("=" * 74)
    print("SUMBU SENDI (frame global CAD, mm)")
    print("=" * 74)
    for name, (sd, sp) in SEED_AXES.items():
        a = fit_axis(circles, sd, sp, SEED_RMIN[name])
        axes[name] = a
        if a is None:
            print(f"{name}: TIDAK KETEMU - perbarui SEED_AXES")
            continue
        d, p = a["dir"], a["pt"]
        print(f"{name}: arah=({d[0]:9.6f},{d[1]:9.6f},{d[2]:9.6f})")
        print(f"    lewat=({p[0]:9.3f},{p[1]:9.3f},{p[2]:9.3f})  "
              f"n={a['n']:4d} lingkaran, simpangan maks {a['resid']:.4f} mm")
        print(f"    part: {', '.join(sorted(a['parts']))}")

    if not all(axes.values()):
        return 1

    print()
    print("=" * 74)
    print("KRITERIA PIEPER - sumbu pergelangan harus berpotongan di satu titik")
    print("=" * 74)
    for x, y in (("J4", "J5"), ("J5", "J6"), ("J4", "J6")):
        dist, _, _ = line_distance(axes[x]["dir"], axes[x]["pt"],
                                   axes[y]["dir"], axes[y]["pt"])
        ang = math.degrees(math.acos(min(1.0, abs(dot(axes[x]["dir"], axes[y]["dir"])))))
        print(f"  {x}-{y}: jarak common normal {dist:7.4f} mm   sudut {ang:6.2f} deg")
    _, c4, c5 = line_distance(axes["J4"]["dir"], axes["J4"]["pt"],
                              axes["J5"]["dir"], axes["J5"]["pt"])
    wc = tuple((c4[i] + c5[i]) / 2 for i in range(3))
    print(f"  wrist center = ({wc[0]:.3f}, {wc[1]:.3f}, {wc[2]:.3f}) mm")
    print(f"  simpangan sumbu J6 dari titik itu: "
          f"{perp_dist(wc, axes['J6']['dir'], axes['J6']['pt']):.4f} mm")

    print()
    print("=" * 74)
    print("PARAMETER DH")
    print("=" * 74)
    a1, f1, _ = line_distance(axes["J1"]["dir"], axes["J1"]["pt"],
                              axes["J2"]["dir"], axes["J2"]["pt"])
    a2, _, _ = line_distance(axes["J2"]["dir"], axes["J2"]["pt"],
                             axes["J3"]["dir"], axes["J3"]["pt"])
    a3, c3, _ = line_distance(axes["J3"]["dir"], axes["J3"]["pt"],
                              axes["J4"]["dir"], axes["J4"]["pt"])
    d1 = axes["J2"]["pt"][2]
    d4 = math.dist(c3, wc)
    print(f"  d1 (tinggi J1->J2)              = {d1:8.3f} mm")
    print(f"  a1 (offset lateral J1->J2)      = {a1:8.3f} mm")
    print(f"  a2 (upper arm J2->J3)           = {a2:8.3f} mm")
    print(f"  a3 (offset perpendicular siku)  = {a3:8.3f} mm")
    print(f"  d4 (forearm, siku->wrist center)= {d4:8.3f} mm")
    print(f"  d3 (geseran lateral Y forearm)  = {wc[1] - f1[1]:8.3f} mm")

    # d6 = jarak dari wrist center ke MUKA flange gripper: lingkaran besar
    # (Ø>=40) PERTAMA yang ditemui saat berjalan keluar dari wrist center
    # sepanjang sumbu J6. Muka itu bidang temu housing J6 dengan pelat gripper;
    # pelatnya sendiri masih menerus beberapa mm lagi ke luar, jadi jangan
    # ambil yang terjauh.
    j6d, j6p = axes["J6"]["dir"], axes["J6"]["pt"]
    outward = j6d if dot(sub(wc, j6p), j6d) < 0 else mul(j6d, -1)
    flange = [dot(sub(o, wc), outward) for label, o, z, r in circles
              if r >= 20.0 and perp_dist(o, j6d, j6p) <= 1.0
              and dot(sub(o, wc), outward) > 1.0]
    d6 = min(flange) if flange else 0.0
    print(f"  d6 (wrist center->muka flange)  = {d6:8.3f} mm")
    print(f"  reach dari sumbu J2 (a2+d4+d6)  = {a2 + d4 + d6:8.3f} mm")

    print()
    print("=" * 74)
    print("RASIO REDUKSI")
    print("=" * 74)
    for name in ("J2", "J3", "J4"):
        groups = count_holes(circles, axes[name])
        # pin roller cycloidal: lubang Ø4-7 mm yang jumlahnya paling banyak
        best = max(((len(v), k) for k, v in groups.items()
                    if 4.0 <= k[1] <= 7.0 and len(v) >= 5), default=None)
        if best:
            cnt, (label, dia, pcr) = best
            print(f"  {name} cycloidal: {cnt:3d} pin Ø{dia:.1f} mm di pin-circle "
                  f"R{pcr:.1f} mm -> reduksi 1:{cnt} ({label})")
    print("  pulley HTD3M (radius ujung gigi -> perkiraan jumlah gigi):")
    for label in ("Input Pulley", "Stage 2 Pulley", "Output Pulley",
                  "Motor Pulley", "Driven Pulley"):
        rr = collections.Counter(round(r, 2) for lb, o, z, r in circles
                                 if lb == label and r > 4)
        tips = [r for r, n in rr.items() if n >= 30]
        if tips:
            teeth = ", ".join(f"{htd3m_teeth(r):.1f}T (r={r:.2f})"
                              for r in sorted(tips, reverse=True))
            print(f"    {label:<16} {teeth}")

    print()
    print("=" * 74)
    print("BANDING DENGAN src/arm/config.py")
    print("=" * 74)
    sys.path.insert(0, str(REPO / "src"))
    try:
        from arm import config as C
    except ImportError as exc:                       # pragma: no cover
        print(f"  (tidak bisa mengimpor config.py: {exc})")
        return 0
    rows = [
        ("D1_BASE", C.D1_BASE * 1000, d1),
        ("A1_SHOULDER_OFFSET", C.A1_SHOULDER_OFFSET * 1000, a1),
        ("A2_UPPER_ARM", C.A2_UPPER_ARM * 1000, a2),
        ("A3_ELBOW_OFFSET", C.A3_ELBOW_OFFSET * 1000, a3),
        ("D4_FOREARM", C.D4_FOREARM * 1000, d4),
        ("D6_WRIST_TCP", C.D6_WRIST_TCP * 1000, d6),
        ("REACH_FROM_J2", C.REACH_FROM_J2 * 1000, a2 + d4 + d6),
    ]
    drift = False
    for label, cfg, cad in rows:
        delta = cad - cfg
        flag = "" if abs(delta) <= 0.5 else "   <-- BEDA, perbarui config.py"
        drift = drift or bool(flag)
        print(f"  {label:<20} config {cfg:9.3f} mm   CAD {cad:9.3f} mm   "
              f"selisih {delta:+7.3f}{flag}")
    print("\n" + ("Ada selisih di atas 0.5 mm - config.py perlu di-rebase."
                  if drift else "config.py sudah sinkron dengan CAD."))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
