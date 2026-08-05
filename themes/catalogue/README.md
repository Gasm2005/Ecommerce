# catalogue

A denser, retail-first look — the opposite end from the base theme's editorial spacing.
Suits a shop with a wide catalogue and a customer who scans rather than reads.

This theme overrides two files. Everything else falls through to `views/`, which is the
point: a theme is a diff. When a bug is fixed in the base, this theme gets the fix.

| File | What changes |
|---|---|
| `partials/product-card.ejs` | Price and name sit **on** the image, not below it — 4-up reads as one block rather than a list |

Run it with `THEME=catalogue npm start`, or set `theme.name` in `config/site.config.json`.
