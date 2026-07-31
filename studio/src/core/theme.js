/* ============================================================================
   Tema: dark-only, sistem warna mengadopsi Waldo Commander.
   - UI dikendalikan CSS variable (styles/theme.css).
   - Scene (Three.js) tidak bisa baca CSS variable, jadi warna hex ada di sini.
   Axis mengikuti konvensi robotics (X merah, Y hijau, Z biru) versi CVD-aware.
   ========================================================================== */

export const SceneColors = {
  dark: {
    background: '#0b1015',
    ground: '#18242e',
    groundMajor: '#33505f',
    material: '#a3a3a3',
  },
  axisX: 0xe05a4e, axisY: 0x31c98a, axisZ: 0x5b78ff,
  axisRX: 0xf1a79f, axisRY: 0xaee5cf, axisRZ: 0xaeb9f3,
  accent: 0x38bdf8,
  ok: 0x22c55e, warn: 0xf5b942, over: 0xef4444,
};

export function getTheme() { return 'dark'; }
export function sceneTheme() { return SceneColors.dark; }

/** dark-only: tema tidak pernah berubah; API dipertahankan untuk kompatibilitas. */
export function onThemeChange() { return () => {}; }

/** ambil nilai CSS variable saat runtime (untuk warna status di panel). */
export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
