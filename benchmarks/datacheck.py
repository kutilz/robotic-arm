"""Pengaman kecil supaya data contoh tidak pernah terpakai sebagai hasil.

Berkas `benchmarks/data/*_sample.csv` ada untuk mendemonstrasikan FORMAT kolom,
bukan untuk dilaporkan. Risikonya nyata: keempat skrip pengujian menerima path
CSV apa pun, angkanya tampak masuk akal, dan grafiknya keluar rapi, sehingga
data contoh gampang tersalin ke Bab IV tanpa sadar. Fungsi di bawah mencetak
peringatan mencolok setiap kali masukannya berupa berkas contoh.
"""

from __future__ import annotations

from pathlib import Path

BANNER = "!" * 72


def warn_if_sample(csv_path: Path) -> bool:
    """Peringatkan bila CSV masukan adalah data contoh. True bila contoh."""
    if "sample" not in csv_path.stem.lower():
        return False
    print(BANNER)
    print("PERINGATAN: masukan adalah DATA CONTOH, bukan hasil pengukuran.")
    print(f"  berkas : {csv_path}")
    print("  Angka dan grafik di bawah hanya untuk memeriksa format kolom.")
    print("  JANGAN menyalinnya ke Bab IV. Ganti dengan CSV hasil pengukuran")
    print("  yang direkam dari tab CAL digital twin atau dicatat manual.")
    print(BANNER)
    print()
    return True
