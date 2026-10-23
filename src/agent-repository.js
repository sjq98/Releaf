import { randomUUID } from "node:crypto";
import { AppError } from "./errors.js";

export function createAgentRepository(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_settings (name TEXT PRIMARY KEY, value_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_tokens (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      prefix TEXT NOT NULL, mode TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS agent_actions (
      id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, request_key TEXT NOT NULL,
      operation TEXT NOT NULL, args_json TEXT NOT NULL, preview_json TEXT NOT NULL,
      status TEXT NOT NULL, result_json TEXT, error TEXT,
      created_at TEXT NOT NULL, resolved_at TEXT, UNIQUE(actor_id, request_key)
    );
    CREATE TABLE IF NOT EXISTS assistant_sessions (
      id TEXT PRIMARY KEY, messages_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  if (!db.prepare("PRAGMA table_info(agent_tokens)").all().some((column) => column.name === "space_id")) {
    db.exec("ALTER TABLE agent_tokens ADD COLUMN space_id TEXT NOT NULL DEFAULT 'default'");
  }
  for (const table of ["agent_tokens", "agent_actions", "assistant_sessions"]) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === "user_id")) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN user_id TEXT`);
    }
  }
  const parseAction = (row) => row ? {
    id: row.id, userId: row.user_id, actorId: row.actor_id, actorName: row.actor_name, requestKey: row.request_key,
    operation: row.operation, args: JSON.parse(row.args_json), preview: JSON.parse(row.preview_json),
    status: row.status, result: row.result_json ? JSON.parse(row.result_json) : null,
    error: row.error, createdAt: row.created_at, resolvedAt: row.resolved_at,
  } : null;
  const parseToken = (row) => row ? {
    id: row.id, userId: row.user_id, name: row.name, prefix: row.prefix, mode: row.mode, spaceId: row.space_id, createdAt: row.created_at, revokedAt: row.revoked_at,
  } : null;
  function getAction(id) {
    const action = parseAction(db.prepare("SELECT * FROM agent_actions WHERE id = ?").get(id));
    if (!action) throw new AppError(404, "Action not found.");
    return action;
  }
  return {
    getSetting(name, fallback = null) {
      const row = db.prepare("SELECT value_json FROM agent_settings WHERE name = ?").get(name);
      return row ? JSON.parse(row.value_json) : fallback;
    },
    setSetting(name, value) {
      db.prepare("INSERT INTO agent_settings VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value_json = excluded.value_json")
        .run(name, JSON.stringify(value));
    },
    listTokens({ userId } = {}) {
      return db.prepare("SELECT * FROM agent_tokens WHERE (? IS NULL OR user_id = ?) ORDER BY created_at DESC, rowid DESC")
        .all(userId ?? null, userId ?? null).map(parseToken);
    },
    getToken(id) {
      const token = parseToken(db.prepare("SELECT * FROM agent_tokens WHERE id = ?").get(id));
      if (!token) throw new AppError(404, "Token not found.");
      return token;
    },
    insertToken({ name, hash, prefix, mode, spaceId = "default", userId = null }) {
      const id = randomUUID();
      db.prepare("INSERT INTO agent_tokens (id, name, token_hash, prefix, mode, created_at, revoked_at, space_id, user_id) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)")
        .run(id, name, hash, prefix, mode, new Date().toISOString(), spaceId, userId);
      return parseToken(db.prepare("SELECT * FROM agent_tokens WHERE id = ?").get(id));
    },
    findToken(hash) { return parseToken(db.prepare("SELECT * FROM agent_tokens WHERE token_hash = ? AND revoked_at IS NULL").get(hash)); },
    updateToken(id, mode) {
      if (!db.prepare("UPDATE agent_tokens SET mode = ? WHERE id = ? AND revoked_at IS NULL").run(mode, id).changes) throw new AppError(404, "Active token not found.");
      return parseToken(db.prepare("SELECT * FROM agent_tokens WHERE id = ?").get(id));
    },
    revokeToken(id) {
      if (!db.prepare("SELECT id FROM agent_tokens WHERE id = ?").get(id)) throw new AppError(404, "Token not found.");
      db.prepare("UPDATE agent_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?").run(new Date().toISOString(), id);
      db.prepare("UPDATE agent_actions SET status = 'rejected', resolved_at = ? WHERE actor_id = ? AND status = 'pending'")
        .run(new Date().toISOString(), id);
    },
    getAction,
    findAction(actorId, requestKey) {
      return parseAction(db.prepare("SELECT * FROM agent_actions WHERE actor_id = ? AND request_key = ?").get(actorId, requestKey));
    },
    listActions({ actorId, userId, pending = false } = {}) {
      return db.prepare(`SELECT * FROM agent_actions WHERE (? IS NULL OR actor_id = ?) AND (? IS NULL OR user_id = ?) AND (? = 0 OR status = 'pending')
        ORDER BY created_at DESC, rowid DESC LIMIT 100`).all(actorId ?? null, actorId ?? null, userId ?? null, userId ?? null, pending ? 1 : 0).map(parseAction);
    },
    actionFeed(actorId, userId) {
      return db.prepare(`SELECT * FROM agent_actions WHERE (? IS NULL OR actor_id = ?) AND (? IS NULL OR user_id = ?)
        ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, created_at DESC, rowid DESC LIMIT 200`)
        .all(actorId ?? null, actorId ?? null, userId ?? null, userId ?? null).map(parseAction);
    },
    insertAction({ actorId, actorName, requestKey, operation, args, preview, userId = null }) {
      const id = randomUUID();
      db.prepare(`INSERT INTO agent_actions
        (id, actor_id, actor_name, request_key, operation, args_json, preview_json, status, created_at, user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
        .run(id, actorId, actorName, requestKey, operation, JSON.stringify(args), JSON.stringify(preview), new Date().toISOString(), userId);
      return getAction(id);
    },
    resolveAction(id, status, result = null, error = null) {
      db.prepare("UPDATE agent_actions SET status = ?, result_json = ?, error = ?, resolved_at = ? WHERE id = ?")
        .run(status, result == null ? null : JSON.stringify(result), error, new Date().toISOString(), id);
      return getAction(id);
    },
    createSession(userId = null) {
      const id = randomUUID();
      const now = new Date().toISOString();
      db.prepare("INSERT INTO assistant_sessions (id, messages_json, created_at, updated_at, user_id) VALUES (?, '[]', ?, ?, ?)").run(id, now, now, userId);
      return { id, userId, messages: [], createdAt: now, updatedAt: now };
    },
    getSession(id) {
      const row = db.prepare("SELECT * FROM assistant_sessions WHERE id = ?").get(id);
      if (!row) throw new AppError(404, "Conversation not found.");
      return { id: row.id, userId: row.user_id, messages: JSON.parse(row.messages_json), createdAt: row.created_at, updatedAt: row.updated_at };
    },
    saveSession(id, messages) {
      db.prepare("UPDATE assistant_sessions SET messages_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(messages), new Date().toISOString(), id);
    },
  };
}
