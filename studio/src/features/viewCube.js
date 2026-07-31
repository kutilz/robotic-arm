/* ============================================================================
   View cube: orientasi kamera ala Onshape. Dua bagian:
   1. buildViewButtons(): tombol Iso/Depan/Belakang/Kanan/Kiri/Atas/Bawah +
      toggle perspektif/ortho, dipasang di scene panel.
   2. buildGizmo(): overlay triad sumbu X(coral) Y(teal) Z(purple) di pojok
      kiri-bawah yang ikut orientasi kamera dan bisa diklik untuk snap view.
   Memakai kamera Three.js yang sudah ada (viewport.js): set cam.az/cam.pol lalu
   applyCam(). Tombol view otomatis mengaktifkan mode ortho (gaya drawing CAD).
   ========================================================================== */
import { THREE, camera, cam, applyCam, setOrtho, isOrtho, onFrame } from '../core/viewport.js';

// Preset (az, pol) selaras applyCam viewport:
//   x = r·sin(pol)·sin(az), z = r·sin(pol)·cos(az), y = r·cos(pol)
// => front (+Z) az=0 pol=90; kanan (+X) az=90; atas (+Y) pol=0. Iso true 35.26°.
const ISO_POL = Math.acos(1 / Math.sqrt(3));   // 54.7356° dari sumbu atas
export const VIEWS = {
  iso:   { az: -Math.PI / 4, pol: ISO_POL, label: 'Iso' },
  front: { az: 0,            pol: Math.PI / 2, label: 'Depan' },
  back:  { az: Math.PI,      pol: Math.PI / 2, label: 'Belakang' },
  right: { az: Math.PI / 2,  pol: Math.PI / 2, label: 'Kanan' },
  left:  { az: -Math.PI / 2, pol: Math.PI / 2, label: 'Kiri' },
  top:   { az: 0,            pol: 0.0008,      label: 'Atas' },
  bottom:{ az: 0,            pol: Math.PI - 0.0008, label: 'Bawah' },
};

const projIndicators = new Set();   // elemen UI yang mencerminkan status ortho
/** daftar elemen yang punya kelas .on saat ortho aktif (tombol/segment). */
export function registerProjIndicator(el, orthoWhenOn = true) {
  if (el) projIndicators.add({ el, orthoWhenOn }); refreshProj();
}
export function refreshProj() {
  for (const { el, orthoWhenOn } of projIndicators) el.classList.toggle('on', isOrtho() === orthoWhenOn);
}

/** set kamera ke view bernama; view ortho = true (default) meniru drawing CAD. */
export function setView(name, { ortho = true } = {}) {
  const v = VIEWS[name]; if (!v) return;
  cam.az = v.az; cam.pol = v.pol;
  if (ortho) setOrtho(true); else applyCam();
  refreshProj();
}
/** set proyeksi perspektif/ortho tanpa mengubah sudut. */
export function setProjection(ortho) { setOrtho(ortho); refreshProj(); }

/* ---------------- tombol view (di scene panel) ---------------- */
const BTN_ORDER = ['iso', 'front', 'back', 'left', 'right', 'top', 'bottom'];
export function buildViewButtons(container) {
  const grid = document.createElement('div'); grid.className = 'vcBtns';
  for (const name of BTN_ORDER) {
    const b = document.createElement('button');
    b.className = 'vcBtn' + (name === 'iso' ? ' iso' : '');
    b.textContent = VIEWS[name].label; b.dataset.view = name;
    b.onclick = () => setView(name);
    grid.appendChild(b);
  }
  container.appendChild(grid);

  const seg = document.createElement('div'); seg.className = 'seg vcProj';
  const bp = document.createElement('button'); bp.textContent = 'Perspektif';
  const bo = document.createElement('button'); bo.textContent = 'Ortho';
  bp.onclick = () => setProjection(false); bo.onclick = () => setProjection(true);
  seg.append(bp, bo); container.appendChild(seg);
  registerProjIndicator(bo, true); registerProjIndicator(bp, false);
}

/* ---------------- gizmo triad (pojok kiri-bawah) ---------------- */
// warna sesuai arm_dh_viewer.html: X coral, Y teal, Z purple.
const AXES = [
  { name: 'X', v: new THREE.Vector3(1, 0, 0),  col: '#d85a30', view: 'right' },
  { name: 'Y', v: new THREE.Vector3(0, 1, 0),  col: '#1d9e75', view: 'top' },
  { name: 'Z', v: new THREE.Vector3(0, 0, 1),  col: '#7f77dd', view: 'front' },
  { name: '-X', v: new THREE.Vector3(-1, 0, 0), col: '#d85a30', view: 'left', neg: true },
  { name: '-Y', v: new THREE.Vector3(0, -1, 0), col: '#1d9e75', view: 'bottom', neg: true },
  { name: '-Z', v: new THREE.Vector3(0, 0, -1), col: '#7f77dd', view: 'back', neg: true },
];

export function buildGizmo(stageEl) {
  const wrap = document.createElement('div'); wrap.id = 'viewGizmo';
  const size = 104; const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cv = document.createElement('canvas');
  cv.width = size * dpr; cv.height = size * dpr;
  cv.style.width = size + 'px'; cv.style.height = size + 'px';
  wrap.appendChild(cv); stageEl.appendChild(wrap);
  const ctx = cv.getContext('2d');
  const C = size / 2, L = 33, R = 9;
  const right = new THREE.Vector3(), up = new THREE.Vector3(), back = new THREE.Vector3();
  let hit = [];   // {x,y,r,view} untuk klik

  function draw() {
    camera.updateMatrixWorld();
    const e = camera.matrixWorld.elements;
    right.set(e[0], e[1], e[2]); up.set(e[4], e[5], e[6]); back.set(e[8], e[9], e[10]);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    // proyeksikan tiap sumbu ke layar (x kanan, y ke bawah), depth utk z-order
    const pts = AXES.map(a => {
      const sx = a.v.dot(right), sy = a.v.dot(up), depth = a.v.dot(back);
      return { a, x: C + sx * L, y: C - sy * L, depth };
    });
    pts.sort((p, q) => p.depth - q.depth);   // jauh dulu, dekat di atas
    hit = [];
    for (const p of pts) {
      const { a } = p;
      // batang sumbu (positif tegas, negatif redup)
      ctx.strokeStyle = a.col; ctx.globalAlpha = a.neg ? 0.28 : 0.95;
      ctx.lineWidth = a.neg ? 2 : 3; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(C, C); ctx.lineTo(p.x, p.y); ctx.stroke();
      // bola ujung
      ctx.globalAlpha = 1; ctx.beginPath(); ctx.arc(p.x, p.y, a.neg ? R * 0.62 : R, 0, 7);
      if (a.neg) { ctx.fillStyle = '#0e1318'; ctx.fill(); ctx.strokeStyle = a.col; ctx.globalAlpha = 0.7; ctx.lineWidth = 1.5; ctx.stroke(); }
      else { ctx.fillStyle = a.col; ctx.fill(); ctx.fillStyle = '#0e1318'; ctx.font = '700 11px ui-monospace,Menlo,monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(a.name, p.x, p.y + 0.5); }
      ctx.globalAlpha = 1;
      hit.push({ x: p.x, y: p.y, r: (a.neg ? R * 0.62 : R) + 2, view: a.view });
    }
  }

  cv.style.cursor = 'pointer';
  cv.addEventListener('pointerdown', (ev) => {
    const rect = cv.getBoundingClientRect();
    const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
    // cek dari yang tergambar terakhir (paling depan) -> iterasi mundur
    for (let i = hit.length - 1; i >= 0; i--) {
      const h = hit[i];
      if ((mx - h.x) ** 2 + (my - h.y) ** 2 <= h.r * h.r) { setView(h.view); return; }
    }
  });
  cv.title = 'Klik sumbu untuk snap view · ikut orientasi kamera';

  onFrame(draw); draw();
  return wrap;
}
