import { createHash, randomBytes } from "node:crypto";
import { AppError } from "./errors.js";
import { normalizeValues } from "./field-types.js";

const object = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const string = { type: "string" };
const version = { type: "integer", minimum: 1 };
const values = { type: "object", additionalProperties: true };
const field = object({
  id: string, name: string, type: { type: "string", enum: ["text", "longtext", "number", "date", "datetime", "select", "checkbox", "reference"] },
  required: { type: "boolean" }, unique: { type: "boolean" }, options: { type: "array", items: string },
  reference: object({ formId: string, fieldId: string }, ["formId", "fieldId"]),
}, ["id", "name", "type", "required", "unique"]);
const definitions = [
  ["list_forms", "List all tables, field schemas and record counts.", object({})],
  ["get_form", "Read a table schema and its current version.", object({ formId: string }, ["formId"])],
  ["query_records", "Search and filter records. Filters use field IDs; references store record IDs. All filters are ANDed.", object({
    formId: string, q: string, limit: { type: "integer", minimum: 1, maximum: 100 }, offset: { type: "integer", minimum: 0 },
    filters: { type: "array", maxItems: 20, items: object({
      fieldId: string, operator: { type: "string", enum: ["eq", "ne", "contains", "gt", "gte", "lt", "lte", "is_empty"] },
      value: { type: ["string", "number", "boolean", "null"] },
    }, ["fieldId", "operator"]) },
    sort: object({ fieldId: string, direction: { type: "string", enum: ["asc", "desc"] } }, ["fieldId", "direction"]),
  }, ["formId"])],
  ["get_record", "Read a record and its version before editing it.", object({ recordId: string }, ["recordId"])],
  ["create_record", "Propose a record using field IDs and the current schemaVersion. Required fields must be supplied.", object({
    formId: string, schemaVersion: version, values,
  }, ["formId", "schemaVersion", "values"])],
  ["update_record", "Propose a partial record edit with the read record version and schemaVersion. Preserve other values.", object({
    recordId: string, schemaVersion: version, version, values,
  }, ["recordId", "schemaVersion", "version", "values"])],
  ["delete_record", "Propose deletion of one record, retaining activity history.", object({
    recordId: string, schemaVersion: version, version,
  }, ["recordId", "schemaVersion", "version"])],
  ["create_form", "Propose a custom table. Supply stable field IDs, names, types, required/unique rules; select needs options and reference needs a unique target field.", object({
    name: string, moduleId: { type: "string", enum: ["orders", "meetings", "suppliers"] }, fields: { type: "array", items: field, minItems: 1, maxItems: 40 },
  }, ["name", "fields"])],
  ["update_form", "Propose a complete replacement schema and table name at the current version. Keep existing field IDs. Removed fields disappear from the active schema; stored historical values are retained.", object({
    formId: string, version, name: string, fields: { type: "array", items: field, minItems: 1, maxItems: 40 },
  }, ["formId", "version", "name", "fields"])],
];
export const AGENT_TOOLS = definitions.map(([name, description, parameters]) => ({
  type: "function", function: { name, description, parameters, strict: false },
}));
const writes = new Set(["create_record", "update_record", "delete_record", "create_form", "update_form"]);
export const isWriteOperation = (name) => writes.has(name);
const hash = (text) => createHash("sha256").update(text).digest("hex");
const stable = (value) => JSON.stringify(value, (_, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const modes = new Set(["review", "full"]);
function validateMode(mode) {
  if (!modes.has(mode)) throw new AppError(400, "Choose review or full access.");
  return mode;
}
function argsFor(name, args) {
  const definition = definitions.find(([id]) => id === name);
  if (!definition) throw new AppError(400, "Unknown agent operation.");
  const schema = definition[2];
  if (!args || typeof args !== "object" || Array.isArray(args) ||
    Object.keys(args).some((key) => !Object.hasOwn(schema.properties, key)) ||
    schema.required.some((key) => !Object.hasOwn(args, key))) throw new AppError(400, "Invalid operation arguments.");
  for (const [key, value] of Object.entries(args)) {
    const type = schema.properties[key].type;
    if ((type === "string" && (typeof value !== "string" || (key !== "q" && !value.trim()) || value.length > 1000)) ||
      (type === "integer" && (!Number.isSafeInteger(value) || value < (schema.properties[key].minimum ?? 0))) ||
      (type === "object" && (!value || typeof value !== "object" || Array.isArray(value))) ||
      (type === "array" && !Array.isArray(value))) throw new AppError(400, `Invalid ${key}.`);
  }
  if (JSON.stringify(args).length > 100000) throw new AppError(413, "Operation arguments are too large.");
  return structuredClone(args);
}

export function queryRecords(store, args) {
  const form = store.getForm(args.formId);
  const { q = "", limit = 50, offset = 0, filters = [], sort } = args;
  if (typeof q !== "string" || q.length > 500 || !Number.isInteger(limit) || limit < 1 || limit > 100 ||
    !Number.isSafeInteger(offset) || offset < 0 || !Array.isArray(filters) || filters.length > 20) throw new AppError(400, "Invalid query or pagination.");
  const checked = filters.map((filter) => {
    const field = form.fields.find((item) => item.id === filter?.fieldId);
    if (!field || Object.keys(filter).some((key) => !["fieldId", "operator", "value"].includes(key))) throw new AppError(400, "Filter must name an existing field.");
    const op = filter.operator;
    if (!["eq", "ne", "contains", "gt", "gte", "lt", "lte", "is_empty"].includes(op)) throw new AppError(400, "Unsupported filter operator.");
    if (op === "is_empty") return { field, op };
    if (!Object.hasOwn(filter, "value")) throw new AppError(400, "Filter value is required.");
    if (op === "contains" && !["text", "longtext", "select"].includes(field.type)) throw new AppError(400, "Contains requires a text or dropdown field.");
    if (["gt", "gte", "lt", "lte"].includes(op) && !["number", "date", "datetime"].includes(field.type)) throw new AppError(400, "Range filters require a number or date field.");
    if (op === "contains") {
      if (typeof filter.value !== "string" || filter.value.length > 1000) throw new AppError(400, "Contains requires a text value.");
      return { field, op, value: filter.value.toLowerCase() };
    }
    const value = normalizeValues({ [field.id]: filter.value }, [{ ...field, required: false }])[field.id];
    return { field, op, value: typeof value === "string" ? value.toLowerCase() : value };
  });
  const search = q.toLowerCase().trim();
  let records = store.listRecords(form.id).filter((record) => {
    if (search && !form.fields.some((field) => {
      let value = record.values[field.id];
      if (field.type === "reference" && value) {
        try { value = store.getRecord(value).values[field.reference.fieldId]; } catch { value = ""; }
      }
      return String(value ?? "").toLowerCase().includes(search);
    })) return false;
    return checked.every(({ field, op, value }) => {
      const raw = record.values[field.id] ?? null;
      const actual = typeof raw === "string" ? raw.toLowerCase() : raw;
      if (op === "is_empty") return actual === null || actual === "";
      if (op === "eq") return actual === value;
      if (op === "ne") return actual !== value;
      if (op === "contains") return String(actual ?? "").includes(value);
      if (actual === null || value === null) return false;
      return { gt: actual > value, gte: actual >= value, lt: actual < value, lte: actual <= value }[op];
    });
  });
  if (sort) {
    if (!form.fields.some((field) => field.id === sort.fieldId) || !["asc", "desc"].includes(sort.direction)) throw new AppError(400, "Invalid sort field or direction.");
    records = records.sort((a, b) => {
      const x = a.values[sort.fieldId], y = b.values[sort.fieldId];
      const compared = x == null ? (y == null ? 0 : -1) : y == null ? 1 : typeof x === "number" ? x - y : String(x).localeCompare(String(y));
      return compared * (sort.direction === "asc" ? 1 : -1) || a.id.localeCompare(b.id);
    });
  }
  return { formId: form.id, schemaVersion: form.version, total: records.length, limit, offset,
    records: records.slice(offset, offset + limit), hasMore: offset + limit < records.length };
}

export function createAgentOperations(store) {
  const repo = store.agent;
  const recordFingerprint = (formId) => hash(stable(store.listRecords(formId).map(({ id, version, values }) => ({ id, version, values })).sort((a, b) => a.id.localeCompare(b.id))));
  function execute(operation, args) {
    switch (operation) {
      case "list_forms": return store.listForms();
      case "get_form": return store.getForm(args.formId);
      case "query_records": return queryRecords(store, args);
      case "get_record": return store.getRecord(args.recordId);
      case "create_form": return store.createForm(args);
      case "update_form": return store.updateForm(args.formId, args);
      case "create_record": return store.createRecord(args.formId, args);
      case "update_record": return store.updateRecord(args.recordId, args);
      case "delete_record": {
        const form = store.getForm(store.getRecord(args.recordId).formId);
        if (form.version !== args.schemaVersion) throw new AppError(409, "The form schema changed. Read it again before deleting.");
        return store.deleteRecord(args.recordId, args);
      }
    }
  }
  function makePreview(operation, args) {
    if (operation === "create_form" || operation === "update_form") {
      const before = operation === "update_form" ? store.getForm(args.formId) : null;
      const oldRecords = before ? store.listRecords(before.id) : [];
      const fingerprint = before ? recordFingerprint(before.id) : null;
      const after = execute(operation, args);
      const recordChanges = before ? store.listRecords(before.id).flatMap((row) => {
        const previous = oldRecords.find((old) => old.id === row.id);
        const visibleBefore = Object.fromEntries(before.fields.map((field) => [field.id, previous.values[field.id] ?? null]));
        const visibleAfter = Object.fromEntries(after.fields.map((field) => [field.id, row.values[field.id] ?? null]));
        return stable(visibleBefore) === stable(visibleAfter) ? [] : [{ recordId: row.id, before: visibleBefore, after: visibleAfter }];
      }) : [];
      return { title: `${before ? "Edit" : "Create"} table: ${after.name}`, formId: before?.id ?? null,
        before: before ? { name: before.name, fields: before.fields } : null, after: { name: after.name, fields: after.fields },
        affectedRecords: oldRecords.length, changedRecordCount: recordChanges.length, recordChanges: recordChanges.slice(0, 20), fingerprint };
    }
    const before = operation === "create_record" ? null : store.getRecord(args.recordId);
    const form = store.getForm(before?.formId ?? args.formId);
    const result = execute(operation, args);
    const after = result.record ?? null;
    const diff = form.fields.filter((field) => (before?.values[field.id] ?? null) !== (after?.values[field.id] ?? null))
      .map((field) => {
        const referenceLabel = (id) => id ? String(store.getRecord(id).values[field.reference.fieldId]) : null;
        return { fieldId: field.id, name: field.name, type: field.type, reference: field.reference,
          before: before?.values[field.id] ?? null, after: after?.values[field.id] ?? null,
          ...(field.type === "reference" ? { beforeLabel: referenceLabel(before?.values[field.id]), afterLabel: referenceLabel(after?.values[field.id]) } : {}) };
      });
    return { title: `${operation === "create_record" ? "Create" : operation === "delete_record" ? "Delete" : "Update"} record in ${form.name}`,
      formId: form.id, recordId: before?.id ?? null, diff, noChange: result.changed === false };
  }
  function apply(action) {
    if (action.status === "applied") return action;
    if (action.status !== "pending") throw new AppError(409, `This action is ${action.status}.`);
    if (Date.now() - Date.parse(action.createdAt) > 86400000) throw new AppError(409, "This preview expired. Request a fresh preview.");
    if (action.operation === "update_form" && recordFingerprint(action.args.formId) !== action.preview.fingerprint) {
      throw new AppError(409, "Table records changed since this preview. Request a fresh preview.");
    }
    const result = execute(action.operation, action.args);
    return repo.resolveAction(action.id, "applied", result);
  }
  return {
    getMode: () => repo.getSetting("assistant-mode", "review"),
    setMode(mode) { repo.setSetting("assistant-mode", validateMode(mode)); return { mode }; },
    createToken({ name, mode = "review" }) {
      if (typeof name !== "string" || !name.trim() || name.trim().length > 80) throw new AppError(400, "Token name must contain 1-80 characters.");
      validateMode(mode);
      if (repo.listTokens().filter((token) => !token.revokedAt).length >= 20) throw new AppError(400, "Revoke an unused token first (maximum 20 active tokens).");
      const token = `rlf_${randomBytes(32).toString("base64url")}`;
      return { ...repo.insertToken({ name: name.trim(), mode, hash: hash(token), prefix: token.slice(0, 12) }), token };
    },
    updateToken(id, mode) { return repo.updateToken(id, validateMode(mode)); },
    authenticate(header) {
      if (typeof header !== "string" || !/^Bearer rlf_[A-Za-z0-9_-]{43}$/.test(header)) throw new AppError(401, "A valid Agent Bearer token is required.");
      const token = repo.findToken(hash(header.slice(7)));
      if (!token) throw new AppError(401, "Agent token is invalid or revoked.");
      return token;
    },
    run(operation, input, actor, requestKey) {
      const args = argsFor(operation, input);
      if (!writes.has(operation)) return execute(operation, args);
      if (typeof requestKey !== "string" || !requestKey.trim() || requestKey.length > 200) throw new AppError(400, "Supply an Idempotency-Key of 1-200 characters for writes.");
      return store.transaction(() => {
        const existing = repo.findAction(actor.id, requestKey);
        if (existing) {
          if (existing.operation !== operation || stable(existing.args) !== stable(args)) throw new AppError(409, "This idempotency key was already used for a different action.");
          return existing;
        }
        if (repo.listActions({ pending: true }).length >= 100) throw new AppError(409, "Resolve pending approvals before proposing more changes.");
        const preview = store.preview(() => makePreview(operation, args));
        const action = repo.insertAction({ actorId: actor.id, actorName: actor.name, requestKey, operation, args, preview });
        const mode = actor.type === "chat" ? repo.getSetting("assistant-mode", "review") : repo.listTokens().find((token) => token.id === actor.id && !token.revokedAt)?.mode;
        if (!mode) throw new AppError(401, "Agent token is invalid or revoked.");
        return mode === "full" ? apply(action) : action;
      });
    },
    approve(id) {
      try { return store.transaction(() => apply(repo.getAction(id))); }
      catch (error) {
        if (repo.getAction(id).status === "pending") repo.resolveAction(id, "failed", null, error.message);
        throw error;
      }
    },
    reject(id) {
      return store.transaction(() => {
        const action = repo.getAction(id);
        if (action.status === "rejected") return action;
        if (action.status !== "pending") throw new AppError(409, `This action is ${action.status}.`);
        return repo.resolveAction(id, "rejected");
      });
    },
  };
}
