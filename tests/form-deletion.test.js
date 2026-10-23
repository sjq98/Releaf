import test from "node:test";
import { setupAdmin } from "./helpers/http-auth.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStore } from "../src/store.js";
import { createApp } from "../src/server.js";
import { createAgentOperations } from "../src/agent-operations.js";
import { createStore as prototypeStore } from "../future/cross-form-automation/src/store.js";
import { createInventoryModule } from "../future/cross-form-automation/src/inventory.js";
import { createSupplierService } from "../future/cross-form-automation/src/supplier-reconciliation.js";
import { retireLegacyForms } from "../scripts/retire-legacy-forms.mjs";

const field = (id, extra = {}) => ({ id, name: id, type: "text", required: false, unique: false, options: [], ...extra });
function fixture(t) {
  const store = createStore(":memory:"); t.after(() => store.close());
  const form = store.createForm({ name: "Custom register", fields: [field("code", { unique: true })] });
  const record = store.createRecord(form.id, { schemaVersion: 1, values: { code: "A" } }).record;
  return { store, form, record };
}
const remove = (store, id, overrides = {}) => store.deletions.remove(id, { ...store.deletions.inspect(id), confirmed: true, ...overrides });

test("form deletion requires explicit confirmation, retains history and removes all active entry points", t => {
  const { store, form, record } = fixture(t);
  store.automation.save({ name: "Alert", formId: form.id, trigger: "created", enabled: true, actions: [{ type: "notify", message: "Saved" }] });
  const before = store.deletions.inspect(form.id);
  assert.equal(before.recordCount, 1); assert.equal(before.notificationRuleCount, 1);
  assert.throws(() => store.deletions.remove(form.id, before), /Confirm form deletion/);
  const result = remove(store, form.id);
  assert.equal(result.deleted, true);
  assert.throws(() => store.getForm(form.id), { status: 404 });
  assert.throws(() => store.getRecord(record.id), { status: 404 });
  assert.throws(() => store.listRecords(form.id), { status: 404 });
  assert.throws(() => store.listChanges(form.id), { status: 404 });
  assert.ok(!store.spaces.tree().some(node => node.formId === form.id));
  assert.ok(!store.referenceCatalog().some(table => table.id === form.id));
  assert.equal(store.automation.list().length, 0);
  assert.equal(store.database.prepare("SELECT values_json FROM records WHERE id = ?").get(record.id).values_json, '{"code":"A"}');
  assert.equal(store.database.prepare("SELECT count(*) n FROM form_activity WHERE form_id = ?").get(form.id).n, 1);
  assert.equal(store.database.prepare("SELECT count(*) n FROM unique_values WHERE form_id = ?").get(form.id).n, 0);
  assert.equal(store.database.prepare("SELECT record_count FROM form_deletions WHERE form_id = ?").get(form.id).record_count, 1);
});

test("reference schemas block deletion even with no records; removing the referencing field releases it", t => {
  const { store, form } = fixture(t);
  const source = store.createForm({ name: "Linked", fields: [
    field("note"), field("ref", { type: "reference", reference: { formId: form.id, fieldId: "code" } }),
  ] });
  assert.equal(store.deletions.inspect(form.id).blockers[0].type, "reference");
  assert.throws(() => remove(store, form.id), { status: 409 });
  store.updateForm(source.id, { ...source, fields: [source.fields[0]] });
  assert.equal(remove(store, form.id).deleted, true);
});

test("warehouse core tables and AI-task dependencies are protected identically to ordinary writes", t => {
  const { store, form } = fixture(t);
  const tables = store.warehouse.ensureTables().tables;
  for (const id of Object.values(tables)) {
    assert.equal(store.deletions.inspect(id).blockers[0].type, "system");
    assert.throws(() => remove(store, id), { status: 409 });
  }
  const target = store.createForm({ name: "AI output", fields: [field("result")] });
  const task = store.tasks.save({ name: "Extract", formId: form.id, inputFields: ["code"], outputFormId: target.id, outputFields: ["result"], instructions: "Extract", mode: "review", action: "create" });
  assert.equal(store.deletions.inspect(form.id).blockers[0].type, "task");
  assert.equal(store.deletions.inspect(target.id).blockers[0].type, "task");
  store.tasks.remove(task.id, task.version);
  assert.equal(remove(store, target.id).deleted, true);
});

test("stale record data, schema, and newly added references invalidate deletion previews", t => {
  const { store, form, record } = fixture(t);
  const preview = store.deletions.inspect(form.id);
  store.updateRecord(record.id, { schemaVersion: 1, version: 1, values: { code: "B" } });
  assert.throws(() => store.deletions.remove(form.id, { ...preview, confirmed: true }), /changed/);
  assert.throws(() => remove(store, form.id, { version: 0 }), /changed/);
  assert.equal(store.getRecord(record.id).values.code, "B");
});

test("external notification lookups block deletion until the dependency is removed", t => {
  const { store, form } = fixture(t);
  const source = store.createForm({ name: "Alerts", fields: [field("code")] });
  const rule = store.automation.save({
    name: "Lookup alert", formId: source.id, trigger: "created", enabled: true,
    condition: { fieldId: "code", operator: "eq", value: { kind: "field", scope: "lookup", formId: form.id, fieldId: "code", selection: "first" } },
    actions: [{ type: "notify", message: "Matching code" }],
  });
  assert.equal(store.deletions.inspect(form.id).blockers[0].type, "notification");
  assert.throws(() => remove(store, form.id), { status: 409 });
  store.automation.remove(rule.id, rule.version);
  assert.equal(remove(store, form.id).deleted, true);
});

test("deleting the last form gives an empty Space and does not recreate templates on reopen", () => {
  const folder = mkdtempSync(join(tmpdir(), "releaf-delete-")), filename = join(folder, "forms.sqlite");
  let store = createStore(filename);
  try {
    const id = store.listForms()[0].id;
    remove(store, id);
    assert.equal(store.bootstrap().form, null);
    assert.deepEqual(store.bootstrap().records, []);
    store.close(); store = createStore(filename);
    assert.equal(store.listForms().length, 0);
    assert.deepEqual(store.spaces.tree(), []);
    assert.equal(store.createForm({ name: "Start again" }).name, "Start again");
  } finally { store.close(); rmSync(folder, { recursive: true, force: true }); }
});

test("Agent form deletion always waits for a human, including full access, and stale approvals fail", t => {
  const { store, form } = fixture(t), ops = createAgentOperations(store);
  const token = ops.createToken({ name: "Full", mode: "full" }), actor = { ...token, type: "token" };
  const args = { formId: form.id, version: form.version };
  const action = ops.run("delete_form", args, actor, "delete");
  assert.equal(action.status, "pending"); assert.equal(action.preview.deletion.recordCount, 1);
  assert.equal(store.getForm(form.id).id, form.id);
  assert.equal(ops.run("delete_form", args, actor, "delete").id, action.id);
  const other = store.spaces.create("Other");
  const outsider = ops.createToken({ name: "Outside", spaceId: other.id });
  assert.throws(() => ops.run("preview_form_deletion", { formId: form.id }, { ...outsider, type: "token" }), { status: 403 });
  store.createRecord(form.id, { schemaVersion: 1, values: { code: "B" } });
  assert.throws(() => ops.approve(action.id), /changed since preview/);
  const fresh = ops.run("delete_form", args, actor, "fresh");
  assert.equal(ops.approve(fresh.id).status, "applied");
  assert.equal(ops.run("delete_form", args, actor, "fresh").status, "applied");
});

test("HTTP deletion previews are read-only, writes are local-only, confirmed and idempotent", async t => {
  const app = createApp({ database: ":memory:" });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); app.store.close(); });
  const base = `http://127.0.0.1:${app.server.address().port}`, id = app.store.listForms()[0].id;
  const { cookie } = await setupAdmin(base);
  const preview = await (await fetch(`${base}/api/forms/${id}/deletion-preview`, { headers: { Cookie: cookie } })).json();
  const body = { version: preview.version, fingerprint: preview.fingerprint, confirmed: true };
  const request = (extra = {}, value = body) => fetch(`${base}/api/forms/${id}`, {
    method: "DELETE", headers: { Cookie: cookie, "Content-Type": "application/json", "Idempotency-Key": "delete", ...extra }, body: JSON.stringify(value),
  });
  assert.equal((await request({ Origin: "https://untrusted.example" })).status, 403);
  assert.equal((await request({ Authorization: "Bearer test" })).status, 403);
  assert.equal((await request({}, { ...body, confirmed: false })).status, 400);
  assert.equal((await request()).status, 200);
  assert.equal((await request()).status, 200);
  assert.equal((await fetch(`${base}/api/forms/${id}`, { headers: { Cookie: cookie } })).status, 404);
  assert.equal((await (await fetch(`${base}/api/bootstrap`, { headers: { Cookie: cookie } })).json()).form, null);
});

test("Agent HTTP deletion cannot self-confirm and retired routes and assets remain unavailable", async t => {
  const app = createApp({ database: ":memory:" });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); app.store.close(); });
  const base = `http://127.0.0.1:${app.server.address().port}`, form = app.store.listForms()[0];
  const { cookie, user } = await setupAdmin(base);
  const token = app.store.auth.withUser(user, () => createAgentOperations(app.store).createToken({ name: "Full deletion", mode: "full" }));
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token.token}`, "Idempotency-Key": "delete-full" };
  const response = await fetch(`${base}/api/agent/forms/${form.id}`, { method: "DELETE", headers, body: JSON.stringify({ version: form.version }) });
  assert.equal(response.status, 202);
  const action = await response.json();
  assert.equal(action.status, "pending");
  assert.equal((await fetch(`${base}/api/assistant/actions/${action.id}/approve`, { method: "POST", headers, body: "{}" })).status, 403);
  assert.equal(app.store.getForm(form.id).id, form.id);
  for (const path of ["/api/inventory", "/api/suppliers/tables", "/api/reconciliations", "/api/meetings", "/api/stock-receipts"]) {
    assert.equal((await fetch(`${base}${path}`, { headers: { Cookie: cookie } })).status, 410, path);
  }
  for (const path of ["/supplier.js", "/inventory.js", "/inventory.css"]) assert.equal((await fetch(`${base}${path}`)).status, 404, path);
});

test("legacy cleanup retires only registered templates, preserves custom forms and warehouse, and is repeatable", () => {
  const folder = mkdtempSync(join(tmpdir(), "releaf-retire-")), filename = join(folder, "forms.sqlite");
  let store = prototypeStore(filename);
  try {
    const orders = store.listForms()[0], todos = store.ensureMeetingTable();
    store.createRecord(orders.id, { schemaVersion: 1, values: { orderNumber: "KEEP-HISTORY", completed: "No" } });
    createInventoryModule(store).ensureTables();
    createSupplierService({ store, aiConfig: {} }).ensureTables();
    const custom = store.createForm({ name: "Orders", fields: [field("code")] });
    const other = store.spaces.create("User Space");
    store.createForm({ name: "Mine", spaceId: other.id });
    store.close(); store = createStore(filename);
    const warehouse = store.warehouse.ensureTables().tables;
    const result = retireLegacyForms(store);
    assert.equal(result.retired.length, 8);
    assert.throws(() => store.getForm(todos.id), { status: 404 });
    assert.equal(store.getForm(custom.id).name, "Orders");
    assert.equal(store.listForms(other.id).length, 1);
    assert.equal(Object.keys(store.warehouse.state().tables).length, 7);
    assert.equal(store.listRecords(warehouse.warehouses).length, 1);
    assert.equal(store.database.prepare("SELECT count(*) n FROM records WHERE form_id = ?").get(orders.id).n, 1);
    assert.deepEqual(retireLegacyForms(store).retired, []);
    assert.equal(store.workflows, undefined); assert.equal(store.inventory, undefined); assert.equal(store.receipts, undefined);
  } finally { store.close(); rmSync(folder, { recursive: true, force: true }); }
});

test("legacy cleanup rolls back completely when a custom form still references an old template", () => {
  const folder = mkdtempSync(join(tmpdir(), "releaf-retire-blocked-")), filename = join(folder, "forms.sqlite");
  let store = prototypeStore(filename);
  try {
    const orders = store.listForms()[0];
    store.ensureMeetingTable();
    store.createForm({ name: "Keep my links", fields: [field("order", { type: "reference", reference: { formId: orders.id, fieldId: "orderNumber" } })] });
    store.close(); store = createStore(filename);
    const before = store.listForms().map(form => form.id);
    assert.throws(() => retireLegacyForms(store), /still references a legacy form/);
    assert.deepEqual(store.listForms().map(form => form.id), before);
    assert.equal(store.database.prepare("SELECT count(*) n FROM form_deletions").get().n, 0);
  } finally { store.close(); rmSync(folder, { recursive: true, force: true }); }
});
