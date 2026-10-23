import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { createStore } from "../src/store.js";
import { createTableImport, parseTableFile } from "../src/table-import.js";

const field = (id, type = "text", extra = {}) => ({ id, name: id, type, required: false, unique: false, options: [], ...extra });
const file = (name, bytes) => ({ name, data: Buffer.from(bytes).toString("base64") });
function fixture(t) {
  const store = createStore(":memory:"); t.after(() => store.close());
  const form = store.createForm({ name: "Items", fields: [field("code", "text", { required: true, unique: true }), field("quantity", "number")] });
  return { store, form, importer: createTableImport(store) };
}

test("CSV and XLSX parsers preserve identifiers, cached formulas, dates and worksheet structure", async () => {
  const csv = await parseTableFile(file("items.csv", 'Code,Quantity\r\n"0001",2\r\n'));
  assert.equal(csv.sheets[0].rows[1][0], "0001");
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet("Data");
  sheet.addRow(["Code", "Quantity", "Date"]);
  sheet.addRow([1, { formula: "1+2", result: 3 }, new Date("2026-10-22T00:00:00Z")]);
  sheet.getCell("A2").numFmt = "0000";
  workbook.addWorksheet("Other").addRow(["Code"]);
  const parsed = await parseTableFile(file("items.xlsx", await workbook.xlsx.writeBuffer()));
  assert.equal(parsed.sheets.length, 2);
  assert.deepEqual(parsed.sheets[0].rows[1], ["0001", 3, "2026-10-22T00:00:00.000Z"]);
});

test("import parsers reject unsupported, oversized, excessive and uncached inputs", async () => {
  await assert.rejects(parseTableFile(file("old.xls", "no")), { status: 400 });
  await assert.rejects(parseTableFile(file("large.csv", "x".repeat(5 * 1024 * 1024 + 1))), { status: 400 });
  await assert.rejects(parseTableFile(file("many.csv", "a\n".repeat(1102))), { status: 400 });
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("Data").getCell("A1").value = { formula: "NOW()" };
  await assert.rejects(parseTableFile(file("uncached.xlsx", await workbook.xlsx.writeBuffer())), /saved result/);
});

test("new table preview is unwritten and committed imports are atomic and idempotent", t => {
  const { store, importer } = fixture(t), before = store.listForms().length;
  const input = { name: "Import", fields: [field("sku", "text", { unique: true, required: true })], mapping: { sku: 0 }, rows: [["A"], ["B"]] };
  const preview = importer.preview(input);
  assert.equal(store.listForms().length, before);
  assert.equal(preview.errors.length, 0);
  const result = importer.commit(preview.id);
  assert.equal(store.listRecords(result.formId).length, 2);
  assert.equal(importer.commit(preview.id).alreadySaved, true);
  assert.throws(() => importer.preview(input), { status: 409 });
});

test("spreadsheet references resolve unique values and record validation collects row errors", t => {
  const { store, form, importer } = fixture(t);
  const record = store.createRecord(form.id, { schemaVersion: 1, values: { code: "0001" } }).record;
  const linked = store.createForm({ name: "Linked", fields: [field("item", "reference", { reference: { formId: form.id, fieldId: "code" } })] });
  const preview = importer.preview({ formId: linked.id, schemaVersion: 1, mapping: { item: 0 }, rows: [["0001"]] });
  assert.equal(preview.rows[0].item, record.id);
  assert.equal(store.listRecords(linked.id).length, 0);
  importer.commit(preview.id);
  const bad = importer.preview({ formId: form.id, schemaVersion: 1, mapping: { code: 0, quantity: 1 }, rows: [["NEW", "1,000"], ["0001", 1], [null, 2]] });
  assert.equal(bad.errors.length, 3);
  assert.throws(() => importer.commit(bad.id), { status: 400 });
  assert.equal(store.listRecords(form.id).length, 1);
  const missing = importer.preview({ formId: linked.id, schemaVersion: 1, mapping: { item: 0 }, rows: [["UNKNOWN"]] });
  assert.match(missing.errors[0].fields.item, /No matching/);
});

test("schema changes, concurrent uniqueness and deleted targets invalidate import previews", t => {
  const { store, form, importer } = fixture(t);
  const input = { formId: form.id, schemaVersion: 1, mapping: { code: 0 }, rows: [["A"], ["B"]] };
  const preview = importer.preview(input);
  store.createRecord(form.id, { schemaVersion: 1, values: { code: "B" } });
  assert.throws(() => importer.commit(preview.id), { status: 409 });
  assert.equal(store.listRecords(form.id).length, 1);
  const fresh = importer.preview({ ...input, rows: [["C"]] });
  store.updateForm(form.id, { ...form, name: "Renamed" });
  assert.throws(() => importer.commit(fresh.id), { status: 409 });
  const next = importer.preview({ ...input, schemaVersion: 2, rows: [["D"]] });
  store.deletions.remove(form.id, { ...store.deletions.inspect(form.id), confirmed: true });
  assert.throws(() => importer.commit(next.id), { status: 409 });
});
