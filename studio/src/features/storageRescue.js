/* ============================================================================
   PENYELAMAT HASIL KERJA YANG TERTINGGAL DI PORT LAIN.

   Masalahnya bukan bug di satu modul, melainkan sifat localStorage: dia terikat
   ORIGIN. Selama 12 sampai 13 Agu 2026 sebuah proses vite lama memegang port
   5173, sehingga tiap `npm run dev` berikutnya mendarat di 5174. Akibatnya
   hasil kerja operator terbelah dua tanpa satu pun pesan: keyframe timeline
   tersimpan di http://localhost:5173, sedangkan pose hasil teach dan tanda
   verifikasi di http://localhost:5174. Dari sisi kode, halaman di satu port
   TIDAK BISA membaca penyimpanan port lain dengan cara apa pun.

   Satu satunya jembatan yang sah adalah halaman di origin itu sendiri yang
   menyerahkan datanya. Itulah public/rescue.html: halaman tanpa aplikasi, cuma
   membaca kunci berawalan `armstudio.` lalu mengirimnya lewat postMessage ke
   induk yang membukanya sebagai iframe.

   Yang dikerjakan modul ini:
     1 buka rescue.html di beberapa port localhost yang wajar sebagai iframe
     2 kumpulkan kunci armstudio. dari tiap port yang menjawab
     3 tulis ke origin ini: kunci runner disimpan dengan akhiran port asalnya
       (mis. armstudio.runner.v4.p5173) supaya penggabung di features/runner.js
       memungutnya sendiri, dan timeline disalin apa adanya kalau di sini belum
       ada. Tidak ada yang ditimpa.
     4 kalau ada yang benar benar baru, halaman dimuat ulang SEKALI supaya
       timeline dan runner membacanya dari awal

   Penjaga: cuma jalan di localhost, cuma sekali per tab (penanda di
   sessionStorage), cuma membaca, dan diam sepenuhnya kalau tidak ada yang
   menjawab. Port yang tidak ada server-nya gagal dalam senyap.
   ========================================================================== */

const PORT_KANDIDAT = [5173, 5174, 5175, 5176, 5177];
const FLAG = 'armstudio.rescue.sesi';
const TIMEOUT_MS = 2500;

const lokal = () => location.hostname === 'localhost' || location.hostname === '127.0.0.1';

/** buka satu port, kembalikan kunci armstudio. yang dijawabnya (atau null). */
function tanyaPort(port) {
  return new Promise((res) => {
    const f = document.createElement('iframe');
    f.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
    f.src = `http://${location.hostname}:${port}/rescue.html`;
    let selesai = false;
    const tutup = (hasil) => {
      if (selesai) return;
      selesai = true;
      clearTimeout(timer);
      window.removeEventListener('message', onMsg);
      f.remove();
      res(hasil);
    };
    const onMsg = (e) => {
      if (!e.data || e.data.t !== 'armstudio.dump') return;
      if (e.source !== f.contentWindow) return;      // jawaban port lain, bukan ini
      tutup(e.data.data || {});
    };
    const timer = setTimeout(() => tutup(null), TIMEOUT_MS);
    window.addEventListener('message', onMsg);
    f.onerror = () => tutup(null);
    document.body.appendChild(f);
  });
}

/**
 * Kumpulkan hasil kerja dari port localhost lain ke origin ini.
 * @returns {Promise<{n:number, dari:string[]}>} jumlah kunci baru yang ditulis.
 */
export async function selamatkanDariPortLain() {
  if (!lokal()) return { n: 0, dari: [] };
  try { if (sessionStorage.getItem(FLAG)) return { n: 0, dari: [] }; } catch { return { n: 0, dari: [] }; }

  const target = PORT_KANDIDAT.filter(p => String(p) !== location.port);
  const jawaban = await Promise.all(target.map(async p => [p, await tanyaPort(p)]));
  try { sessionStorage.setItem(FLAG, '1'); } catch { /* diblokir: paling paling terulang */ }

  let n = 0;
  const dari = [];
  for (const [port, isi] of jawaban) {
    if (!isi || !Object.keys(isi).length) continue;
    let adaBaru = false;
    for (const [k, v] of Object.entries(isi)) {
      let tujuan = null;
      if (k.startsWith('armstudio.runner.')) {
        /* Disimpan dengan akhiran port asal, BUKAN menimpa kunci runner di sini.
           Penggabung di runner.js memindai semua kunci armstudio.runner.* dan
           menyatukan tandanya, jadi data dua origin bisa hidup berdampingan
           tanpa satu pun yang hilang. */
        tujuan = `${k}.p${port}`;
      } else if (k === 'armstudio.timeline.v1' && !localStorage.getItem(k)) {
        tujuan = k;              // keyframe: cuma disalin kalau di sini kosong
      }
      if (!tujuan) continue;
      try {
        if (localStorage.getItem(tujuan) === v) continue;
        localStorage.setItem(tujuan, v);
        n++; adaBaru = true;
      } catch { /* kuota penuh: sisanya dilewati, yang sudah masuk tetap ada */ }
    }
    if (adaBaru) dari.push(`localhost:${port}`);
  }
  return { n, dari };
}
