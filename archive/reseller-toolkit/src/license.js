'use strict';

/**
 * Licence keys.
 *
 * A licence is a short signed token that says: this store, this plan, until this
 * date. It is signed with an Ed25519 private key that lives ONLY on the agency's
 * machine; every deployment ships the public key and can verify offline. So a
 * client — or anyone who ever gets a copy of the code — can read a licence but
 * cannot mint one, and cannot edit "starter" into "scale" without the signature
 * failing.
 *
 * What this is honestly for:
 *   · the single source of truth for which plan a store is on
 *   · renewal and expiry, tracked automatically instead of in a spreadsheet
 *   · insurance for the day a client insists on holding the code themselves
 *
 * What it is NOT: anti-piracy for a store the agency hosts. If the client never
 * has the code, the server is the enforcement. The licence is what makes the
 * arrangement legible — and portable if that ever changes.
 *
 * Verification is offline by design. A store must not stop selling because a
 * licence server is unreachable.
 *
 * Expiry is deliberately gentle: past the date there is a grace period, and after
 * that the ADMIN locks to the licence page while the STOREFRONT keeps taking
 * orders. A shop is a real business with real customers; it does not get switched
 * off over an unpaid invoice.
 */

const crypto = require('crypto');
const store = require('./store');

/**
 * The agency's public key. Replace this with your own after running
 *   node scripts/issue-license.js --keygen
 * The matching private key never leaves your machine.
 */
const PUBLIC_KEY_B64 = process.env.LICENSE_PUBLIC_KEY
  || 'MCowBQYDK2VwAyEAhsA8rAYuwy9AGw1U5pJOFf9WCG02EdGfGLjLAztoSuY=';

const GRACE_DAYS = 14;
const EXPIRY_WARNING_DAYS = 30;

/* ------------------------------------------------------------ encoding ---- */

const b64url = {
  encode: (buf) => Buffer.from(buf).toString('base64url'),
  decode: (str) => Buffer.from(String(str), 'base64url')
};

/**
 * Token format:  LIC1.<payload>.<signature>
 * Both parts base64url. The version prefix means a future format can be told
 * apart from a corrupt key instead of being reported as forged.
 */
function encodeToken(payload, signature) {
  return ['LIC1', b64url.encode(JSON.stringify(payload)), b64url.encode(signature)].join('.');
}

function decodeToken(token) {
  const parts = String(token || '').trim().split('.');
  if (parts.length !== 3 || parts[0] !== 'LIC1') return null;
  try {
    return {
      payload: JSON.parse(b64url.decode(parts[1]).toString('utf8')),
      signature: b64url.decode(parts[2]),
      signed: Buffer.from(parts[1], 'utf8')
    };
  } catch {
    return null;
  }
}

/* --------------------------------------------------------- verification ---- */

function publicKey() {
  return crypto.createPublicKey({
    key: Buffer.from(PUBLIC_KEY_B64, 'base64'),
    format: 'der',
    type: 'spki'
  });
}

/**
 * Checks the signature only. Says nothing about dates or domains — those are
 * policy, and policy belongs in status() where it can be explained to a human.
 */
function verify(token) {
  const parsed = decodeToken(token);
  if (!parsed) return { ok: false, reason: 'That does not look like a licence key.' };

  let valid = false;
  try {
    valid = crypto.verify(null, parsed.signed, publicKey(), parsed.signature);
  } catch (err) {
    return { ok: false, reason: 'Licence key could not be checked: ' + err.message };
  }
  if (!valid) return { ok: false, reason: 'This licence key has been altered — the signature does not match.' };

  const p = parsed.payload;
  if (!p || !p.id || !p.plan || !p.expires) {
    return { ok: false, reason: 'This licence key is missing required fields.' };
  }
  return { ok: true, licence: p };
}

/* -------------------------------------------------------------- storage ---- */

/** Env var wins, so a hosted deployment can be licensed without a writable disk. */
function stored() {
  if (process.env.LICENSE_KEY) return { token: process.env.LICENSE_KEY.trim(), source: 'env' };
  const row = store.read('license', {});
  return row && row.token ? { token: row.token, source: 'file' } : null;
}

/** Saves a key after verifying it — an invalid key is never written. */
function activate(token) {
  const check = verify(token);
  if (!check.ok) return check;

  store.write('license', {
    token: String(token).trim(),
    activatedAt: new Date().toISOString(),
    licenceId: check.licence.id
  }, { skipBackup: true });

  return { ok: true, licence: check.licence };
}

function deactivate() {
  store.write('license', {}, { skipBackup: true });
}

/* --------------------------------------------------------------- status ---- */

const DAY = 86400000;

/**
 * Everything a human or a gate needs to know, in one object.
 *
 * state:
 *   unlicensed  no key at all — falls back to config.plan (dev and self-hosting)
 *   invalid     present but forged, altered or corrupt
 *   mismatch    signed for a different domain than the one being served
 *   active      good
 *   expiring    good, but inside the warning window
 *   grace       past the date, still working, countdown running
 *   expired     past grace — the admin locks, the storefront does not
 */
function status(host) {
  const found = stored();
  if (!found) {
    return { state: 'unlicensed', ok: true, restricted: false, licence: null, source: null };
  }

  const check = verify(found.token);
  if (!check.ok) {
    return {
      state: 'invalid', ok: false, restricted: true,
      licence: null, source: found.source, reason: check.reason
    };
  }

  const lic = check.licence;
  const now = Date.now();
  const expires = new Date(lic.expires).getTime();
  const graceEnds = expires + (Number.isFinite(lic.graceDays) ? lic.graceDays : GRACE_DAYS) * DAY;
  const daysLeft = Math.ceil((expires - now) / DAY);

  // Domain binding is optional: a licence with no domains works anywhere, which
  // is what a staging copy needs.
  const domains = Array.isArray(lic.domains) ? lic.domains.filter(Boolean) : [];
  if (domains.length && host) {
    const bare = String(host).toLowerCase().split(':')[0].replace(/^www\./, '');
    const local = bare === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(bare) || bare.endsWith('.local');
    const allowed = domains.some((d) => {
      const clean = String(d).toLowerCase().replace(/^www\./, '');
      return bare === clean || bare.endsWith('.' + clean);
    });
    // Never fail on localhost or a LAN IP — that is the agency testing, not a
    // client running an unlicensed copy.
    if (!allowed && !local) {
      return {
        state: 'mismatch', ok: false, restricted: true, licence: lic, source: found.source,
        reason: `This licence is issued for ${domains.join(', ')}, but the store is being served from ${bare}.`
      };
    }
  }

  const base = { licence: lic, source: found.source, daysLeft, expiresAt: lic.expires };

  if (now > graceEnds) {
    return {
      ...base, state: 'expired', ok: false, restricted: true,
      reason: `This licence expired on ${new Date(lic.expires).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}.`
    };
  }
  if (now > expires) {
    return {
      ...base, state: 'grace', ok: true, restricted: false,
      graceDaysLeft: Math.ceil((graceEnds - now) / DAY),
      reason: `This licence expired ${Math.abs(daysLeft)} day(s) ago. It keeps working for ${Math.ceil((graceEnds - now) / DAY)} more day(s).`
    };
  }
  if (daysLeft <= EXPIRY_WARNING_DAYS) {
    return { ...base, state: 'expiring', ok: true, restricted: false, reason: `This licence renews in ${daysLeft} day(s).` };
  }
  return { ...base, state: 'active', ok: true, restricted: false };
}

/**
 * The plan a store is entitled to.
 *
 * A valid licence outranks config.plan — that is the whole point, since the
 * config is a plain file and the licence is signed. With no licence we fall back
 * to the config so development and self-hosted deployments still work.
 */
function entitlement(config, host) {
  const s = status(host);
  if (s.licence && (s.state === 'active' || s.state === 'expiring' || s.state === 'grace')) {
    return { plan: s.licence.plan, extras: s.licence.extras || [], from: 'licence', status: s };
  }
  if (s.state === 'expired' || s.state === 'invalid' || s.state === 'mismatch') {
    // Do not silently promote a store to whatever its config claims. It keeps
    // its plan for the storefront, but the admin is restricted by `restricted`.
    return {
      plan: s.licence ? s.licence.plan : (config && config.plan) || null,
      extras: s.licence ? (s.licence.extras || []) : [],
      from: 'licence-lapsed',
      status: s
    };
  }
  return {
    plan: (config && config.plan) || null,
    extras: (config && config.planExtras) || [],
    from: 'config',
    status: s
  };
}

/** Short, readable id for a support conversation: AANYA-7F3K2-9QX4M. */
function shortId(licence) {
  if (!licence || !licence.id) return null;
  const hash = crypto.createHash('sha256').update(licence.id).digest('hex').toUpperCase();
  const group = (i) => hash.slice(i, i + 5).replace(/[^A-Z0-9]/g, 'X');
  const prefix = String(licence.store || 'STORE').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5) || 'STORE';
  return `${prefix}-${group(0)}-${group(5)}`;
}

module.exports = {
  PUBLIC_KEY_B64, GRACE_DAYS, EXPIRY_WARNING_DAYS,
  encodeToken, decodeToken, verify, activate, deactivate, stored, status, entitlement, shortId
};
