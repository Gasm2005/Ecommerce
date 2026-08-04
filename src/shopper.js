'use strict';

/**
 * Who the shopper is, without an account.
 *
 * Most people who buy ethnic wear buy two or three times a year. Making them
 * create a password for that is a checkout step that earns nothing, so this
 * remembers them the way a good shop assistant does: name, phone, the addresses
 * they have used, and which orders are theirs.
 *
 * It is SIGNED, not just stored. The order ids in here decide who may read an
 * order, and order ids are sequential — ORD-00042 tells you ORD-00041 exists. An
 * unsigned cookie would let anyone list someone else's purchase by typing a number
 * into their own cookie. The signature is the whole reason this file exists rather
 * than a plain JSON cookie like the cart.
 *
 * It is not a security boundary for anything that matters more than that: it proves
 * "this browser placed that order", which is exactly what a guest checkout can
 * honestly claim. Real accounts come next, and they replace this as the stronger
 * proof while this keeps working for everyone who never signs up.
 */

const crypto = require('crypto');
const secrets = require('./secrets');

const COOKIE = 'aanya_shopper';
/** Two years: long enough to still know a customer who buys once a season. */
const MAX_AGE = 1000 * 60 * 60 * 24 * 730;
/** Keep the cookie small — browsers drop what grows past ~4KB, silently. */
const MAX_ORDERS = 40;
const MAX_ADDRESSES = 5;

/** Signing key, generated once and kept with the other secrets. */
function signingKey() {
  let key = secrets.get('shopper.cookieKey');
  if (!key) {
    key = crypto.randomBytes(32).toString('base64');
    secrets.set('shopper.cookieKey', key);
  }
  return Buffer.from(key, 'base64');
}

function sign(body) {
  return crypto.createHmac('sha256', signingKey()).update(body).digest('base64url');
}

function encode(data) {
  const body = Buffer.from(JSON.stringify(data), 'utf8').toString('base64url');
  return `${body}.${sign(body)}`;
}

function decode(raw) {
  const value = String(raw || '');
  const dot = value.lastIndexOf('.');
  if (dot < 1) return null;

  const body = value.slice(0, dot);
  const mac = value.slice(dot + 1);

  const expected = sign(body);
  // Constant-time, and length-guarded: timingSafeEqual throws on a length mismatch.
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;

  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ shape ---- */

function blank() {
  return { name: '', email: '', phone: '', orderIds: [], addresses: [] };
}

/** The shopper this request belongs to. Always an object, never null. */
function current(req) {
  const data = decode(req && req.cookies && req.cookies[COOKIE]);
  if (!data) return blank();

  return {
    name: String(data.name || ''),
    email: String(data.email || ''),
    phone: String(data.phone || ''),
    orderIds: Array.isArray(data.orderIds) ? data.orderIds.map(String).slice(0, MAX_ORDERS) : [],
    addresses: Array.isArray(data.addresses) ? data.addresses.slice(0, MAX_ADDRESSES) : []
  };
}

function isKnown(shopper) {
  const s = shopper || blank();
  return !!(s.name || s.phone || s.email || s.orderIds.length);
}

function save(res, data) {
  res.cookie(COOKIE, encode(data), {
    httpOnly: true, sameSite: 'lax', path: '/', maxAge: MAX_AGE
  });
  return data;
}

function forget(res) {
  res.clearCookie(COOKIE, { path: '/' });
  return blank();
}

/* -------------------------------------------------------------- addresses ---- */

const ADDRESS_FIELDS = ['fullName', 'phone', 'pincode', 'address1', 'address2', 'landmark', 'city', 'state'];

function addressFrom(state) {
  const out = {};
  ADDRESS_FIELDS.forEach((k) => {
    const v = String((state && state[k]) || '').trim();
    if (v) out[k] = v;
  });
  return out;
}

/**
 * Two addresses are "the same place" when the door and the pincode match. Deliberately
 * loose about the rest: someone who writes "Flat 4B" one time and "4B" the next has not
 * moved house, and offering them both is how a saved-address list becomes useless.
 */
function sameAddress(a, b) {
  const key = (x) => [
    String((x && x.address1) || '').toLowerCase().replace(/[^a-z0-9]/g, ''),
    String((x && x.pincode) || '').replace(/\D/g, '')
  ].join('|');
  return key(a) === key(b) && key(a) !== '|';
}

/** Remembers an address, newest first, without duplicating a place already known. */
function rememberAddress(shopper, state) {
  const address = addressFrom(state);
  if (!address.address1 || !address.pincode) return shopper.addresses;

  const rest = shopper.addresses.filter((a) => !sameAddress(a, address));
  return [address, ...rest].slice(0, MAX_ADDRESSES);
}

/* ----------------------------------------------------------------- orders ---- */

function ownsOrder(shopper, orderId) {
  const id = String(orderId || '').trim().toUpperCase();
  if (!id) return false;
  return (shopper.orderIds || []).some((x) => String(x).toUpperCase() === id);
}

/**
 * Called when an order is placed: this browser now owns that order, and whatever
 * they typed becomes what we know about them.
 *
 * Details are only overwritten when the new order actually carries them, so a
 * customer who leaves the email blank on their second order does not lose the one
 * we already had.
 */
function rememberOrder(res, shopper, { order, state }) {
  const id = String((order && order.id) || '').toUpperCase();
  const next = {
    name: String((state && state.fullName) || shopper.name || '').trim(),
    email: String((state && state.email) || shopper.email || '').trim(),
    phone: String((state && state.phone) || shopper.phone || '').trim(),
    orderIds: id
      ? [id, ...(shopper.orderIds || []).filter((x) => String(x).toUpperCase() !== id)].slice(0, MAX_ORDERS)
      : shopper.orderIds,
    addresses: rememberAddress(shopper, state)
  };
  save(res, next);
  return next;
}

/**
 * The checkout state a returning shopper should open with.
 *
 * Only fills what is still blank. A half-typed address must never be overwritten by
 * a remembered one — someone changing their address on a page that reloads would
 * watch their new street revert to the old one, and post a parcel to a house they
 * moved out of.
 */
function prefill(state, me) {
  const saved = (me && me.addresses && me.addresses[0]) || null;
  const filled = { ...(state || {}) };
  if (!me) return filled;

  if (saved) {
    ADDRESS_FIELDS.forEach((k) => {
      if (!String(filled[k] || '').trim() && saved[k]) filled[k] = saved[k];
    });
  }
  if (!String(filled.email || '').trim() && me.email) filled.email = me.email;
  if (!String(filled.fullName || '').trim() && me.name) filled.fullName = me.name;
  return filled;
}

module.exports = {
  COOKIE, MAX_AGE, MAX_ORDERS, MAX_ADDRESSES, ADDRESS_FIELDS,
  encode, decode, blank, current, isKnown, save, forget,
  addressFrom, sameAddress, rememberAddress, ownsOrder, rememberOrder, prefill
};
