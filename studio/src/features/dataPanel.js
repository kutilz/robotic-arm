/* ============================================================================
   Engineering drawer: Offsets, Offset inspector, Sizing, Joint torque check,
   Cycloidal geometry. (Pose/Presets/View pindah ke control card & scene panel.)
   ========================================================================== */
import {
  CYC, OFFS, OFFS_RESEARCH, OFFS_SEARAH, OFFS_LAMA, STATE, MOTORS,
  plaCeiling, recalcCyc,
} from '../config/arm.js';
import { section, slider, buttonRow, button, note } from '../ui/panel.js';
import { cssVar } from '../core/theme.js';
import { computeTorques, haveTorque, lastTorques, onUpdate } from '../model/kinematics.js';
import {
  setMode, focusJoint, clearFocus, rebuildArmOnly, rebuildGeo, onFocusChange,
} from './inspector.js';
import { updateHud } from '../ui/hud.js';

const cards = [];
let payloadSlider = null, offRefs = {}, focusBtns = [];

function hexA(hex, a) { const h = hex.replace('#', ''); const r = parseInt(h.substr(0, 2), 16), g = parseInt(h.substr(2, 2), 16), b = parseInt(h.substr(4, 2), 16); return `rgba(${r},${g},${b},${a})`; }

/** set payload (kg) + sinkron slider drawer + hitung ulang torsi (dipakai preset pose). */
export function setPayload(kg) {
  STATE.payload = kg;
  if (payloadSlider) {
    payloadSlider.value = kg * 1000;
    payloadSlider.parentElement.querySelector('.val').textContent = (kg * 1000).toFixed(0) + ' g';
  }
  computeTorques(); updateTorqueUI(); updateHud();
}

export function updateTorqueUI() {
  const ps = document.getElementById('plaShow'); if (ps) ps.textContent = STATE.plaCeil.toFixed(0);
  STATE.joints.forEach((j, i) => {
    const need = (lastTorques[i] || 0) * STATE.sf;
    const have = haveTorque(j);
    const c = cards[i]; if (!c) return;
    const ratio = have > 0 ? need / have : 99;
    let col = cssVar('--ok'), txt = 'OK';
    if (ratio > 1) { col = cssVar('--over'); txt = 'OVER'; }
    else if (ratio > 0.8) { col = cssVar('--warn'); txt = 'TIGHT'; }
    if ((j.drive === 'cyc' || j.drive === 'cyc-belt') && need > STATE.plaCeil) { if (ratio <= 1) { col = cssVar('--warn'); txt = 'PLA?'; } }
    c.style.borderLeftColor = col;
    const st = c.querySelector('.st'); st.textContent = txt; st.style.background = hexA(col, .16); st.style.color = col;
    c.querySelector('.need').textContent = need.toFixed(2);
    c.querySelector('.have').textContent = have.toFixed(2);
    const bar = c.querySelector('.meter i'); bar.style.width = Math.min(100, ratio * 100).toFixed(0) + '%'; bar.style.background = col;
  });
}

export function buildDataPanel(scroll) {
  /* ---- offsets ---- */
  const offBody = section(scroll, 'Offsets · packaging (CAD)');
  offRefs = {};
  const offSlider = (label, key, min, max) => { offRefs[key] = slider(offBody, label, min, max, OFFS[key], 1, ' mm', v => { OFFS[key] = v; rebuildArmOnly(); }); };
  offSlider('Kolom J1->J2', 'colH', 40, 200);
  offSlider('Shoulder lateral', 'shoulder', -70, 70);
  offSlider('Elbow lateral (J3)', 'elbow', -70, 70);
  offSlider('Forearm inset (J4)', 'fore', -30, 30);
  offSlider('J5 off-axis !', 'w5', -20, 20);
  offSlider('J6 off-axis !', 'w6', -20, 20);
  const offBtns = buttonRow(offBody);
  const offPreset = (name, vals) => button(offBtns, name, () => {
    Object.assign(OFFS, vals);
    for (const k in offRefs) { offRefs[k].value = OFFS[k]; offRefs[k].parentElement.querySelector('.val').textContent = OFFS[k].toFixed(0) + ' mm'; }
    rebuildArmOnly();
  });
  offPreset('Research 35/-50', OFFS_RESEARCH);
  offPreset('Searah 35/+50', OFFS_SEARAH);
  offPreset('Lama 30/-26', OFFS_LAMA);
  note(offBody, 'Aturan emas research §5: offset besar hanya di J1-J3; wrist w5/w6 <b>wajib 0</b> (slider ! cuma demo pecahnya closed-form IK, lihat readout <b>drift</b> di status card). Offset lateral tidak mengubah torsi pitch.');

  /* ---- offset inspector ---- */
  const inspBody = section(scroll, 'Offset inspector (per joint)');
  const jbRow = buttonRow(inspBody);
  focusBtns = [];
  ['J1', 'J2', 'J3', 'J4', 'J5', 'J6'].forEach((n, i) => {
    const b = button(jbRow, n, () => { if (STATE.mode !== 'offsets') setMode('offsets'); focusJoint(i); });
    focusBtns.push(b);
  });
  button(jbRow, '✕ lepas', () => clearFocus());
  onFocusChange((fi) => focusBtns.forEach((b, i) => { b.style.borderColor = (i === fi) ? cssVar('--accent') : ''; b.style.color = (i === fi) ? cssVar('--accent') : ''; }));
  note(inspBody, 'Fokus per joint: part lain jadi ghost, muncul envelope packaging (wireframe) + rincian offset. Tombol otomatis pindah ke mode Offsets.');

  /* ---- sizing ---- */
  const sizeBody = section(scroll, 'Sizing · payload & margins');
  payloadSlider = slider(sizeBody, 'Payload', 0, 1000, STATE.payload * 1000, 10, ' g', v => { STATE.payload = v / 1000; computeTorques(); updateTorqueUI(); updateHud(); });
  slider(sizeBody, 'Drive efficiency η', 0.5, 0.95, STATE.eta, 0.01, '', v => { STATE.eta = v; updateTorqueUI(); updateHud(); });
  slider(sizeBody, 'Safety factor', 1, 3.5, STATE.sf, 0.1, '×', v => { STATE.sf = v; updateTorqueUI(); updateHud(); });
  note(sizeBody, 'Stepper budget = ratio × (0.5·holding) × η. Servo budget ≈ 0.45·stall. Required = live gravity torque × SF. PLA+ cycloidal ceiling (est.) ≈ <b id=plaShow></b> N·m at Ø' + (CYC.pinCircleR * 2) + ' pin circle.');

  /* ---- torque cards ---- */
  const torqueBody = section(scroll, 'Joint torque check');
  const cardWrap = document.createElement('div'); torqueBody.appendChild(cardWrap);
  cards.length = 0;
  STATE.joints.forEach((j) => {
    const c = document.createElement('div'); c.className = 'jcard';
    const driveTxt = { belt: 'belt 2-stage', cyc: 'cyc direct', 'cyc-belt': 'belt + cyc', servo: 'servo direct' }[j.drive] || j.drive;
    const ratioRow = j.drive === 'servo'
      ? `<div class="row" style="margin:4px 0"><label style="width:auto;font-size:10px;color:var(--dim)">${j.motor} direct -> pot internal + ADC1 · stall ${MOTORS[j.motor].toFixed(2)} N·m</label></div>`
      : `<div class="row" style="margin:4px 0"><label style="width:64px;font-size:10.5px">ratio 1:</label><input type=range min=8 max=80 value=${j.ratio} step=1 style="flex:1"><span class="val rr"></span></div>`;
    c.innerHTML = `<div class="top"><div class="nm">${j.id} <span>${j.name} · ${driveTxt}</span></div><div class="st"></div></div>
      <div class="row" style="margin:6px 0 2px"><select class="mtr"></select></div>
      ${ratioRow}
      <div class="meter"><i></i></div>
      <div class="nums"><span>need <b class="need"></b></span><span>have <b class="have"></b> N·m</span></div>`;
    const sel = c.querySelector('.mtr');
    for (const mn of Object.keys(MOTORS)) { const o = document.createElement('option'); o.value = mn; o.textContent = mn + '  (' + MOTORS[mn].toFixed(2) + ')'; if (mn === j.motor) o.selected = true; sel.appendChild(o); }
    sel.onchange = () => { j.motor = sel.value; updateTorqueUI(); updateHud(); };
    const rr = c.querySelector('input[type=range]'), rv = c.querySelector('.rr');
    if (rr) { rr.oninput = () => { j.ratio = +rr.value; rv.textContent = rr.value; updateTorqueUI(); updateHud(); }; rv.textContent = j.ratio; }
    cardWrap.appendChild(c); cards.push(c);
  });

  /* ---- geometry ---- */
  const geoBody = section(scroll, 'Cycloidal geometry (J2-class drive)', false);
  slider(geoBody, 'Ring pins N', 6, 60, CYC.N, 1, '', v => { CYC.N = v; recalcCyc(); rebuildGeo(); });
  slider(geoBody, 'Pin circle R', 18, 80, CYC.pinCircleR, 1, ' mm', v => { CYC.pinCircleR = v; recalcCyc(); STATE.plaCeil = plaCeiling(); rebuildGeo(); updateTorqueUI(); });
  slider(geoBody, 'Eccentricity e', 0.4, 3, CYC.ecc, 0.1, ' mm', v => { CYC.ecc = v; rebuildGeo(); });
  slider(geoBody, 'Disk thickness', 4, 14, CYC.diskT, 1, ' mm', v => { CYC.diskT = v; recalcCyc(); rebuildGeo(); });
  note(geoBody, 'N=25 -> 25:1, lobes=24, dual disk 180°, output 6×Ø5 dowels, ecc-bearing 6700. J2 pin-circle upsized ~30mm untuk angkat ceiling PLA+ (13 -> ~17 N·m); J3/J4 tetap ~22mm.');

  // refresh cards/HUD tiap pose berubah
  onUpdate(() => { updateTorqueUI(); updateHud(); });
  updateTorqueUI();
}
