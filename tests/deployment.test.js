import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { createApp } from "../src/server.js";
import { deploymentConfig, assertWorkspaceRequest } from "../src/deployment.js";

const origin = "https://releaf-test.onrender.com";
const env = {
  RENDER: "true", RENDER_EXTERNAL_URL: origin,
  RELEAF_ADMIN_USERNAME: "release.admin",
  RELEAF_ADMIN_PASSWORD: "A-test-only-password-2026",
};

async function fixture(t, options = {}) {
  const app = createApp({ database: ":memory:", env, ...options });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
  };
  t.after(close);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (path, { body, cookie, headers } = {}) => new Promise((resolve, reject) => {
    const req = httpRequest(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Host: new URL(origin).host, Origin: origin,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
    }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          for (const item of Array.isArray(value) ? value : [value]) {
            if (item !== undefined) responseHeaders.append(key, item);
          }
        }
        resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: responseHeaders }));
      });
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { app, request, close };
}

test("hosted mode is explicit and requires a single configured HTTPS origin", () => {
  assert.deepEqual(deploymentConfig({}), { hosted: false, host: "127.0.0.1", origin: null });
  assert.equal(deploymentConfig(env).host, "0.0.0.0");
  assert.equal(deploymentConfig(env).origin, origin);
  assert.equal(deploymentConfig({ ...env, RELEAF_PUBLIC_URL: "https://demo.example" }).origin, "https://demo.example");
  assert.throws(() => deploymentConfig({ RENDER: "true" }), /HTTPS website URL/);
  for (const url of ["http://demo.example", "https://admin:pass@demo.example", "https://demo.example/path",
    "https://demo.example/?x=1", "https://demo.example/#fragment", "https://localhost"]) {
    assert.throws(() => deploymentConfig({ RELEAF_PUBLIC_URL: url }), /HTTPS origin/);
  }
});

test("local mode still blocks remote workspace clients, external hosts and forwarded-header bypasses", () => {
  const config = deploymentConfig({});
  const request = { headers: { host: "localhost:5174" }, socket: { remoteAddress: "203.0.113.10" } };
  assert.throws(() => assertWorkspaceRequest(request, "/api/auth/status", config), { status: 403 });
  request.headers["x-forwarded-for"] = "127.0.0.1";
  request.headers["x-forwarded-host"] = "localhost:5174";
  assert.throws(() => assertWorkspaceRequest(request, "/api/auth/status", config), { status: 403 });
  request.socket.remoteAddress = "127.0.0.1";
  assert.doesNotThrow(() => assertWorkspaceRequest(request, "/api/auth/status", config));
  request.headers.host = "external.example";
  assert.throws(() => assertWorkspaceRequest(request, "/api/auth/status", config), { status: 403 });
});

test("fresh hosted workspaces fail closed without deployment administrator credentials", () => {
  assert.throws(() => createApp({
    database: ":memory:", env: { RENDER: "true", RENDER_EXTERNAL_URL: origin },
  }), /RELEAF_ADMIN_USERNAME and RELEAF_ADMIN_PASSWORD/);
  assert.throws(() => createApp({ database: ":memory:", env: { ...env, RELEAF_ADMIN_PASSWORD: "12345" } }),
    /at least 12 characters/);
});

test("hosted bootstrap is private, administrator setup is not public, and secure login works", async t => {
  const { app, request } = await fixture(t);
  assert.equal(app.store.auth.listUsers().length, 1);
  const status = await (await request("/api/auth/status")).json();
  assert.equal(status.setupRequired, false);
  assert.equal(status.user, null);
  assert.equal((await request("/api/bootstrap")).status, 401);
  assert.equal((await request("/api/auth/setup", { body: { username: "attacker", password: env.RELEAF_ADMIN_PASSWORD } })).status, 403);
  const response = await request("/api/auth/login", {
    body: { username: env.RELEAF_ADMIN_USERNAME, password: env.RELEAF_ADMIN_PASSWORD },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie"), /HttpOnly; SameSite=Strict;.*; Secure$/);
  assert.equal(response.headers.get("strict-transport-security"), "max-age=31536000");
  const cookie = response.headers.get("set-cookie").split(";")[0];
  assert.equal((await response.json()).user.role, "admin");
  assert.equal((await request("/api/bootstrap", { cookie })).status, 200);
  const logout = await request("/api/auth/logout", { cookie, body: {} });
  assert.match(logout.headers.get("set-cookie"), /Max-Age=0; Secure$/);
  assert.equal((await request("/api/bootstrap", { cookie })).status, 401);
});

test("hosted self-registration remains available without granting administrator access", async t => {
  const { request } = await fixture(t);
  const response = await request("/api/auth/register", {
    body: { username: "judge.member", password: "A-judge-test-password-2026", role: "admin" },
  });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).user.role, "user");
  const cookie = response.headers.get("set-cookie").split(";")[0];
  assert.equal((await request("/api/bootstrap", { cookie })).status, 200);
  assert.equal((await request("/api/auth/users", { cookie })).status, 403);
  const changed = await request("/api/auth/password", {
    cookie, body: { currentPassword: "A-judge-test-password-2026", password: "Another-judge-password-2026" },
  });
  assert.equal(changed.status, 200);
  assert.match(changed.headers.get("set-cookie"), /; Secure$/);
});

test("hosted mode rejects foreign origins, hosts, cross-site requests and spoofed proxy headers", async t => {
  const { request } = await fixture(t);
  for (const headers of [
    { Origin: "https://external.example" },
    { Origin: "http://releaf-test.onrender.com" },
    { Host: "external.example" },
    { Host: "localhost", "X-Forwarded-Host": new URL(origin).host },
    { Origin: "https://external.example", "X-Forwarded-Proto": "https", "X-Forwarded-Host": new URL(origin).host },
    { "Sec-Fetch-Site": "cross-site" },
  ]) assert.equal((await request("/api/auth/status", { headers })).status, 403);
});

test("health checks disclose no accounts or business data", async t => {
  const { request } = await fixture(t);
  const health = await request("/healthz", { headers: { Host: "internal-health-probe", Origin: "" } });
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });
  assert.equal(health.headers.get("set-cookie"), null);
});

test("hosted accounts and records survive restart without resetting existing credentials", async t => {
  const dir = await mkdtemp(join(tmpdir(), "releaf-hosted-"));
  let first, second;
  t.after(async () => {
    await first?.close();
    await second?.close();
    assert.ok(dir.startsWith(join(tmpdir(), "releaf-hosted-")));
    await rm(dir, { recursive: true, force: true });
  });
  const database = join(dir, "forms.sqlite");
  first = await fixture(t, { database });
  const login = first.app.store.auth.login({
    username: env.RELEAF_ADMIN_USERNAME, password: env.RELEAF_ADMIN_PASSWORD,
  }, "restart-test");
  const form = first.app.store.auth.withUser(login.user, () => first.app.store.createForm({ name: "Demo records" }));
  const fieldId = form.fields[0].id;
  first.app.store.auth.withUser(login.user, () => first.app.store.createRecord(form.id, {
    schemaVersion: form.version, values: { [fieldId]: "Persistent demo record" },
  }));
  await first.close();
  second = await fixture(t, { database, env: { RENDER: "true", RENDER_EXTERNAL_URL: origin } });
  assert.equal(second.app.store.auth.listUsers().length, 1);
  assert.equal(second.app.store.listRecords(form.id)[0].values[fieldId], "Persistent demo record");
  const response = await second.request("/api/auth/login", {
    body: { username: env.RELEAF_ADMIN_USERNAME, password: env.RELEAF_ADMIN_PASSWORD },
  });
  assert.equal(response.status, 200);
  await second.close();
});
