"""Kalibrasi tiga servo (J5 MG996R, J6 MG996R, gripper MG90S) lewat WebSocket,
memakai umpan balik wiper potensiometer internal yang dibaca ADS1115.

Yang dicari, sesuai urutan pemakaian:
  cek       kondisi ADS1115 + tegangan wiper saat diam, TANPA menggerakkan apa pun
  derau     simpangan baku pembacaan saat servo diam (batas bawah ketelitian)
  sapu      titik AWAL, TENGAH, dan AKHIR travel tiap servo (hasil utama)
  linear    kurva lebar pulsa -> tegangan wiper, naik dan turun (linearitas +
            histeresis)
  ulang     repeatability: berkali kali kembali ke titik tengah dari dua arah
  cepat     kalibrasi KECEPATAN: step response direkam 860 SPS di firmware
  busur     masukkan pembacaan busur derajat fisik supaya skala derajat berhenti
            jadi asumsi dan jadi hasil ukur
  terap     tulis hasil sapu ke kalibrasi firmware (RAM), `simpan` untuk NVS

Kenapa sapuannya bertahap dan bukan langsung 500 -> 2500 us:
  Servo tidak melaporkan kegagalan. Kalau diperintah melewati ujung travelnya,
  dia menekan stop internal terus menerus, panas, dan lama lama gundul giginya.
  Perkakas ini melangkah kecil sambil memeriksa apakah wiper masih mengikuti.
  Begitu wiper berhenti mengikuti tiga langkah berturut turut, titik itu
  dianggap ujung travel, servo langsung ditarik mundur, dan batas yang dicatat
  diberi margin supaya pose kerja tidak pernah duduk di titik stall.

PAGAR TEGANGAN (penting, ADS1115 di-supply 3,3 V):
  Batas absolut input ADS1115 = VDD + 0,3 V = 3,6 V, sedangkan wiper servo
  mengambang di rail servo 5 V. Sapuan DIHENTIKAN seketika kalau ada kanal yang
  melewati SATURASI_MV. Kalau itu terjadi, wiper wajib diberi voltage divider
  dulu; hasil di atas ambang itu bukan hasil ukur melainkan dioda clamp input.

Pakai:
  python tools/kalibrasi_servo.py cek
  python tools/kalibrasi_servo.py sapu 0
  set ARM_WS=ws://192.168.1.8:81      (PowerShell: $env:ARM_WS="ws://...")

Data hasilnya: benchmarks/kalibrasi/servo/
"""
import asyncio
import csv
import json
import os
import statistics
import sys
from datetime import datetime

import websockets

URL = os.environ.get("ARM_WS", "ws://armbot.local:81")
DATA = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                    "benchmarks", "kalibrasi", "servo")
SESI = datetime.now().strftime("%Y-%m-%dT%H:%M")

NAMA = ["J5", "J6", "GRIP"]
# Indeks sendi 0-based yang dilayani tiap servo, None = bukan sendi (gripper).
# Cocok dengan SERVO_JOINT[] di firmware.
JOINT_SERVO = [4, 5, None]

# --- parameter sapuan ---
US_TENGAH_AWAL = 1500   # netral standar servo hobi, titik mulai semua sapuan
US_BATAS_BAWAH = 500    # tidak pernah memerintah di luar rentang ini
US_BATAS_ATAS = 2500
LANGKAH_US = 20         # besar satu langkah sapuan
DIAM_MS = 300           # jeda sebelum membaca, supaya servo sempat sampai
MARGIN_US = 40          # jarak aman dari ujung travel yang ditemukan
N_SAMPEL = 12           # oversample tiap pembacaan
STUCK_BUTUH = 3         # berapa langkah diam berturut turut = ujung travel
STUCK_RASIO = 0.25      # "diam" = pergerakan < 25% pergerakan normal
GERAK_MIN_MV = 0.5      # di bawah ini servo dianggap tidak bergerak sama sekali

# --- penolakan pembacaan kotor ---
# Terukur 10 Agu 2026: selama motor servo masih menarik arus untuk mengoreksi
# posisi, arus itu lewat kabel GND bersama dan menggeser referensi ADS1115.
# Gejalanya khas: simpangan baku satu pembacaan melompat dari ~0,1 mV ke ratusan
# mV, dan nilainya selalu meleset ke arah RENDAH (IR drop di jalur GND). Karena
# itu tiap pembacaan diperiksa ketenangannya dulu, bukan langsung dipakai.
SD_BERSIH = 5.0         # mV, batas simpangan baku sebuah pembacaan dianggap sah
ULANG_MAKS = 5          # percobaan ulang sebelum menyerah pada satu titik

# Ambang henti darurat. ADS1115 di-supply 3,294 V, jadi di atas ~3,29 V ADC
# mulai terpotong dan di atas 3,6 V dioda clamp input yang menahan tegangan.
# 3250 mV: masih di bawah VDD (jadi angkanya belum terpotong) dan 350 mV di
# bawah batas absolut. Hanya diterapkan pada pembacaan yang sudah TENANG,
# karena lonjakan ground bounce sesaat bukan bukti tegangan wiper naik.
SATURASI_MV = 3250

# Skala awal servo hobi standar: 500..2500 us memetakan 0..180 derajat.
# Dipakai sebagai cadangan SEBELUM skala terukur masuk ke kalibrasi firmware.
# Setelah `busur` dijalankan, skala diambil dari kalibrasi lewat deg_per_us().
#
# TERVERIFIKASI 10 Agustus 2026 untuk ketiga servo di lengan ini: pada 500 us
# dan 2500 us horn berada tepat pada satu garis lurus, jadi jaraknya 180 derajat
# dan skalanya benar benar 0,0900 deg/us. Kolinearitas dipilih sebagai metode
# karena mata jauh lebih teliti menilai "lurus atau tidak" daripada membaca
# angka pada busur derajat.
DEG_PER_US_ASUMSI = 180.0 / 2000.0


def deg_per_us(c, s):
    """Skala derajat yang BERLAKU untuk servo s, diambil dari kalibrasi.

    Sumbernya kalibrasi, bukan konstanta di skrip ini, supaya hasil `busur`
    otomatis dipakai seluruh perhitungan tanpa ada angka yang perlu diubah
    tangan di dua tempat.
    """
    span_us = c["servo_us_max"][s] - c["servo_us_min"][s]
    span_deg = c["servo_ang_max"][s] - c["servo_ang_min"][s]
    if span_us <= 0 or span_deg <= 0:
        return DEG_PER_US_ASUMSI
    return span_deg / span_us


def catat(nama, header, baris):
    os.makedirs(DATA, exist_ok=True)
    jalur = os.path.join(DATA, nama)
    baru = not os.path.exists(jalur)
    with open(jalur, "a", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        if baru:
            w.writerow(header)
        w.writerows(baris)
    print(f"[data] {len(baris)} baris -> benchmarks/kalibrasi/servo/{nama}")


async def kirim(ws, obj):
    await ws.send(json.dumps(obj))


async def tunggu(ws, jenis, batas=8.0):
    """Pesan pertama bertipe `jenis`; banjir feedback 50 Hz diabaikan."""
    try:
        async with asyncio.timeout(batas):
            while True:
                m = json.loads(await ws.recv())
                if m.get("type") == jenis:
                    return m
    except (TimeoutError, asyncio.TimeoutError):
        return None


async def ack(ws, batas=8.0):
    a = await tunggu(ws, "ack", batas)
    return None if not a else (a.get("ok"), a.get("msg"))


async def ambil_cal(ws):
    await kirim(ws, {"cmd": "cal_get"})
    return await tunggu(ws, "cal")


async def baca(ws, n=N_SAMPEL):
    """Satu pembacaan ketiga kanal: [{nama, ok, mv, sd, us, sat}, ...]."""
    await kirim(ws, {"cmd": "servo_read", "n": n})
    m = await tunggu(ws, "servo")
    if m is None:
        raise RuntimeError("servo_read tidak dijawab (ADS1115 / koneksi?)")
    return m["ch"]


def periksa_saturasi(kanal):
    """Hentikan segalanya kalau ada wiper TENANG yang melewati batas aman.

    Bendera `sat` dari firmware sengaja TIDAK dipakai untuk menghentikan, cuma
    diperingatkan: bendera itu lengket dan ikut naik oleh lonjakan ground bounce
    sesaat, yang bukan bukti tegangan wiper benar benar naik. Yang menghentikan
    hanya pembacaan yang sudah tenang (sd rendah) dan tetap tinggi.
    """
    kena = [c["nama"] for c in kanal
            if c["mv"] >= SATURASI_MV and c["sd"] <= SD_BERSIH]
    if kena:
        raise RuntimeError(
            f"SATURASI di {', '.join(kena)}: wiper >= {SATURASI_MV} mV pada "
            f"pembacaan yang tenang, sudah mendekati VDD ADS1115 (3294 mV) dan "
            f"batas absolut inputnya (3600 mV). Sapuan dihentikan. Wiper perlu "
            f"voltage divider (atau ADS1115 dipindah ke rail 5 V) sebelum "
            f"diteruskan."
        )


def belum_dikalibrasi(c, s):
    """Penanda "belum disapu" adalah kalibrasi UMPAN BALIK yang masih
    placeholder 1000/2000 mV, bukan lebar rentang us. Ketiga servo di lengan ini
    ternyata memang menjalani 500..2500 us penuh tanpa mentok, jadi rentang us
    yang lebar justru hasil ukur yang sah, bukan tanda belum dikalibrasi."""
    return (c["servo_fb_mv_min"][s] == 1000 and c["servo_fb_mv_max"][s] == 2000)


async def baca_stabil(ws, s, n=N_SAMPEL):
    """Baca sampai kanal s tenang. Return (kanal, jumlah_percobaan).

    Pembacaan kotor tidak dirata ratakan bersama yang bersih: rata rata data
    yang tercemar ground bounce tetap meleset ke bawah, cuma jadi lebih halus
    dan lebih meyakinkan. Lebih baik menunggu servo benar benar diam.
    """
    terakhir = None
    for percobaan in range(1, ULANG_MAKS + 1):
        kanal = await baca(ws, n=n)
        terakhir = kanal
        if kanal[s]["sd"] <= SD_BERSIH:
            periksa_saturasi(kanal)
            return kanal, percobaan
        await asyncio.sleep(0.25)      # beri waktu servo berhenti mengoreksi
    periksa_saturasi(terakhir)
    return terakhir, ULANG_MAKS


async def set_us(ws, s, us, diam_ms=DIAM_MS):
    await kirim(ws, {"cmd": "servo_us", "servo": s, "us": int(us)})
    await ack(ws)
    await asyncio.sleep(diam_ms / 1000.0)


async def ke_netral(ws, s, us=US_TENGAH_AWAL):
    await set_us(ws, s, us, diam_ms=600)


# ---------------------------------------------------------------- perintah

async def p_cek(ws, _arg):
    """Read-only: tidak ada satu pun servo yang digerakkan."""
    c = await ambil_cal(ws)
    if not c:
        print("cal_get TIDAK DIJAWAB")
        return
    kanal = await baca(ws, n=32)
    print(f"{'servo':6} {'mV':>9} {'sd mV':>7} {'us skrg':>8}  status")
    baris = []
    for i, ch in enumerate(kanal):
        # Bendera `sat` firmware itu LENGKET dan ikut naik oleh lonjakan sesaat
        # saat motor menarik arus, jadi dia bukan bukti wiper benar benar
        # melewati batas. Yang menentukan pembacaan tenang sekarang; bendera
        # lengket cuma dilaporkan sebagai catatan.
        tanda = ""
        if ch["ok"] == 0:
            tanda = "  TIDAK TERBACA"
        elif ch["mv"] >= SATURASI_MV and ch["sd"] <= SD_BERSIH:
            tanda = "  *** LEWAT BATAS saat tenang, butuh voltage divider ***"
        elif ch["mv"] > 3000:
            tanda = "  (dekat VDD 3294 mV, awasi saat sapuan)"
        elif ch.get("sat"):
            tanda = "  (pernah ada lonjakan >=3150 mV, transien saja)"
        print(f"{ch['nama']:6} {ch['mv']:9.2f} {ch['sd']:7.3f} {ch['us']:8}{tanda}")
        baris.append([SESI, ch["nama"], ch["mv"], ch["sd"], ch["us"], ch.get("sat")])
    print()
    print("kalibrasi tersimpan sekarang:")
    for i in range(len(NAMA)):
        print(f"  {NAMA[i]:5} us {c['servo_us_min'][i]}..{c['servo_us_max'][i]} "
              f"tengah {c['servo_us_center'][i]}  "
              f"fb {c['servo_fb_mv_min'][i]}..{c['servo_fb_mv_max'][i]} mV")
    catat("cek_awal.csv", ["sesi", "servo", "mv", "sd_mv", "us", "sat"], baris)


async def p_derau(ws, arg):
    """Simpangan baku pembacaan saat servo DIAM. Ini batas bawah ketelitian:
    tidak ada hasil kalibrasi yang boleh diklaim lebih halus dari angka ini."""
    s = int(arg) if arg is not None else None
    daftar = [s] if s is not None else list(range(len(NAMA)))
    baris = []
    for i in daftar:
        await ke_netral(ws, i)
        contoh = []
        for _ in range(30):
            kanal = await baca(ws, n=16)
            periksa_saturasi(kanal)
            # Sengaja TIDAK memakai baca_stabil: yang diukur di sini justru
            # sebaran apa adanya saat servo bertahan di satu titik, termasuk
            # gangguan dari motor yang masih sesekali mengoreksi.
            contoh.append(kanal[i]["mv"])
        sd = statistics.pstdev(contoh)
        rerata = statistics.fmean(contoh)
        pp = max(contoh) - min(contoh)
        print(f"{NAMA[i]:5} diam di {US_TENGAH_AWAL} us: rerata {rerata:.2f} mV  "
              f"sd {sd:.3f} mV  puncak-ke-puncak {pp:.2f} mV")
        baris.append([SESI, NAMA[i], US_TENGAH_AWAL, rerata, sd, pp, len(contoh)])
    catat("derau_diam.csv",
          ["sesi", "servo", "us", "rerata_mv", "sd_mv", "pp_mv", "n"], baris)


async def _sapu_arah(ws, s, arah, log):
    """Sapu dari netral ke satu arah sampai wiper berhenti mengikuti.

    Return (us_ujung_masih_gerak, mv_di_situ, alasan).
    """
    await ke_netral(ws, s)
    kanal, _ = await baca_stabil(ws, s)
    mv_akhir = kanal[s]["mv"]
    us = US_TENGAH_AWAL

    langkah_mv = []      # besar pergerakan tiap langkah, untuk acuan "normal"
    stuck = 0
    us_terakhir_gerak = us
    mv_terakhir_gerak = mv_akhir
    batas = US_BATAS_BAWAH if arah < 0 else US_BATAS_ATAS

    while True:
        us_baru = us + arah * LANGKAH_US
        if (arah < 0 and us_baru < batas) or (arah > 0 and us_baru > batas):
            return us_terakhir_gerak, mv_terakhir_gerak, "batas perintah 500/2500 us"
        us = us_baru
        await set_us(ws, s, us)
        kanal, coba = await baca_stabil(ws, s)
        mv = kanal[s]["mv"]
        d = abs(mv - mv_akhir)
        log.append([SESI, NAMA[s], "turun" if arah < 0 else "naik", us, mv,
                    kanal[s]["sd"], d, coba])
        mv_akhir = mv

        if len(langkah_mv) < 5:
            langkah_mv.append(d)
            if len(langkah_mv) == 5:
                acuan = statistics.median(langkah_mv)
                if acuan < GERAK_MIN_MV:
                    raise RuntimeError(
                        f"{NAMA[s]} tidak bergerak sama sekali "
                        f"(median {acuan:.2f} mV/langkah). Periksa: catu servo "
                        f"hidup? kabel sinyal di GPIO yang benar? wiper "
                        f"tersolder ke kanal ADS1115 yang benar?")
            us_terakhir_gerak, mv_terakhir_gerak = us, mv
            continue

        acuan = statistics.median(langkah_mv)
        if d < STUCK_RASIO * acuan:
            stuck += 1
            if stuck >= STUCK_BUTUH:
                return us_terakhir_gerak, mv_terakhir_gerak, "ujung travel"
        else:
            stuck = 0
            us_terakhir_gerak, mv_terakhir_gerak = us, mv
            langkah_mv.append(d)
            if len(langkah_mv) > 12:
                langkah_mv.pop(0)


async def p_sapu(ws, arg):
    """Hasil utama: titik awal, tengah, akhir travel satu servo."""
    if arg is None:
        print("pakai: sapu <0|1|2>   (0=J5, 1=J6, 2=gripper)")
        return
    s = int(arg)
    log = []
    print(f"[{NAMA[s]}] sapu turun dari {US_TENGAH_AWAL} us...")
    us_lo, mv_lo, alasan_lo = await _sapu_arah(ws, s, -1, log)
    print(f"  ujung bawah {us_lo} us @ {mv_lo:.1f} mV  ({alasan_lo})")

    print(f"[{NAMA[s]}] kembali ke netral, lalu sapu naik...")
    us_hi, mv_hi, alasan_hi = await _sapu_arah(ws, s, +1, log)
    print(f"  ujung atas  {us_hi} us @ {mv_hi:.1f} mV  ({alasan_hi})")

    catat("sapu_mentah.csv",
          ["sesi", "servo", "arah", "us", "mv", "sd_mv", "delta_mv", "n_coba"],
          log)

    # Margin hanya untuk ujung yang benar benar MENTOK. Kalau sapuan berhenti
    # karena sudah menyentuh batas perintah 500/2500 us, tidak ada stop mekanis
    # yang sedang ditekan, jadi menarik masuk 40 us cuma membuang travel yang
    # sebenarnya sehat.
    m_lo = MARGIN_US if alasan_lo == "ujung travel" else 0
    m_hi = MARGIN_US if alasan_hi == "ujung travel" else 0
    us_min = min(us_lo, us_hi) + m_lo
    us_max = max(us_lo, us_hi) - m_hi
    us_mid = round((us_min + us_max) / 2)

    # Ketiga titik diukur ULANG di posisi finalnya. mv dari sapuan tadi diambil
    # di us sebelum margin, jadi memasangkannya dengan us setelah margin akan
    # menggeser seluruh pemetaan mV -> sudut sebesar margin itu.
    async def ukur(us):
        await set_us(ws, s, us, diam_ms=700)
        kanal, _ = await baca_stabil(ws, s, n=32)
        return kanal[s]["mv"]

    mv_min = await ukur(us_min)
    mv_max = await ukur(us_max)
    mv_mid = await ukur(us_mid)
    mv_mid_dugaan = (mv_min + mv_max) / 2
    simpangan = mv_mid - mv_mid_dugaan
    span_mv = mv_max - mv_min
    span_us = us_max - us_min

    print()
    print(f"=== {NAMA[s]} ===")
    print(f"  titik AWAL   : {us_min} us  @ {mv_min:.1f} mV")
    print(f"  titik TENGAH : {us_mid} us  @ {mv_mid:.1f} mV "
          f"(dugaan linier {mv_mid_dugaan:.1f}, simpangan {simpangan:+.1f} mV "
          f"= {100*simpangan/span_mv:+.1f}% travel)")
    print(f"  titik AKHIR  : {us_max} us  @ {mv_max:.1f} mV")
    print(f"  travel       : {span_us} us, {span_mv:.1f} mV, "
          f"{span_us*DEG_PER_US_ASUMSI:.1f} derajat (ASUMSI 0,09 deg/us)")
    print(f"  skala        : {span_mv/span_us:.3f} mV/us")
    print()
    print(f"  terapkan: python tools/kalibrasi_servo.py terap "
          f"{s},{us_min},{us_max},{us_mid},{mv_min:.1f},{mv_max:.1f}")

    catat("sapu_hasil.csv",
          ["sesi", "servo", "us_min", "us_mid", "us_max", "mv_min", "mv_mid",
           "mv_max", "span_us", "span_mv", "mv_per_us", "simpangan_tengah_mv",
           "deg_asumsi", "alasan_bawah", "alasan_atas"],
          [[SESI, NAMA[s], us_min, us_mid, us_max, mv_min, mv_mid, mv_max,
            span_us, span_mv, span_mv / span_us, simpangan,
            span_us * DEG_PER_US_ASUMSI, alasan_lo, alasan_hi]])


async def p_linear(ws, arg):
    """Kurva us -> mV naik lalu turun. Menghasilkan linearitas (R^2, galat
    maksimum terhadap garis lurus) dan histeresis (selisih naik vs turun)."""
    if arg is None:
        print("pakai: linear <0|1|2>   (jalankan `sapu` dulu)")
        return
    s = int(arg)
    c = await ambil_cal(ws)
    us_min, us_max = c["servo_us_min"][s], c["servo_us_max"][s]
    if belum_dikalibrasi(c, s):
        print("PERINGATAN: kalibrasi umpan balik masih placeholder, "
              "jalankan `sapu` + `terap` dulu.")
        return

    titik = 21
    naik, turun = [], []
    urut = [round(us_min + i * (us_max - us_min) / (titik - 1)) for i in range(titik)]

    await set_us(ws, s, urut[0], diam_ms=700)
    for us in urut:
        await set_us(ws, s, us, diam_ms=DIAM_MS)
        kanal, _ = await baca_stabil(ws, s, n=16)
        naik.append((us, kanal[s]["mv"]))
    for us in reversed(urut):
        await set_us(ws, s, us, diam_ms=DIAM_MS)
        kanal, _ = await baca_stabil(ws, s, n=16)
        turun.append((us, kanal[s]["mv"]))
    turun.reverse()

    # Regresi linier pada rata rata dua arah.
    xs = [u for u, _ in naik]
    ys = [(a[1] + b[1]) / 2 for a, b in zip(naik, turun)]
    n = len(xs)
    mx, my = statistics.fmean(xs), statistics.fmean(ys)
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    sxx = sum((x - mx) ** 2 for x in xs)
    kemiringan = sxy / sxx
    potong = my - kemiringan * mx
    sisa = [y - (kemiringan * x + potong) for x, y in zip(xs, ys)]
    sst = sum((y - my) ** 2 for y in ys)
    r2 = 1 - sum(r * r for r in sisa) / sst
    span_mv = max(ys) - min(ys)
    galat_maks = max(abs(r) for r in sisa)
    hist = [abs(a[1] - b[1]) for a, b in zip(naik, turun)]

    print(f"=== {NAMA[s]} linearitas & histeresis ===")
    print(f"  kemiringan   : {kemiringan:.4f} mV/us")
    print(f"  R^2          : {r2:.5f}")
    print(f"  galat linier : maks {galat_maks:.2f} mV = "
          f"{100*galat_maks/span_mv:.2f}% dari travel")
    print(f"  histeresis   : maks {max(hist):.2f} mV = "
          f"{100*max(hist)/span_mv:.2f}% travel, rerata {statistics.fmean(hist):.2f} mV")

    catat("linearitas.csv",
          ["sesi", "servo", "us", "mv_naik", "mv_turun", "mv_rerata",
           "sisa_mv", "histeresis_mv"],
          [[SESI, NAMA[s], xs[i], naik[i][1], turun[i][1], ys[i], sisa[i], hist[i]]
           for i in range(n)])
    catat("linearitas_ringkas.csv",
          ["sesi", "servo", "kemiringan_mv_per_us", "r2", "galat_maks_mv",
           "galat_maks_pct", "histeresis_maks_mv", "histeresis_maks_pct",
           "span_mv"],
          [[SESI, NAMA[s], kemiringan, r2, galat_maks, 100 * galat_maks / span_mv,
            max(hist), 100 * max(hist) / span_mv, span_mv]])


async def p_ulang(ws, arg):
    """Repeatability titik tengah: didatangi bergantian dari bawah dan dari
    atas. Sebaran hasilnya = galat posisi yang benar benar bisa dijanjikan."""
    if arg is None:
        print("pakai: ulang <0|1|2>")
        return
    s = int(arg)
    c = await ambil_cal(ws)
    us_min, us_max = c["servo_us_min"][s], c["servo_us_max"][s]
    us_mid = c["servo_us_center"][s]
    if belum_dikalibrasi(c, s):
        print("PERINGATAN: kalibrasi umpan balik masih placeholder, "
              "jalankan `sapu` + `terap` dulu.")
        return

    N = 10
    baris, dari_bawah, dari_atas = [], [], []
    for k in range(N):
        for asal, nama_asal, tampung in ((us_min, "bawah", dari_bawah),
                                         (us_max, "atas", dari_atas)):
            await set_us(ws, s, asal, diam_ms=500)
            await set_us(ws, s, us_mid, diam_ms=600)
            kanal, _ = await baca_stabil(ws, s, n=16)
            tampung.append(kanal[s]["mv"])
            baris.append([SESI, NAMA[s], k + 1, nama_asal, us_mid, kanal[s]["mv"]])

    semua = dari_bawah + dari_atas
    sd = statistics.pstdev(semua)
    pp = max(semua) - min(semua)
    beda_arah = statistics.fmean(dari_atas) - statistics.fmean(dari_bawah)
    span_mv = abs(c["servo_fb_mv_max"][s] - c["servo_fb_mv_min"][s]) or 1
    span_us = us_max - us_min
    mv_per_us = span_mv / span_us
    dpu = deg_per_us(c, s)

    print(f"=== {NAMA[s]} repeatability titik tengah ({2*N} kedatangan) ===")
    print(f"  rerata       : {statistics.fmean(semua):.2f} mV")
    print(f"  sd           : {sd:.3f} mV  = {sd/mv_per_us:.1f} us  = "
          f"{sd/mv_per_us*dpu:.3f} deg")
    print(f"  puncak-puncak: {pp:.2f} mV = {pp/mv_per_us:.1f} us")
    print(f"  beda arah    : {beda_arah:+.2f} mV (histeresis di titik tengah)")

    catat("repeatability.csv",
          ["sesi", "servo", "ulangan", "asal", "us_target", "mv"], baris)
    catat("repeatability_ringkas.csv",
          ["sesi", "servo", "n", "rerata_mv", "sd_mv", "pp_mv", "sd_us",
           "sd_deg", "beda_arah_mv", "deg_per_us"],
          [[SESI, NAMA[s], len(semua), statistics.fmean(semua), sd, pp,
            sd / mv_per_us, sd / mv_per_us * dpu, beda_arah, dpu]])


async def _capture(ws, s, dari_us, ke_us, dur_ms=900):
    await kirim(ws, {"cmd": "servo_capture", "servo": s, "from_us": dari_us,
                     "to_us": ke_us, "settle_ms": 800, "pre_ms": 80,
                     "dur_ms": dur_ms})
    potongan = {}
    akhir = None
    try:
        async with asyncio.timeout(25.0):
            while akhir is None:
                m = json.loads(await ws.recv())
                if m.get("type") == "cap":
                    potongan[m["i"]] = (m["t"], m["raw"])
                elif m.get("type") == "cap_end":
                    akhir = m
                elif m.get("type") == "ack" and not m.get("ok"):
                    raise RuntimeError(f"servo_capture ditolak: {m.get('msg')}")
    except (TimeoutError, asyncio.TimeoutError):
        raise RuntimeError("servo_capture tidak selesai (timeout)")

    t, raw = [], []
    for i in sorted(potongan):
        t.extend(potongan[i][0])
        raw.extend(potongan[i][1])
    if len(t) != akhir["n"]:
        raise RuntimeError(f"potongan hilang: {len(t)} dari {akhir['n']} sampel")
    mvpl = akhir["mv_per_lsb"]
    return ([x / 10.0 for x in t],                 # ms
            [r * mvpl for r in raw],               # mV
            akhir["t_cmd"] / 10.0, akhir)


def _analisa_langkah(t, mv, t_cmd):
    """Ukuran step response: waktu naik, kecepatan maksimum, settling, overshoot."""
    dasar = [v for tt, v in zip(t, mv) if tt <= t_cmd]
    ekor = mv[int(len(mv) * 0.8):]
    if not dasar or not ekor:
        return None
    v0 = statistics.fmean(dasar)
    v1 = statistics.fmean(ekor)
    span = v1 - v0
    if abs(span) < 1.0:
        return None
    arah = 1 if span > 0 else -1

    def lewat(frac):
        amb = v0 + frac * span
        for tt, v in zip(t, mv):
            if tt < t_cmd:
                continue
            if (arah > 0 and v >= amb) or (arah < 0 and v <= amb):
                return tt
        return None

    t10, t50, t90 = lewat(0.1), lewat(0.5), lewat(0.9)
    # Kecepatan maksimum, versi tahan pencilan.
    #
    # Versi pertama memakai jendela 15 sampel (~17 ms) pada data mentah dan
    # menghasilkan 789 deg/s untuk MG996R, yaitu 2,2x lebih cepat daripada
    # spesifikasinya sendiri (0,17 s/60deg = 353 deg/s). Penyebabnya lonjakan
    # ground bounce: justru SELAMA servo bergerak motornya menarik arus paling
    # besar, jadi pencilan terbanyak muncul tepat di bagian data yang dipakai
    # menghitung kemiringan. Dua lapis penyaring dipasang:
    #   1. median 5 titik, membuang lonjakan tunggal tanpa menggeser tepi;
    #   2. jendela 40 sampel (~46 ms), cukup panjang untuk menolak sisa
    #      gangguan tapi masih jauh lebih pendek dari waktu naik (200-500 ms)
    #      sehingga puncak kecepatan yang asli tidak ikut terpangkas.
    halus = list(mv)
    for i in range(2, len(mv) - 2):
        halus[i] = statistics.median(mv[i - 2:i + 3])

    laju_maks = 0.0
    W = 40
    for i in range(len(t) - W):
        dt = t[i + W] - t[i]
        if dt <= 0:
            continue
        laju_maks = max(laju_maks, abs(halus[i + W] - halus[i]) / dt)   # mV/ms

    # Ukuran utama yang dilaporkan: laju rata rata pada 10-90% span. Inilah
    # yang sebanding dengan cara pabrikan mengutip "detik per 60 derajat", dan
    # dia tidak bergantung pada satu titik data mana pun.
    laju_1090 = (abs(span) * 0.8 / (t90 - t10)) if (t10 and t90 and t90 > t10) else 0.0

    # Settling: saat terakhir keluar dari pita +-2% span, dihitung dari perintah.
    pita = abs(span) * 0.02
    t_settle = None
    for tt, v in zip(t, mv):
        if tt >= t_cmd and abs(v - v1) > pita:
            t_settle = tt
    t_settle = (t_settle - t_cmd) if t_settle else 0.0

    puncak = max(mv) if arah > 0 else min(mv)
    overshoot = (puncak - v1) / span * 100.0

    return {
        "v0": v0, "v1": v1, "span_mv": span,
        "t10": None if t10 is None else t10 - t_cmd,
        "t50": None if t50 is None else t50 - t_cmd,
        "t90": None if t90 is None else t90 - t_cmd,
        "rise_ms": None if (t10 is None or t90 is None) else t90 - t10,
        "laju_maks_mv_per_ms": laju_maks,
        "laju_1090_mv_per_ms": laju_1090,
        "settle_ms": t_settle,
        "overshoot_pct": overshoot,
    }


async def p_cepat(ws, arg):
    """Kalibrasi KECEPATAN. Firmware merekam wiper pada 860 SPS selama servo
    melompat, jadi yang diukur gerakan sebenarnya, bukan waktu perintah."""
    if arg is None:
        print("pakai: cepat <0|1|2>")
        return
    s = int(arg)
    c = await ambil_cal(ws)
    us_min, us_max = c["servo_us_min"][s], c["servo_us_max"][s]
    us_mid = c["servo_us_center"][s]
    if belum_dikalibrasi(c, s):
        print("PERINGATAN: kalibrasi umpan balik masih placeholder, "
              "jalankan `sapu` + `terap` dulu.")
        return

    span_us = us_max - us_min
    dpu = deg_per_us(c, s)
    # Langkah 60 derajat: satu satunya angka yang langsung sebanding dengan cara
    # pabrikan mengutip kecepatan ("0,17 s/60deg"). Lebarnya dihitung dari skala
    # derajat yang sedang berlaku, jadi ikut terkoreksi sendiri setelah `busur`.
    us_60 = round(60.0 / dpu)
    # Langkah kecil dan besar dipisah karena servo hobi tidak mencapai kecepatan
    # puncaknya pada langkah pendek, jadi satu angka saja akan menyesatkan.
    uji = [
        ("penuh_naik", us_min, us_max),
        ("penuh_turun", us_max, us_min),
        ("setengah_naik", us_mid, round(us_mid + span_us / 4)),
        ("setengah_turun", us_mid, round(us_mid - span_us / 4)),
        ("60deg_naik", us_mid, min(us_max, us_mid + us_60)),
        ("60deg_turun", us_mid, max(us_min, us_mid - us_60)),
    ]

    mentah, ringkas = [], []
    for nama_uji, a, b in uji:
        print(f"[{NAMA[s]}] {nama_uji}: {a} -> {b} us ...")
        t, mv, t_cmd, akhir = await _capture(ws, s, a, b)
        h = _analisa_langkah(t, mv, t_cmd)
        if h is None:
            print("  gerakan terlalu kecil untuk dianalisa, dilewati")
            continue
        mv_per_us = abs(h["span_mv"]) / abs(b - a)
        # mV/ms -> us/ms -> deg/s. Dua tahap supaya asumsi derajat berdiri
        # sendiri dan bisa diganti hasil busur derajat tanpa mengukur ulang.
        def ke_deg_per_s(laju_mv_per_ms):
            return laju_mv_per_ms / mv_per_us * 1000.0 * dpu

        deg_1090 = ke_deg_per_s(h["laju_1090_mv_per_ms"])
        deg_maks = ke_deg_per_s(h["laju_maks_mv_per_ms"])
        per60 = 60.0 / deg_1090 if deg_1090 > 0 else float("nan")
        busur_deg = abs(b - a) * dpu

        print(f"  sampel {akhir['n']}, span {h['span_mv']:.0f} mV "
              f"({busur_deg:.0f} deg)")
        print(f"  t10-t90 {h['rise_ms']:.0f} ms, t50 {h['t50']:.0f} ms, "
              f"settling +-2% {h['settle_ms']:.0f} ms, "
              f"overshoot {h['overshoot_pct']:+.1f}%")
        print(f"  laju 10-90% {deg_1090:.0f} deg/s = {per60:.3f} s/60deg   "
              f"(puncak tersaring {deg_maks:.0f} deg/s)")

        for tt, vv in zip(t, mv):
            mentah.append([SESI, NAMA[s], nama_uji, tt, vv, t_cmd])
        ringkas.append([SESI, NAMA[s], nama_uji, a, b, busur_deg, akhir["n"],
                        h["span_mv"], h["t10"], h["t50"], h["t90"],
                        h["rise_ms"], h["settle_ms"], h["overshoot_pct"],
                        h["laju_1090_mv_per_ms"], h["laju_maks_mv_per_ms"],
                        deg_1090, deg_maks, per60])

    catat("kecepatan_mentah.csv",
          ["sesi", "servo", "uji", "t_ms", "mv", "t_cmd_ms"], mentah)
    catat("kecepatan_ringkas.csv",
          ["sesi", "servo", "uji", "dari_us", "ke_us", "busur_deg",
           "n_sampel", "span_mv", "t10_ms", "t50_ms", "t90_ms", "rise_ms",
           "settle_ms", "overshoot_pct", "laju_1090_mv_per_ms",
           "laju_maks_mv_per_ms", "deg_per_s_1090", "deg_per_s_maks",
           "s_per_60deg"], ringkas)


async def p_busur(ws, arg):
    """Ganti asumsi derajat dengan hasil ukur busur derajat fisik.

    pakai: busur <servo>,<deg_di_us_min>,<deg_di_us_max>
    Contoh: busur 0,-84,91   (servo 0 terukur -84 deg di batas bawah, +91 di atas)
    """
    if arg is None or arg.count(",") != 2:
        print("pakai: busur <servo>,<deg_di_us_min>,<deg_di_us_max>")
        return
    bagian = arg.split(",")
    s = int(bagian[0])
    deg_min, deg_max = float(bagian[1]), float(bagian[2])
    c = await ambil_cal(ws)
    us_min, us_max = c["servo_us_min"][s], c["servo_us_max"][s]
    span_us = us_max - us_min
    span_deg = deg_max - deg_min
    deg_per_us = span_deg / span_us

    skala = span_deg / span_us

    print(f"=== {NAMA[s]} skala derajat TERUKUR ===")
    print(f"  {us_min} us = {deg_min:+.1f} deg, {us_max} us = {deg_max:+.1f} deg")
    print(f"  {skala:.4f} deg/us  (asumsi standar {DEG_PER_US_ASUMSI:.4f}, "
          f"selisih {100*(skala/DEG_PER_US_ASUMSI-1):+.1f}%)")

    angmin = list(c["servo_ang_min"])
    angmax = list(c["servo_ang_max"])
    angmin[s], angmax[s] = deg_min, deg_max
    pesan = {"cmd": "cal_set", "servo_ang_min": angmin, "servo_ang_max": angmax}

    # Joint limit ikut dirapatkan ke travel yang benar benar ada. Kalau tidak,
    # studio menawarkan sudut yang tidak bisa dicapai servo: perintahnya diam
    # diam ter-clamp di servoAngleToUs() dan sendi berhenti lebih awal tanpa
    # ada yang melaporkan bahwa batasnya memang tidak nyata. Gripper dilewati
    # karena bukan sendi dan tidak punya baris di joint_min/max.
    j = JOINT_SERVO[s]
    if j is not None:
        jmin, jmax = list(c["joint_min"]), list(c["joint_max"])
        lama = (jmin[j], jmax[j])
        jmin[j], jmax[j] = deg_min, deg_max
        pesan["joint_min"], pesan["joint_max"] = jmin, jmax
        print(f"  joint limit J{j+1}: {lama[0]:+.0f}..{lama[1]:+.0f} -> "
              f"{deg_min:+.0f}..{deg_max:+.0f} deg")

    await kirim(ws, pesan)
    print("cal_set:", await ack(ws))
    catat("skala_busur.csv",
          ["sesi", "servo", "us_min", "us_max", "deg_min", "deg_max",
           "deg_per_us", "deg_per_us_asumsi", "metode"],
          [[SESI, NAMA[s], us_min, us_max, deg_min, deg_max, skala,
            DEG_PER_US_ASUMSI, "kolinearitas horn di us_min dan us_max"]])


async def p_uji(ws, arg):
    """Uji ujung ke ujung: perintah SUDUT masuk, sudut TERUKUR keluar.

    Ini satu satunya uji yang melewati seluruh rantai sekaligus (sudut ->
    pemetaan us -> servo -> pot -> ADS1115 -> pemetaan mV -> sudut). Sapuan dan
    linearitas sebelumnya menguji potongan potongannya saja, jadi rantai bisa
    saja konsisten sendiri sendiri tapi tetap meleset kalau disambung.
    """
    if arg is None:
        print("pakai: uji <0|1|2>")
        return
    s = int(arg)
    c = await ambil_cal(ws)
    if belum_dikalibrasi(c, s):
        print("PERINGATAN: jalankan `sapu` + `terap` dulu.")
        return

    await kirim(ws, {"cmd": "resume"})
    await ack(ws)
    await kirim(ws, {"cmd": "servo_auto", "servo": s})
    await ack(ws)

    amin, amax = c["servo_ang_min"][s], c["servo_ang_max"][s]
    j = JOINT_SERVO[s]
    # 9 titik merata, ujung ujungnya ditarik masuk 2% supaya yang diuji
    # kemampuan mengikuti perintah, bukan perilaku saat perintahnya ter-clamp.
    tepi = 0.02 * (amax - amin)
    target = [amin + tepi + i * (amax - amin - 2 * tepi) / 8 for i in range(9)]

    baris, galat = [], []
    for t in target:
        if j is not None:
            fb = await tunggu(ws, "feedback")
            sudut = list(fb["angles"])
            sudut[j] = t
            await kirim(ws, {"cmd": "goto", "angles": sudut})
        else:
            await kirim(ws, {"cmd": "gripper", "deg": t})
            await ack(ws)
        await asyncio.sleep(0.9)

        kanal, _ = await baca_stabil(ws, s, n=16)
        fb = await tunggu(ws, "feedback")
        ukur = fb["angles"][j] if j is not None else fb["grip"]
        e = ukur - t
        galat.append(e)
        baris.append([SESI, NAMA[s], t, ukur, e, kanal[s]["mv"]])
        print(f"  perintah {t:+7.1f} deg -> terukur {ukur:+7.1f} deg  "
              f"galat {e:+6.2f} deg")

    rms = (sum(e * e for e in galat) / len(galat)) ** 0.5
    print(f"=== {NAMA[s]}: galat rms {rms:.2f} deg, "
          f"maks {max(galat, key=abs):+.2f} deg, "
          f"bias {statistics.fmean(galat):+.2f} deg")
    catat("uji_sudut.csv",
          ["sesi", "servo", "perintah_deg", "terukur_deg", "galat_deg", "mv"],
          baris)
    catat("uji_sudut_ringkas.csv",
          ["sesi", "servo", "n", "rms_deg", "maks_deg", "bias_deg"],
          [[SESI, NAMA[s], len(galat), rms, max(galat, key=abs),
            statistics.fmean(galat)]])


async def p_terap(ws, arg):
    """terap <servo>,<us_min>,<us_max>,<us_center>,<mv_min>,<mv_max>"""
    if arg is None or arg.count(",") != 5:
        print("pakai: terap <servo>,<us_min>,<us_max>,<us_center>,<mv_min>,<mv_max>")
        return
    b = arg.split(",")
    s = int(b[0])
    c = await ambil_cal(ws)
    umin, umax = list(c["servo_us_min"]), list(c["servo_us_max"])
    ucen = list(c["servo_us_center"])
    fmin, fmax = list(c["servo_fb_mv_min"]), list(c["servo_fb_mv_max"])
    umin[s], umax[s], ucen[s] = int(b[1]), int(b[2]), int(b[3])
    fmin[s], fmax[s] = round(float(b[4])), round(float(b[5]))
    await kirim(ws, {"cmd": "cal_set", "servo_us_min": umin,
                     "servo_us_max": umax, "servo_us_center": ucen,
                     "servo_fb_mv_min": fmin, "servo_fb_mv_max": fmax})
    print("cal_set:", await ack(ws))
    c = await ambil_cal(ws)
    print(f"terbaca balik {NAMA[s]}: us {c['servo_us_min'][s]}.."
          f"{c['servo_us_max'][s]} tengah {c['servo_us_center'][s]}  "
          f"fb {c['servo_fb_mv_min'][s]}..{c['servo_fb_mv_max'][s]} mV")


async def p_tengah(ws, _arg):
    await kirim(ws, {"cmd": "servo_center"})
    print("servo_center:", await ack(ws))


async def p_lepas(ws, _arg):
    await kirim(ws, {"cmd": "servo_auto"})
    print("servo_auto:", await ack(ws))


async def p_simpan(ws, _arg):
    await kirim(ws, {"cmd": "cal_save"})
    print("cal_save:", await ack(ws))


PERINTAH = {
    "cek": p_cek, "derau": p_derau, "sapu": p_sapu, "linear": p_linear,
    "ulang": p_ulang, "cepat": p_cepat, "busur": p_busur, "uji": p_uji,
    "terap": p_terap,
    "tengah": p_tengah, "lepas": p_lepas, "simpan": p_simpan,
}


async def main():
    if len(sys.argv) < 2 or sys.argv[1] not in PERINTAH:
        print(__doc__)
        print("perintah:", " ".join(PERINTAH))
        return
    arg = sys.argv[2] if len(sys.argv) > 2 else None
    print(f"[ws] {URL}")
    async with websockets.connect(URL, ping_interval=None, max_size=2 ** 20) as ws:
        try:
            await PERINTAH[sys.argv[1]](ws, arg)
        except RuntimeError as e:
            # Apa pun yang gagal, servo tidak boleh ditinggal dalam mode manual
            # menekan ujung travelnya.
            print(f"\nBERHENTI: {e}")
            await kirim(ws, {"cmd": "servo_center"})
            await ack(ws)
            print("semua servo dikembalikan ke titik tengah.")
            sys.exit(1)


asyncio.run(main())
