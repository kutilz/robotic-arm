"""Ukur geometri sendi langsung dari STEP assembly Onshape.

Kenapa ada: `src/arm/config.py` mengklaim geometri DH-nya "terukur CAD", tapi
file STEP-nya sendiri di-gitignore (regenerable, 14 MB). Skrip ini yang jadi
jejaknya - jalankan ulang kapan pun desain 3D berubah, lalu salin angkanya ke
config.py.

    python tools/measure_cad_geometry.py [path/ke/Testing Assembly.step]

Cara kerjanya: setiap part di STEP flat Onshape punya transform sendiri. Skrip
membaca semua CIRCLE dan CYLINDRICAL_SURFACE tiap part, memindahnya ke koordinat
assembly global, lalu:

  1. mengelompokkan semua lingkaran yang koaksial jadi kandidat sumbu putar
     (bukan dari bounding box - bbox meleset kalau part-nya tidak simetris),
  2. mengenali sendi mana yang mana lewat tanda-tangan fiturnya,
  3. menghitung parameter DH dari jarak common normal antar sumbu,
  4. menguji kriteria Pieper (sumbu J4/J5/J6 berpotongan di satu titik),
  5. menghitung jumlah pin ring cycloidal dan gigi pulley HTD3M -> rasio reduksi,
  6. membandingkan semuanya dengan nilai yang sedang dipakai di config.py.

PENTING - pengenalan sendinya TIDAK bergantung pose. Versi pertama skrip ini
memakai koordinat sumbu hasil ukuran sebelumnya sebagai tebakan awal, lalu
langsung buta begitu lengan di-ekspor pada pose berbeda (J3-J6 ikut berpindah
padahal geometrinya sama persis). Sekarang identifikasinya begini:

  - J2/J3/J4 = tiga sumbu yang punya cincin pin roller cycloidal (lubang
    Ø4-7 mm tersusun melingkar). Jumlah pin dan radius pin-circle-nya melekat
    di part, jadi tidak berubah oleh pose.
  - Di antara ketiganya, J2 = yang paling dekat ke sumbu J1, J3 = yang sejajar
    dengan J2, J4 = sisanya (tegak lurus dan berpotongan dengan J3).
  - J1 = sumbu dengan part penyumbang terbanyak (tumpukan bearing bola base).
  - J5 = sumbu yang tegak lurus DAN berpotongan dengan J4, di titik terjauh
    dari siku. J6 = yang tegak lurus dan berpotongan dengan J5 di titik yang
    sama. Keduanya murni dari hubungan geometri, bukan dari koordinat hafalan.
"""

from __future__ import annotations

import collections
import math
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DEFAULT_STEP = REPO / "onshape" / "Testing Assembly.step"

# Ambang pengelompokan sumbu.
CLUSTER_RMIN = 2.0        # lingkaran lebih kecil dari ini dianggap derau (mm)
CLUSTER_ANG_TOL = 0.5     # dua lingkaran sesumbu kalau arahnya beda < ini (deg)
CLUSTER_POS_TOL = 0.5     # ... dan kaki tegak lurusnya beda < ini (mm)
# Pin roller cycloidal: lubang dalam rentang diameter ini, minimal sekian buah,
# tersusun melingkar terhadap satu sumbu.
PIN_DIA_RANGE = (4.0, 7.0)
PIN_MIN_COUNT = 8
INTERSECT_TOL = 1.0       # dua sumbu dianggap berpotongan kalau < ini (mm)


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
def _canon(z):
    """Arah sumbu tanpa tanda: dua lingkaran berlawanan hadap tetap sesumbu."""
    if z[0] < -1e-9 or (abs(z[0]) <= 1e-9 and
                        (z[1] < -1e-9 or (abs(z[1]) <= 1e-9 and z[2] < 0))):
        return mul(z, -1)
    return z


def cluster_axes(circles):
    """Kelompokkan lingkaran koaksial jadi kandidat sumbu.

    Di-bucket dulu berdasarkan arah yang dikuantisasi kasar supaya tidak perlu
    membandingkan tiap lingkaran dengan tiap cluster (ada ~9k lingkaran).
    """
    ca = math.cos(math.radians(CLUSTER_ANG_TOL))
    step = 0.05                      # kuantisasi arah, jauh lebih kasar dari toleransi
    buckets = collections.defaultdict(list)
    out = []
    for label, o, z, r in circles:
        if r < CLUSTER_RMIN:
            continue
        zc = _canon(nrm(z))
        foot = sub(o, mul(zc, dot(o, zc)))
        key = tuple(int(math.floor(c / step)) for c in zc)
        hit = None
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for dz in (-1, 0, 1):
                    for cl in buckets.get((key[0] + dx, key[1] + dy, key[2] + dz), ()):
                        if dot(zc, cl["z"]) > ca and math.dist(foot, cl["foot"]) < CLUSTER_POS_TOL:
                            hit = cl
                            break
                    if hit:
                        break
                if hit:
                    break
            if hit:
                break
        if hit is None:
            hit = {"z": zc, "foot": foot, "items": [], "parts": collections.Counter()}
            buckets[key].append(hit)
            out.append(hit)
        n = len(hit["items"]) + 1
        hit["z"] = nrm(tuple((hit["z"][i] * (n - 1) + zc[i]) / n for i in range(3)))
        hit["foot"] = tuple((hit["foot"][i] * (n - 1) + foot[i]) / n for i in range(3))
        hit["items"].append((o, r))
        hit["parts"][label] += 1

    axes = []
    for cl in out:
        pts = [o for o, r in cl["items"]]
        point = tuple(sum(p[i] for p in pts) / len(pts) for i in range(3))
        axes.append({
            "dir": cl["z"], "pt": point, "n": len(pts),
            "parts": dict(cl["parts"]),
            "radii": sorted({round(r, 2) for o, r in cl["items"]}, reverse=True),
            "resid": max(perp_dist(p, cl["z"], point) for p in pts),
        })
    axes.sort(key=lambda a: -a["n"])
    return axes


def ring_pin_count(axis, circles):
    """(jumlah pin, Ø pin, R pin-circle) cincin roller cycloidal di sumbu ini.

    None kalau sumbu ini bukan gearbox cycloidal.
    """
    groups = count_holes(circles, axis)
    best = None
    for (label, dia, pcr), angles in groups.items():
        if not (PIN_DIA_RANGE[0] <= dia <= PIN_DIA_RANGE[1]):
            continue
        if len(angles) < PIN_MIN_COUNT:
            continue
        if best is None or len(angles) > best[0]:
            best = (len(angles), dia, pcr, label)
    return best


def identify_joints(axes, circles):
    """Petakan cluster sumbu -> nama sendi, murni lewat hubungan geometri."""
    major = [a for a in axes if a["n"] >= 8]

    # J1: sumbu dengan part penyumbang terbanyak (tumpukan bearing bola base).
    j1 = max(major, key=lambda a: (len(a["parts"]), a["n"]))

    # J2/J3/J4: sumbu yang punya cincin pin roller cycloidal.
    cyc = []
    for a in major:
        if a is j1:
            continue
        ring = ring_pin_count(a, circles)
        if ring:
            cyc.append((a, ring))
    if len(cyc) != 3:
        return None, f"ketemu {len(cyc)} gearbox cycloidal, harusnya 3"

    # J2 = gearbox yang paling dekat ke PANGKAL J1. Ukur jaraknya dari titik
    # pangkal J1, bukan jarak garis-ke-garis: sumbu J4 kebetulan hampir memotong
    # perpanjangan sumbu J1 (~12 mm) sehingga jarak garis-ke-garis malah
    # menobatkan J4 sebagai yang "terdekat".
    cyc.sort(key=lambda ar: perp_dist(j1["pt"], ar[0]["dir"], ar[0]["pt"]))
    j2, ring2 = cyc[0]
    rest = cyc[1:]
    # J3 sejajar J2 (dua-duanya sumbu pitch); J4 tegak lurus terhadap keduanya.
    par = [ar for ar in rest if abs(dot(ar[0]["dir"], j2["dir"])) > math.cos(math.radians(5))]
    if len(par) != 1:
        return None, "tidak bisa memisahkan J3 (sejajar J2) dari J4"
    j3, ring3 = par[0]
    j4, ring4 = [ar for ar in rest if ar[0] is not j3][0]

    # J5: tegak lurus J4, berpotongan dengannya, di titik TERJAUH dari siku
    # (yang dekat siku itu fitur internal gearbox J4 sendiri).
    _, elbow, _ = line_distance(j3["dir"], j3["pt"], j4["dir"], j4["pt"])
    j5 = _perpendicular_partner(j4, major, exclude=(j1, j2, j3, j4),
                                anchor=elbow, want_far=True)
    if j5 is None:
        return None, "sumbu J5 tidak ketemu"
    _, wc_a, wc_b = line_distance(j4["dir"], j4["pt"], j5["dir"], j5["pt"])
    wc = tuple((wc_a[i] + wc_b[i]) / 2 for i in range(3))
    j6 = _perpendicular_partner(j5, major, exclude=(j1, j2, j3, j4, j5),
                                anchor=wc, want_far=False)
    if j6 is None:
        return None, "sumbu J6 tidak ketemu"

    found = {"J1": j1, "J2": j2, "J3": j3, "J4": j4, "J5": j5, "J6": j6}
    rings = {"J2": ring2, "J3": ring3, "J4": ring4}
    return (found, rings), None


def _perpendicular_partner(axis, candidates, exclude, anchor, want_far):
    """Sumbu yang tegak lurus & berpotongan dengan `axis`, dipilih berdasarkan
    jarak titik potongnya dari `anchor` (terjauh atau terdekat)."""
    best = None
    for a in candidates:
        if any(a is e for e in exclude):
            continue
        if abs(dot(a["dir"], axis["dir"])) > math.cos(math.radians(85)):
            continue                                    # tidak tegak lurus
        dist, c1, _ = line_distance(axis["dir"], axis["pt"], a["dir"], a["pt"])
        if c1 is None or dist > INTERSECT_TOL:
            continue
        d = math.dist(c1, anchor)
        if want_far:
            if d < 50.0:                                # masih di dalam gearbox
                continue
            score = -d
        else:
            score = d
        if best is None or score < best[0]:
            best = (score, a)
    return best[1] if best else None


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

    print("=" * 74)
    print("SUMBU SENDI (frame global CAD, mm) - dikenali dari fitur, bukan pose")
    print("=" * 74)
    candidates = cluster_axes(circles)
    result, err = identify_joints(candidates, circles)
    if result is None:
        print(f"GAGAL mengenali sendi: {err}")
        print(f"({len(candidates)} kandidat sumbu terkumpul; "
              "kalau desain berubah drastis, tinjau ambang di bagian atas file)")
        return 1
    axes, rings = result
    for name in ("J1", "J2", "J3", "J4", "J5", "J6"):
        a = axes[name]
        d, p = a["dir"], a["pt"]
        print(f"{name}: arah=({d[0]:9.6f},{d[1]:9.6f},{d[2]:9.6f})")
        print(f"    lewat=({p[0]:9.3f},{p[1]:9.3f},{p[2]:9.3f})  "
              f"n={a['n']:4d} lingkaran, simpangan maks {a['resid']:.4f} mm")
        print(f"    part: {', '.join(sorted(a['parts']))}")

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
        cnt, dia, pcr, label = rings[name]
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
    print("AKTUATOR TERPASANG DI ASSEMBLY")
    print("=" * 74)
    actuators = collections.Counter()
    for label, frame, geo in step.instances():
        if re.search(r"nema|mg\d|servo|17hs", label, re.I):
            actuators[label] += 1
    if actuators:
        for label, n in sorted(actuators.items()):
            print(f"  {n}x  {label}")
    else:
        print("  (tidak ada part bernama motor/servo - kemungkinan belum diberi "
              "nama di Onshape, atau di-hide saat export)")
    unnamed = sum(1 for label, f, g in step.instances()
                  if re.fullmatch(r"Part \d+", label))
    if unnamed:
        print(f"  catatan: {unnamed} instance masih bernama generik 'Part N'. "
              "Beri nama di Onshape supaya terbaca di sini.")

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
