import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.js";
import { ORDER_SPACE_ID } from "../src/order-system.js";
import { WHATSAPP_PROTOCOL } from "../src/whatsapp-bridge.js";
import { setupAdmin } from "./helpers/http-auth.js";

const password = "Test-only-password-2026";
const chatId = "customer@c.us";
const orderTexts = [
  "Lee: Please order two breads for pickup. Total RM90.",
  "Lee: Please order three cakes for pickup. Total RM120.",
];
const paymentText = "I have paid RM90.";
const answer = content => Response.json({
  choices: [{ finish_reason: "stop", message: { role: "assistant", content } }],
});

async function fixture(t, { assistantFetch = async () => answer("Done.") } = {}) {
  let time = Date.parse("2026-10-24T08:00:00Z");
  const helperRequests = [];
  const app = createApp({
    database: ":memory:",
    env: {
      AI_BASE_URL: "https://extraction.invalid/v1", AI_API_KEY: "test-extraction-key", AI_MODEL: "test-extraction",
      ASSISTANT_BASE_URL: "https://assistant.invalid/v1", ASSISTANT_API_KEY: "test-assistant-key", ASSISTANT_MODEL: "test-assistant",
    },
    aiFetch: async (_url, options) => {
      const input = JSON.parse(JSON.parse(options.body).messages.at(-1).content).customer_text;
      const index = orderTexts.indexOf(input);
      assert.ok(index >= 0 || input === paymentText, "Only the selected fixture messages reach extraction.");
      const isOrder = index >= 0;
      return answer(JSON.stringify({
        isOrder, orderEvidence: isOrder ? input : null,
        customerName: isOrder ? "AI name that differs from WhatsApp" : null, customerPhone: null,
        fulfillment: isOrder ? "pickup" : null, deliveryAddress: null,
        requestedTime: null, notes: null,
        items: isOrder ? [{
          productName: index === 0 ? "bread" : "cake", quantity: index === 0 ? 2 : 3,
          unit: null, notes: null, evidence: index === 0 ? "two breads" : "three cakes",
        }] : [],
      }));
    },
    assistantFetch,
    whatsappOptions: {
      now: () => time,
      inspectProject: async path => path,
      spawnImpl: () => ({ exitCode: 0, once() {}, kill() {} }),
      fetchImpl: async (url, options) => {
        helperRequests.push({ url, options });
        const path = new URL(url);
        const common = { protocol: WHATSAPP_PROTOCOL, accountId: "merchant@c.us" };
        if (path.pathname === "/status") return Response.json({ ...common, state: "ready", linked: true });
        if (path.pathname === "/chats") return Response.json({
          ...common, chats: [{ id: chatId, name: "Lee", isGroup: false }], truncated: false,
        });
        assert.equal(path.pathname, "/messages");
        assert.equal(path.searchParams.get("chatId"), chatId);
        return Response.json({
          ...common, chat: { id: chatId, name: "Lee" }, truncated: false,
          messages: [...orderTexts, paymentText].map((body, index) => ({
            id: `message-${index + 1}`, body, fromMe: false, type: "chat",
            sender: chatId, timestamp: "2026-10-24T07:00:00Z",
          })),
        });
      },
    },
  });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const admin = await setupAdmin(base);
  const request = (path, { cookie = admin.cookie, method = "GET", body, token, key } = {}) => fetch(base + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : cookie ? { Cookie: cookie } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = async (path, options, status = 200) => {
    const response = await request(path, options);
    const value = await response.json();
    assert.equal(response.status, status, JSON.stringify(value));
    return value;
  };
  const member = await json("/api/auth/users", {
    method: "POST", body: { username: "whatsapp.member", password, role: "user" },
  }, 201);
  const login = await request("/api/auth/login", {
    cookie: null, method: "POST", body: { username: member.username, password },
  });
  assert.equal(login.status, 200);
  const memberCookie = login.headers.get("set-cookie").split(";")[0];
  const tokenFor = (options = {}) => json("/api/assistant/tokens", {
    method: "POST", body: { name: "WhatsApp test", spaceId: ORDER_SPACE_ID, ...options },
  }, 201);
  const operate = (token, operation, args = {}, key, status = 200) => json("/api/agent/operations", {
    token: token.token, method: "POST", body: { operation, args }, key,
  }, status);
  await json("/api/whatsapp/connect", { method: "POST", body: { projectPath: "D:/test-only-connector" } });
  return {
    admin, member, memberCookie, request, json, tokenFor, operate, helperRequests,
    advanceTime: milliseconds => { time += milliseconds; },
  };
}

test("reviewed WhatsApp Agent imports save two linked orders only after approval and replay safely", async t => {
  const f = await fixture(t);
  const token = await f.tokenFor();
  const plan = await f.operate(token, "preview_whatsapp_import", { chatId, hours: 24, limit: 10 });
  assert.equal(plan.candidates.length, 2);
  for (const candidate of plan.candidates) {
    assert.equal(candidate.draft.customerName, "Lee");
    assert.equal(candidate.draft.messageSentAt, "2026-10-24T15:00");
  }
  assert.deepEqual(plan.skipped, [{ messageId: "message-3", reason: "not_an_order" }]);
  assert.deepEqual(await f.json("/api/orders"), []);
  const args = { planId: plan.planId, fingerprint: plan.fingerprint };
  const pending = await f.operate(token, "import_whatsapp_orders", args, "review-import", 202);
  assert.equal(pending.status, "pending");
  assert.equal(pending.result, null);
  assert.equal(pending.preview.spaceId, ORDER_SPACE_ID);
  assert.equal(pending.preview.result.imported, 2);
  assert.deepEqual(await f.json("/api/orders"), []);
  const before = await f.json(`/api/bootstrap?spaceId=${ORDER_SPACE_ID}`);
  const { orders: ordersId, payments: paymentsId, invoices: invoicesId } = before.orders.tables;
  for (const formId of [ordersId, paymentsId, invoicesId]) {
    assert.deepEqual(await f.json(`/api/forms/${formId}/records`), []);
  }
  assert.equal((await f.request(`/api/assistant/actions/${pending.id}/approve`, {
    token: token.token, method: "POST", body: {},
  })).status, 403);
  const applied = await f.json(`/api/assistant/actions/${pending.id}/approve`, { method: "POST", body: {} });
  assert.equal(applied.status, "applied");
  assert.equal(applied.result.imported, 2);
  const orders = await f.json("/api/orders");
  assert.equal(orders.length, 2);
  for (const order of orders) {
    assert.equal(order.spaceId, ORDER_SPACE_ID);
    assert.equal(order.createdBy, f.admin.user.id);
    assert.equal(order.reviewed, false);
    assert.equal(order.totalAmount, null);
    assert.equal(order.paymentConfirmed, false);
    assert.equal(order.paymentConfirmation.confirmed, false);
    assert.equal(order.source.channel, "whatsapp");
    assert.equal(order.source.chatId, chatId);
    assert.equal(order.customerName, "Lee");
    assert.equal(order.messageSentAt, "2026-10-24T15:00");
    assert.ok(orderTexts.includes(order.sourceText));
  }
  const records = await f.json(`/api/forms/${ordersId}/records`);
  assert.equal(records.length, 2);
  assert.ok(records.every(record => record.values.customerName === "Lee" && record.values.messageSentAt === "2026-10-24T15:00"));
  const agentOrders = await f.operate(token, "list_orders");
  assert.ok(agentOrders.every(order => order.customerName === "Lee" && order.messageSentAt === "2026-10-24T15:00"));
  const payments = await f.json(`/api/forms/${paymentsId}/records`);
  assert.equal(payments.length, 2);
  assert.deepEqual(new Set(payments.map(record => record.values.order)), new Set(orders.map(order => order.id)));
  assert.deepEqual(await f.json(`/api/forms/${invoicesId}/records`), []);
  assert.equal((await f.json("/api/bootstrap")).orders.enabled, false);
  const retried = await f.operate(token, "import_whatsapp_orders", args, "review-import");
  assert.equal(retried.id, applied.id);
  assert.equal(retried.status, "applied");
  const approvedAgain = await f.json(`/api/assistant/actions/${pending.id}/approve`, { method: "POST", body: {} });
  assert.deepEqual(approvedAgain.result, applied.result);
  const replayed = await f.json("/api/whatsapp/import", { method: "POST", body: args }, 201);
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.imported, 2);
  const rescan = await f.operate(token, "preview_whatsapp_import", { chatId });
  assert.equal(rescan.candidates.length, 2);
  assert.equal(rescan.duplicates, 0);
  assert.equal((await f.json("/api/orders")).length, 2);
  assert.equal((await f.json(`/api/forms/${paymentsId}/records`)).length, 2);
});

test("every WhatsApp preview creates a fresh import even when another preview imported the same messages", async t => {
  const f = await fixture(t);
  const preview = () => f.json("/api/whatsapp/preview", {
    method: "POST", body: { chatId, hours: 24, limit: 10 },
  });
  const importPlan = plan => f.json("/api/whatsapp/import", {
    method: "POST", body: { planId: plan.planId, fingerprint: plan.fingerprint },
  }, 201);
  const first = await preview(), second = await preview();
  const imported = await importPlan(first), reimported = await importPlan(second);
  assert.equal(imported.imported, 2);
  assert.equal(reimported.imported, 2);
  assert.equal(reimported.duplicates, 0);
  assert.equal(new Set([...imported.orders, ...reimported.orders].map(order => order.id)).size, 4);
  assert.deepEqual(reimported.orders.map(order => order.source.messageId),
    imported.orders.map(order => order.source.messageId));
  assert.equal((await f.json("/api/orders")).length, 4);
  const { payments } = (await f.json(`/api/bootstrap?spaceId=${ORDER_SPACE_ID}`)).orders.tables;
  assert.equal((await f.json(`/api/forms/${payments}/records`)).length, 4);
  const replayed = await importPlan(second);
  assert.equal(replayed.replayed, true);
  assert.deepEqual(replayed.orders, reimported.orders);
  assert.equal((await f.json("/api/orders")).length, 4);
});

test("last-24-hours preview rescans all messages regardless of active or deleted orders", async t => {
  const f = await fixture(t);
  const plan = await f.json("/api/whatsapp/preview", {
    method: "POST", body: { chatId, hours: 24, limit: 10 },
  });
  const imported = await f.json("/api/whatsapp/import", {
    method: "POST", body: { planId: plan.planId, fingerprint: plan.fingerprint },
  }, 201);
  const [deleted, retained] = imported.orders;
  await f.json(`/api/records/${deleted.id}`, {
    method: "DELETE", body: { version: deleted.version },
  });
  const replayed = await f.json("/api/whatsapp/import", {
    method: "POST", body: { planId: plan.planId, fingerprint: plan.fingerprint },
  }, 201);
  assert.equal(replayed.replayed, true);
  assert.deepEqual(replayed.orders, imported.orders);
  assert.equal((await f.json("/api/orders")).length, 1);
  const rescan = await f.json("/api/whatsapp/preview", {
    method: "POST", body: { chatId, hours: 24, limit: 10 },
  });
  assert.equal(rescan.candidates.length, 2);
  assert.equal(rescan.duplicates, 0);
  const reimported = await f.json("/api/whatsapp/import", {
    method: "POST", body: { planId: rescan.planId, fingerprint: rescan.fingerprint },
  }, 201);
  assert.equal(reimported.imported, 2);
  const replacement = reimported.orders.find(order => order.source.messageId === deleted.source.messageId);
  assert.notEqual(replacement.id, deleted.id);
  assert.equal(replacement.source.messageId, deleted.source.messageId);
  assert.equal(replacement.customerName, "Lee");
  assert.equal(replacement.messageSentAt, "2026-10-24T15:00");
  assert.equal(replacement.reviewed, false);
  assert.equal(replacement.totalAmount, null);
  assert.deepEqual(new Set((await f.json("/api/orders")).map(order => order.id)),
    new Set([retained.id, ...reimported.orders.map(order => order.id)]));
  const { payments } = (await f.json(`/api/bootstrap?spaceId=${ORDER_SPACE_ID}`)).orders.tables;
  assert.deepEqual(new Set((await f.json(`/api/forms/${payments}/records`)).map(record => record.values.order)),
    new Set([retained.id, ...reimported.orders.map(order => order.id)]));
  await f.json(`/api/orders/${deleted.id}`, {}, 404);
  const repeated = await f.json("/api/whatsapp/preview", {
    method: "POST", body: { chatId, hours: 24, limit: 10 },
  });
  assert.equal(repeated.candidates.length, 2);
  assert.equal(repeated.duplicates, 0);
});

test("members cannot read the linked WhatsApp account through app routes or full-access Agent tokens", async t => {
  const f = await fixture(t);
  const token = await f.json("/api/assistant/tokens", {
    cookie: f.memberCookie, method: "POST",
    body: { name: "Member full access", spaceId: ORDER_SPACE_ID, mode: "full", confirmFullAccess: true },
  }, 201);
  const initialRequests = f.helperRequests.length;
  for (const path of ["/api/whatsapp/status", "/api/whatsapp/chats"]) {
    assert.equal((await f.request(path, { cookie: f.memberCookie })).status, 403);
  }
  for (const [path, body] of [
    ["/api/whatsapp/connect", {}],
    ["/api/whatsapp/link", {}],
    ["/api/whatsapp/preview", { chatId }],
    ["/api/whatsapp/import", { planId: "unread-plan", fingerprint: "unread-fingerprint" }],
  ]) {
    assert.equal((await f.request(path, { cookie: f.memberCookie, method: "POST", body })).status, 403);
  }
  const tools = await f.json("/api/agent/tools", { token: token.token });
  assert.equal(tools.tools.some(tool => tool.function.name.includes("whatsapp")), false);
  for (const [operation, args] of [
    ["get_whatsapp_status", {}],
    ["list_whatsapp_chats", {}],
    ["preview_whatsapp_import", { chatId }],
    ["import_whatsapp_orders", { planId: "unread-plan", fingerprint: "unread-fingerprint" }],
  ]) {
    await f.operate(token, operation, args, `denied-${operation}`, 403);
  }
  assert.equal(f.helperRequests.length, initialRequests);
  assert.deepEqual(await f.json("/api/orders"), []);
});

test("administrator tokens scoped to inventory cannot read or import WhatsApp order data", async t => {
  const f = await fixture(t);
  const token = await f.tokenFor({ spaceId: "default", mode: "full", confirmFullAccess: true });
  const initialRequests = f.helperRequests.length;
  for (const [operation, args] of [
    ["get_whatsapp_status", {}],
    ["list_whatsapp_chats", {}],
    ["preview_whatsapp_import", { chatId }],
    ["import_whatsapp_orders", { planId: "unread-plan", fingerprint: "unread-fingerprint" }],
    ["preview_whatsapp_import", { spaceId: ORDER_SPACE_ID, chatId }],
  ]) {
    await f.operate(token, operation, args, `wrong-space-${operation}`, 403);
  }
  assert.equal(f.helperRequests.length, initialRequests);
  assert.deepEqual(await f.json("/api/orders"), []);
});

test("chat tools reject an explicitly wrong WhatsApp Space before reading account data", async t => {
  let round = 0;
  const f = await fixture(t, {
    assistantFetch: async (_url, options) => {
      const request = JSON.parse(options.body);
      if (++round > 1) {
        return answer(JSON.stringify(request.messages.filter(message => message.role === "tool")
          .map(message => JSON.parse(message.content))));
      }
      const calls = [
        ["get_whatsapp_status", {}],
        ["list_whatsapp_chats", {}],
        ["preview_whatsapp_import", { chatId }],
        ["import_whatsapp_orders", { planId: "unread-plan", fingerprint: "unread-fingerprint" }],
      ];
      return Response.json({ choices: [{ finish_reason: "tool_calls", message: {
        role: "assistant", content: null,
        tool_calls: calls.map(([name, args], index) => ({
          id: `wrong-space-${index}`, type: "function",
          function: { name, arguments: JSON.stringify({ ...args, spaceId: "default" }) },
        })),
      } }] });
    },
  });
  const initialRequests = f.helperRequests.length;
  const session = await f.json("/api/assistant/sessions", { method: "POST", body: {} }, 201);
  const response = await f.json(`/api/assistant/sessions/${session.id}/messages`, {
    method: "POST", body: { text: "Check the requested WhatsApp conversation.", spaceId: ORDER_SPACE_ID },
  });
  const results = JSON.parse(response.messages.at(-1).content);
  assert.equal(results.length, 4);
  assert.ok(results.every(result => result.status === 403));
  assert.deepEqual(response.actions, []);
  assert.equal(f.helperRequests.length, initialRequests);
  assert.deepEqual(await f.json("/api/orders"), []);
});

test("an expiring WhatsApp plan cannot be approved after its read window has expired", async t => {
  const f = await fixture(t);
  const token = await f.tokenFor();
  const plan = await f.operate(token, "preview_whatsapp_import", { chatId });
  await f.operate(token, "import_whatsapp_orders", {
    planId: plan.planId, fingerprint: "changed-fingerprint",
  }, "tampered-plan", 409);
  const pending = await f.operate(token, "import_whatsapp_orders", {
    planId: plan.planId, fingerprint: plan.fingerprint,
  }, "expiring-plan", 202);
  f.advanceTime(31 * 60 * 1000);
  await f.json(`/api/assistant/actions/${pending.id}/approve`, { method: "POST", body: {} }, 409);
  const action = await f.json(`/api/agent/actions/${pending.id}`, { token: token.token });
  assert.equal(action.status, "failed");
  assert.match(action.error, /expired/i);
  assert.deepEqual(await f.json("/api/orders"), []);
  const workspace = await f.json("/api/orders/workspace");
  assert.deepEqual(await f.json(`/api/forms/${workspace.tables.payments}/records`), []);
});

test("approval rechecks the import owner's current role instead of borrowing the approver's administrator role", async t => {
  const f = await fixture(t);
  const importer = await f.json("/api/auth/users", {
    method: "POST", body: { username: "import.admin", password, role: "admin" },
  }, 201);
  const login = await f.request("/api/auth/login", {
    cookie: null, method: "POST", body: { username: importer.username, password },
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const token = await f.json("/api/assistant/tokens", {
    cookie, method: "POST", body: { name: "Import owner", spaceId: ORDER_SPACE_ID },
  }, 201);
  const plan = await f.operate(token, "preview_whatsapp_import", { chatId });
  const pending = await f.operate(token, "import_whatsapp_orders", {
    planId: plan.planId, fingerprint: plan.fingerprint,
  }, "before-demotion", 202);
  await f.json(`/api/auth/users/${importer.id}`, { method: "PATCH", body: { role: "user" } });
  await f.json(`/api/assistant/actions/${pending.id}/approve`, { method: "POST", body: {} }, 403);
  const action = await f.json(`/api/agent/actions/${pending.id}`, { token: token.token });
  assert.equal(action.status, "failed");
  const tools = await f.json("/api/agent/tools", { token: token.token });
  assert.equal(tools.tools.some(tool => tool.function.name.includes("whatsapp")), false);
  assert.deepEqual(await f.json("/api/orders"), []);
  const workspace = await f.json("/api/orders/workspace");
  assert.deepEqual(await f.json(`/api/forms/${workspace.tables.payments}/records`), []);
});
