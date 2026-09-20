#!/usr/bin/env python3
"""Compile firmware ESP32 di PC (PlatformIO, cepat) lewat SSH, flash-nya tetap
di laptop lewat kabel USB.

Alur:
  1. staging lokal (exclude .pio, .git) -> scp ke PC
  2. ssh ke PC: `pio run`
  3. scp firmware.bin balik ke laptop
  4. laptop flash ke 0x10000 pakai esptool bawaan PlatformIO lokal (gak compile)

APP SAJA, BUKAN MERGED IMAGE (default). Yang ditulis cuma partisi aplikasi di
0x10000. Bootloader dan tabel partisi tidak berubah antar-build, jadi tidak ada
gunanya ditulis ulang tiap kali, DAN yang lebih penting: menulis merged image ke
0x0 IKUT MENGHAPUS NVS.

  Kejadian 2026-08-11, mahal waktunya, makanya dicatat di sini. Merged image
  membentang 0x0 sampai ~0xF6C00 dan esptool mengisi celahnya dengan 0xFF.
  Partisi `nvs` ada di 0x9000-0xDFFF, tepat di dalam rentang itu, jadi tiap
  flash memformat seluruh kalibrasi: enc_offset, enc_sign, ratio, endpoint
  servo, semuanya balik ke default compile-time.

  Akibatnya tidak kelihatan seperti masalah flash sama sekali. `enc_sign` J1
  balik dari -1 ke +1, umpan balik jadi TERBALIK, dan J1 berputar terus
  menjauhi target begitu PSU dinyalakan. Gejalanya mirip driver rusak atau
  mekanik seret, padahal penyebabnya di sini. Kalau nanti ada yang bilang
  "kalibrasi hilang lagi tiap re-flash", jawabannya baris `--full` di bawah.

  --full mengembalikan perilaku merged image (tulis ke 0x0). Dipakai HANYA
  untuk board baru, board yang bootloader-nya rusak, atau saat tabel partisi
  berubah. Sadari bahwa itu menghapus kalibrasi: `cal_save` ulang setelahnya.

Setup sekali (lihat tools/remote_build.config.example.json + firmware/README.md):
  - OpenSSH Server aktif di PC, key ~/.ssh/robotic-arm-pc sudah diotorisasi
  - PlatformIO CLI ada di PC (path standar: %USERPROFILE%\\.platformio\\penv\\Scripts\\pio.exe)
  - salin tools/remote_build.config.example.json -> tools/remote_build.config.json, isi host/user PC

Pemakaian:
  python tools/remote_build.py --upload-port COM7
  python tools/remote_build.py --no-upload                 # compile doang, cek error
  python tools/remote_build.py --upload-port COM7 --full   # + bootloader, HAPUS kalibrasi
  python tools/remote_build.py --project tmc_bench --env bench --upload-port COM7
"""
import argparse
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = Path(__file__).resolve().parent / "remote_build.config.json"

PIO_HOME = Path(os.environ.get("USERPROFILE", str(Path.home()))) / ".platformio"
LOCAL_PIO = PIO_HOME / "penv" / "Scripts" / "pio.exe"
LOCAL_PYTHON = PIO_HOME / "penv" / "Scripts" / "python.exe"
LOCAL_ESPTOOL = PIO_HOME / "packages" / "tool-esptoolpy" / "esptool.py"

PROJECTS = {
    "arm_controller_esp32": REPO_ROOT / "firmware" / "arm_controller_esp32",
    "tmc_bench": REPO_ROOT / "firmware" / "tmc_bench",
    "tmc_scan": REPO_ROOT / "firmware" / "tmc_scan",
}


def load_config():
    if not CONFIG_PATH.exists():
        example = CONFIG_PATH.with_name("remote_build.config.example.json")
        sys.exit(
            f"Config belum ada: {CONFIG_PATH}\n"
            f"Salin dari {example.name}, isi host/user PC dulu."
        )
    cfg = json.loads(CONFIG_PATH.read_text())
    for key in ("host", "user"):
        if not cfg.get(key):
            sys.exit(f"remote_build.config.json: field '{key}' kosong.")
    cfg.setdefault("ssh_key", "~/.ssh/robotic-arm-pc")
    cfg.setdefault("remote_dir", r"C:/Users/%s/remote-builds" % cfg["user"])
    cfg.setdefault("remote_pio", r"$env:USERPROFILE\.platformio\penv\Scripts\pio.exe")
    cfg.setdefault("remote_python", "python")
    return cfg


def ssh_key_args(cfg):
    key = os.path.expanduser(cfg["ssh_key"])
    return ["-i", key]


def run(cmd):
    print("+ " + " ".join(cmd))
    subprocess.run(cmd, check=True)


def remote_run(cfg, ps_command):
    # -EncodedCommand (base64 UTF-16LE) biar aman dari argv-joining ssh +
    # parsing cmd.exe (pipe/quote di ps_command bisa kepotong kalau raw -Command).
    target = f"{cfg['user']}@{cfg['host']}"
    full_command = f"$ProgressPreference = 'SilentlyContinue'; {ps_command}"
    encoded = base64.b64encode(full_command.encode("utf-16-le")).decode("ascii")
    run([
        "ssh", *ssh_key_args(cfg), target,
        "powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded,
    ])


def stage_project(project_dir, project_name):
    staging = Path(tempfile.mkdtemp(prefix="remote_build_"))
    dest = staging / project_name
    shutil.copytree(
        project_dir, dest,
        ignore=shutil.ignore_patterns(".pio", ".git", "__pycache__"),
    )
    return staging, dest


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--project", default="arm_controller_esp32", choices=sorted(PROJECTS))
    ap.add_argument("--env", default="arm", help="environment platformio.ini (default: arm)")
    ap.add_argument("--upload-port", help="COM port ESP32 di laptop, mis. COM7")
    ap.add_argument("--no-upload", action="store_true", help="compile doang, gak flash")
    ap.add_argument("--monitor", action="store_true", help="buka serial monitor abis flash")
    ap.add_argument(
        "--full", action="store_true",
        help="tulis bootloader+partisi+app ke 0x0 (board baru/bootloader rusak). "
             "MENGHAPUS NVS: semua kalibrasi balik ke default, cal_save ulang setelahnya.",
    )
    args = ap.parse_args()

    if not args.no_upload and not args.upload_port:
        ap.error("butuh --upload-port COMx (atau pakai --no-upload buat compile doang)")

    cfg = load_config()
    project_dir = PROJECTS[args.project]
    target = f"{cfg['user']}@{cfg['host']}"
    remote_project = f"{cfg['remote_dir']}/{args.project}"

    print(f"[1/4] Sync {args.project} -> {cfg['host']}...")
    staging, staged_dest = stage_project(project_dir, args.project)
    try:
        # hapus dulu biar scp -r gak nested kalau folder remote udah ada
        remote_run(
            cfg,
            f"Remove-Item -Recurse -Force -Path '{remote_project}' -ErrorAction SilentlyContinue; "
            f"New-Item -ItemType Directory -Force -Path '{cfg['remote_dir']}' | Out-Null",
        )
        run(["scp", *ssh_key_args(cfg), "-r", str(staged_dest), f"{target}:{cfg['remote_dir']}/"])
    finally:
        shutil.rmtree(staging, ignore_errors=True)

    print(f"[2/4] Build di PC (env={args.env})...")
    remote_run(cfg, f"Set-Location '{remote_project}'; & \"{cfg['remote_pio']}\" run -e {args.env}")

    if args.no_upload:
        print("Build selesai (--no-upload), berhenti di sini.")
        return

    remote_build_dir = f"{remote_project}/.pio/build/{args.env}"
    local_build_dir = project_dir / ".pio" / "build" / args.env
    local_build_dir.mkdir(parents=True, exist_ok=True)

    if args.full:
        print("[3/4] Merge binary di PC + tarik balik (--full)...")
        boot_app0 = r"$env:USERPROFILE\.platformio\packages\framework-arduinoespressif32\tools\partitions\boot_app0.bin"
        remote_esptool = r"$env:USERPROFILE\.platformio\packages\tool-esptoolpy\esptool.py"
        merge_cmd = (
            f"& \"{cfg['remote_python']}\" \"{remote_esptool}\" --chip esp32 merge_bin "
            f"-o '{remote_build_dir}/merged-flash.bin' "
            f"--flash_mode keep --flash_freq keep --flash_size keep "
            f"0x1000 '{remote_build_dir}/bootloader.bin' "
            f"0x8000 '{remote_build_dir}/partitions.bin' "
            f"0xe000 \"{boot_app0}\" "
            f"0x10000 '{remote_build_dir}/firmware.bin'"
        )
        remote_run(cfg, merge_cmd)
        image = local_build_dir / "merged-flash.bin"
        remote_image, offset = f"{remote_build_dir}/merged-flash.bin", "0x0"
    else:
        print("[3/4] Tarik firmware.bin (app saja, NVS aman)...")
        image = local_build_dir / "firmware.bin"
        remote_image, offset = f"{remote_build_dir}/firmware.bin", "0x10000"

    run(["scp", *ssh_key_args(cfg), f"{target}:{remote_image}", str(image)])

    print(f"[4/4] Flash ke {args.upload_port} @ {offset}...")
    if args.full:
        print("      !! --full menulis dari 0x0: NVS ikut terhapus, "
              "kalibrasi balik ke default. cal_save ulang setelah boot.")
    run([
        str(LOCAL_PYTHON), str(LOCAL_ESPTOOL),
        "--chip", "esp32", "--port", args.upload_port, "--baud", "921600",
        "write_flash", offset, str(image),
    ])

    if args.monitor:
        run([str(LOCAL_PIO), "device", "monitor", "-p", args.upload_port, "-b", "115200"])


if __name__ == "__main__":
    main()
