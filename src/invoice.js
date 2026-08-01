'use strict';

/**
 * GST tax invoices (India).
 *
 * The rules that shape this file:
 *  · Prices in this store are GST-INCLUSIVE, so tax is extracted from the line
 *    total, never added on top: taxable = total / (1 + rate).
 *  · Same state as the seller → CGST + SGST, each half the rate.
 *    Different state → IGST at the full rate. Never both.
 *  · One invoice number series, strictly sequential, never reused — a gap in the
 *    series is what an auditor asks about, so numbers are allocated once and
 *    stored on the order.
 *  · Every line needs an HSN code, a taxable value and its own rate; totals are
 *    grouped by rate for the tax summary.
 *
 * Nothing here invents a number that isn't derived from the order.
 */

const store = require('./store');
const orders = require('./orders');
const catalog = require('./catalog');
const pricing = require('./pricing');

/** Indian state → GST state code, for the place-of-supply line. */
const STATE_CODES = {
  'andaman and nicobar islands': '35', 'andhra pradesh': '37', 'arunachal pradesh': '12',
  assam: '18', bihar: '10', chandigarh: '04', chhattisgarh: '22',
  'dadra and nagar haveli and daman and diu': '26', delhi: '07', goa: '30', gujarat: '24',
  haryana: '06', 'himachal pradesh': '02', 'jammu and kashmir': '01', jharkhand: '20',
  karnataka: '29', kerala: '32', ladakh: '38', lakshadweep: '31', 'madhya pradesh': '23',
  maharashtra: '27', manipur: '14', meghalaya: '17', mizoram: '15', nagaland: '13',
  odisha: '21', puducherry: '34', punjab: '03', rajasthan: '08', sikkim: '11',
  'tamil nadu': '33', telangana: '36', tripura: '16', 'uttar pradesh': '09',
  uttarakhand: '05', 'west bengal': '19',
  // Common informal spellings customers actually type.
  mh: '27', dl: '07', ka: '29', tn: '33', up: '09', wb: '19', gj: '24', rj: '08',
  ts: '36', kl: '32', pb: '03', hr: '06', mp: '23', br: '10', or: '21', as: '18'
};

function stateCode(name) {
  const key = String(name || '').trim().toLowerCase();
  return STATE_CODES[key] || null;
}

function business(config) {
  const b = config.business || {};
  return {
    legalName: b.legalName || config.brand.name,
    tradeName: b.tradeName || config.brand.name,
    gstin: b.gstin || '',
    pan: b.pan || '',
    addressLines: b.addressLines || [],
    state: b.state || '',
    stateCode: b.stateCode || stateCode(b.state) || '',
    phone: b.phone || config.brand.supportPhone,
    email: b.email || config.brand.supportEmail,
    invoicePrefix: b.invoicePrefix || 'INV',
    financialYear: b.financialYear || financialYearFor(new Date()),
    signatureName: b.signatureName || b.legalName || config.brand.name,
    defaultHsn: b.defaultHsn || '6211',
    bank: b.bank || null,
    termsLines: b.termsLines || []
  };
}

/** Indian FY runs April→March, and invoice series usually reset with it. */
function financialYearFor(date) {
  const d = new Date(date);
  const y = d.getUTCFullYear();
  const startYear = d.getUTCMonth() >= 3 ? y : y - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/* ------------------------------------------------------- numbering ---- */

/**
 * Allocates the next number in the series and remembers it on the order, so
 * viewing an invoice twice never produces two numbers.
 */
function allocateNumber(order, config) {
  if (order.invoice && order.invoice.number) return order.invoice;

  const b = business(config);
  const fy = financialYearFor(order.createdAt);
  const counters = store.read('invoice-counters', {});
  const key = `${b.invoicePrefix}/${fy}`;
  const next = (counters[key] || 0) + 1;

  const invoice = {
    number: `${b.invoicePrefix}/${fy}/${String(next).padStart(4, '0')}`,
    sequence: next,
    financialYear: fy,
    issuedAt: new Date().toISOString()
  };

  store.write('invoice-counters', { ...counters, [key]: next }, { skipBackup: true });
  orders.attachInvoice(order.id, invoice);
  return invoice;
}

/* ----------------------------------------------------------- build ---- */

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Builds every number an invoice prints. Discounts are applied pro-rata across
 * lines before tax so the sum of line taxable values always equals the invoice
 * taxable value — auditors do check that.
 */
function build(order, config, { allocate = true } = {}) {
  const b = business(config);
  const invoice = allocate ? allocateNumber(order, config) : (order.invoice || { number: 'DRAFT', issuedAt: new Date().toISOString() });

  const buyerState = order.address.state || '';
  const buyerCode = stateCode(buyerState);
  // No seller state configured → assume intra-state rather than silently
  // charging IGST, and flag it so the admin fixes the setting.
  const interState = !!(b.stateCode && buyerCode && b.stateCode !== buyerCode);

  const discountRatio = order.subtotal
    ? (order.subtotal - (order.discount || 0)) / order.subtotal
    : 1;

  const lines = order.items.map((it, i) => {
    const product = catalog.byId(it.productId);
    const rate = Number.isFinite(it.gstPercent)
      ? it.gstPercent
      : pricing.gstPercent(product || { price: it.price }, config);

    const grossInclusive = it.price * it.qty * discountRatio;
    const taxable = grossInclusive / (1 + rate / 100);
    const tax = grossInclusive - taxable;

    return {
      sr: i + 1,
      name: it.name,
      hsn: (product && product.hsn) || b.defaultHsn,
      size: it.size,
      color: it.color,
      qty: it.qty,
      unitInclusive: round2(it.price * discountRatio),
      grossInclusive: round2(grossInclusive),
      taxableValue: round2(taxable),
      rate,
      cgst: interState ? 0 : round2(tax / 2),
      sgst: interState ? 0 : round2(tax / 2),
      igst: interState ? round2(tax) : 0,
      totalTax: round2(tax),
      lineTotal: round2(grossInclusive)
    };
  });

  /* Shipping and gift wrap are part of the same composite supply, so they belong
     on the invoice as taxable lines at the principal (highest) item rate — not as
     an untaxed afterthought at the bottom. The amounts are inclusive either way,
     so the customer's total never changes because of this. */
  const taxCharges = (config.finance || {}).gstOnShipping !== false;
  const principalRate = lines.reduce((max, l) => Math.max(max, l.rate), 0);
  const charge = (label, sac, amountInclusive) => {
    const rate = taxCharges ? principalRate : 0;
    const taxable = amountInclusive / (1 + rate / 100);
    const tax = amountInclusive - taxable;
    return {
      sr: lines.length + 1,
      name: label,
      hsn: sac,
      size: '', color: '', qty: 1,
      unitInclusive: round2(amountInclusive),
      grossInclusive: round2(amountInclusive),
      taxableValue: round2(taxable),
      rate,
      cgst: interState ? 0 : round2(tax / 2),
      sgst: interState ? 0 : round2(tax / 2),
      igst: interState ? round2(tax) : 0,
      totalTax: round2(tax),
      lineTotal: round2(amountInclusive),
      isCharge: true
    };
  };

  // SAC 996819 = courier / delivery services; 998912 = packaging services.
  if (order.shipping > 0) {
    lines.push(charge(order.deliveryTitle ? order.deliveryTitle + ' delivery' : 'Delivery charges', '996819', order.shipping));
  }
  if (order.giftWrapCharge > 0) {
    lines.push(charge('Gift packaging', '998912', order.giftWrapCharge));
  }

  const sum = (key) => round2(lines.reduce((s, l) => s + l[key], 0));

  // Tax summary grouped by rate — the part a CA actually reads.
  const byRate = [];
  lines.forEach((l) => {
    let row = byRate.find((r) => r.rate === l.rate);
    if (!row) {
      row = { rate: l.rate, taxable: 0, cgst: 0, sgst: 0, igst: 0, total: 0 };
      byRate.push(row);
    }
    row.taxable = round2(row.taxable + l.taxableValue);
    row.cgst = round2(row.cgst + l.cgst);
    row.sgst = round2(row.sgst + l.sgst);
    row.igst = round2(row.igst + l.igst);
    row.total = round2(row.total + l.totalTax);
  });
  byRate.sort((a, b2) => a.rate - b2.rate);

  const taxableValue = sum('taxableValue');
  const totalTax = sum('totalTax');
  // Shipping and gift wrap are lines now, so they are already inside the sums —
  // adding them again here is how an invoice quietly overcharges.
  const grandTotal = round2(taxableValue + totalTax);
  const rounded = Math.round(grandTotal);

  return {
    invoice,
    business: b,
    order,
    interState,
    placeOfSupply: buyerState ? `${buyerState}${buyerCode ? ' (' + buyerCode + ')' : ''}` : 'Not specified',
    sellerStateMissing: !b.stateCode,
    gstinMissing: !b.gstin,
    lines,
    byRate,
    totals: {
      taxableValue,
      cgst: sum('cgst'),
      sgst: sum('sgst'),
      igst: sum('igst'),
      totalTax,
      shipping: order.shipping || 0,
      giftWrapCharge: order.giftWrapCharge || 0,
      discount: order.discount || 0,
      grandTotal,
      rounded,
      roundOff: round2(rounded - grandTotal),
      amountInWords: inWords(rounded, config)
    },
    payment: {
      method: order.paymentMethod,
      status: order.paymentStatus,
      paidNow: order.codPlan ? order.codPlan.advancePaid : rounded,
      dueOnDelivery: order.codPlan ? order.codPlan.dueOnDelivery : 0,
      reference: order.payment ? order.payment.paymentId : null
    }
  };
}

/* --------------------------------------------------------- in words ---- */

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigits(n) {
  if (n < 20) return ONES[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '');
}

/** Indian grouping: crore, lakh, thousand, hundred — what the invoice must say. */
function inWords(amount, config) {
  const n = Math.floor(Math.abs(Number(amount) || 0));
  if (n === 0) return 'Zero Rupees Only';

  const parts = [];
  const crore = Math.floor(n / 10000000);
  const lakh = Math.floor((n % 10000000) / 100000);
  const thousand = Math.floor((n % 100000) / 1000);
  const hundred = Math.floor((n % 1000) / 100);
  const rest = n % 100;

  if (crore) parts.push(twoDigits(crore) + ' Crore');
  if (lakh) parts.push(twoDigits(lakh) + ' Lakh');
  if (thousand) parts.push(twoDigits(thousand) + ' Thousand');
  if (hundred) parts.push(ONES[hundred] + ' Hundred');
  if (rest) parts.push((parts.length ? 'and ' : '') + twoDigits(rest));

  const unit = (config && config.currency && config.currency.code === 'INR') ? 'Rupees' : '';
  return `${unit} ${parts.join(' ')} Only`.trim();
}

/** Health check for the settings screen — an invoice missing these isn't valid. */
function readiness(config) {
  const b = business(config);
  const missing = [];
  if (!b.gstin) missing.push('GSTIN');
  if (!b.legalName) missing.push('legal business name');
  if (!b.addressLines.length) missing.push('business address');
  if (!b.stateCode) missing.push('business state');
  if (!b.pan) missing.push('PAN');
  return { ok: missing.length === 0, missing, business: b };
}

module.exports = { build, business, readiness, inWords, stateCode, financialYearFor, allocateNumber, STATE_CODES };
