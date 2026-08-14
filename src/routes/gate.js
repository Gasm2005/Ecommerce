'use strict';

/**
 * The one gate every admin route passes through.
 *
 * One question: ROLE. May this person do this? Staff get 403.
 *
 * This used to ask two more questions first — licence, then plan — because the
 * codebase was built to be resold to many clients under a licence key, with
 * features locked behind a plan tier. That whole toolkit (licence signing,
 * plan gating, the reseller provisioning script) has been parked in
 * archive/reseller-toolkit/ rather than deleted: this build is a dedicated,
 * fully-unlocked site for one business, and there was nothing to gate. If a
 * resold, licensed version is ever needed again, the archived gate.js.orig in
 * that folder is the wall this one used to be — restoring it is a matter of
 * bringing plan.js and license.js back and re-adding the two checks below the
 * role check, in that order (role, then licence, then plan; asking about plans
 * first would show a staff member what their employer didn't buy, which was
 * never their business).
 */

const auth = require('../auth');
const { loadConfig } = require('../config');

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
    return next();
  };
}

module.exports = { requireSection };
