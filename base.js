// tasteskill / base.js — the small amount of script the motion helpers in base.css need.
// Put this line in <head> so the hidden states only apply when scripting works:
//   <script>document.documentElement.classList.add('js')</script>
// Then load this file at the end of <body> (or with defer).

// Reveal once when an element enters the viewport. Never replays, never leaves content hidden.
(() => {
  const targets = document.querySelectorAll('[data-reveal]');
  if (!targets.length) return;
  if (!('IntersectionObserver' in window)) { targets.forEach((el) => el.classList.add('is-in')); return; }
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('is-in');
      io.unobserve(entry.target);
    }
  }, { rootMargin: '0px 0px -12% 0px', threshold: 0.1 });
  targets.forEach((el) => io.observe(el));
  window.addEventListener('load', () => setTimeout(() => {
    targets.forEach((el) => { const r = el.getBoundingClientRect(); if (r.top < innerHeight && r.bottom > 0) el.classList.add('is-in'); });
  }, 2500));
})();

// Keep the ink-and-paper bars at 28px across the full width.
(() => {
  document.querySelectorAll('.stripe').forEach((row) => {
    const bar = row.querySelector('span');
    if (!bar) return;
    const width = row.getBoundingClientRect().width || 1600;
    const need = Math.ceil(width / 28) + 2;
    while (row.children.length < need) row.appendChild(bar.cloneNode());
  });
})();

// The fixed paintings crossfade. Pause when the tab is hidden.
(() => {
  const frames = document.querySelectorAll('.frame');
  if (!frames.length) return;
  document.addEventListener('visibilitychange', () => {
    const state = document.hidden ? 'paused' : 'running';
    frames.forEach((el) => { el.style.animationPlayState = state; });
  });
})();

// The one live thing: the next line sets itself on the sheet, then the mail carries it.
(() => {
  const input = document.querySelector('#next-line');
  const out = document.querySelector('#set-line');
  const form = document.querySelector('#begin');
  if (!input || !out || !form) return;
  const paint = () => { out.textContent = input.value.trim(); };
  input.addEventListener('input', paint);
  form.addEventListener('submit', () => {
    const line = input.value.trim();
    const body = line ? `The next line: ${line}` : '';
    form.action = `mailto:begin@maravoss.example?subject=${encodeURIComponent('The first page')}&body=${encodeURIComponent(body)}`;
  });
})();

// Openings: the row in ink keeps the painting that belongs with it.
(() => {
  const rows = [...document.querySelectorAll('.work-row')];
  const shots = [...document.querySelectorAll('.work-photo img')];
  const cap = document.querySelector('#work-caption');
  if (!rows.length) return;
  const show = (index) => {
    rows.forEach((row, n) => row.setAttribute('aria-pressed', n === index ? 'true' : 'false'));
    shots.forEach((img, n) => img.classList.toggle('is-on', n === index));
    const row = rows[index];
    if (cap && row) cap.textContent = row.dataset.caption || '';
  };
  rows.forEach((row, index) => row.addEventListener('click', () => show(index)));
})();
