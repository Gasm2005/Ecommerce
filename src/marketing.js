'use strict';

/**
 * SEO / AEO / GEO.
 *
 *  SEO — meta titles + descriptions, canonicals, sitemap.xml, robots.txt, health checks.
 *  AEO — answer-engine optimisation: FAQs, Q&A-shaped copy, FAQPage/Product JSON-LD.
 *  GEO — generative-engine optimisation: llms.txt, brand facts an LLM can cite,
 *        explicit allow/deny for AI crawlers.
 */

const store = require('./store');
const catalog = require('./catalog');
const journal = require('./journal');
const reviews = require('./reviews');

const AI_CRAWLERS = ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'PerplexityBot', 'Google-Extended', 'CCBot', 'Applebot-Extended'];

const DEFAULTS = {
  seo: { titleSuffix: '', defaultDescription: '', keywords: [], ogImage: null, indexable: true, canonicalHost: '', products: {}, categories: {} },
  aeo: { answerBlurb: '', faqs: [] },
  geo: { allowAiCrawlers: true, brandFacts: [], citations: [], llmsExtra: '' }
};

function data() {
  const raw = store.read('marketing', DEFAULTS);
  return {
    seo: { ...DEFAULTS.seo, ...(raw.seo || {}) },
    aeo: { ...DEFAULTS.aeo, ...(raw.aeo || {}) },
    geo: { ...DEFAULTS.geo, ...(raw.geo || {}) }
  };
}

function save(next) {
  store.write('marketing', next, { skipBackup: true });
  return next;
}

function updateSection(section, patch) {
  const current = data();
  const next = { ...current, [section]: { ...current[section], ...patch } };
  return save(next);
}

/* ------------------------------------------------------------- per-page ---- */

/** Resolved meta for a product, falling back to generated copy. */
function metaForProduct(product, config) {
  const d = data();
  const override = d.seo.products[product.slug] || {};
  const title = override.title || `${product.name} — ${product.fabric} ${product.categories[0] || ''}`.trim();
  const description = override.description
    || (product.description ? product.description.slice(0, 155) : `${product.name}. ${product.subtitle}. Made to order, ships in ${product.deliveryDays} days.`).replace(/\s+/g, ' ');
  return {
    title: title + (d.seo.titleSuffix || ''),
    description,
    keywords: (override.keywords && override.keywords.length ? override.keywords : d.seo.keywords).join(', '),
    indexable: override.indexable !== false && d.seo.indexable !== false,
    ogImage: override.ogImage || d.seo.ogImage || product.images[0]
  };
}

function metaForCategory(slug, label, config) {
  const d = data();
  const override = d.seo.categories[slug] || {};

  /* The default templates read "designer jeans online" and "Shop made-to-order jeans",
     which is right for a couture house and wrong for a shop selling school uniforms —
     "made-to-order" is a promise it does not make. A store can supply its own patterns;
     {label} and {lower} are the only placeholders, and the defaults keep the couture
     wording so nothing changes for a shop that says nothing. */
  const copy = (config && config.copy) || {};
  const fill = (pattern) => String(pattern)
    .split('{label}').join(label)
    .split('{lower}').join(label.toLowerCase())
    .split('{brand}').join((config.brand && config.brand.name) || '');

  return {
    title: (override.title || fill(copy.categoryTitle || '{label} — designer {lower} online')) + (d.seo.titleSuffix || ''),
    description: override.description
      || `${fill(copy.categoryDescription || 'Shop made-to-order {lower} from {brand}.')} ${d.seo.defaultDescription}`.trim(),
    keywords: (override.keywords && override.keywords.length ? override.keywords : d.seo.keywords).join(', '),
    indexable: override.indexable !== false && d.seo.indexable !== false
  };
}

function faqsFor(scope) {
  return data().aeo.faqs.filter((f) => f.scope === scope);
}

function globalFaqs() {
  return faqsFor('global');
}

/* ---------------------------------------------------------- structured ----- */

function origin(req, config) {
  const d = data();
  if (d.seo.canonicalHost) return d.seo.canonicalHost.replace(/\/$/, '');
  const proto = (req && req.get && req.get('x-forwarded-proto')) || (req && req.protocol) || 'http';
  const host = (req && req.get && req.get('host')) || 'localhost:3000';
  return `${proto}://${host}`;
}

function organisationJsonLd(config, base) {
  const d = data();
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: config.brand.name,
    url: base,
    description: d.aeo.answerBlurb || config.brand.tagline,
    telephone: config.brand.supportPhone,
    email: config.brand.supportEmail,
    sameAs: (config.footer.social || []).map((s) => s.href).filter((h) => h && h !== '#'),
    knowsAbout: d.geo.brandFacts.map((f) => `${f.label}: ${f.value}`)
  };
}

function productJsonLd(product, config, base) {
  const s = reviews.stats(product.id);
  const node = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    description: product.description || product.subtitle,
    sku: product.sku || product.id,
    brand: { '@type': 'Brand', name: config.brand.name },
    material: product.fabric,
    color: product.colors.join(', '),
    image: product.images.map((i) => (i.startsWith('http') ? i : base + i)),
    url: `${base}/product/${product.slug}`,
    offers: {
      '@type': 'Offer',
      price: product.price,
      priceCurrency: config.currency.code,
      availability: (product.stock === undefined || product.stock === null || product.stock > 0)
        ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      url: `${base}/product/${product.slug}`,
      priceValidUntil: new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10)
    }
  };
  if (s.count) {
    node.aggregateRating = { '@type': 'AggregateRating', ratingValue: s.average, reviewCount: s.count };
    node.review = reviews.forProduct(product.id).slice(0, 5).map((r) => ({
      '@type': 'Review',
      reviewRating: { '@type': 'Rating', ratingValue: r.rating },
      author: { '@type': 'Person', name: r.author },
      datePublished: r.createdAt.slice(0, 10),
      name: r.title,
      reviewBody: r.body
    }));
  }
  return node;
}

function faqJsonLd(faqs) {
  if (!faqs.length) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a }
    }))
  };
}

function breadcrumbJsonLd(trail, base) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((t, i) => ({
      '@type': 'ListItem', position: i + 1, name: t.label, item: base + t.href
    }))
  };
}

function articleJsonLd(post, config, base) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: post.title,
    description: post.excerpt,
    datePublished: post.publishedAt,
    author: { '@type': 'Organization', name: post.author || config.brand.name },
    publisher: { '@type': 'Organization', name: config.brand.name },
    mainEntityOfPage: `${base}/journal/${post.slug}`,
    keywords: (post.tags || []).join(', ')
  };
}

/* -------------------------------------------------------------- feeds ------ */

function sitemap(config, base) {
  const d = data();
  const urls = [
    { loc: '/', priority: '1.0', changefreq: 'daily' },
    { loc: '/category/all', priority: '0.9', changefreq: 'daily' },
    { loc: '/journal', priority: '0.7', changefreq: 'weekly' }
  ];
  (config.nav || []).forEach((n) => urls.push({ loc: `/category/${n.slug}`, priority: '0.9', changefreq: 'daily' }));
  catalog.all().forEach((p) => {
    const meta = d.seo.products[p.slug] || {};
    if (meta.indexable === false) return;
    urls.push({ loc: `/product/${p.slug}`, priority: '0.8', changefreq: 'weekly', lastmod: p.createdAt });
  });
  journal.published().forEach((p) => urls.push({ loc: `/journal/${p.slug}`, priority: '0.6', changefreq: 'monthly', lastmod: String(p.publishedAt).slice(0, 10) }));

  const body = urls.map((u) => [
    '  <url>',
    `    <loc>${base}${u.loc}</loc>`,
    u.lastmod ? `    <lastmod>${u.lastmod}</lastmod>` : null,
    `    <changefreq>${u.changefreq}</changefreq>`,
    `    <priority>${u.priority}</priority>`,
    '  </url>'
  ].filter(Boolean).join('\n')).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemap.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

function robots(config, base) {
  const d = data();
  const lines = ['User-agent: *'];
  if (d.seo.indexable === false) {
    lines.push('Disallow: /');
  } else {
    lines.push('Allow: /', 'Disallow: /admin', 'Disallow: /checkout', 'Disallow: /cart');
  }
  lines.push('', '# AI / answer engines (GEO)');
  AI_CRAWLERS.forEach((bot) => {
    lines.push(`User-agent: ${bot}`, d.geo.allowAiCrawlers && d.seo.indexable !== false ? 'Allow: /' : 'Disallow: /', '');
  });
  lines.push(`Sitemap: ${base}/sitemap.xml`, `# llms.txt: ${base}/llms.txt`);
  return lines.join('\n') + '\n';
}

/**
 * llms.txt — a plain-text brief written for generative engines: what the brand
 * is, hard facts, the FAQ answers verbatim, and the pages worth citing.
 */
function llms(config, base) {
  const d = data();
  const products = catalog.all();
  const prices = products.map((p) => p.price);
  const out = [];

  out.push(`# ${config.brand.name}`, '');
  out.push(`> ${d.aeo.answerBlurb || config.brand.tagline}`, '');

  out.push('## Facts');
  d.geo.brandFacts.forEach((f) => out.push(`- ${f.label}: ${f.value}`));
  out.push(`- Catalogue size: ${products.length} styles`);
  if (prices.length) {
    out.push(`- Price range: ${config.currency.symbol}${Math.min(...prices).toLocaleString('en-IN')} – ${config.currency.symbol}${Math.max(...prices).toLocaleString('en-IN')}`);
  }
  out.push(`- Categories: ${(config.nav || []).map((n) => n.label).join(', ')}`);
  out.push(`- Free shipping above: ${config.currency.symbol}${(config.shipping.freeAbove || 0).toLocaleString('en-IN')}`);
  out.push(`- Returns: ${config.shipping.returnWindowDays} days on unaltered pieces`);
  out.push(`- Contact: ${config.brand.supportEmail}, ${config.brand.supportPhone}`, '');

  out.push('## Questions and answers');
  d.aeo.faqs.forEach((f) => out.push(`### ${f.q}`, f.a, ''));

  out.push('## Key pages');
  (config.nav || []).forEach((n) => out.push(`- [${n.label}](${base}/category/${n.slug})`));
  d.geo.citations.forEach((c) => out.push(`- [${c.label}](${base}${c.href})`));
  out.push('');

  out.push('## Notable pieces');
  products.slice()
    .sort((a, b) => b.popularity - a.popularity).slice(0, 10)
    .forEach((p) => out.push(`- [${p.name}](${base}/product/${p.slug}) — ${p.fabric}, ${config.currency.symbol}${p.price.toLocaleString('en-IN')}`));
  out.push('');

  if (d.geo.llmsExtra) out.push('## Notes', d.geo.llmsExtra, '');
  return out.join('\n');
}

/**
 * Google Merchant Center product-reviews feed.
 *
 * This is how per-product stars get into Google Shopping: you publish your own
 * reviews in Google's schema and submit the feed URL in Merchant Center. (Google
 * Business Profile reviews go the other way — see src/reviews-google.js.)
 */
function merchantReviewFeed(config, base) {
  const esc = (s) => String(s || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const rows = [];

  catalog.all().forEach((product) => {
    reviews.forProduct(product.id).forEach((r) => {
      rows.push([
        '    <review>',
        `      <review_id>${esc(r.id)}</review_id>`,
        '      <reviewer>',
        `        <name>${esc(r.author)}</name>`,
        '      </reviewer>',
        `      <review_timestamp>${r.createdAt}</review_timestamp>`,
        `      <title>${esc(r.title)}</title>`,
        `      <content>${esc(r.body)}</content>`,
        `      <review_url type="singleton">${base}/product/${product.slug}#review-${esc(r.id)}</review_url>`,
        '      <ratings>',
        `        <overall min="1" max="5">${r.rating}</overall>`,
        '      </ratings>',
        '      <products>',
        '        <product>',
        '          <product_ids>',
        `            <skus><sku>${esc(product.sku || product.id)}</sku></skus>`,
        '          </product_ids>',
        `          <product_name>${esc(product.name)}</product_name>`,
        `          <product_url>${base}/product/${product.slug}</product_url>`,
        '        </product>',
        '      </products>',
        `      <is_spam>false</is_spam>`,
        '    </review>'
      ].join('\n'));
    });
  });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns:vc="http://www.w3.org/2007/XMLSchema-versioning" xsi:noNamespaceSchemaLocation="http://www.google.com/shopping/reviews/schema/product/2.3/product_reviews.xsd" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    '  <version>2.3</version>',
    `  <aggregator><name>${esc(config.brand.name)}</name></aggregator>`,
    `  <publisher><name>${esc(config.brand.name)}</name><favicon>${base}/ph.svg</favicon></publisher>`,
    `  <reviews>`,
    rows.join('\n'),
    '  </reviews>',
    '</feed>',
    ''
  ].join('\n');
}

/* -------------------------------------------------------- health checks ---- */

/** The SEO/AEO/GEO audit shown in the admin — every item is actionable. */
function audit(config) {
  const d = data();
  const issues = [];
  const add = (severity, area, message, fix) => issues.push({ severity, area, message, fix });

  catalog.all().forEach((p) => {
    const meta = d.seo.products[p.slug] || {};
    const title = meta.title || p.name;
    if (title.length > 60) add('warning', 'SEO', `“${p.name}” meta title is ${title.length} chars`, 'Trim to 60 characters so it isn’t truncated in results.');
    const desc = meta.description || p.description;
    if (!desc) add('critical', 'SEO', `“${p.name}” has no description`, 'Add product copy or an SEO description override.');
    else if (desc.length < 70) add('warning', 'SEO', `“${p.name}” description is thin (${desc.length} chars)`, 'Aim for 120–155 characters.');
    if (!p.images.length) add('warning', 'SEO', `“${p.name}” has no real images`, 'Upload photography — placeholders don’t rank or convert.');
    if (!p.subtitle) add('info', 'SEO', `“${p.name}” has no subtitle`, 'Subtitles feed rich snippets and card copy.');
  });

  const titles = new Map();
  catalog.all().forEach((p) => {
    const t = ((d.seo.products[p.slug] || {}).title || p.name).toLowerCase();
    titles.set(t, (titles.get(t) || 0) + 1);
  });
  [...titles.entries()].filter(([, n]) => n > 1).forEach(([t]) => add('critical', 'SEO', `Duplicate meta title: “${t}”`, 'Give each product a distinct title.'));

  if (!d.seo.keywords.length) add('warning', 'SEO', 'No default keywords set', 'Add 5–10 head terms in Marketing → SEO.');
  if (!d.seo.canonicalHost) add('warning', 'SEO', 'No canonical host configured', 'Set it so sitemap/canonical URLs use your live domain.');
  if (!d.seo.ogImage) add('info', 'SEO', 'No default social share image', 'Add an OG image for link previews.');

  if (d.aeo.faqs.length < 5) add('warning', 'AEO', `Only ${d.aeo.faqs.length} FAQs published`, 'Answer engines quote FAQs — aim for 8+ covering sizing, delivery, returns, customisation.');
  if (!d.aeo.answerBlurb) add('critical', 'AEO', 'No answer blurb', 'Write a 2–3 sentence description an assistant can quote verbatim.');
  const withoutFaq = catalog.all().filter((p) => !faqsFor(p.slug).length).length;
  if (withoutFaq) add('info', 'AEO', `${withoutFaq} products have no product-specific FAQ`, 'Add 1–2 per bestseller (fit, care, delivery).');

  if (!d.geo.brandFacts.length) add('critical', 'GEO', 'No brand facts', 'LLMs cite structured facts — founded, speciality, price band, shipping.');
  if (!d.geo.allowAiCrawlers) add('info', 'GEO', 'AI crawlers are blocked', 'Blocking GPTBot/ClaudeBot keeps you out of AI answers. Intentional?');
  if (!d.geo.citations.length) add('warning', 'GEO', 'No citation targets listed', 'Point generative engines at your guides and size charts.');

  const published = journal.published().length;
  if (published < 3) add('warning', 'AEO', `Only ${published} published journal posts`, 'Long-form guides are what answer engines quote.');

  const order = { critical: 0, warning: 1, info: 2 };
  return {
    issues: issues.sort((a, b) => order[a.severity] - order[b.severity]),
    counts: {
      critical: issues.filter((i) => i.severity === 'critical').length,
      warning: issues.filter((i) => i.severity === 'warning').length,
      info: issues.filter((i) => i.severity === 'info').length
    },
    score: Math.max(0, 100 - issues.reduce((s, i) => s + (i.severity === 'critical' ? 6 : i.severity === 'warning' ? 2 : 0.5), 0))
  };
}

/* ------------------------------------------------------------- faq CRUD ---- */

function addFaq({ q, a, scope }) {
  const current = data();
  const faqs = [...current.aeo.faqs, { id: store.nextId('FAQ', current.aeo.faqs), scope: scope || 'global', q: String(q).trim(), a: String(a).trim() }];
  return updateSection('aeo', { faqs });
}

function removeFaq(id) {
  const current = data();
  return updateSection('aeo', { faqs: current.aeo.faqs.filter((f) => f.id !== id) });
}

function setProductSeo(slug, patch) {
  const current = data();
  const products = { ...current.seo.products, [slug]: { ...(current.seo.products[slug] || {}), ...patch } };
  return updateSection('seo', { products });
}

function addFact({ label, value }) {
  const current = data();
  return updateSection('geo', { brandFacts: [...current.geo.brandFacts, { label: String(label).trim(), value: String(value).trim() }] });
}

function removeFact(index) {
  const current = data();
  return updateSection('geo', { brandFacts: current.geo.brandFacts.filter((_, i) => i !== Number(index)) });
}

module.exports = {
  AI_CRAWLERS, data, save, updateSection, origin,
  metaForProduct, metaForCategory, faqsFor, globalFaqs,
  organisationJsonLd, productJsonLd, faqJsonLd, breadcrumbJsonLd, articleJsonLd,
  sitemap, robots, llms, audit, merchantReviewFeed,
  addFaq, removeFaq, setProductSeo, addFact, removeFact
};
