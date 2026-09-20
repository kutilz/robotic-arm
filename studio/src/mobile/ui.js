/* ============================================================================
   Primitif DOM untuk Arm Pocket.

   Sengaja TIDAK memakai ui/panel.js milik desktop. Bukan karena kodenya jelek,
   tapi karena primitifnya menjawab pertanyaan yang berbeda: section/accordion
   di sana dirancang untuk panel selebar 360 px yang bisa memuat sembilan blok
   sekaligus dan dinavigasi kursor. Di sini yang menentukan bentuk adalah lebar
   jari (target minimal 44 px) dan tinggi layar yang tersisa sesudah E-STOP dan
   bilah tab mengambil jatahnya.
   ========================================================================== */

/** buat elemen: el('button', 'mBtn primary', 'JALAN') */
export function el(tag, cls = '', html = '') {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

/** judul bagian + wadah isinya. Mengembalikan wadahnya, bukan judulnya. */
export function sec(parent, title) {
  const s = el('div', 'mSec');
  if (title) s.appendChild(el('h4', '', title));
  const body = el('div');
  s.appendChild(body);
  parent.appendChild(s);
  return body;
}

export function btn(label, cls, onclick) {
  const b = el('button', 'mBtn ' + (cls || ''), label);
  b.type = 'button';
  if (onclick) b.onclick = onclick;
  return b;
}

export function note(parent, text, kind = '') {
  const n = el('p', 'mNote ' + kind, text);
  parent.appendChild(n);
  return n;
}

/** baris tombol yang lebarnya dibagi rata. */
export function row(...kids) {
  const r = el('div', 'mRow');
  kids.forEach(k => r.appendChild(k));
  return r;
}

/** segmen pilihan tunggal. items = [[key, label], ...] */
export function seg(items, active, onpick) {
  const wrap = el('div', 'mSeg');
  items.forEach(([k, lab]) => {
    const b = el('button', k === active ? 'on' : '', lab);
    b.type = 'button';
    b.dataset.k = k;
    b.onclick = () => {
      wrap.querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.k === k));
      onpick(k);
    };
    wrap.appendChild(b);
  });
  return wrap;
}

/* ---------------- toast ----------------
   Satu satunya saluran pesan di halaman ini. Desktop punya baris status di tiap
   panel; di HP panel yang sedang tidak dibuka tidak bisa menyampaikan apa apa,
   jadi pesan penting (alasan interlock menolak, rutin dihentikan, driver
   hilang) harus muncul di atas panggung, bukan di dalam tab. */
let toastEl = null;
let toastT = null;
export function initToast(node) { toastEl = node; }

/** @param kind '' | 'ok' | 'warn' | 'bad' */
export function toast(msg, kind = '', ms = 3200) {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.className = 'show ' + kind;
  clearTimeout(toastT);
  /* Pesan buruk menetap lebih lama: "driver TMC hilang" yang lewat dalam 3
     detik sama saja dengan tidak pernah ditampilkan kalau mata operator sedang
     di lengan, dan justru di situlah mata operator seharusnya berada. */
  toastT = setTimeout(() => { toastEl.className = ''; }, kind === 'bad' ? ms * 2 : ms);
}

/* ---------------- modal ---------------- */
let modal = null, modalTitle = null, modalBody = null;
export function initModal(root, titleEl, bodyEl, closeBtn) {
  modal = root; modalTitle = titleEl; modalBody = bodyEl;
  closeBtn.onclick = closeModal;
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
}
export function openModal(title, build) {
  modalTitle.textContent = title;
  modalBody.innerHTML = '';
  build(modalBody);
  modal.hidden = false;
}
export function closeModal() { if (modal) modal.hidden = true; }

export const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '--');
