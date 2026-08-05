#!/usr/bin/env node
'use strict';

/**
 * Pre-launch check:  npm run doctor
 *
 * Run this on the client's server before pointing their domain at it. It answers
 * one question — "is anything about this deployment going to embarrass us?" —
 * and it is the difference between finding a missing GSTIN now and finding it
 * when the first customer asks for an invoice.
 *
 * Three levels:
 *   FAIL  blocks a launch. Exit code 1, so CI or a deploy script can stop.
 *   WARN  works, but someone should look.
 *   OK    verified, printed so the check is visibly a check and not a promise.
 *
 * Nothing here writes anything. It is safe to run against a live store.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const results = [];
const add = (level, area, message, fix) => results.push({ level, area, message, fix });
const ok = (area, m) => add('OK', area, m);
const warn = (area, m, fix) => add('WARN', area, m, fix);
const fail = (area, m, fix) => add('FAIL', area, m, fix);

/* ------------------------------------------------------------ runtime ---- */

function checkRuntime() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    fail('Runtime', `Node ${process.versions.node} is too old — fetch() and the test runner need 18+.`,
      'Install Node 20 LTS or newer.');
  } else {
    ok('Runtime', `Node ${process.versions.node}`);
  }

  if (process.env.NODE_ENV !== 'production') {
    warn('Runtime', `NODE_ENV is "${process.env.NODE_ENV || 'unset'}" — config and product files are re-read on every request.`,
      'Set NODE_ENV=production on the client server (ecosystem.config.js does this).');
  } else {
    ok('Runtime', 'NODE_ENV=production');
  }
}

/* --------------------------------------------------------- filesystem ---- */

function checkStorage() {
  const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');

  if (!fs.existsSync(dataDir)) {
    return fail('Storage', `Data directory is missing: ${dataDir}`, 'Create it, or run npm run provision.');
  }
  try {
    const probe = path.join(dataDir, '.doctor-probe');
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    ok('Storage', `Data directory is writable: ${dataDir}`);
  } catch (err) {
    fail('Storage', `Cannot write to ${dataDir} — orders will fail silently.`,
      `Fix ownership/permissions: ${err.code}`);
  }

  // Every order rewrites the whole file. Fine at a boutique's volume; worth
  // saying out loud before it isn't.
  const ordersFile = path.join(dataDir, 'orders.json');
  if (fs.existsSync(ordersFile)) {
    const mb = fs.statSync(ordersFile).size / (1024 * 1024);
    if (mb > 20) {
      warn('Storage', `orders.json is ${mb.toFixed(1)} MB and is rewritten on every order.`,
        'Time to move this store to SQLite.');
    } else {
      ok('Storage', `orders.json is ${mb.toFixed(1)} MB`);
    }
  }

  const backups = path.join(dataDir, 'backups');
  if (!fs.existsSync(backups)) {
    warn('Storage', 'No backups have ever been taken.', 'Schedule: npm run backup');
  } else {
    const files = fs.readdirSync(backups).filter((f) => f.endsWith('.json') || f.endsWith('.zip'));
    const newest = files
      .map((f) => fs.statSync(path.join(backups, f)).mtimeMs)
      .sort((a, b) => b - a)[0];
    const days = newest ? (Date.now() - newest) / 86400000 : Infinity;
    if (!files.length || days > 7) {
      warn('Storage', `Last backup was ${files.length ? Math.round(days) + ' days ago' : 'never'}.`,
        'Schedule npm run backup daily (cron or Task Scheduler).');
    } else {
      ok('Storage', `Backed up ${Math.round(days * 24)} hours ago`);
    }
  }
}

/* -------------------------------------------------------------- store ---- */

function checkConfig() {
  let config;
  try {
    config = require('../src/config').loadConfig();
  } catch (err) {
    return fail('Config', 'site.config.json will not parse: ' + err.message, 'Fix the JSON.');
  }

  /* Shared with the provisioning script so the two cannot drift. It also strips
     diacritics: the demo brand is "AANYÄ", and /aanya/i never matched it, so this
     check had been passing on the support email alone. */
  const { looksLikeDemo } = require('../src/provision');
  if (looksLikeDemo(config.brand.name) || looksLikeDemo(config.brand.supportEmail)) {
    fail('Config', `Brand is still the demo one ("${config.brand.name}").`,
      'Run npm run provision, or edit config/site.config.json.');
  } else {
    ok('Config', `Brand: ${config.brand.name}`);
  }

  const plans = require('../src/plan');
  const plan = plans.planOf(config);
  if (!config.plan) {
    warn('Config', 'No plan set — the client gets the full platform.',
      'Set "plan" in config/site.config.json to what they paid for.');
  } else {
    const locked = plans.overview(config).locked.length;
    ok('Config', `Plan: ${plan.label} (${locked} feature${locked === 1 ? '' : 's'} locked)`);
  }

  // GST invoices are a legal document; a missing field is not a style issue.
  const invoice = require('../src/invoice');
  const readiness = invoice.readiness(config);
  if (!readiness.ok) {
    fail('GST', `Invoices are missing: ${readiness.missing.join(', ')}.`,
      'Admin → Settings → Business & tax invoice.');
  } else {
    ok('GST', `Invoices ready (GSTIN ${readiness.business.gstin}, series ${readiness.business.invoicePrefix})`);
  }

  const products = require('../src/catalog').all();
  if (!products.length) {
    fail('Catalogue', 'There are no products.', 'Import them: Admin → Bulk upload.');
  } else {
    const noImage = products.filter((p) => !p.images || !p.images.length || p.images.every((i) => i.includes('ph.svg')));
    const noPrice = products.filter((p) => !p.price);
    if (noPrice.length) fail('Catalogue', `${noPrice.length} product(s) have no price.`, 'They cannot be sold.');
    if (noImage.length) {
      warn('Catalogue', `${noImage.length} of ${products.length} products still use placeholder art.`,
        'Upload real photography before launch.');
    }
    ok('Catalogue', `${products.length} products`);
  }
}

/* --------------------------------------------------------- who can in ---- */

function checkAccess() {
  const auth = require('../src/auth');
  const users = auth.users();

  if (!users.length) {
    return fail('Access', 'No admin account exists — the admin will offer first-run setup to anyone who finds it.',
      'Run npm run provision, or open /admin/setup immediately after deploying.');
  }
  const owners = users.filter((u) => u.role === 'owner' && u.active);
  if (!owners.length) {
    fail('Access', 'No active owner account.', 'Promote someone: /admin/account.');
  } else {
    ok('Access', `${users.length} admin account(s), ${owners.length} owner(s)`);
  }

  if (process.env.ADMIN_TOKEN) {
    fail('Access', 'ADMIN_TOKEN is set — anyone with that URL bypasses the login entirely.',
      'Unset it now that real accounts exist. It is a first-run escape hatch, not a login.');
  } else {
    ok('Access', 'No ADMIN_TOKEN bypass');
  }

  // A password we handed over must not still be in use.
  const known = ['InvoiceTest123', 'StaffTest12345', 'ChangeMe123', 'Password123'];
  const reused = users.filter((u) => known.some((p) => auth.verifyPassword(p, u.passwordHash)));
  if (reused.length) {
    fail('Access', `${reused.length} account(s) still use a handover password (${reused.map((u) => u.email).join(', ')}).`,
      'Have the client change it at /admin/account.');
  } else {
    ok('Access', 'No known handover passwords in use');
  }

  const sessionKey = require('../src/secrets').get('auth.sessionKey');
  if (!sessionKey) {
    warn('Access', 'No session key stored yet — it is generated on first sign-in.', 'Sign in once.');
  } else {
    ok('Access', 'Session signing key present');
  }
}

/* ------------------------------------------------------- integrations ---- */

function checkIntegrations() {
  const config = require('../src/config').loadConfig();
  const payments = require('../src/payments');
  const notifications = require('../src/notifications');
  const plans = require('../src/plan');

  const pay = payments.status(config);
  if (!plans.hasFeature(config, 'payment-gateway')) {
    ok('Payments', 'Not in this plan — manual/COD only');
  } else if (!pay.live) {
    warn('Payments', `Gateway "${pay.provider}" is selected but not connected — orders fall back to manual.`,
      'Admin → Settings → Payments, add the client’s own keys.');
  } else if (pay.mode === 'test') {
    fail('Payments', `${pay.provider} is in TEST mode — real cards will not be charged.`,
      'Switch to live keys before launch.');
  } else {
    ok('Payments', `${pay.provider} live`);
  }

  const notif = notifications.status(config);
  if (notif.provider === 'log') {
    fail('Email', 'Email provider is "log" — order confirmations are printed to the console, not sent.',
      'Admin → Settings → Notifications, connect SMTP/Resend/Brevo.');
  } else if (!notif.ready) {
    fail('Email', `${notif.provider} is selected but has no credentials: ${(notif.missing || []).join(', ')}.`,
      'Add the API key.');
  } else {
    /* Credentials present is not the same as mail arriving. An expired SMTP password
       or a revoked API key leaves every check saying "ready" while no confirmation
       reaches a customer, so read the delivery log rather than the settings. */
    const mail = notifications.health();
    if (mail.broken) {
      fail('Email', `${mail.consecutiveFailures} sends in a row have failed — ${mail.reason}`,
        'Re-check the credentials, then use the test send in Admin → Marketing.');
    } else if (mail.failed) {
      warn('Email', `${mail.failed} of the last ${mail.attempts} sends failed — ${mail.reason}`,
        'One-off failures are usually the network; a pattern is not.');
    } else if (!mail.attempts) {
      warn('Email', `${notif.label || notif.provider} configured, but nothing has been sent yet.`,
        'Send a test from Admin → Marketing before launch.');
    } else {
      ok('Email', `${notif.label || notif.provider} — last ${mail.attempts} sends delivered`);
    }
  }

  const media = require('../src/media').available();
  if (!media.image) {
    warn('Media', 'sharp is unavailable — uploads will not be compressed to WebP.', 'npm install');
  } else {
    ok('Media', 'Image compression available' + (media.video ? ' · video too' : ''));
  }
  if (!media.video) {
    warn('Media', 'ffmpeg is unavailable — customer videos are stored uncompressed.', 'npm install');
  }
}

/* ----------------------------------------------------------- licence ---- */

function checkLicence() {
  const license = require('../src/license');
  const status = license.status(process.env.PUBLIC_HOST);

  if (status.state === 'unlicensed') {
    warn('Licence', 'No licence key installed — the store runs on the plan in its config file.',
      'Issue one: node scripts/issue-license.js --store "Name" --plan growth --months 12');
    return;
  }
  if (status.restricted) {
    fail('Licence', status.reason || `Licence state: ${status.state}.`,
      'Install a current key at Admin → Licence.');
    return;
  }
  if (status.state === 'grace') {
    fail('Licence', status.reason, 'Renew before the grace period ends and the admin locks.');
    return;
  }
  if (status.state === 'expiring') {
    warn('Licence', status.reason, 'Issue a renewal key.');
    return;
  }
  ok('Licence', `${status.licence.plan} · ${status.licence.store} · ${status.daysLeft} days left · ${license.shortId(status.licence)}`);

  if (!(status.licence.domains || []).length) {
    warn('Licence', 'This licence is not domain-locked — the same key works on any host.',
      'Reissue with --domains theirdomain.com for a client deployment.');
  }
}

/* -------------------------------------------------------- deployment ---- */

function checkDeployment() {
  const eco = path.join(ROOT, 'ecosystem.config.js');
  if (!fs.existsSync(eco)) {
    warn('Deploy', 'No ecosystem.config.js — nothing pins pm2 to a single worker.',
      'Copy it from the template. Cluster mode loses orders.');
  } else {
    const src = fs.readFileSync(eco, 'utf8');
    // Read the number rather than pattern-matching around it: `\s*` can match
    // nothing, so a lookahead here tests the space, not the digit, and reports
    // every config as clustered.
    const instances = (/instances:\s*(\d+)/.exec(src) || [])[1];
    const clustered = /exec_mode:\s*['"]cluster['"]/.test(src);
    if ((instances && Number(instances) !== 1) || clustered) {
      fail('Deploy', 'pm2 is configured for more than one worker — this store loses orders in cluster mode.',
        'Set instances: 1 and exec_mode: "fork".');
    } else {
      ok('Deploy', 'pm2 pinned to a single worker');
    }
  }

  if (fs.existsSync(path.join(ROOT, 'data', 'secrets.json'))) {
    const mode = fs.statSync(path.join(ROOT, 'data', 'secrets.json')).mode & 0o777;
    if (os.platform() !== 'win32' && mode !== 0o600) {
      warn('Deploy', `data/secrets.json is mode ${mode.toString(8)} — other users on this server can read the API keys.`,
        'chmod 600 data/secrets.json');
    } else {
      ok('Deploy', 'Secrets file present');
    }
  }

  // The one file that must never exist on a client's machine.
  if (fs.existsSync(path.join(ROOT, '.license-keys', 'private.pem'))) {
    fail('Deploy', 'The licence SIGNING KEY is present on this machine.',
      'If this is a client server, delete .license-keys/ now — it can mint licences for every store.');
  }

  const gitignore = path.join(ROOT, '.gitignore');
  if (fs.existsSync(gitignore)) {
    const src = fs.readFileSync(gitignore, 'utf8');
    if (!/data\/secrets\.json/.test(src)) {
      fail('Deploy', 'data/secrets.json is not git-ignored — API keys will be committed.',
        'Add it to .gitignore.');
    } else {
      ok('Deploy', 'Secrets are git-ignored');
    }
  }
}

/* -------------------------------------------------------------- print ---- */

function run() {
  [checkRuntime, checkStorage, checkConfig, checkLicence, checkAccess, checkIntegrations, checkDeployment]
    .forEach((check) => {
      try {
        check();
      } catch (err) {
        fail(check.name, 'Check itself crashed: ' + err.message, 'This is a bug in doctor.js.');
      }
    });

  const colour = { OK: '\x1b[32m', WARN: '\x1b[33m', FAIL: '\x1b[31m' };
  const reset = '\x1b[0m';
  const config = (() => { try { return require('../src/config').loadConfig(); } catch { return null; } })();

  console.log(`\n  Pre-launch check — ${config ? config.brand.name : 'unknown store'}\n`);

  let area = null;
  results.forEach((r) => {
    if (r.area !== area) { area = r.area; console.log(`  ${area}`); }
    console.log(`    ${colour[r.level]}${r.level.padEnd(4)}${reset}  ${r.message}`);
    if (r.fix && r.level !== 'OK') console.log(`          → ${r.fix}`);
  });

  const fails = results.filter((r) => r.level === 'FAIL').length;
  const warns = results.filter((r) => r.level === 'WARN').length;

  console.log('');
  if (fails) {
    console.log(`  ${colour.FAIL}${fails} blocker${fails === 1 ? '' : 's'}${reset}` +
      (warns ? ` and ${warns} warning${warns === 1 ? '' : 's'}` : '') + ' — not ready to launch.\n');
    process.exit(1);
  }
  console.log(`  ${colour.OK}Ready to launch${reset}` +
    (warns ? ` — ${warns} warning${warns === 1 ? '' : 's'} worth a look.` : '.') + '\n');
}

if (require.main === module) run();
module.exports = { run, results };
