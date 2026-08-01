'use strict';

/**
 * Tiny JSON data store used by every admin module.
 *
 * Reads are cached in production and re-read in dev; writes are atomic-ish
 * (temp file + rename) and take a timestamped backup first, so any admin action
 * is recoverable from data/backups/.
 *
 * SINGLE PROCESS ONLY. read → mutate → write inside update() is fully
 * synchronous, so two requests in one Node process can never interleave. But the
 * cache below is per-process: run this under pm2 cluster mode and two workers
 * will each write from their own stale copy, silently losing an order. server.js
 * refuses to boot in that situation rather than let it happen quietly.
 *
 * DATA_DIR can be pointed elsewhere (tests, and later one directory per tenant).
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

const cache = new Map();

function file(name) {
  return path.join(DATA_DIR, name + '.json');
}

function read(name, fallback) {
  const isProd = process.env.NODE_ENV === 'production';
  if (isProd && cache.has(name)) return cache.get(name);

  const p = file(name);
  let value;
  if (!fs.existsSync(p)) {
    value = typeof fallback === 'function' ? fallback() : (fallback === undefined ? [] : fallback);
  } else {
    try {
      value = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (err) {
      throw new Error(`data/${name}.json is not valid JSON: ${err.message}`);
    }
  }
  cache.set(name, value);
  return value;
}

function backup(name) {
  const p = file(name);
  if (!fs.existsSync(p)) return null;
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(BACKUP_DIR, `${name}-${stamp}.json`);
  fs.copyFileSync(p, dest);
  return path.relative(path.join(__dirname, '..'), dest);
}

function write(name, value, { skipBackup = false } = {}) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const backupPath = skipBackup ? null : backup(name);
  const p = file(name);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);
  cache.set(name, value);
  return { backupPath };
}

/** read → mutate → write in one call. The callback may return a new value. */
function update(name, fallback, mutator, opts) {
  const current = read(name, fallback);
  const next = mutator(current);
  return write(name, next === undefined ? current : next, opts);
}

function invalidate(name) {
  if (name) cache.delete(name);
  else cache.clear();
}

/** Sequential, human-readable ids: ORD-00042, REV-00007, … */
function nextId(prefix, list, key = 'id') {
  let max = 0;
  const re = new RegExp('^' + prefix + '-(\\d+)$');
  (list || []).forEach((row) => {
    const m = re.exec(String(row[key] || ''));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return `${prefix}-${String(max + 1).padStart(5, '0')}`;
}

function slugify(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
}

module.exports = { read, write, update, backup, invalidate, nextId, slugify, DATA_DIR, BACKUP_DIR };
