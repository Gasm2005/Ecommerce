'use strict';

/**
 * Delivery zones, and who carries the parcel.
 *
 * The claim being defended: a shop that delivers its own city itself must be able
 * to offer that, and an order it delivers itself must never be handed to a
 * courier — not by a person, and not by an integration added later. The other half
 * is honesty: no same-day promise after the cut-off, and none on a piece that
 * takes three weeks to stitch.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sandbox, cartLine, summaryOf } = require('./helpers/sandbox');

const LUCKNOW_ZONE = {
  id: 'lucknow',
  label: 'Lucknow city',
  prefixes: ['226'],
  cities: ['Lucknow'],
  replacesDefaults: false,
  methods: [
    {
      id: 'local-sameday', title: 'Same-day delivery', note: 'By us today, 6pm-9pm',
      charge: 0, fulfilment: 'own', cutoff: '14:00', maxMakeDays: 0,
      slots: ['6pm - 7:30pm', '7:30pm - 9pm']
    },
    { id: 'local-nextday', title: 'Next-day delivery', note: 'By us tomorrow', charge: 0, fulfilment: 'own', maxMakeDays: 0 },
    { id: 'store-pickup', title: 'Collect from the store', note: 'Ready in 2 hours', charge: 0, fulfilment: 'pickup', maxMakeDays: 0 }
  ]
};

const base = sandbox();
const config = {
  ...base.config,
  shipping: { ...base.config.shipping, zones: [LUCKNOW_ZONE] }
};

const delivery = require('../src/delivery');
const cart = require('../src/cart');
const orders = require('../src/orders');

const at = (hour) => { const d = new Date(); d.setHours(hour, 0, 0, 0); return d; };
const ids = (list) => list.map((m) => m.id);
const ready = { ...base.products[0], deliveryDays: 0 };
const madeToOrder = { ...base.products[0], deliveryDays: 21 };

/* -------------------------------------------------------------- matching ---- */

test('a zone matches by prefix, exact pincode and city name', () => {
  assert.ok(delivery.zoneFor(config, { pincode: '226001' }), 'prefix 226 should match');
  assert.ok(delivery.zoneFor(config, { pincode: '226999' }), 'anything in 226 should match');
  assert.ok(delivery.zoneFor(config, { city: 'Lucknow' }), 'city name should match');
  assert.ok(delivery.zoneFor(config, { city: '  lucknow  ' }), 'city match ignores case and spaces');
  assert.equal(delivery.zoneFor(config, { pincode: '400050' }), null, 'Mumbai is not in the zone');
  assert.equal(delivery.zoneFor(config, {}), null, 'nothing entered yet is not a zone');
});

test('a store with no zones configured still sells normally', () => {
  const plain = { ...config, shipping: { ...config.shipping, zones: [] } };
  const methods = delivery.methodsFor(plain, { pincode: '226001', makeDays: 0, now: at(10) });
  assert.deepEqual(ids(methods), ['standard', 'express']);
  assert.ok(methods.every((m) => m.fulfilment === 'courier'));
});

/* --------------------------------------------------------------- options ---- */

test('inside the zone the shop’s own options appear alongside the couriers', () => {
  const methods = delivery.methodsFor(config, { pincode: '226001', makeDays: 0, now: at(10) });
  assert.deepEqual(ids(methods), ['local-sameday', 'local-nextday', 'store-pickup', 'standard', 'express']);
  assert.equal(methods[0].fulfilment, 'own');
  assert.equal(methods[2].fulfilment, 'pickup');
  assert.equal(methods[3].fulfilment, 'courier');
  assert.equal(methods[0].zoneLabel, 'Lucknow city');
});

test('outside the zone, local options are not offered at all', () => {
  const methods = delivery.methodsFor(config, { pincode: '400050', makeDays: 0, now: at(10) });
  assert.deepEqual(ids(methods), ['standard', 'express']);
  assert.ok(methods.every((m) => m.fulfilment === 'courier'), 'a Mumbai buyer cannot be self-delivered');
});

test('replacesDefaults hides the couriers entirely when a client wants that', () => {
  const only = {
    ...config,
    shipping: { ...config.shipping, zones: [{ ...LUCKNOW_ZONE, replacesDefaults: true }] }
  };
  assert.deepEqual(ids(delivery.methodsFor(only, { pincode: '226001', makeDays: 0, now: at(10) })),
    ['local-sameday', 'local-nextday', 'store-pickup']);
});

/* -------------------------------------------------------------- cut-offs ---- */

test('same-day stops being offered after the cut-off', () => {
  const morning = ids(delivery.methodsFor(config, { pincode: '226001', makeDays: 0, now: at(10) }));
  const evening = ids(delivery.methodsFor(config, { pincode: '226001', makeDays: 0, now: at(17) }));

  assert.ok(morning.includes('local-sameday'), 'available at 10am');
  assert.ok(!evening.includes('local-sameday'), 'promising same-day at 5pm is a broken promise');
  assert.ok(evening.includes('local-nextday'), 'next-day survives the cut-off');
});

test('the cut-off is shown to the customer while it still applies', () => {
  const sameday = delivery.methodsFor(config, { pincode: '226001', makeDays: 0, now: at(10) })[0];
  assert.match(sameday.cutoffNote, /before 14:00/i);

  // Inside the last hour it counts down, because "before 2pm" at 1:45 is useless.
  const late = new Date(); late.setHours(13, 20, 0, 0);
  const soon = delivery.methodsFor(config, { pincode: '226001', makeDays: 0, now: late })[0];
  assert.match(soon.cutoffNote, /within 40 min/i);
});

test('a method limited to certain days is not offered on the others', () => {
  const sundayOnly = {
    ...config,
    shipping: {
      ...config.shipping,
      zones: [{
        ...LUCKNOW_ZONE,
        methods: [{ id: 'sun', title: 'Sunday only', charge: 0, fulfilment: 'own', cutoff: '18:00', days: ['sun'] }]
      }]
    }
  };
  // A Monday at noon.
  const monday = new Date('2026-08-03T12:00:00');
  assert.equal(ids(delivery.methodsFor(sundayOnly, { pincode: '226001', now: monday })).includes('sun'), false);

  const sunday = new Date('2026-08-02T12:00:00');
  assert.equal(ids(delivery.methodsFor(sundayOnly, { pincode: '226001', now: sunday })).includes('sun'), true);
});

/* ------------------------------------------------------------ make time ---- */

test('a made-to-order piece cannot be promised same-day, however local the buyer', () => {
  // The conflict this rule exists for: a 21-day lehenga and a same-day option.
  const methods = ids(delivery.methodsFor(config, { pincode: '226001', makeDays: 21, now: at(10) }));
  assert.ok(!methods.includes('local-sameday'), 'same-day on a 21-day piece is a lie');
  assert.ok(!methods.includes('local-nextday'), 'so is next-day');
  assert.ok(!methods.includes('store-pickup'), 'and it is not ready to collect either');
  assert.deepEqual(methods, ['standard', 'express']);
});

test('ready stock in the same zone still gets same-day', () => {
  const methods = ids(delivery.methodsFor(config, { pincode: '226001', makeDays: 0, now: at(10) }));
  assert.ok(methods.includes('local-sameday'));
});

test('a method with no make-time limit is never filtered by it', () => {
  const methods = ids(delivery.methodsFor(config, { pincode: '226001', makeDays: 99, now: at(10) }));
  assert.ok(methods.includes('standard'), 'a courier does not care how long it took to stitch');
});

test('a minimum order is respected', () => {
  const withMin = {
    ...config,
    shipping: {
      ...config.shipping,
      zones: [{ ...LUCKNOW_ZONE, methods: [{ id: 'free-local', title: 'Free local', charge: 0, fulfilment: 'own', minOrder: 5000 }] }]
    }
  };
  assert.equal(ids(delivery.methodsFor(withMin, { pincode: '226001', subtotal: 1000 })).includes('free-local'), false);
  assert.equal(ids(delivery.methodsFor(withMin, { pincode: '226001', subtotal: 9000 })).includes('free-local'), true);
});

/* ------------------------------------------------------- into the cart ---- */

test('the basket moves at the speed of its slowest piece', () => {
  const mixed = summaryOf([cartLine(ready), cartLine(madeToOrder, 1, 'S', 'Gold')]);
  const s = cart.withCheckoutExtras(mixed, { pincode: '226001', city: 'Lucknow' }, config);
  assert.notEqual(s.deliveryMethod, 'local-sameday',
    'one made-to-order piece means the whole order cannot go out today');
});

test('choosing a local option costs nothing and marks the order as ours', () => {
  /* Deliberately next-day, not same-day: same-day depends on the wall clock, and a
     test that passes before 2pm and fails after it is worse than no test. Cut-off
     behaviour is asserted above, where `now` can be injected. */
  const s = cart.withCheckoutExtras(
    summaryOf([cartLine(ready)]),
    { pincode: '226001', city: 'Lucknow', deliveryMethod: 'local-nextday' },
    config
  );
  assert.equal(s.deliveryMethod, 'local-nextday');
  assert.equal(s.shipping, 0);
  assert.equal(s.fulfilment, 'own');
  assert.equal(s.deliveryZoneLabel, 'Lucknow city');
  assert.equal(s.total, s.subtotal, 'a free local delivery adds nothing to the total');
});

test('a Mumbai buyer cannot pick a Lucknow option by posting its id', () => {
  // The UI would not show it; the server must not accept it either.
  const s = cart.withCheckoutExtras(
    summaryOf([cartLine(ready)]),
    { pincode: '400050', city: 'Mumbai', deliveryMethod: 'local-sameday' },
    config
  );
  assert.notEqual(s.deliveryMethod, 'local-sameday');
  assert.equal(s.fulfilment, 'courier');
});

/* --------------------------------------------------------- onto the order ---- */

function place(state) {
  const summary = cart.withCheckoutExtras(summaryOf([cartLine(ready)]), state, config);
  return orders.create({
    cartSummary: summary,
    state: {
      fullName: 'Local Buyer', phone: '9820000000', email: 'l@test.example',
      address1: '12 Hazratganj', city: 'Lucknow', state: 'Uttar Pradesh', pincode: '226001',
      ...state
    },
    config, attribution: null, codPlan: null, payment: null
  });
}

test('an order the shop delivers itself is marked so, permanently', () => {
  // next-day rather than same-day, for the wall-clock reason noted above.
  const order = place({ pincode: '226001', city: 'Lucknow', deliveryMethod: 'local-nextday', deliverySlot: '6pm - 7:30pm' });

  assert.equal(order.fulfilment, 'own');
  assert.equal(order.deliveryZone, 'lucknow');
  assert.equal(order.deliveryZoneLabel, 'Lucknow city');
  assert.equal(order.deliverySlot, '6pm - 7:30pm');
  assert.equal(order.shipping, 0);
  assert.equal(delivery.isSelfDelivered(order), true,
    'a courier integration must be able to recognise and skip this');
});

test('a store pickup is not a delivery at all', () => {
  const order = place({ pincode: '226001', city: 'Lucknow', deliveryMethod: 'store-pickup' });
  assert.equal(order.fulfilment, 'pickup');
  assert.equal(delivery.isSelfDelivered(order), true, 'nothing to dispatch');
});

test('a courier order is marked courier, and older orders count as courier', () => {
  const order = place({ pincode: '400050', city: 'Mumbai', deliveryMethod: 'standard' });
  assert.equal(order.fulfilment, 'courier');
  assert.equal(delivery.isSelfDelivered(order), false);
  // Orders written before this feature existed have no flag at all.
  assert.equal(delivery.isSelfDelivered({ id: 'ORD-OLD' }), false);
});

test('the admin can list exactly what the shop is delivering itself', () => {
  place({ pincode: '226001', city: 'Lucknow', deliveryMethod: 'local-nextday' });
  place({ pincode: '226001', city: 'Lucknow', deliveryMethod: 'store-pickup' });
  place({ pincode: '400050', city: 'Mumbai', deliveryMethod: 'standard' });

  const self = orders.query({ fulfilment: 'self', perPage: 100 }).items;
  assert.ok(self.length >= 2);
  assert.ok(self.every((o) => o.fulfilment === 'own' || o.fulfilment === 'pickup'));

  const courier = orders.query({ fulfilment: 'courier', perPage: 100 }).items;
  assert.ok(courier.every((o) => !o.fulfilment || o.fulfilment === 'courier'));
  assert.ok(!courier.some((o) => o.fulfilment === 'own'), 'a self-delivered order must never appear in the courier list');
});
