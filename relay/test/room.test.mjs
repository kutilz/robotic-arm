// Uji aturan relay tanpa Cloudflare: `npm test` (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RoomCore, roleFor, originAllowed, sameSecret, GOTO_MIN_GAP_MS, DEFAULT_LEASE_MS,
} from '../src/room.js';

function sock() {
  const s = { out: [], closed: null };
  s.send = (t) => s.out.push(t);
  s.close = (c, r) => { s.closed = [c, r]; };
  s.json = () => s.out.map((t) => JSON.parse(t));
  s.clear = () => { s.out.length = 0; };
  return s;
}

function room() {
  let t = 1000;
  const timers = [];
  const core = new RoomCore({
    now: () => t,
    setTimer: (fn, ms) => timers.push({ at: t + ms, fn }),
  });
  const clock = {
    advance(ms) {
      t += ms;
      for (const x of timers.splice(0)) {
        if (x.at <= t) x.fn(); else timers.push(x);
      }
    },
  };
  return { core, clock };
}

test('balasan ber-_c hanya ke browser penanya, feedback ke semua', () => {
  const { core } = room();
  const dev = sock(); core.addDevice(dev);
  const a = sock(), b = sock();
  const ida = core.addUi(a, 'operator');
  const idb = core.addUi(b, 'operator');
  a.clear(); b.clear(); dev.clear();

  core.fromUi(ida, JSON.stringify({ cmd: 'ping', seq: 7, t: 1.5 }));
  const fwd = dev.json()[0];
  assert.equal(fwd._c, ida);
  assert.equal(fwd.cmd, 'ping');

  core.fromDevice(`{"_c":${ida},"type":"pong","seq":7,"t":1.5}`);
  assert.deepEqual(a.json(), [{ type: 'pong', seq: 7, t: 1.5 }]);
  assert.equal(b.out.length, 0, 'pong tidak boleh bocor ke browser lain');

  core.fromDevice('{"type":"feedback","angles":[0,0,0,0,0,0]}');
  assert.equal(a.out.length, 2);
  assert.equal(b.out.length, 1);
  assert.ok(idb);
});

test('satu operator: browser kedua ditolak selama lease pertama hidup', () => {
  const { core, clock } = room();
  const dev = sock(); core.addDevice(dev);
  const a = sock(), b = sock();
  const ida = core.addUi(a, 'operator');
  const idb = core.addUi(b, 'operator');
  dev.clear(); b.clear();

  core.fromUi(ida, JSON.stringify({ cmd: 'goto', angles: [1, 0, 0, 0, 0, 0], lease: 1000 }));
  assert.equal(dev.out.length, 1);

  clock.advance(100);
  b.clear();
  core.fromUi(idb, JSON.stringify({ cmd: 'goto', angles: [9, 0, 0, 0, 0, 0], lease: 1000 }));
  assert.equal(dev.out.length, 1, 'goto browser kedua tidak boleh sampai');
  const ack = b.json().find((m) => m.type === 'ack');
  assert.equal(ack.ok, false);

  // ping berlease dari pemegang memperpanjang kendali
  clock.advance(800);
  core.fromUi(ida, JSON.stringify({ cmd: 'ping', seq: 1, t: 0, lease: 1000 }));
  clock.advance(800);
  core.fromUi(idb, JSON.stringify({ cmd: 'goto', angles: [9, 0, 0, 0, 0, 0], lease: 1000 }));
  assert.equal(dev.json().filter((m) => m.cmd === 'goto').length, 1, 'masih dipegang a');

  // a berhenti memperpanjang: sesudah lease lewat, b boleh
  clock.advance(1100);
  core.fromUi(idb, JSON.stringify({ cmd: 'goto', angles: [9, 0, 0, 0, 0, 0], lease: 1000 }));
  assert.equal(dev.json().filter((m) => m.cmd === 'goto').length, 2);
});

test('e-stop dari browser mana pun selalu lewat, juga dari penonton', () => {
  const { core } = room();
  const dev = sock(); core.addDevice(dev);
  const a = sock(), v = sock();
  const ida = core.addUi(a, 'operator');
  const idv = core.addUi(v, 'viewer');
  core.fromUi(ida, JSON.stringify({ cmd: 'goto', angles: [1, 0, 0, 0, 0, 0] }));
  dev.clear();
  core.fromUi(idv, JSON.stringify({ cmd: 'estop' }));
  assert.equal(dev.json()[0].cmd, 'estop');
});

test('penonton tidak boleh menggerakkan atau mengubah kalibrasi', () => {
  const { core } = room();
  const dev = sock(); core.addDevice(dev);
  const v = sock(); const idv = core.addUi(v, 'viewer');
  dev.clear(); v.clear();
  for (const cmd of ['goto', 'gripper', 'resume', 'cal_set', 'cal_save']) {
    core.fromUi(idv, JSON.stringify({ cmd, angles: [0, 0, 0, 0, 0, 0] }));
  }
  assert.equal(dev.out.length, 0);
  assert.equal(v.json().filter((m) => m.type === 'ack' && !m.ok).length, 5);
});

test('operator menutup koneksi -> lease_drop langsung ke ESP32', () => {
  const { core } = room();
  const dev = sock(); core.addDevice(dev);
  const a = sock(); const ida = core.addUi(a, 'operator');
  core.fromUi(ida, JSON.stringify({ cmd: 'goto', angles: [1, 0, 0, 0, 0, 0] }));
  dev.clear();
  core.removeUi(ida);
  const cmds = dev.json().map((m) => m.cmd);
  assert.ok(cmds.includes('lease_drop'));
  assert.ok(cmds.includes('link_cfg'), 'tanpa penonton feedback dimatikan');
  assert.equal(dev.json().find((m) => m.cmd === 'link_cfg').fb_hz, 0);
});

test('penonton yang bukan pemegang pergi -> TIDAK ada lease_drop', () => {
  const { core } = room();
  const dev = sock(); core.addDevice(dev);
  const a = sock(), b = sock();
  const ida = core.addUi(a, 'operator');
  const idb = core.addUi(b, 'operator');
  core.fromUi(ida, JSON.stringify({ cmd: 'goto', angles: [1, 0, 0, 0, 0, 0] }));
  dev.clear();
  core.removeUi(idb);
  assert.ok(!dev.json().some((m) => m.cmd === 'lease_drop'));
});

test('goto rapat digabung: yang terbaru menang, e-stop tidak ditahan', () => {
  const { core, clock } = room();
  const dev = sock(); core.addDevice(dev);
  const a = sock(); const ida = core.addUi(a, 'operator');
  dev.clear();
  for (let k = 1; k <= 5; k++) {
    core.fromUi(ida, JSON.stringify({ cmd: 'goto', angles: [k, 0, 0, 0, 0, 0] }));
    clock.advance(5);
  }
  core.fromUi(ida, JSON.stringify({ cmd: 'estop' }));
  let sent = dev.json();
  assert.deepEqual(sent.map((m) => m.cmd), ['goto', 'estop'], 'goto pertama lewat, sisanya ditahan; estop langsung');
  clock.advance(GOTO_MIN_GAP_MS);
  sent = dev.json();
  const gotos = sent.filter((m) => m.cmd === 'goto');
  assert.equal(gotos.length, 2);
  assert.equal(gotos[1].angles[0], 5, 'yang diteruskan adalah goto TERAKHIR');
});

test('tanpa lengan: ping dijawab status relay, goto ditolak', () => {
  const { core } = room();
  const a = sock(); const ida = core.addUi(a, 'operator');
  a.clear();
  core.fromUi(ida, JSON.stringify({ cmd: 'ping', seq: 1, t: 0 }));
  core.fromUi(ida, JSON.stringify({ cmd: 'goto', angles: [0, 0, 0, 0, 0, 0] }));
  const m = a.json();
  assert.equal(m[0].type, 'relay');
  assert.equal(m[0].device, false);
  assert.equal(m[1].ok, false);
});

test('laju feedback = permintaan tertinggi, perangkat baru langsung diberi tahu', () => {
  const { core } = room();
  const a = sock(), b = sock();
  const ida = core.addUi(a, 'operator');
  const idb = core.addUi(b, 'viewer');
  core.fromUi(ida, JSON.stringify({ cmd: 'link_cfg', fb_hz: 5 }));
  core.fromUi(idb, JSON.stringify({ cmd: 'link_cfg', fb_hz: 20 }));
  const dev = sock(); core.addDevice(dev);
  assert.equal(dev.json()[0].fb_hz, 20);
  dev.clear();
  core.removeUi(idb);
  assert.equal(dev.json()[0].fb_hz, 5);
});

test('perangkat kedua menggantikan yang pertama', () => {
  const { core } = room();
  const d1 = sock(), d2 = sock();
  core.addDevice(d1);
  core.addDevice(d2);
  assert.ok(d1.closed);
  core.removeDevice(d1);           // close handler socket lama tidak boleh melepas yang baru
  assert.equal(core.device, d2);
});

test('perintah internal relay tidak bisa dipalsukan browser', () => {
  const { core } = room();
  const dev = sock(); core.addDevice(dev);
  const a = sock(); const ida = core.addUi(a, 'operator');
  dev.clear();
  core.fromUi(ida, JSON.stringify({ cmd: 'lease_drop' }));
  assert.equal(dev.out.length, 0);
});

test('lease bawaan dipakai kalau browser tidak menyertakan lease', () => {
  const { core, clock } = room();
  const dev = sock(); core.addDevice(dev);
  const a = sock(), b = sock();
  const ida = core.addUi(a, 'operator');
  const idb = core.addUi(b, 'operator');
  core.fromUi(ida, JSON.stringify({ cmd: 'goto', angles: [0, 0, 0, 0, 0, 0] }));
  clock.advance(DEFAULT_LEASE_MS + 1);
  dev.clear();
  core.fromUi(idb, JSON.stringify({ cmd: 'goto', angles: [0, 0, 0, 0, 0, 0] }));
  assert.equal(dev.json().filter((m) => m.cmd === 'goto').length, 1);
});

test('autentikasi', () => {
  const env = { OP_TOKEN: 'op', VIEW_TOKEN: 'lihat' };
  assert.equal(roleFor('op', env), 'operator');
  assert.equal(roleFor('lihat', env), 'viewer');
  assert.equal(roleFor('', env), null);
  assert.equal(roleFor('opx', env), null);
  assert.equal(roleFor('lihat', { OP_TOKEN: 'op' }), null);
  assert.equal(sameSecret('', ''), false, 'rahasia kosong tidak pernah cocok');
  assert.equal(originAllowed('https://x.vercel.app', ''), true);
  assert.equal(originAllowed('https://x.vercel.app', 'https://y.app'), false);
  assert.equal(originAllowed('https://x.vercel.app', '*.vercel.app'), true);
  assert.equal(originAllowed('http://x.vercel.app', '*.vercel.app'), false);
});

test('kendali yang lepas karena lease habis dikabarkan lewat ping berikutnya', () => {
  const { core, clock } = room();
  const dev = sock(); core.addDevice(dev);
  const a = sock(), b = sock();
  const ida = core.addUi(a, 'operator');
  const idb = core.addUi(b, 'operator');
  core.fromUi(ida, JSON.stringify({ cmd: 'goto', angles: [0, 0, 0, 0, 0, 0], lease: 1000 }));
  assert.equal(b.json().filter((m) => m.type === 'relay').pop().ctrl, 'other');
  b.clear();
  clock.advance(1500);
  core.fromUi(idb, JSON.stringify({ cmd: 'ping', seq: 1, t: 0 }));
  const st = b.json().find((m) => m.type === 'relay');
  assert.ok(st, 'status dikirim ulang');
  assert.equal(st.ctrl, 'none');
  b.clear();
  core.fromUi(idb, JSON.stringify({ cmd: 'ping', seq: 2, t: 0 }));
  assert.ok(!b.json().some((m) => m.type === 'relay'), 'tidak diulang kalau tidak berubah');
});
