/* ============================================================================
   BILAH INTERLOCK: rantai izin gerak yang selalu terlihat.

   Kenapa bilah ini ada. Sebelum ini saklar yang saling memblokir tersebar di
   tab yang berbeda: Connect di SETUP, ARM di MOTION, LIVE di CART DAN di
   MOTION. Untuk satu gerakan nyata operator harus menyentuh tiga tab, dan yang
   lebih buruk, tombol yang mati tidak pernah bisa menjelaskan dirinya sendiri.
   Prasyaratnya ada di tab lain daripada tempat konsekuensinya terasa, jadi
   "kenapa tombol ini mati" cuma bisa dijawab dengan mencari, bukan melihat.

   Bilah ini menaruh keempat prasyarat itu berjejer dalam satu baris yang
   terlihat di mode mana pun:

       LINK -> DRIVER -> ARM -> LIVE

   Rantai mati-ke-kanan TIDAK dipaksakan di sini dengan kode tambahan. Dia
   muncul sendiri karena net/liveLink.js memang sudah melucuti ARM dan LIVE
   begitu link atau driver hilang. Yang dikerjakan berkas ini cuma membaca dan
   menggambar.

   ATURAN YANG TIDAK BOLEH DILANGGAR DI SINI: tidak ada satu pun keputusan
   interlock yang lahir di berkas ini. Semua alasan penolakan datang dari
   blockedReason() di net/liveLink.js, yang sudah memeriksa E-STOP, link,
   driver, dan ARM dengan urutan yang sama persis dengan rantai di atas.
   Menyalin urutan itu ke sini berarti membuat tempat kedua yang bisa berbeda
   pendapat dengan jalur kirim yang sebenarnya.

   Kenapa ARM boleh naik ke sini. Aturan lamanya: ARM tidak boleh dinyalakan
   dari tempat yang tidak menampilkan satu pun angka umpan balik, karena
   menghidupkan interlock tanpa melihat posisi nyata lengan adalah menebak.
   Karena itu bilah ini ikut memajang strip sudut aktual per sendi, lengkap
   dengan tanda untuk sendi yang angkanya BUKAN hasil ukur (J5/J6 pot servo
   yang kalibrasinya masih placeholder). Tanpa strip itu ARM harus kembali ke
   panel rutin.

   E-STOP sengaja TIDAK diduplikasi ke sini. Tombolnya tinggal di footer kartu
   yang sama, cuma berjarak sekitar 40 px; dua tombol E-STOP adalah cacat
   keselamatan, bukan kemudahan. Yang dilakukan bilah saat E-STOP tertekan
   adalah memerah seluruhnya dan menyebutkannya di baris alasan.
   ========================================================================== */
import { STATE } from '../config/arm.js';
import {
  connect, disconnect, isConnected, isActive, onHwStatus,
  isDriverOk, getDriverResets, getActual, isFbTrusted,
  getNet, isSocketOpen, downloadRttCsv,
} from '../net/bridge.js';
import {
  loadLink, saveLink, linkUrl, displayUrl, localBlockedReason,
} from '../net/linkConfig.js';
import {
  isArmed, isLive, setArmed, setLive, getProfile,
  blockedReason, armVetoReason, onLiveChange,
} from '../net/liveLink.js';
import { SPEED } from '../config/routines.js';
import { setCalService, isCalService } from './calPanel.js';

/* Tik pembaca, BUKAN pengirim. Aturan "satu setInterval pengirim di seluruh
   studio" (lihat net/liveLink.js) tetap utuh: tidak ada satu byte pun yang
   berangkat dari sini. Timer dibutuhkan karena dua hal tidak memancarkan event:
   sudut aktual (datang tiap frame feedback tanpa event sendiri) dan STATE.estop
   saat tombol E-STOP lokal ditekan (main.js mengubahnya langsung). */
const UI_MS = 200;
/* Pesan hasil klik bertahan sebentar sebelum baris alasan kembali menceritakan
   keadaan sekarang. Tanpa jeda ini jawaban atas klik langsung tertimpa tik
   berikutnya dan operator tidak sempat membacanya. */
const SAY_MS = 6000;

const NJ = 6;
let els = null;
let sayUntil = 0;
let sayText = '';
let sayTone = '';

function mkLamp(parent, key, label, title, onClick) {
  const b = document.createElement('button');
  b.className = 'ilLamp'; b.dataset.k = key; b.title = title;
  b.innerHTML = `<i class="pd"></i><span>${label}</span>`;
  b.onclick = onClick;
  parent.appendChild(b);
  return b;
}
function arrow(parent) {
  const s = document.createElement('span'); s.className = 'ilArrow'; s.textContent = '▸';
  parent.appendChild(s);
}
function say(msg, tone = '') {
  sayText = msg || ''; sayTone = tone;
  sayUntil = msg ? Date.now() + SAY_MS : 0;
  draw();
}

/* ---------------- gambar ---------------- */
function setSt(el, st) { el.dataset.st = st; }

function drawLamps() {
  const conn = isConnected();
  const drvOk = isDriverOk();
  const resets = getDriverResets();
  const armed = isArmed();

  /* LINK tetap jujur saat E-STOP: socketnya memang masih terbuka. Yang merah
     karena E-STOP adalah bilahnya, bukan lampu yang tidak ada hubungannya. */
  const net = getNet();
  setSt(els.link, conn ? (net.level === 'putus' ? 'err' : net.level === 'buruk' ? 'warn' : 'ok')
    : isActive() ? 'warn' : '');
  /* Driver tidak punya pendapat selama link mati, dan menampilkan "ok" di situ
     berarti menjanjikan sesuatu yang tidak pernah diperiksa. */
  setSt(els.drv, !conn ? '' : !drvOk ? 'err' : resets > 0 ? 'warn' : 'ok');
  setSt(els.arm, armed ? 'ok' : (armVetoReason() ? 'err' : ''));
  setSt(els.live, isLive() ? 'ok' : '');

  els.link.querySelector('span').textContent = conn ? (net.mode === 'cloud' ? 'CLOUD' : 'LINK')
    : isSocketOpen() && net.mode === 'cloud' ? 'RELAY' : isActive() ? 'CARI' : 'LINK';
  els.arm.querySelector('span').textContent = armed ? 'ARMED' : 'ARM';
  els.live.querySelector('span').textContent = isLive() ? 'LIVE' : 'live';
  els.drv.querySelector('span').textContent = resets > 0 ? `DRV ${resets}x` : 'DRIVER';
}

function drawWhy() {
  const why = blockedReason();
  if (sayUntil && Date.now() < sayUntil) {
    els.why.textContent = sayText;
    els.why.dataset.tone = sayTone;
  } else {
    sayUntil = 0;
    els.why.dataset.tone = why ? 'bad' : isLive() ? 'warn' : '';
    els.why.textContent = why || (isLive()
      ? `LIVE: lengan mengikuti pose twin. Target merayap ${SPEED[getProfile()].speed} deg/detik, `
        + 'jadi lengan tertinggal kalau gizmo ditarik cepat.'
      : 'Siap. Semua prasyarat gerak terpenuhi, LIVE tinggal dinyalakan.');
  }

  /* Kunci home ulang berdiri SENDIRI, bukan bagian rantai. Dia menolak
     transisi ARM (veto di runner), bukan pengiriman, jadi blockedReason() tidak
     menyebutnya dan memang tidak seharusnya. Tanpa baris terpisah ini lampu ARM
     merah tanpa alasan yang bisa dibaca dari tempatnya. */
  const veto = isArmed() ? null : armVetoReason();
  els.lock.textContent = veto || '';
  els.lock.style.display = veto ? '' : 'none';
}

function drawActual() {
  const a = getActual();
  let adaTakTerukur = false;
  for (let i = 0; i < NJ; i++) {
    const c = els.act[i];
    const trust = isFbTrusted(i);
    if (!trust) adaTakTerukur = true;
    const v = a && Number.isFinite(a[i]) ? a[i] : null;
    c.v.textContent = v == null ? '--' : v.toFixed(1) + (trust ? '' : '*');
    c.v.classList.toggle('na', v == null);
    c.v.classList.toggle('untrust', !trust);
  }
  els.actNote.style.display = adaTakTerukur ? '' : 'none';
}

const fmtMs = (v) => (Number.isFinite(v) ? `${Math.round(v)}` : '?');
const OWN_TXT = { local: 'jaringan lokal', cloud: 'cloud', none: 'bebas' };

/* Baris kualitas link. Semua angkanya hasil ukur ping/pong ke ESP32 (lewat
   relay kalau CLOUD), jadi yang terbaca di sini adalah latensi yang dialami
   perintah gerak, termasuk antrean dan beban loop kendali firmware. */
function drawNet() {
  const n = getNet();
  const show = isSocketOpen();
  els.net.style.display = show ? '' : 'none';
  if (!show) return;
  els.net.dataset.lv = n.level;
  const jalur = n.mode === 'cloud' ? 'CLOUD' : 'LOKAL';
  if (n.mode === 'cloud' && !n.relay.device) {
    els.net.innerHTML = `<b>${jalur}</b> relay tersambung, <b class="lv">lengan offline</b>: `
      + 'ESP32 belum menelepon relay (cek WiFi/hotspot lengan, atau CLOUD_HOST di wifi_secrets.h).';
    return;
  }
  const parts = [
    `<b>${jalur}</b> <b class="lv">${n.label}</b>`,
    `RTT ${fmtMs(n.p50)} ms (p95 ${fmtMs(n.p95)}, jitter ${fmtMs(n.jitter)})`,
  ];
  if (n.fbAge != null) parts.push(`feedback ${(n.fbAge / 1000).toFixed(1)} s lalu`);
  if (n.lease) parts.push(`lease ${(n.lease / 1000).toFixed(1)} s`);
  parts.push(`kendali: ${n.mode === 'cloud' && n.relay.ctrl === 'other' ? 'browser lain' : OWN_TXT[n.own] || n.own}`);
  if (n.hold && isArmed()) parts.push('<b class="lv">direm (lease habis)</b>');
  if (n.mode === 'cloud' && n.relay.role === 'viewer') parts.push('<b>token lihat saja</b>');
  els.net.innerHTML = parts.join(' · ') + ` · <button type="button" data-csv>log RTT (${n.logN})</button>`;
}

function draw() {
  if (!els) return;
  els.bar.classList.toggle('trip', !!STATE.estop);
  drawLamps();
  drawWhy();
  drawNet();
  drawActual();
  els.svcSeg.forEach((b, k) => b.classList.toggle('on', (k === 1) === isCalService()));
}

/* ---------------- build ---------------- */
/* Konfigurasi jalur hidup di net/linkConfig.js dan dipakai bersama halaman HP. */
const cfg = loadLink();

function sambung() {
  const u = linkUrl(cfg);
  if (!u) {
    els.pop.style.display = '';
    say('Jalur CLOUD belum lengkap: isi host relay dan token operator.', 'bad');
    return;
  }
  const blok = cfg.mode === 'local' ? localBlockedReason(u) : null;
  connect(u);
  say(blok || `Menyambung ke ${displayUrl(u)} ...`, blok ? 'warn' : '');
}

export function buildInterlockBar() {
  const bar = document.createElement('div'); bar.className = 'ilBar';

  /* baris rantai */
  const chain = document.createElement('div'); chain.className = 'ilChain';

  const link = mkLamp(chain, 'link', 'LINK', 'sambungkan / putuskan (jalur di tombol ▾)', () => {
    if (isActive()) { disconnect(); say('Link diputus.'); return; }
    sambung();
  });
  const edit = document.createElement('button');
  edit.className = 'ilEdit'; edit.textContent = '▾'; edit.title = 'ubah alamat bridge';
  edit.onclick = () => {
    const buka = els.pop.style.display === 'none';
    els.pop.style.display = buka ? '' : 'none';
    if (buka) (cfg.mode === 'cloud' ? els.relay : els.url).focus();
  };
  chain.appendChild(edit);
  arrow(chain);

  const drv = mkLamp(chain, 'drv', 'DRIVER', 'status verifikasi driver TMC2209',
    () => {
      if (!isConnected()) { say('Belum terhubung, status driver belum bisa dibaca.', 'bad'); return; }
      if (!isDriverOk()) {
        say('Driver TMC belum siap, tahap output dimatikan. Periksa PSU 12 V; '
          + 'firmware mencoba memulihkan tiap 5 detik.', 'bad');
      } else if (getDriverResets() > 0) {
        say(`Driver sempat hilang/reset ${getDriverResets()}x sejak ESP32 menyala dan sudah `
          + 'dikonfigurasi ulang otomatis. Gerak yang sedang berjalan saat itu TIDAK dilanjutkan.', 'warn');
      } else {
        say('Keempat driver terverifikasi, belum pernah kehilangan VM sejak ESP32 menyala.', 'ok');
      }
    });
  arrow(chain);

  const arm = mkLamp(chain, 'arm', 'ARM', 'interlock: tanpa ini tidak ada perintah gerak yang berangkat',
    () => {
      if (isArmed()) { setArmed(false); say('Dilucuti. Tidak ada perintah yang dikirim.'); return; }
      const veto = setArmed(true);
      if (veto) { say(veto, 'bad'); return; }
      say('ARMED. Perintah gerak sekarang sampai ke lengan.', 'warn');
    });
  arrow(chain);

  const live = mkLamp(chain, 'live', 'live', 'lengan mengikuti pose twin terus menerus',
    () => {
      if (isLive()) { setLive(false); say('LIVE mati. Perubahan pose hanya mengubah target di layar.'); return; }
      const why = setLive(true);
      if (why) { say(why, 'bad'); return; }
      say('LIVE: lengan sekarang mengikuti pose twin, termasuk gizmo TCP.', 'warn');
    });

  const grow = document.createElement('div'); grow.className = 'grow';
  chain.appendChild(grow);

  /* MONITOR/SERVICE sengaja BUKAN mata rantai: izin tulis kalibrasi bukan
     prasyarat gerak, dan menaruhnya dalam rantai akan menyiratkan bahwa lengan
     tidak mau bergerak selama SERVICE mati. */
  const svc = document.createElement('div'); svc.className = 'segsm ilSvc';
  const svcSeg = ['MON', 'SVC'].map((lbl, k) => {
    const b = document.createElement('button'); b.textContent = lbl;
    if (k === 1) b.classList.add('svc');
    if (k === 0) b.classList.add('on');
    b.onclick = () => { setCalService(k === 1); draw(); };
    svc.appendChild(b);
    return b;
  });
  chain.appendChild(svc);
  bar.appendChild(chain);

  /* popover jalur: LOKAL (ESP32 langsung) atau CLOUD (lewat relay) */
  const pop = document.createElement('div'); pop.className = 'ilPop'; pop.style.display = 'none';
  const modeSeg = document.createElement('div'); modeSeg.className = 'segsm';
  const modeBtns = [['local', 'LOKAL'], ['cloud', 'CLOUD']].map(([k, lbl]) => {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = lbl;
    b.onclick = () => { cfg.mode = k; saveLink(cfg); drawMode(); };
    modeSeg.appendChild(b);
    return [k, b];
  });
  pop.appendChild(modeSeg);

  const field = (type, ph, val, onIn) => {
    const i = document.createElement('input'); i.type = type; i.placeholder = ph; i.value = val || '';
    i.autocomplete = 'off'; i.spellcheck = false;
    i.oninput = () => { onIn(i.value.trim()); saveLink(cfg); };
    i.onkeydown = (e) => { if (e.key === 'Enter') { pop.style.display = 'none'; sambung(); } };
    return i;
  };
  const boxLocal = document.createElement('div');
  const url = field('text', 'ws://192.168.1.8:81', cfg.localUrl, (v) => { cfg.localUrl = v; });
  url.id = 'wsUrl';
  boxLocal.appendChild(url);
  const hintLocal = document.createElement('div'); hintLocal.className = 'mini';
  hintLocal.innerHTML = 'Bawaan <code>ws://192.168.1.8:81</code> = ESP32 di WiFi rumah (halaman bawaannya '
    + '<code>http://192.168.1.8/</code>). Alternatif: <code>ws://armbot.local:81</code> (mDNS, cuma jalan '
    + 'dari dalam WiFi yang sama), <code>ws://192.168.4.1:81</code> (ESP32 jatuh ke mode AP), atau '
    + '<code>ws://localhost:8765</code> sesudah <code>python -m arm.bridge --simulate</code>. '
    + 'Hanya jalan kalau studio dibuka lewat <code>http://</code>.';
  boxLocal.appendChild(hintLocal);

  const boxCloud = document.createElement('div');
  const relayIn = field('text', 'armbot-relay.namamu.workers.dev', cfg.relay, (v) => { cfg.relay = v; });
  const armIn = field('text', 'armbot', cfg.armId, (v) => { cfg.armId = v || 'armbot'; });
  armIn.style.maxWidth = '90px';
  const row = document.createElement('div'); row.className = 'ilRow'; row.append(relayIn, armIn);
  const tokIn = field('password', 'token operator', cfg.token, (v) => { cfg.token = v; });
  boxCloud.append(row, tokIn);
  const hintCloud = document.createElement('div'); hintCloud.className = 'mini';
  hintCloud.innerHTML = 'Lewat relay Cloudflare: bisa dari mana saja, termasuk dari twin yang di-host di '
    + '<code>https://</code>. Lengan harus tersambung ke WiFi yang punya internet (mis. hotspot HP) dan '
    + 'firmware-nya diisi <code>CLOUD_HOST</code>. Latensi internet ditangani otomatis: LIVE dan RUN '
    + 'ditahan kalau link memburuk, lengan direm firmware kalau perintah berhenti datang.';
  boxCloud.appendChild(hintCloud);
  pop.append(boxLocal, boxCloud);

  const go = document.createElement('div'); go.className = 'btns ilGo';
  const goBtn = document.createElement('button'); goBtn.type = 'button'; goBtn.textContent = 'sambung';
  goBtn.onclick = () => { pop.style.display = 'none'; sambung(); };
  go.appendChild(goBtn);
  pop.appendChild(go);
  bar.appendChild(pop);

  function drawMode() {
    modeBtns.forEach(([k, b]) => b.classList.toggle('on', k === cfg.mode));
    boxLocal.style.display = cfg.mode === 'local' ? '' : 'none';
    boxCloud.style.display = cfg.mode === 'cloud' ? '' : 'none';
  }
  drawMode();

  /* baris alasan + baris kunci */
  const why = document.createElement('div'); why.className = 'ilWhy';
  bar.appendChild(why);
  const lock = document.createElement('div'); lock.className = 'ilLock'; lock.style.display = 'none';
  bar.appendChild(lock);

  /* strip sudut aktual: inilah yang membuat ARM boleh ada di bilah */
  const actWrap = document.createElement('div'); actWrap.className = 'ilAct';
  const act = STATE.joints.slice(0, NJ).map((j) => {
    const cell = document.createElement('div'); cell.className = 'ilCell';
    const k = document.createElement('span'); k.className = 'k'; k.textContent = j.id;
    const v = document.createElement('span'); v.className = 'v na'; v.textContent = '--';
    cell.append(k, v);
    actWrap.appendChild(cell);
    return { v };
  });
  bar.appendChild(actWrap);
  const actNote = document.createElement('div'); actNote.className = 'ilNote'; actNote.style.display = 'none';
  actNote.textContent = '* bukan hasil ukur: kalibrasi pot servo masih placeholder, '
    + 'angkanya adalah sudut yang diperintahkan.';
  bar.appendChild(actNote);

  /* status hardware. Id dipertahankan persis (#bridgeDrv/#bridgeFault/#bridgeAck):
     dulu bertempat di tab SETUP, sekarang duduk tepat di bawah lampu DRIVER
     supaya tidak ada dua tempat yang bisa berbeda pendapat soal driver. */
  const stDrv = document.createElement('div'); stDrv.className = 'mini'; stDrv.id = 'bridgeDrv';
  const stFault = document.createElement('div'); stFault.className = 'mini'; stFault.id = 'bridgeFault';
  stFault.style.color = 'var(--over)';
  const stAck = document.createElement('div'); stAck.className = 'mini'; stAck.id = 'bridgeAck';
  bar.append(stDrv, stFault, stAck);

  /* baris kualitas link, tepat di atas baris alasan */
  const net = document.createElement('div'); net.className = 'ilNet'; net.style.display = 'none';
  net.addEventListener('click', (e) => {
    if (!e.target.closest('[data-csv]')) return;
    const n = downloadRttCsv();
    say(`Log RTT diunduh (${n} sampel).`, 'ok');
  });
  bar.insertBefore(net, why);

  els = { bar, link, drv, arm, live, why, lock, act, actNote, url, relay: relayIn, pop, svcSeg, net };

  onHwStatus(ev => {
    if (ev.type === 'fault') {
      const bad = ev.fault.map((f, i) => (f ? 'J' + (i + 1) : null)).filter(Boolean);
      stFault.textContent = bad.length
        ? '⚠ encoder fault: ' + bad.join(', ') + ' (fallback open-loop)' : '';
    } else if (ev.type === 'ack') {
      stAck.textContent = 'ack ' + ev.cmd + ': ' + ev.msg;
      stAck.style.color = ev.ok ? '' : 'var(--over)';
    } else if (ev.type === 'drv') {
      /* Cacah pemulihan sengaja ikut ditampilkan walau driver sudah pulih.
         Pemulihan otomatis membuat gejalanya hilang dari layar dalam hitungan
         detik, dan tanpa angka ini "PSU sempat mati sejam" tidak meninggalkan
         bekas apa pun kecuali arus di alat ukur. */
      if (!ev.ok) {
        stDrv.style.color = 'var(--over)';
        stDrv.textContent = '⛔ driver TMC belum siap, tahap output dimatikan. '
          + 'Periksa PSU 12 V; firmware mencoba memulihkan tiap 5 detik.';
      } else if (ev.resets > 0) {
        stDrv.style.color = 'var(--warn)';
        stDrv.textContent = `⚠ driver sempat hilang/reset ${ev.resets}x sejak ESP32 menyala `
          + 'dan sudah dikonfigurasi ulang otomatis. Target dibekukan tiap kali, '
          + 'jadi gerak yang sedang berjalan saat itu TIDAK dilanjutkan.';
      } else {
        stDrv.textContent = '';
      }
    } else if (ev.type === 'link' && !ev.up) {
      stDrv.textContent = '';
    }
    draw();
  });
  onLiveChange(({ why: w }) => { if (w) say(w, 'warn'); else draw(); });
  setInterval(draw, UI_MS);
  draw();

  return bar;
}
