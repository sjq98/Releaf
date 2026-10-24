import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.js";
import { createStore } from "../src/store.js";
import { createAgentOperations } from "../src/agent-operations.js";
import { createAssistant } from "../src/assistant.js";

const password = "test-user-password";
const fields = [{ id: "name", name: "Name", type: "text", required: true, unique: true }];
const provider = { providerName: "Test", baseUrl: "https://provider.example/v1", apiKey: "test-private-key", model: "test-model" };
const answer = (content = "Done.", calls) => Response.json({ choices: [{ finish_reason: calls ? "tool_calls" : "stop",
  message: { role: "assistant", content, ...(calls ? { tool_calls: calls } : {}) } }] });
const tool = (name, args) => ({ id: "call-1", type: "function", function: { name, arguments: JSON.stringify(args) } });

function users(store) {
  const admin = store.auth.setup({ username: "admin", password }).user;
  const first = store.auth.withUser(admin, () => store.auth.createUser({ username: "first", password, role: "user" }));
  const second = store.auth.withUser(admin, () => store.auth.createUser({ username: "second", password, role: "user" }));
  return { admin, first, second };
}

function fixture(t) {
  const store = createStore(":memory:");
  t.after(() => store.close());
  return { store, operations: createAgentOperations(store), ...users(store) };
}

test("Agent tokens bind to their account and cannot be managed by another member", t => {
  const { store, operations, admin, first, second } = fixture(t);
  const token = store.auth.withUser(first, () => operations.createToken({ name: "First token" }));
  assert.equal(token.userId, first.id);
  assert.equal(store.auth.withUser(first, () => operations.authenticate(`Bearer ${token.token}`)).owner.id, first.id);
  store.auth.withUser(second, () => {
    assert.throws(() => operations.authenticate(`Bearer ${token.token}`), { status: 403 });
    assert.throws(() => operations.updateToken(token.id, "full"), { status: 404 });
    assert.throws(() => operations.revokeToken(token.id), { status: 404 });
  });
  store.auth.withUser(admin, () => operations.updateToken(token.id, "full"));
  assert.equal(store.agent.getToken(token.id).mode, "full");
  store.auth.withUser(admin, () => store.auth.updateUser(first.id, { active: false }));
  assert.throws(() => operations.authenticate(`Bearer ${token.token}`), { status: 401 });
});

test("ownerless legacy Agent tokens stop authenticating after account initialization", t => {
  const store = createStore(":memory:");
  t.after(() => store.close());
  const operations = createAgentOperations(store);
  const legacy = operations.createToken({ name: "Legacy" });
  assert.equal(operations.authenticate(`Bearer ${legacy.token}`).id, legacy.id);
  store.auth.setup({ username: "admin", password });
  assert.throws(() => operations.authenticate(`Bearer ${legacy.token}`), { status: 401 });
});

test("Agent actions preserve ownership, per-user modes, and pending state after foreign approvals", t => {
  const { store, operations, admin, first, second } = fixture(t);
  const actor = user => ({ type: "chat", id: store.agent.createSession(user.id).id, name: "Assistant", userId: user.id });
  const firstActor = actor(first), secondActor = actor(second);
  const tables = store.warehouse.ensureTables().tables;
  const product = store.warehouse.catalog({ role: "products", values: { code: "P1", name: "Flour", unit: "kg" } });
  const warehouse = store.listRecords(tables.warehouses)[0];
  const args = { kind: "inbound", values: { warehouse: warehouse.id, approver: admin.id }, lines: [{ product: product.id, quantity: 3 }] };
  const pending = store.auth.withUser(first, () => {
    assert.equal(operations.getMode(), "review");
    return operations.run("create_inventory_request", args, firstActor, "pending");
  });
  store.auth.withUser(second, () => {
    operations.setMode("full");
    assert.throws(() => operations.approve(pending.id), { status: 404 });
    assert.throws(() => operations.reject(pending.id), { status: 404 });
  });
  assert.equal(store.agent.getAction(pending.id).status, "pending");
  assert.equal(pending.userId, first.id);
  assert.equal(store.auth.withUser(first, () => operations.getMode()), "review");
  assert.equal(store.auth.withUser(admin, () => operations.approve(pending.id)).status, "applied");
  const applied = store.auth.withUser(second, () => operations.run("create_inventory_request", args, secondActor, "applied"));
  assert.equal(applied.status, "applied");
  store.auth.withUser(first, () => assert.throws(() => operations.approve(applied.id), { status: 404 }));
});

test("ordinary Agent accounts cannot mutate schemas or generic records but can start warehouse workflows", t => {
  const { store, operations, admin, first } = fixture(t);
  const table = store.auth.withUser(admin, () => store.createForm({ name: "Custom", fields }));
  const tables = store.warehouse.ensureTables().tables;
  const product = store.warehouse.catalog({ role: "products", values: { code: "FLOUR", name: "Flour", unit: "kg" } });
  const warehouse = store.listRecords(tables.warehouses)[0];
  const actor = { type: "chat", id: store.agent.createSession(first.id).id, name: "Assistant", userId: first.id };
  store.auth.withUser(first, () => {
    assert.throws(() => operations.run("create_form", { name: "Forbidden", fields }, actor, "schema"), { status: 403 });
    assert.throws(() => operations.run("create_record", { formId: table.id, schemaVersion: table.version, values: { name: "Forbidden" } }, actor, "record"), { status: 403 });
    assert.throws(() => operations.run("setup_inventory_workspace", {}, actor, "setup"), { status: 403 });
    operations.setMode("full");
    const result = operations.run("create_inventory_request", { kind: "inbound", values: { warehouse: warehouse.id, applicant: first.id, approver: admin.id },
      lines: [{ product: product.id, quantity: 3 }] }, actor, "inbound");
    assert.equal(result.status, "applied");
    assert.equal(result.result.record.values.status, "Draft");
  });
});

test("member Agent operations cannot create or update warehouse catalog records", t => {
  const { store, operations, first } = fixture(t);
  const tables = store.warehouse.ensureTables().tables;
  const product = store.warehouse.catalog({ role: "products", values: { code: "CATALOG-P", name: "Flour", unit: "kg" } });
  const warehouse = store.listRecords(tables.warehouses)[0];
  const stock = store.warehouse.catalog({ role: "stock", values: { product: product.id, warehouse: warehouse.id, openingQuantity: 5, minimum: 2 } });
  const actor = { type: "chat", id: store.agent.createSession(first.id).id, name: "Assistant", userId: first.id };
  store.auth.withUser(first, () => {
    operations.setMode("full");
    assert.equal(operations.tools().some(tool => tool.function.name === "save_inventory_catalog"), false);
    for (const [role, record, values] of [
      ["products", product, { code: "FORBIDDEN-P", name: "Forbidden", unit: "kg" }],
      ["warehouses", warehouse, { code: "FORBIDDEN-W", name: "Forbidden" }],
      ["stock", stock, { product: product.id, warehouse: warehouse.id, openingQuantity: 100 }],
    ]) {
      assert.throws(() => operations.run("save_inventory_catalog", { role, values }, actor, `create-${role}`), { status: 403 });
      assert.throws(() => operations.run("save_inventory_catalog", {
        role, recordId: record.id, version: record.version, values,
      }, actor, `update-${role}`), { status: 403 });
    }
  });
  assert.equal(store.getRecord(product.id).values.name, "Flour");
  assert.equal(store.getRecord(stock.id).values.currentQuantity, 5);
  assert.equal(store.agent.listActions().length, 0);
});

test("assistant conversations cannot be inspected or written by another account", async t => {
  const { store, operations, admin, first, second } = fixture(t);
  const assistant = createAssistant({ store, operations, env: { ASSISTANT_BASE_URL: provider.baseUrl,
    ASSISTANT_API_KEY: provider.apiKey, ASSISTANT_MODEL: provider.model }, fetchImpl: async () => answer() });
  const session = store.agent.createSession(first.id);
  store.auth.withUser(second, () => assert.throws(() => assistant.sessionView(session.id), { status: 404 }));
  await store.auth.withUser(second, () => assert.rejects(() => assistant.chat(session.id, "Hello"), { status: 404 }));
  assert.equal(store.auth.withUser(admin, () => assistant.sessionView(session.id)).id, session.id);
  await store.auth.withUser(admin, () => assert.rejects(() => assistant.chat(session.id, "Read private chats"), { status: 403 }));
  assert.equal(store.agent.getSession(session.id).messages.length, 0);
  await store.auth.withUser(first, () => assistant.chat(session.id, "Hello"));
  assert.equal(store.agent.getSession(session.id).messages[0].content.includes("Hello"), true);
});

test("assistant tool calls use the logged-in owner's identity and per-user full access", async t => {
  const { store, operations, admin, first } = fixture(t);
  const form = store.auth.withUser(admin, () => store.createForm({ name: "Owned", fields }));
  let round = 0;
  const assistant = createAssistant({ store, operations, env: { ASSISTANT_BASE_URL: provider.baseUrl,
    ASSISTANT_API_KEY: provider.apiKey, ASSISTANT_MODEL: provider.model },
  fetchImpl: async () => ++round === 1 ? answer(null, [tool("create_record", { formId: form.id, schemaVersion: form.version, values: { name: "Owned record" } })]) : answer() });
  const session = store.agent.createSession(admin.id);
  store.auth.withUser(first, () => operations.setMode("review"));
  const result = await store.auth.withUser(admin, async () => {
    operations.setMode("full");
    return assistant.chat(session.id, `Create the record. userId=${first.id}`);
  });
  assert.equal(result.actions[0].status, "applied");
  assert.equal(result.actions[0].userId, admin.id);
  assert.equal(result.actions[0].actorId, session.id);
});

test("HTTP assistant settings and action feeds are scoped; external tokens inherit account permissions", async t => {
  const app = createApp({ database: ":memory:", env: {}, assistantFetch: async () => Response.json({ data: [{ id: "test-model" }] }) });
  const { admin, first, second } = users(app.store);
  const cookie = user => `releaf_session=${app.store.auth.login({ username: user.username, password }).sessionToken}`;
  const cookies = { admin: cookie(admin), first: cookie(first), second: cookie(second) };
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); app.store.close(); });
  const request = (user, path, method = "GET", body, extra = {}) => fetch(`http://127.0.0.1:${app.server.address().port}${path}`, {
    method, headers: { ...(user ? { Cookie: cookies[user] } : {}), ...(body ? { "Content-Type": "application/json" } : {}), ...extra },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const token = await (await request("first", "/api/assistant/tokens", "POST", { name: "Member token", mode: "full", confirmFullAccess: true })).json();
  assert.equal(token.userId, first.id);
  assert.equal((await (await request("second", "/api/assistant/tokens")).json()).length, 0);
  assert.equal((await request("second", `/api/assistant/tokens/${token.id}`, "DELETE")).status, 404);
  for (const [path, method, body] of [["/api/assistant/config", "GET"], ["/api/assistant/config", "PUT", provider], ["/api/assistant/models", "POST", provider]]) {
    assert.equal((await request("first", path, method, body)).status, 403);
  }
  assert.equal((await request("admin", "/api/assistant/config", "PUT", provider)).status, 200);
  const session = await (await request("first", "/api/assistant/sessions", "POST", {})).json();
  assert.equal((await request("second", `/api/assistant/sessions/${session.id}`)).status, 404);
  const headers = { Authorization: `Bearer ${token.token}`, "Idempotency-Key": "forbidden" };
  assert.equal((await request(null, "/api/agent/forms", "POST", { name: "Forbidden", fields }, headers)).status, 403);
  assert.equal((await request(null, "/api/agent/forms", "GET", undefined, headers)).status, 200);
  const tools = (await (await request(null, "/api/agent/tools", "GET", undefined, headers)).json()).tools;
  assert.equal(tools.some(tool => tool.function.name === "create_record"), false);
  assert.equal(tools.some(tool => tool.function.name === "create_form"), false);
  assert.equal(tools.some(tool => tool.function.name === "save_inventory_catalog"), false);
  assert.equal(tools.some(tool => tool.function.name === "create_inventory_request"), true);
  const tables = app.store.warehouse.ensureTables().tables;
  const product = app.store.warehouse.catalog({ role: "products", values: { code: "TOKEN-P", name: "Token product", unit: "kg" } });
  const warehouse = app.store.listRecords(tables.warehouses)[0];
  for (const args of [
    { role: "products", values: { code: "FORBIDDEN", name: "Forbidden", unit: "kg" } },
    { role: "products", recordId: product.id, version: product.version, values: { name: "Forbidden" } },
  ]) {
    const denied = await request(null, "/api/agent/operations", "POST", { operation: "save_inventory_catalog", args },
      { ...headers, "Idempotency-Key": `catalog-${args.recordId ? "update" : "create"}` });
    assert.equal(denied.status, 403);
  }
  const actionResponse = await request(null, "/api/agent/operations", "POST", { operation: "create_inventory_request",
    args: { kind: "inbound", values: { warehouse: warehouse.id, approver: admin.id }, lines: [{ product: product.id, quantity: 3 }] },
  }, { ...headers, "Idempotency-Key": "request" });
  assert.equal(actionResponse.status, 200);
  const action = await actionResponse.json();
  assert.equal(action.status, "applied");
  assert.equal(action.userId, first.id);
  const secondFeed = await (await request("second", "/api/assistant/state")).json();
  assert.equal(secondFeed.actions.length, 0);
  assert.equal(secondFeed.config.configured, true);
  assert.equal(secondFeed.config.baseUrl, undefined);
  assert.equal(secondFeed.config.hasApiKey, undefined);
  assert.equal((await (await request("first", "/api/assistant/state")).json()).actions[0].id, action.id);
});

test("member Agent dashboard reads stay within their token's Space", async t => {
  const app = createApp({ database: ":memory:", env: {} });
  const { first } = users(app.store), { store } = app;
  const defaultTables = store.warehouse.ensureTables().tables;
  const defaultProduct = store.warehouse.catalog({ role: "products", values: { code: "LOCAL", name: "Local flour", unit: "kg" } });
  const space = store.spaces.create("Other inventory");
  const tables = store.warehouse.ensureTables(space.id).tables;
  const product = store.warehouse.catalog({ spaceId: space.id, role: "products", values: { code: "OTHER", name: "Other boxes", unit: "pcs" } });
  const warehouse = store.listRecords(tables.warehouses)[0];
  store.warehouse.catalog({ spaceId: space.id, role: "stock", values: { product: product.id, warehouse: warehouse.id, openingQuantity: 7 } });
  const operations = createAgentOperations(store);
  const token = store.auth.withUser(first, () => operations.createToken({ name: "Scoped dashboard", spaceId: space.id }));
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); store.close(); });
  const request = async args => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/agent/operations`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token.token}` },
      body: JSON.stringify({ operation: "get_inventory_dashboard", args }),
    });
    return { status: response.status, data: await response.json() };
  };
  const result = await request({ from: "2026-10", to: "2026-10" });
  assert.equal(result.status, 200);
  assert.equal(result.data.tables.stock, tables.stock);
  assert.notEqual(result.data.tables.stock, defaultTables.stock);
  assert.deepEqual(result.data.available.products.map(row => row.id), [product.id]);
  assert.deepEqual(result.data.summary.inventory, [{ unit: "pcs", quantity: 7 }]);
  assert.equal((await request({ spaceId: "default" })).status, 403);
  assert.equal((await request({ productId: defaultProduct.id })).status, 400);
  assert.equal(store.agent.listActions().length, 0);
});
