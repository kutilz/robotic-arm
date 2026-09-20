/* ============================================================================
   KALIBRASI TWIN (blok di mode SERVICE).

   Yang disetel di sini BUKAN lengan, melainkan cara twin MENGGAMBAR sudut yang
   sama. Tidak ada satu byte pun yang dikirim ke firmware dari file ini: sudut
   yang dikirim studio harus tetap sama artinya dengan sudut di halaman bawaan
   ESP32 dan di data pengujian yang sudah terlanjur dicatat, jadi yang boleh
   dibetulkan cuma gambarnya.

   Dua besaran per sendi, dua duanya hanya bisa ditentukan dengan MELIHAT lengan
   (tidak ada di CAD, dan tidak ada di firmware):
     arah  +/-  ke mana twin berputar saat sudut sendi naik
     trim  deg  sudut yang ditambahkan sebelum digambar; membetulkan sendi yang
                di lengan ada di home tapi di twin tampil bengkok

   Kenapa ini panel dan bukan cuma konstanta di cadRig.js: menentukan angkanya
   perlu satu putaran "putar sendi -> lihat -> betulkan -> lihat lagi", dan
   memuat ulang halaman di tiap putaran berarti kehilangan koneksi bridge dan
   pose yang sedang dipegang. Nilai yang dipakai tetap dari cadRig.js; panel ini
   menimpanya di runtime, menyimpannya di localStorage, dan menyalakan penanda
   "belum masuk kode" selama hasil setelan belum ditulis balik ke sana. Tombol
   `salin` menyiapkan barisnya supaya perjalanan ke kode tinggal tempel.
   ========================================================================== */
import { STATE } from '../config/arm.js';
import { applyPose } from '../model/kinematics.js';
import { recalibrateTwin } from '../model/rig.js';
import { getTwinCal, setTwinCal, twinCalDirty, TWIN_CAL_DEFAULT } from '../model/cadRig.js';

/* v2 (13 Agu 2026): membuang setelan runtime yang tersimpan di browser.
   Alasannya konkret. J4 sempat digeser 180 lewat tombol di panel ini karena
   dikira twin yang salah menggambar pergelangan; ternyata yang salah lengannya,
   dan sesudah lengan dibetulkan geseran itu berbalik jadi kesalahan, yaitu
   twin yang setengah putaran meleset dari lengan yang sudah benar.

   Yang bikin dia berbahaya bukan nilainya, melainkan tempatnya: setelan panel
   ini menang atas TWIN_CAL_DEFAULT di cadRig.js dan hidup di localStorage per
   origin, jadi kode bisa benar sementara satu peramban tetap menggambar pose
   yang lain, tanpa ada yang bisa melihatnya dari repo. Menaikkan kunci
   memulangkan semua peramban ke angka di cadRig.js sekali jalan.

   Sesudah ini, cara membetulkan twin tetap sama: setel di panel, lihat lengan,
   lalu tekan `salin` dan tempel hasilnya ke TWIN_CAL_DEFAULT. Selama belum
   ditempel, penanda "belum masuk kode" memang menyala, dan itu bukan cacat
   melainkan pengingat. */
const LS_KEY = 'armstudio.twincal.v2';

const rows = [];
let dirtyEl = null;
let hintEl = null;

/* ---------------- persistensi ---------------- */
function save() {
  try {
    const c = getTwinCal();
    // Kalibrasi yang sama dengan bawaan TIDAK disimpan. Dengan begitu, sekali
    // hasil setelan ditulis balik ke cadRig.js, localStorage berhenti menjadi
    // salinan kedua yang diam diam bisa menyimpang dari kode.
    if (!twinCalDirty()) localStorage.removeItem(LS_KEY);
    else localStorage.setItem(LS_KEY, JSON.stringify(c));
  } catch { /* kuota penuh / mode privat: setelan tidak persisten, bukan fatal */ }
}

/** Baca kalibrasi twin dari localStorage. WAJIB dipanggil sebelum buildRig(),
 *  karena offset home ikut dihitung saat rantai dibangun. */
export function loadTwinCal() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) setTwinCal(JSON.parse(raw));
  } catch { /* localStorage rusak/diblokir: jalan dengan bawaan cadRig.js */ }
}

/* ---------------- terapkan ---------------- */
/* applyPose(true): ini perubahan CARA MENGGAMBAR, bukan edit pose. Lewat jalur
   biasa ia akan men-set STATE.poseDirty sehingga bridge menahan feedback dan
   badge melompat ke `target`, padahal operator justru sedang membandingkan
   twin dengan lengan yang hidup. */
function apply() {
  recalibrateTwin();
  applyPose(true);
  draw();
  save();
}

function draw() {
  const { dir, trim } = getTwinCal();
  rows.forEach((r, i) => {
    r.dirBtn.textContent = dir[i] > 0 ? '+' : '−';
    r.dirBtn.classList.toggle('flip', dir[i] < 0);
    r.dirBtn.title = dir[i] > 0
      ? `J${i + 1} berputar mengikuti kaidah tangan kanan sumbu CAD`
      : `J${i + 1} dibalik terhadap sumbu CAD`;
    if (document.activeElement !== r.trimInp) r.trimInp.value = trim[i];
    r.trimInp.classList.toggle('nz', trim[i] !== 0);
  });
  const dirty = twinCalDirty();
  dirtyEl.dataset.st = dirty ? 'warn' : 'ok';
  dirtyEl.querySelector('.t').textContent = dirty ? 'belum masuk kode' : 'sama dengan kode';
}

/** baris `dir` + `trim` siap tempel ke TWIN_CAL_DEFAULT di cadRig.js. */
function snippet() {
  const { dir, trim } = getTwinCal();
  return `export const TWIN_CAL_DEFAULT = {\n`
    + `  dir: [${dir.join(', ')}],\n`
    + `  trim: [${trim.join(', ')}],\n};`;
}

/* ---------------- UI ---------------- */
export function buildTwinCal(body) {
  const cap = document.createElement('div'); cap.className = 'calCap';
  cap.textContent = 'kalibrasi twin';
  body.appendChild(cap);

  const note = document.createElement('div'); note.className = 'mini';
  note.textContent = 'Hanya mengubah cara model 3D menggambar sudut. Tidak ada perintah '
    + 'yang dikirim ke lengan, dan sudut yang dikirim studio tidak ikut berubah.';
  body.appendChild(note);

  /* Pengingat yang menempel di panelnya sendiri, bukan cuma di komentar kode:
     angka J4/J5/J6 diukur terhadap pergelangan versi lama. Yang paling mahal
     bukan salah nilai, melainkan salah nilai yang terlihat sudah beres. */
  const stale = document.createElement('div'); stale.className = 'mini';
  stale.style.color = 'var(--warn)';
  stale.textContent = 'J4, J5, J6 diukur 12 Agu 2026 terhadap pergelangan SEBELUM dibongkar '
    + 'pasang. Putar ketiganya satu per satu dan cocokkan lagi sebelum dipercaya, lalu '
    + 'tekan salin dan tempel hasilnya ke cadRig.js.';
  body.appendChild(stale);

  const hdr = document.createElement('div'); hdr.className = 'rnJRow rnJHdr tcRow';
  hdr.innerHTML = '<span></span><span>arah</span><span>trim °</span><span></span>';
  body.appendChild(hdr);

  STATE.joints.forEach((j, i) => {
    const row = document.createElement('div'); row.className = 'rnJRow tcRow';

    const k = document.createElement('span'); k.className = 'rnJk';
    k.textContent = j.id; k.title = j.name;

    const dirBtn = document.createElement('button'); dirBtn.className = 'tcDir';
    dirBtn.onclick = () => {
      const { dir } = getTwinCal();
      setTwinCal({ dir: dir.map((v, m) => (m === i ? -v : v)) });
      apply();
      hint(`${j.id} dibalik. Putar sendi itu di lengan dan lihat apakah twin sekarang ikut ke arah yang sama.`);
    };

    const trimInp = document.createElement('input');
    trimInp.type = 'number'; trimInp.className = 'rnJn'; trimInp.step = 5;
    const setTrim = () => {
      const v = +trimInp.value;
      if (!Number.isFinite(v)) return;
      const { trim } = getTwinCal();
      setTwinCal({ trim: trim.map((t, m) => (m === i ? v : t)) });
      apply();
    };
    trimInp.onchange = setTrim;
    trimInp.title = `derajat yang ditambahkan ke ${j.id} sebelum digambar. `
      + `Sendi ${j.id} di home tapi twin bengkok: geser sampai twin ikut lurus.`;

    /* 180 dapat tombolnya sendiri karena ini kasus yang benar benar muncul di
       lengan ini (J6 terpasang ter-roll setengah putaran), dan mengetiknya
       lewat panah step 5 butuh 36 klik. */
    const b180 = document.createElement('button'); b180.className = 'rnMini';
    b180.textContent = '180';
    b180.title = 'geser trim 180 derajat (dan kembali)';
    b180.onclick = () => {
      const { trim } = getTwinCal();
      const v = ((trim[i] + 180) % 360 + 360) % 360;
      setTwinCal({ trim: trim.map((t, m) => (m === i ? (v > 180 ? v - 360 : v) : t)) });
      apply();
    };

    row.append(k, dirBtn, trimInp, b180);
    body.appendChild(row);
    rows.push({ dirBtn, trimInp });
  });

  const btns = document.createElement('div'); btns.className = 'calBtns';
  const bReset = document.createElement('button');
  bReset.textContent = 'BAWAAN';
  bReset.title = 'kembali ke arah + trim yang tertulis di cadRig.js';
  bReset.onclick = () => {
    setTwinCal({ dir: TWIN_CAL_DEFAULT.dir, trim: TWIN_CAL_DEFAULT.trim });
    apply();
    hint('Kembali ke nilai bawaan di cadRig.js.');
  };
  const bCopy = document.createElement('button');
  bCopy.textContent = 'SALIN';
  bCopy.title = 'salin nilai sekarang sebagai TWIN_CAL_DEFAULT untuk cadRig.js';
  bCopy.onclick = async () => {
    const s = snippet();
    try {
      await navigator.clipboard.writeText(s);
      hint('Tersalin. Tempel ke TWIN_CAL_DEFAULT di studio/src/model/cadRig.js '
        + 'supaya setelan ini ikut ke gambar skripsi dan verify_cad_rig.mjs.');
    } catch {
      // clipboard butuh konteks aman; di http:// polos ia menolak. Jangan
      // menghilangkan angkanya cuma karena penyalinnya gagal.
      hint(s.replace(/\n\s*/g, ' '));
    }
  };
  btns.append(bReset, bCopy);
  body.appendChild(btns);

  const st = document.createElement('div'); st.className = 'tcState';
  dirtyEl = document.createElement('span'); dirtyEl.className = 'plamp';
  dirtyEl.innerHTML = '<i class="pd"></i><span class="t"></span>';
  st.appendChild(dirtyEl);
  body.appendChild(st);

  hintEl = document.createElement('div'); hintEl.className = 'mini';
  body.appendChild(hintEl);
  hint('Putar satu sendi di lengan, bandingkan dengan twin, lalu betulkan barisnya.');

  draw();
}

function hint(msg) { if (hintEl) hintEl.textContent = msg; }
