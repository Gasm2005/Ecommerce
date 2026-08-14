#!/usr/bin/env node
'use strict';

/**
 * Sold to live — AGENCY MACHINE ONLY.
 *
 *   npm run provision -- --template > client.json     write a spec to fill in
 *   npm run provision -- --file client.json --dry-run validate, change nothing
 *   npm run provision -- --file client.json           do it
 *
 * The spec is a file rather than a set of prompts on purpose. This runs once per
 * client, dozens of times: a file can be filled in before the meeting, checked by
 * someone else, kept as the record of what was agreed, and re-run when a detail turns
 * out to be wrong. Fifteen typed answers cannot be any of those things.
 *
 * Everything is validated before anything is written. A half-provisioned store is
 * worse than an untouched one — the brand is the client's, the GSTIN is still
 * somebody else's, and no screen tells you which.
 *
 * What this cannot do, and says so at the end: real product photography, the payment
 * gateway keys, and the mail provider credentials. Those belong to the client and only
 * they can hand them over.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const provision = require('../src/provision');
const minting = require('../src/minting');
const { PLANS } = require('../src/plan');

/* ---------------------------------------------------------------- args ---- */

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { out._.push(arg); continue; }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { out[key] = true; } else { out[key] = next; i += 1; }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

/* --------------------------------------------------------------- output ---- */

const C = process.stdout.isTTY
  ? { red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m', dim: '\x1b[2m', bold: '\x1b[1m', off: '\x1b[0m' }
  : { red: '', yellow: '', green: '', dim: '', bold: '', off: '' };

const say = (s = '') => console.log(s);
const head = (s) => say(`\n  ${C.bold}${s}${C.off}`);
const bad = (s) => say(`    ${C.red}✗${C.off}  ${s}`);
const warn = (s) => say(`    ${C.yellow}!${C.off}  ${s}`);
const good = (s) => say(`    ${C.green}✓${C.off}  ${s}`);
const note = (s) => say(`       ${C.dim}${s}${C.off}`);

function die(message) {
  say(`\n  ${C.red}${message}${C.off}\n`);
  process.exit(1);
}

/* ------------------------------------------------------------- template ---- */

if (args.template) {
  process.stdout.write(JSON.stringify(provision.template(), null, 2) + '\n');
  process.exit(0);
}

if (!args.file) {
  say(`
  Provisioning (agency machine only)

    --template              print a spec file to fill in
    --file client.json      the filled-in spec
    --dry-run               validate and show the changes, write nothing
    --keep-demo-accounts    leave the seeded logins alone (you almost never want this)
    --no-activate           mint the licence but do not install it on this machine

  Typical run:

    npm run provision -- --template > client.json
    npm run provision -- --file client.json --dry-run
    npm run provision -- --file client.json
`);
  process.exit(0);
}

/* ----------------------------------------------------------------- read ---- */

const specPath = path.resolve(String(args.file));
if (!fs.existsSync(specPath)) die(`No such file: ${specPath}`);

let spec;
try {
  spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
} catch (err) {
  die(`${path.basename(specPath)} will not parse as JSON: ${err.message}`);
}

const { loadConfig } = require('../src/config');
const current = provision.readConfig();

/* ------------------------------------------------------------- validate ---- */

head('Checking the spec');

const check = provision.validate(spec, { config: current });
check.errors.forEach(bad);
check.warnings.forEach(warn);

if (!check.ok) {
  say(`\n  ${C.red}Nothing was changed.${C.off} Fix the above and run again.\n`);
  process.exit(1);
}
if (!check.warnings.length) good('Everything checks out');

// The licence is signed from this machine, so a missing key stops us before we edit
// a config the client would then be running without a licence.
const wantsLicence = !!(spec.licence && spec.licence.plan);
if (wantsLicence && !minting.hasPrivateKey()) {
  die('No licence signing key on this machine. Run: node scripts/issue-license.js --keygen');
}

/* ----------------------------------------------------------- what changes ---- */

const nextConfig = provision.planConfig(spec, current);
const changes = provision.diff(current, nextConfig);

head(`Config — ${changes.length} change${changes.length === 1 ? '' : 's'}`);
if (!changes.length) {
  note('nothing to change; the config already matches the spec');
} else {
  const width = Math.max(...changes.map((c) => c.key.length));
  changes.forEach((c) => {
    const from = c.from === undefined || c.from === '' ? '(empty)' : String(c.from);
    say(`    ${c.key.padEnd(width)}  ${C.dim}${truncate(from)}${C.off} → ${truncate(String(c.to))}`);
  });
}

function truncate(s, n = 46) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/* ------------------------------------------------------------- dry run ---- */

const auth = require('../src/auth');
const existingOwner = auth.findByEmail(spec.owner.email);

head('Accounts');
if (existingOwner) {
  note(`${spec.owner.email} already exists — its password will be reset`);
} else {
  note(`${spec.owner.email} will be created as owner, with a generated password`);
}

const demoAccounts = auth.users().filter((u) => /@store\.com$/i.test(u.email));
if (demoAccounts.length) {
  if (args['keep-demo-accounts']) {
    warn(`${demoAccounts.length} seeded account(s) will be LEFT ACTIVE: ${demoAccounts.map((u) => u.email).join(', ')}`);
  } else {
    note(`${demoAccounts.length} seeded account(s) will be removed: ${demoAccounts.map((u) => u.email).join(', ')}`);
  }
}

if (args['dry-run']) {
  say(`\n  ${C.dim}Dry run — nothing was written.${C.off}\n`);
  process.exit(0);
}

/* ---------------------------------------------------------------- write ---- */

head('Writing');

// Back up first, and say where: the one thing you need when a run was pointed at the
// wrong store.
const backup = provision.backupConfig();
fs.writeFileSync(provision.CONFIG_PATH, JSON.stringify(nextConfig, null, 2) + '\n', 'utf8');
require('../src/config').invalidate();
good(`config/site.config.json  (backup: ${backup})`);

/* --- the owner account --- */
const password = provision.generatePassword();
if (existingOwner) {
  auth.updateUser(existingOwner.id, { role: 'owner', active: true, password });
  good(`${spec.owner.email} — password reset, role owner`);
} else {
  auth.createUser({ name: spec.owner.name, email: spec.owner.email, password, role: 'owner' });
  good(`${spec.owner.email} — created as owner`);
}

/* --- the seeded logins. Leaving these is how a handover password stays valid. --- */
if (demoAccounts.length && !args['keep-demo-accounts']) {
  demoAccounts.forEach((u) => auth.removeUser(u.id));
  good(`removed ${demoAccounts.length} seeded account(s)`);
}

/* --- the catalogue --- */
if (spec.catalogue === 'empty') {
  const productsWrite = require('../src/products');
  const count = productsWrite.readRaw().length;
  productsWrite.writeRaw([]);
  good(`emptied the demo catalogue (${count} products removed)`);
}

/* --- the licence --- */
let licence = null;
if (wantsLicence) {
  try {
    licence = minting.mint({
      store: spec.brand.name,
      plan: spec.licence.plan,
      months: spec.licence.months || 12,
      extras: spec.licence.extras || [],
      domains: spec.licence.domains || []
    });
    minting.record({ ...licence.payload, reference: licence.reference, token: licence.token });
    good(`licence ${licence.reference} — ${spec.licence.plan}, ${licence.months} months`);

    /* Install it here too. We host these stores, so a key that is only printed leaves
       the shop we just provisioned running unlicensed while the paperwork says
       otherwise. --no-activate is for the other case: preparing a key for a server
       somebody else runs. */
    if (args['no-activate']) {
      note('not activated on this install (--no-activate) — paste it wherever the shop actually runs');
    } else {
      const applied = require('../src/license').activate(licence.token);
      if (applied.ok) {
        good('licence activated on this install');
      } else {
        warn(`licence minted but not activated here: ${applied.reason}`);
      }
    }
  } catch (err) {
    // The config is already theirs at this point, so this is a warning rather than a
    // failure: the store works, it just needs a key pasting in.
    warn(`licence not issued: ${err.message}`);
  }
}

/* ------------------------------------------------------------ handover ---- */

say(`\n  ${C.bold}Hand these over${C.off}\n`);
say(`    Admin        /admin`);
say(`    Email        ${spec.owner.email}`);
say(`    Password     ${C.bold}${password}${C.off}`);
note('shown once and never stored in readable form — send it, then have them change it');

if (licence) {
  say(`\n    Licence key  ${C.dim}(paste into Admin → Licence, or set LICENSE_KEY)${C.off}\n`);
  say(`    ${licence.token}\n`);
  const domains = licence.payload.domains;
  note(domains.length ? `locked to ${domains.join(', ')}` : 'NOT domain-locked — it will work on any host');
}

/* ------------------------------------------------------ what is still left ---- */

head('Still needed before launch');

const config = loadConfig();
const products = require('../src/catalog').all();
const notifications = require('../src/notifications');
const payments = require('../src/payments');

const left = [];

const placeholders = products.filter((p) => !p.images || !p.images.length || p.images.every((i) => i.includes('ph.svg')));
if (!products.length) {
  left.push('Their catalogue — nothing is listed yet. Admin → Bulk upload.');
} else if (placeholders.length) {
  left.push(`Real photography — ${placeholders.length} of ${products.length} products still use placeholder art.`);
}

if (notifications.status(config).provider === 'log') {
  left.push('Mail credentials — order confirmations print to the console until a provider is connected.');
}
if (!payments.status(config).live) {
  left.push('Payment gateway keys — the shop takes manual and COD orders until these are in.');
}
if (minting.hasPrivateKey()) {
  left.push('If this machine is the CLIENT\'S server, delete .license-keys/ — it can mint licences for every store.');
}

if (!left.length) {
  good('Nothing — run npm run doctor to confirm');
} else {
  left.forEach((l) => warn(l));
  note('these are the client\'s to supply; everything else is done');
}

say(`\n  ${C.dim}Confirm with:  npm run doctor${C.off}\n`);
