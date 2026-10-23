import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createTableImport } from "../src/table-import.js";

const field = (id, type = "text", extra = {}) => ({ id, name: id, type, required: false, unique: false, options: [], ...extra });
test("spreadsheet imports calculate fields and preserve same-form notification behavior", (t) => {
  const store = createStore(":memory:");
  t.after(() => store.close());
  const imports = createTableImport(store);
  const form = store.createForm({ name: "Lines", fields: [field("qty", "number"), field("price", "number"),
    field("total", "number", { formula: { expression: "q * p", bindings: { q: { scope: "record", fieldId: "qty" }, p: { scope: "record", fieldId: "price" } } } }),
  ] });
  store.automation.save({ name: "Log line", formId: form.id, trigger: "created", enabled: true, actions: [
    { type: "notify", message: "Line received" },
  ] });
  const preview = imports.preview({ formId: form.id, schemaVersion: 1, rows: [[3, 0.1], [2, 0.2]], mapping: { qty: 0, price: 1 } });
  assert.equal(preview.errors.length, 0);
  assert.equal(preview.effects.length, 2);
  assert.equal(store.automation.notifications().length, 0);
  const result = imports.commit(preview.id);
  assert.equal(result.recordIds.length, 2);
  assert.deepEqual(store.listRecords(form.id).map((row) => row.values.total).sort(), [0.3, 0.4]);
  assert.equal(store.automation.notifications().length, 2);
  assert.equal(imports.commit(preview.id).alreadySaved, true);
});

test("new-table imports retain the selected Space and parent; dependency changes invalidate approval", (t) => {
  const store = createStore(":memory:");
  t.after(() => store.close());
  const imports = createTableImport(store), space = store.spaces.create("Branch");
  const node = store.spaces.createNode({ name: "Purchases", spaceId: space.id });
  const preview = imports.preview({ name: "Imported", spaceId: space.id, parentId: node.id, fields: [field("qty", "number")], rows: [[4]], mapping: { qty: 0 } });
  const result = imports.commit(preview.id);
  assert.equal(store.getForm(result.formId).spaceId, space.id);
  assert.equal(store.spaces.node(`form_${result.formId}`).parentId, node.id);
  const next = imports.preview({ formId: result.formId, schemaVersion: 1, rows: [[5]], mapping: { qty: 0 } });
  store.createRecord(result.formId, { schemaVersion: 1, values: { qty: 8 } });
  assert.throws(() => imports.commit(next.id), /changed/);
  assert.equal(store.listRecords(result.formId).length, 2);
});
