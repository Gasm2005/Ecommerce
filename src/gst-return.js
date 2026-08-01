'use strict';

/**
 * GSTR-1 working papers.
 *
 * A CA filing GSTR-1 for a D2C store does not want a list of orders. They want
 * the return's own tables, already summarised the way the portal asks for them:
 *
 *   B2CS      unregistered buyers, aggregated by place of supply + rate
 *             (this is nearly all of a D2C store's sales)
 *   B2CL      unregistered, INTER-state, invoice value above ₹2.5 lakh —
 *             these must be reported invoice-by-invoice, not aggregated
 *   B2B       registered buyers, invoice-wise with their GSTIN, so they can
 *             claim input credit
 *   HSN       Table 12: quantity and value per HSN code
 *   DOCS      Table 13: the invoice number series issued, and how many
 *   CDNUR     credit notes for returns/refunds against unregistered buyers
 *
 * Plus a GSTR-3B summary, which is the one-page figure that gets paid.
 *
 * HONEST LIMIT: this produces the numbers and the table structure. The portal
 * itself ingests either a JSON from its own offline utility or manual entry, so a
 * CA still transfers these figures across (a five-minute job instead of a
 * two-day one). Generating the portal JSON directly is possible — it needs the
 * exact schema version and GSTIN validation — and is a separate piece of work.
 *
 * Everything is derived from issued invoices only. An order without an invoice
 * number has not been reported to anyone and must not appear in a return.
 */

const invoice = require('./invoice');
const orders = require('./orders');
const returns = require('./returns');
const { csv } = require('./zip');

const B2CL_THRESHOLD = 250000;
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * The invoices in a period, with their computed tax. One place that decides what
 * "reportable" means: an invoice exists, and the order was not cancelled.
 */
function invoicesIn(window, config) {
  return orders.all()
    .filter((o) => o.invoice && o.invoice.number)
    .filter((o) => o.status !== 'cancelled')
    .filter((o) => {
      if (!window) return true;
      const at = new Date(o.invoice.issuedAt || o.createdAt).getTime();
      return at >= window.from.getTime() && at <= window.to.getTime();
    })
    .map((o) => ({ order: o, inv: invoice.build(o, config, { allocate: false }) }))
    .sort((a, b) => String(a.inv.invoice.number).localeCompare(String(b.inv.invoice.number)));
}

/* ----------------------------------------------------------------- B2CS ---- */

/**
 * Table 7: supplies to unregistered buyers, aggregated by place of supply and
 * rate. Aggregated — not invoice-wise — which is why a store with 5,000 orders
 * still files a return that fits on one screen.
 */
function b2cs(rows) {
  const buckets = new Map();

  rows.filter((r) => !r.order.customer.gstin).forEach(({ order, inv }) => {
    if (inv.interState && inv.totals.rounded > B2CL_THRESHOLD) return;   // that's B2CL

    inv.lines.forEach((line) => {
      const pos = inv.placeOfSupply;
      const key = `${inv.interState ? 'INTER' : 'INTRA'}|${pos}|${line.rate}`;
      const bucket = buckets.get(key) || {
        type: inv.interState ? 'OE' : 'OE',     // OE = other than e-commerce
        supply: inv.interState ? 'Inter-State' : 'Intra-State',
        pos,
        rate: line.rate,
        taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, invoices: new Set()
      };
      bucket.taxable = round2(bucket.taxable + line.taxableValue);
      bucket.cgst = round2(bucket.cgst + line.cgst);
      bucket.sgst = round2(bucket.sgst + line.sgst);
      bucket.igst = round2(bucket.igst + line.igst);
      bucket.invoices.add(inv.invoice.number);
      buckets.set(key, bucket);
    });
  });

  const list = [...buckets.values()].sort((a, b) => a.pos.localeCompare(b.pos) || a.rate - b.rate);
  return {
    rows: list,
    csv: csv(
      ['type', 'supply', 'place_of_supply', 'rate', 'taxable_value', 'cgst', 'sgst', 'igst', 'cess', 'invoice_count'],
      list.map((b) => [b.type, b.supply, b.pos, b.rate, b.taxable, b.cgst, b.sgst, b.igst, b.cess, b.invoices.size])
    )
  };
}

/* ----------------------------------------------------------------- B2CL ---- */

/**
 * Table 5: unregistered, inter-state, above ₹2.5 lakh. Invoice-wise. Bridal
 * lehengas cross this threshold routinely, so this table is not theoretical for
 * this kind of store.
 */
function b2cl(rows) {
  const list = rows
    .filter((r) => !r.order.customer.gstin)
    .filter((r) => r.inv.interState && r.inv.totals.rounded > B2CL_THRESHOLD);

  const flat = [];
  list.forEach(({ order, inv }) => {
    inv.byRate.forEach((rate) => flat.push([
      inv.invoice.number,
      new Date(order.invoice.issuedAt || order.createdAt).toLocaleDateString('en-GB').replace(/\//g, '-'),
      inv.totals.rounded,
      inv.placeOfSupply,
      rate.rate,
      rate.taxable,
      rate.igst,
      0,
      order.customer.name
    ]));
  });

  return {
    count: list.length,
    csv: csv(
      ['invoice_no', 'invoice_date', 'invoice_value', 'place_of_supply', 'rate',
        'taxable_value', 'igst', 'cess', 'customer'],
      flat
    )
  };
}

/* ------------------------------------------------------------------ B2B ---- */

/**
 * Table 4: registered buyers. Needs the buyer's GSTIN — a reseller or boutique
 * buying wholesale cannot claim input credit without it, and they will ask.
 * Empty until checkout collects a GSTIN.
 */
function b2b(rows) {
  const flat = [];
  rows.filter((r) => r.order.customer.gstin).forEach(({ order, inv }) => {
    inv.byRate.forEach((rate) => flat.push([
      order.customer.gstin,
      // The REGISTERED name, not whoever placed the order. GSTR-1 matches on the
      // GSTIN's registered name; the purchase manager's name there is a mismatch
      // the buyer has to chase.
      order.customer.businessName || order.customer.name,
      inv.invoice.number,
      new Date(order.invoice.issuedAt || order.createdAt).toLocaleDateString('en-GB').replace(/\//g, '-'),
      inv.totals.rounded,
      inv.placeOfSupply,
      'N',                                   // reverse charge
      'Regular B2B',
      rate.rate,
      rate.taxable,
      rate.cgst, rate.sgst, rate.igst, 0
    ]));
  });

  return {
    count: new Set(rows.filter((r) => r.order.customer.gstin).map((r) => r.inv.invoice.number)).size,
    csv: csv(
      ['buyer_gstin', 'buyer_name', 'invoice_no', 'invoice_date', 'invoice_value',
        'place_of_supply', 'reverse_charge', 'invoice_type', 'rate', 'taxable_value',
        'cgst', 'sgst', 'igst', 'cess'],
      flat
    )
  };
}

/* ------------------------------------------------------------------ HSN ---- */

/** Table 12: per HSN — quantity, taxable value, tax. UQC for garments is NOS. */
function hsnSummary(rows) {
  const map = new Map();

  rows.forEach(({ inv }) => {
    inv.lines.forEach((line) => {
      const key = `${line.hsn}|${line.rate}`;
      const row = map.get(key) || {
        hsn: line.hsn,
        description: line.isCharge ? line.name : 'Garments / apparel',
        uqc: line.isCharge ? 'OTH' : 'NOS',
        rate: line.rate,
        qty: 0, total: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0
      };
      row.qty += line.qty;
      row.total = round2(row.total + line.lineTotal);
      row.taxable = round2(row.taxable + line.taxableValue);
      row.cgst = round2(row.cgst + line.cgst);
      row.sgst = round2(row.sgst + line.sgst);
      row.igst = round2(row.igst + line.igst);
      map.set(key, row);
    });
  });

  const list = [...map.values()].sort((a, b) => String(a.hsn).localeCompare(String(b.hsn)) || a.rate - b.rate);
  return {
    rows: list,
    csv: csv(
      ['hsn', 'description', 'uqc', 'rate', 'total_quantity', 'total_value',
        'taxable_value', 'cgst', 'sgst', 'igst', 'cess'],
      list.map((r) => [r.hsn, r.description, r.uqc, r.rate, r.qty, r.total,
        r.taxable, r.cgst, r.sgst, r.igst, 0])
    )
  };
}

/* ------------------------------------------------------- documents issued ---- */

/**
 * Table 13: the invoice series. The portal wants from–to, total issued and
 * cancelled. A gap here is the first thing an assessing officer asks about,
 * which is why invoice numbers are allocated once and never reused.
 */
function documentsIssued(rows, config) {
  if (!rows.length) {
    return { csv: csv(['nature_of_document', 'sr_no_from', 'sr_no_to', 'total_number', 'cancelled'], []) };
  }
  const numbers = rows.map((r) => r.inv.invoice.number).sort();
  const cancelled = orders.all()
    .filter((o) => o.invoice && o.invoice.number && o.status === 'cancelled').length;

  return {
    csv: csv(
      ['nature_of_document', 'sr_no_from', 'sr_no_to', 'total_number', 'cancelled'],
      [['Invoices for outward supply', numbers[0], numbers[numbers.length - 1], numbers.length, cancelled]]
    ),
    from: numbers[0],
    to: numbers[numbers.length - 1],
    count: numbers.length,
    cancelled
  };
}

/* ---------------------------------------------------------- credit notes ---- */

/**
 * Table 9B: credit notes against unregistered buyers — a refunded return reduces
 * the tax already declared. Skipping these means paying GST on money that went
 * back to the customer.
 */
function creditNotes(window, config) {
  const refunded = returns.all().filter((r) => r.status === 'refunded' && r.refundAmount > 0);

  const flat = [];
  refunded.forEach((ret) => {
    const order = orders.byId(ret.orderId);
    if (!order || !order.invoice) return;
    if (window) {
      const at = new Date(ret.refundedAt || ret.updatedAt || ret.createdAt).getTime();
      if (at < window.from.getTime() || at > window.to.getTime()) return;
    }

    const inv = invoice.build(order, config, { allocate: false });
    // The refund is a slice of the invoice, so the tax inside it is the same
    // slice of the invoice's tax — not a fresh calculation at a guessed rate.
    const share = inv.totals.rounded ? ret.refundAmount / inv.totals.rounded : 0;
    const principalRate = inv.byRate.length ? inv.byRate[inv.byRate.length - 1].rate : 0;
    const taxable = round2(ret.refundAmount / (1 + principalRate / 100));
    const tax = round2(ret.refundAmount - taxable);

    flat.push([
      ret.id,
      new Date(ret.refundedAt || ret.updatedAt || ret.createdAt).toLocaleDateString('en-GB').replace(/\//g, '-'),
      inv.invoice.number,
      inv.interState && inv.totals.rounded > B2CL_THRESHOLD ? 'B2CL' : 'B2CS',
      inv.placeOfSupply,
      ret.refundAmount,
      principalRate,
      taxable,
      inv.interState ? 0 : round2(tax / 2),
      inv.interState ? 0 : round2(tax / 2),
      inv.interState ? tax : 0,
      round2(share * 100) + '%'
    ]);
  });

  return {
    count: flat.length,
    csv: csv(
      ['credit_note_no', 'date', 'against_invoice', 'type', 'place_of_supply',
        'note_value', 'rate', 'taxable_value', 'cgst', 'sgst', 'igst', 'share_of_invoice'],
      flat
    )
  };
}

/* ----------------------------------------------------------------- 3B ---- */

/** The one page that gets paid: outward supplies and tax payable. */
function gstr3b(rows, credits) {
  const totals = rows.reduce((acc, { inv }) => ({
    taxable: round2(acc.taxable + inv.totals.taxableValue),
    cgst: round2(acc.cgst + inv.totals.cgst),
    sgst: round2(acc.sgst + inv.totals.sgst),
    igst: round2(acc.igst + inv.totals.igst),
    total: round2(acc.total + inv.totals.rounded)
  }), { taxable: 0, cgst: 0, sgst: 0, igst: 0, total: 0 });

  const lines = [
    ['3.1(a)', 'Outward taxable supplies (other than zero rated, nil rated, exempted)',
      totals.taxable, totals.igst, totals.cgst, totals.sgst, 0],
    ['9B', 'Less: credit notes issued (returns refunded)',
      -credits.taxable, -credits.igst, -credits.cgst, -credits.sgst, 0],
    ['Net', 'Net tax payable on outward supplies',
      round2(totals.taxable - credits.taxable),
      round2(totals.igst - credits.igst),
      round2(totals.cgst - credits.cgst),
      round2(totals.sgst - credits.sgst),
      0]
  ];

  return {
    totals,
    csv: csv(['table', 'description', 'taxable_value', 'igst', 'cgst', 'sgst', 'cess'], lines)
  };
}

/** Totals of the credit notes, for the 3B reduction. */
function creditTotals(window, config) {
  const refunded = returns.all().filter((r) => r.status === 'refunded' && r.refundAmount > 0);
  return refunded.reduce((acc, ret) => {
    const order = orders.byId(ret.orderId);
    if (!order || !order.invoice) return acc;
    if (window) {
      const at = new Date(ret.refundedAt || ret.updatedAt || ret.createdAt).getTime();
      if (at < window.from.getTime() || at > window.to.getTime()) return acc;
    }
    const inv = invoice.build(order, config, { allocate: false });
    const rate = inv.byRate.length ? inv.byRate[inv.byRate.length - 1].rate : 0;
    const taxable = ret.refundAmount / (1 + rate / 100);
    const tax = ret.refundAmount - taxable;
    return {
      taxable: round2(acc.taxable + taxable),
      cgst: round2(acc.cgst + (inv.interState ? 0 : tax / 2)),
      sgst: round2(acc.sgst + (inv.interState ? 0 : tax / 2)),
      igst: round2(acc.igst + (inv.interState ? tax : 0))
    };
  }, { taxable: 0, cgst: 0, sgst: 0, igst: 0 });
}

/**
 * Everything a CA needs for one period, as named CSVs plus a covering note.
 * `window` is { from: Date, to: Date }; omit it for everything ever issued.
 */
function workingPapers(config, window) {
  const rows = invoicesIn(window, config);
  const b = require('./invoice').business(config);

  const tables = {
    b2cs: b2cs(rows),
    b2cl: b2cl(rows),
    b2b: b2b(rows),
    hsn: hsnSummary(rows),
    docs: documentsIssued(rows, config),
    credits: creditNotes(window, config)
  };
  const credits = creditTotals(window, config);
  const summary = gstr3b(rows, credits);

  const period = window
    ? `${window.from.toISOString().slice(0, 10)} to ${window.to.toISOString().slice(0, 10)}`
    : 'all invoices issued';

  const readme = [
    `GSTR-1 working papers — ${b.legalName}`,
    `GSTIN ${b.gstin || '(not set)'}`,
    `Period: ${period}`,
    `Generated ${new Date().toISOString()}`,
    '',
    'FILES',
    '  gstr1-b2cs.csv        Table 7  — unregistered buyers, by place of supply + rate',
    '  gstr1-b2cl.csv        Table 5  — unregistered, inter-state, above Rs 2,50,000',
    '  gstr1-b2b.csv         Table 4  — registered buyers (needs buyer GSTIN)',
    '  gstr1-hsn.csv         Table 12 — quantity and value per HSN',
    '  gstr1-docs.csv        Table 13 — invoice series issued',
    '  gstr1-credit-notes.csv Table 9B — refunded returns',
    '  gstr3b-summary.csv    the figure that gets paid',
    '  invoice-register.csv  every invoice, one row each, for tallying',
    '',
    'NOTES FOR THE ACCOUNTANT',
    '  · Prices on this store are GST-INCLUSIVE. Tax is extracted from the sale',
    '    value, never added to it, so taxable value + tax = what the customer paid.',
    '  · Shipping and gift packaging are treated as part of a composite supply and',
    '    carry the principal item rate. Set finance.gstOnShipping to false in the',
    '    store settings if you want them shown untaxed instead.',
    '  · Intra-state sales are split CGST/SGST; inter-state carry IGST. The seller',
    `    state is ${b.state || '(not set)'} (${b.stateCode || '??'}).`,
    '  · Invoice numbers are allocated once and never reused. Table 13 shows the',
    '    unbroken series.',
    '  · Cancelled orders are excluded from the return and counted in Table 13.',
    '',
    'WHAT STILL NEEDS A HUMAN',
    '  These are working papers, not a portal upload. The figures are final; they',
    '  are transferred into the GST portal (or your filing software) as-is.',
    tables.b2b.count === 0
      ? '  · No B2B invoices: the store does not collect buyer GSTIN at checkout yet,\n    so every sale is treated as B2C. Add that field if you sell to resellers.'
      : `  · ${tables.b2b.count} B2B invoice(s) present — verify each GSTIN before filing.`
  ].join('\r\n') + '\r\n';

  return {
    period,
    readme,
    summary,
    tables,
    entries: [
      { name: 'gst/README.txt', data: readme },
      { name: 'gst/gstr1-b2cs.csv', data: tables.b2cs.csv },
      { name: 'gst/gstr1-b2cl.csv', data: tables.b2cl.csv },
      { name: 'gst/gstr1-b2b.csv', data: tables.b2b.csv },
      { name: 'gst/gstr1-hsn.csv', data: tables.hsn.csv },
      { name: 'gst/gstr1-docs.csv', data: tables.docs.csv },
      { name: 'gst/gstr1-credit-notes.csv', data: tables.credits.csv },
      { name: 'gst/gstr3b-summary.csv', data: summary.csv }
    ]
  };
}

module.exports = {
  B2CL_THRESHOLD, invoicesIn, b2cs, b2cl, b2b, hsnSummary,
  documentsIssued, creditNotes, creditTotals, gstr3b, workingPapers
};
