r"""Cek tata letak gambar skripsi di thesis/figures.

Kenapa ada: gambar-gambar itu digambar lewat koordinat SVG manual, jadi teks
gampang keluar kanvas atau saling menimpa dan itu baru kelihatan setelah
di-render. Preview pane menyimpan _fig.js versi basi, dan
getBoundingClientRect() selalu mengembalikan nol di halaman ini, jadi
pemeriksaannya harus pakai getBBox() di browser sungguhan.

    python tools/cek_gambar.py thesis/figures/*.html
    python tools/cek_gambar.py thesis/figures/gambar-2-4-kurva-torsi-stepper.html -s

Keluar dengan status 1 kalau ada error JS, elemen keluar kanvas, atau teks
bertumpuk, supaya bisa dipakai di pre-commit kalau nanti diperlukan.

Butuh playwright: `pip install playwright && playwright install chromium`.

Catatan hasil: elemen <path> kepala panah (HEAD di _fig.js) selalu dilaporkan
"keluar kanvas" karena posisinya ditentukan oleh atribut transform sementara
getBBox() mengembalikan koordinat lokal sebelum transform. Itu positif palsu
dan sudah disaring.

Halaman disajikan lewat HTTP, bukan file://, karena halaman CAD 3D memakai
modul ES dan XHR yang dua-duanya mati di origin null. Aman untuk halaman SVG
lama: semuanya cuma memakai path relatif.
"""
from __future__ import annotations

import argparse
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sajikan import REPO, layani, url_gambar  # noqa: E402

# Label gambar penuh karakter di luar cp1252 (theta, mu, tanda derajat, panah).
# Konsol Windows bawaannya cp1252, jadi tanpa ini satu label ber-theta bikin
# UnicodeEncodeError dan MEMBATALKAN sisa pemeriksaan berkas lain, bukan cuma
# merusak satu baris keluaran.
for _aliran in (sys.stdout, sys.stderr):
    if hasattr(_aliran, "reconfigure"):
        _aliran.reconfigure(encoding="utf-8", errors="replace")

# GLB masuk .gitignore, jadi 404-nya wajar di mesin yang belum menjalankan
# optimize_cad_glb.mjs. Chrome mencatatnya sebagai console.error, padahal itu
# bukan cacat tata letak: halaman CAD punya jalur cadangan kerangka SVG.
ABAI = ("Failed to load resource", "main-assembly")

JS = r"""
() => {
  const svg = document.querySelector('#card svg');
  if (!svg) return { fatal: 'SVG tidak terbentuk' };
  const W = +svg.getAttribute('width'), H = +svg.getAttribute('height');

  const luar = [], teks = [];

  // #isi sendiri selalu punya atribut transform, tapi isinya string kosong
  // selama judul dalam gambar dimatikan. hasAttribute() tetap true untuk
  // atribut kosong, jadi nilainya yang harus dicek, bukan keberadaannya.
  const digeser = n => n && n.getAttribute &&
    (n.getAttribute('transform') || '').trim() !== '';

  svg.querySelectorAll('#isi *').forEach(e => {
    let b;
    try { b = e.getBBox(); } catch (_) { return; }
    if (!b.width && !b.height) return;

    // elemen ber-transform: getBBox() koordinat lokal, bukan posisi akhir
    const berTransform = digeser(e) || digeser(e.parentNode);

    if (!berTransform &&
        (b.x < -1 || b.y < -1 || b.x + b.width > W + 1 || b.y + b.height > H + 1)) {
      luar.push({ tag: e.tagName, isi: (e.textContent || '').slice(0, 46),
                  x: +b.x.toFixed(1), y: +b.y.toFixed(1),
                  w: +b.width.toFixed(1), h: +b.height.toFixed(1) });
    }
    if (e.tagName === 'text' && !berTransform) {
      teks.push({ isi: (e.textContent || '').slice(0, 46),
                  x: b.x, y: b.y, w: b.width, h: b.height });
    }
  });

  // tumpukan antar teks; tiap kotak dipotong 1,5 px di tiap sisi supaya baris
  // yang cuma bersinggungan tidak ikut dilaporkan
  const tum = [], P = 1.5;
  for (let i = 0; i < teks.length; i++) {
    for (let j = i + 1; j < teks.length; j++) {
      const a = teks[i], b = teks[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) - 2 * P;
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) - 2 * P;
      if (ox > 0 && oy > 0) {
        tum.push({ a: a.isi, b: b.isi, ox: +ox.toFixed(1), oy: +oy.toFixed(1) });
      }
    }
  }
  return { W, H, jumlahTeks: teks.length, luar, tumpuk: tum };
}
"""


def cek(pg, path: Path, base: str, simpan: Path | None) -> bool:
    """True kalau bersih."""
    errs: list[str] = []
    pg.on("pageerror", lambda e: errs.append(f"pageerror: {e}"))
    pg.on("console", lambda m: errs.append(f"console.{m.type}: {m.text}")
          if m.type == "error" else None)

    print(f"== {path.name}")

    # "Ini halaman gambar atau bukan" diperiksa dari TEKS BERKAS, bukan dari DOM
    # hidup. Halaman CAD 3D memblokir main thread selama WebGL merender (belasan
    # detik kalau jatuh ke SwiftShader tanpa GPU), dan selama itu kueri selector
    # apa pun tidak terjawab. Menebak "bukan halaman gambar" dari selector yang
    # timeout karena itu salah: index.html dan halaman CAD sama-sama diam.
    # Bukan kegagalan: index.html ikut kena kalau dipanggil dengan glob
    # `thesis/figures/*.html`, dan itu pemakaian yang wajar. Dulu ini
    # mengembalikan False sehingga seluruh proses keluar dengan status 1
    # walaupun semua gambarnya sebenarnya bersih.
    if 'id="card"' not in path.read_text(encoding="utf-8", errors="ignore"):
        print("   LEWAT: bukan halaman gambar (tidak ada #card)")
        return True

    pg.goto(url_gambar(base, path))

    # Tunggu SVG benar-benar ada, bukan 350 ms buta: halaman CAD 3D baru
    # memanggil Fig.build() setelah GLB dimuat dan WebGL selesai merender.
    # state="attached" WAJIB: bawaan wait_for_selector menunggu elemen TERLIHAT,
    # dan <div id="card"> yang masih kosong tingginya nol.
    try:
        pg.wait_for_selector("#card svg", state="attached", timeout=180_000)
    except PlaywrightTimeoutError:
        print("   FATAL: SVG tidak terbentuk (habis waktu tunggu 180 s)")
        for e in errs:
            print("   ERROR JS:", e)
        return False
    pg.wait_for_timeout(200)  # jeda mengendap untuk tata letak teks
    h = pg.evaluate(JS)

    if simpan:
        pg.screenshot(path=str(simpan / (path.stem + ".png")), full_page=True)

    if h.get("fatal"):
        print("   FATAL:", h["fatal"])
        return False

    errs = [e for e in errs if not all(k in e for k in ABAI)]
    for e in errs:
        print("   ERROR JS:", e)

    print(f"   kanvas {h['W']}x{h['H']}, {h['jumlahTeks']} teks", end="")
    if not errs and not h["luar"] and not h["tumpuk"]:
        print("  -> bersih")
        return True
    print()

    for o in h["luar"]:
        print(f"   KELUAR KANVAS  {o['tag']:6s} x={o['x']} y={o['y']} "
              f"w={o['w']} h={o['h']}  {o['isi']!r}")
    for t in h["tumpuk"]:
        print(f"   BERTUMPUK      +{t['ox']}x{t['oy']}  {t['a']!r}  vs  {t['b']!r}")
    return False


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("berkas", nargs="+", help="berkas .html gambar")
    ap.add_argument("-s", "--simpan", action="store_true",
                    help="simpan screenshot ke folder sementara dan cetak lokasinya")
    a = ap.parse_args()

    simpan = Path(tempfile.mkdtemp(prefix="cek-gambar-")) if a.simpan else None
    bersih = True
    srv, base = layani(REPO)

    with sync_playwright() as p:
        # SwiftShader: halaman CAD 3D butuh WebGL, dan mesin CI atau remote
        # desktop sering tidak punya GPU. Tidak berpengaruh ke halaman SVG.
        br = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader",
                                     "--enable-unsafe-swiftshader"])
        for berkas in a.berkas:
            pg = br.new_page(viewport={"width": 1400, "height": 1000})
            bersih &= cek(pg, Path(berkas).resolve(), base, simpan)
            pg.close()
        br.close()
    srv.shutdown()

    if simpan:
        print(f"\nScreenshot: {simpan}")
    return 0 if bersih else 1


if __name__ == "__main__":
    sys.exit(main())
