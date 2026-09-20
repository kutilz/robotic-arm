"""Pisahkan galat sapuan sendi jadi komponen yang punya sebab fisik berbeda.

Model: galat(theta) = a + b*theta + sum_n [A_n sin(n theta) + B_n cos(n theta)]
  a    offset tetap       -> titik nol kalibrasi
  b    galat skala        -> rasio reduksi yang dipakai firmware meleset
  n=1  sekali/putaran     -> magnet AS5600 tidak sepusat dengan poros
  n=2  dua kali/putaran   -> magnet miring atau tidak diametris sempurna
Sisa sesudah semuanya dibuang = batas ketelitian yang tersisa.

PENTING: butuh data yang meliputi SATU PUTARAN PENUH. Di bawah itu suku garis
lurus dan suku sinus hampir tak terbedakan, dan pemisahannya jadi omong kosong
yang kelihatan meyakinkan (lihat firmware/kalibrasi.md).

Pakai:
  set SENDI=1 & set RASIO=15
  python tools/kalibrasi_analisa.py <tahap>
"""
import csv
import math
import os
import sys

DATA = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                    "benchmarks", "kalibrasi")
SENDI = int(os.environ.get("SENDI", "1"))
# Rasio yang SEDANG dipasang di firmware waktu data diambil. Dipakai hanya untuk
# menerjemahkan kemiringan jadi "rasio sejati", jadi wajib cocok dengan kolom
# rasio_terpasang di CSV.
RASIO = float(os.environ.get("RASIO", "15"))


def gauss(M, v):
    """Selesaikan M x = v (kecil, jadi eliminasi biasa sudah cukup)."""
    n = len(v)
    A = [row[:] + [v[i]] for i, row in enumerate(M)]
    for i in range(n):
        p = max(range(i, n), key=lambda r: abs(A[r][i]))
        A[i], A[p] = A[p], A[i]
        if abs(A[i][i]) < 1e-12:
            raise ValueError("matriks singular")
        for r in range(n):
            if r == i:
                continue
            f = A[r][i] / A[i][i]
            for c in range(i, n + 1):
                A[r][c] -= f * A[i][c]
    return [A[i][n] / A[i][i] for i in range(n)]


def cocokkan(theta, galat, harmonik=1):
    """Kuadrat terkecil dengan offset + skala + harmonik ke-1..n.

    Harmonik ke-n = n siklus per satu putaran sendi. Ordenya penting karena
    sebabnya beda: 1 siklus = magnet tidak sepusat sumbu, 2 siklus = magnet
    miring atau tidak diametris sempurna, n siklus = sesuatu yang berputar n
    kali lebih cepat dari output (poros antara di reduksi bertingkat).
    """
    basis = [lambda t: 1.0, lambda t: t]
    for h in range(1, harmonik + 1):
        basis.append(lambda t, h=h: math.sin(h * math.radians(t)))
        basis.append(lambda t, h=h: math.cos(h * math.radians(t)))
    k = len(basis)
    M = [[sum(basis[i](t) * basis[j](t) for t in theta) for j in range(k)]
         for i in range(k)]
    v = [sum(basis[i](t) * g for t, g in zip(theta, galat)) for i in range(k)]
    c = gauss(M, v)
    sisa = [g - sum(c[i] * basis[i](t) for i in range(k))
            for t, g in zip(theta, galat)]
    return c, sisa


def rms(x):
    return (sum(v * v for v in x) / len(x)) ** 0.5


def main():
    tahap = sys.argv[1] if len(sys.argv) > 1 else "penuh-openloop"
    theta, enc = [], []
    with open(os.path.join(DATA, f"j{SENDI}-sapuan.csv"), encoding="utf-8") as f:
        for r in csv.DictReader(f):
            if r["tahap"] == tahap:
                theta.append(float(r["perintah_deg"]))
                enc.append(float(r["encoder_deg"]))
    if not theta:
        print(f"tidak ada baris tahap={tahap}")
        return
    galat = [e - t for e, t in zip(enc, theta)]
    print(f"tahap {tahap}: {len(theta)} titik, "
          f"{min(theta):+.0f}..{max(theta):+.0f} deg")
    print(f"galat mentah: rerata {sum(galat)/len(galat):+.3f}, "
          f"rms {rms(galat):.3f}, terbesar {max(map(abs, galat)):.3f} deg\n")

    liputan = max(theta) - min(theta)
    if liputan < 300:
        print(f"PERINGATAN: liputan cuma {liputan:.0f} deg. Di bawah satu"
              " putaran, suku garis lurus dan suku sinus hampir tak"
              " terbedakan, jadi pemisahannya tidak bisa dipegang.\n")

    c0, s0 = cocokkan(theta, galat, harmonik=0)
    print("model 0, offset + skala saja:")
    print(f"  offset {c0[0]:+.3f} deg, skala {1 + c0[1]:.5f} "
          f"-> rasio sejati {RASIO / (1 + c0[1]):.4f}")
    print(f"  sisa: rms {rms(s0):.3f}, terbesar {max(map(abs, s0)):.3f} deg")

    hasil = [(0, c0, s0)]
    for h in (1, 2, 3):
        c, s = cocokkan(theta, galat, harmonik=h)
        hasil.append((h, c, s))
        print(f"\nmodel {h}, sampai harmonik ke-{h}:")
        print(f"  offset {c[0]:+.3f} deg, skala {1 + c[1]:.5f} "
              f"-> rasio sejati {RASIO / (1 + c[1]):.4f}")
        for i in range(1, h + 1):
            amp = math.hypot(c[2 * i], c[2 * i + 1])
            fase = math.degrees(math.atan2(c[2 * i + 1], c[2 * i]))
            print(f"  harmonik {i} ({i} siklus/putaran): amplitudo "
                  f"{amp:.3f} deg, fase {fase:+.1f} deg")
        print(f"  sisa: rms {rms(s):.3f}, terbesar {max(map(abs, s)):.3f} deg")

    print(f"\n1 LSB AS5600 = {360/4096:.4f} deg; pengulangan terukur ~0.1 deg.")
    print("Sisa yang sudah turun ke sekitar itu berarti modelnya sudah"
          " menangkap semua yang berpola.")

    terbaik = hasil[-1]
    print(f"\n  theta   galat   model    sisa")
    for t, g, s in zip(theta, galat, terbaik[2]):
        print(f"  {t:6.1f}  {g:+6.3f}  {g - s:+6.3f}  {s:+6.3f}")


main()
