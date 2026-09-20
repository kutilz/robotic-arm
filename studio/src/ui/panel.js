/* ============================================================================
   Helper UI panel: section collapsible, slider, toggle. Port dari legacy.
   ========================================================================== */
export function section(parent, title, openByDefault = true) {
  const s = document.createElement('div'); s.className = 'sec' + (openByDefault ? '' : ' closed');
  s.innerHTML = `<div class="h"><span>${title}</span><span class="ar">▼</span></div><div class="body"></div>`;
  s.querySelector('.h').onclick = () => s.classList.toggle('closed');
  parent.appendChild(s); return s.querySelector('.body');
}

/* Accordion: sama seperti section() di atas tapi SATU yang terbuka pada satu
   waktu. Dipakai mode SERVICE, yang punya sembilan blok komisioning; dulu
   kesembilannya terbuka sekaligus dalam satu kolom yang harus digulung,
   padahal yang dipakai bersamaan biasanya cuma dua.

   Isi tiap blok tetap DIBANGUN DI MUKA dan cuma disembunyikan CSS, tidak
   dibangun saat dibuka. Bukan soal kecepatan: panel kalibrasi mengumpulkan
   tombolnya ke daftar interlock SERVICE sebagai efek samping pembuatan, jadi
   blok yang lahir belakangan tidak akan pernah ikut terkunci. */
export function accordion(parent, { compact = false } = {}) {
  const seksi = [];
  return {
    add(title, openByDefault = false) {
      const s = document.createElement('div');
      s.className = 'sec' + (compact ? ' compact' : '') + (openByDefault ? '' : ' closed');
      s.innerHTML = `<div class="h"><span>${title}</span><span class="ar">▼</span></div><div class="body"></div>`;
      s.querySelector('.h').onclick = () => {
        const buka = s.classList.contains('closed');
        seksi.forEach(x => x.classList.add('closed'));
        s.classList.toggle('closed', !buka);
      };
      parent.appendChild(s);
      seksi.push(s);
      if (openByDefault) seksi.forEach(x => { if (x !== s) x.classList.add('closed'); });
      return s.querySelector('.body');
    },
  };
}

export function slider(parent, label, min, max, val, step, unit, oninput) {
  const r = document.createElement('div'); r.className = 'row';
  r.innerHTML = `<label>${label}</label><input type=range min=${min} max=${max} value=${val} step=${step}><span class="val"></span>`;
  const inp = r.querySelector('input'), v = r.querySelector('.val');
  const upd = () => { v.textContent = (+inp.value).toFixed(step < 1 ? (step < 0.1 ? 2 : 1) : 0) + (unit || ''); };
  inp.oninput = () => { upd(); oninput(+inp.value); }; upd(); parent.appendChild(r); return inp;
}

export function toggle(parent, label, get, set) {
  const t = document.createElement('div'); t.className = 'tgl' + (get() ? ' on' : '');
  t.innerHTML = `<span>${label}</span><span class="dot"></span>`;
  t.onclick = () => { set(!get()); t.classList.toggle('on', get()); };
  parent.appendChild(t); return t;
}

export function buttonRow(parent) {
  const b = document.createElement('div'); b.className = 'btns'; parent.appendChild(b); return b;
}
export function button(row, name, onclick) {
  const b = document.createElement('button'); b.textContent = name; b.onclick = onclick; row.appendChild(b); return b;
}
export function note(parent, html, cls = 'mini') {
  const n = document.createElement('div'); n.className = cls; n.innerHTML = html; parent.appendChild(n); return n;
}
