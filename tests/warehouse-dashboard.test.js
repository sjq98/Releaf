import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { createStore } from "../src/store.js";
import { createWarehouseDashboard } from "../src/warehouse-dashboard.js";

const fixedNow = () => new Date("2026-10-24T02:00:00Z");

function setup(t) {
  const store = createStore(":memory:");
  t.after(() => store.close());
  const wh = store.warehouse, tables = wh.ensureTables().tables, db = store.database;
  const warehouse = store.listRecords(tables.warehouses)[0];
  const add = (role, values) => wh.catalog({ role, values });
  const product = add("products", { code: "FLOUR", name: "Flour", unit: "kg" });
  const salt = add("products", { code: "SALT", name: "Salt", unit: "kg" });
  const stock = add("stock", { product: product.id, warehouse: warehouse.id, openingQuantity: 10, minimum: 5 });
  const saltStock = add("stock", { product: salt.id, warehouse: warehouse.id, openingQuantity: 2, minimum: 3 });
  const advance = (id, action, extra = {}) => wh.transition(id, {
    action, version: store.getRecord(id).version, actor: action === "approve" ? "Manager" : "Operator", note: "Test reason", ...extra,
  });
  const document = (kind, quantity, date, options = {}) => {
    const doc = wh.createDocument({
      kind, values: { warehouse: options.warehouseId ?? warehouse.id, applicant: "Applicant", approver: "Manager", applicationDate: date },
      lines: [{ product: options.productId ?? product.id, quantity }], submit: options.submit ?? true,
    });
    if (options.pending) return doc;
    advance(doc.record.id, "approve");
    return advance(doc.record.id, "post", { date });
  };
  const dashboard = createWarehouseDashboard({ db, store, now: fixedNow });
  return { store, db, wh, tables, warehouse, product, salt, stock, saltStock, add, advance, document, dashboard };
}

function assertReconciles(rows) {
  for (const row of rows) {
    assert.equal(new Decimal(row.openingQuantity).plus(row.inboundQuantity).minus(row.outboundQuantity).plus(row.adjustmentQuantity).toNumber(), row.closingQuantity);
    assert.equal(new Decimal(row.closingQuantity).minus(row.openingQuantity).toNumber(), row.netChange);
  }
}

test("monthly snapshots reconcile exact quantities, prehistory and pending documents without writing", t => {
  const { document, dashboard, stock, saltStock, db } = setup(t);
  document("inbound", 5, "2026-06-20");
  document("inbound", 0.1, "2026-07-01");
  document("outbound", 0.2, "2026-07-20");
  document("outbound", 5, "2026-08-20");
  document("inbound", 100, "2026-09-01", { pending: true });
  document("inbound", 2.3, "2026-10-20");
  const before = db.prepare("SELECT total_changes() AS count").get().count;
  const result = dashboard.report({ from: "2026-07", to: "2026-10" });
  assert.equal(db.prepare("SELECT total_changes() AS count").get().count, before);
  assertReconciles(result.reportRows);
  const flour = result.reportRows.filter(row => row.stockId === stock.id).reverse();
  assert.deepEqual(flour.map(row => [row.month, row.openingQuantity, row.closingQuantity]), [
    ["2026-07", 15, 14.9], ["2026-08", 14.9, 9.9], ["2026-09", 9.9, 9.9], ["2026-10", 9.9, 12.2],
  ]);
  assert.deepEqual(result.trends.points, [
    { month: "2026-07", inbound: 0.1, outbound: 0.2 }, { month: "2026-08", inbound: 0, outbound: 5 },
    { month: "2026-09", inbound: 0, outbound: 0 }, { month: "2026-10", inbound: 2.3, outbound: 0 },
  ]);
  assert.deepEqual(result.summary, {
    stockItems: 2, lowStockItems: 1, inboundDocuments: 2, outboundDocuments: 2, pendingDocuments: 1,
    inventory: [{ unit: "kg", quantity: 14.2 }],
  });
  assert.equal(result.warnings[0].stockId, saltStock.id);
  assert.equal(result.warnings[0].shortage, 1);
  assert.equal(flour[0].turnoverRate, new Decimal(0.2).dividedBy(new Decimal(15).plus(14.9).dividedBy(2)).toNumber());
  assert.equal(flour[2].turnoverRate, 0);
  assert.equal(flour[2].turnoverDays, null);
  assert.equal(flour[1].days, 31);
  assert.equal(result.updatedAt, "2026-10-24T02:00:00.000Z");
});

test("reversals adjust their Singapore effective month and never double-count receipts or issues", t => {
  const { document, advance, dashboard, stock, db } = setup(t);
  const receipt = document("inbound", 4, "2026-08-12");
  const issue = document("outbound", 2, "2026-09-12");
  advance(issue.record.id, "reverse");
  db.prepare("UPDATE warehouse_movements SET created_at = ? WHERE document_id = ? AND reversal = 1").run("2026-09-30T16:30:00Z", issue.record.id);
  advance(receipt.record.id, "reverse");
  db.prepare("UPDATE warehouse_movements SET created_at = ? WHERE document_id = ? AND reversal = 1").run("2026-10-15T00:00:00Z", receipt.record.id);
  const result = dashboard.report({ from: "2026-08", to: "2026-10" });
  assertReconciles(result.reportRows);
  const rows = result.reportRows.filter(row => row.stockId === stock.id).reverse();
  assert.deepEqual(rows.map(row => [row.month, row.inboundQuantity, row.outboundQuantity, row.adjustmentQuantity, row.closingQuantity]), [
    ["2026-08", 4, 0, 0, 14], ["2026-09", 0, 2, 0, 12], ["2026-10", 0, 0, -2, 10],
  ]);
  assert.deepEqual(result.trends.points, [
    { month: "2026-08", inbound: 4, outbound: 0 }, { month: "2026-09", inbound: 0, outbound: 2 },
    { month: "2026-10", inbound: 0, outbound: 0 },
  ]);
  assert.equal(result.summary.inboundDocuments, 1);
  assert.equal(result.summary.outboundDocuments, 1);
  assert.equal(result.warnings.find(row => row.stockId === stock.id).currentQuantity, 10);
  assert.equal(dashboard.report({ from: "2026-10", to: "2026-10" }).reportRows.find(row => row.stockId === stock.id).openingQuantity, 12);
});

test("warehouse, product and unit filters apply consistently and foreign selections are rejected", t => {
  const { store, add, dashboard, product, warehouse, document } = setup(t);
  const box = add("products", { code: "BOX", name: "Boxes", unit: "pcs" });
  const otherWarehouse = add("warehouses", { code: "W2", name: "Second warehouse" });
  add("stock", { product: box.id, warehouse: warehouse.id, openingQuantity: 100, minimum: 20 });
  add("stock", { product: product.id, warehouse: otherWarehouse.id, openingQuantity: 50 });
  document("inbound", 5, "2026-10-12", { warehouseId: otherWarehouse.id });
  document("outbound", 12, "2026-10-12", { productId: box.id });
  document("inbound", 7, "2026-10-14", { productId: box.id, pending: true });
  const kg = dashboard.report({ from: "2026-10", to: "2026-10" });
  assert.equal(kg.filters.unit, "kg");
  assert.deepEqual(kg.available.units, ["kg", "pcs"]);
  assert.equal(kg.summary.stockItems, 3);
  assert.deepEqual(kg.summary.inventory, [{ unit: "kg", quantity: 67 }]);
  assert.equal(kg.summary.outboundDocuments, 0);
  assert.equal(kg.summary.pendingDocuments, 0);
  assert.equal(kg.reportRows.every(row => row.unit === "kg"), true);
  const boxes = dashboard.report({ from: "2026-10", to: "2026-10", warehouseId: warehouse.id, productId: box.id, unit: "pcs" });
  assert.equal(boxes.summary.stockItems, 1);
  assert.equal(boxes.summary.outboundDocuments, 1);
  assert.equal(boxes.summary.pendingDocuments, 1);
  assert.deepEqual(boxes.summary.inventory, [{ unit: "pcs", quantity: 88 }]);
  assert.deepEqual(boxes.trends.points, [{ month: "2026-10", inbound: 0, outbound: 12 }]);
  const boxesImplicit = dashboard.report({ from: "2026-10", to: "2026-10", productId: box.id });
  assert.equal(boxesImplicit.filters.unit, "pcs");
  assert.deepEqual(boxesImplicit.summary.inventory, [{ unit: "pcs", quantity: 88 }]);
  assert.throws(() => dashboard.report({ unit: "liters" }), error => error.status === 400 && /available inventory unit/.test(error.message));
  assert.throws(() => dashboard.report({ productId: box.id, unit: "kg" }), error => error.status === 400 && /uses pcs/.test(error.message));
  const flour = dashboard.report({ from: "2026-10", to: "2026-10", warehouseId: otherWarehouse.id, productId: product.id });
  assert.equal(flour.summary.stockItems, 1);
  assert.deepEqual(flour.trends.points, [{ month: "2026-10", inbound: 5, outbound: 0 }]);
  const space = store.spaces.create("Foreign"), foreignTables = store.warehouse.ensureTables(space.id).tables;
  const foreignWarehouse = store.listRecords(foreignTables.warehouses)[0];
  const foreignProduct = store.warehouse.catalog({ spaceId: space.id, role: "products", values: { code: "FOREIGN", name: "Foreign", unit: "kg" } });
  assert.throws(() => dashboard.report({ warehouseId: foreignWarehouse.id }), /warehouse in this Space/);
  assert.throws(() => dashboard.report({ productId: foreignProduct.id }), /product in this Space/);
});

test("future posting dates leave earlier snapshots unchanged while current stock matches its table", t => {
  const { document, dashboard, stock, store } = setup(t);
  document("inbound", 5, "2026-12-02");
  const past = dashboard.report({ from: "2026-10", to: "2026-11" });
  assert.equal(past.reportRows.filter(row => row.stockId === stock.id).every(row => row.openingQuantity === 10 && row.closingQuantity === 10), true);
  assert.equal(past.summary.inboundDocuments, 0);
  assert.equal(past.warnings.find(row => row.stockId === stock.id).currentQuantity, store.getRecord(stock.id).values.currentQuantity);
  assert.equal(past.warnings.find(row => row.stockId === stock.id).currentQuantity, 15);
  const future = dashboard.report({ from: "2026-12", to: "2026-12" });
  assert.equal(future.reportRows.find(row => row.stockId === stock.id).closingQuantity, 15);
});

test("reports read every ledger entry rather than the truncated activity feed", t => {
  const { db, tables, stock, warehouse, dashboard, wh } = setup(t);
  const insertDocument = db.prepare("INSERT INTO records (id, form_id, values_json, version, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)");
  const insertMovement = db.prepare("INSERT INTO warehouse_movements VALUES (?, 'default', ?, ?, 'In', '0.1', 0, 'Operator', '', ?)");
  const timestamp = "2026-10-01T00:00:00Z";
  db.exec("BEGIN");
  try {
    for (let index = 0; index < 1005; index++) {
      const id = randomUUID();
      insertDocument.run(id, tables.inbound, JSON.stringify({ number: `BULK-${index}`, status: "Posted", warehouse: warehouse.id, postedDate: "2026-10-01" }), timestamp, timestamp);
      insertMovement.run(randomUUID(), id, stock.id, timestamp);
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  assert.equal(wh.state().movements.length, 1000);
  const result = dashboard.report({ from: "2026-10", to: "2026-10" });
  assert.equal(result.trends.points[0].inbound, 100.5);
  assert.equal(result.summary.inboundDocuments, 1005);
  assert.equal(result.reportRows.find(row => row.stockId === stock.id).closingQuantity, 110.5);
  assertReconciles(result.reportRows);
});

test("month validation, Singapore defaults and an unconfigured Space are safe and read-only", t => {
  const store = createStore(":memory:");
  t.after(() => store.close());
  const dashboard = createWarehouseDashboard({ db: store.database, store, now: () => new Date("2026-09-30T17:00:00Z") });
  const before = store.database.prepare("SELECT total_changes() AS count").get().count;
  const result = dashboard.report();
  assert.equal(result.setupRequired, true);
  assert.equal(result.filters.from, "2026-05");
  assert.equal(result.filters.to, "2026-10");
  assert.equal(result.filters.unit, null);
  assert.deepEqual(result.available, { warehouses: [], products: [], units: [] });
  assert.deepEqual(result.reportRows, []);
  assert.equal(result.trends.points.length, 6);
  assert.equal(store.database.prepare("SELECT total_changes() AS count").get().count, before);
  for (const query of [
    { from: "2026-13" }, { to: "2026-2" }, { from: "0000-01" }, { from: "2026-11", to: "2026-10" },
    { from: "2024-10", to: "2026-10" }, { from: ["2026-01"] }, { warehouseId: {} }, { unit: "kg" },
  ]) assert.throws(() => dashboard.report(query), error => error.status === 400);
  assert.equal(dashboard.report({ from: "2024-11", to: "2026-10" }).trends.points.length, 24);
});

test("zero-average stock returns undefined turnover safely and draft records do not affect totals", t => {
  const { add, warehouse, document, dashboard, wh } = setup(t);
  const product = add("products", { code: "ZERO", name: "Just in time", unit: "kg" });
  document("inbound", 3, "2026-10-01", { productId: product.id });
  document("outbound", 3, "2026-10-20", { productId: product.id });
  wh.createDocument({
    kind: "inbound", values: { warehouse: warehouse.id, applicant: "A", approver: "Manager", applicationDate: "2026-10-01" },
    lines: [{ product: product.id, quantity: 999 }],
  });
  const result = dashboard.report({ from: "2026-10", to: "2026-10", productId: product.id });
  assert.equal(result.reportRows.length, 1);
  assert.equal(result.reportRows[0].turnoverRate, null);
  assert.equal(result.reportRows[0].turnoverDays, null);
  assert.equal(result.summary.pendingDocuments, 0);
  assert.deepEqual(result.trends.points, [{ month: "2026-10", inbound: 3, outbound: 3 }]);
  assertReconciles(result.reportRows);
});
