'use strict';

/**
 * Minting licence keys — AGENCY MACHINE ONLY.
 *
 * Signing lives here rather than inside scripts/issue-license.js because the
 * provisioning script needs the same bytes signed the same way. Two copies of
 * signing code is two chances to serialise a payload differently, and a licence that
 * fails to verify is only discovered by the client who cannot open their admin.
 *
 * Nothing in the running shop requires this file: verification uses the public key
 * compiled into src/license.js. This is the private half, and it must exist in exactly
 * one place in the world.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const license = require('./license');
const { PLANS } = require('./plan');

const ROOT = path.join(__dirname, '..');
const KEY_DIR = path.join(ROOT, '.license-keys');
const PRIVATE_KEY = path.join(KEY_DIR, 'private.pem');
const ISSUED_LOG = path.join(KEY_DIR, 'issued.json');

function hasPrivateKey() {
  return fs.existsSync(PRIVATE_KEY);
}

/** Generates the one keypair everything else depends on. */
function keygen({ force = false } = {}) {
  if (hasPrivateKey() && !force) {
    throw new Error(
      `A private key already exists at ${path.relative(ROOT, PRIVATE_KEY)}. ` +
      'Generating a new one invalidates EVERY licence already issued.'
    );
  }

  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  fs.mkdirSync(KEY_DIR, { recursive: true });
  fs.writeFileSync(PRIVATE_KEY, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });

  return {
    privateKeyPath: path.relative(ROOT, PRIVATE_KEY),
    publicKeyB64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  };
}

/**
 * Signs one licence and returns it with the payload.
 *
 * Verifies before returning: a key that does not check out against the public half
 * must never leave this function, because the next thing that happens to it is a
 * client pasting it into their admin.
 */
function mint({ store, plan = 'growth', months = 12, extras = [], domains = [], graceDays } = {}) {
  if (!hasPrivateKey()) {
    throw new Error('No signing key yet. Run: node scripts/issue-license.js --keygen');
  }
  if (!store) throw new Error('A store name is required.');
  if (!PLANS.some((p) => p.id === plan)) {
    throw new Error(`Unknown plan "${plan}". Available: ${PLANS.map((p) => p.id).join(', ')}`);
  }
  const term = Number(months);
  if (!Number.isFinite(term) || term <= 0) throw new Error('months must be a positive number.');

  const issued = new Date();
  const expires = new Date(issued);
  expires.setMonth(expires.getMonth() + term);

  const payload = {
    v: 1,
    id: crypto.randomUUID(),
    store: String(store),
    plan,
    extras: [...extras],
    domains: [...domains],
    issued: issued.toISOString(),
    expires: expires.toISOString(),
    graceDays: Number.isFinite(Number(graceDays)) ? Number(graceDays) : license.GRACE_DAYS
  };

  /* Sign the exact bytes that will be transmitted, not a re-serialisation of them —
     otherwise a difference in key order breaks verification on the client's server. */
  const privateKey = crypto.createPrivateKey(fs.readFileSync(PRIVATE_KEY));
  const signedPart = Buffer.from(Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url'), 'utf8');
  const signature = crypto.sign(null, signedPart, privateKey);
  const token = license.encodeToken(payload, signature);

  const check = license.verify(token);
  if (!check.ok) {
    throw new Error(
      'The generated key does not verify against the public key compiled into ' +
      `src/license.js — they are from different keypairs. (${check.reason})`
    );
  }

  return { token, payload, reference: license.shortId(payload), months: term };
}

/**
 * Local record of what each client holds, so "what did they buy?" is answerable
 * without asking them to read a key back over the phone.
 */
function record(entry) {
  fs.mkdirSync(KEY_DIR, { recursive: true });
  const log = fs.existsSync(ISSUED_LOG) ? JSON.parse(fs.readFileSync(ISSUED_LOG, 'utf8')) : [];
  log.push(entry);
  fs.writeFileSync(ISSUED_LOG, JSON.stringify(log, null, 2) + '\n', { mode: 0o600 });
  return log.length;
}

function issuedLog() {
  if (!fs.existsSync(ISSUED_LOG)) return [];
  return JSON.parse(fs.readFileSync(ISSUED_LOG, 'utf8'));
}

module.exports = {
  KEY_DIR, PRIVATE_KEY, ISSUED_LOG,
  hasPrivateKey, keygen, mint, record, issuedLog,
  relative: (p) => path.relative(ROOT, p)
};
