import { defineConfig } from 'vite';

// Relative base agar hasil `vite build` (dist/) bisa dibuka langsung dari file://
// maupun disajikan sebagai lampiran statis skripsi.
export default defineConfig({
  base: './',
  server: { port: 5173, open: false },
  build: { outDir: 'dist', target: 'es2020', sourcemap: true },
});
