/* ------------------------------------------------------------------------
   app.js — the only bespoke JS in the template.
   Alpine handles small UI state; HTMX handles everything that touches data.
   ------------------------------------------------------------------------ */

/* Search fields live inside sheets/collapses that are still animating open, so
   retry briefly until the element is actually visible before focusing. */
function focusWhenVisible(selector, attempts = 12) {
  let tries = 0;
  const tick = () => {
    const el = document.querySelector(selector);
    if (el && el.offsetParent !== null) return el.focus();
    if (tries++ < attempts) setTimeout(tick, 60);
  };
  setTimeout(tick, 80);
}

/* -------------------------------------------------------- installable app */
/**
 * Chrome fires beforeinstallprompt once and then shows its own banner on its own
 * schedule — dismiss that banner and there is no way back to it, so the shop reads as
 * having no app at all. Holding on to the event lets the menu offer the real install
 * dialog whenever the shopper is ready.
 *
 * The event has to be captured before Alpine boots, which is why this sits at the top
 * level rather than inside alpine:init.
 */
let deferredInstall = null;

window.addEventListener('beforeinstallprompt', (e) => {
  // Stops the mini-infobar so the choice is ours to offer, not the browser's to bury.
  e.preventDefault();
  deferredInstall = e;
  if (window.Alpine && Alpine.store('ui')) Alpine.store('ui').canInstall = true;
});

window.addEventListener('appinstalled', () => {
  deferredInstall = null;
  if (window.Alpine && Alpine.store('ui')) Alpine.store('ui').canInstall = false;
});

/** Already running as an installed app — nothing left to offer. */
function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

/**
 * iOS has no beforeinstallprompt at all: Safari only installs from its own Share
 * sheet. Detected so the menu can say how rather than showing a button that cannot
 * work — and iPadOS reports itself as a Mac, hence the touch check.
 */
function isIos() {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/* ---------------------------------------------------------- Alpine store */
document.addEventListener('alpine:init', () => {
  Alpine.store('ui', {
    cart: false,
    menu: false,
    quick: false,
    filters: false,
    appSearch: false,
    appCats: false,
    deskSearch: false,
    mega: null,

    /* Install: canInstall is set by the captured event, so the entry only appears
       where it can actually do something. */
    canInstall: false,
    iosInstall: false,
    installed: false,
    showIosHelp: false,

    async install() {
      if (!deferredInstall) return;
      deferredInstall.prompt();
      const { outcome } = await deferredInstall.userChoice;
      // One prompt per event: Chrome will not let the same one be reused.
      deferredInstall = null;
      this.canInstall = false;
      if (outcome === 'accepted') this.installed = true;
    },
    openQuick() { this.quick = true; },
    /* Desktop: the header shows a lens only; this expands the slim field. */
    toggleDeskSearch() {
      this.deskSearch = !this.deskSearch;
      if (this.deskSearch) focusWhenVisible('#q-d');
    },
    /* Search tab on phone/tablet: open the sheet, then focus the field. */
    openAppSearch() {
      this.appCats = false;
      this.appSearch = true;
      focusWhenVisible('[x-ref="appq"]');
    },
    /* deskSearch is inline in the header, not an overlay — it must not lock scroll. */
    anyOverlay() {
      return this.cart || this.menu || this.quick || this.filters || this.appSearch || this.appCats;
    }
  });

  /* Set once Alpine exists, since the event may have fired before it booted. */
  const ui = Alpine.store('ui');
  ui.installed = isStandalone();
  ui.canInstall = !!deferredInstall && !ui.installed;
  ui.iosInstall = isIos() && !ui.installed;

  // Lock body scroll while any overlay is open.
  Alpine.effect(() => {
    const open = Alpine.store('ui').anyOverlay();
    document.documentElement.style.overflow = open ? 'hidden' : '';
  });
});

function store() {
  return window.Alpine && Alpine.store ? Alpine.store('ui') : null;
}

/* --------------------------------------------------- cart drawer / toasts */
document.addEventListener('cart:open', () => {
  const s = store();
  if (!s) return;
  s.quick = false;
  s.filters = false;
  s.appSearch = false;
  s.appCats = false;
  s.cart = true;
});

document.addEventListener('cart:changed', () => {
  const badge = document.getElementById('cart-count');
  if (badge) {
    badge.animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(1.35)' }, { transform: 'scale(1)' }],
      { duration: 380, easing: 'ease-out' }
    );
  }
});

/* Toast helper — used for wishlist feedback; cart uses the drawer itself. */
function toast(message) {
  const stack = document.getElementById('toast-stack');
  if (!stack) return;
  const el = document.createElement('div');
  el.className = 'toast pointer-events-auto border border-line bg-ink px-4 py-3 text-[11px] uppercase tracking-[0.14em] text-ivory shadow-lg';
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s, transform .3s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    setTimeout(() => el.remove(), 320);
  }, 2400);
}
window.toast = toast;

/* --------------------------------------------------------------- wishlist */
/* Keeps every heart for the same product in sync (a product can appear in
   several rails on one page) without a second round trip. */
document.addEventListener('wishlist:changed', (e) => {
  const { id, active } = e.detail || {};
  if (!id) return;
  document.querySelectorAll(`[data-wl="${id}"]`).forEach((btn) => {
    btn.setAttribute('aria-pressed', String(active));
    const svg = btn.querySelector('svg');
    if (!svg) return;
    svg.setAttribute('fill', active ? 'currentColor' : 'none');
    svg.classList.toggle('text-maroon', !!active);
    svg.classList.toggle('text-ink', !active);
  });
  toast(active ? 'Saved to wishlist' : 'Removed from wishlist');
});

/* ------------------------------------------------------- listing filters */
function triggerFilterForm() {
  const form = document.getElementById('filter-form');
  if (form) form.dispatchEvent(new Event('change', { bubbles: true }));
}

window.removeFilter = function (name, value) {
  const form = document.getElementById('filter-form');
  if (!form) return;
  form.querySelectorAll(`input[name="${name}"]`).forEach((input) => {
    if (input.value === value) input.checked = false;
  });
  triggerFilterForm();
};

window.clearFilters = function () {
  const form = document.getElementById('filter-form');
  if (!form) return;
  form.querySelectorAll('input[type="checkbox"]').forEach((i) => { i.checked = false; });
  triggerFilterForm();
};

/* --------------------------------------------------------- carousel rails */
window.scrollCarousel = function (id, direction) {
  const rail = document.getElementById(id);
  if (!rail) return;
  rail.scrollBy({ left: direction * Math.round(rail.clientWidth * 0.8), behavior: 'smooth' });
};

/* ------------------------------------------------- lazy section safety net */
/* htmx's own `revealed` only fires while an element passes through the
   viewport. If a visitor jumps (anchor link, restored scroll position, fast
   flick), a section can end up above the fold and sit as a skeleton forever.
   This sweep catches anything at-or-above the fold and loads it. */
(function lazySweep() {
  let pending = null;

  function sweep() {
    if (!window.htmx) return;
    document.querySelectorAll('[hx-trigger*="revealed"]').forEach((el) => {
      if (el.dataset.lazySwept) return;
      const rect = el.getBoundingClientRect();
      if (rect.top < window.innerHeight * 1.15) {
        el.dataset.lazySwept = '1';
        htmx.trigger(el, 'revealed');
      }
    });
  }

  function schedule() {
    clearTimeout(pending);
    pending = setTimeout(sweep, 180);
  }

  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule, { passive: true });
  document.addEventListener('DOMContentLoaded', schedule);
  document.addEventListener('htmx:afterSettle', schedule);
})();

/* ----------------------------------------------- slim top progress bar */
/* Deliberately not a spinner: content areas fade or show skeletons instead. */
(function progressBar() {
  const bar = document.createElement('div');
  bar.id = 'nprogress';
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(bar));

  let inflight = 0;
  let timer = null;

  function start() {
    inflight++;
    bar.classList.add('active');
    bar.style.width = '35%';
    clearTimeout(timer);
    timer = setTimeout(() => { bar.style.width = '72%'; }, 260);
  }

  function done() {
    inflight = Math.max(0, inflight - 1);
    if (inflight > 0) return;
    clearTimeout(timer);
    bar.style.width = '100%';
    setTimeout(() => {
      bar.classList.remove('active');
      setTimeout(() => { bar.style.width = '0'; }, 220);
    }, 140);
  }

  document.addEventListener('htmx:beforeRequest', start);
  document.addEventListener('htmx:afterRequest', done);
})();

/* --------------------------------------------------------- HTMX polish */
document.addEventListener('DOMContentLoaded', () => {
  if (!window.htmx) return;

  // Keep the search dropdown snappy but avoid hammering the server.
  htmx.config.defaultSwapStyle = 'innerHTML';
  htmx.config.historyCacheSize = 12;
  htmx.config.includeIndicatorStyles = false;
});

/* Close the search dropdown after navigating away via a suggestion. */
document.addEventListener('htmx:afterSwap', (e) => {
  if (e.detail.target && e.detail.target.id === 'checkout-body') {
    const top = document.getElementById('checkout-body');
    if (top) window.scrollTo({ top: top.getBoundingClientRect().top + window.scrollY - 120, behavior: 'smooth' });
  }
});

document.addEventListener('keydown', (e) => {
  const s = store();
  if (!s) return;

  // Escape closes whatever is open.
  if (e.key === 'Escape') {
    s.cart = false; s.quick = false; s.menu = false; s.filters = false;
    s.appSearch = false; s.appCats = false; s.deskSearch = false;
    return;
  }

  // "/" opens search — unless the visitor is already typing somewhere.
  const typing = /^(input|textarea|select)$/i.test((e.target.tagName || '')) || e.target.isContentEditable;
  if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    if (window.matchMedia('(min-width: 1024px)').matches) {
      s.deskSearch = true;
      focusWhenVisible('#q-d');
    } else {
      s.openAppSearch();
    }
  }
});

/* Tapping a search suggestion should close the app search sheet. */
document.addEventListener('click', (e) => {
  if (!e.target.closest || !e.target.closest('#suggest-app a')) return;
  const s = store();
  if (s) s.appSearch = false;
});
