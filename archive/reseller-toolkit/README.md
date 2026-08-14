# Reseller toolkit — parked, not deleted

This folder holds the machinery that made the storefront a **resellable SaaS product**:
one codebase sold to many businesses under a signed licence key, with features locked
behind plan tiers. The live build in this repo is now a **dedicated, fully-unlocked site
for a single business (AANYÄ)**, so none of this runs — but it is kept intact for when a
multi-client, licensed version is wanted again.

## What's here

| Path | Was |
|---|---|
| `src/license.js` | Ed25519 licence keys — verify offline, lock the admin when lapsed |
| `src/minting.js` | Signs licence keys (agency machine only) |
| `src/plan.js` | 18 features across 3 tiers; `hasFeature` / `sectionUnlocked` |
| `src/provision.js` | Turns a filled-in client spec into a configured store |
| `scripts/issue-license.js` | CLI to mint a key per client |
| `scripts/provision.js` | CLI: sold → live in one pass |
| `routes/gate.js.orig` | The three-question admin gate (role → licence → plan) |
| `views/admin/{license,plan,locked}.ejs` | Licence screen, plan screen, the padlock wall |
| `test/{license,plan,plan-gate,provision}.test.js` | 81 tests for all of the above |

## How the live build was disconnected

Nothing in `src/` imports any of these any more. The seams left behind, so reconnecting
is mechanical rather than archaeological:

- **`src/routes/gate.js`** — now role-only. The archived `gate.js.orig` is the full wall.
- **`server.js`** — `res.locals.hasFeature` returns `true`; `storefrontFeature()` is a
  pass-through; `codConfigFor()` returns the config unchanged. Each was left as a named
  function so a plan check can be dropped back in at one spot, not nine.
- **`src/routes/admin.js`** — the `/license`, `/license/remove` and `/plan` routes and
  `licenseModel()` are gone; `hasFeature` local returns true.
- **`views/admin/partials/open.ejs`** — Plan & Licence nav links and the padlock branch
  removed; every visible section is a live link.
- **`scripts/doctor.js`** — the licence check and the plan/demo-brand config checks
  removed.
- **config** — `plan` / `planExtras` keys dropped from `config/site.config.json`.

## To restore the SaaS build

1. Move `src/{license,plan,minting,provision}.js` and `scripts/{issue-license,provision}.js`
   back to their homes.
2. Replace `src/routes/gate.js` with `gate.js.orig`.
3. Undo the seam changes above (git history for this commit shows each one).
4. Move the four test files back and run `npm test`.
5. Set `"plan"` in the store's config again.
