/* ============================================================================
   Jog: logika kontrol Waldo Commander, dipakai oleh controlCard.
   - buildJointRows : 6 baris [−][slider+nilai][+] (merangkap pose slider).
   - buildCartPad   : pad X/Y/Z + RX/RY/RZ (IK numerik).
   - Hormati E-STOP (semua jog nonaktif saat tripped).
   ========================================================================== */
import { THREE } from '../core/viewport.js';
import { STATE } from '../config/arm.js';
import { applyPose, jogCartesian, onUpdate } from '../model/kinematics.js';

const STEPS = {
  joint: [1, 5, 15],       // deg
  trans: [1, 5, 20],       // mm
  rot: [1, 5, 15],         // deg
};
let stepIdx = 1;
let jointWrap = null, cartWrap = null;
const jrowRefs = [];       // { slider, val } per joint

export function stepLabel(mode) {
  if (mode === 'joint') return STEPS.joint[stepIdx] + '°';
  return STEPS.trans[stepIdx] + 'mm / ' + STEPS.rot[stepIdx] + '°';
}

function doJointJog(i, dir) {
  if (STATE.estop) return;
  const j = STATE.joints[i];
  j.a = Math.max(j.min, Math.min(j.max, j.a + dir * STEPS.joint[stepIdx]));
  applyPose();
}
function doCartJog(axis, dir) {
  if (STATE.estop) return;
  const s = dir;
  const dPos = new THREE.Vector3(), dRot = { x: 0, y: 0, z: 0 };
  if (axis === 'X') dPos.x = s * STEPS.trans[stepIdx];
  else if (axis === 'Y') dPos.y = s * STEPS.trans[stepIdx];
  else if (axis === 'Z') dPos.z = s * STEPS.trans[stepIdx];
  else if (axis === 'RX') dRot.x = s * STEPS.rot[stepIdx];
  else if (axis === 'RY') dRot.y = s * STEPS.rot[stepIdx];
  else if (axis === 'RZ') dRot.z = s * STEPS.rot[stepIdx];
  const ok = jogCartesian(dPos, dRot);
  if (!ok) flashUnreachable();
}

let flashT = null;
function flashUnreachable() {
  const el = document.getElementById('cartHint'); if (!el) return;
  el.dataset.warn = '1'; el.textContent = 'target di luar jangkauan';
  clearTimeout(flashT);
  flashT = setTimeout(() => { el.dataset.warn = ''; el.textContent = 'step ' + stepLabel('cart'); }, 1200);
}

/* tombol tekan-tahan (auto-repeat ala Waldo jogging), juga dipakai mode SERVICE. */
export function holdBtn(btn, fn) {
  let t = null, rpt = null;
  const start = (e) => { e.preventDefault(); if (STATE.estop) return; fn(); t = setTimeout(() => { rpt = setInterval(fn, 90); }, 320); };
  const stop = () => { clearTimeout(t); clearInterval(rpt); };
  btn.addEventListener('pointerdown', start);
  btn.addEventListener('pointerup', stop);
  btn.addEventListener('pointerleave', stop);
  btn.addEventListener('pointercancel', stop);
}

/** segmen step fine/med/coarse; hintId opsional untuk update label step. */
export function buildStepSeg(parent, mode, hintId) {
  const wrap = document.createElement('div'); wrap.className = 'segRow';
  const cap = document.createElement('span'); cap.className = 'cap'; cap.textContent = 'step';
  const seg = document.createElement('div'); seg.className = 'segsm';
  ['fine', 'med', 'coarse'].forEach((s, i) => {
    const b = document.createElement('button'); b.textContent = s; b.className = (i === stepIdx) ? 'on' : '';
    b.onclick = () => {
      stepIdx = i;
      // sinkron semua segmen step (JOINT & CARTESIAN berbagi stepIdx)
      document.querySelectorAll('.segsm[data-step]').forEach(sg =>
        sg.querySelectorAll('button').forEach((x, k) => x.classList.toggle('on', k === i)));
      const h = hintId && document.getElementById(hintId);
      if (h && !h.dataset.warn) h.textContent = 'step ' + stepLabel(mode);
      const ch = document.getElementById('cartHint');
      if (ch && !ch.dataset.warn) ch.textContent = 'step ' + stepLabel('cart');
      const jh = document.getElementById('jointHint');
      if (jh) jh.textContent = 'step ' + stepLabel('joint');
    };
    seg.appendChild(b);
  });
  seg.dataset.step = '1';
  const hint = document.createElement('span'); hint.className = 'ccHint'; hint.id = hintId;
  hint.textContent = 'step ' + stepLabel(mode);
  wrap.append(cap, seg, hint);
  parent.appendChild(wrap);
  return wrap;
}

/** 6 baris joint: [−] [label + slider + nilai] [+]. Merangkap pose slider. */
export function buildJointRows(parent) {
  jointWrap = document.createElement('div');
  jrowRefs.length = 0;
  STATE.joints.forEach((j, i) => {
    const row = document.createElement('div'); row.className = 'jrow';
    const minus = document.createElement('button'); minus.className = 'jbtn'; minus.textContent = '−';
    const plus = document.createElement('button'); plus.className = 'jbtn'; plus.textContent = '+';
    const mid = document.createElement('div'); mid.className = 'jmid';
    mid.innerHTML = `<div class="jlab"><span><b>${j.id}</b> ${j.name}</span><span class="jv">${j.a.toFixed(0)}°</span></div>`;
    const s = document.createElement('input'); s.type = 'range'; s.min = j.min; s.max = j.max; s.step = 1; s.value = j.a;
    s.oninput = () => { if (STATE.estop) { s.value = j.a; return; } j.a = +s.value; applyPose(); };
    mid.appendChild(s);
    holdBtn(minus, () => doJointJog(i, -1));
    holdBtn(plus, () => doJointJog(i, +1));
    row.append(minus, mid, plus);
    jointWrap.appendChild(row);
    jrowRefs.push({ slider: s, val: mid.querySelector('.jv'), j });
  });
  parent.appendChild(jointWrap);
  refreshDisabled();
}

/** pad cartesian X/Y/Z + RX/RY/RZ (pakai IK). */
export function buildCartPad(parent) {
  cartWrap = document.createElement('div');
  const mkBtn = (label, cls) => {
    const b = document.createElement('button'); b.className = 'jogBtn ' + (cls || ''); b.textContent = label; return b;
  };
  const mkPair = (axis, cls) => {
    const wrap = document.createElement('div'); wrap.style.display = 'contents';
    const neg = mkBtn(axis + '−', cls);
    const lbl = document.createElement('div'); lbl.className = 'jogBtn lbl'; lbl.textContent = axis;
    const pos = mkBtn(axis + '+', cls);
    holdBtn(neg, () => doCartJog(axis, -1)); holdBtn(pos, () => doCartJog(axis, +1));
    wrap.append(neg, lbl, pos); return wrap;
  };
  const t = document.createElement('div'); t.className = 'cartGrid';
  t.append(mkPair('X', 'axX'), mkPair('Y', 'axY'), mkPair('Z', 'axZ'));
  const r = document.createElement('div'); r.className = 'cartGrid';
  r.append(mkPair('RX', 'axX'), mkPair('RY', 'axY'), mkPair('RZ', 'axZ'));
  cartWrap.append(t, r);
  parent.appendChild(cartWrap);
  refreshDisabled();
}

function refreshDisabled() {
  const dis = STATE.estop;
  if (jointWrap) jointWrap.querySelectorAll('button').forEach(b => { b.disabled = dis; });
  if (cartWrap) cartWrap.querySelectorAll('button.jogBtn:not(.lbl)').forEach(b => { b.disabled = dis; });
}

/** sinkron slider/nilai joint dari STATE (jog, timeline, bridge, drag TCP). */
function syncRows() {
  for (const r of jrowRefs) {
    if (+r.slider.value !== r.j.a) r.slider.value = r.j.a;
    r.val.textContent = r.j.a.toFixed(0) + '°';
  }
}

/** dipanggil sekali dari controlCard setelah kedua pad dibangun. */
export function initJogSync() { onUpdate(syncRows); syncRows(); }

/** dipanggil saat E-STOP berubah untuk enable/disable jog. */
export function refreshJogEnabled() { refreshDisabled(); }

/** pose home (semua sendi 0). */
export function goHome() {
  if (STATE.estop) return;
  STATE.joints.forEach(j => { j.a = 0; });
  applyPose();
}
