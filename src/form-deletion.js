import { randomUUID } from "node:crypto";
import { AppError } from "./errors.js";

export function referencesForm(value, formId) {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) =>
    ["formId", "outputFormId"].includes(key) && child === formId || referencesForm(child, formId));
}

export function createFormDeletion({ db, store }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS form_deletions (
      id TEXT PRIMARY KEY, form_id TEXT NOT NULL REFERENCES forms(id),
      name TEXT NOT NULL, record_count INTEGER NOT NULL, created_at TEXT NOT NULL
    );
  `);
  function inspect(id) {
    const form = store.getForm(id), blockers = [];
    if (store.warehouse.roleOf(id)) blockers.push({ type: "system", name: form.name });
    for (const source of store.listForms(form.spaceId).filter(item => item.id !== id)) {
      for (const field of source.fields.filter(field => referencesForm(field.reference, id) || referencesForm(field.formula, id))) {
        blockers.push({ type: "reference", formId: source.id, name: source.name, field: field.name });
      }
    }
    for (const task of store.tasks.list(form.spaceId).filter(task => referencesForm(task, id))) {
      blockers.push({ type: "task", id: task.id, name: task.name });
    }
    for (const rule of store.automation.list(form.spaceId).filter(rule => rule.formId !== id && referencesForm(rule, id))) {
      blockers.push({ type: "notification", id: rule.id, name: rule.name });
    }
    return {
      formId: id, name: form.name, version: form.version,
      recordCount: store.listRecords(id).length,
      notificationRuleCount: store.automation.list(form.spaceId, id).length,
      blockers, canDelete: blockers.length === 0,
      fingerprint: store.automation.fingerprint(form.spaceId),
    };
  }
  function remove(id, body) {
    return store.transaction(() => {
      const preview = inspect(id);
      if (body?.confirmed !== true) throw new AppError(400, "Confirm form deletion before continuing.");
      if (body.version !== preview.version || body.fingerprint !== preview.fingerprint) {
        throw new AppError(409, "The form or related data changed. Review deletion again.");
      }
      if (!preview.canDelete) throw new AppError(409, "This form has protected dependencies. Remove them before deleting.");
      const now = new Date().toISOString();
      db.prepare("DELETE FROM navigation_nodes WHERE form_id = ?").run(id);
      db.prepare("DELETE FROM unique_values WHERE form_id = ?").run(id);
      db.prepare("DELETE FROM automation_rules WHERE form_id = ?").run(id);
      db.prepare("DELETE FROM notifications WHERE form_id = ?").run(id);
      db.prepare("UPDATE forms SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?").run(now, now, id);
      db.prepare("INSERT INTO form_deletions VALUES (?, ?, ?, ?, ?)").run(randomUUID(), id, preview.name, preview.recordCount, now);
      return { id, name: preview.name, recordCount: preview.recordCount, deleted: true };
    });
  }
  return { inspect, remove };
}
