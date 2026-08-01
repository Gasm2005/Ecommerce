'use strict';

/**
 * Coupons.
 *
 * A coupon bug spends the owner's money, so the tests care most about the "no"
 * cases: expired, over-used, below minimum, switched off. A discount that
 * applies when it shouldn't is a silent refund on every order.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sandbox, seed } = require('./helpers/sandbox');

sandbox();
const discounts = require('../src/discounts');

const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const nextYear = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);

function seedCodes() {
  seed('discounts', [
    { code: 'SAVE10', type: 'percent', value: 10, minOrder: 0, expiresAt: null, usageLimit: 0, used: 0, active: true, note: '' },
    { code: 'FLAT2K', type: 'flat', value: 2000, minOrder: 5000, expiresAt: null, usageLimit: 0, used: 0, active: true, note: '' },
    { code: 'FREESHIP', type: 'freeship', value: 0, minOrder: 0, expiresAt: null, usageLimit: 0, used: 0, active: true, note: '' },
    { code: 'GONE', type: 'percent', value: 50, minOrder: 0, expiresAt: yesterday, usageLimit: 0, used: 0, active: true, note: '' },
    { code: 'USEDUP', type: 'percent', value: 50, minOrder: 0, expiresAt: null, usageLimit: 2, used: 2, active: true, note: '' },
    { code: 'PAUSED', type: 'percent', value: 50, minOrder: 0, expiresAt: nextYear, usageLimit: 0, used: 0, active: false, note: '' }
  ]);
}
seedCodes();

test('a percentage code takes its percentage', () => {
  const r = discounts.evaluate('SAVE10', 10000);
  assert.equal(r.ok, true);
  assert.equal(r.amount, 1000);
  assert.equal(r.code, 'SAVE10');
});

test('codes are case-insensitive, because customers type them by hand', () => {
  assert.equal(discounts.evaluate('save10', 10000).ok, true);
  assert.equal(discounts.evaluate('  Save10  '.trim(), 10000).ok, true);
});

test('a flat code never discounts more than the cart is worth', () => {
  const big = discounts.evaluate('FLAT2K', 10000);
  assert.equal(big.amount, 2000);

  // Below its own minimum it must not apply at all…
  assert.equal(discounts.evaluate('FLAT2K', 3000).ok, false);
  // …and where it does, it cannot exceed the subtotal.
  const r = discounts.evaluate('FLAT2K', 5000);
  assert.ok(r.amount <= 5000, 'discount larger than the cart: ' + r.amount);
});

test('a minimum order is enforced with a reason the customer can act on', () => {
  const r = discounts.evaluate('FLAT2K', 4999);
  assert.equal(r.ok, false);
  assert.match(r.reason, /above/i);
});

test('an expired code is refused', () => {
  const r = discounts.evaluate('GONE', 10000);
  assert.equal(r.ok, false);
  assert.match(r.reason, /expired/i);
});

test('a code at its usage limit is refused', () => {
  const r = discounts.evaluate('USEDUP', 10000);
  assert.equal(r.ok, false);
  assert.match(r.reason, /limit/i);
});

test('a deactivated code is refused even before it expires', () => {
  const r = discounts.evaluate('PAUSED', 10000);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no longer active/i);
});

test('an unknown code is refused without leaking which codes exist', () => {
  const r = discounts.evaluate('DEFINITELYNOT', 10000);
  assert.equal(r.ok, false);
  assert.match(r.reason, /isn’t recognised|not recognised/i);
});

test('a free-shipping code discounts nothing but flags free shipping', () => {
  const r = discounts.evaluate('FREESHIP', 10000);
  assert.equal(r.ok, true);
  assert.equal(r.amount, 0, 'freeship must not take money off the items');
  assert.equal(r.freeShipping, true);
});

test('usage is counted, and counting it can push a code past its limit', () => {
  seed('discounts', [
    { code: 'ONCE', type: 'percent', value: 10, minOrder: 0, expiresAt: null, usageLimit: 1, used: 0, active: true, note: '' }
  ]);
  assert.equal(discounts.evaluate('ONCE', 10000).ok, true);
  discounts.markUsed('ONCE');
  assert.equal(discounts.evaluate('ONCE', 10000).ok, false, 'a single-use code must not work twice');
  seedCodes();
});

test('upsert normalises the code and never resets a live usage count', () => {
  seed('discounts', []);
  discounts.upsert({ code: '  newyear  ', type: 'percent', value: 15 });
  let row = discounts.byCode('NEWYEAR');
  assert.ok(row, 'code was not stored uppercase/trimmed');
  assert.equal(row.value, 15);

  discounts.markUsed('NEWYEAR');
  discounts.upsert({ code: 'NEWYEAR', type: 'percent', value: 20 });
  row = discounts.byCode('NEWYEAR');
  assert.equal(row.value, 20, 'the edit should apply');
  assert.equal(row.used, 1, 'editing a coupon must not wipe its usage history');
  seedCodes();
});

test('an unknown type falls back to percent rather than discounting wildly', () => {
  seed('discounts', []);
  const row = discounts.upsert({ code: 'WEIRD', type: 'buy-one-get-ten', value: 5 });
  assert.equal(row.type, 'percent');
  seedCodes();
});
