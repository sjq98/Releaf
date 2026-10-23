import { DatabaseSync, backup } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { createStore, AppError } from "../src/store.js";
import { referencesForm } from "../src/form-deletion.js";

export function legacyForms(store) {
  const db = store.database, ids = new Set();
  for (const table of ["module_tables", "workflow_tables", "inventory_tables"]) {
    if (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) {
      for (const row of db.prepare(`SELECT form_id FROM ${table}`).all()) ids.add(row.form_id);
    }
  }
  const forms = store.listForms();
  const first = forms.find(form => form.spaceId === "default");
  if (first?.moduleId === "orders" && ["orderNumber", "deliveryAt", "item", "quantity", "completed"].every(id => first.fields.some(field => field.id === id))) ids.add(first.id);
  return forms.filter(form => ids.has(form.id) && !store.warehouse.roleOf(form.id));
}

export function retireLegacyForms(store) {
  return store.transaction(() => {
    const forms = legacyForms(store), ids = new Set(forms.map(form => form.id));
    if (!ids.size) return { retired: [] };
    for (const form of store.listForms().filter(form => !ids.has(form.id))) {
      if (forms.some(target => referencesForm(form.fields, target.id))) {
        throw new AppError(409, `Custom form "${form.name}" still references a legacy form. Remove that reference before cleanup.`);
      }
    }
    for (const space of store.spaces.list()) {
      for (const task of store.tasks.list(space.id)) {
        if (forms.some(form => referencesForm(task, form.id))) throw new AppError(409, `AI task "${task.name}" depends on a legacy form.`);
      }
      for (const rule of store.automation.list(space.id).filter(rule => !ids.has(rule.formId))) {
        if (forms.some(form => referencesForm(rule, form.id))) throw new AppError(409, `Notification "${rule.name}" depends on a legacy form.`);
      }
    }
    const db = store.database, now = new Date().toISOString();
    for (const form of forms) {
      db.prepare("DELETE FROM navigation_nodes WHERE form_id = ?").run(form.id);
      db.prepare("DELETE FROM unique_values WHERE form_id = ?").run(form.id);
      db.prepare("DELETE FROM automation_rules WHERE form_id = ?").run(form.id);
      db.prepare("DELETE FROM notifications WHERE form_id = ?").run(form.id);
      db.prepare("UPDATE forms SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?").run(now, now, form.id);
      db.prepare("INSERT INTO form_deletions VALUES (?, ?, ?, ?, ?)").run(randomUUID(), form.id, form.name, form.recordCount, now);
    }
    // Keep user-created descendants, but remove the four obsolete module folders.
    for (const id of ["node_orders", "node_meetings", "node_suppliers", "node_inventory"]) {
      db.prepare("UPDATE navigation_nodes SET parent_id = NULL WHERE parent_id = ?").run(id);
      db.prepare("DELETE FROM navigation_nodes WHERE id = ? AND kind = 'node'").run(id);
    }
    db.prepare("UPDATE forms SET module_id = 'custom' WHERE deleted_at IS NULL AND module_id IN ('orders', 'meetings', 'suppliers')").run();
    return { retired: forms.map(({ id, name, recordCount }) => ({ id, name, recordCount })) };
  });
}

async function main() {
  const filename = resolve(process.argv[2] ?? "data/forms.sqlite");
  if (process.argv[3] !== "--apply") throw new Error("Usage: node scripts/retire-legacy-forms.mjs data/forms.sqlite --apply");
  const folder = resolve(dirname(filename), "backups");
  mkdirSync(folder, { recursive: true });
  const backupFile = resolve(folder, `before-legacy-cleanup-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`);
  const original = new DatabaseSync(filename, { readOnly: true });
  try { await backup(original, backupFile); } finally { original.close(); }
  const store = createStore(filename);
  try { console.log(JSON.stringify({ backup: backupFile, ...retireLegacyForms(store) }, null, 2)); }
  finally { store.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
