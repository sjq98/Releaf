import { DatabaseSync, backup } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createStore } from "../src/store.js";

const SEED_ID = "warehouse-dashboard-demo-v1";
const LABEL = `DEMO/Dashboard sample (${SEED_ID})`;
const PRODUCTS = [
  { code: "DEMO-FLOUR", name: "Bread flour", unit: "kg", category: "Baking ingredients", specification: "High-protein flour", minimum: [120, 80] },
  { code: "DEMO-SALT", name: "Sea salt", unit: "kg", category: "Baking ingredients", specification: "Fine sea salt", minimum: [30, 8] },
  { code: "DEMO-BUTTER", name: "Unsalted butter", unit: "kg", category: "Chilled ingredients", specification: "82% milk fat", minimum: [30, 20] },
  { code: "DEMO-SUGAR", name: "Caster sugar", unit: "kg", category: "Baking ingredients", specification: "Fine white sugar", minimum: [80, 40] },
  { code: "DEMO-YEAST", name: "Instant yeast", unit: "kg", category: "Baking ingredients", specification: "Instant dry yeast", minimum: [10, 4] },
  { code: "DEMO-BAGS", name: "Kraft bread bags", unit: "pcs", category: "Packaging", specification: "Food-grade kraft bag", minimum: [200, 100] },
];
const WAREHOUSES = [
  { code: "DEMO-CENTRAL", name: "DEMO Central Bakery", location: "DEMO industrial bakery storeroom", manager: "DEMO warehouse team" },
  { code: "DEMO-RIVERSIDE", name: "DEMO Riverside Shop", location: "DEMO retail bakery storeroom", manager: "DEMO shop team" },
];
const EXTRA_STATUSES = ["Draft", "Pending approval", "Approved", "Rejected", "Cancelled"];

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error("The sample as-of date must be a valid YYYY-MM-DD calendar date.");
  }
  return value;
}

function monthList(asOf) {
  const [year, month] = asOf.split("-").map(Number);
  return Array.from({ length: 6 }, (_, index) =>
    new Date(Date.UTC(year, month - 6 + index, 1)).toISOString().slice(0, 7));
}

function postingDate(month, day, asOf) {
  return `${month}-${String(month === asOf.slice(0, 7) ? Math.min(day, Number(asOf.slice(-2))) : day).padStart(2, "0")}`;
}

function monthlyQuantities(warehouseIndex, monthIndex) {
  const step = monthIndex;
  return warehouseIndex === 0 ? {
    inbound: [320 + 25 * step, 25 + 2 * step, 100 + 8 * step, 150 + 12 * step, 16 + 2 * step, 600 + 40 * step],
    outbound: [280 + 25 * step, 21 + 2 * step, 92 + 8 * step, 125 + 12 * step, 15 + 2 * step, 530 + 40 * step],
  } : {
    inbound: [150 + 12 * step, 12 + step, 50 + 5 * step, 75 + 6 * step, 9 + step, 280 + 20 * step],
    outbound: [140 + 12 * step, 11 + step, 46 + 5 * step, 68 + 6 * step, 8.5 + step, 260 + 20 * step],
  };
}

function assertNoConflicts(store, tables) {
  for (const [role, fixtures] of [["products", PRODUCTS], ["warehouses", WAREHOUSES]]) {
    const reserved = new Set(fixtures.map(row => row.code.toLowerCase()));
    if (store.listRecords(tables[role]).some(row => reserved.has(String(row.values.code).toLowerCase()))) {
      throw new Error("A reserved DEMO catalog code already exists without a completed seed marker. No sample records were added; existing records were preserved.");
    }
  }
  for (const role of ["inbound", "outbound"]) {
    if (store.listRecords(tables[role]).some(row => String(row.values.notes ?? "").includes(LABEL))) {
      throw new Error("Existing dashboard samples have no completed seed marker. No sample records were added; existing records were preserved.");
    }
  }
}

export function seedWarehouseDemo(store, { spaceId = "default", asOf = "2026-10-24" } = {}) {
  validDate(asOf);
  store.auth.requireAdmin();
  const admin = store.auth.currentUser() ?? store.auth.listUsers().find(user => user.active && user.role === "admin");
  const operator = admin?.username ?? "DEMO internal operator";
  const approver = admin?.username ?? "DEMO internal approver";
  return store.auth.withUser(admin ?? null, () => store.transaction(() => {
    const db = store.database;
    store.spaces.get(spaceId);
    db.exec(`CREATE TABLE IF NOT EXISTS warehouse_demo_seeds (
      space_id TEXT NOT NULL, seed_id TEXT NOT NULL, summary_json TEXT NOT NULL,
      created_at TEXT NOT NULL, PRIMARY KEY(space_id, seed_id)
    )`);
    const completed = db.prepare("SELECT summary_json FROM warehouse_demo_seeds WHERE space_id = ? AND seed_id = ?").get(spaceId, SEED_ID);
    if (completed) return { ...JSON.parse(completed.summary_json), applied: false };

    const warehouse = store.warehouse;
    const tables = warehouse.ensureTables(spaceId).tables;
    assertNoConflicts(store, tables);
    const add = (role, values) => warehouse.catalog({ spaceId, role, values });
    const warehouses = WAREHOUSES.map(values => add("warehouses", { ...values, notes: `${LABEL}; synthetic warehouse, not a real company.` }));
    const products = PRODUCTS.map(({ minimum, ...values }) => add("products", { ...values, active: true, notes: `${LABEL}; synthetic bakery catalog.` }));
    const stockRows = warehouses.map(record => products.map(product =>
      add("stock", { product: product.id, warehouse: record.id, openingQuantity: 0, minimum: 0 })));
    const months = monthList(asOf);
    const documents = { inbound: [], outbound: [] };
    let movementCount = 0, workflowEventCount = 0;
    const statuses = { inbound: {}, outbound: {} };

    const advance = (id, action, extra = {}) => warehouse.transition(id, {
      action, version: store.getRecord(id).version,
      actor: ["approve", "reject"].includes(action) ? approver : operator,
      note: `${LABEL}; ${action}.`, ...extra,
    });
    const create = (kind, warehouseIndex, date, quantities, productIndexes, status, key) => {
      const document = warehouse.createDocument({
        spaceId, kind,
        values: {
          warehouse: warehouses[warehouseIndex].id, applicant: operator, approver,
          applicationDate: date, type: kind === "inbound" ? "Purchase receipt" : "Production issue",
          notes: `${LABEL}; ${key}; synthetic training document.`,
        },
        lines: productIndexes.map(index => ({
          product: products[index].id, quantity: quantities[index], notes: `${LABEL}; ${key}.`,
        })),
      });
      const id = document.record.id;
      if (status !== "Draft") { advance(id, "submit"); workflowEventCount++; }
      if (["Approved", "Posted"].includes(status)) { advance(id, "approve"); workflowEventCount++; }
      if (status === "Posted") { advance(id, "post", { date }); movementCount += productIndexes.length; workflowEventCount++; }
      if (status === "Rejected") { advance(id, "reject"); workflowEventCount++; }
      if (status === "Cancelled") { advance(id, "cancel"); workflowEventCount++; }
      documents[kind].push(id);
      statuses[kind][status] = (statuses[kind][status] ?? 0) + 1;
    };

    // All balances come from real receipt/issue transitions, never opening-stock adjustments.
    for (const [monthIndex, month] of months.entries()) {
      for (let warehouseIndex = 0; warehouseIndex < warehouses.length; warehouseIndex++) {
        const quantities = monthlyQuantities(warehouseIndex, monthIndex);
        for (let group = 0; group < 2; group++) {
          // The smaller shop alternates its two replenishment groups each month.
          if (warehouseIndex === 1 && group !== monthIndex % 2) continue;
          const indexes = group === 0 ? [0, 1, 2] : [3, 4, 5];
          create("inbound", warehouseIndex, postingDate(month, 3 + group * 7, asOf), quantities.inbound, indexes, "Posted", `DEMO-${month}-${warehouseIndex + 1}-RECEIPT-${group + 1}`);
          if (warehouseIndex === 1 && monthIndex === months.length - 1 && group === 1) {
            quantities.outbound[5] = store.getRecord(stockRows[warehouseIndex][5].id).values.currentQuantity;
          }
          create("outbound", warehouseIndex, postingDate(month, 15 + group * 6, asOf), quantities.outbound, indexes, "Posted", `DEMO-${month}-${warehouseIndex + 1}-ISSUE-${group + 1}`);
        }
      }
    }

    for (const kind of ["inbound", "outbound"]) {
      for (const [index, status] of EXTRA_STATUSES.entries()) {
        create(kind, index % 2, asOf, [12, 2, 4, 10, 1, 30], [index % 3, 5], status, `DEMO-${kind.toUpperCase()}-${status.replaceAll(" ", "-").toUpperCase()}`);
      }
    }
    for (let warehouseIndex = 0; warehouseIndex < warehouses.length; warehouseIndex++) {
      for (let productIndex = 0; productIndex < products.length; productIndex++) {
        const record = store.getRecord(stockRows[warehouseIndex][productIndex].id);
        warehouse.catalog({ spaceId, role: "stock", recordId: record.id, version: record.version, values: { minimum: PRODUCTS[productIndex].minimum[warehouseIndex] } });
      }
    }
    const finalStocks = stockRows.flat().map(record => store.getRecord(record.id));
    const summary = {
      seedId: SEED_ID, spaceId, asOf, tables,
      period: { start: `${months[0]}-01`, end: asOf, months },
      actors: { operator, approver },
      created: {
        warehouses: warehouses.length, products: products.length, stockRows: finalStocks.length,
        inboundDocuments: documents.inbound.length, outboundDocuments: documents.outbound.length,
        inboundLines: documents.inbound.reduce((sum, id) => sum + warehouse.document(id).lines.length, 0),
        outboundLines: documents.outbound.reduce((sum, id) => sum + warehouse.document(id).lines.length, 0),
        movements: movementCount, workflowEvents: workflowEventCount,
      },
      statuses,
      lowStockRows: finalStocks.filter(record => record.values.currentQuantity < record.values.minimum).length,
      zeroStockRows: finalStocks.filter(record => record.values.currentQuantity === 0).length,
      catalogIds: { warehouses: warehouses.map(record => record.id), products: products.map(record => record.id), stock: finalStocks.map(record => record.id) },
      documentIds: documents,
    };
    db.prepare("INSERT INTO warehouse_demo_seeds (space_id, seed_id, summary_json, created_at) VALUES (?, ?, ?, ?)")
      .run(spaceId, SEED_ID, JSON.stringify(summary), new Date().toISOString());
    return { ...summary, applied: true };
  }));
}

async function main() {
  const args = process.argv.slice(2);
  const usage = "Usage: node scripts/seed-warehouse-demo.mjs --apply <database.sqlite> [--as-of YYYY-MM-DD] [--space SPACE_ID]";
  if (args[0] !== "--apply" || !args[1] || args[1].startsWith("--")) throw new Error(usage);
  const options = {};
  for (let index = 2; index < args.length; index += 2) {
    const key = { "--as-of": "asOf", "--space": "spaceId" }[args[index]];
    if (!key || !args[index + 1] || args[index + 1].startsWith("--") || Object.hasOwn(options, key)) throw new Error(usage);
    options[key] = args[index + 1];
  }
  validDate(options.asOf ?? "2026-10-24");
  const filename = resolve(args[1]);
  if (!statSync(filename).isFile()) throw new Error("Choose an existing SQLite database file.");
  const backupDirectory = resolve(dirname(filename), "backups");
  mkdirSync(backupDirectory, { recursive: true });
  const backupFile = resolve(backupDirectory, `before-warehouse-demo-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.sqlite`);
  const original = new DatabaseSync(filename, { readOnly: true });
  try { await backup(original, backupFile); } finally { original.close(); }
  const store = createStore(filename);
  try {
    const result = seedWarehouseDemo(store, options);
    console.log(JSON.stringify({
      backup: backupFile, applied: result.applied, seedId: result.seedId, spaceId: result.spaceId,
      asOf: result.asOf, period: result.period, created: result.created, statuses: result.statuses,
      lowStockRows: result.lowStockRows, zeroStockRows: result.zeroStockRows,
    }, null, 2));
  } finally { store.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
