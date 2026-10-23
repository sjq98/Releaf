import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError, createStore, DEFAULT_FIELDS, FIELD_TYPES } from "../src/store.js";

const field = (id, type = "text", rules = {}) => ({
  id, name: id, type, required: false, unique: false, options: [], ...rules,
});
const fixture = (t) => {
  const store = createStore(":memory:");
  t.after(() => store.close());
  return store;
};
const create = (store, form, values) => store.createRecord(form.id, { schemaVersion: form.version, values }).record;
const edit = (store, form, record, values) => store.updateRecord(record.id, { schemaVersion: form.version, version: record.version, values });
const schema = (store, form, fields, name = form.name) => store.updateForm(form.id, { version: form.version, name, fields });
const errorStatus = (status, fieldId) => (error) => {
  assert.ok(error instanceof AppError);
  assert.equal(error.status, status);
  if (fieldId) assert.ok(error.fields[fieldId], `Expected error for ${fieldId}`);
  return true;
};

test("starts with a generic form without legacy business templates", (t) => {
  const store = fixture(t);
  const data = store.bootstrap();
  assert.equal(data.forms.length, 1);
  assert.equal(data.form.name, "New form");
  assert.deepEqual(data.form.fields, DEFAULT_FIELDS);
  assert.deepEqual(data.fieldTypes, FIELD_TYPES);
  assert.deepEqual(data.records, []);
  assert.deepEqual(data.changes, []);
});

test("creates multiple independent forms and isolates their unique values", (t) => {
  const store = fixture(t);
  const first = store.createForm({ name: "Suppliers", fields: [field("code", "text", { unique: true })] });
  const second = store.createForm({ name: "Materials", fields: [field("code", "text", { unique: true })] });
  create(store, first, { code: "A" });
  create(store, second, { code: "A" });
  assert.equal(store.listRecords(first.id).length, 1);
  assert.equal(store.bootstrap(second.id).changes.length, 1);
  assert.equal(store.listForms().find((form) => form.id === first.id).recordCount, 1);
});

test("supports all seven field types and trims text", (t) => {
  const store = fixture(t);
  const form = store.createForm({ name: "All types", fields: [
    field("title"), field("notes", "longtext"), field("amount", "number"),
    field("day", "date"), field("appointment", "datetime"),
    field("status", "select", { options: ["Yes", "No"] }), field("active", "checkbox"),
  ] });
  const values = { title: "  Example  ", notes: " Line one\nLine two ", amount: -1.25, day: "2028-02-29", appointment: "2026-10-20T23:59", status: "No", active: false };
  const record = create(store, form, values);
  assert.deepEqual(record.values, { ...values, title: "Example", notes: "Line one\nLine two" });
  assert.equal(store.listChanges(form.id)[0].diff.length, 7);
});

test("required fields reject null, omitted values and blank text", (t) => {
  const store = fixture(t);
  const form = store.createForm({ name: "Required", fields: [field("name", "text", { required: true })] });
  for (const values of [{}, { name: null }, { name: "" }, { name: "   " }]) {
    assert.throws(() => create(store, form, values), errorStatus(400, "name"));
  }
  assert.equal(store.listRecords(form.id).length, 0);
  assert.equal(store.listChanges(form.id).length, 0);
});

test("required numeric zero is valid and required checkboxes must be checked", (t) => {
  const store = fixture(t);
  const form = store.createForm({ name: "Zero", fields: [field("amount", "number", { required: true }), field("active", "checkbox", { required: true })] });
  assert.throws(() => create(store, form, { amount: 0 }), errorStatus(400, "active"));
  assert.throws(() => create(store, form, { amount: 0, active: false }), errorStatus(400, "active"));
  assert.deepEqual(create(store, form, { amount: 0, active: true }).values, { amount: 0, active: true });
});

test("rejects incorrectly typed values for each field type", (t) => {
  const store = fixture(t);
  for (const [type, invalid] of [["text", 2], ["longtext", false], ["number", "12"], ["date", "2026-02-29"], ["datetime", "2026-10-20T24:00"], ["select", "Unknown"], ["checkbox", "false"]]) {
    const form = store.createForm({ name: type, fields: [field("value", type, { options: ["Yes", "No"] })] });
    assert.throws(() => create(store, form, { value: invalid }), errorStatus(400, "value"));
  }
});

test("validates date boundaries, leap days and datetime precision", (t) => {
  const store = fixture(t);
  const form = store.createForm({ name: "Dates", fields: [field("day", "date"), field("time", "datetime")] });
  for (const day of ["1899-12-31", "2026-04-31", "2026-13-01", "2026-00-01", "2026-01-00", "10000-01-01", "2026-1-01"]) {
    assert.throws(() => create(store, form, { day }), errorStatus(400, "day"));
  }
  for (const time of ["2026-10-20T12:60", "2026-10-20T12:30Z", "2026-10-20T12:30:00"]) {
    assert.throws(() => create(store, form, { time }), errorStatus(400, "time"));
  }
  assert.equal(create(store, form, { day: "1900-01-01", time: "9999-12-31T23:59" }).values.day, "1900-01-01");
});

test("rejects non-finite and out-of-range numbers and oversized text", (t) => {
  const store = fixture(t);
  const form = store.createForm({ name: "Limits", fields: [field("value", "number"), field("text"), field("notes", "longtext")] });
  for (const value of [NaN, Infinity, -Infinity, 1e16]) {
    assert.throws(() => create(store, form, { value }), errorStatus(400, "value"));
  }
  assert.throws(() => create(store, form, { text: "a".repeat(1001) }), errorStatus(400, "text"));
  assert.throws(() => create(store, form, { notes: "a".repeat(5001) }), errorStatus(400, "notes"));
});

test("unique text is case-insensitive and ignores blank optional values", (t) => {
  const store = fixture(t);
  const form = store.createForm({ name: "Unique", fields: [field("code", "text", { unique: true })] });
  create(store, form, { code: " A-1 " });
  assert.throws(() => create(store, form, { code: "a-1" }), errorStatus(409, "code"));
  create(store, form, {});
  create(store, form, { code: " " });
  assert.equal(store.listRecords(form.id).length, 3);
  assert.equal(store.listChanges(form.id).length, 3);
});

test("uniqueness applies to numeric zero and boolean false", (t) => {
  const store = fixture(t);
  for (const [type, value] of [["number", 0], ["checkbox", false]]) {
    const form = store.createForm({ name: type, fields: [field("value", type, { unique: true })] });
    create(store, form, { value });
    assert.throws(() => create(store, form, { value }), errorStatus(409, "value"));
  }
});

test("records field-level before/after differences automatically", (t) => {
  const store = fixture(t);
  const form = store.createForm({ name: "Requests", fields: [
    field("orderNumber", "text", { unique: true }),
    field("quantity", "number", { name: "Quantity" }),
    field("completed", "select", { name: "Completed", options: ["Yes", "No"] }),
  ] });
  const record = create(store, form, { orderNumber: "ORD-001", quantity: 1, completed: "No" });
  const result = edit(store, form, record, { quantity: 5, completed: "Yes" });
  assert.equal(result.changed, true);
  assert.equal(result.record.version, 2);
  const entry = store.listChanges(form.id)[0];
  assert.equal(entry.kind, "updated");
  assert.equal(entry.recordTitle, "ORD-001");
  assert.deepEqual(entry.diff, [
    { fieldId: "quantity", name: "Quantity", type: "number", before: 1, after: 5 },
    { fieldId: "completed", name: "Completed", type: "select", before: "No", after: "Yes" },
  ]);
});

test("no-op saves do not increment versions or generate activity", (t) => {
  const store = fixture(t);
  const form = store.createForm({ name: "Notes" });
  const record = create(store, form, { [form.fields[0].id]: "A" });
  assert.equal(edit(store, form, record, { [form.fields[0].id]: " A " }).changed, false);
  assert.equal(store.getRecord(record.id).version, 1);
  assert.equal(store.listChanges(form.id).length, 1);
  assert.equal(schema(store, form, form.fields).version, 1);
});

test("failed duplicate updates leave record, history and unique indexes intact", (t) => {
  const store = fixture(t);
  const form = store.createForm({ name: "Codes", fields: [field("code", "text", { unique: true })] });
  const first = create(store, form, { code: "A" });
  const second = create(store, form, { code: "B" });
  assert.throws(() => edit(store, form, first, { code: "B" }), errorStatus(409, "code"));
  assert.deepEqual(store.getRecord(first.id), first);
  assert.equal(store.listChanges(form.id).length, 2);
  assert.throws(() => edit(store, form, second, { code: "A" }), errorStatus(409, "code"));
});

test("rejects stale record and schema versions", (t) => {
  const store = fixture(t);
  let form = store.createForm({ name: "Notes", fields: [field("name")] });
  const record = create(store, form, { name: "A" });
  edit(store, form, record, { name: "B" });
  assert.throws(() => edit(store, form, record, { name: "C" }), errorStatus(409));
  const previousForm = form;
  form = schema(store, form, form.fields, "Renamed");
  assert.throws(() => schema(store, previousForm, previousForm.fields), errorStatus(409));
  assert.throws(() => create(store, previousForm, { name: "D" }), errorStatus(409));
  assert.throws(() => store.deleteRecord(record.id, { version: record.version }), errorStatus(409));
});

test("renaming and reordering fields preserves values by field ID", (t) => {
  const store = fixture(t);
  const form = store.createForm({ name: "People", fields: [field("name"), field("age", "number")] });
  const record = create(store, form, { name: "Alex", age: 20 });
  const updated = schema(store, form, [form.fields[1], { ...form.fields[0], name: "Full name" }]);
  assert.equal(updated.fields[1].id, "name");
  assert.deepEqual(store.getRecord(record.id).values, { name: "Alex", age: 20 });
  assert.equal(store.listChanges(form.id)[0].diff[0].name, "name");
});

test("removed fields and historical labels remain preserved", (t) => {
  const store = fixture(t);
  let form = store.createForm({ name: "Archive", fields: [field("name"), field("notes")] });
  const record = create(store, form, { name: "A", notes: "Preserved" });
  form = schema(store, form, [form.fields[0]]);
  edit(store, form, store.getRecord(record.id), { name: "B" });
  assert.equal(store.getRecord(record.id).values.notes, "Preserved");
  assert.equal(store.listChanges(form.id).at(-1).diff[1].after, "Preserved");
  form = schema(store, form, [...form.fields, field("notes")]);
  assert.equal(store.getRecord(record.id).values.notes, "Preserved");
});

test("new optional fields are normalized consistently in existing records", (t) => {
  const store = fixture(t);
  const form = store.createForm({ name: "New fields", fields: [field("name")] });
  const record = create(store, form, { name: "A" });
  schema(store, form, [...form.fields, field("notes"), field("active", "checkbox")]);
  assert.deepEqual(store.getRecord(record.id).values, { name: "A", notes: null, active: false });
  assert.equal(store.listChanges(form.id).length, 1);
});

test("blocks required fields when existing records have no value", (t) => {
  const store = fixture(t);
  const form = store.createForm({ name: "Rules", fields: [field("name")] });
  create(store, form, { name: "A" });
  assert.throws(() => schema(store, form, [...form.fields, field("newField", "text", { required: true })]), errorStatus(409));
  assert.equal(store.getForm(form.id).version, 1);
});

test("blocks incompatible type changes and removed dropdown options", (t) => {
  const store = fixture(t);
  const form = store.createForm({ name: "Rules", fields: [field("name"), field("status", "select", { options: ["A", "B"] })] });
  create(store, form, { name: "Not a number", status: "A" });
  assert.throws(() => schema(store, form, [{ ...form.fields[0], type: "number" }, form.fields[1]]), errorStatus(409));
  assert.throws(() => schema(store, form, [form.fields[0], { ...form.fields[1], options: ["B"] }]), errorStatus(409));
  assert.equal(store.getForm(form.id).version, 1);
});

test("enabling unique on existing duplicates rolls back schema and indexes", (t) => {
  const store = fixture(t);
  let form = store.createForm({ name: "Rules", fields: [field("name")] });
  const record = create(store, form, { name: "same" });
  create(store, form, { name: "SAME" });
  assert.throws(() => schema(store, form, [{ ...form.fields[0], unique: true }]), errorStatus(409, "name"));
  assert.equal(store.getForm(form.id).fields[0].unique, false);
  edit(store, form, record, { name: "different" });
  form = schema(store, form, [{ ...form.fields[0], unique: true }]);
  assert.throws(() => create(store, form, { name: "Different" }), errorStatus(409, "name"));
});

test("deletion retains history and releases unique values", (t) => {
  const store = fixture(t);
  const form = store.createForm({ name: "Codes", fields: [field("code", "text", { unique: true })] });
  const record = create(store, form, { code: "A" });
  store.deleteRecord(record.id, { version: 1 });
  assert.equal(store.listRecords(form.id).length, 0);
  assert.throws(() => store.getRecord(record.id), errorStatus(404));
  assert.equal(store.listChanges(form.id)[0].kind, "deleted");
  assert.equal(store.listChanges(form.id)[0].diff[0].before, "A");
  create(store, form, { code: "A" });
  assert.equal(store.listChanges(form.id).length, 3);
});

test("schema checks ignore deleted records", (t) => {
  const store = fixture(t);
  const form = store.createForm({ name: "Archived", fields: [field("name")] });
  const record = create(store, form, { name: "Text" });
  store.deleteRecord(record.id, { version: 1 });
  assert.equal(schema(store, form, [field("name", "number", { required: true })]).version, 2);
});

test("validates form names, field counts, names, IDs, rules and dropdown options", (t) => {
  const store = fixture(t);
  for (const name of ["", " ", 12, "a".repeat(81)]) assert.throws(() => store.createForm({ name }), errorStatus(400));
  const invalid = [
    [], Array.from({ length: 41 }, (_, i) => field(`f${i}`)),
    [field("same"), field("same")], [field("a"), field("b", "text", { name: "A" })],
    [field("_invalid")], [field("ok", "text", { name: " " })],
    [field("ok", "file")], [field("ok", "text", { required: "yes" })],
    [field("ok", "select")], [field("ok", "select", { options: ["A", "a"] })],
    [field("ok", "select", { options: [""] })], [field("ok", "select", { options: ["a".repeat(101)] })],
  ];
  for (const fields of invalid) assert.throws(() => store.createForm({ name: "Invalid", fields }), errorStatus(400));
  assert.equal(store.listForms().length, 1);
});

test("rejects unknown fields and non-object record data", (t) => {
  const store = fixture(t);
  const form = store.createForm({ name: "Safe", fields: [field("name")] });
  for (const values of [null, [], "text", { unexpected: "A" }]) {
    assert.throws(() => create(store, form, values), errorStatus(400));
  }
});

test("handles valid field IDs that match Object prototype property names", (t) => {
  const store = fixture(t);
  const form = store.createForm({ name: "Keys", fields: [field("constructor"), field("toString")] });
  assert.deepEqual(create(store, form, {}).values, { constructor: null, toString: null });
  const record = create(store, form, { constructor: "A", toString: "B" });
  assert.deepEqual(store.listChanges(form.id)[0].diff[0], { fieldId: "constructor", name: "constructor", type: "text", before: null, after: "A" });
  assert.equal(edit(store, form, record, { constructor: "C" }).record.values.constructor, "C");
});

test("adding a unique checkbox checks the normalized default false values", (t) => {
  const store = fixture(t);
  const form = store.createForm({ name: "Checkbox rules", fields: [field("name")] });
  create(store, form, { name: "A" });
  create(store, form, { name: "B" });
  assert.throws(() => schema(store, form, [...form.fields, field("flag", "checkbox", { unique: true })]), errorStatus(409, "flag"));
  assert.equal(store.getForm(form.id).version, 1);
});

test("clearing optional values creates a difference and releases the unique value", (t) => {
  const store = fixture(t);
  const form = store.createForm({ name: "Optional codes", fields: [field("code", "text", { unique: true })] });
  const record = create(store, form, { code: "A" });
  edit(store, form, record, { code: null });
  assert.equal(store.listChanges(form.id)[0].diff[0].after, null);
  create(store, form, { code: "A" });
});

test("reports missing forms and records as 404", (t) => {
  const store = fixture(t);
  assert.throws(() => store.getForm("missing"), errorStatus(404));
  assert.throws(() => store.listRecords("missing"), errorStatus(404));
  assert.throws(() => store.listChanges("missing"), errorStatus(404));
  assert.throws(() => store.getRecord("missing"), errorStatus(404));
});

test("persists forms, records, indexes and activity across reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "form-studio-"));
  const filename = join(directory, "forms.sqlite");
  let store;
  try {
    store = createStore(filename);
    const form = store.createForm({ name: "Persistent", fields: [field("code", "text", { unique: true })] });
    const record = create(store, form, { code: "A" });
    store.close();
    store = createStore(filename);
    assert.equal(store.listForms().length, 2);
    assert.deepEqual(store.getRecord(record.id), record);
    assert.equal(store.listChanges(form.id).length, 1);
    assert.throws(() => create(store, form, { code: "a" }), errorStatus(409, "code"));
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
