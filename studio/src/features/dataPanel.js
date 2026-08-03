/* ============================================================================
   Engineering drawer: Geometri terukur (read-only), Sizing, Joint torque check.

   Bagian Offsets, Offset inspector, dan slider Cycloidal geometry sudah dihapus
   bersama twin parametrik: semuanya alat bantu MEMILIH geometri, sedangkan
   geometrinya kini terkunci di rakitan CAD dan dibaca dari sumbu terukur.
   Angka geometri sekarang cuma ditampilkan, tidak bisa digeser.
   ========================================================================== */
import { CYC, STATE, MOTORS } from '../config/arm.js';
import { section, slider, note } from '../ui/panel.js';
import { cssVar } from '../core/theme.js';
import { computeTorques, haveTorque, lastTorques, onUpdate } from '../model/kinematics.js';
import { world } from '../model/rig.js';
import { updateHud } from '../ui/hud.js';

const cards = [];
let payloadSlider = null;

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
  /* ---- geometri terukur (read-only) ---- */
  const geoBody = section(scroll, 'Geometri terukur (CAD)');
  const g = world.geo || {};
  const rows = [
    ['a1', 'offset bahu J1->J2', g.a1],
    ['a2', 'upper arm J2->J3', g.a2],
    ['d4', 'forearm J3->pusat wrist', g.d4],
    ['d6', 'pusat wrist->TCP', g.d6],
    ['-', 'offset lateral (sumbu pitch)', g.lateral],
    ['-', 'reach J2->TCP (lengan lurus)', g.reachFromJ2],
    ['-', 'tinggi TCP di pose home', g.homeHeight],
  ];
  const tbl = document.createElement('div'); tbl.className = 'mini';
  tbl.innerHTML = rows.map(([k, t, v]) =>
    `<div class="row" style="margin:2px 0"><label style="width:auto;flex:1;font-size:10.5px">`
    + `<b style="color:var(--accent)">${k}</b> ${t}</label>`
    + `<span class="val">${v == null ? '-' : v.toFixed(2)} mm</span></div>`).join('');
  geoBody.appendChild(tbl);
  note(geoBody, 'Diukur dari <code>onshape/Main Assembly (Complete).glb</code> rev 2026-08-03: '
    + 'sumbu J2/J3/J4 difit ke ring lubang roller, J1 ke kantong bola crown, J5/J6 ke boss keluaran servo '
    + '(sd fit 0,000 mm). Rinciannya di <code>docs/bom-main-assembly.md</code>; tabelnya dibangkitkan dari '
    + '<code>src/model/cadRig.js</code>, jadi tidak bisa digeser dari UI. TCP = titik tengah ujung wedge jaw '
    + 'saat tertutup.');

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

  // refresh cards/HUD tiap pose berubah
  onUpdate(() => { updateTorqueUI(); updateHud(); });
  updateTorqueUI();
}
