'use strict';

/**
 * Bulk product import: CSV or JSON in, validated products out.
 *
 * Shared by the admin UI (/admin) and the CLI (npm run import), so both apply
 * exactly the same parsing, defaults and validation rules.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
const PRODUCTS_PATH = path.join(DATA_DIR, 'products.json');
const BACKUP_DIR = path.join(__dirname, '..', 'data', 'backups');

/** Columns understood by the CSV importer, in template order. */
const COLUMNS = [
  { key: 'name', label: 'name', required: true, hint: 'Raniya Zardozi Bridal Lehenga' },
  { key: 'subtitle', label: 'subtitle', hint: 'Hand-embroidered raw silk with dupatta' },
  { key: 'categories', label: 'categories', required: true, list: true, hint: 'bridal|lehengas' },
  { key: 'price', label: 'price', required: true, number: true, hint: '189000' },
  { key: 'mrp', label: 'mrp', number: true, hint: '225000' },
  { key: 'colors', label: 'colors', list: true, hint: 'Rani Pink|Maroon' },
  { key: 'fabric', label: 'fabric', hint: 'Raw Silk' },
  { key: 'sizes', label: 'sizes', list: true, hint: 'XS|S|M|L|XL' },
  { key: 'occasion', label: 'occasion', list: true, hint: 'Wedding|Reception' },
  { key: 'stock', label: 'stock', number: true, hint: '4 — pieces in hand, all sizes together' },
  { key: 'variantStock', label: 'variantStock', hint: 'S:4|M:2|L:0 or S/Red:4|S/Gold:2 — overrides stock' },
  { key: 'badge', label: 'badge', hint: 'Bestseller' },
  { key: 'audience', label: 'audience', hint: 'men / women / kids — blank shows to everyone' },
  { key: 'sizeChart', label: 'sizeChart', hint: 'which size chart applies, e.g. men' },
  { key: 'hsn', label: 'hsn', hint: '6211 — printed on the tax invoice' },
  { key: 'gstPercent', label: 'gstPercent', number: true, hint: '5 — blank uses the store default' },
  { key: 'cost', label: 'cost', number: true, hint: '42000 — your purchase cost, never shown to customers' },
  { key: 'popularity', label: 'popularity', number: true, hint: '90' },
  { key: 'deliveryDays', label: 'deliveryDays', number: true, hint: '21' },
  { key: 'description', label: 'description', hint: 'Long-form copy for the product page' },
  { key: 'fabricDetails', label: 'fabricDetails', hint: 'Raw silk base · zardozi hand work' },
  { key: 'care', label: 'care', hint: 'Dry clean only.' },
  { key: 'images', label: 'images', list: true, hint: '/static/img/a.jpg|/static/img/b.jpg' },
  { key: 'createdAt', label: 'createdAt', hint: '2026-07-31' },
  { key: 'slug', label: 'slug', hint: 'leave blank to auto-generate' },
  { key: 'id', label: 'id', hint: 'leave blank to auto-generate' }
];

const LIST_SEPARATOR = '|';

/* ------------------------------------------------------------------ CSV ---- */

/**
 * Minimal RFC-4180 CSV reader: handles quoted fields, embedded commas,
 * doubled quotes and both line endings. Returns an array of row arrays.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = String(text).replace(/^﻿/, ''); // strip BOM from Excel exports

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }

  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

function csvToObjects(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { objects: [], unknownColumns: [] };

  const header = rows[0].map((h) => String(h).trim());
  const known = COLUMNS.map((c) => c.key);
  const unknownColumns = header.filter((h) => h && !known.includes(h));

  const objects = rows.slice(1).map((r) => {
    const obj = {};
    header.forEach((h, i) => { if (h && known.includes(h)) obj[h] = r[i] !== undefined ? r[i] : ''; });
    return obj;
  });

  return { objects, unknownColumns };
}

function templateCsv() {
  const header = COLUMNS.map((c) => c.label).join(',');
  const example = COLUMNS.map((c) => {
    const v = c.hint || '';
    return v.includes(',') ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(',');
  return `${header}\n${example}\n`;
}

/* -------------------------------------------------------------- shaping ---- */

function slugify(s) {
  return String(s).toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 70);
}

function toList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (value === undefined || value === null || value === '') return [];
  return String(value).split(LIST_SEPARATOR).map((v) => v.trim()).filter(Boolean);
}

function toNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(String(value).replace(/[₹,\s]/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Reads a per-size stock column: "S:4|M:2|L:0", or "S/Red:4|S/Gold:2" when the
 * count differs by colour.
 *
 * A size written as 0 is counted and sold out; a size left out of the string is
 * NOT counted, which on the storefront also reads as unavailable. That asymmetry
 * is deliberate — a spreadsheet that omits a size should not silently put stock
 * on it — but it is why the importer warns when a listed size is missing here.
 */
function toVariants(value) {
  const rows = [];
  toList(value).forEach((part) => {
    const at = part.lastIndexOf(':');
    if (at < 0) return;

    const where = part.slice(0, at).trim();
    const n = toNumber(part.slice(at + 1));
    if (!where || !Number.isFinite(n)) return;

    const [size, color] = where.split('/').map((x) => x.trim());
    if (!size) return;

    const row = { size, stock: Math.max(0, Math.round(n)) };
    if (color) row.color = color;
    rows.push(row);
  });
  return rows;
}

/** Applies defaults and coerces types. Never throws — errors are reported separately. */
function shape(raw, { today }) {
  const name = String(raw.name || '').trim();
  const price = toNumber(raw.price);
  const mrp = toNumber(raw.mrp);
  const popularity = toNumber(raw.popularity);
  const deliveryDays = toNumber(raw.deliveryDays);

  return {
    id: String(raw.id || '').trim() || null,
    slug: slugify(raw.slug || name),
    name,
    subtitle: String(raw.subtitle || '').trim(),
    categories: toList(raw.categories).map((c) => slugify(c)),
    price: Number.isFinite(price) ? price : price, // NaN/null surfaces in validate()
    mrp: Number.isFinite(mrp) && mrp > 0 ? mrp : (Number.isFinite(price) ? price : 0),
    colors: toList(raw.colors).length ? toList(raw.colors) : ['As shown'],
    fabric: String(raw.fabric || '').trim() || 'Not specified',
    sizes: toList(raw.sizes).length ? toList(raw.sizes) : ['Free Size'],
    occasion: toList(raw.occasion),
    popularity: Number.isFinite(popularity) ? Math.max(0, Math.min(100, popularity)) : 50,
    createdAt: String(raw.createdAt || '').trim() || today,
    badge: String(raw.badge || '').trim() || null,
    description: String(raw.description || '').trim(),
    fabricDetails: String(raw.fabricDetails || '').trim(),
    care: String(raw.care || '').trim(),
    deliveryDays: Number.isFinite(deliveryDays) ? deliveryDays : 10,
    images: toList(raw.images),
    ...stockFields(raw)
  };
}

/**
 * stock and variants together. When a variantStock column is given it wins, and
 * product.stock becomes the sum of it — one number, derived, so no screen can
 * disagree with another.
 */
function stockFields(raw) {
  const variants = toVariants(raw.variantStock);
  if (variants.length) {
    return { variants, stock: variants.reduce((t, v) => t + v.stock, 0) };
  }
  const stock = toNumber(raw.stock);
  return { stock: Number.isFinite(stock) ? Math.max(0, Math.round(stock)) : 0 };
}

function validate(p, raw) {
  const errors = [];
  const warnings = [];

  if (!p.name) errors.push('name is required');
  if (raw.price === undefined || raw.price === '') errors.push('price is required');
  else if (!Number.isFinite(p.price)) errors.push(`price "${raw.price}" is not a number`);
  else if (p.price <= 0) errors.push('price must be greater than 0');

  if (!p.categories.length) errors.push('at least one category is required');
  if (!p.slug) errors.push('could not derive a slug — give a name or slug');
  if (p.createdAt && !/^\d{4}-\d{2}-\d{2}$/.test(p.createdAt)) errors.push(`createdAt "${p.createdAt}" must be YYYY-MM-DD`);

  if (Number.isFinite(p.price) && p.mrp < p.price) warnings.push('mrp is below price — no discount will show');
  if (!p.occasion.length) warnings.push('no occasion — the piece won’t appear under occasion filters');
  if (!p.images.length) warnings.push('no images — placeholder art will be generated');
  if (!p.description) warnings.push('no description');
  if (raw.colors === undefined || String(raw.colors || '').trim() === '') warnings.push('no colours — defaulted to “As shown”');

  if (String(raw.variantStock || '').trim() && !p.variants) {
    warnings.push(`variantStock "${raw.variantStock}" could not be read — expected S:4|M:2`);
  }
  if (p.variants) {
    // A size counted here but not listed above can never be chosen on the storefront.
    const unlisted = p.variants.filter((v) => !p.sizes.some((s2) => s2.toLowerCase() === v.size.toLowerCase()));
    if (unlisted.length) errors.push(`variantStock names sizes that are not in sizes: ${unlisted.map((v) => v.size).join(', ')}`);

    // And a listed size left out of the count reads as sold out, which surprises people.
    const uncounted = p.sizes.filter((s2) => !p.variants.some((v) => v.size.toLowerCase() === s2.toLowerCase()));
    if (uncounted.length) warnings.push(`no count for ${uncounted.join(', ')} — those sizes will show as sold out`);
  } else if (!p.stock) {
    warnings.push('stock is 0 — the piece will list as sold out');
  }

  return { errors, warnings };
}

/* --------------------------------------------------------------- import ---- */

function readProducts() {
  return JSON.parse(fs.readFileSync(PRODUCTS_PATH, 'utf8'));
}

function nextIdFactory(existing) {
  let max = 0;
  existing.forEach((p) => {
    const m = /^p(\d+)$/.exec(String(p.id || ''));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return () => {
    max += 1;
    return 'p' + String(max).padStart(3, '0');
  };
}

/**
 * Parses + validates an upload without touching disk.
 *
 * mode: 'append' keeps every existing product and skips slug clashes,
 *       'upsert' overwrites products whose slug/id already exists,
 *       'replace' throws away the current catalogue.
 */
function analyse(text, { format = 'csv', mode = 'append' } = {}) {
  const existing = readProducts();
  const today = new Date().toISOString().slice(0, 10);

  let objects = [];
  let unknownColumns = [];
  let parseError = null;

  try {
    if (format === 'json') {
      const parsed = JSON.parse(text);
      objects = Array.isArray(parsed) ? parsed : [parsed];
    } else {
      const out = csvToObjects(text);
      objects = out.objects;
      unknownColumns = out.unknownColumns;
    }
  } catch (e) {
    parseError = e.message;
  }

  const existingBySlug = new Map(existing.map((p) => [p.slug, p]));
  const seenSlugs = new Set();
  const nextId = nextIdFactory(existing);

  const rows = objects.map((raw, i) => {
    const product = shape(raw, { today });
    const { errors, warnings } = validate(product, raw);

    let action = 'create';
    if (seenSlugs.has(product.slug)) {
      errors.push(`duplicate slug "${product.slug}" inside this file`);
      action = 'skip';
    } else if (existingBySlug.has(product.slug)) {
      if (mode === 'append') { action = 'skip'; warnings.push(`slug "${product.slug}" already exists — row skipped in append mode`); }
      else { action = 'update'; }
    }
    seenSlugs.add(product.slug);

    if (errors.length) action = 'skip';
    if (action === 'update') product.id = existingBySlug.get(product.slug).id;
    else if (action === 'create' && !product.id) product.id = nextId();

    return { line: i + 2, raw, product, errors, warnings, action };
  });

  return {
    parseError,
    unknownColumns,
    mode,
    format,
    rows,
    existingCount: existing.length,
    counts: {
      total: rows.length,
      create: rows.filter((r) => r.action === 'create').length,
      update: rows.filter((r) => r.action === 'update').length,
      skip: rows.filter((r) => r.action === 'skip').length,
      warnings: rows.filter((r) => r.warnings.length).length
    }
  };
}

/** Writes a timestamped backup of the current catalogue and returns its path. */
function backup() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(BACKUP_DIR, `products-${stamp}.json`);
  fs.copyFileSync(PRODUCTS_PATH, file);
  return file;
}

/** Applies an analysis to data/products.json. Always backs up first. */
function commit(analysis) {
  if (analysis.parseError) throw new Error('Cannot commit: ' + analysis.parseError);

  const existing = readProducts();
  const backupPath = backup();

  const accepted = analysis.rows.filter((r) => r.action !== 'skip');
  let list;

  if (analysis.mode === 'replace') {
    list = accepted.map((r) => r.product);
  } else {
    const bySlug = new Map(existing.map((p) => [p.slug, p]));
    accepted.forEach((r) => bySlug.set(r.product.slug, { ...(bySlug.get(r.product.slug) || {}), ...r.product }));
    list = [...bySlug.values()];
  }

  fs.writeFileSync(PRODUCTS_PATH, JSON.stringify(list, null, 2) + '\n', 'utf8');

  return {
    backupPath: path.relative(path.join(__dirname, '..'), backupPath),
    written: list.length,
    created: analysis.counts.create,
    updated: analysis.counts.update,
    skipped: analysis.counts.skip
  };
}

module.exports = {
  COLUMNS, LIST_SEPARATOR, PRODUCTS_PATH,
  parseCsv, csvToObjects, templateCsv, slugify, shape, validate, toVariants,
  analyse, commit, backup, readProducts
};
