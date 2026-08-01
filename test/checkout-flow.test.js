'use strict';

/**
 * The whole checkout, over HTTP, the way a customer walks it.
 *
 * The unit tests above prove the arithmetic. This one proves the WIRING: that
 * the number the summary shows is the number the order is written with. The
 * delivery-charge bug passed every unit-level check that existed at the time and
 * still shipped, because nothing walked the route.
 *
 * No mocks. A real server on a random port, real cookies, real HTML.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sandbox } = require('./helpers/sandbox');

const { config } = sandbox();

// Copy the views and public assets the app renders — they live outside DATA_DIR.
process.env.PORT = '0';

let server;
let base;
const jar = new Map();

/** Minimal cookie jar: checkout state lives in cookies, so this is the session. */
function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}
function storeCookies(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  raw.forEach((line) => {
    const [pair] = line.split(';');
    const idx = pair.indexOf('=');
    jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  });
}

async function req(method, path, body) {
  const res = await fetch(base + path, {
    method,
    redirect: 'manual',
    headers: {
      cookie: cookieHeader(),
      ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {})
    },
    body: body ? new URLSearchParams(body).toString() : undefined
  });
  storeCookies(res);
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

const get = (p) => req('GET', p);
const post = (p, body) => req('POST', p, body);

/**
 * Money figures as rendered, so we assert what the customer actually reads.
 * The label must fill a whole tag body: matching "Total" loosely also matches
 * the "Total" inside "Subtotal", which is a confusing way to fail.
 */
function rupees(html, label) {
  const flat = html.replace(/\s+/g, ' ');
  const re = new RegExp('>\\s*' + label + '\\s*<[^₹]{0,300}?₹\\s*([\\d,]+)', 'i');
  const m = re.exec(flat);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

before(async () => {
  const app = require('../server');
  server = app.listen ? app.listen(0) : null;
  assert.ok(server, 'server.js must export the express app for tests to drive it');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { if (server) server.close(); });

const ADDRESS = {
  _from: '1',
  fullName: 'Test Buyer',
  phone: '9820000000',
  email: 'buyer@test.example',
  address1: '1 Test Road',
  pincode: '400001',
  city: 'Mumbai',
  state: 'Maharashtra',
  country: 'India'
};

test('a customer can walk from an empty cart to a placed order', async () => {
  // Empty cart must not offer a checkout at all.
  const empty = await get('/checkout');
  assert.equal(empty.status, 302, 'an empty cart must be redirected away from checkout');

  await post('/cart/add', { id: 'p001', size: 'M', color: 'Red', qty: '1' });

  const step1 = await get('/checkout');
  assert.equal(step1.status, 200);
  assert.equal(rupees(step1.text, 'Total payable'), 10000, 'the summary must show the cart total');

  const step2 = await post('/checkout/step/2', ADDRESS);
  assert.equal(step2.status, 200);
  assert.match(step2.text, /Delivery method/i);

  const step3 = await post('/checkout/step/3', { _from: '2', deliveryMethod: 'standard' });
  assert.equal(step3.status, 200);
  assert.match(step3.text, /Payment method/i);

  const placed = await post('/checkout/place-order', { _from: '3', paymentMethod: 'upi' });
  const redirect = placed.headers.get('hx-redirect');
  assert.match(redirect || '', /^\/order\/ORD-/, 'placing an order must redirect to it');

  // And the written order matches what was shown.
  const orders = require('../src/orders');
  const order = orders.byId(redirect.split('/').pop());
  assert.equal(order.total, 10000);
  assert.equal(order.customer.name, 'Test Buyer');
  assert.equal(order.items[0].productId, 'p001');
});

test('the price shown for express is the price the order is written with', async () => {
  // This is the exact bug: the option said ₹500 and the order said ₹0.
  jar.clear();
  await post('/cart/add', { id: 'p001', size: 'M', color: 'Red', qty: '1' });
  await post('/checkout/step/2', ADDRESS);

  const quoted = await post('/checkout/quote', { _from: '2', deliveryMethod: 'express' });
  const shownTotal = rupees(quoted.text, 'Total payable');
  const shownDelivery = rupees(quoted.text, 'Express delivery');
  assert.equal(shownDelivery, 500, 'the summary must show the express charge');
  assert.equal(shownTotal, 10500);

  await post('/checkout/step/3', { _from: '2', deliveryMethod: 'express' });
  const placed = await post('/checkout/place-order', { _from: '3', paymentMethod: 'upi' });
  const id = (placed.headers.get('hx-redirect') || '').split('/').pop();

  const order = require('../src/orders').byId(id);
  assert.equal(order.shipping, 500, 'the order must carry the charge the customer saw');
  assert.equal(order.total, shownTotal, 'shown total and charged total must be the same number');
});

test('gift wrap re-quotes live and reaches the order', async () => {
  jar.clear();
  await post('/cart/add', { id: 'p001', size: 'M', color: 'Red', qty: '1' });
  await post('/checkout/step/2', ADDRESS);

  const quoted = await post('/checkout/quote', { _from: '2', deliveryMethod: 'express', giftWrap: 'yes' });
  assert.equal(rupees(quoted.text, 'Gift packaging'), 300);
  assert.equal(rupees(quoted.text, 'Total payable'), 10800);

  await post('/checkout/step/3', { _from: '2', deliveryMethod: 'express', giftWrap: 'yes' });
  const placed = await post('/checkout/place-order', { _from: '3', paymentMethod: 'upi' });
  const order = require('../src/orders').byId((placed.headers.get('hx-redirect') || '').split('/').pop());

  assert.equal(order.giftWrapCharge, 300);
  assert.equal(order.total, 10800);
});

test('GST is disclosed on the summary and stored on the order', async () => {
  jar.clear();
  await post('/cart/add', { id: 'p001', size: 'M', color: 'Red', qty: '1' });
  const page = await get('/checkout');
  const shownTax = rupees(page.text, 'Includes GST');
  assert.ok(shownTax > 0, 'the customer must be told how much GST is included');
  assert.equal(rupees(page.text, 'Total payable'), 10000, 'disclosing GST must not change the total');

  await post('/checkout/step/2', ADDRESS);
  await post('/checkout/step/3', { _from: '2', deliveryMethod: 'standard' });
  const placed = await post('/checkout/place-order', { _from: '3', paymentMethod: 'upi' });
  const order = require('../src/orders').byId((placed.headers.get('hx-redirect') || '').split('/').pop());
  assert.equal(order.gstAmount, shownTax, 'stored GST must match what was shown');
});

test('an incomplete address is refused and nothing is written', async () => {
  jar.clear();
  await post('/cart/add', { id: 'p001', size: 'M', color: 'Red', qty: '1' });
  const orders = require('../src/orders');
  const before = orders.all().length;

  const res = await post('/checkout/step/2', { _from: '1', fullName: '', phone: '', pincode: '' });
  assert.equal(res.status, 200);
  assert.match(res.text, /Delivery address/i, 'a failed step must stay on step 1');
  assert.equal(orders.all().length, before, 'no order may be written from a failed step');
});

test('a payment method the rules forbid cannot place an order', async () => {
  // fullEnabled is false in the fixture, so plain COD must be refused.
  jar.clear();
  await post('/cart/add', { id: 'p001', size: 'M', color: 'Red', qty: '1' });
  await post('/checkout/step/2', ADDRESS);
  await post('/checkout/step/3', { _from: '2', deliveryMethod: 'standard' });

  const orders = require('../src/orders');
  const before = orders.all().length;
  const res = await post('/checkout/place-order', { _from: '3', paymentMethod: 'cod' });

  assert.equal(res.headers.get('hx-redirect'), null, 'a forbidden method must not place an order');
  assert.equal(orders.all().length, before);
  assert.match(res.text, /no longer available|choose another/i);
});

test('partial COD splits the money and leaves the rest to collect', async () => {
  jar.clear();
  await post('/cart/add', { id: 'p001', size: 'M', color: 'Red', qty: '1' });
  await post('/checkout/step/2', ADDRESS);
  await post('/checkout/step/3', { _from: '2', deliveryMethod: 'standard' });
  const placed = await post('/checkout/place-order', { _from: '3', paymentMethod: 'cod-partial' });

  const order = require('../src/orders').byId((placed.headers.get('hx-redirect') || '').split('/').pop());
  assert.equal(order.paymentStatus, 'partially_paid');
  assert.equal(order.codPlan.advancePaid, 2500, '25% of ₹10,000');
  assert.equal(order.codPlan.dueOnDelivery, 7500);
  assert.equal(order.codPlan.advancePaid + order.codPlan.dueOnDelivery, order.total);
});

test('COD is not offered at a blocked pincode, and the reason is shown', async () => {
  jar.clear();
  await post('/cart/add', { id: 'p001', size: 'M', color: 'Red', qty: '1' });
  await post('/checkout/step/2', { ...ADDRESS, pincode: '110001', city: 'New Delhi', state: 'Delhi' });
  const step3 = await post('/checkout/step/3', { _from: '2', deliveryMethod: 'standard' });

  // Assert on the radio values, not on prose — the wording is free to change.
  const offered = [...step3.text.matchAll(/name="paymentMethod" value="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(offered.length, 'some payment method must be offered');
  assert.ok(!offered.some((id) => id.startsWith('cod')), 'COD offered at a blocked pincode: ' + offered);
  assert.match(step3.text, /Cash on delivery/i, 'the customer should be told why it is missing');
});

test('pincode lookup fills city and state without the customer typing them', async () => {
  // Seeded into the local cache so the test never touches India Post's API —
  // a test that depends on someone else's uptime fails for the wrong reason.
  require('./helpers/sandbox').seed('pincodes', {
    400050: { city: 'Mumbai', state: 'Maharashtra', areas: ['Bandra West', 'Khar'], source: 'india-post' }
  });
  jar.clear();
  await post('/cart/add', { id: 'p001', size: 'M', color: 'Red', qty: '1' });
  const res = await post('/checkout/pincode', { pincode: '400050' });

  assert.match(res.text, /hx-swap-oob/, 'the fields must be swapped in place');
  assert.match(res.text, /id="state-field"[^>]*value="Maharashtra"/, 'state must be filled');
  assert.match(res.text, /id="city-field"[^>]*value="Mumbai"/, 'city must be filled');
  assert.match(res.text, /Bandra West/, 'localities let the customer skip typing a landmark');
});

test('a nonsense pincode is rejected without filling anything', async () => {
  jar.clear();
  const res = await post('/checkout/pincode', { pincode: '12' });
  assert.match(res.text, /6-digit/i);
  assert.doesNotMatch(res.text, /hx-swap-oob/, 'nothing may be auto-filled from a bad pincode');
});

test('a coupon reaches the total and the order id records it', async () => {
  jar.clear();
  require('./helpers/sandbox').seed('discounts', [
    { code: 'TEST1K', type: 'flat', value: 1000, minOrder: 0, expiresAt: null, usageLimit: 0, used: 0, active: true, note: '' }
  ]);
  await post('/cart/add', { id: 'p001', size: 'M', color: 'Red', qty: '1' });
  const applied = await post('/cart/coupon', { code: 'TEST1K' });
  assert.ok(applied.status < 400);

  const page = await get('/checkout');
  assert.equal(rupees(page.text, 'Total payable'), 9000, 'the coupon must come off the total');

  await post('/checkout/step/2', ADDRESS);
  await post('/checkout/step/3', { _from: '2', deliveryMethod: 'standard' });
  const placed = await post('/checkout/place-order', { _from: '3', paymentMethod: 'upi' });
  const id = (placed.headers.get('hx-redirect') || '').split('/').pop();

  assert.match(id, /^ORD-C-/, 'a coupon order gets its own id series');
  const order = require('../src/orders').byId(id);
  assert.equal(order.discount, 1000);
  assert.equal(order.total, 9000);
});

test('placing an order empties the cart, so a refresh cannot re-order', async () => {
  jar.clear();
  await post('/cart/add', { id: 'p001', size: 'M', color: 'Red', qty: '1' });
  await post('/checkout/step/2', ADDRESS);
  await post('/checkout/step/3', { _from: '2', deliveryMethod: 'standard' });
  await post('/checkout/place-order', { _from: '3', paymentMethod: 'upi' });

  const again = await get('/checkout');
  assert.equal(again.status, 302, 'the cart must be empty after checkout');
});

test('a sold-out product cannot be added, even by posting straight to the route', async () => {
  // Hiding the buy button is not a control: this posts as a script would.
  jar.clear();
  await post('/cart/add', { id: 'p003', size: 'M', color: 'Mint', qty: '1' });   // stock 0
  const cartPage = await get('/cart');
  assert.match(cartPage.text, /bag is empty/i, 'a zero-stock product must not enter the cart');
});

test('a cart line is capped at the stock that exists', async () => {
  jar.clear();
  // p002 has 4 in stock; asking for 9 must not sell 9.
  await post('/cart/add', { id: 'p002', size: 'Free', color: 'Ivory', qty: '9' });
  await post('/checkout/step/2', ADDRESS);
  await post('/checkout/step/3', { _from: '2', deliveryMethod: 'standard' });
  const placed = await post('/checkout/place-order', { _from: '3', paymentMethod: 'upi' });

  const order = require('../src/orders').byId((placed.headers.get('hx-redirect') || '').split('/').pop());
  assert.ok(order, 'the order should still go through, just for what exists');
  assert.equal(order.items[0].qty, 4, 'quantity must be capped at available stock');
});

test('an order is refused if stock ran out while the cart sat open', async () => {
  jar.clear();
  const productsWrite = require('../src/products');
  await post('/cart/add', { id: 'p001', size: 'M', color: 'Red', qty: '2' });
  await post('/checkout/step/2', ADDRESS);
  await post('/checkout/step/3', { _from: '2', deliveryMethod: 'standard' });

  // Someone else buys the stock in the meantime.
  const before = require('../src/catalog').byId('p001').stock;
  productsWrite.setStock('p001', 1);

  const orders = require('../src/orders');
  const count = orders.all().length;
  const res = await post('/checkout/place-order', { _from: '3', paymentMethod: 'upi' });

  assert.equal(res.headers.get('hx-redirect'), null, 'the order must not be placed');
  assert.equal(orders.all().length, count, 'nothing may be written');
  assert.match(res.text, /Only 1 left/i, 'the customer must be told what changed');

  productsWrite.setStock('p001', before);
});

test('the customer invoice is not readable without proving who you are', async () => {
  jar.clear();
  await post('/cart/add', { id: 'p001', size: 'M', color: 'Red', qty: '1' });
  await post('/checkout/step/2', ADDRESS);
  await post('/checkout/step/3', { _from: '2', deliveryMethod: 'standard' });
  const placed = await post('/checkout/place-order', { _from: '3', paymentMethod: 'upi' });
  const id = (placed.headers.get('hx-redirect') || '').split('/').pop();

  // Same session placed it → allowed.
  const own = await get(`/order/${id}/invoice`);
  assert.equal(own.status, 200);
  assert.match(own.text, /Tax invoice/i);

  // A stranger with only the order number → bounced to the lookup.
  jar.clear();
  const stranger = await get(`/order/${id}/invoice`);
  assert.equal(stranger.status, 302);
  assert.match(stranger.headers.get('location') || '', /\/returns/);

  // With the right contact → allowed.
  const proved = await get(`/order/${id}/invoice?contact=buyer%40test.example`);
  assert.equal(proved.status, 200);
});

test('the admin is closed to anyone not signed in', async () => {
  jar.clear();
  for (const path of ['/admin', '/admin/orders', '/admin/settings', '/admin/reports']) {
    const res = await get(path);
    assert.equal(res.status, 302, `${path} must not be open`);
    assert.match(res.headers.get('location') || '', /\/admin\/(login|setup)/);
  }
});
