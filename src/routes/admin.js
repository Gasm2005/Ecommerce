'use strict';

/**
 * Admin router: dashboard, orders, products, categories, bulk import, reports.
 * Content modules (reviews, journal, marketing, discounts, customers, settings)
 * live in admin-content.js — both are mounted at /admin.
 */

const express = require('express');
const { loadConfig, money } = require('../config');
const catalog = require('../catalog');
const productsWrite = require('../products');
const orders = require('../orders');
const analytics = require('../analytics');
const reviews = require('../reviews');
const marketing = require('../marketing');
const activity = require('../activity');
const invoice = require('../invoice');
const plan = require('../plan');
const license = require('../license');
const exporter = require('../exporter');
const gstReturn = require('../gst-return');
const hx = require('../hx');
const auth = require('../auth');
const settings = require('../settings');
const importer = require('../importer');
const uploads = require('../uploads');
const returns = require('../returns');
const cod = require('../cod');
const pricing = require('../pricing');
const notifications = require('../notifications');
const payments = require('../payments');
const media = require('../media');

const router = express.Router();

/* ------------------------------------------------------------- guard ---- */

/* Routes reachable without being signed in. */
const OPEN_PATHS = ['/login', '/setup', '/forgot', '/reset', '/logout'];

/**
 * Signed-in users first; ADMIN_TOKEN stays as an escape hatch for scripts and
 * curl. With no accounts yet, everything redirects to the one-time setup page —
 * so a fresh install is never briefly wide open.
 */
function adminGuard(req, res, next) {
  const config = loadConfig();

  if (OPEN_PATHS.includes(req.path)) return next();

  const token = process.env.ADMIN_TOKEN;
  if (token && (req.query.token === token || (req.body && req.body.token === token))) {
    res.locals.adminToken = token;
    res.locals.user = { id: 'token', name: 'Token access', email: '', role: 'owner' };
    return next();
  }

  if (auth.isFirstRun()) return res.redirect('/admin/setup');

  const user = auth.currentUser(req);
  if (!user) {
    const back = encodeURIComponent(req.originalUrl.replace(/[?&]token=[^&]*/, ''));
    return res.redirect('/admin/login?next=' + back);
  }

  res.locals.user = user;
  return next();
}

/** Section-level permission gate — a hidden sidebar link is not a permission. */
const { requireSection, requireFeature } = require('./gate');

/** Compact money for axis labels and tight tiles: ₹1.2L, ₹45k. */
function compact(n, config) {
  const c = (config || loadConfig()).currency;
  const v = Math.abs(Number(n) || 0);
  const sign = n < 0 ? '−' : '';
  if (v >= 1e7) return `${sign}${c.symbol}${(v / 1e7).toFixed(v >= 1e8 ? 0 : 1)}Cr`;
  if (v >= 1e5) return `${sign}${c.symbol}${(v / 1e5).toFixed(v >= 1e6 ? 0 : 1)}L`;
  if (v >= 1e3) return `${sign}${c.symbol}${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}k`;
  return `${sign}${c.symbol}${Math.round(v)}`;
}

/** Locals every admin view relies on (sidebar badges, formatters, helpers). */
router.use(adminGuard, (req, res, next) => {
  const config = loadConfig();
  const token = res.locals.adminToken || null;

  res.locals.config = config;
  res.locals.money = (n) => money(n, config);
  res.locals.compact = (n) => compact(n, config);
  res.locals.analytics = analytics;
  res.locals.orders = orders;
  res.locals.catalog = catalog;
  res.locals.adminToken = token;
  res.locals.tokenQs = token ? '?token=' + token : '';
  res.locals.isHx = req.get('HX-Request') === 'true';
  res.locals.media = media;
  res.locals.returns = returns;
  res.locals.cod = cod;
  res.locals.openReturns = returns.overview().open;
  res.locals.can = (section) => auth.can(res.locals.user, section);
  res.locals.roles = auth.ROLES;
  // Plan state for the chrome. Locked sections stay VISIBLE with a padlock —
  // a client should know what the platform can do, not wonder what's missing.
  res.locals.plan = plan.planOf(loadConfig(), req.get('host'));
  res.locals.unlocked = (section) => plan.sectionUnlocked(loadConfig(), section, req.get('host'));
  // Licence state, so the chrome can warn before it walls anything off.
  res.locals.licence = license.status(req.get('host'));
  res.locals.hasFeature = (id) => plan.hasFeature(loadConfig(), id);
  res.locals.adminActions = null;
  res.locals.adminSubtitle = null;

  const all = orders.all();
  res.locals.pendingOrders = all.filter((o) => o.status === 'pending').length;
  res.locals.pendingReviews = reviews.all().filter((r) => r.status === 'pending').length;
  const restock = analytics.lowStockVariants(config);
  res.locals.lowStockCount = restock.filter((v) => v.stock > 0).length;
  res.locals.outOfStockCount = restock.filter((v) => v.stock <= 0).length;

  next();
});

/* ------------------------------------------------------------- login ---- */

function loginView(req, res, extra = {}) {
  return res.render('admin/login', {
    config: loadConfig(),
    mode: 'login',
    error: null,
    notice: null,
    email: '',
    token: null,
    next: req.query.next || (req.body && req.body.next) || '',
    ...extra
  });
}

router.get('/login', (req, res) => {
  if (auth.isFirstRun()) return res.redirect('/admin/setup');
  if (auth.currentUser(req)) return res.redirect('/admin');
  loginView(req, res, { notice: req.query.reset === '1' ? 'Check your email for the reset link.' : null });
});

router.post('/login', (req, res) => {
  const out = auth.login({
    email: req.body.email,
    password: req.body.password,
    ip: req.ip
  });

  if (!out.ok) {
    activity.log('Auth', `Failed sign-in for ${String(req.body.email || '').slice(0, 60)}`);
    return res.status(401).render('admin/login', {
      config: loadConfig(), mode: 'login', error: out.reason, notice: null,
      email: req.body.email || '', token: null, next: req.body.next || ''
    });
  }

  auth.startSession(res, out.user);
  activity.log('Auth', `${out.user.name} signed in`);

  const next = String(req.body.next || '');
  res.redirect(next.startsWith('/admin') ? next : '/admin');
});

router.get('/logout', (req, res) => {
  const user = auth.currentUser(req);
  auth.endSession(res);
  if (user) activity.log('Auth', `${user.name} signed out`);
  res.redirect('/admin/login');
});

/* First run: create the owner. Closed the moment an account exists. */
router.get('/setup', (req, res) => {
  if (!auth.isFirstRun()) return res.redirect('/admin/login');
  res.render('admin/login', { config: loadConfig(), mode: 'setup', error: null, notice: null, email: '', token: null, state: {} });
});

router.post('/setup', (req, res) => {
  if (!auth.isFirstRun()) return res.redirect('/admin/login');
  try {
    const user = auth.createUser({
      name: req.body.name,
      email: req.body.email,
      password: req.body.password,
      role: 'owner'
    });
    auth.startSession(res, user);
    activity.log('Auth', `Owner account created for ${user.email}`);
    res.redirect('/admin');
  } catch (err) {
    res.status(400).render('admin/login', {
      config: loadConfig(), mode: 'setup', error: err.message, notice: null,
      email: req.body.email || '', token: null, state: { name: req.body.name || '' }
    });
  }
});

/* Reset by email — uses the store's own sending account. */
router.post('/forgot', async (req, res) => {
  const config = loadConfig();
  const user = auth.findByEmail(req.body.email);

  // Always the same response: don't reveal which emails have accounts.
  if (user) {
    const link = auth.resetLink(user, marketing.origin(req, config));
    notifications.send({
      event: 'admin.reset',
      to: user.email,
      subject: `Reset your ${config.brand.name} admin password`,
      template: 'generic',
      data: {
        headline: 'Password reset',
        body: `Open this link within the hour to choose a new password: ${link} — if you didn't ask for this, ignore it and nothing changes.`
      },
      config
    }).catch((err) => console.error('reset email failed:', err.message));
    activity.log('Auth', `Password reset requested for ${user.email}`);
  }

  res.redirect('/admin/login?reset=1');
});

router.get('/reset', (req, res) => {
  const user = auth.resolveReset(req.query.token);
  if (!user) {
    return res.status(400).render('admin/login', {
      config: loadConfig(), mode: 'login', error: 'That reset link has expired or has already been used.',
      notice: null, email: '', token: null, next: ''
    });
  }
  res.render('admin/login', { config: loadConfig(), mode: 'reset', error: null, notice: null, email: user.email, token: req.query.token });
});

router.post('/reset', (req, res) => {
  const out = auth.completeReset(req.body.token, req.body.password);
  if (!out.ok) {
    return res.status(400).render('admin/login', {
      config: loadConfig(), mode: 'reset', error: out.reason, notice: null,
      email: '', token: req.body.token
    });
  }
  auth.startSession(res, out.user);
  activity.log('Auth', `${out.user.email} reset their password`);
  res.redirect('/admin');
});

/* ------------------------------------------------- account & staff ---- */

function accountModel(req, res, extra = {}) {
  return {
    user: res.locals.user,
    staff: auth.users().map(auth.publicUser),
    saved: req.query.saved === '1',
    error: null,
    ...extra
  };
}

function licenseModel(req, extra) {
  const status = license.status(req.get('host'));
  return {
    status,
    shortId: license.shortId(status.licence),
    saved: false, error: null, wall: false,
    ...(extra || {})
  };
}

router.get('/license', (req, res) => {
  res.render('admin/license', licenseModel(req, { saved: req.query.saved === '1' }));
});

router.post('/license', requireSection('settings'), (req, res) => {
  const result = license.activate(req.body.key);
  if (!result.ok) {
    return res.status(422).render('admin/license', licenseModel(req, { error: result.reason }));
  }
  activity.log('Licence', `Activated ${result.licence.plan} licence for ${result.licence.store}`);
  res.redirect('/admin/license' + (res.locals.adminToken ? `?token=${res.locals.adminToken}&saved=1` : '?saved=1'));
});

router.post('/license/remove', requireSection('settings'), (req, res) => {
  license.deactivate();
  activity.log('Licence', 'Licence key removed');
  hx.trigger(res, { 'admin:reload': true });
  res.status(200).send('');
});

/**
 * "Your data is yours."
 *
 * Not buried in a settings tab: an owner should be able to walk out with
 * everything, at any moment, without asking. That promise is worth more in a
 * sales conversation than any feature, and it is only worth anything if the
 * button actually works.
 */
router.get('/export', requireSection('reports'), (req, res) => {
  const config = loadConfig();
  const spec = rangeSpec(req, '12m');
  const win = analytics.resolveWindow(spec);
  res.render('admin/export', {
    counts: exporter.buildArchive(config).counts,
    gst: gstReturn.workingPapers(config, win),
    win,
    ranges: analytics.RANGES,
    spec
  });
});

router.get('/export/all.zip', requireSection('reports'), (req, res) => {
  const out = exporter.buildArchive(loadConfig());
  activity.log('Export', `Full data export (${(out.buffer.length / 1024).toFixed(0)} KB)`);
  res.type('application/zip')
    .set('Content-Disposition', `attachment; filename="${out.filename}"`)
    .send(out.buffer);
});

/** GST working papers for one period — what the CA is actually sent. */
router.get('/export/gst.zip', requireSection('reports'), (req, res) => {
  const config = loadConfig();
  const win = analytics.resolveWindow(rangeSpec(req, '12m'));
  const papers = gstReturn.workingPapers(config, win);
  const stamp = `${win.from.toISOString().slice(0, 10)}-to-${win.to.toISOString().slice(0, 10)}`;

  const { zip } = require('../zip');
  // Flatten the gst/ prefix: this archive is only the GST papers, so a folder
  // inside it is one click the accountant does not need.
  const buffer = zip(papers.entries.map((e) => ({ ...e, name: e.name.replace('gst/', '') })));
  activity.log('Export', `GST working papers ${stamp}`);
  res.type('application/zip')
    .set('Content-Disposition', `attachment; filename="gstr1-working-papers-${stamp}.zip"`)
    .send(buffer);
});

router.get('/plan', (req, res) => {
  res.render('admin/plan', { info: plan.overview(loadConfig(), req.get('host')) });
});

router.get('/account', (req, res) => res.render('admin/account', accountModel(req, res)));

router.post('/account', (req, res) => {
  try {
    auth.updateUser(res.locals.user.id, { name: req.body.name });
    res.redirect('/admin/account?saved=1');
  } catch (err) {
    res.status(400).render('admin/account', accountModel(req, res, { error: err.message }));
  }
});

router.post('/account/password', (req, res) => {
  const full = auth.findById(res.locals.user.id);
  // Knowing the current password is the point — a stolen session shouldn't be
  // able to lock the real owner out.
  if (!full || !auth.verifyPassword(req.body.current, full.passwordHash)) {
    return res.status(400).render('admin/account', accountModel(req, res, { error: 'Current password is incorrect.' }));
  }
  try {
    auth.updateUser(full.id, { password: req.body.password });
    activity.log('Auth', `${full.name} changed their password`);
    res.redirect('/admin/account?saved=1');
  } catch (err) {
    res.status(400).render('admin/account', accountModel(req, res, { error: err.message }));
  }
});

router.post('/users', requireSection('settings'), (req, res) => {
  try {
    const created = auth.createUser({
      name: req.body.name,
      email: req.body.email,
      password: req.body.password,
      role: req.body.role
    });
    activity.log('Auth', `Added ${created.role} account ${created.email}`);
    res.redirect('/admin/account?saved=1');
  } catch (err) {
    res.status(400).render('admin/account', accountModel(req, res, { error: err.message }));
  }
});

router.post('/users/:id/role', requireSection('settings'), (req, res) => {
  try {
    const updated = auth.updateUser(req.params.id, { role: req.body.role });
    if (updated) activity.log('Auth', `${updated.email} is now ${updated.role}`);
    notify(res, updated ? `${updated.name} → ${updated.role}` : 'Not found', updated ? 'good' : 'critical');
  } catch (err) {
    notify(res, err.message, 'critical');
  }
  res.send('');
});

router.post('/users/:id/delete', requireSection('settings'), (req, res) => {
  try {
    const removed = auth.removeUser(req.params.id);
    if (removed) activity.log('Auth', `Removed account ${removed.email}`);
    // One header: a toast plus a reload so the staff table redraws.
    hx.trigger(res, {
      'admin:toast': { message: removed ? `Removed ${removed.name}` : 'Not found', tone: removed ? 'good' : 'critical' },
      'admin:reload': true
    });
  } catch (err) {
    notify(res, err.message, 'critical');
  }
  res.send('');
});

/** Rebuilds a pretty admin URL from the current query + overrides. */
function buildQs(req, overrides = {}, drop = []) {
  const params = new URLSearchParams();
  Object.entries({ ...req.query, ...overrides }).forEach(([k, v]) => {
    if (drop.includes(k) || v === undefined || v === null || v === '') return;
    if (Array.isArray(v)) v.forEach((x) => params.append(k, x));
    else params.append(k, v);
  });
  const s = params.toString();
  return s ? '?' + s : '';
}

/** ASCII-safe: toast text carries currency symbols and curly quotes. */
function notify(res, message, tone) {
  hx.toast(res, message, tone);
}

/* ---------------------------------------------------------- dashboard ---- */

function dashboardModel(req) {
  const config = loadConfig();
  // A preset id, or an explicit from/to for campaign windows.
  const range = (req.query.from || req.query.to)
    ? { range: req.query.range, from: req.query.from, to: req.query.to }
    : (req.query.range || '30d');
  const s = analytics.summary(range, config);
  const all = orders.all();

  const openOrders = {};
  orders.STATUSES.forEach((st) => { openOrders[st.id] = all.filter((o) => o.status === st.id).length; });

  return {
    s,
    trend: analytics.series(range, config),
    winners: analytics.topProducts(range, config, 8),
    categoryRows: analytics.byCategory(range, config).map((r) => ({ label: r.category, value: r.revenue, meta: r.units + ' units' })),
    payments: analytics.paymentSplit(range, config),
    paymentRows: analytics.paymentSplit(range, config).rows.map((r) => ({
      label: orders.label(orders.PAYMENT_METHODS, r.method),
      value: r.value,
      meta: r.count + ' orders'
    })),
    attribution: analytics.byAttribution(range, config),
    codeRows: analytics.byDiscount(range, config),
    couponSplit: analytics.couponSplit(range, config),
    codOutstanding: cod.outstanding(all),
    openOrders,
    codPending: all.filter((o) => o.paymentMethod === 'cod' && o.paymentStatus === 'pending').length,
    reviewStats: reviews.overview(),
    seoAudit: marketing.audit(config),
    custo: analytics.customers(range),
    activityRows: activity.recent(6),
    /* Surfaced on the dashboard rather than only on the Marketing page: a client who
       has to go looking will not find out their confirmations stopped. */
    mailHealth: notifications.health()
  };
}

// Gated like every other section: the dashboard shows revenue and profit, so a
// half-wall that locks Orders but leaves this open protects nothing.
router.get('/', requireSection('dashboard'), (req, res) => {
  const model = dashboardModel(req);
  if (res.locals.isHx) {
    res.set('HX-Push-Url', '/admin' + buildQs(req));
    return res.render('admin/fragments/dashboard-body', model);
  }
  res.render('admin/dashboard', model);
});

/* ------------------------------------------------------------- orders ---- */

function ordersModel(req) {
  const perPage = Math.min(100, parseInt(req.query.perPage, 10) || 20);
  const result = orders.query({
    status: req.query.status,
    payment: req.query.payment,
    paymentStatus: req.query.paymentStatus,
    fulfilment: req.query.fulfilment,
    q: req.query.q,
    from: req.query.from,
    to: req.query.to,
    sort: req.query.sort,
    page: parseInt(req.query.page, 10) || 1,
    perPage
  });
  const all = orders.all();
  return {
    result,
    filters: {
      status: req.query.status || '',
      payment: req.query.payment || '',
      paymentStatus: req.query.paymentStatus || '',
      q: req.query.q || '',
      from: req.query.from || '',
      to: req.query.to || '',
      fulfilment: req.query.fulfilment || '',
      sort: req.query.sort || 'newest'
    },
    counts: {
      all: all.length,
      cod: all.filter((o) => o.paymentMethod === 'cod').length,
      prepaid: all.filter((o) => o.paymentMethod !== 'cod').length,
      unpaid: all.filter((o) => o.paymentStatus === 'pending').length,
      refunded: all.filter((o) => o.paymentStatus === 'refunded').length,
      // What the shop is carrying itself, and still owes a delivery on.
      selfDeliver: all.filter((o) => (o.fulfilment === 'own' || o.fulfilment === 'pickup')
        && !['delivered', 'cancelled', 'returned'].includes(o.status)).length
    },
    statusCounts: orders.STATUSES.map((s) => ({ ...s, count: all.filter((o) => o.status === s.id).length }))
  };
}

router.get('/orders', requireSection('orders'), (req, res) => {
  res.render('admin/orders', ordersModel(req));
});

router.get('/orders/rows', requireSection('orders'), (req, res) => {
  res.set('HX-Push-Url', '/admin/orders' + buildQs(req, {}, ['token']));
  res.render('admin/fragments/order-rows', ordersModel(req));
});

router.get('/orders/export.csv', requireSection('orders'), (req, res) => {
  const result = orders.query({ ...req.query, perPage: 100000, page: 1 });
  res.type('text/csv').set('Content-Disposition', 'attachment; filename="orders.csv"').send(orders.csv(result.items));
});

router.get('/orders/:id', requireSection('orders'), (req, res, next) => {
  const order = orders.byId(req.params.id);
  if (!order) return next();
  res.render('admin/order-detail', { order, timeline: [...(order.timeline || [])].reverse() });
});

/**
 * The tax invoice. Rendered as a standalone print page — the browser's own
 * "Save as PDF" is the export, so there is no PDF library to keep alive on a
 * client's shared host. The invoice number is allocated on first view.
 */
router.get('/orders/:id/invoice', requireSection('orders'), (req, res, next) => {
  const order = orders.byId(req.params.id);
  if (!order) return next();
  res.render('invoice', {
    inv: invoice.build(order, loadConfig()),
    isAdmin: true
  });
});

router.post('/orders/:id/status', requireSection('orders'), (req, res) => {
  const updated = orders.setStatus(req.params.id, req.body.status, req.body.note);
  if (!updated) return res.status(404).send('');
  activity.log('Orders', `${updated.id} → ${orders.statusMeta(updated.status).label}`, { id: updated.id });

  // Shipped / delivered / cancelled tell the customer. Never block the response
  // on a mail server — a slow SMTP host must not freeze the admin.
  notifications.orderStatus(updated, updated.status, loadConfig())
    .catch((err) => console.error('status email failed:', err.message));
  notify(res, `${updated.id} marked ${orders.statusMeta(updated.status).label.toLowerCase()}`);
  res.render('admin/fragments/order-detail-body', { order: updated, timeline: [...(updated.timeline || [])].reverse() });
});

router.post('/orders/:id/payment', requireSection('orders'), (req, res) => {
  const updated = orders.setPaymentStatus(req.params.id, req.body.paymentStatus);
  if (!updated) return res.status(404).send('');
  activity.log('Orders', `${updated.id} payment → ${updated.paymentStatus}`, { id: updated.id });
  notify(res, `Payment marked ${updated.paymentStatus}`);
  res.render('admin/fragments/order-detail-body', { order: updated, timeline: [...(updated.timeline || [])].reverse() });
});

router.post('/orders/:id/note', requireSection('orders'), (req, res) => {
  const updated = orders.addNote(req.params.id, String(req.body.note || '').slice(0, 400));
  if (!updated) return res.status(404).send('');
  notify(res, 'Note added');
  res.render('admin/fragments/order-detail-body', { order: updated, timeline: [...(updated.timeline || [])].reverse() });
});

/* ----------------------------------------------------------- products ---- */

function productsModel(req) {
  const config = loadConfig();
  const q = (req.query.q || '').toLowerCase();
  const stockFilter = req.query.stock || '';
  const category = req.query.category || '';
  const sort = req.query.sort || 'name';
  const threshold = config.inventory.lowStockThreshold;

  const perf = new Map(analytics.topProducts('12m', config, 999).map((r) => [r.productId, r]));

  let rows = catalog.all().map((p) => {
    const r = perf.get(p.id);
    return {
      ...p,
      units: r ? r.units : 0,
      revenue: r ? r.revenue : 0,
      profit: r ? r.profit : 0,
      marginPercent: r ? r.marginPercent : (p.cost ? +(((p.price - p.cost) / p.price) * 100).toFixed(1) : null),
      rating: reviews.stats(p.id)
    };
  });

  if (q) rows = rows.filter((p) => (p.name + ' ' + p.slug + ' ' + (p.sku || '') + ' ' + p.fabric).toLowerCase().includes(q));
  if (category) rows = rows.filter((p) => p.categories.includes(category));
  if (stockFilter === 'low') rows = rows.filter((p) => Number.isFinite(p.stock) && p.stock > 0 && p.stock <= threshold);
  if (stockFilter === 'out') rows = rows.filter((p) => Number.isFinite(p.stock) && p.stock <= 0);
  if (stockFilter === 'healthy') rows = rows.filter((p) => Number.isFinite(p.stock) && p.stock > threshold);

  const sorters = {
    name: (a, b) => a.name.localeCompare(b.name),
    revenue: (a, b) => b.revenue - a.revenue,
    units: (a, b) => b.units - a.units,
    stock: (a, b) => (a.stock || 0) - (b.stock || 0),
    'price-desc': (a, b) => b.price - a.price,
    'price-asc': (a, b) => a.price - b.price,
    margin: (a, b) => (b.marginPercent || 0) - (a.marginPercent || 0),
    newest: (a, b) => String(b.createdAt).localeCompare(String(a.createdAt))
  };
  rows.sort(sorters[sort] || sorters.name);

  return {
    rows,
    filters: { q: req.query.q || '', stock: stockFilter, category, sort },
    categories: (config.nav || []).map((n) => ({ slug: n.slug, label: n.label })),
    threshold,
    totals: {
      count: catalog.all().length,
      stockUnits: catalog.all().reduce((s, p) => s + (Number.isFinite(p.stock) ? p.stock : 0), 0),
      stockValue: catalog.all().reduce((s, p) => s + (Number.isFinite(p.stock) ? p.stock * (p.cost || 0) : 0), 0),
      retailValue: catalog.all().reduce((s, p) => s + (Number.isFinite(p.stock) ? p.stock * p.price : 0), 0)
    }
  };
}

router.get('/products', requireSection('products'), (req, res) => {
  res.render('admin/products', productsModel(req));
});

router.get('/products/rows', requireSection('products'), (req, res) => {
  res.set('HX-Push-Url', '/admin/products' + buildQs(req, {}, ['token']));
  res.render('admin/fragments/product-rows', productsModel(req));
});

router.get('/products/export.csv', requireSection('products'), (req, res) => {
  res.type('text/csv').set('Content-Disposition', 'attachment; filename="products.csv"').send(productsWrite.csv(catalog.all()));
});

router.get('/products/new', requireSection('products'), (req, res) => {
  const config = loadConfig();
  res.render('admin/product-edit', {
    product: null,
    facets: catalog.facets('all'),
    categories: (config.nav || []).map((n) => ({ slug: n.slug, label: n.label })),
    seo: {},
    perf: null,
    economics: pricing.productMargin({ price: 0, categories: [] }, config),
    error: null
  });
});

router.post('/products', requireSection('products'), (req, res) => {
  const config = loadConfig();
  const fields = productsWrite.fieldsFromBody(req.body);
  if (!fields.name) {
    return res.status(400).render('admin/product-edit', {
      product: null, facets: catalog.facets('all'),
      categories: (config.nav || []).map((n) => ({ slug: n.slug, label: n.label })),
      seo: {}, perf: null, economics: pricing.productMargin({ price: 0, categories: [] }, config), error: 'A product name is required.'
    });
  }
  const created = productsWrite.create(fields, config);
  activity.log('Products', `Created “${created.name}”`, { id: created.id });
  res.redirect(`/admin/products/${created.id}${res.locals.tokenQs}`);
});

router.get('/products/:id', requireSection('products'), (req, res, next) => {
  const config = loadConfig();
  const product = catalog.byId(req.params.id);
  if (!product) return next();
  const perf = analytics.topProducts('12m', config, 999).find((r) => r.productId === product.id) || null;
  res.render('admin/product-edit', {
    product,
    facets: catalog.facets('all'),
    categories: (config.nav || []).map((n) => ({ slug: n.slug, label: n.label })),
    seo: marketing.data().seo.products[product.slug] || {},
    perf,
    reviewStats: reviews.stats(product.id),
    economics: pricing.productMargin(product, config),
    saved: req.query.saved === '1',
    error: null
  });
});

router.post('/products/:id', requireSection('products'), (req, res) => {
  const config = loadConfig();
  const fields = productsWrite.fieldsFromBody(req.body);
  try {
    const updated = productsWrite.update(req.params.id, fields);
    if (!updated) return res.status(404).send('Product not found');
    if (req.body.seoTitle !== undefined || req.body.seoDescription !== undefined) {
      marketing.setProductSeo(updated.slug, {
        title: String(req.body.seoTitle || '').trim() || undefined,
        description: String(req.body.seoDescription || '').trim() || undefined,
        indexable: req.body.seoIndexable === 'on'
      });
    }
    activity.log('Products', `Updated “${updated.name}”`, { id: updated.id });
    const qs = res.locals.adminToken ? `?token=${res.locals.adminToken}&saved=1` : '?saved=1';
    res.redirect(`/admin/products/${updated.id}${qs}`);
  } catch (err) {
    const product = catalog.byId(req.params.id);
    res.status(400).render('admin/product-edit', {
      product,
      facets: catalog.facets('all'),
      categories: (config.nav || []).map((n) => ({ slug: n.slug, label: n.label })),
      seo: marketing.data().seo.products[product.slug] || {},
      perf: null,
      reviewStats: reviews.stats(product.id),
      economics: pricing.productMargin(product, config),
      error: err.message
    });
  }
});

/**
 * Admin image upload — same compression pipeline as customer reviews
 * (WebP, resized, thumbnail written alongside). Appends to the gallery.
 */
router.post('/products/:id/images', requireSection('products'), uploads.accept('products', 'media', 10), async (req, res) => {
  const product = catalog.byId(req.params.id);
  if (!product) return res.status(404).send('');

  if (req.uploadError) {
    return res.status(422).render('admin/fragments/product-gallery', { p: product, error: req.uploadError });
  }

  const results = await uploads.processAll('products', req.files);
  const added = results.filter((r) => r.descriptor && r.descriptor.src).map((r) => r.descriptor.src);
  results.forEach((r) => { if (r.token) uploads.claim([r.token]); }); // keep the files, drop the tokens

  const saved = results.reduce((s, r) => s + ((r.descriptor && r.descriptor.savedBytes) || 0), 0);
  const updated = added.length ? productsWrite.update(product.id, { images: [...product.images, ...added] }) : product;

  if (added.length) {
    activity.log('Products', `Uploaded ${added.length} image${added.length === 1 ? '' : 's'} to “${product.name}” (${Math.round(saved / 1024)} KB saved by compression)`, { id: product.id });
    notify(res, `${added.length} image${added.length === 1 ? '' : 's'} added · ${Math.round(saved / 1024)} KB saved`);
  }

  res.render('admin/fragments/product-gallery', { p: updated, error: results.find((r) => r.error) ? results.find((r) => r.error).error : null });
});

router.post('/products/:id/images/remove', requireSection('products'), (req, res) => {
  const product = catalog.byId(req.params.id);
  if (!product) return res.status(404).send('');
  const src = String(req.body.src || '');

  const updated = productsWrite.update(product.id, { images: product.images.filter((i) => i !== src) });
  // Only delete from disk if it's one of ours (never touch external URLs).
  if (src.startsWith('/static/uploads/')) {
    uploads.removeMedia([{ src, thumb: src.replace(/\.webp$/, '-thumb.webp') }]);
  }
  activity.log('Products', `Removed an image from “${product.name}”`, { id: product.id });
  res.render('admin/fragments/product-gallery', { p: updated, error: null });
});

router.post('/products/:id/stock', requireSection('products'), (req, res) => {
  const delta = parseInt(req.body.delta, 10);
  const updated = Number.isFinite(delta)
    ? productsWrite.adjustStock(req.params.id, delta)
    : productsWrite.setStock(req.params.id, req.body.stock);
  if (!updated) return res.status(404).send('');
  activity.log('Inventory', `${updated.name} stock → ${updated.stock}`, { id: updated.id });
  notify(res, `${updated.name}: stock ${updated.stock}`);
  res.render('admin/fragments/stock-cell', { p: updated, threshold: loadConfig().inventory.lowStockThreshold });
});

/**
 * Sets the stock on ONE size/colour from the grid. The whole grid comes back, not
 * just the cell, because a single edit moves the row total, the product total and
 * the sold-out list with it.
 */
router.post('/products/:id/variant-stock', requireSection('products'), (req, res) => {
  const choice = { size: String(req.body.size || '').trim(), color: String(req.body.color || '').trim() || null };
  if (!choice.size) return res.status(400).send('');

  /* Read from "count", not "stock". The grid lives inside the product edit form,
     and HTMX sends that whole form with every cell edit — so a cell named "stock"
     received the form's headline Stock number as well as the typed one, and the
     wrong one won. Two bugs came out of that: a count of 9 saved as 0, then a
     cleared box saved as 12. The name is now unique and hx-params pins the payload.

     Still tolerant of an array: never let the shape of a request decide a number. */
  const sent = Array.isArray(req.body.count)
    ? req.body.count.map((v) => String(v).trim()).filter((v) => v !== '').pop()
    : req.body.count;
  const raw = String(sent === undefined || sent === null ? '' : sent).trim();

  const n = Number(raw.replace(/[,s]/g, ''));
  if (raw !== '' && !Number.isFinite(n)) return res.status(400).send('');

  const updated = raw === ''
    ? productsWrite.clearVariantStock(req.params.id, choice)
    : productsWrite.setVariantStock(req.params.id, choice, n);
  if (!updated) return res.status(404).send('');

  const variants = require('../variants');
  const shown = raw === '' ? 'not counted' : String(variants.stockFor(updated, choice));
  activity.log('Inventory', `${updated.name} — ${variants.label(choice)} → ${shown}`, { id: updated.id });
  notify(res, `${updated.name} · ${variants.label(choice)}: ${shown}`);

  res.render('admin/fragments/stock-grid', { p: updated, threshold: loadConfig().inventory.lowStockThreshold });
});

router.post('/products/:id/delete', requireSection('products'), (req, res) => {
  const removed = productsWrite.remove(req.params.id);
  if (removed) activity.log('Products', `Deleted “${removed.name}”`, { id: removed.id });
  notify(res, removed ? `Deleted “${removed.name}”` : 'Product not found', removed ? 'good' : 'critical');
  res.set('HX-Redirect', '/admin/products' + res.locals.tokenQs);
  res.send('');
});

/* --------------------------------------------------------- categories ---- */

router.get('/categories', requireSection('categories'), (req, res) => {
  res.render('admin/categories', { ...settings.categories(), error: req.query.error || null });
});

router.post('/categories', requireSection('categories'), (req, res) => {
  try {
    const slug = settings.addCategory(req.body);
    activity.log('Categories', `Added category “${slug}”`);
    res.set('HX-Redirect', '/admin/categories' + res.locals.tokenQs);
    res.send('');
  } catch (err) {
    notify(res, err.message, 'critical');
    res.status(400).render('admin/fragments/category-rows', settings.categories());
  }
});

router.post('/categories/:slug/rename', requireSection('categories'), (req, res) => {
  try {
    const out = settings.renameCategory(req.params.slug, req.body);
    activity.log('Categories', `Renamed “${req.params.slug}” → “${out.slug}” (${out.productsTouched} products)`);
    notify(res, `Saved · ${out.productsTouched} product${out.productsTouched === 1 ? '' : 's'} re-tagged`);
  } catch (err) {
    notify(res, err.message, 'critical');
  }
  res.render('admin/fragments/category-rows', settings.categories());
});

router.post('/categories/:slug/delete', requireSection('categories'), (req, res) => {
  try {
    const out = settings.deleteCategory(req.params.slug);
    activity.log('Categories', `Deleted “${out.label}” (${out.productsTouched} products re-tagged)`);
    notify(res, `Deleted “${out.label}” · ${out.productsTouched} product${out.productsTouched === 1 ? '' : 's'} updated`);
  } catch (err) {
    notify(res, err.message, 'critical');
  }
  res.render('admin/fragments/category-rows', settings.categories());
});

router.post('/categories/:slug/move', requireSection('categories'), (req, res) => {
  settings.reorderCategory(req.params.slug, req.body.direction);
  res.render('admin/fragments/category-rows', settings.categories());
});

/* ------------------------------------------------------- bulk import ---- */

router.get('/import', requireSection('import'), (req, res) => {
  res.render('admin/import', { columns: importer.COLUMNS, productCount: catalog.all().length });
});

router.get('/import/template.csv', requireSection('import'), (req, res) => {
  res.type('text/csv').set('Content-Disposition', 'attachment; filename="products-template.csv"').send(importer.templateCsv());
});

router.post('/import/preview', requireSection('import'), (req, res) => {
  const analysis = importer.analyse(String(req.body.payload || ''), {
    format: req.body.format === 'json' ? 'json' : 'csv',
    mode: ['append', 'upsert', 'replace'].includes(req.body.mode) ? req.body.mode : 'append'
  });
  res.render('admin/fragments/import-preview', { analysis, payload: String(req.body.payload || '') });
});

router.post('/import/commit', requireSection('import'), (req, res) => {
  const format = req.body.format === 'json' ? 'json' : 'csv';
  const mode = ['append', 'upsert', 'replace'].includes(req.body.mode) ? req.body.mode : 'append';
  const analysis = importer.analyse(String(req.body.payload || ''), { format, mode });

  if (analysis.parseError || !analysis.rows.some((r) => r.action !== 'skip')) {
    return res.render('admin/fragments/import-preview', { analysis, payload: String(req.body.payload || '') });
  }

  const result = importer.commit(analysis);
  catalog.invalidate();
  activity.log('Products', `Bulk import: ${result.created} created, ${result.updated} updated (${mode})`);
  res.render('admin/fragments/import-result', { result, analysis });
});

/* ------------------------------------------------------------ reports ---- */

/** A window spec from either presets or explicit dates — shared by every export. */
function rangeSpec(req, fallback = '30d') {
  return (req.query.from || req.query.to)
    ? { range: req.query.range, from: req.query.from, to: req.query.to }
    : (req.query.range || fallback);
}

function monthlyRows(config) {
  return analytics.series('12m', config).map((m) => {
    const from = new Date(m.key + '-01T00:00:00Z');
    const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 0, 23, 59, 59));
    const list = orders.all().filter((o) => o.createdAt >= from.toISOString() && o.createdAt <= to.toISOString());
    const t = analytics.totals(list, config);
    const fixed = analytics.fixedCosts({ from, to }, config);
    return {
      key: m.key,
      label: m.label,
      ...t,
      fixed: fixed.total,
      marketing: fixed.marketing,
      profitInHand: t.contribution - fixed.total
    };
  });
}

/** Per-SKU profitability inside a window — the "which product actually pays" view. */
function skuRows(spec, config) {
  return analytics.topProducts(spec, config, 999).map((r) => {
    const product = catalog.byId(r.productId);
    const econ = product ? pricing.productMargin(product, config) : null;
    return {
      ...r,
      sku: product ? (product.sku || product.id) : r.productId,
      price: product ? product.price : null,
      unitCost: econ ? econ.cost : null,
      gstPercent: econ ? econ.gstPercent : null,
      categories: product ? product.categories.join('|') : ''
    };
  });
}

function csvOf(head, rows) {
  return [head, ...rows]
    .map((r) => r.map((c) => {
      const s = String(c === undefined || c === null ? '' : c);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(','))
    .join('\n') + '\n';
}

router.get('/reports', requireSection('reports'), (req, res) => {
  const config = loadConfig();
  const spec = rangeSpec(req, '7d');
  const s = analytics.summary(spec, config);

  res.render('admin/reports', {
    s,
    spec,
    exportQs: buildQs(req, {}, ['token']),
    monthly: monthlyRows(config),
    skus: skuRows(spec, config).slice(0, 15),
    lowStock: analytics.lowStock(config),
    lowStockVariants: analytics.lowStockVariants(config),
    deadStock: analytics.deadStock('12m', config).slice(0, 10),
    couponSplit: analytics.couponSplit(spec, config),
    returnsOverview: returns.overview()
  });
});

/** Orders for the chosen window (presets or from/to both work). */
router.get('/reports/export/orders.csv', requireSection('reports'), (req, res) => {
  const config = loadConfig();
  const win = analytics.resolveWindow(rangeSpec(req, '7d'), new Date());
  const list = orders.all().filter((o) => o.createdAt >= win.from.toISOString() && o.createdAt <= win.to.toISOString());
  res.type('text/csv')
    .set('Content-Disposition', `attachment; filename="orders-${win.from.toISOString().slice(0, 10)}-to-${win.to.toISOString().slice(0, 10)}.csv"`)
    .send(orders.csv(list));
});

/** The whole P&L ladder for the window, one row per line — pasteable into Excel. */
router.get('/reports/export/pnl.csv', requireSection('reports'), (req, res) => {
  const config = loadConfig();
  const spec = rangeSpec(req, '7d');
  const s = analytics.summary(spec, config);

  const rows = [
    ['Window', s.from.toISOString().slice(0, 10) + ' to ' + s.to.toISOString().slice(0, 10)],
    ['Orders', s.orderCount],
    ['Units', s.units],
    ['Gross sales', s.gross],
    ['Refunds and returns', -s.refunds],
    ['Net sales', s.netSales],
    ['GST collected', -s.gst],
    ['Shipping collected', -s.shippingCollected],
    ['Revenue ex-GST', s.revenue],
    ['COGS', -s.cogs],
    ['Gross profit', s.grossProfit],
    ['Gross margin %', s.marginPercent],
    ['Packaging', -s.packaging],
    ['Shipping paid out', -s.fulfilment],
    ['Payment and COD fees', -s.paymentFees],
    ['Platform fees', -s.platformFees],
    ['Returns provision', -s.returnsProvision],
    ['Contribution', s.contribution],
    ['Contribution margin %', s.contributionMarginPercent],
    ...s.fixed.lines.map((l) => [l.key, -l.amount]),
    ['Fixed costs total', -s.opex],
    ['PROFIT IN HAND', s.profitInHand],
    ['Net margin %', s.ebitdaMarginPercent],
    ['Discounts given', s.discounts],
    ['AOV', s.aov],
    ['Return rate %', s.returnRatePercent]
  ];

  res.type('text/csv')
    .set('Content-Disposition', `attachment; filename="pnl-${s.from.toISOString().slice(0, 10)}-to-${s.to.toISOString().slice(0, 10)}.csv"`)
    .send(csvOf(['line', 'amount'], rows));
});

/** Monthly P&L, twelve rows — profit after refunds, per month. */
router.get('/reports/export/monthly.csv', requireSection('reports'), (req, res) => {
  const config = loadConfig();
  const rows = monthlyRows(config).map((m) => [
    m.key, m.orderCount, m.units, m.gross, m.refunds, m.netSales, m.gst, m.revenue,
    m.cogs, m.grossProfit, m.marginPercent, m.variableCosts, m.contribution,
    m.marketing, m.fixed, m.profitInHand, m.returnRatePercent, m.discounts
  ]);
  res.type('text/csv').set('Content-Disposition', 'attachment; filename="monthly-pnl.csv"')
    .send(csvOf([
      'month', 'orders', 'units', 'gross_sales', 'refunds', 'net_sales', 'gst', 'revenue_ex_gst',
      'cogs', 'gross_profit', 'gross_margin_pct', 'variable_costs', 'contribution',
      'marketing', 'fixed_costs', 'profit_in_hand', 'return_rate_pct', 'discounts'
    ], rows));
});

/** Per-SKU profitability for the window. */
router.get('/reports/export/skus.csv', requireSection('reports'), (req, res) => {
  const config = loadConfig();
  const spec = rangeSpec(req, '7d');
  const rows = skuRows(spec, config).map((r) => [
    r.sku, r.name, r.categories, r.price, r.unitCost, r.gstPercent,
    r.units, r.revenue, r.cost, r.profit, r.marginPercent, r.stock
  ]);
  res.type('text/csv').set('Content-Disposition', 'attachment; filename="sku-profitability.csv"')
    .send(csvOf(['sku', 'name', 'categories', 'price', 'unit_cost', 'gst_pct', 'units_sold', 'revenue', 'cogs', 'profit', 'margin_pct', 'stock_now'], rows));
});

module.exports = { router, adminGuard, compact, buildQs, notify };
