'use strict';

/**
 * Audit trail for admin actions — who changed what, when. Capped so the file
 * can't grow without bound.
 */

const store = require('./store');

const LIMIT = 400;

function all() {
  return store.read('activity', []);
}

function log(area, message, meta) {
  const entry = {
    at: new Date().toISOString(),
    area,
    message,
    meta: meta || null
  };
  store.update('activity', [], (list) => [entry, ...list].slice(0, LIMIT), { skipBackup: true });
  return entry;
}

function recent(n = 12) {
  return all().slice(0, n);
}

module.exports = { log, all, recent };
