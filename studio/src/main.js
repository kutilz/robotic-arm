/* ============================================================================
   Cycloidal Arm Studio: bootstrap.
   Layout ala Waldo Commander: scene full-viewport + panel floating.
   Model digital twin + jog/IK, timeline, demo, bridge WS, engineering drawer.
   ========================================================================== */
import './styles/theme.css';
import { mount, startLoop, scene } from './core/viewport.js';
import { STATE } from './config/arm.js';
import { buildRig, applyExplode, world } from './model/rig.js';
import { loadCadModel, onCadStatus } from './model/cadModel.js';
import { applyPose } from './model/kinematics.js';
import { refreshVisToggles } from './features/viewToggles.js';
import { buildDataPanel } from './features/dataPanel.js';
import { initLegend, initStatusCard, updateHud } from './ui/hud.js';
import { refreshJogEnabled, goHome } from './features/jog.js';
import { buildControlCard, toggleGizmo, syncGizmoUI } from './features/controlCard.js';
import { loadTwinCal } from './features/twinCal.js';
import { selamatkanDariPortLain } from './features/storageRescue.js';
import { runnerEstop } from './features/runner.js';
import { buildScenePanel, buildIconStrip, setCamPreset } from './features/scenePanel.js';
import { buildGizmo } from './features/viewCube.js';
import { initPathPreview } from './features/pathPreview.js';
import { buildTimeline, stopPlayback, togglePlay } from './features/timeline.js';
import { initTcpDrag } from './features/tcpDrag.js';
import { initActualMarker } from './features/actualMarker.js';
import { sendEstop, sendResume, onHwStatus } from './net/bridge.js';
import { DEMOS } from './features/demos.js';
import { icon } from './ui/icons.js';

const stage = document.getElementById('stage');
mount(stage);

/* Hasil kerja yang tertinggal di port localhost lain ditarik ke sini dulu.
   Sengaja TIDAK ditunggu (tanpa top-level await): aplikasi boot seperti biasa,
   dan kalau ternyata ada yang ditemukan halaman dimuat ulang sekali supaya
   timeline dan runner membacanya dari awal. Rinciannya di storageRescue.js. */
selamatkanDariPortLain().then(({ n, dari }) => {
  if (!n) return;
  console.log(`[armstudio] ${n} kunci penyimpanan ditarik dari ${dari.join(', ')}; memuat ulang.`);
  location.reload();
});

// Kalibrasi twin dibaca SEBELUM rantai dibangun: arah sendi dan trim home ikut
// dihitung di buildChain(), jadi memuatnya sesudah itu berarti frame pertama
// digambar dengan kalibrasi lama.
loadTwinCal();

// model: rantai sendi + overlay dibangun dari sumbu terukur, jadi studio sudah
// bisa dipakai penuh sebelum (atau tanpa) mesh CAD. Mesh-nya dimuat duluan
// karena CAD adalah tampilan default.
buildRig();
initPathPreview();
initTcpDrag();
initActualMarker();
loadCadModel();

/* Kait inspeksi untuk perkakas uji (tools/), BUKAN API untuk kode aplikasi.
   Alasannya konkret: verify_cad_rig.mjs membuktikan rantainya benar di Node,
   tapi ia tidak menyentuh satu pun tombol, jadi ia tidak bisa membedakan
   "kalibrasi benar" dari "tombol kalibrasi tidak tersambung ke apa pun". Uji
   peramban butuh cara membaca sumbu pivot yang SEDANG dipakai render, dan
   membacanya dari piksel adalah cara paling mudah untuk lolos palsu. Hanya
   dibaca; menulis lewat sini tidak akan memicu applyPose. */
window.__armstudio = { world, scene, STATE };

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
  if (on) { stopPlayback(); runnerEstop(); }   // playback 3D DAN rutin hardware
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

/* Banner status CAD. GLB-nya gitignored (1,8 MB) jadi tidak ikut ke remote;
   di mesin yang belum punya file itu studio tetap jalan sebagai skeleton dan
   banner ini yang memberi tahu cara membuatnya. */
const cadBanner = document.createElement('div');
cadBanner.id = 'cadBanner';
cadBanner.style.cssText = 'position:absolute;left:50%;top:14px;transform:translateX(-50%);z-index:40;'
  + 'padding:7px 14px;border-radius:8px;font-size:11.5px;line-height:1.5;pointer-events:none;'
  + 'background:rgba(8,12,16,.9);border:1px solid var(--line2);color:var(--muted);display:none';
stage.appendChild(cadBanner);
onCadStatus((s) => {
  if (s === 'loading') {
    cadBanner.style.display = 'block';
    cadBanner.style.color = 'var(--muted)';
    cadBanner.textContent = 'memuat mesh CAD (main-assembly.glb, 1,8 MB)...';
  } else if (s === 'ready') {
    cadBanner.style.display = 'none';
  } else if (s === 'preview') {
    // Build produksi (deploy web) tidak menampilkan apa pun saat GLB absen:
    // situsnya dipakai untuk presentasi, banner peringatan cuma mengganggu.
    // Di dev banner tetap muncul supaya jelas model blok yang sedang tampil
    // bukan mesh CAD.
    if (import.meta.env.PROD) {
      cadBanner.style.display = 'none';
      return;
    }
    cadBanner.style.display = 'block';
    cadBanner.style.color = 'var(--warn)';
    cadBanner.innerHTML = 'mesh CAD belum ada di mesin ini, tampilan memakai <b>model blok</b> '
      + '(posisi dari CAD_PARTS, ukuran dari BOM). Untuk mesh aslinya: '
      + '<code>node tools/optimize_cad_glb.mjs "onshape/Main Assembly (Complete).glb"</code>';
  }
});

// pose awal
refreshVisToggles();
applyPose();
applyExplode();
updateHud();
startLoop();
