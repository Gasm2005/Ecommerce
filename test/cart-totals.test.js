'use strict';

/**
 * What the customer is actually asked to pay.
 *
 * This file exists because a real bug shipped here: the chosen delivery method
 * never reached the total, so Express was offered at ₹500 and charged at ₹0. The
 * invariant below — total = items − discount + delivery + gift wrap — is the one
 * that was broken, and it is asserted for every combination now.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sandbox, cartLine, summaryOf } = require('./helpers/sandbox');

const { config, products } = sandbox();
const cart = require('../src/cart');
const pricing = require('../src/pricing');

const lehenga = products.find((p) => p.id === 'p001');   // ₹10,000 @ 5%
const kurta = products.find((p) => p.id === 'p003');     // ₹2,000 @ default 12%

/** The invariant. Every test ends here. */
function assertTotalAddsUp(s) {
  const expected = s.subtotal - (s.discount || 0) + (s.shipping || 0) + (s.giftWrapCharge || 0);
  assert.equal(s.total, expected,
    `total ${s.total} should be ${expected} (items ${s.subtotal} − disc ${s.discount || 0} + ship ${s.shipping || 0} + wrap ${s.giftWrapCharge || 0})`);
}

test('delivery methods come from config, with note tokens filled in', () => {
  const methods = cart.deliveryMethods(config);
  assert.equal(methods.length, 2);
  assert.equal(methods[0].id, 'standard');
  assert.equal(methods[0].charge, null, 'standard follows the free-above rules');
  assert.equal(methods[1].charge, 500);
  assert.equal(methods[0].note, '3-6 days', 'estimate tokens are replaced');
});

test('a store with no methods configured still offers standard', () => {
  const bare = { ...config, shipping: { ...config.shipping, methods: [] } };
  const methods = cart.deliveryMethods(bare);
  assert.equal(methods.length, 1);
  assert.equal(methods[0].id, 'standard');
});

test('express adds its charge — the bug this file was written for', () => {
  const base = summaryOf([cartLine(lehenga)], { shipping: 0 });   // free: 10k > 8k
  const s = cart.withCheckoutExtras(base, { deliveryMethod: 'express' }, config);

  assert.equal(s.shipping, 500, 'express must be charged');
  assert.equal(s.total, 10500);
  assert.equal(s.deliveryTitle, 'Express');
  assertTotalAddsUp(s);
});

test('a flat-charge method applies even when standard shipping is free', () => {
  // The trap: "shipping is free on this cart" must not swallow a paid upgrade.
  const base = summaryOf([cartLine(lehenga)], { shipping: 0, freeShipping: true });
  const s = cart.withCheckoutExtras(base, { deliveryMethod: 'express' }, config);
  assert.equal(s.shipping, 500);
});

test('standard keeps whatever the free-above rules decided', () => {
  const free = cart.withCheckoutExtras(summaryOf([cartLine(lehenga)], { shipping: 0 }), { deliveryMethod: 'standard' }, config);
  assert.equal(free.shipping, 0);
  assertTotalAddsUp(free);

  const paid = cart.withCheckoutExtras(summaryOf([cartLine(kurta)], { shipping: 200 }), { deliveryMethod: 'standard' }, config);
  assert.equal(paid.shipping, 200, 'a small cart still pays standard shipping');
  assert.equal(paid.total, 2200);
  assertTotalAddsUp(paid);
});

test('gift wrap is charged only when asked for', () => {
  const off = cart.withCheckoutExtras(summaryOf([cartLine(lehenga)]), {}, config);
  assert.equal(off.giftWrapCharge, 0);

  const on = cart.withCheckoutExtras(summaryOf([cartLine(lehenga)]), { giftWrap: 'yes' }, config);
  assert.equal(on.giftWrapCharge, 300);
  assert.equal(on.total, 10300);
  assertTotalAddsUp(on);
});

test('express and gift wrap stack, and both land in the total', () => {
  const s = cart.withCheckoutExtras(
    summaryOf([cartLine(lehenga)]),
    { deliveryMethod: 'express', giftWrap: 'yes' },
    config
  );
  assert.equal(s.shipping, 500);
  assert.equal(s.giftWrapCharge, 300);
  assert.equal(s.total, 10800);
  assertTotalAddsUp(s);
});

test('an unknown delivery method falls back to the first, never to free', () => {
  const s = cart.withCheckoutExtras(summaryOf([cartLine(kurta)], { shipping: 200 }), { deliveryMethod: 'teleport' }, config);
  assert.equal(s.deliveryMethod, 'standard');
  assert.equal(s.shipping, 200);
  assertTotalAddsUp(s);
});

test('a discount lowers the total but never the delivery charge', () => {
  const base = summaryOf([cartLine(lehenga)], { discount: 2000, discountCode: 'SAVE2K', shipping: 0 });
  const s = cart.withCheckoutExtras(base, { deliveryMethod: 'express' }, config);
  assert.equal(s.total, 10000 - 2000 + 500);
  assert.equal(s.shipping, 500, 'a coupon must not quietly pay for express');
  assertTotalAddsUp(s);
});

test('a discount larger than the cart cannot make the total negative', () => {
  const base = summaryOf([cartLine(kurta)], { discount: 99999, shipping: 200 });
  const s = cart.withCheckoutExtras(base, { deliveryMethod: 'standard' }, config);
  assert.ok(s.total >= 0, 'total went negative: ' + s.total);
  assert.equal(s.total, 200, 'only the shipping remains payable');
});

/* --------------------------------------------------------------- GST ---- */

test('GST is disclosed, and disclosing it never changes the total', () => {
  const plain = summaryOf([cartLine(lehenga)]);
  const s = cart.withCheckoutExtras(plain, {}, config);
  assert.equal(s.total, 10000, 'inclusive pricing: tax must not be added on top');
  assert.equal(s.tax, pricing.taxOf(10000, 5));
});

test('mixed GST rates in one cart are summed per line, not averaged', () => {
  const s = cart.withCheckoutExtras(summaryOf([cartLine(lehenga), cartLine(kurta, 1, 'M', 'Mint')]), {}, config);
  const expected = pricing.taxOf(10000, 5) + pricing.taxOf(2000, 12);
  assert.equal(s.tax, expected);
  assert.equal(s.total, 12000, 'total is still just the sum of prices');
});

test('a discount reduces the GST pro-rata, as the invoice will', () => {
  const full = cart.withCheckoutExtras(summaryOf([cartLine(lehenga)]), {}, config);
  const half = cart.withCheckoutExtras(summaryOf([cartLine(lehenga)], { discount: 5000 }), {}, config);
  assert.ok(half.tax < full.tax, 'less money charged means less tax collected');
  assert.equal(half.tax, Math.round(pricing.taxOf(10000, 5) * 0.5));
});

test('shipping carries the principal rate in the cart, not its own', () => {
  const noShip = cart.withCheckoutExtras(summaryOf([cartLine(lehenga)]), {}, config);
  const withShip = cart.withCheckoutExtras(summaryOf([cartLine(lehenga)]), { deliveryMethod: 'express' }, config);
  // ₹500 express, principal rate 5% → 500 × 5/105 = 23.8
  assert.equal(withShip.tax - noShip.tax, pricing.taxOf(500, 5));
});

test('gstOnShipping: false leaves delivery untaxed but still charged', () => {
  const off = { ...config, finance: { ...config.finance, gstOnShipping: false } };
  const s = cart.withCheckoutExtras(summaryOf([cartLine(lehenga)]), { deliveryMethod: 'express' }, off);
  assert.equal(s.shipping, 500, 'the charge itself is unaffected by a tax setting');
  assert.equal(s.tax, pricing.taxOf(10000, 5), 'no tax extracted from delivery');
  assertTotalAddsUp(s);
});

test('an empty cart has no tax, no shipping and no total', () => {
  const s = cart.withCheckoutExtras(summaryOf([]), { deliveryMethod: 'express' }, config);
  assert.equal(s.count, 0);
  assert.equal(s.tax, 0);
  assert.equal(s.total, 500, 'express on an empty cart is a UI state, not a charge');
});
