/* ============================================================================
   Arm Pocket: halaman kendali lengan untuk HP.

   BUKAN studio desktop yang di-resize. Alasannya dua, dan yang kedua yang
   menentukan.

   Pertama, tata letaknya. Studio desktop menumpuk panel floating di atas
   panggung 3D full-viewport: scene panel 262 px, status card 296 px, control
   card 360 px, plus drawer 362 px. Di layar 390 px itu bukan "sempit", itu
   mustahil; media query tidak bisa memperbaiki tata letak yang premisnya adalah
   ruang kosong di sekeliling panggung. Di sini tata letaknya kolom kaku dan
   tidak ada yang bisa bertindihan pada lebar berapa pun.

   Kedua, FUNGSINYA memang beda. HP ini alat memperagakan, bukan alat menyetel.
   Yang tidak ikut ke sini dan itu disengaja:
     - kalibrasi (tab SERVICE, cal_set/cal_save/cal_zero, diag 5 Hz)
     - teach by showing, penandaan langkah terverifikasi, ekspor rutin
     - kalibrasi twin, drawer engineering, sizing, torsi, inspector
     - jog Cartesian, drag TCP, dan seluruh jalur IK interaktif
   Semuanya butuh melihat lengan dari dekat sambil membandingkan angka, dan
   semuanya menulis keadaan yang harus kembali ke repo. Layar 6 inci di tangan
   orang yang sedang bicara bukan tempatnya.

   -------------------------------------------------------------------------
   YANG PALING PENTING DIKETAHUI SEBELUM MENGUBAH BERKAS INI:

   Halaman ini TIDAK membaca satu pun kunci `armstudio.*` di localStorage, dan
   itu bukan kelalaian. localStorage terikat origin DAN perangkat. HP membuka
   http://<ip-lan>:5174 di peramban HP; laptop membuka http://localhost:5174 di
   peramban laptop. Itu dua penyimpanan yang berbeda, dan tidak ada alamat yang
   bisa menyatukannya, karena keduanya bahkan bukan mesin yang sama.

   Artinya hasil teach, keyframe rekaman, dan geseran kalibrasi twin di laptop
   TIDAK PERNAH sampai ke HP. Kalau halaman ini pura pura membacanya, yang
   terjadi bukan galat melainkan panel yang terbuka dengan angka bawaan tanpa
   satu pun pesan. Jadi seluruh pose yang dijalankan HP datang dari berkas yang
   ikut git: config/routines.js, config/arm.js, dan TWIN_CAL_DEFAULT di
   model/cadRig.js. Satu satunya yang disimpan HP adalah alamat WebSocket
   (armpocket.ws.v1), karena mengetik ulang IP di papan ketik layar tiap sesi
   tidak menghasilkan keselamatan apa pun.

   Konsekuensi yang harus diterima: kalau hasil teach terakhir belum
   dikembalikan ke repo lewat "ekspor rutin" di studio desktop, HP menjalankan
   angka yang lebih lama. Panel RUTIN menyebutkan itu di layar.
   ========================================================================== */
import '../styles/mobile.css';
import { mount, startLoop, onFrame } from '../core/viewport.js';
import { setView } from '../features/viewCube.js';
import { STATE } from '../config/arm.js';
import { buildRig } from '../model/rig.js';
import { loadCadModel, onCadStatus } from '../model/cadModel.js';
import { applyPose } from '../model/kinematics.js';
import { refreshVisToggles } from '../features/viewToggles.js';
import { loadTwinCal } from '../features/twinCal.js';
import {
  connect, sendEstop, sendResume, onHwStatus, getActual, isFbTrusted, isConnected,
} from '../net/bridge.js';
import { setArmed, isArmed, onLiveChange } from '../net/liveLink.js';
import { el, initToast, initModal, toast, fmt } from './ui.js';
import { buildChain, drawChain, watchChain, openLinkSheet, savedUrl } from './link.js';
import { buildPose, refresh as refreshPose } from './pose.js';
import { buildJog, refresh as refreshJog } from './jog.js';
import { buildRoutine, refresh as refreshRoutine, routineEstop, isRunning } from './routine.js';
import { buildData, refresh as refreshData } from './data.js';

const stage = document.getElementById('mstage');
mount(stage);

/* Kalibrasi twin dibaca SEBELUM rantai dibangun: arah sendi dan trim home ikut
   dihitung di buildChain(), jadi memuatnya sesudah itu berarti frame pertama
   digambar dengan kalibrasi lama. Di HP loadTwinCal() praktis selalu jatuh ke
   TWIN_CAL_DEFAULT karena localStorage-nya kosong, dan itu memang yang benar:
   yang tersimpan di kode adalah yang ikut terbaca gambar skripsi dan
   verify_cad_rig.mjs. */
loadTwinCal();
buildRig();
loadCadModel();
refreshVisToggles();
applyPose();

/* Ortho dimatikan: di layar sempit proyeksi ortho membuat lengan terlihat
   pipih dan penonton kehilangan kedalaman, yang justru satu satunya alasan
   menunjukkan model 3D dan bukan foto. */
setView('iso', { ortho: false });

initToast(document.getElementById('mToast'));
initModal(
  document.getElementById('mModal'),
  document.getElementById('mModalTitle'),
  document.getElementById('mModalBody'),
  document.getElementById('mModalClose'),
);

/* ---------------- kamera ---------------- */
const VIEW_CYCLE = [['iso', 'ISO'], ['front', 'DEPAN'], ['right', 'SAMPING'], ['top', 'ATAS']];
let viewIdx = 0;
const viewBtn = document.getElementById('mView');
viewBtn.onclick = () => {
  viewIdx = (viewIdx + 1) % VIEW_CYCLE.length;
  const [name, label] = VIEW_CYCLE[viewIdx];
  setView(name, { ortho: false });
  viewBtn.textContent = label;
};

/* ---------------- rantai interlock + koneksi ---------------- */
buildChain(document.getElementById('mChain'));
document.getElementById('mLink').onclick = () => openLinkSheet(syncSub);

const subEl = document.getElementById('mSub');
function syncSub() {
  subEl.textContent = isConnected() ? savedUrl() : 'belum tersambung - ketuk ikon koneksi';
}

/* ---------------- tab ---------------- */
const sheetBody = document.getElementById('msheetBody');
const TABS = [
  ['pose', 'POSE', buildPose, refreshPose],
  ['jog', 'JOG', buildJog, refreshJog],
  ['rutin', 'RUTIN', buildRoutine, refreshRoutine],
  ['data', 'DATA', buildData, refreshData],
];
const panes = {};
let active = 'pose';

const tabsEl = document.getElementById('mtabs');
TABS.forEach(([k, label, build]) => {
  /* Keempat panel dibangun sekali di depan, lalu ditukar tampil. Membangun
     ulang tiap ganti tab jauh lebih sederhana, tapi ia membuang keadaan yang
     sedang berjalan: rutin yang sedang jalan kehilangan tombol STOP-nya begitu
     operator melirik tab DATA, dan itu persis tab yang ingin dilirik saat
     sesuatu terasa aneh. */
  const pane = el('div');
  build(pane);
  panes[k] = pane;

  const b = el('button', 'mtab' + (k === active ? ' on' : ''), label);
  b.type = 'button';
  b.onclick = () => setTab(k);
  tabsEl.appendChild(b);
});

function setTab(k) {
  active = k;
  tabsEl.querySelectorAll('.mtab').forEach((b, i) => b.classList.toggle('on', TABS[i][0] === k));
  sheetBody.innerHTML = '';
  sheetBody.appendChild(panes[k]);
  document.documentElement.classList.remove('collapsed');
  TABS.find(t => t[0] === k)[3]();
}
setTab('pose');

/* lembar bisa dikuncupkan supaya panggung 3D dapat seluruh layar saat
   memperlihatkan lengan ke orang. */
document.getElementById('mGrip').onclick = () => {
  document.documentElement.classList.toggle('collapsed');
};

/* Kanvas WebGL TIDAK ikut berubah ukuran sendiri saat panggung tumbuh. mount()
   di viewport.js hanya mendengarkan event `resize` milik window, dan window
   tidak berubah ukuran saat lembar tab dikuncupkan, saat bilah alamat Safari
   menyusut, atau saat papan ketik layar muncul. Yang terlihat kalau ini tidak
   ada: gambar 3D yang gepeng atau bergaris hitam sesudah lembar dibuka-tutup
   sekali. ResizeObserver mengamati elemen yang benar, lalu meminjam jalur
   resize yang sudah ada supaya tidak ada dua jalur ukur. */
new ResizeObserver(() => window.dispatchEvent(new Event('resize'))).observe(stage);

/* ---------------- E-STOP ---------------- */
/* Sengaja tanpa konfirmasi dan tanpa tahan-untuk-menekan. Tombol berhenti yang
   butuh dua langkah bukan tombol berhenti. Yang dijaga adalah sebaliknya:
   melepasnya (RESET) mengirim `resume` eksplisit, dan firmware dibangun dengan
   ESTOP_AUTO_RESUME 0 sehingga goto tidak pernah diam diam melepas e-stop. */
const estopBtn = document.getElementById('mEstop');
function setEstop(on, fromHw = false) {
  STATE.estop = on;
  estopBtn.classList.toggle('tripped', on);
  estopBtn.textContent = on ? 'RESET' : 'E-STOP';
  if (on) routineEstop();
  if (!fromHw) {
    if (on) sendEstop(); else sendResume();
  }
  drawChain();
  toast(on
    ? 'E-STOP: tahap output driver dimatikan. RESET mengirim resume dan menyamakan target dengan posisi sekarang.'
    : 'E-STOP dilepas.', on ? 'bad' : 'ok');
}
estopBtn.onclick = () => setEstop(!STATE.estop);

watchChain((ev) => {
  if (ev.type === 'estop' && ev.on !== STATE.estop) setEstop(ev.on, true);
  else if (ev.type === 'link') syncSub();
});

/* ---------------- layar tetap menyala + penjaga saat ditinggal ---------------- */
/* Dua hal yang cuma ada di HP dan dua duanya soal keselamatan.

   1 Wake lock. Firmware memakai dead-man 4 detik: kalau tidak ada satu pun
     klien WebSocket selama itu, gerak diramp berhenti. HP yang layarnya mati di
     tengah rutin akan memutus socket dan memicu itu. Berhentinya aman, tapi
     rutin yang putus di tengah karena layar mati adalah kegagalan yang tidak
     perlu ada.

   2 Halaman ditinggal = ARM dilucuti. Kalau operator pindah aplikasi atau
     mengunci HP, tidak ada lagi yang melihat lengan sementara perintah masih
     boleh berangkat. Melucuti ARM di sini lebih tegas daripada menunggu
     dead-man firmware, karena dead-man baru bekerja setelah socket benar benar
     putus, sedangkan tab yang tersembunyi bisa tetap terhubung cukup lama. */
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* ditolak browser / tidak didukung: bukan alasan menghentikan apa pun */ }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (isArmed()) {
      setArmed(false);
      toast('Halaman ditinggal: ARM dilucuti otomatis.', 'warn');
    }
    routineEstop();
    keepAwake(false);
  } else if (isArmed()) {
    keepAwake(true);
  }
});

/* ARM menyala -> layar dijaga menyala; ARM mati -> dilepas lagi supaya baterai
   tidak habis selama HP cuma memajang model. Dikaitkan ke event liveLink, bukan
   di-poll: ARM bisa dilucuti sendiri oleh liveLink (link putus, driver hilang)
   tanpa ada yang menekan apa pun, dan wake lock harus ikut lepas di situ juga. */
let lastArmed = false;
onLiveChange(() => {
  const a = isArmed();
  if (a !== lastArmed) { lastArmed = a; keepAwake(a); }
});

/* ---------------- strip sudut ---------------- */
const anglesEl = document.getElementById('mAngles');
STATE.joints.forEach((_, i) => {
  anglesEl.appendChild(el('div', 'mAng', `<b>J${i + 1}</b><span>--</span>`));
});
const angSpans = [...anglesEl.querySelectorAll('.mAng')];

/* Feedback datang 50 Hz. Menggambar ulang DOM secepat itu di HP menghabiskan
   frame budget yang seharusnya milik WebGL, dan tidak ada mata yang membaca
   angka yang berubah 50 kali per detik. 8 Hz sudah terasa "hidup". */
const UI_MS = 125;
let lastUi = 0;
onFrame(() => {
  const now = performance.now();
  if (now - lastUi < UI_MS) return;
  lastUi = now;

  const act = getActual();
  angSpans.forEach((n, i) => {
    const a = act ? act[i] : null;
    n.querySelector('span').textContent = Number.isFinite(a) ? fmt(a) : fmt(STATE.joints[i].a);
    n.classList.toggle('untrusted', !isFbTrusted(i));
    n.classList.toggle('stale', !act);
  });

  TABS.find(t => t[0] === active)[3]();
});

/* ---------------- status mesh CAD ---------------- */
const cadEl = document.getElementById('mCad');
onCadStatus((s) => {
  if (s === 'loading') {
    cadEl.style.display = 'block';
    cadEl.style.color = 'var(--muted)';
    cadEl.textContent = 'memuat mesh CAD 1,8 MB lewat WiFi...';
  } else if (s === 'ready') {
    cadEl.style.display = 'none';
  } else if (s === 'missing') {
    cadEl.style.display = 'block';
    cadEl.style.color = 'var(--warn)';
    cadEl.textContent = 'mesh CAD belum ada di mesin yang menyajikan halaman ini; '
      + 'tampilan jatuh ke skeleton. Kinematika tetap akurat.';
  }
});

/* ---------------- mulai ---------------- */
syncSub();
startLoop();

/* Menyambung sendiri saat halaman dibuka. Aman karena menyambung TIDAK
   menggerakkan apa pun: ARM tetap mati, dan liveLink menolak setiap byte
   selama itu. Yang didapat adalah umpan balik sudut langsung terlihat, yaitu
   satu satunya cara operator tahu HP-nya benar benar bicara dengan lengan
   sebelum ada yang ditekan. */
connect(savedUrl());

onHwStatus((ev) => {
  if (ev.type === 'link' && ev.up && ev.reopened && isRunning()) {
    toast('Link kembali di tengah rutin. Periksa pose lengan sebelum melanjutkan.', 'warn');
  }
});
