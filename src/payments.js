'use strict';

/**
 * Payments.
 *
 * Every store brings its own gateway account, so this is an adapter layer: the
 * checkout talks to one interface, the adapter talks to the gateway. Razorpay is
 * implemented; the others are declared with the same shape so adding one is a
 * single file change, not a checkout rewrite.
 *
 * An adapter implements:
 *   configured(config)                → boolean
 *   createIntent({ order, config })   → { id, amount, currency, meta }
 *   verify({ payload, config })       → { ok, paymentId, orderId, reason }
 *   verifyWebhook({ raw, signature }) → boolean
 *   refund({ paymentId, amount })     → { ok, refundId, reason }
 *
 * With no keys saved the store still works — it falls back to `manual`, which
 * records the order as awaiting payment. That keeps the template runnable out of
 * the box and gives a client a working store before their gateway is approved.
 *
 * No SDK: Razorpay's REST API over fetch, HMAC via node:crypto. One less
 * dependency to keep patched across 50 stores.
 */

const crypto = require('crypto');
const secrets = require('./secrets');

const PROVIDERS = [
  { id: 'manual', label: 'No gateway (record only)', hint: 'Orders are recorded as awaiting payment — good for COD-only or while a gateway is being approved.' },
  { id: 'razorpay', label: 'Razorpay', hint: 'UPI, cards, net banking, wallets. Keys from Dashboard → Settings → API Keys.', keys: ['keyId', 'keySecret', 'webhookSecret'] },
  { id: 'cashfree', label: 'Cashfree', hint: 'Not implemented yet — adapter stub in src/payments.js.', keys: ['appId', 'secretKey'], stub: true },
  { id: 'stripe', label: 'Stripe', hint: 'Not implemented yet — adapter stub in src/payments.js.', keys: ['publishableKey', 'secretKey', 'webhookSecret'], stub: true },
  { id: 'payu', label: 'PayU', hint: 'Not implemented yet — adapter stub in src/payments.js.', keys: ['merchantKey', 'salt'], stub: true }
];

function settings(config) {
  const p = (config && config.payments) || {};
  return {
    provider: p.provider || 'manual',
    mode: p.mode === 'live' ? 'live' : 'test',
    currency: (config && config.currency && config.currency.code) || 'INR',
    companyName: (config && config.brand && config.brand.name) || 'Store',
    themeColor: (config && config.theme && config.theme.colors && config.theme.colors.maroon) || '#6B1B2B',
    autoCapture: p.autoCapture !== false,
    // What to charge now. Partial COD only charges the advance.
    partialCodChargesAdvance: p.partialCodChargesAdvance !== false
  };
}

function providerMeta(id) {
  return PROVIDERS.find((p) => p.id === id) || PROVIDERS[0];
}

/* ------------------------------------------------------------- razorpay ---- */

const RZP_API = 'https://api.razorpay.com/v1';

const razorpay = {
  id: 'razorpay',

  keys() {
    return {
      keyId: secrets.get('payments.razorpay.keyId'),
      keySecret: secrets.get('payments.razorpay.keySecret'),
      webhookSecret: secrets.get('payments.razorpay.webhookSecret')
    };
  },

  configured() {
    const k = this.keys();
    return !!(k.keyId && k.keySecret);
  },

  auth() {
    const k = this.keys();
    return 'Basic ' + Buffer.from(`${k.keyId}:${k.keySecret}`).toString('base64');
  },

  async call(method, path, body) {
    const res = await fetch(RZP_API + path, {
      method,
      headers: {
        Authorization: this.auth(),
        'Content-Type': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000)
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (json.error && (json.error.description || json.error.reason)) || `HTTP ${res.status}`;
      throw new Error('Razorpay: ' + msg);
    }
    return json;
  },

  /** Creates the gateway-side order the browser checkout attaches to. */
  async createIntent({ amountPaise, receipt, notes, config }) {
    const s = settings(config);
    const rzpOrder = await this.call('POST', '/orders', {
      amount: amountPaise,
      currency: s.currency,
      receipt: String(receipt).slice(0, 40),
      payment_capture: s.autoCapture ? 1 : 0,
      notes: notes || {}
    });
    return {
      id: rzpOrder.id,
      amount: rzpOrder.amount,
      currency: rzpOrder.currency,
      keyId: this.keys().keyId
    };
  },

  /**
   * Verifies the browser callback. Razorpay signs
   * `${order_id}|${payment_id}` with the key secret — if that HMAC doesn't match,
   * the response was forged and the order must not be created.
   */
  verify({ payload }) {
    const orderId = payload.razorpay_order_id;
    const paymentId = payload.razorpay_payment_id;
    const signature = payload.razorpay_signature;
    if (!orderId || !paymentId || !signature) return { ok: false, reason: 'Incomplete payment response.' };

    const expected = crypto
      .createHmac('sha256', this.keys().keySecret)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');

    const ok = expected.length === signature.length &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));

    return ok
      ? { ok: true, paymentId, gatewayOrderId: orderId }
      : { ok: false, reason: 'Payment signature did not verify.' };
  },

  /** Server-to-server webhook (the source of truth when a browser dies mid-redirect). */
  verifyWebhook({ raw, signature }) {
    const secret = this.keys().webhookSecret;
    if (!secret || !signature) return false;
    const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
    return expected.length === signature.length &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  },

  async fetchPayment(paymentId) {
    return this.call('GET', '/payments/' + paymentId);
  },

  async refund({ paymentId, amountPaise, notes }) {
    const body = { notes: notes || {} };
    if (amountPaise) body.amount = amountPaise;
    const r = await this.call('POST', `/payments/${paymentId}/refund`, body);
    return { ok: true, refundId: r.id, amount: r.amount };
  },

  /** Cheap credential check for the admin "test connection" button. */
  async test() {
    await this.call('GET', '/orders?count=1');
    return { ok: true, message: 'Keys accepted by Razorpay.' };
  }
};

/* --------------------------------------------------------------- manual ---- */

const manual = {
  id: 'manual',
  configured: () => true,
  async createIntent() { return null; },
  verify: () => ({ ok: true, paymentId: null }),
  verifyWebhook: () => false,
  async refund() { return { ok: false, reason: 'No gateway configured — refund the customer manually.' }; },
  async test() { return { ok: true, message: 'No gateway — orders are recorded as awaiting payment.' }; }
};

/* ---------------------------------------------------------------- stubs ---- */
/* Same shape, so wiring one up is a single file change. */

function stub(id, label) {
  return {
    id,
    configured: () => false,
    async createIntent() { throw new Error(`${label} adapter is not implemented yet.`); },
    verify: () => ({ ok: false, reason: `${label} adapter is not implemented yet.` }),
    verifyWebhook: () => false,
    async refund() { return { ok: false, reason: `${label} adapter is not implemented yet.` }; },
    async test() { throw new Error(`${label} adapter is not implemented yet.`); }
  };
}

const ADAPTERS = {
  manual,
  razorpay,
  cashfree: stub('cashfree', 'Cashfree'),
  stripe: stub('stripe', 'Stripe'),
  payu: stub('payu', 'PayU')
};

/* ------------------------------------------------------------ public API ---- */

function adapterFor(config) {
  const s = settings(config);
  const adapter = ADAPTERS[s.provider] || manual;
  // A provider selected but not keyed falls back to manual rather than failing a
  // checkout — a half-configured store still takes orders.
  if (s.provider !== 'manual' && !adapter.configured()) return manual;
  return adapter;
}

function status(config) {
  const s = settings(config);
  const meta = providerMeta(s.provider);
  const adapter = ADAPTERS[s.provider] || manual;
  const ready = s.provider === 'manual' ? true : adapter.configured();
  return {
    provider: s.provider,
    label: meta.label,
    mode: s.mode,
    ready,
    live: s.provider !== 'manual' && ready,
    stub: !!meta.stub,
    reason: s.provider === 'manual'
      ? 'No gateway connected — orders are recorded as awaiting payment.'
      : (ready ? null : `${meta.label} keys are not saved yet.`)
  };
}

/**
 * How much to charge online for this cart. Partial COD only takes the advance;
 * full COD takes nothing.
 */
function payableNow({ cartSummary, codPlan, config }) {
  const s = settings(config);
  if (!codPlan || codPlan.type === 'prepaid') return cartSummary.total;
  if (codPlan.type === 'partial-cod') return s.partialCodChargesAdvance ? codPlan.advancePaid : 0;
  return 0; // full COD
}

async function createIntent({ cartSummary, codPlan, config, receipt, customer }) {
  const amount = payableNow({ cartSummary, codPlan, config });
  if (amount <= 0) return null;

  const adapter = adapterFor(config);
  if (adapter.id === 'manual') return null;

  const intent = await adapter.createIntent({
    amountPaise: Math.round(amount * 100),
    receipt,
    notes: {
      customer: (customer && customer.name) || '',
      phone: (customer && customer.phone) || '',
      plan: codPlan ? codPlan.type : 'prepaid'
    },
    config
  });

  return intent ? { ...intent, provider: adapter.id, amountRupees: amount } : null;
}

function verify({ payload, config }) {
  return adapterFor(config).verify({ payload, config });
}

function verifyWebhook({ raw, signature, config }) {
  return adapterFor(config).verifyWebhook({ raw, signature });
}

async function refund({ paymentId, amount, config, notes }) {
  const adapter = adapterFor(config);
  if (!paymentId) return { ok: false, reason: 'This order has no gateway payment to refund.' };
  return adapter.refund({ paymentId, amountPaise: amount ? Math.round(amount * 100) : undefined, notes });
}

async function test(config) {
  return adapterFor(config).test();
}

module.exports = { PROVIDERS, providerMeta, settings, status, payableNow, createIntent, verify, verifyWebhook, refund, test, adapterFor };
