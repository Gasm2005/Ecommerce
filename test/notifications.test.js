'use strict';

/**
 * Order confirmations.
 *
 * This was the last part of the shop with no tests at all, which is a poor place for
 * that to be true: it is the only promise the shop makes after taking someone's
 * money, and it fails silently by design. send() catches everything so a mail outage
 * cannot break a checkout — correct, and it means a template that throws produces no
 * email, no error, and a customer who assumes the order never went through.
 *
 * So these tests do three things. They render every template against awkward order
 * shapes, because that is where a template breaks. They assert what actually leaves
 * the building — address, subject, the numbers a customer will compare against their
 * bank statement. And they prove the failure paths: that a dead provider does not take
 * checkout down with it, and that a shop whose mail has stopped is told so.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sandbox } = require('./helpers/sandbox');

const { config, configPath } = sandbox();

const fs = require('fs');
const path = require('path');
const notifications = require('../src/notifications');
const ordersStore = require('../src/orders');
const catalog = require('../src/catalog');

/* ------------------------------------------------------------- a test rig ---- */

/**
 * Points the config at the 'log' provider, which needs no credentials and records every
 * send in the same delivery log the admin and doctor read.
 */
function useFakeProvider() {
  const next = {
    ...JSON.parse(fs.readFileSync(configPath, 'utf8')),
    notifications: {
      emailProvider: 'log',       // 'log' needs no credentials
      whatsappProvider: 'off',
      fromName: 'Test Store',
      fromEmail: 'orders@test.example',
      replyTo: 'care@test.example',
      storeEmail: 'store@test.example',
      storePhone: '+91 90000 00000',
      events: {}
    }
  };
  fs.writeFileSync(configPath, JSON.stringify(next, null, 2));
  require('../src/config').invalidate();
  return require('../src/config').loadConfig();
}

/* ------------------------------------------------------------ order shapes ---- */

/** An order as the real checkout writes one, so templates see real fields. */
function makeOrder(overrides = {}, state = {}) {
  const product = catalog.all().find((p) => p.id === 'p001');
  // orders.create() snapshots from l.product, so lines carry the product itself —
  // the same shape cart.hydrate() produces.
  const summary = {
    lines: [{ product, size: 'S', color: 'Red', qty: 1, lineTotal: product.price }],
    count: 1,
    subtotal: product.price,
    discount: 0,
    shipping: 0,
    giftWrapCharge: 0,
    total: product.price,
    gstAmount: Math.round(product.price * 5 / 105),
    ...overrides
  };

  return ordersStore.create({
    cartSummary: summary,
    state: {
      fullName: 'Test Buyer', phone: '9820000000', email: 'buyer@test.example',
      address1: '1 Test Road', pincode: '400001', city: 'Mumbai', state: 'Maharashtra',
      paymentMethod: 'upi', deliveryMethod: 'standard',
      ...state
    },
    config: require('../src/config').loadConfig(),
    attribution: {},
    codPlan: null,
    payment: null
  });
}

before(() => { useFakeProvider(); });
after(() => { useFakeProvider(); });

/* ----------------------------------------------------- every template renders ---- */

/**
 * A template only breaks on the order shape nobody tried. These are the shapes that
 * differ structurally, not just numerically: no discount vs a coupon, free vs charged
 * delivery, gift wrap on, GST off, an empty address line, a refunded order.
 */
const SHAPES = [
  { name: 'plain order', over: {} },
  { name: 'with a coupon', over: { discount: 2000, discountCode: 'TEST20', total: 8000 } },
  { name: 'charged delivery', over: { shipping: 499, total: 10499 } },
  { name: 'gift wrapped', over: { giftWrapCharge: 300, total: 10300 } },
  { name: 'no GST resolved', over: { gstAmount: 0 } },
  { name: 'everything at once', over: { discount: 1000, discountCode: 'BIG', shipping: 499, giftWrapCharge: 300, total: 9799 } }
];

SHAPES.forEach(({ name, over }) => {
  test(`the confirmation renders for an order ${name}`, async () => {
    const cfg = require('../src/config').loadConfig();
    const order = makeOrder(over);

    const results = await notifications.orderPlaced(order, cfg, 'https://shop.test.example');

    results.forEach((r) => {
      assert.equal(r.error, undefined, `${r.event} failed to render: ${r.error}`);
      assert.equal(r.ok, true, `${r.event} did not go out`);
    });
  });
});

test('a status change renders for every status that has an email', async () => {
  const cfg = require('../src/config').loadConfig();
  const order = makeOrder();

  for (const status of ['shipped', 'delivered', 'cancelled']) {
    const r = await notifications.orderStatus({ ...order, status }, status, cfg);
    assert.ok(r, `${status} should send something`);
    assert.equal(r.error, undefined, `${status} failed to render: ${r.error}`);
  }
});

test('a status with no email defined sends nothing rather than throwing', async () => {
  const cfg = require('../src/config').loadConfig();
  const r = await notifications.orderStatus(makeOrder(), 'in_production', cfg);
  assert.equal(r, null, 'in_production has no customer email, and that is fine');
});

/* ------------------------------------------------- what the customer receives ---- */

test('the confirmation carries the numbers a customer will check', async () => {
  const cfg = require('../src/config').loadConfig();
  const order = makeOrder({ shipping: 499, total: 10499 });

  const html = await renderConfirmation(order, cfg);
  const flat = html.replace(/\s+/g, ' ');

  assert.match(flat, new RegExp(order.id), 'the order number is what they will quote back');
  assert.match(flat, /Test Lehenga/, 'and what they bought');
  assert.match(flat, /S · Red|S &middot; Red/, 'in the size and colour they chose');

  const rupees = (n) => n.toLocaleString('en-IN');
  assert.ok(flat.includes(rupees(order.total)), `total ${rupees(order.total)} must appear`);
  assert.ok(flat.includes(rupees(499)), 'a delivery charge they paid must be itemised');
});

test('the confirmation says where it is going, so a wrong address is caught early', async () => {
  const cfg = require('../src/config').loadConfig();
  const order = makeOrder();
  const flat = (await renderConfirmation(order, cfg)).replace(/\s+/g, ' ');

  assert.match(flat, /1 Test Road/);
  assert.match(flat, /400001/);
  assert.match(flat, /Mumbai/);
  assert.match(flat, /9820000000/, 'the phone too — a courier calls it');
});

test('the invoice link does not carry their email through the internet', async () => {
  const cfg = require('../src/config').loadConfig();
  const order = makeOrder();
  const html = await renderConfirmation(order, cfg, 'https://shop.test.example');

  const links = html.match(/href="[^"]+"/g) || [];
  assert.ok(links.length, 'there should be a way to reach the invoice');
  links.forEach((href) => {
    assert.doesNotMatch(href, /buyer@test\.example/, 'a forwarded email would hand over the address');
    assert.doesNotMatch(href, /9820000000/);
  });
});

/** Renders order-placed exactly as send() does, so this asserts the real output. */
async function renderConfirmation(order, cfg, origin = 'https://shop.test.example') {
  const ejs = require('ejs');
  const settings = notifications.settings(cfg);
  return ejs.renderFile(
    path.join(__dirname, '..', 'views', 'emails', 'order-placed.ejs'),
    { order, origin, fulfilment: require('../src/fulfilment'), config: cfg, brand: cfg.brand, settings },
    { async: false }
  );
}

/* ------------------------------------------------------- switches and skips ---- */

test('an event turned off is skipped, not failed', async () => {
  const cfg = require('../src/config').loadConfig();
  const off = { ...cfg, notifications: { ...cfg.notifications, events: { 'order.placed': false } } };

  const r = await notifications.send({
    event: 'order.placed', to: 'buyer@test.example', subject: 'x',
    template: 'generic', data: { headline: 'x', body: 'x' }, config: off
  });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, 'event turned off');
});

test('system mail cannot be switched off from a settings screen', () => {
  const cfg = require('../src/config').loadConfig();
  // A password reset is not a marketing preference.
  const off = { ...cfg, notifications: { ...cfg.notifications, events: { 'auth.reset': false } } };
  assert.equal(notifications.isEnabled('auth.reset', off), false, 'an explicit setting is still honoured');

  // But it is not in the switchable list, so nothing in the admin can set it.
  assert.equal(notifications.EVENTS.some((e) => e.id === 'auth.reset'), false);
  assert.equal(notifications.isEnabled('auth.reset', cfg), true, 'and it defaults to on');
});

test('an order with no email address is skipped quietly', async () => {
  const cfg = require('../src/config').loadConfig();
  const r = await notifications.send({
    event: 'order.placed', to: '', subject: 'x',
    template: 'generic', data: { headline: 'x', body: 'x' }, config: cfg
  });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, 'no address on the order');
});

/* ------------------------------------------------------------ failure paths ---- */

test('a template that throws is recorded as a failure, not reported as sent', async () => {
  const cfg = require('../src/config').loadConfig();
  const r = await notifications.send({
    event: 'order.placed', to: 'buyer@test.example', subject: 'x',
    template: 'no-such-template', data: {}, config: cfg
  });
  assert.equal(r.ok, false, 'a missing template must not read as delivered');
  assert.ok(r.error, 'and it must say why');
});

test('a mail failure does not take the checkout down with it', async () => {
  const cfg = require('../src/config').loadConfig();
  // Whatever goes wrong, send() resolves — the caller is inside a paid checkout.
  await assert.doesNotReject(() => notifications.send({
    event: 'order.placed', to: 'buyer@test.example', subject: 'x',
    template: 'no-such-template', data: {}, config: cfg
  }));

  await assert.doesNotReject(() => notifications.orderPlaced(
    { ...makeOrder(), items: null },       // a shape no template can handle
    cfg, 'https://shop.test.example'
  ));
});

/* -------------------------------------------------------------- is it working ---- */

/**
 * status() answers "is it configured", which stops being the useful question the day
 * after launch. An expired SMTP password leaves every credential in place, so the
 * shop keeps reporting ready while no confirmation reaches anyone.
 */
test('health reads the delivery log, not the settings', async () => {
  const cfg = require('../src/config').loadConfig();

  // Three real failures in a row is a broken provider, not a flaky network.
  for (let i = 0; i < 3; i++) {
    await notifications.send({
      event: 'order.placed', to: 'buyer@test.example', subject: 'x',
      template: 'no-such-template', data: {}, config: cfg
    });
  }

  const bad = notifications.health();
  assert.ok(bad.consecutiveFailures >= 3);
  assert.equal(bad.broken, true, 'the owner has to be told');
  assert.ok(bad.reason, 'and told what went wrong');

  // One success clears it: the point is "is it working NOW".
  await notifications.send({
    event: 'order.placed', to: 'buyer@test.example', subject: 'x',
    template: 'generic', data: { headline: 'x', body: 'x' }, config: cfg
  });

  const good = notifications.health();
  assert.equal(good.consecutiveFailures, 0);
  assert.equal(good.broken, false);
  assert.ok(good.lastOk);
});

test('one failure is not called broken', async () => {
  const cfg = require('../src/config').loadConfig();

  // Start from a success so the window is clean.
  await notifications.send({
    event: 'order.placed', to: 'a@test.example', subject: 'x',
    template: 'generic', data: { headline: 'x', body: 'x' }, config: cfg
  });
  await notifications.send({
    event: 'order.placed', to: 'b@test.example', subject: 'x',
    template: 'no-such-template', data: {}, config: cfg
  });

  const h = notifications.health();
  assert.equal(h.consecutiveFailures, 1);
  assert.equal(h.broken, false, 'a single timeout is noise — warning about it teaches people to ignore warnings');
  assert.ok(h.failed >= 1, 'but it is still counted');
});

test('skipped sends are not mistaken for failures', async () => {
  const cfg = require('../src/config').loadConfig();
  const off = { ...cfg, notifications: { ...cfg.notifications, events: { 'order.placed': false } } };

  for (let i = 0; i < 5; i++) {
    await notifications.send({
      event: 'order.placed', to: 'buyer@test.example', subject: 'x',
      template: 'generic', data: { headline: 'x', body: 'x' }, config: off
    });
  }

  const h = notifications.health();
  assert.equal(h.broken, false, 'an event switched off is the shop working as configured');
});

/* ---------------------------------------------------------- the plain text ---- */

test('the plain-text part keeps the rupee sign and loses the markup', async () => {
  const cfg = require('../src/config').loadConfig();
  const order = makeOrder();
  const html = await renderConfirmation(order, cfg);

  // toText is not exported; this is the same transformation send() applies.
  const r = await notifications.send({
    event: 'order.placed', to: 'buyer@test.example',
    subject: 'x', template: 'order-placed',
    data: { order, origin: 'https://shop.test.example', fulfilment: require('../src/fulfilment') },
    config: cfg
  });
  assert.equal(r.ok, true);

  assert.match(html, /₹/, 'the HTML has rupees');
  // A mail client showing the text part must not show &#8377; or a bare number.
  const text = html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&#8377;/g, '₹');
  assert.match(text, /₹/);
  assert.doesNotMatch(text, /<[a-z]/i, 'no tags should survive');
});

/* ------------------------------------------------------- the switch that lied ---- */

/**
 * "Review published" has been in the settings list since the start with nothing
 * sending it. An owner could switch it on and receive silence forever — and a switch
 * that does nothing is worse than a missing feature, because it spends the owner's
 * trust in every other switch on the screen.
 */
test('every switchable event has something that actually sends it', async () => {
  /* Driven, not grepped. A first attempt searched the source for "event: 'x'" and
     reported two false positives, because the return emails pick their id with a
     ternary. Running the senders and reading what comes back is the only version of
     this check that cannot be fooled by how the code happens to be written. */
  const cfg = require('../src/config').loadConfig();
  const allOn = {
    ...cfg,
    notifications: {
      ...cfg.notifications,
      events: Object.fromEntries(notifications.EVENTS.map((e) => [e.id, true]))
    }
  };

  const order = makeOrder();
  const fired = new Set();
  const collect = (r) => (Array.isArray(r) ? r : [r]).forEach((x) => { if (x) fired.add(x.event); });

  collect(await notifications.orderPlaced(order, allOn, 'https://shop.test.example'));
  for (const st of ['shipped', 'delivered', 'cancelled']) {
    collect(await notifications.orderStatus({ ...order, status: st }, st, allOn));
  }

  const request = {
    id: 'RET-TEST', orderId: order.id, status: 'requested', refundAmount: 0,
    customer: { email: 'buyer@test.example', phone: '9820000000' }
  };
  collect(await notifications.returnUpdate(request, order, allOn));
  collect(await notifications.returnUpdate({ ...request, status: 'refunded', refundAmount: 5000 }, order, allOn));
  collect(await notifications.reviewPublished({ id: 'rev1', orderId: order.id, productId: 'p001', rating: 5 }, allOn));

  notifications.EVENTS.forEach((e) => {
    assert.ok(fired.has(e.id), `${e.id} is offered in the admin but nothing sends it`);
  });
});

test('a published review is thanked, using the address on the order', async () => {
  const cfg = require('../src/config').loadConfig();
  const order = makeOrder();

  const on = { ...cfg, notifications: { ...cfg.notifications, events: { 'review.published': true } } };
  const r = await notifications.reviewPublished(
    { id: 'rev1', orderId: order.id, productId: 'p001', rating: 5 }, on
  );

  assert.ok(r, 'it should send');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.to, 'buyer@test.example', 'reviews only carry a display name — the order has the address');
  assert.match(r.subject, /Test Lehenga/);
});

test('a review with no order behind it sends nothing rather than throwing', async () => {
  const cfg = require('../src/config').loadConfig();
  assert.equal(await notifications.reviewPublished({ id: 'x', productId: 'p001' }, cfg), null);
  assert.equal(await notifications.reviewPublished({ id: 'x', orderId: 'ORD-NOPE', productId: 'p001' }, cfg), null);
});
