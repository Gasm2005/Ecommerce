'use strict';

/**
 * Admin router, part two: reviews, journal, marketing (SEO/AEO/GEO),
 * discounts, customers, settings, activity log.
 */

const express = require('express');
const { loadConfig } = require('../config');
const catalog = require('../catalog');
const analytics = require('../analytics');
const orders = require('../orders');
const reviews = require('../reviews');
const googleReviews = require('../reviews-google');
const media = require('../media');
const returns = require('../returns');
const codRules = require('../cod');
const notifications = require('../notifications');
const payments = require('../payments');
const journal = require('../journal');
const marketing = require('../marketing');
const discounts = require('../discounts');
const settings = require('../settings');
const activity = require('../activity');
const invoice = require('../invoice');
const auth = require('../auth');
const hx = require('../hx');
const secrets = require('../secrets');

const router = express.Router();

/* Re-declared here because both routers are mounted separately; the guard that
   populates res.locals.user runs in admin.js and applies to both. */
const { requireSection, requireFeature } = require('./gate');

/** ASCII-safe: toast text carries currency symbols and curly quotes. */
function notify(res, message, tone) {
  hx.toast(res, message, tone);
}

/* ------------------------------------------------------------- reviews ---- */

function reviewsModel(req) {
  return {
    groups: reviews.byProduct({ q: req.query.q, status: req.query.status }),
    overview: reviews.overview(),
    filters: { q: req.query.q || '', status: req.query.status || '' },
    statuses: reviews.STATUSES
  };
}

router.get('/reviews', requireSection('reviews'), (req, res) => res.render('admin/reviews', reviewsModel(req)));

router.get('/reviews/rows', requireSection('reviews'), (req, res) => {
  const params = new URLSearchParams(req.query);
  params.delete('token');
  const qs = params.toString();
  res.set('HX-Push-Url', '/admin/reviews' + (qs ? '?' + qs : ''));
  res.render('admin/fragments/review-groups', reviewsModel(req));
});

router.post('/reviews/:id/status', requireSection('reviews'), (req, res) => {
  const wasPublished = (reviews.all().find((x) => x.id === req.params.id) || {}).status === 'published';
  const updated = reviews.setStatus(req.params.id, req.body.status);
  if (updated) activity.log('Reviews', `${updated.id} → ${updated.status} (${updated.rating}★)`);

  /* Only on the transition into published, so re-saving an already-live review does
     not thank the same person twice. Never let a mail failure fail the approval. */
  if (updated && updated.status === 'published' && !wasPublished) {
    notifications.reviewPublished(updated, loadConfig())
      .catch((err) => console.error('review email failed:', err.message));
  }
  notify(res, updated ? `Review ${updated.status}` : 'Review not found', updated ? 'good' : 'critical');
  res.render('admin/fragments/review-groups', reviewsModel(req));
});

router.post('/reviews/:id/reply', requireSection('reviews'), (req, res) => {
  const updated = reviews.reply(req.params.id, String(req.body.reply || '').slice(0, 800));
  if (updated) activity.log('Reviews', `Replied to ${updated.id}`);
  notify(res, 'Reply saved');
  res.render('admin/fragments/review-groups', reviewsModel(req));
});

router.post('/reviews/:id/delete', requireSection('reviews'), (req, res) => {
  const removed = reviews.remove(req.params.id);
  if (removed) activity.log('Reviews', `Deleted ${removed.id}`);
  notify(res, 'Review deleted');
  res.render('admin/fragments/review-groups', reviewsModel(req));
});

/* --------------------------------------------------- returns & refunds ---- */

function returnsModel(req) {
  return {
    rows: returns.query({ status: req.query.status, q: req.query.q }),
    overview: returns.overview(),
    statuses: returns.STATUSES,
    methods: returns.METHODS,
    filters: { status: req.query.status || '', q: req.query.q || '' }
  };
}

router.get('/returns', requireSection('returns'), (req, res) => res.render('admin/returns', returnsModel(req)));

router.get('/returns/rows', requireSection('returns'), (req, res) => {
  const params = new URLSearchParams(req.query);
  params.delete('token');
  const qs = params.toString();
  res.set('HX-Push-Url', '/admin/returns' + (qs ? '?' + qs : ''));
  res.render('admin/fragments/return-rows', returnsModel(req));
});

router.get('/returns/export.csv', requireSection('returns'), (req, res) => {
  res.type('text/csv').set('Content-Disposition', 'attachment; filename="returns.csv"')
    .send(returns.csv(returns.query({ status: req.query.status, q: req.query.q })));
});

router.post('/returns/:id/status', requireSection('returns'), (req, res) => {
  try {
    const updated = returns.setStatus(req.params.id, req.body.status, {
      amount: req.body.amount,
      note: req.body.note
    });
    if (updated) {
      const config = loadConfig();
      const order = orders.byId(updated.orderId);

      // Refund through the gateway when the order was paid online. A gateway
      // failure must not undo the refund record — the admin is told to do it
      // by hand instead, which is safer than silently pretending it worked.
      if (updated.status === 'refunded' && order && order.payment && order.payment.paymentId) {
        payments.refund({
          paymentId: order.payment.paymentId,
          amount: updated.refundAmount,
          config,
          notes: { returnId: updated.id, orderId: updated.orderId }
        })
          .then((out) => activity.log('Payments', out.ok
            ? `Gateway refund ${out.refundId} issued for ${updated.orderId}`
            : `Gateway refund failed for ${updated.orderId}: ${out.reason} — refund manually`))
          .catch((err) => activity.log('Payments', `Gateway refund error on ${updated.orderId}: ${err.message} — refund manually`));
      }

      notifications.returnUpdate(updated, order, config)
        .catch((err) => console.error('return email failed:', err.message));

      activity.log('Returns', `${updated.id} → ${updated.status}` +
        (updated.status === 'refunded' ? ` (₹${(updated.refundAmount || 0).toLocaleString('en-IN')} refunded on ${updated.orderId})` : ''));
      notify(res, updated.status === 'refunded'
        ? `Refunded ₹${(updated.refundAmount || 0).toLocaleString('en-IN')} · ${updated.orderId} marked returned`
        : `${updated.id} ${updated.status}`);
    }
  } catch (err) {
    notify(res, err.message, 'critical');
  }
  res.render('admin/fragments/return-rows', returnsModel(req));
});

router.post('/returns/:id/delete', requireSection('returns'), (req, res) => {
  const removed = returns.remove(req.params.id);
  if (removed) activity.log('Returns', `Deleted ${removed.id}`);
  notify(res, removed ? 'Request deleted' : 'Not found', removed ? 'good' : 'critical');
  res.render('admin/fragments/return-rows', returnsModel(req));
});

/* ------------------------------------------------------------- journal ---- */

router.get('/journal', requireSection('journal'), (req, res) => {
  res.render('admin/journal', { posts: journal.all().sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt))), tags: journal.tags() });
});

router.get('/journal/new', requireSection('journal'), (req, res) => {
  res.render('admin/journal-edit', { post: null, error: null });
});

router.post('/journal', requireSection('journal'), (req, res) => {
  const fields = journal.fieldsFromBody(req.body);
  if (!fields.title) return res.status(400).render('admin/journal-edit', { post: null, error: 'A title is required.' });
  const post = journal.create(fields);
  activity.log('Journal', `Created “${post.title}” (${post.status})`);
  res.redirect(`/admin/journal/${post.id}${res.locals.tokenQs}`);
});

router.get('/journal/:id', requireSection('journal'), (req, res, next) => {
  const post = journal.byId(req.params.id);
  if (!post) return next();
  res.render('admin/journal-edit', { post, error: null });
});

router.post('/journal/:id', requireSection('journal'), (req, res) => {
  try {
    const updated = journal.update(req.params.id, journal.fieldsFromBody(req.body));
    if (!updated) return res.status(404).send('Post not found');
    activity.log('Journal', `Updated “${updated.title}”`);
    const qs = res.locals.adminToken ? `?token=${res.locals.adminToken}&saved=1` : '?saved=1';
    res.redirect(`/admin/journal/${updated.id}${qs}`);
  } catch (err) {
    res.status(400).render('admin/journal-edit', { post: journal.byId(req.params.id), error: err.message });
  }
});

router.post('/journal/:id/status', requireSection('journal'), (req, res) => {
  const updated = journal.setStatus(req.params.id, req.body.status);
  if (updated) activity.log('Journal', `“${updated.title}” → ${updated.status}`);
  notify(res, updated ? `Post ${updated.status}` : 'Not found', updated ? 'good' : 'critical');
  res.render('admin/fragments/journal-rows', { posts: journal.all().sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt))) });
});

router.post('/journal/:id/delete', requireSection('journal'), (req, res) => {
  const removed = journal.remove(req.params.id);
  if (removed) activity.log('Journal', `Deleted “${removed.title}”`);
  notify(res, removed ? 'Post deleted' : 'Not found', removed ? 'good' : 'critical');
  res.render('admin/fragments/journal-rows', { posts: journal.all().sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt))) });
});

/* ----------------------------------------------------------- marketing ---- */

function marketingModel(req) {
  const config = loadConfig();
  const d = marketing.data();
  return {
    seo: d.seo,
    aeo: d.aeo,
    geo: d.geo,
    audit: marketing.audit(config),
    products: catalog.all(),
    crawlers: marketing.AI_CRAWLERS,
    tab: ['seo', 'aeo', 'geo'].includes(req.query.tab) ? req.query.tab : 'seo',
    journalCount: journal.published().length
  };
}

router.get('/marketing', requireSection('marketing'), (req, res) => res.render('admin/marketing', marketingModel(req)));

router.post('/marketing/seo', requireSection('marketing'), (req, res) => {
  marketing.updateSection('seo', {
    titleSuffix: req.body.titleSuffix || '',
    defaultDescription: req.body.defaultDescription || '',
    keywords: String(req.body.keywords || '').split(',').map((k) => k.trim()).filter(Boolean),
    ogImage: String(req.body.ogImage || '').trim() || null,
    canonicalHost: String(req.body.canonicalHost || '').trim().replace(/\/$/, ''),
    indexable: req.body.indexable === 'on'
  });
  activity.log('Marketing', 'Updated SEO defaults');
  notify(res, 'SEO settings saved');
  res.render('admin/fragments/marketing-audit', marketingModel(req));
});

router.post('/marketing/product-seo', requireSection('marketing'), (req, res) => {
  marketing.setProductSeo(req.body.slug, {
    title: String(req.body.title || '').trim() || undefined,
    description: String(req.body.description || '').trim() || undefined,
    keywords: String(req.body.keywords || '').split(',').map((k) => k.trim()).filter(Boolean),
    indexable: req.body.indexable === 'on'
  });
  activity.log('Marketing', `SEO override for ${req.body.slug}`);
  notify(res, 'Product SEO saved');
  res.render('admin/fragments/marketing-audit', marketingModel(req));
});

router.post('/marketing/aeo', requireSection('marketing'), (req, res) => {
  marketing.updateSection('aeo', { answerBlurb: String(req.body.answerBlurb || '').trim() });
  activity.log('Marketing', 'Updated AEO answer blurb');
  notify(res, 'Answer blurb saved');
  res.render('admin/fragments/marketing-audit', marketingModel(req));
});

router.post('/marketing/faq', requireSection('marketing'), (req, res) => {
  if (req.body.q && req.body.a) {
    marketing.addFaq({ q: req.body.q, a: req.body.a, scope: req.body.scope || 'global' });
    activity.log('Marketing', 'Added FAQ');
    notify(res, 'FAQ added');
  }
  res.render('admin/fragments/faq-list', marketingModel(req));
});

router.post('/marketing/faq/:id/delete', (req, res) => {
  marketing.removeFaq(req.params.id);
  activity.log('Marketing', 'Deleted FAQ');
  notify(res, 'FAQ deleted');
  res.render('admin/fragments/faq-list', marketingModel(req));
});

router.post('/marketing/geo', requireSection('marketing'), (req, res) => {
  marketing.updateSection('geo', {
    allowAiCrawlers: req.body.allowAiCrawlers === 'on',
    llmsExtra: String(req.body.llmsExtra || '').trim(),
    citations: String(req.body.citations || '').split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
      const [label, href] = line.split('|').map((s) => s.trim());
      return { label: label || href, href: href || '/' };
    })
  });
  activity.log('Marketing', 'Updated GEO settings');
  notify(res, 'GEO settings saved');
  res.render('admin/fragments/marketing-audit', marketingModel(req));
});

router.post('/marketing/fact', requireSection('marketing'), (req, res) => {
  if (req.body.label && req.body.value) {
    marketing.addFact({ label: req.body.label, value: req.body.value });
    notify(res, 'Fact added');
  }
  res.render('admin/fragments/fact-list', marketingModel(req));
});

router.post('/marketing/fact/:index/delete', (req, res) => {
  marketing.removeFact(req.params.index);
  notify(res, 'Fact removed');
  res.render('admin/fragments/fact-list', marketingModel(req));
});

/* ----------------------------------------------------------- discounts ---- */

router.get('/discounts', requireSection('discounts'), (req, res) => {
  const all = orders.all();
  const usage = new Map();
  all.forEach((o) => {
    if (!o.discountCode) return;
    const row = usage.get(o.discountCode) || { orders: 0, given: 0, revenue: 0 };
    row.orders += 1;
    row.given += o.discount || 0;
    row.revenue += o.total;
    usage.set(o.discountCode, row);
  });

  res.render('admin/discounts', {
    rows: discounts.all().map((d) => ({ ...d, usage: usage.get(d.code) || { orders: 0, given: 0, revenue: 0 } })),
    types: discounts.TYPES
  });
});

router.post('/discounts', requireSection('discounts'), (req, res) => {
  try {
    const row = discounts.upsert(req.body);
    activity.log('Discounts', `Saved code ${row.code}`);
    notify(res, `Saved ${row.code}`);
  } catch (err) {
    notify(res, err.message, 'critical');
  }
  res.set('HX-Redirect', '/admin/discounts' + res.locals.tokenQs);
  res.send('');
});

router.post('/discounts/:code/toggle', (req, res) => {
  const updated = discounts.toggle(req.params.code);
  if (updated) activity.log('Discounts', `${updated.code} ${updated.active ? 'activated' : 'paused'}`);
  res.set('HX-Redirect', '/admin/discounts' + res.locals.tokenQs);
  res.send('');
});

router.post('/discounts/:code/delete', (req, res) => {
  const removed = discounts.remove(req.params.code);
  if (removed) activity.log('Discounts', `Deleted ${removed.code}`);
  res.set('HX-Redirect', '/admin/discounts' + res.locals.tokenQs);
  res.send('');
});

/* ----------------------------------------------------------- customers ---- */

router.get('/customers', requireSection('customers'), (req, res) => {
  const range = req.query.range || 'all';
  const data = analytics.customers(range);
  const q = (req.query.q || '').toLowerCase();
  const rows = q
    ? data.rows.filter((r) => (r.name + ' ' + r.email + ' ' + r.city + ' ' + r.phone).toLowerCase().includes(q))
    : data.rows;
  res.render('admin/customers', { data, rows, filters: { q: req.query.q || '', range } });
});

router.get('/customers/export.csv', requireSection('customers'), (req, res) => {
  const rows = analytics.customers('all').rows;
  const head = ['name', 'email', 'phone', 'city', 'orders', 'spend', 'first_order', 'last_order'];
  const body = rows.map((r) => [r.name, r.email, r.phone, r.city, r.orders, r.spend, r.first.slice(0, 10), r.last.slice(0, 10)]);
  const csv = [head, ...body].map((r) => r.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c))).join(',')).join('\n') + '\n';
  res.type('text/csv').set('Content-Disposition', 'attachment; filename="customers.csv"').send(csv);
});

/* ------------------------------------------------------------ settings ---- */

const SECTION_BOOLEANS = {
  shipping: ['codAvailable'],
  features: ['guestCheckout', 'wishlist', 'quickView', 'infiniteScroll', 'showMrpStrikethrough',
    // Unchecked checkboxes never post, so these must be listed or they can never
    // be switched OFF once on.
    'madeToOrder', 'customisation', 'orderNotes'],
  reviews: ['showStoreBadge', 'merchantFeed', 'requirePurchase', 'allowMedia'],
  inventory: [],
  brand: [],
  theme: []
};

/**
 * Values the credentials panel is allowed to show: public ids in full, secrets
 * masked to their last four characters. Nothing here reveals a saved secret.
 */
function secretView() {
  const view = {};
  const publicKeys = [
    'payments.razorpay.keyId',
    'notifications.smtp.host', 'notifications.smtp.port', 'notifications.smtp.user'
  ];
  const maskedKeys = [
    'payments.razorpay.keySecret', 'payments.razorpay.webhookSecret',
    'notifications.smtp.pass', 'notifications.resend.apiKey',
    'notifications.brevo.apiKey', 'notifications.interakt.apiKey'
  ];
  publicKeys.forEach((k) => { view[k + '.raw'] = secrets.get(k); });
  maskedKeys.forEach((k) => { view[k] = secrets.masked(k); });
  return view;
}

function connectionsModel(req) {
  const config = loadConfig();
  return {
    payStatus: payments.status(config),
    mailStatus: notifications.status(config),
    cfg: settings.readConfigRaw(),
    secretView: secretView(),
    deliveries: notifications.recent(8),
    payments,
    notifications,
    origin: marketing.origin(req, config)
  };
}

router.get('/settings', requireSection('settings'), (req, res) => {
  const config = loadConfig();
  res.render('admin/settings', {
    ...connectionsModel(req),
    googleStatus: googleReviews.status(config),
    media,
    cod: codRules.codConfig(config),
    codOutstanding: codRules.outstanding(orders.all()),
    invoiceReadiness: invoice.readiness(config),
    stateNames: Object.keys(invoice.STATE_CODES).filter(function (k) { return k.length > 2; }).sort(),
    saved: req.query.saved === '1'
  });
});

/* ------------------------------------------- payments & notifications ---- */

router.post('/settings/payments', requireSection('settings'), (req, res) => {
  const cfg = settings.readConfigRaw();
  cfg.payments = {
    ...(cfg.payments || {}),
    provider: payments.PROVIDERS.some((p) => p.id === req.body.provider) ? req.body.provider : 'manual',
    mode: req.body.mode === 'live' ? 'live' : 'test',
    partialCodChargesAdvance: req.body.partialCodChargesAdvance === 'on'
  };
  settings.writeConfig(cfg);

  // Blank fields mean "leave the saved value alone", so a masked form is safe to post.
  secrets.setMany({
    'payments.razorpay.keyId': req.body.razorpay_keyId,
    'payments.razorpay.keySecret': req.body.razorpay_keySecret,
    'payments.razorpay.webhookSecret': req.body.razorpay_webhookSecret
  });

  activity.log('Settings', `Payment gateway → ${cfg.payments.provider} (${cfg.payments.mode})`);
  const qs = res.locals.adminToken ? `?token=${res.locals.adminToken}&saved=1` : '?saved=1';
  res.redirect('/admin/settings' + qs);
});

router.post('/settings/payments/test', requireSection('settings'), async (req, res) => {
  const config = loadConfig();
  try {
    const out = await payments.test(config);
    notify(res, out.message || 'Gateway reachable.');
  } catch (err) {
    notify(res, err.message, 'critical');
  }
  res.render('admin/fragments/connection-panels', connectionsModel(req));
});

router.post('/settings/notifications', requireSection('settings'), (req, res) => {
  const cfg = settings.readConfigRaw();
  const events = {};
  notifications.EVENTS.forEach((e) => { events[e.id] = req.body['event_' + e.id] === 'on'; });

  cfg.notifications = {
    ...(cfg.notifications || {}),
    emailProvider: notifications.EMAIL_PROVIDERS.some((p) => p.id === req.body.emailProvider) ? req.body.emailProvider : 'log',
    whatsappProvider: notifications.WHATSAPP_PROVIDERS.some((p) => p.id === req.body.whatsappProvider) ? req.body.whatsappProvider : 'off',
    fromName: String(req.body.fromName || '').trim(),
    fromEmail: String(req.body.fromEmail || '').trim(),
    replyTo: String(req.body.replyTo || '').trim(),
    storeEmail: String(req.body.storeEmail || '').trim(),
    storePhone: (cfg.notifications && cfg.notifications.storePhone) || cfg.brand.supportPhone,
    events
  };
  settings.writeConfig(cfg);

  secrets.setMany({
    'notifications.smtp.host': req.body.smtp_host,
    'notifications.smtp.port': req.body.smtp_port,
    'notifications.smtp.user': req.body.smtp_user,
    'notifications.smtp.pass': req.body.smtp_pass,
    'notifications.resend.apiKey': req.body.resend_apiKey,
    'notifications.brevo.apiKey': req.body.brevo_apiKey,
    'notifications.interakt.apiKey': req.body.interakt_apiKey
  });

  activity.log('Settings', `Notifications → ${cfg.notifications.emailProvider}, WhatsApp ${cfg.notifications.whatsappProvider}`);
  const qs = res.locals.adminToken ? `?token=${res.locals.adminToken}&saved=1` : '?saved=1';
  res.redirect('/admin/settings' + qs);
});

router.post('/settings/notifications/test', requireSection('settings'), async (req, res) => {
  const config = loadConfig();
  const to = String(req.body.testTo || '').trim();
  if (!to) notify(res, 'Enter an address to send the test to.', 'critical');
  else {
    const out = await notifications.sendTest(to, config);
    notify(res,
      out.ok ? (out.logged ? `Written to the server log (provider is “log”) — set a real provider to actually send.` : `Test sent to ${to}.`) : out.error,
      out.ok ? 'good' : 'critical');
  }
  res.render('admin/fragments/connection-panels', connectionsModel(req));
});

/** Finance is nested (monthlyCosts / perOrderCosts / percentCosts), so the form
    posts prefixed names and they're unpacked here. */
router.post('/settings/finance', requireSection('settings'), (req, res) => {
  const cfg = settings.readConfigRaw();
  const num = (v) => {
    const n = Number(String(v).replace(/[₹,\s%]/g, ''));
    return Number.isFinite(n) ? n : 0;
  };

  const finance = { ...cfg.finance };
  if (req.body.gstPercentDefault !== undefined) finance.gstPercentDefault = num(req.body.gstPercentDefault);
  if (req.body.defaultCogsPercent !== undefined) finance.defaultCogsPercent = num(req.body.defaultCogsPercent);

  // Below-EBITDA costs: separate keys, because folding them into monthlyCosts
  // would understate EBITDA — the one figure a lender or investor compares.
  ['depreciationMonthly', 'interestMonthly', 'incomeTaxPercent'].forEach((key) => {
    if (req.body[key] !== undefined) finance[key] = num(req.body[key]);
  });

  ['monthly', 'perOrder', 'percent'].forEach((group) => {
    const target = group === 'monthly' ? 'monthlyCosts' : (group === 'perOrder' ? 'perOrderCosts' : 'percentCosts');
    const next = { ...(finance[target] || {}) };
    Object.keys(req.body).forEach((k) => {
      if (!k.startsWith(group + '_')) return;
      next[k.slice(group.length + 1)] = num(req.body[k]);
    });
    finance[target] = next;
  });

  cfg.finance = finance;
  settings.writeConfig(cfg);
  activity.log('Settings', 'Updated the finance model');
  const qs = res.locals.adminToken ? `?token=${res.locals.adminToken}&saved=1` : '?saved=1';
  res.redirect('/admin/settings' + qs);
});

router.post('/settings/category-finance', requireSection('settings'), (req, res) => {
  const cfg = settings.readConfigRaw();
  const defaults = { ...(cfg.finance.categoryDefaults || {}) };

  (cfg.nav || []).forEach((n) => {
    const gst = req.body['gst_' + n.slug];
    const cogs = req.body['cogs_' + n.slug];
    const row = { ...(defaults[n.slug] || {}) };

    if (gst === '' || gst === undefined) delete row.gstPercent;
    else row.gstPercent = Number(gst) || 0;

    if (cogs === '' || cogs === undefined) delete row.cogsPercent;
    else row.cogsPercent = Number(cogs) || 0;

    if (Object.keys(row).length) defaults[n.slug] = row;
    else delete defaults[n.slug];
  });

  cfg.finance.categoryDefaults = defaults;
  settings.writeConfig(cfg);
  activity.log('Settings', 'Updated per-category GST / COGS defaults');
  const qs = res.locals.adminToken ? `?token=${res.locals.adminToken}&saved=1` : '?saved=1';
  res.redirect('/admin/settings' + qs);
});

router.post('/settings/cod', requireSection('settings'), (req, res) => {
  const cfg = settings.readConfigRaw();
  const list = (v) => String(v || '').split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  const num = (v) => {
    const n = Number(String(v).replace(/[₹,\s%]/g, ''));
    return Number.isFinite(n) ? n : 0;
  };

  cfg.shipping = cfg.shipping || {};
  cfg.shipping.cod = {
    ...(cfg.shipping.cod || {}),
    enabled: req.body.enabled === 'on',
    partialEnabled: req.body.partialEnabled === 'on',
    fullEnabled: req.body.fullEnabled === 'on',
    advanceType: req.body.advanceType === 'flat' ? 'flat' : 'percent',
    advancePercent: num(req.body.advancePercent),
    advanceFlat: num(req.body.advanceFlat),
    minOrder: num(req.body.minOrder),
    maxOrder: num(req.body.maxOrder),
    pincodeMode: req.body.pincodeMode === 'allow-list' ? 'allow-list' : 'block-list',
    blockedPincodes: list(req.body.blockedPincodes),
    blockedPrefixes: list(req.body.blockedPrefixes),
    allowedPincodesOnly: list(req.body.allowedPincodesOnly)
  };

  settings.writeConfig(cfg);
  activity.log('Settings', `COD: ${cfg.shipping.cod.enabled ? 'on' : 'off'}, full ${cfg.shipping.cod.fullEnabled ? 'on' : 'off'}, partial ${cfg.shipping.cod.partialEnabled ? 'on' : 'off'}, ${cfg.shipping.cod.pincodeMode}`);
  const qs = res.locals.adminToken ? `?token=${res.locals.adminToken}&saved=1` : '?saved=1';
  res.redirect('/admin/settings' + qs);
});

/**
 * Legal entity details for GST invoices. Kept separate from the generic section
 * writer because the address, terms and bank block are arrays and an object,
 * which the flat coercer would flatten into strings.
 */
router.post('/settings/business', requireSection('settings'), (req, res) => {
  const cfg = settings.readConfigRaw();
  const b = { ...(cfg.business || {}) };
  const str = (k) => String(req.body[k] || '').trim();
  const lines = (k) => String(req.body[k] || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  b.legalName = str('legalName');
  b.tradeName = str('tradeName');
  b.gstin = str('gstin').toUpperCase();
  b.pan = str('pan').toUpperCase();
  b.addressLines = lines('addressLines');
  b.state = str('state');
  // A wrong state code means CGST/SGST vs IGST comes out wrong, so derive it
  // from the state name whenever the admin leaves the code blank.
  b.stateCode = str('stateCode') || invoice.stateCode(b.state) || '';
  b.phone = str('phone');
  b.email = str('email');
  b.invoicePrefix = str('invoicePrefix').toUpperCase() || 'INV';
  b.defaultHsn = str('defaultHsn');
  b.signatureName = str('signatureName');
  b.termsLines = lines('termsLines');
  b.bank = str('bankName') || str('bankAccountNumber')
    ? {
      name: str('bankName'),
      accountName: str('bankAccountName'),
      accountNumber: str('bankAccountNumber'),
      ifsc: str('bankIfsc').toUpperCase(),
      upi: str('bankUpi')
    }
    : null;

  cfg.business = b;
  settings.writeConfig(cfg);
  activity.log('Settings', 'Updated business & invoice details');
  const qs = res.locals.adminToken ? `?token=${res.locals.adminToken}&saved=1` : '?saved=1';
  res.redirect('/admin/settings' + qs);
});

router.post('/settings/:section', requireSection('settings'), (req, res) => {
  const section = req.params.section;
  if (!Object.prototype.hasOwnProperty.call(SECTION_BOOLEANS, section)) {
    return res.status(400).send('Unknown settings section');
  }

  // theme.colors is nested one level deeper than the other sections.
  if (section === 'theme') {
    const cfg = settings.readConfigRaw();
    const colors = { ...cfg.theme.colors };
    Object.keys(req.body).forEach((k) => {
      if (k.startsWith('color_')) colors[k.replace('color_', '')] = String(req.body[k]).trim();
    });
    cfg.theme = { ...cfg.theme, colors };
    if (req.body.headingFont) cfg.theme.fonts.heading = String(req.body.headingFont).trim();
    if (req.body.bodyFont) cfg.theme.fonts.body = String(req.body.bodyFont).trim();
    settings.writeConfig(cfg);
  } else {
    settings.updateSection(section, req.body, { booleans: SECTION_BOOLEANS[section] });
  }

  activity.log('Settings', `Updated ${section}`);
  const qs = res.locals.adminToken ? `?token=${res.locals.adminToken}&saved=1` : '?saved=1';
  res.redirect('/admin/settings' + qs);
});

/* ------------------------------------------------------------ activity ---- */

router.get('/activity', requireSection('activity'), (req, res) => {
  res.render('admin/activity', { rows: activity.all() });
});

module.exports = { router };
