'use strict';

/**
 * GST working papers.
 *
 * The check an accountant does first is reconciliation: the return's tables must
 * add back to the figure being paid. If B2CS + B2CL does not equal 3B, or the HSN
 * summary disagrees with either, the return is wrong and the store is either
 * overpaying or heading for a notice. Everything here defends that.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sandbox, cartLine, summaryOf } = require('./helpers/sandbox');

const { config, products } = sandbox();
const cart = require('../src/cart');
const orders = require('../src/orders');
const invoice = require('../src/invoice');
const gst = require('../src/gst-return');

const lehenga = products.find((p) => p.id === 'p001');
const saree = products.find((p) => p.id === 'p002');

function place({ state = {}, lines, extras = {} } = {}) {
  const summary = cart.withCheckoutExtras(summaryOf(lines || [cartLine(lehenga)], extras), state, config);
  const order = orders.create({
    cartSummary: summary,
    state: {
      fullName: 'Test Buyer', phone: '9820000000', email: 'b@test.example',
      address1: '1 Road', city: 'Mumbai', state: 'Maharashtra', pincode: '400001',
      ...state
    },
    config, attribution: null, codPlan: null, payment: null
  });
  invoice.allocateNumber(order, config);
  return orders.byId(order.id);
}

/** Sums a numeric column out of one of the generated CSVs. */
function column(csvText, header) {
  const lines = csvText.replace(/^﻿/, '').trim().split('\r\n');
  const cols = lines[0].split(',');
  const idx = cols.indexOf(header);
  assert.ok(idx >= 0, `column "${header}" missing from: ${lines[0]}`);
  return lines.slice(1).reduce((sum, line) => sum + (Number(line.split(',')[idx]) || 0), 0);
}

const near = (a, b, msg) => assert.ok(Math.abs(a - b) <= 1, `${msg} (${a} vs ${b})`);

test('the tables reconcile to the 3B figure — the check a CA does first', () => {
  place();
  place({ state: { state: 'Karnataka' } });
  place({ lines: [cartLine(saree, 2, 'Free', 'Ivory')] });
  place({ state: { deliveryMethod: 'express' } });

  const papers = gst.workingPapers(config);
  const b2cs = column(papers.tables.b2cs.csv, 'taxable_value');
  const b2cl = column(papers.tables.b2cl.csv, 'taxable_value');
  const hsn = column(papers.tables.hsn.csv, 'taxable_value');

  near(b2cs + b2cl, papers.summary.totals.taxable, 'B2CS + B2CL must equal 3B taxable');
  near(hsn, papers.summary.totals.taxable, 'the HSN summary must equal 3B taxable');
});

test('tax reported equals tax collected', () => {
  const papers = gst.workingPapers(config);
  const t = papers.summary.totals;
  const reported = ['cgst', 'sgst', 'igst'].reduce((s, c) => s + column(papers.tables.b2cs.csv, c), 0)
    + column(papers.tables.b2cl.csv, 'igst');
  near(reported, t.cgst + t.sgst + t.igst, 'reported tax must match collected tax');
});

test('an intra-state row never carries IGST, and vice versa', () => {
  const papers = gst.workingPapers(config);
  papers.tables.b2cs.csv.replace(/^﻿/, '').trim().split('\r\n').slice(1).forEach((line) => {
    const p = line.split(',');
    if (p[1] === 'Intra-State') assert.equal(Number(p[7]) || 0, 0, 'intra-state row carries IGST: ' + line);
    if (p[1] === 'Inter-State') assert.equal(Number(p[5]) || 0, 0, 'inter-state row carries CGST: ' + line);
  });
});

test('a large inter-state sale is reported invoice-wise, and only once', () => {
  place({ lines: [cartLine({ ...lehenga, price: 300000 })], state: { state: 'Tamil Nadu' } });
  const papers = gst.workingPapers(config);

  assert.match(papers.tables.b2cl.csv, /Tamil Nadu/, 'missing from B2CL');
  assert.doesNotMatch(papers.tables.b2cs.csv, /Tamil Nadu/,
    'a B2CL invoice must not be aggregated into B2CS as well — that double-counts it');
});

test('a large INTRA-state sale stays in B2CS: the threshold is inter-state only', () => {
  place({ lines: [cartLine({ ...lehenga, price: 400000 })], state: { state: 'Maharashtra' } });
  assert.match(gst.workingPapers(config).tables.b2cs.csv, /Maharashtra/);
});

test('the HSN summary uses the right unit of measure per kind of line', () => {
  const papers = gst.workingPapers(config);
  assert.match(papers.tables.hsn.csv, /6211,Garments \/ apparel,NOS/);
  if (/996819/.test(papers.tables.hsn.csv)) {
    assert.match(papers.tables.hsn.csv, /996819,[^,]*,OTH/, 'a delivery charge is not measured in pieces');
  }
});

test('the invoice series is reported unbroken', () => {
  const papers = gst.workingPapers(config);
  assert.ok(papers.tables.docs.count > 0);
  assert.ok(papers.tables.docs.from <= papers.tables.docs.to, 'series must run low to high');
  assert.match(papers.tables.docs.csv, /Invoices for outward supply/);
});

test('a cancelled order drops out of the return', () => {
  const order = place();
  const before = gst.workingPapers(config).summary.totals.taxable;
  orders.setStatus(order.id, 'cancelled');
  assert.ok(gst.workingPapers(config).summary.totals.taxable < before,
    'cancelling must reduce the reported supplies');
});

test('an order with no invoice number is never reported', () => {
  const summary = cart.withCheckoutExtras(summaryOf([cartLine(lehenga)]), {}, config);
  const raw = orders.create({
    cartSummary: summary,
    state: { fullName: 'No Invoice Person', phone: '9820000001', address1: 'x', city: 'Mumbai', state: 'Maharashtra', pincode: '400001' },
    config, attribution: null, codPlan: null, payment: null
  });
  assert.equal(raw.invoice, undefined, 'no invoice should have been issued');

  const papers = gst.workingPapers(config);
  assert.doesNotMatch(papers.tables.b2cl.csv, /No Invoice Person/);
});

test('B2B stays empty until a buyer GSTIN is collected, and the note says so', () => {
  const papers = gst.workingPapers(config);
  assert.equal(papers.tables.b2b.count, 0);
  assert.match(papers.readme, /does not collect buyer GSTIN/i);
});

test('a refunded return becomes a credit note that lowers the tax payable', () => {
  const order = place();
  const returns = require('../src/returns');
  const ret = returns.create({ order, itemKeys: ['0'], reason: 'size', method: 'refund' });
  returns.setStatus(ret.id, 'approved');
  returns.setStatus(ret.id, 'received');
  returns.setStatus(ret.id, 'refunded', { amount: 4000 });

  const credits = gst.creditTotals(null, config);
  assert.ok(credits.taxable > 0, 'a refund must produce a credit note');

  const papers = gst.workingPapers(config);
  assert.match(papers.summary.csv, /credit notes/i);
  const netRow = papers.summary.csv.replace(/^﻿/, '').trim().split('\r\n').pop().split(',');
  assert.ok(Number(netRow[2]) < papers.summary.totals.taxable,
    'net taxable must fall once a credit note exists');
});

test('the covering note states every assumption the numbers rest on', () => {
  const readme = gst.workingPapers(config).readme;
  assert.match(readme, /GST-INCLUSIVE/);
  assert.match(readme, /composite supply/i);
  assert.match(readme, /never reused/i);
  assert.match(readme, /\(27\)/, 'the seller state code must be stated');
});
