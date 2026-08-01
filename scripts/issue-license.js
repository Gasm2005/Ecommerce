#!/usr/bin/env node
'use strict';

/**
 * Licence issuing — AGENCY MACHINE ONLY.
 *
 * First time:
 *   node scripts/issue-license.js --keygen
 *     Writes .license-keys/private.pem (git-ignored) and prints the public key
 *     to paste into src/license.js. Back the private key up somewhere safe: lose
 *     it and every future licence has to be reissued under a new public key.
 *
 * Then, per client:
 *   node scripts/issue-license.js --store "Aanya Couture" --plan growth --months 12 \
 *        --domains aanyacouture.com --extras whatsapp
 *
 * The printed token goes into the client's deployment as LICENSE_KEY, or is
 * pasted once into Admin → Licence. Nothing here talks to a network.
 *
 * NEVER copy private.pem onto a client server. The whole design rests on the
 * private key existing in exactly one place.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const KEY_DIR = path.join(ROOT, '.license-keys');
const PRIVATE_KEY = path.join(KEY_DIR, 'private.pem');
const ISSUED_LOG = path.join(KEY_DIR, 'issued.json');

const license = require('../src/license');
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

/* -------------------------------------------------------------- keygen ---- */

function keygen() {
  if (fs.existsSync(PRIVATE_KEY) && !args.force) {
    console.error(`\n  A private key already exists at ${path.relative(ROOT, PRIVATE_KEY)}.`);
    console.error('  Generating a new one invalidates EVERY licence already issued.');
    console.error('  Pass --force only if you mean that.\n');
    process.exit(1);
  }

  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  fs.mkdirSync(KEY_DIR, { recursive: true });
  fs.writeFileSync(PRIVATE_KEY, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });

  const pub = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

  console.log('\n  Keypair generated.\n');
  console.log(`  Private key  ${path.relative(ROOT, PRIVATE_KEY)}   (mode 600, git-ignored)`);
  console.log('               Back this up. Losing it means reissuing every licence.\n');
  console.log('  Public key — paste into src/license.js as PUBLIC_KEY_B64:\n');
  console.log(`    '${pub}'\n`);
}

/* --------------------------------------------------------------- issue ---- */

function issue() {
  if (!fs.existsSync(PRIVATE_KEY)) {
    console.error('\n  No private key yet. Run:  node scripts/issue-license.js --keygen\n');
    process.exit(1);
  }
  if (!args.store) {
    console.error('\n  --store "Client Name" is required.\n');
    process.exit(1);
  }
  const plan = String(args.plan || 'growth');
  if (!PLANS.some((p) => p.id === plan)) {
    console.error(`\n  Unknown plan "${plan}". Available: ${PLANS.map((p) => p.id).join(', ')}\n`);
    process.exit(1);
  }

  const months = Number(args.months || 12);
  if (!Number.isFinite(months) || months <= 0) {
    console.error('\n  --months must be a positive number.\n');
    process.exit(1);
  }

  const issued = new Date();
  const expires = new Date(issued);
  expires.setMonth(expires.getMonth() + months);

  const payload = {
    v: 1,
    id: crypto.randomUUID(),
    store: String(args.store),
    plan,
    extras: args.extras ? String(args.extras).split(',').map((s) => s.trim()).filter(Boolean) : [],
    domains: args.domains ? String(args.domains).split(',').map((s) => s.trim()).filter(Boolean) : [],
    issued: issued.toISOString(),
    expires: expires.toISOString(),
    graceDays: Number(args.grace || license.GRACE_DAYS)
  };

  // Sign the exact bytes that will be transmitted, not a re-serialisation of
  // them — otherwise a key-order difference breaks verification.
  const privateKey = crypto.createPrivateKey(fs.readFileSync(PRIVATE_KEY));
  const signedPart = Buffer.from(Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url'), 'utf8');
  const signature = crypto.sign(null, signedPart, privateKey);
  const token = license.encodeToken(payload, signature);

  // Verify before printing: never hand over a key that does not work.
  const check = license.verify(token);
  if (!check.ok) {
    console.error('\n  Refusing to issue: the generated key does not verify against the public key');
    console.error('  compiled into src/license.js — they are from different keypairs.');
    console.error(`  (${check.reason})\n`);
    process.exit(1);
  }

  const planMeta = PLANS.find((p) => p.id === plan);
  const money = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');

  console.log('\n  Licence issued\n');
  console.log(`    Store      ${payload.store}`);
  console.log(`    Plan       ${planMeta.label} (${money(planMeta.price)})`);
  if (payload.extras.length) console.log(`    Extras     ${payload.extras.join(', ')}`);
  console.log(`    Domains    ${payload.domains.length ? payload.domains.join(', ') : 'any (not domain-locked)'}`);
  console.log(`    Valid      ${issued.toISOString().slice(0, 10)} → ${expires.toISOString().slice(0, 10)} (${months} months)`);
  console.log(`    Grace      ${payload.graceDays} days past expiry`);
  console.log(`    Reference  ${license.shortId(payload)}`);
  console.log('\n  Key — paste into Admin → Licence, or set LICENSE_KEY:\n');
  console.log(`${token}\n`);

  // A local record, so "what does this client have?" is answerable without
  // asking them to read their key back over the phone.
  const log = fs.existsSync(ISSUED_LOG) ? JSON.parse(fs.readFileSync(ISSUED_LOG, 'utf8')) : [];
  log.push({ ...payload, reference: license.shortId(payload), token });
  fs.writeFileSync(ISSUED_LOG, JSON.stringify(log, null, 2) + '\n', { mode: 0o600 });
  console.log(`  Recorded in ${path.relative(ROOT, ISSUED_LOG)} (${log.length} licence${log.length === 1 ? '' : 's'} issued)\n`);
}

/* ----------------------------------------------------------------- list ---- */

function list() {
  if (!fs.existsSync(ISSUED_LOG)) {
    console.log('\n  No licences issued yet.\n');
    return;
  }
  const log = JSON.parse(fs.readFileSync(ISSUED_LOG, 'utf8'));
  console.log(`\n  ${log.length} licence(s) issued\n`);
  log.forEach((l) => {
    const days = Math.ceil((new Date(l.expires).getTime() - Date.now()) / 86400000);
    const state = days < 0 ? `EXPIRED ${Math.abs(days)}d ago` : `${days}d left`;
    console.log(`    ${l.reference.padEnd(20)} ${String(l.store).padEnd(24)} ${l.plan.padEnd(8)} ${state}`);
  });
  console.log('');
}

/* ----------------------------------------------------------------- main ---- */

if (args.keygen) keygen();
else if (args.list) list();
else if (args.store) issue();
else {
  console.log(`
  Licence issuing (agency machine only)

    --keygen                    create the signing keypair, once
    --list                      show every licence issued from this machine

    --store "Name"              issue a licence (required)
    --plan starter|growth|scale default: growth
    --months 12                 validity, default 12
    --domains a.com,b.com       optional domain lock
    --extras whatsapp,reports   features on top of the plan
    --grace 14                  days of grace after expiry
`);
}
