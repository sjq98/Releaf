import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.js";
import { createAgentOperations } from "../src/agent-operations.js";
import { setupAdmin } from "./helpers/http-auth.js";
import { ORDER_SPACE_ID } from "../src/order-system.js";

async function fixture(t) {
  const app = createApp({ database: ":memory:", env: {} });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const admin = await setupAdmin(base);
  const member = app.store.auth.withUser(admin.user, () => app.store.auth.createUser({
    username: "orders.member", password: "Test-only-password-2026", role: "user",
  }));
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: member.username, password: "Test-only-password-2026" }),
  });
  assert.equal(login.status, 200);
  const memberCookie = login.headers.get("set-cookie").split(";")[0];
  const request = (path, { cookie = memberCookie, method = "GET", body, token, key } = {}) => fetch(base + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : cookie ? { Cookie: cookie } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const body = {
    customerName: "Lee", fulfillment: "pickup", totalAmount: 17.8, reviewed: true,
    notes: "Chicken rice x 2 portions\nOne without chilli",
  };
  return { ...app, admin, member, request, body };
}

test("order HTTP entry, finance and notification actions share ownership and version checks", async t => {
  const { request, admin, body } = await fixture(t);
  assert.equal((await request("/api/orders", { cookie: null })).status, 401);
  for (const path of ["/orders.js", "/orders.css"]) {
    assert.equal((await request(path, { cookie: null })).status, 200);
  }
  const created = await request("/api/orders", { method: "POST", body, key: "new-order" });
  assert.equal(created.status, 201);
  let order = await created.json();
  const retry = await request("/api/orders", { method: "POST", body, key: "new-order" });
  assert.equal((await retry.json()).id, order.id);
  assert.equal((await (await request("/api/orders")).json()).length, 1);
  const path = `/api/orders/${order.id}`;
  const edited = await request(path, { method: "PATCH", body: { version: order.version, department: "Counter", reviewed: true } });
  assert.equal(edited.status, 200);
  order = await edited.json();
  assert.equal(order.department, "Counter");
  assert.equal((await request(path, { method: "PATCH", body: { version: 1, notes: "Stale" } })).status, 409);
  const payment = await request(`${path}/payment-confirmation`, {
    method: "POST", body: { version: order.version, confirmed: true },
  });
  assert.equal(payment.status, 200);
  order = await payment.json();
  assert.equal(order.paymentConfirmed, true);
  assert.equal(order.receivedAmount, undefined);
  assert.equal(order.outstandingAmount, undefined);
  assert.ok(order.paymentConfirmation.confirmedBy);
  assert.equal((await request(`${path}/payments`, {
    method: "POST", body: { version: order.version, amount: 10, method: "Cash" },
  })).status, 410);
  const invoice = await request(`${path}/invoices`, {
    method: "POST", body: { version: order.version, amount: 17.8, number: "INV-1", note: "Customer copy" },
  });
  assert.equal(invoice.status, 200);
  order = await invoice.json();
  assert.equal(order.uninvoicedAmount, 0);
  const notification = await request(`${path}/notifications`, { method: "POST", body: { version: order.version } });
  assert.equal(notification.status, 200);
  assert.equal((await notification.json()).channel, "local");
  assert.equal((await request(`${path}/transition`, {
    method: "POST", body: { version: order.version, action: "accept" },
  })).status, 409);
  order = await (await request(path)).json();
  const accepted = await request(`${path}/transition`, {
    method: "POST", body: { version: order.version, action: "accept" },
  });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).status, "accepted");
  const foreign = await (await request("/api/orders", {
    cookie: admin.cookie, method: "POST", body: { ...body, customerName: "Admin customer" },
  })).json();
  assert.equal((await request(`/api/orders/${foreign.id}`)).status, 404);
  assert.equal((await request(`/api/orders/${foreign.id}`, {
    method: "PATCH", body: { version: foreign.version, notes: "Forbidden" },
  })).status, 404);
  assert.equal((await (await request("/api/orders/workspace")).json()).orders.length, 1);
  assert.equal((await (await request("/api/orders/workspace", { cookie: admin.cookie })).json()).orders.length, 2);
});

test("external order tokens support reviewed and idempotent full writes without crossing Spaces", async t => {
  const { store, admin, member, request, body } = await fixture(t);
  const operations = createAgentOperations(store);
  const token = store.auth.withUser(member, () => operations.createToken({ name: "Order assistant", spaceId: ORDER_SPACE_ID }));
  const run = (operation, args, key) => request("/api/agent/operations", {
    token: token.token, method: "POST", body: { operation, args }, key,
  });
  assert.equal((await request("/api/orders", { token: token.token })).status, 403);
  assert.equal((await run("create_order", body)).status, 400);
  const pending = await run("create_order", body, "reviewed-order");
  assert.equal(pending.status, 202);
  const action = await pending.json();
  assert.equal(action.status, "pending");
  assert.deepEqual(await (await request("/api/orders")).json(), []);
  assert.equal((await request(`/api/assistant/actions/${action.id}/approve`, {
    token: token.token, method: "POST", body: {},
  })).status, 403);
  const approval = await request(`/api/assistant/actions/${action.id}/approve`, { method: "POST", body: {} });
  assert.equal(approval.status, 200);
  const applied = await approval.json();
  assert.equal(applied.status, "applied");
  assert.equal(applied.result.createdBy, member.id);
  assert.equal((await (await run("create_order", body, "reviewed-order")).json()).id, action.id);
  assert.equal((await (await request("/api/orders")).json()).length, 1);
  assert.equal((await run("list_orders", { spaceId: "default" })).status, 403);
  const inventoryToken = store.auth.withUser(member, () => operations.createToken({ name: "Inventory assistant", spaceId: "default" }));
  for (const [operation, args] of [
    ["list_orders", {}],
    ["get_order", { orderId: applied.result.id }],
    ["create_order", body],
    ["create_order", { ...body, spaceId: ORDER_SPACE_ID }],
  ]) {
    assert.equal((await request("/api/agent/operations", {
      token: inventoryToken.token, method: "POST", body: { operation, args }, key: `inventory-${operation}`,
    })).status, 403);
  }
  const full = store.auth.withUser(member, () => operations.createToken({ name: "Full order assistant", mode: "full", spaceId: ORDER_SPACE_ID }));
  const fullWrite = () => request("/api/agent/operations", {
    token: full.token, method: "POST", body: { operation: "create_order", args: body }, key: "full-order",
  });
  const result = await fullWrite();
  assert.equal(result.status, 200);
  const fullAction = await result.json();
  assert.equal(fullAction.status, "applied");
  assert.equal((await (await fullWrite()).json()).id, fullAction.id);
  assert.equal((await (await request("/api/orders")).json()).length, 2);
  const names = (await (await request("/api/agent/tools", { token: token.token })).json())
    .tools.map(tool => tool.function.name);
  for (const name of ["list_order_menu", "save_order_menu", "create_order_issue_draft"]) {
    assert.equal(names.includes(name), false);
    assert.equal((await run(name, {}, `removed-${name}`)).status, 400);
  }
});

test("order extraction over HTTP is read-only and does not expose catalog or warehouse actions", async t => {
  const { store, request, body } = await fixture(t);
  const text = "Lee wants 2 portions of Chicken rice for pickup. Total RM17.80.";
  store.orders.configure({
    aiConfig: { credentials: () => ({ baseUrl: "https://provider.invalid/v1", apiKey: "private", model: "test" }) },
    fetchImpl: async () => Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
      isOrder: true, orderEvidence: "Lee wants 2 portions of Chicken rice for pickup.",
      customerName: "Lee", customerPhone: null, fulfillment: "pickup", deliveryAddress: null,
      requestedTime: null, notes: null,
      items: [{ productName: "Chicken rice", quantity: 2, unit: "portion", notes: null, evidence: "2 portions of Chicken rice" }],
    }) } }] }),
  });
  const result = await request("/api/orders/extract", { method: "POST", body: { text } });
  assert.equal(result.status, 200);
  const draft = await result.json();
  assert.equal(draft.notes, "Chicken rice x 2 portion");
  assert.equal(draft.totalAmount, null);
  assert.equal(draft.items, undefined);
  assert.deepEqual(await (await request("/api/orders")).json(), []);
  const workspace = await (await request("/api/orders/workspace")).json();
  assert.equal(workspace.menu, undefined);
  assert.equal(workspace.products, undefined);
  assert.equal(workspace.warehouses, undefined);
  assert.equal((await request("/api/orders/menu")).status, 404);
  const order = await (await request("/api/orders", { method: "POST", body })).json();
  assert.equal((await request(`/api/orders/${order.id}/issue-draft`, { method: "POST", body: {} })).status, 403);
});

test("bootstrap and order routes keep the order Space separate from inventory", async t => {
  const { request, body } = await fixture(t);
  const created = await (await request("/api/orders", { method: "POST", body })).json();
  assert.equal(created.spaceId, ORDER_SPACE_ID);
  const inventory = await (await request("/api/bootstrap")).json();
  assert.equal(inventory.space.id, "default");
  assert.equal(inventory.orders.enabled, false);
  assert.deepEqual(inventory.orders.orders, []);
  const orders = await (await request(`/api/bootstrap?spaceId=${ORDER_SPACE_ID}`)).json();
  assert.equal(orders.space.id, ORDER_SPACE_ID);
  assert.equal(orders.orders.enabled, true);
  assert.equal(orders.orders.orders[0].id, created.id);
  assert.deepEqual(orders.warehouse.tables, {});
  assert.equal(orders.forms.length, 3);
  assert.equal((await request("/api/orders?spaceId=default")).status, 400);
  assert.equal((await request("/api/orders", { method: "POST", body: { ...body, spaceId: "default" } })).status, 400);
});

test("unified order forms keep generic writes admin-only and own-order reads scoped", async t => {
  const { request, admin, body } = await fixture(t);
  const mine = await (await request("/api/orders", { method: "POST", body })).json();
  const other = await (await request("/api/orders", {
    method: "POST", cookie: admin.cookie, body: { ...body, customerName: "Other customer" },
  })).json();
  const boot = await (await request(`/api/bootstrap?spaceId=${ORDER_SPACE_ID}`)).json();
  const { orders, payments, invoices } = boot.orders.tables;
  assert.equal(boot.forms.length, 3);
  assert.equal((await (await request(`/api/forms/${orders}/records`)).json()).length, 1);
  assert.equal((await (await request(`/api/forms/${payments}/records`)).json()).length, 1);
  assert.equal((await request(`/api/records/${other.id}`)).status, 404);
  assert.equal((await request(`/api/records/${other.paymentConfirmation.id}`)).status, 404);
  assert.equal((await request(`/api/records/${mine.id}`, {
    method: "PATCH", body: { version: mine.version, schemaVersion: 1, values: { notes: "Generic edit" } },
  })).status, 403);
  assert.equal((await request(`/api/forms/${orders}`, {
    method: "PUT", body: { version: 1, name: "Renamed", fields: [] },
  })).status, 403);
  const paymentForm = await (await request(`/api/forms/${payments}`)).json();
  const reference = paymentForm.fields.find(field => field.id === "order");
  assert.deepEqual(reference.reference, { formId: orders, fieldId: "number" });
  const paymentRecords = await (await request(`/api/forms/${payments}/records`)).json();
  assert.equal(paymentRecords[0].values.order, mine.id);
  const adminBoot = await (await request(`/api/bootstrap?spaceId=${ORDER_SPACE_ID}`, { cookie: admin.cookie })).json();
  assert.equal(adminBoot.forms.find(form => form.id === orders).recordCount, 2);
  assert.equal((await (await request(`/api/forms/${orders}/deletion-preview`, { cookie: admin.cookie })).json()).canDelete, false);
  assert.ok(invoices);
});

test("text intake persists a reviewable order and an unpaid linked record without copying quoted money", async t => {
  const { store, request } = await fixture(t);
  store.orders.configure({
    aiConfig: { credentials: () => ({ baseUrl: "https://provider.invalid/v1", apiKey: "private", model: "test" }) },
    fetchImpl: async () => Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
      isOrder: true, orderEvidence: "Please order two breads",
      customerName: "Lee", customerPhone: null, fulfillment: "pickup", deliveryAddress: null,
      requestedTime: null, notes: null,
      items: [{ productName: "bread", quantity: 2, unit: null, notes: null, evidence: "two breads" }],
    }) } }] }),
  });
  const body = { text: "Please order two breads for pickup. Total RM90." };
  const imported = await request("/api/orders/intake", { method: "POST", body, key: "capture-1" });
  assert.equal(imported.status, 201);
  const order = await imported.json();
  assert.equal(order.totalAmount, null);
  assert.equal(order.reviewed, false);
  assert.equal(order.paymentConfirmed, false);
  assert.equal(order.paymentConfirmation.confirmed, false);
  const retry = await (await request("/api/orders/intake", { method: "POST", body, key: "capture-1" })).json();
  assert.equal(retry.id, order.id);
  assert.equal((await (await request("/api/orders")).json()).length, 1);
  assert.equal((await request(`/api/orders/${order.id}/payment-confirmation`, {
    method: "POST", body: { version: order.version, confirmed: true },
  })).status, 409);
  const reviewed = await request(`/api/orders/${order.id}`, {
    method: "PATCH", body: { version: order.version, totalAmount: 90, reviewed: true },
  });
  assert.equal(reviewed.status, 200);
  const verified = await reviewed.json();
  assert.equal(verified.reviewed, true);
  const confirmation = await request(`/api/orders/${order.id}/payment-confirmation`, {
    method: "POST", body: { version: verified.version, confirmed: true },
  });
  assert.equal(confirmation.status, 200);
  assert.equal((await confirmation.json()).paymentConfirmed, true);
});

test("order diagnostics and notifications retain the same ownership boundary as records", async t => {
  const { store, admin, request, body } = await fixture(t);
  const formId = store.orders.tables().orders;
  store.auth.withUser(admin.user, () => store.automation.save({
    formId, name: "Order received", enabled: true, trigger: "created",
    actions: [{ type: "notify", message: "Review customer order" }],
  }));
  const foreign = await (await request("/api/orders", {
    cookie: admin.cookie, method: "POST", body: { ...body, customerName: "Private admin customer" },
  })).json();
  const mine = await (await request("/api/orders", { method: "POST", body })).json();
  const invalid = await request(`/api/records/${foreign.id}`, {
    cookie: admin.cookie, method: "PATCH",
    body: { version: foreign.version, schemaVersion: 1, values: { totalAmount: -1, notes: "Private failed mutation" } },
  });
  assert.equal(invalid.status, 400);
  const spaceQuery = `?spaceId=${ORDER_SPACE_ID}`;
  const errors = await (await request(`/api/errors${spaceQuery}`)).json();
  assert.equal(errors.some(error => error.context.recordId === foreign.id), false);
  const adminErrors = await (await request(`/api/errors${spaceQuery}`, { cookie: admin.cookie })).json();
  assert.equal(adminErrors.some(error => error.context.recordId === foreign.id), true);
  const notifications = await (await request(`/api/notifications${spaceQuery}`)).json();
  assert.deepEqual(notifications.map(item => item.recordId), [mine.id]);
  const allNotifications = await (await request(`/api/notifications${spaceQuery}`, { cookie: admin.cookie })).json();
  const hidden = allNotifications.find(item => item.recordId === foreign.id);
  assert.ok(hidden);
  assert.equal((await request(`/api/notifications/${hidden.id}`, { method: "PATCH", body: {} })).status, 404);
  const runs = await (await request(`/api/automation-runs${spaceQuery}`)).json();
  assert.deepEqual(runs.map(run => run.event.recordId), [mine.id]);
});
