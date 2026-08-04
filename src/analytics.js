'use strict';

/**
 * Every number the dashboard shows is computed here, from data/orders.json.
 *
 * Money model (product prices are GST-inclusive):
 *   gross          = sum of order totals (what customers were charged)
 *   refunds        = totals of cancelled/returned orders
 *   net sales      = gross − refunds
 *   GST            = tax component extracted from net sales
 *   revenue (ex-tax)= net sales − GST − shipping collected
 *   COGS           = per-item cost × qty
 *   gross profit   = revenue − COGS
 *   variable costs = payment fees + COD fees + fulfilment/shipping cost
 *   contribution   = gross profit − variable costs
 *   EBITDA         = contribution − opex for the period
 */

const orders = require('./orders');
const catalog = require('./catalog');
const pricing = require('./pricing');

const DAY = 24 * 3600 * 1000;

/**
 * Did this order come through a marketplace rather than the store's own site?
 *
 * It matters because only a marketplace withholds TDS and TCS. Channel comes from
 * attribution, so 'web', 'direct' and organic search are the store's own.
 */
const OWN_CHANNELS = new Set(['web', 'direct', 'organic', 'google', 'instagram', 'facebook', 'whatsapp', 'email', null, undefined, '']);
function isMarketplace(order) {
  return !OWN_CHANNELS.has(order.channel);
}

/**
 * Short windows matter as much as long ones: a one-day or five-day view is how
 * you tell whether an influencer post or a campaign actually moved anything.
 * Every window is compared against the equal-length period immediately before it.
 */
const RANGES = [
  { id: 'today', label: 'Today', days: 1 },
  { id: '2d', label: '2 days', days: 2 },
  { id: '5d', label: '5 days', days: 5 },
  { id: '7d', label: '7 days', days: 7 },
  { id: '15d', label: '15 days', days: 15 },
  { id: '30d', label: '30 days', days: 30 },
  { id: '90d', label: '90 days', days: 90 },
  { id: '12m', label: '12 months', days: 365 },
  { id: 'all', label: 'All time', days: null }
];

function resolveRange(id) {
  return RANGES.find((r) => r.id === id) || RANGES.find((r) => r.id === '30d');
}

/** Accepts a preset id or a { range, from, to } spec — both reach windowFor. */
function resolveWindow(spec, now) {
  if (spec && typeof spec === 'object') return windowFor(spec.range, now, { from: spec.from, to: spec.to });
  return windowFor(spec, now);
}

/**
 * Resolves a window from either a preset id or an explicit from/to pair
 * (`?from=2026-07-01&to=2026-07-05`), which is what campaign analysis needs.
 */
function windowFor(rangeId, now = new Date(), custom = null) {
  if (custom && custom.from) {
    const from = new Date(custom.from + 'T00:00:00Z');
    const to = custom.to ? new Date(custom.to + 'T23:59:59Z') : now;
    if (!isNaN(from) && !isNaN(to) && from <= to) {
      const days = Math.max(1, Math.round((to - from) / DAY));
      return { from, to, range: { id: 'custom', label: `${custom.from} → ${custom.to || 'now'}`, days, custom: true } };
    }
  }

  const range = resolveRange(rangeId);
  if (!range.days) {
    /* "All time" starts at the FIRST ORDER, not at the epoch. Starting at 1970
       made fixedCosts() prorate rent and salaries over 688 months, which turned a
       profitable store into a ₹22 crore loss on that one view. */
    const first = orders.all().reduce((min, o) => {
      const t = new Date(o.createdAt).getTime();
      return Number.isFinite(t) && t < min ? t : min;
    }, Infinity);
    return { from: new Date(Number.isFinite(first) ? first : now.getTime()), to: now, range };
  }

  // Month-bucketed ranges snap to the 1st, so the first column isn't a stub day
  // (a plain now−365d window starts mid-month and reads as an empty month).
  if (range.days > 92) {
    const months = Math.round(range.days / 30) - 1;
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, 1, 0, 0, 0));
    return { from, to: now, range };
  }

  // "Today" means from midnight, not the last 24 hours.
  if (range.id === 'today') {
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
    return { from, to: now, range };
  }

  const from = new Date(now.getTime() - range.days * DAY);
  return { from, to: now, range };
}

/** The equivalent window immediately before this one, for % change. */
function previousWindow({ from, to }) {
  const span = to - from;
  return { from: new Date(from.getTime() - span), to: from };
}

function inWindow(order, { from, to }) {
  const t = new Date(order.createdAt).getTime();
  return t >= from.getTime() && t <= to.getTime();
}

/**
 * Core P&L for a set of orders.
 *
 * The ladder, in the order money actually leaves:
 *   gross sales
 *   − refunds (cancelled/returned)              = net sales
 *   − GST (extracted, it was never ours)
 *   − shipping collected (passed to the courier) = revenue, ex-tax
 *   − COGS (per-SKU cost the owner entered)      = gross profit
 *   − packaging, shipping cost, COD handling
 *   − payment gateway %, platform %, returns provision
 *                                                = contribution
 *   − marketing, salaries, rent, software, other (prorated)
 *                                                = EBITDA
 *   − depreciation                                = EBIT
 *   − loan interest                               = PBT (profit before tax)
 *   − income tax on PBT                           = PROFIT IN HAND (PAT)
 *
 * EBITDA and profit in hand are NOT the same number. EBITDA is how the business
 * performs; profit in hand is what the owner keeps. A store with a loan and a tax
 * bill can show a healthy EBITDA and take home much less.
 */
function totals(list, config) {
  const f = config.finance || {};
  const perOrder = f.perOrderCosts || {};
  const pct = f.percentCosts || {};

  const live = list.filter((o) => !orders.IS_LOST(o));
  const lost = list.filter((o) => orders.IS_LOST(o));

  const gross = list.reduce((s, o) => s + o.total, 0);
  // A cancelled order loses the whole value; a return loses only what was
  // actually refunded (partial refunds are common on made-to-order pieces).
  const refunds = lost.reduce((s, o) => s + (Number.isFinite(o.refundedAmount) ? o.refundedAmount : o.total), 0);
  const netSales = gross - refunds;

  const shippingCollected = live.reduce((s, o) => s + (o.shipping || 0), 0);
  const gst = live.reduce((s, o) => s + pricing.orderTax(o, config, catalog), 0);

  const revenue = netSales - gst - shippingCollected;
  const cogs = live.reduce((s, o) => s + pricing.orderCogs(o, config, catalog), 0);
  const grossProfit = revenue - cogs;

  /* ---- variable costs, per order ---- */
  const packaging = live.length * (perOrder.packaging || 0);
  const fulfilment = live.length * (perOrder.shippingCost || 0);
  const codHandling = live.filter((o) => o.paymentMethod === 'cod').length * (perOrder.codHandling || 0);

  /* ---- variable costs, percentage of value ---- */
  const gatewayBase = live.filter((o) => o.paymentMethod !== 'cod').reduce((s, o) => s + o.total, 0);
  const paymentFees = Math.round(gatewayBase * (pct.paymentGateway || 0) / 100) + codHandling;
  const platformFees = Math.round(netSales * (pct.marketplaceOrPlatform || 0) / 100);
  const returnsProvision = Math.round(netSales * (pct.returnsProvision || 0) / 100);

  const variableCosts = packaging + fulfilment + paymentFees + platformFees + returnsProvision;
  const contribution = grossProfit - variableCosts;

  const units = live.reduce((s, o) => s + o.items.reduce((n, it) => n + it.qty, 0), 0);
  const discounts = live.reduce((s, o) => s + (o.discount || 0), 0);

  /* TDS (194-O) and TCS (GST s.52) are withheld by a MARKETPLACE, not by the
     store's own website. They are also RECOVERABLE — claimed back in the GST and
     income-tax returns — so they are not costs and must never be subtracted from
     profit. Understating profit here would be as wrong as overstating it.
     They are reported separately because they are real cash held by someone else. */
  const marketplaceOrders = live.filter((o) => isMarketplace(o));
  const marketplaceValue = marketplaceOrders.reduce((s, o) => s + o.total, 0);
  const tds = Math.round(marketplaceValue * (f.tdsPercent || 0) / 100);
  const tcs = Math.round(marketplaceValue * (f.tcsPercent || 0) / 100);

  return {
    orderCount: live.length,
    lostCount: lost.length,
    gross, refunds, netSales, gst, shippingCollected, revenue,
    cogs, grossProfit,
    packaging, fulfilment, codHandling, paymentFees, platformFees, returnsProvision,
    variableCosts, contribution,
    units, discounts,
    // Withheld by marketplaces and later claimed back — reported, never deducted.
    marketplaceOrders: marketplaceOrders.length,
    marketplaceValue,
    tds, tcs,
    withheldRecoverable: tds + tcs,
    aov: live.length ? Math.round(netSales / live.length) : 0,
    marginPercent: revenue ? +(grossProfit / revenue * 100).toFixed(1) : 0,
    contributionMarginPercent: revenue ? +(contribution / revenue * 100).toFixed(1) : 0,
    returnRatePercent: list.length ? +(lost.length / list.length * 100).toFixed(1) : 0,
    costPerOrder: live.length ? Math.round(variableCosts / live.length) : 0
  };
}

/**
 * Fixed overheads prorated to the window, itemised — so "profit in hand" is a
 * number you can trace line by line rather than one opaque opex figure.
 */
function fixedCosts(win, config) {
  const monthly = (config.finance && config.finance.monthlyCosts) || {};
  const months = Math.max(0.1, (win.to - win.from) / (30 * DAY));
  const lines = Object.entries(monthly)
    .filter(([k, v]) => k !== '_readme' && Number.isFinite(v))
    .map(([key, value]) => ({ key, monthly: value, amount: Math.round(value * months) }));
  return {
    months: +months.toFixed(2),
    lines,
    total: lines.reduce((s, l) => s + l.amount, 0),
    marketing: Math.round((monthly.marketing || 0) * months)
  };
}

/** Kept for callers that just want the total overhead figure. */
function opexFor(win, config) {
  return fixedCosts(win, config).total;
}

/**
 * The costs that sit BELOW EBITDA, prorated for the window.
 *
 * Kept separate from monthlyCosts because they are not operating costs — mixing
 * loan interest into opex would understate EBITDA, which is the number an
 * investor or a lender compares across businesses.
 */
function belowTheLine(win, config) {
  const f = config.finance || {};
  const months = Math.max(0.1, (win.to - win.from) / (30 * DAY));
  return {
    months: +months.toFixed(2),
    depreciation: Math.round((f.depreciationMonthly || 0) * months),
    interest: Math.round((f.interestMonthly || 0) * months),
    taxPercent: Number.isFinite(f.incomeTaxPercent) ? f.incomeTaxPercent : 0
  };
}

function change(current, previous) {
  if (!previous) return current ? 100 : 0;
  return +(((current - previous) / Math.abs(previous)) * 100).toFixed(1);
}

/** Everything the dashboard needs for one range, plus period-over-period deltas. */
function summary(rangeId, config, now = new Date()) {
  const all = orders.all();
  const win = resolveWindow(rangeId, now);
  const prev = previousWindow(win);

  const current = all.filter((o) => inWindow(o, win));
  const before = all.filter((o) => inWindow(o, prev));

  const t = totals(current, config);
  const p = totals(before, config);

  const fixed = fixedCosts(win, config);
  const prevFixed = fixedCosts({ from: prev.from, to: prev.to }, config);
  const opex = fixed.total;

  /* EBITDA is not what the owner takes home, and calling it that was wrong.
     EBITDA stops before the three things that still take money out:
       depreciation  the machinery/fit-out writing itself off
       interest      the loan EMI's interest half
       income tax    on the profit that remains
     So the ladder continues: EBITDA → EBIT → PBT → profit in hand (PAT).
     All three extra costs default to zero, so a store that has none reports the
     same number as before — but a store with a loan finally sees the truth. */
  const below = belowTheLine(win, config);
  const ebitda = t.contribution - opex;
  const prevEbitda = p.contribution - prevFixed.total;

  const ebit = ebitda - below.depreciation;
  const pbt = ebit - below.interest;
  const incomeTax = pbt > 0 ? Math.round(pbt * below.taxPercent / 100) : 0;
  const profitInHand = pbt - incomeTax;

  return {
    range: win.range,
    from: win.from,
    to: win.to,
    ...t,
    opex,
    fixed,
    marketingSpend: fixed.marketing,
    ebitda,
    ebitdaMarginPercent: t.revenue ? +(ebitda / t.revenue * 100).toFixed(1) : 0,
    // Below EBITDA — each one prorated for the window, like the other fixed costs.
    depreciation: below.depreciation,
    interest: below.interest,
    ebit,
    pbt,
    incomeTax,
    incomeTaxPercent: below.taxPercent,
    profitInHand,
    profitInHandMarginPercent: t.revenue ? +(profitInHand / t.revenue * 100).toFixed(1) : 0,
    // Kept as an alias because "net profit" means PAT to everyone who asks.
    netProfit: profitInHand,
    previous: p,
    deltas: {
      netSales: change(t.netSales, p.netSales),
      orders: change(t.orderCount, p.orderCount),
      aov: change(t.aov, p.aov),
      grossProfit: change(t.grossProfit, p.grossProfit),
      ebitda: change(ebitda, prevEbitda),
      units: change(t.units, p.units),
      refunds: change(t.refunds, p.refunds),
      gst: change(t.gst, p.gst)
    }
  };
}

/**
 * Time series for the trend chart. Buckets by day for short ranges, by month
 * for long ones, and always returns a continuous series (zero-filled).
 */
function series(rangeId, config, now = new Date()) {
  const win = resolveWindow(rangeId, now);
  const list = orders.all().filter((o) => inWindow(o, win));
  const byMonth = !win.range.days || win.range.days > 92;
  const buckets = new Map();

  if (byMonth) {
    const cursor = new Date(Date.UTC(win.from.getUTCFullYear(), win.from.getUTCMonth(), 1));
    while (cursor <= win.to) {
      buckets.set(cursor.toISOString().slice(0, 7), { key: cursor.toISOString().slice(0, 7), label: cursor.toLocaleString('en-IN', { month: 'short' }), netSales: 0, profit: 0, orders: 0 });
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
  } else {
    for (let d = new Date(win.from); d <= win.to; d = new Date(d.getTime() + DAY)) {
      const key = d.toISOString().slice(0, 10);
      buckets.set(key, { key, label: String(d.getUTCDate()), netSales: 0, profit: 0, orders: 0 });
    }
  }

  list.forEach((o) => {
    const key = byMonth ? o.createdAt.slice(0, 7) : o.createdAt.slice(0, 10);
    const b = buckets.get(key);
    if (!b) return;
    if (orders.IS_LOST(o)) return;
    const one = totals([o], config);
    b.netSales += one.netSales;
    b.profit += one.contribution;
    b.orders += 1;
  });

  return [...buckets.values()];
}

/** Best sellers by revenue, with units, margin and current stock. */
function topProducts(rangeId, config, limit = 8, now = new Date()) {
  const win = resolveWindow(rangeId, now);
  const map = new Map();

  orders.all().filter((o) => inWindow(o, win) && !orders.IS_LOST(o)).forEach((o) => {
    o.items.forEach((it) => {
      const row = map.get(it.productId) || { productId: it.productId, name: it.name, slug: it.slug, units: 0, revenue: 0, cost: 0, orders: 0 };
      row.units += it.qty;
      row.revenue += it.price * it.qty;
      row.cost += it.cost * it.qty;
      row.orders += 1;
      map.set(it.productId, row);
    });
  });

  return [...map.values()].map((r) => {
    const product = catalog.byId(r.productId);
    return {
      ...r,
      stock: product ? (product.stock === undefined ? null : product.stock) : null,
      profit: r.revenue - r.cost,
      marginPercent: r.revenue ? +((r.revenue - r.cost) / r.revenue * 100).toFixed(1) : 0
    };
  }).sort((a, b) => b.revenue - a.revenue).slice(0, limit);
}

/** Revenue by category — single-hue bar list on the dashboard. */
function byCategory(rangeId, config, now = new Date()) {
  const win = resolveWindow(rangeId, now);
  const map = new Map();

  orders.all().filter((o) => inWindow(o, win) && !orders.IS_LOST(o)).forEach((o) => {
    o.items.forEach((it) => {
      const product = catalog.byId(it.productId);
      const cats = product ? product.categories : [];
      // Attribute to the product's primary category so totals don't double-count.
      const primary = cats[0] || 'uncategorised';
      const row = map.get(primary) || { category: primary, revenue: 0, units: 0 };
      row.revenue += it.price * it.qty;
      row.units += it.qty;
      map.set(primary, row);
    });
  });

  return [...map.values()].sort((a, b) => b.revenue - a.revenue);
}

/** Orders split by payment method — COD vs prepaid is the number that matters. */
function paymentSplit(rangeId, config, now = new Date()) {
  const win = resolveWindow(rangeId, now);
  const list = orders.all().filter((o) => inWindow(o, win));
  const map = new Map();
  list.forEach((o) => {
    const row = map.get(o.paymentMethod) || { method: o.paymentMethod, count: 0, value: 0 };
    row.count += 1;
    row.value += o.total;
    map.set(o.paymentMethod, row);
  });
  const rows = [...map.values()].sort((a, b) => b.value - a.value);
  const cod = rows.filter((r) => r.method === 'cod').reduce((s, r) => s + r.count, 0);
  return { rows, codShare: list.length ? +(cod / list.length * 100).toFixed(1) : 0, total: list.length };
}

/**
 * Revenue by traffic source — the answer to "did that influencer post pay off?".
 * Sources come from utm_source / ?ref= captured at first visit (see
 * src/attribution.js) and stored on the order.
 *
 * Each row is compared with the same-length window immediately before, so a
 * 5-day view around a campaign shows the lift rather than a bare total.
 */
function byAttribution(rangeId, config, now = new Date()) {
  const win = resolveWindow(rangeId, now);
  const prev = previousWindow(win);
  const all = orders.all();

  const bucket = (list) => {
    const map = new Map();
    list.forEach((o) => {
      const a = o.attribution || {};
      const key = (a.source || o.channel || 'direct').toLowerCase();
      const row = map.get(key) || { source: key, campaign: a.campaign || null, medium: a.medium || null, orders: 0, revenue: 0, units: 0 };
      row.orders += 1;
      row.revenue += o.total;
      row.units += o.items.reduce((s, it) => s + it.qty, 0);
      if (a.campaign && !row.campaign) row.campaign = a.campaign;
      if (a.medium && !row.medium) row.medium = a.medium;
      map.set(key, row);
    });
    return map;
  };

  const nowMap = bucket(all.filter((o) => inWindow(o, win) && !orders.IS_LOST(o)));
  const prevMap = bucket(all.filter((o) => inWindow(o, prev) && !orders.IS_LOST(o)));

  const rows = [...nowMap.values()].map((r) => {
    const before = prevMap.get(r.source) || { orders: 0, revenue: 0 };
    return {
      ...r,
      aov: r.orders ? Math.round(r.revenue / r.orders) : 0,
      previousRevenue: before.revenue,
      previousOrders: before.orders,
      revenueDelta: change(r.revenue, before.revenue),
      orderDelta: change(r.orders, before.orders)
    };
  }).sort((a, b) => b.revenue - a.revenue);

  const total = rows.reduce((s, r) => s + r.revenue, 0);
  return {
    rows: rows.map((r) => ({ ...r, share: total ? +(r.revenue / total * 100).toFixed(1) : 0 })),
    total,
    window: win,
    previousWindow: prev,
    // Sources active now but absent before — usually a campaign that just started.
    newSources: rows.filter((r) => !prevMap.has(r.source)).map((r) => r.source)
  };
}

/**
 * Coupon performance inside the window.
 *
 * Includes what came back: a code that drives sales which are then returned is
 * costing money twice (the discount and the refund), and that only shows up if
 * returns are attributed to the code.
 */
function byDiscount(rangeId, config, now = new Date()) {
  const win = resolveWindow(rangeId, now);
  const map = new Map();

  orders.all().filter((o) => inWindow(o, win) && o.discountCode).forEach((o) => {
    const row = map.get(o.discountCode) || {
      code: o.discountCode, orders: 0, revenue: 0, given: 0,
      returnedOrders: 0, refunded: 0, cancelledOrders: 0
    };

    if (orders.IS_LOST(o)) {
      const back = Number.isFinite(o.refundedAmount) ? o.refundedAmount : o.total;
      row.refunded += back;
      if (o.status === 'returned') row.returnedOrders += 1;
      else row.cancelledOrders += 1;
    } else {
      row.orders += 1;
      row.revenue += o.total;
      row.given += o.discount || 0;
    }

    map.set(o.discountCode, row);
  });

  return [...map.values()].map((r) => {
    const attempted = r.orders + r.returnedOrders + r.cancelledOrders;
    const netRevenue = r.revenue - r.refunded;
    return {
      ...r,
      attempted,
      netRevenue,
      aov: r.orders ? Math.round(r.revenue / r.orders) : 0,
      // Discount handed out as a share of what the code actually grossed.
      costPercent: r.revenue ? +(r.given / (r.revenue + r.given) * 100).toFixed(1) : 0,
      returnRatePercent: attempted ? +((r.returnedOrders + r.cancelledOrders) / attempted * 100).toFixed(1) : 0,
      // Discount + refunds together, against net revenue kept.
      totalCost: r.given + r.refunded,
      keptPercent: (r.revenue + r.refunded) ? +(netRevenue / (r.revenue + r.refunded) * 100).toFixed(1) : 0
    };
  }).sort((a, b) => b.netRevenue - a.netRevenue);
}

/**
 * Coupon vs full-price split — the two order-id families (ORD-… and ORD-C-…)
 * compared side by side, so you can see whether discounting is buying volume or
 * just giving away margin.
 */
function couponSplit(rangeId, config, now = new Date()) {
  const win = resolveWindow(rangeId, now);
  const list = orders.all().filter((o) => inWindow(o, win));
  const withCode = list.filter((o) => orders.isCouponOrder(o));
  const without = list.filter((o) => !orders.isCouponOrder(o));

  const shape = (rows, label) => {
    const t = totals(rows, config);
    return {
      label,
      orders: t.orderCount,
      netSales: t.netSales,
      refunds: t.refunds,
      grossProfit: t.grossProfit,
      contribution: t.contribution,
      aov: t.aov,
      marginPercent: t.marginPercent,
      returnRatePercent: t.returnRatePercent,
      discounts: t.discounts
    };
  };

  return { withCoupon: shape(withCode, 'With a coupon'), fullPrice: shape(without, 'Full price') };
}

function statusSplit(rangeId, now = new Date()) {
  const win = resolveWindow(rangeId, now);
  const list = orders.all().filter((o) => inWindow(o, win));
  const map = new Map();
  list.forEach((o) => map.set(o.status, (map.get(o.status) || 0) + 1));
  return orders.STATUSES.map((s) => ({ ...s, count: map.get(s.id) || 0 })).filter((s) => s.count);
}

/** Products at or below the configured low-stock threshold. */
function lowStock(config) {
  const threshold = (config.inventory && config.inventory.lowStockThreshold) || 4;
  return catalog.all()
    .filter((p) => p.stock !== undefined && p.stock !== null && p.stock <= threshold)
    .map((p) => ({ ...p, outOfStock: p.stock <= 0 }))
    .sort((a, b) => a.stock - b.stock);
}

/**
 * The restock list at the level a shop actually reorders: the SIZE.
 *
 * lowStock() above looks at the whole piece, which hides the case that costs the
 * most sales — 60 pieces in stock but nothing left in M, the size half the
 * customers want. A total is a comfortable number to read and the wrong number to
 * buy against.
 *
 * Pieces that don't count sizes separately still appear, as a single row, so the
 * list is the whole shop and not just the tracked half.
 */
function lowStockVariants(config) {
  const variants = require('./variants');
  const threshold = (config.inventory && config.inventory.lowStockThreshold) || 4;
  const out = [];

  catalog.all().forEach((p) => {
    if (variants.tracksVariants(p)) {
      variants.lowVariants(p, threshold).forEach((v) => {
        out.push({
          productId: p.id, name: p.name, price: p.price,
          label: variants.label(v), stock: v.stock, outOfStock: v.stock <= 0,
          tracked: true
        });
      });
      return;
    }

    if (p.stock === undefined || p.stock === null || p.stock > threshold) return;
    out.push({
      productId: p.id, name: p.name, price: p.price,
      label: 'All sizes', stock: p.stock, outOfStock: p.stock <= 0,
      tracked: false
    });
  });

  // Out first, then closest to running out: the order you would place the order in.
  return out.sort((x, y) => x.stock - y.stock || x.name.localeCompare(y.name));
}

/** Sold in the window but never restocked — the "losing money" list. */
function deadStock(rangeId, config, now = new Date()) {
  const sold = new Set(topProducts(rangeId, config, 999, now).map((r) => r.productId));
  return catalog.all().filter((p) => !sold.has(p.id)).sort((a, b) => b.price - a.price);
}

function customers(rangeId, now = new Date()) {
  const win = resolveWindow(rangeId, now);
  const map = new Map();
  orders.all().filter((o) => inWindow(o, win)).forEach((o) => {
    const key = o.customer.email.toLowerCase();
    const row = map.get(key) || { email: key, name: o.customer.name, phone: o.customer.phone, city: o.address.city, orders: 0, spend: 0, first: o.createdAt, last: o.createdAt };
    row.orders += 1;
    if (!orders.IS_LOST(o)) row.spend += o.total;
    if (o.createdAt < row.first) row.first = o.createdAt;
    if (o.createdAt > row.last) row.last = o.createdAt;
    map.set(key, row);
  });
  const rows = [...map.values()].sort((a, b) => b.spend - a.spend);
  const repeat = rows.filter((r) => r.orders > 1).length;
  return {
    rows,
    count: rows.length,
    repeatCount: repeat,
    repeatRatePercent: rows.length ? +(repeat / rows.length * 100).toFixed(1) : 0,
    ltv: rows.length ? Math.round(rows.reduce((s, r) => s + r.spend, 0) / rows.length) : 0
  };
}

module.exports = {
  isMarketplace,
  belowTheLine,
  RANGES, resolveRange, windowFor, resolveWindow, summary, series, totals,
  topProducts, byCategory, paymentSplit, statusSplit, lowStock, lowStockVariants, deadStock, customers,
  byAttribution, byDiscount, couponSplit, fixedCosts
};
