"""Generator PDF kertas milimeter A4 untuk uji repeatability lengan robot.

Grid digambar skala 1:1 (100%), jadi jarak antar garis di kertas benar-benar
sesuai pitch yang diminta. Semua koordinat dihitung dalam mm lalu dikonversi
ke point (1 mm = 72/25.4 pt) tanpa penskalaan tambahan.

Dua level garis: minor (default 5 mm, tipis) dan major (default 10 mm, tebal).
Default sengaja dipilih yang aman dicetak printer rumahan; pitch minor 1 mm
butuh garis 0.10 mm yang sudah mendekati batas satu dot printer 600 dpi.

Contoh:
    python tools/buat_grid_cetak.py
    python tools/buat_grid_cetak.py --minor 1 --lw-minor 0.10 --out tools/cetak/grid-mm-a4.pdf
    python tools/buat_grid_cetak.py --minor 0 --out tools/cetak/grid-1cm-saja.pdf
    python tools/buat_grid_cetak.py --tes-garis
"""

from __future__ import annotations

import argparse
from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas

LEBAR_MM = 210.0
TINGGI_MM = 297.0

# Margin (kiri, kanan, bawah, atas) dalam mm.
# Versi berlabel menyisakan ruang untuk angka sumbu dan batang cek skala,
# sekaligus menjauhi zona non-printable printer rumahan (inkjet HP bisa
# menyisakan 12.7 mm di sisi bawah).
MARGIN_LABEL = (15.0, 14.0, 13.0, 22.0)
MARGIN_POLOS = (10.0, 10.0, 10.0, 10.0)


def hitung_area(pitch_mm: float, margin: tuple[float, float, float, float]):
    """Kembalikan (x0, y0, jumlah kolom, jumlah baris) grid di dalam margin."""
    ml, mr, mb, mt = margin
    kolom = int((LEBAR_MM - ml - mr) // pitch_mm)
    baris = int((TINGGI_MM - mb - mt) // pitch_mm)
    if kolom < 1 or baris < 1:
        raise SystemExit(f"pitch {pitch_mm} mm terlalu besar untuk A4")
    x0 = ml + (LEBAR_MM - ml - mr - kolom * pitch_mm) / 2.0
    y0 = mb + (TINGGI_MM - mb - mt - baris * pitch_mm) / 2.0
    return x0, y0, kolom, baris


def garis_minor(c, minor_mm, lw_mm, x0, y0, x1, y1, rasio):
    """Garis halus; yang berimpit dengan garis major dilewati (ditimpa major)."""
    c.setLineWidth(lw_mm * mm)
    n_x = int(round((x1 - x0) / minor_mm))
    n_y = int(round((y1 - y0) / minor_mm))
    batch = []
    for i in range(n_x + 1):
        if rasio and i % rasio == 0:
            continue
        x = (x0 + i * minor_mm) * mm
        batch.append((x, y0 * mm, x, y1 * mm))
    for j in range(n_y + 1):
        if rasio and j % rasio == 0:
            continue
        y = (y0 + j * minor_mm) * mm
        batch.append((x0 * mm, y, x1 * mm, y))
    c.lines(batch)


def garis_major(c, pitch_mm, lw_mm, x0, y0, x1, y1, kolom, baris):
    c.setLineWidth(lw_mm * mm)
    batch = []
    for i in range(kolom + 1):
        x = (x0 + i * pitch_mm) * mm
        batch.append((x, y0 * mm, x, y1 * mm))
    for j in range(baris + 1):
        y = (y0 + j * pitch_mm) * mm
        batch.append((x0 * mm, y, x1 * mm, y))
    c.lines(batch)


def gambar_label(c, pitch_mm, x0, y0, x1, y1, kolom, baris):
    """Angka sumbu (mm, origin di sudut kiri bawah grid) plus batang cek skala."""
    c.setFillGray(0.0)
    c.setFont("Helvetica", 4.5)
    for i in range(0, kolom + 1, 2):
        x = x0 + i * pitch_mm
        c.drawCentredString(x * mm, (y1 + 2.0) * mm, f"{i * pitch_mm:g}")
    for j in range(0, baris + 1, 2):
        y = y0 + j * pitch_mm
        c.drawRightString((x0 - 1.5) * mm, (y - 1.5) * mm, f"{j * pitch_mm:g}")

    # Batang verifikasi skala: ukur pakai caliper setelah dicetak. Dibuat dua arah
    # karena error penskalaan printer beda antara arah scan dan arah feed kertas.
    c.setLineWidth(0.25 * mm)

    bar_y = y1 + 8.0
    c.line(x0 * mm, bar_y * mm, (x0 + 100.0) * mm, bar_y * mm)
    for x in (x0, x0 + 50.0, x0 + 100.0):
        c.line(x * mm, (bar_y - 1.5) * mm, x * mm, (bar_y + 1.5) * mm)
    c.setFont("Helvetica", 5.5)
    c.drawString((x0 + 102.0) * mm, (bar_y - 1.8) * mm, "cek skala X: harus 100.0 mm")

    bar_x = x1 + 3.0
    c.line(bar_x * mm, y0 * mm, bar_x * mm, (y0 + 100.0) * mm)
    for y in (y0, y0 + 50.0, y0 + 100.0):
        c.line((bar_x - 1.5) * mm, y * mm, (bar_x + 1.5) * mm, y * mm)
    c.saveState()
    c.translate((bar_x + 2.8) * mm, (y0 + 2.0) * mm)
    c.rotate(90)
    c.drawString(0, 0, "cek skala Y: harus 100.0 mm")
    c.restoreState()


def gambar_grid(c, pitch_mm, lw_mm, minor_mm, lw_minor_mm, pakai_label):
    margin = MARGIN_LABEL if pakai_label else MARGIN_POLOS
    x0, y0, kolom, baris = hitung_area(pitch_mm, margin)
    x1 = x0 + kolom * pitch_mm
    y1 = y0 + baris * pitch_mm

    c.setStrokeGray(0.0)
    c.setLineCap(0)  # butt cap, supaya garis tidak melar di ujung

    if minor_mm > 0:
        rasio = int(round(pitch_mm / minor_mm))
        if abs(rasio * minor_mm - pitch_mm) > 1e-9:
            raise SystemExit(f"pitch {pitch_mm} mm harus kelipatan bulat dari minor {minor_mm} mm")
        garis_minor(c, minor_mm, lw_minor_mm, x0, y0, x1, y1, rasio)

    garis_major(c, pitch_mm, lw_mm, x0, y0, x1, y1, kolom, baris)

    if pakai_label:
        gambar_label(c, pitch_mm, x0, y0, x1, y1, kolom, baris)

    return x0, y0, kolom, baris


# Lebar garis uji, mm. Rentangnya sengaja melewati batas dot printer 600 dpi
# (1 dot = 0.0423 mm) supaya kelihatan di mana garis mulai pecah atau memudar.
LEBAR_UJI = [0.05, 0.07, 0.09, 0.10, 0.12, 0.15, 0.20, 0.25, 0.30, 0.40]


def gambar_tes_garis(c):
    """Halaman uji: petak 1 mm dengan bermacam lebar garis, biar ketahuan
    lebar paling tipis yang masih dicetak rata oleh printer yang dipakai."""
    x_label = 15.0
    x_vert = 32.0
    x_horz = 92.0
    lebar_petak = 50.0
    tinggi_petak = 14.0
    y_atas = 268.0
    jarak_baris = 22.0

    c.setStrokeGray(0.0)
    c.setFillGray(0.0)
    c.setLineCap(0)

    c.setFont("Helvetica", 7)
    c.drawString(x_label * mm, 283.0 * mm, "Tes garis printer, petak 1 mm. Cetak 1:1, lalu lihat dari jarak baca.")
    c.setFont("Helvetica", 5.5)
    c.drawString(x_label * mm, 278.5 * mm,
                 "Pilih lebar paling tipis yang garisnya masih rata, sama hitam, dan tidak menyatu.")
    c.drawString(x_vert * mm, 274.0 * mm, "garis vertikal (arah scan)")
    c.drawString(x_horz * mm, 274.0 * mm, "garis horizontal (arah feed kertas)")

    for k, w in enumerate(LEBAR_UJI):
        y = y_atas - k * jarak_baris
        c.setFont("Helvetica", 6)
        c.drawString(x_label * mm, (y - tinggi_petak / 2 - 1.0) * mm, f"{w:.2f} mm")

        c.setLineWidth(w * mm)
        batch = []
        for i in range(int(lebar_petak) + 1):
            x = (x_vert + i) * mm
            batch.append((x, y * mm, x, (y - tinggi_petak) * mm))
        for j in range(int(tinggi_petak) + 1):
            yy = (y - j) * mm
            batch.append((x_horz * mm, yy, (x_horz + lebar_petak) * mm, yy))
        c.lines(batch)

    c.setFont("Helvetica", 5.5)
    c.drawString(x_label * mm, 32.0 * mm,
                 "Catatan: pada 600 dpi 1 dot = 0.042 mm, jadi lebar di bawah 0.09 mm biasanya")
    c.drawString(x_label * mm, 28.0 * mm,
                 "dibulatkan ke 1 sampai 2 dot dan ketebalannya jadi tidak seragam antar garis.")


def buat_tes_pdf(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    c = canvas.Canvas(str(path), pagesize=A4)
    c.setTitle("Tes lebar garis printer")
    c.setAuthor("robotic-arm")
    gambar_tes_garis(c)
    c.showPage()
    c.save()
    return path


def buat_pdf(path, pitch_mm, lw_mm, minor_mm, lw_minor_mm, pakai_label):
    path.parent.mkdir(parents=True, exist_ok=True)
    c = canvas.Canvas(str(path), pagesize=A4)
    c.setTitle(f"Kertas milimeter A4 (major {pitch_mm:g} mm) uji repeatability")
    c.setAuthor("robotic-arm")
    info = gambar_grid(c, pitch_mm, lw_mm, minor_mm, lw_minor_mm, pakai_label)
    c.showPage()
    c.save()
    return info


def main() -> None:
    p = argparse.ArgumentParser(description="Bikin PDF kertas milimeter A4 skala 1:1")
    p.add_argument("--pitch", type=float, default=10.0, help="pitch garis tebal, mm (default 10)")
    p.add_argument("--lw", type=float, default=0.35, help="tebal garis major, mm (default 0.35)")
    p.add_argument("--minor", type=float, default=5.0, help="pitch garis tipis, mm (0 = mati)")
    p.add_argument("--lw-minor", type=float, default=0.15, help="tebal garis minor, mm (default 0.15)")
    p.add_argument("--out", type=Path, default=Path("tools/cetak/grid-5mm-a4.pdf"))
    p.add_argument("--polos", action="store_true", help="tanpa label mm dan batang cek skala")
    p.add_argument("--tes-garis", action="store_true",
                   help="bikin halaman uji lebar garis, bukan grid")
    args = p.parse_args()

    if args.tes_garis:
        out = args.out if args.out != Path("tools/cetak/grid-5mm-a4.pdf") else Path("tools/cetak/tes-garis-printer.pdf")
        buat_tes_pdf(out)
        print(f"{out}: uji lebar garis {LEBAR_UJI[0]:g} sampai {LEBAR_UJI[-1]:g} mm pada petak 1 mm")
        return

    x0, y0, kolom, baris = buat_pdf(
        args.out, args.pitch, args.lw, args.minor, args.lw_minor, not args.polos
    )
    minor = f"minor {args.minor:g} mm @ {args.lw_minor:g} mm" if args.minor > 0 else "tanpa minor"
    print(
        f"{args.out}: {kolom} x {baris} kotak major @ {args.pitch:g} mm "
        f"({kolom * args.pitch:g} x {baris * args.pitch:g} mm), garis major {args.lw:g} mm, {minor}, "
        f"origin grid di ({x0:.1f}, {y0:.1f}) mm dari sudut kiri bawah kertas"
    )


if __name__ == "__main__":
    main()
