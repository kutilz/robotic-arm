r"""Rekam dokumentasi pengerjaan lengan robot lewat webcam OBSBOT.

Kenapa ada: progres perakitan/kalibrasi cuma kelihatan di commit message, padahal
skripsi butuh bukti visual - foto rakitan sebelum/sesudah, klip uji gerak sendi,
timelapse sesi kerja. Skrip ini yang mengurus kameranya supaya tidak perlu buka
OBSBOT Center cuma buat ambil satu foto.

    python tools/capture_docs.py list
    python tools/capture_docs.py aim                            # setir gimbal, live
    python tools/capture_docs.py snap  -l "J2 cycloidal terpasang"
    python tools/capture_docs.py clip  -d 30 -l "uji sweep J1"
    python tools/capture_docs.py lapse -i 5 -m 45 -l "rakit wrist"

Butuh GUI? `python tools/dokumentasi_ui.py`.

Berkasnya masuk ke F:\dokumentasi-robotic-arm\<tanggal>\ - sengaja di luar repo,
karena foto 4K dan video menumpuk cepat sementara drive C tinggal sedikit. Yang
ikut di-commit cuma indeksnya: tiap capture menambah satu baris di
docs/dokumentasi-visual.md, jadi urutan kerjanya tetap terbaca walau drive F:
sedang tidak terpasang. Pindah drive? set env ARM_DOCS_DIR.

Soal gimbal: Tiny 2 Lite menuruti perintah UVC PTZ standar, jadi pan/tilt/zoom
bisa disetir dari sini - TAPI hanya lewat backend DirectShow (MSMF menerima
set() lalu mengabaikannya, terbukti waktu diuji). Makanya seluruh skrip ini
dipaku ke CAP_DSHOW; kebetulan DSHOW juga sanggup 4K, jadi tidak ada yang
dikorbankan. Range terukur di unit ini: pan +-130 deg, tilt +-90 deg, zoom 0-100.

Arah yang sering dipakai disimpan sebagai preset di tools/kamera_preset.json -
ikut di-commit, supaya foto "sebelum/sesudah" benar-benar dari sudut yang sama.

Catatan: kalau AI tracking aktif di OBSBOT Center, kamera akan menarik gimbal
balik mengikuti orang dan melawan perintah di sini. Matikan tracking dulu kalau
arahnya terasa "membandel".
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import time
from pathlib import Path

import cv2

# OpenCV meneriakkan "backend can't be used to capture by index" tiap probe index
# kosong - benar tapi tidak actionable, dan menenggelamkan output kita.
# Submodule cv2.utils.logging tidak selalu ke-expose (beda antar build
# opencv-python, terbukti beda antara PC dan laptop) - diamkan saja kalau hilang.
try:
    cv2.utils.logging.setLogLevel(cv2.utils.logging.LOG_LEVEL_ERROR)
except AttributeError:
    pass

REPO = Path(__file__).resolve().parent.parent

# Media disimpan di luar repo: foto 4K + video menumpuk cepat dan drive C cuma
# sisa ~27 GB. Override lewat env ARM_DOCS_DIR kalau drive-nya pindah huruf.
MEDIA = Path(os.environ.get("ARM_DOCS_DIR", r"F:\dokumentasi-robotic-arm"))

# ...tapi indeksnya tetap di dalam repo supaya ikut ter-commit dan tetap terbaca
# walau drive F: sedang tidak terpasang
LOG = REPO / "docs" / "dokumentasi-visual.md"
PRESET = Path(__file__).resolve().parent / "kamera_preset.json"

BACKEND = cv2.CAP_DSHOW  # satu-satunya backend yang gimbal-nya nurut - lihat docstring

FOTO = (3840, 2160)   # foto: pakai sensor penuh, detail baut/kabel kebaca
VIDEO = (1920, 1080)  # video: 4K bikin encoder OpenCV tidak sanggup 30 fps
WARMUP = 15           # frame yang dibuang dulu: auto-exposure OBSBOT butuh ~0.5 s

PAN = (-130.0, 130.0)
TILT = (-90.0, 90.0)
ZOOM = (0.0, 100.0)


def jepit(nilai: float, batas: tuple[float, float]) -> float:
    return max(batas[0], min(batas[1], nilai))


# --- kamera -----------------------------------------------------------------

def buka(index: int, size: tuple[int, int]) -> tuple[cv2.VideoCapture, tuple[int, int]]:
    """Buka kamera pada resolusi yang diminta, kembalikan resolusi sebenarnya."""
    cap = cv2.VideoCapture(index, BACKEND)
    if not cap.isOpened():
        sys.exit(
            f"Kamera index {index} tidak bisa dibuka.\n"
            "Tutup aplikasi lain yang memakai kamera (OBSBOT Center, Zoom, Meet), "
            "lalu jalankan `python tools/capture_docs.py list`."
        )
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, size[0])
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, size[1])
    nyata = (int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)))
    if nyata != size:
        print(f"  catatan: minta {size[0]}x{size[1]}, kamera kasih {nyata[0]}x{nyata[1]}")
    return cap, nyata


def hangatkan(cap: cv2.VideoCapture, n: int = WARMUP) -> None:
    """Buang beberapa frame pertama - kalau tidak, fotonya gelap/blur."""
    for _ in range(n):
        cap.read()


def arahkan(cap, pan=None, tilt=None, zoom=None, tunggu: float = 2.0) -> None:
    """Setir gimbal. Gerakannya asinkron, jadi beri jeda sebelum ambil frame.

    Nilai balik get() tertinggal di belakang posisi nyata (terbukti waktu diuji:
    set 2 lalu 3 tetap terbaca 1), jadi jangan pakai get() buat verifikasi -
    posisi diingat oleh pemanggil.
    """
    gerak = False
    for nilai, prop, batas in (
        (pan, cv2.CAP_PROP_PAN, PAN),
        (tilt, cv2.CAP_PROP_TILT, TILT),
        (zoom, cv2.CAP_PROP_ZOOM, ZOOM),
    ):
        if nilai is not None:
            cap.set(prop, float(jepit(float(nilai), batas)))
            gerak = True
    if gerak and tunggu:
        time.sleep(tunggu)


# --- preset arah ------------------------------------------------------------

def baca_preset() -> dict:
    if not PRESET.exists():
        return {}
    try:
        return json.loads(PRESET.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        sys.exit(f"{PRESET.name} rusak: {e}")


def tulis_preset(data: dict) -> None:
    PRESET.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def pakai_preset(nama: str) -> dict:
    data = baca_preset()
    if nama not in data:
        tersedia = ", ".join(sorted(data)) or "(belum ada)"
        sys.exit(f"Preset '{nama}' tidak ada. Yang tersedia: {tersedia}")
    return data[nama]


def terapkan_arah(cap, args) -> None:
    """Gabungkan preset + flag manual; flag menang kalau dua-duanya diberi."""
    p = t = z = None
    if getattr(args, "preset", None):
        v = pakai_preset(args.preset)
        p, t, z = v.get("pan"), v.get("tilt"), v.get("zoom")
    if getattr(args, "pan", None) is not None:
        p = args.pan
    if getattr(args, "tilt", None) is not None:
        t = args.tilt
    if getattr(args, "zoom", None) is not None:
        z = args.zoom
    if (p, t, z) != (None, None, None):
        print(f"  arah: pan={p} tilt={t} zoom={z}")
        arahkan(cap, p, t, z)


# --- berkas & log -----------------------------------------------------------

def stempel(frame, teks: str):
    """Tulis waktu + label di pojok kiri bawah, biar urutan kerja tidak tertukar."""
    h = frame.shape[0]
    skala = h / 1080.0
    font = cv2.FONT_HERSHEY_SIMPLEX
    pos = (int(24 * skala), h - int(24 * skala))
    # outline hitam dulu supaya tetap terbaca di atas latar terang (dinding putih)
    cv2.putText(frame, teks, pos, font, 0.9 * skala, (0, 0, 0), int(6 * skala), cv2.LINE_AA)
    cv2.putText(frame, teks, pos, font, 0.9 * skala, (255, 255, 255), int(2 * skala), cv2.LINE_AA)
    return frame


def folder_hari_ini() -> Path:
    drive = Path(MEDIA.anchor)
    if drive.anchor and not drive.exists():
        sys.exit(
            f"Drive {MEDIA.anchor} tidak terpasang, padahal media disimpan di {MEDIA}.\n"
            "Colok drive-nya, atau arahkan ke tempat lain:\n"
            '  $env:ARM_DOCS_DIR = "D:\\dokumentasi-robotic-arm"'
        )
    d = MEDIA / dt.date.today().isoformat()
    d.mkdir(parents=True, exist_ok=True)
    return d


def catat(berkas: Path, label: str, keterangan: str) -> None:
    """Tambah satu baris ke log di repo - jejak tertulis yang ikut di-commit."""
    LOG.parent.mkdir(parents=True, exist_ok=True)
    if not LOG.exists():
        LOG.write_text(
            "# Log dokumentasi visual\n\n"
            "Dibuat otomatis oleh `tools/capture_docs.py`.\n\n"
            f"Berkas medianya sendiri disimpan di luar repo (`{MEDIA}`) karena foto 4K\n"
            "dan video menumpuk cepat. Tabel di bawah ini indeksnya - tetap terbaca\n"
            "walau drive-nya sedang tidak terpasang.\n\n"
            "| Waktu | Berkas | Keterangan | Label |\n"
            "| --- | --- | --- | --- |\n",
            encoding="utf-8",
        )
    waktu = dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    try:
        nama = berkas.relative_to(MEDIA).as_posix()
    except ValueError:
        nama = berkas.name
    with LOG.open("a", encoding="utf-8") as f:
        f.write(f"| {waktu} | `{nama}` | {keterangan} | {label or '-'} |\n")


def teks_stempel(label: str) -> str:
    waktu = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    return f"{waktu}  |  {label}" if label else waktu


def slug(label: str) -> str:
    bersih = "".join(c if c.isalnum() else "-" for c in label.lower())
    return "-".join(bagian for bagian in bersih.split("-") if bagian)[:40]


def nama_berkas(label: str, ext: str) -> str:
    jam = dt.datetime.now().strftime("%H%M%S")
    s = slug(label)
    return f"{jam}-{s}.{ext}" if s else f"{jam}.{ext}"


# --- perintah ---------------------------------------------------------------

def cmd_list(args: argparse.Namespace) -> None:
    """Probe index kamera dan tebak mana OBSBOT-nya (satu-satunya yang 4K)."""
    print("Memindai index kamera...\n")
    ketemu = False
    for idx in range(args.max_index + 1):
        cap = cv2.VideoCapture(idx, BACKEND)
        if not cap.isOpened():
            cap.release()
            continue
        ketemu = True
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, 3840)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 2160)
        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        fps = cap.get(cv2.CAP_PROP_FPS)
        ptz = "  gimbal: ya" if cap.set(cv2.CAP_PROP_PAN, 0.0) else ""
        tebakan = "  <- OBSBOT (mampu 4K)" if w >= 3840 else ""
        print(f"  index {idx}: maks {w}x{h} @ {fps:.0f} fps{tebakan}{ptz}")
        cap.release()
    if not ketemu:
        print("  (tidak ada kamera terbuka - mungkin dipakai aplikasi lain)")


HELP_AIM = """
  panah / WASD : pan-tilt        + -  : zoom
  [ ]          : besar langkah   r    : balik ke tengah (0,0,0)
  s            : simpan foto     p    : simpan arah ini jadi preset
  q / Esc      : keluar
"""


def cmd_aim(args: argparse.Namespace) -> None:
    """Preview live sambil menyetir gimbal pakai keyboard."""
    cap, res = buka(args.index, VIDEO)
    pan, tilt, zoom = 0.0, 0.0, 0.0
    if args.preset:
        v = pakai_preset(args.preset)
        pan, tilt, zoom = v.get("pan", 0.0), v.get("tilt", 0.0), v.get("zoom", 0.0)
    langkah = 5.0

    hangatkan(cap)
    arahkan(cap, pan, tilt, zoom, tunggu=1.0)
    print("Jendela preview terbuka." + HELP_AIM)

    # kode tombol panah Windows dari waitKeyEx
    KIRI, ATAS, KANAN, BAWAH = 2424832, 2490368, 2555904, 2621440
    judul = "Arahkan kamera - q untuk keluar"

    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                print("Frame gagal dibaca, berhenti.")
                break

            hud = frame.copy()
            cv2.rectangle(hud, (0, 0), (res[0], 96), (0, 0, 0), -1)
            frame = cv2.addWeighted(hud, 0.45, frame, 0.55, 0)
            cv2.putText(frame, f"pan {pan:+.0f}  tilt {tilt:+.0f}  zoom {zoom:.0f}",
                        (20, 40), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (255, 255, 255), 2, cv2.LINE_AA)
            cv2.putText(frame, f"langkah {langkah:.0f} deg   [panah] gerak  [s] foto  [q] keluar",
                        (20, 76), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (200, 200, 200), 1, cv2.LINE_AA)
            cv2.imshow(judul, frame)

            k = cv2.waitKeyEx(30)
            if k == -1:
                if cv2.getWindowProperty(judul, cv2.WND_PROP_VISIBLE) < 1:
                    break
                continue

            kecil = k & 0xFF
            baru = (pan, tilt, zoom)
            if k == KIRI or kecil in (ord("a"), ord("A")):
                baru = (jepit(pan - langkah, PAN), tilt, zoom)
            elif k == KANAN or kecil in (ord("d"), ord("D")):
                baru = (jepit(pan + langkah, PAN), tilt, zoom)
            elif k == ATAS or kecil in (ord("w"), ord("W")):
                baru = (pan, jepit(tilt + langkah, TILT), zoom)
            elif k == BAWAH or kecil in (ord("x"), ord("X")):
                # X, bukan S: S sudah dipakai buat simpan foto
                baru = (pan, jepit(tilt - langkah, TILT), zoom)
            elif kecil in (ord("+"), ord("=")):
                baru = (pan, tilt, jepit(zoom + 10, ZOOM))
            elif kecil in (ord("-"), ord("_")):
                baru = (pan, tilt, jepit(zoom - 10, ZOOM))
            elif kecil == ord("["):
                langkah = max(1.0, langkah - 1)
            elif kecil == ord("]"):
                langkah = min(30.0, langkah + 1)
            elif kecil in (ord("r"), ord("R")):
                baru = (0.0, 0.0, 0.0)
            elif kecil in (ord("s"), ord("S")):
                tujuan = folder_hari_ini() / nama_berkas(args.label, "jpg")
                # ambil frame segar: `frame` sudah kena HUD, jangan ikut tersimpan
                ok2, bersih = cap.read()
                if not ok2:
                    print("  gagal ambil frame, foto dilewat")
                    continue
                if not args.no_stamp:
                    stempel(bersih, teks_stempel(args.label))
                cv2.imwrite(str(tujuan), bersih, [cv2.IMWRITE_JPEG_QUALITY, 92])
                catat(tujuan, args.label, f"foto {res[0]}x{res[1]} (aim)")
                print(f"  foto -> {tujuan}")
            elif kecil in (ord("p"), ord("P")):
                nama = input("\n  nama preset: ").strip()
                if nama:
                    data = baca_preset()
                    data[nama] = {"pan": round(pan, 1), "tilt": round(tilt, 1), "zoom": round(zoom, 1)}
                    tulis_preset(data)
                    print(f"  preset '{nama}' disimpan: pan {pan:+.0f} tilt {tilt:+.0f} zoom {zoom:.0f}")
            elif kecil in (ord("q"), 27):
                break

            if baru != (pan, tilt, zoom):
                pan, tilt, zoom = baru
                # jangan tidur di sini: preview harus tetap hidup selama gimbal jalan
                arahkan(cap, pan, tilt, zoom, tunggu=0)
    finally:
        cap.release()
        cv2.destroyAllWindows()

    print(f"\nArah terakhir: pan {pan:+.0f}  tilt {tilt:+.0f}  zoom {zoom:.0f}")
    print(f"Pakai lagi: python tools/capture_docs.py snap --pan {pan:.0f} --tilt {tilt:.0f} --zoom {zoom:.0f}")


def cmd_preset(args: argparse.Namespace) -> None:
    data = baca_preset()
    if args.aksi == "list":
        if not data:
            print("Belum ada preset. Bikin lewat `aim` (tombol p) atau `preset simpan`.")
            return
        for nama, v in sorted(data.items()):
            print(f"  {nama:20s} pan {v.get('pan', 0):+6.0f}  tilt {v.get('tilt', 0):+6.0f}  "
                  f"zoom {v.get('zoom', 0):5.0f}")
    elif args.aksi == "simpan":
        data[args.nama] = {"pan": args.pan or 0.0, "tilt": args.tilt or 0.0, "zoom": args.zoom or 0.0}
        tulis_preset(data)
        print(f"Preset '{args.nama}' disimpan.")
    elif args.aksi == "hapus":
        if data.pop(args.nama, None) is None:
            sys.exit(f"Preset '{args.nama}' tidak ada.")
        tulis_preset(data)
        print(f"Preset '{args.nama}' dihapus.")


def cmd_snap(args: argparse.Namespace) -> None:
    cap, res = buka(args.index, FOTO)
    try:
        terapkan_arah(cap, args)
        hangatkan(cap)
        ok, frame = cap.read()
        if not ok or frame is None:
            sys.exit("Gagal mengambil frame dari kamera.")
    finally:
        cap.release()

    if not args.no_stamp:
        stempel(frame, teks_stempel(args.label))

    tujuan = folder_hari_ini() / nama_berkas(args.label, "jpg")
    cv2.imwrite(str(tujuan), frame, [cv2.IMWRITE_JPEG_QUALITY, 92])
    catat(tujuan, args.label, f"foto {res[0]}x{res[1]}")
    print(f"Foto {res[0]}x{res[1]} -> {tujuan}")


def cmd_clip(args: argparse.Namespace) -> None:
    cap, res = buka(args.index, VIDEO)
    tujuan = folder_hari_ini() / nama_berkas(args.label, "mp4")
    writer = cv2.VideoWriter(str(tujuan), cv2.VideoWriter_fourcc(*"mp4v"), args.fps, res)

    mulai = time.monotonic()
    n = 0
    try:
        terapkan_arah(cap, args)
        hangatkan(cap)
        print(f"Merekam {args.duration} s pada {res[0]}x{res[1]}... (Ctrl+C untuk berhenti)")
        mulai = time.monotonic()
        while time.monotonic() - mulai < args.duration:
            ok, frame = cap.read()
            if not ok:
                break
            if not args.no_stamp:
                stempel(frame, teks_stempel(args.label))
            writer.write(frame)
            n += 1
    except KeyboardInterrupt:
        print("\n  dihentikan manual")
    finally:
        cap.release()
        writer.release()

    lama = time.monotonic() - mulai
    fps_nyata = n / lama if lama else 0
    catat(tujuan, args.label, f"klip {lama:.0f} s, {res[1]}p, {fps_nyata:.0f} fps")
    print(f"Klip {lama:.0f} s ({n} frame, {fps_nyata:.1f} fps nyata) -> {tujuan}")
    if fps_nyata < args.fps * 0.8:
        print(f"  catatan: fps nyata di bawah target {args.fps}; pakai --fps {fps_nyata:.0f} "
              "supaya durasi playback-nya tidak melar")


def cmd_lapse(args: argparse.Namespace) -> None:
    cap, res = buka(args.index, FOTO if args.foto else VIDEO)
    total = int(args.minutes * 60 / args.interval)
    tujuan = folder_hari_ini() / nama_berkas(args.label or "timelapse", "mp4")
    frames_dir = None
    if args.keep_frames:
        frames_dir = tujuan.with_suffix("")
        frames_dir.mkdir(parents=True, exist_ok=True)

    writer = cv2.VideoWriter(str(tujuan), cv2.VideoWriter_fourcc(*"mp4v"), args.playback_fps, res)

    print(f"Timelapse: {total} frame, tiap {args.interval} s, total ~{args.minutes:.0f} menit.")
    print(f"Playback {args.playback_fps} fps -> durasi video ~{total / args.playback_fps:.0f} s.")
    print("Ctrl+C untuk berhenti lebih awal (video tetap tersimpan).\n")

    n = 0
    try:
        terapkan_arah(cap, args)
        hangatkan(cap)
        berikutnya = time.monotonic()
        while n < total:
            # grab() terus supaya buffer tidak basi - tanpa ini frame yang
            # terambil bisa gambar dari beberapa detik lalu
            while time.monotonic() < berikutnya:
                cap.grab()
                time.sleep(0.05)

            ok, frame = cap.read()
            if not ok:
                print("  frame gagal, lanjut...")
                berikutnya += args.interval
                continue

            if not args.no_stamp:
                stempel(frame, teks_stempel(args.label))
            writer.write(frame)
            if frames_dir:
                cv2.imwrite(str(frames_dir / f"{n:05d}.jpg"), frame,
                            [cv2.IMWRITE_JPEG_QUALITY, 90])
            n += 1
            berikutnya += args.interval
            print(f"\r  frame {n}/{total}", end="", flush=True)
    except KeyboardInterrupt:
        print("\n  dihentikan manual")
    finally:
        cap.release()
        writer.release()

    print()
    catat(tujuan, args.label, f"timelapse {n} frame @ {args.interval} s, {res[1]}p")
    print(f"Timelapse {n} frame -> {tujuan}")


def tambah_arah(sub) -> None:
    """Flag pengarah gimbal yang dipakai bareng snap/clip/lapse."""
    sub.add_argument("-p", "--preset", help="pakai arah tersimpan (lihat `preset list`)")
    sub.add_argument("--pan", type=float, help=f"derajat {PAN[0]:.0f}..{PAN[1]:.0f}")
    sub.add_argument("--tilt", type=float, help=f"derajat {TILT[0]:.0f}..{TILT[1]:.0f}")
    sub.add_argument("--zoom", type=float, help=f"{ZOOM[0]:.0f}..{ZOOM[1]:.0f}")


def main() -> None:
    p = argparse.ArgumentParser(
        description="Ambil foto/klip/timelapse dokumentasi dari webcam OBSBOT.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__.split("Soal gimbal:")[0].split("\n", 2)[2],
    )
    p.add_argument("--index", type=int, default=0, help="index kamera (default 0 = OBSBOT)")
    sub = p.add_subparsers(dest="perintah", required=True)

    s = sub.add_parser("list", help="pindai kamera yang tersedia")
    s.add_argument("--max-index", type=int, default=5)
    s.set_defaults(func=cmd_list)

    s = sub.add_parser("aim", help="preview live + setir gimbal pakai keyboard")
    s.add_argument("-p", "--preset", help="mulai dari arah tersimpan")
    s.add_argument("-l", "--label", default="", help="label untuk foto yang diambil dari sini")
    s.add_argument("--no-stamp", action="store_true")
    s.set_defaults(func=cmd_aim)

    s = sub.add_parser("preset", help="kelola arah kamera tersimpan")
    s.add_argument("aksi", choices=["list", "simpan", "hapus"])
    s.add_argument("nama", nargs="?", help="nama preset (untuk simpan/hapus)")
    s.add_argument("--pan", type=float)
    s.add_argument("--tilt", type=float)
    s.add_argument("--zoom", type=float)
    s.set_defaults(func=cmd_preset)

    s = sub.add_parser("snap", help="satu foto 4K")
    s.add_argument("-l", "--label", default="", help="keterangan singkat, ikut ke nama file")
    s.add_argument("--no-stamp", action="store_true", help="jangan tulis waktu di gambar")
    tambah_arah(s)
    s.set_defaults(func=cmd_snap)

    s = sub.add_parser("clip", help="rekam video pendek")
    s.add_argument("-d", "--duration", type=float, default=20, help="durasi detik (default 20)")
    s.add_argument("-l", "--label", default="")
    s.add_argument("--fps", type=float, default=30)
    s.add_argument("--no-stamp", action="store_true")
    tambah_arah(s)
    s.set_defaults(func=cmd_clip)

    s = sub.add_parser("lapse", help="timelapse sesi kerja")
    s.add_argument("-i", "--interval", type=float, default=10, help="jarak antar frame, detik")
    s.add_argument("-m", "--minutes", type=float, default=30, help="lama sesi, menit")
    s.add_argument("-l", "--label", default="")
    s.add_argument("--playback-fps", type=float, default=15)
    s.add_argument("--foto", action="store_true", help="ambil 4K, bukan 1080p (file jauh lebih besar)")
    s.add_argument("--keep-frames", action="store_true", help="simpan juga JPEG tiap frame")
    s.add_argument("--no-stamp", action="store_true")
    tambah_arah(s)
    s.set_defaults(func=cmd_lapse)

    args = p.parse_args()
    if args.perintah == "preset" and args.aksi in ("simpan", "hapus") and not args.nama:
        p.error(f"`preset {args.aksi}` butuh nama preset")
    args.func(args)


if __name__ == "__main__":
    main()
