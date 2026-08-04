'use strict';

/**
 * Stock per size and colour.
 *
 * This exists because of a real defect: stock was one number per product, so a
 * kurti with twelve pieces across M, L and XL would happily sell twelve XL. For a
 * made-to-order couture house that never mattered — nothing is on a shelf. For the
 * retail shops this template is now sold to, it is a refund and an apology every
 * week.
 *
 * Two rules the tests hold hardest:
 *   · untracked stock stays BUYABLE. Treating "no stock number" as zero would
 *     empty every made-to-order shop the day this shipped.
 *   · a product with no variants behaves exactly as before, because existing
 *     catalogues must keep working untouched.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sandbox, summaryOf } = require('./helpers/sandbox');

/* A retail kurti: stock counted by size AND colour, which is the hard case. */
const KURTI = {
  id: 'v1', slug: 'retail-kurti', name: 'Retail Kurti',
  categories: ['kurtas'], price: 2400, mrp: 2800,
  colors: ['Red', 'Blue'], sizes: ['S', 'M', 'L'],
  fabric: 'Cotton', occasion: ['Daytime'], images: ['/ph.svg'],
  createdAt: '2026-01-01', popularity: 50, cost: 900,
  variants: [
    { size: 'S', color: 'Red', stock: 3 },
    { size: 'S', color: 'Blue', stock: 0 },
    { size: 'M', color: 'Red', stock: 1 },
    { size: 'M', color: 'Blue', stock: 5 },
    { size: 'L', stock: 4 }                 // this size, any colour
  ]
};

/* A shop that only counts by size. */
const SHIRT = {
  id: 'v2', slug: 'plain-shirt', name: 'Plain Shirt',
  categories: ['kurtas'], price: 1800, mrp: 1800,
  colors: ['White'], sizes: ['38', '40', '42'],
  fabric: 'Cotton', occasion: [], images: ['/ph.svg'],
  createdAt: '2026-01-02', popularity: 40, cost: 700,
  variants: [
    { size: '38', stock: 2 },
    { size: '40', stock: 0 },
    { size: '42', stock: 7 }
  ]
};

/* The old shape: one number, no variants. Must behave exactly as before. */
const LEGACY = {
  id: 'v3', slug: 'legacy-saree', name: 'Legacy Saree',
  categories: ['sarees'], price: 15000, mrp: 18000,
  colors: ['Gold'], sizes: ['Free'], fabric: 'Silk', occasion: [],
  images: ['/ph.svg'], createdAt: '2026-01-03', popularity: 30, cost: 6000,
  stock: 6
};

/* Made to order: no stock number at all. Must stay buyable. */
const COUTURE = {
  id: 'v4', slug: 'couture-lehenga', name: 'Couture Lehenga',
  categories: ['bridal'], price: 180000, mrp: 210000,
  colors: ['Maroon'], sizes: ['XS', 'S', 'M'], fabric: 'Raw Silk', occasion: ['Wedding'],
  images: ['/ph.svg'], createdAt: '2026-01-04', popularity: 90, cost: 70000,
  deliveryDays: 21
};

const base = sandbox({ products: [KURTI, SHIRT, LEGACY, COUTURE] });
const config = base.config;

const variants = require('../src/variants');
const cart = require('../src/cart');
const orders = require('../src/orders');
const catalog = require('../src/catalog');
const productsWrite = require('../src/products');

const kurti = () => catalog.byId('v1');
const shirt = () => catalog.byId('v2');

/* --------------------------------------------------------- resolution ---- */

test('stock is read from the exact size and colour', () => {
  assert.equal(variants.stockFor(KURTI, { size: 'S', color: 'Red' }), 3);
  assert.equal(variants.stockFor(KURTI, { size: 'S', color: 'Blue' }), 0);
  assert.equal(variants.stockFor(KURTI, { size: 'M', color: 'Red' }), 1);
  assert.equal(variants.stockFor(KURTI, { size: 'M', color: 'Blue' }), 5);
});

test('a size-only row covers every colour in that size', () => {
  // 'L' has no colour breakdown, so both colours read the same number.
  assert.equal(variants.stockFor(KURTI, { size: 'L', color: 'Red' }), 4);
  assert.equal(variants.stockFor(KURTI, { size: 'L', color: 'Blue' }), 4);
});

test('an exact row beats a size-only row', () => {
  const mixed = { ...KURTI, variants: [{ size: 'M', stock: 9 }, { size: 'M', color: 'Red', stock: 1 }] };
  assert.equal(variants.stockFor(mixed, { size: 'M', color: 'Red' }), 1, 'the specific row must win');
  assert.equal(variants.stockFor(mixed, { size: 'M', color: 'Blue' }), 9, 'others fall to the size row');
});

test('colour and size matching ignores case and stray spaces', () => {
  assert.equal(variants.stockFor(KURTI, { size: 's', color: ' red ' }), 3);
  assert.equal(variants.stockFor(SHIRT, { size: '42' }), 7);
});

test('a shop that counts only by size never has to name colours', () => {
  assert.equal(variants.stockFor(SHIRT, { size: '38', color: 'White' }), 2);
  assert.equal(variants.stockFor(SHIRT, { size: '40', color: 'White' }), 0);
});

test('a combination that is not in the table does not exist', () => {
  // Not "unknown, allow it" — a size absent from a tracked product is not for sale.
  assert.equal(variants.stockFor(KURTI, { size: 'XXL', color: 'Red' }), 0);
  assert.equal(variants.stockFor(SHIRT, { size: '46' }), 0);
});

test('untracked stock reads as null, never as zero', () => {
  // The rule that keeps every made-to-order shop selling.
  assert.equal(variants.stockFor(COUTURE, { size: 'S', color: 'Maroon' }), null);
  assert.equal(variants.totalStock(COUTURE), null);
  assert.equal(variants.anyAvailable(COUTURE), true, 'made to order must stay buyable');
  assert.equal(variants.isSoldOut(COUTURE, { size: 'S' }), false);
});

test('a product with no variants behaves exactly as it did before', () => {
  assert.equal(variants.tracksVariants(LEGACY), false);
  assert.equal(variants.stockFor(LEGACY, { size: 'Free', color: 'Gold' }), 6);
  assert.equal(variants.stockFor(LEGACY, { size: 'anything' }), 6, 'one number covers everything');
  assert.equal(variants.totalStock(LEGACY), 6);
});

test('the total is the sum of the variants', () => {
  assert.equal(variants.totalStock(KURTI), 3 + 0 + 1 + 5 + 4);
  assert.equal(variants.totalStock(SHIRT), 9);
});

/* ------------------------------------------------------- availability ---- */

test('the size picker knows which sizes are gone', () => {
  const red = variants.sizeAvailability(KURTI, 'Red');
  assert.deepEqual(red.map((s) => [s.size, s.available]), [['S', true], ['M', true], ['L', true]]);

  const blue = variants.sizeAvailability(KURTI, 'Blue');
  assert.deepEqual(blue.map((s) => [s.size, s.available]), [['S', false], ['M', true], ['L', true]]);
});

test('low stock is flagged only when it is true', () => {
  const red = variants.sizeAvailability(KURTI, 'Red');
  assert.equal(red.find((s) => s.size === 'M').low, true, 'one left is low');
  assert.equal(red.find((s) => s.size === 'L').low, false, 'four is not');

  // Never invented for a made-to-order piece.
  assert.equal(variants.sizeAvailability(COUTURE, 'Maroon').every((s) => !s.low), true);
});

test('sold-out colours are known too', () => {
  const inS = variants.colourAvailability(KURTI, 'S');
  assert.deepEqual(inS.map((c) => [c.color, c.available]), [['Red', true], ['Blue', false]]);
});

test('the admin grid covers every size and colour on sale', () => {
  const m = variants.matrix(KURTI);
  assert.deepEqual(m.sizes, ['S', 'M', 'L']);
  assert.deepEqual(m.colors, ['Red', 'Blue']);
  assert.equal(m.tracked, true);
  assert.equal(m.total, 13);
  assert.equal(m.cell('S', 'Red').stock, 3);
  assert.equal(m.cell('L', 'Red').inherited, true, 'L comes from a size-only row');
  assert.equal(m.cell('S', 'Red').inherited, false);
});

test('a product with no colours still gets one grid column', () => {
  const noColour = { ...SHIRT, colors: [] };
  assert.deepEqual(variants.matrix(noColour).colors, [null]);
});

/* -------------------------------------------------------------- cart ---- */

test('the cart caps against the chosen size, not the product total', () => {
  // THE BUG. 13 pieces exist, but only one M/Red.
  const lines = cart.addToCart(
    { cookies: {} }, { cookie() {} },
    { id: 'v1', size: 'M', color: 'Red', qty: 9 }
  );
  assert.equal(lines[0].qty, 1, 'nine M/Red cannot be carted when one exists');
});

test('a sold-out variant cannot enter the cart at all', () => {
  const lines = cart.addToCart(
    { cookies: {} }, { cookie() {} },
    { id: 'v1', size: 'S', color: 'Blue', qty: 1 }
  );
  assert.equal(lines.length, 0, 'S/Blue is at zero');
});

test('a different variant of the same product is unaffected', () => {
  const lines = cart.addToCart(
    { cookies: {} }, { cookie() {} },
    { id: 'v1', size: 'M', color: 'Blue', qty: 4 }
  );
  assert.equal(lines[0].qty, 4, 'five M/Blue exist, so four is fine');
});

test('a made-to-order piece is still capped only by the line limit', () => {
  const lines = cart.addToCart(
    { cookies: {} }, { cookie() {} },
    { id: 'v4', size: 'S', color: 'Maroon', qty: 50 }
  );
  assert.equal(lines[0].qty, 10, 'capped by the per-line limit, not by stock');
});

test('the pre-payment check names the variant, not just the product', () => {
  const line = {
    key: 'v1|M|Red', product: kurti(), size: 'M', color: 'Red', qty: 3,
    lineTotal: 7200, lineMrp: 8400
  };
  const problems = cart.stockProblems(summaryOf([line]));
  assert.equal(problems.length, 1);
  assert.equal(problems[0].available, 1);
  assert.match(problems[0].message, /Only 1 left of Retail Kurti \(M · Red\)/,
    'a customer who ordered the M is not comforted by "6 in stock"');
});

test('the pre-payment check passes when the variant has enough', () => {
  const line = {
    key: 'v1|M|Blue', product: kurti(), size: 'M', color: 'Blue', qty: 5,
    lineTotal: 12000, lineMrp: 14000
  };
  assert.deepEqual(cart.stockProblems(summaryOf([line])), []);
});

/* ------------------------------------------------------------ writes ---- */

test('selling a variant takes it off that variant alone', () => {
  const before = variants.stockFor(kurti(), { size: 'M', color: 'Blue' });

  const summary = cart.withCheckoutExtras(summaryOf([{
    key: 'v1|M|Blue', product: kurti(), size: 'M', color: 'Blue', qty: 2,
    lineTotal: 4800, lineMrp: 5600
  }]), {}, config);

  orders.create({
    cartSummary: summary,
    state: { fullName: 'Buyer', phone: '9820000000', address1: 'x', city: 'Mumbai', state: 'Maharashtra', pincode: '400001' },
    config, attribution: null, codPlan: null, payment: null
  });

  assert.equal(variants.stockFor(kurti(), { size: 'M', color: 'Blue' }), before - 2);
  assert.equal(variants.stockFor(kurti(), { size: 'M', color: 'Red' }), 1, 'the M/Red is untouched');
  assert.equal(variants.stockFor(kurti(), { size: 'S', color: 'Red' }), 3, 'and so is the S');
});

test('the product total stays in step with its variants', () => {
  // Every older screen and report still reads product.stock; it must not drift.
  const p = kurti();
  assert.equal(p.stock, variants.totalStock(p),
    `product.stock (${p.stock}) should equal the sum of variants (${variants.totalStock(p)})`);
});

test('the admin can set one cell without touching the others', () => {
  productsWrite.setVariantStock('v2', { size: '40' }, 12);
  assert.equal(variants.stockFor(shirt(), { size: '40' }), 12);
  assert.equal(variants.stockFor(shirt(), { size: '38' }), 2, 'unrelated sizes unchanged');
  assert.equal(shirt().stock, 2 + 12 + 7);
});

test('stock can be adjusted by a delta and never goes below zero', () => {
  productsWrite.adjustVariantStock('v2', { size: '38' }, -5);
  assert.equal(variants.stockFor(shirt(), { size: '38' }), 0, 'clamped at zero, not negative');
});

test('setting stock for a size that had no row creates one', () => {
  productsWrite.setVariantStock('v2', { size: '42', color: 'White' }, 3);
  assert.equal(variants.stockFor(shirt(), { size: '42', color: 'White' }), 3);
});

test('a legacy product keeps using the single number when sold', () => {
  const before = catalog.byId('v3').stock;

  const summary = cart.withCheckoutExtras(summaryOf([{
    key: 'v3|Free|Gold', product: catalog.byId('v3'), size: 'Free', color: 'Gold', qty: 2,
    lineTotal: 30000, lineMrp: 36000
  }]), {}, config);

  orders.create({
    cartSummary: summary,
    state: { fullName: 'Buyer', phone: '9820000001', address1: 'x', city: 'Mumbai', state: 'Maharashtra', pincode: '400001' },
    config, attribution: null, codPlan: null, payment: null
  });

  assert.equal(catalog.byId('v3').stock, before - 2);
  assert.equal(variants.tracksVariants(catalog.byId('v3')), false, 'no variants were invented for it');
});

/* --------------------------------------------------------- reporting ---- */

test('low variants are listed smallest first, for a buying list', () => {
  const low = variants.lowVariants(KURTI, 2);
  assert.deepEqual(low.map((v) => [variants.label(v), v.stock]), [
    ['S · Blue', 0],
    ['M · Red', 1]
  ]);
});

test('a variant label reads the way a person would say it', () => {
  assert.equal(variants.label({ size: 'M', color: 'Red' }), 'M · Red');
  assert.equal(variants.label({ size: 'L' }), 'L');
  assert.equal(variants.label({}), 'All');
});
