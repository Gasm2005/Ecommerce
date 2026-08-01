'use strict';

const store = require('./store');

const TYPES = [
  { id: 'percent', label: '% off' },
  { id: 'flat', label: 'Flat ₹ off' },
  { id: 'freeship', label: 'Free shipping' }
];

function all() {
  return store.read('discounts', []);
}

function byCode(code) {
  const needle = String(code || '').trim().toUpperCase();
  return all().find((d) => d.code.toUpperCase() === needle) || null;
}

/**
 * Validates a code against a cart subtotal. Returns the computed discount plus a
 * human reason when it can't be applied — the reason is shown in the cart.
 */
function evaluate(code, subtotal) {
  const d = byCode(code);
  if (!d) return { ok: false, reason: 'That code isn’t recognised.' };
  if (!d.active) return { ok: false, reason: 'That code is no longer active.' };
  if (d.expiresAt && new Date(d.expiresAt + 'T23:59:59Z') < new Date()) return { ok: false, reason: 'That code has expired.' };
  if (d.usageLimit && d.used >= d.usageLimit) return { ok: false, reason: 'That code has reached its usage limit.' };
  if (d.minOrder && subtotal < d.minOrder) {
    return { ok: false, reason: `Valid on orders above ₹${d.minOrder.toLocaleString('en-IN')}.` };
  }

  const amount = d.type === 'percent' ? Math.round(subtotal * d.value / 100)
    : d.type === 'flat' ? Math.min(d.value, subtotal)
      : 0;

  return { ok: true, code: d.code, type: d.type, amount, freeShipping: d.type === 'freeship', discount: d };
}

function markUsed(code) {
  store.update('discounts', [], (list) => list.map((d) =>
    (d.code.toUpperCase() === String(code).toUpperCase() ? { ...d, used: (d.used || 0) + 1 } : d)
  ), { skipBackup: true });
}

function upsert(body) {
  const code = String(body.code || '').trim().toUpperCase();
  if (!code) throw new Error('A code is required');

  const row = {
    code,
    type: TYPES.some((t) => t.id === body.type) ? body.type : 'percent',
    value: Number(body.value) || 0,
    minOrder: Number(body.minOrder) || 0,
    expiresAt: String(body.expiresAt || '').trim() || null,
    usageLimit: Number(body.usageLimit) || 0,
    used: 0,
    active: body.active === undefined ? true : (body.active === 'on' || body.active === true || body.active === 'true'),
    note: String(body.note || '').trim()
  };

  store.update('discounts', [], (list) => {
    const idx = list.findIndex((d) => d.code.toUpperCase() === code);
    if (idx < 0) return [...list, row];
    const next = [...list];
    next[idx] = { ...next[idx], ...row, used: next[idx].used || 0 };
    return next;
  }, { skipBackup: true });

  return row;
}

function toggle(code) {
  let updated = null;
  store.update('discounts', [], (list) => list.map((d) => {
    if (d.code.toUpperCase() !== String(code).toUpperCase()) return d;
    updated = { ...d, active: !d.active };
    return updated;
  }), { skipBackup: true });
  return updated;
}

function remove(code) {
  let removed = null;
  store.update('discounts', [], (list) => {
    removed = list.find((d) => d.code.toUpperCase() === String(code).toUpperCase()) || null;
    return list.filter((d) => d.code.toUpperCase() !== String(code).toUpperCase());
  }, { skipBackup: true });
  return removed;
}

module.exports = { TYPES, all, byCode, evaluate, markUsed, upsert, toggle, remove };
