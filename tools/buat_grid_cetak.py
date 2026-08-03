"""Generator PDF grid A4 untuk uji repeatability lengan robot.

Grid dicetak dengan skala 1:1 (100%), jadi jarak antar garis di kertas
benar-benar sesuai pitch yang diminta. Semua koordinat dihitung dalam mm
lalu dikonversi ke point (1 mm = 72/25.4 pt) tanpa penskalaan tambahan.

Contoh:
    python tools/buat_grid_cetak.py
    python tools/buat_grid_cetak.py --pitch 5 --lw 0.15 --out tools/cetak/grid-5mm.pdf
    python tools/buat_grid_cetak.py --polos
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
MARGIN_LABEL = (15.0, 12.0, 13.0, 22.0)
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


def gambar_grid(c: canvas.Canvas, pitch_mm: float, lw_mm: float, pakai_label: bool):
    margin = MARGIN_LABEL if pakai_label else MARGIN_POLOS
    x0, y0, kolom, baris = hitung_area(pitch_mm, margin)
    x1 = x0 + kolom * pitch_mm
    y1 = y0 + baris * pitch_mm

    c.setStrokeGray(0.0)
    c.setLineWidth(lw_mm * mm)
    c.setLineCap(0)  # butt cap, supaya garis tidak melar di ujung

    for i in range(kolom + 1):
        x = x0 + i * pitch_mm
        c.line(x * mm, y0 * mm, x * mm, y1 * mm)

    for j in range(baris + 1):
        y = y0 + j * pitch_mm
        c.line(x0 * mm, y * mm, x1 * mm, y * mm)

    if pakai_label:
        gambar_label(c, pitch_mm, lw_mm, x0, y0, x1, y1, kolom, baris)

    return x0, y0, kolom, baris


def gambar_label(c, pitch_mm, lw_mm, x0, y0, x1, y1, kolom, baris):
    """Angka sumbu (mm, origin di sudut kiri bawah grid) plus batang cek skala."""
    c.setFillGray(0.0)
    c.setFont("Helvetica", 4.5)
    for i in range(0, kolom + 1, 2):
        x = x0 + i * pitch_mm
        c.drawCentredString(x * mm, (y1 + 2.0) * mm, f"{i * pitch_mm:g}")
    for j in range(0, baris + 1, 2):
        y = y0 + j * pitch_mm
        c.drawRightString((x0 - 1.5) * mm, (y - 1.5) * mm, f"{j * pitch_mm:g}")

    # Batang verifikasi skala: ukur pakai penggaris/caliper setelah dicetak.
    bar_y = y1 + 8.0
    c.setLineWidth(0.25 * mm)
    c.line(x0 * mm, bar_y * mm, (x0 + 100.0) * mm, bar_y * mm)
    for x in (x0, x0 + 50.0, x0 + 100.0):
        c.line(x * mm, (bar_y - 1.5) * mm, x * mm, (bar_y + 1.5) * mm)
    c.setFont("Helvetica", 5.5)
    c.drawString((x0 + 102.0) * mm, (bar_y - 1.8) * mm, "cek skala: batang ini harus 100.0 mm")

    jejak = (
        f"grid {pitch_mm:g} mm, garis {lw_mm:g} mm, {kolom} x {baris} kotak "
        f"({kolom * pitch_mm:g} x {baris * pitch_mm:g} mm). "
        f"Cetak Actual size / 100%, bukan Fit to page."
    )
    c.setFont("Helvetica", 5.5)
    c.drawString(x0 * mm, (y1 + 13.0) * mm, jejak)


def buat_pdf(path: Path, pitch_mm: float, lw_mm: float, pakai_label: bool) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    c = canvas.Canvas(str(path), pagesize=A4)
    c.setTitle(f"Grid {pitch_mm:g} mm A4 uji repeatability")
    c.setAuthor("robotic-arm")
    info = gambar_grid(c, pitch_mm, lw_mm, pakai_label)
    c.showPage()
    c.save()
    return info


def main() -> None:
    p = argparse.ArgumentParser(description="Bikin PDF grid A4 skala 1:1")
    p.add_argument("--pitch", type=float, default=10.0, help="jarak antar garis, mm (default 10)")
    p.add_argument("--lw", type=float, default=0.2, help="tebal garis, mm (default 0.2)")
    p.add_argument("--out", type=Path, default=Path("tools/cetak/grid-1cm-a4.pdf"))
    p.add_argument("--polos", action="store_true", help="tanpa label mm dan batang cek skala")
    args = p.parse_args()

    x0, y0, kolom, baris = buat_pdf(args.out, args.pitch, args.lw, not args.polos)
    print(
        f"{args.out}: {kolom} x {baris} kotak @ {args.pitch:g} mm "
        f"({kolom * args.pitch:g} x {baris * args.pitch:g} mm), garis {args.lw:g} mm, "
        f"origin grid di ({x0:.1f}, {y0:.1f}) mm dari sudut kiri bawah kertas"
    )


if __name__ == "__main__":
    main()
