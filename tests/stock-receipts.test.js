// Archived prototype regression suite. Active workflow restrictions have separate tests.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createStore } from "../future/cross-form-automation/src/store.js";
import { createInventoryModule } from "../future/cross-form-automation/src/inventory.js";
import { createAgentOperations } from "../future/cross-form-automation/src/agent-operations.js";
import { createTableImport } from "../future/cross-form-automation/src/table-import.js";
import { createApp } from "../future/cross-form-automation/src/server.js";

const field = (id, type = "text", extra = {}) => ({ id, name: id, type, required: false, unique: false, ...extra });
const from = (fieldId) => ({ kind: "field", scope: "source", fieldId });
const add = (store, form, values) => store.createRecord(form.id, { schemaVersion: store.getForm(form.id).version, values }).record;
const edit = (store, record, values) => store.updateRecord(record.id, { schemaVersion: store.getForm(record.formId).version, version: store.getRecord(record.id).version, values });
function setup(store, ledger = false, spaceId = "default") {
  const source = store.createForm({ name: "Receipts", spaceId, fields: [field("line", "text", { unique: true }), field("item"), field("qty", "number"), field("unit"), field("note")] });
  const inventory = createInventoryModule(store);
  const target = ledger ? inventory.ensureTables().materials : store.createForm({ name: "Stock", spaceId, fields: [
    field("name", "text", { required: true }), field("stock", "number"), field("unit"), field("note"),
  ] });
  const action = { type: "receive_stock", formId: target.id, itemField: "item", quantityField: "qty", matchField: "name",
    ...(ledger ? {} : { stockField: "stock" }), sourceUnitField: "unit", targetUnitField: "unit", newRecordValues: ledger ? { sku: from("item") } : {} };
  const rule = store.automation.save({ name: "Receive stock", formId: source.id, trigger: "created", enabled: true, actions: [action] });
  return { store, source, target, action, rule, inventory, receive: (qty, item = "Flour", unit = "kg") => add(store, source, { line: randomUUID(), item, qty, unit }),
    stock: () => ledger ? Number(inventory.state().summary[0]?.onHand ?? 0) : store.listRecords(target.id)[0]?.values.stock ?? 0 };
}
function fixture(t, ledger = false) {
  const store = createStore(":memory:"); t.after(() => store.close()); return setup(store, ledger);
}

test("receipt action creates a missing material then adds exact quantities without replacing other fields", (t) => {
  const { store, target, receive, stock } = fixture(t);
  receive(0.1);
  const material = store.listRecords(target.id)[0];
  edit(store, material, { note: "Keep" });
  receive(0.2, "flour");
  assert.equal(stock(), 0.3);
  assert.equal(store.listRecords(target.id).length, 1);
  assert.equal(store.getRecord(material.id).values.note, "Keep");
  assert.deepEqual(store.automation.runs().map((run) => run.steps[0].outcome), ["updated", "created"]);
  assert.equal(store.receipts.list("default").length, 2);
});

test("preview and idempotent HTTP-style retries leave neither duplicate stock nor receipt postings", (t) => {
  const { store, source, target, stock } = fixture(t);
  const body = { schemaVersion: source.version, values: { line: "R1", item: "Salt", qty: 3, unit: "kg" } };
  const preview = store.preview(() => store.createRecord(source.id, body));
  assert.equal(preview.effects.length, 2);
  assert.equal(store.listRecords(source.id).length, 0);
  assert.equal(store.listRecords(target.id).length, 0);
  assert.equal(store.receipts.list("default").length, 0);
  const first = store.automation.once("receive-1", body, () => store.createRecord(source.id, body));
  const retry = store.automation.once("receive-1", body, () => store.createRecord(source.id, body));
  assert.equal(first.record.id, retry.record.id);
  assert.equal(stock(), 3);
  assert.equal(store.receipts.list("default").length, 1);
});

test("ambiguous materials, unit mismatch, invalid quantities and later failed actions roll back the receipt", (t) => {
  const { store, source, target, receive, rule, action, stock } = fixture(t);
  add(store, target, { name: "Duplicate", unit: "kg", stock: 1 });
  add(store, target, { name: "duplicate", unit: "kg", stock: 2 });
  assert.throws(() => receive(1, "Duplicate"), /Multiple materials/);
  receive(3, "Flour");
  assert.throws(() => receive(1, "Flour", "g"), /units do not match/);
  for (const qty of [0, -1, 0.0000001, 1e13]) assert.throws(() => receive(qty), /Received quantity/);
  assert.equal(store.listRecords(source.id).length, 1);
  store.automation.save({ ...rule, actions: [action, { type: "update", formId: target.id, selection: "first", noMatch: "error", condition: { fieldId: "name", operator: "eq", value: { kind: "literal", value: "Missing" } }, assignments: { stock: { kind: "literal", value: 99 } } }] }, rule.id);
  assert.throws(() => receive(5, "Butter"), /no records matched/);
  assert.ok(!store.listRecords(target.id).some((row) => row.values.name === "Butter"));
  assert.equal(store.receipts.list("default").length, 1);
  assert.ok(store.automation.errors().some((error) => error.context.ruleId === rule.id));
  assert.equal(stock(), 3);
});

test("duplicate receiving actions fail atomically and a trigger condition can skip unapproved receipts", (t) => {
  const { store, source, target, rule, action, receive } = fixture(t);
  const duplicated = store.automation.save({ ...rule, actions: [action, action] }, rule.id);
  assert.throws(() => receive(3), /only one Receive stock/);
  assert.equal(store.listRecords(target.id).length, 0);
  assert.equal(store.listRecords(source.id).length, 0);
  store.automation.save({ ...duplicated, actions: [action], condition: { fieldId: "note", operator: "eq", value: { kind: "literal", value: "Approved" } } }, rule.id);
  receive(3);
  assert.equal(store.receipts.list("default").length, 0);
  assert.equal(store.listRecords(source.id).length, 1);
});

test("receiving mappings reject unsupported triggers, cross-Space targets, calculated stock and missing required defaults", (t) => {
  const { store, source, target, action, rule } = fixture(t);
  assert.throws(() => store.automation.save({ ...rule, trigger: "updated" }), /only for Record created/);
  const other = store.spaces.create("Other"), foreign = store.createForm({ name: "Foreign", spaceId: other.id, fields: [field("name"), field("stock", "number")] });
  assert.throws(() => store.automation.save({ ...rule, actions: [{ ...action, formId: foreign.id }] }), /same Space/);
  assert.throws(() => store.updateForm(target.id, { ...target, fields: target.fields.map((f) => f.id === "stock" ? { ...f, formula: { expression: "1", bindings: {} } } : f) }), /editable.*stock field/);
  const required = store.createForm({ name: "Required defaults", fields: [field("name"), field("stock", "number"), field("unit"), field("code", "text", { required: true })] });
  assert.throws(() => store.automation.save({ ...rule, actions: [{ ...action, formId: required.id }] }), /every required field/);
  assert.throws(() => store.automation.save({ ...rule, actions: [{ ...action, newRecordValues: { stock: from("qty") } }] }), /cannot override/);
  assert.throws(() => store.automation.save({ ...rule, actions: [{ ...action, newRecordValues: { note: { kind: "field", scope: "target", fieldId: "note" } } }] }), /receipt fields/);
  assert.equal(store.getForm(source.id).version, 1);
});

test("posted receipts protect source identity and schemas even after rule deletion; reversal unlocks corrections", (t) => {
  const { store, source, target, rule, receive, stock } = fixture(t);
  const row = receive(4), receipt = store.receipts.list("default")[0], material = store.listRecords(target.id)[0];
  edit(store, row, { note: "Delivery checked" });
  assert.throws(() => edit(store, row, { qty: 9 }), /Reverse/);
  assert.throws(() => edit(store, material, { unit: "g" }), /Reverse/);
  assert.throws(() => store.deleteRecord(row.id, { version: store.getRecord(row.id).version }), /Reverse/);
  store.automation.remove(rule.id, rule.version);
  assert.throws(() => store.updateForm(source.id, { ...source, fields: source.fields.filter((f) => f.id !== "qty") }), /Reverse/);
  assert.throws(() => store.updateForm(target.id, { ...target, fields: target.fields.filter((f) => f.id !== "stock") }), /Reverse/);
  store.preview(() => store.receipts.reverse(receipt.id, "Check"));
  assert.equal(stock(), 4);
  assert.equal(store.receipts.get(receipt.id).reversed, false);
  store.receipts.reverse(receipt.id, "Wrong delivery");
  assert.equal(stock(), 0);
  assert.equal(store.receipts.reverse(receipt.id, "Retry").alreadyReversed, true);
  edit(store, row, { qty: 9 });
  assert.equal(stock(), 0);
});

test("reversal cannot make custom stock negative", (t) => {
  const { store, target, receive, stock } = fixture(t);
  receive(5);
  edit(store, store.listRecords(target.id)[0], { stock: 2 });
  const receipt = store.receipts.list("default")[0];
  assert.throws(() => store.receipts.reverse(receipt.id, "Correction"), /already been consumed/);
  assert.equal(stock(), 2);
  assert.equal(store.receipts.get(receipt.id).reversed, false);
});

test("custom-Space receipt discovery and reversal errors retain ownership and exact numeric balances", (t) => {
  const store = createStore(":memory:"); t.after(() => store.close());
  const space = store.spaces.create("Receiving");
  const { source, target, receive, stock } = setup(store, false, space.id);
  receive(0.000001);
  const operations = createAgentOperations(store), actor = { type: "chat", id: store.agent.createSession().id, name: "Assistant" };
  const receipts = operations.run("list_stock_receipts", { formId: source.id }, actor);
  assert.equal(receipts.length, 1);
  edit(store, store.listRecords(target.id)[0], { stock: 999999999999999.9 });
  assert.throws(() => store.receipts.reverse(receipts[0].id, "Correction"), /cannot be stored exactly/);
  assert.equal(stock(), 999999999999999.9);
  assert.equal(store.receipts.get(receipts[0].id).reversed, false);
  assert.equal(store.automation.errors(space.id)[0].context.receiptId, receipts[0].id);
  assert.equal(store.automation.errors("default").length, 0);
});

test("Materials receiving writes the shared ledger and supports existing inventory reversal", (t) => {
  const { store, target, receive, inventory, stock } = fixture(t, true);
  const row = receive(2), receipt = store.receipts.list("default")[0];
  receive(3);
  assert.equal(stock(), 5);
  assert.equal(store.listRecords(target.id).length, 1);
  assert.equal(inventory.state().movements.filter((move) => move.kind === "receipt").length, 2);
  assert.ok(store.automation.runs()[0].changes.some((change) => change.kind === "stock_received"));
  const request = { kind: "reversal", sourceId: receipt.postingId, note: "Correction" };
  inventory.post({ ...request, previewToken: inventory.preview(request).previewToken, idempotencyKey: randomUUID() });
  assert.equal(stock(), 3);
  assert.equal(store.receipts.get(receipt.id).reversed, true);
  assert.equal(store.receipts.reverse(receipt.id, "Retry").alreadyReversed, true);
  edit(store, row, { qty: 6 });
  const remaining = store.receipts.list("default").find((item) => !item.reversed);
  store.receipts.reverse(remaining.id, "Correction");
  assert.equal(stock(), 0);
});

test("reference material fields match stable IDs rather than their display labels", (t) => {
  const { store, source, target, rule, action } = fixture(t);
  store.automation.remove(rule.id, rule.version);
  const keyed = store.updateForm(target.id, { ...target, fields: target.fields.map((f) => f.id === "name" ? { ...f, unique: true } : f) });
  const material = add(store, keyed, { name: "M1", stock: 2, unit: "kg" });
  const referenced = store.updateForm(source.id, { ...source, fields: source.fields.map((f) => f.id === "item" ? { ...f, type: "reference", reference: { formId: keyed.id, fieldId: "name" } } : f) });
  store.automation.save({ ...rule, actions: [action] });
  add(store, referenced, { item: material.id, qty: 3, unit: "kg" });
  assert.equal(store.getRecord(material.id).values.stock, 5);
});

test("Agent approvals include receiving effects and ledger changes invalidate pending previews", (t) => {
  const { store, source, receive, stock, inventory } = fixture(t, true);
  receive(1);
  const operations = createAgentOperations(store), actor = { type: "chat", id: store.agent.createSession().id, name: "Assistant" };
  const args = { formId: source.id, schemaVersion: source.version, values: { item: "Flour", qty: 2, unit: "kg" } };
  const pending = operations.run("create_record", args, actor, "receive-1");
  assert.equal(stock(), 1);
  assert.ok(pending.preview.changes.some((change) => change.kind === "stock_received"));
  const adjustment = { kind: "adjustment", materialId: inventory.state().summary[0].materialId, direction: "In", quantity: 4, note: "Count" };
  inventory.post({ ...adjustment, previewToken: inventory.preview(adjustment).previewToken, idempotencyKey: randomUUID() });
  assert.throws(() => operations.approve(pending.id), /changed since preview/);
  const next = operations.run("create_record", args, actor, "receive-2");
  operations.approve(next.id);
  assert.equal(stock(), 7);
  operations.approve(next.id);
  assert.equal(stock(), 7);
  const receipt = store.receipts.list("default").find((item) => item.quantity === 2);
  const reverse = operations.run("reverse_stock_receipt", { receiptId: receipt.id, note: "Correction" }, actor, "reverse-1");
  assert.equal(stock(), 7);
  operations.approve(reverse.id);
  assert.equal(stock(), 5);
  const space = store.spaces.create("Other"), token = operations.createToken({ name: "Other", spaceId: space.id, mode: "full" });
  const outsider = { ...token, type: "token" };
  assert.throws(() => operations.run("get_stock_receipt", { receiptId: receipt.id }, outsider), /another Space/);
  assert.throws(() => operations.run("reverse_stock_receipt", { receiptId: receipt.id, note: "No" }, outsider, "bad"), /another Space/);
  assert.deepEqual(operations.run("list_stock_receipts", {}, outsider), []);
});

test("spreadsheet preview and commit receive stock atomically without repeating imports", (t) => {
  const { store, source, target, stock } = fixture(t);
  const imports = createTableImport(store);
  const preview = imports.preview({ formId: source.id, schemaVersion: source.version, rows: [["A", "Flour", 2, "kg"], ["B", "Flour", 3, "kg"]], mapping: { line: 0, item: 1, qty: 2, unit: 3 } });
  assert.equal(preview.errors.length, 0);
  assert.equal(store.listRecords(target.id).length, 0);
  assert.equal(store.receipts.list("default").length, 0);
  imports.commit(preview.id);
  assert.equal(stock(), 5);
  imports.commit(preview.id);
  assert.equal(stock(), 5);
});

test("receiving definitions, receipt protections and reversals persist across reopen", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "releaf-receipts-")), database = join(directory, "forms.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let store = createStore(database);
  const { source, target, receive } = setup(store);
  receive(6);
  const receiptId = store.receipts.list("default")[0].id;
  store.close(); store = createStore(database);
  try {
    assert.equal(store.listRecords(target.id)[0].values.stock, 6);
    assert.equal(store.automation.list("default", source.id)[0].actions[0].type, "receive_stock");
    assert.throws(() => edit(store, store.listRecords(source.id)[0], { qty: 9 }), /Reverse/);
    store.receipts.reverse(receiptId, "Correction");
    assert.equal(store.listRecords(target.id)[0].values.stock, 0);
  } finally { store.close(); }
});

test("HTTP receipt reversal requires a fresh preview and leaves previews unwritten", async (t) => {
  const app = createApp({ database: ":memory:", env: {} });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise((resolve) => app.server.close(resolve)); app.store.close(); });
  const { receive, stock, target } = setup(app.store);
  receive(3);
  const receipt = app.store.receipts.list("default")[0];
  const path = `http://127.0.0.1:${app.server.address().port}/api/stock-receipts/${receipt.id}`;
  const post = (suffix, body, headers = {}) => fetch(path + suffix, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  assert.equal((await fetch(path, { headers: { Authorization: "Bearer pretend" } })).status, 403);
  assert.equal((await post("/reverse", { note: "Correction" })).status, 409);
  const preview = await (await post("/reverse-preview", { note: "Correction" })).json();
  assert.equal(preview.changes[0].before.stock, 3);
  assert.equal(stock(), 3);
  edit(app.store, app.store.listRecords(target.id)[0], { stock: 4 });
  assert.equal((await post("/reverse", { note: "Correction", fingerprint: preview.fingerprint })).status, 409);
  const fresh = await (await post("/reverse-preview", { note: "Correction" })).json();
  const body = { note: "Correction", fingerprint: fresh.fingerprint }, headers = { "Idempotency-Key": "reverse-receipt-http" };
  assert.equal((await post("/reverse", body, headers)).status, 200);
  assert.equal(stock(), 1);
  assert.equal((await post("/reverse", body, headers)).status, 200);
  assert.equal(stock(), 1);
});
