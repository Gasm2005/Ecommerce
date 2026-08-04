'use strict';

/**
 * Write side of the catalogue (the read side is src/catalog.js).
 * Every mutation backs up data/products.json and busts the catalogue cache.
 */

const fs = require('fs');
const path = require('path');
const catalog = require('./catalog');
const store = require('./store');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
const PRODUCTS_PATH = path.join(DATA_DIR, 'products.json');

function readRaw() {
  return JSON.parse(fs.readFileSync(PRODUCTS_PATH, 'utf8'));
}

function writeRaw(list, { skipBackup = false } = {}) {
  let backupPath = null;
  if (!skipBackup) backupPath = store.backup('products');
  const tmp = PRODUCTS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, PRODUCTS_PATH);
  catalog.invalidate();
  return { backupPath };
}

const NUMERIC = ['price', 'mrp', 'cost', 'stock', 'popularity', 'deliveryDays', 'gstPercent'];
const LISTS = ['categories', 'colors', 'sizes', 'occasion', 'images'];

/** Coerces a form body into product fields, leaving untouched keys alone. */
function fieldsFromBody(body) {
  const out = {};

  ['name', 'subtitle', 'fabric', 'description', 'fabricDetails', 'care', 'badge', 'sku', 'hsn', 'audience', 'sizeChart', 'createdAt', 'slug'].forEach((k) => {
    if (body[k] !== undefined) out[k] = String(body[k]).trim();
  });
  NUMERIC.forEach((k) => {
    if (body[k] !== undefined && body[k] !== '') {
      const n = Number(String(body[k]).replace(/[₹,\s]/g, ''));
      if (Number.isFinite(n)) out[k] = n;
    }
  });
  LISTS.forEach((k) => {
    if (body[k] !== undefined) {
      out[k] = String(body[k]).split(/[|\n,]/).map((v) => v.trim()).filter(Boolean);
    }
  });
  if (out.badge === '') out.badge = null;
  if (out.slug) out.slug = store.slugify(out.slug);
  return out;
}

function nextProductId(list) {
  let max = 0;
  list.forEach((p) => {
    const m = /^p(\d+)$/.exec(String(p.id || ''));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return 'p' + String(max + 1).padStart(3, '0');
}

function update(id, fields) {
  const list = readRaw();
  const idx = list.findIndex((p) => p.id === id);
  if (idx < 0) return null;

  // Guard the slug: it's the storefront URL, so it must stay unique.
  if (fields.slug && list.some((p, i) => i !== idx && p.slug === fields.slug)) {
    throw new Error(`slug "${fields.slug}" is already used by another product`);
  }

  list[idx] = { ...list[idx], ...fields };
  writeRaw(list);
  return list[idx];
}

function create(fields, config) {
  const list = readRaw();
  const name = fields.name || 'Untitled piece';
  let slug = fields.slug || store.slugify(name);
  let n = 2;
  while (list.some((p) => p.slug === slug)) slug = store.slugify(name) + '-' + n++;

  const finance = (config && config.finance) || {};
  const price = Number.isFinite(fields.price) ? fields.price : 0;

  const product = {
    id: nextProductId(list),
    slug,
    name,
    subtitle: fields.subtitle || '',
    categories: fields.categories && fields.categories.length ? fields.categories : ['festive'],
    price,
    mrp: Number.isFinite(fields.mrp) && fields.mrp > 0 ? fields.mrp : price,
    cost: Number.isFinite(fields.cost) ? fields.cost : Math.round(price * (finance.defaultCogsPercent || 42) / 100),
    stock: Number.isFinite(fields.stock) ? fields.stock : 0,
    sku: fields.sku || '',
    colors: fields.colors && fields.colors.length ? fields.colors : ['As shown'],
    fabric: fields.fabric || 'Not specified',
    sizes: fields.sizes && fields.sizes.length ? fields.sizes : ['Free Size'],
    occasion: fields.occasion || [],
    popularity: Number.isFinite(fields.popularity) ? fields.popularity : 50,
    createdAt: fields.createdAt || new Date().toISOString().slice(0, 10),
    badge: fields.badge || null,
    description: fields.description || '',
    fabricDetails: fields.fabricDetails || '',
    care: fields.care || '',
    deliveryDays: Number.isFinite(fields.deliveryDays) ? fields.deliveryDays : 10,
    images: fields.images || []
  };

  writeRaw([...list, product]);
  return product;
}

function remove(id) {
  const list = readRaw();
  const product = list.find((p) => p.id === id);
  if (!product) return null;
  writeRaw(list.filter((p) => p.id !== id));
  return product;
}

function adjustStock(id, delta) {
  const list = readRaw();
  const idx = list.findIndex((p) => p.id === id);
  if (idx < 0) return null;
  const current = Number.isFinite(list[idx].stock) ? list[idx].stock : 0;
  list[idx] = { ...list[idx], stock: Math.max(0, current + delta) };
  writeRaw(list, { skipBackup: true });
  return list[idx];
}

/**
 * Moves the stock on ONE size/colour. Used when an order sells a specific
 * variant, and by the admin stock grid.
 *
 * `product.stock` is kept in step as the sum of the variants, so every screen and
 * report that still reads a single number stays truthful instead of drifting.
 */
function adjustVariantStock(id, choice, delta) {
  const variants = require('./variants');
  const list = readRaw();
  const idx = list.findIndex((p) => p.id === id);
  if (idx < 0) return null;

  const product = list[idx];
  const current = variants.stockFor(product, choice);
  const next = Math.max(0, (Number.isFinite(current) ? current : 0) + delta);

  const rows = variants.setStock(product, choice, next);
  list[idx] = { ...product, variants: rows, stock: variants.totalStock({ ...product, variants: rows }) };

  writeRaw(list, { skipBackup: true });
  return list[idx];
}

/** Sets one variant outright, rather than moving it by a delta. */
function setVariantStock(id, choice, value) {
  const variants = require('./variants');
  const list = readRaw();
  const idx = list.findIndex((p) => p.id === id);
  if (idx < 0) return null;

  const product = list[idx];
  const rows = variants.setStock(product, choice, value);
  list[idx] = { ...product, variants: rows, stock: variants.totalStock({ ...product, variants: rows }) };

  writeRaw(list, { skipBackup: true });
  return list[idx];
}

/**
 * Removes the row for one size/colour, so it goes back to "not counted" rather
 * than reading as a hard zero. Clearing the last row stops variant tracking
 * altogether and the single product number takes over again.
 */
function clearVariantStock(id, choice) {
  const variants = require('./variants');
  const list = readRaw();
  const idx = list.findIndex((x) => x.id === id);
  if (idx < 0) return null;

  const product = list[idx];
  const rows = (Array.isArray(product.variants) ? product.variants : []).filter((v) => !(
    variants.same(v.size, choice.size) && (
      (v.color && choice.color && variants.same(v.color, choice.color)) || (!v.color && !choice.color)
    )
  ));

  const next = { ...product, variants: rows };
  // Only recompute the headline number while variants still say something; once
  // the last row goes, the number the owner typed by hand is the truth again.
  if (rows.length) next.stock = variants.totalStock(next);
  list[idx] = next;

  writeRaw(list, { skipBackup: true });
  return next;
}

function setStock(id, value) {
  const list = readRaw();
  const idx = list.findIndex((p) => p.id === id);
  if (idx < 0) return null;
  list[idx] = { ...list[idx], stock: Math.max(0, Number(value) || 0) };
  writeRaw(list, { skipBackup: true });
  return list[idx];
}

/** Renames a category slug across every product (used by category CRUD). */
function renameCategory(from, to) {
  const list = readRaw();
  let touched = 0;
  const next = list.map((p) => {
    if (!p.categories.includes(from)) return p;
    touched++;
    return { ...p, categories: p.categories.map((c) => (c === from ? to : c)) };
  });
  if (touched) writeRaw(next);
  return touched;
}

function removeCategory(slug) {
  const list = readRaw();
  let touched = 0;
  const next = list.map((p) => {
    if (!p.categories.includes(slug)) return p;
    touched++;
    const categories = p.categories.filter((c) => c !== slug);
    return { ...p, categories: categories.length ? categories : ['festive'] };
  });
  if (touched) writeRaw(next);
  return touched;
}

function csv(list) {
  const head = ['id', 'sku', 'name', 'slug', 'categories', 'price', 'mrp', 'cost', 'stock', 'colors', 'fabric', 'sizes', 'occasion', 'badge', 'popularity', 'deliveryDays', 'createdAt', 'images'];
  const rows = list.map((p) => head.map((k) => Array.isArray(p[k]) ? p[k].join('|') : (p[k] === undefined || p[k] === null ? '' : p[k])));
  return [head, ...rows]
    .map((r) => r.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c))).join(','))
    .join('\n') + '\n';
}

module.exports = { readRaw, writeRaw, fieldsFromBody, create, update, remove, adjustStock, setStock,
  adjustVariantStock, setVariantStock, clearVariantStock, renameCategory, removeCategory, csv };
