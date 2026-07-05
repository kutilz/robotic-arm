/* ============================================================================
   Bridge WebSocket — digital twin <-> lengan fisik / simulasi.
   Protokol (studio/README.md):
     masuk : {"type":"feedback","angles":[a1..a6]}   (dari encoder AS5600)
     keluar: {"cmd":"goto","angles":[a1..a6]}         (perintah target)
   ========================================================================== */
import { STATE } from '../config/arm.js';
import { applyPose } from '../model/kinematics.js';

let ws = null;
let url = 'ws://localhost:8765';
let wantOpen = false;      // user menghendaki koneksi tetap terbuka
let everOpened = false;    // pernah berhasil OPEN (baru boleh auto-reconnect)
let reconnectTimer = null;

function badge(state, label) {
  const el = document.getElementById('connBadge'); if (!el) return;
  el.className = 'badge ' + state;
  el.querySelector('.lbl').textContent = label;
}

function onMessage(ev) {
  let msg; try { msg = JSON.parse(ev.data); } catch { return; }
  if (msg.type === 'feedback' && Array.isArray(msg.angles)) {
    msg.angles.forEach((a, i) => { if (STATE.joints[i] != null && typeof a === 'number') STATE.joints[i].a = a; });
    applyPose();
  }
}

export function connect(u) {
  if (u) url = u;
  wantOpen = true;
  clearTimeout(reconnectTimer); reconnectTimer = null;
  try { ws = new WebSocket(url); } catch { badge('err', 'error'); return; }
  badge('off', 'connecting');
  ws.onopen = () => { everOpened = true; badge('on', 'live'); };
  ws.onerror = () => badge('err', 'error');
  ws.onclose = () => {
    ws = null;
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
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  badge('off', 'sim');
}
export function isConnected() { return ws && ws.readyState === WebSocket.OPEN; }
/** true bila user sedang menghendaki koneksi (connecting/open/reconnect). */
export function isActive() { return wantOpen; }

export function sendGoto(angles) {
  if (!isConnected()) return false;
  ws.send(JSON.stringify({ cmd: 'goto', angles: angles || STATE.joints.map(j => j.a) }));
  return true;
}
export function sendEstop() { if (isConnected()) ws.send(JSON.stringify({ cmd: 'estop' })); }

export function getUrl() { return url; }
