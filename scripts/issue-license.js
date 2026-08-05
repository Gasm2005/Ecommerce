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


const license = require('../src/license');
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

/* -------------------------------------------------------------- keygen ---- */

function keygen() {
  let out;
  try {
    out = minting.keygen({ force: !!args.force });
  } catch (err) {
    console.error('\n  ' + err.message);
    console.error('  Pass --force only if you mean that.\n');
    process.exit(1);
  }

  console.log('\n  Keypair generated.\n');
  console.log(`  Private key  ${out.privateKeyPath}   (mode 600, git-ignored)`);
  console.log('               Back this up. Losing it means reissuing every licence.\n');
  console.log('  Public key — paste into src/license.js as PUBLIC_KEY_B64:\n');
  console.log(`    '${out.publicKeyB64}'\n`);
}

/* --------------------------------------------------------------- issue ---- */

function issue() {
  const csv = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);

  let out;
  try {
    // Signing lives in src/minting.js so the provisioning script produces identical
    // bytes; it also verifies before returning, so nothing unusable gets printed.
    out = minting.mint({
      store: args.store,
      plan: String(args.plan || 'growth'),
      months: Number(args.months || 12),
      extras: csv(args.extras),
      domains: csv(args.domains),
      graceDays: args.grace
    });
  } catch (err) {
    console.error('\n  Refusing to issue: ' + err.message + '\n');
    process.exit(1);
  }

  const { token, payload } = out;
  const planMeta = PLANS.find((p) => p.id === payload.plan);
  const money = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');

  console.log('\n  Licence issued\n');
  console.log(`    Store      ${payload.store}`);
  console.log(`    Plan       ${planMeta.label} (${money(planMeta.price)})`);
  if (payload.extras.length) console.log(`    Extras     ${payload.extras.join(', ')}`);
  console.log(`    Domains    ${payload.domains.length ? payload.domains.join(', ') : 'any (not domain-locked)'}`);
  console.log(`    Valid      ${payload.issued.slice(0, 10)} → ${payload.expires.slice(0, 10)} (${out.months} months)`);
  console.log(`    Grace      ${payload.graceDays} days past expiry`);
  console.log(`    Reference  ${out.reference}`);
  console.log('\n  Key — paste into Admin → Licence, or set LICENSE_KEY:\n');
  console.log(`${token}\n`);

  const count = minting.record({ ...payload, reference: out.reference, token });
  console.log(`  Recorded in ${minting.relative(minting.ISSUED_LOG)} (${count} licence${count === 1 ? '' : 's'} issued)\n`);
}

/* ----------------------------------------------------------------- list ---- */

function list() {
  const log = minting.issuedLog();
  if (!log.length) {
    console.log('\n  No licences issued yet.\n');
    return;
  }
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
