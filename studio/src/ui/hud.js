/* ============================================================================
   Status card kanan-atas (pose TCP besar + reach/beban/tightest/drift) dan
   legend card (popover dari icon strip).
   ========================================================================== */
import { STATE, MASSES } from '../config/arm.js';
import { THREE } from '../core/viewport.js';
import { world } from '../model/rig.js';
import { lastTorques, haveTorque, getTCP, tightestLimit } from '../model/kinematics.js';
import { cssVar } from '../core/theme.js';

// Warna part datang dari appearance Onshape di GLB, jadi legend ini menjelaskan
// warna OVERLAY (yang memang dipilih studio), bukan warna mesh CAD.
const LEGEND = [
  ['var(--axis-x)', 'sumbu pitch J2 / J3 / J5 (X)'],
  ['var(--axis-y)', 'sumbu yaw/roll J1 / J4 / J6 (Y)'],
  ['#39c2e0', 'skeleton link (upper arm · forearm · tool)'],
  ['#f5a53c', 'offset a1 bahu (65,9 mm, tegak lurus sumbu J2)'],
  ['#8fa3b8', 'kolom base J1 -> J2 (72,8 mm)'],
  ['#f06c5e', 'marker titik berat (lumped mass)'],
  ['#7fe0f0', 'label dimensi & reach'],
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
const j2Pos = new THREE.Vector3();

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
  let worst = '-', wm = 0;
  STATE.joints.forEach((j, i) => { const h = haveTorque(j); const r = h > 0 ? (lastTorques[i] * STATE.sf) / h : 0; if (r > wm) { wm = r; worst = j.id; } });
  const wCol = wm > 1 ? cssVar('--over') : wm > 0.8 ? cssVar('--warn') : cssVar('--ok');

  // Pemakaian jangkauan: jarak TCP dari sumbu J2 dibanding lengan lurus penuh.
  // 100% itu SAH, bukan error: di pose home lengan memang lurus tegak sehingga
  // TCP persis di batas envelope. Jadi merah hanya kalau target melewati batas
  // (IK pasti tidak konvergen), kuning saat mepet.
  const maxReach = (world.geo && world.geo.reachFromJ2) || 1;
  const used = world.jointRefs[1]
    ? t.pos.distanceTo(world.jointRefs[1].pivot.getWorldPosition(j2Pos)) / maxReach : 0;
  const uCol = used > 1.001 ? cssVar('--over') : used > 0.97 ? cssVar('--warn') : cssVar('--ok');

  const lim = tightestLimit();
  const lCol = lim.frac > 0.98 ? cssVar('--over') : lim.frac > 0.9 ? cssVar('--warn') : cssVar('--ok');

  foot.innerHTML =
    `<span>reach <b>${t.reach.toFixed(0)}</b> mm</span>` +
    `<span>envelope <b style="color:${uCol}">${(used * 100).toFixed(0)}%</b></span>` +
    `<span>beban <b>${total.toFixed(2)}</b> kg</span>` +
    `<span>torsi <b style="color:${wCol}">${worst} ${(wm * 100).toFixed(0)}%</b></span>` +
    `<span>limit <b style="color:${lCol}">${lim.id} ${(lim.frac * 100).toFixed(0)}%</b></span>`;
}
