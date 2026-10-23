import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { AppError } from "./errors.js";

const core = {
  materials: ["sku", "name", "unit", "reorderLevel"],
  products: ["productCode", "name"],
  recipes: ["product", "material", "quantityPerUnit"],
  purchases: ["purchaseNumber", "material", "quantity"],
};

export function inventoryQuantity(value, label, allowZero = false) {
  if (typeof value !== "number" || !Number.isFinite(value) || value > 1e12 ||
      (allowZero ? value < 0 : value <= 0) || new Decimal(value).decimalPlaces() > 6) {
    throw new AppError(400, `${label} must be ${allowZero ? "nonnegative" : "positive"}, at most 1e12, with up to 6 decimal places.`);
  }
  return value;
}

export function createInventoryRepository(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inventory_tables (role TEXT PRIMARY KEY, form_id TEXT NOT NULL REFERENCES forms(id));
    CREATE TABLE IF NOT EXISTS inventory_mappings (form_id TEXT PRIMARY KEY REFERENCES forms(id), payload_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS inventory_postings (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, source_record_id TEXT REFERENCES records(id),
      payload_json TEXT NOT NULL, reverses TEXT REFERENCES inventory_postings(id),
      reversed_by TEXT REFERENCES inventory_postings(id), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS inventory_entries (
      id TEXT PRIMARY KEY, posting_id TEXT NOT NULL REFERENCES inventory_postings(id),
      material_id TEXT NOT NULL REFERENCES records(id), direction TEXT NOT NULL CHECK(direction IN ('In', 'Out')),
      quantity TEXT NOT NULL, unit TEXT NOT NULL, payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS inventory_material ON inventory_entries(material_id);
    CREATE INDEX IF NOT EXISTS inventory_source ON inventory_postings(source_record_id);
    CREATE UNIQUE INDEX IF NOT EXISTS inventory_active_source ON inventory_postings(source_record_id)
      WHERE source_record_id IS NOT NULL AND reversed_by IS NULL AND kind IN ('purchase', 'order');
    CREATE TABLE IF NOT EXISTS inventory_requests (
      request_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, posting_id TEXT NOT NULL REFERENCES inventory_postings(id)
    );
  `);
  const parse = (row) => ({
    id: row.id, kind: row.kind, ...JSON.parse(row.payload_json), reverses: row.reverses,
    reversedBy: row.reversed_by, createdAt: row.created_at,
  });
  const tables = () => Object.fromEntries(db.prepare("SELECT * FROM inventory_tables").all().map((row) => [row.role, row.form_id]));
  const mappings = () => db.prepare("SELECT * FROM inventory_mappings").all().map((row) => ({ formId: row.form_id, ...JSON.parse(row.payload_json) }));
  const activeForSource = (id) => {
    const row = db.prepare("SELECT * FROM inventory_postings WHERE source_record_id = ? AND reversed_by IS NULL AND kind IN ('purchase', 'order', 'receipt')").get(id);
    return row ? parse(row) : null;
  };
  return {
    tables, mappings, activeForSource,
    setTable(role, id) { db.prepare("INSERT INTO inventory_tables VALUES (?, ?)").run(role, id); },
    saveMapping(formId, mapping) {
      db.prepare("INSERT INTO inventory_mappings VALUES (?, ?) ON CONFLICT(form_id) DO UPDATE SET payload_json = excluded.payload_json")
        .run(formId, JSON.stringify(mapping));
    },
    posting(id) {
      const row = db.prepare("SELECT * FROM inventory_postings WHERE id = ?").get(id);
      if (!row) throw new AppError(404, "Stock posting not found.");
      return parse(row);
    },
    postings() { return db.prepare("SELECT * FROM inventory_postings ORDER BY created_at DESC, rowid DESC").all().map(parse); },
    entries() {
      return db.prepare("SELECT * FROM inventory_entries ORDER BY rowid").all().map((row) => ({
        ...JSON.parse(row.payload_json), id: row.id, postingId: row.posting_id, materialId: row.material_id,
        direction: row.direction, quantity: row.quantity, unit: row.unit,
      }));
    },
    request(key) {
      const row = db.prepare("SELECT * FROM inventory_requests WHERE request_key = ?").get(key);
      return row ? { fingerprint: row.fingerprint, posting: this.posting(row.posting_id) } : null;
    },
    savePosting(preview, key, fingerprint) {
      const id = randomUUID();
      const { kind, source, lines, note, reverses = null } = preview;
      db.prepare("INSERT INTO inventory_postings VALUES (?, ?, ?, ?, ?, NULL, ?)")
        .run(id, kind, source?.recordId || null, JSON.stringify({ source, lines, note }), reverses, new Date().toISOString());
      for (const line of lines) {
        db.prepare("INSERT INTO inventory_entries VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(randomUUID(), id, line.materialId, line.direction, line.quantity, line.unit, JSON.stringify(line));
      }
      if (reverses) db.prepare("UPDATE inventory_postings SET reversed_by = ? WHERE id = ?").run(id, reverses);
      db.prepare("INSERT INTO inventory_requests VALUES (?, ?, ?)").run(key, fingerprint, id);
      return this.posting(id);
    },
    assertSchema(form, fields) {
      const role = Object.entries(tables()).find(([, id]) => id === form.id)?.[0];
      const protectedIds = new Set([...(core[role] || []), ...mappings().filter((item) => item.formId === form.id).flatMap((item) => [item.itemField, item.quantityField])]);
      for (const id of protectedIds) {
        const before = form.fields.find((field) => field.id === id), after = fields.find((field) => field.id === id);
        if (!before || !after || before.type !== after.type || before.required && !after.required || before.unique && !after.unique ||
            JSON.stringify(before.reference) !== JSON.stringify(after.reference)) {
          throw new AppError(409, `Keep the type, reference and required/unique rules for inventory field "${before?.name || id}". It can be renamed or reordered.`);
        }
      }
    },
    assertRecordWrite(form, previous, values) {
      const roles = tables();
      if (form.id === roles.materials) {
        inventoryQuantity(values.reorderLevel ?? 0, "Reorder level", true);
        if (!values.unit || values.unit.length > 32) throw new AppError(400, "A stock unit must contain 1-32 characters.");
        if (previous && previous.values.unit !== values.unit &&
            db.prepare("SELECT 1 FROM inventory_entries WHERE material_id = ? LIMIT 1").get(previous.id)) {
          throw new AppError(409, "The unit has stock history. Create a separate material for another unit.");
        }
      }
      if (form.id === roles.purchases) inventoryQuantity(values.quantity, "Purchase quantity");
      if (form.id === roles.recipes) {
        inventoryQuantity(values.quantityPerUnit, "Recipe quantity per product");
        if (db.prepare(`SELECT id FROM records WHERE form_id = ? AND deleted_at IS NULL
          AND json_extract(values_json, '$.product') = ? AND json_extract(values_json, '$.material') = ? AND id != ?`)
          .get(form.id, values.product, values.material, previous?.id || "")) {
          throw new AppError(409, "This product already has a recipe line for that material. Edit its existing quantity.");
        }
      }
      const posting = previous && activeForSource(previous.id);
      if (posting && Object.entries(posting.source.stockValues).some(([id, value]) => (values[id] ?? null) !== value)) {
        throw new AppError(409, "Reverse the stock posting before changing its material, product or quantity.");
      }
    },
    assertRecordDelete(record) {
      if (db.prepare("SELECT 1 FROM inventory_entries WHERE material_id = ? LIMIT 1").get(record.id) ||
          db.prepare("SELECT 1 FROM inventory_postings WHERE source_record_id = ? LIMIT 1").get(record.id)) {
        throw new AppError(409, "This record has stock history and cannot be deleted. Reverse a posting to correct stock.");
      }
    },
  };
}
