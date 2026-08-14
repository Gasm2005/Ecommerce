'use strict';

/**
 * Licence keys and plan entitlement.
 *
 * The claim this file has to defend: a client cannot promote themselves. Editing
 * the plan inside a key, or writing "scale" into the config while a starter
 * licence is installed, must not unlock anything. Everything else here is about
 * failing kindly — a lapsed licence locks the admin, never the shop.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { sandbox, seed } = require('./helpers/sandbox');

const { config } = sandbox();

// A throwaway keypair for the tests, installed before license.js is required so
// it verifies against this one rather than the agency's real public key.
const pair = crypto.generateKeyPairSync('ed25519');
process.env.LICENSE_PUBLIC_KEY = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

const license = require('../src/license');
const plan = require('../src/plan');

const DAY = 86400000;

/** Signs a licence the same way scripts/issue-license.js does. */
function issue(overrides = {}) {
  const payload = {
    v: 1,
    id: crypto.randomUUID(),
    store: 'Test Store',
    plan: 'growth',
    extras: [],
    domains: [],
    issued: new Date(Date.now() - DAY).toISOString(),
    expires: new Date(Date.now() + 200 * DAY).toISOString(),
    graceDays: 14,
    ...overrides
  };
  const signed = Buffer.from(Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url'), 'utf8');
  const signature = crypto.sign(null, signed, pair.privateKey);
  return { token: license.encodeToken(payload, signature), payload };
}

/** Installs a licence for the checks that read from storage. */
function install(token) {
  delete process.env.LICENSE_KEY;
  const out = license.activate(token);
  return out;
}

function clear() {
  delete process.env.LICENSE_KEY;
  seed('license', {});
}

/* ------------------------------------------------------- signature ---- */

test('a properly signed licence verifies', () => {
  const { token, payload } = issue();
  const out = license.verify(token);
  assert.equal(out.ok, true);
  assert.equal(out.licence.store, payload.store);
  assert.equal(out.licence.plan, 'growth');
});

test('editing the plan inside a key breaks the signature', () => {
  // The whole point: a client with the key text cannot promote themselves.
  const { token } = issue({ plan: 'starter' });
  const [prefix, body, signature] = token.split('.');

  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  payload.plan = 'scale';
  const forged = [prefix, Buffer.from(JSON.stringify(payload)).toString('base64url'), signature].join('.');

  const out = license.verify(forged);
  assert.equal(out.ok, false);
  assert.match(out.reason, /altered|signature/i);
});

test('extending the expiry date inside a key breaks the signature', () => {
  const { token } = issue({ expires: new Date(Date.now() - DAY).toISOString() });
  const [prefix, body, signature] = token.split('.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  payload.expires = new Date(Date.now() + 3650 * DAY).toISOString();
  const forged = [prefix, Buffer.from(JSON.stringify(payload)).toString('base64url'), signature].join('.');

  assert.equal(license.verify(forged).ok, false);
});

test('a key signed by a different keypair is refused', () => {
  const other = crypto.generateKeyPairSync('ed25519');
  const payload = { v: 1, id: 'x', store: 'Pirate', plan: 'scale', expires: new Date(Date.now() + DAY).toISOString() };
  const signed = Buffer.from(Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url'), 'utf8');
  const token = license.encodeToken(payload, crypto.sign(null, signed, other.privateKey));

  assert.equal(license.verify(token).ok, false);
});

test('garbage is reported as not-a-key, not as forgery', () => {
  ['', 'hello', 'LIC1.only-two-parts', 'LIC9.a.b'].forEach((bad) => {
    const out = license.verify(bad);
    assert.equal(out.ok, false);
    assert.match(out.reason, /does not look like/i, `for input "${bad}"`);
  });
});

test('a key missing required fields is refused even when correctly signed', () => {
  const payload = { v: 1, store: 'No id or plan' };
  const signed = Buffer.from(Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url'), 'utf8');
  const token = license.encodeToken(payload, crypto.sign(null, signed, pair.privateKey));

  const out = license.verify(token);
  assert.equal(out.ok, false);
  assert.match(out.reason, /missing required/i);
});

/* ---------------------------------------------------------- storage ---- */

test('activating stores the key; an invalid key is never written', () => {
  clear();
  const { token } = issue();
  assert.equal(install(token).ok, true);
  assert.equal(license.stored().token, token);

  const before = license.stored().token;
  assert.equal(license.activate('LIC1.rubbish.rubbish').ok, false);
  assert.equal(license.stored().token, before, 'a bad key overwrote a good one');
  clear();
});

test('an env var licence wins over the stored one', () => {
  clear();
  const stored = issue({ plan: 'starter' });
  install(stored.token);

  const fromEnv = issue({ plan: 'scale' });
  process.env.LICENSE_KEY = fromEnv.token;
  assert.equal(license.stored().source, 'env');
  assert.equal(license.status().licence.plan, 'scale');
  clear();
});

/* ----------------------------------------------------------- status ---- */

test('no licence at all is a valid state, not an error', () => {
  clear();
  const s = license.status();
  assert.equal(s.state, 'unlicensed');
  assert.equal(s.restricted, false, 'an unlicensed dev copy must still work');
});

test('a licence inside the warning window says so without restricting anything', () => {
  clear();
  install(issue({ expires: new Date(Date.now() + 10 * DAY).toISOString() }).token);
  const s = license.status();
  assert.equal(s.state, 'expiring');
  assert.equal(s.restricted, false);
  assert.equal(s.daysLeft, 10);
  clear();
});

test('just past expiry the store enters grace and keeps working', () => {
  clear();
  install(issue({ expires: new Date(Date.now() - 3 * DAY).toISOString(), graceDays: 14 }).token);
  const s = license.status();
  assert.equal(s.state, 'grace');
  assert.equal(s.restricted, false, 'grace must not lock anything');
  assert.equal(s.graceDaysLeft, 11);
  clear();
});

test('past grace the admin is restricted', () => {
  clear();
  install(issue({ expires: new Date(Date.now() - 30 * DAY).toISOString(), graceDays: 14 }).token);
  const s = license.status();
  assert.equal(s.state, 'expired');
  assert.equal(s.restricted, true);
  clear();
});

test('a domain-locked licence refuses a different domain', () => {
  clear();
  install(issue({ domains: ['aanyacouture.com'] }).token);

  assert.equal(license.status('aanyacouture.com').state, 'active');
  assert.equal(license.status('www.aanyacouture.com').state, 'active', 'www must be accepted');
  assert.equal(license.status('shop.aanyacouture.com').state, 'active', 'subdomains must be accepted');

  const wrong = license.status('someone-elses-shop.com');
  assert.equal(wrong.state, 'mismatch');
  assert.equal(wrong.restricted, true);
  clear();
});

test('localhost and LAN addresses never trip the domain lock', () => {
  clear();
  install(issue({ domains: ['aanyacouture.com'] }).token);
  ['localhost', 'localhost:3000', '192.168.1.5', '10.57.91.134:3000'].forEach((host) => {
    assert.equal(license.status(host).state, 'active', `${host} should be allowed for testing`);
  });
  clear();
});

test('a licence with no domains works anywhere', () => {
  clear();
  install(issue({ domains: [] }).token);
  assert.equal(license.status('anything.example').state, 'active');
  clear();
});

test('the short reference is stable and reveals no key material', () => {
  const { payload, token } = issue({ store: 'Aanya Couture' });
  const id = license.shortId(payload);
  assert.equal(id, license.shortId(payload), 'must be stable');
  assert.match(id, /^[A-Z0-9]+-[A-Z0-9]{5}-[A-Z0-9]{5}$/);
  assert.ok(!token.includes(id.split('-')[1]), 'the reference must not be a slice of the key');
});

/* ------------------------------------------------------ entitlement ---- */

test('a licence outranks the plan written in the config', () => {
  clear();
  const cheatingConfig = { ...config, plan: 'scale' };
  install(issue({ plan: 'starter' }).token);

  assert.equal(plan.planOf(cheatingConfig).id, 'starter', 'config must not beat a signed licence');
  assert.equal(plan.hasFeature(cheatingConfig, 'reports'), false, 'starter has no P&L reports');
  assert.equal(plan.hasFeature(cheatingConfig, 'orders'), true, 'core features stay on');
  clear();
});

test('with no licence the config decides, so development still works', () => {
  clear();
  assert.equal(plan.planOf({ ...config, plan: 'starter' }).id, 'starter');
  assert.equal(plan.planOf({ ...config, plan: 'scale' }).id, 'scale');
  clear();
});

test('extras in the licence unlock single features above the tier', () => {
  clear();
  install(issue({ plan: 'starter', extras: ['reports'] }).token);
  assert.equal(plan.hasFeature(config, 'reports'), true, 'the paid-for extra must be on');
  assert.equal(plan.hasFeature(config, 'marketing'), false, 'nothing else comes with it');
  clear();
});

test('an expired licence keeps its plan rather than falling back to the config', () => {
  clear();
  const cheatingConfig = { ...config, plan: 'scale' };
  install(issue({ plan: 'starter', expires: new Date(Date.now() - 30 * DAY).toISOString() }).token);

  const ent = plan.entitlement(cheatingConfig);
  assert.equal(ent.planId, 'starter', 'letting it expire must not be a free upgrade');
  assert.equal(ent.licence.restricted, true);
  clear();
});

test('a scale licence unlocks everything', () => {
  clear();
  install(issue({ plan: 'scale' }).token);
  plan.FEATURES.forEach((f) => {
    assert.equal(plan.hasFeature(config, f.id), true, `${f.id} should be on for scale`);
  });
  clear();
});

test('a starter licence locks the sections it does not include', () => {
  clear();
  install(issue({ plan: 'starter' }).token);

  assert.equal(plan.sectionUnlocked(config, 'orders'), true);
  assert.equal(plan.sectionUnlocked(config, 'products'), true);
  assert.equal(plan.sectionUnlocked(config, 'reports'), false);
  assert.equal(plan.sectionUnlocked(config, 'marketing'), false);
  assert.equal(plan.sectionUnlocked(config, 'discounts'), false);
  // Sections with no feature attached are never plan-locked.
  assert.equal(plan.sectionUnlocked(config, 'settings'), true);
  assert.equal(plan.sectionUnlocked(config, 'activity'), true);
  clear();
});

test('an unclassified feature defaults to ON, so new work never vanishes', () => {
  clear();
  install(issue({ plan: 'starter' }).token);
  assert.equal(plan.hasFeature(config, 'some-feature-added-next-year'), true);
  clear();
});

test('the overview reports where the plan came from', () => {
  clear();
  install(issue({ plan: 'growth' }).token);
  const info = plan.overview(config);
  assert.equal(info.plan.id, 'growth');
  assert.equal(info.source, 'licence');
  assert.ok(info.locked.length > 0, 'growth is not the top tier');
  assert.equal(info.upgradeTo.id, 'scale');

  clear();
  assert.equal(plan.overview({ ...config, plan: 'scale' }).source, 'config');
});
