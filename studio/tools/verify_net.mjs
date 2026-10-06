/* ============================================================================
   Buktikan aturan link internet (net/netQuality.js) TANPA peramban, relay,
   atau lengan:

     node studio/tools/verify_net.mjs

   Yang dijaga di sini adalah keputusan yang tidak boleh salah begitu studio
   mengendalikan lengan lewat internet:

     1 TINGKAT LINK. RTT yang khas WiFi rumah, 4G sehat, dan 4G tersendat
       harus jatuh ke tingkat yang benar, dan stall yang SEDANG berlangsung
       (pong belum datang) harus terdeteksi sebelum p95 sempat menyusul.
     2 HISTERESIS. Turun tingkat seketika, naik baru sesudah bertahan. Link
       yang bolak balik di perbatasan tidak boleh menyalakan-mematikan LIVE.
     3 LEASE. Selalu lebih panjang dari dua ping yang hilang (supaya satu
       paket telat tidak merem lengan) dan tidak pernah melewati batas
       firmware (LEASE_MAX_MS 8000).
     4 KECEPATAN SAMA DI DUA JALUR. Jalur cloud mengirim lebih jarang dengan
       jatah lebih besar, tapi laju gerak per detiknya harus identik dengan
       jalur lokal; kalau tidak, profil TEACH di cloud diam diam lebih cepat.
   ========================================================================== */
import {
  rawLevel, LevelGate, leaseFor, percentile, jitter, PROFILE, PING_MS,
  CLOUD_TICK_MS, LOCAL_TICK_MS, UPGRADE_HOLD_MS,
} from '../src/net/netQuality.js';
import { stepPerTick, TICK_MS } from '../src/net/liveRamp.js';
import { SPEED } from '../src/config/routines.js';

let bad = 0;
const check = (nama, ok, detail = '') => {
  console.log(`  ${ok ? 'OK  ' : 'GAGAL'} ${nama}${detail ? '  ' + detail : ''}`);
  if (!ok) bad++;
};

// Generator acak berbiji supaya hasilnya sama tiap dijalankan.
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const series = (n, base, spread, spikeP = 0, spike = 0) =>
  Array.from({ length: n }, () => base + rnd() * spread + (rnd() < spikeP ? spike : 0));

console.log('\n== 1 tingkat link ==');
{
  const wifi = series(40, 6, 12);                 // 6..18 ms
  const g4 = series(40, 90, 150);                  // 90..240 ms: dua kaki 4G
  const g4buruk = series(40, 60, 80, 0.1, 600);    // 10% paket telat 600 ms
  check('WiFi rumah -> lan', rawLevel({ samples: wifi }) === 'lan', `p95 ${percentile(wifi, 95).toFixed(0)} ms`);
  check('4G sehat (operator dan lengan sama sama di 4G) -> baik', rawLevel({ samples: g4 }) === 'baik', `p95 ${percentile(g4, 95).toFixed(0)} ms`);
  check('4G tersendat -> buruk', rawLevel({ samples: g4buruk }) === 'buruk', `p95 ${percentile(g4buruk, 95).toFixed(0)} ms`);
  check('stall berjalan 1,2 s terdeteksi walau p95 masih bagus',
    rawLevel({ samples: g4, overdueMs: 1200 }) === 'buruk');
  check('pong telat melebihi lease -> putus',
    rawLevel({ samples: g4, overdueMs: 2000, leaseMs: 1500 }) === 'putus');
  check('loss di atas 10% -> buruk', rawLevel({ samples: g4, lost: 6, sent: 40 }) === 'buruk');
  check('belum ada sampel dan tidak ada yang telat -> baik (tidak menghukum koneksi baru)',
    rawLevel({ samples: [] }) === 'baik');
  check('jitter dihitung dari selisih berurutan', Math.abs(jitter([10, 20, 10, 20]) - 10) < 1e-9);
}

console.log('\n== 2 histeresis ==');
{
  const g = new LevelGate();
  let t = 0;
  g.update('baik', t);
  check('turun ke buruk seketika', g.update('buruk', (t += 500)) === 'buruk');
  check('naik ke baik TIDAK seketika', g.update('baik', (t += 500)) === 'buruk');
  // flap: baik, buruk, baik, ... tiap 500 ms selama 10 detik
  let naik = 0;
  for (let k = 0; k < 20; k++) {
    const lv = g.update(k % 2 ? 'buruk' : 'baik', (t += 500));
    if (lv === 'baik') naik++;
  }
  check('link bolak balik tidak pernah sempat naik', naik === 0);
  let lv;
  for (let k = 0; k <= UPGRADE_HOLD_MS / 500; k++) lv = g.update('baik', (t += 500));
  check(`naik sesudah bertahan ${UPGRADE_HOLD_MS} ms`, lv === 'baik');
  check('putus langsung dari lan', g.update('putus', (t += 1)) === 'putus');
}

console.log('\n== 3 lease ==');
{
  check('lokal 1000 ms', leaseFor('local', 10) === 1000);
  for (const p95 of [NaN, 50, 140, 400, 2000, 10000]) {
    const L = leaseFor('cloud', p95);
    check(`cloud p95 ${p95}: ${L} ms dalam 1500..5000 dan > 2 ping hilang`,
      L >= 1500 && L <= 5000 && L > 2 * PING_MS);
  }
  check('lease tumbuh dengan p95', leaseFor('cloud', 1200) > leaseFor('cloud', 100));
}

console.log('\n== 4 laju gerak sama di dua jalur ==');
{
  check('periode lokal = TICK_MS liveRamp', LOCAL_TICK_MS === TICK_MS);
  for (const k of Object.keys(SPEED)) {
    const dpsLokal = stepPerTick(SPEED[k].speed, LOCAL_TICK_MS) * 1000 / LOCAL_TICK_MS;
    const dpsCloud = stepPerTick(SPEED[k].speed, CLOUD_TICK_MS) * 1000 / CLOUD_TICK_MS;
    check(`profil ${k}: ${dpsLokal.toFixed(2)} vs ${dpsCloud.toFixed(2)} deg/s`,
      Math.abs(dpsLokal - dpsCloud) < 1e-9 && Math.abs(dpsLokal - SPEED[k].speed) < 1e-9);
  }
  check('tingkat buruk/putus mematikan LIVE dan RUN',
    !PROFILE.buruk.live && !PROFILE.buruk.run && !PROFILE.putus.live && !PROFILE.putus.run);
  check('feedback cloud tidak melebihi batas firmware 25 Hz',
    Object.values(PROFILE).every(p => p.fbHz > 0 && p.fbHz <= 25));
}

console.log('\n' + (bad === 0 ? 'semua pemeriksaan lulus' : `${bad} PEMERIKSAAN GAGAL`));
process.exit(bad === 0 ? 0 : 1);
