#!/usr/bin/env node
'use strict';

/**
 * Does this theme still work?
 *
 *   npm run theme:check                 the base theme
 *   npm run theme:check -- catalogue    one theme
 *   npm run theme:check -- --all        every theme on disk
 *
 * This is the piece that makes a per-client storefront a process rather than a gamble.
 * A new design — written by hand, or generated from the contract — cannot know which
 * parts of a view are load-bearing. Six bugs turned up in a single carefully written
 * theme in one day: a JSON attribute whose quotes closed the tag early, an input whose
 * name collided with the form around it, a sticky bar reading state one click stale.
 * Every one of them looked fine on screen.
 *
 * So this drives a real server on the theme and asserts the CONTRACT: that a size which
 * is sold out cannot be added, that the total a customer reads is the total the order is
 * written with, that the tax line a shop is required to show is on the page. It says
 * nothing about whether the design is any good — that is for eyes. It says whether the
 * shop still sells.
 */

const path = require('path');

const theme = require('../src/theme');

/* ---------------------------------------------------------------- args ---- */

const argv = process.argv.slice(2);
const wantAll = argv.includes('--all');
const selfTest = argv.includes('--self-test');
const named = argv.filter((a) => !a.startsWith('--'));

/* A theme that is meant to fail, so the harness can be watched failing. A check nobody
   has seen fail is not a check — it is decoration that happens to be green. Dot-prefixed,
   so --all skips it. */
const SELF_TEST_THEME = '.selftest';

const C = process.stdout.isTTY
  ? { red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m', dim: '\x1b[2m', bold: '\x1b[1m', off: '\x1b[0m' }
  : { red: '', yellow: '', green: '', dim: '', bold: '', off: '' };

const say = (s = '') => console.log(s);

/* ------------------------------------------------------------ the checks ---- */

/**
 * Every check is (name, run) where run() throws with a readable reason. Grouped by what
 * breaks for a customer, not by which file it lives in — a theme author needs to know
 * "sold-out sizes are buyable", not "line 88 is wrong".
 */
function checks(ctx) {
  const { get, post, product, soldOutSize, openSize } = ctx;

  const must = (cond, why) => { if (!cond) throw new Error(why); };
  const unescape = (s) => s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"').replace(/&#x27;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

  return [
    /* --- the pages exist at all --- */
    ['every storefront page renders', async () => {
      const routes = ['/', '/category/all', '/cart', '/wishlist', '/returns', '/journal', '/orders',
        `/product/${product.slug}`, '/search?q=a', `/fragments/quick-view/${product.slug}`,
        '/fragments/home-section/1'];
      for (const r of routes) {
        const res = await get(r);
        must([200, 302].includes(res.status), `${r} answered ${res.status}`);
      }
    }],

    ['a page that fails to render is not served as a blank 200', async () => {
      const res = await get('/');
      must(res.text.length > 2000, `the homepage came back ${res.text.length} bytes — something did not render`);
      must(/<\/html>/i.test(res.text), 'the homepage has no closing </html> — a view threw part-way through');
    }],

    /* --- what a shopper is allowed to buy --- */
    ['the product page carries a stock map the browser can parse', async () => {
      const res = await get(`/product/${product.slug}`);
      const found = /data-stock='([^']+)'/.exec(res.text);
      must(found, "no data-stock attribute — the size picker cannot know what is left");

      let map;
      try {
        map = JSON.parse(unescape(found[1]));
      } catch (err) {
        // This exact bug shipped once: the JSON's own quotes closed the attribute early.
        throw new Error(`data-stock is not parseable JSON (${err.message}) — quote it single, escape the contents`);
      }
      must(Object.keys(map).length, 'the stock map is empty');
    }],

    ['the sticky buy bar knows about stock too', async () => {
      const res = await get(`/product/${product.slug}`);
      const maps = (res.text.match(/data-stock='/g) || []).length;
      // The bar is its own Alpine scope; without its own copy it offered sizes the
      // picker above had already refused.
      must(maps >= 2, 'only one stock map on the page — a separate buy bar needs its own');
    }],

    ['the page never shows two Add to bag buttons at once', async () => {
      const res = await get(`/product/${product.slug}`);
      const bar = res.text.slice(res.text.indexOf("data-stock='", res.text.indexOf("data-stock='") + 1));

      /* Reported from a phone: the sticky bar showed from the first pixel on any screen
         under 1024px, so while the real Add to bag was still on screen the page carried
         two of them. Which one is live is not a question to make a customer answer.
         The bar must wait for the real buttons to leave. */
      /* Comments stripped first. This check failed against correct code because the
         comment explaining the old bug quotes the old bug — the check was matching its own
         documentation.

         Plain string matching rather than a regex: braces and parens in a pattern this
         shape are three escapes away from silently matching nothing. */
      const code = bar.replace(/\/\*[\s\S]*?\*\//g, ' ');

      must(code.includes('!this.upsell && this.past'),
        'the sticky bar is not gated on the real buttons having scrolled away');
      must(!code.includes('window.innerWidth < 1024'),
        'the sticky bar shows unconditionally on small screens, alongside the real button');
    }],

    ['a sold-out size cannot be added to the bag', async () => {
      if (!soldOutSize) return 'skipped — nothing is sold out in the demo catalogue';

      const before = await cartLines(ctx);
      await post('/cart/add', { id: product.id, size: soldOutSize, color: product.colors[0], qty: 1 });
      const after = await cartLines(ctx);

      must(after === before, `adding sold-out size ${soldOutSize} changed the bag — the server must refuse it`);
    }],

    ['a listing card admits when a piece is sold out', async () => {
      const variants = require('../src/variants');
      const catalog = require('../src/catalog');
      const gone = catalog.all().find((p) => !variants.anyAvailable(p));
      if (!gone) return 'skipped — nothing in the catalogue is fully sold out';

      /* Searched for by name rather than hoped for on page one. The first version of
         this check skipped itself instead, and a check that quietly skips is a check
         that lets a broken theme through — which is exactly what it did. */
      const res = await get('/category/all?q=' + encodeURIComponent(gone.name));
      must(res.text.includes(gone.slug),
        `the listing cannot find "${gone.name}", so its card cannot be checked`);

      /* Anchored on the card's own link, not on the first mention of the slug — that
         first mention is the canonical URL in the head, eighty kilobytes away from the
         card, and a window around it saw nothing.

         Checked around the card rather than across the whole page, because a "Sold out"
         filter chip elsewhere would otherwise pass this for a card that says nothing. */
      const href = `href="/product/${gone.slug}"`;
      const at = res.text.indexOf(href);
      must(at > 0, `no card links to ${gone.slug} on the listing`);

      const card = res.text.slice(Math.max(0, at - 1500), at + 2000);
      must(/sold out|notify me/i.test(card),
        `the card for "${gone.name}" gives no sign it is sold out — a shopper clicks through to a dead page`);
    }],

    ['a quantity beyond stock is capped, not accepted', async () => {
      const res = await post('/cart/add', { id: product.id, size: openSize, color: product.colors[0], qty: 99 });
      must(res.status === 200, `/cart/add answered ${res.status}`);

      const page = await get('/cart');
      must(!/\b99\b/.test(page.text.replace(/data-[^"]*"[^"]*"/g, '')), 'the bag accepted 99 of a piece that has fewer');
    }],

    /* --- the numbers --- */
    ['the bag shows a total, and it is the total the summary agrees with', async () => {
      await post('/cart/add', { id: product.id, size: openSize, color: product.colors[0], qty: 1 });
      const res = await get('/cart');
      must(/₹/.test(res.text), 'no price anywhere in the bag');
      must(/total/i.test(res.text), 'the bag shows no total');
    }],

    ['prices are presented as tax-inclusive', async () => {
      const res = await get(`/product/${product.slug}`);
      // The shop's whole pricing stance: the number shown is the number paid.
      must(/incl\.?\s*(of\s*)?(all\s*)?tax/i.test(res.text),
        'no "inclusive of taxes" line — a shopper must know the price is final');
    }],

    ['checkout reaches payment and states what is payable', async () => {
      await post('/cart/add', { id: product.id, size: openSize, color: product.colors[0], qty: 1 });

      const two = await post('/checkout/step/2', {
        _from: '1', fullName: 'Theme Check', phone: '9820000000', email: 'check@test.example',
        address1: '1 Test Road', pincode: '400001', city: 'Mumbai', state: 'Maharashtra', country: 'India'
      });
      must(two.status === 200, `checkout step 2 answered ${two.status}`);

      const three = await post('/checkout/step/3', { _from: '2', deliveryMethod: 'standard' });
      must(three.status === 200, `checkout step 3 answered ${three.status}`);
      must(/total payable/i.test(three.text), 'the payment step never says what is payable');
    }],

    ['the order summary breaks out GST rather than hiding it', async () => {
      const res = await get('/checkout');
      must(/includes gst/i.test(res.text), 'no GST line — the tax has to be shown even when it is inside the price');
    }],

    /* --- the wiring a design can silently cut --- */
    ['the targets HTMX swaps into are present', async () => {
      const needed = [
        ['/', 'cart-panel'],
        ['/cart', 'cart-page'],
        ['/checkout', 'checkout-body'],
        ['/checkout', 'order-summary']
      ];
      for (const [route, id] of needed) {
        const res = await get(route);
        if (res.status !== 200) continue;
        must(res.text.includes(`id="${id}"`), `${route} has no #${id} — the fragment that swaps into it will vanish`);
      }
    }],

    ['the bag can be opened from the page', async () => {
      const res = await get('/');
      must(/\$store\.ui\.cart\s*=\s*true|\$store\.ui\.openCart/.test(res.text),
        'nothing on the page opens the bag drawer');
    }],

    ['quick view knows what is left', async () => {
      const res = await get(`/fragments/quick-view/${product.slug}`);
      if (res.status !== 200) return 'skipped — quick view is switched off';
      must(/data-stock='/.test(res.text), 'quick view offers sizes without knowing which are gone');
    }]
  ];
}

/** Reads the bag through the real page, so this tests what a customer would see. */
async function cartLines(ctx) {
  const res = await ctx.get('/cart');
  return (res.text.match(/\/cart\/remove/g) || []).length;
}

/* ------------------------------------------------------------- one theme ---- */

async function checkTheme(name) {
  // A fresh process per theme would be cleaner; instead the env var is set before the
  // server is required, which is the only thing that reads it.
  if (name) process.env.THEME = name; else delete process.env.THEME;

  const label = name || '(base)';
  say(`\n  ${C.bold}${label}${C.off}`);

  const orphaned = name ? theme.orphans(name) : [];
  if (orphaned.length) {
    /* A typo here fails in the worst way: the theme looks installed, the file is never
       reached, and the base view renders instead. Nothing looks broken. */
    orphaned.forEach((f) => say(`    ${C.red}✗${C.off}  ${f} overrides nothing in views/ — check the filename`));
  }
  if (name) {
    const files = theme.overrides(name);
    say(`    ${C.dim}${files.length} override${files.length === 1 ? '' : 's'}: ${files.join(', ') || '(none)'}${C.off}`);
  }

  // Required fresh so the views array is built with THEME in place.
  Object.keys(require.cache)
    .filter((k) => k.includes(`${path.sep}src${path.sep}`) || k.endsWith(`${path.sep}server.js`))
    .forEach((k) => delete require.cache[k]);

  const server = require('../server').listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const jar = new Map();
  async function req(method, route, body) {
    const res = await fetch(base + route, {
      method,
      redirect: 'manual',
      headers: {
        cookie: [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
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

  /* A piece with some sizes gone and some left, so the interesting checks have
     something real to bite on. */
  const variants = require('../src/variants');
  const catalog = require('../src/catalog');
  const product = catalog.all().find((p) => {
    const sizes = variants.sizeAvailability(p);
    return sizes.some((s) => s.available) && sizes.some((s) => !s.available);
  }) || catalog.all().find((p) => variants.anyAvailable(p)) || catalog.all()[0];

  const availability = variants.sizeAvailability(product);
  const ctx = {
    get: (r) => req('GET', r),
    post: (r, b) => req('POST', r, b || {}),
    product,
    openSize: (availability.find((s) => s.available) || {}).size || (product.sizes || [])[0],
    soldOutSize: (availability.find((s) => !s.available) || {}).size || null
  };

  let failed = 0;
  let skipped = 0;

  for (const [name2, run] of checks(ctx)) {
    try {
      const result = await run();
      if (typeof result === 'string' && result.startsWith('skipped')) {
        skipped++;
        say(`    ${C.dim}–  ${name2} — ${result.replace(/^skipped — /, '')}${C.off}`);
      } else {
        say(`    ${C.green}✓${C.off}  ${name2}`);
      }
    } catch (err) {
      failed++;
      say(`    ${C.red}✗${C.off}  ${name2}`);
      say(`       ${C.red}${err.message}${C.off}`);
    }
  }

  server.close();
  return { failed: failed + orphaned.length, skipped };
}

/* ----------------------------------------------------------------- main ---- */

(async () => {
  if (selfTest) {
    const { failed } = await checkTheme(SELF_TEST_THEME);
    // Four deliberate breaks; fewer means the harness has stopped noticing something.
    if (failed >= 4) {
      say(`\n  ${C.green}The harness caught all ${failed} deliberate breaks.${C.off}\n`);
      process.exit(0);
    }
    say(`\n  ${C.red}Only ${failed} of 4 deliberate breaks caught — the harness has gone blind.${C.off}\n`);
    process.exit(1);
  }

  const list = wantAll ? [null, ...theme.available()] : (named.length ? named : [null]);

  const unknown = list.filter((n) => n && !theme.dirOf(n));
  if (unknown.length) {
    say(`\n  ${C.red}No such theme: ${unknown.join(', ')}${C.off}`);
    say(`  On disk: ${theme.available().join(', ') || '(none)'}\n`);
    process.exit(1);
  }

  let broken = 0;
  for (const name of list) {
    const { failed } = await checkTheme(name);
    if (failed) broken++;
  }

  if (broken) {
    say(`\n  ${C.red}${broken} theme${broken === 1 ? '' : 's'} would not sell.${C.off} Fix the above.\n`);
    process.exit(1);
  }
  say(`\n  ${C.green}All ${list.length} theme${list.length === 1 ? '' : 's'} pass the contract.${C.off}`);
  say(`  ${C.dim}This says the shop still sells. Whether it looks good is for eyes.${C.off}\n`);
})();
