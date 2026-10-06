/* ============================================================================
   Kualitas link: RTT, jitter, dan profil yang dipakai studio. Fungsi murni.

   Sama seperti liveRamp.js, modul ini tidak tahu apa apa tentang WebSocket,
   DOM, atau scene graph: semua keputusan "seberapa jelek link ini dan apa yang
   masih boleh" ada di sini dan dibuktikan di Node lewat
   `node studio/tools/verify_net.mjs`. Pemakainya net/bridge.js (yang mengukur)
   dan net/liveLink.js (yang membatasi).

   -------------------------------------------------------------------------
   KENAPA PROFIL, BUKAN SATU ATURAN UNTUK SEMUA LINK

   Di WiFi rumah RTT ke ESP32 belasan ms dan stabil, dan aliran live 20 Hz
   yang sudah terbukti tidak perlu diubah. Lewat relay dan 4G, RTT rata ratanya
   masih wajar (sekitar 100 ms) tapi EKORNYA panjang: sesekali satu paket
   tertahan setengah sampai beberapa detik, lalu yang tertahan tumpah
   bersamaan. Yang menentukan aman tidaknya kendali karena itu bukan rata rata
   melainkan p95 dan pong yang terlambat, dan yang dilakukan terhadapnya
   berbeda per tingkat:

     lan    p95 < 40 ms     seperti sekarang: live 20 Hz, RUN boleh
     baik   p95 < 300 ms    live dengan target kasar 5 Hz, RUN boleh
     buruk  selebihnya      live dimatikan, TEACH saja, pose dikirim satu satu
     putus  pong tak datang perintah gerak ditolak sampai link pulih

   Kenapa batas "baik" 300 ms dan bukan lebih ketat: RTT yang diukur di sini
   adalah jalur PENUH browser -> relay -> ESP32 -> relay -> browser, dan kalau
   lengan maupun operator sama sama di 4G, dua kaki seluler itu saja sudah
   150 sampai 250 ms. Latensi setinggi itu tidak berbahaya selama datangnya
   rata: batas laju di firmware membuat target yang telat tetap dijalankan
   halus. Yang berbahaya adalah stall, dan itu ditangkap terpisah lewat pong
   yang telat (overdueMs) dan lease, tanpa menunggu p95 naik.

   Turun tingkat seketika, naik tingkat baru sesudah kondisinya bertahan
   UPGRADE_HOLD_MS. Link yang naik turun di perbatasan tidak boleh membuat
   LIVE menyala-mati tiap detik.
   ========================================================================== */

export const PING_MS = 500;           // sekaligus perpanjangan lease selama ARM
export const WINDOW = 40;             // 40 sampel = 20 detik terakhir
export const UPGRADE_HOLD_MS = 5000;
export const LOCAL_TICK_MS = 50;      // = TICK_MS liveRamp, laju yang sudah terbukti
export const CLOUD_TICK_MS = 200;

export const LEVELS = ['lan', 'baik', 'buruk', 'putus'];
export const PROFILE = {
  lan:   { label: 'LAN',   live: true,  run: true,  fbHz: 20 },
  baik:  { label: 'Baik',  live: true,  run: true,  fbHz: 20 },
  buruk: { label: 'Buruk', live: false, run: false, fbHz: 10 },
  putus: { label: 'Putus', live: false, run: false, fbHz: 10 },
};

/** persentil dari daftar angka (tidak harus terurut). */
export function percentile(xs, p) {
  if (!xs.length) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  const k = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[k];
}

/** jitter = rata rata selisih mutlak RTT berurutan (gaya RFC 3550, tanpa filter). */
export function jitter(xs) {
  if (xs.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < xs.length; i++) sum += Math.abs(xs[i] - xs[i - 1]);
  return sum / (xs.length - 1);
}

/**
 * Tingkat link SAAT INI, tanpa histeresis.
 * @param o.samples    RTT terakhir (ms)
 * @param o.overdueMs  umur ping tertua yang belum dijawab (0 = tidak ada)
 * @param o.lost       jumlah ping yang dianggap hilang di jendela ini
 * @param o.sent       jumlah ping yang dikirim di jendela ini
 * @param o.leaseMs    lease yang sedang dipakai; pong yang lebih telat dari
 *                     ini berarti firmware sudah membekukan lengan
 */
export function rawLevel({ samples, overdueMs = 0, lost = 0, sent = 0, leaseMs = 1500 }) {
  if (overdueMs > Math.max(leaseMs, 1500)) return 'putus';
  if (!samples.length) return overdueMs > 0 ? 'buruk' : 'baik';
  const p95 = percentile(samples, 95);
  const loss = sent ? lost / sent : 0;
  /* Pong yang sudah telat lebih dari 1 dtk = stall yang sedang berlangsung.
     Tidak menunggu p95 menyusul: p95 baru naik sesudah pong-nya datang. */
  if (overdueMs > 1000 || loss > 0.1 || p95 >= 300) return 'buruk';
  if (p95 < 40) return 'lan';
  return 'baik';
}

/** Lease perintah gerak untuk firmware dan relay (ms). p95 NaN = belum ada sampel. */
export function leaseFor(mode, p95) {
  if (mode !== 'cloud') return 1000;
  if (!Number.isFinite(p95)) p95 = 300;
  // 3 x p95: dua ping (500 ms) boleh hilang berturut turut tanpa lengan direm.
  return Math.round(Math.min(5000, Math.max(1500, 3 * p95 + 2 * PING_MS)));
}

/**
 * Penjaga histeresis: turun seketika, naik setelah bertahan holdMs.
 * Disuntik jam supaya bisa diuji tanpa menunggu.
 */
export class LevelGate {
  constructor(holdMs = UPGRADE_HOLD_MS) {
    this.holdMs = holdMs;
    this.level = 'baik';
    this.betterSince = 0;
    this.betterLevel = null;
  }
  /** @returns {string} tingkat yang berlaku sesudah observasi ini */
  update(raw, now) {
    const cur = LEVELS.indexOf(this.level);
    const nxt = LEVELS.indexOf(raw);
    if (nxt >= cur) {                       // sama atau lebih jelek: langsung
      this.level = raw;
      this.betterLevel = null;
      return this.level;
    }
    if (this.betterLevel !== raw) { this.betterLevel = raw; this.betterSince = now; }
    if (now - this.betterSince >= this.holdMs) {
      this.level = raw;
      this.betterLevel = null;
    }
    return this.level;
  }
  reset(level = 'baik') { this.level = level; this.betterLevel = null; }
}

/** Ringkasan untuk ditampilkan. */
export function summarize(samples) {
  return {
    n: samples.length,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    jitter: jitter(samples),
  };
}
