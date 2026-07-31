/* ============================================================================
   Tab CAL: panel komisioning gaya PLC/servo-drive industrial.
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
import {
  isConnected, sendGoto, getActual, onHwStatus,
  sendCalGet, sendCalSet, sendCalZero, sendCalSave, sendCalReset,
  sendDiag, sendLoadTare, sendLoadScale,
} from '../net/bridge.js';

const NSTEP = 4;                    // J1..J4 stepper ber-encoder
const CAL_STEPS = [0.5, 2, 10];     // step jog kalibrasi (derajat)
const DIAG_MS = 200;                // ~5 Hz poll diag saat SERVICE

let service = false;
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
let lampLink, lampMod, lampRec, lampLc;
let infoEl, hintEl, recCountEl, recBtn;
let loadGEl, loadNmEl;
let armInp, massInp;
const paramInp = {};                // ratio[4], speed, accel, kp, deadband
const tmcInp = {};                  // ma[4], hold, microstep
const drvRows = [];                 // refs baris readback driver TMC
let tmcSpread = 1;                  // 0 = stealthChop, 1 = spreadCycle
let setSpreadSeg = null;            // setter segmented STEALTH|SPREAD
let rsenseEl;
const writeBtns = [];               // semua tombol yg butuh interlock SERVICE

/* Ambang arus yang butuh pendinginan serius. Di atas 1000 mA RMS, TMC2209
   wajib heatsink besar + aliran udara (lihat docs/research/). */
const TMC_MA_WARN = 1000;
const TMC_MA_MAX = 1700;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fmt = (v, d = 2) => (v == null || !Number.isFinite(v) ? '--' : v.toFixed(d));

function hint(msg, ok = true) {
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

/* ---------- interlock ---------- */
function canWrite() { return service && isConnected() && !STATE.estop; }
function refreshLock() {
  const dis = !canWrite();
  writeBtns.forEach(b => { b.disabled = dis; });
  lampLink.set(isConnected() ? 'ok' : 'err');
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

/* ---------- mode SERVICE ---------- */
function setService(on, segBtns) {
  service = on;
  segBtns.forEach((b, k) => b.classList.toggle('on', (k === 1) === on));
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

/* ---------- build ---------- */
export function buildCalPanel(body) {
  /* header: mode selector + lamp status */
  const head = document.createElement('div'); head.className = 'calHead';
  const seg = document.createElement('div'); seg.className = 'segsm';
  const segBtns = ['MONITOR', 'SERVICE'].map((lbl, k) => {
    const b = document.createElement('button');
    b.textContent = lbl;
    if (k === 1) b.classList.add('svc');
    if (k === 0) b.classList.add('on');
    b.onclick = () => setService(k === 1, segBtns);
    seg.appendChild(b);
    return b;
  });
  head.appendChild(seg);
  const grow = document.createElement('div'); grow.className = 'grow'; head.appendChild(grow);
  lampLink = mkLamp(head, 'LINK');
  lampMod = mkLamp(head, 'MOD');
  lampRec = mkLamp(head, 'REC');
  body.appendChild(head);

  infoEl = document.createElement('div'); infoEl.className = 'mini';
  infoEl.textContent = 'diag belum ada, aktifkan SERVICE saat terhubung';
  body.appendChild(infoEl);

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
  body.appendChild(stepRow);

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
    body.appendChild(card);
  }

  /* parameter (semantik drive: APPLY=RAM, COMMIT=NVS) */
  const cap1 = document.createElement('div'); cap1.className = 'calCap'; cap1.textContent = 'parameter';
  body.appendChild(cap1);
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
  body.appendChild(grid);
  const pBtns = document.createElement('div'); pBtns.className = 'calBtns';
  mkBtn(pBtns, 'READ', () => { if (!sendCalGet()) hint('belum terhubung', false); }, { write: false });
  mkBtn(pBtns, 'APPLY', applyParams);
  mkBtn(pBtns, 'COMMIT', () => sendCalSave());
  mkBtn(pBtns, 'DEFAULTS', () => {
    if (confirm('Kembalikan SEMUA kalibrasi ke default + hapus NVS?')) sendCalReset();
  }, { danger: true });
  body.appendChild(pBtns);

  /* driver TMC2209: arus & karakter chopper, runtime tanpa re-flash.
     APPLY DRIVER terpisah dari APPLY parameter karena efeknya beda kelas:
     yang ini menyentuh register chip dan sempat mematikan tahap output. */
  const cap4 = document.createElement('div'); cap4.className = 'calCap';
  cap4.textContent = 'driver TMC2209';
  body.appendChild(cap4);

  rsenseEl = document.createElement('div'); rsenseEl.className = 'mini';
  rsenseEl.textContent = 'tekan READ untuk memuat setting driver';
  body.appendChild(rsenseEl);

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
  body.appendChild(tGrid);

  const tBtns = document.createElement('div'); tBtns.className = 'calBtns';
  mkBtn(tBtns, 'APPLY DRIVER', applyTmc);
  body.appendChild(tBtns);

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
  body.appendChild(drvTbl);

  /* load cell (bench torsi) */
  const cap2 = document.createElement('div'); cap2.className = 'calCap'; cap2.textContent = 'load cell';
  body.appendChild(cap2);
  const lcHead = document.createElement('div'); lcHead.className = 'calHead';
  lampLc = mkLamp(lcHead, 'LC');
  const big = document.createElement('div'); big.className = 'loadBig';
  loadGEl = document.createElement('b'); loadGEl.textContent = '--';
  const unit = document.createElement('span'); unit.textContent = 'g';
  big.append(loadGEl, unit);
  lcHead.appendChild(big);
  body.appendChild(lcHead);
  loadNmEl = document.createElement('div'); loadNmEl.className = 'mini';
  body.appendChild(loadNmEl);

  const lcGrid = document.createElement('div'); lcGrid.className = 'calParams';
  armInp = document.createElement('input'); armInp.type = 'text';
  armInp.value = localStorage.getItem('cal.armMm') || '100';
  armInp.onchange = () => localStorage.setItem('cal.armMm', armInp.value);
  massInp = document.createElement('input'); massInp.type = 'text'; massInp.placeholder = 'mis. 500';
  const l1 = document.createElement('label'); l1.textContent = 'lengan tuas mm';
  const l2 = document.createElement('label'); l2.textContent = 'massa known g';
  lcGrid.append(l1, armInp, l2, massInp);
  body.appendChild(lcGrid);
  const lcBtns = document.createElement('div'); lcBtns.className = 'calBtns';
  mkBtn(lcBtns, 'TARE', () => sendLoadTare());
  mkBtn(lcBtns, 'CAL MASSA', () => {
    const g = parseFloat(massInp.value);
    if (!Number.isFinite(g) || g <= 0) { hint('isi massa known (gram) dulu', false); return; }
    sendLoadScale(g);
  });
  mkBtn(lcBtns, 'RESET PEAK', () => { peakG = 0; }, { write: false });
  body.appendChild(lcBtns);

  /* data log (skripsi) */
  const cap3 = document.createElement('div'); cap3.className = 'calCap'; cap3.textContent = 'data log';
  body.appendChild(cap3);
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
  body.appendChild(recRow);
  recCountEl = document.createElement('div'); recCountEl.className = 'mini';
  recCountEl.textContent = '0 sampel';
  body.appendChild(recCountEl);

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
    } else if (ev.type === 'ack') {
      if (/^(cal_|load_)/.test(ev.cmd)) hint(`${ev.cmd}: ${ev.msg}`, ev.ok);
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

  /* lamp LINK & interlock mengikuti status koneksi (tidak ada event connect,
     jadi disinkron ringan tiap 500 ms) */
  uiTimer = setInterval(refreshLock, 500);
  refreshLock();
}
