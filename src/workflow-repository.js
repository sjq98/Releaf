import { randomUUID } from "node:crypto";
import { AppError } from "./errors.js";

export function createWorkflowRepository(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_tables (role TEXT PRIMARY KEY, form_id TEXT NOT NULL REFERENCES forms(id));
    CREATE TABLE IF NOT EXISTS workflow_drafts (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload_json TEXT NOT NULL,
      result_json TEXT, fingerprint TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS workflow_fingerprint ON workflow_drafts(kind, fingerprint);
    CREATE TABLE IF NOT EXISTS supplier_files (
      id TEXT PRIMARY KEY, filename TEXT NOT NULL, mime TEXT NOT NULL, content BLOB NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS supplier_sources (
      record_id TEXT PRIMARY KEY REFERENCES records(id), file_id TEXT NOT NULL REFERENCES supplier_files(id),
      evidence TEXT NOT NULL, page INTEGER
    );
    CREATE TABLE IF NOT EXISTS reconciliation_runs (
      id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
    );
  `);
  const parseDraft = (row) => ({
    id: row.id, kind: row.kind, payload: JSON.parse(row.payload_json),
    result: row.result_json ? JSON.parse(row.result_json) : null, fingerprint: row.fingerprint, createdAt: row.created_at,
  });
  const parseRun = (row) => ({
    id: row.id, ...JSON.parse(row.payload_json), version: row.version, createdAt: row.created_at,
  });
  return {
    tables() { return Object.fromEntries(db.prepare("SELECT * FROM workflow_tables").all().map((row) => [row.role, row.form_id])); },
    setTable(role, id) { db.prepare("INSERT INTO workflow_tables VALUES (?, ?)").run(role, id); },
    draft(id, kind) {
      const row = db.prepare("SELECT * FROM workflow_drafts WHERE id = ? AND kind = ?").get(id, kind);
      if (!row) throw new AppError(404, "Import draft not found.");
      return parseDraft(row);
    },
    drafts(kind) {
      return db.prepare("SELECT * FROM workflow_drafts WHERE kind = ? ORDER BY created_at DESC, rowid DESC LIMIT 50").all(kind).map(parseDraft);
    },
    duplicate(kind, fingerprint) {
      const row = db.prepare("SELECT * FROM workflow_drafts WHERE kind = ? AND fingerprint = ? AND result_json IS NOT NULL LIMIT 1").get(kind, fingerprint);
      return row ? parseDraft(row) : null;
    },
    saveDraft(kind, payload, fingerprint) {
      const id = randomUUID();
      db.prepare("INSERT INTO workflow_drafts VALUES (?, ?, ?, NULL, ?, ?)")
        .run(id, kind, JSON.stringify(payload), fingerprint, new Date().toISOString());
      return this.draft(id, kind);
    },
    finishDraft(id, result) { db.prepare("UPDATE workflow_drafts SET result_json = ? WHERE id = ?").run(JSON.stringify(result), id); },
    saveFile({ name, mime, bytes }) {
      const id = randomUUID();
      db.prepare("INSERT INTO supplier_files VALUES (?, ?, ?, ?, ?)").run(id, name, mime, bytes, new Date().toISOString());
      return id;
    },
    file(id) {
      const row = db.prepare("SELECT * FROM supplier_files WHERE id = ?").get(id);
      if (!row) throw new AppError(404, "Source document not found.");
      return { id: row.id, name: row.filename, mime: row.mime, bytes: row.content };
    },
    fileInfo(id) {
      const row = db.prepare("SELECT id, filename, mime FROM supplier_files WHERE id = ?").get(id);
      if (!row) throw new AppError(404, "Source document not found.");
      return { id: row.id, name: row.filename, mime: row.mime };
    },
    linkSource(recordId, fileId, evidence, page) {
      db.prepare("INSERT INTO supplier_sources VALUES (?, ?, ?, ?)").run(recordId, fileId, evidence, page);
    },
    source(recordId) {
      const row = db.prepare(`SELECT s.file_id, s.evidence, s.page, f.filename FROM supplier_sources s
        JOIN supplier_files f ON f.id = s.file_id WHERE s.record_id = ?`).get(recordId);
      return row ? { fileId: row.file_id, name: row.filename, evidence: row.evidence, page: row.page } : null;
    },
    saveRun(payload) {
      const id = randomUUID();
      db.prepare("INSERT INTO reconciliation_runs VALUES (?, ?, 1, ?)").run(id, JSON.stringify(payload), new Date().toISOString());
      return this.run(id);
    },
    run(id) {
      const row = db.prepare("SELECT * FROM reconciliation_runs WHERE id = ?").get(id);
      if (!row) throw new AppError(404, "Reconciliation run not found.");
      return parseRun(row);
    },
    runs() { return db.prepare("SELECT * FROM reconciliation_runs ORDER BY created_at DESC, rowid DESC LIMIT 50").all().map(parseRun); },
    updateRun(id, payload, version) {
      if (!db.prepare("UPDATE reconciliation_runs SET payload_json = ?, version = version + 1 WHERE id = ? AND version = ?")
        .run(JSON.stringify(payload), id, version).changes) throw new AppError(409, "This result changed. Refresh before saving.");
      return this.run(id);
    },
  };
}
