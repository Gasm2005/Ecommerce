'use strict';

/**
 * Campaign attribution.
 *
 * Any visit carrying `?utm_source=…` (or the shorthand `?ref=…`) is remembered in
 * a cookie for 30 days, first touch and last touch. When the order is placed both
 * are stored on it, so the dashboard can answer "did that influencer post sell
 * anything?" instead of guessing from a traffic spike.
 *
 * Example link to hand an influencer:
 *   https://yourstore.com/?utm_source=instagram&utm_medium=influencer&utm_campaign=diya-oct&ref=diya
 */

const COOKIE = 'aanya_attr';
const OPTS = { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 1000 * 60 * 60 * 24 * 30 };

const FIELDS = ['source', 'medium', 'campaign', 'content', 'term'];

function clean(v) {
  return String(v || '').trim().toLowerCase().slice(0, 60).replace(/[^a-z0-9._\- ]/g, '');
}

function read(req) {
  try {
    const raw = req.cookies && req.cookies[COOKIE];
    if (!raw) return null;
    const parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function write(req, res, value) {
  const encoded = Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
  res.cookie(COOKIE, encoded, OPTS);
  if (req.cookies) req.cookies[COOKIE] = encoded;
}

/** Derives a source from the referring site when there are no UTM params. */
function fromReferrer(req) {
  const ref = req.get('referer') || req.get('referrer');
  if (!ref) return null;
  try {
    const host = new URL(ref).hostname.replace(/^www\./, '');
    if (host === (req.get('host') || '').replace(/^www\./, '').split(':')[0]) return null; // internal
    const known = {
      'instagram.com': 'instagram', 'l.instagram.com': 'instagram',
      'facebook.com': 'facebook', 'l.facebook.com': 'facebook',
      'google.com': 'google', 'google.co.in': 'google',
      'youtube.com': 'youtube', 'pinterest.com': 'pinterest',
      't.co': 'twitter', 'x.com': 'twitter', 'wa.me': 'whatsapp'
    };
    return known[host] || host;
  } catch {
    return null;
  }
}

/**
 * Middleware: records first/last touch. Runs on every request but only writes a
 * cookie when something new arrives, so it costs nothing on normal navigation.
 */
function capture(req, res, next) {
  const q = req.query || {};
  const incoming = {};

  FIELDS.forEach((f) => {
    const v = q['utm_' + f];
    if (v) incoming[f] = clean(v);
  });
  if (!incoming.source && q.ref) {
    incoming.source = clean(q.ref);
    incoming.medium = incoming.medium || 'referral';
  }
  if (!incoming.source) {
    const ref = fromReferrer(req);
    if (ref) {
      incoming.source = clean(ref);
      incoming.medium = incoming.medium || 'referral';
    }
  }

  const existing = read(req);

  if (Object.keys(incoming).length) {
    const at = new Date().toISOString();
    const next = {
      first: existing && existing.first ? existing.first : { ...incoming, at },
      last: { ...incoming, at },
      touches: ((existing && existing.touches) || 0) + 1
    };
    write(req, res, next);
    res.locals.attribution = next;
  } else {
    res.locals.attribution = existing;
  }

  next();
}

/** Flattened shape stored on the order. */
function forOrder(req) {
  const a = read(req);
  if (!a) return { source: 'direct', medium: 'none', campaign: null, firstSource: 'direct', touches: 1 };
  const last = a.last || {};
  const first = a.first || {};
  return {
    source: last.source || 'direct',
    medium: last.medium || 'none',
    campaign: last.campaign || null,
    content: last.content || null,
    firstSource: first.source || last.source || 'direct',
    firstAt: first.at || null,
    touches: a.touches || 1
  };
}

module.exports = { COOKIE, capture, read, forOrder };
