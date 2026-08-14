'use strict';

/**
 * Turning a sold store into a live one.
 *
 * This runs once per client and there will be many clients, so the failure modes are
 * not "the script crashed" — they are the quiet ones. A shop live under the demo brand.
 * A handover password that still works. Invoices issued under somebody else's GSTIN,
 * with somebody else's UPI printed on them, for a year before anyone notices.
 *
 * So these tests care about two things above all: that a bad spec changes NOTHING, and
 * that nothing of the demo store survives a good one.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sandbox } = require('./helpers/sandbox');

const { config } = sandbox();

const provision = require('../src/provision');
const gstinCheck = require('../src/gstin');
const invoice = require('../src/invoice');

/** The shipped example, which must itself be valid — it is what everyone starts from. */
const spec = () => JSON.parse(JSON.stringify(provision.template()));

/* -------------------------------------------------------------- the spec ---- */

test('the template we hand out is valid as it stands', () => {
  const result = provision.validate(spec(), { config });
  assert.deepEqual(result.errors, [], 'someone filling this in should not start from a broken file');
  assert.equal(result.ok, true);
});

test('a bad spec reports every problem at once, not the first one', () => {
  const broken = {
    brand: { name: '' },
    business: { gstin: 'nonsense', pan: 'nope' },
    owner: {}
  };
  const { ok, errors } = provision.validate(broken, { config });

  assert.equal(ok, false);
  // Someone filling this in before a client meeting should learn about all of it now.
  assert.ok(errors.length >= 5, `expected several problems, got ${errors.length}: ${errors.join(' | ')}`);
  assert.ok(errors.some((e) => /brand\.name/.test(e)));
  assert.ok(errors.some((e) => /gstin/i.test(e)));
  assert.ok(errors.some((e) => /pan/i.test(e)));
  assert.ok(errors.some((e) => /owner\.email/.test(e)));
});

test('a GSTIN that fails its check digit is refused', () => {
  const s = spec();
  const good = s.business.gstin;
  assert.equal(gstinCheck.check(good).ok, true, 'the template GSTIN should be genuinely valid');

  // Change the last character: still 15 chars, still the right shape, still wrong.
  s.business.gstin = good.slice(0, 14) + (good.slice(14) === '5' ? '6' : '5');
  const { ok, errors } = provision.validate(s, { config });
  assert.equal(ok, false, 'a year of invoices under a mistyped GSTIN is not a fixable mistake');
  assert.ok(errors.some((e) => /check digit/i.test(e)), errors.join(' | '));
});

test('a GSTIN whose state does not match the stated state is refused', () => {
  const s = spec();
  // 09 is Uttar Pradesh; claim Maharashtra and one of the two must be wrong.
  s.business.state = 'Maharashtra';

  const { ok, errors } = provision.validate(s, { config });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => /one of them is wrong/.test(e)), errors.join(' | '));
  // And the reason it matters: this field decides CGST+SGST versus IGST on every order.
  assert.equal(invoice.stateCode('Maharashtra'), '27');
  assert.equal(invoice.stateCode('Uttar Pradesh'), '09');
});

test('the demo brand cannot be provisioned as if it were a client', () => {
  const s = spec();
  s.brand.name = 'AANYÄ Couture';
  const { ok, errors } = provision.validate(s, { config });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => /demo brand/.test(e)));
});

test('a password in the spec is an error, not something to use', () => {
  const s = spec();
  s.owner.password = 'ClientChose1234';
  const { ok, errors } = provision.validate(s, { config });
  assert.equal(ok, false, 'a password in a file lives in a chat thread forever');
  assert.ok(errors.some((e) => /Remove owner\.password/.test(e)));
});

test('an audience the shop does not have is refused', () => {
  const s = spec();
  s.audiences = ['women', 'pets'];
  const { ok, errors } = provision.validate(s, { config });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => /"pets"/.test(e)));
});

test('a domain with a scheme or a path is refused', () => {
  const s = spec();
  s.licence.domains = ['https://meeracouture.in/shop'];
  const { ok, errors } = provision.validate(s, { config });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => /not a domain/.test(e)));
});

test('an unlocked licence is a warning, since the key would work anywhere', () => {
  const s = spec();
  s.licence.domains = [];
  const { ok, warnings } = provision.validate(s, { config });
  assert.equal(ok, true, 'it is a choice, not a mistake');
  assert.ok(warnings.some((w) => /any host/.test(w)));
});

test('an unknown plan is refused', () => {
  const s = spec();
  s.licence.plan = 'enterprise';
  const { ok } = provision.validate(s, { config });
  assert.equal(ok, false);
});

/* --------------------------------------------------- nothing of ours survives ---- */

/**
 * The demo store's details are scattered across the config, and the ones that hurt are
 * not the visible ones. A shop live under the wrong name is embarrassing; a shop
 * issuing invoices with our UPI id on them takes a customer's money to the wrong place.
 */
test('no trace of the demo store survives provisioning', () => {
  const next = provision.planConfig(spec(), config);

  const found = [];
  (function walk(node, at) {
    if (typeof node === 'string') {
      if (/aanya/i.test(node)) found.push(`${at} = ${node.slice(0, 60)}`);
      return;
    }
    if (node && typeof node === 'object') {
      Object.entries(node).forEach(([k, v]) => walk(v, at ? `${at}.${k}` : k));
    }
  })(next, '');

  assert.deepEqual(found, [], 'the demo store is still in there');
});

test('bank details are cleared rather than inherited', () => {
  const s = spec();
  delete s.business.bank;

  const next = provision.planConfig(s, config);
  const bank = next.business.bank;

  /* This block is printed on the invoice. Absent beats wrong by a wide margin: no bank
     block is correct, while a customer paying a client's invoice into our demo account
     is a phone call nobody wants to make. */
  assert.equal(bank.accountName, '');
  assert.equal(bank.upi, '');
  assert.equal(bank.ifsc, '');
});

test('bank details given in the spec are used', () => {
  const next = provision.planConfig(spec(), config);
  assert.match(next.business.bank.accountName, /Meera/);
  assert.match(next.business.bank.upi, /meera/);
});

test('order mail replies go to the client, not to us', () => {
  const s = spec();
  const next = provision.planConfig(s, config);

  // Customers reply to a confirmation more than to anything else the shop sends.
  assert.equal(next.notifications.replyTo, s.brand.supportEmail);
  assert.equal(next.notifications.storeEmail, s.owner.email);
  assert.equal(next.notifications.fromName, s.brand.name);
});

test('the invoice is legally complete after provisioning', () => {
  const next = provision.planConfig(spec(), config);
  const readiness = invoice.readiness(next);
  assert.equal(readiness.ok, true, `still missing: ${readiness.missing.join(', ')}`);
  assert.equal(readiness.business.stateCode, '09', 'the state code has to be derived, not typed');
});

/* -------------------------------------------------------------- sections ---- */

test('only the sections the client sells to are kept, in their order', () => {
  const s = spec();
  s.audiences = ['men', 'women'];

  const next = provision.planConfig(s, config);
  assert.deepEqual(next.audiences.list.map((a) => a.id), ['men', 'women']);
  // Each entry keeps its configured nav — we are selecting, not rewriting.
  assert.ok(next.audiences.list.every((a) => Array.isArray(a.nav) && a.nav.length));
});

test('a single-audience shop carries no trace of the feature', () => {
  const s = spec();
  s.audiences = ['women'];
  const next = provision.planConfig(s, config);

  assert.equal(next.audiences.list.length, 1);
  const audience = require('../src/audience');
  assert.equal(audience.isMultiple(next), false, 'no chooser, no switcher, nothing to explain');
});

test('leaving audiences out of the spec changes nothing about them', () => {
  const s = spec();
  delete s.audiences;
  const next = provision.planConfig(s, config);
  assert.deepEqual(
    next.audiences.list.map((a) => a.id),
    config.audiences.list.map((a) => a.id)
  );
});

/* ------------------------------------------------------------- fulfilment ---- */

test('only known fulfilment flags are accepted, so a typo cannot invent a feature', () => {
  const picked = provision.pickFulfilment({
    madeToOrder: true,
    complimentaryCustomization: true,      // American spelling — not our key
    somethingElse: true
  });
  assert.deepEqual(picked, { madeToOrder: true });
});

test('the retail default is off, because forgetting to switch a promise off costs a refund', () => {
  const next = provision.planConfig(spec(), config);
  assert.equal(next.features.madeToOrder, false);
  assert.equal(next.features.complimentaryCustomisation, false);
});

/* --------------------------------------------------------------- password ---- */

test('the generated password passes the rules the admin enforces', () => {
  const auth = require('../src/auth');
  for (let i = 0; i < 40; i++) {
    const pw = provision.generatePassword();
    assert.equal(auth.passwordProblem(pw), null, `${pw} would be refused at the login`);
  }
});

test('the generated password is readable enough to say down a phone', () => {
  const pw = provision.generatePassword();
  // Words and a number: something nobody writes on a sticky note.
  assert.match(pw, /^[A-Z][a-z]+-[A-Z][a-z]+-\d{4}$/, pw);

  const [a, b] = pw.split('-');
  assert.notEqual(a, b, 'a doubled word reads as a typo');
});

test('two runs do not produce the same password', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) seen.add(provision.generatePassword());
  assert.ok(seen.size > 45, `only ${seen.size} distinct out of 50`);
});

/* ------------------------------------------------------------------ diff ---- */

test('the diff names every change and invents none', () => {
  const before = { a: 1, nested: { keep: 'same', change: 'old' }, list: [1, 2] };
  const after = { a: 2, nested: { keep: 'same', change: 'new' }, list: [1, 2, 3] };

  const lines = provision.diff(before, after);
  const keys = lines.map((l) => l.key).sort();

  assert.deepEqual(keys, ['a', 'list', 'nested.change']);
  assert.equal(lines.find((l) => l.key === 'a').from, 1);
  assert.equal(lines.find((l) => l.key === 'a').to, 2);
});

test('the diff skips the readme keys nobody wants to see', () => {
  const lines = provision.diff({ _readme: 'old' }, { _readme: 'new' });
  assert.deepEqual(lines, []);
});

test('provisioning the demo config produces a long list of changes', () => {
  // A short list would mean the script is quietly leaving most of the demo in place.
  const next = provision.planConfig(spec(), config);
  const lines = provision.diff(config, next);
  assert.ok(lines.length >= 15, `only ${lines.length} changes — that is suspiciously few`);
});

/* ------------------------------------------------- the check that never fired ---- */

/**
 * The demo brand is written "AANYÄ", and /aanya/i does not match it — Ä is not a. Both
 * this guard and the one in doctor were that regex, so the brand-name check had never
 * fired once. The only reason a demo store was ever flagged is that its support email
 * happened to be care@aanya.example.
 *
 * A client provisioned under the demo name with their own email address would have
 * passed every check we had.
 */
test('the demo brand is recognised with its diacritic, not only without', () => {
  assert.equal(provision.looksLikeDemo('AANYÄ'), true, 'this is the actual demo brand string');
  assert.equal(provision.looksLikeDemo('AANYÄ Couture'), true);
  assert.equal(provision.looksLikeDemo('AANYA'), true);
  assert.equal(provision.looksLikeDemo('care@aanya.example'), true);

  assert.equal(provision.looksLikeDemo('Meera Couture'), false);
  assert.equal(provision.looksLikeDemo(''), false);
  assert.equal(provision.looksLikeDemo(undefined), false);
});

test('doctor and provisioning agree on what counts as the demo store', () => {
  // One helper, used by both: two copies of this rule is how one of them rots.
  const doctorSrc = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'scripts', 'doctor.js'), 'utf8'
  );
  assert.match(doctorSrc, /looksLikeDemo/, 'doctor must use the shared helper');
  assert.doesNotMatch(doctorSrc, /const demo = \/aanya\/i/, 'the regex that never matched Ä is gone');
});
