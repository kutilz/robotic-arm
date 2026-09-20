/* ============================================================================
   Tab JOG: enam baris sendi, tekan-tahan untuk berjalan.

   Tombol tekan-tahan (holdBtn) dipakai ulang apa adanya dari features/jog.js.
   Dia sudah memakai pointer event, jadi jempol dan kursor jalan di jalur yang
   sama, dan dia sudah menolak bergerak saat E-STOP tertekan.

   Yang TIDAK ada di sini, dan sengaja: jog Cartesian dan drag TCP. Keduanya
   memanggil IK numerik yang menyelesaikan enam derajat kebebasan sekaligus, dan
   hasilnya adalah pose yang tidak bisa diperiksa sekilas sebelum berangkat. Di
   depan penonton, dengan layar sekecil ini, satu satunya gerak yang bisa
   dipertanggungjawabkan adalah gerak per sendi yang angkanya kelihatan.
   ========================================================================== */
import { STATE } from '../config/arm.js';
import { applyPose, onUpdate } from '../model/kinematics.js';
import { holdBtn } from '../features/jog.js';
import { isLive } from '../net/liveLink.js';
import { el, sec, note, seg, toast } from './ui.js';

const STEPS = [0.5, 2, 10];   // deg
let stepIdx = 1;
let rows = [];
let hintEl = null;

function nudge(i, dir) {
  const j = STATE.joints[i];
  const next = j.a + dir * STEPS[stepIdx];
  const cl = Math.max(j.min, Math.min(j.max, next));
  if (cl === j.a) {
    /* Diam karena mentok limit harus punya nama. Tombol yang ditekan dan tidak
       terjadi apa apa adalah cara tercepat membuat operator mengira link putus. */
    toast(`J${i + 1} sudah di limit ${cl === j.min ? 'bawah' : 'atas'} (${cl}°).`, 'warn', 1600);
    return;
  }
  j.a = cl;
  applyPose();
}

export function refresh() {
  rows.forEach(({ val, i }) => {
    const j = STATE.joints[i];
    val.textContent = j.a.toFixed(1) + '°';
    // kuning saat menempel limit: batasnya tidak boleh cuma terasa saat ditekan
    val.classList.toggle('lim', j.a <= j.min + 0.01 || j.a >= j.max - 0.01);
  });
  if (hintEl) {
    const live = isLive();
    hintEl.textContent = live
      ? 'LIVE menyala: tiap ketukan merayap ke lengan, 0,4°/tick di TEACH.'
      : 'LIVE mati: yang bergerak baru model 3D. Nyalakan lampu LIVE di rantai atas '
        + 'supaya lengan ikut.';
    hintEl.className = 'mNote' + (live ? ' ok' : ' warn');
  }
}

export function buildJog(body) {
  rows = [];

  const b0 = sec(body, 'besar langkah');
  b0.appendChild(seg(
    STEPS.map((s, i) => [String(i), s + '°']),
    String(stepIdx),
    (k) => { stepIdx = +k; },
  ));

  const b1 = sec(body, 'sendi');
  STATE.joints.forEach((j, i) => {
    const r = el('div', 'mJog');
    r.appendChild(el('div', 'lab', `<b>J${i + 1}</b><span>${j.name}</span>`));

    const minus = el('button', 'mStep', '−');
    minus.type = 'button';
    const val = el('div', 'val', '0.0°');
    const plus = el('button', 'mStep', '+');
    plus.type = 'button';

    holdBtn(minus, () => nudge(i, -1));
    holdBtn(plus, () => nudge(i, +1));

    r.append(minus, val, plus);
    b1.appendChild(r);
    rows.push({ val, i });
  });

  hintEl = note(body, '');
  // Angka ikut bergerak saat feedback hardware menggerakkan model, bukan cuma
  // saat tombol ditekan.
  onUpdate(refresh);
  refresh();
}
