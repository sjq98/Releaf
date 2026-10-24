import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createWhatsAppBridge, inspectWhatsAppProject, WHATSAPP_PROTOCOL } from "../src/whatsapp-bridge.js";
import { createWhatsAppHelper } from "../scripts/whatsapp-helper.mjs";
import { AppError } from "../src/errors.js";

const admin = { id: "admin-one", role: "admin" };
const fixedNow = Date.parse("2026-10-24T08:00:00Z");
const sourceKey = source => JSON.stringify([source.accountId, source.chatId, source.messageId]);

function fixture(t, { messages, extract, clock = () => fixedNow, fetchError } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE imported_orders (id TEXT PRIMARY KEY, source_key TEXT UNIQUE, data TEXT)");
  let user = admin, extractionCalls = 0, failMessage = null;
  const requests = [], spawns = [];
  const store = {
    database: db,
    auth: {
      currentUser: () => user,
      requireAdmin() { if (user?.role !== "admin") throw new AppError(403, "Administrator permission is required."); },
    },
    transaction(callback) {
      db.exec("SAVEPOINT testing");
      try { const value = callback(); db.exec("RELEASE testing"); return value; }
      catch (error) { db.exec("ROLLBACK TO testing"); db.exec("RELEASE testing"); throw error; }
    },
    orders: {
      findSource(source) {
        const row = db.prepare("SELECT data FROM imported_orders WHERE source_key = ?").get(sourceKey(source));
        return row ? JSON.parse(row.data) : null;
      },
      async extract(input) {
        extractionCalls++;
        return extract ? extract(input) : {
          isOrder: input.text.startsWith("Order"), customerName: "Lee", notes: input.text,
          totalAmount: 999, reviewed: true, issues: [],
        };
      },
      importExtracted({ draft, source }) {
        if (source.messageId === failMessage) throw new AppError(400, "Import failed.");
        const previous = this.findSource(source);
        if (previous) return { ...previous, intakeDuplicate: true };
        const order = { id: `order-${source.messageId}`, ...draft, source };
        db.prepare("INSERT INTO imported_orders VALUES (?, ?, ?)").run(order.id, sourceKey(source), JSON.stringify(order));
        return order;
      },
    },
  };
  const response = {
    protocol: WHATSAPP_PROTOCOL, accountId: "merchant@c.us",
    chat: { id: "customer@c.us", name: "Lee" },
    messages: messages ?? [{ id: "m1", body: "Order two breads", fromMe: false, type: "chat", timestamp: "2026-10-24T07:00:00Z" }],
  };
  const bridge = createWhatsAppBridge({
    store, now: clock, inspectProject: async value => value,
    spawnImpl: (...args) => { spawns.push(args); return { exitCode: null, once() {}, kill() {} }; },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (new URL(url).pathname === "/status") return Response.json({ protocol: WHATSAPP_PROTOCOL, state: "ready", linked: true });
      if (fetchError) throw fetchError;
      return Response.json(response);
    },
  });
  t.after(() => { bridge.close(); db.close(); });
  const configure = () => db.prepare("INSERT INTO whatsapp_bridge_settings VALUES (1, ?, ?, ?)").run("D:/connector", "test-private-helper-token-with-enough-length", new Date(fixedNow).toISOString());
  return { db, store, bridge, response, requests, spawns, configure,
    extractionCalls: () => extractionCalls, as: value => { user = value; }, failOn: value => { failMessage = value; } };
}

test("WhatsApp bridge starts dormant and keeps its helper token out of status", async t => {
  const f = fixture(t);
  const initial = await f.bridge.status();
  assert.equal(initial.configured, false);
  assert.equal(initial.state, "not_configured");
  assert.equal(f.requests.length, 0);
  assert.equal(f.spawns.length, 0);
  f.configure();
  const status = await f.bridge.status();
  assert.equal(status.linked, true);
  assert.equal(JSON.stringify(status).includes("test-private-helper-token"), false);
  assert.match(f.requests[0].options.headers.Authorization, /^Bearer /);
});

test("preview reads only the selected chat and filters payments, outbound and media before writing orders", async t => {
  const f = fixture(t, { messages: [
    { id: "order", body: "Order two breads", fromMe: false, type: "chat" },
    { id: "payment", body: "I paid RM40", fromMe: false, type: "chat" },
    { id: "outbound", body: "Order four breads", fromMe: true, type: "chat" },
    { id: "media", body: "[media]", fromMe: false, type: "image" },
  ] });
  f.configure();
  const plan = await f.bridge.previewImport({ chatId: "customer@c.us", hours: 6, limit: 10 });
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.candidates[0].draft.totalAmount, null);
  assert.equal(plan.candidates[0].draft.reviewed, false);
  assert.equal(plan.candidates[0].source.accountId, "merchant@c.us");
  assert.equal(plan.candidates[0].source.chatId, "customer@c.us");
  assert.equal(plan.candidates[0].source.messageId, "order");
  assert.deepEqual(plan.skipped.map(row => row.reason), ["not_an_order", "outbound_message", "unsupported_message"]);
  assert.equal(f.extractionCalls(), 2);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM imported_orders").get().n, 0);
  const query = new URL(f.requests[0].url);
  assert.equal(query.searchParams.get("chatId"), "customer@c.us");
  assert.equal(query.searchParams.get("hours"), "6");
  assert.equal(query.searchParams.get("limit"), "10");
});

test("plan execution and retries create one unreviewed order per stable message ID", async t => {
  const f = fixture(t);
  f.configure();
  const plan = await f.bridge.previewImport({ chatId: "customer@c.us" });
  const result = f.bridge.importMessages(plan);
  assert.equal(result.imported, 1);
  assert.equal(result.orders[0].totalAmount, null);
  assert.equal(result.orders[0].reviewed, false);
  const replay = f.bridge.importMessages(plan);
  assert.equal(replay.replayed, true);
  assert.equal(replay.orders[0].id, result.orders[0].id);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM imported_orders").get().n, 1);
  const duplicate = await f.bridge.previewImport({ chatId: "customer@c.us" });
  assert.equal(duplicate.duplicates, 1);
  assert.equal(duplicate.candidates.length, 0);
  assert.equal(f.extractionCalls(), 1);
});

test("import participates in the same rollback preview as other Agent mutations", async t => {
  const f = fixture(t);
  f.configure();
  const plan = await f.bridge.previewImport({ chatId: "customer@c.us" });
  f.db.exec("SAVEPOINT agent_preview");
  const preview = f.bridge.importMessages(plan);
  assert.equal(preview.imported, 1);
  f.db.exec("ROLLBACK TO agent_preview");
  f.db.exec("RELEASE agent_preview");
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM imported_orders").get().n, 0);
  assert.equal(f.bridge.getPlan(plan).applied, false);
  assert.equal(f.bridge.importMessages(plan).imported, 1);
});

test("changed fingerprints and expired plans cannot write business records", async t => {
  let time = fixedNow;
  const f = fixture(t, { clock: () => time });
  f.configure();
  const plan = await f.bridge.previewImport({ chatId: "customer@c.us" });
  assert.throws(() => f.bridge.importMessages({ ...plan, fingerprint: "wrong" }), { status: 409 });
  time += 31 * 60 * 1000;
  assert.throws(() => f.bridge.importMessages(plan), { status: 409 });
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM imported_orders").get().n, 0);
});

test("a failed multi-order plan rolls back both orders and its consumed marker", async t => {
  const f = fixture(t, { messages: [
    { id: "one", body: "Order two breads", type: "chat" },
    { id: "two", body: "Order three breads", type: "chat" },
  ] });
  f.configure();
  const plan = await f.bridge.previewImport({ chatId: "customer@c.us" });
  f.failOn("two");
  assert.throws(() => f.bridge.importMessages(plan), { status: 400 });
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM imported_orders").get().n, 0);
  assert.equal(f.bridge.getPlan(plan).applied, false);
});

test("WhatsApp account access is administrator-only and import plans remain owner-scoped", async t => {
  const f = fixture(t);
  f.configure();
  const plan = await f.bridge.previewImport({ chatId: "customer@c.us" });
  f.as({ id: "member", role: "user" });
  for (const action of [() => f.bridge.status(), () => f.bridge.connect(), () => f.bridge.link(),
    () => f.bridge.chats(), () => f.bridge.previewImport({ chatId: "customer@c.us" })]) {
    await assert.rejects(action, { status: 403 });
  }
  assert.throws(() => f.bridge.importMessages(plan), { status: 403 });
  f.as({ id: "admin-two", role: "admin" });
  assert.throws(() => f.bridge.getPlan(plan), { status: 404 });
  assert.throws(() => f.bridge.importMessages(plan), { status: 404 });
});

test("wrong conversation identities, missing message IDs and invalid read windows are rejected", async t => {
  const f = fixture(t);
  f.configure();
  for (const input of [{}, { chatId: "x", hours: 0 }, { chatId: "x", limit: 51 }, { chatId: "x", hours: "24" }]) {
    await assert.rejects(() => f.bridge.previewImport(input), { status: 400 });
  }
  await assert.rejects(() => f.bridge.previewImport({ chatId: "different@c.us" }), { status: 502 });
  f.response.messages[0].id = undefined;
  await assert.rejects(() => f.bridge.previewImport({ chatId: "customer@c.us" }), { status: 502 });
});

test("unverified connector paths cannot be launched", async () => {
  await assert.rejects(() => inspectWhatsAppProject("relative/path"), { status: 400 });
  await assert.rejects(() => inspectWhatsAppProject("D:/connector-does-not-exist"), { status: 400 });
});

test("connection launches only the owned hidden helper without a shell", async t => {
  const f = fixture(t);
  const status = await f.bridge.connect({ projectPath: "D:/verified-connector" });
  assert.equal(status.available, true);
  assert.equal(f.spawns.length, 1);
  const [command, args, options] = f.spawns[0];
  assert.equal(command, process.execPath);
  assert.match(args[0], /whatsapp-helper\.mjs$/);
  assert.equal(args[1], "D:/verified-connector");
  assert.equal(options.shell, false);
  assert.equal(options.windowsHide, true);
  assert.equal(options.env.RELEAF_WHATSAPP_TOKEN.length >= 32, true);
  assert.equal(options.env.RELEAF_WHATSAPP_PORT, "47291");
  assert.equal(JSON.stringify(status).includes(options.env.RELEAF_WHATSAPP_TOKEN), false);
  await f.bridge.connect({ projectPath: "D:/verified-connector" });
  assert.equal(f.spawns.length, 1);
  await assert.rejects(() => f.bridge.connect({ command: "arbitrary command" }), { status: 400 });
});

test("an incompatible upstream helper is never treated as a trusted bridge", async t => {
  const f = fixture(t);
  f.configure();
  delete f.response.protocol;
  await assert.rejects(() => f.bridge.previewImport({ chatId: "customer@c.us" }), { status: 409 });
  assert.equal(f.extractionCalls(), 0);
});

test("helper reads allow 45 seconds for the linked browser to synchronize chats", async t => {
  const deadlines = [];
  t.mock.method(AbortSignal, "timeout", milliseconds => {
    deadlines.push(milliseconds);
    return new AbortController().signal;
  });
  const f = fixture(t);
  f.configure();
  await f.bridge.chats();
  assert.deepEqual(deadlines, [45000]);
});

test("a slow chat read is reported as a timeout without declaring a reachable helper offline", async t => {
  const f = fixture(t, { fetchError: new DOMException("Synthetic deadline", "TimeoutError") });
  f.configure();
  assert.equal((await f.bridge.status()).available, true);
  await assert.rejects(() => f.bridge.chats(), error => {
    assert.equal(error.status, 504);
    assert.match(error.message, /timed out/i);
    assert.doesNotMatch(error.message, /not running/i);
    return true;
  });
  assert.equal((await f.bridge.status()).linked, true);
});

test("helper requests require private authentication and return exact stable conversation and message IDs", async t => {
  const token = "test-helper-token-long-enough-for-authentication";
  const fetchedIds = [];
  const customer = {
    id: { _serialized: "customer@c.us" }, name: "Lee", timestamp: fixedNow / 1000,
    async fetchMessages({ limit }) {
      assert.equal(limit, 10);
      return [{ id: { _serialized: "real-message-id" }, body: "Order bread", type: "chat",
        fromMe: false, from: "customer@c.us", timestamp: fixedNow / 1000 - 60 }];
    },
  };
  const client = {
    info: { wid: { _serialized: "merchant@c.us" } },
    async getChats() { return [customer, { id: { _serialized: "group@g.us" }, isGroup: true }]; },
    async getChatById(id) { fetchedIds.push(id); return id === customer.id._serialized ? customer : null; },
  };
  const helper = createWhatsAppHelper({
    wa: { getState: () => ({ state: "ready" }), getLastQr: () => null, ensureClient: () => client },
    qrToDataURL: async () => "data:image/png;base64,qr", token, now: () => fixedNow,
  });
  await new Promise(resolve => helper.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => helper.close(resolve)));
  const base = `http://127.0.0.1:${helper.address().port}`;
  assert.equal((await fetch(`${base}/status`)).status, 401);
  assert.equal((await fetch(`${base}/status`, { headers: { Authorization: `Bearer ${token}`, Origin: "https://foreign.invalid" } })).status, 403);
  const headers = { Authorization: `Bearer ${token}` };
  assert.equal((await fetch(`${base}/link`, { headers })).status, 405);
  await fetch(`${base}/link`, { method: "POST", headers });
  const chats = await (await fetch(`${base}/chats`, { headers })).json();
  assert.equal(chats.protocol, WHATSAPP_PROTOCOL);
  assert.deepEqual(chats.chats.map(chat => chat.id), ["customer@c.us"]);
  const response = await fetch(`${base}/messages?${new URLSearchParams({ chatId: "customer@c.us", limit: 10 })}`, { headers });
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.messages[0].id, "real-message-id");
  assert.equal(data.accountId, "merchant@c.us");
  assert.deepEqual(fetchedIds, ["customer@c.us"]);
  assert.equal((await fetch(`${base}/messages?chatId=customer`, { headers })).status, 400);
});

test("helper status does not launch a browser and exposes QR only through authenticated status/link", async t => {
  const token = "test-qr-helper-private-authentication-token";
  let ensureCalls = 0, destroyed = false;
  const helper = createWhatsAppHelper({
    wa: {
      getState: () => ({ state: "qr" }),
      getLastQr: () => "private-linking-challenge",
      ensureClient: () => { ensureCalls++; return { async destroy() { destroyed = true; } }; },
    },
    qrToDataURL: async qr => { assert.equal(qr, "private-linking-challenge"); return "data:image/png;base64,cXI="; },
    token,
  });
  await new Promise(resolve => helper.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => helper.close(resolve)));
  const base = `http://127.0.0.1:${helper.address().port}`;
  const headers = { Authorization: `Bearer ${token}` };
  const status = await (await fetch(`${base}/status`, { headers })).json();
  assert.equal(ensureCalls, 0);
  assert.equal(status.qrImage, "data:image/png;base64,cXI=");
  assert.equal(status.linked, false);
  await fetch(`${base}/link`, { method: "POST", headers });
  assert.equal(ensureCalls, 1);
  await helper.closeWhatsApp();
  assert.equal(destroyed, true);
});

test("a saved login is not ready and an initially empty direct-chat list can be refreshed without relinking", async t => {
  const token = "test-lifecycle-helper-private-authentication-token";
  let state = "idle", browserStarts = 0, reads = 0;
  const customer = { id: { _serialized: "fixture-customer@c.us" }, name: "Fixture customer" };
  const group = { id: { _serialized: "fixture-group@g.us" }, isGroup: true };
  const client = {
    info: { wid: { _serialized: "fixture-merchant@c.us" } },
    async getChats() { return ++reads === 1 ? [group] : [customer, group]; },
  };
  const helper = createWhatsAppHelper({
    wa: {
      getState: () => ({ state, linked: true }),
      getLastQr: () => null,
      ensureClient() {
        if (state === "idle") { browserStarts++; state = "loading"; }
        return client;
      },
    },
    qrToDataURL: async () => null, token,
  });
  await new Promise(resolve => helper.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => helper.close(resolve)));
  const base = `http://127.0.0.1:${helper.address().port}`;
  const headers = { Authorization: `Bearer ${token}` };
  const initial = await (await fetch(`${base}/status`, { headers })).json();
  assert.equal(initial.state, "idle");
  assert.equal(initial.linked, false);
  assert.equal(browserStarts, 0);
  const waiting = await (await fetch(`${base}/chats`, { headers })).json();
  assert.match(waiting.error, /wait.*ready/i);
  assert.equal(browserStarts, 0);
  const linking = await (await fetch(`${base}/link`, { headers, method: "POST" })).json();
  assert.equal(linking.state, "loading");
  assert.equal(linking.linked, false);
  state = "ready";
  const ready = await (await fetch(`${base}/status`, { headers })).json();
  assert.equal(ready.linked, true);
  assert.deepEqual((await (await fetch(`${base}/chats`, { headers })).json()).chats, []);
  const refreshed = await (await fetch(`${base}/chats`, { headers })).json();
  assert.deepEqual(refreshed.chats.map(chat => chat.id), ["fixture-customer@c.us"]);
  assert.equal(browserStarts, 1);
});

test("chat discovery reads direct metadata without serializing incompatible last-message keys", async t => {
  const token = "test-metadata-helper-private-authentication-token";
  const chats = [
    { id: { _serialized: "old@c.us", user: "old" }, formattedTitle: "Old identifier", t: 10 },
    { id: { $1: "new@lid", user: "new" }, formattedTitle: "New identifier", t: 20 },
    { id: { $1: "group@g.us" }, groupMetadata: {} },
    { id: { _serialized: "status@broadcast" } },
    { id: { $1: "channel@newsletter" } },
    { id: { _serialized: "invalid-time@c.us" }, t: Infinity },
  ];
  for (const chat of chats) {
    Object.defineProperty(chat, "lastReceivedKey", { get() { throw new Error("Chat discovery must not access message keys."); } });
    chat.serialize = () => { throw new Error("Chat discovery must not serialize messages or group metadata."); };
  }
  const { runInNewContext } = await import("node:vm");
  let evaluations = 0;
  const helper = createWhatsAppHelper({
    wa: {
      getState: () => ({ state: "ready" }), getLastQr: () => null,
      ensureClient: () => ({
        info: { wid: { _serialized: "fixture-account@c.us" } },
        getChats() { throw new Error("The SDK's full serialization fails on new message keys."); },
        pupPage: {
          async evaluate(fn) {
            evaluations++;
            return runInNewContext(`(${fn.toString()})()`, {
              window: { require(name) {
                assert.equal(name, "WAWebCollections");
                return { Chat: { getModelsArray: () => chats } };
              } },
            });
          },
        },
      }),
    },
    qrToDataURL: async () => null, token,
  });
  await new Promise(resolve => helper.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => helper.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${helper.address().port}/chats`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.chats.map(chat => chat.id), ["new@lid", "old@c.us", "invalid-time@c.us"]);
  assert.equal(result.chats[0].name, "New identifier");
  assert.equal(result.chats[2].lastActivity, null);
  assert.equal(evaluations, 1);
});
