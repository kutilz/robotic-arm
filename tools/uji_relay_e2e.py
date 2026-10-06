"""Uji ujung ke ujung jalur CLOUD tanpa lengan: relay + simulator + browser tiruan.

    cd relay && npm run dev           # terminal 1: relay lokal di :8787
    python tools/uji_relay_e2e.py     # terminal 2

Atau ke relay yang sudah di-deploy:
    python tools/uji_relay_e2e.py --relay wss://armbot-relay.namamu.workers.dev \\
        --key <DEVICE_KEY> --token <OP_TOKEN>

Simulator (src/arm/bridge.py) memainkan ESP32 lengkap dengan blok JALUR, dan
menyambung KELUAR ke relay persis seperti cloud_link.h. Yang dibuktikan di
sini adalah rantai yang tidak bisa diuji per modul: autentikasi relay,
alamat balasan "_c", satu operator, lease yang benar benar merem "lengan"
saat browser berhenti bicara, dan lease_drop saat browser menutup tab.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import pathlib
import sys
import time

import websockets

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "src"))
from arm.bridge import Impair, SimLink, cloud_loop  # noqa: E402

bad = 0


def check(nama: str, ok: bool, detail: str = "") -> None:
    global bad
    print(f"  {'OK  ' if ok else 'GAGAL'} {nama}{'  ' + detail if detail else ''}")
    if not ok:
        bad += 1


class Ui:
    """Browser tiruan: kumpulkan pesan, kirim perintah, ukur RTT."""

    def __init__(self, ws) -> None:
        self.ws = ws
        self.msgs: list[dict] = []
        self.seq = 0
        self.task = asyncio.create_task(self._rx())

    async def _rx(self) -> None:
        try:
            async for raw in self.ws:
                self.msgs.append(json.loads(raw))
        except websockets.ConnectionClosed:
            pass

    async def send(self, **m) -> None:
        await self.ws.send(json.dumps(m))

    def last(self, typ: str) -> dict | None:
        for m in reversed(self.msgs):
            if m.get("type") == typ:
                return m
        return None

    async def wait(self, pred, timeout: float = 5.0) -> dict | None:
        t0 = time.monotonic()
        while time.monotonic() - t0 < timeout:
            for m in self.msgs:
                if pred(m):
                    return m
            await asyncio.sleep(0.02)
        return None

    async def ping(self, lease: int | None = None) -> float | None:
        self.seq += 1
        seq = self.seq
        t = time.monotonic() * 1000
        m = {"cmd": "ping", "seq": seq, "t": t}
        if lease:
            m["lease"] = lease
        await self.send(**m)
        p = await self.wait(lambda x: x.get("type") == "pong" and x.get("seq") == seq, 6)
        return time.monotonic() * 1000 - t if p else None

    async def close(self) -> None:
        await self.ws.close()
        self.task.cancel()


async def expect_reject(url: str) -> bool:
    try:
        async with websockets.connect(url):
            return False
    except websockets.InvalidStatus as e:
        return 400 <= e.response.status_code < 500
    except Exception:  # noqa: BLE001
        return True


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--relay", default="ws://127.0.0.1:8787")
    ap.add_argument("--arm", default="e2e-test")
    ap.add_argument("--key", default="dev-device-key")
    ap.add_argument("--token", default="dev-op-token")
    ap.add_argument("--view-token", default="dev-view-token")
    ap.add_argument("--delay", type=float, default=60, help="latensi satu arah tiruan 4G (ms)")
    ap.add_argument("--jitter", type=float, default=40)
    a = ap.parse_args()

    base = f"{a.relay}/arm/{a.arm}"
    ui_url = f"{base}/ui?token={a.token}"

    print("\n== autentikasi ==")
    check("kunci perangkat salah ditolak", await expect_reject(f"{base}/device?key=salah"))
    check("token browser salah ditolak", await expect_reject(f"{base}/ui?token=salah"))
    check("arm id aneh ditolak", await expect_reject(f"{a.relay}/arm/BAD!id/ui?token={a.token}"))

    print("\n== relay tanpa lengan ==")
    u1 = Ui(await websockets.connect(ui_url))
    st = await u1.wait(lambda m: m.get("type") == "relay")
    check("status relay datang saat browser masuk", st is not None)
    check("lengan dilaporkan offline", st is not None and st["device"] is False)
    await u1.send(cmd="goto", angles=[0, 0, 0, 0, 0, 0])
    ack = await u1.wait(lambda m: m.get("type") == "ack" and m.get("cmd") == "goto")
    check("goto tanpa lengan ditolak relay", ack is not None and ack["ok"] is False)

    print(f"\n== lengan (simulator) masuk lewat 'internet' {a.delay:.0f}+{a.jitter:.0f} ms ==")
    sim = SimLink()
    sim.cal["speed"] = 30.0
    holder = {"out": None}
    dev = asyncio.create_task(cloud_loop(sim, f"{base}/device?key={a.key}", Impair(a.delay, a.jitter),
                                         lambda f: holder.__setitem__("out", f)))

    async def feedback_pump() -> None:
        last = 0.0
        while True:
            sim.tick()
            now = time.monotonic() * 1000
            if holder["out"] and sim.cloud_fb_ms and now - last >= sim.cloud_fb_ms:
                last = now
                holder["out"](json.dumps(sim.feedback_payload()))
            await asyncio.sleep(SimLink.DT)

    pump = asyncio.create_task(feedback_pump())
    st = await u1.wait(lambda m: m.get("type") == "relay" and m.get("device") is True, 10)
    check("relay mengabarkan lengan tersambung", st is not None)
    fb = await u1.wait(lambda m: m.get("type") == "feedback", 5)
    check("feedback mengalir ke browser (link_cfg dari relay sampai)", fb is not None)

    rtts = [r for r in [await u1.ping() for _ in range(10)] if r is not None]
    rtts.sort()
    check("pong kembali ke browser penanya (_c)", len(rtts) == 10,
          f"RTT p50 {rtts[len(rtts) // 2]:.0f} ms, maks {rtts[-1]:.0f} ms" if rtts else "")
    check("RTT mencerminkan latensi tiruan dua arah", bool(rtts) and rtts[0] >= 2 * a.delay * 0.9)

    print("\n== satu operator ==")
    u2 = Ui(await websockets.connect(ui_url))
    await u2.wait(lambda m: m.get("type") == "relay")
    await u1.send(cmd="goto", angles=[40, 0, 0, 0, 0, 0], lease=3000)
    await asyncio.sleep(0.5)
    await u2.send(cmd="goto", angles=[-40, 0, 0, 0, 0, 0], lease=3000)
    ack = await u2.wait(lambda m: m.get("type") == "ack" and m.get("cmd") == "goto")
    check("browser kedua ditolak selagi pertama memegang", ack is not None and ack["ok"] is False,
          ack["msg"] if ack else "")
    check("target lengan tetap milik browser pertama", sim.target[0] == 40)
    rel = await u2.wait(lambda m: m.get("type") == "relay" and m.get("ctrl") == "other", 3)
    check("browser kedua diberi tahu kendali dipegang orang lain", rel is not None)

    print("\n== penonton ==")
    v = Ui(await websockets.connect(f"{base}/ui?token={a.view_token}"))
    st = await v.wait(lambda m: m.get("type") == "relay")
    check("token lihat saja dikenali", st is not None and st["role"] == "viewer")
    await v.send(cmd="goto", angles=[0, 0, 0, 0, 0, 0])
    ack = await v.wait(lambda m: m.get("type") == "ack")
    check("penonton tidak bisa menggerakkan", ack is not None and ack["ok"] is False)
    await v.send(cmd="estop")
    ok = await v.wait(lambda m: m.get("type") == "ack" and m.get("cmd") == "estop" and m["ok"], 5)
    check("penonton BISA menekan e-stop", ok is not None and sim.estop)
    await u1.send(cmd="resume")
    await u1.wait(lambda m: m.get("type") == "ack" and m.get("cmd") == "resume", 5)
    await v.close()

    print("\n== lease: browser berhenti bicara ==")
    await u1.send(cmd="goto", angles=[80, 0, 0, 0, 0, 0], lease=1500)
    await asyncio.sleep(0.4)
    check("lengan mulai bergerak", 0 < sim.actual[0] < 80 and not sim.hold, f"J1 {sim.actual[0]:.1f}")
    # Tidak ada ping, tidak ada goto: tab dibekukan, sinyal hilang, apa pun.
    await asyncio.sleep(2.0)
    pos = sim.actual[0]
    check("lease habis -> lengan direm sebelum sampai", sim.hold and pos < 80, f"berhenti di J1 {pos:.1f}")
    fbh = await u1.wait(lambda m: m.get("type") == "feedback" and m.get("hold") is True, 3)
    check("browser melihat hold di feedback", fbh is not None)
    await asyncio.sleep(0.5)
    check("tidak ada gerak sesudah hold", abs(sim.actual[0] - pos) < 1e-6)

    print("\n== lease: diperpanjang ping ==")
    await u1.send(cmd="goto", angles=[0, 0, 0, 0, 0, 0], lease=1500)
    for _ in range(8):
        await u1.ping(lease=1500)
        await asyncio.sleep(0.25)
    check("ping berlease menjaga gerak tetap jalan", not sim.hold, f"J1 {sim.actual[0]:.1f}")

    print("\n== operator menutup tab ==")
    await u1.send(cmd="goto", angles=[60, 0, 0, 0, 0, 0], lease=5000)
    await asyncio.sleep(0.3)
    t0 = time.monotonic()
    await u1.close()
    while not sim.hold and time.monotonic() - t0 < 4:
        await asyncio.sleep(0.02)
    dt = (time.monotonic() - t0) * 1000
    check("lease_drop merem lengan jauh sebelum lease 5 dtk habis", sim.hold and dt < 1500, f"{dt:.0f} ms")
    await u2.send(cmd="goto", angles=[10, 0, 0, 0, 0, 0], lease=1500)
    await asyncio.sleep(1.0)
    check("browser kedua sekarang boleh mengendalikan", sim.target[0] == 10)

    print("\n== lengan putus dari relay ==")
    dev.cancel()
    pump.cancel()
    st = await u2.wait(lambda m: m.get("type") == "relay" and m.get("device") is False
                       and u2.msgs.index(m) > 3, 5)
    check("browser diberi tahu lengan offline", st is not None)
    await u2.close()

    print("\n" + ("semua pemeriksaan lulus" if bad == 0 else f"{bad} PEMERIKSAAN GAGAL"))
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
