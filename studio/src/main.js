/* ============================================================================
   Cycloidal Arm Studio: bootstrap.
   Layout ala Waldo Commander: scene full-viewport + panel floating.
   Model digital twin + jog/IK, timeline, demo, bridge WS, engineering drawer.
   ========================================================================== */
import './styles/theme.css';
import { mount, startLoop } from './core/viewport.js';
import { STATE } from './config/arm.js';
import { buildArm } from './model/arm.js';
import { applyPose, applyExplode } from './model/kinematics.js';
import { buildInspect, setMode, refreshVisToggles } from './features/inspector.js';
import { buildDataPanel } from './features/dataPanel.js';
import { initLegend, initStatusCard, updateHud } from './ui/hud.js';
import { refreshJogEnabled, goHome } from './features/jog.js';
import { buildControlCard, toggleGizmo, syncGizmoUI } from './features/controlCard.js';
import { buildScenePanel, buildIconStrip, setCamPreset } from './features/scenePanel.js';
import { buildGizmo } from './features/viewCube.js';
import { initPathPreview } from './features/pathPreview.js';
import { buildTimeline, stopPlayback, togglePlay } from './features/timeline.js';
import { initTcpDrag } from './features/tcpDrag.js';
import { sendEstop, sendResume, onHwStatus } from './net/bridge.js';
import { DEMOS } from './features/demos.js';
import { icon } from './ui/icons.js';

const stage = document.getElementById('stage');
mount(stage);

// model
buildArm();
buildInspect();
initPathPreview();
initTcpDrag();

// panel-panel floating
buildScenePanel(document.getElementById('scenePanel'));
buildGizmo(stage);   // triad orientasi kamera (pojok kiri-bawah)
initStatusCard();
initLegend();
buildControlCard(document.getElementById('controlCard'));
buildTimeline(document.getElementById('timelineBar'));

// engineering drawer (mount-once; visibility via class .eng di <html>)
buildDataPanel(document.getElementById('engScroll'));

let engBtnRef = null;
function setEngineering(on) {
  STATE.engineering = on;
  document.documentElement.classList.toggle('eng', on);
  if (engBtnRef) engBtnRef.classList.toggle('on', on);
  // jangan tinggalkan user di mode offsets/drive saat pill-nya disembunyikan
  if (!on && STATE.mode !== 'arm') setMode('arm');
}
const strip = buildIconStrip(document.getElementById('iconStrip'), () => setEngineering(!STATE.engineering));
engBtnRef = strip.engBtn;
const engClose = document.getElementById('engClose');
engClose.innerHTML = icon('close');
engClose.onclick = () => setEngineering(false);

// E-STOP. fromHw=true saat status datang DARI hardware (field estop di
// feedback, mis. klien lain menekan e-stop) -> sinkron UI tanpa kirim balik.
const estopBtn = document.getElementById('estop');
function setEstop(on, fromHw = false) {
  STATE.estop = on;
  estopBtn.classList.toggle('tripped', on);
  estopBtn.textContent = on ? 'RESET' : 'E-STOP';
  if (on) stopPlayback();
  if (!fromHw) {
    if (on) sendEstop();
    else sendResume();   // RESET melepas e-stop di hardware secara eksplisit
  }
  refreshJogEnabled();
  syncGizmoUI();
}
estopBtn.onclick = () => setEstop(!STATE.estop);
onHwStatus(ev => {
  if (ev.type === 'estop' && ev.on !== STATE.estop) setEstop(ev.on, true);
});

// keyboard shortcuts (demo sidang): tidak aktif saat fokus di input.
// E-STOP sengaja tanpa shortcut, terlalu riskan kepencet.
const demoFns = Object.values(DEMOS);
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest && e.target.closest('input, select, textarea')) return;
  const k = e.key.toLowerCase();
  if (k === ' ') { e.preventDefault(); togglePlay(); }
  else if (k === 'h') goHome();
  else if (k >= '1' && k <= '4') { if (!STATE.estop) demoFns[+k - 1]?.(); }
  else if (k === 'i') setCamPreset('iso');
  else if (k === 'f') setCamPreset('front');
  else if (k === 's') setCamPreset('side');
  else if (k === 't') setCamPreset('top');
  else if (k === 'e') setEngineering(!STATE.engineering);
  else if (k === 'g') toggleGizmo();
  else if (k === 'escape') {
    if (STATE.engineering) setEngineering(false);
    else document.getElementById('legendCard').classList.remove('open');
  }
});

// pose awal
refreshVisToggles();
applyPose();
applyExplode();
updateHud();
startLoop();
