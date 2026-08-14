'use strict';

/**
 * The one gate every admin route passes through.
 *
 * Three questions, in this order:
 *   1. ROLE     may this person do this? Staff get 403.
 *   2. LICENCE  is this store's licence in order? A lapsed one locks the admin.
 *   3. PLAN     did this store buy this feature? 402 and an upgrade page.
 *
 * Order matters. Asking about plans first would show a staff member which
 * features their employer didn't pay for, which is the client's business.
 *
 * The storefront is never gated here. A licence dispute is between the agency and
 * the client; the client's own customers keep shopping.
 */

const auth = require('../auth');
const plan = require('../plan');
const license = require('../license');
const { loadConfig } = require('../config');

/** Pages a store can always reach, even with a lapsed licence. */
const ALWAYS_OPEN = ['/license', '/logout', '/account', '/plan'];

function licenceWall(req, res) {
  const status = license.status(req.get('host'));
  if (!status.restricted) return false;
  if (ALWAYS_OPEN.some((p) => req.path === p || req.path.startsWith(p + '/'))) return false;

  res.status(402).render('admin/license', {
    status,
    shortId: license.shortId(status.licence),
    saved: false,
    error: null,
    wall: true
  });
  return true;
}

function requireSection(section) {
  return function sectionGate(req, res, next) {
    if (!auth.can(res.locals.user, section)) {
      return res.status(403).render('admin/forbidden', {
        adminTitle: 'Not allowed',
        section,
        config: loadConfig(),
        user: res.locals.user
      });
    }

    if (licenceWall(req, res)) return undefined;

    const config = loadConfig();
    const host = req.get('host');
    if (!plan.sectionUnlocked(config, section, host)) {
      const feature = plan.FEATURES.find((f) => f.section === section);
      const info = plan.overview(config, host);
      return res.status(402).render('admin/locked', {
        feature: feature || { id: section, label: section },
        plan: info.plan,
        unlockedBy: (info.features.find((f) => f.section === section) || {}).unlockedBy || info.upgradeTo
      });
    }

    return next();
  };
}

/** Gate a single capability that isn't a whole admin section. */
function requireFeature(id) {
  return plan.requireFeature(id);
}

module.exports = { requireSection, requireFeature, licenceWall, ALWAYS_OPEN };
