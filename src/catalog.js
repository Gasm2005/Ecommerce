'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
const PRODUCTS_PATH = path.join(DATA_DIR, 'products.json');

let cache = null;

const PRICE_RANGES = [
  { id: '0-25000', label: 'Under ₹25,000', min: 0, max: 25000 },
  { id: '25000-50000', label: '₹25,000 – ₹50,000', min: 25000, max: 50000 },
  { id: '50000-100000', label: '₹50,000 – ₹1,00,000', min: 50000, max: 100000 },
  { id: '100000-150000', label: '₹1,00,000 – ₹1,50,000', min: 100000, max: 150000 },
  { id: '150000-', label: 'Above ₹1,50,000', min: 150000, max: Infinity }
];

const SORTS = [
  { id: 'featured', label: 'Featured' },
  { id: 'new', label: 'New Arrivals' },
  { id: 'popular', label: 'Popularity' },
  { id: 'price-asc', label: 'Price: Low to High' },
  { id: 'price-desc', label: 'Price: High to Low' }
];

function all() {
  if (cache && process.env.NODE_ENV === 'production') return cache;
  cache = JSON.parse(fs.readFileSync(PRODUCTS_PATH, 'utf8')).map(normalise);
  return cache;
}

/** Auto-fill placeholder art when a product ships without photography. */
function normalise(p) {
  const images = (p.images && p.images.length ? p.images : [
    `/ph.svg?seed=${p.id}a&w=900&h=1200&label=${encodeURIComponent(p.name)}`,
    `/ph.svg?seed=${p.id}b&w=900&h=1200&label=${encodeURIComponent(p.subtitle || p.name)}`,
    `/ph.svg?seed=${p.id}c&w=900&h=1200&label=${encodeURIComponent(p.fabric || '')}`,
    `/ph.svg?seed=${p.id}d&w=900&h=1200&label=${encodeURIComponent('Detail')}`
  ]);
  return { ...p, images, discount: p.mrp && p.mrp > p.price ? Math.round((1 - p.price / p.mrp) * 100) : 0 };
}

/** Called after any write to data/products.json so cached reads don't go stale. */
function invalidate() {
  cache = null;
}

function bySlug(slug) {
  return all().find((p) => p.slug === slug) || null;
}

function byId(id) {
  return all().find((p) => p.id === id) || null;
}

/**
 * The pool a visitor browses.
 *
 * `audience` narrows it to one section of the shop — menswear, womenswear, kids.
 * Facets, search, suggestions and "you may also like" are all built on top of this
 * one function, so the audience filter cannot be applied in one place and
 * forgotten in another.
 *
 * A product with no audience of its own is universal stock and always shows, which
 * is how a client's existing catalogue keeps working the day this is switched on.
 */
function inCategory(slug, audience) {
  const audienceOf = require('./audience');
  const pool = audience ? all().filter((p) => audienceOf.matches(p, audience)) : all();
  if (!slug || slug === 'all') return pool;
  return pool.filter((p) => p.categories.includes(slug));
}

function uniq(list) {
  return [...new Set(list)];
}

/** Facet counts for the sidebar, computed against the current category. */
function facets(slug, audience) {
  const pool = inCategory(slug, audience);
  const count = (fn) => {
    const map = new Map();
    pool.forEach((p) => [].concat(fn(p)).forEach((v) => v && map.set(v, (map.get(v) || 0) + 1)));
    return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([value, n]) => ({ value, count: n }));
  };
  return {
    price: PRICE_RANGES.map((r) => ({
      value: r.id,
      label: r.label,
      count: pool.filter((p) => p.price >= r.min && p.price < r.max).length
    })),
    color: count((p) => p.colors),
    fabric: count((p) => p.fabric),
    size: count((p) => p.sizes),
    occasion: count((p) => p.occasion)
  };
}

function asArray(v) {
  if (v === undefined || v === null || v === '') return [];
  return Array.isArray(v) ? v.filter(Boolean) : [v];
}

/** Normalises a raw req.query into the filter state used everywhere. */
function parseQuery(query = {}) {
  return {
    q: (query.q || '').toString().trim(),
    price: asArray(query.price),
    color: asArray(query.color),
    fabric: asArray(query.fabric),
    size: asArray(query.size),
    occasion: asArray(query.occasion),
    sort: SORTS.some((s) => s.id === query.sort) ? query.sort : 'featured',
    page: Math.max(1, parseInt(query.page, 10) || 1)
  };
}

function activeFilterCount(f) {
  return f.price.length + f.color.length + f.fabric.length + f.size.length + f.occasion.length;
}

function matchesPrice(p, ids) {
  if (!ids.length) return true;
  return ids.some((id) => {
    const r = PRICE_RANGES.find((x) => x.id === id);
    return r && p.price >= r.min && p.price < r.max;
  });
}

function sortList(list, sort) {
  const out = [...list];
  switch (sort) {
    case 'price-asc': return out.sort((a, b) => a.price - b.price);
    case 'price-desc': return out.sort((a, b) => b.price - a.price);
    case 'new': return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    case 'popular': return out.sort((a, b) => b.popularity - a.popularity);
    default: return out.sort((a, b) => (b.popularity + (b.badge ? 6 : 0)) - (a.popularity + (a.badge ? 6 : 0)));
  }
}

/**
 * Main listing query. Returns a page of products plus enough metadata for the
 * "Load more" sentinel to know whether another page exists.
 */
function search(categorySlug, filters, perPage, audience) {
  const f = filters;
  let list = inCategory(categorySlug, audience).filter((p) =>
    matchesPrice(p, f.price) &&
    (!f.color.length || p.colors.some((c) => f.color.includes(c))) &&
    (!f.fabric.length || f.fabric.includes(p.fabric)) &&
    (!f.size.length || p.sizes.some((s) => f.size.includes(s))) &&
    (!f.occasion.length || p.occasion.some((o) => f.occasion.includes(o)))
  );

  if (f.q) list = list.filter((p) => haystack(p).includes(f.q.toLowerCase()));

  list = sortList(list, f.sort);

  const total = list.length;
  const size = perPage || 8;
  const start = (f.page - 1) * size;
  const items = list.slice(start, start + size);
  return { items, total, page: f.page, perPage: size, hasMore: start + items.length < total };
}

function haystack(p) {
  return [p.name, p.subtitle, p.fabric, ...(p.colors || []), ...(p.occasion || []), ...(p.categories || [])]
    .join(' ').toLowerCase();
}

/** As-you-type suggestions: products first, then matching categories/facets. */
function suggest(term, config, limit = 6, audience) {
  const t = term.trim().toLowerCase();
  if (t.length < 2) return { products: [], groups: [], term: t };

  const scored = inCategory(null, audience).map((p) => {
    const name = p.name.toLowerCase();
    let score = 0;
    if (name.startsWith(t)) score = 100;
    else if (name.includes(t)) score = 70;
    else if (haystack(p).includes(t)) score = 40;
    return { p, score };
  }).filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.p.popularity - a.p.popularity)
    .slice(0, limit)
    .map((x) => x.p);

  const groups = [];
  (config.nav || []).forEach((n) => {
    if (n.label.toLowerCase().includes(t) || n.slug.includes(t)) {
      groups.push({ label: n.label, sub: 'Category', href: `/category/${n.slug}` });
    }
  });
  uniq(all().map((p) => p.fabric)).forEach((fab) => {
    if (fab && fab.toLowerCase().includes(t)) {
      groups.push({ label: fab, sub: 'Fabric', href: `/category/all?fabric=${encodeURIComponent(fab)}` });
    }
  });
  uniq(all().flatMap((p) => p.occasion)).forEach((occ) => {
    if (occ && occ.toLowerCase().includes(t)) {
      groups.push({ label: occ, sub: 'Occasion', href: `/category/all?occasion=${encodeURIComponent(occ)}` });
    }
  });

  return { products: scored, groups: groups.slice(0, 4), term: t };
}

function bestsellers(n = 8, audience) {
  return sortList(inCategory(null, audience), 'popular').slice(0, n);
}

function newArrivals(n = 8, audience) {
  return sortList(inCategory(null, audience), 'new').slice(0, n);
}

/** Same-category, closest-priced products. */
function related(product, n = 6) {
  return inCategory(null, product.audience)
    .filter((p) => p.id !== product.id && p.categories.some((c) => product.categories.includes(c)))
    .sort((a, b) => Math.abs(a.price - product.price) - Math.abs(b.price - product.price))
    .slice(0, n);
}

/** Serialises filter state back into a query string. */
function buildQuery(f, overrides = {}) {
  const state = { ...f, ...overrides };
  const qs = new URLSearchParams();
  ['color', 'fabric', 'size', 'occasion', 'price'].forEach((k) => state[k].forEach((v) => qs.append(k, v)));
  if (state.sort && state.sort !== 'featured') qs.set('sort', state.sort);
  if (state.q) qs.set('q', state.q);
  if (state.page && state.page > 1) qs.set('page', state.page);
  return qs.toString();
}

/**
 * Pretty, shareable listing URL — used for HX-Push-Url so the address bar stays
 * correct while the grid swaps in place. NOT for fetching: see buildFragmentUrl.
 */
function buildUrl(categorySlug, f, overrides = {}) {
  const s = buildQuery(f, overrides);
  return `/category/${categorySlug || 'all'}${s ? '?' + s : ''}`;
}

/**
 * Fetch URL for the grid fragment ("load more" / infinite scroll). Must hit the
 * fragment route — pointing this at buildUrl() would inject a whole page into
 * the grid.
 */
function buildFragmentUrl(categorySlug, f, overrides = {}) {
  const s = buildQuery(f, overrides);
  return `/fragments/products/${categorySlug || 'all'}?${s ? s + '&' : ''}append=1`;
}

module.exports = {
  all, invalidate, bySlug, byId, inCategory, facets, parseQuery, search, suggest,
  bestsellers, newArrivals, related, buildUrl, buildFragmentUrl, buildQuery, activeFilterCount,
  PRICE_RANGES, SORTS
};
