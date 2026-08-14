'use strict';

/**
 * Plan enforcement over HTTP.
 *
 * The unit tests prove hasFeature() returns the right booleans. This one proves
 * the booleans are actually WIRED: that a client on Starter who types
 * /admin/reports gets refused by the server, not merely shown a hidden link.
 *
 * That distinction is the whole product. If the gate is only in the sidebar,
 * every ₹49k client has a ₹1.99L store one URL away.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sandbox } = require('./helpers/sandbox');

// Sold the cheapest tier: everything beyond the core shop must be shut.
const { config, configPath } = sandbox({ config: { plan: 'starter' } });

const fs = require('fs');
const auth = require('../src/auth');

let server;
let base;
const jar = new Map();

function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
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
  (res.headers.getSetCookie ? res.headers.getSetCookie() : []).forEach((line) => {
    const [pair] = line.split(';');
    const i = pair.indexOf('=');
    jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  });
  return { status: res.status, headers: res.headers, text: await res.text() };
}
const get = (p) => req('GET', p);
const post = (p, b) => req('POST', p, b);

/** Re-plan the live store: this is exactly what selling an upgrade does. */
function setPlan(id, extras) {
  const next = { ...JSON.parse(fs.readFileSync(configPath, 'utf8')), plan: id, planExtras: extras || [] };
  fs.writeFileSync(configPath, JSON.stringify(next, null, 2));
  require('../src/config').invalidate();
}

before(async () => {
  auth.createUser({ name: 'Owner', email: 'owner@test.example', password: 'OwnerPass4242', role: 'owner' });
  auth.createUser({ name: 'Staff', email: 'staff@test.example', password: 'StaffPass4242', role: 'staff' });

  server = require('../server').listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  await post('/admin/login', { email: 'owner@test.example', password: 'OwnerPass4242' });
});

after(() => { setPlan('starter'); if (server) server.close(); });

/* ------------------------------------------------------------- admin ---- */

test('an owner on Starter is refused the sections they did not buy', async () => {
  setPlan('starter');
  for (const path of ['/admin/reports', '/admin/discounts', '/admin/marketing', '/admin/journal', '/admin/import']) {
    const res = await get(path);
    assert.equal(res.status, 402, `${path} must be payment-gated, got ${res.status}`);
    assert.match(res.text, /not included in the starter plan/i, `${path} should explain why`);
  }
});

test('the sections they did buy still work', async () => {
  setPlan('starter');
  for (const path of ['/admin', '/admin/orders', '/admin/products', '/admin/settings']) {
    const res = await get(path);
    assert.equal(res.status, 200, `${path} broke on the cheapest plan`);
  }
});

test('the plan page is never locked — a client can always see what they have', async () => {
  setPlan('starter');
  const res = await get('/admin/plan');
  assert.equal(res.status, 200);
  assert.match(res.text, /Starter/);
  assert.match(res.text, /Not included/i);
});

test('selling an upgrade unlocks it immediately, with no code change', async () => {
  setPlan('starter');
  assert.equal((await get('/admin/reports')).status, 402);

  setPlan('growth');
  assert.equal((await get('/admin/reports')).status, 200, 'Growth includes reports');
  assert.equal((await get('/admin/discounts')).status, 200);
  assert.equal((await get('/admin/journal')).status, 402, 'journal is still a Scale feature');

  setPlan('scale');
  assert.equal((await get('/admin/journal')).status, 200, 'Scale withholds nothing');
});

test('a single paid extra unlocks exactly one thing', async () => {
  setPlan('starter', ['reports']);
  assert.equal((await get('/admin/reports')).status, 200, 'the extra was paid for');
  assert.equal((await get('/admin/marketing')).status, 402, 'and nothing rode in with it');
});

test('a POST to a locked section is refused too, not just the page', async () => {
  // The dangerous version of this bug: the page is gated, the form handler isn't.
  setPlan('starter');
  const res = await post('/admin/discounts', { code: 'SNEAK', type: 'percent', value: '50' });
  assert.equal(res.status, 402, 'a locked write must be refused');

  const discounts = require('../src/discounts');
  assert.ok(!discounts.byCode('SNEAK'), 'nothing may be written through a locked section');
});

test('role and plan produce different refusals, and role is checked first', async () => {
  // Staff must never be told which features their employer declined to buy.
  setPlan('starter');
  jar.clear();
  await post('/admin/login', { email: 'staff@test.example', password: 'StaffPass4242' });

  const res = await get('/admin/reports');
  assert.equal(res.status, 403, 'staff get a permissions refusal, not a pricing one');
  assert.doesNotMatch(res.text, /plan/i, 'the refusal must not mention plans to staff');

  jar.clear();
  await post('/admin/login', { email: 'owner@test.example', password: 'OwnerPass4242' });
});

/* -------------------------------------------------------- storefront ---- */

test('a locked storefront feature 404s — the customer sees no trace of it', async () => {
  setPlan('starter');
  jar.clear();
  for (const path of ['/journal', '/returns']) {
    const res = await get(path);
    assert.equal(res.status, 404, `${path} must not exist on Starter, got ${res.status}`);
    assert.doesNotMatch(res.text, /plan|upgrade/i, 'a customer must not see the shop owner’s billing');
  }
});

test('the same storefront pages open once the plan includes them', async () => {
  setPlan('scale');
  for (const path of ['/journal', '/returns', '/wishlist']) {
    assert.equal((await get(path)).status, 200, `${path} should work on Scale`);
  }
});

test('a locked storefront POST is refused, not just the page', async () => {
  setPlan('starter');
  const res = await post('/returns/lookup', { orderId: 'ORD-00001', contact: 'x@y.z' });
  assert.equal(res.status, 404, 'the write path must be gated with the page');
});

test('Starter keeps the wishlist it paid for', async () => {
  setPlan('starter');
  assert.equal((await get('/wishlist')).status, 200);
});

test('the shop itself never breaks on the cheapest plan', async () => {
  setPlan('starter');
  for (const path of ['/', '/category/all', '/product/test-lehenga', '/cart', '/checkout']) {
    const res = await get(path);
    assert.ok([200, 302].includes(res.status), `${path} broke on Starter: ${res.status}`);
  }
});

test('COD disappears from checkout when the plan excludes it', async () => {
  // Not by hiding the radio: the rules engine must treat it as switched off.
  setPlan('starter');   // prepaid-only tier
  jar.clear();
  await post('/cart/add', { id: 'p001', size: 'M', color: 'Red', qty: '1' });
  await post('/checkout/step/2', {
    _from: '1', fullName: 'T', phone: '9820000000', email: 'a@b.c',
    address1: 'x', pincode: '400001', city: 'Mumbai', state: 'Maharashtra'
  });
  const step3 = await post('/checkout/step/3', { _from: '2', deliveryMethod: 'standard' });

  const offered = [...step3.text.matchAll(/name="paymentMethod" value="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(offered.length, 'prepaid methods must still be offered');
  assert.ok(!offered.some((id) => id.startsWith('cod')), 'COD offered without the feature: ' + offered);
});

test('a forbidden COD order cannot be forced through by posting the method', async () => {
  setPlan('starter');
  const orders = require('../src/orders');
  const before = orders.all().length;
  const res = await post('/checkout/place-order', { _from: '3', paymentMethod: 'cod-partial' });

  assert.equal(res.headers.get('hx-redirect'), null, 'no order may be placed');
  assert.equal(orders.all().length, before);
});
