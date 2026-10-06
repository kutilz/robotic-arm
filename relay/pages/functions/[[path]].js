// Pintu masuk kedua relay lewat Cloudflare Pages (armbot-relay.pages.dev).
// Semua logika di ../../src/gate.js; Durable Object-nya milik Worker armbot-relay.
import { handle } from '../../src/gate.js';

export const onRequest = (ctx) => handle(ctx.request, ctx.env);
