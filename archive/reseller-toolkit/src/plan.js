'use strict';

/**
 * Plans: what a client paid for.
 *
 * One codebase serves every client. What separates a ₹49k store from a ₹1.99L
 * store is this file and one line in their config — never a fork, never a
 * hand-edited copy. A hundred divergent codebases is the thing that kills an
 * agency, so the rule is: no feature may be removed from the code to sell a
 * cheaper tier; it is switched off here.
 *
 * The gate is SERVER-SIDE. A hidden sidebar link is decoration — every locked
 * route refuses on the server, and the storefront reads the same flags, so a
 * feature that is off cannot be reached by typing the URL.
 *
 * Adding a feature: add it to FEATURES, list it in the plans that include it,
 * and gate the route with requireFeature(). If a feature is not listed in any
 * plan it is ON for everyone — new work does not silently vanish for clients.
 */

/**
 * Every sellable capability.
 *  · section — the admin section it unlocks (matches auth PERMISSIONS keys)
 *  · storefront — the customer-facing half also disappears when it is off
 */
const FEATURES = [
  { id: 'orders', label: 'Orders & fulfilment', section: 'orders', core: true, blurb: 'Take orders, track status, export.' },
  { id: 'products', label: 'Product catalogue', section: 'products', core: true, blurb: 'Add, edit and price products.' },
  { id: 'invoices', label: 'GST tax invoices', core: true, blurb: 'Sequential GST invoices with CGST/SGST/IGST.' },

  { id: 'bulk-import', label: 'Bulk product upload', section: 'import', blurb: 'Import a whole catalogue from CSV.' },
  { id: 'discounts', label: 'Coupons & discounts', section: 'discounts', blurb: 'Percentage, flat and free-shipping codes.' },
  { id: 'returns', label: 'Returns & refunds', section: 'returns', storefront: true, blurb: 'Self-serve returns with partial refunds.' },
  { id: 'reviews', label: 'Customer reviews', section: 'reviews', storefront: true, blurb: 'Verified reviews with photo and video.' },
  { id: 'cod', label: 'Cash on delivery', storefront: true, blurb: 'Full and partial COD with pincode rules.' },

  { id: 'reports', label: 'Profit & loss reports', section: 'reports', blurb: 'Full P&L: COGS, GST, fixed costs, profit in hand.' },
  { id: 'marketing', label: 'Marketing & SEO', section: 'marketing', blurb: 'Meta tags, sitemap, structured data, campaigns.' },
  { id: 'journal', label: 'Journal / blog', section: 'journal', storefront: true, blurb: 'Long-form content for SEO.' },
  { id: 'customers', label: 'Customer records', section: 'customers', blurb: 'Who buys, how often, what they spend.' },

  { id: 'staff-accounts', label: 'Staff accounts & roles', blurb: 'More than one login, with permissions.' },
  { id: 'payment-gateway', label: 'Online payments', blurb: 'Razorpay and other gateways.' },
  { id: 'whatsapp', label: 'WhatsApp notifications', blurb: 'Order updates on WhatsApp.' },
  { id: 'media-compression', label: 'Image & video compression', blurb: 'Automatic WebP and H.264 compression.' },
  { id: 'google-reviews', label: 'Live Google reviews', blurb: 'Pull the store rating from Google.' },
  { id: 'wishlist', label: 'Wishlist', storefront: true, blurb: 'Customers save pieces for later.' }
];

/**
 * The tiers as sold. Prices live here so the upgrade screen and the sales
 * conversation cannot drift apart.
 */
const PLANS = [
  {
    id: 'starter',
    label: 'Starter',
    price: 49000,
    blurb: 'A complete prepaid shop: catalogue, orders, GST invoices.',
    // Prepaid only. COD carries the RTO risk and needs the pincode rules and
    // partial-advance engine to run safely, so it sits a tier up. Move 'cod'
    // here if a client's market genuinely can't buy without it.
    features: ['orders', 'products', 'invoices', 'wishlist']
  },
  {
    id: 'growth',
    label: 'Growth',
    price: 99000,
    blurb: 'Everything needed to actually grow: reviews, coupons, SEO, P&L.',
    features: [
      'orders', 'products', 'invoices', 'cod', 'wishlist',
      'bulk-import', 'discounts', 'returns', 'reviews',
      'reports', 'marketing', 'customers',
      'payment-gateway', 'media-compression'
    ]
  },
  {
    id: 'scale',
    label: 'Scale',
    price: 199000,
    blurb: 'The whole platform, nothing withheld.',
    features: '*'
  }
];

const DEFAULT_PLAN = 'scale';

/**
 * What this store is entitled to.
 *
 * A signed licence outranks config.plan, because the config is a plain file and
 * the licence is not forgeable. With no licence we fall back to the config, which
 * is what development and a self-hosted deployment need.
 */
function entitlement(config, host) {
  // Required lazily: license.js reads the store, which has no opinion on plans.
  const licence = require('./license').entitlement(config, host);
  return {
    planId: licence.plan || (config && config.plan) || DEFAULT_PLAN,
    extras: licence.extras && licence.extras.length ? licence.extras : ((config && config.planExtras) || []),
    from: licence.from,
    licence: licence.status
  };
}

function planOf(config, host) {
  const wanted = entitlement(config, host).planId;
  return PLANS.find((p) => p.id === wanted) || PLANS.find((p) => p.id === DEFAULT_PLAN);
}

/**
 * Is this capability switched on for this client?
 *
 * Unknown ids return true on purpose. A feature nobody has classified yet is
 * new work, and new work must not disappear from every existing client's store
 * because someone forgot to add it to a plan.
 */
function hasFeature(config, id, host) {
  const ent = entitlement(config, host);
  const plan = PLANS.find((p) => p.id === ent.planId) || PLANS.find((p) => p.id === DEFAULT_PLAN);
  if (plan.features === '*') return true;
  if (!FEATURES.some((f) => f.id === id)) return true;

  // A per-client override beats the tier — for the deal where one client pays
  // for Growth plus a single extra thing.
  if (ent.extras.includes(id)) return true;

  return plan.features.includes(id);
}

/** The admin section → feature map, so route gates read naturally. */
function featureForSection(section) {
  const hit = FEATURES.find((f) => f.section === section);
  return hit ? hit.id : null;
}

/** Can this client open this admin section at all? (Separate from role.) */
function sectionUnlocked(config, section, host) {
  const feature = featureForSection(section);
  return feature ? hasFeature(config, feature, host) : true;
}

/** Everything the upgrade screen needs: what is on, what is off, what unlocks it. */
function overview(config, host) {
  const ent = entitlement(config, host);
  const current = PLANS.find((p) => p.id === ent.planId) || PLANS.find((p) => p.id === DEFAULT_PLAN);
  const extras = ent.extras;

  const features = FEATURES.map((f) => {
    const on = hasFeature(config, f.id, host);
    // The cheapest tier that would turn this on, for the upsell line.
    const unlockedBy = PLANS.find((p) => p.features === '*' || p.features.includes(f.id));
    return {
      ...f,
      on,
      viaExtra: extras.includes(f.id),
      unlockedBy: on ? null : (unlockedBy || null)
    };
  });

  return {
    plan: current,
    plans: PLANS,
    features,
    locked: features.filter((f) => !f.on),
    upgradeTo: PLANS.filter((p) => p.price > current.price)[0] || null,
    // Where the plan came from, and what the licence says about it.
    source: ent.from,
    licence: ent.licence
  };
}

/**
 * Express gate. Runs AFTER the role check, so a staff member sees "not your
 * permission" and an owner on a cheaper plan sees "not in your plan" — two
 * different problems that must not be confused with each other.
 */
function requireFeature(id) {
  return function featureGate(req, res, next) {
    const config = require('./config').loadConfig();
    const host = req.get && req.get('host');
    if (hasFeature(config, id, host)) return next();

    const feature = FEATURES.find((f) => f.id === id) || { id, label: id };
    const info = overview(config, host);
    res.status(402).render('admin/locked', {
      feature,
      plan: info.plan,
      unlockedBy: info.features.find((f) => f.id === id)?.unlockedBy || info.upgradeTo
    });
  };
}

module.exports = {
  FEATURES, PLANS, DEFAULT_PLAN,
  entitlement, planOf, hasFeature, featureForSection, sectionUnlocked, overview, requireFeature
};
