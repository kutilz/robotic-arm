/* ============================================================================
   Relay Cloudflare: Worker (pintu masuk) + Durable Object (satu per lengan).

     ESP32  --wss-->  /arm/<id>/device?key=DEVICE_KEY   (keluar dari WiFi apa pun)
     browser --wss--> /arm/<id>/ui?token=OP_TOKEN|VIEW_TOKEN

   Semua aturan routing ada di room.js (bisa diuji di Node). Berkas ini cuma
   menempelkan aturan itu ke API Cloudflare: autentikasi, upgrade WebSocket,
   dan hibernasi.

   HIBERNASI. Socket diterima lewat ctx.acceptWebSocket(), bukan ws.accept(),
   jadi Durable Object boleh dibongkar dari memori saat tidak ada lalu lintas
   tanpa memutus socket. Itu yang membuat ESP32 boleh tersambung 24 jam tanpa
   menghabiskan kuota durasi: tanpa penonton ESP32 tidak mengirim feedback
   (link_cfg fb_hz 0), dan ping heartbeat-nya dijawab runtime. Konsekuensinya
   state di memori bisa hilang kapan saja, jadi identitas tiap socket disimpan
   di attachment-nya dan RoomCore dibangun ulang dari situ saat bangun.
   Pemegang kendali sengaja tidak ikut dipulihkan: kalau DO sempat tidur,
   berarti tidak ada ping selama itu, dan lease-nya memang sudah habis.
   ========================================================================== */
import { DurableObject } from 'cloudflare:workers';
import { RoomCore, roleFor } from './room.js';
import { handle } from './gate.js';

/* Pintu masuk langsung (armbot-relay.<akun>.workers.dev). Pintu kedua lewat
   Cloudflare Pages (pages/) memakai handle() yang sama persis. */
export default { fetch: (req, env) => handle(req, env) };

export class ArmRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.core = new RoomCore();
    // Bangun ulang dari socket yang selamat melewati hibernasi.
    for (const ws of ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() || {};
      if (a.kind === 'device') this.core.device = ws;
      else if (a.kind === 'ui') this.core.uis.set(a.id, { sock: ws, role: a.role, fbHz: a.fbHz || 10 });
      if (a.id && a.id >= this.core.nextId) this.core.nextId = a.id + 1;
    }
  }

  async fetch(req) {
    const url = new URL(req.url);
    const kind = url.pathname.endsWith('/device') ? 'device' : 'ui';
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [kind]);

    if (kind === 'device') {
      server.serializeAttachment({ kind });
      this.core.addDevice(server);
    } else {
      const role = roleFor(url.searchParams.get('token') || '', this.env) || 'viewer';
      const id = this.core.nextId;
      server.serializeAttachment({ kind, id, role });
      this.core.addUi(server, role, id);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, data) {
    if (typeof data !== 'string') return;          // protokol ini teks saja
    const a = ws.deserializeAttachment() || {};
    if (a.kind === 'device') this.core.fromDevice(data);
    else if (a.kind === 'ui') {
      this.core.fromUi(a.id, data);
      // Laju feedback yang diminta ikut disimpan supaya selamat dari hibernasi.
      const ui = this.core.uis.get(a.id);
      if (ui && ui.fbHz !== a.fbHz) ws.serializeAttachment({ ...a, fbHz: ui.fbHz });
    }
  }

  async webSocketClose(ws, code, reason) {
    this.drop(ws);
    try { ws.close(code, reason); } catch { /* sudah tertutup */ }
  }

  async webSocketError(ws) { this.drop(ws); }

  drop(ws) {
    const a = ws.deserializeAttachment() || {};
    if (a.kind === 'device') this.core.removeDevice(ws);
    else if (a.kind === 'ui') this.core.removeUi(a.id);
  }
}
