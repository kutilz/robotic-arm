/* ============================================================================
   Control card (kanan-bawah) — tab JOINT | CARTESIAN | MOTION | SETUP +
   footer (home, send goto, E-STOP). Menggantikan left dock lama.
   ========================================================================== */
import { STATE, POSE_PRESETS } from '../config/arm.js';
import { applyPose } from '../model/kinematics.js';
import { icon } from '../ui/icons.js';
import {
  buildJointRows, buildCartPad, buildStepSeg, initJogSync, goHome,
} from './jog.js';
import { setTcpDrag, setTcpMode, getTcpEnabled } from './tcpDrag.js';
import { DEMOS } from './demos.js';
import { setShow, getShow } from './pathPreview.js';
import { addKey, clearKeys } from './timeline.js';
import { connect, disconnect, isActive, sendGoto, getUrl, onHwStatus } from '../net/bridge.js';
import { setPayload } from './dataPanel.js';
import { buildCalPanel } from './calPanel.js';

const TABS = [
  ['joint', 'JOINT'],
  ['cart', 'CART'],
  ['motion', 'MOTION'],
  ['cal', 'CAL'],
  ['setup', 'SETUP'],
];

let dragTgl = null;

function tgl(parent, label, get, set) {
  const t = document.createElement('div'); t.className = 'tgl' + (get() ? ' on' : '');
  t.innerHTML = `<span>${label}</span><span class="dot"></span>`;
  t.onclick = () => { set(!get()); t.classList.toggle('on', get()); };
  parent.appendChild(t); return t;
}

export function buildControlCard(card) {
  /* ---- tabs ---- */
  const tabRow = document.createElement('div'); tabRow.className = 'tabs';
  const bodies = {};
  TABS.forEach(([key, label], i) => {
    const b = document.createElement('button'); b.className = 'tab' + (i === 0 ? ' on' : ''); b.textContent = label;
    b.onclick = () => {
      tabRow.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x === b));
      for (const k in bodies) bodies[k].classList.toggle('on', k === key);
    };
    tabRow.appendChild(b);
    const body = document.createElement('div'); body.className = 'tabBody' + (i === 0 ? ' on' : '');
    bodies[key] = body;
  });
  card.appendChild(tabRow);
  for (const k in bodies) card.appendChild(bodies[k]);

  /* ---- JOINT ---- */
  buildJointRows(bodies.joint);
  buildStepSeg(bodies.joint, 'joint', 'jointHint');
  const chips = document.createElement('div'); chips.className = 'chips';
  POSE_PRESETS.forEach(p => {
    const c = document.createElement('button'); c.className = 'chip'; c.textContent = p.name; c.title = p.full;
    c.onclick = () => {
      if (STATE.estop) return;
      STATE.joints.forEach((j, i) => { j.a = p.angles[i]; });
      if (p.payload != null) setPayload(p.payload);
      applyPose();
    };
    chips.appendChild(c);
  });
  bodies.joint.appendChild(chips);

  /* ---- CARTESIAN ---- */
  buildCartPad(bodies.cart);
  buildStepSeg(bodies.cart, 'cart', 'cartHint');
  dragTgl = tgl(bodies.cart, 'Drag TCP dengan mouse (gizmo)', () => getTcpEnabled(), v => setTcpDrag(v));
  const modeSeg = document.createElement('div'); modeSeg.className = 'segsm';
  ['translate', 'rotate'].forEach((m, i) => {
    const b = document.createElement('button'); b.textContent = m === 'translate' ? 'geser' : 'putar'; b.className = i === 0 ? 'on' : '';
    b.onclick = () => { setTcpMode(m); modeSeg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); };
    modeSeg.appendChild(b);
  });
  bodies.cart.appendChild(modeSeg);

  /* ---- MOTION ---- */
  const demoWrap = document.createElement('div'); demoWrap.className = 'btns';
  Object.entries(DEMOS).forEach(([name, fn]) => {
    const b = document.createElement('button'); b.innerHTML = icon('play', 11) + ' ' + name;
    b.style.display = 'flex'; b.style.alignItems = 'center'; b.style.gap = '6px';
    b.onclick = () => { if (STATE.estop) return; fn(); };
    demoWrap.appendChild(b);
  });
  bodies.motion.appendChild(demoWrap);
  const mCap = document.createElement('div'); mCap.className = 'segRow';
  mCap.innerHTML = '<span class="cap">preview</span>';
  bodies.motion.appendChild(mCap);
  tgl(bodies.motion, 'Path TCP (dari timeline)', () => getShow('path'), v => setShow('path', v));
  tgl(bodies.motion, 'Reachability envelope', () => getShow('reach'), v => setShow('reach', v));
  const kfRow = document.createElement('div'); kfRow.className = 'btns'; kfRow.style.marginTop = '4px';
  const bAdd = document.createElement('button'); bAdd.innerHTML = icon('plus', 11) + ' keyframe';
  bAdd.style.display = 'flex'; bAdd.style.alignItems = 'center'; bAdd.style.gap = '6px';
  bAdd.onclick = () => addKey();
  const bClr = document.createElement('button'); bClr.innerHTML = icon('trash', 11) + ' clear';
  bClr.style.display = 'flex'; bClr.style.alignItems = 'center'; bClr.style.gap = '6px';
  bClr.onclick = () => clearKeys();
  kfRow.append(bAdd, bClr);
  bodies.motion.appendChild(kfRow);

  /* ---- CAL (komisioning gaya PLC; logika penuh di calPanel.js) ---- */
  buildCalPanel(bodies.cal);

  /* ---- SETUP (bridge) ---- */
  const urlInp = document.createElement('input'); urlInp.type = 'text'; urlInp.id = 'wsUrl'; urlInp.value = getUrl();
  bodies.setup.appendChild(urlInp);
  const btns = document.createElement('div'); btns.className = 'btns'; btns.style.marginTop = '9px';
  const bConn = document.createElement('button');
  const connLabel = () => { bConn.innerHTML = icon('plug', 11) + ' ' + (isActive() ? 'Disconnect' : 'Connect'); };
  bConn.style.display = 'flex'; bConn.style.alignItems = 'center'; bConn.style.gap = '6px';
  bConn.onclick = () => {
    if (isActive()) disconnect();
    else connect(urlInp.value.trim());
    connLabel();
  };
  connLabel();
  const bGoto = document.createElement('button'); bGoto.innerHTML = icon('send', 11) + ' Send goto';
  bGoto.style.display = 'flex'; bGoto.style.alignItems = 'center'; bGoto.style.gap = '6px';
  bGoto.onclick = () => { if (!sendGoto()) alert('Belum terhubung ke bridge.'); };
  btns.append(bConn, bGoto);
  bodies.setup.appendChild(btns);
  const hint = document.createElement('div'); hint.className = 'mini'; hint.style.marginTop = '10px';
  hint.innerHTML = 'Jalankan <code>python -m arm.bridge --simulate</code> lalu Connect, atau langsung ke ESP32 '
    + '<code>ws://armbot.local:81</code>. Saat <b>live</b> feedback encoder menggerakkan model; begitu pose '
    + 'diubah lokal badge jadi <b>target</b> (feedback ditahan) sampai Send goto mengirim target sendi sekarang.';
  bodies.setup.appendChild(hint);

  // status hardware: fault encoder (persisten) + ack command terakhir
  const stFault = document.createElement('div'); stFault.className = 'mini'; stFault.id = 'bridgeFault';
  stFault.style.marginTop = '8px'; stFault.style.color = 'var(--over)';
  const stAck = document.createElement('div'); stAck.className = 'mini'; stAck.id = 'bridgeAck';
  stAck.style.marginTop = '4px';
  bodies.setup.append(stFault, stAck);
  onHwStatus(ev => {
    if (ev.type === 'fault') {
      const bad = ev.fault.map((f, i) => (f ? 'J' + (i + 1) : null)).filter(Boolean);
      stFault.textContent = bad.length
        ? '⚠ encoder fault: ' + bad.join(', ') + ' (fallback open-loop)' : '';
    } else if (ev.type === 'ack') {
      stAck.textContent = 'ack ' + ev.cmd + ': ' + ev.msg;
      stAck.style.color = ev.ok ? '' : 'var(--over)';
    }
  });

  /* ---- footer ---- */
  const foot = document.createElement('div'); foot.className = 'ccFoot';
  const bHome = document.createElement('button'); bHome.className = 'icobtn'; bHome.title = 'Pose home (semua sendi 0)';
  bHome.innerHTML = icon('home'); bHome.onclick = () => goHome();
  const bSend = document.createElement('button'); bSend.className = 'icobtn'; bSend.title = 'Kirim pose sekarang ke lengan (goto)';
  bSend.innerHTML = icon('send'); bSend.onclick = () => { if (!sendGoto()) alert('Belum terhubung ke bridge.'); };
  const grow = document.createElement('div'); grow.className = 'grow';
  const estop = document.createElement('button'); estop.id = 'estop'; estop.className = 'estop';
  estop.title = 'Emergency stop — hentikan semua gerak'; estop.textContent = 'E-STOP';
  foot.append(bHome, bSend, grow, estop);
  card.appendChild(foot);

  initJogSync();
}

/** toggle gizmo drag TCP (shortcut G) — sinkron dengan toggle di tab CARTESIAN. */
export function toggleGizmo() {
  const on = !getTcpEnabled();
  setTcpDrag(on);
  if (dragTgl) dragTgl.classList.toggle('on', on);
}

/** sinkron UI toggle gizmo dengan state (mis. setelah E-STOP mematikan drag). */
export function syncGizmoUI() {
  if (dragTgl) dragTgl.classList.toggle('on', getTcpEnabled());
}
