#!/usr/bin/env node
'use strict';

/**
 * Backup:  npm run backup
 *
 * One zip of everything that cannot be recreated: orders, products, reviews,
 * returns, discounts, the journal, admin accounts, the site config, and the
 * licence. Schedule it daily.
 *
 * Two things it deliberately does NOT do:
 *   · it does not include data/secrets.json unless you pass --with-secrets. API
 *     keys in a zip that gets emailed around is how a client's gateway gets
 *     drained. Restoring them is a two-minute job in the admin.
 *   · it does not write inside data/backups/. A backup on the same disk as the
 *     thing it protects is not a backup — it goes to ./backups/ so a sync tool or
 *     a cron job can copy the folder off the machine.
 *
 * Restoring is deliberately manual: unzip, look at what you are about to
 * overwrite, then copy the files in. There is no --restore flag, because the day
 * you need one is the day you should not be running a script you have never
 * tested against a live store.
 */

const fs = require('fs');
const path = require('path');
const { zip } = require('../src/zip');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const OUT_DIR = process.env.BACKUP_DIR ? path.resolve(process.env.BACKUP_DIR) : path.join(ROOT, 'backups');

const args = process.argv.slice(2);
const withSecrets = args.includes('--with-secrets');
const keep = (() => {
  const i = args.indexOf('--keep');
  const n = i >= 0 ? parseInt(args[i + 1], 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 30;
})();

/** Everything worth keeping, in the order a human would look for it. */
const FILES = [
  'orders', 'products', 'returns', 'reviews', 'discounts', 'journal',
  'marketing', 'users', 'invoice-counters', 'pincodes', 'activity', 'license'
];

function run() {
  if (!fs.existsSync(DATA_DIR)) {
    console.error(`\n  No data directory at ${DATA_DIR} — nothing to back up.\n`);
    process.exit(1);
  }

  const entries = [];
  const skipped = [];

  FILES.forEach((name) => {
    const file = path.join(DATA_DIR, name + '.json');
    if (fs.existsSync(file)) entries.push({ name: `data/${name}.json`, data: fs.readFileSync(file) });
    else skipped.push(name);
  });

  // The config is not in data/, but a store without it is not restorable.
  const configPath = process.env.SITE_CONFIG
    ? path.resolve(process.env.SITE_CONFIG)
    : path.join(ROOT, 'config', 'site.config.json');
  if (fs.existsSync(configPath)) {
    entries.push({ name: 'config/site.config.json', data: fs.readFileSync(configPath) });
  }

  const secretsPath = path.join(DATA_DIR, 'secrets.json');
  const hasSecrets = fs.existsSync(secretsPath);
  if (hasSecrets && withSecrets) {
    entries.push({ name: 'data/secrets.json', data: fs.readFileSync(secretsPath) });
  }

  // Uploaded customer media: referenced by URL from reviews and returns, so a
  // restore without them leaves broken images.
  const uploads = path.join(ROOT, 'public', 'uploads');
  let uploadCount = 0;
  if (fs.existsSync(uploads)) {
    const walk = (dir, prefix) => {
      fs.readdirSync(dir, { withFileTypes: true }).forEach((item) => {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) return walk(full, `${prefix}${item.name}/`);
        entries.push({ name: `uploads/${prefix}${item.name}`, data: fs.readFileSync(full) });
        uploadCount += 1;
      });
    };
    walk(uploads, '');
  }

  let brand = 'store';
  try {
    brand = JSON.parse(fs.readFileSync(configPath, 'utf8')).brand.name;
  } catch { /* a config we cannot parse is still worth backing up */ }

  const slug = String(brand).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'store';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `${slug}-backup-${stamp}.zip`;

  entries.unshift({
    name: 'README.txt',
    data: [
      `${brand} — backup`,
      `Taken ${new Date().toISOString()}`,
      `From ${DATA_DIR}`,
      '',
      'To restore: stop the server, copy data/ and config/ back over the live',
      'ones, copy uploads/ into public/uploads/, then start it again. Look at what',
      'you are overwriting first.',
      '',
      hasSecrets && !withSecrets
        ? 'API keys are NOT in this file. Re-enter them in Admin - Settings after a\nrestore, or run the backup with --with-secrets if you keep it somewhere safe.'
        : (withSecrets ? 'WARNING: this archive CONTAINS API keys. Treat it like a password.' : ''),
      '',
      `Files: ${entries.length}`
    ].filter(Boolean).join('\r\n') + '\r\n'
  });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, filename);
  fs.writeFileSync(out, zip(entries), { mode: 0o600 });

  const kb = (fs.statSync(out).size / 1024).toFixed(0);
  console.log(`\n  Backed up ${brand}\n`);
  console.log(`    ${path.relative(ROOT, out)}   ${kb} KB`);
  console.log(`    ${entries.length - 1} file(s)${uploadCount ? `, including ${uploadCount} upload(s)` : ''}`);
  if (skipped.length) console.log(`    not present yet: ${skipped.join(', ')}`);
  if (hasSecrets && !withSecrets) {
    console.log('\n    API keys excluded. Pass --with-secrets only if this archive');
    console.log('    goes somewhere you would keep a password.');
  }

  // Prune old archives so a daily cron does not fill the disk in a year.
  const old = fs.readdirSync(OUT_DIR)
    .filter((f) => f.startsWith(slug + '-backup-') && f.endsWith('.zip'))
    .sort()
    .reverse()
    .slice(keep);
  old.forEach((f) => fs.unlinkSync(path.join(OUT_DIR, f)));
  if (old.length) console.log(`    pruned ${old.length} archive(s) older than the last ${keep}`);

  console.log('\n    A backup on the same disk as the store is not a backup —');
  console.log('    copy this folder somewhere else.\n');
}

if (require.main === module) run();
module.exports = { run };
