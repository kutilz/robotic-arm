/* ============================================================================
   Scene panel (kiri-atas, collapsible): brand, mode pill (eng-only), view
   toggles, exploded view. Plus icon strip kiri-bawah: kamera, ortho, legend,
   toggle engineering.
   ========================================================================== */
import { STATE } from '../config/arm.js';
import { isOrtho } from '../core/viewport.js';
import { applyExplode } from '../model/kinematics.js';
import { setMode, refreshVisToggles, rebuildSweep } from './inspector.js';
import { setCadVisible } from '../model/cadModel.js';
import { slider, toggle } from '../ui/panel.js';
import { icon } from '../ui/icons.js';
import { buildViewButtons, setView, setProjection, registerProjIndicator } from './viewCube.js';

export function buildScenePanel(panel) {
  panel.innerHTML = `
    <div class="spHead">
      <span class="logo">◎</span>
      <div class="titles">
        <div class="t">Cycloidal Arm Studio</div>
        <div class="s">6-DOF · AS5600 J1-J4 + pot servo J5/J6 · digital twin</div>
      </div>
      <span class="icobtn chev">${icon('chevron')}</span>
    </div>
    <div class="spBody">
      <div id="modePill" class="seg" role="tablist" aria-label="Mode tampilan">
        <button data-mode="arm" class="on">Full arm</button>
        <button data-mode="offsets">Offsets</button>
        <button data-mode="drive">Drive</button>
      </div>
      <div class="cap">view</div>
      <div class="spToggles"></div>
      <div class="cap">orientasi kamera</div>
      <div class="vcHost"></div>
    </div>`;

  panel.querySelector('.spHead').onclick = () => panel.classList.toggle('open');
  panel.querySelectorAll('#modePill button').forEach(b => { b.onclick = () => setMode(b.dataset.mode); });

  buildViewButtons(panel.querySelector('.vcHost'));

  const body = panel.querySelector('.spToggles');
  const vt = (label, key) => toggle(body, label, () => STATE.show[key], v => { STATE.show[key] = v; refreshVisToggles(); });
  vt('Rotation axes + labels', 'axes');
  vt('Center-of-mass markers', 'masses');
  vt('Dimension tags', 'dims');
  vt('Skeleton centerline', 'skeleton');
  vt('X-ray solids', 'xray');
  vt('Wrist axes (concurrency)', 'wristAxes');
  toggle(body, 'Sweep ghost J3', () => STATE.show.sweep, v => { STATE.show.sweep = v; rebuildSweep(); refreshVisToggles(); });
  toggle(body, 'CAD model (Testing Assembly)', () => STATE.show.cad, v => { STATE.show.cad = v; setCadVisible(v); });
  slider(body, 'Exploded view', 0, 1, 0, 0.01, '', v => { STATE.explode = v; applyExplode(); });
}

// alias nama lama (shortcut keyboard i/f/s/t di main.js) -> view cube baru.
const PRESET_ALIAS = { iso: 'iso', front: 'front', side: 'right', top: 'top' };
export function setCamPreset(name) { setView(PRESET_ALIAS[name] || name); }

/** icon strip kiri-bawah. onEng(next) dipanggil saat wrench diklik. */
export function buildIconStrip(strip, onEng) {
  const mk = (html, title, onclick) => {
    const b = document.createElement('button'); b.className = 'icobtn'; b.title = title;
    b.innerHTML = html; b.onclick = onclick; strip.appendChild(b); return b;
  };
  const sep = () => { const s = document.createElement('span'); s.className = 'stripSep'; strip.appendChild(s); };

  mk('ISO', 'Kamera isometrik (I)', () => setCamPreset('iso'));
  mk('F', 'Kamera depan (F)', () => setCamPreset('front'));
  mk('S', 'Kamera samping (S)', () => setCamPreset('side'));
  mk('T', 'Kamera atas (T)', () => setCamPreset('top'));
  sep();
  const bOrtho = mk(icon('grid'), 'Orthographic (ala drawing CAD)', () => setProjection(!isOrtho()));
  registerProjIndicator(bOrtho, true);
  const bLegend = mk(icon('info'), 'Legend warna material', () => {
    const el = document.getElementById('legendCard');
    el.classList.toggle('open'); bLegend.classList.toggle('on', el.classList.contains('open'));
  });
  sep();
  const bEng = mk(icon('wrench'), 'Engineering mode (E) — sizing, torsi, offsets, geometri', () => onEng());
  return { engBtn: bEng, legendBtn: bLegend };
}
