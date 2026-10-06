"""Blok JALUR di simulator (cermin firmware): lease, pemegang kendali, whitelist cloud.

Simulator ini yang dipakai menguji studio dan relay ujung ke ujung tanpa
lengan, jadi aturannya harus sama dengan firmware. Kalau tes ini dan firmware
berbeda pendapat, uji ujung ke ujungnya membuktikan hal yang salah.
"""

from __future__ import annotations

from arm.bridge import CLOUD_LEASE_DEFAULT_MS, CTRL_IDLE_MS, SimLink


class Clock:
    def __init__(self) -> None:
        self.t = 10_000.0

    def __call__(self) -> float:
        return self.t


def sim() -> tuple[SimLink, Clock]:
    c = Clock()
    return SimLink(clock=c), c


def goto(s: SimLink, a0: float, jalur: str = "local", lease: int | None = None):
    m = {"cmd": "goto", "angles": [a0, 0, 0, 0, 0, 0]}
    if lease is not None:
        m["lease"] = lease
    return s.handle_cmd(m, jalur)


def test_lease_habis_merem_dan_membekukan_target():
    s, c = sim()
    s.cal["speed"] = 10.0
    goto(s, 90, lease=1000)
    for _ in range(25):            # 0,5 dtk gerak
        c.t += 20
        s.tick()
    assert 0 < s.actual[0] < 90
    c.t += 600                     # lewat lease 1000 ms tanpa perpanjangan
    s.tick()
    assert s.hold is True
    assert s.target[0] == s.actual[0], "target dibekukan di posisi sekarang"
    pos = s.actual[0]
    for _ in range(50):
        c.t += 20
        s.tick()
    assert s.actual[0] == pos, "tidak ada gerak sesudah hold"
    assert s.feedback_payload()["hold"] is True


def test_ping_berlease_dari_pemegang_memperpanjang():
    s, c = sim()
    goto(s, 45, lease=1000)
    for _ in range(10):
        c.t += 500
        s.handle_cmd({"cmd": "ping", "seq": 1, "t": 0, "lease": 1000}, "local")
        s.tick()
    assert s.hold is False


def test_ping_tanpa_lease_tidak_memperpanjang():
    s, c = sim()
    goto(s, 45, lease=1000)
    c.t += 600
    s.handle_cmd({"cmd": "ping", "seq": 1, "t": 0}, "local")
    c.t += 600
    s.tick()
    assert s.hold is True


def test_goto_berikutnya_melepas_hold():
    s, c = sim()
    goto(s, 45, lease=500)
    c.t += 600
    s.tick()
    assert s.hold
    goto(s, 10, lease=500)
    assert not s.hold and s.target[0] == 10


def test_pengirim_lama_tanpa_lease_tetap_perilaku_lama():
    s, c = sim()
    goto(s, 45)                    # halaman bawaan ESP32: tanpa lease
    c.t += 60_000
    s.tick()
    assert s.hold is False and s.target[0] == 45


def test_cloud_tanpa_lease_diberi_lease_bawaan():
    s, c = sim()
    goto(s, 45, jalur="cloud")
    c.t += CLOUD_LEASE_DEFAULT_MS + 1
    s.tick()
    assert s.hold is True


def test_lokal_merebut_cloud_tapi_tidak_sebaliknya():
    s, c = sim()
    assert goto(s, 10, jalur="cloud", lease=2000) is None
    assert goto(s, 20, jalur="local", lease=2000) is None, "lokal selalu boleh merebut"
    assert s.owner() == "local"
    r = goto(s, 30, jalur="cloud", lease=2000)
    assert r and r["ok"] is False and "lokal" in r["msg"]
    assert s.target[0] == 20
    c.t += 2001                    # lease lokal habis
    s.tick()
    assert goto(s, 30, jalur="cloud", lease=2000) is None


def test_lokal_tanpa_lease_menahan_cloud_selama_idle():
    s, c = sim()
    goto(s, 10, jalur="local")
    assert goto(s, 30, jalur="cloud")["ok"] is False
    c.t += CTRL_IDLE_MS + 1
    assert goto(s, 30, jalur="cloud") is None


def test_estop_dari_cloud_selalu_diterima():
    s, _ = sim()
    goto(s, 10, jalur="local", lease=5000)
    r = s.handle_cmd({"cmd": "estop"}, "cloud")
    assert r["ok"] and s.estop


def test_whitelist_cloud():
    s, _ = sim()
    for cmd in ("cal_save", "cal_reset", "cal_zero", "servo_capture", "nada", "load_tare"):
        r = s.handle_cmd({"cmd": cmd}, "cloud")
        assert r["ok"] is False and "lokal" in r["msg"], cmd
    r = s.handle_cmd({"cmd": "cal_set", "kp": 9}, "cloud")
    assert r["ok"] is False, "cal_set dari cloud hanya speed/accel"
    r = s.handle_cmd({"cmd": "cal_set", "speed": 999, "accel": 999}, "cloud")
    assert r["ok"] and s.cal["speed"] == 25.0 and s.cal["accel"] == 90.0
    assert s.handle_cmd({"cmd": "servo_us", "servo": 0, "us": 1500}, "cloud")["ok"] is False
    assert s.handle_cmd({"cmd": "servo_us", "servo": 2, "us": 1500}, "cloud")["ok"] is True


def test_relay_putus_atau_lease_drop_merem_pemegang_cloud():
    for akhir in ("putus", "drop"):
        s, c = sim()
        goto(s, 90, jalur="cloud", lease=5000)
        c.t += 100
        s.tick()
        if akhir == "putus":
            s.link_down()
        else:
            s.handle_cmd({"cmd": "lease_drop"}, "cloud")
        assert s.hold and s.owner() == "none"


def test_lease_drop_tidak_menyentuh_pemegang_lokal():
    s, _ = sim()
    goto(s, 90, jalur="local", lease=5000)
    s.handle_cmd({"cmd": "lease_drop"}, "cloud")
    assert not s.hold and s.owner() == "local"


def test_pong_menggemakan_seq_dan_t():
    s, _ = sim()
    assert s.handle_cmd({"cmd": "ping", "seq": 42, "t": 123.4}, "cloud") == {
        "type": "pong", "seq": 42, "t": 123.4}


def test_link_cfg_hanya_dari_cloud():
    s, _ = sim()
    s.handle_cmd({"cmd": "link_cfg", "fb_hz": 10}, "local")
    assert s.cloud_fb_ms == 0
    s.handle_cmd({"cmd": "link_cfg", "fb_hz": 10}, "cloud")
    assert s.cloud_fb_ms == 100
    s.handle_cmd({"cmd": "link_cfg", "fb_hz": 999}, "cloud")
    assert s.cloud_fb_ms == 40
