'use strict';

/**
 * Buyer GSTIN — validation, and what it changes downstream.
 *
 * A wrong GSTIN is worse than a missing one: it reaches the invoice and GSTR-1,
 * the buyer's input credit never appears, and someone spends a week chasing it.
 * So it is checked with its real check digit, at the field, before it can do that.
 *
 * Downstream, a GSTIN turns a sale from B2C into B2B, which changes which table
 * of the return it lands in and what the invoice must print.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sandbox, cartLine, summaryOf } = require('./helpers/sandbox');

const { config, products } = sandbox();
const gstin = require('../src/gstin');
const cart = require('../src/cart');
const orders = require('../src/orders');
const invoice = require('../src/invoice');
const gstReturn = require('../src/gst-return');
const auth = require('../src/auth');

const lehenga = products.find((p) => p.id === 'p001');

/** Builds a genuinely valid GSTIN by computing its own check digit. */
function validGstin(first14 = '27AABCA1234A1Z') {
  return first14 + gstin.checksum(first14);
}

/* ------------------------------------------------------------ validation ---- */

test('a blank GSTIN is valid — the field is optional', () => {
  ['', null, undefined, '   '].forEach((v) => {
    const out = gstin.check(v);
    assert.equal(out.ok, true, `"${v}" should be accepted as "not a business purchase"`);
    assert.equal(out.empty, true);
  });
});

test('a correct GSTIN passes and is broken into its parts', () => {
  const out = gstin.check(validGstin());
  assert.equal(out.ok, true);
  assert.equal(out.stateCode, '27');
  assert.equal(out.pan, 'AABCA1234A');
  assert.equal(out.state, 'maharashtra');
});

test('lowercase, spaces and hyphens are normalised, not rejected', () => {
  const good = validGstin();
  const messy = '  ' + good.slice(0, 5).toLowerCase() + ' ' + good.slice(5).toLowerCase() + ' ';
  const out = gstin.check(messy);
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.gstin, good);
});

test('a mistyped character fails the check digit', () => {
  // This is the common real error, and the reason a format regex is not enough.
  const good = validGstin();
  const wrong = good.slice(0, 14) + (good[14] === 'A' ? 'B' : 'A');
  const out = gstin.check(wrong);
  assert.equal(out.ok, false);
  assert.match(out.reason, /check digit/i);
});

test('an invalid state code is named in the error', () => {
  const out = gstin.check('99AABCA1234A1Z5');
  assert.equal(out.ok, false);
  assert.match(out.reason, /99/);
  assert.match(out.reason, /state code/i);
});

test('wrong length and malformed input are told apart', () => {
  assert.match(gstin.check('27AABCA1234A1Z').reason, /15 characters/);
  assert.match(gstin.check('abcdefghijklmno').reason, /does not look like/i);
  assert.match(gstin.check('271234512345123').reason, /does not look like/i);
});

test('the store’s own configured GSTIN is valid', () => {
  // A store printing an invalid GSTIN on its invoices is a real, quiet problem.
  assert.equal(gstin.isValid(config.business.gstin), true,
    `${config.business.gstin} fails validation`);
});

/* ------------------------------------------------------------ downstream ---- */

function place(state = {}) {
  const summary = cart.withCheckoutExtras(summaryOf([cartLine(lehenga)]), state, config);
  const order = orders.create({
    cartSummary: summary,
    state: {
      fullName: 'Purchase Manager', phone: '9820000000', email: 'b@test.example',
      address1: '1 Road', city: 'Mumbai', state: 'Maharashtra', pincode: '400001',
      ...state
    },
    config, attribution: null, codPlan: null, payment: null
  });
  invoice.allocateNumber(order, config);
  return orders.byId(order.id);
}

test('a GSTIN is stored on the order, normalised', () => {
  const order = place({ gstin: validGstin().toLowerCase(), businessName: 'Reseller Boutique LLP' });
  assert.equal(order.customer.gstin, validGstin());
  assert.equal(order.customer.businessName, 'Reseller Boutique LLP');
});

test('a retail order stores no GSTIN rather than an empty string', () => {
  const order = place();
  assert.equal(order.customer.gstin, null);
  assert.equal(order.customer.businessName, null);
});

test('a B2B order is reported in the B2B table, not B2CS', () => {
  const order = place({ gstin: validGstin(), businessName: 'Reseller Boutique LLP' });
  const papers = gstReturn.workingPapers(config);

  assert.ok(papers.tables.b2b.count > 0, 'the B2B table should no longer be empty');
  assert.match(papers.tables.b2b.csv, new RegExp(validGstin()));
  assert.match(papers.tables.b2b.csv, /Reseller Boutique LLP/);
  assert.match(papers.tables.b2b.csv, new RegExp(order.invoice.number.replace(/\//g, '\\/')));
});

test('a B2B invoice is not double-reported in the B2C tables', () => {
  const papers = gstReturn.workingPapers(config);
  assert.doesNotMatch(papers.tables.b2cs.csv, new RegExp(validGstin()));
  assert.doesNotMatch(papers.tables.b2cl.csv, /Reseller Boutique LLP/);
});

test('the covering note stops saying GSTIN is not collected once one exists', () => {
  const papers = gstReturn.workingPapers(config);
  assert.doesNotMatch(papers.readme, /does not collect buyer GSTIN/i);
  assert.match(papers.readme, /verify each GSTIN/i, 'it should now ask for verification instead');
});

test('the invoice prints the registered name and GSTIN, not just the buyer', () => {
  const order = place({ gstin: validGstin(), businessName: 'Reseller Boutique LLP' });
  const inv = invoice.build(order, config, { allocate: false });
  // The data the template needs must be on the order, in the right shape.
  assert.equal(inv.order.customer.gstin, validGstin());
  assert.equal(inv.order.customer.businessName, 'Reseller Boutique LLP');
  assert.equal(inv.order.customer.name, 'Purchase Manager', 'the contact person is kept too');
});

test('a B2B sale is taxed identically — a GSTIN changes reporting, not the rate', () => {
  const retail = place();
  const business = place({ gstin: validGstin(), businessName: 'Reseller Boutique LLP' });
  assert.equal(business.gstAmount, retail.gstAmount);
  assert.equal(business.total, retail.total);
});

/* ------------------------------------------------------------ over HTTP ---- */

let server;
let base;
const jar = new Map();

async function req(method, path, body) {
  const res = await fetch(base + path, {
    method,
    redirect: 'manual',
    headers: {
      cookie: [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
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

before(async () => {
  const app = require('../server');
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { if (server) server.close(); });

const ADDRESS = {
  _from: '1', fullName: 'Purchase Manager', phone: '9820000000', email: 'b@test.example',
  address1: '1 Road', pincode: '400001', city: 'Mumbai', state: 'Maharashtra', country: 'India'
};

test('checkout refuses a mistyped GSTIN and keeps the customer on step 1', async () => {
  jar.clear();
  await req('POST', '/cart/add', { id: 'p001', size: 'M', color: 'Red', qty: '1' });

  const bad = validGstin();
  const res = await req('POST', '/checkout/step/2', {
    ...ADDRESS, gstin: bad.slice(0, 14) + (bad[14] === 'A' ? 'B' : 'A'), businessName: 'X LLP'
  });
  assert.match(res.text, /Delivery address/i, 'a bad GSTIN must not advance the step');
  assert.match(res.text, /check digit/i, 'and it must say why');
});

test('checkout requires a business name alongside a GSTIN', async () => {
  jar.clear();
  await req('POST', '/cart/add', { id: 'p001', size: 'M', color: 'Red', qty: '1' });
  const res = await req('POST', '/checkout/step/2', { ...ADDRESS, gstin: validGstin(), businessName: '' });
  assert.match(res.text, /Registered business name is required/i);
});

test('a valid GSTIN passes checkout and reaches the placed order', async () => {
  jar.clear();
  await req('POST', '/cart/add', { id: 'p001', size: 'M', color: 'Red', qty: '1' });

  const step2 = await req('POST', '/checkout/step/2', {
    ...ADDRESS, gstin: validGstin(), businessName: 'Reseller Boutique LLP'
  });
  assert.match(step2.text, /Delivery method/i, 'a valid GSTIN should advance the step');

  await req('POST', '/checkout/step/3', { _from: '2', deliveryMethod: 'standard' });
  const placed = await req('POST', '/checkout/place-order', { _from: '3', paymentMethod: 'upi' });
  const id = (placed.headers.get('hx-redirect') || '').split('/').pop();

  const order = orders.byId(id);
  assert.ok(order, 'the order should have been placed');
  assert.equal(order.customer.gstin, validGstin());
  assert.equal(order.customer.businessName, 'Reseller Boutique LLP');
});

test('retail checkout is unaffected — no GSTIN, no extra field, no friction', async () => {
  jar.clear();
  await req('POST', '/cart/add', { id: 'p001', size: 'M', color: 'Red', qty: '1' });
  const step2 = await req('POST', '/checkout/step/2', ADDRESS);
  assert.match(step2.text, /Delivery method/i);

  await req('POST', '/checkout/step/3', { _from: '2', deliveryMethod: 'standard' });
  const placed = await req('POST', '/checkout/place-order', { _from: '3', paymentMethod: 'upi' });
  const order = orders.byId((placed.headers.get('hx-redirect') || '').split('/').pop());
  assert.equal(order.customer.gstin, null);
});
