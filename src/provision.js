'use strict';

/**
 * Turning a sold store into a live one.
 *
 * The same codebase is resold many times, so every launch repeats the same dozen
 * edits: the brand, the tax details that make an invoice legal, which sections the shop
 * sells to, the plan, the owner account, the licence. Doing that by hand once is fine.
 * Doing it fifty times is where a shop goes live still called AANYÄ, or with the
 * handover password still working, or issuing invoices under someone else's GSTIN.
 *
 * Two rules shape this file.
 *
 * VALIDATE EVERYTHING BEFORE WRITING ANYTHING. A half-provisioned store is worse than
 * an untouched one: the brand is theirs, the GSTIN is not, and nothing on screen says
 * which. Every check runs first, and a single failure means no file is touched.
 *
 * NEVER TAKE A PASSWORD AS INPUT. The owner password is generated here and printed
 * once. A password that arrives in a spec file is a password that lives in a WhatsApp
 * thread forever.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const invoice = require('./invoice');
const gstin = require('./gstin');
const { PLANS } = require('./plan');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config', 'site.config.json');

/* ------------------------------------------------------------ the spec ---- */

/**
 * An example spec, written out by `--template`. Comment keys are deliberate: a JSON
 * file someone fills in a week before the meeting needs to explain itself.
 */
function template() {
  return {
    _readme: [
      'One client. Fill this in, then: npm run provision -- --file client.json',
      'Run with --dry-run first: it validates everything and writes nothing.',
      'Do NOT put a password here — provisioning generates one and prints it once.'
    ],
    brand: {
      name: 'Meera Couture',
      logoText: 'MEERA',
      logoSubtext: 'COUTURE',
      tagline: 'Hand-worked festive wear from Lucknow',
      supportPhone: '+91 98000 00000',
      supportEmail: 'care@meeracouture.in'
    },
    business: {
      legalName: 'Meera Couture Private Limited',
      tradeName: 'Meera Couture',
      gstin: '09AABCM1234A1Z5',
      pan: 'AABCM1234A',
      addressLines: ['12 Hazratganj', 'Lucknow 226001'],
      state: 'Uttar Pradesh',
      invoicePrefix: 'MC',
      defaultHsn: '6211',
      signatureName: 'For Meera Couture Private Limited',
      // Optional. Left out, the invoice simply carries no bank block — which is
      // correct, and far better than carrying somebody else's.
      bank: {
        name: 'HDFC Bank',
        accountName: 'Meera Couture Private Limited',
        accountNumber: 'XXXXXXXX0000',
        ifsc: 'HDFC0000000',
        upi: 'meera@hdfcbank'
      }
    },
    footer: {
      blurb: 'Hand-worked festive and occasion wear, made in Lucknow.',
      copyright: '© Meera Couture. All rights reserved.'
    },
    owner: {
      name: 'Meera Singh',
      email: 'meera@meeracouture.in'
    },
    audiences: ['women', 'men'],
    fulfilment: {
      madeToOrder: false,
      complimentaryCustomisation: false
    },
    licence: {
      plan: 'growth',
      months: 12,
      domains: ['meeracouture.in', 'www.meeracouture.in'],
      extras: []
    },
    catalogue: 'keep-demo'
  };
}

/* ---------------------------------------------------------- validation ---- */

const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const DOMAIN = /^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
const CATALOGUE_CHOICES = ['keep-demo', 'empty'];

/**
 * Is this string still the demo store's?
 *
 * The demo brand is written "AANYÄ", and /aanya/i does not match it — Ä is not a. The
 * guard here and the one in doctor were both that regex, so the brand-name check had
 * never once fired; the only reason a demo store was ever flagged is that its support
 * email happened to be care@aanya.example. Diacritics are stripped first now, so the
 * name is actually checked.
 */
function looksLikeDemo(value) {
  const plain = String(value || '')
    .normalize('NFD')                 // splits Ä into A + combining diaeresis
    .replace(/\p{Diacritic}/gu, '')   // …which this then drops
    .toLowerCase();
  return /aanya/.test(plain);
}

/**
 * Every problem with the spec, in one pass.
 *
 * Returns them all rather than throwing on the first: someone filling this in before a
 * client meeting should learn about four mistakes at once, not discover a fifth run
 * later that the PAN was wrong too.
 */
function validate(spec, { config } = {}) {
  const errors = [];
  const warnings = [];
  const need = (cond, msg) => { if (!cond) errors.push(msg); };

  if (!spec || typeof spec !== 'object') return { ok: false, errors: ['The spec is not an object.'], warnings };

  /* --- brand --- */
  const brand = spec.brand || {};
  need(brand.name, 'brand.name is required — it is the shop\'s name everywhere.');
  need(!looksLikeDemo(brand.name), 'brand.name is still the demo brand.');
  need(brand.supportEmail, 'brand.supportEmail is required — customers reply to it.');
  if (brand.supportEmail) need(EMAIL.test(brand.supportEmail), `brand.supportEmail "${brand.supportEmail}" is not an email address.`);
  if (!brand.supportPhone) warnings.push('No brand.supportPhone — the storefront and invoices will show no number to call.');
  if (!brand.logoText) warnings.push('No brand.logoText — the header will fall back to the full brand name.');

  /* --- business: this is what makes an invoice a legal document --- */
  const biz = spec.business || {};
  need(biz.legalName, 'business.legalName is required — an invoice is issued by a legal entity, not a brand.');
  need(biz.gstin, 'business.gstin is required.');
  if (biz.gstin) {
    const g = gstin.check(biz.gstin);
    // The check digit catches a typed-in GSTIN that looks right and is not. Issuing a
    // year of invoices under a wrong number is not a fixable mistake.
    need(g.ok, `business.gstin ${biz.gstin} is invalid: ${g.reason || 'failed the check digit'}`);
  }
  need(biz.pan, 'business.pan is required — it appears on the invoice.');
  if (biz.pan) need(PAN.test(String(biz.pan).toUpperCase()), `business.pan "${biz.pan}" is not shaped like a PAN.`);
  need(Array.isArray(biz.addressLines) && biz.addressLines.filter(Boolean).length,
    'business.addressLines is required — an invoice needs a place of business.');
  need(biz.state, 'business.state is required — it decides CGST+SGST versus IGST on every order.');
  if (biz.state) {
    const code = invoice.stateCode(biz.state);
    need(code, `business.state "${biz.state}" is not a state we have a GST code for.`);
    // The GSTIN's first two digits ARE the state code; a mismatch means one of them is
    // wrong, and every invoice would carry the wrong place of supply.
    if (code && biz.gstin && gstin.check(biz.gstin).ok && String(biz.gstin).slice(0, 2) !== code) {
      errors.push(`business.gstin starts ${String(biz.gstin).slice(0, 2)} but ${biz.state} is state code ${code} — one of them is wrong.`);
    }
  }
  if (!biz.invoicePrefix) warnings.push('No business.invoicePrefix — the invoice series will use the default.');

  /* --- the person who will run it --- */
  const owner = spec.owner || {};
  need(owner.name, 'owner.name is required.');
  need(owner.email, 'owner.email is required — it is their login.');
  if (owner.email) need(EMAIL.test(owner.email), `owner.email "${owner.email}" is not an email address.`);
  if (owner.password || (spec.owner && spec.owner.pass)) {
    errors.push('Remove owner.password. Provisioning generates one and prints it once — a password in a spec file lives in a chat thread forever.');
  }

  /* --- which sections the shop sells to --- */
  const known = ((config && config.audiences && config.audiences.list) || []).map((a) => a.id);
  if (spec.audiences !== undefined) {
    need(Array.isArray(spec.audiences) && spec.audiences.length,
      'audiences must be a non-empty list, e.g. ["women"] or ["women","men","kids"].');
    (Array.isArray(spec.audiences) ? spec.audiences : []).forEach((id) => {
      need(known.includes(id), `audiences: "${id}" is not one of ${known.join(', ') || '(none configured)'}.`);
    });
  }

  /* --- licence --- */
  const lic = spec.licence || {};
  if (lic.plan !== undefined) {
    need(PLANS.some((p) => p.id === lic.plan), `licence.plan "${lic.plan}" is not one of ${PLANS.map((p) => p.id).join(', ')}.`);
  }
  if (lic.months !== undefined) {
    need(Number.isFinite(Number(lic.months)) && Number(lic.months) > 0, 'licence.months must be a positive number.');
  }
  (lic.domains || []).forEach((d) => {
    need(DOMAIN.test(String(d)), `licence.domains: "${d}" is not a domain (no scheme, no path).`);
  });
  if (!(lic.domains || []).length) {
    warnings.push('No licence.domains — the key will work on any host, including one the client stands up themselves.');
  }

  /* --- catalogue --- */
  if (spec.catalogue !== undefined) {
    need(CATALOGUE_CHOICES.includes(spec.catalogue),
      `catalogue must be one of ${CATALOGUE_CHOICES.join(', ')}.`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

/* ------------------------------------------------------------- password ---- */

/**
 * A password the client will actually type once and then change.
 *
 * Deliberately readable — words and a number, not 24 random bytes. A password nobody
 * can read over the phone gets written on a sticky note, which is worse than a
 * slightly shorter one they will replace on first login anyway.
 */
const WORDS = [
  'marigold', 'brocade', 'zardozi', 'chikan', 'banarasi', 'kanjivaram', 'jamdani',
  'tussar', 'organza', 'chanderi', 'phulkari', 'bandhani', 'mashru', 'gota'
];

function generatePassword() {
  const pick = () => WORDS[crypto.randomInt(WORDS.length)];
  const word = (w) => w[0].toUpperCase() + w.slice(1);
  // Two distinct words, so it never reads as a doubled typo.
  let a = pick(); let b = pick();
  while (b === a) b = pick();
  return `${word(a)}-${word(b)}-${crypto.randomInt(1000, 10000)}`;
}

/* --------------------------------------------------------------- config ---- */

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

/**
 * Copies the config aside before it is overwritten.
 *
 * store.backup() only knows about data/, so it would look for config/site.config.json
 * in the wrong directory and quietly return null — leaving a run that pointed at the
 * wrong store with no way back.
 */
function backupConfig() {
  const dir = path.join(ROOT, 'data', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dir, `site.config-${stamp}.json`);
  fs.copyFileSync(CONFIG_PATH, dest);
  return path.relative(ROOT, dest);
}

/**
 * The new config, as a value. Nothing is written here, so a caller can diff it or
 * throw it away — which is what --dry-run does.
 */
function planConfig(spec, current) {
  const next = JSON.parse(JSON.stringify(current));
  const brand = spec.brand || {};
  const biz = spec.business || {};

  next.brand = {
    ...next.brand,
    name: brand.name,
    logoText: brand.logoText || brand.name,
    logoSubtext: brand.logoSubtext !== undefined ? brand.logoSubtext : '',
    tagline: brand.tagline || next.brand.tagline,
    supportPhone: brand.supportPhone || '',
    supportEmail: brand.supportEmail,
    // The monogram is the favicon letter; derived so nobody has to think about it.
    monogram: brand.monogram || String(brand.name).trim()[0].toUpperCase()
  };

  /* The bank block is PRINTED ON THE INVOICE. Leaving the demo's HDFC account and
     "aanya@hdfcbank" there is the worst thing on this page: a customer could pay a
     client's invoice into our demo account. Absent beats wrong, so an unspecified bank
     is cleared rather than inherited. */
  const bank = biz.bank && biz.bank.accountName ? biz.bank : null;

  next.business = {
    ...next.business,
    bank: bank
      ? { ...bank }
      : { name: '', accountName: '', accountNumber: '', ifsc: '', upi: '' },
    legalName: biz.legalName,
    tradeName: biz.tradeName || brand.name,
    gstin: gstin.normalise(biz.gstin),
    pan: String(biz.pan).toUpperCase(),
    addressLines: biz.addressLines.filter(Boolean),
    state: biz.state,
    stateCode: invoice.stateCode(biz.state),
    phone: biz.phone || brand.supportPhone || '',
    email: biz.email || brand.supportEmail,
    invoicePrefix: biz.invoicePrefix || next.business.invoicePrefix,
    defaultHsn: biz.defaultHsn || next.business.defaultHsn,
    signatureName: biz.signatureName || `For ${biz.legalName}`
  };

  /* Sections: keep the configured entries, in the client's order, and drop the rest.
     A menswear-only shop should carry no trace of the feature. */
  if (Array.isArray(spec.audiences) && spec.audiences.length) {
    const byId = new Map(((current.audiences && current.audiences.list) || []).map((a) => [a.id, a]));
    next.audiences = {
      ...next.audiences,
      list: spec.audiences.map((id) => byId.get(id)).filter(Boolean)
    };
  }

  if (spec.fulfilment) {
    next.features = { ...next.features, ...pickFulfilment(spec.fulfilment) };
  }

  if (spec.licence && spec.licence.plan) {
    next.plan = spec.licence.plan;
    next.planExtras = [...(spec.licence.extras || [])];
  }

  // The announcement bar ships with demo copy about bridal customisation.
  if (next.brand.announcement && (looksLikeDemo(next.brand.announcement) || /complimentary/i.test(next.brand.announcement))) {
    next.brand.announcement = brand.announcement !== undefined ? brand.announcement : '';
  }

  /* Order mail replies. The demo address here means a client's customers reply into an
     inbox nobody reads — and they reply to confirmations more than to anything else. */
  next.notifications = {
    ...next.notifications,
    fromName: brand.name,
    replyTo: brand.supportEmail,
    storeEmail: (spec.owner && spec.owner.email) || brand.supportEmail,
    storePhone: brand.supportPhone || ''
  };

  // Visible demo prose. Cleared when not supplied: an empty footer line is invisible,
  // a wrong one is on every page.
  const footer = spec.footer || {};
  next.footer = {
    ...next.footer,
    blurb: footer.blurb !== undefined ? footer.blurb : '',
    copyright: footer.copyright !== undefined ? footer.copyright : `© ${brand.name}. All rights reserved.`
  };

  return next;
}

/** Only the flags we know about, so a typo in the spec cannot invent a feature. */
function pickFulfilment(f) {
  const out = {};
  if (f.madeToOrder !== undefined) out.madeToOrder = !!f.madeToOrder;
  if (f.complimentaryCustomisation !== undefined) out.complimentaryCustomisation = !!f.complimentaryCustomisation;
  if (f.measurementNotes !== undefined) out.measurementNotes = !!f.measurementNotes;
  if (f.atelierLanguage !== undefined) out.atelierLanguage = !!f.atelierLanguage;
  return out;
}

/** What changed, in words, for the summary and for --dry-run. */
function diff(before, after, prefix = '') {
  const lines = [];
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);

  keys.forEach((k) => {
    if (k.startsWith('_')) return;
    const a = before ? before[k] : undefined;
    const b = after ? after[k] : undefined;
    const label = prefix ? `${prefix}.${k}` : k;

    const plain = (v) => v === null || typeof v !== 'object';
    if (plain(a) && plain(b)) {
      if (a !== b) lines.push({ key: label, from: a, to: b });
      return;
    }
    if (Array.isArray(a) || Array.isArray(b)) {
      const sa = JSON.stringify(a);
      const sb = JSON.stringify(b);
      if (sa !== sb) lines.push({ key: label, from: sa, to: sb });
      return;
    }
    lines.push(...diff(a || {}, b || {}, label));
  });

  return lines;
}

module.exports = {
  CONFIG_PATH, CATALOGUE_CHOICES,
  template, looksLikeDemo, validate, generatePassword, readConfig, backupConfig, planConfig, pickFulfilment, diff
};
