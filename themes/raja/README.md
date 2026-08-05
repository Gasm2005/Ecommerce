# raja — Raja Whole Sale, Gonda

A **retail** shop. The name says "whole sale" because the rates are wholesale-like, not
because the customer is a trader — so nothing here talks about bulk orders or minimum
quantities, and every line addresses a family buying for itself.

Sells to men, women and children, and the storefront opens on **Everything** rather than
one section: a mother buying for a husband and two children wants one shop.

Run: `npm run raja` · Check: `npm run theme:check -- raja`

## Three overrides, and only three

An earlier version of this theme replaced the homepage, the sections, the header and the
card — dense rows, no serif, coloured rectangles where the hero should be — and it looked
cheap next to the base it replaced. The base template is well made; the mistake was
throwing its craft away in pursuit of "value shop means dense".

What the shop's business actually requires is narrower than that:

| File | Change | Why |
|---|---|---|
| `partials/product-card.ejs` | Price reads before the name and in the heavier weight; discount badge; an action on the card | This shopper compares across a rail rather than considering one piece, and forty comparisons should not cost forty page loads |
| `partials/header.ejs` | Scrolling offer strip, always-open search, call button, and a type scale one notch up | A value shop needs to say what is on today; this shopper arrives knowing "jeans 34"; in this trade a rate is a phone call |
| `pages/home.ejs` | A darker hero scrim | The base's `from-ink/55` is plenty over bridal photography and nearly unreadable over this shop's pale sand-and-gold art |

Everything else — the hero, the sections, the listing, the bag, checkout, stock, tax,
invoices — is the base's, and gets every fix made there.

The palette and the copy live in `clients/raja-wholesale.config.json`. Emerald and gold on
warm ivory, which is the register an Indian garment shop already lives in and clearly not
the base store's bridal maroon. The views read token *names*, so that swap changed no
markup at all.

## Still to confirm before the demo

Not filled in on purpose. A wrong address on a demo is worse than a blank one.

- [ ] **The address.** Justdial lists Karbala, Circular Road, Utraula Road, Gonda 271003.
      Third-party and unverified — the Google listing would not open, and the Instagram
      link was an aggregate page mixing this shop with a differently-named fabric shop at
      Bharat Milap Chauraha.
- [ ] **Email** — `orders@example.com` is a placeholder. The phone is yours: 7408690994.
- [ ] **The numbers in the trust row** — the Google rating is from the listing; "2,000+
      designs" is a guess and should be the shop's own figure or removed.
- [ ] **GSTIN and PAN** — needed before provisioning, not before the demo.
- [ ] **Photography.** Every product still uses generated placeholder art. Fifteen real
      photographs and real prices will change this demo more than any code here.
