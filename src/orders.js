'use strict';

/**
 * Order persistence and lifecycle. Storefront checkout writes here; the admin
 * reads, filters and advances status here.
 */

const store = require('./store');
const catalog = require('./catalog');

const STATUSES = [
  { id: 'pending', label: 'Pending', tone: 'warning', hint: 'Awaiting confirmation / payment' },
  { id: 'confirmed', label: 'Confirmed', tone: 'info', hint: 'Accepted, not yet in production' },
  { id: 'in_production', label: 'In production', tone: 'info', hint: 'With the atelier' },
  { id: 'shipped', label: 'Shipped', tone: 'info', hint: 'Handed to the courier' },
  { id: 'delivered', label: 'Delivered', tone: 'good', hint: 'Completed' },
  { id: 'cancelled', label: 'Cancelled', tone: 'critical', hint: 'Cancelled before dispatch' },
  { id: 'returned', label: 'Returned', tone: 'critical', hint: 'Returned after delivery' }
];

const PAYMENT_METHODS = [
  { id: 'upi', label: 'UPI' },
  { id: 'card', label: 'Card' },
  { id: 'netbanking', label: 'Net banking' },
  { id: 'emi', label: 'EMI' },
  { id: 'cod', label: 'Cash on delivery' }
];

const PAYMENT_STATUSES = [
  { id: 'paid', label: 'Paid', tone: 'good' },
  { id: 'pending', label: 'Pending', tone: 'warning' },
  { id: 'partially_paid', label: 'Advance paid', tone: 'warning' },
  { id: 'refunded', label: 'Refunded', tone: 'critical' },
  { id: 'partially_refunded', label: 'Part refunded', tone: 'warning' },
  { id: 'failed', label: 'Failed', tone: 'critical' }
];

/** Orders that should not count towards revenue. */
const IS_LOST = (o) => o.status === 'cancelled' || o.status === 'returned';

function all() {
  return store.read('orders', []);
}

function byId(id) {
  return all().find((o) => o.id === id) || null;
}

function label(list, id) {
  const row = list.find((x) => x.id === id);
  return row ? row.label : id;
}

function statusMeta(id) {
  return STATUSES.find((s) => s.id === id) || { id, label: id, tone: 'info' };
}

/**
 * Order numbers say at a glance whether a coupon was used:
 *   ORD-00042    — full price
 *   ORD-C-00042  — a coupon was applied
 * The sequence is shared, so ids never collide and the count stays readable.
 */
function nextOrderId(hasCoupon) {
  const seq = all().reduce((max, o) => {
    const m = /(\d+)$/.exec(String(o.id || ''));
    return m ? Math.max(max, parseInt(m[1], 10)) : max;
  }, 0) + 1;
  return `ORD-${hasCoupon ? 'C-' : ''}${String(seq).padStart(5, '0')}`;
}

/** True for ids minted against a coupon. */
function isCouponOrder(order) {
  return /^ORD-C-/.test(String(order.id || '')) || !!order.discountCode;
}

/**
 * Creates an order from a hydrated cart + checkout state. Prices and costs are
 * snapshotted so later catalogue edits don't rewrite history.
 */
function create({ cartSummary, state, config, attribution, codPlan, payment }) {
  const pricing = require('./pricing');

  // Snapshot each line's cost and GST rate at the moment of sale, resolved from
  // the product → category → global chain. Later edits never rewrite history.
  const items = cartSummary.lines.map((l) => {
    const snap = pricing.lineSnapshot(l.product, l.qty, config);
    return {
      productId: l.product.id,
      slug: l.product.slug,
      name: l.product.name,
      size: l.size,
      color: l.color,
      qty: l.qty,
      price: snap.price,
      cost: snap.cost,
      gstPercent: snap.gstPercent,
      taxAmount: snap.taxAmount
    };
  });

  const cogs = items.reduce((s, it) => s + it.cost * it.qty, 0);
  // Tax is extracted per line (rates differ by product), then reduced pro-rata
  // for any discount, since the discount lowers the taxable amount too.
  const grossTax = items.reduce((s, it) => s + it.taxAmount, 0);
  const discountRatio = cartSummary.subtotal ? (cartSummary.subtotal - (cartSummary.discount || 0)) / cartSummary.subtotal : 1;

  // Shipping and gift wrap are part of the same composite supply, so they carry
  // the principal (highest) rate in the order unless the owner opted out.
  const shipping = cartSummary.shipping || 0;
  const giftWrapCharge = cartSummary.giftWrapCharge || 0;
  const charges = shipping + giftWrapCharge;
  const principalRate = items.reduce((max, it) => Math.max(max, it.gstPercent || 0), 0);
  const chargeTax = charges > 0 && (config.finance || {}).gstOnShipping !== false
    ? pricing.taxOf(charges, principalRate)
    : 0;

  const gstAmount = Math.round(grossTax * discountRatio) + chargeTax;

  const paymentMethod = state.paymentMethod || 'upi';
  const now = new Date().toISOString();

  const order = {
    id: nextOrderId(!!cartSummary.discountCode),
    createdAt: now,
    status: 'pending',
    paymentMethod,
    // Partial COD is genuinely part-paid — the P&L and the delivery team both
    // need to know how much is still to collect at the door.
    paymentStatus: !codPlan || codPlan.type === 'prepaid' ? 'paid'
      : (codPlan.type === 'partial-cod' ? 'partially_paid' : 'pending'),
    codPlan: codPlan && codPlan.type !== 'prepaid' ? codPlan : null,
    // Gateway receipt, so a refund can be issued through the same provider.
    payment: payment || null,
    channel: (attribution && attribution.source) || 'web',
    attribution: attribution || null,
    customer: {
      name: state.fullName || 'Guest',
      email: state.email || '',
      phone: state.phone || '',
      // A GSTIN turns this into a B2B supply: it must appear on the invoice and
      // be reported invoice-wise in GSTR-1 so the buyer can claim input credit.
      gstin: require('./gstin').normalise(state.gstin) || null,
      businessName: String(state.businessName || '').trim() || null
    },
    address: {
      address1: [state.address1, state.address2].filter(Boolean).join(', '),
      city: state.city || '',
      state: state.state || '',
      pincode: state.pincode || '',
      country: state.country || 'India'
    },
    items,
    subtotal: cartSummary.subtotal,
    discount: cartSummary.discount || 0,
    discountCode: cartSummary.discountCode || null,
    shipping,
    giftWrapCharge,
    chargeTax,
    total: cartSummary.total,
    gstAmount,
    cogs,
    deliveryMethod: cartSummary.deliveryMethod || state.deliveryMethod || 'standard',
    deliveryTitle: cartSummary.deliveryTitle || null,
    deliveryNote: cartSummary.deliveryNote || null,
    /* Who carries this parcel. 'own' means the shop delivers it themselves and it
       must NEVER be handed to a courier — including automatically, once courier
       integration exists. 'pickup' means the customer collects it. */
    fulfilment: cartSummary.fulfilment || 'courier',
    deliveryZone: cartSummary.deliveryZone || null,
    deliveryZoneLabel: cartSummary.deliveryZoneLabel || null,
    deliverySlot: String(state.deliverySlot || '').trim() || null,
    giftWrap: state.giftWrap === 'yes',
    notes: state.notes || '',
    timeline: [{ at: now, label: 'Order placed' }]
  };

  store.update('orders', [], (list) => [...list, order], { skipBackup: true });
  decrementStock(items);
  return order;
}

/** Keeps inventory honest when an order is placed. */
function decrementStock(items) {
  // Required lazily: src/products.js requires catalog, which requires nothing
  // back here, but keeping it local documents that this is a side effect.
  const products = require('./products');
  const variants = require('./variants');

  items.forEach((it) => {
    const product = catalog.byId(it.productId);
    if (!product) return;

    // Take it off the exact size and colour that sold. Falling back to the
    // whole-product number would leave the M looking available after the last M
    // went out of the door.
    if (variants.tracksVariants(product)) {
      products.adjustVariantStock(it.productId, { size: it.size, color: it.color }, -it.qty);
      return;
    }
    if (Number.isFinite(product.stock)) products.adjustStock(it.productId, -it.qty);
  });
}

/** Advances status, appends to the timeline and syncs payment status. */
function setStatus(id, status, note) {
  if (!STATUSES.some((s) => s.id === status)) throw new Error('Unknown status: ' + status);
  let updated = null;

  store.update('orders', [], (list) => list.map((o) => {
    if (o.id !== id) return o;
    const timeline = [...(o.timeline || []), {
      at: new Date().toISOString(),
      label: note || ('Marked ' + statusMeta(status).label.toLowerCase())
    }];
    let paymentStatus = o.paymentStatus;
    if (status === 'delivered' && o.paymentMethod === 'cod') paymentStatus = 'paid';
    if (status === 'returned' || status === 'cancelled') {
      paymentStatus = o.paymentStatus === 'paid' ? 'refunded' : 'failed';
    }
    updated = { ...o, status, paymentStatus, timeline };
    return updated;
  }), { skipBackup: true });

  return updated;
}

function setPaymentStatus(id, paymentStatus) {
  let updated = null;
  store.update('orders', [], (list) => list.map((o) => {
    if (o.id !== id) return o;
    updated = {
      ...o,
      paymentStatus,
      timeline: [...(o.timeline || []), { at: new Date().toISOString(), label: 'Payment marked ' + paymentStatus }]
    };
    return updated;
  }), { skipBackup: true });
  return updated;
}

/**
 * Called when a return is refunded. Records the exact amount paid back — the P&L
 * uses this rather than assuming the whole order value came back.
 */
/**
 * Records money going back to the customer.
 *
 * Refunds ACCUMULATE. One order can produce several returns — two items sent
 * back a week apart — and each refund adds to the total already returned. An
 * earlier version overwrote it, which made the P&L understate refunds and
 * overstate profit for every multi-return order.
 *
 * The running total is capped at the order value, and the returns that produced
 * it are kept so the admin can trace where the money went.
 */
function markRefunded(id, amount, returnId) {
  let updated = null;
  store.update('orders', [], (list) => list.map((o) => {
    if (o.id !== id) return o;

    const already = Number.isFinite(o.refundedAmount) ? o.refundedAmount : 0;
    const asked = Math.max(0, Number(amount) || 0);
    const value = Math.min(already + asked, o.total);
    const added = value - already;

    const returnIds = [...new Set([...(o.returnIds || (o.returnId ? [o.returnId] : [])), returnId].filter(Boolean))];

    updated = {
      ...o,
      status: 'returned',
      paymentStatus: value >= o.total ? 'refunded' : 'partially_refunded',
      refundedAmount: value,
      returnId: returnId || o.returnId || null,
      returnIds,
      timeline: [...(o.timeline || []), {
        at: new Date().toISOString(),
        label: `Refunded ₹${added.toLocaleString('en-IN')}${returnId ? ' (' + returnId + ')' : ''}` +
          (already ? ` · ₹${value.toLocaleString('en-IN')} returned in total` : '')
      }]
    };
    return updated;
  }), { skipBackup: true });
  return updated;
}

/** Stores the allocated invoice number so it is never issued twice. */
function attachInvoice(id, invoice) {
  let updated = null;
  store.update('orders', [], (list) => list.map((row) => {
    if (row.id !== id || (row.invoice && row.invoice.number)) return row;
    updated = { ...row, invoice };
    return updated;
  }), { skipBackup: true });
  return updated;
}

function addNote(id, text) {
  let updated = null;
  store.update('orders', [], (list) => list.map((o) => {
    if (o.id !== id) return o;
    updated = { ...o, timeline: [...(o.timeline || []), { at: new Date().toISOString(), label: 'Note: ' + text }] };
    return updated;
  }), { skipBackup: true });
  return updated;
}

/** Admin list view: filter + search + sort + paginate. */
function query({ status, payment, paymentStatus, fulfilment, q, from, to, sort = 'newest', page = 1, perPage = 20 } = {}) {
  let list = all();

  if (status) list = list.filter((o) => o.status === status);
  if (payment === 'cod') list = list.filter((o) => o.paymentMethod === 'cod');
  else if (payment === 'prepaid') list = list.filter((o) => o.paymentMethod !== 'cod');
  else if (payment) list = list.filter((o) => o.paymentMethod === payment);
  if (paymentStatus) list = list.filter((o) => o.paymentStatus === paymentStatus);
  /* "Show me what I'm delivering myself today" — the list a shop with its own
     delivery actually works from each morning. 'courier' covers older orders
     written before fulfilment existed. */
  if (fulfilment === 'self') list = list.filter((o) => o.fulfilment === 'own' || o.fulfilment === 'pickup');
  else if (fulfilment === 'own') list = list.filter((o) => o.fulfilment === 'own');
  else if (fulfilment === 'pickup') list = list.filter((o) => o.fulfilment === 'pickup');
  else if (fulfilment === 'courier') list = list.filter((o) => !o.fulfilment || o.fulfilment === 'courier');
  if (from) list = list.filter((o) => o.createdAt >= from);
  if (to) list = list.filter((o) => o.createdAt <= to + 'T23:59:59Z');

  if (q) {
    const needle = String(q).toLowerCase();
    list = list.filter((o) =>
      o.id.toLowerCase().includes(needle) ||
      o.customer.name.toLowerCase().includes(needle) ||
      o.customer.email.toLowerCase().includes(needle) ||
      o.customer.phone.includes(needle) ||
      o.address.city.toLowerCase().includes(needle) ||
      o.items.some((it) => it.name.toLowerCase().includes(needle))
    );
  }

  switch (sort) {
    case 'oldest': list = [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt)); break;
    case 'value-desc': list = [...list].sort((a, b) => b.total - a.total); break;
    case 'value-asc': list = [...list].sort((a, b) => a.total - b.total); break;
    default: list = [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  const total = list.length;
  const start = (Math.max(1, page) - 1) * perPage;
  return {
    items: list.slice(start, start + perPage),
    total,
    page: Math.max(1, page),
    perPage,
    pages: Math.max(1, Math.ceil(total / perPage)),
    value: list.reduce((s, o) => s + o.total, 0)
  };
}

/**
 * Purchase verification for reviews: the order must exist, contain the product,
 * be far enough along to have been received, and the contact must match what was
 * used at checkout. Returns { ok, order, reason }.
 */
function verifyPurchase({ orderId, contact, productId }) {
  const id = String(orderId || '').trim().toUpperCase();
  const needle = String(contact || '').trim().toLowerCase();

  if (!id) return { ok: false, reason: 'Enter the order number from your confirmation.' };
  if (!needle) return { ok: false, reason: 'Enter the email or phone number used on the order.' };

  const order = all().find((o) => o.id.toUpperCase() === id);
  if (!order) return { ok: false, reason: 'We can’t find that order number.' };

  const email = String(order.customer.email || '').toLowerCase();
  const phone = String(order.customer.phone || '').replace(/\D/g, '');
  const contactDigits = needle.replace(/\D/g, '');
  const matches = (email && email === needle) || (phone && contactDigits && phone.endsWith(contactDigits.slice(-8)));
  if (!matches) return { ok: false, reason: 'That email or phone doesn’t match the order.' };

  if (!order.items.some((it) => it.productId === productId)) {
    return { ok: false, reason: 'That order doesn’t include this piece.' };
  }
  if (order.status === 'cancelled') return { ok: false, reason: 'That order was cancelled.' };
  if (['pending', 'confirmed', 'in_production'].includes(order.status)) {
    return { ok: false, reason: 'You can review a piece once it has been delivered.' };
  }

  return { ok: true, order };
}

function csv(list) {
  const head = ['id', 'createdAt', 'status', 'paymentMethod', 'paymentStatus', 'customer', 'email', 'phone', 'city', 'state', 'pincode', 'items', 'units', 'subtotal', 'discount', 'shipping', 'total', 'gst', 'cogs'];
  const rows = list.map((o) => [
    o.id, o.createdAt, o.status, o.paymentMethod, o.paymentStatus,
    o.customer.name, o.customer.email, o.customer.phone,
    o.address.city, o.address.state, o.address.pincode,
    o.items.map((it) => `${it.name} (${it.size}/${it.color}) x${it.qty}`).join(' + '),
    o.items.reduce((s, it) => s + it.qty, 0),
    o.subtotal, o.discount || 0, o.shipping, o.total, o.gstAmount || 0, o.cogs || 0
  ]);
  return [head, ...rows]
    .map((r) => r.map((c) => {
      const s = String(c === undefined || c === null ? '' : c);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(','))
    .join('\n') + '\n';
}

module.exports = {
  STATUSES, PAYMENT_METHODS, PAYMENT_STATUSES, IS_LOST,
  all, byId, create, setStatus, setPaymentStatus, markRefunded, addNote, query, csv, statusMeta, label,
  nextOrderId, isCouponOrder, attachInvoice,
  verifyPurchase
};
