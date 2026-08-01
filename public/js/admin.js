/* ------------------------------------------------------------------------
   admin.js — Alpine store, toasts, confirm dialog, chart hover layer.
   Loaded before Alpine core (see views/admin/partials/open.ejs).
   ------------------------------------------------------------------------ */

document.addEventListener('alpine:init', () => {
  Alpine.store('admin', {
    nav: false,
    confirm: { open: false, title: '', body: '', cta: 'Delete', el: null },

    /** Any element with data-confirm routes its click through the dialog. */
    ask(el) {
      this.confirm = {
        open: true,
        title: el.dataset.confirmTitle || 'Are you sure?',
        body: el.dataset.confirm || 'This cannot be undone.',
        cta: el.dataset.confirmCta || 'Delete',
        el
      };
    },
    cancel() { this.confirm = { ...this.confirm, open: false, el: null }; },
    proceed() {
      const el = this.confirm.el;
      this.confirm = { ...this.confirm, open: false, el: null };
      if (!el) return;
      el.dataset.confirmed = '1';
      if (window.htmx) htmx.trigger(el, 'confirmed');
    }
  });
});

/* Intercept clicks on data-confirm elements until the dialog approves them. */
document.addEventListener('click', (e) => {
  const el = e.target.closest && e.target.closest('[data-confirm]');
  if (!el) return;
  if (el.dataset.confirmed === '1') { delete el.dataset.confirmed; return; }
  e.preventDefault();
  e.stopPropagation();
  if (window.Alpine && Alpine.store) Alpine.store('admin').ask(el);
}, true);

/* ------------------------------------------------------------------ toasts */
function toast(message, tone) {
  const stack = document.getElementById('admin-toasts');
  if (!stack) return;
  const el = document.createElement('div');
  const border = tone === 'critical' ? '#d03b3b' : tone === 'warning' ? '#fab219' : '#0ca30c';
  el.className = 'pointer-events-auto border bg-panel px-4 py-3 text-[12px] shadow-lg';
  el.style.borderColor = border;
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s, transform .3s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 320);
  }, 3200);
}
window.adminToast = toast;

/* Some actions change a whole table; the server asks for a redraw rather than
   every handler having to return the right fragment. */
document.addEventListener('admin:reload', () => setTimeout(() => window.location.reload(), 400));

/* Server-driven notices: HX-Trigger: {"admin:toast": {...}} */
document.addEventListener('admin:toast', (e) => {
  const d = e.detail || {};
  toast(d.message || 'Saved', d.tone);
});

/* ------------------------------------------------------------------ charts */
/**
 * Hover layer for inline-SVG charts. Any <svg> inside a `.viz` wrapper whose
 * marks carry data-label / data-value gets a shared tooltip — no per-chart JS.
 */
function bindCharts(root) {
  (root || document).querySelectorAll('.viz').forEach((viz) => {
    if (viz.dataset.bound === '1') return;
    viz.dataset.bound = '1';
    viz.style.position = viz.style.position || 'relative';

    const tip = document.createElement('div');
    tip.className = 'viz-tooltip';
    viz.appendChild(tip);

    viz.addEventListener('mousemove', (e) => {
      const mark = e.target.closest('[data-label]');
      if (!mark) { tip.classList.remove('is-visible'); return; }
      tip.innerHTML = `<b>${mark.dataset.label}</b><br>${mark.dataset.value}`
        + (mark.dataset.value2 ? `<br>${mark.dataset.value2}` : '');
      const box = viz.getBoundingClientRect();
      const x = e.clientX - box.left;
      const y = e.clientY - box.top;
      tip.style.left = Math.min(Math.max(8, x + 12), box.width - tip.offsetWidth - 8) + 'px';
      tip.style.top = Math.max(4, y - tip.offsetHeight - 10) + 'px';
      tip.classList.add('is-visible');
    });

    viz.addEventListener('mouseleave', () => tip.classList.remove('is-visible'));
  });
}

document.addEventListener('DOMContentLoaded', () => bindCharts());
document.addEventListener('htmx:afterSwap', (e) => bindCharts(e.detail.target));

/* Auto-submit filter forms on change without a submit button. */
document.addEventListener('change', (e) => {
  const form = e.target.closest && e.target.closest('form[data-auto-submit]');
  if (form && window.htmx) htmx.trigger(form, 'submit');
});
