'use strict';

/**
 * Transactional messages — email now, WhatsApp/SMS through the same door.
 *
 * Same adapter shape as payments, for the same reason: every store brings its
 * own sending account. The client pastes credentials once and the app never
 * changes.
 *
 *   SMTP      — Gmail / Zoho / Hostinger / any host. What most small stores have.
 *   Resend    — HTTP API, no SMTP ports needed (good on locked-down hosts)
 *   Brevo     — HTTP API, generous free tier, popular in India
 *   log       — writes to the console. The default, so a fresh install never
 *               silently fails to send and never accidentally emails anyone.
 *
 * Bodies are EJS templates in views/emails/, so a client's wording and colours
 * follow their theme without touching this file.
 */

const path = require('path');
const ejs = require('ejs');
const secrets = require('./secrets');
const store = require('./store');

const EMAIL_PROVIDERS = [
  { id: 'log', label: 'Log only (nothing is sent)', hint: 'Default. Messages are printed to the server log so you can see what would go out.' },
  { id: 'smtp', label: 'SMTP (Gmail, Zoho, Hostinger…)', hint: 'Host, port, user, password. For Gmail use an App Password, not the account password.', keys: ['host', 'port', 'user', 'pass'] },
  { id: 'resend', label: 'Resend', hint: 'One API key. Verify the sending domain in Resend first.', keys: ['apiKey'] },
  { id: 'brevo', label: 'Brevo (Sendinblue)', hint: 'One API key from Brevo → SMTP & API.', keys: ['apiKey'] }
];

const WHATSAPP_PROVIDERS = [
  { id: 'off', label: 'Off', hint: 'No WhatsApp messages.' },
  { id: 'interakt', label: 'Interakt', hint: 'Secret key from Interakt → Developer settings.', keys: ['apiKey'] },
  { id: 'gupshup', label: 'Gupshup', hint: 'API key and the registered source number.', keys: ['apiKey', 'source', 'appName'] }
];

/** Every message the store can send. Templates live in views/emails/<template>.ejs */
const EVENTS = [
  { id: 'order.placed', label: 'Order confirmation', to: 'customer', template: 'order-placed', default: true },
  { id: 'order.placed.admin', label: 'New order alert', to: 'store', template: 'order-placed-admin', default: true },
  { id: 'order.shipped', label: 'Order shipped', to: 'customer', template: 'order-status', default: true },
  { id: 'order.delivered', label: 'Order delivered', to: 'customer', template: 'order-status', default: false },
  { id: 'order.cancelled', label: 'Order cancelled', to: 'customer', template: 'order-status', default: true },
  { id: 'return.requested', label: 'Return received (to customer)', to: 'customer', template: 'return-status', default: true },
  { id: 'return.requested.admin', label: 'Return alert (to store)', to: 'store', template: 'return-status-admin', default: true },
  { id: 'return.refunded', label: 'Refund processed', to: 'customer', template: 'return-status', default: true },
  { id: 'review.published', label: 'Review published', to: 'customer', template: 'generic', default: false }
];

function settings(config) {
  const n = (config && config.notifications) || {};
  return {
    emailProvider: n.emailProvider || 'log',
    whatsappProvider: n.whatsappProvider || 'off',
    fromName: n.fromName || (config && config.brand && config.brand.name) || 'Store',
    fromEmail: n.fromEmail || '',
    replyTo: n.replyTo || (config && config.brand && config.brand.supportEmail) || '',
    storeEmail: n.storeEmail || (config && config.brand && config.brand.supportEmail) || '',
    storePhone: n.storePhone || (config && config.brand && config.brand.supportPhone) || '',
    events: n.events || {}
  };
}

/**
 * Per-event switches apply only to the listed store events. Anything not in the
 * list is system mail — password resets, test sends — and always goes out; those
 * must not be silently disableable from a settings screen.
 */
function isEnabled(eventId, config) {
  const s = settings(config);
  if (s.events[eventId] !== undefined) return !!s.events[eventId];
  const def = EVENTS.find((e) => e.id === eventId);
  return def ? def.default : true;
}

/* ----------------------------------------------------------- adapters ---- */

const email = {
  async log({ to, subject, html, text }) {
    console.log(`\n  ✉  [log-only] to: ${to}\n     subject: ${subject}\n     ${(text || html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)}…\n`);
    return { ok: true, id: 'log', logged: true };
  },

  async smtp({ to, subject, html, text, from, replyTo }) {
    const nodemailer = require('nodemailer');
    const host = secrets.get('notifications.smtp.host');
    const port = Number(secrets.get('notifications.smtp.port')) || 587;
    const user = secrets.get('notifications.smtp.user');
    const pass = secrets.get('notifications.smtp.pass');
    if (!host || !user || !pass) throw new Error('SMTP host, user and password are required.');

    const transport = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,          // 465 = implicit TLS, 587 = STARTTLS
      auth: { user, pass },
      connectionTimeout: 15000
    });

    const info = await transport.sendMail({ from, to, replyTo, subject, html, text });
    return { ok: true, id: info.messageId };
  },

  async resend({ to, subject, html, text, from, replyTo }) {
    const key = secrets.get('notifications.resend.apiKey');
    if (!key) throw new Error('Resend API key is not saved.');
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, html, text, reply_to: replyTo || undefined }),
      signal: AbortSignal.timeout(15000)
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error('Resend: ' + (json.message || `HTTP ${res.status}`));
    return { ok: true, id: json.id };
  },

  async brevo({ to, subject, html, text, fromName, fromEmail, replyTo }) {
    const key = secrets.get('notifications.brevo.apiKey');
    if (!key) throw new Error('Brevo API key is not saved.');
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': key, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: { name: fromName, email: fromEmail },
        to: [{ email: to }],
        replyTo: replyTo ? { email: replyTo } : undefined,
        subject,
        htmlContent: html,
        textContent: text
      }),
      signal: AbortSignal.timeout(15000)
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error('Brevo: ' + (json.message || `HTTP ${res.status}`));
    return { ok: true, id: json.messageId };
  }
};

const whatsapp = {
  async off() { return { ok: true, skipped: true }; },

  async interakt({ phone, template, variables }) {
    const key = secrets.get('notifications.interakt.apiKey');
    if (!key) throw new Error('Interakt API key is not saved.');
    const res = await fetch('https://api.interakt.ai/v1/public/message/', {
      method: 'POST',
      headers: { Authorization: 'Basic ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        countryCode: '+91',
        phoneNumber: String(phone).replace(/\D/g, '').slice(-10),
        type: 'Template',
        template: { name: template, languageCode: 'en', bodyValues: variables || [] }
      }),
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) throw new Error('Interakt: HTTP ' + res.status);
    return { ok: true };
  },

  async gupshup({ phone, message }) {
    const key = secrets.get('notifications.gupshup.apiKey');
    const source = secrets.get('notifications.gupshup.source');
    const appName = secrets.get('notifications.gupshup.appName');
    if (!key || !source) throw new Error('Gupshup API key and source number are required.');
    const body = new URLSearchParams({
      channel: 'whatsapp',
      source,
      destination: String(phone).replace(/\D/g, '').slice(-12),
      'src.name': appName || '',
      message: JSON.stringify({ type: 'text', text: message })
    });
    const res = await fetch('https://api.gupshup.io/wa/api/v1/msg', {
      method: 'POST',
      headers: { apikey: key, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) throw new Error('Gupshup: HTTP ' + res.status);
    return { ok: true };
  }
};

/* ------------------------------------------------------------- sending ---- */

function templatePath(name) {
  return path.join(__dirname, '..', 'views', 'emails', name + '.ejs');
}

async function render(template, data) {
  return ejs.renderFile(templatePath(template), data, { async: false });
}

/** Strips tags for the plain-text part — some clients still prefer it. */
function toText(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/(p|div|tr|h1|h2|h3|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#8377;|&rupee;/g, '₹')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
}

function logDelivery(entry) {
  store.update('notifications', [], (list) => [{ at: new Date().toISOString(), ...entry }, ...list].slice(0, 300), { skipBackup: true });
}

/**
 * Sends one message. Never throws into a request — a mail outage must not stop a
 * customer completing checkout. Failures are logged and shown in the admin.
 */
async function send({ event, to, subject, template, data, config, phone, whatsappText }) {
  const s = settings(config);
  const result = { event, to, subject, ok: false, provider: s.emailProvider };

  if (!isEnabled(event, config)) {
    return { ...result, ok: true, skipped: 'event turned off' };
  }
  if (!to) {
    return { ...result, ok: true, skipped: 'no address on the order' };
  }

  try {
    const html = await render(template, { ...data, config, brand: config.brand, settings: s });
    const from = s.fromEmail ? `${s.fromName} <${s.fromEmail}>` : s.fromName;

    const adapter = email[s.emailProvider] || email.log;
    const sent = await adapter({
      to, subject, html, text: toText(html),
      from, fromName: s.fromName, fromEmail: s.fromEmail, replyTo: s.replyTo
    });

    result.ok = true;
    result.id = sent.id;
    result.logged = !!sent.logged;
  } catch (err) {
    result.error = err.message;
  }

  // WhatsApp is best-effort and independent of the email result.
  if (phone && s.whatsappProvider !== 'off' && whatsappText) {
    try {
      await (whatsapp[s.whatsappProvider] || whatsapp.off)({ phone, message: whatsappText, template: event.replace(/\./g, '_'), variables: [whatsappText] });
      result.whatsapp = 'sent';
    } catch (err) {
      result.whatsapp = 'failed: ' + err.message;
    }
  }

  logDelivery(result);
  return result;
}

/* ------------------------------------------------------- event helpers ---- */

const money = (n, config) => (config.currency.symbol) + Number(n || 0).toLocaleString(config.currency.locale || 'en-IN');

async function orderPlaced(order, config, origin) {
  const s = settings(config);
  const out = [];

  out.push(await send({
    event: 'order.placed',
    to: order.customer.email,
    phone: order.customer.phone,
    subject: `Order ${order.id} confirmed · ${config.brand.name}`,
    template: 'order-placed',
    data: { order, origin: origin || '', fulfilment: require('./fulfilment') },
    config,
    whatsappText: `Thank you! Order ${order.id} is confirmed — ${money(order.total, config)}. We'll message you when it ships.`
  }));

  out.push(await send({
    event: 'order.placed.admin',
    to: s.storeEmail,
    subject: `New order ${order.id} · ${money(order.total, config)}`,
    template: 'order-placed-admin',
    data: { order },
    config
  }));

  return out;
}

async function orderStatus(order, status, config) {
  const map = {
    shipped: { event: 'order.shipped', line: 'Your order is on its way.' },
    delivered: { event: 'order.delivered', line: 'Your order has been delivered.' },
    cancelled: { event: 'order.cancelled', line: 'Your order has been cancelled.' }
  };
  const meta = map[status];
  if (!meta) return null;

  return send({
    event: meta.event,
    to: order.customer.email,
    phone: order.customer.phone,
    subject: `Order ${order.id} — ${status} · ${config.brand.name}`,
    template: 'order-status',
    data: { order, status, headline: meta.line },
    config,
    whatsappText: `${meta.line} Order ${order.id}.`
  });
}

async function returnUpdate(request, order, config) {
  const s = settings(config);
  const refunded = request.status === 'refunded';
  const out = [];

  out.push(await send({
    event: refunded ? 'return.refunded' : 'return.requested',
    to: request.customer.email,
    phone: request.customer.phone,
    subject: refunded
      ? `Refund of ${money(request.refundAmount, config)} processed · ${request.id}`
      : `Return ${request.id} received · ${config.brand.name}`,
    template: 'return-status',
    data: { request, order },
    config,
    whatsappText: refunded
      ? `Refund of ${money(request.refundAmount, config)} for ${request.orderId} has been processed.`
      : `We've received your return request ${request.id}. We'll confirm within a day.`
  }));

  if (!refunded) {
    out.push(await send({
      event: 'return.requested.admin',
      to: s.storeEmail,
      subject: `Return requested — ${request.id} on ${request.orderId}`,
      template: 'return-status-admin',
      data: { request, order },
      config
    }));
  }

  return out;
}

/** Admin "send test" button. Deliberately bypasses the per-event switches. */
/**
 * A published review, back to whoever wrote it.
 *
 * This event has been in the settings list since the start with nothing sending it —
 * an owner could switch "Review published" on and receive silence forever. A switch
 * that does nothing is worse than a missing feature: it spends the owner's trust in
 * every other switch on the screen.
 *
 * The address comes from the ORDER, not the review: reviews only carry a display name.
 */
async function reviewPublished(review, config) {
  const order = review && review.orderId ? require('./orders').byId(review.orderId) : null;
  const to = order && order.customer && order.customer.email;
  if (!to) return null;

  const product = require('./catalog').all().find((p) => p.id === review.productId);
  const name = (product && product.name) || 'your piece';

  return send({
    event: 'review.published',
    to,
    subject: `Your review of ${name} is live · ${config.brand.name}`,
    template: 'generic',
    data: {
      headline: 'Thank you for the review',
      body: `Your review of ${name} is now on the product page${review.rating ? ` — ${review.rating} out of 5` : ''}. ` +
            'It helps the next person buying it more than anything we could write ourselves.'
    },
    config
  });
}

async function sendTest(to, config) {
  const s = settings(config);
  try {
    const html = await render('generic', {
      config,
      brand: config.brand,
      settings: s,
      headline: 'Test message',
      body: `If you're reading this, ${config.brand.name} can send email through ${s.emailProvider}. Sent ${new Date().toLocaleString('en-IN')}.`
    });
    const from = s.fromEmail ? `${s.fromName} <${s.fromEmail}>` : s.fromName;
    const adapter = email[s.emailProvider] || email.log;
    const sent = await adapter({ to, subject: `Test from ${config.brand.name}`, html, text: toText(html), from, fromName: s.fromName, fromEmail: s.fromEmail, replyTo: s.replyTo });
    logDelivery({ event: 'test', to, ok: true, provider: s.emailProvider, id: sent.id });
    return { ok: true, logged: !!sent.logged, provider: s.emailProvider };
  } catch (err) {
    logDelivery({ event: 'test', to, ok: false, provider: s.emailProvider, error: err.message });
    return { ok: false, error: err.message };
  }
}

function recent(n = 25) {
  return store.read('notifications', []).slice(0, n);
}

/**
 * Is mail actually going out?
 *
 * status() answers whether it is CONFIGURED, which is a different question and the
 * less useful one after launch. An SMTP password expires, a Resend key gets revoked,
 * a sending domain loses its DNS record — credentials are still present, so every
 * check keeps saying "ready" while not one confirmation reaches a customer. Nobody
 * finds out until somebody rings to ask where their order went.
 *
 * So this reads the delivery log instead of the settings: what failed, how recently,
 * and whether anything has succeeded since.
 *
 * Skipped sends are not failures. An event switched off, or an order with no email on
 * it, is the shop working as configured.
 */
function health(window = 20) {
  const rows = recent(window).filter((r) => !r.skipped);
  const failures = rows.filter((r) => !r.ok);
  const lastOk = rows.find((r) => r.ok) || null;
  const lastFailure = failures[0] || null;

  /* "Broken" is every attempt since the last success having failed, not merely one
     bad row: a single timeout on a flaky network is noise, and warning about it
     teaches an owner to ignore the warning. */
  const sinceSuccess = [];
  for (const r of rows) {
    if (r.ok) break;
    sinceSuccess.push(r);
  }

  return {
    attempts: rows.length,
    failed: failures.length,
    consecutiveFailures: sinceSuccess.length,
    broken: sinceSuccess.length >= 2,
    lastOk,
    lastFailure,
    // The same message repeated is one problem, and it is the one worth printing.
    reason: lastFailure ? lastFailure.error || 'unknown error' : null
  };
}

function status(config) {
  const s = settings(config);
  const provider = EMAIL_PROVIDERS.find((p) => p.id === s.emailProvider) || EMAIL_PROVIDERS[0];
  const needs = provider.keys || [];
  const missing = needs.filter((k) => !secrets.has(`notifications.${s.emailProvider}.${k}`));
  return {
    provider: s.emailProvider,
    label: provider.label,
    ready: s.emailProvider === 'log' ? true : (missing.length === 0 && !!s.fromEmail),
    missing,
    needsFrom: !s.fromEmail && s.emailProvider !== 'log',
    whatsapp: s.whatsappProvider,
    lastFailure: recent(50).find((r) => !r.ok) || null
  };
}

module.exports = {
  EMAIL_PROVIDERS, WHATSAPP_PROVIDERS, EVENTS,
  settings, status, health, isEnabled, send, sendTest, recent,
  orderPlaced, orderStatus, returnUpdate, reviewPublished
};
