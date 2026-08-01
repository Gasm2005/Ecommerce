'use strict';

/**
 * Test sandbox.
 *
 * Every test file gets its own throwaway data directory and its own site config,
 * so a test can place orders, refund them and edit products without touching
 * data/ — which is a real client's live store in production.
 *
 * MUST be required (and sandbox() called) BEFORE any src/ module, because those
 * modules resolve DATA_DIR at require time. Node's test runner gives each file
 * its own process, so per-file setup is safe.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** A small, predictable catalogue. Round numbers so failures are readable. */
const PRODUCTS = [
  {
    id: 'p001', slug: 'test-lehenga', name: 'Test Lehenga', sku: 'TL-001',
    categories: ['bridal', 'lehengas'], price: 10000, mrp: 12000,
    colors: ['Red', 'Gold'], sizes: ['XS', 'S', 'M'], fabric: 'Silk',
    stock: 10, cost: 4000, gstPercent: 5, hsn: '6211',
    images: ['/ph.svg'], createdAt: '2026-01-01', popularity: 90
  },
  {
    id: 'p002', slug: 'test-saree', name: 'Test Saree', sku: 'TS-002',
    categories: ['sarees'], price: 5000, mrp: 5000,
    colors: ['Ivory'], sizes: ['Free'], fabric: 'Cotton',
    stock: 4, cost: 2000, gstPercent: 12, hsn: '5407',
    images: ['/ph.svg'], createdAt: '2026-02-01', popularity: 50
  },
  {
    id: 'p003', slug: 'test-kurta', name: 'Test Kurta', sku: 'TK-003',
    categories: ['kurtas'], price: 2000, mrp: 2500,
    colors: ['Mint'], sizes: ['S', 'M', 'L'], fabric: 'Linen',
    stock: 0, cost: 800, images: ['/ph.svg'], createdAt: '2026-03-01', popularity: 10
  }
];

/**
 * Config for tests.
 *
 * The SHAPE comes from the real config/site.config.json — views iterate its
 * arrays directly, so a hand-written stub goes stale the moment someone adds a
 * key and every render test fails for the wrong reason. Only the numbers that
 * tests assert on are overridden, and they are chosen so a human can check the
 * arithmetic in their head: ₹10,000 at 5%, express ₹500, wrap ₹300.
 */
function baseConfig() {
  const real = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', '..', 'config', 'site.config.json'), 'utf8'
  ));

  return {
    ...real,
    brand: {
      ...real.brand,
      name: 'Test Store', logoText: 'TEST',
      supportPhone: '+91 90000 00000', supportEmail: 'care@test.example'
    },
    features: { ...real.features, guestCheckout: true, productsPerPage: 12 },
    finance: {
      gstPercentDefault: 12,
      defaultCogsPercent: 40,
      gstOnShipping: true,
      categoryDefaults: { sarees: { gstPercent: 12, cogsPercent: 40 } },
      perOrderCosts: { packaging: 100, shippingCost: 150, codHandling: 50 },
      percentCosts: { paymentGateway: 2, marketplaceOrPlatform: 0, returnsProvision: 0 },
      monthlyCosts: { rent: 0, salaries: 0, software: 0, other: 0 }
    },
    business: {
      legalName: 'Test Store Private Limited', tradeName: 'TEST',
      gstin: '27AABCT1234A1Z0', pan: 'AABCT1234A',
      addressLines: ['1 Test Road', 'Mumbai 400001'],
      state: 'Maharashtra', stateCode: '27',
      phone: '+91 90000 00000', email: 'care@test.example',
      invoicePrefix: 'TST', defaultHsn: '6211',
      signatureName: 'For Test Store Private Limited',
      bank: null, termsLines: ['Test terms.']
    },
    shipping: {
      ...real.shipping,
      freeAbove: 8000,
      standardCharge: 200,
      estimateDaysMetro: 3,
      estimateDaysOther: 6,
      returnWindowDays: 7,
      giftWrapCharge: 300,
      methods: [
        { id: 'standard', title: 'Standard', note: '{metro}-{other} days', charge: null },
        { id: 'express', title: 'Express', note: 'Fast', charge: 500 }
      ],
      cod: {
        ...(real.shipping.cod || {}),
        enabled: true, fullEnabled: false, partialEnabled: true,
        advanceType: 'percent', advancePercent: 25, advanceFlat: 2000,
        minOrder: 0, maxOrder: 100000,
        pincodeMode: 'block-list', blockedPincodes: ['110001'], blockedPrefixes: ['19'],
        allowedPincodesOnly: []
      }
    },
    inventory: { ...real.inventory, lowStockThreshold: 3 },
    reviews: { ...real.reviews, source: 'local', requirePurchase: true },
    payments: { ...real.payments, provider: 'manual', mode: 'test' },
    // Mail goes to the log provider: a test must never touch a real inbox.
    notifications: {
      ...real.notifications,
      emailProvider: 'log', whatsappProvider: 'off',
      fromEmail: 'no-reply@test.example', storeEmail: 'care@test.example'
    },
    nav: [
      { label: 'Bridal', slug: 'bridal' },
      { label: 'Sarees', slug: 'sarees' },
      { label: 'Kurtas', slug: 'kurtas' }
    ]
  };
}

/**
 * Creates the sandbox and points the app at it. Returns handles the test can use
 * to seed extra data or read the config back.
 */
function sandbox({ products, config: overrides } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-test-'));
  const configPath = path.join(dir, 'site.config.json');
  const config = { ...baseConfig(), ...(overrides || {}) };

  fs.writeFileSync(path.join(dir, 'products.json'), JSON.stringify(products || PRODUCTS, null, 2));
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  // Empty collections up front so no module has to invent a fallback shape.
  ['orders', 'returns', 'reviews', 'users', 'activity', 'journal', 'notifications', 'pincodes', 'invoice-counters', 'secrets'].forEach((name) => {
    const empty = ['pincodes', 'invoice-counters', 'secrets', 'marketing'].includes(name) ? {} : [];
    fs.writeFileSync(path.join(dir, name + '.json'), JSON.stringify(empty, null, 2));
  });
  fs.writeFileSync(path.join(dir, 'discounts.json'), JSON.stringify([], null, 2));

  process.env.DATA_DIR = dir;
  process.env.SITE_CONFIG = configPath;
  delete process.env.NODE_ENV;   // dev mode = no caching, so writes are visible

  return { dir, configPath, config, products: products || PRODUCTS };
}

/** Writes a data file mid-test (e.g. seed discounts) and clears any read cache. */
function seed(name, value) {
  fs.writeFileSync(path.join(process.env.DATA_DIR, name + '.json'), JSON.stringify(value, null, 2));
  require('../../src/store').invalidate(name);
}

/** A ready-to-use cart line, so tests don't rebuild the shape every time. */
function cartLine(product, qty = 1, size = 'M', color = 'Red') {
  return {
    key: `${product.id}|${size}|${color}`,
    product, size, color, qty,
    lineTotal: product.price * qty,
    lineMrp: (product.mrp || product.price) * qty
  };
}

/** A cart summary as hydrate() would return it — for unit-testing downstream. */
function summaryOf(lines, extra = {}) {
  const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
  const mrpTotal = lines.reduce((s, l) => s + l.lineMrp, 0);
  return {
    lines,
    count: lines.reduce((s, l) => s + l.qty, 0),
    subtotal,
    savings: Math.max(0, mrpTotal - subtotal),
    discount: 0, discountCode: null, discountError: null,
    shipping: 0, giftWrapCharge: 0, deliveryMethod: null, deliveryTitle: null,
    tax: 0, total: subtotal,
    ...extra
  };
}

module.exports = { sandbox, seed, cartLine, summaryOf, PRODUCTS, baseConfig };
