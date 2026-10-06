/* ============================================================================
   Gerbang HTTP relay: routing, autentikasi, lalu serahkan ke Durable Object.

   Dipakai DUA pintu masuk yang meneruskan ke Durable Object yang sama:
     - Worker      armbot-relay.<akun>.workers.dev   (src/index.js)
     - Pages       armbot-relay.pages.dev            (pages/functions/)

   Kenapa dua. 7 Okt 2026, uji relay yang baru di-deploy: XL Axiata
   membelokkan DNS SEMUA subdomain *.workers.dev ke IP halaman blokir, termasuk
   kueri ke 1.1.1.1 (port 53 dicegat). Relay-nya sehat (menjawab dari IP
   Cloudflare asli), tapi tidak terjangkau dari HP atau ESP32 di hotspot XL.
   *.pages.dev saat itu tidak diblokir. Pintu ketiga yang paling tahan blokir
   adalah domain sendiri: cukup tambah route ke Worker yang sama.
   ========================================================================== */
import { roleFor, sameSecret, originAllowed, ARM_ID_RE } from './room.js';

export async function handle(req, env) {
  const url = new URL(req.url);
  if (url.pathname === '/' || url.pathname === '/health') {
    return new Response('armbot relay ok\n', { headers: { 'content-type': 'text/plain' } });
  }
  const m = url.pathname.match(/^\/arm\/([^/]+)\/(device|ui)$/);
  if (!m) return new Response('not found', { status: 404 });
  const [, armId, kind] = m;
  if (!ARM_ID_RE.test(armId)) return new Response('arm id tidak valid', { status: 400 });
  if (req.headers.get('Upgrade') !== 'websocket') {
    return new Response('butuh WebSocket', { status: 426 });
  }

  /* Autentikasi di sini, SEBELUM Durable Object dibangunkan: permintaan tanpa
     kunci tidak boleh memakan kuota DO sama sekali. */
  if (kind === 'device') {
    if (!sameSecret(url.searchParams.get('key') || '', env.DEVICE_KEY)) {
      return new Response('kunci perangkat salah', { status: 401 });
    }
  } else {
    if (!originAllowed(req.headers.get('Origin'), env.ALLOWED_ORIGINS)) {
      return new Response('origin tidak diizinkan', { status: 403 });
    }
    if (!roleFor(url.searchParams.get('token') || '', env)) {
      return new Response('token salah', { status: 401 });
    }
  }
  const stub = env.ARM_ROOM.get(env.ARM_ROOM.idFromName(armId));
  return stub.fetch(req);
}
