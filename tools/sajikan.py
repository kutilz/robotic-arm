r"""Server statis kecil untuk halaman gambar CAD 3D di thesis/figures.

Kenapa ada: halaman gambar CAD memakai modul ES dan memuat main-assembly.glb
lewat XHR. Dua-duanya mati di file:// karena origin-nya null, padahal halaman
gambar SVG yang lain cukup diklik ganda. Jadi khusus halaman 3D harus disajikan
lewat HTTP. Akarnya root repo, bukan thesis/figures, supaya import relatif
../../studio/src/model/cadRig.js dan ../../studio/public/main-assembly.glb ikut
kebaca.

    python tools/sajikan.py            -> http://127.0.0.1:8765/thesis/figures/
    python tools/sajikan.py --port 0   -> port bebas yang dipilih OS

Dipakai tiga cara: dijalankan langsung untuk membuka manual di peramban, dan
diimpor oleh tools/cek_gambar.py serta tools/render_gambar.py lewat layani().

JEBAKAN WINDOWS: modul mimetypes membaca HKEY_CLASSES_ROOT, dan di sebagian
mesin .js terdaftar sebagai text/plain. Chrome menolak modul dengan MIME itu
dan pesan errornya sama sekali tidak menyebut penyebabnya. Karena itu tipe
.js, .mjs, dan .glb dipaksa di extensions_map di bawah, jangan dihapus.
"""
from __future__ import annotations

import argparse
import sys
import threading
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PORT_BAWAAN = 8765


class Penyaji(SimpleHTTPRequestHandler):
    """SimpleHTTPRequestHandler dengan MIME yang dipaksa dan log dimatikan."""

    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".glb": "model/gltf-binary",
        ".svg": "image/svg+xml",
        ".json": "application/json",
    }

    def log_message(self, *args) -> None:  # noqa: D102 - sengaja bisu
        pass


def layani(akar: Path = REPO, port: int = 0) -> tuple[ThreadingHTTPServer, str]:
    """Jalankan server di thread daemon.

    port 0 berarti biar OS yang pilih, dipakai oleh cek_gambar.py dan
    render_gambar.py supaya dua tool bisa jalan barengan tanpa rebutan port.
    Kembalikan (server, base_url) tanpa garis miring di ujung.
    """
    srv = ThreadingHTTPServer(
        ("127.0.0.1", port), partial(Penyaji, directory=str(akar)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}"


def url_gambar(base: str, berkas: Path, akar: Path = REPO) -> str:
    """URL sebuah berkas gambar relatif terhadap akar yang disajikan."""
    return f"{base}/{berkas.resolve().relative_to(akar).as_posix()}"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", type=int, default=PORT_BAWAAN,
                    help=f"port, 0 = bebas (bawaan {PORT_BAWAAN})")
    ap.add_argument("--buka", action="store_true",
                    help="langsung buka daftar gambar di peramban")
    a = ap.parse_args()

    try:
        srv, base = layani(REPO, a.port)
    except OSError as e:
        print(f"gagal membuka port {a.port}: {e}")
        print("coba: python tools/sajikan.py --port 0")
        return 1

    daftar = f"{base}/thesis/figures/index.html"
    print(f"akar    : {REPO}")
    print(f"daftar  : {daftar}")
    print("Halaman CAD 3D hanya jalan lewat alamat ini, bukan lewat klik ganda.")
    print("Ctrl+C untuk berhenti.")
    if a.buka:
        webbrowser.open(daftar)

    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        print("\nberhenti.")
        srv.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
