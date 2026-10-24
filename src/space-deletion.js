import { createHash } from "node:crypto";
import { AppError } from "./errors.js";

export function createSpaceDeletion({ db, store }) {
  const forms = "SELECT id FROM forms WHERE space_id = ?";
  const records = `SELECT id FROM records WHERE form_id IN (${forms})`;
  // Children precede their referenced parents so the entire Space can be removed atomically.
  const scopedTables = [
    ["ai_task_runs", "space_id = ?"],
    ["ai_tasks", "space_id = ?"],
    ["warehouse_import_runs", "file_id IN (SELECT id FROM warehouse_import_files WHERE space_id = ?)"],
    ["warehouse_import_files", "space_id = ?"],
    ["meeting_task_imports", "space_id = ?"],
    ["meeting_task_workspace", "space_id = ?"],
    ["warehouse_movements", "space_id = ?"],
    ["warehouse_events", "space_id = ?"],
    ["warehouse_forms", "space_id = ?"],
    ["warehouse_sequences", "space_id = ?"],
    ["order_intake_sources", `order_id IN (${records})`],
    ["order_details", `order_id IN (${records})`],
    ["order_forms", "space_id = ?"],
    ["order_sequences", "space_id = ?"],
    ["customer_orders", "space_id = ?"],
    ["automation_runs", "space_id = ?"],
    ["automation_rules", "space_id = ?"],
    ["notifications", "space_id = ?"],
    ["processing_errors", "space_id = ?"],
    ["navigation_nodes", "space_id = ?"],
    ["form_deletions", `form_id IN (${forms})`],
    ["unique_values", `form_id IN (${forms})`],
    ["form_activity", `form_id IN (${forms})`],
    ["records", `form_id IN (${forms})`],
    ["forms", "space_id = ?"],
    ["attachments", "space_id = ?"],
  ];
  function inspect(id) {
    store.auth.requireAdmin();
    const space = store.spaces.get(id);
    const hash = createHash("sha256").update(JSON.stringify(space));
    for (const [table, where] of scopedTables) {
      hash.update(table);
      const columns = ["attachments", "warehouse_import_files"].includes(table) ? "id, name, length(bytes) AS size, created_at" : "*";
      for (const row of db.prepare(`SELECT ${columns} FROM ${table} WHERE ${where} ORDER BY rowid`).iterate(id)) {
        hash.update(JSON.stringify(row));
      }
    }
    const count = (table, where) => db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get(id).count;
    return {
      spaceId: id, name: space.name, canDelete: store.spaces.list().length > 1,
      tableCount: count("forms", "space_id = ?"),
      recordCount: count("records", `form_id IN (${forms})`),
      fileCount: count("attachments", "space_id = ?") + count("warehouse_import_files", "space_id = ?"),
      fingerprint: hash.digest("hex"),
    };
  }
  function remove(id, body) {
    store.auth.requireAdmin();
    return store.transaction(() => {
      const preview = inspect(id);
      if (body?.confirmed !== true) throw new AppError(400, "Confirm Space deletion before continuing.");
      if (!preview.canDelete) throw new AppError(409, "Keep at least one Space.");
      if (body.fingerprint !== preview.fingerprint) throw new AppError(409, "The Space or its data changed. Review deletion again.");
      for (const [table, where] of scopedTables) db.prepare(`DELETE FROM ${table} WHERE ${where}`).run(id);
      for (const token of store.agent.listTokens().filter(token => token.spaceId === id)) store.agent.revokeToken(token.id);
      db.prepare("INSERT INTO space_deletions VALUES (?, ?, ?)").run(id, preview.name, new Date().toISOString());
      db.prepare("DELETE FROM spaces WHERE id = ?").run(id);
      const remaining = store.spaces.list();
      return { id, name: preview.name, deleted: true, nextSpaceId: (remaining.find(space => space.id === "default") ?? remaining[0]).id };
    });
  }
  return { inspect, remove };
}
