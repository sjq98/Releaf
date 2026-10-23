import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { AppError } from "./errors.js";
import { normalizeField, validateFields } from "./field-types.js";

export const fingerprint = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");

export function decodeFile(file, allowed) {
  if (!file || typeof file.name !== "string" || !file.name.trim() || file.name.length > 180 ||
      typeof file.data !== "string" || !/^[a-zA-Z0-9+/]*={0,2}$/.test(file.data) || file.data.length % 4 !== 0) {
    throw new AppError(400, "Choose a valid file.");
  }
  const extension = file.name.split(".").pop().toLowerCase();
  if (!allowed.includes(extension)) throw new AppError(400, `Supported file types: ${allowed.join(", ")}.`);
  const bytes = Buffer.from(file.data, "base64");
  if (!bytes.length || bytes.length > 5 * 1024 * 1024) throw new AppError(400, "Choose a file up to 5 MB.");
  return { name: file.name.trim(), extension, bytes };
}

export async function parseTableFile(file) {
  const { name, extension, bytes } = decodeFile(file, ["xlsx", "csv"]);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./table-import-worker.js", import.meta.url), {
      workerData: { extension, bytes }, resourceLimits: { maxOldGenerationSizeMb: 192 },
    });
    const timer = setTimeout(() => { worker.terminate(); reject(new AppError(400, "Workbook processing timed out. Use a smaller, simpler workbook.")); }, 15000);
    worker.once("message", (result) => {
      clearTimeout(timer);
      worker.terminate();
      if (result.error) reject(new AppError(400, result.error));
      else resolve({ name, ...result });
    });
    worker.once("error", () => { clearTimeout(timer); reject(new AppError(400, "Could not read this workbook. Use a smaller, valid XLSX or UTF-8 CSV file.")); });
    worker.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new AppError(400, "Workbook processing stopped. Use a smaller, valid file."));
    });
  });
}

function convertCell(value, field, store, referenceCache) {
  if (value === null || value === undefined || value === "") return field.type === "checkbox" ? false : null;
  if (field.type === "number") {
    const text = String(value).trim();
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) throw new Error("Use an unambiguous numeric value without currency or thousands separators.");
    value = Number(text);
  } else if (field.type === "checkbox") {
    if (typeof value !== "boolean") {
      const text = String(value).trim().toLowerCase();
      if (!["true", "false", "yes", "no", "1", "0"].includes(text)) throw new Error("Use true/false, yes/no or 1/0.");
      value = ["true", "yes", "1"].includes(text);
    }
  } else if (field.type === "reference") {
    const cacheKey = JSON.stringify(field.reference);
    const lookupKey = (value) => `${typeof value}:${typeof value === "string" ? value.toLowerCase() : String(value)}`;
    if (!referenceCache.has(cacheKey)) {
      const targetField = store.getForm(field.reference.formId).fields.find((item) => item.id === field.reference.fieldId);
      const records = new Map(store.listRecords(field.reference.formId).filter((record) => record.values[field.reference.fieldId] != null)
        .map((record) => [lookupKey(record.values[field.reference.fieldId]), record.id]));
      referenceCache.set(cacheKey, { targetField, records });
    }
    const { targetField, records } = referenceCache.get(cacheKey);
    const key = convertCell(value, { ...targetField, required: true }, store, referenceCache);
    if (!records.has(lookupKey(key))) throw new Error("No matching unique value in the referenced table.");
    value = records.get(lookupKey(key));
  } else {
    value = String(value);
    if (field.type === "date" && /^\d{4}-\d{2}-\d{2}T/.test(value)) value = value.slice(0, 10);
    if (field.type === "datetime" && /^\d{4}-\d{2}-\d{2}T/.test(value)) value = value.slice(0, 16);
  }
  return normalizeField(field, value);
}

export function createTableImport(store) {
  const repo = store.imports;
  function prepare(body) {
    if (!Array.isArray(body?.rows) || !body.rows.length || body.rows.length > 1000 ||
        body.rows.some((row) => !Array.isArray(row) || row.length > 40 ||
          row.some((cell) => cell !== null && !["string", "number", "boolean"].includes(typeof cell) ||
            typeof cell === "string" && cell.length > 5000))) throw new AppError(400, "Import 1-1,000 rows with up to 40 columns and 5,000 characters per cell.");
    const existing = Boolean(body.formId);
    const fields = existing ? store.getForm(body.formId).fields : validateFields(body.fields);
    const form = existing ? store.getForm(body.formId) : { name: body.name, moduleId: body.moduleId, spaceId: body.spaceId ?? "default", parentId: body.parentId, fields };
    if (existing && body.schemaVersion !== form.version) throw new AppError(409, "The target table changed. Reload the import.");
    if (!body.mapping || typeof body.mapping !== "object" || Array.isArray(body.mapping) ||
        Object.entries(body.mapping).some(([id, col]) => !fields.some((field) => field.id === id && !field.formula) || !Number.isInteger(col) || col < 0 || col > 39)) {
      throw new AppError(400, "Choose valid column mappings.");
    }
    const referenceCache = new Map();
    const rows = body.rows.map((row) => {
      const values = {}, errors = {};
      for (const field of fields) {
        if (field.formula) continue;
        try { values[field.id] = convertCell(Object.hasOwn(body.mapping, field.id) ? row[body.mapping[field.id]] : null, field, store, referenceCache); }
        catch (error) { errors[field.id] = error.message; }
      }
      return { values, errors };
    });
    const key = fingerprint({ target: existing ? form.id : { name: form.name, moduleId: form.moduleId, spaceId: form.spaceId, fields }, rows: rows.map((row) => row.values) });
    if (repo.duplicate("table", key)) throw new AppError(409, "These rows have already been imported into this table. No records were added.");
    const errors = [];
    const dependencyFingerprint = store.automation.fingerprint(form.spaceId);
    const effects = store.preview(() => {
      const target = existing ? form : store.createForm(form);
      rows.forEach((row, index) => {
        if (Object.keys(row.errors).length) { errors.push({ row: index + 1, fields: row.errors }); return; }
        try { store.createRecord(target.id, { schemaVersion: target.version, values: row.values }); }
        catch (error) { errors.push({ row: index + 1, fields: error.fields, message: error.message }); }
      });
      return store.automation.changes();
    });
    return { existing, form, rows: rows.map((row) => row.values), errors, fingerprint: key,
      effects, dependencyFingerprint,
      fileName: typeof body.fileName === "string" ? body.fileName.slice(0, 180) : "", sheetName: typeof body.sheetName === "string" ? body.sheetName.slice(0, 80) : "" };
  }
  return {
    preview(body) {
      const draft = prepare(body);
      const saved = repo.saveDraft("table", draft, draft.fingerprint);
      return { id: saved.id, form: draft.form, rows: draft.rows, errors: draft.errors, effects: draft.effects, validCount: draft.rows.length - draft.errors.length };
    },
    commit(id) {
      return store.transaction(() => {
        const draft = repo.draft(id, "table");
        if (draft.result) return { ...draft.result, alreadySaved: true };
        const data = draft.payload;
        if (data.errors.length) throw new AppError(400, "Correct all row errors and preview the import again.");
        if (repo.duplicate("table", draft.fingerprint)) throw new AppError(409, "These rows have already been imported.");
        if (data.dependencyFingerprint && store.automation.fingerprint(data.form.spaceId ?? "default") !== data.dependencyFingerprint) throw new AppError(409, "The target schema, automation rules, or related records changed. Preview the import again.");
        const form = data.existing ? store.getForm(data.form.id) : store.createForm(data.form);
        if (data.existing && form.version !== data.form.version) throw new AppError(409, "The target schema changed. Preview the import again.");
        const recordIds = data.rows.map((values) => store.createRecord(form.id, { schemaVersion: form.version, values }).record.id);
        const result = { formId: form.id, recordIds };
        repo.finishDraft(id, result);
        return result;
      });
    },
  };
}
