'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = process.env.SITE_CONFIG
  ? path.resolve(process.env.SITE_CONFIG)
  : path.join(__dirname, '..', 'config', 'site.config.json');

let cached = null;

/**
 * Site config loader. In dev (NODE_ENV !== 'production') the JSON is re-read on
 * every request so a client can tweak colors/copy and just hit refresh.
 */
function loadConfig() {
  if (cached && process.env.NODE_ENV === 'production') return cached;
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  cached = JSON.parse(raw);
  return cached;
}

/** Called after the admin writes config so cached reads don't go stale. */
function invalidate() {
  cached = null;
}

function money(amount, config) {
  const c = (config || loadConfig()).currency;
  return c.symbol + Number(amount || 0).toLocaleString(c.locale, { maximumFractionDigits: 0 });
}

module.exports = { loadConfig, invalidate, money, CONFIG_PATH };
