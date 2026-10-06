/* ============================================================================
   Inti relay: satu "ruang" = satu lengan + browser yang menontonnya.

   Modul ini sengaja tidak tahu apa apa tentang Cloudflare. Socket cuma objek
   dengan send(teks) dan close(), jam dan timer disuntikkan. Alasannya sama
   dengan studio/src/net/liveRamp.js: aturan yang menentukan perintah mana yang
   sampai ke lengan harus bisa dibuktikan di Node (`npm test`), bukan cuma
   dicoba sambil melihat lengan bergerak.

   Relay TIDAK mengendalikan lengan. Keputusan gerak tetap milik firmware
   (lease, batas laju, pemegang kendali lokal vs cloud). Yang diurus di sini
   cuma hal yang hanya bisa dilihat dari tengah:

   1 ALAMAT BALASAN. ESP32 hanya punya satu koneksi ke relay, jadi tidak bisa
     membedakan browser. Tiap pesan dari browser diberi "_c" (nomor koneksi),
     firmware menyisipkannya kembali di balasan (pong, ack, cal), dan relay
     mengantar balasan itu ke browser yang bertanya saja. Pesan tanpa "_c"
     (feedback) disebar ke semua browser.

   2 SATU OPERATOR DI ANTARA BROWSER CLOUD. Firmware hanya melihat satu jalur
     "cloud", jadi dua browser yang sama sama ARM akan saling tarik tanpa
     firmware bisa tahu. Browser yang mengirim perintah gerak duluan memegang
     kendali selama lease-nya diperpanjang; yang lain ditolak di sini.

   3 OPERATOR PERGI = lease_drop. Begitu socket browser pemegang kendali
     tertutup, firmware diberi tahu saat itu juga, tanpa menunggu lease habis.

   4 YANG TERBARU MENANG. goto bersifat absolut, jadi kalau browser mengirim
     lebih rapat dari GOTO_MIN_GAP_MS, yang diteruskan cuma yang terakhir.
     E-stop dan perintah lain tidak pernah ditahan atau digabung.

   5 LAJU FEEDBACK. ESP32 baru mengirim feedback ke cloud kalau ada yang
     menonton (link_cfg fb_hz). Ruang tanpa penonton tidak memakan kuota
     Cloudflare dan tidak membebani TLS di ESP32.
   ========================================================================== */

export const MOTION = new Set(['goto', 'gripper']);
/* Penonton boleh melihat dan boleh MENGHENTIKAN. E-stop dari siapa pun yang
   melihat lengan bergerak salah adalah fitur, bukan celah. */
export const VIEWER_OK = new Set(['ping', 'cal_get', 'diag', 'estop', 'link_cfg']);
/* Perintah yang hanya boleh dibuat relay sendiri. */
const RELAY_ONLY = new Set(['lease_drop']);

export const DEFAULT_LEASE_MS = 1500;   // = CLOUD_LEASE_DEFAULT_MS firmware
export const MAX_LEASE_MS = 8000;       // = LEASE_MAX_MS firmware
export const GOTO_MIN_GAP_MS = 50;
export const FB_HZ_DEFAULT = 10;
export const FB_HZ_MAX = 25;

export class RoomCore {
  /**
   * @param {object} o
   * @param {() => number} [o.now]
   * @param {(fn: () => void, ms: number) => any} [o.setTimer]
   */
  constructor({ now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms) } = {}) {
    this.now = now;
    this.setTimer = setTimer;
    this.device = null;
    /** @type {Map<number, {sock: any, role: 'operator'|'viewer', fbHz: number}>} */
    this.uis = new Map();
    this.nextId = 1;
    this.ctrl = null;          // id browser pemegang kendali
    this.ctrlUntil = 0;
    this.lastGotoAt = 0;
    this.pendingGoto = null;   // teks goto terakhir yang ditahan
    this.flushArmed = false;
    this.sentFbHz = -1;
  }

  /* ---------------- siklus hidup socket ---------------- */

  addDevice(sock) {
    if (this.device && this.device !== sock) {
      try { this.device.close(4000, 'digantikan perangkat baru'); } catch { /* sudah tutup */ }
    }
    this.device = sock;
    this.sentFbHz = -1;        // perangkat baru belum tahu apa apa
    this.pushFbHz();
    this.broadcastStatus();
  }

  removeDevice(sock) {
    if (this.device !== sock) return;
    this.device = null;
    this.pendingGoto = null;
    this.broadcastStatus();
  }

  /** @returns {number} id browser */
  addUi(sock, role, id = null) {
    const uid = id ?? this.nextId++;
    if (uid >= this.nextId) this.nextId = uid + 1;
    this.uis.set(uid, { sock, role, fbHz: FB_HZ_DEFAULT });
    this.pushFbHz();
    this.sendStatus(uid);
    return uid;
  }

  removeUi(uid) {
    if (!this.uis.delete(uid)) return;
    if (this.ctrl === uid) {
      this.ctrl = null;
      this.ctrlUntil = 0;
      this.pendingGoto = null;
      this.toDevice({ cmd: 'lease_drop' });
    }
    this.pushFbHz();
    this.broadcastStatus();
  }

  /* ---------------- pesan ---------------- */

  fromUi(uid, text) {
    const ui = this.uis.get(uid);
    if (!ui) return;
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    const cmd = typeof msg.cmd === 'string' ? msg.cmd : '';
    const ack = (ok, m) => this.sendTo(uid, { type: 'ack', cmd: cmd || '?', ok, msg: m });

    if (RELAY_ONLY.has(cmd)) { ack(false, 'perintah internal relay'); return; }
    if (ui.role === 'viewer' && !VIEWER_OK.has(cmd)) {
      ack(false, 'mode lihat saja: token ini tidak boleh mengendalikan lengan');
      return;
    }

    if (cmd === 'link_cfg') {
      const hz = Number(msg.fb_hz);
      ui.fbHz = Number.isFinite(hz) ? Math.max(1, Math.min(FB_HZ_MAX, Math.round(hz))) : FB_HZ_DEFAULT;
      this.pushFbHz();
      return;
    }

    if (!this.device) {
      /* Ping tetap dijawab, oleh relay sendiri, supaya studio bisa membedakan
         "relay hidup tapi lengan belum tersambung" dari "internet putus". */
      if (cmd === 'ping') this.sendStatus(uid);
      else if (cmd !== 'cal_get' && cmd !== 'diag') ack(false, 'lengan belum tersambung ke relay');
      return;
    }

    const now = this.now();
    const lease = Number.isFinite(msg.lease) && msg.lease > 0
      ? Math.min(msg.lease, MAX_LEASE_MS) : DEFAULT_LEASE_MS;

    if (MOTION.has(cmd)) {
      const ctrlAlive = this.ctrl != null && now < this.ctrlUntil;
      if (ctrlAlive && this.ctrl !== uid) {
        ack(false, 'lengan sedang dikendalikan browser lain');
        return;
      }
      const changed = this.ctrl !== uid;
      this.ctrl = uid;
      this.ctrlUntil = now + lease;
      if (changed) this.broadcastStatus();
    } else if (cmd === 'ping') {
      if (this.ctrl === uid && Number.isFinite(msg.lease)) this.ctrlUntil = now + lease;
      /* Kendali yang LEPAS karena lease habis tidak memicu apa pun di relay
         (tidak ada timer), jadi kabarnya dititipkan ke ping berikutnya. Tanpa
         ini browser lain terus mengira lengan masih dipegang orang. */
      if (this.status(uid).ctrl !== ui.lastCtrl) this.sendStatus(uid);
    }

    msg._c = uid;
    const out = JSON.stringify(msg);
    if (cmd === 'goto') this.forwardGoto(out, now);
    else this.toDeviceText(out);
  }

  fromDevice(text) {
    /* Jalur cepat: feedback 10 sampai 25 Hz tidak perlu di-parse, cukup
       dikenali tidak membawa "_c". Firmware selalu menaruh "_c" PALING DEPAN. */
    if (!text.startsWith('{"_c":')) {
      for (const ui of this.uis.values()) safeSend(ui.sock, text);
      return;
    }
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    const uid = msg._c;
    delete msg._c;
    const ui = this.uis.get(uid);
    if (ui) safeSend(ui.sock, JSON.stringify(msg));
  }

  /* ---------------- bagian dalam ---------------- */

  forwardGoto(text, now) {
    if (now - this.lastGotoAt >= GOTO_MIN_GAP_MS && !this.flushArmed) {
      this.lastGotoAt = now;
      this.toDeviceText(text);
      return;
    }
    this.pendingGoto = text;            // yang lama dibuang: terbaru menang
    if (this.flushArmed) return;
    this.flushArmed = true;
    const wait = Math.max(0, GOTO_MIN_GAP_MS - (now - this.lastGotoAt));
    this.setTimer(() => {
      this.flushArmed = false;
      if (!this.pendingGoto) return;
      const t = this.pendingGoto;
      this.pendingGoto = null;
      this.lastGotoAt = this.now();
      this.toDeviceText(t);
    }, wait);
  }

  toDevice(obj) { this.toDeviceText(JSON.stringify(obj)); }
  toDeviceText(text) { if (this.device) safeSend(this.device, text); }

  /** laju feedback = permintaan TERTINGGI di antara browser, 0 kalau kosong. */
  wantedFbHz() {
    let hz = 0;
    for (const ui of this.uis.values()) hz = Math.max(hz, ui.fbHz);
    return hz;
  }

  pushFbHz() {
    const hz = this.wantedFbHz();
    if (hz === this.sentFbHz || !this.device) return;
    this.sentFbHz = hz;
    this.toDevice({ cmd: 'link_cfg', fb_hz: hz });
  }

  status(uid) {
    const ui = this.uis.get(uid);
    const ctrlAlive = this.ctrl != null && this.now() < this.ctrlUntil;
    return {
      type: 'relay',
      device: !!this.device,
      role: ui ? ui.role : 'viewer',
      ctrl: !ctrlAlive ? 'none' : this.ctrl === uid ? 'you' : 'other',
      n: this.uis.size,
    };
  }

  sendStatus(uid) {
    const st = this.status(uid);
    const ui = this.uis.get(uid);
    if (ui) ui.lastCtrl = st.ctrl;
    this.sendTo(uid, st);
  }
  broadcastStatus() { for (const uid of this.uis.keys()) this.sendStatus(uid); }

  sendTo(uid, obj) {
    const ui = this.uis.get(uid);
    if (ui) safeSend(ui.sock, JSON.stringify(obj));
  }
}

function safeSend(sock, text) {
  try { sock.send(text); } catch { /* socket sedang menutup; close handler yang membereskan */ }
}

/* ---------------- autentikasi ---------------- */

/** Bandingkan rahasia tanpa bocor lewat waktu (panjang tetap ikut bocor, itu wajar). */
export function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/** Peran dari token browser: 'operator' | 'viewer' | null (ditolak). */
export function roleFor(token, env) {
  if (sameSecret(token, env.OP_TOKEN)) return 'operator';
  if (env.VIEW_TOKEN && sameSecret(token, env.VIEW_TOKEN)) return 'viewer';
  return null;
}

/** Origin browser diizinkan? Daftar kosong = semua origin boleh (token tetap wajib). */
export function originAllowed(origin, list) {
  const allowed = String(list || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!allowed.length) return true;
  if (!origin) return false;
  return allowed.some(a => a === origin
    || (a.startsWith('*.') && origin.endsWith(a.slice(1)) && /^https:\/\//.test(origin)));
}

export const ARM_ID_RE = /^[a-z0-9-]{1,32}$/;
