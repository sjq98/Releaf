import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { createStore } from "../src/store.js";
import { createAgentOperations, queryRecords } from "../src/agent-operations.js";
import { createApp } from "../src/server.js";

const fields = [
  { id: "code", name: "Code", type: "text", required: true, unique: true },
  { id: "quantity", name: "Quantity", type: "number", required: false, unique: false },
  { id: "done", name: "Done", type: "checkbox", required: false, unique: false },
];
function fixture(t) {
  const store = createStore(":memory:");
  t.after(() => store.close());
  const operations = createAgentOperations(store);
  const actor = { type: "chat", id: store.agent.createSession().id, name: "Chat assistant" };
  const form = store.createForm({ name: "Materials", fields });
  return { store, operations, actor, form,
    run: (operation, args, key = "request-1") => operations.run(operation, args, actor, key) };
}
const recordArgs = (form, code = "R-1", more = {}) => ({ formId: form.id, schemaVersion: form.version, values: { code, ...more } });

test("default approval previews validate real writes without storing records, history or unique indexes", (t) => {
  const { store, operations, form, run } = fixture(t);
  const action = run("create_record", recordArgs(form));
  assert.equal(action.status, "pending");
  assert.equal(action.preview.diff[0].after, "R-1");
  assert.equal(store.listRecords(form.id).length, 0);
  assert.equal(store.listChanges(form.id).length, 0);
  const approved = operations.approve(action.id);
  assert.equal(approved.status, "applied");
  assert.equal(store.listRecords(form.id).length, 1);
  assert.equal(store.listChanges(form.id).length, 1);
  assert.deepEqual(operations.approve(action.id), approved);
  assert.equal(store.listRecords(form.id).length, 1);
});

test("proposals and full-access writes are idempotent and reject reuse with different arguments", (t) => {
  const { store, operations, form, run } = fixture(t);
  const pending = run("create_record", recordArgs(form));
  assert.equal(run("create_record", recordArgs(form)).id, pending.id);
  assert.throws(() => run("create_record", recordArgs(form, "R-2")), { status: 409 });
  operations.reject(pending.id);
  assert.equal(run("create_record", recordArgs(form)).status, "rejected");
  operations.setMode("full");
  const applied = run("create_record", recordArgs(form), "direct");
  assert.equal(applied.status, "applied");
  assert.equal(run("create_record", recordArgs(form), "direct").id, applied.id);
  assert.equal(store.listRecords(form.id).length, 1);
  assert.equal(store.listChanges(form.id).length, 1);
});

test("rejected previews never execute and invalid proposals leave business data and action log untouched", (t) => {
  const { store, operations, form, run } = fixture(t);
  const action = run("create_record", recordArgs(form));
  assert.equal(operations.reject(action.id).status, "rejected");
  assert.equal(operations.reject(action.id).status, "rejected");
  assert.throws(() => operations.approve(action.id), { status: 409 });
  assert.equal(store.listRecords(form.id).length, 0);
  assert.throws(() => run("create_record", { ...recordArgs(form), values: {} }, "invalid"), { status: 400 });
  assert.equal(store.agent.listActions().length, 1);
});

test("previewed updates and deletions reject stale record or schema versions", (t) => {
  const { store, operations, form, run } = fixture(t);
  const { record } = store.createRecord(form.id, { schemaVersion: form.version, values: { code: "R-1" } });
  const args = { recordId: record.id, version: record.version, schemaVersion: form.version };
  const update = run("update_record", { ...args, values: { quantity: 10 } });
  store.updateRecord(record.id, { ...args, values: { quantity: 20 } });
  assert.throws(() => operations.approve(update.id), { status: 409 });
  assert.equal(store.agent.getAction(update.id).status, "failed");
  assert.equal(store.getRecord(record.id).values.quantity, 20);
  const deletion = run("delete_record", { ...args, version: 2 }, "delete");
  store.updateForm(form.id, { version: form.version, name: "Renamed", fields: form.fields });
  assert.throws(() => operations.approve(deletion.id), { status: 409 });
  assert.equal(store.getRecord(record.id).version, 2);
});

test("table-edit previews include lost values, roll back schema changes and detect new or edited records", (t) => {
  const { store, operations, form, run } = fixture(t);
  store.createRecord(form.id, { schemaVersion: form.version, values: { code: "R-1", quantity: 4 } });
  const action = run("update_form", { formId: form.id, version: form.version, name: "Materials", fields: [form.fields[0]] });
  assert.equal(store.getForm(form.id).fields.length, 3);
  assert.equal(store.listRecords(form.id)[0].values.quantity, 4);
  assert.equal(action.preview.changedRecordCount, 1);
  assert.equal(action.preview.recordChanges[0].before.quantity, 4);
  store.createRecord(form.id, { schemaVersion: form.version, values: { code: "R-2" } });
  assert.throws(() => operations.approve(action.id), { status: 409 });
  assert.equal(store.getForm(form.id).version, 1);
});

test("creating and editing forms uses the same constraints and keeps stable field IDs", (t) => {
  const { store, operations, run } = fixture(t);
  const proposed = run("create_form", { name: "Suppliers", moduleId: "custom", fields });
  assert.equal(store.listForms("default").length, 2);
  const form = operations.approve(proposed.id).result;
  assert.equal(form.moduleId, "custom");
  const edit = run("update_form", { formId: form.id, version: form.version, name: "Partners",
    fields: form.fields.map((item) => ({ ...item, name: item.id === "code" ? "Partner code" : item.name })) }, "edit");
  const saved = operations.approve(edit.id).result;
  assert.equal(saved.name, "Partners");
  assert.equal(saved.fields[0].id, "code");
  assert.equal(saved.version, 2);
});

test("full access still enforces unique values, field rules, references and deletion protection", (t) => {
  const { store, operations, form, run } = fixture(t);
  operations.setMode("full");
  const action = run("create_record", recordArgs(form));
  assert.throws(() => run("create_record", recordArgs(form, "r-1"), "duplicate"), { status: 409 });
  assert.throws(() => run("create_record", recordArgs(form, "R-2", { quantity: "invalid" }), "bad-type"), { status: 400 });
  const refs = store.createForm({ name: "Jobs", fields: [{ id: "material", name: "Material", type: "reference", required: true, unique: false,
    reference: { formId: form.id, fieldId: "code" } }] });
  assert.throws(() => run("create_record", { formId: refs.id, schemaVersion: 1, values: { material: "made-up-id" } }, "bad-ref"), { status: 400 });
  run("create_record", { formId: refs.id, schemaVersion: 1, values: { material: action.result.record.id } }, "valid-ref");
  assert.throws(() => run("delete_record", { recordId: action.result.record.id, version: 1, schemaVersion: 1 }, "protected"), { status: 409 });
  assert.equal(store.listRecords(form.id).length, 1);
});

test("queries combine typed filters, search, sort and bounded pagination on any table", (t) => {
  const { store, form } = fixture(t);
  for (const [code, quantity, done] of [["ALPHA", 1, false], ["Beta", 3, true], ["Gamma", 5, false]]) {
    store.createRecord(form.id, { schemaVersion: 1, values: { code, quantity, done } });
  }
  assert.equal(queryRecords(store, { formId: form.id, filters: [{ fieldId: "code", operator: "eq", value: "alpha" }] }).records[0].values.code, "ALPHA");
  const query = queryRecords(store, { formId: form.id, q: "a", filters: [{ fieldId: "quantity", operator: "gte", value: 2 }],
    sort: { fieldId: "quantity", direction: "desc" }, limit: 1 });
  assert.equal(query.total, 2);
  assert.equal(query.records[0].values.code, "Gamma");
  assert.equal(query.hasMore, true);
  assert.equal(queryRecords(store, { formId: form.id, filters: [{ fieldId: "done", operator: "eq", value: false }] }).total, 2);
  assert.equal(queryRecords(store, { formId: form.id, filters: [{ fieldId: "code", operator: "contains", value: "ET" }] }).total, 1);
  for (const query of [
    { limit: 101 }, { offset: -1 }, { filters: [{ fieldId: "missing", operator: "eq", value: 0 }] },
    { filters: [{ fieldId: "quantity", operator: "contains", value: "3" }] },
    { filters: [{ fieldId: "quantity", operator: "eq", value: "3" }] },
    { filters: [{ fieldId: "done", operator: "gt", value: true }] },
    { sort: { fieldId: "missing", direction: "asc" } },
  ]) assert.throws(() => queryRecords(store, { formId: form.id, ...query }), { status: 400 });
});

test("separate tokens keep independent permissions, never expose saved secrets and revoke pending actions", (t) => {
  const { store, operations, form } = fixture(t);
  const review = operations.createToken({ name: "Review agent" });
  const full = operations.createToken({ name: "Full agent", mode: "full" });
  assert.equal(review.token.length, 47);
  assert.ok(!JSON.stringify(store.agent.listTokens()).includes(review.token));
  const authenticated = operations.authenticate(`Bearer ${review.token}`);
  assert.equal(authenticated.id, review.id);
  const pending = operations.run("create_record", recordArgs(form), { ...authenticated, type: "token" }, "external-1");
  operations.setMode("full");
  assert.equal(pending.status, "pending");
  const applied = operations.run("create_record", recordArgs(form, "R-2"), { ...full, type: "token" }, "external-2");
  assert.equal(applied.status, "applied");
  store.agent.revokeToken(review.id);
  assert.equal(store.agent.getAction(pending.id).status, "rejected");
  assert.throws(() => operations.authenticate(`Bearer ${review.token}`), { status: 401 });
  for (const header of [undefined, "Bearer nope", `Basic ${full.token}`]) assert.throws(() => operations.authenticate(header), { status: 401 });
});

test("invalid operations, extra arguments, version types and missing idempotency keys are rejected", (t) => {
  const { operations, actor, form } = fixture(t);
  for (const [operation, args, key] of [
    ["approve_action", {}, "1"], ["create_record", { ...recordArgs(form), mode: "full" }, "2"],
    ["create_record", { ...recordArgs(form), schemaVersion: "1" }, "3"],
    ["create_record", recordArgs(form), undefined], ["update_form", {}, "4"],
  ]) assert.throws(() => operations.run(operation, args, actor, key), { status: 400 });
});

test("older pending approvals remain visible after more than 100 later resolved actions", (t) => {
  const { store, run, operations, form } = fixture(t);
  const pending = run("create_record", recordArgs(form, "WAITING"));
  operations.setMode("full");
  for (let i = 0; i < 105; i++) run("create_record", recordArgs(form, `R-${i}`), `later-${i}`);
  assert.ok(store.agent.actionFeed().some((action) => action.id === pending.id && action.status === "pending"));
});

test("agent settings, token hashes, proposals and conversations persist across reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "releaf-agent-"));
  const filename = join(directory, "test.sqlite");
  let store;
  try {
    store = createStore(filename);
    const operations = createAgentOperations(store);
    const token = operations.createToken({ name: "Persisted" });
    const session = store.agent.createSession();
    store.agent.saveSession(session.id, [{ role: "user", content: "Hello" }]);
    operations.setMode("full");
    store.close();
    store = createStore(filename);
    const reopened = createAgentOperations(store);
    assert.equal(reopened.authenticate(`Bearer ${token.token}`).id, token.id);
    assert.equal(reopened.getMode(), "full");
    assert.equal(store.agent.getSession(session.id).messages[0].content, "Hello");
  } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
});

async function httpFixture(t, assistantFetch = async () => Response.json({ data: [{ id: "test-model" }] })) {
  const app = createApp({ database: ":memory:", env: {}, assistantFetch });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise((resolve) => app.server.close(resolve)); app.store.close(); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const { sessionToken } = app.store.auth.setup({ username: "agent-test-admin", password: "test-admin-password" });
  const request = (path, method = "GET", body, headers = {}) => fetch(base + path, {
    method, headers: { Cookie: `releaf_session=${sessionToken}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { app, request, base };
}
const provider = { providerName: "Test provider", baseUrl: "https://provider.example/v1", apiKey: "private-test-key", model: "test-model" };
const tool = (name, args, id = "call-1") => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const answer = (content = null, calls) => Response.json({ choices: [{ finish_reason: calls ? "tool_calls" : "stop", message: { role: "assistant", content, ...(calls ? { tool_calls: calls } : {}) } }] });

test("HTTP Agent API requires tokens, supports CRUD previews and cannot approve itself or access local settings", async (t) => {
  const { request, app, base } = await httpFixture(t);
  assert.equal((await request("/api/agent/forms")).status, 401);
  const token = await (await request("/api/assistant/tokens", "POST", { name: "External agent" })).json();
  const headers = { Authorization: `Bearer ${token.token}` };
  const form = app.store.listForms()[0];
  const body = { schemaVersion: form.version, values: { name: "A-1" } };
  assert.equal((await request(`/api/agent/forms/${form.id}/records`, "POST", body, headers)).status, 400);
  const response = await request(`/api/agent/forms/${form.id}/records`, "POST", body, { ...headers, "Idempotency-Key": "create-1" });
  assert.equal(response.status, 202);
  const action = await response.json();
  assert.equal(app.store.listRecords(form.id).length, 0);
  for (const path of ["/api/assistant/state", "/api/ai/config", "/api/forms", `/api/assistant/actions/${action.id}/approve`]) {
    assert.equal((await request(path, path.endsWith("/approve") ? "POST" : "GET", path.endsWith("/approve") ? {} : undefined, headers)).status, 403);
  }
  assert.equal((await request(`/api/agent/actions/${action.id}/approve`, "POST", {}, headers)).status, 404);
  assert.equal((await request(`/api/assistant/actions/${action.id}/approve`, "POST", {})).status, 200);
  const applied = await (await request(`/api/agent/actions/${action.id}`, "GET", undefined, headers)).json();
  const record = applied.result.record;
  assert.equal(applied.status, "applied");
  assert.equal((await request(`/api/agent/records/${record.id}`, "GET", undefined, headers)).status, 200);
  const query = await (await request(`/api/agent/forms/${form.id}/query`, "POST", { filters: [{ fieldId: "name", operator: "eq", value: "A-1" }] }, headers)).json();
  assert.equal(query.total, 1);
  assert.equal((await request(`/api/agent/forms/${form.id}/records?filters=not-json`, "GET", undefined, headers)).status, 400);
  const reboundStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(base + "/api/assistant/state", { headers: { Host: "attacker.example" } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on("error", reject);
    request.end();
  });
  assert.equal(reboundStatus, 403);
  assert.equal((await fetch(base + "/api/assistant/state", { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
  assert.equal((await request(`/api/assistant/tokens/${token.id}`, "DELETE")).status, 200);
  assert.equal((await request("/api/agent/forms", "GET", undefined, headers)).status, 401);
});

test("HTTP full access requires explicit confirmation and token permissions do not follow chat mode", async (t) => {
  const { request } = await httpFixture(t);
  assert.equal((await request("/api/assistant/mode", "PUT", { mode: "full" })).status, 400);
  assert.equal((await request("/api/assistant/tokens", "POST", { name: "Bad", mode: "full" })).status, 400);
  assert.equal((await request("/api/assistant/mode", "PUT", { mode: "full", confirmFullAccess: true })).status, 200);
  const token = await (await request("/api/assistant/tokens", "POST", { name: "Independent" })).json();
  assert.equal(token.mode, "review");
  assert.equal((await request(`/api/assistant/tokens/${token.id}`, "PATCH", { mode: "full" })).status, 400);
  assert.equal((await request(`/api/assistant/tokens/${token.id}`, "PATCH", { mode: "full", confirmFullAccess: true })).status, 200);
});

test("Agent tokens can only read their own actions and can discover schemas without receiving secrets", async (t) => {
  const { request, app } = await httpFixture(t);
  const first = await (await request("/api/assistant/tokens", "POST", { name: "First" })).json();
  const second = await (await request("/api/assistant/tokens", "POST", { name: "Second" })).json();
  const headers = { Authorization: `Bearer ${first.token}`, "Idempotency-Key": "create" };
  const form = app.store.listForms()[0];
  const action = await (await request(`/api/agent/forms/${form.id}/records`, "POST",
    { schemaVersion: 1, values: { name: "OWN" } }, headers)).json();
  assert.equal((await request(`/api/agent/actions/${action.id}`, "GET", undefined, { Authorization: `Bearer ${second.token}` })).status, 404);
  const spec = await (await request("/api/agent/openapi.json", "GET", undefined, headers)).json();
  assert.equal(spec.openapi, "3.1.0");
  assert.ok(spec.paths["/api/agent/forms/{formId}/records"].post.requestBody);
  assert.ok(!spec.paths["/api/agent/forms/{formId}"].get.requestBody);
  assert.ok(!spec.paths["/api/assistant/mode"]);
  assert.ok(!JSON.stringify(spec).includes(first.token));
  const tools = (await (await request("/api/agent/tools", "GET", undefined, headers)).json()).tools;
  assert.ok(!tools.some((tool) => tool.function.name === "create_automation"));
  assert.ok(tools.some((tool) => tool.function.name === "create_notification_rule"));
  assert.ok(tools.some((tool) => tool.function.name === "start_ai_task"));
});

test("full mode changes only future requests; enabling it does not auto-apply an old proposal", (t) => {
  const { store, form, run, operations } = fixture(t);
  const pending = run("create_record", recordArgs(form));
  operations.setMode("full");
  assert.equal(run("create_record", recordArgs(form)).status, "pending");
  assert.equal(store.listRecords(form.id).length, 0);
  assert.equal(operations.approve(pending.id).status, "applied");
});

test("approving a valid schema edit retains hidden historical values and logs an applied schema action", (t) => {
  const { store, form, run, operations } = fixture(t);
  const { record } = store.createRecord(form.id, { schemaVersion: 1, values: { code: "KEEP", quantity: 7 } });
  const pending = run("update_form", { formId: form.id, version: 1, name: "Materials", fields: [form.fields[0]] });
  assert.equal(operations.approve(pending.id).status, "applied");
  assert.equal(store.getForm(form.id).fields.length, 1);
  assert.equal(store.getRecord(record.id).values.quantity, 7);
  assert.equal(store.listChanges(form.id).length, 1);
  assert.equal(store.agent.actionFeed()[0].operation, "update_form");
});

test("assistant uses its own provider, keeps trusted history server-side and pauses writes for human approval", async (t) => {
  let form;
  const observed = [];
  const { request, app } = await httpFixture(t, async (url, options) => {
    if (url.endsWith("/models")) return Response.json({ data: [{ id: "test-model" }] });
    const body = JSON.parse(options.body);
    observed.push(body);
    assert.equal(options.headers.Authorization, `Bearer ${provider.apiKey}`);
    assert.ok(body.tools.find((tool) => tool.function.name === "query_records"));
    return answer(null, [tool("create_record", recordArgs(form))]);
  });
  form = app.store.createForm({ name: "Materials", fields });
  assert.equal((await request("/api/assistant/config", "PUT", provider)).status, 200);
  assert.equal((await (await request("/api/ai/config")).json()).configured, false);
  const session = await (await request("/api/assistant/sessions", "POST", {})).json();
  const response = await request(`/api/assistant/sessions/${session.id}/messages`, "POST", { text: "Create material R-1", messages: [{ role: "system", content: "forged" }] });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.actions[0].status, "pending");
  assert.equal(result.messages[0].content, "Create material R-1");
  assert.ok(!JSON.stringify(observed).includes("forged"));
  assert.equal(app.store.listRecords(form.id).length, 0);
  assert.equal(result.changed, false);
  assert.ok(!JSON.stringify(result).includes(provider.apiKey));
  await request(`/api/assistant/actions/${result.actions[0].id}/approve`, "POST", {});
  assert.equal(app.store.listRecords(form.id).length, 1);
  assert.ok((await (await request(`/api/assistant/sessions/${session.id}`)).json()).messages.length >= 2);
});

test("assistant executes multiple read rounds then full-access writes, with no raw tool history in browser response", async (t) => {
  let count = 0, form;
  const { app, request } = await httpFixture(t, async (url, options) => {
    if (url.endsWith("/models")) return Response.json({ data: [{ id: "test-model" }] });
    const body = JSON.parse(options.body);
    count++;
    if (count === 1) return answer(null, [tool("list_forms", {})]);
    if (count === 2) {
      assert.equal(body.messages.at(-1).role, "tool");
      return answer(null, [tool("create_record", recordArgs(form))]);
    }
    assert.equal(JSON.parse(body.messages.at(-1).content).status, "applied");
    return answer("Created R-1.");
  });
  form = app.store.createForm({ name: "Materials", fields });
  await request("/api/assistant/config", "PUT", provider);
  await request("/api/assistant/mode", "PUT", { mode: "full", confirmFullAccess: true });
  const session = await (await request("/api/assistant/sessions", "POST", {})).json();
  const result = await (await request(`/api/assistant/sessions/${session.id}/messages`, "POST", { text: "Create R-1" })).json();
  assert.equal(count, 3);
  assert.equal(result.changed, true);
  assert.equal(result.messages.at(-1).content, "Created R-1.");
  assert.ok(result.messages.every((message) => !message.tool_calls && message.role !== "tool"));
  assert.equal(app.store.listRecords(form.id).length, 1);
});

test("assistant rejects missing configuration, empty messages, provider errors and unsupported response formats", async (t) => {
  let upstream = Response.json({ error: provider.apiKey }, { status: 401 });
  const { request } = await httpFixture(t, async (url) => url.endsWith("/models")
    ? Response.json({ data: [{ id: "test-model" }] }) : upstream);
  const session = await (await request("/api/assistant/sessions", "POST", {})).json();
  const path = `/api/assistant/sessions/${session.id}/messages`;
  assert.equal((await request(path, "POST", { text: "Hello" })).status, 503);
  await request("/api/assistant/config", "PUT", provider);
  assert.equal((await request(path, "POST", { text: "" })).status, 400);
  const response = await request(path, "POST", { text: "Hello" });
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes(provider.apiKey));
  upstream = Response.json({ wrong: "format" });
  assert.equal((await request(path, "POST", { text: "Try again" })).status, 502);
  upstream = answer(null, [tool("list_forms", {}, "same"), tool("list_forms", {}, "same")]);
  assert.equal((await request(path, "POST", { text: "Try again" })).status, 502);
});

test("truncated tool responses do not execute partial writes", async (t) => {
  let form;
  const { app, request } = await httpFixture(t, async (url) => url.endsWith("/models") ? Response.json({ data: [{ id: "test-model" }] })
    : Response.json({ choices: [{ finish_reason: "length", message: { role: "assistant", tool_calls: [tool("create_record", recordArgs(form))] } }] }));
  form = app.store.createForm({ name: "Materials", fields });
  await request("/api/assistant/config", "PUT", provider);
  await request("/api/assistant/mode", "PUT", { mode: "full", confirmFullAccess: true });
  const session = await (await request("/api/assistant/sessions", "POST", {})).json();
  assert.equal((await request(`/api/assistant/sessions/${session.id}/messages`, "POST", { text: "Create R-1" })).status, 502);
  assert.equal(app.store.listRecords(form.id).length, 0);
  assert.equal(app.store.agent.listActions().length, 0);
});

test("agent can query and mutate newly created custom tables via HTTP, including updates and deletions", async (t) => {
  const { request, app } = await httpFixture(t);
  const token = await (await request("/api/assistant/tokens", "POST", { name: "Full", mode: "full", confirmFullAccess: true })).json();
  let key = 0;
  const call = (path, method = "GET", body) => request(path, method, body, { Authorization: `Bearer ${token.token}`, "Idempotency-Key": String(++key) });
  const created = await (await call("/api/agent/forms", "POST", { name: "Custom", fields })).json();
  const form = created.result;
  assert.equal(created.status, "applied");
  const edit = await (await call(`/api/agent/forms/${form.id}`, "PUT", { version: 1, name: "Custom edited", fields })).json();
  assert.equal(edit.result.version, 2);
  const inserted = await (await call(`/api/agent/forms/${form.id}/records`, "POST", { schemaVersion: 2, values: { code: "C-1" } })).json();
  const record = inserted.result.record;
  const updated = await (await call(`/api/agent/records/${record.id}`, "PATCH", { schemaVersion: 2, version: 1, values: { quantity: 8 } })).json();
  assert.equal(updated.result.record.values.quantity, 8);
  assert.equal((await (await call(`/api/agent/forms/${form.id}/records?limit=1&offset=0`)).json()).total, 1);
  const deletion = await (await call(`/api/agent/records/${record.id}`, "DELETE", { schemaVersion: 2, version: 2 })).json();
  assert.equal(deletion.status, "applied");
  assert.equal(app.store.listRecords(form.id).length, 0);
  assert.equal(app.store.listChanges(form.id).length, 3);
});
