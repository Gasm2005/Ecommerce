'use strict';

/**
 * The seam between how the shop looks and how it works.
 *
 * Every client wants their own storefront, and the way that usually goes is: clone the
 * repo, redesign it, hand it over. Do that ten times and one bug lives in ten folders.
 * The six bugs found in a single day of work on this codebase were all in src/ — the
 * stock matching, the mail health check, the audience switch, the provisioning guard —
 * and not one of them was in a view. A fork would have carried every one of them into
 * every client.
 *
 * So a theme is a DIFF, not a copy. It contains only the files whose LOOK differs;
 * everything else falls through to views/. A client wanting a new hero and a new product
 * card ships two files, not forty-five.
 *
 * Handing over code still works exactly the same: flatten base + theme at handover and
 * the client owns a complete repo on their own domain, hosting and database. What stays
 * on our side is one base that all themes are built against, so a fix is a fix once.
 *
 * ── how resolution works, and the trap in it ──
 *
 * Express takes an array for `views`, so res.render('pages/home') finds the theme's copy
 * first. That part is easy. The trap is include(): EJS resolves a root-relative include
 * against THE INCLUDING FILE'S OWN DIRECTORY before it consults the views roots. So a
 * base page including 'partials/header' finds the base header sitting next to it and
 * never looks at the theme at all — which would mean overriding a partial required
 * overriding every page that includes it, and "a theme is a diff" would be a lie.
 *
 * Hence view(): it resolves theme-first and returns an ABSOLUTE path, which EJS honours
 * without second-guessing. Views call include(view('partials/header')).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASE_DIR = path.join(ROOT, 'views');
const THEMES_DIR = path.join(ROOT, 'themes');

/** Themes on disk, whether or not any config mentions them. */
function available() {
  if (!fs.existsSync(THEMES_DIR)) return [];
  return fs.readdirSync(THEMES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

function dirOf(name) {
  const clean = String(name || '').trim();
  // Nothing from a config gets to walk out of themes/.
  if (!clean || clean !== path.basename(clean)) return null;
  const dir = path.join(THEMES_DIR, clean);
  return fs.existsSync(dir) ? dir : null;
}

/**
 * The theme in force. THEME env var wins over config, so a preview can run one theme
 * without editing the store it is previewing.
 */
function current(config) {
  const wanted = process.env.THEME || (config && config.theme && config.theme.name) || '';
  if (!wanted) return null;
  return dirOf(wanted) ? String(wanted).trim() : null;
}

/** Where to look, in order. Always ends at views/, so nothing can 404 for want of a theme. */
function roots(config) {
  const name = current(config);
  const dir = name && dirOf(name);
  return dir ? [dir, BASE_DIR] : [BASE_DIR];
}

/**
 * Resolves one view name to an absolute path, theme first.
 *
 * Absolute on purpose: a relative include would be resolved against the including
 * file's directory, which is exactly the trap described above.
 */
function resolver(config) {
  const search = roots(config);

  function view(name) {
    const clean = String(name || '').replace(/\.ejs$/, '');
    for (const dir of search) {
      const candidate = path.join(dir, clean + '.ejs');
      if (fs.existsSync(candidate)) return candidate;
    }
    /* Loud on purpose. A silent miss here renders a page with a hole in it, and the
       hole is usually the header or the buy button. */
    throw new Error(
      `No view "${clean}" in ${search.map((d) => path.relative(ROOT, d)).join(' or ')}`
    );
  }

  /**
   * The BASE version of a view, skipping the theme's own.
   *
   * For a theme that overrides a dispatcher and only handles some of its cases — a home
   * section renderer that restyles the grid but has nothing to say about the editorial
   * block. Without this, falling through to the base would resolve to the theme's own
   * file again and recurse until the stack gave out; the alternative is mirroring every
   * case the base handles, which is how a theme quietly stops rendering a section the
   * shop configured a year later.
   */
  view.base = function base(name) {
    const clean = String(name || '').replace(/\.ejs$/, '');
    const candidate = path.join(BASE_DIR, clean + '.ejs');
    if (fs.existsSync(candidate)) return candidate;
    throw new Error(`No base view "${clean}" in ${path.relative(ROOT, BASE_DIR)}`);
  };

  return view;
}

/** Which files a theme actually overrides — the diff, for tooling and for the harness. */
function overrides(name) {
  const dir = dirOf(name);
  if (!dir) return [];

  const out = [];
  (function walk(at) {
    fs.readdirSync(at, { withFileTypes: true }).forEach((entry) => {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) return walk(full);
      if (entry.name.endsWith('.ejs')) out.push(path.relative(dir, full).replace(/\\/g, '/'));
    });
  })(dir);

  return out.sort();
}

/**
 * Overridden files with no counterpart in views/.
 *
 * Usually a typo — pages/prodcut.ejs — and it fails in the worst way: the theme looks
 * installed, the file is never reached, and the base view renders instead. Nothing is
 * broken enough to notice.
 */
function orphans(name) {
  return overrides(name).filter((rel) => !fs.existsSync(path.join(BASE_DIR, rel)));
}

module.exports = {
  BASE_DIR, THEMES_DIR,
  available, dirOf, current, roots, resolver, overrides, orphans
};
