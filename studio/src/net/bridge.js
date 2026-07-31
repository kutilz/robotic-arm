/* ============================================================================
   Bridge WebSocket: digital twin <-> lengan fisik / simulasi.
   Protokol (firmware/README.md):
     masuk : {"type":"feedback","angles":[a1..a6],"estop":b,"fault":[f1..f4]}
             {"type":"ack","cmd":"...","ok":b,"msg":"..."}
             {"type":"cal", ...}  {"type":"diag", ...}    (dipakai tab CAL)
     keluar: {"cmd":"goto","angles":[a1..a6]}   {"cmd":"estop"}   {"cmd":"resume"}
             {"cmd":"cal_get"|"cal_set..."|"cal_zero"|"cal_save"|"cal_reset"}
             {"cmd":"diag"}   {"cmd":"load_tare"}   {"cmd":"load_scale","grams":g}

   Guardrail target vs actual: feedback ~50 Hz dari hardware TIDAK boleh
   menindas pose yang sedang disusun user. Aturannya lewat STATE.poseDirty:
   - edit lokal apa pun (jog, slider, preset, IK, timeline, drag TCP) men-set
     poseDirty -> model menampilkan TARGET, feedback ditahan (badge 'target');
   - Send goto mengirim target lalu melepas poseDirty -> model kembali
     mengikuti feedback hardware (badge 'live').
   E-STOP juga di-assert ulang tiap koneksi (ter)buka supaya tidak hilang
   saat ditekan di tengah reconnect.
   ========================================================================== */
import { STATE } from '../config/arm.js';
import { applyPose } from '../model/kinematics.js';

let ws = null;
let url = 'ws://localhost:8765';
let wantOpen = false;      // user menghendaki koneksi tetap terbuka
let everOpened = false;    // pernah berhasil OPEN (baru boleh auto-reconnect)
let reconnectTimer = null;

// Watchdog liveness: hardware harusnya kirim feedback ~50 Hz. Socket "open"
// tapi >2 dtk sunyi = TCP zombie -> paksa close supaya auto-reconnect jalan
// (dan e-stop di-assert ulang di onopen). Pasangan heartbeat ping/pong di
// firmware yang memutus klien mati dari sisi sana.
let lastMsgAt = 0;
let liveTimer = null;
function liveCheck() {
  if (ws && ws.readyState === WebSocket.OPEN && Date.now() - lastMsgAt > 2000) {
    badge('err', 'stale');
    ws.close();   // onclose -> jadwal reconnect
  }
}

/* status hardware terakhir (dari feedback/ack) + subscriber UI */
let hwEstop = false;
let hwFault = [0, 0, 0, 0];
let actual = null;         // sudut aktual terakhir dari hardware (derajat)
const hwListeners = new Set();
/** subscribe event hardware: {type:'estop',on} | {type:'fault',fault[4]} |
 *  {type:'ack',cmd,ok,msg} | {type:'cal',cal} | {type:'diag',diag} */
export function onHwStatus(fn) { hwListeners.add(fn); return () => hwListeners.delete(fn); }
function emitHw(ev) { for (const fn of hwListeners) fn(ev); }
/** sudut aktual terakhir dari hardware (null bila belum ada feedback). */
export function getActual() { return actual; }

let lastLbl = '';
function badge(state, label) {
  const el = document.getElementById('connBadge'); if (!el) return;
  el.className = 'badge ' + state;
  el.querySelector('.lbl').textContent = label;
  lastLbl = label;
}

function onMessage(ev) {
  let msg; try { msg = JSON.parse(ev.data); } catch { return; }
  lastMsgAt = Date.now();   // pesan apa pun = bukti link hidup (watchdog)

  if (msg.type === 'feedback') {
    if (Array.isArray(msg.angles)) {
      actual = msg.angles.slice(0, 6).map(a => (Number.isFinite(a) ? a : null));
      if (!STATE.poseDirty) {
        // model mengikuti hardware; hanya angka finite yang diterima
        actual.forEach((a, i) => { if (STATE.joints[i] != null && a != null) STATE.joints[i].a = a; });
        applyPose(true);   // true = dari feedback, jangan set poseDirty
      }
      const lbl = STATE.poseDirty ? 'target' : 'live';
      if (lbl !== lastLbl) badge('on', lbl);
    }
    if (typeof msg.estop === 'boolean' && msg.estop !== hwEstop) {
      hwEstop = msg.estop;
      emitHw({ type: 'estop', on: hwEstop });
    }
    if (Array.isArray(msg.fault)) {
      const f = msg.fault.slice(0, 4).map(x => (x ? 1 : 0));
      if (f.join() !== hwFault.join()) { hwFault = f; emitHw({ type: 'fault', fault: f }); }
    }
  } else if (msg.type === 'ack') {
    emitHw({ type: 'ack', cmd: String(msg.cmd ?? '?'), ok: !!msg.ok, msg: String(msg.msg ?? '') });
  } else if (msg.type === 'cal') {
    emitHw({ type: 'cal', cal: msg });
  } else if (msg.type === 'diag') {
    emitHw({ type: 'diag', diag: msg });
  }
}

export function connect(u) {
  if (u) url = u;
  wantOpen = true;
  clearTimeout(reconnectTimer); reconnectTimer = null;
  try { ws = new WebSocket(url); } catch { badge('err', 'error'); return; }
  badge('off', 'connecting');
  ws.onopen = () => {
    everOpened = true;
    STATE.poseDirty = false;         // koneksi (kembali) terbuka: ikuti hardware
    badge('on', 'live');
    lastMsgAt = Date.now();          // grace period watchdog mulai dari open
    clearInterval(liveTimer);
    liveTimer = setInterval(liveCheck, 1000);
    // guardrail: E-STOP yang ditekan saat putus/reconnect di-assert ulang
    if (STATE.estop) ws.send(JSON.stringify({ cmd: 'estop' }));
  };
  ws.onerror = () => badge('err', 'error');
  ws.onclose = () => {
    ws = null;
    clearInterval(liveTimer); liveTimer = null;
    // auto-reconnect hanya kalau user masih mau DAN koneksi pernah sukses
    // (mencegah retry tak berujung saat bridge belum dijalankan).
    if (wantOpen && everOpened) { badge('off', 'reconnect'); reconnectTimer = setTimeout(connect, 2000); }
    else if (wantOpen) { wantOpen = false; badge('err', 'gagal'); }
    else badge('off', 'sim');
  };
  ws.onmessage = onMessage;
}
export function disconnect() {
  wantOpen = false;
  clearTimeout(reconnectTimer); reconnectTimer = null;
  clearInterval(liveTimer); liveTimer = null;
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  badge('off', 'sim');
}
export function isConnected() { return ws && ws.readyState === WebSocket.OPEN; }
/** true bila user sedang menghendaki koneksi (connecting/open/reconnect). */
export function isActive() { return wantOpen; }

export function sendGoto(angles) {
  if (!isConnected()) return false;
  ws.send(JSON.stringify({ cmd: 'goto', angles: angles || STATE.joints.map(j => j.a) }));
  STATE.poseDirty = false;   // target terkirim: model kembali mengikuti feedback
  return true;
}
export function sendEstop() { if (isConnected()) ws.send(JSON.stringify({ cmd: 'estop' })); }
export function sendResume() { if (isConnected()) ws.send(JSON.stringify({ cmd: 'resume' })); }

/* ---- kalibrasi & diagnostik (tab CAL). Firmware = executor primitif; semua
   sequencing/perhitungan ada di features/calPanel.js. Balasan datang sebagai
   event onHwStatus {type:'cal'|'diag'|'ack'}. ---- */
function sendCmd(obj) {
  if (!isConnected()) return false;
  ws.send(JSON.stringify(obj));
  return true;
}
export function sendCalGet()       { return sendCmd({ cmd: 'cal_get' }); }
export function sendCalSet(fields) { return sendCmd({ cmd: 'cal_set', ...fields }); }
export function sendCalZero(joint) { return sendCmd(joint ? { cmd: 'cal_zero', joint } : { cmd: 'cal_zero' }); }
export function sendCalSave()      { return sendCmd({ cmd: 'cal_save' }); }
export function sendCalReset()     { return sendCmd({ cmd: 'cal_reset' }); }
export function sendDiag()         { return sendCmd({ cmd: 'diag' }); }
export function sendLoadTare()     { return sendCmd({ cmd: 'load_tare' }); }
export function sendLoadScale(g)   { return sendCmd({ cmd: 'load_scale', grams: g }); }

export function getUrl() { return url; }
