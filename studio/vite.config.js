import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

// Relative base agar hasil `vite build` (dist/) bisa dibuka langsung dari file://
// maupun disajikan sebagai lampiran statis skripsi.
//
// strictPort WAJIB, dan bukan soal selera: pose hasil teach di tab MOTION
// disimpan di localStorage, yang terikat ORIGIN. Bawaan Vite adalah menggeser
// port diam diam kalau 5173 masih dipegang proses lama (5174, 5175, ...), dan
// studio yang terbuka di port baru datang dengan penyimpanan kosong. Yang
// terlihat operator cuma "restart, semua hasil teach hilang", tanpa satu pun
// pesan salah. Dengan strictPort, port yang bentrok membuat `npm run dev`
// GAGAL dan berisik, bukan berpindah alamat.
// Portnya 5174, bukan 5173 bawaan Vite, dan itu disengaja: seluruh hasil teach
// dan tanda verifikasi yang sudah ada tersimpan di localStorage milik
// http://localhost:5174, karena selama 12 sampai 13 Agu 2026 port 5173 dipegang
// proses vite lama sehingga tiap `npm run dev` mendarat di 5174. Memindahkan
// alamat aplikasi ke sana jauh lebih murah daripada memindahkan datanya.
/* `host: true` menyiarkan dev server ke seluruh WiFi, bukan cuma localhost.
   Ini yang membuat halaman HP (mobile.html) bisa dibuka sama sekali, dan ia
   TIDAK mengubah alamat yang dipakai laptop: desktop tetap membuka
   http://localhost:5174 sehingga localStorage berisi hasil teach, keyframe,
   dan kalibrasi twin tetap di tempatnya.

   Yang harus disadari: HP membuka origin yang LAIN (http://<ip-lan>:5174), dan
   localStorage terikat origin DAN perangkat. Jadi HP tidak akan pernah melihat
   hasil teach maupun keyframe rekaman laptop, seberapa pun benar alamatnya.
   Karena itu halaman mobile sengaja tidak membaca satu pun kunci
   `armstudio.*`: semua pose yang dijalankannya datang dari config/routines.js
   dan config/arm.js, yaitu angka yang ikut git. Lihat kepala src/mobile/main.js. */
export default defineConfig({
  base: './',
  server: { port: 5174, strictPort: true, open: false, host: true },
  build: {
    outDir: 'dist',
    target: 'es2020',
    sourcemap: true,
    rollupOptions: {
      input: {
        main: path.join(here, 'index.html'),
        mobile: path.join(here, 'mobile.html'),
      },
    },
  },
});
