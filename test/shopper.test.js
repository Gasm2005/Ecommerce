'use strict';

/**
 * The returning customer, without an account.
 *
 * Two things are being proved here, and the second matters more than the first.
 *
 * The convenience: a shopper who bought once has their address filled in next time,
 * can pick between the addresses they have used, and can say "not me" in one click.
 *
 * The privacy: order ids run in sequence, so ORD-00042 tells anyone that ORD-00041
 * exists. Before this, walking those numbers read back what strangers had paid. The
 * cookie that decides which orders are "yours" is therefore SIGNED — an unsigned one
 * would let anyone list someone else's purchase by typing a number into their own
 * cookie, which is a worse hole than the one it was closing.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sandbox } = require('./helpers/sandbox');

sandbox();

const shopper = require('../src/shopper');
const ordersStore = require('../src/orders');
const catalog = require('../src/catalog');

let server;
let base;
let jar = new Map();

function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function req(method, path, body, { jarOverride } = {}) {
  const bag = jarOverride || jar;
  const res = await fetch(base + path, {
    method,
    redirect: 'manual',
    headers: {
      cookie: [...bag.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
      ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {})
    },
    body: body ? new URLSearchParams(body).toString() : undefined
  });
  (res.headers.getSetCookie ? res.headers.getSetCookie() : []).forEach((line) => {
    const [pair] = line.split(';');
    const i = pair.indexOf('=');
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    if (value === '') bag.delete(name); else bag.set(name, value);
  });
  return { status: res.status, headers: res.headers, text: await res.text() };
}
const get = (p, o) => req('GET', p, undefined, o);
const post = (p, b, o) => req('POST', p, b, o);

before(async () => {
  server = require('../server').listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { if (server) server.close(); });

const ADDRESS = {
  _from: '1',
  fullName: 'Test Buyer',
  phone: '9820000000',
  email: 'buyer@test.example',
  address1: '1 Test Road',
  pincode: '400001',
  city: 'Mumbai',
  state: 'Maharashtra',
  country: 'India'
};

/** Walks a whole order and returns its id. */
async function placeOrder(address = ADDRESS, opts = {}) {
  const product = catalog.all().find((p) => p.id === 'p001');
  await post('/cart/add', { id: product.id, size: 'XS', color: 'Red', qty: 1 }, opts);
  await post('/checkout/step/2', address, opts);
  await post('/checkout/step/3', { _from: '2', deliveryMethod: 'standard' }, opts);
  const placed = await post('/checkout/place-order', { _from: '3', paymentMethod: 'upi' }, opts);
  const id = (placed.headers.get('hx-redirect') || '').split('/').pop();
  assert.match(id || '', /^ORD-/, 'the order should have been placed');
  return id;
}

/* ------------------------------------------------------------ the cookie ---- */

test('the cookie is signed, so its contents cannot be rewritten', () => {
  const mine = { name: 'Real Buyer', email: '', phone: '', orderIds: ['ORD-00001'], addresses: [] };
  const cookie = shopper.encode(mine);

  assert.deepEqual(shopper.decode(cookie), mine, 'a cookie we signed must read back');

  // Someone editing the payload to claim another order gets nothing.
  const body = cookie.slice(0, cookie.lastIndexOf('.'));
  const forgedBody = Buffer.from(
    JSON.stringify({ ...mine, orderIds: ['ORD-00002'] }), 'utf8'
  ).toString('base64url');
  const forged = `${forgedBody}.${cookie.slice(cookie.lastIndexOf('.') + 1)}`;

  assert.equal(shopper.decode(forged), null, 'a rewritten payload must not verify');
  assert.equal(shopper.decode(`${body}.notasignature`), null);
  assert.equal(shopper.decode(''), null);
  assert.equal(shopper.decode('nodothere'), null);
});

test('a forged signature of the wrong length is rejected, not thrown on', () => {
  // timingSafeEqual throws when the buffers differ in length; that must be caught.
  const cookie = shopper.encode(shopper.blank());
  const body = cookie.slice(0, cookie.lastIndexOf('.'));
  assert.doesNotThrow(() => shopper.decode(`${body}.x`));
  assert.equal(shopper.decode(`${body}.x`), null);
});

/* ------------------------------------------------ the leak this closed ---- */

test('a stranger cannot read an order by guessing the number', async () => {
  jar = new Map();
  const id = await placeOrder();

  // Same browser: fine.
  const mine = await get(`/order/${id}`);
  assert.equal(mine.status, 200);

  // A different browser, with no claim to it.
  const stranger = new Map();
  const theirs = await get(`/order/${id}`, { jarOverride: stranger });
  assert.equal(theirs.status, 302, 'ids run in sequence — guessing one must not pay off');
  assert.match(theirs.headers.get('location') || '', /^\/returns\?order=/);
});

test('the real customer still gets in from another device, with their contact', async () => {
  jar = new Map();
  const id = await placeOrder();

  const stranger = new Map();
  const withContact = await get(`/order/${id}?contact=${encodeURIComponent(ADDRESS.email)}`, { jarOverride: stranger });
  assert.equal(withContact.status, 200, 'the person who placed it must not be locked out');

  const wrong = await get(`/order/${id}?contact=someone.else@test.example`, { jarOverride: stranger });
  assert.equal(wrong.status, 302);
});

test('the returns page says why it asked, instead of looking broken', async () => {
  const res = await get('/returns?order=ORD-00001');
  assert.equal(res.status, 200);
  assert.match(res.text, /placed from this device/);
  assert.match(res.text, /value="ORD-00001"/, 'the number should be carried over, not retyped');
});

/* ----------------------------------------------------- being remembered ---- */

test('placing an order teaches this browser who it is', async () => {
  jar = new Map();
  const id = await placeOrder();

  const raw = jar.get(shopper.COOKIE);
  assert.ok(raw, 'the shopper cookie must be set when an order is placed');

  const me = shopper.decode(decodeURIComponent(raw));
  assert.equal(me.name, ADDRESS.fullName);
  assert.equal(me.phone, ADDRESS.phone);
  assert.equal(me.email, ADDRESS.email);
  assert.deepEqual(me.orderIds, [id]);
  assert.equal(me.addresses.length, 1);
  assert.equal(me.addresses[0].address1, ADDRESS.address1);
});

test('the next checkout starts with the address already in it', async () => {
  // Cart is empty after the last order, so fill it again — same browser.
  const product = catalog.all().find((p) => p.id === 'p001');
  await post('/cart/add', { id: product.id, size: 'XS', color: 'Red', qty: 1 });

  const page = await get('/checkout');
  assert.equal(page.status, 200);
  assert.match(page.text, /value="1 Test Road"/);
  assert.match(page.text, /value="400001"/);
  assert.match(page.text, /Welcome back, Test/);
  assert.match(page.text, /Not you\? Start fresh/);
});

test('"not you" clears the address rather than half of it', async () => {
  const res = await post('/checkout/forget', { _from: '1' });
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /value="1 Test Road"/);
  assert.doesNotMatch(res.text, /value="400001"/);
  assert.doesNotMatch(res.text, /Welcome back/);
  assert.equal(jar.get(shopper.COOKIE), undefined, 'the cookie itself must be dropped');
});

test('a half-typed address is never overwritten by a remembered one', () => {
  const me = { name: 'Old Name', email: 'old@test.example', phone: '', addresses: [
    { fullName: 'Old Name', address1: 'Old Road', pincode: '400001', city: 'Mumbai' }
  ] };

  const filled = shopper.prefill({ address1: 'New Road' }, me);
  assert.equal(filled.address1, 'New Road', 'the field they are editing must stand');
  assert.equal(filled.city, 'Mumbai', 'the ones they have not touched may be filled');
  assert.equal(filled.email, 'old@test.example');
});

test('a moved shopper keeps their new street through a reload', async () => {
  // The route, not a copy of its logic: someone changing their address on a page
  // that reloads must not watch it revert to the house they moved out of.
  jar = new Map();
  await placeOrder();

  const product = catalog.all().find((p) => p.id === 'p001');
  await post('/cart/add', { id: product.id, size: 'XS', color: 'Red', qty: 1 });

  // They start editing: new street, same everything else.
  await post('/checkout/step/2', { ...ADDRESS, address1: '77 New Street' });

  const reloaded = await get('/checkout');
  assert.equal(reloaded.status, 200);
  assert.match(reloaded.text, /value="77 New Street"/, 'the address they typed must survive a reload');
  assert.doesNotMatch(reloaded.text, /value="1 Test Road"/);
});

/* -------------------------------------------------------- saved addresses ---- */

test('a second address is remembered alongside the first, newest first', async () => {
  jar = new Map();
  await placeOrder();

  const second = { ...ADDRESS, address1: '9 Other Street', pincode: '110001', city: 'New Delhi', state: 'Delhi' };
  await placeOrder(second);

  const me = shopper.decode(decodeURIComponent(jar.get(shopper.COOKIE)));
  assert.equal(me.addresses.length, 2);
  assert.equal(me.addresses[0].address1, '9 Other Street', 'the one just used comes first');
  assert.equal(me.addresses[1].address1, '1 Test Road');
});

test('the same place written slightly differently is not saved twice', () => {
  const me = { addresses: [{ address1: 'Flat 4B, Rose Street', pincode: '400050', city: 'Mumbai' }] };
  const again = { address1: 'flat 4b rose street', pincode: '400 050', city: 'Mumbai' };

  const next = shopper.rememberAddress(me, again);
  assert.equal(next.length, 1, 'someone writing "4B" instead of "Flat 4B" has not moved house');
});

test('a shopper can switch between the addresses they have used', async () => {
  const product = catalog.all().find((p) => p.id === 'p001');
  await post('/cart/add', { id: product.id, size: 'XS', color: 'Red', qty: 1 });

  const opened = await get('/checkout');
  assert.match(opened.text, /value="9 Other Street"/, 'opens on the most recent');

  const switched = await post('/checkout/address/1', {});
  assert.equal(switched.status, 200);
  assert.match(switched.text, /value="1 Test Road"/);
  assert.match(switched.text, /value="400001"/);
  // The panel must survive the switch, not vanish because index 0 no longer matches.
  assert.match(switched.text, /Not you\? Start fresh/);
});

test('an out-of-range address index does not blow up the checkout', async () => {
  const res = await post('/checkout/address/99', {});
  assert.equal(res.status, 200);
});

/* --------------------------------------------------------- your orders ---- */

test('your orders lists what this browser bought, newest first', async () => {
  const res = await get('/orders');
  assert.equal(res.status, 200);

  const me = shopper.decode(decodeURIComponent(jar.get(shopper.COOKIE)));
  assert.equal(me.orderIds.length, 2);
  me.orderIds.forEach((id) => assert.ok(res.text.includes(id), `${id} should be listed`));

  const positions = me.orderIds.map((id) => res.text.indexOf(id));
  const newest = ordersStore.byId(me.orderIds[0]);
  const other = ordersStore.byId(me.orderIds[1]);
  if (new Date(newest.createdAt) > new Date(other.createdAt)) {
    assert.ok(positions[0] < positions[1], 'newest first');
  }
});

test('a browser with no history sees a way in rather than an empty page', async () => {
  const fresh = new Map();
  const res = await get('/orders', { jarOverride: fresh });
  assert.equal(res.status, 200);
  assert.match(res.text, /Nothing here yet/);
  assert.match(res.text, /Find an order/);
});

test('your orders cannot be used to read someone else\'s', async () => {
  // Forging the cookie is the only way to claim an id you never bought, and it fails.
  const forged = new Map();
  const payload = Buffer.from(JSON.stringify({ orderIds: ['ORD-00001', 'ORD-00002'] }), 'utf8').toString('base64url');
  forged.set(shopper.COOKIE, `${payload}.deadbeef`);

  const res = await get('/orders', { jarOverride: forged });
  assert.equal(res.status, 200);
  assert.match(res.text, /Nothing here yet/, 'an unverified cookie must count for nothing');
  assert.doesNotMatch(res.text, /ORD-0000/);
});

test('an order that no longer exists is dropped, not rendered blank', async () => {
  const me = shopper.decode(decodeURIComponent(jar.get(shopper.COOKIE)));
  const withGhost = new Map(jar);
  withGhost.set(shopper.COOKIE, shopper.encode({ ...me, orderIds: ['ORD-DOESNOTEXIST', ...me.orderIds] }));

  const res = await get('/orders', { jarOverride: withGhost });
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /ORD-DOESNOTEXIST/);
  assert.ok(res.text.includes(me.orderIds[0]), 'the real orders must still be there');
});

test('forget me really forgets', async () => {
  const res = await post('/orders/forget', {});
  assert.equal(res.status, 302);
  assert.equal(jar.get(shopper.COOKIE), undefined);

  const after = await get('/orders');
  assert.match(after.text, /Nothing here yet/);
});

/* ------------------------------------------------------ switching section ---- */

/**
 * The switcher, over HTTP.
 *
 * Two things were wrong. The switcher only rendered at lg and above, so on a phone —
 * where most of these shoppers are — the audience picked in the welcome popup could
 * never be changed. And "everything" was not offered at all, so someone buying a
 * sherwani for their son and a saree for themselves had to keep flipping sections.
 *
 * The route also treated "everything" as a failure, because choose() answers it with
 * null and null was read as an unknown id. Every "show me everything" click landed on
 * the homepage as if it had erred.
 */
test('switching section keeps you on the page you were reading', async () => {
  const res = await post('/audience', { audience: 'men', next: '/cart' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/cart', 'switching must not also lose their place');
});

test('choosing everything is accepted, not treated as a bad id', async () => {
  const res = await post('/audience', { audience: 'all', next: '/cart' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/cart', 'null from choose() is the answer, not an error');
});

test('an unknown section is still refused', async () => {
  const res = await post('/audience', { audience: 'martians', next: '/cart' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/');
});

test('an off-site next is not followed', async () => {
  const res = await post('/audience', { audience: 'men', next: 'https://evil.example/steal' });
  assert.equal(res.headers.get('location'), '/');

  const protocolRelative = await post('/audience', { audience: 'men', next: '//evil.example' });
  assert.equal(protocolRelative.headers.get('location'), '/');
});

test('the switcher is reachable on a phone, not only on a desktop', async () => {
  const page = await get('/');
  assert.equal(page.status, 200);

  // The drawer is the phone's only navigation, so the choice has to live in it.
  assert.ok(page.text.includes('Shopping for'), 'the drawer must carry the audience switcher');

  const at = page.text.indexOf('Shopping for');
  // Up to the next drawer item, so this cannot pass on the desktop row instead.
  const block = page.text.slice(at, page.text.indexOf('New In', at));
  assert.match(block, /name="audience" value="all"/, 'including everything');
  assert.match(block, /name="audience" value="men"/);
  assert.match(block, /name="next"/, 'and it should return them to where they were');
});

test('the welcome popup offers everything as its own answer', async () => {
  const fresh = new Map();
  const page = await get('/', { jarOverride: fresh });
  assert.match(page.text, /show me everything/i);
});

/* ------------------------------------------------------- installable app ---- */

/**
 * The browser's own install banner appears once, on its own schedule, and cannot be
 * summoned back after it is dismissed — so the shop reads as having no app at all.
 * The fix is to hold on to the beforeinstallprompt event and offer it from the menu.
 *
 * The behaviour is client-side, so what these hold is the contract: the event is
 * captured rather than left to the browser, the entry only appears where it can do
 * something, and iOS gets instructions instead of a button Safari will not honour.
 */
const appJs = require('fs').readFileSync(
  require('path').join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8'
);

test('the install event is captured instead of left to the browser', () => {
  const at = appJs.indexOf("addEventListener('beforeinstallprompt'");
  assert.ok(at > 0, 'the event must be listened for at all');

  /* Inside the handler only. preventDefault appears elsewhere in this file, so a
     whole-file match passed even with this one deleted — which is how a test can
     look green while the mini-infobar is back in charge. */
  const handler = appJs.slice(at, appJs.indexOf('});', at));
  assert.match(handler, /preventDefault\(\)/, 'the mini-infobar must be stopped so the choice is ours to offer');
  assert.match(handler, /deferredInstall = e/, 'and the event kept, or it cannot be replayed');
});

test('the offer disappears once the app is installed', () => {
  assert.match(appJs, /addEventListener\('appinstalled'/);
  assert.match(appJs, /function isStandalone/, 'already running installed = nothing to offer');
});

test('iOS is detected, since Safari has no install event at all', () => {
  assert.match(appJs, /function isIos/);
  assert.match(appJs, /maxTouchPoints/, 'iPadOS reports itself as a Mac');
});

test('the menu carries the install entry, gated on it being useful', async () => {
  const page = await get('/');
  assert.match(page.text, /Add to home screen/);
  assert.match(page.text, /\$store\.ui\.install\(\)/, 'the entry must actually trigger the held prompt');
  assert.match(page.text, /\$store\.ui\.canInstall \|\| \$store\.ui\.iosInstall/, 'hidden where it cannot work');
  assert.match(page.text, /Add to Home Screen/, 'iOS needs the Share-sheet wording');
});
