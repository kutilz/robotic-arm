/* ============================================================================
   Pulsa gripper yang BOLEH dikirim dari HP.

   Aturannya disalin dari syncGripLimits() di features/runner.js, dan yang
   disalin bukan angkanya melainkan ARAHNYA. Di gripper ini pulsa KECIL membuka
   rahang dan pulsa BESAR menutupnya (hasil sapu di lengan terakit, 13 Agu 2026:
   travel 1406..1859 us, open 1406 / close 1856). Tebakan lama yang menulis
   kebalikannya adalah satu satunya jalur yang bisa menukar arti "buka" dan
   "tutup" tanpa ada yang mengetiknya, dan tidak ada pesan salah yang muncul
   kalau itu terjadi: rahang cuma bergerak ke arah yang salah.

   Nilai di luar travel TIDAK dijepit satu per satu. Menjepit nilai yang meleset
   ke ujung terdekat bisa mendarat di ujung yang salah; kalau travel hasil
   kalibrasi tidak memuat nilai bawaan, keduanya ditulis ulang sekaligus ke dua
   ujung travel.
   ========================================================================== */
import { getCal, SERVO_GRIP } from '../net/bridge.js';
import { GRIP_US_DEFAULT } from '../config/routines.js';

/** @returns {{open:number, close:number, calibrated:boolean, min:number, max:number}} */
export function gripPulses() {
  const cal = getCal();
  const lo = cal && cal.servo_us_min, hi = cal && cal.servo_us_max;
  const min = Array.isArray(lo) ? lo[SERVO_GRIP] : NaN;
  const max = Array.isArray(hi) ? hi[SERVO_GRIP] : NaN;

  // Belum ada cal (belum tersambung, atau cal_get belum dijawab): pakai angka
  // terukur dari repo apa adanya, dan katakan bahwa itu belum diverifikasi.
  if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
    return { ...GRIP_US_DEFAULT, calibrated: false, min: 500, max: 2500 };
  }
  // Travel penuh 500..2500 = default pabrik, artinya gripper belum pernah disapu.
  const calibrated = !(min === 500 && max === 2500);
  const d = GRIP_US_DEFAULT;
  const muat = d.open >= min && d.open <= max && d.close >= min && d.close <= max;
  if (calibrated && !muat) return { open: min, close: max, calibrated, min, max };
  return { ...d, calibrated, min, max };
}
