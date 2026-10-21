import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.js";

async function fixture(t) {
  const app = createApp({ database: ":memory:" });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    app.store.close();
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (path, method = "GET", body) => fetch(`${base}${path}`, {
    method, headers: body === undefined ? {} : { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { app, base, request };
}

test("HTTP API supports form creation, schema editing and record CRUD with history", async (t) => {
  const { request } = await fixture(t);
  const boot = await (await request("/api/bootstrap")).json();
  assert.equal(boot.form.name, "Orders");
  let response = await request("/api/forms", "POST", { name: "Suppliers" });
  assert.equal(response.status, 201);
  let form = await response.json();
  form = await (await request(`/api/forms/${form.id}`, "PUT", {
    version: form.version, name: "Partners",
    fields: [{ id: "code", name: "Partner code", type: "text", required: true, unique: true }],
  })).json();
  response = await request(`/api/forms/${form.id}/records`, "POST", { schemaVersion: form.version, values: { code: "S-1" } });
  assert.equal(response.status, 201);
  let { record } = await response.json();
  assert.equal((await (await request(`/api/records/${record.id}`)).json()).values.code, "S-1");
  response = await request(`/api/records/${record.id}`, "PATCH", { schemaVersion: form.version, version: record.version, values: { code: "S-2" } });
  assert.equal(response.status, 200);
  record = (await response.json()).record;
  assert.equal((await (await request(`/api/forms/${form.id}/records`)).json()).length, 1);
  assert.equal((await (await request(`/api/forms/${form.id}`)).json()).name, "Partners");
  assert.equal((await (await request("/api/forms")).json()).length, 2);
  response = await request(`/api/records/${record.id}`, "DELETE", { version: record.version });
  assert.equal(response.status, 200);
  assert.equal((await (await request(`/api/forms/${form.id}/changes`)).json()).length, 3);
  assert.equal((await request(`/api/records/${record.id}`)).status, 404);
});

test("HTTP validation errors expose English messages and field errors", async (t) => {
  const { request } = await fixture(t);
  const { form } = await (await request("/api/bootstrap")).json();
  const response = await request(`/api/forms/${form.id}/records`, "POST", { schemaVersion: form.version, values: {} });
  assert.equal(response.status, 400);
  const error = await response.json();
  assert.ok(error.error.includes("highlighted"));
  assert.ok(error.fields.orderNumber);
  assert.ok(error.fields.completed);
});

test("rejects malformed JSON, invalid bodies, content types and oversized requests", async (t) => {
  const { base } = await fixture(t);
  for (const body of ["{", "null", "[]", "123"]) {
    const response = await fetch(`${base}/api/forms`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    assert.equal(response.status, 400);
  }
  assert.equal((await fetch(`${base}/api/forms`, { method: "POST", body: "{}" })).status, 415);
  assert.equal((await fetch(`${base}/api/forms`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "x".repeat(270000) }),
  })).status, 413);
});

test("blocks cross-origin API requests and allows the local origin", async (t) => {
  const { base } = await fixture(t);
  assert.equal((await fetch(`${base}/api/bootstrap`, { headers: { Origin: "https://external.example" } })).status, 403);
  assert.equal((await fetch(`${base}/api/bootstrap`, { headers: { Origin: base } })).status, 200);
});

test("serves English UI, local icons and security headers without exposing source or data", async (t) => {
  const { request } = await fixture(t);
  const response = await request("/");
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<html lang="en">/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  for (const path of ["/app.js", "/styles.css", "/vendor/lucide.js"]) assert.equal((await request(path)).status, 200);
  assert.equal((await request("/styles.css", "HEAD")).status, 200);
  assert.equal((await request("/favicon.ico")).status, 204);
  for (const path of ["/server.js", "/store.js", "/data/forms.sqlite", "/api/missing"]) {
    assert.equal((await request(path)).status, 404);
  }
});
