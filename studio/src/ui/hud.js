/* ============================================================================
   Status card kanan-atas (pose TCP besar + reach/beban/tightest/drift) dan
   legend card (popover dari icon strip).
   ========================================================================== */
import { STATE, MASSES } from '../config/arm.js';
import { world } from '../model/arm.js';
import { lastTorques, haveTorque, getTCP } from '../model/kinematics.js';
import { cssVar } from '../core/theme.js';

const LEGEND = [
  ['var(--axis-x)', 'axis X (pitch)'],
  ['var(--axis-y)', 'axis Y (yaw/roll)'],
  ['var(--axis-z)', 'axis Z'],
  ['#e08a3c', 'printed PLA+ (housing / disk / hub / link)'],
  ['#b9c2cb', 'steel hardware (pin · dowel · bearing · shaft)'],
  ['#2f6db0', 'MG996R servo (wrist J5 / J6, feedback pot internal)'],
  ['#1f7a4d', 'AS5600 feedback (output J1..J4)'],
  ['#1c2228', 'HTD3M belt (J1 base · J3 elbow)'],
];

export function initLegend() {
  const el = document.getElementById('legendCard');
  el.innerHTML = LEGEND.map(([c, t]) => `<div><span class="sw" style="background:${c}"></span>${t}</div>`).join('');
}

const CELLS = [
  ['X', 'ax', 'mm'], ['RX', 'rx', '°'],
  ['Y', 'ay', 'mm'], ['RY', 'ry', '°'],
  ['Z', 'az', 'mm'], ['RZ', 'rz', '°'],
];
let vals = null, foot = null;

export function initStatusCard() {
  const grid = document.getElementById('tcpGrid');
  grid.innerHTML = CELLS.map(([k, cls, u]) =>
    `<div class="cell"><span class="k ${cls}">${k}</span><b data-k="${k}">0.0</b><span class="u">${u}</span></div>`).join('');
  vals = {};
  grid.querySelectorAll('b').forEach(b => { vals[b.dataset.k] = b; });
  foot = document.getElementById('hudFoot');
}

export function updateHud() {
  if (!vals) return;
  const t = getTCP();
  vals.X.textContent = t.pos.x.toFixed(1); vals.Y.textContent = t.pos.y.toFixed(1); vals.Z.textContent = t.pos.z.toFixed(1);
  vals.RX.textContent = t.rx.toFixed(1); vals.RY.textContent = t.ry.toFixed(1); vals.RZ.textContent = t.rz.toFixed(1);

  const total = MASSES.reduce((s, m) => s + (m.label === 'payload' ? STATE.payload : m.m), 0);
  let worst = '—', wm = 0;
  STATE.joints.forEach((j, i) => { const h = haveTorque(j); const r = h > 0 ? (lastTorques[i] * STATE.sf) / h : 0; if (r > wm) { wm = r; worst = j.id; } });
  const wd = world.wristDrift;
  const dCol = wd > 2 ? cssVar('--over') : wd > 0.5 ? cssVar('--warn') : cssVar('--ok');
  const wCol = wm > 1 ? cssVar('--over') : wm > 0.8 ? cssVar('--warn') : cssVar('--ok');
  foot.innerHTML =
    `<span>reach <b>${t.reach.toFixed(0)}</b> mm</span>` +
    `<span>beban <b>${total.toFixed(2)}</b> kg</span>` +
    `<span>tightest <b style="color:${wCol}">${worst} ${(wm * 100).toFixed(0)}%</b></span>` +
    `<span>drift <b style="color:${dCol}">${wd.toFixed(1)} mm</b></span>`;
}
