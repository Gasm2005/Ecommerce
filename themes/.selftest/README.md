# .selftest — not a real theme

A deliberately broken theme, kept so the harness can prove it still catches things. A
check nobody has watched fail is not a check; it is decoration that happens to be green.

Skipped by `--all` (the dot prefix), run by `npm run theme:check -- --self-test`.

What is wrong with it, on purpose:

| Break | Which check should fail |
|---|---|
| `data-stock` in a double-quoted attribute, so the JSON's own quotes close it early | the stock map is unparseable |
| the sticky bar loses its own copy of the map | only one stock map on the page |
| a card that ignores sold-out entirely | a listing card admits when a piece is sold out |
| `pages/prodcut.ejs` — a typo | overrides nothing in views/ |

The typo is the nastiest of the four in real life: the theme looks installed, the file is
never reached, and the base view renders instead. Nothing is broken enough to notice.
