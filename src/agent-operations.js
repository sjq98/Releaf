import { createHash, randomBytes } from "node:crypto";
import { AppError } from "./errors.js";
import { normalizeValues } from "./field-types.js";
import { MODULES } from "./modules.js";

const object = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const string = { type: "string" };
const version = { type: "integer", minimum: 1 };
const values = { type: "object", additionalProperties: true };
const field = object({
  id: string, name: string, type: { type: "string", enum: ["text", "longtext", "number", "date", "datetime", "select", "checkbox", "reference", "attachment"] },
  required: { type: "boolean" }, unique: { type: "boolean" }, options: { type: "array", items: string },
  reference: object({ formId: string, fieldId: string }, ["formId", "fieldId"]),
  formula: values,
}, ["id", "name", "type", "required", "unique"]);
const inventoryLines = { type: "array", maxItems: 100, items: values };
const importArgs = { fileId: string, sheetIndex: { type: "integer" }, mapping: values, kind: { type: "string", enum: ["inbound", "outbound"] }, values,
  stage: { type: "string", enum: ["draft", "submit", "post"] }, actor: string, approvalActor: string };
const definitions = [
  ["upload_inventory_file", "Upload an XLSX or UTF-8 CSV with base64 file.data and file.name, up to 5 MB. Upload stores the source file only; it does not change business records or start workflows. Returns fileId as id, worksheets, headers and samples. Use match_inventory_file next.", object({ spaceId: string, file: values }, ["file"])],
  ["get_inventory_file", "Read an uploaded spreadsheet's worksheet headers and samples within the authorized Space.", object({ fileId: string }, ["fileId"])],
  ["match_inventory_file", "Match spreadsheet headers and product records. Resolve exact product codes first, or unambiguous names; report row errors. Optional mapping uses zero-based column indices or null to ignore a field. Does not write business data.", object({ ...importArgs, linesOnly: { type: "boolean" } }, ["fileId"])],
  ["preview_inventory_import", "Validate and preview a whole spreadsheet batch. stage=draft saves drafts; submit starts approval; post explicitly approves and posts using approvalActor matching each assigned approver. Default submit. Returns fingerprint, matched requests and errors. Never invent operators or silently choose post.", object(importArgs, ["fileId"])],
  ["execute_inventory_import", "Execute the exact validated spreadsheet batch with its preview fingerprint. Atomic, duplicate protected, and subject to Agent review/full access. All workflow validations still apply.", object({ ...importArgs, fingerprint: string }, ["fileId", "fingerprint"])],
  ["save_inventory_catalog", "Use the catalog workflow to register or maintain products, warehouses or stock settings. Warehouse forms are read-only through generic CRUD. Products need code/name/unit; stock settings need product and warehouse IDs and optional minimum/openingQuantity. Updates need recordId and version.", object({ spaceId: string, role: { type: "string", enum: ["products", "warehouses", "stock"] }, recordId: string, version, values }, ["role", "values"])],
  ["upload_attachment", "Upload a PDF, PNG or JPEG for a record using base64 file.data and file.name. Follows the same validation and review mode as user uploads; use the returned ID in attachment fields. PDF images may contain up to six rendered data-URL pages.", object({ spaceId: string, file: values, images: { type: "array", items: string } }, ["file"])],
  ["get_attachment", "Read an attachment and its base64 content within the authorized Space.", object({ attachmentId: string }, ["attachmentId"])],
  ["setup_inventory_workspace", "Install the fixed warehouse tables and workflows in a Space, as the Set up warehouse button. Idempotent; keeps existing records.", object({ spaceId: string })],
  ["list_navigation", "Read the Space navigation tree.", object({ spaceId: string })],
  ["create_navigation_node", "Create a display node in the Space.", object({ spaceId: string, name: string, parentId: { type: ["string", "null"] } }, ["name"])],
  ["update_navigation_node", "Rename or move a node with the same UI validation.", object({ nodeId: string, name: string, parentId: { type: ["string", "null"] }, position: { type: "integer" } }, ["nodeId"])],
  ["move_navigation_node", "Move a node and its complete subtree before, after or inside another node.", object({ nodeId: string, targetId: { type: ["string", "null"] }, placement: { type: "string", enum: ["before", "after", "inside"] } }, ["nodeId", "targetId", "placement"])],
  ["delete_navigation_node", "Delete an empty display node. Cannot delete forms or nonempty folders.", object({ nodeId: string }, ["nodeId"])],
  ["list_notifications", "List notifications in this Space.", object({ spaceId: string })],
  ["mark_notification_read", "Mark a notification as read.", object({ notificationId: string, spaceId: string }, ["notificationId"])],
  ["resolve_error", "Change an Error Center item status.", object({ errorId: string, spaceId: string, status: { type: "string", enum: ["Resolved", "Unresolved", "Ignored"] } }, ["errorId", "status"])],
  ["create_ai_task", "Create a configurable AI processing task using the same definition as the UI.", object({ definition: values }, ["definition"])],
  ["update_ai_task", "Update an AI processing task definition with its current version.", object({ taskId: string, definition: values }, ["taskId", "definition"])],
  ["delete_ai_task", "Delete a task without run history.", object({ taskId: string, version }, ["taskId", "version"])],
  ["list_ai_runs", "Read the processing history in a Space.", object({ spaceId: string })],
  ["preview_ai_run", "Preview the data changes produced by an AI task.", object({ runId: string }, ["runId"])],
  ["apply_ai_run", "Apply reviewed AI output using a fresh fingerprint from preview_ai_run.", object({ runId: string, fingerprint: string }, ["runId", "fingerprint"])],
  ["retry_ai_run", "Retry a failed or stale AI run.", object({ runId: string }, ["runId"])],
  ["cancel_ai_run", "Cancel a queued or reviewable AI run.", object({ runId: string }, ["runId"])],
  ["list_forms", "List tables, field schemas and record counts within a Space.", object({ spaceId: string })],
  ["list_spaces", "List available Spaces. Tokens only see their own Space.", object({})],
  ["get_form", "Read a table schema and its current version.", object({ formId: string }, ["formId"])],
  ["query_records", "Search and filter records. Filters use field IDs; references store record IDs. All filters are ANDed.", object({
    formId: string, q: string, condition: values, limit: { type: "integer", minimum: 1, maximum: 100 }, offset: { type: "integer", minimum: 0 },
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
    name: string, spaceId: string, parentId: { type: ["string", "null"] }, moduleId: { type: "string", enum: MODULES.map((module) => module.id) }, fields: { type: "array", items: field, minItems: 1, maxItems: 40 },
  }, ["name", "fields"])],
  ["update_form", "Propose a complete replacement schema and table name at the current version. Keep existing field IDs. Removed fields disappear from the active schema; stored historical values are retained.", object({
    formId: string, version, name: string, fields: { type: "array", items: field, minItems: 1, maxItems: 40 },
  }, ["formId", "version", "name", "fields"])],
  ["preview_form_deletion", "Read form name, affected record count and dependency blockers before proposing deletion. Warehouse system forms cannot be deleted.", object({ formId: string }, ["formId"])],
  ["delete_form", "Propose deleting a custom form and its active records from the workspace. Always requires local human confirmation, even in full access. Supply version from get_form. Dependencies and warehouse system forms are protected; historical data is retained.", object({ formId: string, version }, ["formId", "version"])],
  ["list_notification_rules", "Read same-form notification rules in a Space.", object({ spaceId: string, formId: string })],
  ["create_notification_rule",  "Propose a same-form notification rule. Only one notify action is supported; cross-form actions are built in and not configurable.", object({ definition: values }, ["definition"])],
  ["update_notification_rule", "Propose a full automation definition with its current version.", object({ ruleId: string, definition: values }, ["ruleId", "definition"])],
  ["delete_notification_rule", "Propose removing an automation rule.", object({ ruleId: string, version }, ["ruleId", "version"])],
  ["list_ai_tasks", "Discover configurable AI tasks in a Space.", object({ spaceId: string })],
  ["start_ai_task", "Queue an AI task using a saved input record. Results may require later review.", object({ taskId: string, recordId: string }, ["taskId", "recordId"])],
  ["get_ai_run", "Read AI task state, structured output and proposed changes.", object({ runId: string }, ["runId"])],
  ["list_errors", "Read processing errors for a Space.", object({ spaceId: string })],
  ["get_inventory_workspace", "Discover warehouse form IDs, managed fields, two workflows and recent stock movements in a Space. Use query_records to resolve warehouse and product IDs.", object({ spaceId: string })],
  ["get_inventory_request", "Read an inbound/outbound document, its product lines, current version and workflow events.", object({ recordId: string }, ["recordId"])],
  ["create_inventory_request", "Create one inbound/outbound document with all lines atomically. values: warehouse record ID, applicant, approver, optional type/applicationDate/notes/photos. lines: product catalog record ID (not stock ID), quantity, optional notes. Set submit=true to start approval. First inbound posting creates missing warehouse stock. No stock changes until approved and posted. Do not invent missing business values.", object({ spaceId: string, kind: { type: "string", enum: ["inbound", "outbound"] }, values, lines: inventoryLines, submit: { type: "boolean" }, actor: string }, ["kind", "values", "lines"])],
  ["update_inventory_request", "Replace a draft/rejected document's complete line list. Existing lines need id and version; omitted lines are deleted. Header values are a partial update. Workflow-managed fields cannot be edited.", object({ recordId: string, version, values, lines: inventoryLines }, ["recordId", "version", "values", "lines"])],
  ["advance_inventory_request", "Submit, approve, reject, cancel, post or reverse a warehouse request using the same rules as the UI. Requires its current version and operator name; approval/rejection require the assigned approver; reject/cancel/reverse need a reason. Agent review/full access is separate from the document workflow status.", object({ recordId: string, version, action: { type: "string", enum: ["submit", "approve", "reject", "cancel", "post", "reverse"] }, actor: string, note: string, date: string }, ["recordId", "version", "action", "actor"])],
];
export const AGENT_TOOLS = definitions.map(([name, description, parameters]) => ({
  type: "function", function: { name, description, parameters, strict: false },
}));
const writes = new Set(["upload_attachment", "setup_inventory_workspace", "create_navigation_node", "update_navigation_node", "move_navigation_node", "delete_navigation_node", "mark_notification_read", "resolve_error", "create_ai_task", "update_ai_task", "delete_ai_task", "apply_ai_run", "retry_ai_run", "cancel_ai_run", "create_record", "update_record", "delete_record", "create_form", "update_form", "delete_form", "create_notification_rule", "update_notification_rule", "delete_notification_rule", "start_ai_task", "create_inventory_request", "update_inventory_request", "advance_inventory_request"]);
writes.add("save_inventory_catalog");
writes.add("execute_inventory_import");
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
    if (schema.properties[key].enum && !schema.properties[key].enum.includes(value) || type === "boolean" && typeof value !== "boolean") throw new AppError(400, `Invalid ${key}.`);
    if ((type === "string" && (typeof value !== "string" || (key !== "q" && !value.trim()) || value.length > 1000)) ||
      (type === "integer" && (!Number.isSafeInteger(value) || value < (schema.properties[key].minimum ?? 0))) ||
      (type === "object" && (!value || typeof value !== "object" || Array.isArray(value))) ||
      (type === "array" && !Array.isArray(value))) throw new AppError(400, `Invalid ${key}.`);
  }
  if (JSON.stringify(args).length > (["upload_attachment", "upload_inventory_file"].includes(name) ? 24 * 1024 * 1024 : 100000)) throw new AppError(413, "Operation arguments are too large.");
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
  if (args.condition) store.automation.validateCondition(args.condition, form, form, form.spaceId);
  let records = store.listRecords(form.id).filter((record) => {
    if (args.condition) {
      if (!store.automation.test(args.condition, { event: { before: record.values, after: record.values }, target: record, spaceId: form.spaceId })) return false;
    }
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
  const auth = store.auth;
  const currentUser = () => auth?.currentUser?.() ?? null;
  const hasAuthUser = () => Boolean(currentUser());
  const isAdmin = () => !hasAuthUser() || currentUser().role === "admin";
  const currentUserId = () => currentUser()?.id ?? null;
  const adminOperations = new Set([
    "create_form", "update_form", "delete_form", "create_record", "update_record", "delete_record",
    "create_navigation_node", "update_navigation_node", "move_navigation_node", "delete_navigation_node",
    "resolve_error", "setup_inventory_workspace", "create_ai_task", "update_ai_task", "delete_ai_task", "apply_ai_run",
    "create_notification_rule", "update_notification_rule", "delete_notification_rule",
  ]);
  function requireOperationPermission(operation) {
    if (adminOperations.has(operation) && hasAuthUser() && !isAdmin()) throw new AppError(403, "Administrator permission is required for this operation.");
  }
  function ownerUser(userId, { allowMissing = true } = {}) {
    if (!userId) {
      if (auth?.status && !auth.status().setupRequired && !allowMissing) throw new AppError(401, "This Agent action has no user owner.");
      return null;
    }
    const owner = auth?.getUser?.(userId);
    if (!owner || owner.active === false) throw new AppError(401, "The Agent owner is inactive.");
    return owner;
  }
  function assertActorUser(actor) {
    const user = currentUser();
    if (!user || !actor?.userId) return;
    if (actor.userId !== user.id && user.role !== "admin") throw new AppError(403, "This Agent actor belongs to another user.");
  }
  function assertActionAccess(action) {
    const user = currentUser();
    if (!user) return;
    ownerUser(action.userId, { allowMissing: false });
    if (user.role !== "admin" && action.userId !== user.id) throw new AppError(404, "Action not found.");
  }
  const recordFingerprint = (formId) => hash(stable(store.listRecords(formId).map(({ id, version, values }) => ({ id, version, values })).sort((a, b) => a.id.localeCompare(b.id))));
  function execute(operation, args) {
    switch (operation) {
      case "upload_inventory_file": return store.warehouseImports.upload(args);
      case "get_inventory_file": return store.warehouseImports.info(args.fileId);
      case "match_inventory_file": return store.warehouseImports.match(args);
      case "preview_inventory_import": return store.warehouseImports.preview(args);
      case "execute_inventory_import": return store.warehouseImports.execute(args);
      case "save_inventory_catalog": return store.warehouse.catalog(args);
      case "upload_attachment": return store.files.upload(args);
      case "get_attachment": {
        const file = store.files.get(args.attachmentId);
        return { ...store.files.info(args.attachmentId), data: file.bytes.toString("base64") };
      }
      case "setup_inventory_workspace": return store.warehouse.ensureTables(args.spaceId);
      case "list_navigation": return store.spaces.tree(args.spaceId);
      case "create_navigation_node": return store.spaces.createNode(args);
      case "update_navigation_node": return store.spaces.updateNode(args.nodeId, args);
      case "move_navigation_node": return store.spaces.moveNode(args.nodeId, args);
      case "delete_navigation_node": return store.spaces.deleteNode(args.nodeId);
      case "list_notifications": return store.automation.notifications(args.spaceId);
      case "mark_notification_read": {
        if (!store.automation.notifications(args.spaceId).some(n => n.id === args.notificationId)) throw new AppError(404, "Notification not found.");
        return store.automation.readNotification(args.notificationId);
      }
      case "resolve_error": {
        if (!store.automation.errors(args.spaceId).some(e => e.id === args.errorId)) throw new AppError(404, "Error not found.");
        return store.automation.resolveError(args.errorId, args.status);
      }
      case "create_ai_task": return store.tasks.save(args.definition);
      case "update_ai_task": return store.tasks.save(args.definition, args.taskId);
      case "delete_ai_task": return store.tasks.remove(args.taskId, args.version);
      case "list_ai_runs": return store.tasks.runs(args.spaceId);
      case "preview_ai_run": return store.tasks.preview(args.runId);
      case "apply_ai_run": return store.tasks.apply(args.runId, { fingerprint: args.fingerprint });
      case "retry_ai_run": return store.tasks.retry(args.runId);
      case "cancel_ai_run": return store.tasks.cancel(args.runId);
      case "list_forms": return store.listForms(args.spaceId);
      case "list_spaces": return store.spaces.list();
      case "get_form": return store.getForm(args.formId);
      case "query_records": return queryRecords(store, args);
      case "get_record": return store.getRecord(args.recordId);
      case "create_form": return store.createForm(args);
      case "update_form": return store.updateForm(args.formId, args);
      case "preview_form_deletion": return store.deletions.inspect(args.formId);
      case "delete_form": {
        const preview = store.deletions.inspect(args.formId);
        return store.deletions.remove(args.formId, { version: args.version, fingerprint: preview.fingerprint, confirmed: true });
      }
      case "create_record": return store.createRecord(args.formId, args);
      case "update_record": return store.updateRecord(args.recordId, args);
      case "list_notification_rules": return store.automation.list(args.spaceId, args.formId);
      case "create_notification_rule": return store.automation.save(args.definition);
      case "update_notification_rule": return store.automation.save(args.definition, args.ruleId);
      case "delete_notification_rule": return store.automation.remove(args.ruleId, args.version);
      case "list_ai_tasks": return store.tasks.list(args.spaceId);
      case "start_ai_task": return store.tasks.enqueue(args.taskId, { recordId: args.recordId });
      case "get_ai_run": return store.tasks.run(args.runId);
      case "list_errors": return store.automation.errors(args.spaceId);
      case "get_inventory_workspace": return store.warehouse.state(args.spaceId);
      case "get_inventory_request": return store.warehouse.document(args.recordId);
      case "create_inventory_request": return store.warehouse.createDocument(args);
      case "update_inventory_request": return store.warehouse.updateDocument(args.recordId, args);
      case "advance_inventory_request": return store.warehouse.transition(args.recordId, args);
      case "delete_record": {
        const form = store.getForm(store.getRecord(args.recordId).formId);
        if (form.version !== args.schemaVersion) throw new AppError(409, "The form schema changed. Read it again before deleting.");
        return store.deleteRecord(args.recordId, args);
      }
    }
  }
  function primaryPreview(operation, args) {
    if (operation === "delete_form") {
      const preview = store.deletions.inspect(args.formId);
      execute(operation, args);
      return { title: `Delete table: ${preview.name}`, formId: args.formId,
        deletion: { name: preview.name, recordCount: preview.recordCount, notificationRuleCount: preview.notificationRuleCount } };
    }
    if (!["create_form", "update_form", "create_record", "update_record", "delete_record"].includes(operation)) {
      return { title: operation.replaceAll("_", " "), result: execute(operation, args) };
    }
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
  function operationSpace(args) {
    if (args.fileId) return store.warehouseImports.info(args.fileId).spaceId;
    if (args.attachmentId) return store.files.info(args.attachmentId).spaceId;
    if (args.nodeId) return store.spaces.node(args.nodeId).spaceId;
    if (args.formId) return store.getForm(args.formId).spaceId;
    if (args.recordId) return store.getForm(store.getRecord(args.recordId).formId).spaceId;
    if (args.definition?.formId) return store.getForm(args.definition.formId).spaceId;
    if (args.ruleId) return store.automation.get(args.ruleId).spaceId;
    if (args.taskId) return store.tasks.get(args.taskId).spaceId;
    if (args.runId) return store.tasks.run(args.runId).spaceId;
    return args.spaceId ?? "default";
  }
  function makePreview(operation, args) {
    const spaceId = operationSpace(args), dependencyFingerprint = store.automation.fingerprint(spaceId);
    return { ...primaryPreview(operation, args), spaceId, dependencyFingerprint, changes: store.automation.changes() };
  }
  function apply(action) {
    assertActionAccess(action);
    if (action.status === "applied") return action;
    if (action.status !== "pending") throw new AppError(409, `This action is ${action.status}.`);
    const perform = () => {
      requireOperationPermission(action.operation);
      if (Date.now() - Date.parse(action.createdAt) > 86400000) throw new AppError(409, "This preview expired. Request a fresh preview.");
      if (action.operation === "update_form" && recordFingerprint(action.args.formId) !== action.preview.fingerprint) {
        throw new AppError(409, "Table records changed since this preview. Request a fresh preview.");
      }
      if (action.preview.dependencyFingerprint && store.automation.fingerprint(action.preview.spaceId) !== action.preview.dependencyFingerprint) {
        throw new AppError(409, "Automation rules or related table data changed since preview. Request a fresh preview.");
      }
      argsFor(action.operation, action.args);
      const result = execute(action.operation, action.args);
      return repo.resolveAction(action.id, "applied", result);
    };
    const owner = ownerUser(action.userId, { allowMissing: false });
    return owner && auth?.withUser ? auth.withUser(owner, perform) : perform();
  }
  return {
    tools() {
      return isAdmin() ? AGENT_TOOLS : AGENT_TOOLS.filter(tool => !adminOperations.has(tool.function.name));
    },
    getMode() {
      return repo.getSetting(`assistant-mode${currentUserId() ? `:${currentUserId()}` : ""}`, "review");
    },
    setMode(mode) {
      repo.setSetting(`assistant-mode${currentUserId() ? `:${currentUserId()}` : ""}`, validateMode(mode));
      return { mode };
    },
    createToken({ name, mode = "review", spaceId = "default" }) {
      if (typeof name !== "string" || !name.trim() || name.trim().length > 80) throw new AppError(400, "Token name must contain 1-80 characters.");
      validateMode(mode);
      store.spaces.get(spaceId);
      const userId = currentUserId();
      if (repo.listTokens(userId ? { userId } : {}).filter((token) => !token.revokedAt).length >= 20) throw new AppError(400, "Revoke an unused token first (maximum 20 active tokens).");
      const token = `rlf_${randomBytes(32).toString("base64url")}`;
      return { ...repo.insertToken({ name: name.trim(), mode, hash: hash(token), prefix: token.slice(0, 12), spaceId, userId }), token };
    },
    updateToken(id, mode) {
      const target = repo.getToken(id);
      const user = currentUser();
      if (user && user.role !== "admin" && target.userId !== user.id) throw new AppError(404, "Token not found.");
      return repo.updateToken(id, validateMode(mode));
    },
    revokeToken(id) {
      const target = repo.getToken(id);
      const user = currentUser();
      if (user && user.role !== "admin" && target.userId !== user.id) throw new AppError(404, "Token not found.");
      repo.revokeToken(id);
      return { revoked: true };
    },
    authenticate(header) {
      if (typeof header !== "string" || !/^Bearer rlf_[A-Za-z0-9_-]{43}$/.test(header)) throw new AppError(401, "A valid Agent Bearer token is required.");
      const token = repo.findToken(hash(header.slice(7)));
      if (!token) throw new AppError(401, "Agent token is invalid or revoked.");
      if (auth?.status && !auth.status().setupRequired && !token.userId) throw new AppError(401, "This legacy Agent token has no user owner.");
      const owner = ownerUser(token.userId, { allowMissing: true });
      const user = currentUser();
      if (user && token.userId && user.id !== token.userId && user.role !== "admin") throw new AppError(403, "This Agent token belongs to another user.");
      if (owner) token.owner = owner;
      return token;
    },
    run(operation, input, actor, requestKey) {
      const args = argsFor(operation, input);
      requireOperationPermission(operation);
      assertActorUser(actor);
      if (actor?.userId) ownerUser(actor.userId);
      const token = actor.type === "token" ? repo.getToken(actor.id) : null;
      if (token?.revokedAt) throw new AppError(401, "Agent token is invalid or revoked.");
      if (operation === "delete_form" && typeof requestKey === "string" && requestKey.trim() && requestKey.length <= 200) {
        const existing = repo.findAction(actor.id, requestKey);
        if (existing) {
          if (existing.operation !== operation || stable(existing.args) !== stable(args)) throw new AppError(409, "This idempotency key was already used for a different action.");
          return existing;
        }
      }
      if (actor.type === "token") {
        const allowed = actor.spaceId ?? "default";
        if (["save_inventory_catalog", "upload_inventory_file"].includes(operation)) args.spaceId ??= allowed;
        if (["upload_attachment", "setup_inventory_workspace", "list_navigation", "create_navigation_node", "list_notifications", "mark_notification_read", "resolve_error", "list_ai_runs", "list_forms", "list_notification_rules", "list_ai_tasks", "list_errors", "get_inventory_workspace", "create_inventory_request"].includes(operation)) args.spaceId ??= allowed;
        if (operation === "create_form") args.spaceId ??= allowed;
        if (operation !== "list_spaces" && (operationSpace(args) !== allowed || args.spaceId && args.spaceId !== allowed)) throw new AppError(403, "This Agent token belongs to another Space.");
        if (operation === "list_spaces") return [store.spaces.get(allowed)];
      }
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
        const action = repo.insertAction({ actorId: actor.id, actorName: actor.name, requestKey, operation, args, preview, userId: actor.userId ?? currentUserId() });
        const mode = actor.type === "chat" ? repo.getSetting(`assistant-mode${currentUserId() ? `:${currentUserId()}` : ""}`, "review") : token?.mode;
        if (!mode) throw new AppError(401, "Agent token is invalid or revoked.");
        return mode === "full" && operation !== "delete_form" ? apply(action) : action;
      });
    },
    approve(id) {
      const action = repo.getAction(id);
      assertActionAccess(action);
      try { return store.transaction(() => apply(action)); }
      catch (error) {
        const latest = repo.getAction(id);
        if (latest.status === "pending") repo.resolveAction(id, "failed", null, error.message);
        throw error;
      }
    },
    reject(id) {
      return store.transaction(() => {
        const action = repo.getAction(id);
        assertActionAccess(action);
        if (action.status === "rejected") return action;
        if (action.status !== "pending") throw new AppError(409, `This action is ${action.status}.`);
        return repo.resolveAction(id, "rejected");
      });
    },
  };
}
