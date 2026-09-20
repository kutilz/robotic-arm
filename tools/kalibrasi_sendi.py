"""Kalibrasi satu sendi stepper lewat WebSocket, satu subperintah per langkah
supaya tiap hasil bisa dilihat dulu sebelum lanjut.

Prosedur lengkap dan daftar jebakannya: firmware/kalibrasi.md
Data hasilnya: benchmarks/kalibrasi/

Pagar pengaman yang dipakai di sini:
  - kp = 0 selama pengukuran. Loop tertutup akan MENGOREKSI selisih rasio
    sampai encoder sama dengan target, jadi rasio yang salah jadi tak terlihat.
    Lebih penting lagi: kalau enc_sign terbalik, koreksi jadi umpan balik
    positif dan lengan lari sampai limit.
  - joint limit dipersempit di FIRMWARE, bukan cuma di skrip ini.
  - gerak pertama cuma 5 derajat: kalau rasio meleset 2x atau magnet ternyata
    di poros motor (bukan output), itu ketahuan sebelum lengan berayun jauh.

Pakai:
  set SENDI=1                       (PowerShell: $env:SENDI=1)
  python tools/kalibrasi_sendi.py <perintah> [arg] [tahap]
"""
import asyncio
import csv
import json
import os
import sys
from datetime import datetime

import websockets

# Default ke mDNS, bukan IP: alamat DHCP unitnya sudah pernah pindah
# (192.168.1.17 -> 192.168.1.8) dan IP mati di skrip bikin kalibrasi gagal
# connect padahal lengannya sehat. Timpa dengan $env:ARM_WS bila perlu.
URL = os.environ.get("ARM_WS", "ws://armbot.local:81")
DATA = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                    "benchmarks", "kalibrasi")
# Sendi yang dikalibrasi, 1-based seperti penamaan sendi stepper di pinout (1..4).
SENDI = int(os.environ.get("SENDI", "1"))
PRE = f"j{SENDI}"    # awalan nama berkas CSV
SESI = datetime.now().strftime("%Y-%m-%dT%H:%M")
# Label tahap yang ikut masuk kolom CSV. Env var didahulukan karena posisi
# argumen ketiga hanya berlaku untuk perintah yang PUNYA argumen kedua:
# `tutup magnet-terpasang` diam-diam menaruh labelnya di slot arg yang tidak
# dipakai p_tutup, dan barisnya tercatat dengan tahap "-" (kejadian 12 Agu 2026,
# dua sesi tutup jadi tak terbedakan selain lewat kolom sesi).
TAHAP = os.environ.get("TAHAP") or (sys.argv[3] if len(sys.argv) > 3 else "-")


def catat(nama, header, baris):
    """Tambah baris ke CSV di folder data. Header ditulis sekali saja."""
    os.makedirs(DATA, exist_ok=True)
    jalur = os.path.join(DATA, nama)
    baru = not os.path.exists(jalur)
    with open(jalur, "a", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        if baru:
            w.writerow(header)
        w.writerows(baris)
    print(f"[data] {len(baris)} baris -> benchmarks/kalibrasi/{nama}")


IDX = SENDI - 1    # indeks 0-based sendi yang sedang dikalibrasi


def hanya(t):
    """Vektor goto yang menyentuh HANYA sendi yang sedang dikalibrasi.

    Dulu ketiga pemanggil menulis [t, None, None, None, None, None] harfiah,
    jadi SENDI=2 tetap menggerakkan J1 sementara semua pembacaan diambil dari
    J2. Gejalanya jahat: sendi yang diukur diam saja, sendi lain yang bergerak.
    Perkakas ini lahir waktu cuma J1 yang punya encoder, dan cacat itu baru
    ketahuan saat J2 dipakai pertama kali (12 Agu 2026).
    """
    a = [None] * 6
    a[IDX] = t
    return a


# Ambang "sudah berhenti" HARUS di atas 1 LSB AS5600 (0.0879 deg): bacaan yang
# diam pun bergoyang antara dua LSB bertetangga, jadi ambang 0.05 tak pernah
# terpenuhi dan tiap gerak dilaporkan "belum diam" padahal sudah berhenti.
SETTLE_DIAM = 0.15
SETTLE_LAMA = 0.6    # detik diam berturut-turut


async def kirim(ws, obj):
    await ws.send(json.dumps(obj))


async def tunggu(ws, jenis, batas=6.0):
    """Pesan pertama bertipe `jenis`; banjir feedback 50 Hz diabaikan."""
    try:
        async with asyncio.timeout(batas):
            while True:
                m = json.loads(await ws.recv())
                if m.get("type") == jenis:
                    return m
    except (TimeoutError, asyncio.TimeoutError):
        return None


async def sudut(ws, batas=3.0):
    fb = await tunggu(ws, "feedback", batas)
    return None if not fb else fb["angles"][IDX]


async def diam(ws, batas=25.0):
    """Tunggu sampai sudut sendi berhenti berubah. Return (sudut, detik, sampel)."""
    loop = asyncio.get_event_loop()
    t0 = loop.time()
    riwayat = []          # (waktu, sudut)
    while loop.time() - t0 < batas:
        a = await sudut(ws)
        if a is None:
            continue
        t = loop.time()
        riwayat.append((t, a))
        riwayat = [(tt, aa) for tt, aa in riwayat if t - tt <= SETTLE_LAMA]
        if t - t0 > 1.0 and len(riwayat) > 10:
            nilai = [aa for _, aa in riwayat]
            if max(nilai) - min(nilai) < SETTLE_DIAM:
                return a, t - t0, len(riwayat)
    a = await sudut(ws)
    return a, batas, -1        # -1 = TIDAK diam sampai batas waktu


async def ack(ws, batas=6.0):
    a = await tunggu(ws, "ack", batas)
    return None if not a else (a.get("ok"), a.get("msg"))


async def ambil_cal(ws):
    await kirim(ws, {"cmd": "cal_get"})
    return await tunggu(ws, "cal")


# ---------------------------------------------------------------- perintah

async def p_status(ws, _):
    c = await ambil_cal(ws)
    if not c:
        print("cal_get TIDAK DIJAWAB")
        return
    print(f"ratio     J{SENDI} = {c['ratio'][IDX]}")
    print(f"enc_off   J{SENDI} = {c['enc_offset'][IDX]:.2f} deg")
    print(f"enc_sign  J{SENDI} = {c['enc_sign'][IDX]:+d}")
    print(f"limit     J{SENDI} = {c['joint_min'][IDX]} .. {c['joint_max'][IDX]} deg")
    print(f"kp={c['kp']}  deadband={c['deadband']}  "
          f"speed={c['speed']} deg/s  accel={c['accel']} deg/s^2")
    print(f"microstep = {c['tmc_microstep']}  spread={c['tmc_spread']}")
    spd = 200.0 * c["tmc_microstep"] * c["ratio"][IDX] / 360.0
    print(f"-> step per derajat output J{SENDI} = {spd:.3f}")

    await kirim(ws, {"cmd": "diag"})
    d = await tunggu(ws, "diag")
    if not d:
        print("diag TIDAK DIJAWAB")
        return
    e = d["enc"][IDX]
    print(f"\nAS5600 J{SENDI}: ok={e['ok']} md={e['md']} ml={e['ml']} mh={e['mh']} "
          f"agc={e['agc']} mag={e['mag']}")
    print(f"           raw={e['raw']}  deg={e['deg']}  fault={e['fault']}")
    dr = d["drv"][IDX]
    if dr.get("ok"):
        print(f"driver J{SENDI}: ms={dr['ms']} msok={dr['msok']} cs={dr['cs']} "
              f"ma={dr['ma']} macs={dr['macs']} vref={dr['vref']}")
        print(f"           ot={dr['ot']} otpw={dr['otpw']} s2g={dr['s2g']} "
              f"ol={dr.get('ol')}  stallguard={d['sg'][IDX]}")
    else:
        print(f"driver J{SENDI}: TIDAK MENJAWAB UART")
    fb = await tunggu(ws, "feedback")
    print(f"\nestop={fb['estop']}  sudut J{SENDI}={fb['angles'][IDX]:.2f}  "
          f"fault={fb['fault']}")


async def p_bising(ws, arg):
    """Sebar bacaan encoder saat lengan DIAM. Menentukan apakah angka
    kalibrasi nanti berarti atau tenggelam di derau."""
    detik = float(arg) if arg else 5.0
    loop = asyncio.get_event_loop()
    t0 = loop.time()
    nilai = []
    while loop.time() - t0 < detik:
        a = await sudut(ws)
        if a is not None:
            nilai.append(a)
    if not nilai:
        print("tidak ada feedback")
        return
    lo, hi = min(nilai), max(nilai)
    rata = sum(nilai) / len(nilai)
    var = sum((x - rata) ** 2 for x in nilai) / len(nilai)
    print(f"{len(nilai)} sampel dalam {detik:.0f} s")
    print(f"  min={lo:+.3f}  max={hi:+.3f}  rentang={hi - lo:.3f} deg")
    print(f"  rata={rata:+.3f}  simpangan baku={var ** 0.5:.4f} deg")
    print(f"  1 LSB AS5600 = {360 / 4096:.4f} deg")
    unik = sorted(set(round(x, 3) for x in nilai))
    print(f"  nilai unik: {len(unik)}" +
          (f" -> {unik}" if len(unik) <= 8 else ""))
    if len(unik) == 1:
        print("  ^ SATU nilai saja. Bisa jadi encoder benar benar diam,"
              " bisa juga bacaannya macet. Dibuktikan saat lengan bergerak.")


async def p_siap(ws, _):
    """Amankan dulu: e-stop, kp=0, pelan. Belum menyentuh apa pun yang bergerak."""
    await kirim(ws, {"cmd": "estop"})
    print("estop:", await ack(ws))
    # microstep 16: 1 step = 0.0075 deg output, jauh di bawah 1 LSB encoder
    # (0.088 deg), jadi resolusi step tidak ikut jadi sumber galat pengukuran.
    # Gerak juga lebih halus -> lebih kecil peluang step hilang saat diukur.
    await kirim(ws, {"cmd": "cal_set", "kp": 0.0, "speed": 8.0, "accel": 16.0,
                     "tmc_microstep": 16})
    print("kp=0 speed=8 accel=16 microstep=16:", await ack(ws))
    c = await ambil_cal(ws)
    print(f"terbaca balik: kp={c['kp']} speed={c['speed']} accel={c['accel']} "
          f"microstep={c['tmc_microstep']}")


async def p_nol(ws, _):
    """cal_zero: pose sekarang jadi 0, lalu limit dipersempit ke +-40."""
    await kirim(ws, {"cmd": "cal_zero", "joint": SENDI})
    print(f"cal_zero J{SENDI}:", await ack(ws))
    c = await ambil_cal(ws)
    jmin, jmax = list(c["joint_min"]), list(c["joint_max"])
    jmin[IDX], jmax[IDX] = -40.0, 40.0
    await kirim(ws, {"cmd": "cal_set", "joint_min": jmin, "joint_max": jmax})
    print(f"limit J{SENDI} -> -40..+40:", await ack(ws))
    c = await ambil_cal(ws)
    print(f"terbaca balik: offset={c['enc_offset'][IDX]:.2f} "
          f"limit={c['joint_min'][IDX]}..{c['joint_max'][IDX]}")
    a = await sudut(ws)
    print(f"sudut sendi sekarang = {a:.2f} (harus 0.00)")


async def p_lepas(ws, _):
    await kirim(ws, {"cmd": "resume"})
    print("resume:", await ack(ws))
    a, t, n = await diam(ws, 6)
    print(f"sudut J{SENDI} sesudah driver hidup = {a:.2f} (diam {t:.1f}s, {n} sampel)")


async def p_gerak(ws, arg):
    """goto ke sudut perintah tertentu, ukur sudut encoder sebelum & sesudah."""
    tujuan = float(arg)
    a0 = await sudut(ws)
    print(f"sebelum : {a0:+.3f} deg (encoder)")
    print(f"perintah: {tujuan:+.3f} deg")
    await kirim(ws, {"cmd": "goto",
                     "angles": hanya(tujuan)})
    a1, t, n = await diam(ws)
    tag = "" if n > 0 else "   <-- BELUM DIAM saat batas waktu habis!"
    print(f"sesudah : {a1:+.3f} deg (encoder), berhenti {t:.1f}s{tag}")
    print(f"delta perintah = {tujuan - a0:+.3f}   delta encoder = {a1 - a0:+.3f}")
    if abs(tujuan - a0) > 0.01:
        f = (a1 - a0) / (tujuan - a0)
        print(f"faktor gerak = {f:+.4f}  (1.000 = rasio & arah sudah benar)")


async def _pergi(ws, t, batas=25.0):
    """goto satu sendi lalu tunggu berhenti. Return (sudut, sempat_diam).

    batas harus melebihi waktu tempuh: pada 8 deg/s, pindah 260 deg makan 33 s,
    dan batas bawaan 25 s akan melaporkan "belum diam" pada gerak yang
    sebenarnya baik baik saja.
    """
    await kirim(ws, {"cmd": "goto",
                     "angles": hanya(t)})
    a, _, n = await diam(ws, batas)
    return a, n > 0


async def p_sapu(ws, arg):
    """Ukur rasio dengan sapuan SATU ARAH.

    Uji bolak-balik mencampur dua hal yang berbeda: backlash (rugi tetap tiap
    kali arah dibalik) dan galat rasio (rugi sebanding dengan jarak). Sapuan
    satu arah memisahkannya: sesudah backlash termakan di kaki pertama, semua
    kaki berikutnya bersih, jadi kemiringan encoder-vs-perintah murni rasio.
    Backlash lalu diukur sendiri lewat satu pembalikan di ujung.
    """
    # arg: "20" -> -20..+20, "a:b" -> daerah mana pun (uji eksentrisitas),
    # "a:b:langkah" -> sekalian atur kerapatan titik.
    langkah = None
    if arg and ":" in arg:
        bagian = [float(x) for x in arg.split(":")]
        awal, akhir = bagian[0], bagian[1]
        if len(bagian) > 2:
            langkah = bagian[2]
    else:
        d0 = float(arg) if arg else 20.0
        awal, akhir = -d0, d0
    d = akhir
    if langkah is None:
        langkah = (akhir - awal) / 8.0
    c = await ambil_cal(ws)
    r0 = c["ratio"][IDX]
    if awal - 3 < c["joint_min"][IDX] or akhir > c["joint_max"][IDX]:
        print(f"batal: butuh {awal - 3:.0f}..{akhir:.0f} tapi limit J{SENDI} "
              f"{c['joint_min'][IDX]:.0f}..{c['joint_max'][IDX]:.0f}")
        return
    print(f"rasio terpasang {r0}, sapuan {awal:+.0f} .. {akhir:+.0f} "
          f"per {langkah:.1f} deg\n")

    # Turun melewati titik awal supaya backlash termakan di kaki naik pertama.
    print(f"  seating: turun ke {awal - 3:+.2f} lalu naik ke {awal:+.2f}")
    await _pergi(ws, awal - 3, 150.0)   # bisa menyeberangi seluruh rentang
    a, ok = await _pergi(ws, awal)
    if not ok:
        print("  BELUM DIAM, dibatalkan")
        return

    titik = [(awal, a)]
    print(f"  {'perintah':>9} {'encoder':>9} {'d-perintah':>11} {'d-encoder':>10}")
    print(f"  {awal:9.2f} {a:9.3f} {'(mulai)':>11}")
    t = awal
    while t < d - 1e-6:
        t = min(t + langkah, d)
        b, ok = await _pergi(ws, t)
        print(f"  {t:9.2f} {b:9.3f} {t - titik[-1][0]:11.2f} "
              f"{b - titik[-1][1]:10.3f}" + ("" if ok else "  BELUM DIAM!"))
        titik.append((t, b))

    # Kemiringan lewat kuadrat terkecil pada seluruh titik bersih.
    n = len(titik)
    mx = sum(p[0] for p in titik) / n
    my = sum(p[1] for p in titik) / n
    sxy = sum((p[0] - mx) * (p[1] - my) for p in titik)
    sxx = sum((p[0] - mx) ** 2 for p in titik)
    if sxx == 0:
        print("titik tidak cukup")
        return
    slope = sxy / sxx
    sisa = [p[1] - (my + slope * (p[0] - mx)) for p in titik]
    rms = (sum(s * s for s in sisa) / n) ** 0.5
    print(f"\nkemiringan encoder/perintah = {slope:.5f}  (1 = rasio pas)")
    print(f"sisa terhadap garis lurus: rms {rms:.3f} deg, "
          f"terbesar {max(abs(s) for s in sisa):.3f} deg")
    print(f"rasio sejati = {r0} / {slope:.5f} = {r0 / slope:.4f}")
    if rms > 0.3:
        print("  ^ sisa besar: gerak tidak linier (slip atau step hilang),"
              " rasio di atas belum bisa dipegang")

    # Galat posisi apa adanya: encoder dikurangi sudut yang diperintahkan.
    galat = [p[1] - p[0] for p in titik]
    rerata = sum(galat) / n
    print(f"galat posisi (encoder - perintah): rerata {rerata:+.3f}, "
          f"terbesar {max(abs(g) for g in galat):.3f} deg")

    catat(f"{PRE}-sapuan.csv",
          ["sesi", "tahap", "arah", "perintah_deg", "encoder_deg",
           "galat_deg", "sisa_linier_deg", "rasio_terpasang", "microstep"],
          [[SESI, TAHAP, "naik", f"{p[0]:.3f}", f"{p[1]:.3f}",
            f"{p[1] - p[0]:.3f}", f"{s:.3f}", r0, c["tmc_microstep"]]
           for p, s in zip(titik, sisa)])

    # Backlash: balik arah satu langkah, bandingkan dengan kemiringan bersih.
    balik = d - langkah
    b, ok = await _pergi(ws, balik)
    ukur = titik[-1][1] - b
    harap = slope * langkah
    backlash = harap - ukur
    print(f"\nbalik arah {langkah:.1f} deg: encoder bergerak {ukur:.3f}, "
          f"seharusnya {harap:.3f}")
    print(f"-> backlash + lost motion J{SENDI} = {backlash:.3f} deg")

    catat(f"{PRE}-ringkas.csv",
          ["sesi", "tahap", "rentang_deg", "langkah_deg", "titik",
           "rasio_terpasang", "kemiringan", "rasio_sejati", "rms_sisa_deg",
           "galat_rerata_deg", "galat_maks_deg", "backlash_deg", "microstep"],
          [[SESI, TAHAP, f"{awal:.0f}..{akhir:.0f}", f"{langkah:.2f}", n, r0,
            f"{slope:.5f}", f"{r0 / slope:.4f}", f"{rms:.3f}",
            f"{rerata:+.3f}", f"{max(abs(g) for g in galat):.3f}",
            f"{backlash:.3f}", c["tmc_microstep"]]])


async def _diam_rata(ws, detik=1.5):
    """Rerata sudut selama `detik` terakhir sesudah gerak dianggap selesai."""
    loop = asyncio.get_event_loop()
    t0 = loop.time()
    n = []
    while loop.time() - t0 < detik:
        a = await sudut(ws)
        if a is not None:
            n.append(a)
    return sum(n) / len(n) if n else float("nan")


async def p_magnet(ws, arg):
    """Kekuatan medan magnet SEPANJANG travel, bukan cuma di satu pose.

    AS5600 melapor AGC (gain otomatis) dan MAGNITUDE. AGC yang mentok di 128
    berarti chip sudah menaikkan gain sampai batas dan medannya terlalu lemah;
    di J1 kondisi itu berpasangan dengan galat sistematis 1,38 deg. Yang mudah
    terlewat: angka ini BERUBAH menurut sudut sendi, karena magnet ikut berputar
    dan dudukannya tidak pernah benar-benar sepusat. Memeriksanya di satu pose
    saja bisa memberi lampu hijau palsu. Terlihat di J2 12 Agu 2026: AGC 104 di
    0 deg tetapi mentok 128 di +50 deg.

    arg: "80:20" (jangkauan +-, langkah). Dijalankan sesudah `pulih`.
    """
    bagian = (arg or "80:20").split(":")
    jangkauan = float(bagian[0])
    langkah = float(bagian[1]) if len(bagian) > 1 else 20.0
    c = await ambil_cal(ws)
    if jangkauan > min(abs(c["joint_min"][IDX]), c["joint_max"][IDX]):
        print(f"batal: jangkauan {jangkauan:.0f} melewati limit J{SENDI} "
              f"{c['joint_min'][IDX]:.0f}..{c['joint_max'][IDX]:.0f}")
        return
    sudut = []
    t = -jangkauan
    while t <= jangkauan + 1e-6:
        sudut.append(t)
        t += langkah
    print(f"{len(sudut)} titik, {-jangkauan:+.0f}..{jangkauan:+.0f} deg\n")
    print(f"  {'perintah':>9} {'encoder':>9} {'agc':>5} {'mag':>6} "
          f"{'md':>5} {'ml':>5} {'mh':>5}")
    baris, agcs = [], []
    for s in sudut:
        await _pergi(ws, s)
        await asyncio.sleep(1.0)
        await kirim(ws, {"cmd": "diag"})
        d = await tunggu(ws, "diag")
        if not d:
            print(f"  {s:9.2f}  diag tidak dijawab")
            continue
        e = d["enc"][IDX]
        a = await _diam_rata(ws, 0.8)
        agcs.append(e["agc"])
        print(f"  {s:9.2f} {a:9.3f} {e['agc']:5} {e['mag']:6} "
              f"{str(e['md']):>5} {str(e['ml']):>5} {str(e['mh']):>5}")
        baris.append([SESI, TAHAP, f"{s:.2f}", f"{a:.3f}", e["agc"], e["mag"],
                      int(bool(e["md"])), int(bool(e["ml"])), int(bool(e["mh"]))])
    if agcs:
        print(f"\nAGC: min {min(agcs)}  maks {max(agcs)}  "
              f"rentang {max(agcs) - min(agcs)}")
        if max(agcs) >= 128:
            print("  ^ MENTOK di 128 pada sebagian sudut: medan terlalu lemah"
                  " di sana, magnet kejauhan atau dudukannya miring")
        if min(agcs) <= 0:
            print("  ^ MENTOK di 0 pada sebagian sudut: medan terlalu kuat,"
                  " magnet kedekatan")
    catat(f"{PRE}-magnet.csv",
          ["sesi", "tahap", "perintah_deg", "encoder_deg", "agc", "magnitude",
           "md", "ml", "mh"], baris)
    await _pergi(ws, 0.0)


async def p_histeresis(ws, arg):
    """Histeresis di sudut BERBEBAN, sebagai pembanding backlash dari sapuan.

    `ulang` selalu mendatangi 0 derajat, dan untuk sendi pitch seperti J2 titik
    itu justru pose tegak tempat torsi gravitasi nyaris nol. Di sana tidak ada
    yang menentukan sisi mana dari backlash yang tersentuh, sehingga hasilnya
    bisa terbaca 0,000 dan tampak sempurna sementara sapuan di sudut terbeban
    melaporkan backlash yang nyata. Terjadi di J2 12 Agu 2026: pengulangan
    0,000 deg lawan backlash 0,226 deg dari sapuan yang sama sesinya.

    Dua angka itu tidak bisa dua-duanya benar tanpa penjelasan, jadi perintah
    ini mengukur langsung di sudut yang diminta.

    arg: "20" atau "20:5" (sudut sasaran, jumlah ulangan tiap arah)
    """
    bagian = (arg or "20").split(":")
    sasaran = float(bagian[0])
    n = int(bagian[1]) if len(bagian) > 1 else 3
    c = await ambil_cal(ws)
    if c["kp"] != 0:
        print(f"batal: kp={c['kp']}, jalankan 'siap' dulu supaya kp=0")
        return
    ayun = 15.0
    lo, hi = sasaran - ayun, sasaran + ayun
    if lo < c["joint_min"][IDX] or hi > c["joint_max"][IDX]:
        print(f"batal: butuh {lo:.0f}..{hi:.0f} tapi limit J{SENDI} "
              f"{c['joint_min'][IDX]:.0f}..{c['joint_max'][IDX]:.0f}")
        return
    print(f"sasaran {sasaran:+.1f} deg, {n} kali tiap arah, "
          f"ayun +-{ayun:.0f}, kp=0\n")
    hasil = {"naik": [], "turun": []}
    baris = []
    for i in range(n):
        for arah, dari in (("naik", lo), ("turun", hi)):
            await _pergi(ws, dari)
            await _pergi(ws, sasaran)
            a = await _diam_rata(ws)
            hasil[arah].append(a)
            print(f"  {i+1} {arah:5}: {a:+.3f}  (galat {a - sasaran:+.3f})")
            baris.append([SESI, TAHAP, i + 1, arah, f"{sasaran:.2f}",
                          f"{a:.3f}", f"{a - sasaran:+.3f}"])
    rer = {}
    for arah, v in hasil.items():
        m = sum(v) / len(v)
        rer[arah] = m
        sd = (sum((x - m) ** 2 for x in v) / len(v)) ** 0.5
        print(f"\n{arah:5}: rerata {m:+.3f}  sebaran {max(v) - min(v):.3f}  "
              f"simpangan baku {sd:.3f} deg")
    hist = rer["naik"] - rer["turun"]
    print(f"\nhisteresis di {sasaran:+.1f} deg = {hist:+.3f} deg "
          f"({abs(hist) / (360 / 4096):.1f} LSB encoder)")
    print(f"1 LSB AS5600 = {360 / 4096:.4f} deg; angka di bawah itu tidak bisa"
          " dibedakan dari nol oleh encoder ini")
    catat(f"{PRE}-histeresis.csv",
          ["sesi", "tahap", "ulangan", "arah", "sasaran_deg", "encoder_deg",
           "galat_deg"], baris)


async def p_ulang(ws, arg):
    """Pengulangan MEKANIS: datangi sasaran yang sama berulang kali dari dua
    arah. Dijalankan dengan kp=0 supaya yang terukur perilaku drivetrain,
    bukan kemampuan loop menutup selisih."""
    n = int(arg) if arg else 5
    sasaran = 0.0
    c = await ambil_cal(ws)
    if c["kp"] != 0:
        print(f"batal: kp={c['kp']}, jalankan 'siap' dulu supaya kp=0")
        return
    print(f"sasaran {sasaran:+.1f} deg, {n} kali tiap arah, kp=0\n")
    hasil = {"naik": [], "turun": []}
    baris = []
    for i in range(n):
        for arah, dari in (("naik", sasaran - 20), ("turun", sasaran + 20)):
            await _pergi(ws, dari)
            await _pergi(ws, sasaran)
            a = await _diam_rata(ws)
            hasil[arah].append(a)
            print(f"  {i+1} {arah:5}: {a:+.3f}")
            baris.append([SESI, TAHAP, i + 1, arah, f"{sasaran:.2f}",
                          f"{a:.3f}", f"{a - sasaran:+.3f}"])
    print()
    rer = {}
    for arah, v in hasil.items():
        m = sum(v) / len(v)
        rer[arah] = m
        sd = (sum((x - m) ** 2 for x in v) / len(v)) ** 0.5
        print(f"{arah:5}: rerata {m:+.3f}  sebaran {max(v) - min(v):.3f}  "
              f"simpangan baku {sd:.3f} deg")
    hist = rer["naik"] - rer["turun"]
    semua = hasil["naik"] + hasil["turun"]
    print(f"\nhisteresis (beda rerata dua arah) = {hist:+.3f} deg")
    print(f"pengulangan dua arah, sebaran total = "
          f"{max(semua) - min(semua):.3f} deg")
    catat(f"{PRE}-pengulangan.csv",
          ["sesi", "tahap", "ulangan", "arah", "sasaran_deg", "encoder_deg",
           "galat_deg"], baris)


async def p_tutup(ws, _):
    """Konvergensi loop tertutup: sesudah kp dipulihkan, seberapa dekat sendi
    berhenti dari sudut yang diminta. Diukur pada beberapa titik sepanjang
    rentang, tiap titik didatangi dari bawah dan dari atas."""
    c = await ambil_cal(ws)
    if c["kp"] == 0:
        print("batal: kp masih 0, jalankan 'pulih' dulu")
        return
    lim = min(abs(c["joint_min"][IDX]), c["joint_max"][IDX]) - 25
    sasaran = [-150, -100, -50, 0, 50, 100, 150]
    sasaran = [s for s in sasaran if abs(s) <= lim]
    print(f"kp={c['kp']} deadband={c['deadband']}, "
          f"{len(sasaran)} titik x 2 arah\n")
    baris, galat = [], []
    for s in sasaran:
        for arah, dari in (("naik", s - 20), ("turun", s + 20)):
            await _pergi(ws, dari)
            await _pergi(ws, s)
            await asyncio.sleep(2.0)          # beri waktu koreksi bekerja
            a = await _diam_rata(ws)
            g = a - s
            galat.append(g)
            print(f"  {s:+6.1f} dari {arah:5}: encoder {a:+8.3f}  "
                  f"galat {g:+.3f}")
            baris.append([SESI, TAHAP, f"{s:.1f}", arah, f"{a:.3f}",
                          f"{g:+.3f}"])
    n = len(galat)
    rer = sum(galat) / n
    print(f"\ngalat loop tertutup: rerata {rer:+.3f}, "
          f"rms {(sum(g*g for g in galat)/n) ** 0.5:.3f}, "
          f"terbesar {max(map(abs, galat)):.3f} deg")
    print(f"deadband firmware = {c['deadband']} deg")
    catat(f"{PRE}-loop-tertutup.csv",
          ["sesi", "tahap", "sasaran_deg", "arah", "encoder_deg", "galat_deg"],
          baris)


async def p_bolakbalik(ws, arg):
    """Ukur rasio: 0 -> +d -> 0 -> -d -> 0. Balik ke 0 membuktikan tak ada
    step yang hilang, jadi selisih yang tersisa benar-benar rasio."""
    d = float(arg)
    c = await ambil_cal(ws)
    r0 = c["ratio"][IDX]
    titik = [d, 0.0, -d, 0.0]
    a = await sudut(ws)
    print(f"rasio terpasang = {r0}, mulai dari {a:+.3f} deg\n")
    catat = [(0.0, a)]
    for t in titik:
        awal = await sudut(ws)
        await kirim(ws, {"cmd": "goto",
                         "angles": hanya(t)})
        b, dt, n = await diam(ws)
        tag = "" if n > 0 else "  BELUM DIAM!"
        print(f"  perintah {t:+7.2f} -> encoder {b:+8.3f}  "
              f"(gerak perintah {t - awal:+7.2f}, encoder {b - awal:+7.3f}){tag}")
        catat.append((t, b))
    kembali = catat[-1][1] - catat[0][1]
    print(f"\nkembali ke 0: encoder {catat[-1][1]:+.3f} "
          f"(geser {kembali:+.3f} dari awal)")
    if abs(kembali) > 0.5:
        print("  ^ geseran besar: ada step hilang / slip belt / backlash besar."
              "\n    Angka rasio di bawah BELUM boleh dipercaya.")
    naik = catat[1][1] - catat[0][1]
    turun = catat[3][1] - catat[2][1]
    for nama, ukur, minta in (("arah +", naik, d), ("arah -", turun, -d)):
        if abs(ukur) > 1e-6:
            print(f"{nama}: encoder {ukur:+.3f} untuk perintah {minta:+.2f}"
                  f"  -> rasio sejati = {r0 * minta / ukur:.4f}")
    if abs(naik) > 1e-6 and abs(turun) > 1e-6:
        rata = (r0 * d / naik + r0 * -d / turun) / 2
        print(f"\nrata rata rasio sejati = {rata:.4f}  (terpasang {r0})")


async def p_rasio(ws, arg):
    r = float(arg)
    c = await ambil_cal(ws)
    ra = list(c["ratio"])
    ra[IDX] = r
    await kirim(ws, {"cmd": "cal_set", "ratio": ra})
    print(f"ratio J{SENDI} -> {r}:", await ack(ws))
    c = await ambil_cal(ws)
    print(f"terbaca balik: ratio={c['ratio'][IDX]}")
    a = await sudut(ws)
    print(f"sudut J{SENDI} = {a:.2f} (step counter sudah di-sync ulang firmware)")


async def p_sign(ws, arg):
    s = int(arg)
    c = await ambil_cal(ws)
    es = list(c["enc_sign"])
    es[IDX] = s
    await kirim(ws, {"cmd": "cal_set", "enc_sign": es})
    print(f"enc_sign J{SENDI} -> {s:+d}:", await ack(ws))
    c = await ambil_cal(ws)
    print(f"terbaca balik: enc_sign={c['enc_sign'][IDX]:+d}")


async def p_pulih(ws, arg):
    """Kembalikan kp/limit/kecepatan ke nilai kerja."""
    lim = float(arg) if arg else 90.0
    c = await ambil_cal(ws)
    jmin, jmax = list(c["joint_min"]), list(c["joint_max"])
    jmin[IDX], jmax[IDX] = -lim, lim
    await kirim(ws, {"cmd": "cal_set", "kp": 0.4, "speed": 30.0, "accel": 60.0,
                     "joint_min": jmin, "joint_max": jmax})
    print(f"kp=0.4 speed=30 accel=60 limit J{SENDI} +-{lim}:", await ack(ws))
    c = await ambil_cal(ws)
    print(f"terbaca balik: kp={c['kp']} speed={c['speed']} "
          f"limit={c['joint_min'][IDX]}..{c['joint_max'][IDX]}")


async def p_limit(ws, arg):
    """Lebar batas gerak sendi terpilih di FIRMWARE, bukan cuma di skrip ini."""
    lim = float(arg)
    c = await ambil_cal(ws)
    jmin, jmax = list(c["joint_min"]), list(c["joint_max"])
    jmin[IDX], jmax[IDX] = -lim, lim
    await kirim(ws, {"cmd": "cal_set", "joint_min": jmin, "joint_max": jmax})
    print(f"limit J{SENDI} -> +-{lim}:", await ack(ws))
    c = await ambil_cal(ws)
    print(f"terbaca balik: {c['joint_min'][IDX]}..{c['joint_max'][IDX]}")


async def p_simpan(ws, _):
    await kirim(ws, {"cmd": "cal_save"})
    print("cal_save:", await ack(ws))


async def p_stop(ws, _):
    await kirim(ws, {"cmd": "estop"})
    print("estop:", await ack(ws))


PERINTAH = {
    "status": p_status, "bising": p_bising, "siap": p_siap, "nol": p_nol, "lepas": p_lepas,
    "gerak": p_gerak, "bolakbalik": p_bolakbalik, "sapu": p_sapu, "ulang": p_ulang,
    "histeresis": p_histeresis, "magnet": p_magnet, "tutup": p_tutup, "rasio": p_rasio,
    "sign": p_sign, "pulih": p_pulih, "simpan": p_simpan, "limit": p_limit, "stop": p_stop,
}


async def main():
    if len(sys.argv) < 2 or sys.argv[1] not in PERINTAH:
        print("perintah:", " ".join(PERINTAH))
        return
    arg = sys.argv[2] if len(sys.argv) > 2 else None
    async with websockets.connect(URL, ping_interval=None) as ws:
        await PERINTAH[sys.argv[1]](ws, arg)


asyncio.run(main())
