import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Decimal from "decimal.js";
import { createStore } from "../src/store.js";
import { seedWarehouseDemo } from "../scripts/seed-warehouse-demo.mjs";

function fixture(t) {
  const store = createStore(":memory:");
  t.after(() => store.close());
  const tables = store.warehouse.ensureTables().tables;
  const originalWarehouse = store.listRecords(tables.warehouses)[0];
  const originalProduct = store.warehouse.catalog({ role: "products", values: { code: "EXISTING-FLOUR", name: "Existing flour", unit: "kg" } });
  const originalStock = store.warehouse.catalog({ role: "stock", values: { product: originalProduct.id, warehouse: originalWarehouse.id, openingQuantity: 7, minimum: 2 } });
  const originalDocument = store.warehouse.createDocument({
    kind: "inbound", values: { warehouse: originalWarehouse.id, applicant: "Existing applicant", notes: "Keep this existing draft" },
    lines: [{ product: originalProduct.id, quantity: 2 }],
  });
  const originals = [originalWarehouse, originalProduct, originalStock, store.getRecord(originalDocument.record.id), ...originalDocument.lines];
  return { store, tables, originals };
}

function snapshot(store) {
  return {
    records: store.database.prepare("SELECT * FROM records ORDER BY rowid").all(),
    history: store.database.prepare("SELECT * FROM form_activity ORDER BY rowid").all(),
    movements: store.database.prepare("SELECT * FROM warehouse_movements ORDER BY rowid").all(),
    events: store.database.prepare("SELECT * FROM warehouse_events ORDER BY rowid").all(),
    notifications: store.automation.notifications(),
  };
}

test("dashboard samples preserve existing records and reconcile every warehouse balance through posted workflows", t => {
  const { store, tables, originals } = fixture(t);
  const result = seedWarehouseDemo(store);
  assert.equal(result.applied, true);
  assert.deepEqual(result.created, {
    warehouses: 2, products: 6, stockRows: 12,
    inboundDocuments: 23, outboundDocuments: 23, inboundLines: 64, outboundLines: 64,
    movements: 108, workflowEvents: 122,
  });
  for (const record of originals) assert.deepEqual(store.getRecord(record.id), record);
  assert.equal(store.auth.status().setupRequired, true);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM auth_sessions").get().count, 0);
  assert.equal(store.listRecords(tables.products).length, 7);
  assert.ok(store.listRecords(tables.products).filter(record => result.catalogIds.products.includes(record.id)).every(record => record.values.code.startsWith("DEMO-")));
  assert.ok(result.lowStockRows >= 4);
  assert.equal(result.zeroStockRows, 1);
  const movements = store.database.prepare("SELECT * FROM warehouse_movements ORDER BY rowid").all();
  assert.equal(movements.length, result.created.movements);
  for (const id of result.catalogIds.stock) {
    const record = store.getRecord(id);
    assert.equal(record.values.openingQuantity, 0);
    let quantity = new Decimal(0);
    for (const movement of movements.filter(row => row.stock_id === id)) {
      quantity = movement.direction === "In" ? quantity.plus(movement.quantity) : quantity.minus(movement.quantity);
      assert.ok(quantity.gte(0), "No posting creates a negative balance.");
      const header = store.getRecord(movement.document_id);
      assert.equal(header.values.status, "Posted");
      assert.equal(header.values.warehouse, record.values.warehouse);
      assert.match(header.values.notes, /DEMO\/Dashboard sample/);
    }
    assert.equal(record.values.currentQuantity, quantity.toNumber());
  }
});

test("sample date coverage, references, totals and unposted workflow examples are consistent", t => {
  const { store } = fixture(t);
  const result = seedWarehouseDemo(store, { asOf: "2026-10-24" });
  assert.deepEqual(result.period.months, ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
  for (const kind of ["inbound", "outbound"]) {
    assert.deepEqual(result.statuses[kind], { Posted: 18, Draft: 1, "Pending approval": 1, Approved: 1, Rejected: 1, Cancelled: 1 });
    const postedMonths = new Set();
    for (const id of result.documentIds[kind]) {
      const { record, lines, events } = store.warehouse.document(id);
      assert.equal(record.values.totalQuantity, lines.reduce((sum, line) => new Decimal(sum).plus(line.values.quantity).toNumber(), 0));
      assert.ok(lines.length >= 2);
      for (const line of lines) {
        assert.equal(line.values.document, id);
        assert.equal(line.values.status, record.values.status);
        assert.equal(line.values.postedDate, record.values.postedDate);
        assert.ok(result.catalogIds.products.includes(line.values.product));
      }
      const posted = record.values.status === "Posted";
      assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM warehouse_movements WHERE document_id = ?").get(id).count, posted ? lines.length : 0);
      if (posted) {
        assert.ok(record.values.postedDate >= result.period.start && record.values.postedDate <= result.asOf);
        postedMonths.add(record.values.postedDate.slice(0, 7));
        assert.deepEqual(events.map(event => event.action), ["submit", "approve", "post"]);
      } else assert.equal(record.values.postedDate, null);
    }
    assert.deepEqual([...postedMonths].sort(), result.period.months);
  }
});

test("reruns are no-ops even after an administrator edits a sample catalog record", t => {
  const { store } = fixture(t);
  const result = seedWarehouseDemo(store);
  const product = store.getRecord(result.catalogIds.products[0]);
  store.warehouse.catalog({ role: "products", recordId: product.id, version: product.version, values: { name: "User-edited sample name" } });
  const before = snapshot(store);
  const replay = seedWarehouseDemo(store, { asOf: "2027-02-15" });
  assert.deepEqual(replay, { ...result, applied: false });
  assert.deepEqual(snapshot(store), before);
  assert.equal(store.getRecord(product.id).values.name, "User-edited sample name");
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM warehouse_demo_seeds").get().count, 1);
});

test("existing DEMO codes are never reused or overwritten and a conflict rolls back all new records", t => {
  const { store, tables, originals } = fixture(t);
  const conflicting = store.warehouse.catalog({ role: "products", values: { code: "demo-flour", name: "User's own flour", unit: "kg" } });
  const before = snapshot(store);
  assert.throws(() => seedWarehouseDemo(store), /reserved DEMO catalog code/);
  assert.deepEqual(snapshot(store), before);
  assert.deepEqual(store.getRecord(conflicting.id), conflicting);
  for (const record of originals) assert.deepEqual(store.getRecord(record.id), record);
  assert.equal(store.listRecords(tables.warehouses).length, 1);
  assert.equal(store.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'warehouse_demo_seeds'").get(), undefined);
});

test("a mid-seed workflow failure rolls back catalogs, documents, movements and the completion marker", t => {
  const { store } = fixture(t);
  const originalTransition = store.warehouse.transition;
  const before = snapshot(store);
  let calls = 0;
  store.warehouse.transition = (...args) => {
    if (++calls === 8) throw new Error("Injected posting failure");
    return originalTransition(...args);
  };
  assert.throws(() => seedWarehouseDemo(store), /Injected posting failure/);
  assert.deepEqual(snapshot(store), before);
  assert.equal(store.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'warehouse_demo_seeds'").get(), undefined);
  store.warehouse.transition = originalTransition;
  assert.equal(seedWarehouseDemo(store).applied, true);
});

test("an existing active administrator is used without creating users, sessions or changing the caller identity", t => {
  const { store } = fixture(t);
  const { user } = store.auth.setup({ username: "existing.admin", displayName: "Existing administrator", password: "Existing-test-password-2026" });
  const accounts = store.database.prepare("SELECT * FROM auth_users ORDER BY id").all();
  const sessions = store.database.prepare("SELECT * FROM auth_sessions ORDER BY token_hash").all();
  const result = seedWarehouseDemo(store);
  assert.equal(result.actors.operator, user.username);
  assert.equal(result.actors.approver, user.username);
  assert.equal(store.auth.currentUser(), undefined);
  assert.deepEqual(store.database.prepare("SELECT * FROM auth_users ORDER BY id").all(), accounts);
  assert.deepEqual(store.database.prepare("SELECT * FROM auth_sessions ORDER BY token_hash").all(), sessions);
  const events = store.database.prepare("SELECT actor FROM warehouse_events").all();
  assert.ok(events.every(event => event.actor === user.username));
  assert.ok(result.documentIds.inbound.every(id => store.getRecord(id).values.applicant === user.username));
});

test("sample seeding is Space scoped and safely handles early dates in a new year", t => {
  const { store, tables } = fixture(t);
  const before = store.listRecords(tables.products);
  const space = store.spaces.create("Other company");
  const result = seedWarehouseDemo(store, { spaceId: space.id, asOf: "2026-01-02" });
  assert.deepEqual(result.period.months, ["2025-08", "2025-09", "2025-10", "2025-11", "2025-12", "2026-01"]);
  assert.deepEqual(store.listRecords(tables.products), before);
  assert.equal(store.listRecords(result.tables.products).length, 6);
  assert.ok(result.documentIds.inbound.every(id => (store.getRecord(id).values.postedDate ?? result.asOf) <= result.asOf));
  assert.equal(seedWarehouseDemo(store, { spaceId: space.id }).applied, false);
  assert.equal(seedWarehouseDemo(store).applied, true);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM warehouse_demo_seeds").get().count, 2);
});

test("sample date validation rejects impossible dates before any seed writes", t => {
  const { store } = fixture(t);
  const before = snapshot(store);
  for (const asOf of ["2026-02-30", "2026-13-01", "2026-1-2", "", null]) {
    assert.throws(() => seedWarehouseDemo(store, { asOf }), /valid YYYY-MM-DD/);
  }
  assert.deepEqual(snapshot(store), before);
});

test("ordinary account contexts cannot run the trusted sample seeder", t => {
  const { store } = fixture(t);
  const { user: admin } = store.auth.setup({ username: "sample.admin", password: "Sample-test-password-2026" });
  const member = store.auth.withUser(admin, () => store.auth.createUser({
    username: "sample.member", password: "Sample-test-password-2026", role: "user",
  }));
  const before = snapshot(store);
  store.auth.withUser(member, () => {
    assert.throws(() => seedWarehouseDemo(store), error => error.status === 403);
    assert.equal(store.auth.currentUser().id, member.id);
  });
  assert.deepEqual(snapshot(store), before);
});

test("the CLI requires explicit apply and creates a readable pre-seed SQLite backup", t => {
  const folder = mkdtempSync(join(tmpdir(), "releaf-demo-cli-"));
  t.after(() => {
    assert.equal(dirname(resolve(folder)), resolve(tmpdir()));
    rmSync(folder, { recursive: true, force: true });
  });
  const filename = join(folder, "forms.sqlite");
  const script = fileURLToPath(new URL("../scripts/seed-warehouse-demo.mjs", import.meta.url));
  let store = createStore(filename);
  const source = store.listForms()[0];
  const original = store.createRecord(source.id, { schemaVersion: source.version, values: { name: "Preserved CLI record" } }).record;
  const beforeRecords = store.database.prepare("SELECT COUNT(*) AS count FROM records").get().count;
  store.close();
  const withoutApply = spawnSync(process.execPath, [script, filename], { encoding: "utf8" });
  assert.equal(withoutApply.status, 1);
  assert.match(withoutApply.stderr, /Usage:/);
  assert.deepEqual(readdirSync(folder).filter(name => name === "backups"), []);
  const applied = spawnSync(process.execPath, [script, "--apply", filename, "--as-of", "2026-10-24"], { encoding: "utf8" });
  assert.equal(applied.status, 0, applied.stderr);
  const result = JSON.parse(applied.stdout);
  assert.equal(result.applied, true);
  assert.equal(dirname(result.backup), join(folder, "backups"));
  const originalDatabase = new DatabaseSync(result.backup, { readOnly: true });
  try {
    assert.equal(originalDatabase.prepare("SELECT COUNT(*) AS count FROM records").get().count, beforeRecords);
    assert.equal(originalDatabase.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'warehouse_demo_seeds'").get(), undefined);
    assert.equal(JSON.parse(originalDatabase.prepare("SELECT values_json FROM records WHERE id = ?").get(original.id).values_json).name, "Preserved CLI record");
  } finally { originalDatabase.close(); }
  store = createStore(filename);
  try {
    assert.deepEqual(store.getRecord(original.id), original);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM warehouse_demo_seeds").get().count, 1);
    assert.equal(store.auth.status().setupRequired, true);
  } finally { store.close(); }
});
