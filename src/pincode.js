'use strict';

/**
 * Pincode → city + state.
 *
 * Three layers, in order, because a checkout field must never sit there spinning:
 *   1. Local cache (data/pincodes.json) — instant, and it grows as customers
 *      shop, so a repeat pincode never touches the network again.
 *   2. India Post's public API — free, no key, but it is someone else's uptime.
 *   3. A built-in prefix table — the first two digits of an Indian PIN identify
 *      the postal circle, so the STATE is always answerable offline even when
 *      the city isn't.
 *
 * Nothing here blocks for long: the API call has a hard timeout and a failure
 * degrades to layer 3 rather than erroring.
 */

const store = require('./store');

const API = 'https://api.postalpincode.in/pincode/';
const TIMEOUT_MS = 2500;
const CACHE_KEY = 'pincodes';

/** First two digits of a PIN → state. Bottom layer, always available. */
const PREFIX_STATE = {
  11: 'Delhi',
  12: 'Haryana', 13: 'Haryana',
  14: 'Punjab', 15: 'Punjab', 16: 'Punjab',
  17: 'Himachal Pradesh',
  18: 'Jammu and Kashmir', 19: 'Jammu and Kashmir',
  20: 'Uttar Pradesh', 21: 'Uttar Pradesh', 22: 'Uttar Pradesh', 23: 'Uttar Pradesh',
  24: 'Uttar Pradesh', 25: 'Uttar Pradesh', 26: 'Uttar Pradesh', 27: 'Uttar Pradesh', 28: 'Uttar Pradesh',
  30: 'Rajasthan', 31: 'Rajasthan', 32: 'Rajasthan', 33: 'Rajasthan', 34: 'Rajasthan',
  36: 'Gujarat', 37: 'Gujarat', 38: 'Gujarat', 39: 'Gujarat',
  40: 'Maharashtra', 41: 'Maharashtra', 42: 'Maharashtra', 43: 'Maharashtra', 44: 'Maharashtra',
  45: 'Madhya Pradesh', 46: 'Madhya Pradesh', 47: 'Madhya Pradesh', 48: 'Madhya Pradesh',
  49: 'Chhattisgarh',
  50: 'Telangana', 51: 'Andhra Pradesh', 52: 'Andhra Pradesh', 53: 'Andhra Pradesh',
  56: 'Karnataka', 57: 'Karnataka', 58: 'Karnataka', 59: 'Karnataka',
  60: 'Tamil Nadu', 61: 'Tamil Nadu', 62: 'Tamil Nadu', 63: 'Tamil Nadu', 64: 'Tamil Nadu',
  67: 'Kerala', 68: 'Kerala', 69: 'Kerala',
  70: 'West Bengal', 71: 'West Bengal', 72: 'West Bengal', 73: 'West Bengal', 74: 'West Bengal',
  75: 'Odisha', 76: 'Odisha', 77: 'Odisha',
  78: 'Assam', 79: 'Arunachal Pradesh',
  80: 'Bihar', 81: 'Bihar', 82: 'Bihar', 83: 'Jharkhand', 84: 'Bihar', 85: 'Jharkhand',
  90: 'Army Post Office', 91: 'Army Post Office', 92: 'Army Post Office',
  // 65/66 straddle Tamil Nadu / Puducherry; the API resolves those precisely.
  65: 'Tamil Nadu', 66: 'Tamil Nadu'
};

function normalise(pin) {
  return String(pin || '').replace(/\D/g, '').slice(0, 6);
}

function isValid(pin) {
  const p = normalise(pin);
  return /^[1-9]\d{5}$/.test(p);
}

/** State from the prefix table — the answer that never needs the network. */
function stateFromPrefix(pin) {
  const p = normalise(pin);
  if (p.length < 2) return null;
  return PREFIX_STATE[Number(p.slice(0, 2))] || null;
}

/* ------------------------------------------------------------- cache ---- */

function cached(pin) {
  const all = store.read(CACHE_KEY, {});
  return all[normalise(pin)] || null;
}

function remember(pin, entry) {
  const all = store.read(CACHE_KEY, {});
  all[normalise(pin)] = entry;
  store.write(CACHE_KEY, all, { skipBackup: true });
}

/* --------------------------------------------------------- resolution ---- */

async function fromApi(pin) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(API + normalise(pin), { signal: controller.signal });
    if (!res.ok) return null;
    const body = await res.json();
    const first = Array.isArray(body) ? body[0] : null;
    if (!first || first.Status !== 'Success' || !Array.isArray(first.PostOffice) || !first.PostOffice.length) return null;

    const offices = first.PostOffice;
    const head = offices.find((o) => o.BranchType === 'Head Post Office') || offices[0];
    return {
      city: head.District || head.Block || head.Name || '',
      state: head.State || '',
      // Localities let the customer pick their area instead of typing it.
      areas: [...new Set(offices.map((o) => o.Name).filter(Boolean))].slice(0, 12),
      source: 'india-post'
    };
  } catch {
    return null;   // timeout, offline, or malformed — layer 3 takes over
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolves a pincode. Always returns an object; `ok` says whether we have
 * anything useful, and `state`/`city` may be partially filled.
 */
async function lookup(pin) {
  const p = normalise(pin);
  if (!isValid(p)) return { ok: false, pincode: p, reason: 'Enter a 6-digit pincode.' };

  const hit = cached(p);
  if (hit) return { ok: true, pincode: p, ...hit, cached: true };

  const live = await fromApi(p);
  if (live && live.state) {
    remember(p, live);
    return { ok: true, pincode: p, ...live, cached: false };
  }

  const state = stateFromPrefix(p);
  if (state) {
    // Deliberately not cached: a prefix guess would then outrank a later real
    // lookup for this pincode.
    return { ok: true, pincode: p, city: '', state, areas: [], source: 'prefix', partial: true };
  }
  return { ok: false, pincode: p, reason: 'We couldn’t recognise that pincode.' };
}

/** Synchronous best effort — for server-side validation, never for the UI. */
function guess(pin) {
  const hit = cached(pin);
  if (hit) return { ...hit, pincode: normalise(pin) };
  const state = stateFromPrefix(pin);
  return state ? { city: '', state, pincode: normalise(pin), source: 'prefix' } : null;
}

module.exports = { lookup, guess, isValid, normalise, stateFromPrefix, PREFIX_STATE };
