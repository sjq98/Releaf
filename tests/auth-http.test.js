import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.js";

async function fixture(t) {
  const app = createApp({ database: ":memory:", env: {} });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (path, { body, cookie, origin = base } = {}) => fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { app, request };
}

test("a clean installation has no accounts or business records and retains login protection", async t => {
  const { app, request } = await fixture(t);
  assert.equal((await (await request("/api/auth/status")).json()).setupRequired, true);
  assert.equal(app.store.auth.listUsers().length, 0);
  for (const space of app.store.spaces.list()) {
    for (const form of app.store.listForms(space.id)) assert.equal(app.store.listRecords(form.id).length, 0);
  }
  assert.equal((await request("/api/bootstrap")).status, 401);
  assert.equal((await request("/api/auth/register", {
    body: { username: "new.member", password: "a valid member password" },
  })).status, 409);
  assert.equal((await (await request("/api/auth/status")).json()).setupRequired, true);
});

test("public registration issues a member session, preserves admin restrictions and supports later login", async t => {
  const { request } = await fixture(t);
  const admin = await request("/api/auth/setup", {
    body: { username: "first.admin", password: "a valid admin password" },
  });
  assert.equal(admin.status, 201);
  assert.equal((await admin.json()).user.role, "admin");
  const input = { username: "new.member", displayName: "New Member", password: "a valid member password" };
  const registration = await request("/api/auth/register", { body: { ...input, role: "admin", active: false } });
  assert.equal(registration.status, 201);
  assert.match(registration.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  const cookie = registration.headers.get("set-cookie").split(";")[0];
  const session = await registration.json();
  assert.equal(session.user.role, "user");
  assert.equal(session.user.active, true);
  assert.equal(session.permissions.manageUsers, false);
  const bootstrap = await request("/api/bootstrap", { cookie });
  assert.equal(bootstrap.status, 200);
  assert.equal((await bootstrap.json()).user.id, session.user.id);
  assert.equal((await request("/api/auth/users", { cookie })).status, 403);
  assert.equal((await request("/api/forms", { cookie, body: { name: "Forbidden" } })).status, 403);
  assert.equal((await request("/api/auth/register", { body: input })).status, 409);
  assert.equal((await request("/api/auth/setup", { body: { ...input, username: "another.admin" } })).status, 409);
  assert.equal((await request("/api/auth/logout", { cookie, body: {} })).status, 200);
  assert.equal((await request("/api/bootstrap", { cookie })).status, 401);
  const login = await request("/api/auth/login", { body: input });
  assert.equal(login.status, 200);
  assert.equal((await login.json()).user.id, session.user.id);
});

test("public registration keeps cross-origin, password and request validation", async t => {
  const { request } = await fixture(t);
  await request("/api/auth/setup", { body: { username: "first.admin", password: "a valid admin password" } });
  assert.equal((await request("/api/auth/register", {
    origin: "https://external.example",
    body: { username: "new.member", password: "a valid member password" },
  })).status, 403);
  assert.equal((await request("/api/auth/register", { body: { username: "new.member", password: "short" } })).status, 400);
  assert.equal((await request("/api/auth/register", { body: [] })).status, 400);
  assert.equal((await request("/api/auth/register", { body: null })).status, 400);
  const status = await (await request("/api/auth/status")).json();
  assert.equal(status.user, null);
  assert.equal(status.setupRequired, false);
});
