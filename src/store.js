import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { AppError } from "./errors.js";
import { FIELD_TYPES, normalizeValues, validateFields } from "./field-types.js";
import { MODULES, TODO_FIELDS } from "./modules.js";

export { AppError, FIELD_TYPES };
export const DEFAULT_FIELDS = [
  { id: "orderNumber", name: "Order number", type: "text", required: true, unique: true, options: [] },
  { id: "deliveryAt", name: "Delivery time", type: "datetime", required: false, unique: false, options: [] },
  { id: "item", name: "Order item", type: "text", required: false, unique: false, options: [] },
  { id: "quantity", name: "Quantity", type: "number", required: false, unique: false, options: [] },
  { id: "completed", name: "Completed", type: "select", required: true, unique: false, options: ["Yes", "No"] },
];

function fail(message, fields = {}) {
  throw new AppError(400, message, fields);
}

function validateName(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 80) fail("Form name must contain 1-80 characters.");
  return value.trim();
}

function uniqueKey(value) {
  return `${typeof value}:${typeof value === "string" ? value.toLowerCase() : String(value)}`;
}

function fieldValue(values, id) {
  return Object.hasOwn(values, id) ? values[id] ?? null : null;
}

export function createStore(filename) {
  if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS forms (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, fields_json TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS records (
      id TEXT PRIMARY KEY, form_id TEXT NOT NULL REFERENCES forms(id),
      values_json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS unique_values (
      form_id TEXT NOT NULL, field_id TEXT NOT NULL, value_key TEXT NOT NULL,
      record_id TEXT NOT NULL REFERENCES records(id),
      PRIMARY KEY(form_id, field_id, value_key)
    );
    CREATE TABLE IF NOT EXISTS form_activity (
      id TEXT PRIMARY KEY, form_id TEXT NOT NULL, record_id TEXT NOT NULL, record_title TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('created', 'updated', 'deleted')),
      diff_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS records_form ON records(form_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS activity_form ON form_activity(form_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS meeting_imports (
      id TEXT PRIMARY KEY, form_id TEXT NOT NULL REFERENCES forms(id), title TEXT NOT NULL,
      meeting_date TEXT NOT NULL, source_text TEXT NOT NULL, schema_version INTEGER NOT NULL,
      items_json TEXT NOT NULL, result_json TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meeting_items (
      record_id TEXT PRIMARY KEY REFERENCES records(id),
      import_id TEXT NOT NULL REFERENCES meeting_imports(id), evidence TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS module_tables (
      module_id TEXT PRIMARY KEY, form_id TEXT NOT NULL REFERENCES forms(id)
    );
    CREATE TABLE IF NOT EXISTS ai_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1), provider_name TEXT NOT NULL,
      base_url TEXT NOT NULL, api_key TEXT NOT NULL, model TEXT NOT NULL
    );
  `);
  if (!db.prepare("PRAGMA table_info(forms)").all().some((column) => column.name === "module_id")) {
    db.exec("ALTER TABLE forms ADD COLUMN module_id TEXT NOT NULL DEFAULT 'orders'");
  }
  if (db.prepare("SELECT COUNT(*) AS count FROM forms").get().count === 0) {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO forms (id, name, fields_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
      randomUUID(), "Orders", JSON.stringify(DEFAULT_FIELDS), now, now,
    );
  }

  function transaction(callback) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      db.exec("COMMIT");
      return result;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  function parseForm(row) {
    return { id: row.id, name: row.name, moduleId: row.module_id, fields: JSON.parse(row.fields_json), version: row.version, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  function getForm(id) {
    const row = db.prepare("SELECT * FROM forms WHERE id = ?").get(id);
    if (!row) throw new AppError(404, "This form no longer exists.");
    return parseForm(row);
  }

  function listForms() {
    return db.prepare("SELECT * FROM forms ORDER BY created_at, rowid").all().map((row) => ({
      ...parseForm(row), recordCount: db.prepare("SELECT COUNT(*) AS count FROM records WHERE form_id = ? AND deleted_at IS NULL").get(row.id).count,
    }));
  }

  function createForm(body) {
    const name = validateName(body?.name);
    const moduleId = body?.moduleId ?? "orders";
    if (!MODULES.some((module) => module.id === moduleId)) fail("Choose an available module.");
    const fields = validateFields(body?.fields ?? [{ id: `fld_${randomUUID()}`, name: "Name", type: "text", required: true, unique: false, options: [] }]);
    validateReferences(fields);
    const now = new Date().toISOString();
    const id = randomUUID();
    db.prepare("INSERT INTO forms (id, name, fields_json, created_at, updated_at, module_id) VALUES (?, ?, ?, ?, ?, ?)").run(id, name, JSON.stringify(fields), now, now, moduleId);
    return getForm(id);
  }

  function parseRecord(row) {
    const source = db.prepare(`SELECT mi.evidence, m.id, m.title, m.meeting_date
      FROM meeting_items mi JOIN meeting_imports m ON m.id = mi.import_id WHERE mi.record_id = ?`).get(row.id);
    return { id: row.id, formId: row.form_id, values: JSON.parse(row.values_json), version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
      ...(source ? { source: { importId: source.id, title: source.title, date: source.meeting_date, evidence: source.evidence } } : {}) };
  }

  function getRecord(id) {
    const row = db.prepare("SELECT * FROM records WHERE id = ? AND deleted_at IS NULL").get(id);
    if (!row) throw new AppError(404, "This record has been deleted or does not exist.");
    return parseRecord(row);
  }

  function listRecords(formId) {
    getForm(formId);
    return db.prepare("SELECT * FROM records WHERE form_id = ? AND deleted_at IS NULL ORDER BY created_at DESC, rowid DESC").all(formId).map(parseRecord);
  }

  function validateReferences(fields, formId = null) {
    for (const field of fields.filter((field) => field.type === "reference")) {
      if (field.reference.formId === formId) fail(`"${field.name}" must reference a different table.`);
      const target = getForm(field.reference.formId);
      const key = target.fields.find((item) => item.id === field.reference.fieldId);
      if (!key?.unique || key.type === "reference") fail(`"${field.name}" must target a unique, non-reference field.`);
    }
  }

  function validateReferenceValues(fields, values) {
    for (const field of fields.filter((field) => field.type === "reference" && values[field.id] != null)) {
      let target;
      try { target = getRecord(values[field.id]); } catch { /* Report a field-level validation error below. */ }
      const key = target?.values[field.reference.fieldId];
      if (!target || target.formId !== field.reference.formId || key === null || key === undefined || key === "") {
        throw new AppError(400, "Please check the highlighted fields.", { [field.id]: "Choose an existing record with a non-empty unique value." });
      }
    }
  }

  function inboundReferences(formId) {
    return listForms().flatMap((form) => form.fields
      .filter((field) => field.type === "reference" && field.reference.formId === formId)
      .map((field) => ({ form, field })));
  }

  function referenceCatalog() {
    return listForms().map((form) => ({
      id: form.id, name: form.name,
      fields: form.fields.filter((field) => field.unique && field.type !== "reference"),
      records: listRecords(form.id).map((record) => ({
        id: record.id,
        values: Object.fromEntries(form.fields.filter((field) => field.unique && field.type !== "reference").map((field) => [field.id, record.values[field.id]])),
      })),
    }));
  }

  function ensureMeetingTable() {
    return transaction(() => {
      const existing = db.prepare("SELECT form_id FROM module_tables WHERE module_id = 'meetings'").get();
      if (existing) return getForm(existing.form_id);
      const orderForm = listForms().find((form) => form.moduleId === "orders" && form.fields.some((field) => field.unique && field.type !== "reference"));
      const key = orderForm?.fields.find((field) => field.unique && field.type !== "reference");
      const form = createForm({
        name: "To-do Items", moduleId: "meetings",
        fields: [...TODO_FIELDS, ...(key ? [{
          id: "relatedOrder", name: "Related order", type: "reference", required: false, unique: false, options: [],
          reference: { formId: orderForm.id, fieldId: key.id },
        }] : [])],
      });
      db.prepare("INSERT INTO module_tables (module_id, form_id) VALUES ('meetings', ?)").run(form.id);
      return form;
    });
  }

  function writeUniqueValues(formId, recordId, fields, values) {
    db.prepare("DELETE FROM unique_values WHERE record_id = ?").run(recordId);
    for (const field of fields.filter((field) => field.unique)) {
      const value = values[field.id];
      if (value === null || value === undefined || value === "") continue;
      const key = uniqueKey(value);
      if (db.prepare("SELECT record_id FROM unique_values WHERE form_id = ? AND field_id = ? AND value_key = ?").get(formId, field.id, key)) {
        throw new AppError(409, `"${field.name}" must be unique.`, { [field.id]: "This value is already used by another record (text is case-insensitive)." });
      }
      db.prepare("INSERT INTO unique_values (form_id, field_id, value_key, record_id) VALUES (?, ?, ?, ?)").run(formId, field.id, key, recordId);
    }
  }

  function updateForm(id, body) {
    return transaction(() => {
      const form = getForm(id);
      if (body?.version !== form.version) throw new AppError(409, "This form was changed in another window. Reload and try again.");
      const name = validateName(body.name);
      const fields = validateFields(body.fields);
      validateReferences(fields, id);
      for (const { field } of inboundReferences(id)) {
        const old = form.fields.find((item) => item.id === field.reference.fieldId);
        const next = fields.find((item) => item.id === field.reference.fieldId);
        if (!next?.unique || next.type !== old.type) throw new AppError(409, `"${old.name}" is used by a reference field. Keep its type and Unique rule, or remove the reference field first.`);
      }
      if (name === form.name && JSON.stringify(fields) === JSON.stringify(form.fields)) return form;
      const records = listRecords(id);
      const normalized = new Map();
      // Validate before rewriting indexes so failed constraints leave schema and data untouched.
      for (const record of records) {
        try {
          const values = normalizeValues({}, fields, record.values);
          validateReferenceValues(fields, values);
          for (const { form: source, field: reference } of inboundReferences(id)) {
            const value = values[reference.reference.fieldId];
            if ((value == null || value === "") && listRecords(source.id).some((row) => row.values[reference.id] === record.id)) {
              throw new AppError(409, "A referenced unique value cannot be cleared.");
            }
          }
          normalized.set(record.id, values);
        }
        catch (error) {
          if (!Object.keys(error.fields || {}).length) throw error;
          const [fieldId, detail] = Object.entries(error.fields)[0];
          throw new AppError(409, `Cannot save this schema: record "${recordTitle(form.fields, record.values, record.id)}" does not satisfy "${fields.find((f) => f.id === fieldId).name}". ${detail}`);
        }
      }
      db.prepare("DELETE FROM unique_values WHERE form_id = ?").run(id);
      for (const record of records) {
        const values = normalized.get(record.id);
        writeUniqueValues(id, record.id, fields, values);
        db.prepare("UPDATE records SET values_json = ? WHERE id = ?").run(JSON.stringify(values), record.id);
      }
      db.prepare("UPDATE forms SET name = ?, fields_json = ?, version = version + 1, updated_at = ? WHERE id = ?").run(
        name, JSON.stringify(fields), new Date().toISOString(), id,
      );
      return getForm(id);
    });
  }

  function checkSchema(formId, body) {
    const form = getForm(formId);
    if (body?.schemaVersion !== form.version) throw new AppError(409, "The form fields have changed. Close this editor, refresh and try again.");
    return form;
  }

  function recordTitle(fields, values, id) {
    const first = fields.find((f) => f.unique && fieldValue(values, f.id) !== null) || fields.find((f) => fieldValue(values, f.id) !== null);
    return first ? String(values[first.id]).slice(0, 120) : `Record ${id.slice(0, 8)}`;
  }

  function recordChange(form, record, kind, before, after, now) {
    const diff = form.fields.filter((field) => fieldValue(before, field.id) !== fieldValue(after, field.id))
      .map((field) => ({ fieldId: field.id, name: field.name, type: field.type, ...(field.reference ? { reference: field.reference } : {}), before: fieldValue(before, field.id), after: fieldValue(after, field.id) }));
    if (kind === "updated" && diff.length === 0) return;
    db.prepare("INSERT INTO form_activity (id, form_id, record_id, record_title, kind, diff_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      randomUUID(), form.id, record.id, recordTitle(form.fields, record.values, record.id), kind, JSON.stringify(diff), now,
    );
  }

  function insertRecord(formId, body) {
      const form = checkSchema(formId, body);
      const values = normalizeValues(body.values, form.fields, {}, true);
      validateReferenceValues(form.fields, values);
      const now = new Date().toISOString();
      const id = randomUUID();
      db.prepare("INSERT INTO records (id, form_id, values_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
        id, formId, JSON.stringify(values), now, now,
      );
      writeUniqueValues(formId, id, form.fields, values);
      const record = getRecord(id);
      recordChange(form, record, "created", {}, values, now);
      return { record, changed: true };
  }

  function createRecord(formId, body) {
    return transaction(() => insertRecord(formId, body));
  }

  function updateRecord(id, body) {
    return transaction(() => {
      const previous = getRecord(id);
      const form = checkSchema(previous.formId, body);
      if (body.version !== previous.version) throw new AppError(409, "This record was changed in another window. Close the editor and refresh.");
      const values = normalizeValues(body.values, form.fields, previous.values);
      validateReferenceValues(form.fields, values);
      for (const { form: source, field } of inboundReferences(form.id)) {
        if ((values[field.reference.fieldId] == null || values[field.reference.fieldId] === "") &&
          listRecords(source.id).some((record) => record.values[field.id] === id)) {
          throw new AppError(409, "A referenced unique value cannot be cleared. Remove its references first.");
        }
      }
      if (form.fields.every((field) => (values[field.id] ?? null) === (previous.values[field.id] ?? null))) return { record: previous, changed: false };
      writeUniqueValues(form.id, id, form.fields, values);
      const now = new Date().toISOString();
      db.prepare("UPDATE records SET values_json = ?, updated_at = ?, version = version + 1 WHERE id = ?").run(JSON.stringify(values), now, id);
      const record = getRecord(id);
      recordChange(form, record, "updated", previous.values, values, now);
      return { record, changed: true };
    });
  }

  function deleteRecord(id, body) {
    return transaction(() => {
      const record = getRecord(id);
      const form = getForm(record.formId);
      if (body?.version !== record.version) throw new AppError(409, "This record was changed in another window. Refresh and try again.");
      for (const { form: source, field } of inboundReferences(form.id)) {
        if (listRecords(source.id).some((row) => row.values[field.id] === id)) {
          throw new AppError(409, `This record is referenced by "${source.name}". Remove its references before deleting it.`);
        }
      }
      const now = new Date().toISOString();
      db.prepare("UPDATE records SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?").run(now, now, id);
      db.prepare("DELETE FROM unique_values WHERE record_id = ?").run(id);
      recordChange(form, record, "deleted", record.values, {}, now);
      return { id };
    });
  }

  function listChanges(formId) {
    getForm(formId);
    return db.prepare("SELECT * FROM form_activity WHERE form_id = ? ORDER BY created_at DESC, rowid DESC").all(formId).map((row) => ({
      id: row.id, recordId: row.record_id, recordTitle: row.record_title,
      kind: row.kind, diff: JSON.parse(row.diff_json), createdAt: row.created_at,
    }));
  }

  function bootstrap(formId) {
    const forms = listForms();
    const form = getForm(formId || forms[0].id);
    return { forms, form, records: listRecords(form.id), changes: listChanges(form.id), fieldTypes: FIELD_TYPES, modules: MODULES,
      meetingTableId: db.prepare("SELECT form_id FROM module_tables WHERE module_id = 'meetings'").get()?.form_id || null,
      references: referenceCatalog(), meetings: listMeetings() };
  }

  function listMeetings() {
    return db.prepare("SELECT * FROM meeting_imports ORDER BY created_at DESC, rowid DESC LIMIT 50").all().map((row) => ({
      id: row.id, title: row.title, date: row.meeting_date, formId: row.form_id,
      committed: row.result_json !== null, itemCount: JSON.parse(row.result_json || row.items_json).length, createdAt: row.created_at,
    }));
  }

  function saveExtraction(form, meeting, items) {
    if (getForm(form.id).version !== form.version) throw new AppError(409, "The table changed during extraction. Extract again using its current fields.");
    const id = randomUUID();
    db.prepare(`INSERT INTO meeting_imports
      (id, form_id, title, meeting_date, source_text, schema_version, items_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, form.id, meeting.title, meeting.date, meeting.text, form.version, JSON.stringify(items), new Date().toISOString());
    return getExtraction(id);
  }

  function getExtraction(id) {
    const row = db.prepare("SELECT * FROM meeting_imports WHERE id = ?").get(id);
    if (!row) throw new AppError(404, "Meeting import not found.");
    return { id: row.id, formId: row.form_id, title: row.title, date: row.meeting_date, text: row.source_text,
      schemaVersion: row.schema_version, items: JSON.parse(row.items_json), recordIds: row.result_json ? JSON.parse(row.result_json) : null };
  }

  function commitExtraction(id, body) {
    return transaction(() => {
      const draft = getExtraction(id);
      if (draft.recordIds) return { recordIds: draft.recordIds, alreadySaved: true };
      if (!Array.isArray(body?.items) || !body.items.length || body.items.length > 50) fail("Select 1-50 action items to save.");
      const indexes = new Set();
      const recordIds = body.items.map((item) => {
        if (!item || !Number.isInteger(item.index) || !draft.items[item.index] || indexes.has(item.index)) fail("Invalid action-item selection.");
        indexes.add(item.index);
        const { record } = insertRecord(draft.formId, { schemaVersion: draft.schemaVersion, values: item.values });
        db.prepare("INSERT INTO meeting_items (record_id, import_id, evidence) VALUES (?, ?, ?)").run(record.id, id, draft.items[item.index].evidence);
        return record.id;
      });
      db.prepare("UPDATE meeting_imports SET result_json = ? WHERE id = ?").run(JSON.stringify(recordIds), id);
      return { recordIds, alreadySaved: false };
    });
  }
  function getAIConfig() {
    const row = db.prepare("SELECT * FROM ai_settings WHERE id = 1").get();
    return row ? { providerName: row.provider_name, baseUrl: row.base_url, apiKey: row.api_key, model: row.model } : null;
  }

  function saveAIConfig(config) {
    db.prepare(`INSERT INTO ai_settings (id, provider_name, base_url, api_key, model) VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET provider_name = excluded.provider_name, base_url = excluded.base_url,
      api_key = excluded.api_key, model = excluded.model`).run(config.providerName, config.baseUrl, config.apiKey, config.model);
  }

  return { getForm, listForms, createForm, updateForm, listRecords, getRecord, createRecord, updateRecord, deleteRecord, listChanges,
    getAIConfig, saveAIConfig,
    referenceCatalog, ensureMeetingTable, saveExtraction, getExtraction, commitExtraction, bootstrap, close: () => db.close() };
}
