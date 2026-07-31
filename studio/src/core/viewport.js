/* ============================================================================
   Viewport: renderer, scene, kamera (persp + ortho), lighting, grid, material,
   kontrol orbit/pan/zoom custom (mouse + touch), label sprite, render loop.
   Diport dari studio/legacy/index.html; API Three.js dinaikkan ke modul r160.
   ========================================================================== */
import * as THREE from 'three';
import { SceneColors, sceneTheme, onThemeChange } from './theme.js';

export { THREE };
export const v3 = (x, y, z) => new THREE.Vector3(x, y, z);

export const scene = new THREE.Scene();

export const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

// kamera
export const camera = new THREE.PerspectiveCamera(42, 1, 1, 60000);
export const ocam = new THREE.OrthographicCamera(-1, 1, 1, -1, -30000, 30000);
let orthoOn = false;
export function setOrtho(on) { orthoOn = on; applyCam(); }
export function isOrtho() { return orthoOn; }
export function curCam() { return orthoOn ? ocam : camera; }
export const camTarget = new THREE.Vector3(0, 360, 0);
export const cam = { az: -0.7, pol: 1.15, rad: 1500, min: 250, max: 6000 };

// lighting
scene.add(new THREE.HemisphereLight(0xcfe6f5, 0x0c1116, 0.85));
const key = new THREE.DirectionalLight(0xfff4e6, 1.25); key.position.set(600, 1100, 650); scene.add(key);
const fill = new THREE.DirectionalLight(0x9fc4e6, 0.45); fill.position.set(-700, 400, -500); scene.add(fill);
const rim = new THREE.DirectionalLight(0xbfe9ff, 0.5); rim.position.set(-200, 300, 900); scene.add(rim);

// grid (warna ikut tema)
let grid, grid2;
function buildGrid() {
  if (grid) { scene.remove(grid); scene.remove(grid2); }
  const t = sceneTheme();
  grid = new THREE.GridHelper(2400, 24, new THREE.Color(t.groundMajor), new THREE.Color(t.ground));
  grid.position.y = 0; scene.add(grid);
  grid2 = new THREE.GridHelper(2400, 4, new THREE.Color(t.groundMajor), new THREE.Color(t.groundMajor)); // 600mm major
  grid2.position.y = 0.2; scene.add(grid2);
}

// materials (warna part = makna domain di legend, tidak di-theme kecuali bg/grid)
export const M = {
  pla:     new THREE.MeshStandardMaterial({ color: 0xe08a3c, roughness: .72, metalness: .04 }),
  pla2:    new THREE.MeshStandardMaterial({ color: 0xcf9a5e, roughness: .78, metalness: .04 }),
  housing: new THREE.MeshStandardMaterial({ color: 0xb98a52, roughness: .7, metalness: .05 }),
  steel:   new THREE.MeshStandardMaterial({ color: 0xb9c2cb, roughness: .32, metalness: .92 }),
  motor:   new THREE.MeshStandardMaterial({ color: 0x2b323a, roughness: .55, metalness: .55 }),
  servo:   new THREE.MeshStandardMaterial({ color: 0x2f6db0, roughness: .5, metalness: .25 }),
  pcb:     new THREE.MeshStandardMaterial({ color: 0x1f7a4d, roughness: .6, metalness: .2 }),
  magnet:  new THREE.MeshStandardMaterial({ color: 0x9aa6b2, roughness: .4, metalness: .85 }),
  belt:    new THREE.MeshStandardMaterial({ color: 0x1c2228, roughness: .85, metalness: .1 }),
  link:    new THREE.MeshStandardMaterial({ color: 0xd98a3c, roughness: .7, metalness: .05 }),
};

function applyThemeToScene() {
  const t = sceneTheme();
  scene.background = new THREE.Color(t.background);
  buildGrid();
}
onThemeChange(applyThemeToScene);
applyThemeToScene();

export function applyCam() {
  const s = Math.sin(cam.pol);
  const x = cam.rad * s * Math.sin(cam.az), z = cam.rad * s * Math.cos(cam.az), y = cam.rad * Math.cos(cam.pol);
  camera.position.set(camTarget.x + x, camTarget.y + y, camTarget.z + z);
  camera.lookAt(camTarget);
  ocam.position.copy(camera.position); ocam.up.set(0, 1, 0); ocam.lookAt(camTarget);
  const a = camera.aspect || 1, h = cam.rad * 0.42;
  ocam.left = -h * a; ocam.right = h * a; ocam.top = h; ocam.bottom = -h; ocam.updateProjectionMatrix();
}

/** pasang canvas + kontrol ke elemen stage. */
export function mount(stageEl) {
  stageEl.appendChild(renderer.domElement);
  attachControls(renderer.domElement);
  const resize = () => {
    const w = stageEl.clientWidth, h = stageEl.clientHeight;
    renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix(); applyCam();
  };
  window.addEventListener('resize', resize);
  resize();
  applyCam();
}

let controlsEnabled = true;
/** aktif/nonaktifkan orbit custom (dipakai saat drag gizmo TransformControls). */
export function setControlsEnabled(v) { controlsEnabled = v; }

function attachControls(el) {
  let mode = null, lx = 0, ly = 0, pdist = 0;
  const pan = (dx, dy) => {
    const f = cam.rad * 0.0016;
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
    camTarget.addScaledVector(right, -dx * f); camTarget.addScaledVector(up, dy * f); applyCam();
  };
  const rot = (dx, dy) => { cam.az -= dx * 0.0055; cam.pol = Math.max(0.05, Math.min(3.0, cam.pol - dy * 0.0055)); applyCam(); };
  el.addEventListener('pointerdown', e => { if (!controlsEnabled) return; el.setPointerCapture(e.pointerId); mode = (e.shiftKey || e.button === 1 || e.button === 2) ? 'pan' : 'rot'; lx = e.clientX; ly = e.clientY; });
  el.addEventListener('pointermove', e => { if (!mode || !controlsEnabled) return; const dx = e.clientX - lx, dy = e.clientY - ly; lx = e.clientX; ly = e.clientY; if (mode === 'pan') pan(dx, dy); else rot(dx, dy); });
  el.addEventListener('pointerup', () => mode = null);
  el.addEventListener('contextmenu', e => e.preventDefault());
  el.addEventListener('wheel', e => { e.preventDefault(); cam.rad = Math.max(cam.min, Math.min(cam.max, cam.rad * (1 + Math.sign(e.deltaY) * 0.09))); applyCam(); }, { passive: false });
  const tp = {};
  el.addEventListener('touchstart', e => { if (!controlsEnabled) return; for (const t of e.changedTouches) tp[t.identifier] = { x: t.clientX, y: t.clientY }; if (e.touches.length === 2) { const a = e.touches[0], b = e.touches[1]; pdist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); } }, { passive: false });
  el.addEventListener('touchmove', e => {
    if (!controlsEnabled) return;
    e.preventDefault();
    if (e.touches.length === 1) { const t = e.touches[0], o = tp[t.identifier]; if (o) { rot(t.clientX - o.x, t.clientY - o.y); o.x = t.clientX; o.y = t.clientY; } }
    else if (e.touches.length === 2) {
      const a = e.touches[0], b = e.touches[1];
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (pdist) cam.rad = Math.max(cam.min, Math.min(cam.max, cam.rad * pdist / d)); pdist = d;
      const oa = tp[a.identifier], ob = tp[b.identifier];
      if (oa && ob) { const mx = ((a.clientX - oa.x) + (b.clientX - ob.x)) / 2, my = ((a.clientY - oa.y) + (b.clientY - ob.y)) / 2; pan(mx, my); }
      for (const t of e.touches) if (tp[t.identifier]) { tp[t.identifier].x = t.clientX; tp[t.identifier].y = t.clientY; } applyCam();
    }
  }, { passive: false });
  el.addEventListener('touchend', e => { for (const t of e.changedTouches) delete tp[t.identifier]; pdist = 0; });
}

/* ---------------- render loop ---------------- */
const frameCbs = new Set();
export function onFrame(fn) { frameCbs.add(fn); return () => frameCbs.delete(fn); }
export function startLoop() {
  function tick() { requestAnimationFrame(tick); for (const fn of frameCbs) fn(); renderer.render(scene, curCam()); }
  tick();
}

/* ---------------- label sprite ---------------- */
function roundRect(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
export function makeLabel(text, color = '#bfeaf5', scale = 1) {
  const pad = 10, fs = 42 * scale; const c = document.createElement('canvas'); const x = c.getContext('2d');
  x.font = `600 ${fs}px ui-monospace,Menlo,monospace`; const w = x.measureText(text).width;
  c.width = w + pad * 2; c.height = fs + pad * 2;
  x.font = `600 ${fs}px ui-monospace,Menlo,monospace`; x.fillStyle = 'rgba(8,12,16,.72)';
  roundRect(x, 1, 1, c.width - 2, c.height - 2, 10); x.fill();
  x.fillStyle = color; x.textBaseline = 'middle'; x.fillText(text, pad, c.height / 2);
  const tex = new THREE.CanvasTexture(c); tex.minFilter = THREE.LinearFilter; tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true }));
  sp.scale.set(c.width * 0.32 * scale, c.height * 0.32 * scale, 1); sp.renderOrder = 999;
  return sp;
}

/* ---------------- primitive helpers dipakai model ---------------- */
export function cyl(rt, rb, h, seg, mat) { return new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat); }
export function ringMesh(ri, ro, h, mat) {
  const s = new THREE.Shape(); s.absarc(0, 0, ro, 0, Math.PI * 2, false);
  const hole = new THREE.Path(); hole.absarc(0, 0, ri, 0, Math.PI * 2, true); s.holes.push(hole);
  const geo = new THREE.ExtrudeGeometry(s, { depth: h, bevelEnabled: false, curveSegments: 48 }); geo.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(geo, mat); m.position.y = h / 2; return m;
}
