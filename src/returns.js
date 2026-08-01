'use strict';

/**
 * Returns and refunds.
 *
 * A customer raises a request from /returns with their order number and the
 * contact on the order (same verification as reviews — no account needed). The
 * admin approves, marks it received, then refunds. Only a refund marked here
 * moves money in the P&L, so "refunds" on the dashboard is what was actually
 * paid back, not what was asked for.
 */

const store = require('./store');
const orders = require('./orders');

const STATUSES = [
  { id: 'requested', label: 'Requested', tone: 'warning', hint: 'Waiting on your decision' },
  { id: 'approved', label: 'Approved', tone: 'info', hint: 'Pickup arranged' },
  { id: 'received', label: 'Received', tone: 'info', hint: 'Back with the atelier, inspected' },
  { id: 'refunded', label: 'Refunded', tone: 'good', hint: 'Money returned' },
  { id: 'rejected', label: 'Rejected', tone: 'critical', hint: 'Outside policy' }
];

const REASONS = [
  'Size or fit',
  'Not as pictured',
  'Damaged or defective',
  'Wrong item delivered',
  'Late delivery',
  'Changed my mind',
  'Other'
];

const METHODS = [
  { id: 'original', label: 'Back to original payment method' },
  { id: 'bank', label: 'Bank transfer' },
  { id: 'store-credit', label: 'Store credit' }
];

function all() {
  return store.read('returns', []);
}

function byId(id) {
  return all().find((r) => r.id === id) || null;
}

function forOrder(orderId) {
  return all().filter((r) => r.orderId === orderId);
}

function statusMeta(id) {
  return STATUSES.find((s) => s.id === id) || { id, label: id, tone: 'info' };
}

/**
 * Can this order still be returned? Uses the delivery date from the timeline
 * where available, falling back to the order date.
 */
function eligibility(order, config) {
  if (!order) return { ok: false, reason: 'Order not found.' };
  if (order.status === 'cancelled') return { ok: false, reason: 'That order was cancelled.' };
  if (order.status !== 'delivered' && order.status !== 'returned') {
    return { ok: false, reason: 'Returns open once the order has been delivered. Track it or call us if something is wrong.' };
  }

  const existing = forOrder(order.id).filter((r) => r.status !== 'rejected');
  if (existing.length) {
    return { ok: false, reason: `A return is already open on this order (${existing[0].id}).`, existing: existing[0] };
  }

  const days = (config.shipping && config.shipping.returnWindowDays) || 7;
  const delivered = (order.timeline || []).slice().reverse().find((t) => /delivered/i.test(t.label));
  const deliveredAt = new Date(delivered ? delivered.at : order.createdAt);
  const deadline = new Date(deliveredAt.getTime() + days * 24 * 3600 * 1000);

  if (Date.now() > deadline.getTime()) {
    return { ok: false, reason: `The ${days}-day return window closed on ${deadline.toDateString().slice(4)}.`, deadline };
  }
  return { ok: true, deadline, deliveredAt };
}

/** Creates a request. Amount is what the returned lines are worth. */
function create({ order, itemKeys, reason, note, media, method }) {
  const chosen = (order.items || []).filter((it, i) => itemKeys.includes(String(i)));
  const items = (chosen.length ? chosen : order.items).map((it, i) => ({
    productId: it.productId,
    slug: it.slug,
    name: it.name,
    size: it.size,
    color: it.color,
    qty: it.qty,
    price: it.price,
    lineTotal: it.price * it.qty
  }));

  const requested = items.reduce((s, it) => s + it.lineTotal, 0);
  // Never propose more than was actually charged.
  const cap = order.total;
  const now = new Date().toISOString();

  const row = {
    id: store.nextId('RET', all()),
    orderId: order.id,
    customer: { name: order.customer.name, email: order.customer.email, phone: order.customer.phone },
    items,
    reason: reason || 'Other',
    note: String(note || '').slice(0, 800),
    media: Array.isArray(media) ? media : [],
    method: METHODS.some((m) => m.id === method) ? method : 'original',
    status: 'requested',
    requestedAmount: Math.min(requested, cap),
    refundAmount: null,
    requestedAt: now,
    updatedAt: now,
    timeline: [{ at: now, label: 'Return requested by customer' }]
  };

  store.update('returns', [], (list) => [...list, row], { skipBackup: true });
  return row;
}

/**
 * Advances a request. Refunding writes the amount back onto the order and flips
 * it to `returned`, which is what pulls the money out of net sales.
 */
function setStatus(id, status, { amount, note } = {}) {
  if (!STATUSES.some((s) => s.id === status)) throw new Error('Unknown return status');
  let updated = null;

  store.update('returns', [], (list) => list.map((r) => {
    if (r.id !== id) return r;
    const now = new Date().toISOString();
    const refundAmount = status === 'refunded'
      ? Math.max(0, Math.min(Number(amount) || r.requestedAmount, r.requestedAmount))
      : r.refundAmount;

    updated = {
      ...r,
      status,
      refundAmount,
      updatedAt: now,
      timeline: [...(r.timeline || []), {
        at: now,
        label: note || ('Marked ' + statusMeta(status).label.toLowerCase() +
          (status === 'refunded' ? ' — ₹' + (refundAmount || 0).toLocaleString('en-IN') : ''))
      }]
    };
    return updated;
  }), { skipBackup: true });

  if (updated && status === 'refunded') {
    orders.markRefunded(updated.orderId, updated.refundAmount, updated.id);
  }
  return updated;
}

function remove(id) {
  let removed = null;
  store.update('returns', [], (list) => {
    removed = list.find((r) => r.id === id) || null;
    return list.filter((r) => r.id !== id);
  }, { skipBackup: true });
  if (removed && removed.media && removed.media.length) {
    require('./uploads').removeMedia(removed.media);
  }
  return removed;
}

function query({ status, q } = {}) {
  let list = all().slice().sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  if (status) list = list.filter((r) => r.status === status);
  if (q) {
    const needle = String(q).toLowerCase();
    list = list.filter((r) =>
      r.id.toLowerCase().includes(needle) ||
      r.orderId.toLowerCase().includes(needle) ||
      r.customer.name.toLowerCase().includes(needle) ||
      r.customer.email.toLowerCase().includes(needle) ||
      r.items.some((it) => it.name.toLowerCase().includes(needle))
    );
  }
  return list;
}

function overview() {
  const list = all();
  const refunded = list.filter((r) => r.status === 'refunded');
  return {
    total: list.length,
    open: list.filter((r) => ['requested', 'approved', 'received'].includes(r.status)).length,
    requested: list.filter((r) => r.status === 'requested').length,
    refundedCount: refunded.length,
    refundedValue: refunded.reduce((s, r) => s + (r.refundAmount || 0), 0),
    pendingValue: list.filter((r) => ['requested', 'approved', 'received'].includes(r.status))
      .reduce((s, r) => s + (r.requestedAmount || 0), 0),
    byReason: REASONS.map((reason) => ({ reason, count: list.filter((r) => r.reason === reason).length })).filter((x) => x.count)
  };
}

function csv(list) {
  const head = ['id', 'orderId', 'requestedAt', 'status', 'reason', 'customer', 'email', 'phone', 'items', 'requestedAmount', 'refundAmount', 'method', 'note'];
  const rows = list.map((r) => [
    r.id, r.orderId, r.requestedAt, r.status, r.reason,
    r.customer.name, r.customer.email, r.customer.phone,
    r.items.map((it) => `${it.name} x${it.qty}`).join(' + '),
    r.requestedAmount, r.refundAmount === null ? '' : r.refundAmount, r.method, r.note
  ]);
  return [head, ...rows]
    .map((row) => row.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c))).join(','))
    .join('\n') + '\n';
}

module.exports = { STATUSES, REASONS, METHODS, all, byId, forOrder, statusMeta, eligibility, create, setStatus, remove, query, overview, csv };
