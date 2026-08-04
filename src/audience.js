'use strict';

/**
 * Who is this shop for?
 *
 * A menswear shop, a womenswear shop, a kidswear shop and a shop that sells all
 * three are four different websites — different categories, different size charts,
 * different language. Rather than four templates, this is one switch.
 *
 * config.audiences.list decides everything:
 *
 *   ONE entry    a single-audience shop. No chooser, no switcher, and that
 *                audience's nav simply IS the site nav. A client who only sells
 *                menswear never sees a trace of the feature.
 *   TWO OR MORE  a visitor is asked once which section they want. That choice
 *                lives in a cookie and drives the nav, the listing pages, search
 *                and the homepage.
 *
 * Products carry an `audience` id. A product with none shows to everyone, which is
 * how universal stock (a dupatta, a stole) behaves without extra configuration —
 * and it means a client's existing catalogue keeps working the day this is
 * switched on.
 *
 * The choice is a PREFERENCE, not a permission. A direct link to a men's kurta
 * always opens, whatever the cookie says; the shop is not going to hide a product
 * from someone who was sent its URL.
 */

const COOKIE = 'aanya_audience';
const COOKIE_OPTS = {
  httpOnly: false,          // the chooser reads it client-side to avoid a flash
  sameSite: 'lax',
  maxAge: 1000 * 60 * 60 * 24 * 180,
  path: '/'
};

function list(config) {
  const raw = (config && config.audiences && config.audiences.list) || [];
  return raw.filter((a) => a && a.id && a.label);
}

/** True when there is a real choice to make. One audience needs no chooser. */
function isMultiple(config) {
  return list(config).length > 1;
}

function byId(config, id) {
  return list(config).find((a) => a.id === id) || null;
}

/** The default: the first configured audience. */
function fallback(config) {
  return list(config)[0] || null;
}

/**
 * The audience in force for this request.
 *
 * Order: an explicit ?audience= (so a campaign link can land straight in
 * menswear) → the cookie → the first configured audience.
 */
function current(req, config) {
  if (!isMultiple(config)) return fallback(config);

  const asked = req && req.query && req.query.audience;
  if (asked && byId(config, String(asked))) return byId(config, String(asked));

  const saved = req && req.cookies && req.cookies[COOKIE];
  if (saved && byId(config, String(saved))) return byId(config, String(saved));

  return fallback(config);
}

/** Has this visitor actually chosen, or are we showing them the default? */
function hasChosen(req, config) {
  if (!isMultiple(config)) return true;
  const saved = req && req.cookies && req.cookies[COOKIE];
  return !!(saved && byId(config, String(saved)));
}

function choose(req, res, config, id) {
  const found = byId(config, id);
  if (!found) return null;
  res.cookie(COOKIE, found.id, COOKIE_OPTS);
  if (req.cookies) req.cookies[COOKIE] = found.id;
  return found;
}

/** The nav for the audience in force — this is what the header renders. */
function navFor(req, config) {
  const active = current(req, config);
  if (active && Array.isArray(active.nav) && active.nav.length) return active.nav;
  // No per-audience nav configured: fall back to the site nav, so a half-filled
  // config still produces a working shop.
  return (config && config.nav) || [];
}

/**
 * Does this product belong to the audience in force?
 * Universal stock (no audience set) always does.
 */
function matches(product, audienceId) {
  if (!audienceId) return true;
  const own = product && product.audience;
  if (!own) return true;
  return String(own) === String(audienceId);
}

/** Every category slug this audience owns, for filtering and validation. */
function slugsFor(audience) {
  return (audience && Array.isArray(audience.nav) ? audience.nav : []).map((n) => n.slug);
}

module.exports = {
  COOKIE, list, isMultiple, byId, fallback, current, hasChosen, choose,
  navFor, matches, slugsFor
};
