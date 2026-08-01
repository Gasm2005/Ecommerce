'use strict';

/**
 * Plan gating.
 *
 * The business rule this defends: one codebase, many price points. A cheaper
 * tier must be a config line, never a fork — so the tests care that (a) a locked
 * feature is genuinely unreachable on the server, and (b) an unclassified
 * feature stays ON, so new work never silently vanishes from existing clients.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sandbox } = require('./helpers/sandbox');

const { config } = sandbox();
const plans = require('../src/plan');

const at = (id, extras) => ({ ...config, plan: id, planExtras: extras || [] });

test('every plan id in PLANS resolves, and an unknown one falls back safely', () => {
  plans.PLANS.forEach((p) => {
    assert.equal(plans.planOf({ plan: p.id }).id, p.id);
  });
  assert.equal(plans.planOf({ plan: 'enterprise-platinum' }).id, plans.DEFAULT_PLAN);
  assert.equal(plans.planOf({}).id, plans.DEFAULT_PLAN, 'no plan set = full platform');
  assert.equal(plans.planOf(null).id, plans.DEFAULT_PLAN);
});

test('starter gets the core shop and nothing else', () => {
  const c = at('starter');
  ['orders', 'products', 'invoices', 'wishlist'].forEach((f) => {
    assert.equal(plans.hasFeature(c, f), true, `starter must include ${f}`);
  });
  // Starter is prepaid-only: COD needs the pincode and advance engine.
  ['reports', 'discounts', 'reviews', 'marketing', 'journal', 'returns', 'cod'].forEach((f) => {
    assert.equal(plans.hasFeature(c, f), false, `starter must NOT include ${f}`);
  });
});

test('growth adds the things a growing shop needs', () => {
  const c = at('growth');
  ['reviews', 'discounts', 'reports', 'marketing', 'returns', 'payment-gateway'].forEach((f) => {
    assert.equal(plans.hasFeature(c, f), true, `growth must include ${f}`);
  });
  assert.equal(plans.hasFeature(c, 'journal'), false, 'journal is a Scale feature');
});

test('scale withholds nothing', () => {
  const c = at('scale');
  plans.FEATURES.forEach((f) => {
    assert.equal(plans.hasFeature(c, f.id), true, `scale must include ${f.id}`);
  });
});

test('a per-client extra beats the tier', () => {
  // The deal where someone buys Growth plus one more thing.
  const c = at('starter', ['reports']);
  assert.equal(plans.hasFeature(c, 'reports'), true, 'the paid extra must be on');
  assert.equal(plans.hasFeature(c, 'marketing'), false, 'and nothing else comes with it');
});

test('an unclassified feature is ON, so new work never disappears', () => {
  // Someone ships a feature and forgets to list it in a plan. Every existing
  // client must keep working, not silently lose it.
  assert.equal(plans.hasFeature(at('starter'), 'some-brand-new-thing'), true);
});

test('core features are in every plan', () => {
  const core = plans.FEATURES.filter((f) => f.core);
  assert.ok(core.length, 'there should be core features');
  plans.PLANS.forEach((p) => {
    core.forEach((f) => {
      assert.equal(plans.hasFeature({ plan: p.id }, f.id), true,
        `${p.id} is missing core feature ${f.id}`);
    });
  });
});

test('plans are strictly cumulative — a dearer tier never removes anything', () => {
  // A client who pays more and loses a feature is a support call and a refund.
  const sorted = [...plans.PLANS].sort((a, b) => a.price - b.price);
  for (let i = 1; i < sorted.length; i += 1) {
    const cheaper = sorted[i - 1];
    const dearer = sorted[i];
    if (dearer.features === '*') continue;
    cheaper.features.forEach((f) => {
      assert.ok(dearer.features.includes(f),
        `${dearer.id} (₹${dearer.price}) drops "${f}" that ${cheaper.id} has`);
    });
  }
});

test('prices rise with the tiers', () => {
  const prices = plans.PLANS.map((p) => p.price);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b), 'plans must be listed cheapest first');
  assert.equal(new Set(prices).size, prices.length, 'two tiers at the same price is a pricing bug');
});

test('every feature listed in a plan actually exists', () => {
  const known = new Set(plans.FEATURES.map((f) => f.id));
  plans.PLANS.forEach((p) => {
    if (p.features === '*') return;
    p.features.forEach((id) => {
      assert.ok(known.has(id), `plan ${p.id} lists unknown feature "${id}"`);
    });
  });
});

/* ---------------------------------------------------------- sections ---- */

test('admin sections map to features and lock together', () => {
  const c = at('starter');
  assert.equal(plans.sectionUnlocked(c, 'orders'), true);
  assert.equal(plans.sectionUnlocked(c, 'products'), true);
  assert.equal(plans.sectionUnlocked(c, 'reports'), false);
  assert.equal(plans.sectionUnlocked(c, 'discounts'), false);
});

test('a section with no feature attached is never locked', () => {
  // Dashboard, settings, activity: the store must always be operable.
  ['dashboard', 'settings', 'activity', 'categories'].forEach((section) => {
    assert.equal(plans.sectionUnlocked(at('starter'), section), true,
      `${section} must stay reachable on every plan`);
  });
});

/* ---------------------------------------------------------- overview ---- */

test('the overview says what is locked and which tier unlocks it', () => {
  const info = plans.overview(at('starter'));

  assert.equal(info.plan.id, 'starter');
  assert.ok(info.locked.length, 'starter should have locked features');

  const reports = info.features.find((f) => f.id === 'reports');
  assert.equal(reports.on, false);
  assert.equal(reports.unlockedBy.id, 'growth', 'the cheapest tier that includes it');

  const orders = info.features.find((f) => f.id === 'orders');
  assert.equal(orders.on, true);
  assert.equal(orders.unlockedBy, null, 'nothing to upsell for a feature you have');
});

test('the overview names the next tier up, and nothing beyond the top', () => {
  assert.equal(plans.overview(at('starter')).upgradeTo.id, 'growth');
  assert.equal(plans.overview(at('growth')).upgradeTo.id, 'scale');
  assert.equal(plans.overview(at('scale')).upgradeTo, null);
  assert.equal(plans.overview(at('scale')).locked.length, 0);
});

test('an extra is marked as bought separately, not as part of the tier', () => {
  const info = plans.overview(at('starter', ['reports']));
  const reports = info.features.find((f) => f.id === 'reports');
  assert.equal(reports.on, true);
  assert.equal(reports.viaExtra, true);
});
