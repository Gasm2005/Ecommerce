'use strict';

/**
 * API keys and secrets — kept deliberately separate from config/site.config.json.
 *
 * Why a separate file: the whole site config is handed to every view as a local
 * (theme colours, nav, copy). A secret in there is one careless `<%= %>` away
 * from being printed into a page. Nothing in this module is ever exposed to a
 * view; routes read a value only at the moment they call an API.
 *
 * Values can also come from the environment, which wins over the file — so a
 * self-hosted client can keep keys out of the repo entirely, while the hosted
 * multi-tenant setup writes them per store from the admin UI.
 *
 *   secrets.get('payments.razorpay.keySecret')
 *   secrets.set('payments.razorpay.keySecret', 'rzp_live_…')
 *   secrets.masked('payments.razorpay.keySecret')   → '••••••••3f9a'
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'secrets.json');

/** Dotted path → the env var checked first: payments.razorpay.keySecret → PAYMENTS_RAZORPAY_KEYSECRET */
function envName(key) {
  return String(key).replace(/\./g, '_').replace(/([a-z0-9])([A-Z])/g, '$1$2').toUpperCase();
}

function readAll() {
  try {
    if (!fs.existsSync(FILE)) return {};
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeAll(value) {
  const dir = path.dirname(FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

function dig(obj, key) {
  return String(key).split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

function plant(obj, key, value) {
  const parts = String(key).split('.');
  const last = parts.pop();
  let node = obj;
  parts.forEach((p) => {
    if (!node[p] || typeof node[p] !== 'object') node[p] = {};
    node = node[p];
  });
  if (value === null || value === '') delete node[last];
  else node[last] = value;
  return obj;
}

/** Environment first, then the file. Returns '' when unset, never undefined. */
function get(key) {
  const fromEnv = process.env[envName(key)];
  if (fromEnv) return String(fromEnv);
  const fromFile = dig(readAll(), key);
  return fromFile === undefined || fromFile === null ? '' : String(fromFile);
}

function has(key) {
  return get(key).trim() !== '';
}

function set(key, value) {
  const all = readAll();
  plant(all, key, value === undefined || value === null ? '' : String(value).trim());
  writeAll(all);
  return true;
}

/** Bulk write; blank values leave the stored one alone (so a masked form can post back). */
function setMany(pairs) {
  const all = readAll();
  Object.entries(pairs).forEach(([key, value]) => {
    const v = value === undefined || value === null ? '' : String(value).trim();
    if (v === '') return;                       // blank = "unchanged"
    plant(all, key, v === '__clear__' ? '' : v); // explicit sentinel to wipe
  });
  writeAll(all);
  return true;
}

/** Safe to render: shows only the last four characters. */
function masked(key) {
  const v = get(key);
  if (!v) return '';
  if (v.length <= 4) return '••••';
  return '••••••••' + v.slice(-4);
}

/** Where a value is coming from — useful in the admin UI. */
function sourceOf(key) {
  if (process.env[envName(key)]) return 'environment';
  if (dig(readAll(), key)) return 'saved';
  return 'unset';
}

module.exports = { get, set, setMany, has, masked, sourceOf, envName, FILE };
