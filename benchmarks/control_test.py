"""Pengolah data loop kendali closed-loop (Bab III Subbab 3.7.2, Bab IV Subbab 4.5.4-4.5.6).

Skrip ini melayani empat pengujian yang menguji LOOP KENDALI itu sendiri, bukan
hanya hasil akhirnya seperti `accuracy_test.py`. Keempatnya dibedakan otomatis
dari nama kolom CSV, jadi beberapa berkas boleh diberikan sekaligus:

    python benchmarks/control_test.py benchmarks/data/control_noise_run1.csv \
                                      benchmarks/data/control_tuning_run1.csv \
                                      benchmarks/data/control_loop_run1.csv \
                                      benchmarks/data/control_disturbance_run1.csv

BENTUK CSV YANG DIKENALI

  1. derau diam (Sesi 4a)      joint,sample,angle_deg
     Sendi diperintahkan ke satu posisi lalu dibiarkan diam. Keluaran: simpangan
     baku pembacaan dan lebar deadband minimum yang layak.

  2. penalaan Kp (Sesi 4b)     joint,kp,deadband_deg,trial,final_error_deg,osilasi
     Sapuan Kp. Kolom `osilasi` diisi ya/tidak (atau 1/0). Keluaran: error akhir
     per nilai Kp, Kp saat osilasi mulai muncul, dan Kp yang dianjurkan dipakai.

  3. periode sampling (Sesi 4c) state,sample,period_ms
     `state` = idle | moving. Keluaran: rata-rata dan persentil 95 per keadaan.

  4. gangguan (Sesi 6)         test,joint,mode,t_ms,angle_deg,note
     Deret waktu sudut untuk uji droop berbeban dan pemulihan kehilangan langkah.
     `mode` = open | closed. Satu baris ditandai `gangguan` pada kolom `note`
     untuk menyatakan saat gangguan diberikan; bila tidak ada, saat gangguan
     ditebak dari lompatan sudut terbesar dan hal itu diberitahukan.

DASAR PENGOLAHAN

  Deadband minimum = maks(3 x simpangan baku derau diam, satu langkah kuantisasi
  AS5600 sebesar 0,088 derajat). Alasannya di Subbab 2.6.3: tanpa deadband yang
  melampaui derau, koreksi akan terus dipicu oleh derau dan sendi berosilasi
  kecil tanpa henti (limit cycle).

  Peluruhan error mengikuti e[k+1] = (1 - Kp) e[k] (Subbab 3.6.1), sehingga Kp
  yang sah berada pada 0 < Kp < 1 dan jumlah iterasi yang dibutuhkan untuk
  menurunkan error awal e0 ke dalam deadband dapat diprediksi. Prediksi ini
  dicetak sebagai pembanding terhadap jumlah iterasi yang benar-benar terukur
  pada uji gangguan.

CATATAN VALIDITAS. Sama seperti `accuracy_test.py`, encoder di sini berperan
ganda sebagai sensor umpan balik sekaligus alat ukur. Untuk uji gangguan hal ini
masih sah karena yang dibandingkan adalah dua mode pada gangguan yang sama, dan
yang diklaim adalah ada atau tidaknya pemulihan, bukan akurasi absolutnya.
"""

from __future__ import annotations

import csv
import math
import statistics
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import datacheck  # noqa: E402

KUANTISASI_DEG = 360.0 / 4096.0    # 0,0879 derajat per count AS5600
CLAMP_KOREKSI_DEG = 5.0            # CORR_MAX_DEG di firmware
DEADBAND_BAWAAN = 0.3              # nilai bawaan firmware, titik awal penalaan
MODE_LABEL = {"open": "open-loop", "closed": "closed-loop"}

BENTUK = {
    "derau": {"joint", "sample", "angle_deg"},
    "penalaan": {"joint", "kp", "deadband_deg", "trial", "final_error_deg", "osilasi"},
    "periode": {"state", "sample", "period_ms"},
    "gangguan": {"test", "joint", "mode", "t_ms", "angle_deg", "note"},
}


# ----------------------------------------------------------------- utilitas

def kenali(csv_path: Path) -> tuple[str, list[dict]]:
    """Tentukan bentuk CSV dari nama kolomnya, lalu muat isinya."""
    with csv_path.open(newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        kolom = {(c or "").strip().lower() for c in (reader.fieldnames or [])}
        rows = [{(k or "").strip().lower(): v for k, v in r.items()} for r in reader]

    for nama, wajib in BENTUK.items():
        if wajib <= kolom:
            return nama, rows

    diketahui = "\n".join(f"    {n}: {','.join(sorted(k))}" for n, k in BENTUK.items())
    raise SystemExit(
        f"Kolom CSV tidak dikenali: {csv_path}\n"
        f"  ditemukan: {','.join(sorted(kolom)) or '(kosong)'}\n"
        f"  bentuk yang dikenali:\n{diketahui}"
    )


def ya(nilai: str) -> bool:
    """Baca kolom osilasi yang boleh ditulis ya/tidak, y/n, true/false, 1/0."""
    return str(nilai).strip().lower() in {"ya", "y", "true", "1", "iya", "ada"}


def p95(vals: list[float]) -> float:
    """Persentil 95 dengan interpolasi linear."""
    if not vals:
        return float("nan")
    s = sorted(vals)
    if len(s) == 1:
        return s[0]
    pos = 0.95 * (len(s) - 1)
    lo = math.floor(pos)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (pos - lo)


def iterasi_prediksi(e0: float, deadband: float, kp: float) -> float:
    """Jumlah iterasi agar |e| turun dari e0 ke dalam deadband, dari (1-Kp)^n."""
    if not 0 < kp < 1 or deadband <= 0 or abs(e0) <= deadband:
        return 0.0
    return math.ceil(math.log(deadband / abs(e0)) / math.log(1 - kp))


def tulis_csv(path: Path, header: list[str], baris: list[list]) -> None:
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(baris)
    print(f"  ringkasan disimpan: {path}")


# ----------------------------------------------------------- 1. derau diam

def olah_derau(rows: list[dict], out_dir: Path) -> dict[str, dict]:
    per: dict[str, list[float]] = defaultdict(list)
    for r in rows:
        per[r["joint"].strip().upper()].append(float(r["angle_deg"]))

    hasil = {}
    for joint, vals in sorted(per.items()):
        sd = statistics.stdev(vals) if len(vals) > 1 else 0.0
        hasil[joint] = {
            "n": len(vals),
            "mean": statistics.fmean(vals),
            "sd": sd,
            "rentang": max(vals) - min(vals),
            "deadband_min": max(3.0 * sd, KUANTISASI_DEG),
        }

    print("\n=== Derau encoder saat sendi diam (Sesi 4a) ===")
    print(f"{'Sendi':<6} {'n':>6} {'SD (d)':>9} {'rentang (d)':>12} {'deadband min (d)':>18}")
    print("-" * 56)
    for joint, s in hasil.items():
        print(f"{joint:<6} {s['n']:>6} {s['sd']:>9.4f} {s['rentang']:>12.4f} "
              f"{s['deadband_min']:>18.3f}")

    kasar = [j for j, s in hasil.items() if s["deadband_min"] > 0.5]
    if kasar:
        print("\nPERINGATAN: deadband minimum di atas 0,5 derajat pada "
              f"{', '.join(kasar)}. Target repeatability 0,5 derajat tidak mungkin "
              "dicapai karena akurasi tunak tidak pernah lebih baik daripada lebar "
              "deadband. Periksa air gap magnet dan kekakuan dudukan sensor dulu, "
              "jangan menala Kp di atas pembacaan sebesar ini.")
    tipis = [j for j, s in hasil.items() if s["n"] < 200]
    if tipis:
        print(f"\nCatatan: sampel di bawah 200 pada {', '.join(tipis)}. Rekaman 60 "
              "detik pada laju umpan balik 50 Hz seharusnya menghasilkan ribuan "
              "sampel; sebutkan jumlah sebenarnya bila jauh lebih sedikit.")

    tulis_csv(out_dir / "control_noise_summary.csv",
              ["joint", "n", "mean_deg", "SD_deg", "rentang_deg", "deadband_min_deg"],
              [[j, s["n"], f"{s['mean']:.4f}", f"{s['sd']:.4f}",
                f"{s['rentang']:.4f}", f"{s['deadband_min']:.4f}"]
               for j, s in hasil.items()])
    return hasil


# ------------------------------------------------------------ 2. penalaan Kp

def olah_penalaan(rows: list[dict], out_dir: Path,
                  derau: dict[str, dict] | None = None) -> dict[str, dict]:
    per: dict[tuple[str, float], list[dict]] = defaultdict(list)
    deadband_dipakai: dict[str, set] = defaultdict(set)
    for r in rows:
        joint = r["joint"].strip().upper()
        kp = float(r["kp"])
        per[(joint, kp)].append({
            "err": abs(float(r["final_error_deg"])),
            "osilasi": ya(r["osilasi"]),
        })
        deadband_dipakai[joint].add(round(float(r["deadband_deg"]), 4))

    tabel: dict[str, list[dict]] = defaultdict(list)
    for (joint, kp), items in sorted(per.items()):
        tabel[joint].append({
            "kp": kp,
            "n": len(items),
            "err_mean": statistics.fmean(i["err"] for i in items),
            "err_max": max(i["err"] for i in items),
            "osilasi_n": sum(1 for i in items if i["osilasi"]),
        })

    print("\n=== Penalaan Kp (Sesi 4b) ===")
    baris_csv = []
    rekom: dict[str, dict] = {}
    for joint, items in sorted(tabel.items()):
        items.sort(key=lambda d: d["kp"])
        db = sorted(deadband_dipakai[joint])
        db_txt = ", ".join(f"{v:g}" for v in db)
        print(f"\nSendi {joint}   deadband saat penalaan: {db_txt} derajat")
        if len(db) > 1:
            print("  PERINGATAN: deadband tidak ditahan tetap selama sapuan Kp. "
                  "Pengaruh Kp dan pengaruh deadband jadi tercampur, dan Kp "
                  "terpilih tidak bisa dipertanggungjawabkan. Ulangi sapuan "
                  "dengan deadband dikunci.")
        print(f"  {'Kp':>5} {'n':>4} {'err rata2 (d)':>15} {'err maks (d)':>14} {'osilasi':>10}")
        for it in items:
            tanda = f"{it['osilasi_n']}/{it['n']}" if it["osilasi_n"] else "tidak"
            print(f"  {it['kp']:>5.2f} {it['n']:>4} {it['err_mean']:>15.4f} "
                  f"{it['err_max']:>14.4f} {tanda:>10}")
            baris_csv.append([joint, f"{it['kp']:.2f}", it["n"],
                              f"{it['err_mean']:.4f}", f"{it['err_max']:.4f}",
                              it["osilasi_n"]])

        luar = [it["kp"] for it in items if not 0 < it["kp"] < 1]
        if luar:
            print("  Catatan: nilai Kp " + ", ".join(f"{v:g}" for v in luar) +
                  " berada di luar rentang 0 < Kp < 1 dari Subbab 3.6.1, "
                  "sehingga error tidak dijamin meluruh monoton.")

        bersih = [it for it in items if it["osilasi_n"] == 0 and 0 < it["kp"] < 1]
        osc = [it["kp"] for it in items if it["osilasi_n"] > 0]
        kp_osc = min(osc) if osc else None
        if not bersih:
            print("  Tidak ada nilai Kp yang bebas osilasi. Turunkan rentang "
                  "sapuan atau perlebar deadband dulu.")
            rekom[joint] = {"kp_pakai": None, "kp_osc": kp_osc,
                            "deadband": db[0] if db else DEADBAND_BAWAAN}
            continue

        aman = [it for it in bersih if kp_osc is None or it["kp"] < kp_osc]
        aman.sort(key=lambda d: d["kp"])
        kp_pakai = aman[-2]["kp"] if len(aman) >= 2 else aman[-1]["kp"]
        margin = " (satu langkah sapuan di bawah nilai bebas osilasi tertinggi)" \
            if len(aman) >= 2 else " (hanya satu nilai bebas osilasi, tanpa margin)"
        print(f"  Anjuran: Kp = {kp_pakai:g}{margin}.")
        if kp_osc is not None:
            print(f"  Osilasi mulai muncul pada Kp = {kp_osc:g}.")
        else:
            print("  Osilasi tidak pernah muncul sampai ujung sapuan. Sebutkan hal "
                  "ini apa adanya di Bab IV, dan jangan mengarang nilai ambang.")
        rekom[joint] = {"kp_pakai": kp_pakai, "kp_osc": kp_osc,
                        "deadband": db[0] if db else DEADBAND_BAWAAN}

    # prediksi jumlah iterasi memakai deadband hasil derau bila tersedia
    print("\nPrediksi jumlah iterasi sampai error masuk deadband, dari "
          "e[k+1] = (1 - Kp) e[k]:")
    print(f"  {'Sendi':<6} {'Kp':>5} {'deadband':>10} " +
          " ".join(f"{'e0=' + f'{e:g}d':>9}" for e in (1.0, 2.0, CLAMP_KOREKSI_DEG)))
    for joint, r in sorted(rekom.items()):
        kp = r["kp_pakai"]
        if kp is None:
            continue
        db = (derau or {}).get(joint, {}).get("deadband_min") or r["deadband"]
        kolom = " ".join(f"{iterasi_prediksi(e, db, kp):>9.0f}"
                         for e in (1.0, 2.0, CLAMP_KOREKSI_DEG))
        print(f"  {joint:<6} {kp:>5.2f} {db:>10.3f} {kolom}")
    print("  Angka ini prediksi, bukan pengukuran. Pembandingnya adalah jumlah "
          "iterasi terukur pada uji gangguan Sesi 6.")

    tulis_csv(out_dir / "control_tuning_summary.csv",
              ["joint", "kp", "n_trial", "err_mean_deg", "err_max_deg", "osilasi_n"],
              baris_csv)
    tulis_csv(out_dir / "control_tuning_rekomendasi.csv",
              ["joint", "kp_pakai", "kp_mulai_osilasi", "deadband_deg"],
              [[j, "" if r["kp_pakai"] is None else f"{r['kp_pakai']:.2f}",
                "" if r["kp_osc"] is None else f"{r['kp_osc']:.2f}",
                f"{r['deadband']:.3f}"] for j, r in sorted(rekom.items())])
    return {"tabel": tabel, "rekomendasi": rekom}


# ------------------------------------------------------- 3. periode sampling

def olah_periode(rows: list[dict], out_dir: Path) -> dict[str, dict]:
    per: dict[str, list[float]] = defaultdict(list)
    for r in rows:
        per[r["state"].strip().lower()].append(float(r["period_ms"]))

    print("\n=== Periode sampling loop kendali (Sesi 4c) ===")
    print(f"{'Keadaan':<10} {'n':>7} {'rata2 (ms)':>12} {'p95 (ms)':>10} {'maks (ms)':>11}")
    print("-" * 54)
    hasil = {}
    for state, vals in sorted(per.items()):
        hasil[state] = {
            "n": len(vals),
            "mean": statistics.fmean(vals),
            "p95": p95(vals),
            "maks": max(vals),
        }
        s = hasil[state]
        print(f"{state:<10} {s['n']:>7} {s['mean']:>12.2f} {s['p95']:>10.2f} "
              f"{s['maks']:>11.2f}")

    if hasil:
        acuan = hasil.get("idle") or next(iter(hasil.values()))
        laju = 1000.0 / acuan["mean"] if acuan["mean"] > 0 else float("nan")
        print(f"\nLaju iterasi efektif sekitar {laju:.0f} Hz pada keadaan acuan. "
              "Angka ini yang mengubah satuan iterasi menjadi satuan waktu pada "
              "Tabel 4.9, dan wajib disebut karena loop() berjalan bebas tanpa "
              "penjadwal tetap.")

    tulis_csv(out_dir / "control_loop_summary.csv",
              ["state", "n", "mean_ms", "p95_ms", "maks_ms"],
              [[k, s["n"], f"{s['mean']:.3f}", f"{s['p95']:.3f}", f"{s['maks']:.3f}"]
               for k, s in sorted(hasil.items())])
    return hasil


# ------------------------------------------------------------- 4. gangguan

def olah_gangguan(rows: list[dict], out_dir: Path, deadband: float,
                  periode_ms: float | None = None) -> dict:
    seri: dict[tuple[str, str, str], list[dict]] = defaultdict(list)
    for r in rows:
        kunci = (r["test"].strip(), r["joint"].strip().upper(), r["mode"].strip().lower())
        seri[kunci].append({
            "t": float(r["t_ms"]),
            "a": float(r["angle_deg"]),
            "note": (r.get("note") or "").strip().lower(),
        })

    print("\n=== Tanggapan terhadap gangguan (Sesi 6) ===")
    print(f"Ambang pemulihan memakai deadband {deadband:g} derajat.")
    hasil = {}
    ditebak = []
    for kunci, pts in sorted(seri.items()):
        test, joint, mode = kunci
        pts.sort(key=lambda d: d["t"])

        tanda = [p for p in pts if "gangguan" in p["note"]]
        if tanda:
            t_g = tanda[0]["t"]
        else:
            # tebak dari lompatan sudut terbesar antar sampel berurutan
            lonjak = max(range(1, len(pts)),
                         key=lambda i: abs(pts[i]["a"] - pts[i - 1]["a"]),
                         default=0)
            t_g = pts[lonjak]["t"] if lonjak else pts[0]["t"]
            ditebak.append(f"{test} / {joint} / {MODE_LABEL.get(mode, mode)}")

        sebelum = [p["a"] for p in pts if p["t"] < t_g]
        sesudah = [p for p in pts if p["t"] >= t_g]
        if not sebelum or not sesudah:
            print(f"\n{test} / {joint} / {MODE_LABEL.get(mode, mode)}: "
                  "sampel sebelum atau sesudah gangguan tidak ada, dilewati.")
            continue

        acuan = statistics.median(sebelum)
        simpangan = max(sesudah, key=lambda p: abs(p["a"] - acuan))
        ekor = sesudah[max(1, int(len(sesudah) * 0.8)):] or sesudah[-1:]
        sisa = statistics.median(p["a"] for p in ekor) - acuan

        # waktu pulih: saat pertama masuk deadband dan tidak keluar lagi
        pulih = None
        for i, p in enumerate(sesudah):
            if all(abs(q["a"] - acuan) <= deadband for q in sesudah[i:]):
                pulih = (p["t"] - t_g) / 1000.0
                break

        s = {
            "acuan": acuan,
            "simpangan": simpangan["a"] - acuan,
            "sisa": sisa,
            "pulih_s": pulih,
            "n": len(pts),
            # hanya relevan untuk closed-loop: open-loop tidak mengoreksi apa pun
            "melampaui_clamp": (mode == "closed"
                                and abs(simpangan["a"] - acuan) > CLAMP_KOREKSI_DEG),
        }
        if pulih is not None and periode_ms:
            s["iterasi"] = pulih * 1000.0 / periode_ms
        hasil[kunci] = s

        print(f"\n{test} / {joint} / {MODE_LABEL.get(mode, mode)}  ({len(pts)} sampel)")
        print(f"  sudut acuan sebelum gangguan : {acuan:.3f} d")
        print(f"  simpangan puncak             : {s['simpangan']:+.3f} d")
        print(f"  sisa simpangan               : {s['sisa']:+.3f} d")
        if pulih is None:
            print("  pemulihan                    : TIDAK kembali ke dalam deadband")
        else:
            ekstra = (f", sekitar {s['iterasi']:.0f} iterasi"
                      if "iterasi" in s else "")
            print(f"  pemulihan                    : {pulih:.2f} s{ekstra}")
        if s["melampaui_clamp"]:
            print(f"  Simpangan melampaui pembatas koreksi {CLAMP_KOREKSI_DEG:g} derajat, "
                  "jadi pemulihannya memang bertahap beberapa iterasi. Sebutkan ini "
                  "di Bab IV supaya tidak terbaca sebagai loop yang lambat.")

    if ditebak:
        print("\nCatatan: saat gangguan ditebak dari lompatan sudut terbesar pada "
              + "; ".join(ditebak) + ". Lebih baik tandai barisnya dengan `gangguan` "
              "di kolom note supaya tidak bergantung pada tebakan.")

    # pembandingan dua mode pada gangguan yang sama
    print("\nPembandingan open-loop terhadap closed-loop:")
    pasangan = {(t, j) for (t, j, _m) in hasil}
    for test, joint in sorted(pasangan):
        o = hasil.get((test, joint, "open"))
        c = hasil.get((test, joint, "closed"))
        if not (o and c):
            print(f"  {test} / {joint}: hanya satu mode terekam, belum bisa "
                  "dibandingkan. Tanpa pembanding, klaim utama Bab IV tidak berdiri.")
            continue
        print(f"  {test} / {joint}: sisa simpangan {o['sisa']:+.3f} d (open) "
              f"-> {c['sisa']:+.3f} d (closed)"
              + ("" if c["pulih_s"] is None else f", pulih {c['pulih_s']:.2f} s"))
        if c["pulih_s"] is None and o["pulih_s"] is None:
            print("    Kedua mode tidak pulih. Periksa apakah penyebabnya kekurangan "
                  "torsi dan bukan kendali, lalu kaitkan dengan margin torsi Subbab 4.3.")

    tulis_csv(out_dir / "control_disturbance_summary.csv",
              ["test", "joint", "mode", "n_sampel", "acuan_deg", "simpangan_deg",
               "sisa_deg", "waktu_pulih_s", "iterasi_pulih"],
              [[t, j, m, s["n"], f"{s['acuan']:.4f}", f"{s['simpangan']:.4f}",
                f"{s['sisa']:.4f}",
                "" if s["pulih_s"] is None else f"{s['pulih_s']:.3f}",
                f"{s['iterasi']:.1f}" if "iterasi" in s else ""]
               for (t, j, m), s in sorted(hasil.items())])
    return {"hasil": hasil, "seri": seri}


# ------------------------------------------------------------------- plot

def plot_penalaan(tabel: dict, rekom: dict, out_path: Path) -> None:
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        import vizstyle as V
    except ImportError:
        print("matplotlib belum terpasang; lewati plot penalaan.")
        return

    V.apply_rc(plt)
    fig, ax = plt.subplots(figsize=(9.6, 5.2))
    for i, (joint, items) in enumerate(sorted(tabel.items())):
        items = sorted(items, key=lambda d: d["kp"])
        xs = [it["kp"] for it in items]
        ys = [it["err_mean"] for it in items]
        ax.plot(xs, ys, marker=V.MARKERS[i % len(V.MARKERS)],
                color=V.SERIES[i % len(V.SERIES)], label=joint)
        osc = [it for it in items if it["osilasi_n"] > 0]
        if osc:
            ax.plot([o["kp"] for o in osc], [o["err_mean"] for o in osc],
                    linestyle="none", marker="x", markersize=11,
                    color=V.CRITICAL, zorder=5)

    db = [r["deadband"] for r in rekom.values() if r.get("deadband")]
    if db:
        V.threshold_line(ax, statistics.fmean(db), "deadband", color=V.CRITICAL)
    ax.set_xlabel("gain proporsional Kp")
    ax.set_ylabel("error akhir rata-rata (derajat)")
    # kiri atas: daerah itu kosong karena error rendah justru di Kp kecil,
    # sedangkan label deadband berada di kanan
    ax.legend(loc="upper left", title="sendi")
    V.strip_frame(ax)
    V.suptitle(fig, "Penalaan gain proporsional per sendi",
               "Tanda silang menunjukkan nilai Kp yang sudah menimbulkan osilasi")
    V.figure_caption(
        fig,
        "Sumber: benchmarks/control_test.py. Batas teoretis 0 < Kp < 1 mengikuti "
        "peluruhan e[k+1] = (1 - Kp) e[k] pada Subbab 3.6.1. Error akhir tidak dapat "
        "turun di bawah lebar deadband karena di dalam deadband koreksi memang dimatikan.",
    )
    fig.subplots_adjust(top=0.855, bottom=0.16, left=0.085, right=0.98)
    fig.savefig(out_path, dpi=200)
    print(f"  plot disimpan: {out_path}")


def plot_gangguan(seri: dict, hasil: dict, deadband: float, out_path: Path) -> None:
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        import vizstyle as V
    except ImportError:
        print("matplotlib belum terpasang; lewati plot gangguan.")
        return

    pasangan = sorted({(t, j) for (t, j, _m) in seri})
    if not pasangan:
        return

    V.apply_rc(plt)
    n = len(pasangan)
    fig, axes = plt.subplots(1, n, figsize=(min(6.2 * n, 15.0), 5.0), squeeze=False)
    gaya = {"open": (V.MUTED, "--"), "closed": (V.SERIES[0], "-")}

    for ax, (test, joint) in zip(axes[0], pasangan):
        acuan = None
        for mode in ("open", "closed"):
            pts = seri.get((test, joint, mode))
            if not pts:
                continue
            s = hasil.get((test, joint, mode))
            if s and acuan is None:
                acuan = s["acuan"]
            warna, ls = gaya[mode]
            t0 = pts[0]["t"]
            ax.plot([(p["t"] - t0) / 1000.0 for p in pts],
                    [p["a"] for p in pts], ls, color=warna,
                    label=MODE_LABEL[mode])
        if acuan is not None:
            ax.axhline(acuan, color=V.INK, lw=1.0, alpha=0.5)
            ax.axhspan(acuan - deadband, acuan + deadband,
                       color=V.SERIES[0], alpha=0.10)
            V.annotate_value(ax, 0, acuan + deadband, "deadband",
                             dx=4, dy=4, size=8.5, color=V.INK_SECOND)
        ax.set_title(f"{test} — {joint}")
        ax.set_xlabel("waktu (s)")
        ax.set_ylabel("sudut keluaran sendi (derajat)")
        ax.legend(loc="best")
        V.strip_frame(ax)

    V.suptitle(fig, "Tanggapan sendi terhadap gangguan yang sama pada dua mode",
               "Mode open-loop tidak memiliki informasi untuk memulihkan simpangan")
    V.figure_caption(
        fig,
        "Sumber: benchmarks/control_test.py. Pita terang adalah deadband di sekitar sudut acuan "
        "sebelum gangguan. Kehilangan langkah secara prinsip tidak dapat dideteksi tanpa umpan "
        "balik posisi, sehingga selisih perilaku kedua kurva bukan soal penalaan melainkan soal "
        "ketersediaan informasi.",
    )
    fig.subplots_adjust(top=0.855, bottom=0.165, left=0.07, right=0.98, wspace=0.24)
    fig.savefig(out_path, dpi=200)
    print(f"  plot disimpan: {out_path}")


# -------------------------------------------------------------------- main

def main() -> None:
    argv = [a for a in sys.argv[1:]]
    deadband = DEADBAND_BAWAAN
    if "--deadband" in argv:
        i = argv.index("--deadband")
        try:
            deadband = float(argv[i + 1])
        except (IndexError, ValueError):
            raise SystemExit("--deadband perlu satu angka, misalnya --deadband 0.25")
        del argv[i:i + 2]

    paths = [Path(a) for a in argv if not a.startswith("--")]
    if not paths:
        print(__doc__)
        sys.exit(1)

    berkas: dict[str, tuple[Path, list[dict]]] = {}
    for p in paths:
        if not p.exists():
            raise SystemExit(f"Berkas tidak ada: {p}")
        datacheck.warn_if_sample(p)
        bentuk, rows = kenali(p)
        if bentuk in berkas:
            raise SystemExit(f"Dua berkas berbentuk sama ({bentuk}): "
                             f"{berkas[bentuk][0]} dan {p}")
        berkas[bentuk] = (p, rows)
        print(f"{p.name}: dikenali sebagai data {bentuk}, {len(rows)} baris.")

    out_dir = paths[0].parent
    derau = olah_derau(berkas["derau"][1], out_dir) if "derau" in berkas else {}

    penalaan = None
    if "penalaan" in berkas:
        penalaan = olah_penalaan(berkas["penalaan"][1], out_dir, derau)
        plot_penalaan(penalaan["tabel"], penalaan["rekomendasi"],
                      out_dir / "control_tuning.png")

    periode = olah_periode(berkas["periode"][1], out_dir) if "periode" in berkas else {}
    periode_ms = (periode.get("idle") or {}).get("mean") if periode else None

    # deadband untuk ambang pemulihan: utamakan hasil penalaan, lalu derau, lalu CLI
    if penalaan:
        nilai = [r["deadband"] for r in penalaan["rekomendasi"].values() if r.get("deadband")]
        if nilai:
            deadband = statistics.fmean(nilai)
    elif derau:
        deadband = statistics.fmean(s["deadband_min"] for s in derau.values())

    if "gangguan" in berkas:
        g = olah_gangguan(berkas["gangguan"][1], out_dir, deadband, periode_ms)
        plot_gangguan(g["seri"], g["hasil"], deadband,
                      out_dir / "control_disturbance.png")

    print("\nSelesai. Angka di atas mengisi Tabel 4.9 dan Tabel 4.10 serta "
          "Gambar 4.7. Uji guardrail Sesi 6c berupa pengamatan, jadi tidak "
          "melewati skrip ini dan dicatat langsung ke Subbab 4.5.6.")


if __name__ == "__main__":
    main()
