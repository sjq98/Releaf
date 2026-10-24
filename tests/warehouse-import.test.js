import test from "node:test";
import { setupAdmin } from "./helpers/http-auth.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { createStore } from "../src/store.js";
import { createApp } from "../src/server.js";
import { createAgentOperations } from "../src/agent-operations.js";
import { createStore as createOldStore } from "../future/cross-form-automation/src/store.js";

const csv = text => ({ name: "receipt.csv", data: Buffer.from(text).toString("base64") });
function setup(t, store = createStore(":memory:")) {
  t.after(() => store.close());
  const wh = store.warehouse, tables = wh.ensureTables().tables, imports = store.warehouseImports;
  const warehouse = wh.state().warehouses[0];
  const product = wh.catalog({ role: "products", values: { code: "P1", name: "Flour", unit: "kg" } });
  const values = { warehouse: warehouse.id, applicant: "Applicant", approver: "Manager" };
  const upload = text => imports.upload({ file: csv(text) });
  const args = file => ({ fileId: file.id, kind: "inbound", values });
  const execute = body => {
    const preview = imports.preview(body);
    assert.deepEqual(preview.errors, []);
    return imports.execute({ ...body, fingerprint: preview.fingerprint });
  };
  return { store, wh, tables, warehouse, product, values, imports, upload, args, execute };
}

test("first inbound posts catalog products into stock; rejected generic CRUD cannot bypass workflows", t => {
  const { store, wh, tables, values, product } = setup(t);
  let doc = wh.createDocument({ kind: "inbound", values, lines: [{ product: product.id, quantity: 7 }], submit: true });
  assert.equal(wh.state().stockItems.length, 0);
  doc = wh.transition(doc.record.id, { action: "approve", version: doc.record.version, actor: "Manager" });
  assert.equal(wh.state().stockItems.length, 0);
  wh.transition(doc.record.id, { action: "post", version: doc.record.version, actor: "Keeper" });
  assert.equal(wh.state().stockItems[0].values.currentQuantity, 7);
  assert.equal(wh.state().stockItems[0].values.product, product.id);
  assert.equal(wh.state().documentWarehouses[doc.record.id], values.warehouse);
  for (const id of Object.values(tables)) {
    const form = store.getForm(id);
    assert.throws(() => store.createRecord(id, { schemaVersion: form.version, values: {} }), /read-only/);
    assert.throws(() => store.updateForm(id, { ...form, name: "Bypass" }), /read-only/);
    const node = store.spaces.tree().find(node => node.formId === id);
    assert.throws(() => store.spaces.updateNode(node.id, { name: "Bypass" }), /read-only/);
  }
  assert.throws(() => wh.catalog({ role: "products", recordId: product.id, version: product.version, values: { unit: "g" } }), /referenced product/);
});

test("CSV and XLSX upload deduplicate files and expose bounded metadata without writing records", async t => {
  const { imports, upload, wh } = setup(t);
  const source = "商品编码,入库数量,单位\nP1,0.1,kg\nP1,0.2,kg";
  const first = await upload(source), second = await upload(source);
  assert.equal(first.id, second.id);
  assert.equal(first.sheets[0].rowCount, 2);
  const plan = imports.match({ fileId: first.id, linesOnly: true });
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.documents[0].kind, "inbound");
  assert.equal(plan.documents[0].lines[0].quantity, 0.3);
  assert.equal(wh.state().requests.length, 0);
  const book = new ExcelJS.Workbook();
  book.addWorksheet("Receipt").addRows([["Product code", "Quantity"], ["P1", 3]]);
  const xlsx = await imports.upload({ file: { name: "receipt.xlsx", data: Buffer.from(await book.xlsx.writeBuffer()).toString("base64") } });
  assert.equal(xlsx.sheets[0].name, "Receipt");
  assert.deepEqual(imports.match({ fileId: xlsx.id, linesOnly: true }).errors, []);
  await assert.rejects(imports.upload({ file: { name: "bad.exe", data: "YQ==" } }));
  await assert.rejects(imports.upload({ file: { name: "bad.xlsx", data: "YQ==" } }));
});

test("header mappings and product lookup reject ambiguity, mismatched names/units and invalid quantities", async t => {
  const { wh, imports, upload } = setup(t);
  const bad = await upload("Product code,Product name,Quantity,Unit\nMISSING,,2,kg\nP1,Salt,2,kg\nP1,Flour,2,g\nP1,Flour,-1,kg\nP1,Flour,0,kg");
  assert.deepEqual(imports.match({ fileId: bad.id, linesOnly: true }).errors.map(e => e.row), [2, 3, 4, 5, 6]);
  wh.catalog({ role: "products", values: { code: "P2", name: "Flour", unit: "kg" } });
  const ambiguous = await upload("Product,Quantity\nFlour,2");
  assert.match(imports.match({ fileId: ambiguous.id, linesOnly: true }).errors[0].message, /ambiguous/);
  const custom = await upload("SKU label,Weight\nP1,2");
  assert.ok(imports.match({ fileId: custom.id, linesOnly: true }).errors.length);
  assert.deepEqual(imports.match({ fileId: custom.id, linesOnly: true, mapping: { code: 0, quantity: 1 } }).errors, []);
  const repeated = await upload("SKU,Product code,Quantity\nP1,P1,2");
  assert.match(imports.match({ fileId: repeated.id, linesOnly: true }).errors[0].message, /Several headers/);
  assert.deepEqual(imports.match({ fileId: repeated.id, linesOnly: true, mapping: { code: 1 } }).errors, []);
  const distinct = wh.catalog({ role: "products", values: { code: "P-1", name: "Distinct SKU", unit: "kg" } });
  const hyphen = await upload("SKU,Quantity\nP-1,1");
  assert.equal(imports.match({ fileId: hyphen.id, linesOnly: true }).documents[0].lines[0].product, distinct.id);
});

test("line import exposes every detail field and request headers with bilingual column matching", async t => {
  const { imports, upload, tables, store, warehouse } = setup(t);
  const file = await upload("商品编码,入库数量,单位,明细备注,申请人,审批人,申请编号,单据备注,申请日期,仓库编码\nP1,2,kg,Keep dry,Applicant,Manager,EXT-01,Delivery note,2026-10-24,WH001");
  const plan = imports.match({ fileId: file.id, kind: "inbound", linesOnly: true });
  assert.deepEqual(plan.errors, []);
  const detail = store.getForm(tables.inboundLines);
  for (const field of detail.fields) {
    assert.ok(plan.mappingFields?.some(item => item.section === "lines" && item.fieldId === field.id && item.name === field.name), field.name);
  }
  for (const key of ["applicant", "approver", "group", "headerNotes", "applicationDate"]) {
    assert.ok(plan.mappingFields.some(item => item.key === key), key);
    assert.notEqual(plan.mapping[key], null, key);
  }
  assert.equal(plan.mapping.unit, 2);
  assert.equal(plan.documents[0].values.warehouse, warehouse.id);
  assert.equal(plan.documents[0].values.notes, "Delivery note");
  assert.equal(plan.documents[0].values.approver, "Manager");
  assert.equal(plan.documents[0].lines[0].notes, "Keep dry");
  assert.equal(plan.requestValues.notes, "Delivery note");
  assert.equal(plan.requestValues.approver, "Manager");
  assert.equal(plan.mappingFields.find(item => item.section === "lines" && item.fieldId === "status").managed, true);
  assert.equal(plan.mappingFields.find(item => item.key === "group").managed, false);
  assert.equal(plan.mappingFields.find(item => item.key === "applicant").managed, true);
});

test("outbound matching exposes its complete schema and uses actual spreadsheet headers", async t => {
  const { imports, upload, tables, store } = setup(t);
  const file = await upload("Product Code,Outbound Quantity,Unit,Line Notes,Approver,Outbound Request Number,Request Notes,Application Date,Outbound Type\nP1,3,kg,Handle carefully,Manager,EXT-OUT-01,Customer collection,2026-10-24,Sales issue");
  const plan = imports.match({ fileId: file.id, kind: "outbound", linesOnly: true });
  assert.deepEqual(plan.errors, []);
  for (const [role, section] of [["outboundLines", "lines"], ["outbound", "request"]]) {
    const actual = plan.mappingFields.filter(item => item.section === section);
    assert.deepEqual(actual.map(item => item.fieldId), store.getForm(tables[role]).fields.map(field => field.id));
    assert.ok(actual.every(item => item.formId === tables[role]));
  }
  assert.equal(plan.headers[plan.mapping.quantity], "Outbound Quantity");
  assert.equal(plan.headers[plan.mapping.unit], "Unit");
  assert.equal(plan.headers[plan.mapping.group], "Outbound Request Number");
  assert.equal(plan.requestValues.type, "Sales issue");
  assert.equal(plan.requestValues.notes, "Customer collection");
  assert.equal(plan.documents[0].lines[0].notes, "Handle carefully");
});

test("authenticated imports preserve the applicant and accept spreadsheet approvers as text", async t => {
  const { store, imports, upload, values } = setup(t);
  const { user } = store.auth.setup({ username: "importer", displayName: "Importer", password: "Test-importer-password-2026" });
  const manager = store.auth.withUser(user, () => store.auth.createUser({ username: "manager", displayName: "Receiving Manager", password: "Test-manager-password-2026", role: "user" }));
  const file = await upload("SKU,Quantity,Applicant,Approver\nP1,2,someone.else,Receiving Manager");
  const match = mapping => store.auth.withUser(user, () => imports.match({ fileId: file.id, kind: "inbound", linesOnly: true, values, ...(mapping ? { mapping } : {}) }));
  const plan = match();
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.documents[0].values.applicant, user.username);
  assert.equal(plan.requestValues.approver, "Receiving Manager");
  assert.equal(Object.hasOwn(plan.requestValues, "applicant"), false);
  assert.ok(plan.warnings.some(item => item.message?.includes("signed-in account")));
  for (const key of ["request_number", "request_status", "line_status"]) {
    assert.throws(() => match({ [key]: 2 }), /managed stock and status/);
  }
  store.auth.withUser(user, () => store.auth.updateUser(manager.id, { active: false }));
  assert.deepEqual(match().errors, []);
  assert.equal(match().requestValues.approver, "Receiving Manager");
  const unregistered = await upload("SKU,Quantity,Approver\nP1,2,Warehouse supervisor\nP1,3,Warehouse supervisor\nP1,4,Warehouse supervisor");
  const imported = store.auth.withUser(user, () => imports.match({ fileId: unregistered.id, kind: "inbound", linesOnly: true, values }));
  assert.deepEqual(imported.errors, []);
  assert.equal(imported.requestValues.approver, "Warehouse supervisor");
  assert.equal(imported.documents[0].lines[0].quantity, 9);
});

test("custom numeric and reference columns survive matching and saving a request", async t => {
  const { store, wh, imports, upload, tables, values, warehouse } = setup(t);
  const { user } = store.auth.setup({ username: "custom.admin", password: "Test-custom-password-2026" });
  store.auth.withUser(user, () => {
    for (const [role, extra] of [
      ["inboundLines", [
        { id: "weight", name: "Weight", type: "number", required: false, unique: false },
        { id: "location", name: "Storage Location", type: "reference", required: false, unique: false, reference: { formId: tables.warehouses, fieldId: "code" } },
      ]],
      ["inbound", [{ id: "referenceWarehouse", name: "Reference Warehouse", type: "reference", required: false, unique: false, reference: { formId: tables.warehouses, fieldId: "code" } }]],
    ]) {
      const form = store.getForm(tables[role]);
      store.updateForm(form.id, { ...form, fields: [...form.fields, ...extra] });
    }
    const form = store.getForm(tables.inbound);
    store.updateForm(form.id, { ...form, fields: form.fields.map(field => field.id === "notes" ? { ...field, name: "Delivery Memo" } : field) });
  });
  const file = await upload("SKU,Quantity,Weight,Storage Location,Reference Warehouse,Delivery Memo\nP1,2,1.25,WH001,WH001,Dock 3");
  const plan = store.auth.withUser(user, () => imports.match({ fileId: file.id, kind: "inbound", linesOnly: true, values }));
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.documents[0].lines[0].weight, 1.25);
  assert.equal(plan.documents[0].lines[0].location, warehouse.id);
  assert.equal(plan.requestValues.referenceWarehouse, warehouse.id);
  assert.equal(plan.requestValues.notes, "Dock 3");
  assert.deepEqual(plan.mappingFields.find(field => field.key === "line_location").reference, { formId: tables.warehouses, fieldId: "code" });
  const result = store.auth.withUser(user, () => wh.createDocument({ kind: "inbound", values: { ...values, ...plan.requestValues, approver: user.username }, lines: plan.documents[0].lines }));
  assert.equal(result.lines[0].values.weight, 1.25);
  assert.equal(result.lines[0].values.location, warehouse.id);
  assert.equal(result.record.values.notes, "Dock 3");
  assert.equal(result.record.values.referenceWarehouse, warehouse.id);
});

test("one request imports a consistent warehouse and refuses conflicting header values", async t => {
  const { wh, imports, upload, values, warehouse } = setup(t);
  const selected = wh.catalog({ role: "warehouses", values: { code: "W2", name: "Selected warehouse" } });
  const file = await upload("SKU,Quantity,Warehouse code,Request Notes\nP1,2,WH001,Dock 1\nP1,3,WH001,Dock 1");
  const plan = imports.match({ fileId: file.id, kind: "inbound", linesOnly: true, values: { ...values, warehouse: selected.id } });
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.requestValues.warehouse, warehouse.id);
  assert.equal(plan.documents[0].lines[0].quantity, 5);
  const conflicting = await upload("SKU,Quantity,Warehouse code,Request Notes\nP1,2,WH001,Dock 1\nP1,3,W2,Dock 1");
  assert.match(imports.match({ fileId: conflicting.id, kind: "inbound", linesOnly: true }).errors[0].message, /same value/);
  const notes = await upload("SKU,Quantity,Request Notes\nP1,2,Dock 1\nP1,3,Dock 2");
  assert.match(imports.match({ fileId: notes.id, kind: "inbound", linesOnly: true }).errors[0].message, /same value/);
  const requests = await upload("SKU,Quantity,Request number\nP1,2,R1\nP1,3,R2");
  assert.match(imports.match({ fileId: requests.id, kind: "inbound", linesOnly: true }).errors[0].message, /one request at a time/);
  assert.match(imports.match({ fileId: file.id, kind: "inbound", values: { ...values, warehouse: selected.id } }).errors[0].message, /differs from the selected warehouse/);
});

test("batch preview is unwritten; submit creates approval requests and equivalent mappings cannot duplicate them", async t => {
  const { store, imports, upload, args, tables, wh } = setup(t);
  const file = await upload("SKU,Quantity\nP1,4");
  const body = args(file), before = store.automation.fingerprint("default");
  const preview = imports.preview(body);
  assert.deepEqual(preview.errors, []); assert.equal(store.automation.fingerprint("default"), before);
  assert.equal(store.listRecords(tables.inbound).length, 0);
  const result = imports.execute({ ...body, fingerprint: preview.fingerprint });
  assert.equal(result.documents[0].status, "Pending approval"); assert.equal(wh.state().stockItems.length, 0);
  assert.equal(imports.execute({ ...body, mapping: preview.mapping, fingerprint: "old" }).alreadySaved, true);
  assert.equal(store.listRecords(tables.inbound).length, 1);
});

test("explicit batch posting uses assigned approver and atomically rolls back every document on stock failure", async t => {
  const { imports, upload, values, wh, execute } = setup(t);
  const file = await upload("SKU,Quantity,Direction,Request number\nP1,4,inbound,IN\nP1,5,outbound,OUT");
  const body = { fileId: file.id, values, stage: "post", approvalActor: "Manager" };
  const preview = imports.preview(body);
  assert.match(preview.errors[0].message, /Insufficient/);
  assert.equal(wh.state().requests.length, 0); assert.equal(wh.state().stockItems.length, 0);
  assert.throws(() => imports.execute({ ...body, fingerprint: preview.fingerprint }), /Insufficient/);
  assert.equal(wh.state().movements.length, 0); assert.equal(wh.state().requests.length, 0);
  const valid = await upload("SKU,Quantity,Direction,Request number\nP1,4,inbound,IN\nP1,3,outbound,OUT");
  const good = { ...body, fileId: valid.id };
  assert.match(imports.preview({ ...good, approvalActor: "Other" }).errors[0].message, /assigned approver/);
  assert.match(imports.preview({ ...good, approvalActor: "" }).errors[0].message, /assigned approver/);
  const result = execute(good);
  assert.equal(result.documents.length, 2);
  assert.ok(result.documents.every(d => d.status === "Posted"));
  assert.equal(wh.state().stockItems[0].values.currentQuantity, 1);
});

test("batch groups warehouses and external request numbers and refuses stale data previews", async t => {
  const { wh, imports, upload, product, execute } = setup(t);
  wh.catalog({ role: "warehouses", values: { code: "W2", name: "Secondary" } });
  const file = await upload("SKU,入库数量,仓库编码,申请人,审批人,外部单号\nP1,1,WH001,A,Manager,R1\nP1,2,W2,A,Manager,R2\nP1,3,W2,A,Manager,R3");
  const body = { fileId: file.id, stage: "post", approvalActor: "Manager" };
  const preview = imports.preview(body); assert.equal(preview.documents.length, 3);
  wh.catalog({ role: "products", recordId: product.id, version: product.version, values: { notes: "Updated" } });
  assert.throws(() => imports.execute({ ...body, fingerprint: preview.fingerprint }), /changed/);
  execute(body);
  assert.deepEqual(wh.state().stockItems.map(r => r.values.currentQuantity).sort(), [1, 5]);
});

test("Agent uploads are scoped; review/full imports share UI posting and read-only guards", async t => {
  const { store, wh, args } = setup(t), ops = createAgentOperations(store);
  const token = ops.createToken({ name: "Importer" }), actor = { ...token, type: "token" };
  const file = await ops.run("upload_inventory_file", { file: csv("SKU,Quantity\nP1,3") }, actor);
  const body = { ...args(file), stage: "post", approvalActor: "Manager" };
  const preview = ops.run("preview_inventory_import", body, actor);
  const action = ops.run("execute_inventory_import", { ...body, fingerprint: preview.fingerprint }, actor, "batch");
  assert.equal(action.status, "pending"); assert.equal(wh.state().stockItems.length, 0);
  ops.approve(action.id); assert.equal(wh.state().stockItems[0].values.currentQuantity, 3);
  assert.equal(ops.approve(action.id).status, "applied");
  const other = store.spaces.create("Other"), limited = { ...ops.createToken({ name: "Limited", spaceId: other.id }), type: "token" };
  assert.throws(() => ops.run("get_inventory_file", { fileId: file.id }, limited), { status: 403 });
  assert.throws(() => ops.run("execute_inventory_import", { ...body, fingerprint: preview.fingerprint }, limited, "escape"), { status: 403 });
  ops.updateToken(token.id, "full");
  const second = await ops.run("upload_inventory_file", { file: csv("SKU,Quantity\nP1,2") }, actor);
  const secondBody = { ...args(second), stage: "post", approvalActor: "Manager" };
  const next = ops.run("preview_inventory_import", secondBody, actor);
  assert.equal(ops.run("execute_inventory_import", { ...secondBody, fingerprint: next.fingerprint }, actor, "full").status, "applied");
  assert.equal(wh.state().stockItems[0].values.currentQuantity, 5);
});

test("HTTP file transport awaits upload and authenticates before accepting data", async t => {
  const app = createApp({ database: ":memory:", env: {} });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  const { store } = setup(t, app.store), ops = createAgentOperations(store);
  const { user } = await setupAdmin(`http://127.0.0.1:${app.server.address().port}`);
  const token = store.auth.withUser(user, () => ops.createToken({ name: "Upload" }));
  const request = (path, body, authenticated = true) => fetch(`http://127.0.0.1:${app.server.address().port}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...(authenticated ? { Authorization: `Bearer ${token.token}` } : {}) }, body: JSON.stringify(body) });
  const input = { file: csv("SKU,Quantity\nP1,2") };
  assert.equal((await request("/api/agent/files", input, false)).status, 401);
  const response = await request("/api/agent/files", input); assert.equal(response.status, 201);
  const file = await response.json(); assert.ok(file.id); assert.equal(file.sheets[0].rowCount, 1);
  const generic = await request("/api/agent/operations", { operation: "upload_inventory_file", args: input });
  assert.equal(generic.status, 200); assert.equal((await generic.json()).id, file.id);
  assert.equal((await request("/api/warehouse/files", input)).status, 403);
});

test("the documented 100-line batch limit also works through Agent full access", async t => {
  const { wh, store, upload, args } = setup(t);
  for (let i = 2; i <= 100; i++) wh.catalog({ role: "products", values: { code: `P${i}`, name: `Product ${i}`, unit: "kg" } });
  const file = await upload("SKU,Quantity\n" + Array.from({ length: 100 }, (_, i) => `P${i + 1},1`).join("\n"));
  const ops = createAgentOperations(store), actor = { ...ops.createToken({ name: "Full batch", mode: "full" }), type: "token" };
  const body = { ...args(file), stage: "post", approvalActor: "Manager" };
  const preview = ops.run("preview_inventory_import", body, actor);
  assert.deepEqual(preview.errors, []);
  const result = ops.run("execute_inventory_import", { ...body, fingerprint: preview.fingerprint }, actor, "hundred");
  assert.equal(result.status, "applied"); assert.equal(wh.state().stockItems.length, 100);
});

test("chat receives verified attachment IDs and can propose the same batch import for review", async t => {
  let fileId, batch, round = 0, modelInput;
  const assistantFetch = async (url, options) => {
    if (url.endsWith("/models")) return Response.json({ data: [{ id: "test-model" }] });
    const body = JSON.parse(options.body); modelInput = body;
    const call = (name, args) => Response.json({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: `call-${++round}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
    if (!round) return call("preview_inventory_import", batch);
    const preview = JSON.parse(body.messages.findLast(m => m.role === "tool").content);
    return call("execute_inventory_import", { ...batch, fingerprint: preview.fingerprint });
  };
  const app = createApp({ database: ":memory:", env: {}, assistantFetch });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  const { store, upload, args, wh } = setup(t, app.store);
  const { cookie, user } = await setupAdmin(`http://127.0.0.1:${app.server.address().port}`);
  const file = await upload("SKU,Quantity\nP1,8"); fileId = file.id;
  batch = { ...args(file), values: { ...args(file).values, approver: user.username } };
  const request = async (path, method, body) => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, { method, headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  assert.equal((await request("/api/assistant/config", "PUT", { providerName: "Test", baseUrl: "https://provider.example/v1", apiKey: "private-test", model: "test-model" })).status, 200);
  const session = store.agent.createSession(user.id);
  const result = await request(`/api/assistant/sessions/${session.id}/messages`, "POST", { text: "Import these as inbound requests", spaceId: "default", fileIds: [fileId] });
  assert.equal(result.status, 200);
  const pending = store.agent.listActions({ pending: true, userId: user.id });
  assert.equal(pending.length, 1); assert.equal(pending[0].userId, user.id);
  assert.equal(wh.state().requests.length, 0);
  assert.ok(modelInput.messages.some(m => m.role === "user" && m.content.includes(fileId)));
  assert.ok(modelInput.messages.every(m => !Object.hasOwn(m, "displayContent")));
  assert.ok(JSON.stringify(result.data).includes("receipt.csv"));
  const other = store.spaces.create("Unrelated");
  assert.equal((await request(`/api/assistant/sessions/${session.id}/messages`, "POST", { text: "Import", spaceId: other.id, fileIds: [fileId] })).status, 403);
});

test("legacy warehouse migration preserves stock identities, posted movements and references on reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "releaf-products-")), filename = join(directory, "db.sqlite");
  let store;
  try {
    store = createOldStore(filename);
    const tables = store.warehouse.ensureTables().tables, warehouse = store.listRecords(tables.warehouses)[0];
    const stock = store.createRecord(tables.stock, { schemaVersion: 1, values: { code: "P1", name: "Flour", unit: "kg", warehouse: warehouse.id, openingQuantity: 10 } }).record;
    let doc = store.warehouse.createDocument({ kind: "inbound", values: { warehouse: warehouse.id, applicant: "A", approver: "Manager" }, lines: [{ product: stock.id, quantity: 2 }], submit: true });
    doc = store.warehouse.transition(doc.record.id, { action: "approve", actor: "Manager", version: doc.record.version });
    doc = store.warehouse.transition(doc.record.id, { action: "post", actor: "Keeper", version: doc.record.version });
    const movements = store.warehouse.state().movements;
    store.close(); store = null;
    store = createStore(filename);
    const product = store.warehouse.state().products[0];
    assert.ok(product); assert.equal(product.values.code, "P1");
    assert.equal(store.getRecord(stock.id).values.currentQuantity, 12);
    assert.equal(store.getRecord(stock.id).values.product, product.id);
    assert.equal(store.warehouse.document(doc.record.id).lines[0].values.product, product.id);
    assert.deepEqual(store.warehouse.state().movements.map(({ documentNumber, ...row }) => row), movements.map(row => ({ ...row })));
    assert.equal(store.getForm(tables.inboundLines).fields.find(f => f.id === "product").reference.formId, product.formId);
    store.close(); store = null;
    store = createStore(filename);
    assert.equal(store.warehouse.state().products.length, 1);
    assert.equal(store.warehouse.state().products[0].id, product.id);
  } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
});
