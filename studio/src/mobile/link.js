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
} from '../net/bridge.js';
import {
  isArmed, setArmed, isLive, setLive, blockedReason, armVetoReason, onLiveChange,
} from '../net/liveLink.js';
import { el, toast, openModal, closeModal, btn, note, sec } from './ui.js';

/* Alamat bridge disimpan di HP. Ini SATU SATUNYA hal yang halaman mobile
   simpan di localStorage, dan sengaja: mengetik ulang `ws://192.168.1.8:81` di
   papan ketik layar tiap kali halaman dibuka adalah pajak yang tidak
   menghasilkan keselamatan apa pun. Yang TIDAK disimpan di sini adalah apa pun
   yang berbau pose atau kalibrasi; alasannya di kepala main.js. */
const LS_URL = 'armpocket.ws.v1';

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

export function savedUrl() {
  try { return localStorage.getItem(LS_URL) || getUrl(); } catch { return getUrl(); }
}
function saveUrl(u) {
  try { localStorage.setItem(LS_URL, u); } catch { /* mode privat: alamat tidak persisten */ }
}

let chainEl = null;
const lamps = {};

/** Lampu yang mati menjelaskan dirinya. Dipanggil saat lampu ditekan, bukan
 *  digambar terus menerus: di layar HP tidak ada tempat untuk baris alasan
 *  permanen, dan alasan yang dipotong elipsis lebih buruk daripada tidak ada. */
function explain(which) {
  if (which === 'link') {
    toast(isConnected()
      ? `Tersambung ke ${getUrl()}. Tekan lagi untuk memutus.`
      : 'Belum tersambung. Tekan tombol koneksi di kanan atas untuk mengatur alamat.',
    isConnected() ? 'ok' : 'warn');
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
    ? 'LIVE: lengan mengikuti pose di layar, dialirkan bertahap 20 Hz.'
    : 'LIVE mati. Nyalakan supaya jog dan pose preset benar benar dikirim.'),
  why ? 'warn' : 'ok');
}

function tap(which) {
  if (which === 'link') {
    if (isConnected()) { disconnect(); toast('Koneksi diputus.', 'warn'); }
    else { connect(savedUrl()); toast(`Menyambung ke ${savedUrl()}...`); }
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
    const b1 = sec(body, 'alamat bridge');
    const inp = el('input', 'mInput');
    inp.type = 'text';
    inp.value = savedUrl();
    inp.autocapitalize = 'off';
    inp.autocomplete = 'off';
    inp.spellcheck = false;
    b1.appendChild(inp);

    const b2 = sec(body, 'pilihan cepat');
    CANDIDATES.forEach(([u, why]) => {
      const c = el('button', 'mChip', `<b>${u}</b><span>${why}</span>`);
      c.type = 'button';
      c.style.flex = '1 1 100%';
      c.onclick = () => { inp.value = u; };
      b2.appendChild(c);
    });

    const b3 = sec(body, '');
    b3.appendChild(btn('SAMBUNG', 'primary', () => {
      const u = inp.value.trim();
      if (!/^wss?:\/\/.+/i.test(u)) { toast('Alamat harus diawali ws:// atau wss://', 'bad'); return; }
      saveUrl(u);
      connect(u);
      closeModal();
      toast(`Menyambung ke ${u}...`);
      onChanged?.();
    }));
    if (isConnected()) {
      b3.appendChild(btn('PUTUS', 'danger', () => {
        disconnect(); closeModal(); toast('Koneksi diputus.', 'warn'); onChanged?.();
      }));
    }

    note(body, 'Halaman ini disajikan lewat http:// dari laptop, dan itu memang syaratnya: '
      + 'halaman https:// tidak boleh membuka ws:// (mixed content diblokir peramban) '
      + 'sedangkan ESP32 tidak punya TLS.', 'warn');
    note(body, 'Kalau ESP32 gagal masuk WiFi, dia membuat hotspot sendiri dan alamatnya '
      + 'jadi 192.168.4.1. Dari sana halaman ini tidak bisa dimuat (laptop tidak ikut pindah), '
      + 'jadi muat halamannya dulu baru pindah WiFi.');
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
