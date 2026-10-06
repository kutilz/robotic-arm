/* ============================================================================
   Rantai izin gerak versi HP: LINK -> DRIVER -> ARM -> LIVE.

   Ini bukan ringkasan kosmetik dari bilah interlock desktop. Sifat yang
   dipertahankan persis satu, dan itu yang membuat bilahnya ada sama sekali:
   ALASAN LAMPU MATI DIAMBIL DARI blockedReason() DI net/liveLink.js, yaitu
   fungsi yang sama yang dipakai jalur kirim. Jadi tidak mungkin ada keadaan di
   mana layar bilang boleh gerak sementara pengiriman menolak, atau sebaliknya.
   Modul ini tidak memutuskan apa apa sendiri; dia cuma menggambar dan meneruskan
   ketukan.

   Yang khas HP: menekan lampu yang MATI tidak melakukan apa apa selain
   menampilkan alasannya sebagai toast. Di desktop alasan itu selalu terlihat di
   baris di bawah bilah; di layar 390 px baris itu tidak muat, jadi alasannya
   dimunculkan saat ditanya. Yang tidak boleh terjadi adalah tombol yang diam
   saja waktu ditekan, karena itulah yang membuat operator menebak nebak.
   ========================================================================== */
import { STATE } from '../config/arm.js';
import {
  connect, disconnect, isConnected, isDriverOk, getDriverResets, getUrl, onHwStatus,
  getNet, isSocketOpen,
} from '../net/bridge.js';
import {
  loadLink, saveLink, linkUrl, displayUrl, localBlockedReason,
} from '../net/linkConfig.js';
import {
  isArmed, setArmed, isLive, setLive, blockedReason, armVetoReason, onLiveChange,
} from '../net/liveLink.js';
import { el, toast, openModal, closeModal, btn, note, sec } from './ui.js';

/* Pilihan jalur (LOKAL/CLOUD) + alamat disimpan di HP lewat net/linkConfig.js,
   yang sama dengan halaman desktop. Ini SATU SATUNYA hal yang halaman mobile
   simpan di localStorage, dan sengaja: mengetik ulang alamat dan token di
   papan ketik layar tiap kali halaman dibuka adalah pajak yang tidak
   menghasilkan keselamatan apa pun. Yang TIDAK disimpan di sini adalah apa pun
   yang berbau pose atau kalibrasi; alasannya di kepala main.js. */

/* Kandidat alamat, urut dari yang paling sering benar. Alamat ESP32 di WiFi
   rumah tidak dijamin tetap (firmware tidak memanggil WiFi.config, jadi IP-nya
   pemberian DHCP), karena itu mDNS ikut ditawarkan meskipun cuma terjawab dari
   dalam WiFi yang sama. 192.168.4.1 adalah mode AP, yaitu saat ESP32 gagal
   masuk WiFi dan membuat hotspot sendiri. */
const CANDIDATES = [
  ['ws://192.168.1.8:81', 'ESP32 di WiFi rumah (bawaan)'],
  ['ws://armbot.local:81', 'mDNS, hanya dari dalam WiFi yang sama'],
  ['ws://192.168.4.1:81', 'ESP32 mode AP (hotspot sendiri)'],
];

/** URL dari jalur tersimpan; null kalau jalur CLOUD belum lengkap. */
export function savedUrl() { return linkUrl(loadLink()); }
/** Alamat untuk ditampilkan (token disensor). */
export function shownUrl() { return displayUrl(isSocketOpen() ? getUrl() : savedUrl() || ''); }

let chainEl = null;
const lamps = {};

/** Lampu yang mati menjelaskan dirinya. Dipanggil saat lampu ditekan, bukan
 *  digambar terus menerus: di layar HP tidak ada tempat untuk baris alasan
 *  permanen, dan alasan yang dipotong elipsis lebih buruk daripada tidak ada. */
function explain(which) {
  if (which === 'link') {
    const n = getNet();
    if (isConnected()) {
      const rtt = Number.isFinite(n.p95) ? `, RTT p95 ${Math.round(n.p95)} ms (${n.label})` : '';
      toast(`Tersambung ${n.mode === 'cloud' ? 'lewat CLOUD' : 'LOKAL'} ke ${displayUrl(getUrl())}${rtt}. `
        + 'Tekan lagi untuk memutus.', n.level === 'buruk' || n.level === 'putus' ? 'warn' : 'ok');
    } else if (isSocketOpen() && n.mode === 'cloud') {
      toast('Relay tersambung, tapi lengannya belum: ESP32 belum menelepon relay '
        + '(cek WiFi/hotspot lengan).', 'warn');
    } else {
      toast('Belum tersambung. Tekan tombol koneksi di kanan atas untuk memilih jalur.', 'warn');
    }
    return;
  }
  if (which === 'driver') {
    const rst = getDriverResets();
    if (isDriverOk()) {
      toast(rst
        ? `Keempat driver TMC terverifikasi. Firmware sempat memulihkannya ${rst} kali sejak boot.`
        : 'Keempat driver TMC terverifikasi.', rst ? 'warn' : 'ok');
    } else {
      toast('Driver TMC belum siap. Periksa PSU 12 V: tahap output dimatikan, '
        + 'jadi goto ditolak firmware. Pemulihan dicoba tiap 5 detik.', 'bad');
    }
    return;
  }
  if (which === 'arm') {
    /* Veto DIDAHULUKAN. Veto adalah penguncian yang butuh tindakan fisik
       (home ulang manual), bukan sekadar prasyarat yang akan hilang sendiri,
       jadi menampilkan "belum terhubung" di atasnya akan menyuruh operator
       memperbaiki hal yang salah. */
    const veto = armVetoReason();
    if (veto) { toast(veto, 'bad'); return; }
    const why = blockedReason();
    toast(why || (isArmed() ? 'ARMED. Perintah gerak boleh berangkat.' : 'Siap di-ARM.'),
      why ? 'warn' : 'ok');
    return;
  }
  const why = blockedReason();
  toast(why || (isLive()
    ? `LIVE: lengan mengikuti pose di layar, dialirkan bertahap ${getNet().mode === 'cloud' ? '5' : '20'} Hz.`
    : 'LIVE mati. Nyalakan supaya jog dan pose preset benar benar dikirim.'),
  why ? 'warn' : 'ok');
}

function tap(which) {
  if (which === 'link') {
    if (isConnected() || isSocketOpen()) { disconnect(); toast('Koneksi diputus.', 'warn'); return; }
    const u = savedUrl();
    if (!u) { toast('Jalur CLOUD belum lengkap. Buka pengaturan koneksi di kanan atas.', 'bad'); return; }
    connect(u);
    toast(localBlockedReason(u) || `Menyambung ke ${displayUrl(u)}...`, localBlockedReason(u) ? 'warn' : '');
    return;
  }
  if (which === 'driver') { explain('driver'); return; }
  if (which === 'arm') {
    if (isArmed()) { setArmed(false); toast('ARM dilucuti.', 'warn'); return; }
    const why = setArmed(true);
    if (why) toast(why, 'bad'); else toast('ARMED.', 'ok');
    return;
  }
  if (isLive()) { setLive(false); toast('LIVE mati.', 'warn'); return; }
  const why = setLive(true);
  if (why) toast(why, 'bad');
  else toast('LIVE menyala: lengan mengikuti layar.', 'ok');
}

export function drawChain() {
  if (!chainEl) return;
  const armLocked = !!armVetoReason();
  const st = {
    link: isConnected(),
    driver: isConnected() && isDriverOk(),
    arm: isArmed(),
    live: isLive(),
  };
  for (const k of Object.keys(lamps)) {
    const on = st[k];
    /* Merah dipakai untuk "seharusnya hidup tapi gagal", bukan untuk "belum
       giliran". DRIVER merah hanya kalau link sudah ada: driver yang belum bisa
       ditanya karena belum tersambung bukan driver yang rusak. */
    const bad = (k === 'driver' && isConnected() && !isDriverOk())
      || (k === 'arm' && armLocked);
    lamps[k].className = 'mLamp' + (on ? ' on' : '') + (bad ? ' bad' : '');
  }
  chainEl.classList.toggle('tripped', STATE.estop);
}

export function buildChain(node) {
  chainEl = node;
  node.innerHTML = '';
  for (const [k, lab] of [['link', 'LINK'], ['driver', 'DRIVER'], ['arm', 'ARM'], ['live', 'LIVE']]) {
    const b = el('button', 'mLamp', `<i></i><span>${lab}</span>`);
    b.type = 'button';
    /* Sekali tekan = ubah keadaan; tekan lama = jelaskan. Dipisah karena dua
       duanya sering dibutuhkan justru saat lampunya mati, dan menggabungkannya
       berarti operator harus mengubah keadaan dulu untuk bisa membaca alasan. */
    let long = null, didLong = false;
    b.addEventListener('pointerdown', () => {
      didLong = false;
      long = setTimeout(() => { didLong = true; explain(k); }, 450);
    });
    const clear = () => clearTimeout(long);
    b.addEventListener('pointerup', clear);
    b.addEventListener('pointerleave', clear);
    b.addEventListener('pointercancel', clear);
    b.onclick = () => { if (!didLong) tap(k); };
    lamps[k] = b;
    node.appendChild(b);
  }
  drawChain();
}

/* ---------------- lembar koneksi ---------------- */
export function openLinkSheet(onChanged) {
  openModal('Koneksi', (body) => {
    const cfg = loadLink();
    const input = (type, val, ph, onIn) => {
      const i = el('input', 'mInput');
      i.type = type; i.value = val || ''; i.placeholder = ph;
      i.autocapitalize = 'off'; i.autocomplete = 'off'; i.spellcheck = false;
      i.oninput = () => { onIn(i.value.trim()); saveLink(cfg); };
      return i;
    };

    /* Jalur. LOKAL = ESP32 langsung (cepat, tapi hanya dari WiFi yang sama dan
       hanya dari halaman http://). CLOUD = lewat relay (dari mana saja). */
    const b0 = sec(body, 'jalur');
    const seg = el('div', 'mSeg');
    const segBtn = {};
    for (const [k, lbl] of [['local', 'LOKAL'], ['cloud', 'CLOUD']]) {
      const b = el('button', '', lbl);
      b.type = 'button';
      b.onclick = () => { cfg.mode = k; saveLink(cfg); drawMode(); };
      segBtn[k] = b;
      seg.appendChild(b);
    }
    b0.appendChild(seg);

    const boxL = el('div');
    const bl = sec(boxL, 'alamat ESP32');
    const inp = input('text', cfg.localUrl, 'ws://192.168.1.8:81', (v) => { cfg.localUrl = v; });
    bl.appendChild(inp);
    const b2 = sec(boxL, 'pilihan cepat');
    CANDIDATES.forEach(([u, why]) => {
      const c = el('button', 'mChip', `<b>${u}</b><span>${why}</span>`);
      c.type = 'button';
      c.style.flex = '1 1 100%';
      c.onclick = () => { inp.value = u; cfg.localUrl = u; saveLink(cfg); };
      b2.appendChild(c);
    });
    note(boxL, 'Jalur lokal butuh halaman ini dibuka lewat http:// dari jaringan yang sama: '
      + 'halaman https:// tidak boleh membuka ws:// (mixed content diblokir peramban) '
      + 'sedangkan ESP32 tidak punya TLS.', 'warn');
    note(boxL, 'Kalau ESP32 gagal masuk WiFi, dia membuat hotspot sendiri dan alamatnya '
      + 'jadi 192.168.4.1. Dari sana halaman ini tidak bisa dimuat (laptop tidak ikut pindah), '
      + 'jadi muat halamannya dulu baru pindah WiFi.');
    body.appendChild(boxL);

    const boxC = el('div');
    const bc = sec(boxC, 'relay');
    bc.appendChild(input('text', cfg.relay, 'armbot-relay.namamu.workers.dev', (v) => { cfg.relay = v; }));
    bc.appendChild(input('text', cfg.armId, 'id lengan (armbot)', (v) => { cfg.armId = v || 'armbot'; }));
    bc.appendChild(input('password', cfg.token, 'token operator', (v) => { cfg.token = v; }));
    note(boxC, 'Lewat relay Cloudflare: jalan dari jaringan mana pun, termasuk data seluler, '
      + 'dan dari halaman https://. Lengan harus tersambung ke WiFi yang punya internet '
      + '(mis. hotspot HP). Kalau link memburuk LIVE dan RUN ditahan otomatis, dan firmware '
      + 'merem lengan sendiri kalau perintah berhenti datang.');
    body.appendChild(boxC);

    function drawMode() {
      segBtn.local.classList.toggle('on', cfg.mode === 'local');
      segBtn.cloud.classList.toggle('on', cfg.mode === 'cloud');
      boxL.hidden = cfg.mode !== 'local';
      boxC.hidden = cfg.mode !== 'cloud';
    }
    drawMode();

    const b3 = sec(body, '');
    b3.appendChild(btn('SAMBUNG', 'primary', () => {
      const u = linkUrl(cfg);
      if (!u) { toast('Isi host relay dan token operator dulu.', 'bad'); return; }
      if (!/^wss?:\/\/.+/i.test(u)) { toast('Alamat harus diawali ws:// atau wss://', 'bad'); return; }
      saveLink(cfg);
      connect(u);
      closeModal();
      const blok = localBlockedReason(u);
      toast(blok || `Menyambung ke ${displayUrl(u)}...`, blok ? 'warn' : '');
      onChanged?.();
    }));
    if (isConnected() || isSocketOpen()) {
      b3.appendChild(btn('PUTUS', 'danger', () => {
        disconnect(); closeModal(); toast('Koneksi diputus.', 'warn'); onChanged?.();
      }));
    }
  });
}

/** pasang pelanggan supaya rantai selalu menggambar keadaan yang sebenarnya. */
export function watchChain(onEvent) {
  onHwStatus((ev) => { drawChain(); onEvent?.(ev); });
  onLiveChange(({ why }) => {
    drawChain();
    /* Alasan yang datang dari liveLink (bukan dari ketukan operator) adalah
       satu satunya cara operator tahu bahwa LIVE mati sendiri, mis. karena
       driver hilang di tengah gerak. */
    if (why) toast(why, 'warn');
  });
}
