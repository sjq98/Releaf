import { randomUUID } from "node:crypto";
import { AppError } from "./errors.js";

export function createImportDrafts(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_drafts (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload_json TEXT NOT NULL,
      result_json TEXT, fingerprint TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS workflow_fingerprint ON workflow_drafts(kind, fingerprint);
  `);
  const parse = (row) => ({
    id: row.id, kind: row.kind, payload: JSON.parse(row.payload_json),
    result: row.result_json ? JSON.parse(row.result_json) : null,
    fingerprint: row.fingerprint, createdAt: row.created_at,
  });
  return {
    draft(id, kind) {
      const row = db.prepare("SELECT * FROM workflow_drafts WHERE id = ? AND kind = ?").get(id, kind);
      if (!row) throw new AppError(404, "Import draft not found.");
      return parse(row);
    },
    duplicate(kind, fingerprint) {
      const row = db.prepare("SELECT * FROM workflow_drafts WHERE kind = ? AND fingerprint = ? AND result_json IS NOT NULL LIMIT 1").get(kind, fingerprint);
      return row ? parse(row) : null;
    },
    saveDraft(kind, payload, fingerprint) {
      const id = randomUUID();
      db.prepare("INSERT INTO workflow_drafts VALUES (?, ?, ?, NULL, ?, ?)")
        .run(id, kind, JSON.stringify(payload), fingerprint, new Date().toISOString());
      return this.draft(id, kind);
    },
    finishDraft(id, result) {
      db.prepare("UPDATE workflow_drafts SET result_json = ? WHERE id = ?").run(JSON.stringify(result), id);
    },
  };
}
