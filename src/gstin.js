'use strict';

/**
 * GSTIN validation.
 *
 * A GSTIN is checked properly — format AND checksum — because a typo here is not
 * a cosmetic problem. A wrong GSTIN on an invoice goes into GSTR-1, the buyer's
 * input credit fails to appear, and someone spends a week on the phone. Catching
 * it in the checkout field costs nothing.
 *
 * Structure of the 15 characters:
 *   1–2    state code          27
 *   3–12   the holder's PAN    AABCA1234A
 *   13     entity number       1     (nth registration in that state)
 *   14     'Z'                 reserved, always Z in practice
 *   15     checksum            mod-36 over the first 14
 */

const { STATE_CODES } = require('./invoice');

const SHAPE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function normalise(value) {
  return String(value || '').toUpperCase().replace(/[\s-]/g, '');
}

/**
 * The official mod-36 check character. Each position is weighted alternately 1
 * and 2; the products are divided by 36 and the quotient plus remainder summed.
 */
function checksum(first14) {
  let total = 0;
  for (let i = 0; i < 14; i += 1) {
    const value = ALPHABET.indexOf(first14[i]);
    if (value < 0) return null;
    const weighted = value * (i % 2 === 0 ? 1 : 2);
    total += Math.floor(weighted / 36) + (weighted % 36);
  }
  return ALPHABET[(36 - (total % 36)) % 36];
}

const validStateCodes = new Set(Object.values(STATE_CODES));

/**
 * Returns { ok, gstin, stateCode, pan, reason }.
 *
 * An empty value is VALID and simply means "not a business purchase" — the field
 * is optional, and refusing a blank one would block every retail customer.
 */
function check(value) {
  const gstin = normalise(value);
  if (!gstin) return { ok: true, gstin: '', empty: true };

  if (gstin.length !== 15) {
    return { ok: false, gstin, reason: 'A GSTIN is exactly 15 characters.' };
  }
  if (!SHAPE.test(gstin)) {
    return { ok: false, gstin, reason: 'That does not look like a GSTIN — check it against your registration certificate.' };
  }
  if (!validStateCodes.has(gstin.slice(0, 2))) {
    return { ok: false, gstin, reason: `“${gstin.slice(0, 2)}” is not a valid GST state code.` };
  }

  const expected = checksum(gstin.slice(0, 14));
  if (expected !== gstin[14]) {
    // Almost always a mistyped character rather than a fake number.
    return { ok: false, gstin, reason: 'That GSTIN fails its check digit — one character is probably mistyped.' };
  }

  return {
    ok: true,
    gstin,
    stateCode: gstin.slice(0, 2),
    pan: gstin.slice(2, 12),
    state: Object.keys(STATE_CODES).find((k) => STATE_CODES[k] === gstin.slice(0, 2) && k.length > 2) || null
  };
}

/** Convenience for templates and filters. */
function isValid(value) {
  const out = check(value);
  return out.ok && !out.empty;
}

module.exports = { check, isValid, normalise, checksum, SHAPE };
