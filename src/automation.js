import { randomUUID, createHash } from "node:crypto";
import { AppError } from "./errors.js";
import { evaluateFormula, parseFormula } from "./expressions.js";
import { normalizeField } from "./field-types.js";
import { compileConditions } from "./condition-expression.js";

const fail = (message, status = 400) => { throw new AppError(status, message); };
const equal = (a, b) => typeof a === "string" && typeof b === "string" ? a.toLowerCase() === b.toLowerCase() : JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const operators = new Set(["eq", "ne", "gt", "gte", "lt", "lte", "contains", "is_empty", "not_empty", "changed"]);
const stable = (value) => JSON.stringify(value, (_, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
export const fingerprint = (value) => createHash("sha256").update(stable(value)).digest("hex");

export function createAutomation({ db, store }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS automation_rules (
      id TEXT PRIMARY KEY, space_id TEXT NOT NULL, form_id TEXT NOT NULL REFERENCES forms(id),
      name TEXT NOT NULL, enabled INTEGER NOT NULL, version INTEGER NOT NULL, payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS automation_runs (
      id TEXT PRIMARY KEY, rule_id TEXT NOT NULL, space_id TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS processing_errors (
      id TEXT PRIMARY KEY, space_id TEXT NOT NULL, category TEXT NOT NULL, message TEXT NOT NULL,
      context_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Unresolved', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY, space_id TEXT NOT NULL, form_id TEXT NOT NULL, record_id TEXT,
      message TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS local_requests (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL);
  `);
  let context = null;
  function visibleRecord(formId, recordId, ownerId) {
    if (typeof formId !== "string" || !store.orders?.roleOf(formId)) return true;
    const user = store.auth.currentUser();
    if (!user || user.role === "admin") return true;
    const row = recordId ? db.prepare("SELECT values_json FROM records WHERE id = ? AND form_id = ?").get(recordId, formId) : null;
    return row ? store.orders.isVisible(formId, JSON.parse(row.values_json)) : ownerId === user.id;
  }
  const notificationOnly = (rule) => Array.isArray(rule.actions) && rule.actions.length === 1 && rule.actions[0].type === "notify";
  const ruleFrom = (row) => ({ ...JSON.parse(row.payload_json), id: row.id, version: row.version, enabled: Boolean(row.enabled), createdAt: row.created_at, updatedAt: row.updated_at });
  function list(spaceId = "default", formId) {
    store.spaces.get(spaceId);
    return db.prepare("SELECT * FROM automation_rules WHERE space_id = ? ORDER BY created_at, id").all(spaceId)
      .filter((row) => !formId || row.form_id === formId).map(ruleFrom).filter(notificationOnly);
  }
  function get(id) {
    const row = db.prepare("SELECT * FROM automation_rules WHERE id = ?").get(id);
    if (!row || !notificationOnly(ruleFrom(row))) fail("Notification rule not found.", 404);
    return ruleFrom(row);
  }
  function checkForm(id, spaceId, overrides) {
    const form = overrides?.get(id) ?? store.getForm(id);
    if (form.spaceId !== spaceId) fail("Cross-form operations must remain in the same Space.");
    return form;
  }
  function validateValue(value, source, target, spaceId, overrides, depth = 0) {
    if (depth > 10) fail("Expression nesting limit exceeded.");
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("Choose a typed assignment value.");
    if (value.kind === "literal") {
      if (!Object.hasOwn(value, "value") || typeof value.value === "object" && value.value !== null && !Array.isArray(value.value)) fail("Invalid literal value.");
      return;
    }
    if (value.kind === "empty") return;
    if (value.kind === "formula") {
      parseFormula(value.formula);
      Object.values(value.formula.bindings).forEach((binding) => validateValue({ ...binding, kind: "field" }, source, target, spaceId, overrides, depth + 1));
      return;
    }
    if (value.kind !== "field") fail("Unsupported assignment mode.");
    let form;
    if (["source", "after", "before", "record"].includes(value.scope)) form = source;
    else if (["target", "output"].includes(value.scope)) form = target;
    else if (["lookup", "aggregate"].includes(value.scope)) {
      form = checkForm(value.formId, spaceId, overrides);
      if (!["first", "unique", undefined].includes(value.selection)) fail("Choose first or unique lookup selection.");
      if (value.condition) validateCondition(value.condition, source, form, spaceId, overrides, depth + 1);
      if (value.aggregate && !["SUM", "COUNT", "MIN", "MAX"].includes(value.aggregate)) fail("Unsupported aggregate.");
    }
    if (!form || value.formId && form.id !== value.formId || !form.fields.some((field) => field.id === value.fieldId)) fail("Choose an existing field in the selected record scope.");
  }
  function validateCondition(condition, source, target, spaceId, overrides, depth = 0) {
    if (!condition) return;
    if (depth > 10 || typeof condition !== "object") fail("Invalid condition group.");
    if (["AND", "OR", "NOT"].includes(condition.op)) {
      if (!Array.isArray(condition.conditions) || condition.conditions.length < 1 || condition.conditions.length > 30 ||
          condition.op === "NOT" && condition.conditions.length !== 1) fail("Choose conditions for this logical group.");
      condition.conditions.forEach((item) => {
        if (!item) fail("Condition groups cannot contain empty conditions.");
        validateCondition(item, source, target, spaceId, overrides, depth + 1);
      });
      return;
    }
    const field = target?.fields.find((item) => item.id === condition.fieldId);
    if (!field || !operators.has(condition.operator)) fail("A condition references an invalid field or operator.");
    if (["gt", "gte", "lt", "lte"].includes(condition.operator) && !["number", "date", "datetime"].includes(field.type)) fail("Ordered comparison requires a number or date field.");
    if (condition.operator === "contains" && !["text", "longtext", "select"].includes(field.type)) fail("Contains requires a text or dropdown field.");
    if (!["is_empty", "not_empty", "changed"].includes(condition.operator)) validateValue(condition.value, source, target, spaceId, overrides, depth + 1);
    if (condition.value?.kind === "literal" && !["is_empty", "not_empty", "changed", "contains"].includes(condition.operator)) {
      try { normalizeField({ ...field, required: false }, condition.value.value); }
      catch (error) { fail(`Invalid filter value for "${field.name}": ${error.message}`); }
    }
  }
  function validate(body, overrides) {
    if (!body || JSON.stringify(body).length > 100000) fail("Invalid automation definition.");
    const source = overrides?.get(body.formId) ?? store.getForm(body.formId);
    const spaceId = source.spaceId;
    if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 100 ||
        !["created", "updated", "deleted"].includes(body.trigger) || typeof body.enabled !== "boolean") fail("Enter a name, trigger, and enabled state.");
    if (body.watchedFields && (!Array.isArray(body.watchedFields) || body.watchedFields.some((id) => !source.fields.some((field) => field.id === id)))) fail("Choose valid watched fields.");
    const condition = body.conditionBuilder ? compileConditions(body.conditionBuilder) : body.condition ?? null;
    if (body.conditionBuilder) {
      for (const item of body.conditionBuilder.conditions) validateCondition(item.condition, source, source, spaceId, overrides);
      if (body.condition !== undefined && stable(body.condition) !== stable(condition)) fail("The logical expression and trigger conditions do not match.");
    }
    validateCondition(condition, source, source, spaceId, overrides);
    if (!notificationOnly(body)) fail("Custom cross-form automation is archived. Only notification rules are configurable.", 410);
    return { name: body.name.trim(), formId: source.id, spaceId, trigger: body.trigger, enabled: body.enabled,
      watchedFields: body.watchedFields ?? [], condition, actions: structuredClone(body.actions),
      ...(body.conditionBuilder ? { conditionBuilder: structuredClone(body.conditionBuilder) } : {}) };
  }
  function save(body, id) {
    const checked = validate(body), now = new Date().toISOString();
    if (id) {
      const old = get(id);
      if (old.formId !== checked.formId || old.version !== body.version) fail("Automation changed. Reload before editing.", 409);
      db.prepare("UPDATE automation_rules SET name = ?, enabled = ?, version = version + 1, payload_json = ?, updated_at = ? WHERE id = ?").run(checked.name, +checked.enabled, JSON.stringify(checked), now, id);
    } else {
      id = randomUUID();
      db.prepare("INSERT INTO automation_rules VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)").run(id, checked.spaceId, checked.formId, checked.name, +checked.enabled, JSON.stringify(checked), now, now);
    }
    return get(id);
  }
  function value(expression, ctx) {
    if (expression.kind === "empty") return null;
    if (expression.kind === "literal") return structuredClone(expression.value);
    if (expression.kind === "formula") return evaluateFormula(expression.formula, (binding) => value({ ...binding, kind: "field" }, ctx));
    let values;
    if (["source", "after", "record"].includes(expression.scope)) values = ctx.event.after;
    else if (expression.scope === "before") values = ctx.event.before;
    else if (expression.scope === "target") values = ctx.target?.values;
    else if (expression.scope === "output") values = ctx.output;
    else {
      const form = checkForm(expression.formId, ctx.spaceId);
      const rows = store.listRecords(form.id).filter((record) => test(expression.condition, { ...ctx, target: record }));
      if (expression.scope === "aggregate" || expression.aggregate) {
        const items = rows.map((record) => record.values[expression.fieldId] ?? null);
        return evaluateFormula({ expression: `${expression.aggregate || "SUM"}(v)`, bindings: { v: {} } }, () => items);
      }
      if (expression.selection === "unique" && rows.length !== 1) fail("Lookup requires exactly one matching record.", 409);
      values = rows[0]?.values;
    }
    return values?.[expression.fieldId] ?? null;
  }
  function test(condition, ctx) {
    if (!condition) return true;
    if (condition.op === "AND") return condition.conditions.every((item) => test(item, ctx));
    if (condition.op === "OR") return condition.conditions.some((item) => test(item, ctx));
    if (condition.op === "NOT") return !test(condition.conditions[0], ctx);
    const left = (ctx.target ? ctx.target.values?.[condition.fieldId] : ctx.event.after?.[condition.fieldId]) ?? null;
    const empty = left == null || left === "";
    if (condition.operator === "is_empty") return empty;
    if (condition.operator === "not_empty") return !empty;
    if (condition.operator === "changed") return !equal(ctx.event.before?.[condition.fieldId], ctx.event.after?.[condition.fieldId]);
    const right = value(condition.value, ctx);
    if (condition.operator === "eq") return equal(left, right);
    if (condition.operator === "ne") return !equal(left, right);
    if (condition.operator === "contains") return typeof left === "string" && typeof right === "string" && left.toLowerCase().includes(right.toLowerCase());
    if (empty || right == null) return false;
    return { gt: left > right, gte: left >= right, lt: left < right, lte: left <= right }[condition.operator];
  }
  function emit(event) {
    if (!context) return;
    context.changes.push(structuredClone(event));
    if (context.changes.length > 1000) fail("Automation affected-record limit (1000) exceeded.", 409);
    const source = store.getForm(event.formId);
    for (const rule of list(source.spaceId, event.formId).filter((rule) => rule.enabled && rule.trigger === event.kind)) {
      const ctx = { event, spaceId: source.spaceId, target: { values: event.after ?? event.before ?? {} } };
      if (rule.watchedFields.length && event.kind === "updated" && !rule.watchedFields.some((id) => !equal(event.before?.[id], event.after?.[id]))) continue;
      if (!test(rule.condition, ctx)) continue;
      const key = `${rule.id}:${event.recordId}`;
      if (context.ancestors.includes(key) || context.ancestors.length >= 20) fail("Circular automation detected. Review the rule chain.", 409);
      context.ancestors.push(key);
      const steps = [], changeIndex = context.changes.length;
      try {
        for (const [index, action] of rule.actions.entries()) {
          context.current = { ruleId: rule.id, ruleName: rule.name, formId: source.id, recordId: event.recordId, step: index + 1, spaceId: source.spaceId };
          if (action.type === "notify") {
            const priorMatches = event.kind === "updated" && test(rule.condition, { ...ctx, event: { ...event, after: event.before }, target: { values: event.before ?? {} } });
            if (!priorMatches) db.prepare("INSERT INTO notifications (id, space_id, form_id, record_id, message, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
              randomUUID(), source.spaceId, source.id, event.recordId, String(action.message || `${source.name}: ${rule.name}`).slice(0, 500), new Date().toISOString());
            steps.push({ action: index + 1, type: "notify" }); continue;
          }
        }
        const id = randomUUID();
        db.prepare("INSERT INTO automation_runs VALUES (?, ?, ?, ?, ?)").run(id, rule.id, source.spaceId,
          JSON.stringify({ ruleName: rule.name, version: rule.version, event, steps, changes: [event, ...context.changes.slice(changeIndex)] }), new Date().toISOString());
      } catch (error) { error.automationContext ??= context.current; throw error; }
      finally { context.ancestors.pop(); }
    }
  }
  return {
    list, get, save, validate, value, test, emit,
    validateCondition, validateValue,
    begin() { context = { changes: [], ancestors: [], current: null }; },
    checkpoint: () => structuredClone(context),
    restore(checkpoint) { context = checkpoint; },
    end() { const current = context; context = null; return current; },
    changes: () => structuredClone(context?.changes ?? []),
    notify(spaceId, formId, recordId, message) {
      db.prepare("INSERT INTO notifications (id, space_id, form_id, record_id, message, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(randomUUID(), spaceId, formId, recordId, message, new Date().toISOString());
    },
    effect(change) { if (context) context.changes.push(structuredClone(change)); },
    remove(id, version) {
      if (get(id).version !== version) fail("Automation changed. Reload first.", 409);
      db.prepare("DELETE FROM automation_rules WHERE id = ?").run(id); return { id };
    },
    assertSchema(form, fields) {
      const overrides = new Map([[form.id, { ...form, fields }]]);
      for (const rule of list(form.spaceId)) {
        try { validate(rule, overrides); }
        catch (error) { fail(`Cannot change this schema: automation "${rule.name}" depends on it. ${error.message}`, 409); }
      }
    },
    logError(error, details = {}) {
      const ctx = { ...error.automationContext, ...details, userId: store.auth.currentUser()?.id ?? null, ...(error.automationContext ? { ruleId: error.automationContext.ruleId, ruleName: error.automationContext.ruleName, step: error.automationContext.step, ruleContext: error.automationContext } : {}) };
      const id = randomUUID();
      db.prepare("INSERT INTO processing_errors (id, space_id, category, message, context_json, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
        id, ctx.spaceId ?? "default", ctx.category ?? "Processing", String(error.message || error).slice(0, 2000), JSON.stringify(ctx), new Date().toISOString());
      return id;
    },
    errors(spaceId = "default") {
      store.spaces.get(spaceId);
      return db.prepare("SELECT * FROM processing_errors WHERE space_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 500").all(spaceId)
        .map((row) => ({ id: row.id, spaceId: row.space_id, category: row.category, message: row.message, status: row.status, context: JSON.parse(row.context_json), createdAt: row.created_at }))
        .filter(row => visibleRecord(row.context.formId, row.context.recordId, row.context.userId));
    },
    resolveError(id, status) {
      if (!["Unresolved", "Resolved", "Ignored"].includes(status)) fail("Invalid error status.");
      if (!db.prepare("SELECT id FROM processing_errors WHERE id = ?").get(id)) fail("Error not found.", 404);
      db.prepare("UPDATE processing_errors SET status = ? WHERE id = ?").run(status, id); return { id, status };
    },
    runs(spaceId = "default", formId) {
      store.spaces.get(spaceId);
      if (formId) checkForm(formId, spaceId);
      const rows = formId
        ? db.prepare("SELECT * FROM automation_runs WHERE space_id = ? AND json_extract(payload_json, '$.event.formId') = ? ORDER BY created_at DESC, rowid DESC LIMIT 200").all(spaceId, formId)
        : db.prepare("SELECT * FROM automation_runs WHERE space_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 200").all(spaceId);
      return rows.map((row) => ({ id: row.id, ruleId: row.rule_id, ...JSON.parse(row.payload_json), createdAt: row.created_at }))
        .filter(row => [row.event, ...(row.changes ?? [])].every(change => visibleRecord(change?.formId, change?.recordId)));
    },
    notifications: (spaceId = "default") => db.prepare("SELECT * FROM notifications WHERE space_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 100").all(spaceId)
      .filter(row => visibleRecord(row.form_id, row.record_id))
      .map((row) => ({ id: row.id, formId: row.form_id, recordId: row.record_id, message: row.message, read: Boolean(row.read), createdAt: row.created_at })),
    readNotification(id) {
      const row = db.prepare("SELECT * FROM notifications WHERE id = ?").get(id);
      if (!row || !visibleRecord(row.form_id, row.record_id)) fail("Notification not found.", 404);
      db.prepare("UPDATE notifications SET read = 1 WHERE id = ?").run(id); return { id };
    },
    once(key, input, callback) {
      if (!key) return callback();
      if (typeof key !== "string" || key.length > 200) fail("Invalid idempotency key.");
      return store.transaction(() => {
        const existing = db.prepare("SELECT * FROM local_requests WHERE id = ?").get(key);
        const digest = fingerprint(input);
        if (existing) {
          if (existing.fingerprint !== digest) fail("Idempotency key already used with a different request.", 409);
          return JSON.parse(existing.result_json);
        }
        const result = callback();
        db.prepare("INSERT INTO local_requests VALUES (?, ?, ?)").run(key, digest, JSON.stringify(result));
        return result;
      });
    },
    fingerprint(spaceId) {
      const forms = store.listForms(spaceId);
      return fingerprint({ forms, navigation: store.spaces.tree(spaceId), records: forms.map((form) => store.listRecords(form.id)), rules: list(spaceId), tasks: store.tasks?.list(spaceId) ?? [],
        warehouse: store.warehouse.fingerprint(spaceId), orders: store.orders?.fingerprint(spaceId) ?? null });
    },
  };
}
