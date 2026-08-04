'use strict';

/**
 * Audience sections — menswear, womenswear, kids.
 *
 * Two claims to defend. First, that the sections are genuinely separate: a
 * menswear visitor must not be shown a lehenga in the nav, the listing, the
 * facets, search or the homepage rails. Second — and this is the one that decides
 * whether the template is resaleable — that a client who sells to only ONE
 * audience sees no trace of the feature: no chooser, no switcher, no extra
 * configuration.
 *
 * The third rule is commercial: the choice is a preference, never a gate. A
 * direct link to any product opens whatever section the visitor is in, because a
 * shop does not hide a product from someone who was sent its URL.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sandbox } = require('./helpers/sandbox');

const PRODUCTS = [
  { id: 'w1', slug: 'bridal-lehenga', name: 'Bridal Lehenga', categories: ['bridal'], price: 100000, mrp: 120000,
    colors: ['Red'], sizes: ['S', 'M'], fabric: 'Silk', occasion: ['Wedding'], stock: 5, audience: 'women',
    images: ['/ph.svg'], createdAt: '2026-01-01', popularity: 90 },
  { id: 'w2', slug: 'festive-saree', name: 'Festive Saree', categories: ['sarees'], price: 20000, mrp: 24000,
    colors: ['Gold'], sizes: ['Free'], fabric: 'Banarasi', occasion: ['Festive'], stock: 5, audience: 'women',
    images: ['/ph.svg'], createdAt: '2026-02-01', popularity: 80 },
  { id: 'm1', slug: 'ivory-sherwani', name: 'Ivory Sherwani', categories: ['sherwani'], price: 90000, mrp: 110000,
    colors: ['Ivory'], sizes: ['40', '42'], fabric: 'Raw Silk', occasion: ['Wedding'], stock: 4, audience: 'men',
    images: ['/ph.svg'], createdAt: '2026-01-15', popularity: 95 },
  { id: 'm2', slug: 'kurta-set', name: 'Chikankari Kurta Set', categories: ['kurta-pyjama'], price: 12000, mrp: 14000,
    colors: ['Ivory'], sizes: ['40'], fabric: 'Cotton', occasion: ['Festive'], stock: 9, audience: 'men',
    images: ['/ph.svg'], createdAt: '2026-03-01', popularity: 70 },
  { id: 'k1', slug: 'boys-kurta', name: 'Boys Kurta Set', categories: ['boys-ethnic'], price: 6000, mrp: 7500,
    colors: ['Ivory'], sizes: ['4-5Y'], fabric: 'Silk', occasion: ['Festive'], stock: 6, audience: 'kids',
    images: ['/ph.svg'], createdAt: '2026-02-15', popularity: 60 },
  // Universal stock: no audience of its own.
  { id: 'u1', slug: 'gold-stole', name: 'Gold Stole', categories: ['sarees', 'sherwani'], price: 4000, mrp: 5000,
    colors: ['Gold'], sizes: ['Free'], fabric: 'Tissue', occasion: ['Festive'], stock: 20,
    images: ['/ph.svg'], createdAt: '2026-01-20', popularity: 50 }
];

const AUDIENCES = [
  { id: 'women', label: 'Womenswear', nav: [{ label: 'Bridal', slug: 'bridal' }, { label: 'Sarees', slug: 'sarees' }] },
  { id: 'men', label: 'Menswear', nav: [{ label: 'Sherwani', slug: 'sherwani' }, { label: 'Kurta Pyjama', slug: 'kurta-pyjama' }] },
  { id: 'kids', label: 'Kidswear', nav: [{ label: 'Boys Ethnic', slug: 'boys-ethnic' }] }
];

const base = sandbox({ products: PRODUCTS });
const multi = { ...base.config, audiences: { list: AUDIENCES } };
const single = { ...base.config, audiences: { list: [AUDIENCES[1]] } };   // menswear only
const none = { ...base.config, audiences: { list: [] } };

const audience = require('../src/audience');
const catalog = require('../src/catalog');

const req = (cookie, query) => ({ cookies: cookie ? { [audience.COOKIE]: cookie } : {}, query: query || {} });
const names = (list) => list.map((p) => p.name).sort();

/* ------------------------------------------------------------ resolution ---- */

test('a multi-audience shop asks, a single-audience shop never does', () => {
  assert.equal(audience.isMultiple(multi), true);
  assert.equal(audience.isMultiple(single), false, 'one section is not a choice');
  assert.equal(audience.isMultiple(none), false);

  assert.equal(audience.hasChosen(req(), multi), false, 'a first visit has not chosen');
  assert.equal(audience.hasChosen(req(), single), true, 'nothing to choose, so nothing to ask');
});

test('the cookie decides, and a bad cookie falls back instead of breaking', () => {
  assert.equal(audience.current(req('men'), multi).id, 'men');
  assert.equal(audience.current(req('kids'), multi).id, 'kids');
  assert.equal(audience.current(req('nonsense'), multi).id, 'women', 'falls back to the first');
  assert.equal(audience.current(req(), multi).id, 'women');
});

test('a link can land straight in a section, overriding the cookie', () => {
  // So a menswear ad campaign does not dump people in womenswear.
  assert.equal(audience.current(req('women', { audience: 'men' }), multi).id, 'men');
  assert.equal(audience.current(req('women', { audience: 'rubbish' }), multi).id, 'women');
});

test('a single-audience shop always resolves to its one section', () => {
  assert.equal(audience.current(req(), single).id, 'men');
  assert.equal(audience.current(req('women'), single).id, 'men', 'a stale cookie cannot pick a section that is gone');
});

/* ------------------------------------------------------------------ nav ---- */

test('the nav is the section’s nav, never the whole store', () => {
  assert.deepEqual(audience.navFor(req('men'), multi).map((n) => n.slug), ['sherwani', 'kurta-pyjama']);
  assert.deepEqual(audience.navFor(req('women'), multi).map((n) => n.slug), ['bridal', 'sarees']);
  assert.deepEqual(audience.navFor(req('kids'), multi).map((n) => n.slug), ['boys-ethnic']);
});

test('an audience with no nav of its own falls back to the store nav', () => {
  const halfConfigured = { ...base.config, audiences: { list: [{ id: 'x', label: 'X' }] } };
  assert.deepEqual(
    audience.navFor(req(), halfConfigured).map((n) => n.slug),
    (base.config.nav || []).map((n) => n.slug),
    'a half-filled config must still produce a working shop'
  );
});

/* ------------------------------------------------------------ catalogue ---- */

test('each section browses only its own pieces — plus universal stock', () => {
  assert.deepEqual(names(catalog.inCategory('all', 'women')), ['Bridal Lehenga', 'Festive Saree', 'Gold Stole']);
  assert.deepEqual(names(catalog.inCategory('all', 'men')), ['Chikankari Kurta Set', 'Gold Stole', 'Ivory Sherwani']);
  assert.deepEqual(names(catalog.inCategory('all', 'kids')), ['Boys Kurta Set', 'Gold Stole']);
});

test('no audience means the whole catalogue, so the admin still sees everything', () => {
  assert.equal(catalog.inCategory('all').length, PRODUCTS.length);
});

test('a category from another section comes back empty rather than leaking', () => {
  assert.deepEqual(names(catalog.inCategory('bridal', 'men')), [], 'a menswear visitor gets no bridal pieces');
  assert.deepEqual(names(catalog.inCategory('sherwani', 'women')), ['Gold Stole'], 'only the universal piece');
});

test('search, facets and the homepage rails all follow the section', () => {
  const filters = catalog.parseQuery({});

  const menResults = catalog.search('all', filters, 50, 'men');
  assert.deepEqual(names(menResults.items), ['Chikankari Kurta Set', 'Gold Stole', 'Ivory Sherwani']);

  // A facet value that only exists in womenswear must not be offered to menswear.
  const menFabrics = catalog.facets('all', 'men').fabric.map((f) => f.value);
  assert.ok(!menFabrics.includes('Banarasi'), 'Banarasi is womenswear here: ' + menFabrics);
  assert.ok(menFabrics.includes('Raw Silk'));

  assert.ok(!names(catalog.bestsellers(8, 'men')).includes('Bridal Lehenga'));
  assert.ok(!names(catalog.newArrivals(8, 'men')).includes('Festive Saree'));
});

test('suggestions do not offer a piece from another section', () => {
  const inMen = catalog.suggest('lehenga', multi, 6, 'men');
  assert.deepEqual(names(inMen.products), [], 'no lehenga for a menswear visitor');

  const inWomen = catalog.suggest('lehenga', multi, 6, 'women');
  assert.deepEqual(names(inWomen.products), ['Bridal Lehenga']);
});

test('related products stay in the PRODUCT’s section, not the visitor’s', () => {
  // Someone sent a men's sherwani link should get sherwani suggestions, whatever
  // section their cookie says they were browsing.
  const sherwani = PRODUCTS.find((p) => p.id === 'm1');
  const rel = names(catalog.related(sherwani, 8));
  assert.ok(!rel.includes('Bridal Lehenga'), 'related leaked into womenswear: ' + rel);
});

/* ----------------------------------------------------------- over HTTP ---- */

let server;
let base_url;
const jar = new Map();

async function get(path, useJar = true) {
  const res = await fetch(base_url + path, {
    redirect: 'manual',
    headers: useJar ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}
  });
  (res.headers.getSetCookie ? res.headers.getSetCookie() : []).forEach((line) => {
    const [pair] = line.split(';');
    const i = pair.indexOf('=');
    jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  });
  return { status: res.status, text: await res.text() };
}

async function pick(id) {
  const res = await fetch(base_url + '/audience', {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ audience: id, next: '/' }).toString()
  });
  (res.headers.getSetCookie ? res.headers.getSetCookie() : []).forEach((line) => {
    const [pair] = line.split(';');
    const i = pair.indexOf('=');
    jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  });
  return res.status;
}

before(async () => {
  // The live config has three audiences, which is what these assertions expect.
  const app = require('../server');
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base_url = `http://127.0.0.1:${server.address().port}`;
});
after(() => { if (server) server.close(); });

test('a first visit is asked once, and never again after choosing', async () => {
  jar.clear();
  const first = await get('/');
  assert.match(first.text, /What are you shopping for/i, 'a first visit should be asked');

  assert.equal(await pick('men'), 302);
  const second = await get('/');
  assert.doesNotMatch(second.text, /What are you shopping for/i, 'asked twice is a bug');
});

test('choosing a section changes the nav that is rendered', async () => {
  jar.clear();
  await pick('men');
  const men = await get('/');
  assert.match(men.text, /category\/sherwani/, 'menswear nav missing');

  await pick('women');
  const women = await get('/');
  assert.match(women.text, /category\/bridal/, 'womenswear nav missing');
});

test('a listing page in the wrong section shows nothing rather than leaking', async () => {
  jar.clear();
  await pick('men');
  const bridal = await get('/category/bridal');
  assert.equal(bridal.status, 200, 'the page still exists');
  assert.doesNotMatch(bridal.text, /Bridal Lehenga/, 'a womenswear piece leaked into menswear');
});

test('a direct product link always opens, whatever section you are in', async () => {
  // The rule that keeps this a preference and not a gate: a womenswear piece
  // opens for someone whose cookie says kidswear, because they were sent the URL.
  jar.clear();
  await pick('kids');
  const res = await get('/product/bridal-lehenga');
  assert.equal(res.status, 200, 'a shared link must never 404 because of a cookie');
  assert.match(res.text, /Add to bag/i, 'and it must still be buyable');
});

test('an unknown section id is refused without breaking the page', async () => {
  jar.clear();
  const res = await fetch(base_url + '/audience', {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ audience: 'martians', next: '/' }).toString()
  });
  assert.equal(res.status, 302);
  assert.equal((await get('/')).status, 200);
});

test('the next parameter cannot be used to send someone off-site', async () => {
  jar.clear();
  const res = await fetch(base_url + '/audience', {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ audience: 'men', next: '//evil.example/steal' }).toString()
  });
  assert.equal(res.status, 302);
  const location = res.headers.get('location') || '';
  assert.ok(!location.includes('evil.example'), 'open redirect: ' + location);
});

/* ------------------------------------------------- shopping for more than one ---- */

/**
 * "Everything" had to become a real answer.
 *
 * A shop selling menswear and womenswear has customers buying for a whole family in
 * one order. Before this the only answers were "men", "women" or "kids", so a mother
 * buying a sherwani for her son and a saree for herself had to keep flipping — and on
 * a phone she could not flip at all, because the switcher was rendered lg:flex only.
 * The welcome popup was therefore a one-way door on the device most of these shoppers
 * use.
 */
test('"everything" means no audience in force, so the whole catalogue shows', () => {
  assert.equal(audience.current(req('all'), multi), null, 'no audience = no filter');

  const everything = catalog.all().filter((p) => audience.matches(p, null));
  assert.equal(everything.length, catalog.all().length);
  assert.deepEqual(names(everything), names(catalog.all()));
});

test('"everything" counts as having chosen, so the popup stops asking', () => {
  assert.equal(audience.hasChosen(req('all'), multi), true);
  assert.equal(audience.isEverything(req('all'), multi), true);

  // A section is a choice too, but it is not "everything".
  assert.equal(audience.isEverything(req('men'), multi), false);
  // And never asked at all is still unchosen.
  assert.equal(audience.hasChosen(req(), multi), false);
});

test('choosing everything stores it, so the shop stays that way', () => {
  const jar = {};
  const res = { cookie: (k, v) => { jar[k] = v; } };
  const r = req();

  const picked = audience.choose(r, res, multi, audience.EVERYTHING);
  assert.equal(picked, null, 'null is the answer, not a failure');
  assert.equal(jar[audience.COOKIE], 'all', 'it must survive the next request');
  assert.equal(audience.current(r, multi), null);
});

test('a section can still be chosen after everything, and the other way round', () => {
  const jar = {};
  const res = { cookie: (k, v) => { jar[k] = v; } };
  const r = req();

  audience.choose(r, res, multi, audience.EVERYTHING);
  assert.equal(audience.current(r, multi), null);

  const men = audience.choose(r, res, multi, 'men');
  assert.equal(men.id, 'men', 'the door must open both ways');
  assert.equal(audience.current(r, multi).id, 'men');

  audience.choose(r, res, multi, audience.EVERYTHING);
  assert.equal(audience.current(r, multi), null);
});

test('a one-audience shop has nothing to switch, and says so', () => {
  // No chooser, no "everything", nothing to explain — the feature stays invisible.
  assert.equal(audience.isMultiple(single), false);
  assert.equal(audience.isEverything(req('all'), single), false);
  assert.equal(audience.current(req('all'), single).id, 'men', 'a single-audience shop ignores it');
});

test('a nonsense cookie is not mistaken for everything', () => {
  assert.equal(audience.current(req('everything'), multi).id, 'women', 'falls back, not wide open');
  assert.equal(audience.isEverything(req('everything'), multi), false);
});

test('"everything" gets a menu that means everything', () => {
  /* navFor fell back to config.nav when no audience was in force, which is the
     womenswear list — so a man browsing "Everything" had no Sherwani link under a
     heading claiming the whole shop. */
  const menu = audience.navFor(req('all'), multi);
  const slugs = menu.map((x) => x.slug);

  AUDIENCES.forEach((a) => {
    (a.nav || []).forEach((item) => {
      assert.ok(slugs.includes(item.slug), `${item.slug} is missing from the combined menu`);
    });
  });
  assert.equal(slugs.length, new Set(slugs).size, 'two audiences can share a category — list it once');
});

test('one section still gets only its own menu', () => {
  const men = audience.navFor(req('men'), multi).map((x) => x.slug);
  assert.deepEqual(men, ['sherwani', 'kurta-pyjama']);
  assert.equal(men.includes('bridal'), false, 'a menswear shopper should not be shown bridal');
});

test('a shop with no per-audience menus still gets a working one', () => {
  const bare = { ...base.config, audiences: { list: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] } };
  assert.deepEqual(audience.navFor(req('all'), bare), bare.nav || []);
});
