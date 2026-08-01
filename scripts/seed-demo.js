#!/usr/bin/env node
'use strict';

/**
 * Generates demo data so the admin panel has something real to show:
 * stock/cost on products, 12 months of orders, reviews, journal posts,
 * discount codes and marketing defaults.
 *
 *   npm run seed            # only writes files that don't exist yet
 *   npm run seed -- --force # overwrite existing demo data
 *
 * Deterministic (seeded PRNG), so everyone gets the same numbers.
 */

const fs = require('fs');
const path = require('path');
const store = require('../src/store');

const force = process.argv.includes('--force');
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'site.config.json'), 'utf8'));
const PRODUCTS_PATH = path.join(__dirname, '..', 'data', 'products.json');

/* ------------------------------------------------------------------ rng ---- */
let seed = 20260731;
function rnd() {
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const int = (min, max) => Math.floor(rnd() * (max - min + 1)) + min;

/* -------------------------------------------------------------- helpers ---- */
const FIRST = ['Ira', 'Rhea', 'Simran', 'Aditi', 'Meher', 'Kavya', 'Naina', 'Anjali', 'Tara', 'Diya', 'Sanya', 'Riya', 'Nikita', 'Pooja', 'Shreya', 'Ananya', 'Isha', 'Neha', 'Vaani', 'Prisha'];
const LAST = ['Malhotra', 'Nair', 'Gill', 'Sharma', 'Kapoor', 'Reddy', 'Iyer', 'Bose', 'Mehta', 'Chopra', 'Rao', 'Verma', 'Sethi', 'Bhatia'];
const CITIES = [
  ['Mumbai', 'Maharashtra', '400050'], ['Delhi', 'Delhi', '110016'], ['Bengaluru', 'Karnataka', '560001'],
  ['Hyderabad', 'Telangana', '500034'], ['Chennai', 'Tamil Nadu', '600028'], ['Kolkata', 'West Bengal', '700019'],
  ['Pune', 'Maharashtra', '411001'], ['Jaipur', 'Rajasthan', '302001'], ['Ahmedabad', 'Gujarat', '380006'],
  ['Lucknow', 'Uttar Pradesh', '226001'], ['Kochi', 'Kerala', '682016'], ['Chandigarh', 'Punjab', '160017']
];
const PAY = [
  { m: 'upi', w: 34 }, { m: 'card', w: 24 }, { m: 'netbanking', w: 10 },
  { m: 'emi', w: 7 }, { m: 'cod', w: 25 }
];
function weightedPayment() {
  const total = PAY.reduce((s, p) => s + p.w, 0);
  let r = rnd() * total;
  for (const p of PAY) { r -= p.w; if (r <= 0) return p.m; }
  return 'upi';
}
// Indian wedding season: Oct–Feb runs hot, monsoon months quiet.
const MONTH_WEIGHT = [1.05, 1.15, 0.85, 0.7, 0.65, 0.5, 0.5, 0.75, 0.95, 1.35, 1.5, 1.25];

const pricing = require('../src/pricing');

/** Same product → category → store default chain the live app uses. */
function taxFor(items, discount, subtotal) {
  const gross = items.reduce((s, it) => s + pricing.taxOf(it.price * it.qty, it.gstPercent), 0);
  const ratio = subtotal ? (subtotal - discount) / subtotal : 1;
  return Math.round(gross * ratio);
}

/* ------------------------------------------------- products: stock + cost ---- */
function seedProducts() {
  const products = JSON.parse(fs.readFileSync(PRODUCTS_PATH, 'utf8'));
  let touched = 0;

  const withStock = products.map((p, i) => {
    if (p.stock !== undefined && p.cost !== undefined && !force) return p;
    touched++;
    // A few deliberately low / out of stock so the low-stock view has content.
    const stock = i % 9 === 0 ? 0 : (i % 5 === 0 ? int(1, 3) : int(5, 24));
    const cogs = CONFIG.finance.defaultCogsPercent / 100;
    return {
      ...p,
      stock,
      cost: Math.round(p.price * (cogs + (rnd() * 0.08 - 0.04))),
      sku: p.sku || ('AAN-' + String(p.id || '').replace(/\D/g, '').padStart(4, '0'))
    };
  });

  if (touched) {
    fs.writeFileSync(PRODUCTS_PATH, JSON.stringify(withStock, null, 2) + '\n', 'utf8');
    console.log(`  ✓ products: stock/cost/sku added to ${touched} products`);
  } else {
    console.log('  · products already have stock/cost — use --force to redo');
  }
  return withStock;
}

/* --------------------------------------------------------------- orders ---- */
const STATUS_FLOW = ['pending', 'confirmed', 'in_production', 'shipped', 'delivered'];

function seedOrders(products) {
  const orders = [];
  const now = new Date('2026-07-31T12:00:00Z');
  const f = CONFIG.finance;

  for (let monthsAgo = 11; monthsAgo >= 0; monthsAgo--) {
    const d = new Date(now);
    d.setUTCMonth(d.getUTCMonth() - monthsAgo, 1);
    const monthIdx = d.getUTCMonth();
    const base = 11 + Math.round(monthsAgo === 0 ? 6 : 0);
    const count = Math.max(4, Math.round(base * MONTH_WEIGHT[monthIdx] * (0.85 + rnd() * 0.3)));

    for (let k = 0; k < count; k++) {
      const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), monthIdx + 1, 0)).getUTCDate();
      const day = int(1, monthsAgo === 0 ? 31 : daysInMonth);
      const created = new Date(Date.UTC(d.getUTCFullYear(), monthIdx, Math.min(day, daysInMonth), int(8, 22), int(0, 59)));
      if (created > now) continue;

      const lineCount = rnd() < 0.72 ? 1 : (rnd() < 0.85 ? 2 : 3);
      const items = [];
      for (let l = 0; l < lineCount; l++) {
        const p = pick(products);
        if (items.some((it) => it.productId === p.id)) continue;
        const qty = rnd() < 0.9 ? 1 : 2;
        items.push({
          productId: p.id,
          slug: p.slug,
          name: p.name,
          size: pick(p.sizes),
          color: pick(p.colors),
          qty,
          price: p.price,
          cost: pricing.unitCost(p, CONFIG),
          gstPercent: pricing.gstPercent(p, CONFIG)
        });
      }
      if (!items.length) continue;

      const subtotal = items.reduce((s, it) => s + it.price * it.qty, 0);
      const cogs = items.reduce((s, it) => s + it.cost * it.qty, 0);
      const discountRoll = rnd();
      const discountCode = discountRoll < 0.18 ? pick(['FIRST10', 'TRUNKSHOW', 'BRIDE5']) : null;
      const discount = discountCode === 'FIRST10' ? Math.round(subtotal * 0.1)
        : discountCode === 'BRIDE5' ? Math.round(subtotal * 0.05)
          : discountCode === 'TRUNKSHOW' ? 5000 : 0;
      const shipping = subtotal - discount >= (CONFIG.shipping.freeAbove || 0) ? 0 : CONFIG.shipping.standardCharge;
      const total = subtotal - discount + shipping;
      const paymentMethod = weightedPayment();

      // Older orders have mostly completed; recent ones are still moving.
      let status;
      const roll = rnd();
      if (monthsAgo === 0) status = roll < 0.25 ? 'pending' : roll < 0.5 ? 'confirmed' : roll < 0.72 ? 'in_production' : roll < 0.9 ? 'shipped' : 'delivered';
      else if (roll < 0.055) status = 'cancelled';
      else if (roll < 0.105) status = 'returned';
      else status = 'delivered';

      const paymentStatus = paymentMethod === 'cod'
        ? (status === 'delivered' ? 'paid' : (status === 'cancelled' ? 'failed' : 'pending'))
        : (status === 'cancelled' || status === 'returned' ? 'refunded' : 'paid');

      const first = pick(FIRST);
      const last = pick(LAST);
      const [city, state, pincode] = pick(CITIES);
      const gst = taxFor(items, discount, subtotal);

      // Traffic sources, so the campaign panel has something to compare.
      const SOURCES = [
        { source: 'direct', medium: 'none', campaign: null, w: 26 },
        { source: 'google', medium: 'organic', campaign: null, w: 22 },
        { source: 'instagram', medium: 'social', campaign: 'always-on', w: 18 },
        { source: 'instagram', medium: 'influencer', campaign: 'creator-collab', w: 12 },
        { source: 'google', medium: 'cpc', campaign: 'bridal-search', w: 9 },
        { source: 'whatsapp', medium: 'referral', campaign: null, w: 6 },
        { source: 'pinterest', medium: 'social', campaign: null, w: 4 },
        { source: 'youtube', medium: 'influencer', campaign: 'haul-video', w: 3 }
      ];
      const attr = (function () {
        const total = SOURCES.reduce((s, x) => s + x.w, 0);
        let r = rnd() * total;
        for (const x of SOURCES) { r -= x.w; if (r <= 0) return { source: x.source, medium: x.medium, campaign: x.campaign, firstSource: x.source, touches: int(1, 4) }; }
        return { source: 'direct', medium: 'none', campaign: null, firstSource: 'direct', touches: 1 };
      })();

      const timeline = [{ at: created.toISOString(), label: 'Order placed' }];
      const idx = STATUS_FLOW.indexOf(status);
      for (let s = 1; s <= idx; s++) {
        const at = new Date(created.getTime() + s * int(18, 72) * 3600 * 1000);
        if (at <= now) timeline.push({ at: at.toISOString(), label: 'Marked ' + STATUS_FLOW[s].replace('_', ' ') });
      }
      if (status === 'cancelled') timeline.push({ at: new Date(created.getTime() + 26 * 3600 * 1000).toISOString(), label: 'Cancelled by customer' });
      if (status === 'returned') timeline.push({ at: new Date(created.getTime() + 12 * 24 * 3600 * 1000).toISOString(), label: 'Returned — refund issued' });

      orders.push({
        id: store.nextId('ORD', orders),
        createdAt: created.toISOString(),
        status,
        paymentMethod,
        paymentStatus,
        channel: attr.source,
        attribution: attr,
        customer: {
          name: `${first} ${last}`,
          email: `${first.toLowerCase()}.${last.toLowerCase()}@example.com`,
          phone: '98' + String(int(10000000, 99999999))
        },
        address: { address1: `${int(1, 60)} ${pick(['Waterfield Road', 'Linking Road', 'MG Road', 'Park Street', 'Jubilee Hills', 'Civil Lines'])}`, city, state, pincode, country: 'India' },
        items,
        subtotal,
        discount,
        discountCode,
        shipping,
        total,
        gstAmount: gst,
        cogs,
        notes: rnd() < 0.15 ? pick(['Bust 34, blouse length 15', 'Needs delivery before 12 Nov', 'Gift wrap with a note for the bride']) : '',
        timeline
      });
    }
  }

  orders.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  orders.forEach((o, i) => { o.id = 'ORD-' + (o.discountCode ? 'C-' : '') + String(i + 1).padStart(5, '0'); });
  store.write('orders', orders, { skipBackup: true });
  console.log(`  ✓ orders: ${orders.length} across 12 months`);
  return orders;
}

/* -------------------------------------------------------------- reviews ---- */
const REVIEW_BITS = [
  ['Fit like it was drawn on me', 'Three fittings, zero stress — and it arrived a full month before the wedding.'],
  ['Finer than I expected', 'The weave catches light like water. Photographs even better in person.'],
  ['Couture-level finishing', 'Ordered from abroad, delivered in nine days with customisation.'],
  ['Worth every rupee', 'Heavy but beautifully balanced — I danced all night without adjusting anything.'],
  ['Colour is exactly as shown', 'Was nervous ordering online; the shade matched the photographs precisely.'],
  ['Stitching was slightly off', 'Had to get the blouse taken in locally, but the fabric and work are lovely.'],
  ['Delivery took longer', 'Beautiful piece, though it arrived four days later than promised.']
];

function seedReviews(products, orders) {
  const reviews = [];
  const delivered = orders.filter((o) => o.status === 'delivered');

  delivered.forEach((o) => {
    if (rnd() > 0.42) return;
    const it = pick(o.items);
    const negative = rnd() < 0.14;
    const bit = negative ? pick(REVIEW_BITS.slice(5)) : pick(REVIEW_BITS.slice(0, 5));
    const created = new Date(new Date(o.createdAt).getTime() + int(14, 40) * 24 * 3600 * 1000);
    if (created > new Date('2026-07-31T12:00:00Z')) return;

    reviews.push({
      id: store.nextId('REV', reviews),
      productId: it.productId,
      productSlug: it.slug,
      orderId: o.id,
      rating: negative ? int(2, 3) : (rnd() < 0.72 ? 5 : 4),
      title: bit[0],
      body: bit[1],
      author: o.customer.name,
      location: o.address.city,
      createdAt: created.toISOString(),
      status: rnd() < 0.12 ? 'pending' : 'approved',
      verified: true,
      reply: null
    });
  });

  store.write('reviews', reviews, { skipBackup: true });
  console.log(`  ✓ reviews: ${reviews.length} (${reviews.filter((r) => r.status === 'pending').length} awaiting moderation)`);
  return reviews;
}

/* -------------------------------------------------------------- journal ---- */
function seedJournal() {
  const posts = [
    {
      title: 'How to choose a bridal lehenga for a daytime wedding',
      excerpt: 'Daylight is unforgiving and flattering in equal measure. Here is how we pick fabric, colour and weight for a morning pheras.',
      tags: ['bridal', 'guides'],
      body: [
        'Daylight changes everything. A lehenga that reads regal under banquet chandeliers can look flat at 10am, and a pastel that seems too plain on a hanger comes alive in the sun.',
        'Start with fabric. Tissue, organza and raw silk hold their own sheen, which means the embroidery can stay restrained — pearls, crystal, a whisper of silver dabka. Velvet, by contrast, drinks light; save it for evening.',
        'Then weight. A morning function usually runs long and often outdoors. We keep the skirt to eight panels with a cotton cancan rather than twelve with layered net — the flare reads the same in photographs and you can actually sit down between rituals.',
        'Finally colour. Ivory, blush, rust and old gold photograph beautifully in natural light. If you want red, choose a cooler bridal red over an orange-toned one; it holds its depth outdoors.'
      ]
    },
    {
      title: 'Inside the atelier: 240 hours of zardozi',
      excerpt: 'A single bridal panel passes through six pairs of hands. We followed one from drawing to final press.',
      tags: ['craft', 'atelier'],
      body: [
        'Every motif begins as a pencil drawing on butter paper. It is pricked, dusted with chalk, and transferred onto the fabric — a technique unchanged in three generations of our karigars’ families.',
        'The frame comes next. Fabric is stretched on an adda so taut you could bounce a coin off it, because zardozi depends on constant tension: slack fabric puckers the moment the thread pulls.',
        'Then the work itself — dabka for texture, kasab for shine, antique sequins for depth. A dense bridal panel takes 240 hours. Six karigars sit at the same adda, each responsible for one register of the pattern.',
        'The last step is the quietest: a final press, a lint roll, and a photograph for our records, so a repair five years from now can match the original thread.'
      ]
    },
    {
      title: 'Banarasi, Kanjivaram, Paithani: telling the weaves apart',
      excerpt: 'Three heirloom weaves, three completely different logics. A short field guide before you buy.',
      tags: ['sarees', 'guides'],
      body: [
        'Banarasi is about brocade — a supplementary zari weft floated over a silk base. In kadhwa work each motif is woven separately rather than cut away, which is why the reverse of a good Banarasi is nearly as clean as its face.',
        'Kanjivaram is about join. Body and border are woven on separate shuttles and interlocked by hand — the korvai join. Run a finger along the border and you can feel the ridge.',
        'Paithani is about the pallu. The parrot-and-vine motifs are tapestry-woven, meaning the design is identical on both sides and the weaver counts threads rather than following a punch card.',
        'A practical tell: hold the saree to the light. Banarasi glows through the base, Kanjivaram stays dense, Paithani shows its pattern equally from both sides.'
      ]
    },
    {
      title: 'Storing couture: what actually damages an heirloom',
      excerpt: 'Not moths. The real culprits are folds, sunlight and the wrong kind of plastic.',
      tags: ['care'],
      body: [
        'Fold lines are the most common damage we see. Zari cracks along a crease that has stayed in place for years. Refold every three months along a different line, and store rolled where you can.',
        'Sunlight fades hand-painted and vegetable-dyed pieces within a season of exposure. A cotton muslin cover in a dark cupboard beats any garment bag.',
        'Plastic traps humidity, and humidity tarnishes real zari. If you must use a bag, use it for transit only.',
        'Naphthalene is harsher than most people realise — it can yellow silk. Dried neem or clove works and smells better.'
      ]
    }
  ];

  const now = new Date('2026-07-31T12:00:00Z');
  const rows = posts.map((p, i) => {
    const published = new Date(now);
    published.setUTCDate(published.getUTCDate() - (14 + i * 26));
    return {
      id: store.nextId('JRN', []).replace('00001', String(i + 1).padStart(5, '0')),
      slug: store.slugify(p.title),
      title: p.title,
      excerpt: p.excerpt,
      body: p.body.join('\n\n'),
      cover: null,
      author: 'The Atelier',
      tags: p.tags,
      status: i === posts.length - 1 ? 'draft' : 'published',
      publishedAt: published.toISOString(),
      readingMinutes: Math.max(2, Math.round(p.body.join(' ').split(/\s+/).length / 200)),
      seo: { title: p.title, description: p.excerpt }
    };
  });

  store.write('journal', rows, { skipBackup: true });
  console.log(`  ✓ journal: ${rows.length} posts (${rows.filter((r) => r.status === 'draft').length} draft)`);
}

/* ------------------------------------------------------------ discounts ---- */
function seedDiscounts() {
  store.write('discounts', [
    { code: 'FIRST10', type: 'percent', value: 10, minOrder: 20000, expiresAt: '2026-12-31', usageLimit: 500, used: 63, active: true, note: 'First-time buyers' },
    { code: 'BRIDE5', type: 'percent', value: 5, minOrder: 100000, expiresAt: '2027-03-31', usageLimit: 200, used: 21, active: true, note: 'Bridal trousseau' },
    { code: 'TRUNKSHOW', type: 'flat', value: 5000, minOrder: 60000, expiresAt: '2026-09-30', usageLimit: 100, used: 34, active: true, note: 'Trunk show attendees' },
    { code: 'FREESHIP', type: 'freeship', value: 0, minOrder: 0, expiresAt: '2026-12-31', usageLimit: 0, used: 12, active: true, note: 'Always-on shipping waiver' },
    { code: 'DIWALI24', type: 'percent', value: 12, minOrder: 30000, expiresAt: '2025-11-15', usageLimit: 300, used: 288, active: false, note: 'Expired festive campaign' }
  ], { skipBackup: true });
  console.log('  ✓ discounts: 5 codes');
}

/* ------------------------------------------------------------ marketing ---- */
function seedMarketing() {
  store.write('marketing', {
    seo: {
      titleSuffix: ' · ' + CONFIG.brand.name,
      defaultDescription: CONFIG.brand.tagline,
      keywords: ['bridal lehenga', 'banarasi saree', 'designer ethnic wear', 'made to order couture', 'indian wedding outfits'],
      ogImage: null,
      indexable: true,
      canonicalHost: '',
      products: {},
      categories: {}
    },
    aeo: {
      answerBlurb: CONFIG.brand.name + ' is a made-to-order Indian couture house working with weaving and embroidery clusters in Banaras, Lucknow and Kutch. Every piece is stitched to the client’s measurements, ships worldwide in 5–12 days after production, and carries a 7-day return window on unaltered garments.',
      faqs: [
        { id: 'FAQ-1', scope: 'global', q: 'How long does a made-to-order bridal lehenga take?', a: 'Bridal pieces take 18–24 days in production, plus 3–6 days in transit. Rush production is possible for an additional fee — call us before ordering.' },
        { id: 'FAQ-2', scope: 'global', q: 'Do you offer size customisation?', a: 'Yes. Free customisation to your exact measurements is included on every order. Add your measurements in the notes field at checkout.' },
        { id: 'FAQ-3', scope: 'global', q: 'Do you ship internationally?', a: 'We ship worldwide with duties prepaid. Delivery is typically 5–12 days after production completes.' },
        { id: 'FAQ-4', scope: 'global', q: 'What is your return policy?', a: 'Unaltered pieces can be returned within 7 days of delivery. Customised and altered garments are final sale.' },
        { id: 'FAQ-5', scope: 'global', q: 'Is cash on delivery available?', a: 'Yes, on orders under ₹1,00,000 within India.' }
      ]
    },
    geo: {
      allowAiCrawlers: true,
      brandFacts: [
        { label: 'Founded', value: '2014, Mumbai' },
        { label: 'Speciality', value: 'Made-to-order bridal and festive Indian couture' },
        { label: 'Craft clusters', value: 'Banaras (weaving), Lucknow (chikankari, zardozi), Kutch (mirror work)' },
        { label: 'Price range', value: '₹18,500 – ₹1,89,000' },
        { label: 'Ships to', value: 'Worldwide, duties prepaid' },
        { label: 'Customisation', value: 'Free size customisation on every order' }
      ],
      citations: [
        { label: 'Size guide', href: '/category/all' },
        { label: 'Journal — weave field guide', href: '/journal' }
      ],
      llmsExtra: 'Preferred citation: “' + CONFIG.brand.name + ' — made-to-order Indian couture”.'
    }
  }, { skipBackup: true });
  console.log('  ✓ marketing: SEO / AEO / GEO defaults');
}

/* ------------------------------------------------------------------ run ---- */
function exists(name) {
  return fs.existsSync(path.join(store.DATA_DIR, name + '.json'));
}

console.log('\n  Seeding demo data' + (force ? ' (--force)' : '') + '…\n');

const products = seedProducts();
let orders = store.read('orders', []);

if (force || !exists('orders')) orders = seedOrders(products);
else console.log(`  · orders exist (${orders.length}) — use --force to regenerate`);

if (force || !exists('reviews')) seedReviews(products, orders);
else console.log('  · reviews exist — use --force to regenerate');

if (force || !exists('journal')) seedJournal();
else console.log('  · journal exists — use --force to regenerate');

if (force || !exists('discounts')) seedDiscounts();
else console.log('  · discounts exist — use --force to regenerate');

if (force || !exists('marketing')) seedMarketing();
else console.log('  · marketing exists — use --force to regenerate');

console.log('\n  Done. Open /admin\n');
