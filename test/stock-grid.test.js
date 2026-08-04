'use strict';

/**
 * The admin stock grid, over HTTP.
 *
 * The unit tests in variants.test.js prove the maths. This file proves the owner
 * can actually reach it: that every size gets a box even when nobody has ever
 * counted it, that typing a number sticks, that clearing a box means "not
 * counted" rather than "zero", and that the storefront agrees straight away.
 *
 * The pre-fill matters more than it looks. A size with no row reads as sold out
 * to a shopper, so a grid that only showed the sizes already counted would hide
 * the one box the owner needed to type in — and they would have no way to guess
 * why that size had vanished from their own shop.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sandbox } = require('./helpers/sandbox');

sandbox();

const auth = require('../src/auth');
const catalog = require('../src/catalog');
const variants = require('../src/variants');

let server;
let base;
const jar = new Map();

function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function req(method, path, body) {
  const res = await fetch(base + path, {
    method,
    redirect: 'manual',
    headers: {
      cookie: cookieHeader(),
      ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {})
    },
    body: body ? new URLSearchParams(body).toString() : undefined
  });
  (res.headers.getSetCookie ? res.headers.getSetCookie() : []).forEach((line) => {
    const [pair] = line.split(';');
    const i = pair.indexOf('=');
    jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  });
  return { status: res.status, text: await res.text() };
}
const get = (p) => req('GET', p);
const post = (p, b) => req('POST', p, b);

/** Reads the product back from disk, past the catalogue cache. */
function fresh(id) {
  catalog.invalidate();
  return catalog.all().find((p) => p.id === id);
}

/** The sticky bar's markup: from its own data-stock (the second on the page) on. */
function stickyBar(html) {
  const first = html.indexOf("data-stock='");
  const mine = html.indexOf("data-stock='", first + 1);
  // The class attribute sits after the x-data block, so anchoring on z-[71] would
  // cut off the handlers being asserted.
  return mine < 0 ? '' : html.slice(mine);
}

/** Undoes EJS's attribute escaping, the way a browser's parser would. */
function unescapeXml(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"').replace(/&#x27;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const setCell = (id, size, color, stock) =>
  post(`/admin/products/${id}/variant-stock`, { size, color: color || '', count: stock });

before(async () => {
  auth.createUser({ name: 'Owner', email: 'owner@test.example', password: 'OwnerPass4242', role: 'owner' });
  auth.createUser({ name: 'Staff', email: 'staff@test.example', password: 'StaffPass4242', role: 'staff' });

  server = require('../server').listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  await post('/admin/login', { email: 'owner@test.example', password: 'OwnerPass4242' });
});

after(() => { if (server) server.close(); });

/* --------------------------------------------------------------- the grid ---- */

test('the edit page offers a box for every size × colour, counted or not', async () => {
  const res = await get('/admin/products/p001');
  assert.equal(res.status, 200);

  // p001 has never had a variant row: 3 sizes × 2 colours must still be typable.
  const p = fresh('p001');
  assert.equal(variants.tracksVariants(p), false, 'fixture should start untracked');

  p.sizes.forEach((size) => {
    p.colors.forEach((color) => {
      assert.match(
        res.text,
        new RegExp(`aria-label="Stock for ${size} in ${color}"`),
        `no box for ${size} · ${color} — that size would read as sold out with no way to fix it`
      );
    });
  });
});

test('a product with no colours still gets one column, not an empty grid', async () => {
  // p002 has a single colourway; the grid must not collapse to nothing.
  const res = await get('/admin/products/p002');
  assert.equal(res.status, 200);
  assert.match(res.text, /aria-label="Stock for Free/);
});

test('typing a count saves it and the total adds up', async () => {
  const res = await setCell('p001', 'S', 'Red', 7);
  assert.equal(res.status, 200);
  // The whole grid comes back so the totals move with the edit.
  assert.match(res.text, /id="stock-grid-p001"/);

  await setCell('p001', 'M', 'Red', 3);

  const p = fresh('p001');
  assert.equal(variants.stockFor(p, { size: 'S', color: 'Red' }), 7);
  assert.equal(variants.stockFor(p, { size: 'M', color: 'Red' }), 3);
  assert.equal(variants.totalStock(p), 10, 'total must be the sum of the counted rows');
  assert.equal(p.stock, 10, 'the headline number must follow, or old screens lie');
});

test('zero is a real answer — the size is stocked but sold out', async () => {
  await setCell('p001', 'XS', 'Red', 0);

  const p = fresh('p001');
  assert.equal(variants.stockFor(p, { size: 'XS', color: 'Red' }), 0);
  assert.equal(variants.sizeAvailability(p).find((s) => s.size === 'XS').available, false);
});

test('clearing a box means "not counted", which is not the same as zero', async () => {
  await setCell('p001', 'S', 'Gold', 5);
  assert.equal(variants.stockFor(fresh('p001'), { size: 'S', color: 'Gold' }), 5);

  await setCell('p001', 'S', 'Gold', '');   // emptied

  const p = fresh('p001');
  const row = (p.variants || []).find((v) => v.size === 'S' && v.color === 'Gold');
  assert.equal(row, undefined, 'the row should be gone, not set to 0');
  // It falls back to the size-only row, so the size is still buyable in Red.
  assert.equal(variants.stockFor(p, { size: 'S', color: 'Red' }), 7);
});

test('a size nobody counted cannot be bought, and the grid is the only place to fix that', async () => {
  const p = fresh('p001');
  // p001 tracks variants now, so an uncounted combination is not for sale.
  assert.equal(variants.stockFor(p, { size: 'XS', color: 'Gold' }), 0);

  await setCell('p001', 'XS', 'Gold', 4);
  assert.equal(variants.stockFor(fresh('p001'), { size: 'XS', color: 'Gold' }), 4);
});

test('the storefront agrees with the grid immediately', async () => {
  await setCell('p001', 'M', 'Red', 0);
  await setCell('p001', 'M', 'Gold', 0);

  const page = await get('/product/test-lehenga');
  assert.equal(page.status, 200);

  const map = /data-stock='([^']+)'/.exec(page.text);
  assert.ok(map, 'the product page must carry a stock map');
  // EJS escapes the JSON's quotes for the attribute; a browser reads them back.
  const stock = JSON.parse(unescapeXml(map[1]));
  assert.equal(stock['m|red'], 0, 'a size zeroed in admin must read 0 on the storefront');
  assert.equal(stock['s|red'], 7);
});

test('a negative count is floored at zero rather than stored', async () => {
  await setCell('p001', 'S', 'Red', -5);
  assert.equal(variants.stockFor(fresh('p001'), { size: 'S', color: 'Red' }), 0);
  await setCell('p001', 'S', 'Red', 7);   // put it back for the tests below
});

test('a request with no size is refused instead of writing a junk row', async () => {
  const before = (fresh('p001').variants || []).length;
  const res = await post('/admin/products/p001/variant-stock', { size: '', color: 'Red', count: 5 });
  assert.equal(res.status, 400);
  assert.equal((fresh('p001').variants || []).length, before);
});

test('an unknown product is a 404, not a crash', async () => {
  const res = await setCell('p999', 'S', 'Red', 5);
  assert.equal(res.status, 404);
});

/* ------------------------------------------------------------ permissions ---- */

test('staff cannot rewrite stock through the grid endpoint', async () => {
  jar.clear();
  await post('/admin/login', { email: 'staff@test.example', password: 'StaffPass4242' });

  const before = variants.stockFor(fresh('p001'), { size: 'S', color: 'Red' });
  const res = await setCell('p001', 'S', 'Red', 999);
  assert.equal(res.status, 403, 'the products section is owner/manager work');
  assert.equal(variants.stockFor(fresh('p001'), { size: 'S', color: 'Red' }), before);

  jar.clear();
  await post('/admin/login', { email: 'owner@test.example', password: 'OwnerPass4242' });
});

/* ----------------------------------------------------------- buying list ---- */

test('the grid names what is out and what is running low', async () => {
  const res = await get('/admin/products/p001');
  assert.match(res.text, /Sold out:/);
  assert.match(res.text, /M · Red|M · Gold/);
});

/* ------------------------------------------------ stock through a CSV import ---- */

/**
 * Before this column existed the importer set no stock at all, which left every
 * imported piece "untracked" — and untracked means buyable without limit. A
 * hundred-row catalogue could be oversold on all hundred rows. It now defaults to
 * zero and says so in the preview, because an owner correcting a sold-out listing
 * loses a sale, while one shipping stock they never had loses the customer.
 */
const importer = require('../src/importer');

test('a per-size column becomes real variants, and the total is derived from it', () => {
  const p = importer.shape(
    { name: 'Imported Kurta', price: '2000', categories: 'kurtas', sizes: 'S|M|L', variantStock: 'S:4|M:2|L:0' },
    { today: '2026-08-04' }
  );

  assert.deepEqual(p.variants, [
    { size: 'S', stock: 4 }, { size: 'M', stock: 2 }, { size: 'L', stock: 0 }
  ]);
  assert.equal(p.stock, 6, 'the headline number must be the sum, never a second thing to keep in step');
});

test('a count can differ by colour', () => {
  assert.deepEqual(importer.toVariants('S/Red:4|S/Gold:2'), [
    { size: 'S', stock: 4, color: 'Red' }, { size: 'S', stock: 2, color: 'Gold' }
  ]);
});

test('the per-size column wins over a single stock number', () => {
  const p = importer.shape(
    { name: 'X', price: '100', categories: 'kurtas', sizes: 'S|M', stock: '99', variantStock: 'S:1|M:1' },
    { today: '2026-08-04' }
  );
  assert.equal(p.stock, 2);
});

test('a plain stock column still works, and is floored at zero', () => {
  const shape = (stock) => importer.shape(
    { name: 'X', price: '100', categories: 'kurtas', sizes: 'S', stock }, { today: '2026-08-04' }
  );
  assert.equal(shape('7').stock, 7);
  assert.equal(shape('-3').stock, 0);
  assert.equal(shape('').stock, 0, 'no stock means none in hand, not unlimited');
});

test('an imported row with no stock cannot be oversold', () => {
  const p = importer.shape(
    { name: 'X', price: '100', categories: 'kurtas', sizes: 'S' }, { today: '2026-08-04' }
  );
  // The old behaviour left stock undefined, which variants.js reads as untracked.
  assert.notEqual(p.stock, undefined);
  assert.equal(variants.stockFor(p, { size: 'S' }), 0);
});

test('counting a size that is not on sale is an error, not a silent orphan', () => {
  const raw = { name: 'X', price: '100', categories: 'kurtas', sizes: 'S|M', variantStock: 'S:4|XXL:2' };
  const p = importer.shape(raw, { today: '2026-08-04' });
  const { errors } = importer.validate(p, raw);
  assert.ok(errors.some((e) => /XXL/.test(e)), `expected an error naming XXL, got ${JSON.stringify(errors)}`);
});

test('a listed size left out of the count is warned about, not rejected', () => {
  const raw = { name: 'X', price: '100', categories: 'kurtas', sizes: 'S|M|L', variantStock: 'S:4' };
  const p = importer.shape(raw, { today: '2026-08-04' });
  const { errors, warnings } = importer.validate(p, raw);
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => /M, L/.test(w) && /sold out/.test(w)), JSON.stringify(warnings));
});

test('an unreadable per-size column is flagged instead of quietly ignored', () => {
  const raw = { name: 'X', price: '100', categories: 'kurtas', sizes: 'S', variantStock: 'nonsense' };
  const p = importer.shape(raw, { today: '2026-08-04' });
  const { warnings } = importer.validate(p, raw);
  assert.ok(warnings.some((w) => /could not be read/.test(w)), JSON.stringify(warnings));
});

test('the downloadable template offers both columns', () => {
  const [header] = importer.templateCsv().split('\n');
  assert.ok(header.split(',').includes('stock'));
  assert.ok(header.split(',').includes('variantStock'));
});

/* ---------------------------------------------------------- restock list ---- */

const analytics = require('../src/analytics');
const { loadConfig } = require('../src/config');

test('the restock list names the size, not just the piece', async () => {
  // p001 is healthy overall but empty in M — the case a product total hides.
  await setCell('p001', 'XS', 'Red', 40);
  await setCell('p001', 'S', 'Red', 40);
  await setCell('p001', 'M', 'Red', 0);
  await setCell('p001', 'M', 'Gold', 0);

  const p = fresh('p001');
  assert.ok(variants.totalStock(p) > 80, 'the piece should look healthy on a total');

  const rows = analytics.lowStockVariants(loadConfig());
  const m = rows.filter((r) => r.productId === 'p001' && /^M/.test(r.label));
  assert.equal(m.length, 2, `M should be listed in both colours, got ${JSON.stringify(rows)}`);
  assert.ok(m.every((r) => r.outOfStock));

  // And the whole-product list must NOT flag it, which is exactly the blind spot.
  assert.equal(analytics.lowStock(loadConfig()).some((x) => x.id === 'p001'), false);
});

test('a piece that does not count sizes still appears, as one row', () => {
  // p003 has stock 0 and no variant rows.
  const rows = analytics.lowStockVariants(loadConfig());
  const row = rows.find((r) => r.productId === 'p003');
  assert.ok(row, 'an untracked piece must not fall out of the restock list');
  assert.equal(row.label, 'All sizes');
  assert.equal(row.tracked, false);
});

test('the reports page renders the list without blowing up', async () => {
  const res = await get('/admin/reports');
  assert.equal(res.status, 200);
  assert.match(res.text, /Restock list/);
  assert.match(res.text, /By size/);
});

/* ------------------------------------------------ row totals must not double ---- */

/**
 * Found in the browser, not in a test: the grid showed 12 pieces in the footer
 * while its own row totals added up to 24. A size counted WITHOUT a colour shows
 * the same number under every colour column, so summing the cells on screen counts
 * it once per colour. A stock screen that disagrees with itself is worse than no
 * stock screen, because the owner buys against it.
 */
test('a size counted across all colours is not counted once per colour', () => {
  const p = {
    sizes: ['S', 'M'], colors: ['Red', 'Gold'],
    variants: [{ size: 'S', stock: 6 }, { size: 'M', stock: 2, color: 'Red' }, { size: 'M', stock: 3, color: 'Gold' }]
  };

  assert.equal(variants.sizeTotal(p, 'S'), 6, 'one shared row, not 6 per colour');
  assert.equal(variants.sizeTotal(p, 'M'), 5, 'two colour rows do add up');
  assert.equal(variants.sizeTotal(p, 'L'), null, 'an uncounted size is not zero');

  // The row totals must reconcile to the product total the footer prints.
  const rowSum = p.sizes.reduce((t, s) => t + (variants.sizeTotal(p, s) || 0), 0);
  assert.equal(rowSum, variants.totalStock(p), 'the grid must agree with itself');
});

test('the rendered grid reconciles to its own footer total', async () => {
  const res = await get('/admin/products/p001');
  const p = fresh('p001');
  const rowSum = p.sizes.reduce((t, s) => t + (variants.sizeTotal(p, s) || 0), 0);
  assert.equal(rowSum, variants.totalStock(p));
  assert.match(res.text, new RegExp(`<strong class="ml-1.5 text-ink">${variants.totalStock(p)}</strong>`));
});

/* --------------------------------------------- what the browser caught ---- */

/**
 * A count typed as 9 saved as 0.
 *
 * The input carried both hx-include="this" and its own name, so HTMX sent the
 * field twice — "9" and "" — which Express hands over as an array. Stringifying
 * that gave "9,", which parsed to NaN, which stored 0. The owner saw a toast
 * confirming the save and their best-selling size went sold out.
 *
 * The duplicate is gone from the template; these prove the route no longer
 * depends on that being true.
 */
test('a duplicated field keeps the number the owner typed', async () => {
  const res = await fetch(`${base}/admin/products/p002/variant-stock`, {
    method: 'POST',
    headers: { cookie: cookieHeader(), 'content-type': 'application/x-www-form-urlencoded' },
    // Exactly what the double-send produced.
    body: 'size=Free&color=&count=9&count='
  });
  assert.equal(res.status, 200);
  assert.equal(variants.stockFor(fresh('p002'), { size: 'Free' }), 9, 'the typed 9 must survive');
});

test('a count that is not a number is refused, never stored as zero', async () => {
  await setCell('p002', 'Free', '', 9);

  const res = await post('/admin/products/p002/variant-stock', { size: 'Free', color: '', count: 'abc' });
  assert.equal(res.status, 400);
  assert.equal(variants.stockFor(fresh('p002'), { size: 'Free' }), 9, 'the old count must stand');
});

test('the template does not send the field twice any more', () => {
  const tpl = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'views', 'admin', 'fragments', 'stock-grid.ejs'), 'utf8'
  );
  assert.doesNotMatch(tpl, /hx-include="this"/, 'HTMX already sends a named input value');
});

/**
 * The second browser find, and the worse one.
 *
 * The grid sits inside the product edit form, and HTMX sends the whole enclosing
 * form with every request from a control inside it. The cells were named "stock" —
 * the same name as the headline Stock field — so each cell edit arrived carrying
 * two values, and the form's number won. Clearing a box wrote 12 into it.
 *
 * Nothing about that was visible: the toast confirmed a save, and the number it
 * confirmed was one the owner never typed.
 */
test('the form around the grid cannot leak its own Stock field into a cell', async () => {
  await setCell('p002', 'Free', '', 9);

  // Exactly what HTMX sent: the whole edit form, plus the cell.
  const res = await fetch(`${base}/admin/products/p002/variant-stock`, {
    method: 'POST',
    headers: { cookie: cookieHeader(), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      size: 'Free', color: '',
      count: '',                    // the cell being cleared
      stock: '12',                  // the form's headline field, along for the ride
      name: 'Test Saree', price: '5000'
    }).toString()
  });
  assert.equal(res.status, 200);

  const row = (fresh('p002').variants || []).find((v) => v.size === 'Free');
  assert.equal(row, undefined, 'clearing must clear — not store the form\u2019s number');
});

test('the cells are named apart from the form field they sit beside', () => {
  const tpl = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'views', 'admin', 'fragments', 'stock-grid.ejs'), 'utf8'
  );
  assert.match(tpl, /name="count"/);
  assert.doesNotMatch(tpl, /name="stock"/, 'that name belongs to the edit form, not the grid');
  assert.match(tpl, /hx-params="count,size,color,token"/, 'pin the payload so the form cannot ride along');
});

/* -------------------------------------------------------------- quick view ---- */

/**
 * Quick view could never oversell — /cart/add refuses a bad size either way — but
 * it could show a sold-out size as available for the second before that refusal,
 * which reads as a broken shop rather than a busy one.
 */
test('quick view knows what is left, like the product page does', async () => {
  await setCell('p001', 'XS', 'Red', 5);
  await setCell('p001', 'S', 'Red', 0);

  const res = await get('/fragments/quick-view/test-lehenga');
  assert.equal(res.status, 200);

  const map = /data-stock='([^']+)'/.exec(res.text);
  assert.ok(map, 'quick view must carry a stock map');
  const stock = JSON.parse(unescapeXml(map[1]));
  assert.equal(stock['s|red'], 0);
  assert.equal(stock['xs|red'], 5);

  // It opens on a size that can be bought, not on whichever is listed first.
  assert.match(res.text, /size: 'XS'/);
  assert.match(res.text, /Sold out in/);
});

/* -------------------------------------------------------- the sticky bar ---- */

/**
 * The sticky buy bar is its own Alpine scope, and it knew nothing about stock: the
 * picker above disabled a sold-out size while the bar below still offered "Add to
 * bag" for it. Reported from the shop, not caught here, because the bar's behaviour
 * is client-side and these tests do not run Alpine.
 *
 * What they can hold is the contract in the markup — the bar carries the stock map,
 * gates both buttons on it, and reads the colour as well as the size. That is enough
 * to fail if the gate is ever taken back out.
 */
test('the sticky bar carries the stock map and gates its buttons on it', async () => {
  const res = await get('/product/test-lehenga');
  assert.equal(res.status, 200);

  // Two maps: one for the picker, one for the bar's separate scope.
  assert.equal((res.text.match(/data-stock='/g) || []).length, 2,
    'the bar needs its own copy — it cannot see the picker\u2019s state');

  const bar = stickyBar(res.text);
  assert.match(bar, /x-show="canBuy\(\)"/, 'Add to bag must be gated');
  assert.match(bar, /x-show="!canBuy\(\)"/, 'and a dead Sold out shown instead');
  assert.match(bar, /Sold out/);
});

test('the sticky bar follows the colour too, not just the size', async () => {
  const res = await get('/product/test-lehenga');
  const bar = stickyBar(res.text);
  assert.match(bar, /input\[name=color\]/, 'a sold-out colour was equally addable');
});

test('the sticky bar reads the form after Alpine has written to it', async () => {
  const res = await get('/product/test-lehenga');
  const bar = stickyBar(res.text);
  /* The hidden inputs are bound to the picker's scope, so reading them during the
     click event read the PREVIOUS size — the bar sat one selection behind. Harmless
     while it only printed a label; not harmless once it decides whether Add to bag
     appears. */
  assert.match(bar, /\$nextTick\(\(\) => readSize\(\)\)/, 'read after the flush, not during the click');
  assert.doesNotMatch(bar, /@click\.window="readSize\(\)"/);
});
