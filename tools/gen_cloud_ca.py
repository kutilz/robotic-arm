"""Bangkitkan firmware/arm_controller_esp32/cloud_ca.h dari bundel Mozilla (certifi).

Jalankan ulang kalau Cloudflare menambah CA baru untuk sertifikat edge-nya:
    python tools/gen_cloud_ca.py

Cek CA yang sedang dipakai relay:
    openssl s_client -connect <relay>.workers.dev:443 -showcerts </dev/null
"""

from __future__ import annotations

import datetime
import pathlib
import re

import certifi

# Semua root yang dipakai Cloudflare Universal SSL. GTS Root R4 dulu karena
# *.workers.dev sekarang memakai WE1 -> GTS Root R4.
WANT = [
    "GTS Root R4",
    "GTS Root R1",
    "GTS Root R3",
    "ISRG Root X1",
    "ISRG Root X2",
    "SSL.com Root Certification Authority ECC",
    "SSL.com Root Certification Authority RSA",
    "SSL.com TLS ECC Root CA 2022",
    "SSL.com TLS RSA Root CA 2022",
]

OUT = pathlib.Path(__file__).resolve().parent.parent / "firmware" / "arm_controller_esp32" / "cloud_ca.h"


def main() -> None:
    txt = pathlib.Path(certifi.where()).read_text(encoding="utf8")
    blocks = re.findall(
        r'# Label: "(.*?)"\n.*?(-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----)',
        txt,
        re.S,
    )
    got = dict(blocks)
    missing = [w for w in WANT if w not in got]
    if missing:
        raise SystemExit(f"tidak ada di certifi: {missing}")

    today = datetime.date.today().isoformat()
    lines = [
        "/*",
        " * cloud_ca.h: root CA yang dipercaya klien cloud (wss ke relay Cloudflare).",
        " *",
        f" * DIBANGKITKAN oleh tools/gen_cloud_ca.py ({today}) dari bundel Mozilla",
        " * (python certifi). Jangan diedit tangan, jalankan ulang skripnya.",
        " *",
        " * Isinya sengaja SEMUA root yang dipakai Cloudflare untuk sertifikat edge",
        " * (Universal SSL bergiliran antara Google Trust Services, Let's Encrypt, dan",
        " * SSL.com). Mematok satu root saja membuat ESP32 tiba tiba gagal tersambung",
        " * begitu Cloudflare memutar CA, tanpa satu pun perubahan di repo ini.",
        " *",
        " * Kenapa tidak setInsecure(): tanpa verifikasi sertifikat, siapa pun di",
        " * jaringan yang sama (hotspot, WiFi kampus) bisa menyamar jadi relay dan",
        " * mengirim goto ke lengan. Enkripsi tanpa autentikasi server tidak menjaga",
        " * apa pun di sini.",
        " */",
        "#pragma once",
        "",
        "static const char CLOUD_CA[] =",
    ]
    for w in WANT:
        lines.append(f"  // {w}")
        for row in got[w].splitlines():
            lines.append(f'  "{row}\\n"')
    lines[-1] += ";"
    OUT.write_text("\n".join(lines) + "\n", encoding="utf8", newline="\n")
    print(f"{OUT} ({len(WANT)} root)")


if __name__ == "__main__":
    main()
