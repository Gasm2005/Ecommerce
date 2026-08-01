'use strict';

/**
 * Cash on delivery.
 *
 * COD is where the owner's RTO risk lives, so every switch has to mean exactly
 * what it says. The dangerous failure isn't an error message — it's COD quietly
 * being ALLOWED where the owner switched it off, or a plan that collects less
 * than the order is worth.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sandbox } = require('./helpers/sandbox');

const { config } = sandbox();
const cod = require('../src/cod');

/** config with a patched cod block. */
const withCod = (patch) => ({
  ...config,
  shipping: { ...config.shipping, cod: { ...config.shipping.cod, ...patch } }
});

test('full COD is off by default — it carries all the RTO risk', () => {
  const check = cod.evaluate(config, { pincode: '400001', total: 10000 });
  assert.equal(check.fullAllowed, false);
  assert.equal(check.partialAllowed, true, 'partial is the safe default');
});

test('the advance is a percentage of the order, and the rest is due on delivery', () => {
  const check = cod.evaluate(config, { pincode: '400001', total: 10000 });
  assert.equal(check.advance, 2500, '25% of ₹10,000');
  assert.equal(check.dueOnDelivery, 7500);
  assert.equal(check.advance + check.dueOnDelivery, 10000, 'the two must reconstruct the order');
});

test('a flat advance is honoured instead of a percentage', () => {
  const flat = withCod({ advanceType: 'flat', advanceFlat: 2000 });
  const check = cod.evaluate(flat, { pincode: '400001', total: 10000 });
  assert.equal(check.advance, 2000);
  assert.equal(check.dueOnDelivery, 8000);
});

test('an advance can never exceed the order total', () => {
  const flat = withCod({ advanceType: 'flat', advanceFlat: 5000 });
  const check = cod.evaluate(flat, { pincode: '400001', total: 1000 });
  assert.ok(check.advance <= 1000, `advance ${check.advance} exceeds the ₹1,000 order`);
  assert.ok(check.dueOnDelivery >= 0, 'due on delivery went negative');
});

test('switching COD off blocks it everywhere, with a reason', () => {
  const off = withCod({ enabled: false });
  const check = cod.evaluate(off, { pincode: '400001', total: 10000 });
  assert.equal(check.fullAllowed, false);
  assert.equal(check.partialAllowed, false);
  assert.ok(check.reason, 'the customer must be told why');
});

test('min and max order bounds are enforced', () => {
  const bounded = withCod({ minOrder: 2000, maxOrder: 50000 });
  assert.equal(cod.evaluate(bounded, { pincode: '400001', total: 1000 }).partialAllowed, false);
  assert.equal(cod.evaluate(bounded, { pincode: '400001', total: 90000 }).partialAllowed, false);
  assert.equal(cod.evaluate(bounded, { pincode: '400001', total: 10000 }).partialAllowed, true);
});

/* ------------------------------------------------------- serviceability ---- */

test('a blocked pincode loses COD', () => {
  const blocked = cod.evaluate(config, { pincode: '110001', total: 10000 });
  assert.equal(blocked.partialAllowed, false);
  assert.ok(blocked.reason);

  const fine = cod.evaluate(config, { pincode: '400001', total: 10000 });
  assert.equal(fine.partialAllowed, true);
});

test('a blocked prefix blocks the whole range', () => {
  // prefix '19' in the fixture
  assert.equal(cod.evaluate(config, { pincode: '190001', total: 10000 }).partialAllowed, false);
  assert.equal(cod.evaluate(config, { pincode: '191234', total: 10000 }).partialAllowed, false);
  assert.equal(cod.evaluate(config, { pincode: '290001', total: 10000 }).partialAllowed, true);
});

test('allow-list mode refuses everything it does not list', () => {
  const only = withCod({ pincodeMode: 'allow-list', allowedPincodesOnly: ['400050', '5600'] });

  assert.equal(cod.evaluate(only, { pincode: '400050', total: 10000 }).partialAllowed, true, 'exact match');
  assert.equal(cod.evaluate(only, { pincode: '560001', total: 10000 }).partialAllowed, true, 'short entry acts as a prefix');
  assert.equal(cod.evaluate(only, { pincode: '400051', total: 10000 }).partialAllowed, false, 'not listed');
  assert.equal(cod.evaluate(only, { pincode: '110001', total: 10000 }).partialAllowed, false);
});

test('an empty allow-list refuses COD rather than allowing everything', () => {
  // Fail closed: an owner who switched to allow-list and typed nothing yet must
  // not accidentally open COD to all of India.
  const empty = withCod({ pincodeMode: 'allow-list', allowedPincodesOnly: [] });
  assert.equal(cod.evaluate(empty, { pincode: '400050', total: 10000 }).partialAllowed, false);
});

/* -------------------------------------------------------------- plans ---- */

test('a plan is refused for a method the rules do not allow', () => {
  // fullEnabled is false in the fixture, so 'cod' must not produce a plan.
  assert.equal(cod.planFor(config, { method: 'cod', pincode: '400001', total: 10000 }), null);
  assert.ok(cod.planFor(config, { method: 'cod-partial', pincode: '400001', total: 10000 }));
});

test('a partial plan collects the advance now and the rest at the door', () => {
  const plan = cod.planFor(config, { method: 'cod-partial', pincode: '400001', total: 10000 });
  assert.equal(plan.type, 'partial-cod');
  assert.equal(plan.advancePaid, 2500);
  assert.equal(plan.dueOnDelivery, 7500);
  assert.equal(plan.advancePaid + plan.dueOnDelivery, 10000);
});

test('a prepaid plan leaves nothing to collect', () => {
  const plan = cod.planFor(config, { method: 'upi', pincode: '400001', total: 10000 });
  assert.equal(plan.type, 'prepaid');
  assert.equal(plan.advancePaid, 10000);
  assert.equal(plan.dueOnDelivery, 0);
});

test('a COD plan is refused at a blocked pincode', () => {
  assert.equal(cod.planFor(config, { method: 'cod-partial', pincode: '110001', total: 10000 }), null);
});

test('outstanding cash ignores paid, cancelled and returned orders', () => {
  const rows = [
    { codPlan: { dueOnDelivery: 5000 }, paymentStatus: 'partially_paid', status: 'shipped' },
    { codPlan: { dueOnDelivery: 3000 }, paymentStatus: 'paid', status: 'delivered' },
    { codPlan: { dueOnDelivery: 4000 }, paymentStatus: 'pending', status: 'cancelled' },
    { codPlan: { dueOnDelivery: 2000 }, paymentStatus: 'pending', status: 'returned' },
    { codPlan: null, paymentStatus: 'paid', status: 'delivered' }
  ];
  assert.equal(cod.outstanding(rows), 5000);
  assert.equal(cod.outstanding([]), 0);
  assert.equal(cod.outstanding(null), 0);
});
