/* ============================================================================
   Tab POSE: pose preset + gripper.

   Sumber posenya POSE_PRESETS di config/arm.js, yaitu angka yang ikut git.
   Bukan localStorage, dan itu bukan kelalaian: HP membuka origin yang lain di
   PERANGKAT yang lain, jadi hasil teach dan keyframe rekaman laptop memang
   tidak akan pernah sampai ke sini. Yang bisa dipertanggungjawabkan di layar
   HP cuma angka yang sudah kembali ke repo.

   Dua cara pose sampai ke lengan, dan bedanya nyata:
   - LIVE menyala: pose cuma ditulis ke twin, dan liveLink yang mengalirkannya
     bertahap 20 Hz. Servo J5/J6 tidak bisa mendahului stepper karena targetnya
     sendiri tidak pernah melompat.
   - LIVE mati: tombol KIRIM mengirim satu goto utuh. Ini LOMPATAN target, sama
     seperti tombol kirim di runner desktop, jadi servo memang sampai duluan.
     Tombolnya tetap ada karena itu yang dibutuhkan untuk memindahkan lengan
     sekali jalan, tapi labelnya menyebutkan sifat itu.
   ========================================================================== */
import { STATE, POSE_PRESETS } from '../config/arm.js';
import { applyPose } from '../model/kinematics.js';
import { sendPose, isLive } from '../net/liveLink.js';
import { sendServoUs, SERVO_GRIP, isConnected } from '../net/bridge.js';
import { el, sec, btn, note, toast, row } from './ui.js';
import { gripPulses } from './grip.js';

let els = {};

function applyAngles(a) {
  STATE.joints.forEach((j, i) => {
    if (Number.isFinite(a[i])) j.a = Math.max(j.min, Math.min(j.max, a[i]));
  });
  applyPose();
}

function pick(p) {
  /* payload preset sengaja TIDAK ikut diterapkan. Di desktop dia menggerakkan
     kartu torsi di drawer engineering; halaman HP tidak menampilkan torsi sama
     sekali, jadi menyetelnya di sini cuma mengubah angka yang tidak dilihat
     siapa pun. */
  applyAngles(p.angles);
  els.wrap.querySelectorAll('.mChip').forEach(c => c.classList.toggle('on', c.dataset.n === p.name));
  toast(isLive()
    ? `${p.full}: dialirkan ke lengan (LIVE).`
    : `${p.full}: baru di model 3D. Tekan KIRIM untuk menggerakkan lengan.`,
  isLive() ? 'ok' : '');
  refresh();
}

function kirim() {
  const why = sendPose(STATE.joints.map(j => j.a), { src: 'pocket-pose' });
  if (why) { toast(why, 'bad'); return; }
  toast('Terkirim sebagai satu goto. Lihat lengan, jangan lihat layar.', 'ok');
}

function grip(which) {
  if (!isConnected()) { toast('Belum terhubung.', 'bad'); return; }
  const g = gripPulses();
  sendServoUs(SERVO_GRIP, g[which]);
  toast(`Gripper ${which === 'open' ? 'BUKA' : 'TUTUP'} @ ${g[which]} us`
    + (g.calibrated ? '.' : ' (travel BELUM dikalibrasi).'), g.calibrated ? 'ok' : 'warn');
}

export function refresh() {
  if (!els.send) return;
  const live = isLive();
  els.send.disabled = live;
  els.send.textContent = live ? 'DIALIRKAN OTOMATIS (LIVE)' : 'KIRIM POSE INI';
  els.hint.textContent = live
    ? 'LIVE menyala: pose yang dipilih merayap ke lengan sendiri, tidak ada yang perlu ditekan.'
    : 'LIVE mati: pose baru ada di model 3D. KIRIM mengirimkannya sebagai satu goto utuh, '
      + 'jadi servo pergelangan sampai duluan sementara stepper masih jalan.';
  els.hint.className = 'mNote' + (live ? ' ok' : ' warn');
  const g = gripPulses();
  els.gripHint.textContent = g.calibrated
    ? `Travel terkalibrasi ${g.min}..${g.max} us: buka ${g.open}, tutup ${g.close}.`
    : `Travel gripper belum dikalibrasi di firmware. Memakai angka terukur dari repo (${g.open}/${g.close} us).`;
  els.gripHint.className = 'mNote' + (g.calibrated ? '' : ' warn');
}

export function buildPose(body) {
  els = {};
  els.wrap = body;

  const b1 = sec(body, 'pose preset');
  const chips = el('div', 'mChips');
  POSE_PRESETS.forEach((p) => {
    const c = el('button', 'mChip', `<b>${p.name}</b><span>${p.angles.map(v => v.toFixed(0)).join(' ')}</span>`);
    c.type = 'button';
    c.dataset.n = p.name;
    c.title = p.full;
    c.onclick = () => pick(p);
    chips.appendChild(c);
  });
  b1.appendChild(chips);

  const b2 = sec(body, '');
  els.send = btn('KIRIM POSE INI', 'primary', kirim);
  b2.appendChild(els.send);
  els.hint = note(b2, '');

  const b3 = sec(body, 'gripper');
  b3.appendChild(row(
    btn('BUKA', '', () => grip('open')),
    btn('TUTUP', '', () => grip('close')),
  ));
  els.gripHint = note(b3, '');
  note(b3, 'Gripper bukan DOF: tidak ada di angles[] dan tidak ikut KIRIM POSE.');

  refresh();
}
