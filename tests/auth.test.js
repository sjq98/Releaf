import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createAuth, clearSessionCookie, sessionCookie } from "../src/auth.js";

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  return { db, auth: createAuth(db) };
}

const adminInput = {
  username: "Root.Admin",
  displayName: "Workspace Admin",
  password: "correct horse battery staple",
};

test("initial setup creates exactly one admin and returns a hashed, expiring session", (t) => {
  const { db, auth } = fixture(t);
  assert.deepEqual(auth.status(), { setupRequired: true, user: null });

  const created = auth.setup(adminInput);
  assert.equal(created.user.username, "root.admin");
  assert.equal(created.user.displayName, "Workspace Admin");
  assert.equal(created.user.role, "admin");
  assert.equal(created.user.active, true);
  assert.equal(created.sessionToken.length, 43);
  assert.deepEqual(auth.authenticate(`other=value; releaf_session=${created.sessionToken}`), created.user);
  assert.deepEqual(auth.status(), { setupRequired: false, user: null });
  assert.equal(db.prepare("SELECT password_hash FROM auth_users").get().password_hash.includes(adminInput.password), false);
  assert.notEqual(db.prepare("SELECT token_hash FROM auth_sessions").get().token_hash, created.sessionToken);
  assert.throws(() => auth.setup({ ...adminInput, username: "another.admin" }), { status: 409 });
});

test("self-registration requires initial setup and always creates an active member", (t) => {
  const { db, auth } = fixture(t);
  const input = { username: "New.Member", displayName: "New Member", password: "a new member password" };
  assert.throws(() => auth.register(input, "before-setup"), { status: 409 });
  assert.equal(auth.status().setupRequired, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM auth_users").get().count, 0);
  auth.setup(adminInput);
  const created = auth.register({ ...input, role: "admin", active: false }, "new-device");
  assert.equal(created.user.username, "new.member");
  assert.equal(created.user.role, "user");
  assert.equal(created.user.active, true);
  assert.equal(auth.authenticate(sessionCookie(created.sessionToken)).id, created.user.id);
  assert.equal(auth.login(input, "member-login").user.id, created.user.id);
  assert.equal(auth.permissions(created.user).manageUsers, false);
  assert.equal(auth.permissions(created.user).manageOrders, true);
  assert.throws(() => auth.withUser(created.user, () => auth.requireAdmin()), { status: 403 });
  assert.equal(db.prepare("SELECT password_hash FROM auth_users WHERE id = ?").get(created.user.id).password_hash.includes(input.password), false);
});

test("self-registration validates credentials and duplicate usernames without leaving users or sessions", (t) => {
  const { db, auth } = fixture(t);
  auth.setup(adminInput);
  for (const input of [
    { username: "ab", password: "a valid member password" },
    { username: "new.member", password: "short" },
    { username: "new.member", displayName: "", password: "a valid member password" },
  ]) assert.throws(() => auth.register(input, "invalid-input"), { status: 400 });
  assert.throws(() => auth.register({ ...adminInput, username: "ROOT.ADMIN" }, "duplicate"), { status: 409 });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM auth_users").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM auth_sessions").get().count, 1);
});

test("registration is rate limited separately from sign-in and counts successful creation", (t) => {
  const { auth } = fixture(t);
  auth.setup(adminInput);
  const input = { username: "new.member", password: "a valid member password" };
  auth.register(input, "shared-device");
  for (let attempt = 1; attempt < 10; attempt++) {
    assert.throws(() => auth.register(input, "shared-device"), { status: 409 });
  }
  assert.throws(() => auth.register({ ...input, username: "next.member" }, "shared-device"), { status: 429 });
  assert.equal(auth.login(adminInput, "shared-device").user.role, "admin");
  assert.equal(auth.register({ ...input, username: "other.member" }, "other-device").user.role, "user");
});

test("login is case insensitive, rejects invalid credentials uniformly, and caps failures by rate key", (t) => {
  const { auth } = fixture(t);
  auth.setup(adminInput);
  const loggedIn = auth.login({ username: "ROOT.ADMIN", password: adminInput.password }, "127.0.0.1");
  assert.equal(auth.authenticate(sessionCookie(loggedIn.sessionToken)).id, loggedIn.user.id);
  assert.throws(() => auth.login({ username: "nobody", password: adminInput.password }, "192.0.2.1"), { status: 401 });
  for (let attempt = 0; attempt < 10; attempt++) {
    assert.throws(() => auth.login({ username: adminInput.username, password: "not the right password" }, "192.0.2.2"), { status: 401 });
  }
  assert.throws(() => auth.login({ username: adminInput.username, password: adminInput.password }, "192.0.2.2"), { status: 429 });
  assert.equal(auth.login({ username: adminInput.username, password: adminInput.password }, "192.0.2.3").user.id, loggedIn.user.id);
});

test("user management exposes role-derived permissions and admin checks use async context", (t) => {
  const { auth } = fixture(t);
  const setup = auth.setup(adminInput);
  const regular = auth.createUser({
    username: "operator_1",
    displayName: "Operator",
    password: "an operator password",
    role: "user",
  });
  assert.deepEqual(auth.permissions(regular), {
    manageUsers: false, manageForms: false, editRecords: false, manageSettings: false,
    manageOrders: true,
  });
  assert.deepEqual(auth.permissions(setup.user), {
    manageUsers: true, manageForms: true, editRecords: true, manageSettings: true,
    manageOrders: true,
  });
  assert.equal(auth.permissions(null).manageOrders, false);
  assert.equal(auth.permissions({ ...regular, active: false }).manageOrders, false);
  assert.equal(auth.listUsers().length, 2);
  assert.equal(auth.withUser(setup.user, () => auth.requireAdmin()).role, "admin");
  assert.throws(() => auth.withUser(regular, () => auth.requireAdmin()), { status: 403 });
  assert.throws(() => auth.withUser(regular, () => auth.listUsers()), { status: 403 });
  assert.throws(() => auth.withUser(regular, () => auth.createUser({
    username: "new.user", password: "another password", role: "admin",
  })), { status: 403 });
  assert.throws(() => auth.withUser(regular, () => auth.updateUser(regular.id, { role: "admin" })), { status: 403 });
  assert.equal(auth.withUser(undefined, () => auth.requireAdmin()), undefined);
  assert.throws(() => auth.createUser({
    username: "OPERATOR_1", displayName: "Duplicate", password: "another password", role: "user",
  }), { status: 409 });
});

test("password, role, and active changes revoke sessions and current role is reloaded", (t) => {
  const { auth } = fixture(t);
  const setup = auth.setup(adminInput);
  const regular = auth.createUser({
    username: "operator_1",
    displayName: "Operator",
    password: "an operator password",
    role: "user",
  });
  const oldSession = auth.login({ username: regular.username, password: "an operator password" }, "operator-device");
  assert.throws(() => auth.updateUser(setup.user.id, { active: false }), { status: 409 });
  auth.updateUser(regular.id, { role: "admin", password: "a replacement password" });
  assert.throws(() => auth.authenticate(sessionCookie(oldSession.sessionToken)), { status: 401 });
  assert.equal(auth.login({ username: regular.username, password: "a replacement password" }, "operator-device").user.role, "admin");
  auth.updateUser(regular.id, { active: false });
  assert.equal(auth.getUser(regular.id).active, false);
  assert.throws(() => auth.login({ username: regular.username, password: "a replacement password" }, "disabled-device"), { status: 401 });
});

test("logout and expiry invalidate session tokens; cookie helpers keep browser protections", (t) => {
  const { db, auth } = fixture(t);
  const setup = auth.setup(adminInput);
  const cookie = sessionCookie(setup.sessionToken);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Max-Age=604800/);
  assert.match(clearSessionCookie(), /Max-Age=0/);
  assert.equal(auth.logout(cookie).loggedOut, true);
  assert.throws(() => auth.authenticate(cookie), { status: 401 });

  const next = auth.login({ username: adminInput.username, password: adminInput.password });
  db.prepare("UPDATE auth_sessions SET expires_at = ? WHERE token_hash = ?")
    .run("2000-01-01T00:00:00.000Z", createHash("sha256").update(next.sessionToken).digest("hex"));
  assert.throws(() => auth.authenticate(sessionCookie(next.sessionToken)), { status: 401 });
});

test("self-service password changes verify credentials and replace every previous session", (t) => {
  const { auth } = fixture(t);
  const setup = auth.setup(adminInput);
  const secondSession = auth.login({ username: adminInput.username, password: adminInput.password });
  assert.throws(() => auth.changePassword({
    currentPassword: adminInput.password, password: "a new admin password",
  }), { status: 401 });
  assert.throws(() => auth.withUser(setup.user, () => auth.changePassword({
    currentPassword: "the wrong password", password: "a new admin password",
  })), { status: 401 });
  assert.equal(auth.authenticate(sessionCookie(setup.sessionToken)).id, setup.user.id);

  const changed = auth.withUser(setup.user, () => auth.changePassword({
    currentPassword: adminInput.password, password: "a new admin password",
  }));
  assert.equal(changed.user.id, setup.user.id);
  assert.throws(() => auth.authenticate(sessionCookie(setup.sessionToken)), { status: 401 });
  assert.throws(() => auth.authenticate(sessionCookie(secondSession.sessionToken)), { status: 401 });
  assert.equal(auth.authenticate(sessionCookie(changed.sessionToken)).id, setup.user.id);
  assert.throws(() => auth.login({ username: adminInput.username, password: adminInput.password }, "old-password-device"), { status: 401 });
  assert.equal(auth.login({ username: adminInput.username, password: "a new admin password" }, "new-password-device").user.id, setup.user.id);
});

test("scoped authorization revalidates disabled accounts without granting trusted internal access", async (t) => {
  const { db, auth } = fixture(t);
  const setup = auth.setup(adminInput);
  const secondAdmin = auth.createUser({
    username: "second.admin", password: "another admin password", role: "admin",
  });
  await auth.withUser(secondAdmin, async () => {
    await Promise.resolve();
    auth.updateUser(secondAdmin.id, { active: false });
    assert.throws(() => auth.currentUser(), { status: 401 });
    assert.throws(() => auth.requireAdmin(), { status: 401 });
    assert.throws(() => auth.listUsers(), { status: 401 });
  });
  await auth.withUser(setup.user, async () => {
    await Promise.resolve();
    db.prepare("DELETE FROM auth_users WHERE id = ?").run(setup.user.id);
    assert.throws(() => auth.currentUser(), { status: 401 });
    assert.throws(() => auth.requireAdmin(), { status: 401 });
  });
  assert.equal(auth.currentUser(), undefined);
});

test("user contexts remain local to the auth instance", (t) => {
  const first = fixture(t).auth;
  const second = fixture(t).auth;
  const created = first.setup(adminInput);
  first.withUser(created.user, () => {
    assert.equal(first.currentUser().id, created.user.id);
    assert.equal(second.currentUser(), undefined);
  });
});
