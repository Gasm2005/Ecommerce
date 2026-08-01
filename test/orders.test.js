'use strict';

/**
 * Orders and refunds.
 *
 * An order is the permanent record the P&L, the GST return and any dispute are
 * all read from. So these tests care about two things: the money adds up, and a
 * later catalogue edit can never rewrite what was sold.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sandbox, cartLine, summaryOf } = require('./helpers/sandbox');

const { config, products } = sandbox();
const cart = require('../src/cart');
const orders = require('../src/orders');
const productsWrite = require('../src/products');
const catalog = require('../src/catalog');

const lehenga = products.find((p) => p.id === 'p001');   // ₹10,000 @ 5%, cost 4000
const saree = products.find((p) => p.id === 'p002');     // ₹5,000 @ 12%, cost 2000

function place({ state = {}, lines, extras = {}, codPlan = null } = {}) {
  const summary = cart.withCheckoutExtras(summaryOf(lines || [cartLine(lehenga)], extras), state, config);
  return orders.create({
    cartSummary: summary,
    state: {
      fullName: 'Test Buyer', phone: '9820000000', email: 'buyer@test.example',
      address1: '1 Test Road', city: 'Mumbai', state: 'Maharashtra', pincode: '400001',
      ...state
    },
    config, attribution: null, codPlan, payment: null
  });
}

test('an order total reconciles: items − discount + delivery + wrap', () => {
  const order = place({ state: { deliveryMethod: 'express', giftWrap: 'yes' }, extras: { discount: 1000, discountCode: 'X' } });
  assert.equal(order.total, order.subtotal - order.discount + order.shipping + order.giftWrapCharge);
});

test('per-line cost and GST rate are snapshotted at the moment of sale', () => {
  const order = place({ lines: [cartLine(lehenga, 2)] });
  const line = order.items[0];
  assert.equal(line.price, 10000);
  assert.equal(line.cost, 4000);
  assert.equal(line.gstPercent, 5);
  assert.equal(order.cogs, 8000, 'two units at ₹4,000');
});

test('editing a product later never rewrites a past order', () => {
  const order = place({ lines: [cartLine(lehenga)] });
  const before = JSON.parse(JSON.stringify(order.items[0]));

  productsWrite.update('p001', { price: 99999, cost: 1 });
  catalog.invalidate ? catalog.invalidate() : null;

  const stored = orders.byId(order.id).items[0];
  assert.deepEqual(stored, before, 'history changed after a catalogue edit');

  productsWrite.update('p001', { price: 10000, cost: 4000 });   // put it back
});

test('GST on the order includes the tax inside the delivery charge', () => {
  const plain = place();
  const express = place({ state: { deliveryMethod: 'express' } });
  assert.ok(express.gstAmount > plain.gstAmount, 'a taxable charge must raise the GST');
  assert.equal(express.chargeTax > 0, true);
  assert.equal(plain.chargeTax, 0);
});

test('mixed-rate orders sum the tax per line', () => {
  const order = place({ lines: [cartLine(lehenga), cartLine(saree, 1, 'Free', 'Ivory')] });
  const perLine = order.items.reduce((s, it) => s + it.taxAmount, 0);
  assert.equal(order.gstAmount, perLine, 'no averaging across rates');
});

test('a coupon order gets its own id series so returns can be traced', () => {
  const plain = place();
  const coupon = place({ extras: { discount: 500, discountCode: 'SAVE500' } });

  assert.match(plain.id, /^ORD-\d{5}$/);
  assert.match(coupon.id, /^ORD-C-\d{5}$/);
  assert.equal(orders.isCouponOrder(coupon), true);
  assert.equal(orders.isCouponOrder(plain), false);
});

test('placing an order decrements stock, and only for tracked products', () => {
  const before = catalog.byId('p002').stock;
  place({ lines: [cartLine(saree, 2, 'Free', 'Ivory')] });
  assert.equal(catalog.byId('p002').stock, before - 2);
});

test('payment status follows the COD plan, not the payment method name', () => {
  const prepaid = place({ codPlan: { type: 'prepaid', advancePaid: 10000, dueOnDelivery: 0 } });
  assert.equal(prepaid.paymentStatus, 'paid');
  assert.equal(prepaid.codPlan, null, 'a prepaid plan is not stored as a COD plan');

  const partial = place({ codPlan: { type: 'partial-cod', advancePaid: 2500, dueOnDelivery: 7500 } });
  assert.equal(partial.paymentStatus, 'partially_paid');
  assert.equal(partial.codPlan.dueOnDelivery, 7500);

  const full = place({ codPlan: { type: 'full-cod', advancePaid: 0, dueOnDelivery: 10000 } });
  assert.equal(full.paymentStatus, 'pending');
});

/* ------------------------------------------------------------- status ---- */

test('a status change is appended to the timeline, never overwritten', () => {
  const order = place();
  const steps = order.timeline.length;
  orders.setStatus(order.id, 'confirmed', 'looks good');
  const after = orders.byId(order.id);
  assert.equal(after.status, 'confirmed');
  assert.equal(after.timeline.length, steps + 1);
  assert.equal(after.timeline[0].label, 'Order placed', 'the original entry survives');
});

test('an unknown status is rejected rather than stored', () => {
  const order = place();
  assert.throws(() => orders.setStatus(order.id, 'teleported'), /Unknown status/);
  assert.equal(orders.byId(order.id).status, 'pending');
});

/* ------------------------------------------------------------ refunds ---- */

test('a partial refund is recorded without erasing the order value', () => {
  const order = place();
  orders.markRefunded(order.id, 3000, 'RET-00001');
  const after = orders.byId(order.id);

  assert.equal(after.refundedAmount, 3000);
  assert.equal(after.total, order.total, 'the order total is history, not a balance');
  assert.equal(after.paymentStatus, 'partially_refunded');
});

test('a full refund marks the order refunded, and refunds cannot exceed the total', () => {
  const order = place();
  orders.markRefunded(order.id, order.total, 'RET-00002');
  const after = orders.byId(order.id);
  assert.equal(after.paymentStatus, 'refunded');
  assert.ok(after.refundedAmount <= order.total, `refunded ${after.refundedAmount} exceeds total ${order.total}`);
});

test('two returns on one order add up instead of overwriting each other', () => {
  // The bug this caught: the second refund replaced the first, so the P&L
  // understated refunds and overstated profit on every multi-return order.
  const order = place();
  orders.markRefunded(order.id, 3000, 'RET-A');
  orders.markRefunded(order.id, 2000, 'RET-B');
  const after = orders.byId(order.id);

  assert.equal(after.refundedAmount, 5000, 'refunds must accumulate');
  assert.equal(after.paymentStatus, 'partially_refunded');
  assert.deepEqual(after.returnIds, ['RET-A', 'RET-B'], 'both returns must be traceable');
});

test('accumulated refunds stay capped at the order total', () => {
  const order = place();
  orders.markRefunded(order.id, 4000, 'RET-1');
  orders.markRefunded(order.id, 4000, 'RET-2');
  orders.markRefunded(order.id, 4000, 'RET-3');   // would be 12,000 of a 10,000 order
  const after = orders.byId(order.id);
  assert.equal(after.refundedAmount, order.total, 'capped at the order value');
  assert.equal(after.paymentStatus, 'refunded');
});

/* -------------------------------------------------------- verification ---- */

test('a purchase can only be verified with the matching contact', () => {
  const order = place({ state: { email: 'real@test.example', phone: '9820011122' } });
  orders.setStatus(order.id, 'delivered');

  const ok = orders.verifyPurchase({ orderId: order.id, contact: 'real@test.example', productId: 'p001' });
  assert.equal(ok.ok, true);

  const wrong = orders.verifyPurchase({ orderId: order.id, contact: 'someone@else.example', productId: 'p001' });
  assert.equal(wrong.ok, false);

  const noContact = orders.verifyPurchase({ orderId: order.id, contact: '', productId: 'p001' });
  assert.equal(noContact.ok, false);
});

test('a review cannot be verified for a product the order did not contain', () => {
  const order = place({ lines: [cartLine(lehenga)] });
  orders.setStatus(order.id, 'delivered');
  const r = orders.verifyPurchase({ orderId: order.id, contact: 'buyer@test.example', productId: 'p002' });
  assert.equal(r.ok, false);
});

test('an undelivered order cannot be reviewed yet', () => {
  const order = place();
  const r = orders.verifyPurchase({ orderId: order.id, contact: 'buyer@test.example', productId: 'p001' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /delivered/i);
});
