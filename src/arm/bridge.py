"""Bridge Digital Twin: serial (Arduino) <-> WebSocket (interface web).

Aliran data dua arah:
  * Encoder feedback  : firmware kirim "FB,j1,j2,j3,j4,j5,j6\n" -> broadcast ke web
  * Perintah target   : web kirim {"cmd":"goto","angles":[..6..]} -> "GO,..\n" ke firmware

Protokol serial (baris teks, baud 115200):
  ke firmware  : "GO,a1,a2,a3,a4,a5,a6\n"  (sudut target derajat)
  dari firmware: "FB,a1,a2,a3,a4,a5,a6\n"  (sudut aktual dari encoder AS5600)

Mode --simulate juga meniru protokol kalibrasi ESP32 (cal_get/cal_set/cal_zero/
cal_save/cal_reset/diag/load_tare/load_scale + balasan cal/diag/ack) supaya tab
CAL studio bisa diuji end-to-end tanpa hardware.

Sejak 7 Okt 2026 simulator juga meniru blok JALUR firmware: ping/pong, lease
(lengan direm kalau perintah berhenti datang), pemegang kendali lokal vs
cloud, dan daftar perintah yang boleh datang dari cloud. Dengan --cloud dia
menyambung KELUAR ke relay persis seperti ESP32, dan --delay/--jitter/--stall
meniru internet yang tersendat supaya penanganan latensi di studio bisa diuji
tanpa lengan dan tanpa 4G.

Jalankan:
    python -m arm.bridge --port COM5            # hardware nyata
    python -m arm.bridge --simulate             # tanpa hardware (uji digital twin)
    python -m arm.bridge --simulate --cloud ws://localhost:8787/arm/armbot/device?key=dev-device-key \\
        --delay 80 --jitter 60 --stall 20:2     # tiap 20 dtk macet 2 dtk

Lalu buka studio dan sambungkan ke ws://localhost:8765 (lokal) atau lewat relay.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import random
import time

try:
    import serial  # pyserial
except ImportError:  # pragma: no cover - opsional saat mode simulate
    serial = None

try:
    import websockets
except ImportError:  # pragma: no cover
    websockets = None

BAUD = 115200
WS_HOST = "localhost"
WS_PORT = 8765
NUM_JOINTS = 6

# Konstanta blok JALUR, sama persis dengan firmware.
LEASE_MIN_MS = 200
LEASE_MAX_MS = 8000
CLOUD_LEASE_DEFAULT_MS = 1500
CTRL_IDLE_MS = 5000
CLOUD_MAX_DPS = 25.0
CLOUD_MAX_DPSS = 90.0
CLOUD_OK = {"goto", "gripper", "estop", "resume", "ping", "cal_get", "diag", "lease_drop", "link_cfg"}
MOTION = {"goto", "gripper"}


def now_ms() -> float:
    return time.monotonic() * 1000.0


class ArmLink:
    """Abstraksi sumber/penerima data sendi (hardware nyata atau simulasi)."""

    def read_feedback(self) -> list[float] | None:
        raise NotImplementedError

    def send_target(self, angles: list[float]) -> None:
        raise NotImplementedError


class SerialLink(ArmLink):
    def __init__(self, port: str, baud: int = BAUD):
        if serial is None:
            raise RuntimeError("pyserial belum terpasang: pip install pyserial")
        self.ser = serial.Serial(port, baud, timeout=0.05)

    def read_feedback(self) -> list[float] | None:
        line = self.ser.readline().decode(errors="ignore").strip()
        if not line.startswith("FB,"):
            return None
        try:
            vals = [float(x) for x in line[3:].split(",")]
        except ValueError:
            return None
        return vals if len(vals) == NUM_JOINTS else None

    def send_target(self, angles: list[float]) -> None:
        self.ser.write(("GO," + ",".join(f"{a:.2f}" for a in angles) + "\n").encode())


class SimLink(ArmLink):
    """Simulasi lengan: sendi bergerak menuju target dgn laju profil (cal speed).

    Juga meniru protokol kalibrasi firmware ESP32 (state di RAM dict) supaya
    tab CAL studio (lamp magnet, parameter APPLY/COMMIT, load cell, TEST rasio)
    berfungsi penuh tanpa hardware, plus blok JALUR (lease, pemegang kendali).
    """

    DT = 0.02  # periode read_feedback (50 Hz)

    def __init__(self, clock=now_ms) -> None:
        self.clock = clock
        self.actual = [0.0] * NUM_JOINTS
        self.target = [0.0] * NUM_JOINTS
        self.estop = False
        self.cal = self._defaults()
        self.load_g = 0.0    # "beban" simulasi utk blok load cell
        self.grip = 30.0
        # blok JALUR
        self.ctrl = "none"
        self.ctrl_until = 0.0
        self.lease_on = False
        self.lease_until = 0.0
        self.hold = False
        self.cloud_fb_ms = 0

    @staticmethod
    def _defaults() -> dict:
        return {
            "enc_offset": [0.0] * 4,
            "enc_sign": [1] * 4,
            # Rasio FINAL J1..J4 (selaras config.JOINTS dan firmware RATIO[]).
            "ratio": [15.0, 30.0, 30.0, 15.0],
            "joint_min": [-180, -95, -150, -180, -120, -180],
            "joint_max": [180, 95, 150, 180, 120, 180],
            "speed": 60.0, "accel": 120.0, "kp": 0.4, "deadband": 0.3,
            "load_offset": 0.0, "load_scale": 420.0,
        }

    # ---- gerak ----

    def tick(self) -> None:
        """Satu putaran loop firmware: lease, lalu gerak dibatasi laju profil."""
        now = self.clock()
        if self.lease_on and now > self.lease_until:
            self.freeze("lease habis")
        if self.estop:
            return
        step = float(self.cal["speed"]) * self.DT
        for i in range(NUM_JOINTS):
            err = self.target[i] - self.actual[i]
            self.actual[i] += max(-step, min(step, err))

    def read_feedback(self) -> list[float]:
        self.tick()
        return list(self.actual)

    def send_target(self, angles: list[float]) -> None:
        if self.estop:
            return  # ESTOP_AUTO_RESUME 0: goto TIDAK melepas e-stop
        lo, hi = self.cal["joint_min"], self.cal["joint_max"]
        self.target = [max(lo[i], min(hi[i], a)) for i, a in enumerate(angles)]

    def freeze(self, why: str) -> None:
        """bekukanLease(): rem di tempat, kendali dilepas."""
        self.lease_on = False
        self.ctrl_until = self.clock()
        if self.hold:
            return
        self.hold = True
        self.target = list(self.actual)

    # ---- blok JALUR ----

    def owner(self) -> str:
        return self.ctrl if self.ctrl != "none" and self.clock() < self.ctrl_until else "none"

    def _lease(self, data: dict, jalur: str) -> None:
        L = data.get("lease")
        L = L if isinstance(L, (int, float)) and L > 0 else 0
        if L <= 0 and jalur == "cloud":
            L = CLOUD_LEASE_DEFAULT_MS
        now = self.clock()
        if L > 0:
            L = max(LEASE_MIN_MS, min(LEASE_MAX_MS, L))
            self.lease_on = True
            self.lease_until = now + L
            self.ctrl_until = self.lease_until
        else:
            self.lease_on = False
            self.ctrl_until = now + CTRL_IDLE_MS

    def claim(self, data: dict, jalur: str) -> str | None:
        """klaimGerak(): None = boleh, selain itu alasan penolakan."""
        p = self.owner()
        if p != "none" and p != jalur and jalur == "cloud":
            return "lengan sedang dikendalikan dari jaringan lokal"
        self.ctrl = jalur
        self._lease(data, jalur)
        self.hold = False
        return None

    def link_down(self) -> None:
        """relay putus: kalau cloud memegang kendali, rem."""
        self.cloud_fb_ms = 0
        if self.ctrl == "cloud":
            self.freeze("relay putus")
            self.ctrl = "none"

    def feedback_payload(self) -> dict:
        return {
            "type": "feedback",
            "angles": [round(a, 2) for a in self.actual],
            "estop": self.estop, "fault": [0, 0, 0, 0], "grip": round(self.grip, 2),
            "drvok": True, "drvrst": 0,
            "t": int(self.clock()) & 0xFFFFFFFF, "own": self.owner(), "hold": self.hold,
        }

    # ---- protokol (meniru handleText firmware) ----

    def handle_cmd(self, data: dict, jalur: str = "local") -> dict | None:
        """Kembalikan pesan balasan (cal/diag/ack/pong) atau None."""
        cmd = data.get("cmd", "")
        ack = lambda ok, msg: {"type": "ack", "cmd": cmd or "?", "ok": ok, "msg": msg}

        if jalur == "cloud":
            ok = cmd in CLOUD_OK
            if cmd == "servo_us":
                ok = data.get("servo") == 2
            elif cmd == "cal_set":
                ok = set(data) <= {"cmd", "_c", "speed", "accel"}
                if ok and isinstance(data.get("speed"), (int, float)):
                    data["speed"] = min(data["speed"], CLOUD_MAX_DPS)
                if ok and isinstance(data.get("accel"), (int, float)):
                    data["accel"] = min(data["accel"], CLOUD_MAX_DPSS)
            if not ok:
                return ack(False, "perintah ini hanya dari jaringan lokal")

        if cmd == "ping":
            if data.get("lease") is not None and self.owner() == jalur:
                self._lease(data, jalur)
            return {"type": "pong", "seq": data.get("seq", 0), "t": data.get("t", 0)}
        if cmd == "lease_drop":
            if jalur == "cloud" and self.ctrl == "cloud":
                self.freeze("operator cloud pergi")
                self.ctrl = "none"
            return None
        if cmd == "link_cfg":
            if jalur == "cloud":
                hz = max(0, min(25, int(data.get("fb_hz", 0) or 0)))
                self.cloud_fb_ms = int(1000 / hz) if hz else 0
            return None

        if cmd in MOTION or (cmd == "servo_us" and data.get("servo") == 2):
            if self.estop and cmd == "goto":
                return ack(False, "e-stop aktif, goto ditolak")
            why = self.claim(data, jalur)
            if why:
                return ack(False, why)
            if cmd == "goto":
                angles = [float(a) for a in data.get("angles", [])][:NUM_JOINTS]
                if len(angles) == NUM_JOINTS:
                    self.send_target(angles)
                return None
            if cmd == "gripper":
                self.grip = float(data.get("deg", self.grip))
                return ack(True, "target gripper diterima")
            return ack(True, "pulsa mentah diterapkan (mode manual)")

        if cmd == "estop":
            self.estop = True
            return ack(True, "e-stop aktif")
        if cmd == "resume":
            self.estop = False
            self.target = list(self.actual)
            return ack(True, "e-stop dilepas")
        if cmd == "cal_get":
            return {"type": "cal", **self.cal}
        if cmd == "cal_set":
            for k in self.cal:
                if k in data:
                    self.cal[k] = data[k]
            return ack(True, "diterapkan (RAM, belum disimpan) [sim]")
        if cmd == "cal_zero":
            joints = range(4) if "joint" not in data else [int(data["joint"]) - 1]
            for i in joints:
                if not 0 <= i < 4:
                    return ack(False, "joint di luar 1..4")
                self.actual[i] = 0.0
                self.target[i] = 0.0
            return ack(True, "pose sekarang = 0 [sim]")
        if cmd == "cal_save":
            return ack(True, "tersimpan di NVS [sim]")
        if cmd == "cal_reset":
            self.cal = self._defaults()
            return ack(True, "kalibrasi default [sim]")
        if cmd == "load_tare":
            self.load_g = 0.0
            return ack(True, "tare OK [sim]")
        if cmd == "load_scale":
            return ack(True, "skala OK [sim]")
        if cmd == "diag":
            return self._diag()
        return ack(False, "command tak dikenal")

    def _diag(self) -> dict:
        # Magnet sehat di semua channel; raw = sudut aktual di-wrap 0..360
        # + "beban" load cell mengikuti sin dari sudut J1 biar kelihatan hidup.
        self.load_g = 150.0 + 120.0 * math.sin(math.radians(self.actual[0]))
        enc = [{
            "ok": True, "md": True, "ml": False, "mh": False,
            "agc": 128, "mag": 2100,
            "raw": round(self.actual[i] % 360.0, 2),
            "deg": round(self.actual[i], 2), "fault": False,
        } for i in range(4)]
        return {
            "type": "diag", "enc": enc, "sg": [220, 180, 210, 240],
            "load": {"ok": True, "raw": int(self.load_g * 420), "g": round(self.load_g, 1), "cal": True},
            "wifi": {"mode": "sim", "ip": f"{WS_HOST}:{WS_PORT}", "rssi": 0},
            "cloud": {"on": True, "own": self.owner(), "hold": self.hold},
            "mux": True,
        }


# ---------------------------------------------------------------------------
# Gangguan jaringan buatan (hanya jalur cloud)


class Impair:
    """Tunda pesan seperti TCP lewat 4G: urutan dijaga, latensi + jitter, dan
    stall berkala yang menahan SEMUA pesan lalu menumpahkannya bersamaan."""

    def __init__(self, delay_ms: float = 0, jitter_ms: float = 0, stall: str | None = None,
                 seed: int = 7) -> None:
        self.delay = delay_ms / 1000.0
        self.jitter = jitter_ms / 1000.0
        self.every, self.dur = 0.0, 0.0
        if stall:
            a, b = stall.split(":")
            self.every, self.dur = float(a), float(b)
        self.rng = random.Random(seed)
        self.last = 0.0
        self.t0 = time.monotonic()

    def deliver_at(self) -> float:
        now = time.monotonic()
        at = now + self.delay + self.rng.random() * self.jitter
        if self.every > 0:
            phase = (now - self.t0) % self.every
            if phase > self.every - self.dur:          # sedang macet
                at = max(at, now + (self.every - phase))
        at = max(at, self.last)                         # TCP: tidak boleh menyalip
        self.last = at
        return at

    async def run(self, q: asyncio.Queue, send) -> None:
        while True:
            at, text = await q.get()
            wait = at - time.monotonic()
            if wait > 0:
                await asyncio.sleep(wait)
            await send(text)


# ---------------------------------------------------------------------------
# Jalur lokal: server WebSocket (meniru :81 ESP32)


async def broadcast_loop(link: ArmLink, clients: set, cloud_out=None) -> None:
    """Baca feedback berkala, broadcast ke semua klien web (dan ke relay)."""
    last_cloud = 0.0
    while True:
        fb = link.read_feedback()
        if fb is not None:
            if isinstance(link, SimLink):  # samakan bentuk dengan firmware ESP32
                payload = link.feedback_payload()
            else:
                payload = {"type": "feedback", "angles": [round(a, 2) for a in fb]}
            msg = json.dumps(payload)
            if clients:
                await asyncio.gather(*(c.send(msg) for c in list(clients)), return_exceptions=True)
            if cloud_out and isinstance(link, SimLink) and link.cloud_fb_ms:
                t = now_ms()
                if t - last_cloud >= link.cloud_fb_ms:
                    last_cloud = t
                    cloud_out(msg)
        await asyncio.sleep(SimLink.DT)  # ~50 Hz


async def handler(ws, link: ArmLink, clients: set) -> None:
    clients.add(ws)
    try:
        async for raw in ws:
            data = json.loads(raw)
            if isinstance(link, SimLink):
                reply = link.handle_cmd(data, "local")
                if reply is not None:
                    await ws.send(json.dumps(reply))
            elif data.get("cmd") == "goto":
                angles = [float(a) for a in data["angles"]][:NUM_JOINTS]
                link.send_target(angles)
    except Exception:  # noqa: BLE001 - klien putus / pesan rusak
        pass
    finally:
        clients.discard(ws)


# ---------------------------------------------------------------------------
# Jalur cloud: menyambung KELUAR ke relay (meniru cloud_link.h)


def reply_with_c(reply: dict, c) -> str:
    """Balasan ber-"_c" PALING DEPAN, persis bentuk cloudReply() firmware."""
    return json.dumps({"_c": c, **reply})


async def cloud_loop(link: SimLink, url: str, imp: Impair, set_out) -> None:
    retry = 2.0
    while True:
        try:
            async with websockets.connect(url, max_size=2**20) as ws:
                print(f"[CLOUD] tersambung ke relay {url.split('?')[0]}")
                retry = 2.0
                q_out: asyncio.Queue = asyncio.Queue()
                q_in: asyncio.Queue = asyncio.Queue()

                def out(text: str) -> None:
                    q_out.put_nowait((imp.deliver_at(), text))

                set_out(out)

                async def handle(text: str) -> None:
                    try:
                        data = json.loads(text)
                    except ValueError:
                        return
                    c = data.get("_c", 0)
                    reply = link.handle_cmd(data, "cloud")
                    if reply is not None:
                        out(reply_with_c(reply, c))

                sender = asyncio.create_task(imp.run(q_out, ws.send))
                receiver = asyncio.create_task(imp.run(q_in, handle))
                try:
                    async for raw in ws:
                        q_in.put_nowait((imp.deliver_at(), raw))
                finally:
                    sender.cancel()
                    receiver.cancel()
                    set_out(None)
                    link.link_down()
                    print("[CLOUD] relay putus")
        except Exception as e:  # noqa: BLE001 - relay mati / jaringan putus
            print(f"[CLOUD] gagal tersambung ({e.__class__.__name__}), coba lagi {retry:.0f} dtk")
        await asyncio.sleep(retry)
        retry = min(retry * 2, 30.0)


async def main_async(link: ArmLink, cloud: str | None = None, imp: Impair | None = None,
                     serve_local: bool = True) -> None:
    if websockets is None:
        raise RuntimeError("websockets belum terpasang: pip install websockets")
    clients: set = set()
    holder = {"out": None}

    def cloud_out(text: str) -> None:
        if holder["out"]:
            holder["out"](text)

    tasks = []
    if cloud and isinstance(link, SimLink):
        tasks.append(asyncio.create_task(
            cloud_loop(link, cloud, imp or Impair(), lambda f: holder.__setitem__("out", f))))
    if serve_local:
        async with websockets.serve(lambda ws: handler(ws, link, clients), WS_HOST, WS_PORT):
            print(f"Digital twin bridge aktif di ws://{WS_HOST}:{WS_PORT}")
            await broadcast_loop(link, clients, cloud_out)
    else:
        await broadcast_loop(link, clients, cloud_out)


def main() -> None:
    p = argparse.ArgumentParser(description="Bridge digital twin serial<->web")
    p.add_argument("--port", help="port serial Arduino, mis. COM5 atau /dev/ttyUSB0")
    p.add_argument("--simulate", action="store_true", help="jalankan tanpa hardware")
    p.add_argument("--cloud", help="URL device relay, mis. ws://localhost:8787/arm/armbot/device?key=...")
    p.add_argument("--no-local", action="store_true", help="jangan buka server lokal :8765")
    p.add_argument("--delay", type=float, default=0, help="[cloud] latensi satu arah, ms")
    p.add_argument("--jitter", type=float, default=0, help="[cloud] jitter tambahan maksimum, ms")
    p.add_argument("--stall", help="[cloud] 'tiap:lama' detik, mis. 20:2 = tiap 20 dtk macet 2 dtk")
    args = p.parse_args()

    if args.simulate or not args.port:
        print("Mode SIMULASI (tanpa hardware).")
        link: ArmLink = SimLink()
    else:
        link = SerialLink(args.port)

    imp = Impair(args.delay, args.jitter, args.stall)
    try:
        asyncio.run(main_async(link, args.cloud, imp, serve_local=not args.no_local))
    except KeyboardInterrupt:
        print("\nBridge dihentikan.")


if __name__ == "__main__":
    main()
