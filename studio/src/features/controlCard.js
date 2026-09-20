/* ============================================================================
   Control card (kanan-bawah): bilah interlock + mode GERAK | RUTIN | SERVICE +
   footer (home, E-STOP).

   Dulu ada lima tab (JOINT/CART/MOTION/CAL/SETUP) dan satu gerakan nyata butuh
   menyentuh tiga di antaranya: SETUP untuk Connect, MOTION untuk ARM, lalu
   MOTION atau CART untuk LIVE. Yang bikin pusing bukan jumlah tombolnya
   melainkan saklar yang saling memblokir dari tab yang berbeda. Keempat saklar
   itu sekarang berjejer di bilah interlock di atas (features/interlockBar.js),
   terlihat di mode mana pun, jadi yang tersisa di tab benar benar cuma
   pekerjaan: menggerakkan, menjalankan rutin, atau komisioning.

   SETUP tidak lagi jadi tab sendiri. Isinya cuma satu input URL yang disentuh
   sekali seumur sesi plus tiga baris status hardware; URL-nya pindah ke popover
   di lampu LINK dan baris statusnya ke bawah bilah, tempat status hardware
   memang dibaca.
   ========================================================================== */
import { STATE, POSE_PRESETS } from '../config/arm.js';
import { applyPose } from '../model/kinematics.js';
import { icon } from '../ui/icons.js';
import {
  buildJointRows, buildCartPad, buildStepSeg, initJogSync, goHome, stepLabel,
} from './jog.js';
import { setTcpDrag, setTcpMode, getTcpEnabled } from './tcpDrag.js';
import { DEMOS } from './demos.js';
import { setShow, getShow } from './pathPreview.js';
import { addKey, clearKeys, duration, keyframes, sampleTrajectory, onKeysChange, keysStale } from './timeline.js';
import { eePositionsFor } from '../model/kinematics.js';
import { world } from '../model/rig.js';
import { THREE } from '../core/viewport.js';
import { cssVar } from '../core/theme.js';
import { setPayload } from './dataPanel.js';
import { buildCalPanel } from './calPanel.js';
import { buildRunner } from './runner.js';
import { buildInterlockBar } from './interlockBar.js';

const TABS = [
  ['gerak', 'GERAK'],
  ['rutin', 'RUTIN'],
  ['service', 'SERVICE'],
];

let dragTgl = null;

/* Audit lintasan: sampel TCP sepanjang trajektori lalu laporkan titik terendah
   dan pemakaian jangkauan. Ini yang bikin lintasan "kelewat" kelihatan SEBELUM
   diputar: sebelum rantai di-rebase ke CAD, beberapa demo lewat di bawah meja
   dan satu-satunya cara tahu adalah memutarnya sambil melihat. Ambang aman TCP
   ke grid = 25 mm, sama dengan yang dipakai verify_cad_rig.mjs. */
const CLEAR_MM = 25;
function auditHtml() {
  const n = keyframes().length;
  if (n < 2) return '<span style="color:var(--dim)">belum ada lintasan. Pilih demo di atas atau rekam keyframe.</span>';
  const traj = sampleTrajectory(120);
  const pts = eePositionsFor(traj);
  if (!pts.length) return '<span style="color:var(--dim)">lintasan kosong.</span>';

  const j2 = world.jointRefs[1].pivot.getWorldPosition(new THREE.Vector3());
  const maxReach = (world.geo && world.geo.reachFromJ2) || 1;
  let lowY = Infinity, maxUse = 0;
  for (const p of pts) {
    lowY = Math.min(lowY, p.y);
    maxUse = Math.max(maxUse, p.distanceTo(j2) / maxReach);
  }
  const lowCol = lowY < 0 ? cssVar('--over') : lowY < CLEAR_MM ? cssVar('--warn') : cssVar('--ok');
  const useCol = maxUse > 0.99 ? cssVar('--over') : maxUse > 0.92 ? cssVar('--warn') : cssVar('--ok');
  const note = lowY < 0
    ? '<div style="color:var(--over)">TCP menembus meja, lintasan ini tidak bisa dijalankan di hardware.</div>'
    : lowY < CLEAR_MM
      ? '<div style="color:var(--warn)">TCP mepet meja, sisakan jarak aman sebelum kirim ke hardware.</div>'
      : '';
  /* Lintasan yang direkam sambil melihat twin dengan arah sendi lain akan
     terlihat cermin sekarang. Keyframe-nya tidak dibuang, tapi kejanggalannya
     harus punya nama: tanpa baris ini orang akan mengira lintasannya sendiri
     yang salah rekam. */
  const cermin = keysStale()
    ? '<div style="color:var(--warn)">Direkam sebelum arah sendi twin dibetulkan, '
      + 'jadi gerakannya tercermin. Rekam ulang untuk membetulkan.</div>'
    : '';
  return `<span>${n} keyframe · ${duration().toFixed(1)} s</span><br>`
    + `<span>TCP terendah <b style="color:${lowCol}">${lowY.toFixed(0)}</b> mm</span> · `
    + `<span>jangkauan maks <b style="color:${useCol}">${(maxUse * 100).toFixed(0)}%</b></span>`
    + note + cermin;
}

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

  /* ---- GERAK (bekas JOINT + CART) ----
     Digabung karena keduanya memang satu pekerjaan: menggeser pose twin.
     doJointJog dan doCartJog sama sama berakhir di applyPose(), jadi yang
     dipisahkan oleh dua tab dulu bukan state, cuma tata letaknya.

     Step-nya SATU baris di atas kedua kolom, bukan satu per kolom, karena
     stepIdx di jog.js memang dipakai bersama. Dua segmen yang menggerakkan
     variabel yang sama adalah tampilan ganda yang mengundang orang mengira
     keduanya bisa disetel berbeda. */
  buildStepSeg(bodies.gerak, 'joint', 'jointHint');

  const mv = document.createElement('div'); mv.className = 'mvGrid';
  const colJ = document.createElement('div'); colJ.className = 'mvCol';
  const colC = document.createElement('div'); colC.className = 'mvCol';
  mv.append(colJ, colC);
  bodies.gerak.appendChild(mv);

  buildJointRows(colJ);

  buildCartPad(colC);
  /* Hint kartesian tetap punya id #cartHint walau segmen step-nya sudah
     digabung: flashUnreachable() di jog.js menulis "target di luar jangkauan"
     ke sini, dan tanpa elemennya peringatan itu hilang tanpa suara. */
  const cartHint = document.createElement('div'); cartHint.className = 'ccHint'; cartHint.id = 'cartHint';
  cartHint.textContent = 'step ' + stepLabel('cart');
  colC.appendChild(cartHint);
  dragTgl = tgl(colC, 'Drag TCP (gizmo)', () => getTcpEnabled(), v => setTcpDrag(v));
  const modeSeg = document.createElement('div'); modeSeg.className = 'segsm';
  ['translate', 'rotate'].forEach((m, i) => {
    const b = document.createElement('button'); b.textContent = m === 'translate' ? 'geser' : 'putar'; b.className = i === 0 ? 'on' : '';
    b.onclick = () => { setTcpMode(m); modeSeg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); };
    modeSeg.appendChild(b);
  });
  colC.appendChild(modeSeg);

  /* Tombol LIVE yang dulu ada di sini DIHAPUS, bukan dipindah: lampu LIVE di
     bilah interlock adalah tampilan yang sama atas state yang sama di
     net/liveLink.js, dan sekarang satu satunya. */
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
  bodies.gerak.appendChild(chips);

  /* ---- RUTIN (bekas MOTION) ----
     Runner hardware ditaruh PALING ATAS, sebelum tombol demo. Urutannya
     disengaja: tombol demo hanya menganimasikan model, dan menaruhnya lebih
     dulu membuat orang mengira lengan sudah dijalankan dari sana. */
  buildRunner(bodies.rutin);

  const dCap = document.createElement('div'); dCap.className = 'segRow';
  dCap.innerHTML = '<span class="cap">pratinjau 3D (tidak menggerakkan lengan)</span>';
  bodies.rutin.appendChild(dCap);
  const demoWrap = document.createElement('div'); demoWrap.className = 'btns';
  Object.entries(DEMOS).forEach(([name, fn]) => {
    const b = document.createElement('button'); b.innerHTML = icon('play', 11) + ' ' + name;
    b.style.display = 'flex'; b.style.alignItems = 'center'; b.style.gap = '6px';
    b.onclick = () => { if (STATE.estop) return; fn(); };
    demoWrap.appendChild(b);
  });
  bodies.rutin.appendChild(demoWrap);
  const mCap = document.createElement('div'); mCap.className = 'segRow';
  mCap.innerHTML = '<span class="cap">preview</span>';
  bodies.rutin.appendChild(mCap);
  tgl(bodies.rutin, 'Path TCP (dari timeline)', () => getShow('path'), v => setShow('path', v));
  tgl(bodies.rutin, 'Reachability envelope', () => getShow('reach'), v => setShow('reach', v));
  const kfRow = document.createElement('div'); kfRow.className = 'btns'; kfRow.style.marginTop = '4px';
  const bAdd = document.createElement('button'); bAdd.innerHTML = icon('plus', 11) + ' keyframe';
  bAdd.style.display = 'flex'; bAdd.style.alignItems = 'center'; bAdd.style.gap = '6px';
  bAdd.onclick = () => addKey();
  const bClr = document.createElement('button'); bClr.innerHTML = icon('trash', 11) + ' clear';
  bClr.style.display = 'flex'; bClr.style.alignItems = 'center'; bClr.style.gap = '6px';
  bClr.onclick = () => clearKeys();
  kfRow.append(bAdd, bClr);
  bodies.rutin.appendChild(kfRow);

  /* ---- audit trajektori ---- */
  const aCap = document.createElement('div'); aCap.className = 'segRow';
  aCap.innerHTML = '<span class="cap">cek lintasan</span>';
  bodies.rutin.appendChild(aCap);
  const audit = document.createElement('div'); audit.className = 'mini';
  audit.style.cssText = 'line-height:1.7;padding:6px 8px;border-radius:6px;border:1px solid var(--line);';
  bodies.rutin.appendChild(audit);
  const refreshAudit = () => audit.innerHTML = auditHtml();
  onKeysChange(refreshAudit);
  refreshAudit();

  /* ---- SERVICE (komisioning gaya PLC; logika penuh di calPanel.js) ---- */
  buildCalPanel(bodies.service);

  /* ---- footer ----
     Ikon send DIHAPUS. Satu satunya jalur kirim manual sekarang tombol KIRIM di
     mode RUTIN, plus aliran LIVE. Satu perintah gerak, satu tempat: ikon kecil
     yang mengirim goto tanpa konteks apa pun adalah persis jenis tombol yang
     ditekan orang untuk mencari tahu apa fungsinya. */
  const foot = document.createElement('div'); foot.className = 'ccFoot';
  const bHome = document.createElement('button'); bHome.className = 'icobtn'; bHome.title = 'Pose home (semua sendi 0)';
  bHome.innerHTML = icon('home'); bHome.onclick = () => goHome();
  const grow = document.createElement('div'); grow.className = 'grow';
  /* E-STOP sengaja tinggal di sini dan TIDAK diduplikasi ke bilah interlock:
     jaraknya cuma sekitar 40 px di kartu yang sama, dan dua tombol E-STOP
     membuat operator ragu mana yang benar benar berhenti. */
  const estop = document.createElement('button'); estop.id = 'estop'; estop.className = 'estop';
  estop.title = 'Emergency stop: hentikan semua gerak'; estop.textContent = 'E-STOP';
  foot.append(bHome, grow, estop);
  card.appendChild(foot);

  /* Bilah dibangun TERAKHIR tapi ditaruh PERTAMA: dia membaca state milik panel
     kalibrasi (mode SERVICE), jadi panel itu harus sudah ada dulu. */
  card.prepend(buildInterlockBar());

  initJogSync();
}

/** toggle gizmo drag TCP (shortcut G), sinkron dengan toggle di mode GERAK. */
export function toggleGizmo() {
  const on = !getTcpEnabled();
  setTcpDrag(on);
  if (dragTgl) dragTgl.classList.toggle('on', on);
}

/** sinkron UI toggle gizmo dengan state (mis. setelah E-STOP mematikan drag). */
export function syncGizmoUI() {
  if (dragTgl) dragTgl.classList.toggle('on', getTcpEnabled());
}
