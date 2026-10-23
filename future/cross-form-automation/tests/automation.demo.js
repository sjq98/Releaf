import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createAgentOperations, queryRecords } from "../src/agent-operations.js";
import { evaluateFormula } from "../src/expressions.js";
import { createApp } from "../src/server.js";

const field = (id, type = "text", extra = {}) => ({ id, name: id, type, required: false, unique: false, options: [], ...extra });
const literal = (value) => ({ kind: "literal", value });
const source = (fieldId, scope = "source") => ({ kind: "field", scope, fieldId });
const condition = (fieldId, value, operator = "eq") => ({ fieldId, operator, value: typeof value === "object" && value?.kind ? value : literal(value) });
const create = (store, form, values) => store.createRecord(form.id, { schemaVersion: store.getForm(form.id).version, values }).record;
const update = (store, form, record, values) => store.updateRecord(record.id, { schemaVersion: store.getForm(form.id).version, version: store.getRecord(record.id).version, values });
const rule = (store, form, actions, extra = {}) => store.automation.save({ name: "Test rule", formId: form.id, enabled: true, trigger: "created", condition: null, watchedFields: [], actions, ...extra });
const action = (target, extra = {}) => ({ type: "update", formId: target.id, selection: "first", noMatch: "error", assignments: {}, ...extra });
const formula = (expression, bindings) => ({ kind: "formula", formula: { expression, bindings } });
const fixture = (t) => {
  const store = createStore(":memory:");
  t.after(() => store.close());
  return store;
};

test("rules remain owned by their source form and execute only for the saved trigger", (t) => {
  const store = fixture(t);
  const a = store.createForm({ name: "Form A", fields: [field("qty", "number")] });
  const b = store.createForm({ name: "Form B", fields: [field("qty", "number")] });
  const saved = ["created", "updated", "deleted"].map((trigger) => rule(store, a, [{ type: "notify", message: trigger }], { name: trigger, trigger }));
  const other = rule(store, b, [{ type: "notify", message: "Other" }]);
  assert.deepEqual(new Set(store.automation.list("default", a.id).map((item) => item.id)), new Set(saved.map((item) => item.id)));
  assert.deepEqual(store.automation.list("default", b.id).map((item) => item.id), [other.id]);
  const row = create(store, a, { qty: 1 });
  update(store, a, row, { qty: 2 });
  store.deleteRecord(row.id, { version: store.getRecord(row.id).version });
  assert.deepEqual(store.automation.runs("default", a.id).map((run) => run.event.kind), ["deleted", "updated", "created"]);
  assert.equal(store.automation.runs("default", b.id).length, 0);
  const edited = store.automation.save({ ...saved[1], name: "Renamed update", enabled: false }, saved[1].id);
  assert.equal(edited.formId, a.id);
  assert.equal(edited.trigger, "updated");
  assert.equal(store.automation.list("default", a.id).length, 3);
});

test("form run history filters before its limit and retains runs after rule deletion", (t) => {
  const store = fixture(t);
  const a = store.createForm({ name: "Quiet form", fields: [field("code")] });
  const b = store.createForm({ name: "Busy form", fields: [field("code")] });
  const first = rule(store, a, [{ type: "notify", message: "A" }]);
  rule(store, b, [{ type: "notify", message: "B" }]);
  create(store, a, { code: "A" });
  for (let index = 0; index < 205; index++) create(store, b, { code: String(index) });
  assert.equal(store.automation.runs().length, 200);
  assert.equal(store.automation.runs("default", b.id).length, 200);
  store.automation.remove(first.id, first.version);
  const history = store.automation.runs("default", a.id);
  assert.equal(history.length, 1);
  assert.equal(history[0].ruleId, first.id);
  assert.equal(history[0].event.formId, a.id);
  const other = store.spaces.create("Another Space");
  assert.throws(() => store.automation.runs(other.id, a.id), /same Space/);
});

test("HTTP automation lists and history support independent source-form scopes", async (t) => {
  const app = createApp({ database: ":memory:", env: {} });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise((resolve) => app.server.close(resolve)); app.store.close(); });
  const { store } = app, base = `http://127.0.0.1:${app.server.address().port}`;
  const a = store.createForm({ name: "A", fields: [field("code")] });
  const b = store.createForm({ name: "B", fields: [field("code")] });
  for (const form of [a, b]) { rule(store, form, [{ type: "notify", message: form.name }]); create(store, form, { code: form.name }); }
  for (const form of [a, b]) {
    const response = await fetch(`${base}/api/automations?spaceId=default&formId=${form.id}`);
    assert.equal(response.status, 200);
    const rules = await response.json();
    assert.equal(rules.length, 1);
    assert.equal(rules[0].formId, form.id);
    const runsResponse = await fetch(`${base}/api/automation-runs?spaceId=default&formId=${form.id}`);
    assert.equal(runsResponse.status, 200);
    const runs = await runsResponse.json();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].event.formId, form.id);
  }
  assert.equal((await (await fetch(`${base}/api/automation-runs?spaceId=default`)).json()).length, 2);
});

test("navigation moves preserve form identity and reject cycles, nonempty deletion and cross-Space parents", (t) => {
  const store = fixture(t), form = store.listForms()[0];
  const node = store.spaces.createNode({ name: "Warehouse" });
  const child = store.spaces.createNode({ name: "Section", parentId: node.id });
  store.spaces.updateNode(`form_${form.id}`, { parentId: child.id, name: "Sales", position: 2 });
  assert.equal(store.getForm(form.id).name, "Sales");
  assert.equal(store.getForm(form.id).moduleId, "orders");
  assert.throws(() => store.spaces.updateNode(node.id, { parentId: child.id }), /descendant/);
  assert.throws(() => store.spaces.deleteNode(node.id), /children/);
  const other = store.spaces.create("Other");
  assert.throws(() => store.spaces.createNode({ name: "Bad", spaceId: other.id, parentId: child.id }), /same Space/);
  const target = store.createForm({ name: "Other form", spaceId: other.id, fields: [field("code", "text", { unique: true })] });
  assert.throws(() => store.createForm({ name: "Bad ref", fields: [field("ref", "reference", { reference: { formId: target.id, fieldId: "code" } })] }), /same Space/);
});

test("numeric formulas use stable IDs, decimal arithmetic, dependency order and readonly calculated values", (t) => {
  const store = fixture(t);
  let form = store.createForm({ name: "Lines", fields: [
    field("qty", "number"), field("price", "number"),
    field("total", "number", { formula: { expression: "q * p", bindings: { q: { scope: "record", fieldId: "qty" }, p: { scope: "record", fieldId: "price" } } } }),
    field("taxed", "number", { formula: { expression: "t * 1.1", bindings: { t: { scope: "record", fieldId: "total" } } } }),
  ] });
  const row = create(store, form, { qty: 3, price: 0.1 });
  assert.equal(row.values.total, 0.3);
  assert.equal(row.values.taxed, 0.33);
  assert.throws(() => update(store, form, row, { total: 99 }), /highlighted/);
  update(store, form, row, { qty: 4 });
  assert.equal(store.getRecord(row.id).values.total, 0.4);
  form = store.updateForm(form.id, { ...form, fields: form.fields.map((f) => f.id === "qty" ? { ...f, name: "Units" } : f) });
  assert.equal(store.getRecord(row.id).values.total, 0.4);
  assert.throws(() => store.updateForm(form.id, { ...form, fields: form.fields.filter((f) => f.id !== "qty") }), /numeric formula input/);
  const cyclic = form.fields.map((f) => f.id === "qty" ? { ...f, formula: { expression: "x", bindings: { x: { scope: "record", fieldId: "taxed" } } } } : f);
  assert.throws(() => store.updateForm(form.id, { ...form, fields: cyclic }), /Circular/);
});

test("same-form aggregate formulas recalculate remaining rows on create, update and delete", (t) => {
  const store = fixture(t);
  const form = store.createForm({ name: "Totals", fields: [field("qty", "number"), field("sum", "number", { formula: { expression: "SUM(q)", bindings: { q: { scope: "aggregate", fieldId: "qty" } } } })] });
  const a = create(store, form, { qty: 2 }), b = create(store, form, { qty: 3 });
  assert.equal(store.getRecord(a.id).values.sum, 5);
  assert.equal(store.getRecord(b.id).values.sum, 5);
  update(store, form, a, { qty: 7 });
  assert.equal(store.getRecord(b.id).values.sum, 10);
  store.deleteRecord(b.id, { version: store.getRecord(b.id).version });
  assert.equal(store.getRecord(a.id).values.sum, 7);
});

test("formulas reject arbitrary JavaScript, invalid numeric operands and division by zero", () => {
  for (const expression of ["globalThis.process.exit()", "a.constructor", "[1, 2]", "Math.random()", "a = 1"]) {
    assert.throws(() => evaluateFormula({ expression, bindings: { a: {} } }, () => 2));
  }
  assert.throws(() => evaluateFormula({ expression: "a / 0", bindings: { a: {} } }, () => 1), /zero/);
  assert.throws(() => evaluateFormula({ expression: "a + 1", bindings: { a: {} } }, () => "1"), /numeric/);
  assert.equal(evaluateFormula({ expression: "ROUND(1234, -2)", bindings: {} }, () => null), 1200);
  assert.equal(evaluateFormula({ expression: "IF(false, 1 / 0, COALESCE(null, 3))", bindings: {} }, () => null), 3);
});

function inventoryFixture(t) {
  const store = fixture(t);
  const receipts = store.createForm({ name: "Receipts", fields: [field("material"), field("qty", "number")] });
  const stock = store.createForm({ name: "Raw stock", fields: [field("material"), field("qty", "number"), field("note"), field("flag", "checkbox")] });
  const receive = rule(store, receipts, [action(stock, {
    condition: condition("material", source("material")),
    assignments: { qty: formula("COALESCE(t, 0) + s", { t: { scope: "target", fieldId: "qty" }, s: { scope: "source", fieldId: "qty" } }) },
  })]);
  return { store, receipts, stock, receive };
}

test("cross-form first match is newest, target arithmetic uses current values and writes are atomic/idempotent", (t) => {
  const { store, receipts, stock } = inventoryFixture(t);
  const old = create(store, stock, { material: "Flour", qty: 1 }), recent = create(store, stock, { material: "Flour", qty: 5 });
  const input = { material: "Flour", qty: 0.1 };
  const request = () => store.automation.once("receive-1", input, () => create(store, receipts, input));
  const receipt = request();
  assert.equal(request().id, receipt.id);
  assert.equal(store.listRecords(receipts.id).length, 1);
  assert.equal(store.getRecord(old.id).values.qty, 1);
  assert.equal(store.getRecord(recent.id).values.qty, 5.1);
  assert.equal(store.automation.runs().length, 1);
  assert.throws(() => store.automation.once("receive-1", { ...input, qty: 9 }, request), /already used/);
});

test("nested OR/AND/NOT filters support all matches, null clearing and false/zero without losing kept fields", (t) => {
  const { store, receipts, stock, receive } = inventoryFixture(t);
  const a = create(store, stock, { material: "Flour", qty: 1, note: "Keep", flag: true });
  const b = create(store, stock, { material: "Flour", qty: 2, note: "Keep", flag: true });
  const c = create(store, stock, { material: "Salt", qty: 3, note: "Keep", flag: true });
  store.automation.save({ ...receive, actions: [action(stock, {
    selection: "all", condition: { op: "AND", conditions: [
      { op: "OR", conditions: [condition("material", "Flour"), condition("material", "Salt")] },
      { op: "NOT", conditions: [condition("qty", 3)] },
    ] },
    assignments: { qty: literal(0), flag: literal(false), note: { kind: "empty" } },
  })] }, receive.id);
  create(store, receipts, { material: "Batch" });
  for (const row of [a, b]) assert.deepEqual(store.getRecord(row.id).values, { material: "Flour", qty: 0, flag: false, note: null });
  assert.equal(store.getRecord(c.id).values.qty, 3);
  const results = queryRecords(store, { formId: stock.id, condition: { op: "OR", conditions: [condition("qty", 0), condition("material", "Salt")] } });
  assert.equal(results.total, 3);
});

test("failed actions roll back all preceding writes and retain a retryable source operation in Error Center", (t) => {
  const { store, receipts, stock } = inventoryFixture(t);
  assert.throws(() => create(store, receipts, { material: "Missing", qty: 3 }), /no records matched/);
  assert.equal(store.listRecords(receipts.id).length, 0);
  assert.equal(store.listChanges(receipts.id).length, 0);
  assert.equal(store.automation.runs().length, 0);
  const error = store.automation.errors()[0];
  assert.equal(error.context.operation, "create_record");
  assert.equal(error.context.formId, receipts.id);
  assert.equal(error.context.body.values.qty, 3);
  assert.equal(error.context.step, 1);
  create(store, stock, { material: "Missing", qty: 1 });
  create(store, receipts, error.context.body.values);
  assert.equal(store.listRecords(stock.id)[0].values.qty, 4);
  store.automation.resolveError(error.id, "Resolved");
  assert.equal(store.automation.errors()[0].status, "Resolved");
});

test("watched update fields and delete triggers use source before snapshots; no-match skip is reported", (t) => {
  const store = fixture(t), sourceForm = store.createForm({ name: "Source", fields: [field("name"), field("qty", "number")] });
  const target = store.createForm({ name: "Events", fields: [field("name"), field("qty", "number")] });
  rule(store, sourceForm, [{ type: "create", formId: target.id, assignments: { name: source("name"), qty: source("qty") } }], { trigger: "updated", watchedFields: ["qty"] });
  const row = create(store, sourceForm, { name: "A", qty: 1 });
  update(store, sourceForm, row, { name: "B" });
  assert.equal(store.listRecords(target.id).length, 0);
  update(store, sourceForm, row, { qty: 2 });
  assert.equal(store.listRecords(target.id)[0].values.name, "B");
  rule(store, sourceForm, [{ type: "create", formId: target.id, assignments: { name: source("name", "before") } },
    action(target, { condition: condition("name", "Missing"), noMatch: "skip" })], { name: "Deletion", trigger: "deleted" });
  store.deleteRecord(row.id, { version: store.getRecord(row.id).version });
  assert.equal(store.listRecords(target.id).length, 2);
  assert.equal(store.automation.runs()[0].steps[1].skipped, true);
});

test("circular automation fails atomically, previews leave no runs or errors, and rule dependencies protect fields", (t) => {
  const store = fixture(t), a = store.createForm({ name: "A", fields: [field("qty", "number")] }), b = store.createForm({ name: "B", fields: [field("qty", "number")] });
  const ra = create(store, a, { qty: 0 }), rb = create(store, b, { qty: 0 });
  const increment = (form) => action(form, { matchAll: true, assignments: { qty: formula("q + 1", { q: { scope: "target", fieldId: "qty" } }) } });
  rule(store, a, [increment(b)], { trigger: "updated" });
  rule(store, b, [increment(a)], { trigger: "updated" });
  assert.throws(() => store.preview(() => update(store, a, ra, { qty: 1 })), /Circular/);
  assert.equal(store.automation.errors().length, 0);
  assert.equal(store.getRecord(ra.id).values.qty, 0);
  assert.equal(store.getRecord(rb.id).values.qty, 0);
  assert.throws(() => update(store, a, ra, { qty: 1 }), /Circular/);
  assert.equal(store.automation.runs().length, 0);
  assert.throws(() => store.updateForm(a.id, { ...a, fields: [field("other")] }), /depends/);
});

test("lookup requires explicit first/unique selection, filtered aggregates use all matching records", (t) => {
  const store = fixture(t), input = store.createForm({ name: "Input", fields: [field("name")] });
  const values = store.createForm({ name: "Values", fields: [field("name"), field("qty", "number")] });
  const output = store.createForm({ name: "Output", fields: [field("qty", "number")] });
  create(store, values, { name: "A", qty: 2 }); create(store, values, { name: "A", qty: 3 }); create(store, values, { name: "B", qty: 100 });
  const aggregate = { kind: "field", scope: "aggregate", formId: values.id, fieldId: "qty", aggregate: "SUM", condition: condition("name", source("name")) };
  const config = rule(store, input, [{ type: "create", formId: output.id, assignments: { qty: aggregate } }]);
  create(store, input, { name: "A" });
  assert.equal(store.listRecords(output.id)[0].values.qty, 5);
  store.automation.save({ ...config, actions: [{ type: "create", formId: output.id, assignments: { qty: { ...aggregate, scope: "lookup", aggregate: undefined, selection: "unique" } } }] }, config.id);
  assert.throws(() => create(store, input, { name: "A" }), /exactly one/);
});

test("Agent approval includes cascades and becomes stale when related data changes; Space tokens cannot escape", (t) => {
  const { store, receipts, stock } = inventoryFixture(t);
  const row = create(store, stock, { material: "Flour", qty: 10 });
  const ops = createAgentOperations(store), actor = { id: "chat", name: "Chat", type: "chat" };
  const args = { formId: receipts.id, schemaVersion: 1, values: { material: "Flour", qty: 3 } };
  const pending = ops.run("create_record", args, actor, "preview");
  assert.equal(pending.preview.changes.length, 2);
  assert.equal(store.listRecords(receipts.id).length, 0);
  assert.equal(store.getRecord(row.id).values.qty, 10);
  update(store, stock, row, { qty: 20 });
  assert.throws(() => ops.approve(pending.id), /changed since preview/);
  const next = ops.run("create_record", args, actor, "next");
  ops.approve(next.id);
  assert.equal(store.getRecord(row.id).values.qty, 23);
  const other = store.spaces.create("Private"), privateForm = store.createForm({ name: "Private", spaceId: other.id });
  const token = ops.createToken({ name: "External", spaceId: "default" });
  const tokenActor = { ...token, type: "token" };
  assert.throws(() => ops.run("get_form", { formId: privateForm.id }, tokenActor), /another Space/);
  assert.throws(() => ops.run("list_automations", { formId: receipts.id, spaceId: other.id }, tokenActor), /another Space/);
  assert.equal(ops.run("list_forms", {}, tokenActor).some((form) => form.id === privateForm.id), false);
});

test("notifications fire when a threshold is crossed, not on every edit while below it", (t) => {
  const store = fixture(t), form = store.createForm({ name: "Stock", fields: [field("qty", "number"), field("note")] });
  rule(store, form, [{ type: "notify", message: "Low stock" }], { trigger: "updated", condition: condition("qty", 5, "lt") });
  const row = create(store, form, { qty: 10 });
  update(store, form, row, { qty: 3 });
  update(store, form, row, { note: "Still low" });
  assert.equal(store.automation.notifications().length, 1);
  update(store, form, row, { qty: 8 });
  update(store, form, row, { qty: 2 });
  assert.equal(store.automation.notifications().length, 2);
});

function taskFixture(t, mode = "review") {
  const store = fixture(t), input = store.createForm({ name: "Documents", fields: [field("text"), field("file", "attachment")] });
  const output = store.createForm({ name: "Extracted", fields: [field("code", "text", { required: true }), field("qty", "number")] });
  const row = create(store, input, { text: "Invoice A: 3 units" });
  const task = store.tasks.save({ name: "Extract items", formId: input.id, inputFields: ["text", "file"], instructions: "Extract the code and quantity.",
    outputFormId: output.id, outputFields: ["code", "qty"], action: "create", mode });
  return { store, input, output, row, task };
}

test("AI jobs run outside transactions, keep review results unwritten and apply the full cascade exactly once", async (t) => {
  const { store, input, output, row, task } = taskFixture(t);
  const audit = store.createForm({ name: "Audit", fields: [field("code")] });
  rule(store, output, [{ type: "create", formId: audit.id, assignments: { code: source("code") } }]);
  let called = false;
  store.tasks.configure({ taskAI: async () => { called = true; create(store, input, { text: "Concurrent edit is allowed" }); return { items: [{ code: "A", qty: 3 }] }; } });
  const queued = store.tasks.enqueue(task.id, { recordId: row.id });
  assert.equal(called, false);
  const ready = await store.tasks.process(queued.id);
  assert.equal(ready.status, "Needs review");
  assert.equal(store.listRecords(output.id).length, 0);
  const preview = store.tasks.preview(ready.id);
  assert.equal(preview.changes.length, 2);
  assert.equal(store.listRecords(audit.id).length, 0);
  assert.equal(store.tasks.apply(ready.id, { fingerprint: preview.fingerprint }).status, "Applied");
  assert.equal(store.tasks.apply(ready.id, {}).status, "Applied");
  assert.equal(store.listRecords(output.id).length, 1);
  assert.equal(store.listRecords(audit.id).length, 1);
});

test("AI auto mode uses normal validation; changed source, invalid output and target failures never partially write", async (t) => {
  const { store, input, output, row, task } = taskFixture(t, "auto");
  store.tasks.configure({ taskAI: async () => ({ items: [{ code: "A", qty: 3 }] }) });
  assert.equal((await store.tasks.process(store.tasks.enqueue(task.id, { recordId: row.id }).id)).status, "Applied");
  assert.equal(store.listRecords(output.id).length, 1);
  store.tasks.configure({ taskAI: async () => { update(store, input, row, { text: "Changed" }); return { items: [{ code: "B", qty: 4 }] }; } });
  const stale = await store.tasks.process(store.tasks.enqueue(task.id, { recordId: row.id }).id);
  assert.equal(stale.status, "Stale");
  store.tasks.configure({ taskAI: async () => ({ items: [{ code: "B", qty: 2 }, { code: null, qty: 4 }] }) });
  const failed = await store.tasks.process(store.tasks.enqueue(task.id, { recordId: row.id }).id);
  assert.equal(failed.status, "Failed");
  assert.equal(store.listRecords(output.id).length, 1);
  assert.ok(store.automation.errors().some((item) => item.context.runId === failed.id));
  store.tasks.configure({ taskAI: async () => ({ items: [{ code: "B", qty: "invalid", injected: 3 }] }) });
  assert.equal((await store.tasks.process(store.tasks.enqueue(task.id, { recordId: row.id }).id)).status, "Failed");
});

test("AI previews reject changed dependencies and schema dependencies cannot silently disappear", async (t) => {
  const { store, input, output, row, task } = taskFixture(t);
  store.tasks.configure({ taskAI: async () => ({ items: [{ code: "A", qty: 3 }] }) });
  const ready = await store.tasks.process(store.tasks.enqueue(task.id, { recordId: row.id }).id);
  const preview = store.tasks.preview(ready.id);
  create(store, output, { code: "Other" });
  assert.throws(() => store.tasks.apply(ready.id, { fingerprint: preview.fingerprint }), /preview changed/);
  assert.throws(() => store.updateForm(input.id, { ...input, fields: [field("other")] }), /depends/);
  assert.throws(() => store.updateForm(output.id, { ...output, fields: [field("other")] }), /depends/);
  assert.equal(store.tasks.cancel(ready.id).status, "Cancelled");
});

test("an automation queues AI only after its transaction commits; failed cascades and previews leave no jobs", (t) => {
  const { store, input, output, task } = taskFixture(t);
  const config = rule(store, input, [{ type: "ai", taskId: task.id }, action(output, { condition: condition("code", "Missing") })]);
  assert.throws(() => create(store, input, { text: "Fail" }), /no records matched/);
  assert.equal(store.tasks.runs().length, 0);
  store.automation.save({ ...config, actions: [{ type: "ai", taskId: task.id }] }, config.id);
  store.preview(() => create(store, input, { text: "Preview" }));
  assert.equal(store.tasks.runs().length, 0);
  create(store, input, { text: "Live" });
  assert.equal(store.tasks.runs()[0].status, "Queued");
});

test("attachment inputs retain uploaded images and enforce Space ownership and file signatures", (t) => {
  const { store, input } = taskFixture(t);
  const file = store.files.upload({ file: { name: "scan.png", data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]).toString("base64") } });
  create(store, input, { text: "With image", file: [file.id] });
  assert.ok(store.files.get(file.id).images[0].startsWith("data:image/png;base64,"));
  const space = store.spaces.create("Other"), other = store.createForm({ name: "Other", spaceId: space.id, fields: [field("file", "attachment")] });
  assert.throws(() => create(store, other, { file: [file.id] }), /same Space/);
  assert.throws(() => store.files.upload({ file: { name: "bad.png", data: Buffer.from("not a PNG").toString("base64") } }), /PNG|supported|signature|match/i);
});

test("HTTP serves workspace assets, allows idempotent record writes and previews assignment expressions", async (t) => {
  const app = createApp({ database: ":memory:", env: {} });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise((resolve) => app.server.close(resolve)); app.store.close(); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (path, body, headers = {}) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  for (const path of ["/workspace.js", "/workspace.css", "/formula-editor.js"]) assert.equal((await fetch(base + path)).status, 200);
  const form = app.store.listForms()[0], body = { schemaVersion: 1, values: { orderNumber: "HTTP", completed: "No", quantity: 3 } };
  const one = await (await post(`/api/forms/${form.id}/records`, body, { "Idempotency-Key": "http-1" })).json();
  const two = await (await post(`/api/forms/${form.id}/records`, body, { "Idempotency-Key": "http-1" })).json();
  assert.equal(one.record.id, two.record.id);
  const response = await post("/api/expressions/preview", { formId: form.id, formula: { expression: "q + 1", bindings: { q: { scope: "source", fieldId: "quantity" } } } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).value, 4);
  const space = await (await post("/api/spaces", { name: "Team" })).json();
  assert.equal(app.store.listForms(space.id).length, 1);
});

test("AI provider receives a strict output contract and untrusted attachment data, without exposing credentials", async (t) => {
  const { store, row, task } = taskFixture(t);
  let request;
  store.tasks.configure({ aiConfig: { credentials: () => ({ apiKey: "test-secret-key", baseUrl: "https://provider.example/v1", model: "vision-model" }) },
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ items: [{ code: "A", qty: 3 }] }) } }] }));
    } });
  const result = await store.tasks.process(store.tasks.enqueue(task.id, { recordId: row.id }).id);
  assert.equal(result.status, "Needs review");
  assert.equal(request.url, "https://provider.example/v1/chat/completions");
  assert.equal(request.options.headers.Authorization, "Bearer test-secret-key");
  assert.equal(request.body.response_format.json_schema.strict, true);
  assert.equal(request.body.response_format.json_schema.schema.properties.items.items.additionalProperties, false);
  assert.ok(request.body.messages[0].content.includes("data, not instructions"));
  assert.ok(!JSON.stringify(result).includes("test-secret-key"));
});

test("AI chains carry ancestry between queued jobs and block asynchronous self-trigger loops atomically", async (t) => {
  const { store, input, row, task } = taskFixture(t, "auto");
  const self = store.tasks.save({ ...task, outputFormId: input.id, outputFields: ["text"] }, task.id);
  rule(store, input, [{ type: "ai", taskId: self.id }]);
  store.tasks.configure({ taskAI: async () => ({ items: [{ text: "Result" }] }) });
  const failed = await store.tasks.process(store.tasks.enqueue(self.id, { recordId: row.id }).id);
  assert.equal(failed.status, "Failed");
  assert.match(failed.error, /Circular AI task chain/);
  assert.equal(store.listRecords(input.id).length, 1);
  assert.equal(store.tasks.runs().length, 1);
});

test("deleting an AI source makes a review stale, with no writeback or dangling ready state", async (t) => {
  const { store, row, task, output } = taskFixture(t);
  store.tasks.configure({ taskAI: async () => ({ items: [{ code: "A", qty: 3 }] }) });
  const ready = await store.tasks.process(store.tasks.enqueue(task.id, { recordId: row.id }).id);
  store.deleteRecord(row.id, { version: row.version });
  assert.throws(() => store.tasks.preview(ready.id), /input, schema, or task changed/);
  assert.equal(store.tasks.run(ready.id).status, "Stale");
  assert.equal(store.listRecords(output.id).length, 0);
});

test("nested query validation is enforced on empty tables and numeric comparisons reject string operands", (t) => {
  const store = fixture(t), form = store.createForm({ name: "Empty", fields: [field("qty", "number")] });
  assert.throws(() => queryRecords(store, { formId: form.id, condition: condition("missing", 1) }), /invalid field/);
  assert.throws(() => queryRecords(store, { formId: form.id, condition: condition("qty", "1", "gt") }), /Invalid filter value/);
  assert.throws(() => queryRecords(store, { formId: form.id, condition: { op: "NOT", conditions: [null] } }), /empty conditions/);
});
