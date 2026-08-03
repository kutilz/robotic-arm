r"""Render halaman gambar skripsi jadi PNG cetak, tanpa klik manual.

Kenapa terpisah dari cek_gambar.py: itu linter (murni, cuma exit code, aman di
pre-commit), ini builder (menulis ke dalam repo, dan build_draft.py bergantung
pada keluarannya). Kontrak dan mode gagalnya beda. Yang dibagi cuma sajikan.py.

    python tools/render_gambar.py                     semua halaman terdaftar
    python tools/render_gambar.py lengan-pose-kerja   satu halaman
    python tools/render_gambar.py gambar-2-1-konfigurasi-6dof --keluar /tmp

Tool ini menggerakkan tombol #pngBtn yang sudah ada di _fig.js, bukan jalur
ekspor sendiri. Jadi dia menguji persis jalur kode yang dipakai manusia, dan
dia bekerja untuk SEMUA halaman gambar di thesis/figures, bukan cuma yang CAD.

Butuh playwright: `pip install playwright && playwright install chromium`.
"""
from __future__ import annotations

import argparse
import struct
import sys
from pathlib import Path

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sajikan import REPO, layani, url_gambar  # noqa: E402

FIGURES = REPO / "thesis" / "figures"
KELUAR_BAWAAN = FIGURES / "cad"

# Lebar minimum supaya layak cetak. build_draft.py memancarkan {width=100%} dan
# format_docx.py memakai kolom teks 14 cm tanpa penskalaan, jadi 300 dpi butuh
# 14 / 2,54 * 300 = 1654 piksel.
LEBAR_MIN = 1654

# (stem halaman, nama berkas keluaran, skala, varian atau None)
HALAMAN: list[tuple[str, str, int, str | None]] = [
    ("lengan-pose-kerja", "lengan-pose-kerja.png", 3, None),
    ("lengan-mekanisme", "lengan-mekanisme.png", 3, "polos"),
    ("lengan-mekanisme", "lengan-mekanisme-legenda.png", 3, "lengkap"),
    ("cycloidal-j2-exploded", "cycloidal-j2-exploded.png", 3, None),
    ("lengan-dimensi", "lengan-dimensi.png", 3, None),
]


def ringkas(p: Path) -> str:
    """Path relatif ke repo kalau bisa, kalau tidak apa adanya."""
    try:
        return str(p.relative_to(REPO))
    except ValueError:
        return str(p)


def ukuran_png(p: Path) -> tuple[int, int]:
    """Lebar dan tinggi dari header IHDR. Hemat, tanpa perlu Pillow."""
    with p.open("rb") as f:
        kepala = f.read(24)
    if kepala[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"{p.name} bukan PNG")
    return struct.unpack(">II", kepala[16:24])


def render(pg, stem: str, tujuan: Path, skala: int, varian: str | None,
           base: str) -> bool:
    """True kalau berhasil dan hasilnya layak cetak."""
    halaman = FIGURES / f"{stem}.html"
    label = f"{stem}" + (f" [{varian}]" if varian else "")
    print(f"== {label}")
    if not halaman.exists():
        print(f"   GAGAL: {ringkas(halaman)} tidak ada")
        return False

    galat: list[str] = []
    pg.on("pageerror", lambda e: galat.append(str(e)))
    pg.goto(url_gambar(base, halaman))

    try:
        # state="attached": bawaannya menunggu elemen TERLIHAT, dan itu gagal
        # untuk halaman yang SVG-nya belum sempat mengisi tinggi #card.
        pg.wait_for_selector("#card svg", state="attached", timeout=120_000)
    except PlaywrightTimeoutError:
        print("   GAGAL: SVG tidak terbentuk dalam 120 s")
        for g in galat:
            print("   ERROR JS:", g)
        return False

    # Halaman CAD menandai dirinya sendiri. Halaman SVG lama tidak punya ini,
    # jadi None dianggap lolos.
    siap = pg.evaluate("() => window.__cadOk")
    if siap is False:
        print("   GAGAL: model CAD tidak termuat, PNG-nya cuma kerangka.")
        print("   Jalankan dulu:")
        print('     node tools/optimize_cad_glb.mjs "onshape/Main Assembly (Complete).glb"')
        return False

    if varian:
        pg.select_option("#varian", varian)
        pg.wait_for_timeout(400)
    pg.select_option("#scale", str(skala))

    tujuan.parent.mkdir(parents=True, exist_ok=True)
    try:
        with pg.expect_download(timeout=180_000) as unduhan:
            pg.click("#pngBtn")
        unduhan.value.save_as(str(tujuan))
    except PlaywrightTimeoutError:
        print("   GAGAL: tombol Unduh PNG tidak menghasilkan berkas dalam 180 s")
        print("   status halaman:", pg.text_content("#status"))
        return False

    for g in galat:
        print("   ERROR JS:", g)

    w, h = ukuran_png(tujuan)
    kb = tujuan.stat().st_size / 1024
    dpi = round(w / (14 / 2.54))
    print(f"   {ringkas(tujuan)}  {w}x{h} px, {kb:.0f} KB, "
          f"{dpi} dpi di kolom 14 cm")
    if w < LEBAR_MIN:
        print(f"   PERINGATAN: lebar {w} di bawah {LEBAR_MIN} px (300 dpi). "
              f"Naikkan skala atau lebar kanvas.")
        return False
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("halaman", nargs="*",
                    help="stem berkas html, kosong = semua yang terdaftar")
    ap.add_argument("--keluar", type=Path, default=KELUAR_BAWAAN,
                    help=f"folder keluaran (bawaan {KELUAR_BAWAAN.relative_to(REPO)})".replace("\\", "/"))
    ap.add_argument("--skala", type=int, choices=(2, 3, 4),
                    help="paksa skala, kalau tidak diisi pakai daftar di dalam tool")
    ap.add_argument("--tampak", action="store_true",
                    help="jalankan peramban terlihat, buat menelusuri masalah WebGL")
    a = ap.parse_args()

    if a.halaman:
        pilih = [t for t in HALAMAN if t[0] in a.halaman]
        # halaman di luar daftar tetap boleh dirender, nama keluarannya
        # mengikuti cfg.nama di halaman itu sendiri
        tak_dikenal = set(a.halaman) - {t[0] for t in HALAMAN}
        pilih += [(s, f"{s}.png", 3, None) for s in sorted(tak_dikenal)]
    else:
        pilih = list(HALAMAN)

    if a.skala:
        pilih = [(s, n, a.skala, v) for s, n, _, v in pilih]

    srv, base = layani(REPO)
    lolos = True
    with sync_playwright() as p:
        # SwiftShader supaya tetap jalan di mesin tanpa GPU (remote desktop, CI).
        br = p.chromium.launch(
            headless=not a.tampak,
            args=["--use-gl=angle", "--use-angle=swiftshader",
                  "--enable-unsafe-swiftshader"])
        ctx = br.new_context(viewport={"width": 1500, "height": 1000},
                             accept_downloads=True)
        for stem, nama, skala, varian in pilih:
            pg = ctx.new_page()
            lolos &= render(pg, stem, a.keluar / nama, skala, varian, base)
            pg.close()
        ctx.close()
        br.close()
    srv.shutdown()

    if not pilih:
        print("tidak ada halaman yang cocok.")
        return 1
    print("\nselesai." if lolos else "\nada yang gagal, lihat di atas.")
    return 0 if lolos else 1


if __name__ == "__main__":
    sys.exit(main())
