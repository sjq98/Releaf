import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { createWhatsAppHelper } from "../scripts/whatsapp-helper.mjs";

const now = Date.parse("2026-10-24T08:00:00Z");
const chatId = "fixture-customer@c.us";
const accountId = "fixture-merchant@c.us";
const token = "fixture-selected-reader-private-helper-token";
const model = (id, name, { group = false } = {}) => ({
  id: { $1: id, user: "fixture" }, formattedTitle: name, t: now / 1000,
  ...(group ? { groupMetadata: {} } : {}),
  get msgs() { throw new Error("Metadata discovery must not read messages."); },
  get lastReceivedKey() { throw new Error("Metadata discovery must not inspect last-message keys."); },
  serialize() { throw new Error("Full chat serialization is incompatible and must not run."); },
});

async function fixture(t, { modernAccount = false, messages } = {}) {
  const unrelated = model("fixture-unrelated@c.us", "Unrelated");
  Object.defineProperty(unrelated, "formattedTitle", {
    get() { throw new Error("A selected-chat read must not inspect unrelated chat names."); },
  });
  const models = [
    unrelated, model(chatId, "Fixture customer"),
    model("fixture-group@g.us", "Fixture group", { group: true }),
    model("fixture-marked-group@lid", "Fixture marked group", { group: true }),
    model("fixture-newsletter@newsletter", "Fixture newsletter"),
  ];
  const factoryCalls = [], fetches = [];
  const source = messages ?? [
    { id: { _serialized: "fixture-message-one" }, body: "Order two breads", type: "chat",
      fromMe: false, from: chatId, timestamp: now / 1000 - 120 },
    { id: { _serialized: "fixture-message-two" }, body: "Order three cakes", type: "chat",
      fromMe: false, from: chatId, timestamp: now / 1000 - 60 },
  ];
  const client = {
    info: { wid: modernAccount ? { $1: accountId } : { _serialized: accountId } },
    getChats() { throw new Error("Full account chat serialization must not run."); },
    getChatById() { throw new Error("Full selected-chat serialization must not run."); },
    pupPage: {
      async evaluate(callback, ...args) {
        return runInNewContext(`(${callback.toString()})(...args)`, {
          args,
          window: {
            require(name) {
              assert.equal(name, "WAWebCollections");
              return { Chat: { getModelsArray: () => models } };
            },
          },
        });
      },
    },
  };
  const helper = createWhatsAppHelper({
    wa: { getState: () => ({ state: "ready" }), getLastQr: () => null, ensureClient: () => client },
    qrToDataURL: async () => null, token, now: () => now,
    createDirectChat(actualClient, data) {
      assert.equal(actualClient, client);
      assert.equal(data.id._serialized, chatId);
      assert.equal(data.isGroup, false);
      factoryCalls.push(data);
      return {
        id: data.id, name: data.formattedTitle,
        async fetchMessages(options) {
          fetches.push({ chatId: data.id._serialized, ...options });
          return source.slice(-options.limit);
        },
      };
    },
  });
  await new Promise(resolve => helper.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => helper.close(resolve)));
  const base = `http://127.0.0.1:${helper.address().port}`;
  const request = async (selected = chatId, { limit = 10, hours = 24 } = {}) => {
    const response = await fetch(`${base}/messages?${new URLSearchParams({ chatId: selected, limit, hours })}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return { status: response.status, data: await response.json() };
  };
  return { request, factoryCalls, fetches };
}

test("selected message reads construct an exact direct SDK chat without full chat serialization", async t => {
  const f = await fixture(t);
  const response = await f.request(chatId, { limit: 2 });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.deepEqual(response.data.chat, { id: chatId, name: "Fixture customer" });
  assert.equal(response.data.accountId, accountId);
  assert.deepEqual(response.data.messages.map(message => message.id), ["fixture-message-one", "fixture-message-two"]);
  assert.deepEqual(f.fetches, [{ chatId, limit: 2 }]);
  assert.equal(f.factoryCalls.length, 1);
});

test("unknown, group and channel identifiers are rejected before SDK message loading", async t => {
  const f = await fixture(t);
  for (const id of [
    "fixture-missing@c.us", "fixture-group@g.us", "fixture-marked-group@lid", "fixture-newsletter@newsletter",
  ]) {
    const response = await f.request(id);
    assert.equal(response.status, 400, `${id}: ${JSON.stringify(response.data)}`);
  }
  assert.deepEqual(f.factoryCalls, []);
  assert.deepEqual(f.fetches, []);
});

test("modern account, message and sender identifiers remain stable for import deduplication", async t => {
  const f = await fixture(t, {
    modernAccount: true,
    messages: [
      { id: { $1: "fixture-modern-one" }, body: "Order two breads", type: "chat",
        fromMe: false, from: { $1: chatId }, timestamp: now / 1000 - 120 },
      { id: { $1: "fixture-modern-two" }, body: "Order three cakes", type: "chat",
        fromMe: false, _data: { author: { $1: "fixture-sender@lid" } }, timestamp: now / 1000 - 60 },
    ],
  });
  const response = await f.request();
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data.accountId, accountId);
  assert.deepEqual(response.data.messages.map(message => message.id), ["fixture-modern-one", "fixture-modern-two"]);
  assert.deepEqual(response.data.messages.map(message => message.sender), [chatId, "fixture-sender@lid"]);
  const replay = await f.request();
  assert.deepEqual(replay.data.messages.map(message => message.id), ["fixture-modern-one", "fixture-modern-two"]);
});

test("selected SDK reads keep the requested message cap and discard records outside the time window", async t => {
  const f = await fixture(t, {
    messages: [
      { id: { $1: "fixture-old" }, body: "Old order", type: "chat", fromMe: false,
        from: chatId, timestamp: now / 1000 - 7200 },
      { id: { $1: "fixture-recent" }, body: "Order bread", type: "chat", fromMe: false,
        from: chatId, timestamp: now / 1000 - 60 },
    ],
  });
  const response = await f.request(chatId, { hours: 1, limit: 2 });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.deepEqual(response.data.messages.map(message => message.id), ["fixture-recent"]);
  assert.deepEqual(f.fetches, [{ chatId, limit: 2 }]);
  assert.equal(response.data.truncated, true);
});
