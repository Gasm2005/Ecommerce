'use strict';

/**
 * Admin authentication and roles.
 *
 * The gate that matters is server-side. A hidden sidebar link is decoration; if
 * can() says yes to staff for settings, staff can change the store's prices.
 * These tests also pin the things that quietly rot: password hashes never stored
 * in the clear, reset links usable once, the last owner undeletable.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sandbox } = require('./helpers/sandbox');

sandbox();
const auth = require('../src/auth');

const PASSWORD = 'CorrectHorse42';

function makeUsers() {
  const owner = auth.createUser({ name: 'Owner', email: 'owner@test.example', password: PASSWORD, role: 'owner' });
  const manager = auth.createUser({ name: 'Manager', email: 'manager@test.example', password: PASSWORD, role: 'manager' });
  const staff = auth.createUser({ name: 'Staff', email: 'staff@test.example', password: PASSWORD, role: 'staff' });
  return { owner, manager, staff };
}
const { owner, manager, staff } = makeUsers();

/* ---------------------------------------------------------- passwords ---- */

test('a weak password is refused with a reason', () => {
  assert.ok(auth.passwordProblem('short'), 'too short must be refused');
  assert.ok(auth.passwordProblem('alllowercase123'), 'no capital must be refused');
  assert.ok(auth.passwordProblem('NoDigitsHereAtAll'), 'no number must be refused');
  assert.equal(auth.passwordProblem(PASSWORD), null, 'a good password passes');
});

test('passwords are hashed with a salt, never stored in the clear', () => {
  const stored = auth.findByEmail('owner@test.example');
  assert.match(stored.passwordHash, /^scrypt\$/);
  assert.ok(!stored.passwordHash.includes(PASSWORD), 'the password leaked into the hash field');
  assert.equal(stored.password, undefined, 'no plain-text password field may exist');
});

test('the same password hashes differently for two users', () => {
  const a = auth.hashPassword(PASSWORD);
  const b = auth.hashPassword(PASSWORD);
  assert.notEqual(a, b, 'a missing salt would make these identical');
  assert.equal(auth.verifyPassword(PASSWORD, a), true);
  assert.equal(auth.verifyPassword(PASSWORD, b), true);
});

test('verification rejects the wrong password and malformed hashes', () => {
  const hash = auth.hashPassword(PASSWORD);
  assert.equal(auth.verifyPassword('WrongPassword9', hash), false);
  assert.equal(auth.verifyPassword('', hash), false);
  assert.equal(auth.verifyPassword(PASSWORD, 'not-a-hash'), false);
  assert.equal(auth.verifyPassword(PASSWORD, ''), false);
});

/* ------------------------------------------------------------- login ---- */

test('login succeeds with the right password and fails with the wrong one', () => {
  const good = auth.login({ email: 'manager@test.example', password: PASSWORD, ip: '1.1.1.1' });
  assert.equal(good.ok, true);
  assert.equal(good.user.role, 'manager');

  const bad = auth.login({ email: 'manager@test.example', password: 'Nope12345678', ip: '1.1.1.2' });
  assert.equal(bad.ok, false);
});

test('a failed login says the same thing whether or not the email exists', () => {
  // Different wording would let anyone enumerate the store's staff accounts.
  const noSuchUser = auth.login({ email: 'ghost@test.example', password: 'Whatever12345', ip: '2.2.2.1' });
  const wrongPass = auth.login({ email: 'staff@test.example', password: 'Whatever12345', ip: '2.2.2.2' });
  assert.equal(noSuchUser.ok, false);
  assert.equal(wrongPass.ok, false);
  assert.equal(noSuchUser.reason, wrongPass.reason, 'the two messages must be identical');
});

test('repeated failures lock the attempt out', () => {
  const ip = '3.3.3.3';
  let last = null;
  for (let i = 0; i < 10; i += 1) {
    last = auth.login({ email: 'staff@test.example', password: 'WrongOne12345', ip });
  }
  assert.equal(last.ok, false);
  assert.match(last.reason, /too many/i, 'brute force must be throttled: ' + last.reason);
});

/* -------------------------------------------------------------- roles ---- */

test('owner can reach every section', () => {
  ['dashboard', 'orders', 'products', 'settings', 'reports', 'marketing', 'discounts', 'returns'].forEach((section) => {
    assert.equal(auth.can(owner, section), true, `owner blocked from ${section}`);
  });
});

test('staff cannot reach the sections that change money or configuration', () => {
  ['settings', 'products', 'reports', 'marketing', 'discounts'].forEach((section) => {
    assert.equal(auth.can(staff, section), false, `staff must not reach ${section}`);
  });
});

test('staff can still do the day job', () => {
  ['dashboard', 'orders', 'returns'].forEach((section) => {
    assert.equal(auth.can(staff, section), true, `staff needs ${section}`);
  });
});

test('manager runs the shop but cannot change settings', () => {
  ['products', 'reports', 'marketing', 'orders'].forEach((section) => {
    assert.equal(auth.can(manager, section), true, `manager needs ${section}`);
  });
  assert.equal(auth.can(manager, 'settings'), false, 'only an owner touches settings');
});

test('no user and unknown sections are refused, not defaulted to allowed', () => {
  assert.equal(auth.can(null, 'orders'), false);
  assert.equal(auth.can(undefined, 'dashboard'), false);
  assert.equal(auth.can(staff, 'nonexistent-section'), false);
});

test('a disabled account loses access even with the right password', () => {
  auth.updateUser(staff.id, { active: false });
  const out = auth.login({ email: 'staff@test.example', password: PASSWORD, ip: '4.4.4.4' });
  assert.equal(out.ok, false);
  auth.updateUser(staff.id, { active: true });
});

/* -------------------------------------------------------- user records ---- */

test('an owner cannot be deleted while they are the only one', () => {
  // Otherwise a store locks its own owner out with one click.
  const before = auth.users().filter((u) => u.role === 'owner' && u.active).length;
  assert.equal(before, 1, 'fixture should have exactly one owner');
  assert.throws(() => auth.removeUser(owner.id), /owner/i);
  assert.ok(auth.findById(owner.id), 'the owner survived');
});

test('a second owner makes the first deletable', () => {
  const spare = auth.createUser({ name: 'Spare', email: 'spare@test.example', password: PASSWORD, role: 'owner' });
  assert.doesNotThrow(() => auth.removeUser(spare.id));
  assert.equal(auth.findById(spare.id), null);
});

test('a public user object never carries the hash', () => {
  const view = auth.publicUser(auth.findByEmail('owner@test.example'));
  assert.equal(view.passwordHash, undefined, 'the hash must not reach a template');
  assert.ok(view.email && view.role);
});

test('an unknown role is refused rather than silently granted', () => {
  auth.updateUser(staff.id, { role: 'superadmin' });
  assert.equal(auth.findById(staff.id).role, 'staff', 'the role must be unchanged');
});

/* ------------------------------------------------------------- resets ---- */

test('a reset link works once and dies with the password it was issued for', () => {
  const user = auth.findByEmail('manager@test.example');
  const token = auth.resetToken(user);

  assert.ok(auth.resolveReset(token), 'a fresh token must resolve');
  auth.completeReset(token, 'BrandNewPass77');
  assert.equal(auth.resolveReset(token), null, 'a used token must not resolve again');

  // And the new password is the one that works now.
  assert.equal(auth.login({ email: 'manager@test.example', password: 'BrandNewPass77', ip: '5.5.5.1' }).ok, true);
  assert.equal(auth.login({ email: 'manager@test.example', password: PASSWORD, ip: '5.5.5.2' }).ok, false);
});

test('a forged or tampered token never resolves', () => {
  assert.equal(auth.resolveReset('total.rubbish'), null);
  assert.equal(auth.resolveReset(''), null);

  const real = auth.resetToken(auth.findByEmail('owner@test.example'));
  const tampered = real.slice(0, -3) + 'aaa';
  assert.equal(auth.resolveReset(tampered), null, 'signature check failed to reject');
});
