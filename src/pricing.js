'use strict';

/**
 * Who decides what, and in what order.
 *
 * GST %      product.gstPercent → category default → config.finance.gstPercentDefault
 * Unit cost  product.cost       → category default % of price → config default %
 *
 * So the owner can set a real purchase cost per SKU (buy at 100, sell at 500 or
 * 1000 — the margin follows the number they typed, not a guess), and only falls
 * back to a percentage where they haven't.
 *
 * Product prices are GST-INCLUSIVE, so tax is extracted, never added:
 *   tax = price × rate / (1 + rate)
 *
 * `cost` and `gstPercent` are admin-only fields. Nothing in views/pages/* prints
 * them; they exist for the P&L.
 */

function categoryDefaults(config, categories) {
  const map = (config.finance && config.finance.categoryDefaults) || {};
  const hit = (categories || []).map((c) => map[c]).find(Boolean);
  return hit || null;
}

/**
 * Rate from a price slab, if the store has them configured.
 *
 * Apparel in India is slabbed on the SALE VALUE OF THE PIECE, not on the order:
 * a garment under ₹2,500 is taxed at 5%, at or above it at 18%. Two pieces at
 * ₹2,000 in one order are still 5% each — the threshold is per unit.
 *
 * Slabs are `[{ maxPrice, percent }, …]` with the last entry's maxPrice omitted
 * to mean "and above". Configured, not hardcoded, because these rates change and
 * because not every client sells apparel.
 */
function slabPercent(unitPrice, config) {
  const slabs = (config.finance && config.finance.gstSlabs) || null;
  if (!Array.isArray(slabs) || !slabs.length) return null;

  const price = Number(unitPrice) || 0;
  const sorted = [...slabs].sort((a, b) => (a.maxPrice || Infinity) - (b.maxPrice || Infinity));
  const hit = sorted.find((s) => !Number.isFinite(s.maxPrice) || price < s.maxPrice)
    || sorted[sorted.length - 1];
  return Number.isFinite(hit.percent) ? hit.percent : null;
}

/**
 * Resolved GST percentage for a product.
 *
 * Order of authority:
 *   1. the product's own rate      — an explicit decision, always wins
 *   2. the price slab              — the law for apparel, so it beats a guess
 *   3. the category default        — the owner's shorthand for a whole category
 *   4. the store default           — last resort
 *
 * The slab sits above the category default on purpose: a category set to 5% must
 * not undercharge a ₹1.8 lakh lehenga that legally attracts 18%.
 */
function gstPercent(product, config) {
  const f = config.finance || {};
  if (product && Number.isFinite(product.gstPercent)) return product.gstPercent;

  const slab = slabPercent(product && product.price, config);
  if (slab !== null) return slab;

  const cat = categoryDefaults(config, product && product.categories);
  if (cat && Number.isFinite(cat.gstPercent)) return cat.gstPercent;
  return Number.isFinite(f.gstPercentDefault) ? f.gstPercentDefault : 12;
}

/** Resolved unit cost (what the piece actually costs the business). */
function unitCost(product, config) {
  const f = config.finance || {};
  if (product && Number.isFinite(product.cost) && product.cost > 0) return product.cost;
  const cat = categoryDefaults(config, product && product.categories);
  const pct = (cat && Number.isFinite(cat.cogsPercent)) ? cat.cogsPercent
    : (Number.isFinite(f.defaultCogsPercent) ? f.defaultCogsPercent : 45);
  return Math.round(((product && product.price) || 0) * pct / 100);
}

/** Tax contained in a GST-inclusive amount. */
function taxOf(amountInclusive, percent) {
  const r = (Number(percent) || 0) / 100;
  if (!r) return 0;
  return Math.round(amountInclusive * r / (1 + r));
}

/** Per-unit economics for one product, before order-level costs. */
function productMargin(product, config) {
  const gst = gstPercent(product, config);
  const cost = unitCost(product, config);
  const tax = taxOf(product.price, gst);
  const netPrice = product.price - tax;
  const grossProfit = netPrice - cost;
  return {
    price: product.price,
    gstPercent: gst,
    tax,
    netPrice,
    cost,
    grossProfit,
    marginPercent: netPrice ? +((grossProfit / netPrice) * 100).toFixed(1) : 0,
    markupMultiple: cost ? +(product.price / cost).toFixed(2) : null
  };
}

/**
 * Line-level snapshot written onto an order at checkout, so later catalogue or
 * tax-rate edits never rewrite historical P&L.
 */
function lineSnapshot(product, qty, config) {
  const gst = gstPercent(product, config);
  const cost = unitCost(product, config);
  const gross = product.price * qty;
  return {
    price: product.price,
    qty,
    cost,
    gstPercent: gst,
    taxAmount: taxOf(gross, gst),
    lineTotal: gross,
    lineCost: cost * qty
  };
}

/**
 * Totals for a set of order lines. Falls back to resolving from the catalogue for
 * orders written before per-line tax was stored.
 */
function orderTax(order, config, catalog) {
  if (Number.isFinite(order.gstAmount) && order.gstAmount > 0) return order.gstAmount;
  return (order.items || []).reduce((sum, it) => {
    const product = catalog ? catalog.byId(it.productId) : null;
    const pct = Number.isFinite(it.gstPercent) ? it.gstPercent : gstPercent(product || { price: it.price }, config);
    return sum + taxOf(it.price * it.qty, pct);
  }, 0);
}

function orderCogs(order, config, catalog) {
  if (Number.isFinite(order.cogs) && order.cogs > 0) return order.cogs;
  return (order.items || []).reduce((sum, it) => {
    if (Number.isFinite(it.cost) && it.cost > 0) return sum + it.cost * it.qty;
    const product = catalog ? catalog.byId(it.productId) : null;
    return sum + unitCost(product || { price: it.price }, config) * it.qty;
  }, 0);
}

module.exports = { gstPercent, slabPercent, unitCost, taxOf, productMargin, lineSnapshot, orderTax, orderCogs, categoryDefaults };
