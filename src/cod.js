'use strict';

/**
 * Cash-on-delivery rules.
 *
 * Three separate switches, because they're separate decisions:
 *   cod.enabled        — COD offered at all
 *   cod.fullEnabled    — pay nothing now, everything on delivery (off by default;
 *                        it carries the whole RTO risk, so the owner opens it
 *                        deliberately)
 *   cod.partialEnabled — pay an advance now, the rest on delivery
 *
 * Plus serviceability: block pincodes outright, block by prefix (a whole region),
 * or run an allow-list where COD works nowhere except the listed pincodes.
 */

function codConfig(config) {
  const c = (config.shipping && config.shipping.cod) || {};
  return {
    enabled: c.enabled !== false,
    fullEnabled: !!c.fullEnabled,
    partialEnabled: c.partialEnabled !== false,
    advanceType: c.advanceType === 'flat' ? 'flat' : 'percent',
    advancePercent: Number.isFinite(c.advancePercent) ? c.advancePercent : 20,
    advanceFlat: Number.isFinite(c.advanceFlat) ? c.advanceFlat : 2000,
    minOrder: Number.isFinite(c.minOrder) ? c.minOrder : 0,
    maxOrder: Number.isFinite(c.maxOrder) ? c.maxOrder : 0,
    // 'block-list' → COD everywhere except the blocked entries.
    // 'allow-list'  → COD ONLY at allowedPincodesOnly.
    pincodeMode: c.pincodeMode === 'allow-list' ? 'allow-list' : 'block-list',
    blockedPincodes: c.blockedPincodes || [],
    blockedPrefixes: c.blockedPrefixes || [],
    allowedPincodesOnly: c.allowedPincodesOnly || []
  };
}

/** Advance payable now on a partial-COD order. */
function advanceFor(total, cfg) {
  const raw = cfg.advanceType === 'flat'
    ? cfg.advanceFlat
    : Math.round(total * cfg.advancePercent / 100);
  // Never ask for more than the order, and never for a token amount.
  return Math.max(0, Math.min(total, raw));
}

/** Is COD serviceable at this pincode? Returns a reason when it isn't. */
function pincodeCheck(pincode, cfg) {
  const pin = String(pincode || '').replace(/\D/g, '');
  if (!pin) return { ok: true, unknown: true };

  // Allow-list mode: COD works nowhere except the listed pincodes.
  if (cfg.pincodeMode === 'allow-list') {
    if (!cfg.allowedPincodesOnly.length) {
      return { ok: false, reason: 'Cash on delivery is limited to selected pincodes.' };
    }
    const ok = cfg.allowedPincodesOnly.map(String).some((entry) => pin === entry || (entry.length < 6 && pin.startsWith(entry)));
    return ok ? { ok: true } : { ok: false, reason: `Cash on delivery isn’t serviceable at ${pin} — prepaid only.` };
  }
  if (cfg.blockedPincodes.map(String).includes(pin)) {
    return { ok: false, reason: `Cash on delivery isn’t available at ${pin}.` };
  }
  const prefix = cfg.blockedPrefixes.map(String).find((p) => p && pin.startsWith(p));
  if (prefix) {
    return { ok: false, reason: `Cash on delivery isn’t available in this region (pincodes starting ${prefix}).` };
  }
  return { ok: true };
}

/**
 * Full COD/partial-COD availability for a specific cart + address.
 * Everything the checkout needs to render the payment step.
 */
function evaluate(config, { pincode, total }) {
  const cfg = codConfig(config);
  const amount = Number(total) || 0;

  const base = {
    config: cfg,
    fullAllowed: false,
    partialAllowed: false,
    advance: advanceFor(amount, cfg),
    dueOnDelivery: 0,
    reason: null,
    pincode: String(pincode || '').replace(/\D/g, '') || null
  };
  base.dueOnDelivery = Math.max(0, amount - base.advance);

  if (!cfg.enabled) return { ...base, reason: 'Cash on delivery is currently switched off.' };

  if (cfg.minOrder && amount < cfg.minOrder) {
    return { ...base, reason: `Cash on delivery starts at ₹${cfg.minOrder.toLocaleString('en-IN')}.` };
  }
  if (cfg.maxOrder && amount > cfg.maxOrder) {
    return { ...base, reason: `Cash on delivery is unavailable above ₹${cfg.maxOrder.toLocaleString('en-IN')} — this order is ₹${amount.toLocaleString('en-IN')}.` };
  }

  const pin = pincodeCheck(pincode, cfg);
  if (!pin.ok) return { ...base, reason: pin.reason };

  return {
    ...base,
    fullAllowed: cfg.fullEnabled,
    partialAllowed: cfg.partialEnabled,
    reason: (!cfg.fullEnabled && !cfg.partialEnabled) ? 'Cash on delivery is currently switched off.' : null,
    pincodeUnknown: !!pin.unknown
  };
}

/** The payment plan stored on the order. */
function planFor(config, { method, pincode, total }) {
  const check = evaluate(config, { pincode, total });
  const amount = Number(total) || 0;

  if (method === 'cod') {
    if (!check.fullAllowed) return null;
    return { type: 'full-cod', advancePaid: 0, dueOnDelivery: amount };
  }
  if (method === 'cod-partial') {
    if (!check.partialAllowed) return null;
    return { type: 'partial-cod', advancePaid: check.advance, dueOnDelivery: check.dueOnDelivery };
  }
  return { type: 'prepaid', advancePaid: amount, dueOnDelivery: 0 };
}

/** Total still to collect on delivery across a set of orders. */
function outstanding(orderList) {
  return (orderList || []).reduce((sum, o) => {
    if (!o.codPlan || o.paymentStatus === 'paid' || o.status === 'cancelled' || o.status === 'returned') return sum;
    return sum + (o.codPlan.dueOnDelivery || 0);
  }, 0);
}

module.exports = { codConfig, advanceFor, pincodeCheck, evaluate, planFor, outstanding };
