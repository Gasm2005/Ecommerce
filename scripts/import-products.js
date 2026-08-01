#!/usr/bin/env node
'use strict';

/**
 * CLI bulk import — same parser, defaults and validation as the /admin UI.
 *
 *   npm run import -- products.csv
 *   npm run import -- products.csv --mode=upsert
 *   npm run import -- products.json --dry
 */

const fs = require('fs');
const path = require('path');
const importer = require('../src/importer');

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const modeArg = (args.find((a) => a.startsWith('--mode=')) || '').split('=')[1];
const dry = args.includes('--dry') || args.includes('--dry-run');

const MODES = ['append', 'upsert', 'replace'];

function die(msg) {
  console.error('\n  ✕ ' + msg + '\n');
  process.exit(1);
}

if (!file) {
  die('Usage: npm run import -- <file.csv|file.json> [--mode=append|upsert|replace] [--dry]');
}
if (modeArg && !MODES.includes(modeArg)) {
  die(`Unknown mode "${modeArg}". Use one of: ${MODES.join(', ')}`);
}

const abs = path.resolve(process.cwd(), file);
if (!fs.existsSync(abs)) die(`File not found: ${abs}`);

const text = fs.readFileSync(abs, 'utf8');
const format = /\.json$/i.test(abs) ? 'json' : 'csv';
const mode = modeArg || 'append';

const analysis = importer.analyse(text, { format, mode });

console.log(`\n  ${path.basename(abs)} · ${format.toUpperCase()} · mode: ${mode}`);

if (analysis.parseError) die('Parse error: ' + analysis.parseError);
if (!analysis.rows.length) die('No product rows found (a header row plus at least one product is required).');

if (analysis.unknownColumns.length) {
  console.log(`  ! ignored unknown columns: ${analysis.unknownColumns.join(', ')}`);
}

analysis.rows.forEach((r) => {
  const mark = r.action === 'skip' ? '✕' : (r.action === 'update' ? '↻' : '+');
  console.log(`  ${mark} line ${r.line}: ${r.product.name || '(no name)'} [${r.action}]`);
  r.errors.forEach((e) => console.log(`      error:   ${e}`));
  r.warnings.forEach((w) => console.log(`      warning: ${w}`));
});

const { total, create, update, skip } = analysis.counts;
console.log(`\n  ${total} rows → ${create} new, ${update} updates, ${skip} skipped`);

if (dry) {
  console.log('  (dry run — nothing written)\n');
  process.exit(0);
}
if (create + update === 0) die('Nothing importable — fix the errors above.');

const result = importer.commit(analysis);
console.log(`  ✓ wrote ${result.written} products to data/products.json`);
console.log(`  ✓ backup: ${result.backupPath}\n`);
