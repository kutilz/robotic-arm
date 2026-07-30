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

Jalankan:
    python -m arm.bridge --port COM5            # hardware nyata
    python -m arm.bridge --simulate             # tanpa hardware (uji digital twin)

Lalu buka studio/index.html dan sambungkan ke ws://localhost:8765
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math

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
    """Simulasi lengan: sendi bergerak menuju target dgn laju terbatas.

    Juga meniru protokol kalibrasi firmware ESP32 (state di RAM dict) supaya
    tab CAL studio (lamp magnet, parameter APPLY/COMMIT, load cell, TEST rasio)
    berfungsi penuh tanpa hardware.
    """

    def __init__(self) -> None:
        self.actual = [0.0] * NUM_JOINTS
        self.target = [0.0] * NUM_JOINTS
        self.max_step = 2.0  # derajat per tick (model laju gerak)
        self.estop = False
        self.cal = self._defaults()
        self.load_g = 0.0    # "beban" simulasi utk blok load cell

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

    def read_feedback(self) -> list[float]:
        if self.estop:
            return list(self.actual)
        for i in range(NUM_JOINTS):
            err = self.target[i] - self.actual[i]
            self.actual[i] += max(-self.max_step, min(self.max_step, err))
        return list(self.actual)

    def send_target(self, angles: list[float]) -> None:
        if self.estop:
            return  # ESTOP_AUTO_RESUME 0: goto TIDAK melepas e-stop
        lo, hi = self.cal["joint_min"], self.cal["joint_max"]
        self.target = [max(lo[i], min(hi[i], a)) for i, a in enumerate(angles)]

    # ---- protokol kalibrasi (meniru handleText firmware) ----

    def handle_cmd(self, data: dict) -> dict | None:
        """Kembalikan pesan balasan (cal/diag/ack) atau None (goto: tanpa ack)."""
        cmd = data.get("cmd", "")
        ack = lambda ok, msg: {"type": "ack", "cmd": cmd, "ok": ok, "msg": msg}

        if cmd == "estop":
            self.estop = True
            return ack(True, "e-stop aktif")
        if cmd == "resume":
            self.estop = False
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
        if cmd == "goto":
            return None
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
            "mux": True,
        }


async def broadcast_loop(link: ArmLink, clients: set) -> None:
    """Baca feedback berkala, broadcast ke semua klien web."""
    while True:
        fb = link.read_feedback()
        if fb is not None and clients:
            payload = {"type": "feedback", "angles": [round(a, 2) for a in fb]}
            if isinstance(link, SimLink):  # samakan bentuk dengan firmware ESP32
                payload["estop"] = link.estop
                payload["fault"] = [0, 0, 0, 0]
            msg = json.dumps(payload)
            await asyncio.gather(*(c.send(msg) for c in list(clients)), return_exceptions=True)
        await asyncio.sleep(0.02)  # ~50 Hz


async def handler(ws, link: ArmLink, clients: set) -> None:
    clients.add(ws)
    try:
        async for raw in ws:
            data = json.loads(raw)
            if data.get("cmd") == "goto":
                angles = [float(a) for a in data["angles"]][:NUM_JOINTS]
                link.send_target(angles)
            elif isinstance(link, SimLink):
                reply = link.handle_cmd(data)
                if reply is not None:
                    await ws.send(json.dumps(reply))
    except Exception:  # noqa: BLE001 - klien putus / pesan rusak
        pass
    finally:
        clients.discard(ws)


async def main_async(link: ArmLink) -> None:
    if websockets is None:
        raise RuntimeError("websockets belum terpasang: pip install websockets")
    clients: set = set()
    async with websockets.serve(lambda ws: handler(ws, link, clients), WS_HOST, WS_PORT):
        print(f"Digital twin bridge aktif di ws://{WS_HOST}:{WS_PORT}")
        await broadcast_loop(link, clients)


def main() -> None:
    p = argparse.ArgumentParser(description="Bridge digital twin serial<->web")
    p.add_argument("--port", help="port serial Arduino, mis. COM5 atau /dev/ttyUSB0")
    p.add_argument("--simulate", action="store_true", help="jalankan tanpa hardware")
    args = p.parse_args()

    if args.simulate or not args.port:
        print("Mode SIMULASI (tanpa hardware).")
        link: ArmLink = SimLink()
    else:
        link = SerialLink(args.port)

    try:
        asyncio.run(main_async(link))
    except KeyboardInterrupt:
        print("\nBridge dihentikan.")


if __name__ == "__main__":
    main()
