/* ============================================================================
   Bridge WebSocket: digital twin <-> lengan fisik / simulasi.
   Protokol (firmware/README.md):
     masuk : {"type":"feedback","angles":[a1..a6],"estop":b,"fault":[f1..f4],"grip":g}
             {"type":"ack","cmd":"...","ok":b,"msg":"..."}
             {"type":"cal", ...}  {"type":"diag", ...}    (dipakai mode SERVICE)
     keluar: {"cmd":"goto","angles":[a1..a6]}   {"cmd":"estop"}   {"cmd":"resume"}
             {"cmd":"cal_get"|"cal_set..."|"cal_zero"|"cal_save"|"cal_reset"}
             {"cmd":"diag"}   {"cmd":"load_tare"}   {"cmd":"load_scale","grams":g}
             {"cmd":"gripper","deg":x}   {"cmd":"servo_us","servo":s,"us":n}
             {"cmd":"servo_auto"[,"servo":s]}   {"cmd":"servo_center"}

   Guardrail target vs actual: feedback ~50 Hz dari hardware TIDAK boleh
   menindas pose yang sedang disusun user. Aturannya lewat STATE.poseDirty:
   - edit lokal apa pun (jog, slider, preset, IK, timeline, drag TCP) men-set
     poseDirty -> model menampilkan TARGET, feedback ditahan (badge 'target');
   - Send goto mengirim target lalu melepas poseDirty -> model kembali
     mengikuti feedback hardware (badge 'live'). Aliran live (net/liveLink.js)
     mengirim dengan keepDirty selama pose perintahnya masih merayap, dan baru
     melepas dirty di pesan terakhir saat target tercapai.

   Modul ini sengaja tidak punya interlock sendiri: dia lapisan transport. Yang
   memutuskan boleh atau tidaknya sebuah target berangkat ada di
   net/liveLink.js, dan di situ pula satu satunya pengirim berkala berada.
   E-STOP juga di-assert ulang tiap koneksi (ter)buka supaya tidak hilang
   saat ditekan di tengah reconnect.
   ========================================================================== */
import { STATE } from '../config/arm.js';
import { applyPose } from '../model/kinematics.js';

let ws = null;
/* Alamat bawaan = ESP32 di WiFi rumah (halaman bawaannya http://192.168.1.8/,
   server WebSocket-nya WS_PORT 81 di firmware). Ini yang dipakai sehari hari,
   jadi dia yang jadi isi awal kotak SETUP; bridge Python
   (`python -m arm.bridge --simulate`, ws://localhost:8765) tinggal diketik
   manual saat memang sedang menyimulasi tanpa lengan.

   Sengaja IP, bukan ws://armbot.local:81: mDNS tidak terjawab dari luar WiFi
   rumah (mis. lewat Tailscale), sedangkan IP-nya tetap terjangkau. Kalau ESP32
   gagal masuk WiFi ia jatuh ke mode AP dan alamatnya jadi ws://192.168.4.1:81. */
let url = 'ws://192.168.1.8:81';
let wantOpen = false;      // user menghendaki koneksi tetap terbuka
let everOpened = false;    // pernah berhasil OPEN (baru boleh auto-reconnect)
let reconnectTimer = null;
/* Backoff reconnect. Dulu tetap 2 dtk selamanya, dan itu bukan sekadar boros:
   tiap open mengirim cal_get dan memancarkan event `link up`, sedangkan tiap
   close melucuti ARM dan menyiapkan pemeriksaan sendi open-loop. Jadi ESP32
   yang mati semalaman menghasilkan siklus disarm/rearm tiap 2 detik yang
   membanjiri panel runner dengan pesan status. */
const RETRY_MIN = 2000, RETRY_MAX = 30000;
let retryDelay = RETRY_MIN;

/* Watchdog liveness: hardware harusnya kirim feedback ~50 Hz. Socket "open"
   tapi sunyi lama = TCP zombie -> paksa close supaya auto-reconnect jalan
   (dan e-stop di-assert ulang di onopen). Pasangan heartbeat ping/pong di
   firmware yang memutus klien mati dari sisi sana.

   AMBANGNYA HARUS LEBIH LONGGAR DARI BLOK TERPANJANG DI FIRMWARE.
   Yang menghitung di sini cuma pesan TEKS: frame ping/pong WebSocket tidak
   memicu onmessage di peramban, jadi sunyi yang terukur adalah sunyi broadcast
   feedback, bukan sunyi socket. Firmware punya beberapa jalur yang memblokir
   loop() lama lama dan anggarannya dipatok ke heartbeat 3 dtk miliknya sendiri,
   bukan ke watchdog ini:

     servo_capture  settle <=1500 ms + rekam <=200+1300 ms  = sampai 3,0 dtk
     servo_read n=64                                        = ~1,5 dtk
     nada / sweep                                           = sampai 1,5 dtk

   Dengan ambang 2 dtk, satu kali servo capture dari mode SERVICE hampir pasti
   memutus link sendiri, dan putusnya link bukan cuma badge: ARM ikut dilucuti
   dan penjaga sendi open-loop di runner bisa memunculkan "FRAME SUDUT
   BERGESER" padahal tidak ada yang bergeser. 4 dtk memberi jarak ke blok
   terpanjang tanpa membuat zombie TCP nyata jadi lama ketahuan. */
const STALE_MS = 4000;
let lastMsgAt = 0;
let liveTimer = null;
function liveCheck() {
  if (ws && ws.readyState === WebSocket.OPEN && Date.now() - lastMsgAt > STALE_MS) {
    badge('err', 'stale');
    ws.close();   // onclose -> jadwal reconnect
  }
}

/* status hardware terakhir (dari feedback/ack) + subscriber UI */
let hwEstop = false;
let hwFault = [0, 0, 0, 0];
/* Kesehatan driver TMC. Nilai awal `true` disengaja: firmware yang lebih lama
   tidak mengirim field ini sama sekali, dan menampilkan "driver bermasalah"
   pada firmware yang cuma belum tahu cara melapor adalah alarm palsu. Yang
   dipercaya di sini hanya laporan eksplisit. */
let hwDrvOk = true;
let hwDrvReset = 0;        // cacah pemulihan driver sejak ESP32 boot
let actual = null;         // sudut aktual terakhir dari hardware (derajat)
let gripActual = null;     // sudut gripper aktual (derajat), BUKAN sendi
let lastCal = null;        // pesan {"type":"cal"} terakhir

/* ---- Kepercayaan umpan balik pot servo (J5/J6) ----------------------------
   ADS1115 yang menjawab BUKAN bukti bahwa sudut yang dihitung darinya berarti.
   Pengubah tegangan->sudut (servoFbMvMin/Max) punya nilai awal 1000/2000 mV
   yang di firmware sendiri ditandai "BUKAN hasil ukur"; selama masih di situ,
   sudut yang keluar adalah tegangan nyata yang dipetakan dengan konstanta
   karangan. Terbukti di lengan 12 Agu 2026: J6 melaporkan 121,00 deg persis
   sama dengan servo_ang_max-nya, yaitu nilai CLAMP saat tegangan pot melewati
   langit-langit 2000 mV, sementara pergelangan fisiknya jelas ada di home.
   Feedback seperti itu tidak boleh menggerakkan digital twin: begitu tersambung
   model langsung melompat ke pose yang tidak pernah ditempati lengan.

   Ini penyakit yang sama dengan AS5600 tanpa magnet yang sudah dijaga di
   firmware (chip menjawab sempurna, RAW ANGLE tetap keluar). Bedanya di sana
   status magnet ikut diperiksa; untuk pot servo pemeriksaan itu belum ada,
   jadi studio yang menolak memakainya sampai kalibrasinya nyata.

   Sendi yang tidak dipercaya TIDAK dikarang angkanya: model cuma menahan nilai
   yang ada (yaitu sudut yang diperintahkan), dan UI menandainya `cmd`. */
const FB_MV_PLACEHOLDER = { min: 1000, max: 2000 };
const SERVO_OF_JOINT = { 4: 0, 5: 1 };    // J5 -> servo 0, J6 -> servo 1
let fbTrust = [true, true, true, true, true, true];

function recomputeFbTrust(cal) {
  const lo = cal && cal.servo_fb_mv_min, hi = cal && cal.servo_fb_mv_max;
  for (const j of [4, 5]) {
    const s = SERVO_OF_JOINT[j];
    const untouched = Array.isArray(lo) && Array.isArray(hi)
      && lo[s] === FB_MV_PLACEHOLDER.min && hi[s] === FB_MV_PLACEHOLDER.max;
    // Tanpa cal sama sekali kita juga belum boleh percaya: diam diam memakai
    // angka yang belum diperiksa persis kesalahan yang mau dicegah di sini.
    fbTrust[j] = !!(lo && hi) && !untouched;
  }
  emitHw({ type: 'fbtrust', trust: fbTrust.slice() });
}

/* ---- Putusnya link = hilangnya jaminan atas sendi open-loop ----------------
   J3 dan J4 tidak punya encoder: sudut yang dilaporkan firmware untuk keduanya
   adalah isi step counter, dan step counter itu mulai dari NOL tiap ESP32 boot
   (syncSteppersFromEncoders() jatuh ke cabang "tak ada encoder" dan menahan
   actualDeg yang masih 0). Artinya pose fisik apa pun yang sedang ditempati
   lengan saat listrik kembali diam diam menjadi "0 derajat".

   Lebih buruk lagi urutannya saat listrik putus: driver mati lebih dulu, J2 dan
   J3 melorot karena tidak self-locking, BARU ESP boot dan mengambil pose yang
   sudah melorot itu sebagai nol. J1 dan J2 pulih sendiri karena AS5600 absolut;
   J3 dan J4 tidak punya apa pun untuk pulih.

   Tidak ada satu pun angka di layar yang memperlihatkan hal ini: feedback J3
   tetap melapor 0,0 dengan yakin. Jadi yang dipakai sebagai pemicu di sini
   bukan "terdeteksi reboot" (firmware tidak mengirim uptime, jadi itu tidak
   bisa dibuktikan dari sini) melainkan PUTUSNYA link itu sendiri: sesudah putus
   studio memang tidak lagi punya dasar untuk menjamin frame sudut open-loop.
   Konsumennya ada di features/runner.js. */
let openCount = 0;

/** true bila sudut sendi i benar benar hasil ukur yang bisa dipercaya. */
export function isFbTrusted(i) { return fbTrust[i] !== false; }
/** cal terakhir dari firmware (null bila cal_get belum pernah dijawab). */
export function getCal() { return lastCal; }
const hwListeners = new Set();
/** subscribe event hardware: {type:'estop',on} | {type:'fault',fault[4]} |
 *  {type:'ack',cmd,ok,msg} | {type:'cal',cal} | {type:'diag',diag} |
 *  {type:'link',up,reopened} | {type:'drv',ok,resets,baru} */
export function onHwStatus(fn) { hwListeners.add(fn); return () => hwListeners.delete(fn); }
/** true bila firmware menyatakan keempat driver TMC terverifikasi. Firmware
 *  lama yang tidak melaporkannya dianggap ok; lihat catatan di hwDrvOk. */
export function isDriverOk() { return hwDrvOk; }
/** berapa kali firmware memulihkan driver sejak ESP32 boot (0 = belum pernah). */
export function getDriverResets() { return hwDrvReset; }
function emitHw(ev) { for (const fn of hwListeners) fn(ev); }
/** sudut aktual terakhir dari hardware (null bila belum ada feedback). */
export function getActual() { return actual; }
/** sudut gripper aktual dari feedback (null bila firmware belum kirim "grip").
 *  Gripper bukan DOF: tidak ada di angles[] dan tidak punya joint limit. */
export function getGripActual() { return gripActual; }

let lastLbl = '';
function badge(state, label) {
  const el = document.getElementById('connBadge'); if (!el) return;
  el.className = 'badge ' + state;
  el.querySelector('.lbl').textContent = label;
  lastLbl = label;
}

function onMessage(ev) {
  let msg; try { msg = JSON.parse(ev.data); } catch { return; }
  lastMsgAt = Date.now();   // pesan apa pun = bukti link hidup (watchdog)

  if (msg.type === 'feedback') {
    /* Kesehatan driver dibaca DULUAN: dia ikut menentukan label badge di bawah,
       dan badge yang menyebut "live" sementara tahap output driver mati adalah
       persis kebohongan yang membuat insiden 13 Agu 2026 tidak terlihat.
       `drvrst` naik tiap firmware menemukan driver hilang atau baru reset, jadi
       kejadian yang sudah pulih sendiri tetap meninggalkan jejak. */
    if (typeof msg.drvok === 'boolean' || Number.isFinite(msg.drvrst)) {
      const ok = typeof msg.drvok === 'boolean' ? msg.drvok : hwDrvOk;
      const rst = Number.isFinite(msg.drvrst) ? msg.drvrst : hwDrvReset;
      if (ok !== hwDrvOk || rst !== hwDrvReset) {
        const baru = rst > hwDrvReset;
        hwDrvOk = ok; hwDrvReset = rst;
        emitHw({ type: 'drv', ok, resets: rst, baru });
      }
    }
    if (Array.isArray(msg.angles)) {
      actual = msg.angles.slice(0, 6).map(a => (Number.isFinite(a) ? a : null));
      if (!STATE.poseDirty) {
        // model mengikuti hardware; hanya angka finite DAN yang dipercaya.
        // Sendi tak terpercaya ditahan di nilai sekarang (= sudut perintah),
        // bukan diisi tebakan; lihat catatan fbTrust di atas.
        actual.forEach((a, i) => {
          if (STATE.joints[i] != null && a != null && fbTrust[i]) STATE.joints[i].a = a;
        });
        applyPose(true);   // true = dari feedback, jangan set poseDirty
      }
      // Driver mati mendahului target/live: badge adalah satu satunya penanda
      // yang terlihat dari SEMUA tab, jadi kondisi yang menghentikan gerak
      // harus muncul di situ dan bukan cuma di panel yang kebetulan terbuka.
      const lbl = !hwDrvOk ? 'driver' : (STATE.poseDirty ? 'target' : 'live');
      if (lbl !== lastLbl) badge(hwDrvOk ? 'on' : 'err', lbl);
    }
    if (typeof msg.estop === 'boolean' && msg.estop !== hwEstop) {
      hwEstop = msg.estop;
      emitHw({ type: 'estop', on: hwEstop });
    }
    if (Array.isArray(msg.fault)) {
      const f = msg.fault.slice(0, 4).map(x => (x ? 1 : 0));
      if (f.join() !== hwFault.join()) { hwFault = f; emitHw({ type: 'fault', fault: f }); }
    }
    if (Number.isFinite(msg.grip)) gripActual = msg.grip;
  } else if (msg.type === 'ack') {
    emitHw({ type: 'ack', cmd: String(msg.cmd ?? '?'), ok: !!msg.ok, msg: String(msg.msg ?? '') });
  } else if (msg.type === 'cal') {
    lastCal = msg;
    recomputeFbTrust(msg);
    emitHw({ type: 'cal', cal: msg });
  } else if (msg.type === 'diag') {
    emitHw({ type: 'diag', diag: msg });
  }
}

export function connect(u) {
  if (u) url = u;
  wantOpen = true;
  clearTimeout(reconnectTimer); reconnectTimer = null;
  /* Socket lama dinetralkan SEBELUM yang baru dibuat, kalau tidak ini jadi
     zombie yang paling sulit dikenali. ws.close() asinkron, dan handler
     onclose lama menulis `ws = null` lewat variabel modul yang sama. Jadi
     kalau socket lama baru benar benar tutup SESUDAH yang baru dibuat, ia
     menghapus referensi socket baru yang sedang hidup: isConnected() jadi
     false sehingga semua pengiriman diblokir dan badge berbohong, sementara
     socket barunya masih terbuka, masih menerima feedback, dan masih
     menggerakkan model 3D. Melepas handler dulu memutus jalur itu. */
  if (ws) {
    ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
    try { ws.close(); } catch { /* sudah tutup */ }
    ws = null;
  }
  try { ws = new WebSocket(url); } catch { badge('err', 'error'); return; }
  badge('off', 'connecting');
  ws.onopen = () => {
    everOpened = true;
    retryDelay = RETRY_MIN;          // sambungan sehat: backoff dimulai dari awal lagi
    STATE.poseDirty = false;         // koneksi (kembali) terbuka: ikuti hardware
    badge('on', 'live');
    lastMsgAt = Date.now();          // grace period watchdog mulai dari open
    clearInterval(liveTimer);
    liveTimer = setInterval(liveCheck, 1000);
    // guardrail: E-STOP yang ditekan saat putus/reconnect di-assert ulang
    if (STATE.estop) ws.send(JSON.stringify({ cmd: 'estop' }));
    // Kalibrasi diminta SEKALI di tiap koneksi, sebelum feedback sempat
    // menggerakkan model: batas gripper dan kepercayaan pot servo dua duanya
    // dibaca dari sini, dan menebaknya di UI adalah sumber cacat tersendiri.
    fbTrust = [true, true, true, true, false, false];   // servo tidak dipercaya sampai cal membuktikan
    ws.send(JSON.stringify({ cmd: 'cal_get' }));
    openCount++;
    emitHw({ type: 'link', up: true, reopened: openCount > 1 });
  };
  ws.onerror = () => badge('err', 'error');
  ws.onclose = () => {
    ws = null;
    clearInterval(liveTimer); liveTimer = null;
    /* Sudut terakhir dibuang, bukan disimpan. Sesudah link putus tidak ada yang
       tahu apakah lengan masih di situ (driver bisa mati dan sendi non
       self-locking melorot), jadi menampilkannya terus sebagai "aktual" adalah
       angka basi yang menyamar jadi hasil ukur. Semua pembacanya sudah tahan
       null dan menampilkan "--". */
    actual = null; gripActual = null;
    // Kesehatan driver ikut dibuang: selama putus tidak ada yang tahu keadaan
    // rail VM, dan lampu hijau basi lebih menyesatkan daripada tidak ada lampu.
    hwDrvOk = true; hwDrvReset = 0;
    emitHw({ type: 'link', up: false });
    // auto-reconnect hanya kalau user masih mau DAN koneksi pernah sukses
    // (mencegah retry tak berujung saat bridge belum dijalankan).
    if (wantOpen && everOpened) {
      badge('off', `reconnect ${Math.round(retryDelay / 1000)}s`);
      reconnectTimer = setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, RETRY_MAX);
    }
    else if (wantOpen) { wantOpen = false; badge('err', 'gagal'); }
    else badge('off', 'sim');
  };
  ws.onmessage = onMessage;
}
export function disconnect() {
  wantOpen = false;
  clearTimeout(reconnectTimer); reconnectTimer = null;
  clearInterval(liveTimer); liveTimer = null;
  retryDelay = RETRY_MIN;
  // onclose sengaja dilepas supaya tidak menjadwalkan reconnect, jadi event
  // link down harus dipancarkan di sini; putus atas kehendak sendiri tetap
  // putus, dan penjaga sendi open-loop di runner tidak boleh melewatkannya.
  //
  // onmessage ikut dilepas, bukan cuma onclose: ws.close() asinkron dan frame
  // yang sudah ada di buffer tetap memicu onMessage sesudah baris ini, yaitu
  // mengisi ulang `actual` dan memanggil applyPose() SESUDAH seluruh UI
  // menyatakan link mati. Hasilnya getActual() mengembalikan angka yang tampak
  // segar padahal studio sudah menyatakan putus.
  if (ws) { ws.onclose = ws.onmessage = ws.onerror = null; ws.close(); ws = null; }
  actual = null; gripActual = null;
  hwDrvOk = true; hwDrvReset = 0;
  emitHw({ type: 'link', up: false });
  badge('off', 'sim');
}
export function isConnected() { return ws && ws.readyState === WebSocket.OPEN; }
/** true bila user sedang menghendaki koneksi (connecting/open/reconnect). */
export function isActive() { return wantOpen; }

/**
 * Kirim target sendi ke lengan.
 * @param angles  [J1..J6] derajat; tanpa argumen = pose twin sekarang.
 * @param src     penanda pengirim ('live' | 'runner' | 'cal' | 'manual').
 *                Ikut dipancarkan sebagai event supaya net/liveLink.js bisa
 *                menyamakan pose perintahnya dengan yang benar benar berangkat.
 *                Tanpa ini aliran live akan menarik lengan balik dari pose yang
 *                baru saja diperintahkan sumber lain.
 * @param keepDirty  true = JANGAN lepas poseDirty. Dipakai aliran live selagi
 *                pose perintahnya masih merayap menuju target: melepas dirty di
 *                tengah tarikan gizmo membuat feedback menindas pose yang
 *                sedang disusun operator, dan gizmo jadi berkedut.
 */
export function sendGoto(angles, { src = 'manual', keepDirty = false } = {}) {
  if (!isConnected()) return false;
  const a = angles || STATE.joints.map(j => j.a);
  ws.send(JSON.stringify({ cmd: 'goto', angles: a }));
  if (!keepDirty) STATE.poseDirty = false;   // target terkirim: model kembali mengikuti feedback
  emitHw({ type: 'goto', src, angles: a.slice() });
  return true;
}
export function sendEstop() { if (isConnected()) ws.send(JSON.stringify({ cmd: 'estop' })); }
export function sendResume() { if (isConnected()) ws.send(JSON.stringify({ cmd: 'resume' })); }

/* ---- kalibrasi & diagnostik (mode SERVICE). Firmware = executor primitif; semua
   sequencing/perhitungan ada di features/calPanel.js. Balasan datang sebagai
   event onHwStatus {type:'cal'|'diag'|'ack'}. ---- */
function sendCmd(obj) {
  if (!isConnected()) return false;
  ws.send(JSON.stringify(obj));
  return true;
}
export function sendCalGet()       { return sendCmd({ cmd: 'cal_get' }); }
export function sendCalSet(fields) { return sendCmd({ cmd: 'cal_set', ...fields }); }
export function sendCalZero(joint) { return sendCmd(joint ? { cmd: 'cal_zero', joint } : { cmd: 'cal_zero' }); }
export function sendCalSave()      { return sendCmd({ cmd: 'cal_save' }); }
export function sendCalReset()     { return sendCmd({ cmd: 'cal_reset' }); }
export function sendDiag()         { return sendCmd({ cmd: 'diag' }); }
export function sendLoadTare()     { return sendCmd({ cmd: 'load_tare' }); }
export function sendLoadScale(g)   { return sendCmd({ cmd: 'load_scale', grams: g }); }

/* ---- gripper & servo mentah (blok gripper mode SERVICE) ----
   Gripper BUKAN sendi: tidak ikut goto/angles[], jadi perintahnya berdiri
   sendiri dan langsung dieksekusi tanpa perlu Send goto.

   Dua jalur sengaja dipisah:
   - sendGripper(deg)  : lewat pemetaan sudut firmware (servoAngMin..Max).
                         Ini jalur pakai sehari-hari, tapi hasilnya bergantung
                         pada pemetaan sudut yang justru sedang dikalibrasi.
   - sendServoUs(s,us) : lebar pulsa MENTAH + mode manual, jadi loop kendali
                         tidak menimpanya tiap putaran. Ini yang dipakai saat
                         merakit: horn wajib duduk di titik tengah TERUKUR dan
                         diam di situ, tanpa bergantung pemetaan sudut. */
export const SERVO_GRIP = 2;   // indeks servo gripper, sama dgn firmware
export function sendGripper(deg)     { return sendCmd({ cmd: 'gripper', deg }); }
export function sendServoUs(s, us)   { return sendCmd({ cmd: 'servo_us', servo: s, us }); }
export function sendServoAuto(s)     { return sendCmd(s == null ? { cmd: 'servo_auto' } : { cmd: 'servo_auto', servo: s }); }
export function sendServoCenter()    { return sendCmd({ cmd: 'servo_center' }); }

export function getUrl() { return url; }
