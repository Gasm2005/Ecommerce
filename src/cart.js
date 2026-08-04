'use strict';

const catalog = require('./catalog');
const discounts = require('./discounts');

const CART_COOKIE = 'aanya_cart';
const WISH_COOKIE = 'aanya_wishlist';
const DISCOUNT_COOKIE = 'aanya_discount';
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days — cart survives a browser restart
  path: '/'
};

function decode(raw) {
  if (!raw) return [];
  try {
    const json = Buffer.from(String(raw), 'base64').toString('utf8');
    const val = JSON.parse(json);
    return Array.isArray(val) ? val : [];
  } catch {
    return [];
  }
}

function encode(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function lineKey(item) {
  return [item.id, item.size || '-', item.color || '-'].join('|');
}

/* ---------------------------------------------------------------- cart ---- */

function readCart(req) {
  return decode(req.cookies && req.cookies[CART_COOKIE]);
}

/**
 * Persists the cart and mirrors it back onto req.cookies, so anything rendered
 * later in the same request/response cycle sees the mutation (not the cookie the
 * browser sent us).
 */
function writeCart(req, res, lines) {
  const encoded = encode(lines);
  res.cookie(CART_COOKIE, encoded, COOKIE_OPTS);
  if (req.cookies) req.cookies[CART_COOKIE] = encoded;
  return lines;
}

/**
 * How many of a product may be in the cart.
 *
 * Capped against the stock for THIS SIZE AND COLOUR, not the product total. A
 * kurti with twelve pieces across M, L and XL must not sell twelve XL — that is
 * a refund and an apology, and it was the behaviour before variants existed.
 *
 * Untracked stock (made to order) is capped only by the per-line limit. And the
 * buy button being hidden in the UI is not a control: anyone can POST straight to
 * this route, so the limit is enforced here.
 */
const LINE_LIMIT = 10;

function stockCap(product, choice) {
  const variants = require('./variants');
  const available = variants.stockFor(product, choice || {});
  if (available === null) return LINE_LIMIT;   // untracked — made to order
  return Math.max(0, Math.min(LINE_LIMIT, available));
}

function addToCart(req, res, { id, size, color, qty }) {
  const product = catalog.byId(id) || catalog.bySlug(id);
  if (!product) return readCart(req);

  const line = {
    id: product.id,
    size: size || (product.sizes && product.sizes[0]) || 'Free Size',
    color: color || (product.colors && product.colors[0]) || '',
    qty: Math.max(1, parseInt(qty, 10) || 1)
  };

  // The cap depends on the chosen size and colour, so it is worked out after the
  // line is resolved rather than from the product alone.
  const cap = stockCap(product, line);
  if (cap === 0) return readCart(req);   // this variant is sold out

  const lines = readCart(req);
  const existing = lines.find((l) => lineKey(l) === lineKey(line));
  if (existing) existing.qty = Math.min(cap, existing.qty + line.qty);
  else lines.push({ ...line, qty: Math.min(cap, line.qty) });

  return writeCart(req, res, lines);
}

function updateQty(req, res, key, qty) {
  const n = parseInt(qty, 10);
  let lines = readCart(req);
  if (n <= 0) {
    lines = lines.filter((l) => lineKey(l) !== key);
  } else {
    lines = lines.map((l) => {
      if (lineKey(l) !== key) return l;
      return { ...l, qty: Math.min(stockCap(catalog.byId(l.id), l), n) };
    }).filter((l) => l.qty > 0);
  }
  return writeCart(req, res, lines);
}

/**
 * Last check before money changes hands. Stock can fall between adding to the
 * cart and paying — someone else buys the last piece — so the quantities are
 * re-checked against the catalogue at the moment of purchase.
 */
function stockProblems(summary) {
  const variants = require('./variants');

  return summary.lines
    .map((l) => {
      // Checked per size and colour: the M might be gone while the L is fine, and
      // "we have 6 in stock" is no comfort to someone who ordered the M.
      const available = variants.stockFor(l.product, { size: l.size, color: l.color });
      if (available === null || l.qty <= available) return null;

      // Name the variant, not just the product, or the customer cannot tell what
      // to change.
      const which = [l.size, l.color].filter(Boolean).join(' · ');
      const what = which ? `${l.product.name} (${which})` : l.product.name;

      return {
        name: l.product.name,
        variant: which || null,
        wanted: l.qty,
        available,
        message: available === 0
          ? `${what} has just sold out.`
          : `Only ${available} left of ${what}.`
      };
    })
    .filter(Boolean);
}

function removeLine(req, res, key) {
  return writeCart(req, res, readCart(req).filter((l) => lineKey(l) !== key));
}

function clearCart(req, res) {
  return writeCart(req, res, []);
}

/**
 * Joins cookie lines with live catalog data and computes totals. Prices always
 * come from the catalog, never from the cookie — the cookie only holds intent.
 */
function hydrate(req, config) {
  const lines = readCart(req).map((l) => {
    const product = catalog.byId(l.id);
    if (!product) return null;
    return {
      key: lineKey(l),
      product,
      size: l.size,
      color: l.color,
      qty: l.qty,
      lineTotal: product.price * l.qty,
      lineMrp: (product.mrp || product.price) * l.qty
    };
  }).filter(Boolean);

  const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
  const mrpTotal = lines.reduce((s, l) => s + l.lineMrp, 0);
  const count = lines.reduce((s, l) => s + l.qty, 0);
  const ship = config.shipping || {};
  const freeAbove = ship.freeAbove || 0;

  // A stored code is re-validated on every render: if it expires or the cart
  // drops below its minimum, it silently stops applying (with a reason).
  const code = readDiscountCode(req);
  const applied = code && count ? discounts.evaluate(code, subtotal) : null;
  const discount = applied && applied.ok ? applied.amount : 0;
  const afterDiscount = Math.max(0, subtotal - discount);

  const freeShipping = !!(applied && applied.ok && applied.freeShipping);
  const shipping = count === 0 || freeShipping || afterDiscount >= freeAbove ? 0 : (ship.standardCharge || 0);

  return {
    lines,
    count,
    subtotal,
    savings: Math.max(0, mrpTotal - subtotal),
    discount,
    discountCode: applied && applied.ok ? applied.code : null,
    discountError: applied && !applied.ok ? applied.reason : null,
    freeShipping,
    shipping,
    giftWrapCharge: 0,
    deliveryMethod: null,
    deliveryTitle: null,
    tax: taxOn(lines, discount, subtotal, 0, config),
    total: afterDiscount + shipping,
    freeShipRemaining: Math.max(0, freeAbove - afterDiscount),
    freeShipEligible: (freeShipping || afterDiscount >= freeAbove) && count > 0
  };
}

/**
 * GST already contained in the cart. Prices are tax-inclusive, so this is an
 * extraction, not an addition — the total never moves because of it. Rates are
 * per product (product → category → store default), and a discount lowers the
 * taxable amount pro-rata, exactly as the invoice computes it.
 */
function taxOn(lines, discount, subtotal, chargesInclusive, config) {
  const pricing = require('./pricing');
  const goodsTax = lines.reduce((s, l) => s + pricing.taxOf(l.lineTotal, pricing.gstPercent(l.product, config)), 0);
  const ratio = subtotal ? (subtotal - (discount || 0)) / subtotal : 1;
  let tax = goodsTax * ratio;

  // Shipping and gift wrap ride on the principal supply, so they carry the
  // highest rate in the cart rather than a rate of their own.
  if (chargesInclusive > 0 && (config.finance || {}).gstOnShipping !== false) {
    const principal = lines.reduce((max, l) => Math.max(max, pricing.gstPercent(l.product, config)), 0);
    tax += pricing.taxOf(chargesInclusive, principal);
  }
  return Math.round(tax);
}

/** The delivery options a client offers, with the note tokens filled in. */
function deliveryMethods(config) {
  const ship = config.shipping || {};
  const list = Array.isArray(ship.methods) && ship.methods.length
    ? ship.methods
    : [{ id: 'standard', title: 'Standard', note: '{metro}-{other} working days after dispatch', charge: null }];

  return list.map((m) => ({
    id: m.id,
    title: m.title,
    note: String(m.note || '')
      .replace('{metro}', ship.estimateDaysMetro)
      .replace('{other}', ship.estimateDaysOther),
    // null means "use the standard free-above rules"; a number always applies.
    charge: Number.isFinite(m.charge) ? m.charge : null
  }));
}

/**
 * Folds the checkout choices — delivery method, gift wrap — into a cart summary.
 * Kept out of hydrate() so the drawer and listing pages stay cheap, and so there
 * is exactly one place where the amount a customer is asked to pay is decided.
 */
function withCheckoutExtras(summary, state, config) {
  /* Options depend on WHERE it is going: a shop that delivers across its own city
     the same afternoon should offer that, not a three-day courier. Falls back to
     the store-wide list when no pincode has been entered yet. */
  const delivery = require('./delivery');
  // The basket moves at the speed of its slowest piece: one made-to-order lehenga
  // means the whole order cannot go out this afternoon.
  const makeDays = summary.lines.reduce((max, l) => Math.max(max, Number(l.product.deliveryDays) || 0), 0);

  const resolved = delivery.resolve(config, {
    pincode: state && state.pincode,
    city: state && state.city,
    subtotal: summary.subtotal,
    makeDays,
    chosenId: state && state.deliveryMethod
  });

  const methods = resolved.methods.length ? resolved.methods : deliveryMethods(config);
  const chosen = resolved.chosen || methods[0];

  // A flat-charge method (express, same-day, pickup) is what the customer asked
  // for, so it applies even when standard shipping would have been free.
  const shipping = chosen.charge === null ? summary.shipping : chosen.charge;
  const giftWrapCharge = (state && state.giftWrap === 'yes') ? ((config.shipping || {}).giftWrapCharge || 0) : 0;
  const afterDiscount = Math.max(0, summary.subtotal - (summary.discount || 0));

  return {
    ...summary,
    deliveryMethod: chosen.id,
    deliveryTitle: chosen.title,
    deliveryNote: chosen.note || null,
    deliveryMethods: methods,
    // Who carries it. Written onto the order so a courier integration can skip
    // what the shop already delivered by hand.
    fulfilment: chosen.fulfilment || 'courier',
    deliveryZone: chosen.zone || null,
    deliveryZoneLabel: chosen.zoneLabel || null,
    deliverySlots: chosen.slots || null,
    shipping,
    giftWrapCharge,
    tax: taxOn(summary.lines, summary.discount, summary.subtotal, shipping + giftWrapCharge, config),
    total: afterDiscount + shipping + giftWrapCharge
  };
}

/* ------------------------------------------------------------ discounts ---- */

function readDiscountCode(req) {
  return (req.cookies && req.cookies[DISCOUNT_COOKIE]) || null;
}

function setDiscountCode(req, res, code) {
  const clean = String(code || '').trim().toUpperCase();
  res.cookie(DISCOUNT_COOKIE, clean, COOKIE_OPTS);
  if (req.cookies) req.cookies[DISCOUNT_COOKIE] = clean;
  return clean;
}

function clearDiscountCode(req, res) {
  res.clearCookie(DISCOUNT_COOKIE, { path: '/' });
  if (req.cookies) delete req.cookies[DISCOUNT_COOKIE];
}

/* ------------------------------------------------------------ wishlist ---- */

function readWishlist(req) {
  return decode(req.cookies && req.cookies[WISH_COOKIE]);
}

function toggleWishlist(req, res, id) {
  const ids = readWishlist(req);
  const idx = ids.indexOf(id);
  if (idx >= 0) ids.splice(idx, 1);
  else ids.push(id);
  const encoded = encode(ids);
  res.cookie(WISH_COOKIE, encoded, COOKIE_OPTS);
  if (req.cookies) req.cookies[WISH_COOKIE] = encoded;
  return { ids, active: idx < 0 };
}

function wishlistProducts(req) {
  return readWishlist(req).map((id) => catalog.byId(id)).filter(Boolean);
}

module.exports = {
  CART_COOKIE, WISH_COOKIE, DISCOUNT_COOKIE, lineKey,
  readDiscountCode, setDiscountCode, clearDiscountCode,
  readCart, writeCart, addToCart, updateQty, removeLine, clearCart, hydrate,
  withCheckoutExtras, deliveryMethods, stockProblems,
  readWishlist, toggleWishlist, wishlistProducts
};
