import { randomUUID } from "node:crypto";
import { AppError } from "./errors.js";

export function createSpaces(db, modules = [], assertFormEditable = () => {}) {
  const migrated = Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'navigation_nodes'").get());
  db.exec(`
    CREATE TABLE IF NOT EXISTS spaces (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    INSERT OR IGNORE INTO spaces VALUES ('default', 'Inventory Management System');
    CREATE TABLE IF NOT EXISTS navigation_nodes (
      id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id), parent_id TEXT REFERENCES navigation_nodes(id),
      kind TEXT NOT NULL, name TEXT NOT NULL, form_id TEXT UNIQUE REFERENCES forms(id), position INTEGER NOT NULL DEFAULT 0
    );
  `);
  if (!db.prepare("PRAGMA table_info(forms)").all().some((column) => column.name === "space_id")) {
    db.exec("ALTER TABLE forms ADD COLUMN space_id TEXT NOT NULL DEFAULT 'default'");
  }
  for (const [index, module] of (migrated ? [] : modules).entries()) {
    db.prepare("INSERT OR IGNORE INTO navigation_nodes (id, space_id, kind, name, position) VALUES (?, 'default', 'node', ?, ?)").run(`node_${module.id}`, module.name, index);
  }
  for (const form of migrated ? [] : db.prepare("SELECT * FROM forms WHERE deleted_at IS NULL").all()) {
    db.prepare("INSERT OR IGNORE INTO navigation_nodes (id, space_id, parent_id, kind, name, form_id) VALUES (?, ?, ?, 'form', ?, ?)").run(
      `form_${form.id}`, form.space_id, null, form.name, form.id);
  }
  const name = (value) => {
    if (typeof value !== "string" || !value.trim() || value.trim().length > 80) throw new AppError(400, "Enter a name of 1-80 characters.");
    return value.trim();
  };
  function get(id = "default") {
    const row = db.prepare("SELECT * FROM spaces WHERE id = ?").get(id);
    if (!row) throw new AppError(404, "Space not found.");
    return row;
  }
  function node(id) {
    const row = db.prepare("SELECT * FROM navigation_nodes WHERE id = ?").get(id);
    if (!row) throw new AppError(404, "Navigation entry not found.");
    return { id: row.id, spaceId: row.space_id, parentId: row.parent_id, kind: row.kind, name: row.name, formId: row.form_id, position: row.position };
  }
  function parent(spaceId, id) {
    get(spaceId);
    if (id == null || id === "") return null;
    const target = node(id);
    if (target.spaceId !== spaceId || target.kind !== "node") throw new AppError(400, "Choose a parent node in the same Space.");
    return target.id;
  }
  function attach(form, parentId) {
    const candidate = `node_${form.moduleId}`;
    const fallback = form.spaceId === "default" && db.prepare("SELECT id FROM navigation_nodes WHERE id = ?").get(candidate) ? candidate : null;
    const target = parent(form.spaceId, parentId === undefined ? fallback : parentId);
    db.prepare("INSERT INTO navigation_nodes (id, space_id, parent_id, kind, name, form_id, position) VALUES (?, ?, ?, 'form', ?, ?, ?)").run(
      `form_${form.id}`, form.spaceId, target, form.name, form.id, Date.now());
  }
  function moveNode(id, body) {
    const current = node(id);
    if (!body || !["before", "after", "inside"].includes(body.placement) ||
        !(typeof body.targetId === "string" || body.targetId === null)) throw new AppError(400, "Choose a navigation drop target and placement.");
    const target = body.targetId === null ? null : node(body.targetId);
    if (target && target.spaceId !== current.spaceId) throw new AppError(400, "Navigation moves must stay in the same Space.");
    if (!target && body.placement !== "inside") throw new AppError(400, "Choose a navigation drop target and placement.");
    if (target?.id === id) throw new AppError(400, "A node cannot be moved into itself or a descendant.");
    const next = body.placement === "inside" ? parent(current.spaceId, target?.id) : target.parentId;
    let cursor = next, depth = 0;
    while (cursor) {
      if (cursor === id || ++depth > 100) throw new AppError(400, "A node cannot be moved into itself or a descendant.");
      cursor = node(cursor).parentId;
    }
    const siblings = (parentId) => db.prepare("SELECT id FROM navigation_nodes WHERE space_id = ? AND parent_id IS ? AND id != ? ORDER BY position, rowid")
      .all(current.spaceId, parentId, id).map((row) => row.id);
    const destination = siblings(next);
    const index = body.placement === "inside" ? destination.length : destination.indexOf(target.id) + (body.placement === "after" ? 1 : 0);
    destination.splice(index, 0, id);
    // Renumber both sibling lists atomically; descendants keep their parent IDs and form versions.
    db.exec("SAVEPOINT navigation_move");
    try {
      db.prepare("UPDATE navigation_nodes SET parent_id = ? WHERE id = ?").run(next, id);
      const position = db.prepare("UPDATE navigation_nodes SET position = ? WHERE id = ?");
      if (next !== current.parentId) siblings(current.parentId).forEach((item, index) => position.run(index, item));
      destination.forEach((item, index) => position.run(index, item));
      db.exec("RELEASE navigation_move");
    } catch (error) {
      db.exec("ROLLBACK TO navigation_move; RELEASE navigation_move");
      throw error;
    }
    return node(id);
  }
  return {
    get, parent, attach, node, moveNode,
    list: () => db.prepare("SELECT * FROM spaces ORDER BY rowid").all(),
    create(value) {
      const id = randomUUID();
      db.prepare("INSERT INTO spaces VALUES (?, ?)").run(id, name(value));
      return get(id);
    },
    rename(id, value) { get(id); db.prepare("UPDATE spaces SET name = ? WHERE id = ?").run(name(value), id); return get(id); },
    tree(spaceId = "default") { get(spaceId); return db.prepare("SELECT id FROM navigation_nodes WHERE space_id = ? ORDER BY position, rowid").all(spaceId).map((row) => node(row.id)); },
    createNode(body) {
      const spaceId = body.spaceId ?? "default", id = randomUUID();
      db.prepare("INSERT INTO navigation_nodes (id, space_id, parent_id, kind, name, position) VALUES (?, ?, ?, 'node', ?, ?)").run(id, spaceId, parent(spaceId, body.parentId), name(body.name), Date.now());
      return node(id);
    },
    updateNode(id, body) {
      const current = node(id);
      const next = Object.hasOwn(body, "parentId") ? parent(current.spaceId, body.parentId) : current.parentId;
      let cursor = next, depth = 0;
      while (cursor) {
        if (cursor === id || ++depth > 100) throw new AppError(400, "A node cannot be moved into itself or a descendant.");
        cursor = node(cursor).parentId;
      }
      const title = body.name === undefined ? current.name : name(body.name);
      if (current.formId && title !== current.name) assertFormEditable(current.formId);
      const position = body.position === undefined ? current.position : body.position;
      if (!Number.isSafeInteger(position)) throw new AppError(400, "Invalid navigation position.");
      db.prepare("UPDATE navigation_nodes SET parent_id = ?, name = ?, position = ? WHERE id = ?").run(next, title, position, id);
      if (current.formId) db.prepare("UPDATE forms SET name = ?, version = version + 1, updated_at = ? WHERE id = ?").run(title, new Date().toISOString(), current.formId);
      return node(id);
    },
    renameForm(id, value) { db.prepare("UPDATE navigation_nodes SET name = ? WHERE form_id = ?").run(value, id); },
    deleteNode(id) {
      const current = node(id);
      if (current.kind !== "node") throw new AppError(400, "Form data cannot be deleted through navigation.");
      if (db.prepare("SELECT id FROM navigation_nodes WHERE parent_id = ?").get(id)) throw new AppError(409, "Move or remove the children before deleting this node.");
      db.prepare("DELETE FROM navigation_nodes WHERE id = ?").run(id);
      return { id };
    },
  };
}
