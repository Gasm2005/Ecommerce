'use strict';

/**
 * Write side of config/site.config.json — the admin edits brand, theme, finance,
 * shipping, inventory and feature flags here, plus category CRUD (categories are
 * the `nav` array, so adding one adds it to the storefront menu too).
 *
 * Every write backs up the config first.
 */

const fs = require('fs');
const path = require('path');
const { loadConfig, invalidate: invalidateConfig, CONFIG_PATH } = require('./config');
const store = require('./store');
const products = require('./products');
const catalog = require('./catalog');

function backupConfig() {
  const dir = store.BACKUP_DIR;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dir, `site.config-${stamp}.json`);
  fs.copyFileSync(CONFIG_PATH, dest);
  return path.relative(path.join(__dirname, '..'), dest);
}

function readConfigRaw() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function writeConfig(next) {
  const backupPath = backupConfig();
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, CONFIG_PATH);
  invalidateConfig();
  return { backupPath };
}

/* Form bodies arrive as strings; these two sets say what to coerce, so the
   config keeps real numbers and booleans (JSON consumers depend on it). */
const NUMBER_KEYS = new Set([
  'gstRatePercent', 'gstRatePercentUnder1000', 'defaultCogsPercent', 'paymentFeePercent',
  'codFeeFlat', 'shippingCostPerOrder', 'monthlyOpex', 'lowStockThreshold',
  'freeAbove', 'standardCharge', 'estimateDaysMetro', 'estimateDaysOther', 'returnWindowDays',
  'productsPerPage', 'cacheMinutes'
]);
const BOOL_KEYS = new Set([
  'codAvailable', 'guestCheckout', 'wishlist', 'quickView', 'infiniteScroll',
  'showMrpStrikethrough', 'indexable',
  'showStoreBadge', 'merchantFeed', 'requirePurchase', 'allowMedia'
]);

function coerce(key, value) {
  if (NUMBER_KEYS.has(key)) {
    const n = Number(String(value).replace(/[₹,\s%]/g, ''));
    return Number.isFinite(n) ? n : 0;
  }
  if (BOOL_KEYS.has(key)) return value === 'on' || value === 'true' || value === true;
  return value;
}

/**
 * Patches one config section from a form body (only keys present in the body).
 *
 * A key listed in `booleans` is coerced to a real true/false, not just defaulted
 * to false when absent. Without that, a checked box stored the string "on", and
 * any code testing `=== true` read it as off — a toggle that appeared to save and
 * silently did nothing.
 */
function updateSection(section, body, { booleans = [] } = {}) {
  const config = readConfigRaw();
  const current = config[section] || {};
  const boolSet = new Set(booleans);
  const patch = {};

  Object.keys(body).forEach((k) => {
    if (k === 'token' || k === 'section') return;
    // A section's declared booleans win over the global key list, so a new toggle
    // works by being listed in one place rather than two.
    patch[k] = boolSet.has(k)
      ? (body[k] === 'on' || body[k] === 'true' || body[k] === true)
      : coerce(k, body[k]);
  });
  // Unchecked checkboxes never post, so default them to false explicitly.
  booleans.forEach((k) => { if (!(k in body)) patch[k] = false; });

  config[section] = { ...current, ...patch };
  return writeConfig(config);
}

/* ------------------------------------------------------------ categories ---- */

function categories() {
  const config = loadConfig();
  const counts = new Map();
  catalog.all().forEach((p) => (p.categories || []).forEach((c) => counts.set(c, (counts.get(c) || 0) + 1)));

  const nav = (config.nav || []).map((n) => ({
    ...n,
    productCount: counts.get(n.slug) || 0,
    linkCount: (n.columns || []).reduce((s, c) => s + c.links.length, 0)
  }));

  // Slugs used by products but missing from the menu — easy to miss otherwise.
  const orphans = [...counts.keys()]
    .filter((slug) => !nav.some((n) => n.slug === slug))
    .map((slug) => ({ slug, productCount: counts.get(slug) }));

  return { nav, orphans };
}

function addCategory({ label, slug, subtitle, links }) {
  const config = readConfigRaw();
  const cleanSlug = store.slugify(slug || label);
  if (!cleanSlug) throw new Error('A label or slug is required');
  if ((config.nav || []).some((n) => n.slug === cleanSlug)) throw new Error(`Category “${cleanSlug}” already exists`);

  const linkList = String(links || '').split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => ({ label: l, href: `/category/${cleanSlug}` }));

  config.nav = [...(config.nav || []), {
    label: String(label || cleanSlug).trim(),
    slug: cleanSlug,
    columns: linkList.length ? [{ title: 'Shop', links: linkList }] : [{ title: 'Shop', links: [{ label: 'View all', href: `/category/${cleanSlug}` }] }],
    featured: { title: String(label || cleanSlug).trim(), subtitle: String(subtitle || '').trim(), href: `/category/${cleanSlug}`, image: null }
  }];

  writeConfig(config);
  return cleanSlug;
}

function renameCategory(slug, { label, newSlug, subtitle }) {
  const config = readConfigRaw();
  const idx = (config.nav || []).findIndex((n) => n.slug === slug);
  if (idx < 0) throw new Error('Category not found');

  const target = newSlug ? store.slugify(newSlug) : slug;
  if (target !== slug && config.nav.some((n) => n.slug === target)) throw new Error(`Category “${target}” already exists`);

  const entry = { ...config.nav[idx] };
  if (label) entry.label = String(label).trim();
  if (subtitle !== undefined && entry.featured) entry.featured = { ...entry.featured, subtitle: String(subtitle).trim() };

  if (target !== slug) {
    entry.slug = target;
    entry.columns = (entry.columns || []).map((c) => ({
      ...c,
      links: c.links.map((l) => ({ ...l, href: String(l.href).replace(`/category/${slug}`, `/category/${target}`) }))
    }));
    if (entry.featured) entry.featured.href = String(entry.featured.href || '').replace(`/category/${slug}`, `/category/${target}`);
  }

  config.nav[idx] = entry;
  writeConfig(config);

  const touched = target !== slug ? products.renameCategory(slug, target) : 0;
  return { slug: target, productsTouched: touched };
}

/**
 * Deletes a category from the menu. Products keep their other categories; any
 * product left with none falls back to `festive` so nothing becomes unreachable.
 */
function deleteCategory(slug, { detachProducts = true } = {}) {
  const config = readConfigRaw();
  const entry = (config.nav || []).find((n) => n.slug === slug);
  if (!entry) throw new Error('Category not found');

  config.nav = config.nav.filter((n) => n.slug !== slug);
  // Occasion tiles and footer links pointing at it would 404-ish (they'd show an
  // empty listing), so strip those too.
  config.occasions = (config.occasions || []).filter((o) => !String(o.href).includes(`/category/${slug}`));
  writeConfig(config);

  const touched = detachProducts ? products.removeCategory(slug) : 0;
  return { label: entry.label, productsTouched: touched };
}

function reorderCategory(slug, direction) {
  const config = readConfigRaw();
  const idx = (config.nav || []).findIndex((n) => n.slug === slug);
  if (idx < 0) return null;
  const to = direction === 'up' ? idx - 1 : idx + 1;
  if (to < 0 || to >= config.nav.length) return null;
  const nav = [...config.nav];
  [nav[idx], nav[to]] = [nav[to], nav[idx]];
  config.nav = nav;
  writeConfig(config);
  return slug;
}

module.exports = {
  readConfigRaw, writeConfig, updateSection,
  categories, addCategory, renameCategory, deleteCategory, reorderCategory
};
