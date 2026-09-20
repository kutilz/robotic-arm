/* ============================================================================
   Mode SERVICE: panel komisioning gaya PLC/servo-drive industrial.
   Filosofi arsitektur: firmware = EXECUTOR primitif (cal_*, diag, load_*);
   SEMUA sequencing, perhitungan (uji rasio, gram->Newton->torsi, peak hold),
   dan logging CSV (data skripsi) hidup di file ini.

   - Interlock MONITOR | SERVICE ala key-switch: semua aksi TULIS (jog, zero,
     dir, apply, commit, tare) terkunci selama MONITOR.
   - SERVICE aktif -> poll {"cmd":"diag"} ~5 Hz: pilot lamp magnet AS5600
     (MD/ML/MH + AGC) per axis, raw angle, StallGuard, load cell, info WiFi.
   - Parameter semantik drive industrial: APPLY = cal_set (RAM, lamp MOD nyala)
     vs COMMIT = cal_save (NVS) vs DEFAULTS = cal_reset.
   - DATA LOG: REC menyalin tiap sampel diag (+target/actual) ke buffer,
     EXPORT mengunduh CSV -> bahan bab pengujian skripsi.
   ========================================================================== */
import { STATE } from '../config/arm.js';
import { applyPose } from '../model/kinematics.js';
import { holdBtn } from './jog.js';
import { buildTwinCal } from './twinCal.js';
import { accordion } from '../ui/panel.js';
import {
  isConnected, sendGoto, getActual, getGripActual, onHwStatus,
  sendCalGet, sendCalSet, sendCalZero, sendCalSave, sendCalReset,
  sendDiag, sendLoadTare, sendLoadScale,
  sendGripper, sendServoUs, sendServoAuto, SERVO_GRIP,
} from '../net/bridge.js';

const NSTEP = 4;                    // J1..J4 stepper ber-encoder
const CAL_STEPS = [0.5, 2, 10];     // step jog kalibrasi (derajat)
const DIAG_MS = 200;                // ~5 Hz poll diag saat SERVICE
const GRIP_MS = 60;                 // throttle kirim slider gripper (~16 Hz)
const GRIP_UI_MS = 150;             // refresh readout gripper dari feedback

let service = false;
let built = false;                  // panel sudah dibangun (lihat setCalService)
let pollTimer = null;
let uiTimer = null;
let lastCal = null;                 // {type:'cal',...} terakhir dari firmware
let lastDiag = null;
let modified = false;               // cal RAM != NVS (lamp MOD)
let calStepIdx = 0;
let pendingZero = null;             // joint yg menunggu ack cal_zero (0-based)
let testBusy = false;
let peakG = 0;                      // peak hold |gram| (uji stall torque)

/* data log (skripsi): buffer bertahan lintas start/stop sampai CLEAR */
let logRows = [];
let recOn = false;
let recT0 = 0;

const axes = [];                    // refs UI per axis
let lampMod, lampRec, lampLc;
let infoEl, hintEl, recCountEl, recBtn;
let loadGEl, loadNmEl;
let armInp, massInp;
const paramInp = {};                // ratio[4], speed, accel, kp, deadband
const tmcInp = {};                  // ma[4], hold, microstep
const drvRows = [];                 // refs baris readback driver TMC
let tmcSpread = 1;                  // 0 = stealthChop, 1 = spreadCycle
let setSpreadSeg = null;            // setter segmented STEALTH|SPREAD
let rsenseEl;
const writeBtns = [];               // tombol + input yg butuh interlock SERVICE

/* gripper (servo MG90S, indeks SERVO_GRIP di firmware, BUKAN sendi) */
let gripUsSld, gripDegSld;          // handle slider pulsa mentah & sudut
let gripLedCmd, gripLedAct, gripLedUs, gripLampMan;
let gripMinInp, gripMaxInp, gripNote;
let gripManual = false;             // jejak mode manual servo di firmware
/* batas yang dipakai slider. Nilai awal = default firmware; diganti begitu
   cal_get masuk supaya slider tidak pernah menawarkan pulsa di luar travel. */
const gripLim = { usMin: 500, usMax: 2500, usCenter: 1500, angMin: 0, angMax: 180 };

/* Ambang arus yang butuh pendinginan serius. Di atas 1000 mA RMS, TMC2209
   wajib heatsink besar + aliran udara (lihat docs/research/). */
const TMC_MA_WARN = 1000;
const TMC_MA_MAX = 1700;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fmt = (v, d = 2) => (v == null || !Number.isFinite(v) ? '--' : v.toFixed(d));

function hint(msg, ok = true) {
  /* setService() bisa dipanggil bilah interlock sebelum panel ini dibangun,
     dan pesannya tidak punya tempat untuk ditulis. */
  if (!hintEl) return;
  hintEl.textContent = msg;
  hintEl.style.color = ok ? '' : 'var(--warn)';
}

/* ---------- komponen kecil gaya PLC ---------- */
function mkLamp(parent, label) {
  const el = document.createElement('span'); el.className = 'plamp';
  el.innerHTML = `<i class="pd"></i>${label}`;
  parent.appendChild(el);
  return { el, set(st) { el.dataset.st = st; } };   // ok|warn|err|'' (off)
}
function mkLed(parent, label) {
  const box = document.createElement('div'); box.className = 'led';
  box.innerHTML = `<div class="k">${label}</div><div class="v na">--</div>`;
  parent.appendChild(box);
  const v = box.querySelector('.v');
  return { set(text, na = false) { v.textContent = text; v.classList.toggle('na', na); } };
}
function mkBtn(parent, label, fn, { write = true, danger = false } = {}) {
  const b = document.createElement('button');
  b.textContent = label;
  if (danger) b.className = 'danger';
  if (fn) b.onclick = fn;
  parent.appendChild(b);
  if (write) writeBtns.push(b);
  return b;
}
/* Slider yang batasnya bisa diganti setelah kalibrasi terbaca. Beda dengan
   ui/panel.js slider() yang batasnya beku sejak dibuat. */
function mkSlider(parent, label, { min, max, step, unit, dec = 0, oninput }) {
  const r = document.createElement('div'); r.className = 'row';
  r.innerHTML = `<label>${label}</label><input type=range><span class="val"></span>`;
  const inp = r.querySelector('input'), v = r.querySelector('.val');
  const show = () => { v.textContent = (+inp.value).toFixed(dec) + unit; };
  inp.min = min; inp.max = max; inp.step = step; inp.value = (min + max) / 2;
  inp.oninput = () => { show(); oninput(+inp.value); };
  show();
  parent.appendChild(r);
  writeBtns.push(inp);            // ikut interlock SERVICE, sama dgn tombol
  return {
    inp,
    get value() { return +inp.value; },
    setRange(lo, hi) { inp.min = lo; inp.max = hi; this.set(+inp.value); },
    /** geser tanpa memicu oninput (dipakai saat menyelaraskan dgn hardware) */
    set(val) { inp.value = clamp(val, +inp.min, +inp.max); show(); },
  };
}

/* ---------- interlock ---------- */
function canWrite() { return service && isConnected() && !STATE.estop; }
function refreshLock() {
  /* Bisa dipanggil dari bilah interlock sebelum panel ini pernah dibangun
     (urutan mount tidak dijamin), dan saat itu belum ada satu pun lampu atau
     tombol yang boleh disentuh. */
  if (!built) return;
  const dis = !canWrite();
  writeBtns.forEach(b => { b.disabled = dis; });
  lampMod.set(modified ? 'warn' : '');
  lampRec.set(recOn ? 'err' : '');
}

/* ---------- aksi ---------- */
function jog(i, dir) {
  if (!canWrite()) return;
  const j = STATE.joints[i];
  j.a = clamp(j.a + dir * CAL_STEPS[calStepIdx], j.min, j.max);
  applyPose();
  if (!sendGoto()) hint('belum terhubung ke hardware', false);
}

function zero(i) {
  if (!confirm(`ZERO J${i + 1}: definisikan pose fisik SEKARANG sebagai 0°?`)) return;
  pendingZero = i;
  sendCalZero(i + 1);
}

function flipDir(i) {
  if (!lastCal || !Array.isArray(lastCal.enc_sign)) {
    hint('kalibrasi belum terbaca, tekan READ dulu', false);
    sendCalGet();
    return;
  }
  const arr = lastCal.enc_sign.slice(0, NSTEP).map(Number);
  arr[i] *= -1;
  sendCalSet({ enc_sign: arr });
}

/* Uji rasio: perintahkan +/-10 derajat, tunggu settle (feedback 50 Hz diam
   >1.2 dtk), bandingkan delta encoder vs delta commanded -> % error rasio.
   Perhitungan penuh di sini; firmware hanya menjalankan goto. */
function ratioTest(i) {
  if (testBusy) { hint('masih ada TEST berjalan', false); return; }
  if (!canWrite()) return;
  const act = getActual();
  if (!act || act[i] == null) { hint('tidak ada feedback encoder', false); return; }
  const j = STATE.joints[i];
  const delta = (j.a + 10 <= j.max) ? 10 : -10;
  const startEnc = act[i];
  j.a = clamp(j.a + delta, j.min, j.max);
  applyPose();
  if (!sendGoto()) { hint('belum terhubung ke hardware', false); return; }
  testBusy = true;
  axes[i].hint.textContent = `TEST ${delta > 0 ? '+' : ''}${delta}° ...`;
  let lastV = startEnc, still = 0, waited = 0;
  const t = setInterval(() => {
    waited += 300;
    const a = getActual();
    const v = (a && a[i] != null) ? a[i] : lastV;
    if (Math.abs(v - lastV) < 0.05) still++; else still = 0;
    lastV = v;
    if (still >= 4 || waited > 10000) {
      clearInterval(t);
      testBusy = false;
      const meas = v - startEnc;
      const errPct = ((meas - delta) / delta) * 100;
      axes[i].hint.textContent =
        `cmd ${delta > 0 ? '+' : ''}${delta}°  enc ${meas >= 0 ? '+' : ''}${meas.toFixed(2)}°  err ${errPct.toFixed(1)}%`;
      if (waited > 10000) axes[i].hint.textContent += ' (timeout)';
    }
  }, 300);
}

function applyParams() {
  const fields = {};
  const ratio = paramInp.ratio.map(inp => parseFloat(inp.value));
  if (ratio.every(Number.isFinite)) fields.ratio = ratio;
  for (const k of ['speed', 'accel', 'kp', 'deadband']) {
    const v = parseFloat(paramInp[k].value);
    if (Number.isFinite(v)) fields[k] = v;
  }
  if (!Object.keys(fields).length) { hint('tidak ada parameter valid', false); return; }
  sendCalSet(fields);
}

function fillParams() {
  if (!lastCal) return;
  const put = (inp, v) => { if (document.activeElement !== inp) inp.value = v; };
  if (Array.isArray(lastCal.ratio))
    paramInp.ratio.forEach((inp, i) => put(inp, lastCal.ratio[i]));
  put(paramInp.speed, lastCal.speed);
  put(paramInp.accel, lastCal.accel);
  put(paramInp.kp, lastCal.kp);
  put(paramInp.deadband, lastCal.deadband);

  if (Array.isArray(lastCal.tmc_ma))
    tmcInp.ma.forEach((inp, i) => put(inp, lastCal.tmc_ma[i]));
  if (lastCal.tmc_hold != null) put(tmcInp.hold, lastCal.tmc_hold);
  if (lastCal.tmc_microstep != null && document.activeElement !== tmcInp.microstep)
    tmcInp.microstep.value = String(lastCal.tmc_microstep);
  if (lastCal.tmc_spread != null && setSpreadSeg) setSpreadSeg(Number(lastCal.tmc_spread));
  rsenseEl.textContent = lastCal.tmc_rsense != null
    ? `R_SENSE ${lastCal.tmc_rsense} Ω, cocokkan dengan marking resistor di modul`
    : 'firmware tanpa UART TMC (USE_TMC_UART 0)';
}

/* Arus & karakter chopper. Microstep dikirim bareng karena firmware ikut
   menghitung ulang STEPS_PER_DEG dan me-resync step counter saat berubah. */
function applyTmc() {
  const fields = {};
  const ma = tmcInp.ma.map(inp => parseInt(inp.value, 10));
  if (!ma.every(v => Number.isFinite(v) && v >= 100 && v <= TMC_MA_MAX)) {
    hint(`arus tiap axis harus 100..${TMC_MA_MAX} mA`, false);
    return;
  }
  const hot = ma.filter(v => v > TMC_MA_WARN).length;
  if (hot && !confirm(
    `${hot} driver di atas ${TMC_MA_WARN} mA RMS.\n\n` +
    'TMC2209 di arus segini WAJIB heatsink besar + aliran udara. ' +
    'Tanpa itu driver akan overtemp dan mematikan output di tengah gerakan.\n\nLanjut?')) return;
  fields.tmc_ma = ma;

  const hold = parseInt(tmcInp.hold.value, 10);
  if (!Number.isFinite(hold) || hold < 0 || hold > 100) { hint('hold 0..100 %', false); return; }
  fields.tmc_hold = hold;

  fields.tmc_microstep = parseInt(tmcInp.microstep.value, 10);
  fields.tmc_spread = tmcSpread;
  sendCalSet(fields);
}

/* ---------- gripper ----------
   Gripper bukan DOF: tidak ikut goto/angles[] dan tidak punya joint limit,
   jadi seluruh kontrolnya berdiri sendiri di blok ini.

   Dua jalur, sengaja tidak digabung jadi satu slider:
   - PULSA (us) lewat servo_us: lebar pulsa mentah + mode manual di firmware.
     Ini satu-satunya jalur yang artinya tidak bergantung pada kalibrasi, jadi
     inilah yang dipakai SEBELUM rahang terpasang (mis. mendudukkan horn di
     titik tengah sebelum dirakit).
   - SUDUT (deg) lewat gripper: melewati pemetaan servoAngMin..Max. Berguna
     hanya SETELAH min/max gripper benar; sebelum itu angkanya cuma nama lain
     dari persen travel. Perintah ini juga melepas mode manual.
   Keduanya disinkronkan di layar supaya tidak pernah menampilkan dua posisi
   yang saling bertentangan. */
let gripPending = null, gripTimer = null;
function gripThrottled(fn) {
  // Leading edge + trailing: slider bisa memicu puluhan event per detik,
  // sedangkan tiap perintah membalas ack. Tanpa throttle, WS penuh ack.
  gripPending = fn;
  if (gripTimer) return;
  const tick = () => {
    if (!gripPending) { clearInterval(gripTimer); gripTimer = null; return; }
    const f = gripPending; gripPending = null; f();
  };
  tick();
  gripTimer = setInterval(tick, GRIP_MS);
}

const usToDeg = us => gripLim.angMin
  + ((us - gripLim.usMin) / (gripLim.usMax - gripLim.usMin)) * (gripLim.angMax - gripLim.angMin);
const degToUs = deg => gripLim.usMin
  + ((deg - gripLim.angMin) / (gripLim.angMax - gripLim.angMin)) * (gripLim.usMax - gripLim.usMin);

function showGripCmd(us, deg) {
  gripLedUs.set(`${Math.round(us)}`);
  gripLedCmd.set(`${deg.toFixed(1)}°`);
}
function setGripManual(on) {
  gripManual = on;
  gripLampMan.set(on ? 'warn' : '');
}

function gripUs(us) {
  if (!canWrite()) return;
  gripDegSld.set(usToDeg(us));           // sinkron tampilan, tanpa ikut mengirim
  showGripCmd(us, usToDeg(us));
  setGripManual(true);
  gripThrottled(() => { if (!sendServoUs(SERVO_GRIP, Math.round(us))) hint('belum terhubung', false); });
}

function gripDeg(deg) {
  if (!canWrite()) return;
  gripUsSld.set(degToUs(deg));
  showGripCmd(degToUs(deg), deg);
  setGripManual(false);                  // cmd gripper melepas mode manual
  gripThrottled(() => { if (!sendGripper(deg)) hint('belum terhubung', false); });
}

/* TENGAH: dudukkan horn di titik tengah TERUKUR (servoUsCenter) lewat pulsa
   mentah, bukan lewat sudut. Alasannya dua: titik tengah adalah satu-satunya
   pose yang dijamin ada di dalam travel servo, dan mode manual menahannya di
   situ sehingga loop kendali tidak menariknya balik saat rahang dipasang. */
function gripCenter() {
  if (!canWrite()) return;
  const us = gripLim.usCenter;
  gripUsSld.set(us);
  gripDegSld.set(usToDeg(us));
  showGripCmd(us, usToDeg(us));
  setGripManual(true);
  if (sendServoUs(SERVO_GRIP, Math.round(us))) {
    hint(`gripper ditahan di titik tengah ${Math.round(us)} us (mode manual), aman untuk dirakit`);
  } else hint('belum terhubung', false);
}

function gripAuto() {
  if (!canWrite()) return;
  setGripManual(false);
  if (sendServoAuto(SERVO_GRIP)) hint('gripper kembali ke pemetaan sudut (mode manual dilepas)');
  else hint('belum terhubung', false);
}

/* Batas sudut gripper -> servoAngMin/Max index 2. Firmware membaca array
   SELURUH 3 servo sekaligus dan menolak yang panjangnya bukan 3, jadi J5 & J6
   wajib ikut dikirim apa adanya; kalau tidak keduanya ikut tertimpa. */
function applyGripper() {
  if (!lastCal || !Array.isArray(lastCal.servo_ang_min) || !Array.isArray(lastCal.servo_ang_max)) {
    hint('kalibrasi servo belum terbaca, tekan READ dulu', false);
    sendCalGet();
    return;
  }
  const lo = parseFloat(gripMinInp.value), hi = parseFloat(gripMaxInp.value);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) { hint('min/max gripper harus angka', false); return; }
  if (lo >= hi) { hint('min gripper harus lebih kecil dari max', false); return; }
  if (lo < -360 || hi > 360) { hint('min/max gripper di luar -360..360', false); return; }
  const amin = lastCal.servo_ang_min.slice(0, 3).map(Number);
  const amax = lastCal.servo_ang_max.slice(0, 3).map(Number);
  amin[SERVO_GRIP] = lo; amax[SERVO_GRIP] = hi;
  sendCalSet({ servo_ang_min: amin, servo_ang_max: amax });
}

function fillGripper() {
  if (!lastCal) return;
  const num = (arr, def) => (Array.isArray(arr) && Number.isFinite(Number(arr[SERVO_GRIP]))
    ? Number(arr[SERVO_GRIP]) : def);
  gripLim.usMin = num(lastCal.servo_us_min, gripLim.usMin);
  gripLim.usMax = num(lastCal.servo_us_max, gripLim.usMax);
  gripLim.usCenter = num(lastCal.servo_us_center, gripLim.usCenter);
  gripLim.angMin = num(lastCal.servo_ang_min, gripLim.angMin);
  gripLim.angMax = num(lastCal.servo_ang_max, gripLim.angMax);
  gripUsSld.setRange(gripLim.usMin, gripLim.usMax);
  gripDegSld.setRange(gripLim.angMin, gripLim.angMax);
  const put = (inp, v) => { if (document.activeElement !== inp) inp.value = v; };
  put(gripMinInp, gripLim.angMin);
  put(gripMaxInp, gripLim.angMax);
  gripNote.textContent = `travel ${gripLim.usMin}-${gripLim.usMax} us, tengah ${gripLim.usCenter} us`
    + ` = ${gripLim.angMin}..${gripLim.angMax}°`;
}

/* Sudut gripper AKTUAL datang dari wiper pot MG90S lewat ADS1115 (kanal A2),
   bukan dari perintah, jadi ini yang menunjukkan servo benar-benar sampai. */
function refreshGrip() {
  const g = getGripActual();
  gripLedAct.set(g == null ? '--' : `${g.toFixed(1)}°`, g == null);
}

/* ---------- render diag ---------- */
function renderDiag(d) {
  for (let i = 0; i < NSTEP; i++) {
    const a = axes[i], e = d.enc && d.enc[i];
    if (!e || !e.ok) {
      a.comm.set(e && e.fault ? 'err' : '');
      a.mag.set(''); a.flt.set(e && e.fault ? 'err' : '');
      a.raw.set('--', true); a.agc.textContent = '';
      a.ang.set(fmt(e && e.deg), e == null); a.err.set('--', true);
      continue;
    }
    a.comm.set('ok');
    a.mag.set(e.md && !e.ml && !e.mh ? 'ok' : (e.md ? 'warn' : 'err'));
    a.flt.set(e.fault ? 'err' : '');
    a.raw.set(fmt(e.raw) + '°', e.raw == null);
    a.ang.set(fmt(e.deg) + '°');
    a.err.set(fmt(STATE.joints[i].a - e.deg) + '°');
    a.agc.textContent = `agc ${e.agc >= 0 ? e.agc : '--'} mag ${e.mag >= 0 ? e.mag : '--'}`
      + (d.sg ? ` sg ${d.sg[i]}` : '');
  }
  const w = d.wifi || {};
  infoEl.textContent = `link ${w.mode || '?'} ${w.ip || ''}`
    + (w.mode === 'sta' ? ` (${w.rssi} dBm)` : '')
    + ` · mux ${d.mux ? 'OK' : 'tidak ada (bench J1)'}`;

  renderDrv(d);

  const ld = d.load;
  if (ld) {
    lampLc.set(!ld.ok ? 'err' : (ld.cal ? 'ok' : 'warn'));
    const g = ld.ok && ld.cal ? ld.g : null;
    loadGEl.textContent = g == null ? (ld.ok ? 'no cal' : '--') : g.toFixed(1);
    if (g != null) {
      peakG = Math.max(peakG, Math.abs(g));
      const armM = (parseFloat(armInp.value) || 0) / 1000;
      const nm = (g / 1000) * 9.81 * armM;
      loadNmEl.textContent = `${((g / 1000) * 9.81).toFixed(2)} N · ${nm.toFixed(3)} N·m`
        + `  · peak ${peakG.toFixed(1)} g`;
    }
  } else {
    lampLc.set('');
    loadGEl.textContent = '--';
    loadNmEl.textContent = 'firmware tanpa HX711';
  }
}

/* Readback driver TMC2209. "set" = arus jalan yang terprogram (IRUN), "live" =
   arus yang benar-benar aktif detik ini (CS_ACTUAL), saat diam nilainya turun
   ke arus tahan, itu normal dan justru bukti TPOWERDOWN bekerja.
   Catatan: kedua angka ini skala DIGITAL. Bila lamp VREF menyala, pot analog
   masih ikut mengali arus dan angka di sini terlalu optimistis. */
function renderDrv(d) {
  for (let i = 0; i < NSTEP; i++) {
    const row = drvRows[i], v = d.drv && d.drv[i];
    if (!v || !v.ok) { row.set(['--', '--', '--'], 'err', 'no comm'); continue; }
    let st = 'ok', note = 'ok';
    if (v.ol)   { st = 'warn'; note = 'coil open'; }
    if (v.otpw) { st = 'warn'; note = 'panas'; }
    if (v.s2g)  { st = 'err';  note = 'short GND'; }
    if (v.ot)   { st = 'err';  note = 'OVERTEMP'; }
    // Paling akhir: kalau bit ini menyala semua angka arus tidak bisa dipercaya.
    if (v.vref) { st = 'err';  note = 'VREF aktif'; }
    row.set([Math.round(v.ma), Math.round(v.macs), v.cs], st, note);
  }
}

/* ---------- data log (CSV utk skripsi) ---------- */
const CSV_HEAD = ['t_ms',
  ...[1, 2, 3, 4, 5, 6].map(n => `tgt${n}`),
  ...[1, 2, 3, 4, 5, 6].map(n => `act${n}`),
  ...[1, 2, 3, 4].map(n => `raw${n}`),
  ...[1, 2, 3, 4].map(n => `fault${n}`),
  ...[1, 2, 3, 4].map(n => `sg${n}`),
  ...[1, 2, 3, 4].map(n => `drvma${n}`),    // arus live tiap driver (mA RMS)
  ...[1, 2, 3, 4].map(n => `drvhot${n}`),   // 1 = otpw/ot aktif saat sampel
  'load_g', 'load_raw'].join(',');

function pushRow(d) {
  const act = getActual() || [];
  const row = [Date.now() - recT0];
  for (let i = 0; i < 6; i++) row.push(fmt(STATE.joints[i].a));
  for (let i = 0; i < 6; i++) row.push(act[i] != null ? fmt(act[i]) : '');
  for (let i = 0; i < NSTEP; i++) { const e = d.enc && d.enc[i]; row.push(e && e.raw != null ? fmt(e.raw) : ''); }
  for (let i = 0; i < NSTEP; i++) row.push(d.enc && d.enc[i] && d.enc[i].fault ? 1 : 0);
  for (let i = 0; i < NSTEP; i++) row.push(d.sg ? d.sg[i] : '');
  for (let i = 0; i < NSTEP; i++) {
    const v = d.drv && d.drv[i];
    row.push(v && v.ok ? Math.round(v.macs) : '');
  }
  for (let i = 0; i < NSTEP; i++) {
    const v = d.drv && d.drv[i];
    row.push(v && v.ok ? ((v.ot || v.otpw) ? 1 : 0) : '');
  }
  row.push(d.load && d.load.ok ? fmt(d.load.g) : '', d.load ? d.load.raw : '');
  logRows.push(row.join(','));
  recCountEl.textContent = `${logRows.length} sampel`;
}

function exportCsv() {
  if (!logRows.length) { hint('buffer log kosong', false); return; }
  const blob = new Blob([CSV_HEAD + '\n' + logRows.join('\n') + '\n'], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `arm-callog-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  hint(`CSV diexport (${logRows.length} sampel)`);
}

/* ---------- mode SERVICE ----------
   Saklarnya sekarang hidup di bilah interlock, bukan lagi segmen tersembunyi di
   dalam tab ini. State-nya tetap milik modul ini karena yang dikuncinya juga
   milik modul ini (writeBtns + poll diag), jadi yang diekspor cuma pintunya. */
function setService(on) {
  service = on;
  clearInterval(pollTimer); pollTimer = null;
  if (on) {
    if (isConnected()) sendCalGet();
    pollTimer = setInterval(() => { if (isConnected()) sendDiag(); }, DIAG_MS);
    hint('SERVICE aktif: aksi tulis terbuka, diag dipoll 5 Hz');
  } else {
    hint('MONITOR: hanya baca');
  }
  refreshLock();
}

/** Saklar SERVICE dari luar (bilah interlock). */
export function setCalService(on) { setService(!!on); }
/** true bila aksi tulis kalibrasi sedang dibuka. */
export function isCalService() { return service; }

/* ---------- build ---------- */
export function buildCalPanel(body) {
  /* Header tinggal lampu yang memang milik kalibrasi. Saklar MONITOR/SERVICE
     dan lampu LINK naik ke bilah interlock: keduanya berlaku untuk seluruh
     studio, bukan cuma panel ini, dan LINK yang digambar di dua tempat adalah
     dua tempat yang bisa berbeda pendapat soal hal yang sama. */
  const head = document.createElement('div'); head.className = 'calHead';
  const cap = document.createElement('span'); cap.className = 'cap'; cap.textContent = 'kalibrasi';
  head.appendChild(cap);
  const grow = document.createElement('div'); grow.className = 'grow'; head.appendChild(grow);
  lampMod = mkLamp(head, 'MOD');
  lampRec = mkLamp(head, 'REC');
  body.appendChild(head);

  infoEl = document.createElement('div'); infoEl.className = 'mini';
  infoEl.textContent = 'diag belum ada, aktifkan SERVICE saat terhubung';
  body.appendChild(infoEl);

  /* Sembilan blok komisioning jadi accordion satu-terbuka. Dulu kesembilannya
     terbuka sekaligus dalam satu kolom yang harus digulung terus, padahal yang
     dipakai bersamaan biasanya cuma dua. Urutannya mengikuti urutan
     komisioning: axis dulu, twin, lalu parameter firmware, lalu yang jarang.

     Yang TIDAK ikut masuk accordion: lampu keadaan di atas dan baris hint di
     bawah. Keduanya berlaku untuk seluruh panel, jadi menyembunyikannya di
     dalam salah satu blok berarti pesan hasil aksi bisa muncul di blok yang
     sedang tertutup. */
  const acc = accordion(body, { compact: true });
  const secAxis = acc.add('kartu axis J1..J4 + step jog', true);
  const secTwin = acc.add('kalibrasi twin');
  const secParam = acc.add('parameter');
  const secDrv = acc.add('driver TMC2209');
  const secGrip = acc.add('gripper');
  const secLoad = acc.add('load cell');
  const secLog = acc.add('data log');

  /* step jog kalibrasi */
  const stepRow = document.createElement('div'); stepRow.className = 'segRow';
  stepRow.innerHTML = '<span class="cap">step jog</span>';
  const stepSeg = document.createElement('div'); stepSeg.className = 'segsm';
  CAL_STEPS.forEach((s, k) => {
    const b = document.createElement('button');
    b.textContent = s + '°';
    b.className = k === calStepIdx ? 'on' : '';
    b.onclick = () => {
      calStepIdx = k;
      stepSeg.querySelectorAll('button').forEach((x, m) => x.classList.toggle('on', m === k));
    };
    stepSeg.appendChild(b);
  });
  stepRow.appendChild(stepSeg);
  secAxis.appendChild(stepRow);

  /* channel card per axis (ala drive commissioning) */
  for (let i = 0; i < NSTEP; i++) {
    const card = document.createElement('div'); card.className = 'calCard';
    const top = document.createElement('div'); top.className = 'top';
    const nm = document.createElement('span'); nm.className = 'nm';
    nm.textContent = `J${i + 1}`;
    top.appendChild(nm);
    const comm = mkLamp(top, 'COMM');
    const mag = mkLamp(top, 'MAG');
    const flt = mkLamp(top, 'FLT');
    const tGrow = document.createElement('div'); tGrow.className = 'grow'; top.appendChild(tGrow);
    const agc = document.createElement('span'); agc.className = 'agc'; top.appendChild(agc);
    card.appendChild(top);

    const leds = document.createElement('div'); leds.className = 'ledRow';
    const raw = mkLed(leds, 'raw');
    const ang = mkLed(leds, 'ang');
    const err = mkLed(leds, 'err');
    card.appendChild(leds);

    const btns = document.createElement('div'); btns.className = 'calBtns';
    const bMin = mkBtn(btns, 'JOG−');
    const bPls = mkBtn(btns, 'JOG+');
    holdBtn(bMin, () => jog(i, -1));
    holdBtn(bPls, () => jog(i, +1));
    mkBtn(btns, 'ZERO', () => zero(i));
    mkBtn(btns, 'DIR', () => flipDir(i));
    mkBtn(btns, 'TEST', () => ratioTest(i));
    card.appendChild(btns);

    const chint = document.createElement('div'); chint.className = 'mini'; chint.style.margin = '4px 0 0';
    card.appendChild(chint);

    axes.push({ comm, mag, flt, raw, ang, err, agc, hint: chint });
    secAxis.appendChild(card);
  }

  /* Kalibrasi twin tetap jadi seksi tepat di bawah kartu axis, bukan di dasar
     panel: inilah blok yang dipakai bergantian cepat dengan JOG di kartu axis,
     dan menyelipkan tiga blok parameter firmware di antaranya berarti operator
     harus melompati accordion bolak-balik sambil membandingkan arah putaran. */
  buildTwinCal(secTwin);

  /* parameter (semantik drive: APPLY=RAM, COMMIT=NVS) */
  const cap1 = document.createElement('div'); cap1.className = 'calCap'; cap1.textContent = 'parameter';
  secParam.appendChild(cap1);
  const grid = document.createElement('div'); grid.className = 'calParams';
  const addParam = (label, el) => {
    const l = document.createElement('label'); l.textContent = label;
    grid.append(l, el);
  };
  const quad = document.createElement('div'); quad.className = 'quad';
  paramInp.ratio = [0, 1, 2, 3].map(i => {
    const inp = document.createElement('input');
    inp.type = 'text'; inp.title = `ratio J${i + 1}`;
    quad.appendChild(inp);
    return inp;
  });
  addParam('ratio 1-4', quad);
  for (const [k, lbl] of [['speed', 'speed °/s'], ['accel', 'accel °/s²'], ['kp', 'kp'], ['deadband', 'deadband °']]) {
    const inp = document.createElement('input'); inp.type = 'text';
    paramInp[k] = inp;
    addParam(lbl, inp);
  }
  secParam.appendChild(grid);
  const pBtns = document.createElement('div'); pBtns.className = 'calBtns';
  mkBtn(pBtns, 'READ', () => { if (!sendCalGet()) hint('belum terhubung', false); }, { write: false });
  mkBtn(pBtns, 'APPLY', applyParams);
  mkBtn(pBtns, 'COMMIT', () => sendCalSave());
  mkBtn(pBtns, 'DEFAULTS', () => {
    if (confirm('Kembalikan SEMUA kalibrasi ke default + hapus NVS?')) sendCalReset();
  }, { danger: true });
  secParam.appendChild(pBtns);

  /* driver TMC2209: arus & karakter chopper, runtime tanpa re-flash.
     APPLY DRIVER terpisah dari APPLY parameter karena efeknya beda kelas:
     yang ini menyentuh register chip dan sempat mematikan tahap output. */
  const cap4 = document.createElement('div'); cap4.className = 'calCap';
  cap4.textContent = 'driver TMC2209';
  secDrv.appendChild(cap4);

  rsenseEl = document.createElement('div'); rsenseEl.className = 'mini';
  rsenseEl.textContent = 'tekan READ untuk memuat setting driver';
  secDrv.appendChild(rsenseEl);

  const tGrid = document.createElement('div'); tGrid.className = 'calParams';
  const addT = (label, el) => {
    const l = document.createElement('label'); l.textContent = label;
    tGrid.append(l, el);
  };
  const maQuad = document.createElement('div'); maQuad.className = 'quad';
  tmcInp.ma = [0, 1, 2, 3].map(i => {
    const inp = document.createElement('input');
    inp.type = 'text'; inp.title = `arus RMS J${i + 1} (mA)`;
    maQuad.appendChild(inp);
    return inp;
  });
  addT('arus mA 1-4', maQuad);

  const modeSeg = document.createElement('div'); modeSeg.className = 'segsm';
  const modeBtns = [['STEALTH', 0], ['SPREAD', 1]].map(([lbl, val]) => {
    const b = document.createElement('button');
    b.textContent = lbl;
    b.title = val
      ? 'spreadCycle: torsi & akurasi posisi lebih tinggi, motor terdengar. Default lengan.'
      : 'stealthChop: senyap tapi torsi lebih rendah dan butuh autotune. Wajib untuk StallGuard.';
    b.onclick = () => setSpreadSeg(val);
    modeSeg.appendChild(b);
    writeBtns.push(b);
    return b;
  });
  setSpreadSeg = (val) => {
    tmcSpread = val;
    modeBtns.forEach((b, k) => b.classList.toggle('on', k === val));
  };
  setSpreadSeg(1);
  addT('mode chopper', modeSeg);

  tmcInp.microstep = document.createElement('select');
  for (const m of [1, 2, 4, 8, 16, 32, 64, 128, 256]) {
    const o = document.createElement('option');
    o.value = String(m);
    o.textContent = m === 1 ? 'full step' : `1/${m}`;
    tmcInp.microstep.appendChild(o);
  }
  tmcInp.microstep.value = '16';
  tmcInp.microstep.title = 'microstep ikut menskala step/derajat, firmware '
    + 'me-resync step counter otomatis saat ini berubah';
  addT('microstep', tmcInp.microstep);

  tmcInp.hold = document.createElement('input');
  tmcInp.hold.type = 'text';
  tmcInp.hold.title = 'arus tahan saat diam, % dari arus jalan';
  addT('hold %', tmcInp.hold);
  secDrv.appendChild(tGrid);

  const tBtns = document.createElement('div'); tBtns.className = 'calBtns';
  mkBtn(tBtns, 'APPLY DRIVER', applyTmc);
  secDrv.appendChild(tBtns);

  const drvTbl = document.createElement('div'); drvTbl.className = 'drvTable';
  const drvHead = document.createElement('div');
  drvHead.className = 'drvRow head';
  for (const h of ['ax', 'set mA', 'live mA', 'cs', 'status']) {
    const s = document.createElement('span'); s.textContent = h;
    drvHead.appendChild(s);
  }
  drvTbl.appendChild(drvHead);
  for (let i = 0; i < NSTEP; i++) {
    const r = document.createElement('div'); r.className = 'drvRow';
    const cells = [`J${i + 1}`, '--', '--', '--', '--'].map(t => {
      const s = document.createElement('span'); s.textContent = t;
      r.appendChild(s);
      return s;
    });
    drvTbl.appendChild(r);
    drvRows.push({
      set(vals, st, note) {
        cells[1].textContent = vals[0];
        cells[2].textContent = vals[1];
        cells[3].textContent = vals[2];
        cells[4].textContent = note;
        r.dataset.st = st;
      },
    });
  }
  secDrv.appendChild(drvTbl);

  /* gripper: servo MG90S di GPIO4, bukan DOF sehingga tidak punya baris jog
     seperti J1..J4 dan tidak ikut Send goto. Perintahnya langsung jalan. */
  const cap5 = document.createElement('div'); cap5.className = 'calCap';
  cap5.textContent = 'gripper';
  secGrip.appendChild(cap5);

  const gCard = document.createElement('div'); gCard.className = 'calCard';
  const gTop = document.createElement('div'); gTop.className = 'top';
  const gNm = document.createElement('span'); gNm.className = 'nm'; gNm.textContent = 'GRIP';
  gTop.appendChild(gNm);
  gripLampMan = mkLamp(gTop, 'MAN');
  gripLampMan.el.title = 'mode manual: pulsa dikunci servo_us, loop kendali '
    + 'tidak menimpanya. Dilepas oleh AUTO atau slider sudut.';
  const gGrow = document.createElement('div'); gGrow.className = 'grow'; gTop.appendChild(gGrow);
  const gTag = document.createElement('span'); gTag.className = 'agc';
  gTag.textContent = 'MG90S · GPIO4 · bukan DOF';
  gTop.appendChild(gTag);
  gCard.appendChild(gTop);

  const gLeds = document.createElement('div'); gLeds.className = 'ledRow';
  gripLedCmd = mkLed(gLeds, 'cmd');
  gripLedAct = mkLed(gLeds, 'act');
  gripLedUs = mkLed(gLeds, 'us');
  gCard.appendChild(gLeds);

  gripUsSld = mkSlider(gCard, 'pulsa mentah', {
    min: gripLim.usMin, max: gripLim.usMax, step: 5, unit: ' us', oninput: gripUs,
  });
  gripDegSld = mkSlider(gCard, 'sudut', {
    min: gripLim.angMin, max: gripLim.angMax, step: 1, unit: '°', oninput: gripDeg,
  });

  const gBtns = document.createElement('div'); gBtns.className = 'calBtns';
  mkBtn(gBtns, 'TENGAH', gripCenter).title =
    'tahan gripper di titik tengah terukur (servoUsCenter) lewat pulsa mentah. '
    + 'Ini pose untuk memasang horn & rahang.';
  mkBtn(gBtns, 'AUTO', gripAuto).title =
    'lepas mode manual, gripper kembali mengikuti target sudut';
  gCard.appendChild(gBtns);

  gripNote = document.createElement('div'); gripNote.className = 'mini';
  gripNote.style.margin = '4px 0 0';
  gripNote.textContent = 'tekan READ untuk memuat travel gripper dari firmware';
  gCard.appendChild(gripNote);
  secGrip.appendChild(gCard);

  const gGrid = document.createElement('div'); gGrid.className = 'calParams';
  gripMinInp = document.createElement('input'); gripMinInp.type = 'text';
  gripMinInp.title = 'sudut di pulsa minimum (biasanya rahang menutup)';
  gripMaxInp = document.createElement('input'); gripMaxInp.type = 'text';
  gripMaxInp.title = 'sudut di pulsa maksimum (biasanya rahang membuka)';
  const gl1 = document.createElement('label'); gl1.textContent = 'min °';
  const gl2 = document.createElement('label'); gl2.textContent = 'max °';
  gGrid.append(gl1, gripMinInp, gl2, gripMaxInp);
  secGrip.appendChild(gGrid);

  const gApply = document.createElement('div'); gApply.className = 'calBtns';
  mkBtn(gApply, 'APPLY GRIPPER', applyGripper).title =
    'tulis batas sudut gripper ke RAM firmware. COMMIT di blok parameter '
    + 'yang menyimpannya ke NVS.';
  secGrip.appendChild(gApply);

  /* load cell (bench torsi) */
  const cap2 = document.createElement('div'); cap2.className = 'calCap'; cap2.textContent = 'load cell';
  secLoad.appendChild(cap2);
  const lcHead = document.createElement('div'); lcHead.className = 'calHead';
  lampLc = mkLamp(lcHead, 'LC');
  const big = document.createElement('div'); big.className = 'loadBig';
  loadGEl = document.createElement('b'); loadGEl.textContent = '--';
  const unit = document.createElement('span'); unit.textContent = 'g';
  big.append(loadGEl, unit);
  lcHead.appendChild(big);
  secLoad.appendChild(lcHead);
  loadNmEl = document.createElement('div'); loadNmEl.className = 'mini';
  secLoad.appendChild(loadNmEl);

  const lcGrid = document.createElement('div'); lcGrid.className = 'calParams';
  armInp = document.createElement('input'); armInp.type = 'text';
  armInp.value = localStorage.getItem('cal.armMm') || '100';
  armInp.onchange = () => localStorage.setItem('cal.armMm', armInp.value);
  massInp = document.createElement('input'); massInp.type = 'text'; massInp.placeholder = 'mis. 500';
  const l1 = document.createElement('label'); l1.textContent = 'lengan tuas mm';
  const l2 = document.createElement('label'); l2.textContent = 'massa known g';
  lcGrid.append(l1, armInp, l2, massInp);
  secLoad.appendChild(lcGrid);
  const lcBtns = document.createElement('div'); lcBtns.className = 'calBtns';
  mkBtn(lcBtns, 'TARE', () => sendLoadTare());
  mkBtn(lcBtns, 'CAL MASSA', () => {
    const g = parseFloat(massInp.value);
    if (!Number.isFinite(g) || g <= 0) { hint('isi massa known (gram) dulu', false); return; }
    sendLoadScale(g);
  });
  mkBtn(lcBtns, 'RESET PEAK', () => { peakG = 0; }, { write: false });
  secLoad.appendChild(lcBtns);

  /* data log (skripsi) */
  const cap3 = document.createElement('div'); cap3.className = 'calCap'; cap3.textContent = 'data log';
  secLog.appendChild(cap3);
  const recRow = document.createElement('div'); recRow.className = 'calBtns';
  recBtn = mkBtn(recRow, 'REC', () => {
    recOn = !recOn;
    if (recOn && !logRows.length) recT0 = Date.now();
    recBtn.textContent = recOn ? 'STOP' : 'REC';
    hint(recOn ? 'merekam tiap sampel diag (~5 Hz)' : 'rekam berhenti (buffer disimpan)');
    refreshLock();
  }, { write: false });
  mkBtn(recRow, 'EXPORT CSV', exportCsv, { write: false });
  mkBtn(recRow, 'CLEAR', () => {
    logRows = []; recCountEl.textContent = '0 sampel';
    hint('buffer log dikosongkan');
  }, { write: false });
  secLog.appendChild(recRow);
  recCountEl = document.createElement('div'); recCountEl.className = 'mini';
  recCountEl.textContent = '0 sampel';
  secLog.appendChild(recCountEl);

  hintEl = document.createElement('div'); hintEl.className = 'mini';
  hintEl.style.marginTop = '8px';
  body.appendChild(hintEl);

  /* event hardware */
  onHwStatus(ev => {
    if (ev.type === 'diag') {
      lastDiag = ev.diag;
      renderDiag(lastDiag);
      if (recOn && service) pushRow(lastDiag);
    } else if (ev.type === 'cal') {
      lastCal = ev.cal;
      fillParams();
      fillGripper();
    } else if (ev.type === 'ack') {
      if (/^(cal_|load_)/.test(ev.cmd)) hint(`${ev.cmd}: ${ev.msg}`, ev.ok);
      // gripper/servo: hanya kegagalan yang dilaporkan. Slider mengirim
      // belasan perintah per detik, ack sukses tiap kali cuma jadi kedipan.
      else if (!ev.ok && /^(gripper|servo_)/.test(ev.cmd)) hint(`${ev.cmd}: ${ev.msg}`, false);
      if (ev.ok) {
        if (ev.cmd === 'cal_zero' && pendingZero != null) {
          STATE.joints[pendingZero].a = 0;
          applyPose(true);           // dari "feedback": jangan set poseDirty
          pendingZero = null;
        }
        if (['cal_set', 'cal_zero', 'load_tare', 'load_scale'].includes(ev.cmd)) {
          modified = true;
          sendCalGet();
        }
        if (ev.cmd === 'cal_save') modified = false;
        if (ev.cmd === 'cal_reset') { modified = false; sendCalGet(); }
      }
      refreshLock();
    } else if (ev.type === 'estop') {
      refreshLock();
    }
  });

  /* interlock tulis mengikuti status koneksi (tidak ada event connect, jadi
     disinkron ringan tiap 500 ms) */
  built = true;
  uiTimer = setInterval(refreshLock, 500);
  refreshLock();

  /* readout gripper hidup dari feedback 50 Hz, bukan dari poll diag, jadi
     tetap jalan di MONITOR dan tidak menunggu SERVICE. */
  setInterval(refreshGrip, GRIP_UI_MS);
  refreshGrip();
}
