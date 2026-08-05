'use strict';

/**
 * Stock per size and colour.
 *
 * The template started with one stock number per product, which is honest for a
 * made-to-order couture house — nothing is on a shelf, so "stock" barely means
 * anything. It is wrong for a retail shop: a kurti with stock 12 has twelve
 * pieces spread across M, L and XL, and selling twelve XL is a refund and an
 * apology.
 *
 * A product may now carry `variants`:
 *
 *   variants: [
 *     { size: 'M', color: 'Red',  stock: 4 },
 *     { size: 'M', color: 'Blue', stock: 0 },
 *     { size: 'L', stock: 6 }            // this size, any colour
 *   ]
 *
 * Matching is MOST SPECIFIC FIRST — size+colour, then size alone, then the
 * product's own `stock`. That is deliberate: a shop that only counts by size
 * writes size-only rows, a shop that counts by both writes both, and a shop with
 * no variants at all keeps working exactly as before. Nobody is forced into a
 * model they don't run.
 *
 * `null` anywhere here means UNTRACKED, not zero. A made-to-order piece has no
 * stock number and must stay buyable; treating absent as sold out would empty
 * every couture shop the day this shipped.
 */

/** Case- and space-insensitive, because 'Red' and 'red ' are the same colour. */
function same(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function rows(product) {
  return Array.isArray(product && product.variants) ? product.variants : [];
}

function tracksVariants(product) {
  return rows(product).length > 0;
}

/**
 * The variant row that governs this size/colour, or null.
 * Exact match beats a size-only row, which beats nothing.
 */
function rowFor(product, { size, color } = {}) {
  const list = rows(product);
  if (!list.length) return null;

  const exact = list.find((v) => same(v.size, size) && v.color && same(v.color, color));
  if (exact) return exact;

  const sizeOnly = list.find((v) => same(v.size, size) && !v.color);
  if (sizeOnly) return sizeOnly;

  // A row for the colour alone, for shops that count by colourway.
  const colourOnly = list.find((v) => !v.size && v.color && same(v.color, color));
  if (colourOnly) return colourOnly;

  return null;
}

/**
 * How many of this exact size/colour exist.
 * Returns null when nothing tracks it — untracked, always buyable.
 */
function stockFor(product, choice) {
  const row = rowFor(product, choice);
  if (row) return Number.isFinite(row.stock) ? Math.max(0, row.stock) : null;

  // No variant row matched. If the product tracks variants at all, an unlisted
  // combination does not exist — a size that isn't in the table is not for sale.
  if (tracksVariants(product)) return 0;

  return Number.isFinite(product && product.stock) ? Math.max(0, product.stock) : null;
}

/** Everything on hand, across every variant. Null when untracked. */
function totalStock(product) {
  if (tracksVariants(product)) {
    return rows(product).reduce((sum, v) => sum + (Number.isFinite(v.stock) ? Math.max(0, v.stock) : 0), 0);
  }
  return Number.isFinite(product && product.stock) ? Math.max(0, product.stock) : null;
}

function isSoldOut(product, choice) {
  const n = stockFor(product, choice);
  return n === 0;
}

/** Is there anything at all left of this product? Untracked counts as yes. */
function anyAvailable(product) {
  const n = totalStock(product);
  return n === null || n > 0;
}

/**
 * Which sizes can actually be bought, optionally within one colour.
 * Used by the size picker to strike through what is gone.
 */
function sizeAvailability(product, color) {
  const sizes = (product && product.sizes) || [];
  return sizes.map((size) => {
    const n = stockFor(product, { size, color });
    return {
      size,
      stock: n,
      available: n === null || n > 0,
      // Worth telling a customer: urgency that is true.
      low: Number.isFinite(n) && n > 0 && n <= 2
    };
  });
}

/** Which colours have anything left, optionally within one size. */
function colourAvailability(product, size) {
  const colors = (product && product.colors) || [];
  return colors.map((color) => {
    const n = size
      ? stockFor(product, { size, color })
      : (product.sizes || []).reduce((best, s) => {
        const v = stockFor(product, { size: s, color });
        if (v === null) return null;
        return best === null ? null : best + v;
      }, 0);
    return { color, stock: n, available: n === null || n > 0 };
  });
}

/**
 * The grid the admin edits: every size × colour the product offers, with the
 * stock that currently governs it. Built from the product's own size and colour
 * lists so the table always matches what is on sale.
 */
function matrix(product) {
  const sizes = (product && product.sizes) || [];
  const colors = (product && product.colors) || [];

  // A product with no colours still needs one column, or the grid is empty.
  const columns = colors.length ? colors : [null];

  return {
    sizes,
    colors: columns,
    tracked: tracksVariants(product),
    total: totalStock(product),
    cell(size, color) {
      const row = rowFor(product, { size, color });
      return {
        size,
        color,
        stock: row && Number.isFinite(row.stock) ? row.stock : null,
        // Shown differently: a value inherited from a size-only row is not the
        // same as one typed against this exact cell.
        inherited: !!(row && ((row.color && !same(row.color, color)) || (!row.color && color)))
      };
    }
  };
}

/**
 * Writes a stock number for one size/colour, returning a NEW variants array.
 * Pure on purpose — persistence belongs to src/products.js.
 */
function setStock(product, { size, color }, stock) {
  const next = rows(product).map((v) => ({ ...v }));
  const value = Number.isFinite(Number(stock)) ? Math.max(0, Math.round(Number(stock))) : 0;

  const at = next.findIndex((v) => same(v.size, size) && (
    (v.color && color && same(v.color, color)) || (!v.color && !color)
  ));

  if (at >= 0) next[at].stock = value;
  else next.push(color ? { size, color, stock: value } : { size, stock: value });

  return next;
}

/* A decrement() lived here and nothing ever called it. Selling a piece goes through
   products.adjustVariantStock(), which writes to disk; this one returned a new array and
   left the caller to persist it. Two ways to take stock off a size, one of which quietly
   does nothing, is a trap for whoever reaches for the wrong one — and the wrong one is
   the one that reads as harmless. */

/**
 * Pieces in one size, across every colour.
 *
 * Read from the stored rows, NOT by adding up the grid's cells: a size counted
 * without a colour shows the same number in every colour column, so summing the
 * cells counts it once per colour. That is how a shop with 12 pieces reads 24.
 *
 * Returns null when the size is not counted at all, which is different from 0.
 */
function sizeTotal(product, size) {
  const mine = rows(product).filter((v) => same(v.size, size) && Number.isFinite(v.stock));
  if (!mine.length) return null;
  return mine.reduce((t, v) => t + Math.max(0, v.stock), 0);
}

/** Variants at or below the threshold — the buying list. */
function lowVariants(product, threshold) {
  const limit = Number.isFinite(threshold) ? threshold : 3;
  return rows(product)
    .filter((v) => Number.isFinite(v.stock) && v.stock <= limit)
    .map((v) => ({ size: v.size || null, color: v.color || null, stock: v.stock }))
    .sort((a, b) => a.stock - b.stock);
}

/** A readable label for one variant, for admin tables and alerts. */
function label(variant) {
  return [variant.size, variant.color].filter(Boolean).join(' · ') || 'All';
}

module.exports = {
  same, tracksVariants, rowFor, stockFor, totalStock, isSoldOut, anyAvailable,
  sizeAvailability, colourAvailability, matrix, sizeTotal, setStock, lowVariants, label
};
