'use strict';

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const { loadConfig, money } = require('./src/config');
const catalog = require('./src/catalog');
const cart = require('./src/cart');
const placeholder = require('./src/placeholder');
const { swatch } = require('./src/swatches');
const ordersStore = require('./src/orders');
const reviews = require('./src/reviews');
const googleReviews = require('./src/reviews-google');
const uploads = require('./src/uploads');
const journal = require('./src/journal');
const marketing = require('./src/marketing');
const discounts = require('./src/discounts');
const attribution = require('./src/attribution');
const shopper = require('./src/shopper');
const theme = require('./src/theme');
const returns = require('./src/returns');
const invoice = require('./src/invoice');
const pincode = require('./src/pincode');
const gstin = require('./src/gstin');
const delivery = require('./src/delivery');
const fulfilment = require('./src/fulfilment');
const variants = require('./src/variants');
const audience = require('./src/audience');
const plans = require('./src/plan');
const cod = require('./src/cod');
const payments = require('./src/payments');
const notifications = require('./src/notifications');
const activity = require('./src/activity');
const hx = require('./src/hx');
const adminRoutes = require('./src/routes/admin');
const adminContentRoutes = require('./src/routes/admin-content');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
/* Theme first, views/ always last. A theme holds only the files whose look differs, so
   anything it does not override falls through — and a missing theme cannot 404 a page.
   Set per request as well (below), since the active theme is config, and config reloads. */
app.set('views', theme.roots(loadConfig()));
// Bulk uploads are pasted/read as text, so the limit needs headroom.
app.use(express.urlencoded({ extended: true, limit: '8mb' }));
app.use(express.json({ limit: '8mb' }));
app.use(cookieParser());
// Remembers utm_source / ?ref= for 30 days so orders carry their campaign.
app.use(attribution.capture);
// Long cache in production; no cache in dev so CSS/JS edits show up on refresh.
app.use('/static', express.static(path.join(__dirname, 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '7d' : 0
}));

/* ------------------------------------------------------------- locals ---- */

// Cache-buster for /static assets: stamped at boot, so a restart (or deploy)
// always serves fresh CSS/JS even with long cache headers.
const ASSET_VERSION = Date.now().toString(36);

app.use((req, res, next) => {
  const config = loadConfig();
  res.locals.v = ASSET_VERSION;
  res.locals.config = config;
  res.locals.money = (n) => money(n, config);
  res.locals.swatch = swatch;
  res.locals.catalog = catalog;
  res.locals.cartSummary = cart.hydrate(req, config);
  res.locals.wishlistIds = cart.readWishlist(req);
  res.locals.isHx = req.get('HX-Request') === 'true';
  res.locals.currentPath = req.path;
  res.locals.reviews = reviews;
  res.locals.returns = returns;
  res.locals.orders = ordersStore;
  res.locals.cod = cod;
  res.locals.cart = cart;
  res.locals.delivery = delivery;
  res.locals.fulfilment = fulfilment;
  res.locals.variants = variants;
  /* Resolves a view name theme-first and hands back an ABSOLUTE path. Views must use
     include(view('partials/header')) rather than a relative include: EJS resolves a
     root-relative include against the including file's own directory before it looks at
     the views roots, so a base page would find the base partial next to it and never
     see the theme's. */
  res.locals.view = theme.resolver(config);
  app.set('views', theme.roots(config));
  res.locals.themeName = theme.current(config);

  res.locals.shopper = shopper;
  /* Who this browser is, as far as a guest checkout can honestly say. Set here so
     the several places that render a checkout step cannot each forget it. */
  res.locals.me = shopper.current(req);
  res.locals.savedAddresses = res.locals.me.addresses;
  /* Which section of the shop this visitor is in. A single-audience shop resolves
     to its only audience and never shows a chooser or a switcher. */
  res.locals.audience = audience.current(req, config);
  res.locals.audienceId = res.locals.audience ? res.locals.audience.id : null;
  res.locals.audiences = audience.list(config);
  /* Asked only when the answer changes what they see. A shop whose default is EVERYTHING
     already shows a first-time visitor the whole catalogue, so a popup asking which
     section they want is friction that buys nothing — the header switcher is there for
     anyone who does want to narrow. */
  res.locals.audienceChoiceNeeded = audience.isMultiple(config)
    && (config.audiences || {}).default !== audience.EVERYTHING
    && !audience.hasChosen(req, config);
  // The header renders THIS nav, not config.nav — menswear must not show Sarees.
  res.locals.nav = audience.navFor(req, config);
  res.locals.hasFeature = (id) => plans.hasFeature(config, id);
  res.locals.marketing = marketing;
  res.locals.origin = marketing.origin(req, config);
  res.locals.seo = null;      // per-page meta, set by the route
  res.locals.jsonLd = [];     // structured data nodes, rendered in <head>
  next();
});

/* --------------------------------------------------------------- admin ---- */
/* Mounted before the storefront 404 handler. */
app.use('/admin', adminRoutes.router);
app.use('/admin', adminContentRoutes.router);

/* -------------------------------------------------- placeholder images ---- */

app.get('/ph.svg', (req, res) => {
  const config = loadConfig();
  const body = placeholder.svg({
    seed: req.query.seed,
    w: req.query.w,
    h: req.query.h,
    label: req.query.label,
    kind: req.query.kind,
    monogram: config.brand.monogram || config.brand.name.charAt(0),
    theme: config.theme
  });
  res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(body);
});

/* Installable-app manifest, generated from the same config as the UI. */
app.get('/manifest.webmanifest', (req, res) => {
  const c = loadConfig();
  const icon = (size) => ({
    src: `/ph.svg?seed=${encodeURIComponent(c.brand.name)}&w=${size}&h=${size}&label=${encodeURIComponent(c.brand.monogram)}`,
    sizes: `${size}x${size}`,
    type: 'image/svg+xml',
    purpose: 'any'
  });
  res.type('application/manifest+json').json({
    name: `${c.brand.name} — ${c.brand.tagline}`,
    short_name: c.brand.name,
    description: c.brand.tagline,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: c.theme.colors.ivory,
    theme_color: c.theme.colors.ivory,
    icons: [icon(192), icon(512)]
  });
});

/**
 * Storefront half of the plan gate.
 *
 * A locked feature returns 404, not 402: a customer has no business seeing what
 * the shop owner did or didn't buy. To them the page simply does not exist.
 */
function storefrontFeature(id) {
  return function storefrontGate(req, res, next) {
    if (plans.hasFeature(loadConfig(), id)) return next();
    return next('route');
  };
}

/**
 * The visitor picks a section. Stored in a cookie for six months, changeable any
 * time from the header — it is a preference, not a gate: a direct link to any
 * product always opens regardless.
 */
app.post('/audience', (req, res) => {
  const config = loadConfig();
  const wanted = String(req.body.audience || '');
  const picked = audience.choose(req, res, config, wanted);

  /* "Everything" is a valid answer that resolves to no audience at all, so a null
     return is not automatically a failure — only an unknown id is. Treating them the
     same sent every "show me everything" click to the homepage as if it had erred. */
  const accepted = wanted === audience.EVERYTHING || !!picked;

  const next = String(req.body.next || '/');
  const safe = next.startsWith('/') && !next.startsWith('//') ? next : '/';
  if (!accepted) return res.redirect('/');
  if (res.locals.isHx) {
    res.set('HX-Redirect', safe);
    return res.status(200).send('');
  }
  return res.redirect(safe);
});

/* --------------------------------------------------------------- home ---- */

app.get('/', (req, res) => {
  const config = loadConfig();
  const d = marketing.data();
  res.locals.seo = {
    title: config.brand.name + ' — ' + config.brand.tagline,
    description: d.aeo.answerBlurb || d.seo.defaultDescription || config.brand.tagline,
    keywords: d.seo.keywords.join(', ')
  };
  res.locals.jsonLd = [
    marketing.organisationJsonLd(config, res.locals.origin),
    marketing.faqJsonLd(marketing.globalFaqs())
  ].filter(Boolean);
  res.render('pages/home', { title: null });
});

// Lazy-loaded homepage sections (hx-trigger="revealed").
app.get('/fragments/home-section/:index', async (req, res) => {
  const config = loadConfig();
  const section = (config.homeSections || [])[parseInt(req.params.index, 10)];
  if (!section) return res.status(404).send('');

  // Testimonials can come from live Google reviews when a place id is configured.
  let googleStore = null;
  const rc = config.reviews || {};
  if (section.type === 'testimonials' && (rc.source === 'google' || rc.source === 'both')) {
    googleStore = await googleReviews.fetchStore(config);
  }

  res.render('fragments/home-section', { section, lazy: false, index: req.params.index, googleStore });
});

/* ------------------------------------------------------------- search ---- */

app.get('/fragments/search-suggest', (req, res) => {
  const config = loadConfig();
  const result = catalog.suggest(String(req.query.q || ''), config, 6, res.locals.audienceId);
  res.render('fragments/search-suggest', { result });
});

app.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  const exact = catalog.all().find((p) => p.name.toLowerCase() === q.toLowerCase());
  if (exact) return res.redirect(`/product/${exact.slug}`);
  res.redirect(`/category/all?q=${encodeURIComponent(q)}`);
});

/* ------------------------------------------------------ product listing ---- */

function listingModel(req, res) {
  const config = loadConfig();
  const slug = req.params.slug || 'all';
  const filters = catalog.parseQuery(req.query);
  const perPage = (config.features && config.features.productsPerPage) || 8;
  const result = catalog.search(slug, filters, perPage, res.locals.audienceId);
  // Look the category up in the AUDIENCE's nav, so a men's category page gets
  // its own heading rather than falling through to a womenswear one.
  const navEntry = (res.locals.nav || config.nav || []).find((n) => n.slug === slug);
  return {
    slug,
    filters,
    result,
    perPage,
    facets: catalog.facets(slug, res.locals.audienceId),
    priceRanges: catalog.PRICE_RANGES,
    sorts: catalog.SORTS,
    /* "All Couture" is the demo store's word for its whole catalogue and reads oddly on a
       shop selling trousers. Configurable, defaulting to the couture wording so nothing
       changes for a store that does not set it. */
    heading: navEntry ? navEntry.label
      : (filters.q ? `Results for “${filters.q}”` : ((config.copy && config.copy.allCategoryHeading) || 'All Couture')),
    navEntry,
    activeCount: catalog.activeFilterCount(filters)
  };
}

app.get('/category/:slug', (req, res) => {
  const config = loadConfig();
  const model = listingModel(req, res);
  res.locals.seo = marketing.metaForCategory(model.slug, model.heading, config);
  res.locals.jsonLd = [
    marketing.breadcrumbJsonLd([
      { label: 'Home', href: '/' },
      { label: model.heading, href: '/category/' + model.slug }
    ], res.locals.origin),
    {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      name: model.heading,
      numberOfItems: model.result.total,
      itemListElement: model.result.items.slice(0, 12).map((p, i) => ({
        '@type': 'ListItem', position: i + 1, url: res.locals.origin + '/product/' + p.slug, name: p.name
      }))
    }
  ];
  res.render('pages/listing', { ...model, title: model.heading });
});

// Grid-only fragment: filter change, sort change and "load more" all hit this.
app.get('/fragments/products/:slug', (req, res) => {
  const model = listingModel(req, res);
  const append = req.query.append === '1';
  // Filter/sort changes rewrite the address bar; "load more" must not, or a
  // reload would land the visitor on page 2 with page 1 missing.
  if (!append) res.set('HX-Push-Url', catalog.buildUrl(model.slug, model.filters, { page: 1 }));
  res.render('fragments/grid-items', { ...model, append });
});

/* ------------------------------------------------------ product detail ---- */

app.get('/product/:slug', (req, res, next) => {
  const config = loadConfig();
  const product = catalog.bySlug(req.params.slug);
  if (!product) return next();

  const faqs = [...marketing.faqsFor(product.slug), ...marketing.globalFaqs()].slice(0, 6);
  res.locals.seo = marketing.metaForProduct(product, config);
  res.locals.jsonLd = [
    marketing.productJsonLd(product, config, res.locals.origin),
    marketing.faqJsonLd(faqs),
    marketing.breadcrumbJsonLd([
      { label: 'Home', href: '/' },
      { label: product.categories[0] || 'Shop', href: '/category/' + (product.categories[0] || 'all') },
      { label: product.name, href: '/product/' + product.slug }
    ], res.locals.origin)
  ].filter(Boolean);

  res.render('pages/product', {
    product,
    related: catalog.related(product, 8),
    reviewList: reviews.forProduct(product.id),
    reviewStats: reviews.stats(product.id),
    faqs,
    title: product.name
  });
});

app.get('/fragments/quick-view/:slug', (req, res) => {
  const product = catalog.bySlug(req.params.slug);
  if (!product) return res.status(404).send('');
  res.render('fragments/quick-view', { product });
});

app.get('/fragments/size-chart', (req, res) => {
  // Opened from a product page, the guide should show that product's audience —
  // a men's kurta buyer has no use for a bust measurement.
  const product = req.query.product ? catalog.bySlug(String(req.query.product)) : null;
  res.render('fragments/size-chart', { product });
});

/* ----------------------------------------------------------- wishlist ---- */

app.post('/wishlist/toggle/:id', storefrontFeature('wishlist'), (req, res) => {
  const product = catalog.byId(req.params.id) || catalog.bySlug(req.params.id);
  if (!product) return res.status(404).send('');
  const { ids, active } = cart.toggleWishlist(req, res, product.id);
  res.locals.wishlistIds = ids;
  hx.trigger(res, { 'wishlist:changed': { id: product.id, active } });
  res.render('fragments/wishlist-button', {
    product,
    active,
    variant: req.query.variant || 'card',
    count: ids.length
  });
});

app.get('/wishlist', storefrontFeature('wishlist'), (req, res) => {
  res.render('pages/wishlist', { products: cart.wishlistProducts(req), title: 'Wishlist' });
});

/* --------------------------------------------------------------- cart ---- */

/**
 * Every cart mutation re-renders one of two views:
 *   view=page  → the /cart page list (target #cart-page)
 *   default    → the slide-in drawer (target #cart-panel)
 * Both emit an out-of-band header badge, so the count is never stale.
 */
function renderCart(req, res, opts = {}) {
  const config = loadConfig();
  res.locals.cartSummary = cart.hydrate(req, config);
  res.locals.couponError = opts.couponError || null;
  const isPageView = req.body && req.body.view === 'page';
  const events = { 'cart:changed': true };
  if (opts.open && !isPageView) events['cart:open'] = true;
  hx.trigger(res, events);
  if (isPageView) return res.render('fragments/cart-page');
  res.render('fragments/cart-drawer', { justAdded: opts.justAdded || null });
}

app.post('/cart/add', (req, res) => {
  cart.addToCart(req, res, {
    id: req.body.id,
    size: req.body.size,
    color: req.body.color,
    qty: req.body.qty
  });
  const product = catalog.byId(req.body.id) || catalog.bySlug(req.body.id);
  renderCart(req, res, { open: true, justAdded: product ? product.id : null });
});

app.post('/cart/update', (req, res) => {
  cart.updateQty(req, res, req.body.key, req.body.qty);
  renderCart(req, res);
});

app.post('/cart/remove', (req, res) => {
  cart.removeLine(req, res, req.body.key);
  renderCart(req, res);
});

/* Coupons: the code lives in a cookie and is re-validated on every render, so an
   expired or under-minimum code stops applying on its own. */
app.post('/cart/coupon', (req, res) => {
  const config = loadConfig();
  const code = String(req.body.code || '').trim();
  const summary = cart.hydrate(req, config);
  const result = discounts.evaluate(code, summary.subtotal);

  if (result.ok) cart.setDiscountCode(req, res, result.code);
  renderCart(req, res, { couponError: result.ok ? null : result.reason });
});

app.post('/cart/coupon/remove', (req, res) => {
  cart.clearDiscountCode(req, res);
  renderCart(req, res);
});

app.get('/fragments/cart-drawer', (req, res) => {
  res.render('fragments/cart-drawer', { justAdded: null });
});

app.get('/cart', (req, res) => {
  res.render('pages/cart', { title: 'Shopping Bag' });
});

/* ----------------------------------------------------------- checkout ---- */

const STEPS = [
  { id: 1, key: 'address', label: 'Address' },
  { id: 2, key: 'delivery', label: 'Delivery' },
  { id: 3, key: 'payment', label: 'Payment' }
];

function checkoutState(req) {
  try {
    return JSON.parse(Buffer.from(req.cookies.aanya_checkout || '', 'base64').toString('utf8')) || {};
  } catch {
    return {};
  }
}

/**
 * The state checkout should open with.
 *
 * A returning customer's most recent address fills the form, but only where they
 * have not already typed something this visit — a half-finished form must never be
 * overwritten by a remembered one. The saved address is a starting point, not a
 * decision: the form is fully editable and there is a way to clear it outright.
 */
function checkoutStateFor(req) {
  return shopper.prefill(checkoutState(req), shopper.current(req));
}

function saveCheckoutState(res, state) {
  res.cookie('aanya_checkout', Buffer.from(JSON.stringify(state), 'utf8').toString('base64'), {
    httpOnly: true, sameSite: 'lax', path: '/', maxAge: 1000 * 60 * 60 * 24 * 7
  });
}

const REQUIRED = {
  1: ['fullName', 'phone', 'pincode', 'address1', 'city', 'state'],
  2: ['deliveryMethod'],
  3: ['paymentMethod']
};

function validateStep(step, body) {
  const errors = {};
  (REQUIRED[step] || []).forEach((f) => {
    if (!body[f] || String(body[f]).trim() === '') errors[f] = 'Required';
  });
  if (step === 1) {
    if (body.phone && !/^[0-9+\-\s]{10,15}$/.test(body.phone)) errors.phone = 'Enter a valid phone number';
    if (body.pincode && !/^[0-9]{6}$/.test(body.pincode)) errors.pincode = 'Enter a 6-digit pincode';
    if (body.email && !/^\S+@\S+\.\S+$/.test(body.email)) errors.email = 'Enter a valid email';

    // A GSTIN is optional, but a wrong one is worse than none: it goes onto the
    // invoice and into GSTR-1, and the buyer's input credit silently never
    // arrives. Checked here, with its check digit, so it fails at the field.
    const gst = gstin.check(body.gstin);
    if (!gst.ok) errors.gstin = gst.reason;
    // A business buyer needs a name on the invoice that matches their
    // registration, not the name of whoever placed the order.
    if (gst.ok && !gst.empty && !String(body.businessName || '').trim()) {
      errors.businessName = 'Registered business name is required for a GST invoice';
    }
  }
  return errors;
}

/** COD availability for the current cart + the address entered so far. */
/**
 * The cart as checkout sees it: base totals plus the delivery method and gift
 * wrap the customer picked. Also published on res.locals so the order-summary
 * partial and the step fragment can never disagree with what we charge.
 */
/**
 * The config as the COD rules should see it. A store whose plan doesn't include
 * cash on delivery behaves exactly like a store whose owner switched it off —
 * same code path, same message, one less thing that can disagree.
 */
function codConfigFor(config) {
  if (plans.hasFeature(config, 'cod')) return config;
  return { ...config, shipping: { ...config.shipping, cod: { ...(config.shipping.cod || {}), enabled: false } } };
}

function checkoutSummary(req, res, config, state) {
  const summary = cart.withCheckoutExtras(cart.hydrate(req, config), state || checkoutState(req), config);
  res.locals.cartSummary = summary;
  return summary;
}

function codCheckFor(req, res, config) {
  const state = checkoutState(req);
  const summary = checkoutSummary(req, res, config, state);
  return cod.evaluate(codConfigFor(config), { pincode: state.pincode, total: summary.total });
}

app.get('/checkout', (req, res) => {
  const config = loadConfig();
  const summary = checkoutSummary(req, res, config);
  if (!summary.count) return res.redirect('/category/all');
  res.render('pages/checkout', {
    steps: STEPS,
    step: 1,
    state: checkoutStateFor(req),
    errors: {},
    codCheck: codCheckFor(req, res, config),
    title: 'Checkout'
  });
});

/**
 * "Not you?" — drops the remembered address and details.
 *
 * Someone buying a gift for their sister needs one obvious way to start fresh, or
 * they edit four fields, miss the fifth, and the parcel goes to the wrong city.
 */
app.post('/checkout/forget', (req, res) => {
  shopper.forget(res);

  const config = loadConfig();
  const state = {};
  saveCheckoutState(res, state);

  const summary = checkoutSummary(req, res, config, state);
  res.render('fragments/checkout-step', {
    steps: STEPS, step: 1, state, summary, errors: {},
    me: shopper.blank(), savedAddresses: [],   // forgotten: override the locals
    codCheck: cod.evaluate(codConfigFor(config), { pincode: '', total: summary.total })
  });
});

/** Switches to another remembered address without retyping it. */
app.post('/checkout/address/:index', (req, res) => {
  const config = loadConfig();
  const me = shopper.current(req);
  const picked = me.addresses[Math.max(0, parseInt(req.params.index, 10) || 0)];

  const state = { ...checkoutState(req) };
  if (picked) shopper.ADDRESS_FIELDS.forEach((k) => { state[k] = picked[k] || ''; });
  saveCheckoutState(res, state);

  const summary = checkoutSummary(req, res, config, state);
  res.render('fragments/checkout-step', {
    steps: STEPS, step: 1, state, summary, errors: {},
    // Newest-first order would jump the chosen address to the top mid-edit, so keep
    // the list as it is and let the form show what was picked.
    savedAddresses: me.addresses,
    codCheck: cod.evaluate(codConfigFor(config), { pincode: state.pincode || '', total: summary.total })
  });
});

app.post('/checkout/step/:target', (req, res) => {
  const config = loadConfig();
  const target = Math.max(1, Math.min(3, parseInt(req.params.target, 10) || 1));
  const from = Math.max(1, Math.min(3, parseInt(req.body._from, 10) || 1));
  const state = { ...checkoutState(req), ...req.body };
  delete state._from;

  // Moving forward validates the step being left; moving back never blocks.
  const errors = target > from ? validateStep(from, state) : {};
  saveCheckoutState(res, state);

  const step = Object.keys(errors).length ? from : target;
  const summary = checkoutSummary(req, res, config, state);
  hx.trigger(res, { 'checkout:step': step });
  res.render('fragments/checkout-step', {
    steps: STEPS, step, state, errors,
    codCheck: cod.evaluate(codConfigFor(config), { pincode: state.pincode, total: summary.total })
  });
});

/**
 * Re-prices the cart when a delivery option changes and returns just the
 * summary block. No page reload, no step change — the total updates under the
 * customer's cursor, which is the whole point of picking express.
 */
/**
 * Pincode lookup. Fills city and state by out-of-band swap and answers the two
 * questions a customer would otherwise abandon over: when does it arrive, and is
 * COD available here. Cached locally, so the second customer from a pincode
 * costs nothing.
 */
app.post('/checkout/pincode', async (req, res) => {
  const config = loadConfig();
  const result = await pincode.lookup(req.body.pincode);

  let codCheck = null;
  let eta = null;
  if (result.ok) {
    // Persist it so a refresh — or the next step — keeps what we resolved.
    const state = { ...checkoutState(req), ...req.body };
    delete state._from;
    if (result.city) state.city = result.city;
    if (result.state) state.state = result.state;
    saveCheckoutState(res, state);

    const summary = checkoutSummary(req, res, config, state);
    codCheck = cod.evaluate(codConfigFor(config), { pincode: result.pincode, total: summary.total });

    const ship = config.shipping || {};
    const metro = /mumbai|delhi|bengaluru|bangalore|chennai|kolkata|hyderabad|pune|ahmedabad/i.test(result.city || '');
    const days = metro ? ship.estimateDaysMetro : ship.estimateDaysOther;
    if (days) eta = `arrives in about ${days} working days`;
  }

  res.render('fragments/pincode-result', { result, codCheck, eta });
});

app.post('/checkout/quote', (req, res) => {
  const config = loadConfig();
  const state = { ...checkoutState(req), ...req.body };
  delete state._from;
  saveCheckoutState(res, state);
  checkoutSummary(req, res, config, state);
  res.render('partials/order-summary');
});

app.post('/checkout/place-order', async (req, res) => {
  const config = loadConfig();
  const state = { ...checkoutState(req), ...req.body };
  const errors = validateStep(3, state);
  const summary = checkoutSummary(req, res, config, state);
  if (Object.keys(errors).length) {
    return res.render('fragments/checkout-step', {
      steps: STEPS, step: 3, state, errors,
      codCheck: cod.evaluate(codConfigFor(config), { pincode: state.pincode, total: summary.total })
    });
  }
  if (!summary.count) {
    res.set('HX-Redirect', '/category/all');
    return res.status(200).send('');
  }

  // Someone else may have bought the last piece while this cart sat open.
  const shortfalls = cart.stockProblems(summary);
  if (shortfalls.length) {
    return res.render('fragments/checkout-step', {
      steps: STEPS, step: 3, state,
      errors: { stock: shortfalls.map((s2) => s2.message).join(' ') },
      codCheck: cod.evaluate(codConfigFor(config), { pincode: state.pincode, total: summary.total })
    });
  }

  // Persist the order so it shows up in the admin, then clean up the cart.
  // Reject a COD choice the rules no longer allow (pincode changed, cart grew…)
  const plan = cod.planFor(codConfigFor(config), { method: state.paymentMethod, pincode: state.pincode, total: summary.total });
  if (!plan) {
    return res.render('fragments/checkout-step', {
      steps: STEPS, step: 3, state,
      errors: { paymentMethod: 'unavailable' },
      codCheck: cod.evaluate(codConfigFor(config), { pincode: state.pincode, total: summary.total })
    });
  }

  // With a gateway connected, nothing is written until the payment verifies —
  // otherwise an abandoned payment would leave a phantom order in the admin.
  const payable = payments.payableNow({ cartSummary: summary, codPlan: plan, config });
  const gateway = payments.status(config);

  if (gateway.live && payable > 0) {
    try {
      const intent = await payments.createIntent({
        cartSummary: summary,
        codPlan: plan,
        config,
        receipt: 'chk_' + Date.now().toString(36),
        customer: { name: state.fullName, phone: state.phone, email: state.email }
      });
      saveCheckoutState(res, { ...state, pendingPlan: plan });
      return res.render('fragments/checkout-pay', { intent, state, summary, plan, payable });
    } catch (err) {
      return res.render('fragments/checkout-step', {
        steps: STEPS, step: 3, state,
        errors: { gateway: err.message },
        codCheck: cod.evaluate(codConfigFor(config), { pincode: state.pincode, total: summary.total })
      });
    }
  }

  // Manual mode, or nothing to charge now (full COD).
  const order = await finaliseOrder({ req, res, config, summary, state, plan, payment: null });
  res.set('HX-Redirect', `/order/${order.id}`);
  res.status(200).send('');
});

/**
 * The single place an order becomes real: write it, mark the coupon used, clear
 * the cart, then fire notifications. Called from both the manual path and the
 * post-payment verification path so the two can never drift apart.
 */
async function finaliseOrder({ req, res, config, summary, state, plan, payment }) {
  const order = ordersStore.create({
    cartSummary: summary,
    state,
    config,
    attribution: attribution.forOrder(req),
    codPlan: plan,
    payment
  });

  if (summary.discountCode) discounts.markUsed(summary.discountCode);
  cart.clearCart(req, res);
  cart.clearDiscountCode(req, res);
  saveCheckoutState(res, {
    ...state,
    pendingPlan: null,
    lastOrder: { id: order.id, total: order.total, email: state.email || '' }
  });

  /* This browser now owns this order, and whatever they typed is what we know about
     them next time. Signed, because these ids decide who may read an order. */
  shopper.rememberOrder(res, shopper.current(req), { order, state });

  // Never let a mail failure break a completed checkout.
  notifications.orderPlaced(order, config, marketing.origin(req, config)).catch((err) => console.error('order email failed:', err.message));
  activity.log('Orders', `${order.id} placed · ${config.currency.symbol}${order.total.toLocaleString('en-IN')}${payment ? ' · ' + payment.provider : ''}`);

  return order;
}

/**
 * Gateway callback. The signature is checked against the key secret before an
 * order exists — a forged response gets nothing.
 */
app.post('/checkout/verify', async (req, res) => {
  const config = loadConfig();
  const state = checkoutState(req);
  const summary = checkoutSummary(req, res, config, state);

  if (!summary.count) {
    res.set('HX-Redirect', '/category/all');
    return res.status(200).send('');
  }

  const check = payments.verify({ payload: req.body, config });
  if (!check.ok) {
    return res.status(400).render('fragments/checkout-step', {
      steps: STEPS, step: 3, state,
      errors: { gateway: check.reason || 'Payment could not be verified.' },
      codCheck: cod.evaluate(codConfigFor(config), { pincode: state.pincode, total: summary.total })
    });
  }

  const plan = state.pendingPlan
    || cod.planFor(codConfigFor(config), { method: state.paymentMethod, pincode: state.pincode, total: summary.total });

  const order = await finaliseOrder({
    req, res, config, summary, state, plan,
    payment: {
      provider: payments.settings(config).provider,
      paymentId: check.paymentId,
      gatewayOrderId: check.gatewayOrderId,
      amount: payments.payableNow({ cartSummary: summary, codPlan: plan, config }),
      at: new Date().toISOString()
    }
  });

  res.set('HX-Redirect', `/order/${order.id}`);
  res.status(200).send('');
});

/**
 * Server-to-server webhook — the source of truth when a browser dies mid-redirect.
 * Needs the raw body for the HMAC, so it's mounted with its own parser.
 */
app.post('/webhooks/payments', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  const config = loadConfig();
  const signature = req.get('x-razorpay-signature') || req.get('stripe-signature') || '';
  const raw = req.body instanceof Buffer ? req.body.toString('utf8') : String(req.body || '');

  if (!payments.verifyWebhook({ raw, signature, config })) {
    console.warn('payment webhook rejected: bad signature');
    return res.status(400).json({ ok: false });
  }

  let event = {};
  try { event = JSON.parse(raw); } catch { /* ignore */ }

  // Reconcile: if the browser never came back, the order may not exist yet. We
  // log it for the admin rather than guessing a cart that has since changed.
  activity.log('Payments', `Webhook ${event.event || 'received'}${event.payload && event.payload.payment ? ' · ' + event.payload.payment.entity.id : ''}`);
  res.json({ ok: true });
});

/**
 * Your orders, without an account.
 *
 * Reads only the ids this browser is signed as owning, so this cannot become a way
 * to enumerate the shop's orders. An id we no longer hold — a deleted order — is
 * dropped rather than rendered as a blank row.
 */
app.get('/orders', (req, res) => {
  const me = shopper.current(req);
  const rows = me.orderIds
    .map((id) => ordersStore.byId(id))
    .filter(Boolean)
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

  res.locals.seo = { title: 'Your orders' + marketing.data().seo.titleSuffix, description: 'Track the orders you have placed.' };
  res.render('pages/orders', { title: 'Your orders', rows, me });
});

/** A shared computer is the normal case in a family, not an edge case. */
app.post('/orders/forget', (req, res) => {
  shopper.forget(res);
  res.redirect('/orders');
});

app.get('/order/:id', (req, res) => {
  const state = checkoutState(req);
  const id = String(req.params.id || '').trim().toUpperCase();
  const order = ordersStore.byId(id);

  /* Order ids run in sequence, so ORD-00042 tells anyone that ORD-00041 exists.
     Without a check, walking the numbers read back what strangers had paid. Proof is
     either of the two the invoice already accepts: this browser placed the order, or
     the contact on it is supplied. */
  const me = shopper.current(req);
  const ownSession = (state.lastOrder && String(state.lastOrder.id).toUpperCase() === id)
    || shopper.ownsOrder(me, id);

  const check = (order && req.query.contact)
    ? ordersStore.verifyPurchase({ orderId: id, contact: req.query.contact, productId: order.items[0] && order.items[0].productId })
    : { reason: 'no contact' };
  const contactOk = !!req.query.contact && !/find that order|match the order/.test(check.reason || '');

  if (order && !ownSession && !contactOk) {
    return res.redirect('/returns?order=' + encodeURIComponent(id));
  }

  res.render('pages/order', {
    orderId: id,
    order: order || state.lastOrder || null,
    placed: order || null,
    state,
    title: 'Order Confirmed'
  });
});

/**
 * Customer copy of the tax invoice. Identity is proved one of two ways: the
 * order was placed in this browser session, or the email/phone on the order is
 * supplied. Without either we send them through the returns lookup rather than
 * handing an address and phone number to anyone who guesses an order id.
 */
app.get('/order/:id/invoice', (req, res) => {
  const id = String(req.params.id || '').trim().toUpperCase();
  const order = ordersStore.byId(id);
  if (!order) return res.status(404).redirect('/returns');

  const state = checkoutState(req);
  const ownSession = state.lastOrder && String(state.lastOrder.id).toUpperCase() === id;
  const check = req.query.contact
    ? ordersStore.verifyPurchase({ orderId: id, contact: req.query.contact, productId: order.items[0] && order.items[0].productId })
    : { reason: 'no contact' };
  // verifyPurchase also gates on delivery; for identity we only care that the
  // order number and contact belong together.
  const contactOk = !!req.query.contact && !/find that order|match the order/.test(check.reason || '');

  if (!ownSession && !contactOk) return res.redirect('/returns?invoice=' + encodeURIComponent(id));

  res.render('invoice', { inv: invoice.build(order, loadConfig()), isAdmin: false });
});

/**
 * Deliverability from the product page.
 *
 * Answers the two questions that otherwise wait until checkout — when does it
 * arrive, and can I pay cash — using the same pincode module and the same COD
 * rules the checkout uses, so a promise made here is kept there.
 */
app.post('/product/:slug/deliverability', async (req, res) => {
  const config = loadConfig();
  const product = catalog.bySlug(req.params.slug);
  if (!product) return res.status(404).send('');

  const result = await pincode.lookup(req.body.pincode);
  if (!result.ok) {
    return res.send(`<span class="text-maroon">${result.reason}</span>`);
  }

  const ship = config.shipping || {};
  const metro = /mumbai|delhi|bengaluru|bangalore|chennai|kolkata|hyderabad|pune|ahmedabad/i.test(result.city || '');
  const days = metro ? ship.estimateDaysMetro : ship.estimateDaysOther;
  // Judged on this one piece, which is what the shopper is looking at.
  const codCheck = cod.evaluate(codConfigFor(config), { pincode: result.pincode, total: product.price });

  // If the shop delivers here itself, that is the headline — not a courier ETA.
  const methods = delivery.methodsFor(config, {
    pincode: result.pincode, city: result.city, subtotal: product.price,
    // A made-to-order piece cannot be offered same-day, however local the buyer is.
    makeDays: Number(product.deliveryDays) || 0
  });
  const local = methods.find((m) => m.fulfilment === 'own');
  const pickup = methods.find((m) => m.fulfilment === 'pickup');

  res.render('fragments/deliverability', { result, days, codCheck, product, config, local, pickup });
});

/* ------------------------------------------------- returns & refunds ---- */

/** Track an order / start a return — no account, just the order number. */
app.get('/returns', storefrontFeature('returns'), (req, res) => {
  res.locals.seo = { title: 'Returns & refunds' + marketing.data().seo.titleSuffix, description: 'Track an order or request a return.' };
  res.render('pages/returns', {
    title: 'Returns', lookup: null, error: null, state: {},
    invoiceWanted: String(req.query.invoice || '').trim().toUpperCase().slice(0, 20),
    orderWanted: String(req.query.order || '').trim().toUpperCase().slice(0, 20)
  });
});

app.post('/returns/lookup', storefrontFeature('returns'), (req, res) => {
  const config = loadConfig();
  const order = ordersStore.byId(String(req.body.orderId || '').trim().toUpperCase());
  const check = ordersStore.verifyPurchase({
    orderId: req.body.orderId,
    contact: req.body.contact,
    productId: order && order.items.length ? order.items[0].productId : null
  });

  // verifyPurchase also gates on delivery; for a lookup we only need identity.
  const identityOk = order && check.reason !== 'We can’t find that order number.' && check.reason !== 'That email or phone doesn’t match the order.';
  if (!order || !identityOk) {
    return res.status(422).render('fragments/returns-lookup', {
      order: null, eligibility: null, existing: null,
      error: check.reason || 'We can’t find that order.', state: req.body
    });
  }

  const eligibility = returns.eligibility(order, config);
  res.render('fragments/returns-lookup', {
    order,
    eligibility,
    existing: returns.forOrder(order.id),
    error: null,
    state: req.body
  });
});

/** Media for a return request — compressed on arrival, same as reviews. */
app.post('/uploads/return-media', uploads.accept('returns'), async (req, res) => {
  if (req.uploadError) {
    return res.status(422).render('fragments/review-media-item', { item: null, error: req.uploadError });
  }
  const results = await uploads.processAll('returns', req.files);
  res.render('fragments/review-media-list', { results });
});

app.post('/returns', storefrontFeature('returns'), (req, res) => {
  const config = loadConfig();
  const order = ordersStore.byId(String(req.body.orderId || '').trim().toUpperCase());
  const check = ordersStore.verifyPurchase({
    orderId: req.body.orderId,
    contact: req.body.contact,
    productId: order && order.items.length ? order.items[0].productId : null
  });
  if (!order || (check.reason && /find that order|match the order/.test(check.reason))) {
    return res.status(422).render('fragments/returns-lookup', {
      order: null, eligibility: null, existing: null, error: check.reason || 'We can’t find that order.', state: req.body
    });
  }

  const eligible = returns.eligibility(order, config);
  if (!eligible.ok) {
    return res.status(422).render('fragments/returns-lookup', {
      order, eligibility: eligible, existing: returns.forOrder(order.id), error: eligible.reason, state: req.body
    });
  }

  const created = returns.create({
    order,
    itemKeys: [].concat(req.body.items || []).map(String),
    reason: req.body.reason,
    note: req.body.note,
    method: req.body.method,
    media: uploads.claim([].concat(req.body.mediaTokens || []).filter(Boolean))
  });

  activity.log('Returns', );
  notifications.returnUpdate(created, order, config).catch((err) => console.error('return email failed:', err.message));
  res.render('fragments/returns-result', { request: created, order });
});

/* -------------------------------------------------------------- journal ---- */

app.get('/journal', storefrontFeature('journal'), (req, res) => {
  const config = loadConfig();
  const tag = req.query.tag || '';
  const posts = journal.published().filter((p) => !tag || (p.tags || []).includes(tag));
  res.locals.seo = {
    title: 'Journal — guides, craft notes and care' + marketing.data().seo.titleSuffix,
    description: 'Long-form guides on choosing bridal wear, telling weaves apart and caring for couture.'
  };
  res.render('pages/journal', { posts, tags: journal.tags(), tag, title: 'Journal' });
});

app.get('/journal/:slug', storefrontFeature('journal'), (req, res, next) => {
  const config = loadConfig();
  const post = journal.bySlug(req.params.slug);
  if (!post || post.status !== 'published') return next();

  res.locals.seo = {
    title: (post.seo && post.seo.title ? post.seo.title : post.title) + marketing.data().seo.titleSuffix,
    description: (post.seo && post.seo.description) || post.excerpt
  };
  res.locals.jsonLd = [
    marketing.articleJsonLd(post, config, res.locals.origin),
    marketing.breadcrumbJsonLd([
      { label: 'Home', href: '/' },
      { label: 'Journal', href: '/journal' },
      { label: post.title, href: '/journal/' + post.slug }
    ], res.locals.origin)
  ];

  res.render('pages/journal-post', {
    post,
    paragraphs: journal.paragraphs(post),
    related: journal.published().filter((p) => p.id !== post.id).slice(0, 3),
    title: post.title
  });
});

/* -------------------------------------------------------------- reviews ---- */

/**
 * Media uploads happen the moment a file is chosen — while the customer is still
 * writing — so submitting the review never waits on compression.
 */
app.post('/uploads/review-media', storefrontFeature('reviews'), uploads.accept('reviews'), async (req, res) => {
  if (req.uploadError) {
    return res.status(422).render('fragments/review-media-item', { item: null, error: req.uploadError });
  }
  const results = await uploads.processAll('reviews', req.files);
  res.render('fragments/review-media-list', { results });
});

app.post('/uploads/review-media/:token/delete', (req, res) => {
  uploads.discard(req.params.token);
  res.send(''); // the card swaps itself out
});

/**
 * Only verified customers can review: the order number plus the email/phone used
 * at checkout must match, and the order must contain this product. Photos and
 * video come in by token from the background upload above.
 */
app.post('/product/:slug/review', storefrontFeature('reviews'), (req, res) => {
  const config = loadConfig();
  const product = catalog.bySlug(req.params.slug);
  if (!product) return res.status(404).send('');

  const tokens = [].concat(req.body.mediaTokens || []).filter(Boolean);
  const fail = (reason) => res.status(422).render('fragments/review-result', {
    ok: false, product, reason, state: req.body,
    keptMedia: tokens.map((t) => ({ token: t, descriptor: uploads.peek(t) })).filter((x) => x.descriptor)
  });

  const requirePurchase = !config.reviews || config.reviews.requirePurchase !== false;
  let order = null;

  if (requirePurchase) {
    const check = ordersStore.verifyPurchase({
      orderId: req.body.orderId,
      contact: req.body.contact,
      productId: product.id
    });
    if (!check.ok) return fail(check.reason);
    if (reviews.alreadyReviewed(check.order.id, product.id)) {
      return fail('You’ve already reviewed this piece on that order.');
    }
    order = check.order;
  }

  if (!String(req.body.body || '').trim()) return fail('Please write a few words about the piece.');

  const created = reviews.create({
    productId: product.id,
    rating: req.body.rating,
    title: req.body.title,
    body: req.body.body,
    author: req.body.author,
    location: req.body.location,
    media: uploads.claim(tokens),
    order
  });

  res.render('fragments/review-result', { ok: !!created, product, reason: null, state: {}, keptMedia: [] });
});

/* ------------------------------------------------------- SEO / AEO / GEO ---- */

app.get('/sitemap.xml', (req, res) => {
  const config = loadConfig();
  res.type('application/xml').send(marketing.sitemap(config, marketing.origin(req, config)));
});

app.get('/robots.txt', (req, res) => {
  const config = loadConfig();
  res.type('text/plain').send(marketing.robots(config, marketing.origin(req, config)));
});

app.get('/llms.txt', (req, res) => {
  const config = loadConfig();
  res.type('text/plain').send(marketing.llms(config, marketing.origin(req, config)));
});

/* Google Merchant Center product-reviews feed — submit this URL in Merchant
   Center to get per-product stars in Shopping. */
app.get('/feeds/product-reviews.xml', (req, res) => {
  const config = loadConfig();
  if (config.reviews && config.reviews.merchantFeed === false) return res.status(404).send('Feed disabled');
  res.type('application/xml').send(marketing.merchantReviewFeed(config, marketing.origin(req, config)));
});

/* ---------------------------------------------------------------- misc ---- */

app.post('/newsletter', (req, res) => {
  const email = String(req.body.email || '').trim();
  const ok = /^\S+@\S+\.\S+$/.test(email);
  res.render('fragments/newsletter-result', { ok, email });
});

app.use((req, res) => {
  res.status(404).render('pages/404', { title: 'Not found' });
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(500).send('Something went wrong.');
});

/** Every non-internal IPv4 address, so a phone on the same Wi-Fi can connect. */
function lanAddresses() {
  const nets = require('os').networkInterfaces();
  return Object.values(nets).flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
}

/**
 * The JSON store keeps a per-process read cache, so a second worker would write
 * from a stale copy and silently drop orders. Refusing to boot is the only safe
 * response — a store that loses one order in fifty is worse than a store that
 * won't start, because nobody notices the first one.
 *
 * pm2 sets NODE_APP_INSTANCE per worker in cluster mode.
 */
function refuseClusterMode() {
  const instance = process.env.NODE_APP_INSTANCE;
  if (instance === undefined || instance === '0') return;
  console.error(`
  ✖ Refusing to start worker #${instance}.

    This store keeps its data in JSON files with a per-process cache, so running
    more than one worker will lose orders. Set instances: 1 in your pm2 config
    (see ecosystem.config.js) and restart.
`);
  process.exit(1);
}
/* Only take a port when run directly (`node server.js`). Required as a module —
   by the tests — it just exports the app, so a test can listen on a random port
   and drive the real routes instead of a mock. */
if (require.main === module) {
  refuseClusterMode();

  // 0.0.0.0 = listen on every interface, not just loopback.
  app.listen(PORT, '0.0.0.0', () => {
    const name = loadConfig().brand.name;
    console.log(`\n  ${name} template running`);
    console.log(`  ➜ Local:   http://localhost:${PORT}`);
    lanAddresses().forEach((ip) => console.log(`  ➜ Network: http://${ip}:${PORT}   (phone / tablet on the same Wi-Fi)`));
    console.log('');
  });
}

module.exports = app;
