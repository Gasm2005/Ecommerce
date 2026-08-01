'use strict';

/**
 * Admin authentication.
 *
 * No dependencies: scrypt for password hashing and an HMAC-signed cookie for the
 * session, both from node:crypto. Sessions are stateless, so a server restart
 * doesn't log everyone out and nothing needs a session store — which matters for
 * a multi-store setup where each store shouldn't carry its own Redis.
 *
 * First run: with no users saved, /admin/login shows a one-time setup form that
 * creates the owner. There is no default password to forget to change.
 *
 * ADMIN_TOKEN still works when set, as an escape hatch for scripts and curl —
 * documented, and separate from human logins.
 */

const crypto = require('crypto');
const store = require('./store');
const secrets = require('./secrets');

const COOKIE = 'aanya_admin';
const SESSION_DAYS = 14;
const SCRYPT_KEYLEN = 64;
const MAX_ATTEMPTS = 8;             // per email, per window
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

const ROLES = [
  { id: 'owner', label: 'Owner', hint: 'Everything, including settings, users and finance.' },
  { id: 'manager', label: 'Manager', hint: 'Orders, products, content — no settings or finance.' },
  { id: 'staff', label: 'Staff', hint: 'Orders and returns only.' }
];

/* Which admin sections each role may open. Checked in the router, not just hidden
   in the sidebar — a hidden link is not a permission. */
const PERMISSIONS = {
  owner: ['*'],
  manager: ['dashboard', 'orders', 'returns', 'customers', 'products', 'categories', 'import', 'reviews', 'journal', 'marketing', 'discounts', 'reports'],
  staff: ['dashboard', 'orders', 'returns']
};

/* ------------------------------------------------------------ passwords ---- */

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, expected] = parts;
  const actual = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN).toString('hex');
  // Constant-time: a length mismatch alone must not leak through timing.
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

/** Weak passwords are the most likely way a store gets breached. */
function passwordProblem(password) {
  const p = String(password || '');
  if (p.length < 10) return 'Use at least 10 characters.';
  if (!/[a-z]/.test(p) || !/[A-Z]/.test(p)) return 'Mix upper and lower case.';
  if (!/[0-9]/.test(p)) return 'Include at least one number.';
  if (/^(password|admin|12345|qwerty|welcome)/i.test(p)) return 'That is one of the first passwords anyone tries.';
  return null;
}

/* --------------------------------------------------------------- users ---- */

function users() {
  return store.read('users', []);
}

function isFirstRun() {
  return users().length === 0;
}

function findByEmail(email) {
  const needle = String(email || '').trim().toLowerCase();
  return users().find((u) => u.email === needle) || null;
}

function findById(id) {
  return users().find((u) => u.id === id) || null;
}

function publicUser(u) {
  if (!u) return null;
  const { passwordHash, ...rest } = u;
  return rest;
}

function createUser({ name, email, password, role }) {
  const clean = String(email || '').trim().toLowerCase();
  if (!clean || !/^\S+@\S+\.\S+$/.test(clean)) throw new Error('Enter a valid email address.');
  if (findByEmail(clean)) throw new Error('That email already has an account.');

  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);

  const list = users();
  const user = {
    id: store.nextId('USR', list),
    name: String(name || '').trim() || clean.split('@')[0],
    email: clean,
    // The very first account is always the owner — otherwise nobody could
    // reach settings.
    role: list.length === 0 ? 'owner' : (ROLES.some((r) => r.id === role) ? role : 'staff'),
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
    lastLoginAt: null,
    active: true
  };

  store.write('users', [...list, user], { skipBackup: true });
  return publicUser(user);
}

function updateUser(id, patch) {
  let updated = null;
  store.update('users', [], (list) => list.map((u) => {
    if (u.id !== id) return u;
    const next = { ...u };
    if (patch.name !== undefined) next.name = String(patch.name).trim() || u.name;
    if (patch.role !== undefined && ROLES.some((r) => r.id === patch.role)) next.role = patch.role;
    if (patch.active !== undefined) next.active = !!patch.active;
    if (patch.password) {
      const problem = passwordProblem(patch.password);
      if (problem) throw new Error(problem);
      next.passwordHash = hashPassword(patch.password);
      next.passwordChangedAt = new Date().toISOString();
    }
    updated = next;
    return next;
  }), { skipBackup: true });
  return publicUser(updated);
}

/** The last owner can't be removed or demoted — that would lock everyone out. */
function removeUser(id) {
  const list = users();
  const target = list.find((u) => u.id === id);
  if (!target) return null;
  const owners = list.filter((u) => u.role === 'owner' && u.active);
  if (target.role === 'owner' && owners.length <= 1) {
    throw new Error('This is the only owner — promote someone else first.');
  }
  store.write('users', list.filter((u) => u.id !== id), { skipBackup: true });
  return publicUser(target);
}

/* ------------------------------------------------------------ sessions ---- */

/** Server-side signing key, generated once and kept with the other secrets. */
function sessionKey() {
  let key = secrets.get('auth.sessionKey');
  if (!key) {
    key = crypto.randomBytes(32).toString('hex');
    secrets.set('auth.sessionKey', key);
  }
  return key;
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const mac = crypto.createHmac('sha256', sessionKey()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function unsign(token) {
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', sessionKey()).update(body).digest('base64url');
  if (expected.length !== mac.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(mac))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function startSession(res, user) {
  const token = sign({
    uid: user.id,
    role: user.role,
    exp: Date.now() + SESSION_DAYS * 24 * 3600 * 1000
  });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DAYS * 24 * 3600 * 1000,
    secure: process.env.NODE_ENV === 'production'
  });
}

function endSession(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

/** The signed-in user, or null. Re-read from disk so a disabled account dies at once. */
function currentUser(req) {
  const payload = unsign(req.cookies && req.cookies[COOKIE]);
  if (!payload) return null;
  const user = findById(payload.uid);
  if (!user || !user.active) return null;
  return publicUser(user);
}

/* ------------------------------------------------------------ attempts ---- */
/* In-memory: a restart clears them, which is an acceptable trade for zero deps. */

const attempts = new Map();

function attemptKey(email, ip) {
  return String(email || '').toLowerCase() + '|' + (ip || '');
}

function tooManyAttempts(email, ip) {
  const row = attempts.get(attemptKey(email, ip));
  if (!row) return false;
  if (Date.now() - row.first > ATTEMPT_WINDOW_MS) {
    attempts.delete(attemptKey(email, ip));
    return false;
  }
  return row.count >= MAX_ATTEMPTS;
}

function recordFailure(email, ip) {
  const key = attemptKey(email, ip);
  const row = attempts.get(key);
  if (!row || Date.now() - row.first > ATTEMPT_WINDOW_MS) {
    attempts.set(key, { count: 1, first: Date.now() });
  } else {
    row.count += 1;
  }
}

function clearAttempts(email, ip) {
  attempts.delete(attemptKey(email, ip));
}

/* --------------------------------------------------------------- login ---- */

function login({ email, password, ip }) {
  if (tooManyAttempts(email, ip)) {
    return { ok: false, reason: 'Too many attempts. Wait fifteen minutes and try again.' };
  }

  const user = findByEmail(email);
  // Deliberately the same message either way: don't confirm which emails exist.
  const generic = { ok: false, reason: 'Email or password is incorrect.' };

  if (!user || !user.active) {
    recordFailure(email, ip);
    return generic;
  }
  if (!verifyPassword(password, user.passwordHash)) {
    recordFailure(email, ip);
    return generic;
  }

  clearAttempts(email, ip);
  store.update('users', [], (list) => list.map((u) =>
    (u.id === user.id ? { ...u, lastLoginAt: new Date().toISOString() } : u)
  ), { skipBackup: true });

  return { ok: true, user: publicUser(user) };
}

/* --------------------------------------------------------- password reset ---- */
/**
 * Reset links are signed, single-use and short-lived. Single-use comes from
 * binding the token to the current password hash: once the password changes, the
 * signature no longer matches, so a leaked or reused link is dead.
 *
 * No token table, no cleanup job — which is the point.
 */
const RESET_TTL_MS = 60 * 60 * 1000;

function resetToken(user) {
  const fingerprint = crypto.createHash('sha256').update(user.passwordHash).digest('hex').slice(0, 16);
  return sign({ uid: user.id, fp: fingerprint, exp: Date.now() + RESET_TTL_MS, kind: 'reset' });
}

function resetLink(user, origin) {
  return `${origin}/admin/reset?token=${encodeURIComponent(resetToken(user))}`;
}

/** Returns the user the token is for, or null if it's expired/used/forged. */
function resolveReset(token) {
  const payload = unsign(token);
  if (!payload || payload.kind !== 'reset') return null;
  const user = findById(payload.uid);
  if (!user || !user.active) return null;
  const fingerprint = crypto.createHash('sha256').update(user.passwordHash).digest('hex').slice(0, 16);
  if (fingerprint !== payload.fp) return null;   // password already changed
  return publicUser(user);
}

function completeReset(token, newPassword) {
  const user = resolveReset(token);
  if (!user) return { ok: false, reason: 'That link has expired or has already been used.' };
  const problem = passwordProblem(newPassword);
  if (problem) return { ok: false, reason: problem };
  updateUser(user.id, { password: newPassword });
  return { ok: true, user: findById(user.id) ? publicUser(findById(user.id)) : null };
}

/* ---------------------------------------------------------- permissions ---- */

function can(user, section) {
  if (!user) return false;
  const allowed = PERMISSIONS[user.role] || [];
  return allowed.includes('*') || allowed.includes(section);
}

module.exports = {
  COOKIE, ROLES, PERMISSIONS,
  isFirstRun, users, findByEmail, findById, publicUser,
  createUser, updateUser, removeUser,
  hashPassword, verifyPassword, passwordProblem,
  startSession, endSession, currentUser, login, can,
  resetToken, resetLink, resolveReset, completeReset
};
