import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.js";
import { setupAdmin } from "./helpers/http-auth.js";
import { seedWarehouseDemo } from "../scripts/seed-warehouse-demo.mjs";

async function setup(t) {
  const app = createApp({ database: ":memory:", env: {} });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); app.store.close(); });
  const base = `http://127.0.0.1:${app.server.address().port}`, admin = await setupAdmin(base);
  const member = app.store.auth.withUser(admin.user, () => app.store.auth.createUser({
    username: "dashboard.member", displayName: "Dashboard Member", password: "Test-dashboard-password", role: "user",
  }));
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: member.username, password: "Test-dashboard-password" }),
  });
  const memberCookie = login.headers.get("set-cookie").split(";")[0];
  const request = (path, { cookie = memberCookie, method = "GET", body, token } = {}) => fetch(base + path, {
    method, headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : cookie ? { Cookie: cookie } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { ...app, request, admin, member, memberCookie };
}

test("dashboard is an authenticated read for members; filters cannot mutate records or form definitions", async t => {
  const { store, request } = await setup(t);
  store.warehouse.ensureTables();
  const warehouse = store.warehouse.state().warehouses[0];
  const product = store.warehouse.catalog({ role: "products", values: { code: "REPORT-HTTP", name: "Flour", unit: "kg" } });
  store.warehouse.catalog({ role: "stock", values: { product: product.id, warehouse: warehouse.id, openingQuantity: 3, minimum: 5 } });
  const before = store.database.prepare("SELECT total_changes() AS count").get().count;
  const response = await request("/api/warehouse/dashboard?from=2026-05&to=2026-10&unit=kg");
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.summary.lowStockItems, 1);
  assert.equal(data.warnings[0].shortage, 2);
  assert.equal(data.reportRows.length, 6);
  assert.equal(store.database.prepare("SELECT total_changes() AS count").get().count, before);
  assert.equal((await request("/api/warehouse/dashboard", { cookie: null })).status, 401);
  assert.equal((await request("/api/warehouse/dashboard", { method: "POST", body: { minimum: 0 } })).status, 403);
  assert.equal((await request("/api/warehouse/dashboard?from=2026-11&to=2026-10")).status, 400);
  assert.equal((await request("/api/warehouse/dashboard?warehouseId=foreign")).status, 400);
  assert.equal((await request("/api/warehouse/dashboard?unit=unknown-unit")).status, 400);
  for (const path of ["/inventory-dashboard.js", "/inventory-dashboard.css", "/vendor/chart.js"]) {
    assert.equal((await request(path, { cookie: null })).status, 200);
  }
  for (const path of ["/scripts/seed-warehouse-demo.mjs", "/data/forms.sqlite", "/src/warehouse-dashboard.js"]) {
    assert.equal((await request(path)).status, 404);
  }
});

test("member-owned Agent reads the same dashboard and stays inside its token Space", async t => {
  const { store, request, member } = await setup(t);
  const ownSpace = store.spaces.create("Report Space"), otherSpace = store.spaces.create("Other Space");
  store.warehouse.ensureTables(ownSpace.id);
  const warehouse = store.warehouse.state(ownSpace.id).warehouses[0];
  const product = store.warehouse.catalog({ spaceId: ownSpace.id, role: "products", values: { code: "AGENT-REPORT", name: "Bread bags", unit: "pcs" } });
  store.warehouse.catalog({ spaceId: ownSpace.id, role: "stock", values: { product: product.id, warehouse: warehouse.id, openingQuantity: 12 } });
  const { createAgentOperations } = await import("../src/agent-operations.js");
  const operations = createAgentOperations(store);
  const token = store.auth.withUser(member, () => operations.createToken({ name: "Report reader", spaceId: ownSpace.id }));
  const args = { from: "2026-10", to: "2026-10", productId: product.id };
  const response = await request("/api/agent/operations", { token: token.token, method: "POST", body: { operation: "get_inventory_dashboard", args } });
  assert.equal(response.status, 200);
  const data = await response.json();
  const result = data.result ?? data;
  assert.deepEqual(result, { ...store.warehouseDashboard.report({ ...args, spaceId: ownSpace.id }), updatedAt: result.updatedAt });
  assert.equal(result.filters.unit, "pcs");
  assert.equal(result.summary.inventory[0].quantity, 12);
  const foreign = await request("/api/agent/operations", { token: token.token, method: "POST", body: {
    operation: "get_inventory_dashboard", args: { spaceId: otherSpace.id },
  } });
  assert.equal(foreign.status, 403);
  const tools = await (await request("/api/agent/tools", { token: token.token })).json();
  const encoded = JSON.stringify(tools);
  assert.match(encoded, /get_inventory_dashboard/);
  assert.doesNotMatch(encoded, /"name":"save_inventory_catalog"/);
});

test("demo rows produce complete six-month dashboard curves and reconciled closing balances", async t => {
  const { store } = await setup(t);
  const seeded = seedWarehouseDemo(store);
  const result = store.warehouseDashboard.report({ from: "2026-05", to: "2026-10", unit: "kg" });
  assert.equal(result.trends.points.length, 6);
  assert(result.trends.points.every(point => point.inbound > 0 && point.outbound > 0));
  assert(result.summary.lowStockItems > 0);
  assert(result.summary.pendingDocuments > 0);
  assert.equal(result.reportRows.length, 60);
  for (const row of result.reportRows.filter(row => row.month === "2026-10")) {
    assert.equal(row.closingQuantity, store.getRecord(row.stockId).values.currentQuantity);
  }
  assert.equal(seeded.applied, true);
});
