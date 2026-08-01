# Ethnic-wear commerce template

A complete, production-shaped Indian e-commerce storefront and admin, built to be
resold: one codebase, many clients, no forks. Node + Express + EJS + HTMX +
Alpine + Tailwind. No SPA, no build step, no framework upgrade treadmill.

```bash
npm install
npm start          # http://localhost:3000  ·  admin at /admin
npm test           # 227 tests, ~7 seconds
npm run doctor     # pre-launch check for a client deployment
```

The server prints a LAN URL as well as localhost, so a phone on the same Wi-Fi can
open both the storefront and the admin without any extra setup.

---

## Why it is built this way

Three decisions shape everything else.

**Prices are GST-inclusive.** The number a customer sees is the number they pay.
Tax is *extracted* from it for the invoice and the P&L, never added at checkout.
Every total in the system is asserted against this in the test suite.

**One codebase, many clients.** What separates a ₹49k store from a ₹1.99L store is
a plan flag and a signed licence — never a hand-edited copy. A hundred divergent
codebases is the thing that kills an agency.

**Server-side gates.** A hidden link is decoration. Every permission, plan lock,
stock limit and COD rule is enforced on the server, because anyone can POST
straight to a route.

---

## Storefront

### Catalogue & discovery
- Homepage: hero, shop-by-occasion, bestsellers, new arrivals, testimonials,
  newsletter — sections defined in config, lazily loaded as they scroll in
- As-you-type search (2 characters, 300 ms debounce) with suggestions
- Mega-menu category nav, category carousel
- Listing page with HTMX filters that update the grid **and the URL** without a
  reload — fade, no spinner. Facets for colour, fabric, size, occasion, price
- Infinite scroll plus an explicit Load More
- Wishlist, quick view

### Product page
- Two-up image grid on desktop (four views visible at once), swipeable
  scroll-snap rail on phone, hover-to-zoom on every frame
- Colour and size selection on every product
- **Pincode check before the cart**: delivery ETA, whether the shop delivers there
  itself, and COD availability — the same engine the checkout uses, so the two can
  never disagree
- "Inclusive of all taxes" plus the delivery position stated up front, so nothing
  new appears at checkout
- Sticky buy bar that follows the page and stops at the "you may also like"
  section — past that point it would add the wrong piece
- Specifications, care, size guide, per-product FAQ, related pieces
- Verified customer reviews with photo and video

### Cart & checkout
- Cart drawer with live quantity, out-of-stock guard, coupon field
- Single-page multi-step checkout (address → delivery → payment), guest checkout,
  cart persisted in a cookie for 30 days
- **Price details panel**: items, discount, delivery (with a waived charge struck
  through), total payable, GST disclosure, and total saved
- Pincode auto-fills city and state, and offers the local post-office areas
- Optional buyer GSTIN with real check-digit validation, for B2B invoices
- Delivery re-quotes live when the method or gift wrap changes
- Stock is re-checked at the moment of payment — someone else may have bought the
  last piece while the cart sat open

### Mobile
App-shell layout: bottom tab bar (home, search, category, cart), hamburger, sticky
buy bar, swipe gallery. Lazy images, skeletons, no heavy JS.

---

## Admin

### Dashboard & reports
Revenue, orders, AOV, units, refunds, GST, and the full P&L ladder:

```
gross sales
− refunds                        = net sales
− GST (extracted, never ours)
− shipping collected             = revenue ex-tax
− COGS (your per-SKU cost)       = gross profit
− packaging, fulfilment, COD handling
− gateway %, platform %, returns provision
                                 = contribution
− marketing, salaries, rent, software (prorated)
                                 = EBITDA
− depreciation                   = EBIT
− loan interest                  = PBT
− income tax                     = PROFIT IN HAND
```

EBITDA and profit in hand are **different numbers**. EBITDA is how the business
performs; profit in hand is what the owner keeps.

- Windows: today, 2d, 5d, 7d, 15d, 30d, 90d, 12m, all — plus any custom date
  range, each compared against the equal period before it. Short windows are how
  you tell whether an influencer post actually did anything
- Per-SKU profitability, per-category margins, top sellers and dead stock
- Campaign attribution (utm_source / ?ref=), first and last touch
- Coupon economics, including returns *against* coupon orders — coupon orders get
  their own id series (`ORD-C-00042`) so they are traceable
- TDS and TCS on marketplace sales shown as **recoverable**, never deducted from
  profit
- CSV export for every table and window

### Orders
Status pipeline, payment status, timeline, notes, COD outstanding, per-order
economics, GST invoice, and filters by status / payment / who delivers / date /
free-text search.

### Products
Add and edit, per-SKU purchase cost and GST (admin-only, never shown to a
customer), HSN, stock adjustments, low-stock and out-of-stock views, image and
video upload with automatic compression, bulk CSV import with validation and a
backup before every write.

### GST & invoicing
- Sequential tax invoices, one series per financial year, allocated once and never
  reused — a gap is what an auditor asks about
- CGST + SGST for intra-state, IGST for inter-state, decided by place of supply
- Price-slab GST (apparel: 5% under ₹2,500, 18% at or above — per piece, config
  driven)
- Shipping and gift wrap treated as composite supply
- Print-optimised invoice; the browser's own Save as PDF is the export, so there is
  no PDF library to keep alive on a client's host
- **GSTR-1 working papers**: B2CS, B2CL, B2B, HSN summary, documents issued,
  credit notes, and the 3B figure. The tables reconcile — B2CS + B2CL = 3B = HSN
  summary — which is the first thing an accountant checks

### Returns & refunds
Self-serve return requests with photo/video, eligibility from the delivery
timeline, partial refunds that feed the P&L, and refunds that **accumulate** across
multiple returns on one order.

### Everything else
Reviews moderation, journal/blog, marketing (SEO/AEO/GEO, sitemap, structured
data, product-review feed), discounts, customers, activity log, staff accounts with
roles, and settings for every knob in the store.

---

## Reselling this

### Plans
`src/plan.js` defines 18 sellable features across three tiers. Locked sections stay
**visible with a padlock** — a client should know what the platform can do, not
wonder what is missing. A feature not listed in any plan is ON for everyone, so new
work never silently vanishes for existing clients.

### Licences
Ed25519-signed keys. The private key lives only on your machine; every deployment
ships the public key and verifies offline — a store must not stop selling because a
licence server is unreachable.

```bash
node scripts/issue-license.js --keygen
node scripts/issue-license.js --store "Client Name" --plan growth --months 12 \
     --domains theirdomain.com --extras whatsapp
node scripts/issue-license.js --list
```

A client cannot promote themselves: editing the plan or the expiry inside a key
breaks the signature, and a signed licence outranks the plan written in the config
file.

Expiry is deliberately gentle — 14 days of grace, then the **admin** locks while the
**storefront keeps selling**. A shop is a real business with real customers; it does
not get switched off over an unpaid invoice.

### Integrations are the client's own
Payments (Razorpay live, others stubbed) and notifications (SMTP / Resend / Brevo,
Interakt / Gupshup) are adapter layers. The client connects their own keys, stored
in `data/secrets.json` (git-ignored, mode 600) or environment variables — never in
the site config, never in a view.

### Delivery zones
A shop in Lucknow can offer same-day delivery across Lucknow, on its own scooter,
for nothing — and a courier for everyone else. Zones match on pincode / prefix /
city, honour cut-off times, and mark the order `fulfilment: own` so a courier
integration added later **skips what the shop already delivered by hand**.

---

## Configuration

Everything a client can change lives in `config/site.config.json` — brand, colours
(injected straight into the Tailwind config, so one value re-skins the site), fonts,
currency, features, finance model, GST slabs, business/GST details, shipping and
delivery zones, COD rules, payments, notifications, nav, homepage sections, footer.

Data lives in `data/*.json`, written through `src/store.js` with a timestamped
backup before every change. `DATA_DIR` and `SITE_CONFIG` can point elsewhere.

**Single process only.** The store keeps a per-process read cache, so a second
worker would write from a stale copy and silently lose orders. `ecosystem.config.js`
pins pm2 to one worker and the server refuses to boot as worker #1+ — a store that
loses one order in fifty is worse than one that won't start.

---

## Tests

227 tests over the paths where a bug costs money, on Node's built-in runner — no
test dependencies:

| File | What it defends |
|---|---|
| `pricing.test.js` | GST is extracted, never added; rate resolution order |
| `cart-totals.test.js` | total = items − discount + delivery + wrap, every combination |
| `delivery.test.js` | zones, cut-offs, made-to-order limits, who carries the parcel |
| `invoice.test.js` | CGST/SGST vs IGST, numbering, invoice total = order total |
| `gst-return.test.js` | the GSTR-1 tables reconcile to 3B |
| `gstin.test.js` | check-digit validation; B2B reporting |
| `cod.test.js` | advance, pincode allow/block lists, plans |
| `discounts.test.js` | expiry, usage limits, minimums |
| `orders.test.js` | snapshots, refund accumulation, stock |
| `auth.test.js` | roles, hashing, lockout, single-use resets |
| `license.test.js` | forgery, expiry, domain lock, entitlement |
| `plan.test.js`, `plan-gate.test.js` | plan enforcement, including over HTTP |
| `checkout-flow.test.js` | the whole checkout over HTTP, no mocks |

Each test file gets a throwaway data directory, so tests never touch a real store.

Some of these exist because of bugs that shipped: Express delivery was offered at
₹500 and charged at ₹0; a second refund on one order erased the first; a sold-out
piece could be added to the cart by posting straight to the route. Each is now a
test that fails loudly.

---

## Known limits

Stated plainly rather than discovered later.

- **JSON storage, single process.** Fine at a boutique's volume; SQLite is the next
  step. `npm run doctor` warns once `orders.json` grows past 20 MB
- **Video compression is synchronous** — a large upload occupies the process
- **No customer accounts** — guest checkout only; orders are looked up by number +
  contact
- **GST working papers are working papers**, not a portal upload. The figures are
  final; a human transfers them into the portal or filing software
- **Buyer GSTIN is validated but not verified** — the check digit is checked, the
  registration is not looked up
- **`ADMIN_TOKEN` is an escape hatch, not a login.** `doctor` fails the launch if it
  is still set

---

## Layout

```
server.js              storefront routes; exports the app so tests can drive it
config/                site.config.json — everything a client changes
src/
  store.js             JSON persistence with backups
  catalog.js           products, search, facets
  cart.js              cart, totals, GST extraction, checkout extras
  pricing.js           who decides GST% and unit cost, in what order
  delivery.js          zones, cut-offs, who carries the parcel
  cod.js               cash-on-delivery rules
  orders.js            order lifecycle, refunds, purchase verification
  invoice.js           GST tax invoices
  gst-return.js        GSTR-1 working papers
  gstin.js             GSTIN validation with check digit
  analytics.js         the P&L ladder
  plan.js              sellable features and tiers
  license.js           Ed25519 licence verification
  auth.js              scrypt hashing, roles, sessions
  payments.js          gateway adapters
  notifications.js     email / WhatsApp adapters
  exporter.js          "your data is yours" archive
  zip.js               minimal ZIP writer, no dependency
  routes/              admin routers and the shared permission gate
views/                 EJS: pages, fragments, partials, admin, emails
public/                CSS and the small amount of JS
scripts/               doctor, licence issuing, import, seed
test/                  the suite above
```

---

## First run on a client deployment

```bash
npm install
npm run doctor              # tells you what is not ready
npm start
```

Then open `/admin` — with no accounts yet it offers a one-time owner setup, so a
fresh install is never briefly wide open. After that, `doctor` should be clean:
real brand, GSTIN filled, live payment keys, a real email provider, no handover
passwords still in use, and pm2 pinned to a single worker.
