'use strict';

/**
 * GST and margin arithmetic.
 *
 * The rule these tests defend: prices are GST-INCLUSIVE. Tax is extracted from
 * the price, never added to it. If someone ever "fixes" that by adding tax on
 * top, every total in the shop silently jumps and these tests go red.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sandbox } = require('./helpers/sandbox');

const { config, products } = sandbox();
const pricing = require('../src/pricing');

const lehenga = products.find((p) => p.id === 'p001');   // 5% own rate
const saree = products.find((p) => p.id === 'p002');     // 12% own rate
const kurta = products.find((p) => p.id === 'p003');     // no rate → falls back

test('tax is extracted from an inclusive price, not added to it', () => {
  // ₹10,000 inclusive of 5% → tax = 10000 × 5/105 = 476.19 → 476
  assert.equal(pricing.taxOf(10000, 5), 476);
  // The taxable value plus the tax must give the price back.
  assert.equal(10000 - pricing.taxOf(10000, 5), 9524);
});

test('a zero rate means zero tax, never a division surprise', () => {
  assert.equal(pricing.taxOf(10000, 0), 0);
  assert.equal(pricing.taxOf(10000, null), 0);
  assert.equal(pricing.taxOf(0, 12), 0);
});

test('GST rate resolves product → category → store default', () => {
  assert.equal(pricing.gstPercent(lehenga, config), 5, 'product rate wins');
  assert.equal(pricing.gstPercent(saree, config), 12, 'product rate wins over category');

  // Kurta has no rate of its own and no category default → store default.
  assert.equal(pricing.gstPercent(kurta, config), 12);

  // A saree with no own rate must pick up the category default.
  const plainSaree = { ...saree, gstPercent: undefined, categories: ['sarees'] };
  assert.equal(pricing.gstPercent(plainSaree, config), 12);
});

test('a product rate of 0 is honoured, not treated as missing', () => {
  const exempt = { ...lehenga, gstPercent: 0 };
  assert.equal(pricing.gstPercent(exempt, config), 0);
  assert.equal(pricing.taxOf(exempt.price, pricing.gstPercent(exempt, config)), 0);
});

test('unit cost falls back to a percentage of price when none is set', () => {
  assert.equal(pricing.unitCost(lehenga, config), 4000, 'explicit cost wins');

  const noCost = { ...lehenga, cost: undefined, categories: ['bridal'] };
  // defaultCogsPercent 40 of ₹10,000
  assert.equal(pricing.unitCost(noCost, config), 4000);
});

test("the owner's example holds: cost 100 sold at 500 and at 1000", () => {
  // The case the numbers were first checked against by hand.
  const at500 = pricing.productMargin({ price: 500, cost: 100, gstPercent: 5 }, config);
  assert.equal(at500.cost, 100);
  assert.equal(at500.tax, pricing.taxOf(500, 5));
  assert.equal(at500.grossProfit, 500 - at500.tax - 100);
  assert.equal(at500.markupMultiple, 5);

  const at1000 = pricing.productMargin({ price: 1000, cost: 100, gstPercent: 5 }, config);
  assert.ok(at1000.grossProfit > at500.grossProfit, 'a higher price must yield more profit');
  assert.ok(at1000.marginPercent > at500.marginPercent);
  assert.equal(at1000.markupMultiple, 10);
});

test('a product with no cost falls back to the percentage, never NaN', () => {
  // cost 0 is treated as "not set", so defaultCogsPercent (40%) applies.
  const m = pricing.productMargin({ price: 1000, cost: 0, categories: [] }, config);
  assert.equal(m.cost, 400);
  assert.ok(Number.isFinite(m.grossProfit));
  assert.ok(Number.isFinite(m.marginPercent));
  assert.equal(m.markupMultiple, 2.5);
});

test('a zero-price product cannot produce NaN or Infinity', () => {
  const m = pricing.productMargin({ price: 0, categories: [] }, config);
  assert.equal(m.marginPercent, 0);
  assert.equal(m.markupMultiple, null);
  assert.ok(Number.isFinite(m.grossProfit));
});

test('line snapshot freezes price, cost and rate at the moment of sale', () => {
  const snap = pricing.lineSnapshot(lehenga, 3, config);
  assert.equal(snap.price, 10000);
  assert.equal(snap.cost, 4000);
  assert.equal(snap.gstPercent, 5);
  // Tax is for the whole line, not one unit.
  assert.equal(snap.taxAmount, pricing.taxOf(30000, 5));
});

test('gross profit is exactly price − tax − cost, with nothing sneaking in', () => {
  const m = pricing.productMargin(lehenga, config);
  assert.equal(m.netPrice, lehenga.price - m.tax);
  assert.equal(m.grossProfit, lehenga.price - m.tax - m.cost);
  assert.ok(m.grossProfit < lehenga.price, 'profit cannot equal revenue');
});

test('order tax and COGS use the stored snapshot, not live catalogue prices', () => {
  const order = {
    gstAmount: 0, cogs: 0,
    items: [{ productId: 'p001', price: 10000, qty: 2, gstPercent: 5, cost: 4000 }]
  };
  assert.equal(pricing.orderTax(order, config), pricing.taxOf(20000, 5));
  assert.equal(pricing.orderCogs(order, config), 8000);

  // A stored total wins outright — history must not be recomputed.
  assert.equal(pricing.orderTax({ ...order, gstAmount: 999 }, config), 999);
  assert.equal(pricing.orderCogs({ ...order, cogs: 777 }, config), 777);
});
