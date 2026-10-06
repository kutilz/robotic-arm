/* ============================================================================
   Tab DATA: sudut sendi + status live.

   Yang ditampilkan sengaja dua kolom, bukan satu: TARGET (pose yang sedang
   digambar twin) dan AKTUAL (yang dilaporkan firmware). Satu kolom "sudut"
   akan menyembunyikan justru keadaan yang paling perlu terlihat, yaitu saat
   keduanya berbeda karena lengan belum sampai, tersangkut, atau kehilangan
   langkah.

   Kolom AKTUAL tidak sama kualitasnya untuk semua sendi, dan itu ditandai di
   layar, bukan disamarkan:
     J1, J2  AS5600 absolut          -> hasil ukur poros
     J3, J4  tanpa encoder           -> isi step counter, yaitu pulsa yang SUDAH
                                        dikeluarkan firmware. Langkah yang
                                        hilang tidak mengubahnya sedikit pun.
     J5, J6  pot servo               -> belum terkalibrasi (mV 1000/2000 masih
                                        angka bawaan), jadi ditandai `*` dan
                                        tidak dipercaya sampai cal membuktikan.
   ========================================================================== */
import { STATE } from '../config/arm.js';
import { getTCP } from '../model/kinematics.js';
import {
  getActual, isFbTrusted, isDriverOk, getDriverResets, getUrl, isConnected,
  onHwStatus, getGripActual, getNet,
} from '../net/bridge.js';
import { displayUrl } from '../net/linkConfig.js';
import { el, sec, note, fmt } from './ui.js';

/* Baris kualitas link. Hasil ukur ping/pong ke ESP32, bukan perkiraan. */
function netRows() {
  const n = getNet();
  if (!isConnected()) return [];
  const ms = (v) => (Number.isFinite(v) ? `${Math.round(v)} ms` : '--');
  const buruk = n.level === 'buruk' || n.level === 'putus';
  return [
    ['jalur', n.mode === 'cloud' ? 'CLOUD (relay)' : 'LOKAL', ''],
    ['link', n.label, buruk ? 'warn' : ''],
    ['RTT p50 / p95', `${ms(n.p50)} / ${ms(n.p95)}`, buruk ? 'warn' : ''],
    ['jitter', ms(n.jitter), ''],
    ['kendali', n.own, n.hold ? 'warn' : ''],
  ];
}

let els = {};
let lastAck = '';
let fault = [0, 0, 0, 0];

const SUMBER = ['AS5600', 'AS5600', 'step ctr', 'step ctr', 'pot servo', 'pot servo'];

export function refresh() {
  if (!els.jointBody) return;
  const act = getActual();

  els.jointBody.innerHTML = '';
  STATE.joints.forEach((j, i) => {
    const a = act ? act[i] : null;
    const trusted = isFbTrusted(i);
    const tr = el('tr');
    const d = Number.isFinite(a) ? Math.abs(a - j.a) : null;
    tr.innerHTML = `<td>J${i + 1}<span style="color:var(--dim)"> ${SUMBER[i]}</span></td>`
      + `<td class="hi">${fmt(j.a)}</td>`
      + `<td class="${trusted ? '' : 'warn'}">${act ? fmt(a) : '--'}${trusted ? '' : '*'}</td>`
      + `<td class="${d != null && d > 2 ? 'warn' : ''}">${d != null ? fmt(d) : '--'}</td>`;
    els.jointBody.appendChild(tr);
  });

  const t = getTCP();
  els.tcp.innerHTML = `<tr><td>TCP mm</td><td class="hi">${fmt(t.pos.x, 0)}</td>`
    + `<td class="hi">${fmt(t.pos.y, 0)}</td><td class="hi">${fmt(t.pos.z, 0)}</td></tr>`;

  const grip = getGripActual();
  els.stat.innerHTML = [
    ['koneksi', isConnected() ? 'tersambung' : 'putus', isConnected() ? '' : 'warn'],
    ['alamat', displayUrl(getUrl()), ''],
    ...netRows(),
    ['driver TMC', isDriverOk() ? 'terverifikasi' : 'BELUM SIAP', isDriverOk() ? '' : 'warn'],
    ['reset driver', String(getDriverResets()), getDriverResets() ? 'warn' : ''],
    ['fault encoder', fault.some(Boolean) ? fault.map((f, i) => (f ? `J${i + 1}` : '')).filter(Boolean).join(' ') : 'tidak ada',
      fault.some(Boolean) ? 'warn' : ''],
    ['gripper', Number.isFinite(grip) ? fmt(grip) + '°' : '--', ''],
    ['E-STOP', STATE.estop ? 'AKTIF' : 'lepas', STATE.estop ? 'warn' : ''],
    ['ack terakhir', lastAck || '--', ''],
  ].map(([k, v, c]) => `<tr><td>${k}</td><td class="${c || 'hi'}" colspan="3">${v}</td></tr>`).join('');
}

export function buildData(body) {
  els = {};

  const b1 = sec(body, 'sudut sendi');
  const t1 = el('table', 'mTbl');
  t1.innerHTML = '<thead><tr><th>sendi</th><th>target</th><th>aktual</th><th>selisih</th></tr></thead>';
  els.jointBody = el('tbody');
  t1.appendChild(els.jointBody);
  b1.appendChild(t1);
  note(b1, '* = umpan balik belum bisa dipercaya (pot servo J5/J6 masih memakai '
    + 'batas mV bawaan 1000/2000, bukan hasil ukur). J3/J4 tanpa encoder: '
    + 'angka aktualnya isi step counter, jadi langkah yang hilang tidak muncul di sini.', 'warn');

  const b2 = sec(body, 'ujung (TCP)');
  const t2 = el('table', 'mTbl');
  t2.innerHTML = '<thead><tr><th></th><th>X</th><th>Y</th><th>Z</th></tr></thead>';
  els.tcp = el('tbody');
  t2.appendChild(els.tcp);
  b2.appendChild(t2);

  const b3 = sec(body, 'status');
  const t3 = el('table', 'mTbl');
  els.stat = el('tbody');
  t3.appendChild(els.stat);
  b3.appendChild(t3);

  onHwStatus((ev) => {
    if (ev.type === 'ack') lastAck = `${ev.cmd} ${ev.ok ? 'ok' : 'GAGAL'}: ${ev.msg}`;
    else if (ev.type === 'fault') fault = ev.fault;
  });

  refresh();
}
