'use strict';

/**
 * GST tax invoices.
 *
 * Two things here are not style choices — they are law, and getting them wrong
 * is what a GST notice is about:
 *   · same state → CGST + SGST; different state → IGST. Never both, never neither.
 *   · the invoice total must equal what the customer actually paid.
 * Everything else defends the numbering series, which an auditor reads first.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sandbox, cartLine, summaryOf } = require('./helpers/sandbox');

const { config, products } = sandbox();
const cart = require('../src/cart');
const orders = require('../src/orders');
const invoice = require('../src/invoice');

const lehenga = products.find((p) => p.id === 'p001');   // ₹10,000 @ 5%
const saree = products.find((p) => p.id === 'p002');     // ₹5,000 @ 12%

/** Places a real order so the invoice is built from stored history, not a mock. */
function placeOrder({ state = {}, lines, extras = {} } = {}) {
  const base = summaryOf(lines || [cartLine(lehenga)], extras);
  const summary = cart.withCheckoutExtras(base, state, config);
  return orders.create({
    cartSummary: summary,
    state: {
      fullName: 'Test Buyer', phone: '9820000000', email: 'buyer@test.example',
      address1: '1 Test Road', city: 'Mumbai', state: 'Maharashtra',
      pincode: '400001', country: 'India',
      ...state
    },
    config,
    attribution: null,
    codPlan: null,
    payment: null
  });
}

const cents = (a, b, msg) => assert.ok(Math.abs(a - b) <= 1, `${msg} (${a} vs ${b})`);

test('intra-state supply splits into CGST and SGST, with no IGST', () => {
  const order = placeOrder({ state: { state: 'Maharashtra' } });   // seller is 27
  const inv = invoice.build(order, config, { allocate: false });

  assert.equal(inv.interState, false);
  assert.ok(inv.totals.cgst > 0);
  assert.equal(inv.totals.cgst, inv.totals.sgst, 'the split must be equal halves');
  assert.equal(inv.totals.igst, 0);
  cents(inv.totals.cgst + inv.totals.sgst, inv.totals.totalTax, 'halves must sum to the tax');
});

test('inter-state supply charges IGST only', () => {
  const order = placeOrder({ state: { state: 'Karnataka' } });
  const inv = invoice.build(order, config, { allocate: false });

  assert.equal(inv.interState, true);
  assert.ok(inv.totals.igst > 0);
  assert.equal(inv.totals.cgst, 0);
  assert.equal(inv.totals.sgst, 0);
  assert.equal(inv.totals.igst, inv.totals.totalTax);
});

test('the place of supply decides the split, not the tax amount', () => {
  const home = invoice.build(placeOrder({ state: { state: 'Maharashtra' } }), config, { allocate: false });
  const away = invoice.build(placeOrder({ state: { state: 'Karnataka' } }), config, { allocate: false });

  cents(home.totals.totalTax, away.totals.totalTax, 'total tax must not depend on the state');
  cents(away.totals.igst, home.totals.cgst + home.totals.sgst, 'IGST equals CGST+SGST');
});

test('no line ever carries both CGST and IGST', () => {
  [['Maharashtra'], ['Karnataka'], ['Delhi']].forEach(([st]) => {
    const inv = invoice.build(placeOrder({ state: { state: st } }), config, { allocate: false });
    inv.lines.forEach((l) => {
      assert.ok(!(l.cgst > 0 && l.igst > 0), `${st}: line "${l.name}" has both`);
    });
  });
});

test('an unknown buyer state is treated as intra-state, never as IGST', () => {
  // Guessing IGST on a typo would undercharge CGST/SGST and misfile the return.
  const inv = invoice.build(placeOrder({ state: { state: 'Atlantis' } }), config, { allocate: false });
  assert.equal(inv.interState, false);
});

/* ------------------------------------------------------------ totals ---- */

test('the invoice total equals what the customer paid', () => {
  const cases = [
    { name: 'plain', args: {} },
    { name: 'express', args: { state: { deliveryMethod: 'express' } } },
    { name: 'gift wrap', args: { state: { giftWrap: 'yes' } } },
    { name: 'express + wrap', args: { state: { deliveryMethod: 'express', giftWrap: 'yes' } } },
    { name: 'discounted', args: { extras: { discount: 2000, discountCode: 'SAVE2K' } } },
    { name: 'discount + express', args: { state: { deliveryMethod: 'express' }, extras: { discount: 2000, discountCode: 'SAVE2K' } } },
    { name: 'mixed rates', args: { lines: [cartLine(lehenga), cartLine(saree, 2, 'Free', 'Ivory')] } },
    { name: 'mixed + everything', args: { lines: [cartLine(lehenga), cartLine(saree, 2, 'Free', 'Ivory')], state: { deliveryMethod: 'express', giftWrap: 'yes' }, extras: { discount: 1000, discountCode: 'X' } } }
  ];

  cases.forEach(({ name, args }) => {
    const order = placeOrder(args);
    const inv = invoice.build(order, config, { allocate: false });
    cents(inv.totals.rounded, order.total, `${name}: invoice total vs order total`);
  });
});

test('the sum of line taxable values equals the invoice taxable value', () => {
  const order = placeOrder({
    lines: [cartLine(lehenga), cartLine(saree, 2, 'Free', 'Ivory')],
    state: { deliveryMethod: 'express' },
    extras: { discount: 1500, discountCode: 'X' }
  });
  const inv = invoice.build(order, config, { allocate: false });
  const lineSum = inv.lines.reduce((s, l) => s + l.taxableValue, 0);
  cents(lineSum, inv.totals.taxableValue, 'lines must reconcile to the header');
});

test('delivery and gift wrap appear as taxable lines with a SAC code', () => {
  const order = placeOrder({ state: { deliveryMethod: 'express', giftWrap: 'yes' } });
  const inv = invoice.build(order, config, { allocate: false });

  const delivery = inv.lines.find((l) => /delivery/i.test(l.name));
  const wrap = inv.lines.find((l) => /packaging/i.test(l.name));
  assert.ok(delivery, 'delivery must be itemised');
  assert.equal(delivery.hsn, '996819');
  assert.ok(wrap, 'gift wrap must be itemised');
  assert.equal(wrap.hsn, '998912');
  assert.ok(delivery.totalTax > 0, 'a composite supply charge carries tax');
});

test('charges are not double-counted once they are lines', () => {
  // The regression: adding order.shipping to a total that already contains the
  // shipping line silently overcharges by the shipping amount.
  const order = placeOrder({ state: { deliveryMethod: 'express' } });
  const inv = invoice.build(order, config, { allocate: false });
  cents(inv.totals.taxableValue + inv.totals.totalTax, order.total, 'taxable + tax = paid');
  assert.ok(inv.totals.rounded < order.total + 100, 'total inflated by a double-counted charge');
});

test('each rate gets its own row in the tax summary', () => {
  const order = placeOrder({ lines: [cartLine(lehenga), cartLine(saree, 1, 'Free', 'Ivory')] });
  const inv = invoice.build(order, config, { allocate: false });
  const rates = inv.byRate.map((r) => r.rate);
  assert.deepEqual(rates, [...rates].sort((a, b) => a - b), 'rows must be sorted by rate');
  assert.ok(rates.includes(5) && rates.includes(12), 'both rates present: ' + rates);
  cents(inv.byRate.reduce((s, r) => s + r.total, 0), inv.totals.totalTax, 'rows must sum to the tax');
});

test('every line has an HSN code, falling back to the business default', () => {
  const order = placeOrder({ lines: [cartLine(products.find((p) => p.id === 'p003'), 1, 'M', 'Mint')] });
  const inv = invoice.build(order, config, { allocate: false });
  inv.lines.forEach((l) => assert.ok(l.hsn, `line "${l.name}" has no HSN`));
  assert.equal(inv.lines[0].hsn, '6211', 'kurta has none of its own → business default');
});

/* ---------------------------------------------------------- numbering ---- */

test('an invoice number is issued once and never changes', () => {
  const order = placeOrder();
  const first = invoice.allocateNumber(order, config);
  const second = invoice.allocateNumber(orders.byId(order.id), config);
  assert.equal(first.number, second.number, 'viewing twice must not issue twice');
  assert.equal(orders.byId(order.id).invoice.number, first.number, 'it is stored on the order');
});

test('the series is sequential with no gaps', () => {
  const numbers = [placeOrder(), placeOrder(), placeOrder()]
    .map((o) => invoice.allocateNumber(o, config).sequence);
  const step = numbers.map((n, i) => (i ? n - numbers[i - 1] : 1));
  assert.deepEqual(step, [1, 1, 1], 'sequence jumped: ' + numbers.join(','));
});

test('the number carries the prefix and financial year', () => {
  const order = placeOrder();
  const { number } = invoice.allocateNumber(order, config);
  assert.match(number, /^TST\/\d{4}-\d{2}\/\d{4}$/, 'unexpected format: ' + number);
});

test('the financial year turns over on 1 April, not 1 January', () => {
  assert.equal(invoice.financialYearFor('2026-03-31'), '2025-26');
  assert.equal(invoice.financialYearFor('2026-04-01'), '2026-27');
  assert.equal(invoice.financialYearFor('2026-12-31'), '2026-27');
});

/* ------------------------------------------------------------- words ---- */

test('amounts in words use Indian grouping', () => {
  assert.equal(invoice.inWords(0, config), 'Zero Rupees Only');
  assert.equal(invoice.inWords(100, config), 'Rupees One Hundred Only');
  assert.equal(invoice.inWords(189000, config), 'Rupees One Lakh Eighty Nine Thousand Only');
  assert.equal(invoice.inWords(2500000, config), 'Rupees Twenty Five Lakh Only');
  assert.match(invoice.inWords(12345678, config), /^Rupees One Crore/);
});

/* --------------------------------------------------------- readiness ---- */

test('readiness names exactly what is missing', () => {
  assert.equal(invoice.readiness(config).ok, true);

  const bare = { ...config, business: { ...config.business, gstin: '', pan: '' } };
  const check = invoice.readiness(bare);
  assert.equal(check.ok, false);
  assert.deepEqual(check.missing.sort(), ['GSTIN', 'PAN']);
});

test('state codes resolve from names and informal spellings', () => {
  assert.equal(invoice.stateCode('Maharashtra'), '27');
  assert.equal(invoice.stateCode('  maharashtra  '), '27');
  assert.equal(invoice.stateCode('Karnataka'), '29');
  assert.equal(invoice.stateCode('Nowhere'), null);
});
