/* ============================================================================
   Pilihan koneksi: LOKAL (ESP32 langsung) atau CLOUD (lewat relay).

   Satu tempat untuk desktop dan HP, supaya alamat yang diketik di satu
   halaman tidak berbeda diam diam dari halaman lain. Disimpan di localStorage
   karena mengetik ulang token di papan ketik layar tiap kali halaman dibuka
   adalah pajak yang tidak menghasilkan keselamatan apa pun. Yang TIDAK
   disimpan di sini adalah apa pun yang berbau pose atau kalibrasi.

   Kenapa dua jalur dan bukan satu:
   - LOKAL: ws://<ip-esp32>:81. Latensi belasan ms, tidak bergantung internet
     atau layanan siapa pun. Syaratnya halaman ini dibuka lewat http:// dari
     jaringan yang sama (halaman https:// tidak boleh membuka ws://).
   - CLOUD: wss://<relay>/arm/<id>/ui?token=... Bisa dari mana saja, termasuk
     dari twin yang di-host di https://, karena ESP32 yang menelepon keluar ke
     relay. Harganya latensi internet; cara studio menanganinya ada di
     net/netQuality.js.
   ========================================================================== */

const LS = 'armstudio.link.v1';
const LS_OLD_POCKET = 'armpocket.ws.v1';   // alamat lama halaman HP, diwarisi sekali

export const DEFAULTS = {
  mode: 'local',
  localUrl: 'ws://192.168.1.8:81',
  /* Pintu Pages, bukan workers.dev: XL Axiata (dan mungkin operator lain)
     membelokkan DNS semua subdomain *.workers.dev ke halaman blokir. Lihat
     relay/src/gate.js. Token tetap wajib, jadi host bawaan ini tidak membuka
     apa pun bagi yang tidak memegangnya. */
  relay: 'armbot-relay.pages.dev',
  armId: 'armbot',
  token: '',
};

export function loadLink() {
  let cfg = { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(LS);
    if (raw) cfg = { ...cfg, ...JSON.parse(raw) };
    else {
      const old = localStorage.getItem(LS_OLD_POCKET);
      if (old) cfg.localUrl = old;
    }
  } catch { /* mode privat atau JSON rusak: pakai bawaan */ }
  if (cfg.mode !== 'cloud') cfg.mode = 'local';
  return cfg;
}

export function saveLink(cfg) {
  try { localStorage.setItem(LS, JSON.stringify({ ...DEFAULTS, ...cfg })); } catch { /* tidak persisten */ }
}

/** Bersihkan host relay yang ditempel apa adanya (dengan https://, garis miring, path). */
export function cleanRelayHost(s) {
  return String(s || '').trim()
    .replace(/^(wss?|https?):\/\//i, '')
    .replace(/\/.*$/, '');
}

/** URL WebSocket dari konfigurasi. null = konfigurasi cloud belum lengkap. */
export function linkUrl(cfg) {
  if (cfg.mode !== 'cloud') return cfg.localUrl;
  const host = cleanRelayHost(cfg.relay);
  if (!host || !cfg.token) return null;
  // ws:// hanya untuk `wrangler dev` di jaringan sendiri; relay asli selalu wss.
  const lokal = /^(localhost|127\.|192\.168\.|10\.|100\.)/.test(host);
  const proto = lokal ? 'ws' : 'wss';
  const id = encodeURIComponent(cfg.armId || 'armbot');
  return `${proto}://${host}/arm/${id}/ui?token=${encodeURIComponent(cfg.token)}`;
}

/** true bila URL ini menunjuk ke relay (bukan ESP32 / bridge Python langsung). */
export function isCloudUrl(u) { return /\/arm\/[^/?#]+\/ui(\?|$)/.test(String(u || '')); }

/** URL untuk ditampilkan: token disensor. */
export function displayUrl(u) { return String(u || '').replace(/token=[^&]*/, 'token=***'); }

/** Kenapa jalur LOKAL tidak akan berhasil dari halaman ini, atau null. */
export function localBlockedReason(u) {
  if (typeof location !== 'undefined' && location.protocol === 'https:' && /^ws:\/\//i.test(u)) {
    return 'Halaman ini dibuka lewat https://, dan peramban menolak ws:// dari halaman https '
      + '(mixed content). Pakai jalur CLOUD, atau buka studio lewat http:// dari jaringan yang sama.';
  }
  return null;
}
