import test from "node:test";
import { setupAdmin } from "./helpers/http-auth.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.js";
import { createAIConfig } from "../src/ai-config.js";
import { createApp } from "../src/server.js";

const settings = {
  providerName: "Example provider", baseUrl: "https://provider.example/v1/",
  apiKey: "test-secret-never-return", model: "model-b",
};
const response = (data = { data: [{ id: "model-b" }, { id: "model-a" }, { id: "model-b" }] }) => ({ ok: true, json: async () => data });
const fixture = (t, options = {}) => {
  const store = createStore(":memory:");
  t.after(() => store.close());
  const config = createAIConfig({ store, env: {}, fetchImpl: async () => response(), ...options });
  return { store, config };
};

test("AI settings load from environment but never expose the API key", (t) => {
  const { config } = fixture(t, { env: { AI_API_KEY: settings.apiKey, AI_MODEL: "model-a", AI_BASE_URL: settings.baseUrl, AI_PROVIDER_NAME: "Environment" } });
  assert.deepEqual(config.publicConfig(), {
    providerName: "Environment", baseUrl: "https://provider.example/v1", model: "model-a",
    hasApiKey: true, configured: true, source: "environment",
  });
  assert.ok(!JSON.stringify(config.status).includes(settings.apiKey));
  assert.equal(config.status.providerName, "Environment");
});

test("model discovery normalizes URLs, sends the key server-side and returns real sorted model IDs", async (t) => {
  let observed;
  const { config } = fixture(t, { fetchImpl: async (url, options) => { observed = { url, options }; return response(); } });
  const result = await config.models({ ...settings, baseUrl: "https://provider.example/v1/chat/completions" });
  assert.deepEqual(result, { models: ["model-a", "model-b"] });
  assert.equal(observed.url, "https://provider.example/v1/models");
  assert.equal(observed.options.headers.Authorization, `Bearer ${settings.apiKey}`);
  assert.equal(observed.options.redirect, "error");
  assert.equal(config.publicConfig().configured, false);
});

test("saved settings take effect immediately, retain the key only for the same URL, and validate selected models", async (t) => {
  const { store, config } = fixture(t);
  const saved = await config.save(settings);
  assert.equal(saved.configured, true);
  assert.equal(saved.source, "saved");
  assert.ok(!JSON.stringify(saved).includes(settings.apiKey));
  assert.equal(store.getAIConfig().apiKey, settings.apiKey);
  await config.save({ ...settings, apiKey: "", providerName: "Renamed" });
  assert.equal(config.status.providerName, "Renamed");
  await assert.rejects(config.save({ ...settings, model: "invented-model" }), { status: 400 });
  assert.equal(config.status.providerName, "Renamed");
  await assert.rejects(config.models({ ...settings, baseUrl: "https://another.example/v1", apiKey: "" }), { status: 400 });
  assert.equal(store.getAIConfig().baseUrl, "https://provider.example/v1");
});

test("AI provider settings persist across database reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ai-config-"));
  let store;
  try {
    const path = join(directory, "test.sqlite");
    store = createStore(path);
    await createAIConfig({ store, env: {}, fetchImpl: async () => response() }).save(settings);
    store.close();
    store = createStore(path);
    const config = createAIConfig({ store, env: {} });
    assert.equal(config.publicConfig().configured, true);
    assert.equal(config.publicConfig().model, settings.model);
    assert.equal(config.publicConfig().providerName, settings.providerName);
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("AI settings reject unsafe URLs, malformed credentials and missing values without contacting upstream", async (t) => {
  let calls = 0;
  const { config } = fixture(t, { fetchImpl: async () => { calls++; return response(); } });
  for (const baseUrl of ["file:///C:/secret", "ftp://example.com", "http://remote.example/v1", "https://user:password@example.com", "https://example.com/v1?key=secret", "https://example.com/v1#secret", "invalid"]) {
    await assert.rejects(config.models({ ...settings, baseUrl }), { status: 400 });
  }
  for (const body of [{ ...settings, providerName: "" }, { ...settings, apiKey: "" }, { ...settings, apiKey: "key\ninjection" }, { ...settings, apiKey: null }]) {
    await assert.rejects(config.models(body), { status: 400 });
  }
  assert.equal(calls, 0);
  assert.deepEqual(await config.models({ ...settings, baseUrl: "http://127.0.0.1:11434/v1" }), { models: ["model-a", "model-b"] });
});

test("upstream model errors are actionable and do not disclose credentials or replace settings", async (t) => {
  for (const upstream of [
    { ok: false, status: 401 }, { ok: false, status: 404 }, { ok: false, status: 429 },
    response({ data: [] }), response({ data: [{ name: "wrong" }] }), response({ models: ["wrong-format"] }),
  ]) {
    const { config } = fixture(t, { fetchImpl: async () => upstream });
    await assert.rejects(config.save(settings), (error) => {
      assert.equal(error.status, 502);
      assert.ok(!error.message.includes(settings.apiKey));
      return true;
    });
    assert.equal(config.status.configured, false);
  }
  const { config } = fixture(t, { fetchImpl: async () => { throw new DOMException("upstream secret", "TimeoutError"); } });
  await assert.rejects(config.models(settings), /timed out/);
});

test("HTTP AI settings stay private, reject cross-origin writes, and drive configurable AI tasks immediately", async (t) => {
  const observed = [];
  const app = createApp({ database: ":memory:", env: {}, aiFetch: async (url, options) => {
    observed.push({ url, options });
    if (url.endsWith("/models")) return response();
    const body = JSON.parse(options.body);
    const schema = body.response_format.json_schema.schema.properties.items.items.properties;
    assert.ok(schema.result);
    return response({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ items: [{
      result: "Send report",
    }] }) } }] });
  } });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise((resolve) => app.server.close(resolve)); app.store.close(); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const { cookie } = await setupAdmin(base);
  const request = (path, method = "GET", body) => fetch(base + path, {
    method, headers: { Cookie: cookie, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal((await (await request("/api/ai/config")).json()).configured, false);
  assert.deepEqual(await (await request("/api/ai/models", "POST", settings)).json(), { models: ["model-a", "model-b"] });
  assert.equal((await request("/api/ai/config", "PUT", settings)).status, 200);
  const boot = await (await request("/api/bootstrap")).json();
  assert.equal(boot.ai.model, settings.model);
  assert.equal(boot.ai.providerName, settings.providerName);
  assert.ok(!JSON.stringify(boot).includes(settings.apiKey));
  assert.ok(!(await (await request("/api/ai/config")).text()).includes(settings.apiKey));
  assert.equal((await fetch(base + "/api/ai/config", { method: "PUT", headers: { "Content-Type": "application/json", Origin: "https://external.example" }, body: JSON.stringify(settings) })).status, 403);
  const form = app.store.listForms()[0];
  const target = app.store.createForm({ name: "Processed", fields: [{ id: "result", name: "Result", type: "text", required: false, unique: false }] });
  const record = app.store.createRecord(form.id, { schemaVersion: 1, values: { name: "Alex will send the report." } }).record;
  const task = app.store.tasks.save({ name: "Extract", formId: form.id, inputFields: ["name"], outputFormId: target.id,
    outputFields: ["result"], instructions: "Extract action", mode: "review", action: "create" });
  const run = app.store.tasks.enqueue(task.id, { recordId: record.id });
  const extraction = await app.store.tasks.process(run.id);
  assert.equal(extraction.status, "Needs review");
  assert.equal(app.store.listRecords(target.id).length, 0);
  const call = observed.find((call) => call.url.endsWith("/chat/completions"));
  assert.equal(call.url, "https://provider.example/v1/chat/completions");
  assert.equal(call.options.headers.Authorization, `Bearer ${settings.apiKey}`);
  assert.equal(JSON.parse(call.options.body).model, settings.model);
  assert.equal((await request("/ai-settings.js")).status, 200);
  assert.equal((await request("/ai-config.js")).status, 404);
});
