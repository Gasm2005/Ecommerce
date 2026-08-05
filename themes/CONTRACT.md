# The theme contract

Read this before redesigning anything. It is the whole of what a theme may not break.

A theme changes how the shop **looks**. It does not change how it **works** — the
pricing, the tax, the stock truth and the order writing all live in `src/` and are shared
by every client. That split is the reason this template can be sold many times: a bug
fixed once is fixed for everyone.

Verify with:

```bash
npm run theme:check -- <name>
```

That runs a real server on your theme and drives it like a customer. It says whether the
shop still **sells**. Whether it looks good is for eyes, not for the harness.

---

## 1. A theme is a diff, not a copy

Put a theme in `themes/<name>/`, mirroring the `views/` tree. Include **only** the files
whose look you are changing. Everything else falls through to `views/`.

```
themes/meera/
  partials/product-card.ejs     ← a different card
  pages/home.ejs                ← a different hero
```

Two files is a normal theme. Copying all forty-five is how you inherit every future bug
fix as a merge conflict instead of a gift.

Run it with `THEME=meera npm start`, or set `theme.name` in `config/site.config.json`.

**Do not theme these.** They are logic wearing a thin coat of markup, and a redesign of
them breaks money rather than looks:

| | Why |
|---|---|
| `views/admin/**` | Every client gets the same sober admin. Not themed at all. |
| `views/emails/**` | Rendered outside Express, no `view()` helper, and a broken template silently sends nothing. |
| `fragments/checkout-step.ejs` | Validation, delivery quoting and payment state. Restyle the classes inside it; do not restructure it. |

---

## 2. Includes must go through `view()`

```ejs
<%- include(view('partials/product-card'), { product: p }) %>   ✅
<%- include('../partials/product-card', { product: p }) %>       ❌
```

EJS resolves a relative include against **the including file's own directory** before it
looks at the theme. A relative include in a base page therefore finds the base partial
sitting next to it and never sees yours — your override would be silently ignored.
`view()` resolves theme-first and returns an absolute path.

A missing view throws loudly on purpose. A silent miss renders a page with a hole where
the header or the buy button used to be.

---

## 3. Locals you are given

Available in every storefront view, already resolved. Do not re-require modules to get
them; do not compute prices or availability yourself.

**Helpers**

| | |
|---|---|
| `money(n)` | Formats with the store's currency and locale. Never build `'₹' + n`. |
| `swatch(name)` | A colour name to a CSS colour, for colourway dots. |
| `hasFeature(id)` | Plan gating. A feature the client did not buy must not render. |
| `view(name)` | Resolves a view, theme-first. See above. |

**Data**

`config` · `nav` · `audience` `audienceId` `audiences` `audienceChoiceNeeded` ·
`catalog` `variants` `cart` `cartSummary` · `delivery` `cod` `fulfilment` ·
`me` `savedAddresses` `wishlistIds` · `orders` `returns` `reviews` · `marketing` `seo`
`jsonLd` · `currentPath` `origin` `isHx` `themeName`

Two that matter more than they look:

- **`variants`** is the only truth about what can be bought. `variants.stockFor()`,
  `sizeAvailability()`, `anyAvailable()`. Never infer availability from `product.stock`.
- **`fulfilment`** owns every customer-facing sentence about made-to-order. A retail
  client has those flags off, and hard-coding "made to order" into a theme promises
  something the shop does not do.

---

## 4. What must survive your redesign

The harness checks each of these. They are here because each one, left out, costs a sale
or a refund.

### Availability

- The product page carries a **stock map** the browser can parse:
  `data-stock='<%= JSON.stringify(stockMap) %>'` — **single-quoted attribute**. This
  exact line shipped broken once: inside double quotes the JSON's own quotes close the
  attribute early, Alpine never initialises, and every size looks available.
- A **separate sticky buy bar needs its own copy** of that map. It is its own Alpine
  scope; without one it offers sizes the picker above has already refused.
- Sold-out sizes are **shown and struck through**, not hidden. Hiding a size makes the
  shop look like it never stocked it.
- Add-to-bag becomes a **dead** button, not a live one that fails.
- A **listing card for a fully sold-out piece must say so.** Otherwise a shopper clicks
  through to a dead page.
- If you read a form value on a click, read it **after** Alpine has flushed
  (`$nextTick`). Reading during the click gets the previous value, and a buy bar one
  selection stale will sell a size that is gone.

### Money

- Prices are **inclusive of tax** and must say so. The number shown is the number paid.
- The bag and the payment step show a **total**, and the payment step says **Total
  payable**.
- **`Includes GST`** appears on the order summary. The tax is inside the price; it still
  has to be visible.
- A delivery charge the customer pays is **itemised**, never folded into the total.

### Wiring

Keep these ids — HTMX swaps into them by name, and a fragment with nowhere to land just
vanishes:

`#cart-panel` · `#cart-page` · `#checkout-body` · `#order-summary` · `#quick-body` ·
`#pincode-info` · `#pdp-delivery`

Keep these endpoints wired with these fields:

| Endpoint | Fields |
|---|---|
| `POST /cart/add` | `id`, `size`, `color`, `qty` |
| `POST /cart/update`, `/cart/remove` | line index |
| `POST /cart/coupon` | `code` |
| `POST /checkout/step/:n` | `_from` plus that step's fields |
| `POST /checkout/quote` | delivery method, gift wrap |
| `POST /checkout/pincode` | `pincode` |
| `POST /wishlist/toggle/:id` | — |
| `GET /fragments/quick-view/:slug` | — |

Alpine store hooks the page needs: `$store.ui.cart` (bag drawer),
`$store.ui.openQuick()`, `$store.ui.menu` (mobile drawer), `$store.ui.canInstall` and
`$store.ui.install()` (add to home screen).

**Name form inputs carefully.** HTMX sends the whole enclosing form with any request from
a control inside it. An input named the same as a field on that form arrives twice and
the wrong value wins — this turned a stock count of 9 into 0, with a toast confirming the
save.

---

## 5. What is yours to change

Freely: layout, spacing, type scale, image ratios, hero shape, header shape, card shape,
section order, animation, the copy that is not listed above.

`config.theme` already carries 10 colour tokens, two font families and two radii — a
theme that only wants a different palette needs no files at all, just config.

---

## 6. Before you say it is done

```bash
npm run theme:check -- <name>    # the contract
npm test                         # nothing in src/ was touched
```

If the harness fails, it names the broken point in a sentence. Fix that, not the check.

If you had to change something in `src/` to make a design work, that is a signal the base
is missing a hook — say so rather than patching around it. A hook added to the base helps
every client; a workaround in one theme helps one and rots.
