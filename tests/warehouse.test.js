import test from "node:test";
import { setupAdmin } from "./helpers/http-auth.js";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createAgentOperations } from "../src/agent-operations.js";
import { createApp } from "../src/server.js";
import { createTableImport } from "../src/table-import.js";
import { createStore as createPrototypeStore } from "../future/cross-form-automation/src/store.js";
import { AGENT_TOOLS } from "../src/agent-operations.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function setup(t, spaceId = "default", store = createStore(":memory:")) {
  t.after(() => store.close());
  const wh = store.warehouse, tables = wh.ensureTables(spaceId).tables;
  const add = (role, values) => wh.catalog({ spaceId, role, values });
  const warehouse = store.listRecords(tables.warehouses)[0];
  const product = add("products", { code: "P1", name: "Flour", unit: "kg" });
  const second = add("products", { code: "P2", name: "Salt", unit: "kg" });
  const stockRecord = add("stock", { product: product.id, warehouse: warehouse.id, openingQuantity: 10, minimum: 5 });
  add("stock", { product: second.id, warehouse: warehouse.id, openingQuantity: 2 });
  const create = (kind = "inbound", quantity = 3, submit = false) => wh.createDocument({ spaceId, kind, values: { warehouse: warehouse.id, applicant: "Applicant", approver: "Manager" }, lines: [{ product: product.id, quantity }], submit });
  const advance = (id, action, extra = {}) => wh.transition(id, { action, version: store.getRecord(id).version, actor: ["approve", "reject"].includes(action) ? "Manager" : "Operator", note: "Test reason", ...extra });
  const stock = () => store.getRecord(stockRecord.id).values.currentQuantity;
  return { store, wh, tables, add, warehouse, product, second, create, advance, stock, stockRecord };
}

test("warehouse setup is scoped, idempotent and creates seven read-only tables and two workflows", t => {
  const { store, wh, tables } = setup(t);
  assert.equal(Object.keys(tables).length, 7);
  assert.ok(Object.values(tables).every(id => store.getForm(id).readOnly));
  assert.equal(wh.state().workflows.length, 2);
  assert.deepEqual(wh.ensureTables().tables, tables);
  const space = store.spaces.create("Second");
  const other = wh.ensureTables(space.id);
  assert.notEqual(other.tables.stock, tables.stock);
  assert.equal(store.listRecords(other.tables.stock).length, 0);
  assert.equal(store.listForms().find(f => f.name === "New form").recordCount, 0);
});

test("inbound lifecycle totals and child fields stay synchronized; only posting changes exact stock", t => {
  const { store, tables, create, advance, stock, wh } = setup(t);
  const doc = create("inbound", 0.1);
  assert.equal(doc.record.values.totalQuantity, 0.1);
  assert.equal(stock(), 10);
  assert.match(doc.record.values.number, /^RK_\d{8}_001$/);
  advance(doc.record.id, "submit"); advance(doc.record.id, "approve");
  assert.equal(stock(), 10);
  assert.equal(wh.document(doc.record.id).lines[0].values.status, "Approved");
  advance(doc.record.id, "post", { date: "2026-10-23" });
  assert.equal(stock(), 10.1);
  assert.equal(store.listRecords(tables.inboundLines)[0].values.postedDate, "2026-10-23");
  assert.throws(() => advance(doc.record.id, "post"), /not available/);
  assert.equal(stock(), 10.1);
  advance(doc.record.id, "reverse");
  assert.equal(stock(), 10);
  assert.equal(wh.document(doc.record.id).events.length, 4);
  assert.equal(wh.state().movements.length, 2);
});

test("outbound confirmation is atomic, rechecks current stock and does not allow negative stock", t => {
  const { wh, warehouse, product, second, advance, stock, store } = setup(t);
  const doc = wh.createDocument({ kind: "outbound", values: { warehouse: warehouse.id, applicant: "A", approver: "Manager" }, lines: [{ product: product.id, quantity: 3 }, { product: second.id, quantity: 4 }], submit: true });
  advance(doc.record.id, "approve");
  assert.throws(() => advance(doc.record.id, "post"), /Insufficient warehouse stock/);
  assert.equal(stock(), 10); assert.equal(wh.state().movements.length, 0);
  assert.equal(wh.document(doc.record.id).record.values.status, "Approved");
  assert.ok(store.automation.errors().some(e => e.message.includes("Insufficient warehouse stock")));
});

test("raw CRUD cannot bypass approval, alter balances or mutate submitted document lines", t => {
  const { store, product, tables, create, advance, stock } = setup(t);
  const patch = (record, values) => store.updateRecord(record.id, { schemaVersion: store.getForm(record.formId).version, version: store.getRecord(record.id).version, values });
  assert.throws(() => patch(product, { currentQuantity: 999 }), /workflow/);
  const doc = create();
  assert.throws(() => patch(doc.record, { status: "Posted" }), /workflow/);
  advance(doc.record.id, "submit");
  assert.throws(() => patch(doc.lines[0], { quantity: 90 }), /read-only/);
  assert.throws(() => store.deleteRecord(doc.lines[0].id, { version: store.getRecord(doc.lines[0].id).version }), /read-only/);
  assert.throws(() => advance(doc.record.id, "approve", { actor: "Unassigned" }), /assigned approver/);
  assert.throws(() => advance(doc.record.id, "post"), /not available/);
  assert.equal(stock(), 10);
  const schema = store.getForm(tables.stock);
  assert.throws(() => store.updateForm(schema.id, { ...schema, fields: schema.fields.map(f => f.id === "currentQuantity" ? { ...f, formula: { expression: "999", bindings: {} } } : f) }), /read-only/);
});

test("rejected requests can be corrected and resubmitted; cancellation never changes stock", t => {
  const { wh, create, advance, product, stock } = setup(t);
  let doc = create("inbound", 3, true);
  doc = advance(doc.record.id, "reject");
  doc = wh.updateDocument(doc.record.id, { version: doc.record.version, values: { notes: "Corrected" }, lines: [{ ...doc.lines[0].values, id: doc.lines[0].id, version: doc.lines[0].version, quantity: 6 }] });
  assert.equal(doc.record.values.totalQuantity, 6);
  advance(doc.record.id, "submit"); advance(doc.record.id, "approve"); advance(doc.record.id, "cancel");
  assert.equal(stock(), 10);
  assert.throws(() => wh.updateDocument(doc.record.id, { version: doc.record.version, values: {}, lines: [{ product: product.id, quantity: 2 }] }), /Only draft/);
});

test("workflow line edits recalculate totals and one catalog product supports several warehouses", t => {
  const { wh, store, add, create, tables, warehouse, product } = setup(t);
  const doc = create();
  const other = add("warehouses", { code: "W2", name: "Other" });
  const stock = add("stock", { product: product.id, warehouse: other.id });
  assert.throws(() => wh.createDocument({ kind: "inbound", values: { applicant: "A", warehouse: warehouse.id }, lines: [{ product: product.id, quantity: 2 }, { product: stock.id, quantity: 2 }] }), /reference|warehouse system/i);
  assert.equal(store.listRecords(tables.inbound).length, 1);
  assert.throws(() => wh.updateDocument(doc.record.id, { version: doc.record.version, values: {}, lines: [{ product: product.id, quantity: 1 }, { product: product.id, quantity: 2 }] }), /already contains/);
  wh.updateDocument(doc.record.id, { version: doc.record.version, values: {}, lines: [] });
  assert.equal(store.getRecord(doc.record.id).values.totalQuantity, 0);
  assert.throws(() => wh.transition(doc.record.id, { action: "submit", version: store.getRecord(doc.record.id).version, actor: "A" }), /1-100/);
});

test("reversals use the original movements and cannot remove stock already consumed", t => {
  const { create, advance, stock, store, stockRecord, wh } = setup(t);
  const incoming = create("inbound", 4, true); advance(incoming.record.id, "approve"); advance(incoming.record.id, "post");
  const outgoing = create("outbound", 12, true); advance(outgoing.record.id, "approve"); advance(outgoing.record.id, "post");
  assert.equal(stock(), 2);
  assert.throws(() => advance(incoming.record.id, "reverse"), /Insufficient/);
  assert.throws(() => wh.catalog({ role: "stock", recordId: stockRecord.id, version: store.getRecord(stockRecord.id).version, values: { openingQuantity: 90 } }), /movement history/);
  advance(outgoing.record.id, "reverse"); assert.equal(stock(), 14);
  advance(incoming.record.id, "reverse"); assert.equal(stock(), 10);
});

test("Agent shares UI workflow actions and checks while respecting its change-approval mode and Space", t => {
  const { store, tables, warehouse, product, stock, advance } = setup(t);
  const ops = createAgentOperations(store), actor = { type: "chat", id: store.agent.createSession().id, name: "Assistant" };
  const args = { kind: "inbound", values: { warehouse: warehouse.id, applicant: "A", approver: "Manager" }, lines: [{ product: product.id, quantity: 3 }], submit: true };
  const action = ops.run("create_inventory_request", args, actor, "request-1");
  assert.equal(store.listRecords(tables.inbound).length, 0);
  assert.ok(action.preview.changes.length >= 3);
  const applied = ops.approve(action.id), id = applied.result.record.id;
  assert.equal(store.getRecord(id).values.status, "Pending approval");
  assert.equal(stock(), 10);
  assert.equal(ops.approve(action.id).result.record.id, id);
  assert.throws(() => ops.run("advance_inventory_request", { recordId: id, version: store.getRecord(id).version, action: "approve", actor: "Someone else" }, actor, "bad"), /assigned approver/);
  const approval = ops.run("advance_inventory_request", { recordId: id, version: store.getRecord(id).version, action: "approve", actor: "Manager" }, actor, "approve");
  assert.equal(store.getRecord(id).values.status, "Pending approval");
  ops.approve(approval.id);
  const post = ops.run("advance_inventory_request", { recordId: id, version: store.getRecord(id).version, action: "post", actor: "Warehouse" }, actor, "post");
  ops.approve(post.id); assert.equal(stock(), 13);
  const other = store.spaces.create("Other"), token = ops.createToken({ name: "Other", spaceId: other.id });
  assert.throws(() => ops.run("get_inventory_request", { recordId: id }, { ...token, type: "token" }), /another Space/);
});

test("generic spreadsheet imports cannot write read-only warehouse forms", t => {
  const { store, tables, warehouse } = setup(t), imports = createTableImport(store);
  const preview = imports.preview({ formId: tables.stock, schemaVersion: 1, rows: [["P3", "Butter", "WH001", "kg", 2]], mapping: { code: 0, name: 1, warehouse: 2, unit: 3, openingQuantity: 4 } });
  assert.equal(preview.errors.length, 1);
  assert.throws(() => imports.commit(preview.id), /Correct all/);
  assert.equal(store.listRecords(tables.stock).some(r => r.values.code === "P3"), false);
});

test("archived rules and pending Agent approvals cannot execute after upgrading a saved database", t => {
  const folder = mkdtempSync(join(tmpdir(), "releaf-warehouse-")), filename = join(folder, "data.sqlite");
  let store = createPrototypeStore(filename);
  t.after(() => { store.close(); rmSync(folder, { recursive: true, force: true }); });
  const source = store.listForms()[0], target = store.createForm({ name: "Target", fields: source.fields });
  const definition = { name: "Old cascade", formId: source.id, trigger: "created", enabled: true, actions: [{ type: "create", formId: target.id, assignments: { orderNumber: { kind: "literal", value: "AUTO" }, completed: { kind: "literal", value: "No" } } }] };
  store.automation.save(definition);
  const session = store.agent.createSession();
  const action = store.agent.insertAction({ actorId: session.id, actorName: "Old Agent", requestKey: "old-rule", operation: "create_automation", args: { definition }, preview: {} });
  store.close(); store = createStore(filename);
  assert.equal(store.automation.list().length, 0);
  store.createRecord(source.id, { schemaVersion: 1, values: { orderNumber: "MANUAL", completed: "No" } });
  assert.equal(store.listRecords(target.id).length, 0);
  const ops = createAgentOperations(store);
  assert.throws(() => store.automation.save(definition), /archived/);
  assert.throws(() => ops.approve(action.id), /Unknown agent operation/);
  assert.ok(!AGENT_TOOLS.some(t => /^(create|update|delete|list)_automation/.test(t.function.name)));
});

test("HTTP previews are unwritten, stale stock previews fail, retries cannot double-post, retired routes stay closed", async t => {
  const app = createApp({ database: ":memory:", env: {} });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  const { tables, create, advance, stock, store, stockRecord, wh } = setup(t, "default", app.store);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const { cookie } = await setupAdmin(base);
  const request = async (path, method = "GET", body, key, extra = {}) => {
    const response = await fetch(base + path, { method, headers: { Cookie: cookie, ...(body ? { "Content-Type": "application/json" } : {}), ...(key ? { "Idempotency-Key": key } : {}), ...extra }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const doc = create("inbound", 4, true); advance(doc.record.id, "approve");
  const path = `/api/warehouse/documents/${doc.record.id}`, body = { version: store.getRecord(doc.record.id).version, action: "post", actor: "Warehouse" };
  let preview = await request(path + "/preview", "POST", body);
  assert.equal(preview.status, 200); assert.equal(stock(), 10);
  assert.ok(preview.body.changes.some(c => c.formId === tables.stock));
  wh.catalog({ role: "stock", recordId: stockRecord.id, version: store.getRecord(stockRecord.id).version, values: { minimum: 2 } });
  assert.equal((await request(path + "/transition", "POST", { ...body, fingerprint: preview.body.fingerprint }, "stale")).status, 409);
  preview = await request(path + "/preview", "POST", body);
  const first = await request(path + "/transition", "POST", { ...body, fingerprint: preview.body.fingerprint }, "post-once");
  const second = await request(path + "/transition", "POST", { ...body, fingerprint: preview.body.fingerprint }, "post-once");
  assert.equal(first.status, 200); assert.deepEqual(first, second); assert.equal(stock(), 14);
  for (const [suffix, method] of [["", "POST"], ["/old", "PUT"], ["/old", "DELETE"], ["/preview", "POST"]]) assert.equal((await request("/api/automations" + suffix, method, {})).status, 410);
  assert.equal((await request("/api/notification-rules", "POST", { name: "Bypass", formId: tables.stock, trigger: "updated", enabled: true, actions: [{ type: "create", formId: tables.inbound }] })).status, 410);
  assert.equal((await request("/api/warehouse/setup", "POST", {}, null, { Authorization: "Bearer fake" })).status, 403);
  assert.equal((await request("/api/warehouse/setup", "POST", {}, null, { Origin: "https://example.com" })).status, 403);
});

test("low-stock notifications fire on threshold crossings and full Agent mode follows all workflow state guards", t => {
  const { store, create, advance, stock, product } = setup(t);
  const outgoing = create("outbound", 6, true); advance(outgoing.record.id, "approve"); advance(outgoing.record.id, "post");
  assert.equal(stock(), 4); assert.equal(store.automation.notifications().length, 1);
  const ops = createAgentOperations(store), token = ops.createToken({ name: "Full", mode: "full" }), actor = { ...token, type: "token" };
  const result = ops.run("advance_inventory_request", { recordId: outgoing.record.id, version: store.getRecord(outgoing.record.id).version, action: "reverse", actor: "Warehouse", note: "Return" }, actor, "reverse");
  assert.equal(result.status, "applied"); assert.equal(stock(), 10);
  assert.throws(() => ops.run("update_record", { recordId: product.id, schemaVersion: 1, version: store.getRecord(product.id).version, values: { currentQuantity: 1000 } }, actor, "bypass"), /workflow/);
  assert.throws(() => ops.run("advance_inventory_request", { recordId: outgoing.record.id, version: store.getRecord(outgoing.record.id).version, action: "force", actor: "Warehouse" }, actor, "invalid"), /Invalid action/);
});

test("concurrent approved requests cannot spend the same stock and malformed stock inputs are validation errors", t => {
  const { create, advance, stock, wh, product, warehouse } = setup(t);
  const first = create("outbound", 8, true), second = create("outbound", 8, true);
  advance(first.record.id, "approve"); advance(second.record.id, "approve"); advance(first.record.id, "post");
  assert.throws(() => advance(second.record.id, "post"), /Insufficient/); assert.equal(stock(), 2);
  assert.throws(() => wh.catalog({ role: "stock", values: { product: product.id, warehouse: warehouse.id, openingQuantity: "not-a-number" } }), error => error.status === 400);
});

test("warehouse schemas are immutable while custom form formulas remain available", t => {
  const { store, wh, tables, create, advance } = setup(t);
  for (const [role, source] of [["inbound", "totalQuantity"], ["inboundLines", "quantity"]]) {
    const form = store.getForm(tables[role]);
    assert.throws(() => store.updateForm(form.id, { ...form, fields: [...form.fields, { id: "double", name: "Double", type: "number", required: false, unique: false, formula: { expression: "q * 2", bindings: { q: { scope: "record", fieldId: source } } } }] }), /read-only/);
  }
  let doc = create("inbound", 3);
  assert.equal(doc.record.values.totalQuantity, 3);
  doc = wh.updateDocument(doc.record.id, { version: doc.record.version, values: {}, lines: [{ id: doc.lines[0].id, version: doc.lines[0].version, product: doc.lines[0].values.product, quantity: 4 }] });
  assert.equal(doc.record.values.totalQuantity, 4);
  advance(doc.record.id, "submit"); advance(doc.record.id, "approve"); advance(doc.record.id, "post");
  assert.equal(wh.document(doc.record.id).record.values.totalQuantity, 4);
});

test("Agent navigation, notification and AI-task tools use review mode and cannot escape their Space", t => {
  const { store, tables } = setup(t), ops = createAgentOperations(store);
  const token = ops.createToken({ name: "Business operations" }), actor = { ...token, type: "token" };
  const nodeAction = ops.run("create_navigation_node", { name: "Products" }, actor, "folder");
  assert.equal(store.spaces.tree().some(n => n.kind === "node" && n.name === "Products"), false);
  const node = ops.approve(nodeAction.id).result;
  assert.ok(store.spaces.tree().some(n => n.id === node.id));
  const other = store.spaces.create("Other"), foreign = store.spaces.createNode({ name: "Foreign", spaceId: other.id });
  assert.throws(() => ops.run("move_navigation_node", { nodeId: node.id, targetId: foreign.id, placement: "inside" }, actor, "move"), /same Space/);
  assert.throws(() => ops.run("delete_navigation_node", { nodeId: foreign.id }, actor, "delete"), /another Space/);
  const definition = { name: "Low", formId: tables.stock, trigger: "updated", enabled: true, actions: [{ type: "notify", message: "Low" }], condition: { fieldId: "currentQuantity", operator: "lt", value: { kind: "literal", value: 5 } } };
  const notification = ops.run("create_notification_rule", { definition }, actor, "notification");
  assert.equal(store.automation.list().length, 0); ops.approve(notification.id); assert.equal(store.automation.list().length, 1);
  const task = ops.run("create_ai_task", { definition: { name: "Normalize note", formId: tables.warehouses, outputFormId: tables.warehouses, instructions: "Return the notes", inputFields: ["notes"], outputFields: ["notes"], action: "update", condition: { fieldId: "code", operator: "eq", value: { kind: "field", scope: "source", fieldId: "code" } }, mode: "review" } }, actor, "task");
  assert.equal(store.tasks.list().length, 0); ops.approve(task.id); assert.equal(store.tasks.list().length, 1);
});

test("Agent can attach the same product images as users without reading files from other Spaces", t => {
  const { store, product } = setup(t), ops = createAgentOperations(store);
  const token = ops.createToken({ name: "Attachments" }), actor = { ...token, type: "token" };
  const file = { name: "product.png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jNxoAAAAASUVORK5CYII=" };
  const upload = ops.run("upload_attachment", { file }, actor, "image");
  assert.throws(() => store.files.info(upload.preview.result.id), /not found/);
  const saved = ops.approve(upload.id).result;
  assert.equal(ops.run("get_attachment", { attachmentId: saved.id }, actor).data, file.data);
  const edit = ops.run("save_inventory_catalog", { role: "products", recordId: product.id, version: product.version, values: { image: [saved.id] } }, actor, "attach");
  ops.approve(edit.id); assert.deepEqual(store.getRecord(product.id).values.image, [saved.id]);
  const other = store.spaces.create("Other"), foreign = ops.createToken({ name: "Other", spaceId: other.id });
  assert.throws(() => ops.run("get_attachment", { attachmentId: saved.id }, { ...foreign, type: "token" }), /another Space/);
});
