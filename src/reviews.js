'use strict';

const store = require('./store');
const catalog = require('./catalog');

const STATUSES = [
  { id: 'pending', label: 'Pending', tone: 'warning' },
  { id: 'approved', label: 'Approved', tone: 'good' },
  { id: 'rejected', label: 'Rejected', tone: 'critical' }
];

function all() {
  return store.read('reviews', []);
}

function forProduct(productId, { approvedOnly = true } = {}) {
  return all()
    .filter((r) => r.productId === productId && (!approvedOnly || r.status === 'approved'))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Average + histogram, used on the PDP and in the admin product list. */
function stats(productId) {
  const list = forProduct(productId);
  if (!list.length) return { count: 0, average: 0, histogram: [0, 0, 0, 0, 0] };
  const histogram = [0, 0, 0, 0, 0];
  list.forEach((r) => { histogram[Math.min(5, Math.max(1, r.rating)) - 1] += 1; });
  return {
    count: list.length,
    average: +(list.reduce((s, r) => s + r.rating, 0) / list.length).toFixed(2),
    histogram
  };
}

/** Per-product rollup for the admin reviews screen. */
function byProduct({ q, status } = {}) {
  const list = all();
  const map = new Map();

  list.forEach((r) => {
    if (status && r.status !== status) return;
    const row = map.get(r.productId) || { productId: r.productId, reviews: [], pending: 0, sum: 0 };
    row.reviews.push(r);
    if (r.status === 'pending') row.pending += 1;
    if (r.status === 'approved') row.sum += r.rating;
    map.set(r.productId, row);
  });

  let rows = [...map.values()].map((row) => {
    const product = catalog.byId(row.productId);
    const approved = row.reviews.filter((r) => r.status === 'approved');
    return {
      ...row,
      product,
      name: product ? product.name : row.productId,
      slug: product ? product.slug : '',
      count: row.reviews.length,
      approvedCount: approved.length,
      average: approved.length ? +(row.sum / approved.length).toFixed(2) : 0,
      reviews: row.reviews.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    };
  });

  if (q) {
    const needle = q.toLowerCase();
    rows = rows.filter((r) => r.name.toLowerCase().includes(needle));
  }

  return rows.sort((a, b) => b.pending - a.pending || b.count - a.count);
}

function overview() {
  const list = all();
  const approved = list.filter((r) => r.status === 'approved');
  return {
    total: list.length,
    pending: list.filter((r) => r.status === 'pending').length,
    rejected: list.filter((r) => r.status === 'rejected').length,
    average: approved.length ? +(approved.reduce((s, r) => s + r.rating, 0) / approved.length).toFixed(2) : 0,
    lowRated: approved.filter((r) => r.rating <= 3).length,
    productsCovered: new Set(list.map((r) => r.productId)).size
  };
}

function setStatus(id, status) {
  if (!STATUSES.some((s) => s.id === status)) throw new Error('Unknown review status');
  let updated = null;
  store.update('reviews', [], (list) => list.map((r) => {
    if (r.id !== id) return r;
    updated = { ...r, status };
    return updated;
  }), { skipBackup: true });
  return updated;
}

function reply(id, text) {
  let updated = null;
  store.update('reviews', [], (list) => list.map((r) => {
    if (r.id !== id) return r;
    updated = { ...r, reply: text ? { body: text, at: new Date().toISOString(), author: 'The Atelier' } : null };
    return updated;
  }), { skipBackup: true });
  return updated;
}

function remove(id) {
  let removed = null;
  store.update('reviews', [], (list) => {
    removed = list.find((r) => r.id === id) || null;
    return list.filter((r) => r.id !== id);
  }, { skipBackup: true });
  // Uploaded photos/video go with it — otherwise they linger on disk forever.
  if (removed && removed.media && removed.media.length) {
    require('./uploads').removeMedia(removed.media);
  }
  return removed;
}

/**
 * Storefront submission — always lands in moderation.
 * `order` (when purchase verification is on) marks it a verified buyer review and
 * blocks a second review of the same product on the same order.
 */
function create({ productId, rating, title, body, author, location, media, order }) {
  const product = catalog.byId(productId) || catalog.bySlug(productId);
  if (!product) return null;

  const review = {
    id: store.nextId('REV', all()),
    productId: product.id,
    productSlug: product.slug,
    orderId: order ? order.id : null,
    rating: Math.min(5, Math.max(1, parseInt(rating, 10) || 5)),
    title: String(title || '').slice(0, 90),
    body: String(body || '').slice(0, 1200),
    author: String(author || (order ? order.customer.name : 'Anonymous')).slice(0, 60),
    location: String(location || (order ? order.address.city : '')).slice(0, 60),
    createdAt: new Date().toISOString(),
    status: 'pending',
    verified: !!order,
    media: Array.isArray(media) ? media : [],
    reply: null
  };

  store.update('reviews', [], (list) => [...list, review], { skipBackup: true });
  return review;
}

/** True when this order already carries a review for this product. */
function alreadyReviewed(orderId, productId) {
  return all().some((r) => r.orderId === orderId && r.productId === productId);
}

module.exports = {
  STATUSES, all, forProduct, stats, byProduct, overview,
  setStatus, reply, remove, create, alreadyReviewed
};
