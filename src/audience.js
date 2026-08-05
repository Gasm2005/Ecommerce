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

/**
 * "Show me everything" is a real answer, not the absence of one.
 *
 * A shop that sells menswear and womenswear has customers buying for a whole family
 * in one order. Forcing them to flip sections between a sherwani and a lehenga makes
 * the chooser a nuisance rather than a shortcut, so this is offered as its own
 * option — and stored, so the shop stays that way until they say otherwise.
 */
const EVERYTHING = 'all';

/* How many categories the combined menu may show. Eight is what fits one row at 1280px
   without wrapping; past that the nav looks broken rather than well stocked. The rest of
   the tree is still reachable from the mega menu and the phone drawer. */
const MERGED_NAV_LIMIT = 8;

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

/**
 * What a visitor with no cookie sees.
 *
 * The first configured audience, unless the shop says otherwise. A family shop wants
 * EVERYTHING here: with menswear listed first, a first-time visitor to a shop selling to
 * the whole family saw only the men's rail, and the women's stock — most of the
 * catalogue — was invisible until they found the switcher. Set
 * `audiences.default: "all"` for that.
 */
function fallback(config) {
  const wanted = config && config.audiences && config.audiences.default;
  if (wanted === EVERYTHING) return null;
  if (wanted) {
    const named = byId(config, String(wanted));
    if (named) return named;
  }
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
  if (asked === EVERYTHING) return null;
  if (asked && byId(config, String(asked))) return byId(config, String(asked));

  const saved = req && req.cookies && req.cookies[COOKIE];
  // No audience in force means no filter — the whole catalogue, on purpose.
  if (saved === EVERYTHING) return null;
  if (saved && byId(config, String(saved))) return byId(config, String(saved));

  return fallback(config);
}

/** Has this visitor actually chosen, or are we showing them the default? */
function hasChosen(req, config) {
  if (!isMultiple(config)) return true;
  const saved = req && req.cookies && req.cookies[COOKIE];
  if (saved === EVERYTHING) return true;
  return !!(saved && byId(config, String(saved)));
}

function choose(req, res, config, id) {
  if (String(id) === EVERYTHING) {
    res.cookie(COOKIE, EVERYTHING, COOKIE_OPTS);
    if (req.cookies) req.cookies[COOKIE] = EVERYTHING;
    return null;   // null IS "everything" — see current()
  }

  const found = byId(config, id);
  if (!found) return null;
  res.cookie(COOKIE, found.id, COOKIE_OPTS);
  if (req.cookies) req.cookies[COOKIE] = found.id;
  return found;
}

/** Is this visitor browsing the whole shop rather than one section? */
function isEverything(req, config) {
  if (!isMultiple(config)) return false;
  const saved = req && req.cookies && req.cookies[COOKIE];
  return saved === EVERYTHING;
}

/** The nav for the audience in force — this is what the header renders. */
function navFor(req, config) {
  const active = current(req, config);
  if (active && Array.isArray(active.nav) && active.nav.length) return active.nav;

  /* No audience in force, in a shop that has several: that is "everything", and the
     menu has to mean it. Falling back to config.nav showed only the womenswear
     categories under a heading that claimed the whole shop — a man browsing
     Everything had no Sherwani link at all. Merged in list order, deduped by slug,
     since two audiences can share a category. */
  if (!active && isMultiple(config)) {
    const seen = new Set();
    const merged = [];

    /* Round-robin across the sections, not one section after another.
       Three sections with six, five and three categories merge to fourteen, which wraps
       onto a second line and pushes the last item half off the row — it reads as a broken
       page rather than a big shop. Taking the first eight in list order would have given
       all of menswear and two of womenswear, so this takes one from each in turn: the top
       category of every section shows before the second category of any of them. */
    const trees = list(config).map((a) => (a.nav || []).filter((n) => n && n.slug));
    const deepest = Math.max(0, ...trees.map((t) => t.length));

    for (let rank = 0; rank < deepest && merged.length < MERGED_NAV_LIMIT; rank += 1) {
      for (const tree of trees) {
        const item = tree[rank];
        if (!item || seen.has(item.slug) || merged.length >= MERGED_NAV_LIMIT) continue;
        seen.add(item.slug);
        merged.push(item);
      }
    }

    if (merged.length) return merged;
  }

  // A half-filled config still has to produce a working shop.
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
  EVERYTHING, isEverything,
  COOKIE, list, isMultiple, byId, fallback, current, hasChosen, choose,
  navFor, matches, slugsFor
};
