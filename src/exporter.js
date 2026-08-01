'use strict';

/**
 * "Your data is yours" — the whole store, in one download.
 *
 * This exists for a commercial reason as much as a technical one. The commonest
 * objection to a hosted store is lock-in: what happens to my customers, my
 * orders, my catalogue if we part ways. The honest answer is a button that hands
 * all of it over, in files anything can read, with no notice and no negotiation.
 *
 * Two formats, on purpose:
 *   CSV   for a human — opens in Excel, imports into Shopify or WooCommerce
 *   JSON  for a machine — the exact records, nothing lost to flattening
 *
 * What is deliberately NOT included: password hashes, API keys, the licence key.
 * Those are credentials, not business records, and an export that leaks them is a
 * breach waiting for the day someone emails the zip around.
 */

const { zip, csv } = require('./zip');
const store = require('./store');
const catalog = require('./catalog');
const orders = require('./orders');
const reviews = require('./reviews');
const returns = require('./returns');
const discounts = require('./discounts');
const journal = require('./journal');
const invoice = require('./invoice');
const auth = require('./auth');
const gstReturn = require('./gst-return');

/* ---------------------------------------------------------------- sheets ---- */

function ordersSheet(list) {
  return csv(
    ['order_id', 'invoice_no', 'placed_at', 'status', 'payment_method', 'payment_status',
      'customer_name', 'email', 'phone',
      'address', 'city', 'state', 'pincode', 'country',
      'items', 'units', 'subtotal', 'discount', 'coupon',
      'delivery_method', 'shipping', 'gift_wrap', 'total', 'gst_amount',
      'cod_advance_paid', 'cod_due_on_delivery', 'refunded', 'delivery_notes'],
    list.map((o) => [
      o.id,
      o.invoice ? o.invoice.number : '',
      o.createdAt,
      o.status,
      o.paymentMethod,
      o.paymentStatus,
      o.customer.name, o.customer.email, o.customer.phone,
      o.address.address1, o.address.city, o.address.state, o.address.pincode, o.address.country,
      o.items.map((i) => `${i.name} (${i.size}${i.color ? '/' + i.color : ''}) x${i.qty}`).join(' | '),
      o.items.reduce((s, i) => s + i.qty, 0),
      o.subtotal, o.discount || 0, o.discountCode || '',
      o.deliveryTitle || o.deliveryMethod || '', o.shipping || 0, o.giftWrapCharge || 0,
      o.total, o.gstAmount || 0,
      o.codPlan ? o.codPlan.advancePaid : '',
      o.codPlan ? o.codPlan.dueOnDelivery : '',
      o.refundedAmount || 0,
      o.notes || ''
    ])
  );
}

/** One row per line item — what an accountant and a new platform both want. */
function orderItemsSheet(list) {
  const rows = [];
  list.forEach((o) => {
    o.items.forEach((it) => rows.push([
      o.id, o.createdAt, o.status,
      it.productId, it.name, it.size, it.color || '', it.qty,
      it.price, it.price * it.qty, it.gstPercent, it.taxAmount,
      // Cost is the owner's number and never shown to a customer, but it is
      // theirs, so it belongs in their export.
      it.cost, it.cost * it.qty
    ]));
  });
  return csv(
    ['order_id', 'placed_at', 'status', 'product_id', 'product', 'size', 'colour',
      'qty', 'unit_price', 'line_total', 'gst_percent', 'gst_amount', 'unit_cost', 'line_cost'],
    rows
  );
}

/** Customers, derived from orders — there is no separate account system yet. */
function customersSheet(list) {
  const map = new Map();
  list.forEach((o) => {
    const key = (o.customer.email || o.customer.phone || o.id).toLowerCase();
    const row = map.get(key) || {
      name: o.customer.name, email: o.customer.email, phone: o.customer.phone,
      orders: 0, units: 0, spend: 0, refunded: 0,
      first: o.createdAt, last: o.createdAt,
      city: o.address.city, state: o.address.state, pincode: o.address.pincode
    };
    row.orders += 1;
    row.units += o.items.reduce((s, i) => s + i.qty, 0);
    // Cancelled and returned orders are not spend.
    if (o.status !== 'cancelled') row.spend += o.total;
    row.refunded += o.refundedAmount || 0;
    if (o.createdAt < row.first) row.first = o.createdAt;
    if (o.createdAt > row.last) { row.last = o.createdAt; row.city = o.address.city; }
    map.set(key, row);
  });

  return csv(
    ['name', 'email', 'phone', 'orders', 'units', 'lifetime_spend', 'refunded',
      'first_order', 'last_order', 'city', 'state', 'pincode'],
    [...map.values()]
      .sort((a, b) => b.spend - a.spend)
      .map((c) => [c.name, c.email, c.phone, c.orders, c.units, c.spend, c.refunded,
        c.first, c.last, c.city, c.state, c.pincode])
  );
}

function productsSheet(list) {
  return csv(
    ['id', 'sku', 'name', 'slug', 'categories', 'price', 'mrp', 'unit_cost', 'gst_percent',
      'hsn', 'stock', 'colours', 'sizes', 'fabric', 'occasion', 'badge', 'created_at', 'images'],
    list.map((p) => [
      p.id, p.sku || '', p.name, p.slug, (p.categories || []).join('|'),
      p.price, p.mrp || '', p.cost === undefined ? '' : p.cost,
      p.gstPercent === undefined ? '' : p.gstPercent, p.hsn || '',
      p.stock === undefined ? '' : p.stock,
      (p.colors || []).join('|'), (p.sizes || []).join('|'),
      p.fabric || '', (p.occasion || []).join('|'), p.badge || '',
      p.createdAt || '', (p.images || []).join('|')
    ])
  );
}

function reviewsSheet(list) {
  return csv(
    ['id', 'product_id', 'rating', 'title', 'body', 'author', 'email', 'verified',
      'status', 'created_at', 'media'],
    list.map((r) => [
      r.id, r.productId, r.rating, r.title || '', r.body || '',
      r.author || '', r.email || '', r.verifiedPurchase ? 'yes' : 'no',
      r.status || '', r.createdAt || '',
      (r.media || []).map((m) => m.src || m.url || '').filter(Boolean).join('|')
    ])
  );
}

function returnsSheet(list) {
  return csv(
    ['id', 'order_id', 'status', 'reason', 'requested_at', 'refund_amount', 'items', 'notes'],
    list.map((r) => [
      r.id, r.orderId, r.status, r.reason || '', r.createdAt || '',
      r.refundAmount || 0,
      (r.items || []).map((i) => `${i.name || i.productId} x${i.qty || 1}`).join(' | '),
      (r.notes || '')
    ])
  );
}

function discountsSheet(list) {
  return csv(
    ['code', 'type', 'value', 'min_order', 'expires_at', 'usage_limit', 'used', 'active', 'note'],
    list.map((d) => [d.code, d.type, d.value, d.minOrder || 0, d.expiresAt || '',
      d.usageLimit || 0, d.used || 0, d.active ? 'yes' : 'no', d.note || ''])
  );
}

function journalSheet(list) {
  return csv(
    ['id', 'slug', 'title', 'excerpt', 'published_at', 'status', 'tags', 'body'],
    list.map((p) => [p.id, p.slug, p.title, p.excerpt || '', p.publishedAt || p.createdAt || '',
      p.status || '', (p.tags || []).join('|'), p.body || ''])
  );
}

/** GST register: one row per invoice, which is what a CA asks for. */
function gstSheet(list, config) {
  const rows = [];
  list.forEach((o) => {
    if (!o.invoice || !o.invoice.number) return;
    const inv = invoice.build(o, config, { allocate: false });
    rows.push([
      inv.invoice.number, o.invoice.issuedAt || o.createdAt, o.id,
      o.customer.name, o.address.state, inv.placeOfSupply,
      inv.interState ? 'IGST' : 'CGST+SGST',
      inv.totals.taxableValue, inv.totals.cgst, inv.totals.sgst, inv.totals.igst,
      inv.totals.totalTax, inv.totals.rounded
    ]);
  });
  return csv(
    ['invoice_no', 'invoice_date', 'order_id', 'customer', 'buyer_state', 'place_of_supply',
      'tax_type', 'taxable_value', 'cgst', 'sgst', 'igst', 'total_tax', 'invoice_total'],
    rows
  );
}

/** Staff list WITHOUT hashes — who had access, not how to become them. */
function usersSheet() {
  return csv(
    ['name', 'email', 'role', 'active', 'created_at', 'last_login'],
    auth.users().map((u) => [u.name, u.email, u.role, u.active ? 'yes' : 'no',
      u.createdAt || '', u.lastLoginAt || ''])
  );
}

/* -------------------------------------------------------------- assemble ---- */

/** Config with every credential stripped — safe to hand over or email. */
function safeConfig(config) {
  const clone = JSON.parse(JSON.stringify(config));
  delete clone.planExtras;
  // Nothing here should hold secrets by design, but strip defensively: a config
  // is the file most likely to gain a stray key in a hurry.
  const scrub = (obj) => {
    Object.keys(obj || {}).forEach((k) => {
      if (/key|secret|token|password|salt/i.test(k)) obj[k] = '[removed from export]';
      else if (obj[k] && typeof obj[k] === 'object') scrub(obj[k]);
    });
  };
  scrub(clone);
  return clone;
}

function manifest(config, counts) {
  const lines = [
    `${config.brand.name} — data export`,
    `Generated ${new Date().toISOString()}`,
    '',
    'This is your complete store data. It is yours, unconditionally.',
    '',
    'CSV files open in Excel, Google Sheets or Numbers, and import into',
    'Shopify, WooCommerce and most other platforms. The JSON folder holds the',
    'exact records with nothing lost to flattening.',
    '',
    'Contents',
    ...Object.entries(counts).map(([name, n]) => `  ${name.padEnd(22)} ${n} row${n === 1 ? '' : 's'}`),
    '',
    'Deliberately NOT included, because they are credentials rather than',
    'business records:',
    '  · admin password hashes',
    '  · payment gateway and email provider API keys',
    '  · the licence key',
    '',
    'Product images are referenced by URL in products.csv. If you are moving',
    'platforms, download them from the running store before it is shut down.'
  ];
  return lines.join('\r\n') + '\r\n';
}

/**
 * Builds the archive. Returns { filename, buffer, counts } — the caller decides
 * whether it becomes a download or a file on disk.
 */
function buildArchive(config, window) {
  const orderList = orders.all();
  const productList = catalog.all();
  const reviewList = reviews.all();
  const returnList = returns.all();
  const discountList = discounts.all();
  const journalList = journal.all();

  const counts = {
    'orders.csv': orderList.length,
    'order-items.csv': orderList.reduce((s, o) => s + o.items.length, 0),
    'customers.csv': new Set(orderList.map((o) => (o.customer.email || o.customer.phone || o.id).toLowerCase())).size,
    'products.csv': productList.length,
    'reviews.csv': reviewList.length,
    'returns.csv': returnList.length,
    'discounts.csv': discountList.length,
    'journal.csv': journalList.length,
    'gst/ (GSTR-1 tables)': orderList.filter((o) => o.invoice && o.invoice.number).length,
    'admin-users.csv': auth.users().length
  };

  // GSTR-1 working papers: the tables a CA actually files from, not raw orders.
  const gst = gstReturn.workingPapers(config, window);

  const entries = [
    { name: 'README.txt', data: manifest(config, counts) },
    ...gst.entries,
    { name: 'gst/invoice-register.csv', data: gstSheet(orderList, config) },

    { name: 'csv/orders.csv', data: ordersSheet(orderList) },
    { name: 'csv/order-items.csv', data: orderItemsSheet(orderList) },
    { name: 'csv/customers.csv', data: customersSheet(orderList) },
    { name: 'csv/products.csv', data: productsSheet(productList) },
    { name: 'csv/reviews.csv', data: reviewsSheet(reviewList) },
    { name: 'csv/returns.csv', data: returnsSheet(returnList) },
    { name: 'csv/discounts.csv', data: discountsSheet(discountList) },
    { name: 'csv/journal.csv', data: journalSheet(journalList) },
    { name: 'csv/admin-users.csv', data: usersSheet() },

    { name: 'json/orders.json', data: JSON.stringify(orderList, null, 2) },
    { name: 'json/products.json', data: JSON.stringify(productList, null, 2) },
    { name: 'json/reviews.json', data: JSON.stringify(reviewList, null, 2) },
    { name: 'json/returns.json', data: JSON.stringify(returnList, null, 2) },
    { name: 'json/discounts.json', data: JSON.stringify(discountList, null, 2) },
    { name: 'json/journal.json', data: JSON.stringify(journalList, null, 2) },
    { name: 'json/marketing.json', data: JSON.stringify(store.read('marketing', {}), null, 2) },
    { name: 'json/store-settings.json', data: JSON.stringify(safeConfig(config), null, 2) }
  ];

  const stamp = new Date().toISOString().slice(0, 10);
  const slug = String(config.brand.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'store';

  return {
    filename: `${slug}-data-export-${stamp}.zip`,
    buffer: zip(entries),
    counts,
    entries: entries.map((e) => e.name)
  };
}

module.exports = {
  buildArchive, safeConfig,
  ordersSheet, orderItemsSheet, customersSheet, productsSheet, gstSheet
};
