# raja — Raja Wholesale Cloth House, Gonda

Built for a real shop, and the reason it looks nothing like the base theme.

The base theme sells bridal couture: one piece, ₹1.5 lakh, twenty-one days to make, and
whitespace to let it breathe. Raja sells jeans at ₹400 and lehengas at ₹15,000 to whole
families, off a rack, today. Volume, not ceremony. Almost every design decision here is
that difference.

| Decision | Because |
|---|---|
| Dense grid, price larger than the name | The shopper is comparing prices across forty pieces, not reading about one |
| Discount badge and struck MRP are loud | This is a value shop and the value is the pitch |
| Phone and WhatsApp in the header, always | In this trade people call before they cart |
| Compact banner, then categories immediately | Nobody scrolls past a full-screen photo to find trousers |
| No audience popup — everything, with a strip to narrow | A mother buying for a husband and two children wants one shop, not a section |
| Wholesale enquiry on every product | Half the customers want a rate for twenty pieces, not one |

Overrides four files. Everything else — cart, checkout, stock, tax, invoices — falls
through to the base and gets every fix made there.

| File | What changes |
|---|---|
| `partials/product-card.ejs` | Price-first, denser, discount badge prominent |
| `pages/home.ejs` | Banner + category strip instead of a full-bleed hero |
| `partials/header.ejs` | Phone and WhatsApp visible, no logo-centred luxury spacing |
| `fragments/home-section.ejs` | Tighter section rhythm to match the grid |

Run: `THEME=raja npm start` · Check: `npm run theme:check -- raja`

## Still to confirm with the shop

Not hard-coded, on purpose — a wrong address on a demo is worse than a blank one.

- [ ] Exact shop address and phone (Justdial says Utraula Road / Karbala, Circular Road, Gonda 271003 — third-party, unverified)
- [ ] WhatsApp number for order enquiries
- [ ] Whether wholesale rates are shown publicly or only on enquiry
- [ ] GSTIN and PAN, before provisioning (the demo does not need them)
