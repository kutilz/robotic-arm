"""Bridge Digital Twin: serial (Arduino) <-> WebSocket (interface web).

Aliran data dua arah:
  * Encoder feedback  : firmware kirim "FB,j1,j2,j3,j4,j5,j6\n" -> broadcast ke web
  * Perintah target   : web kirim {"cmd":"goto","angles":[..6..]} -> "GO,..\n" ke firmware

Protokol serial (baris teks, baud 115200):
  ke firmware  : "GO,a1,a2,a3,a4,a5,a6\n"  (sudut target derajat)
  dari firmware: "FB,a1,a2,a3,a4,a5,a6\n"  (sudut aktual dari encoder AS5600)

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
    """Simulasi lengan: sendi bergerak menuju target dgn laju terbatas."""

    def __init__(self) -> None:
        self.actual = [0.0] * NUM_JOINTS
        self.target = [0.0] * NUM_JOINTS
        self.max_step = 2.0  # derajat per tick (model laju gerak)

    def read_feedback(self) -> list[float]:
        for i in range(NUM_JOINTS):
            err = self.target[i] - self.actual[i]
            self.actual[i] += max(-self.max_step, min(self.max_step, err))
        return list(self.actual)

    def send_target(self, angles: list[float]) -> None:
        self.target = list(angles)


async def broadcast_loop(link: ArmLink, clients: set) -> None:
    """Baca feedback berkala, broadcast ke semua klien web."""
    while True:
        fb = link.read_feedback()
        if fb is not None and clients:
            msg = json.dumps({"type": "feedback", "angles": [round(a, 2) for a in fb]})
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
