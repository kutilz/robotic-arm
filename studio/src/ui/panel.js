/* ============================================================================
   Helper UI panel: section collapsible, slider, toggle. Port dari legacy.
   ========================================================================== */
export function section(parent, title, openByDefault = true) {
  const s = document.createElement('div'); s.className = 'sec' + (openByDefault ? '' : ' closed');
  s.innerHTML = `<div class="h"><span>${title}</span><span class="ar">▼</span></div><div class="body"></div>`;
  s.querySelector('.h').onclick = () => s.classList.toggle('closed');
  parent.appendChild(s); return s.querySelector('.body');
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
