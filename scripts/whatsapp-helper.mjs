import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inspectWhatsAppProject, WHATSAPP_PROTOCOL } from "../src/whatsapp-bridge.js";

const integer = (value, fallback, max) => {
  const result = value == null ? fallback : Number(value);
  if (!Number.isInteger(result) || result < 1 || result > max) throw new Error("Invalid read limit.");
  return result;
};
const same = (a, b) => {
  const left = Buffer.from(a || ""), right = Buffer.from(b || "");
  return left.length === right.length && timingSafeEqual(left, right);
};
const serializedId = value => value?._serialized || value?.$1 || null;

async function directChatMetadata(client, exactId = null) {
  if (!client.pupPage?.evaluate) return (await client.getChats()).filter(chat => !chat.isGroup && chat.id?._serialized && (!exactId || chat.id._serialized === exactId));
  // SDK getChats also serializes last messages, whose key format changes independently.
  return client.pupPage.evaluate(selectedId => window.require("WAWebCollections").Chat.getModelsArray().flatMap(chat => {
    const id = chat.id?._serialized || chat.id?.$1;
    if (typeof id !== "string" || !/@(?:c\.us|lid)$/.test(id) || chat.groupMetadata || selectedId && id !== selectedId) return [];
    const timestamp = Number(chat.t);
    return [{
      id: { _serialized: id },
      name: String(chat.formattedTitle || chat.name || chat.id.user || "").slice(0, 200),
      timestamp: Number.isFinite(timestamp) && timestamp > 0 && timestamp <= 8_640_000_000_000 ? timestamp : 0,
    }];
  }), exactId);
}

export function createWhatsAppHelper({ wa, qrToDataURL, token, createDirectChat, now = () => Date.now() }) {
  if (typeof token !== "string" || token.length < 32) throw new TypeError("A private helper token is required.");
  let client = null;
  const server = http.createServer(async (req, res) => {
    const send = (status, value) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      res.end(JSON.stringify({ protocol: WHATSAPP_PROTOCOL, ...value }));
    };
    const expectedHost = `127.0.0.1:${server.address().port}`;
    if (req.headers.host !== expectedHost || req.headers.origin ||
        req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "none") {
      send(403, { error: "Local helper access only." }); return;
    }
    if (!same(req.headers.authorization, `Bearer ${token}`)) { send(401, { error: "The private WhatsApp helper token does not match." }); return; }
    const url = new URL(req.url, `http://${expectedHost}`);
    const expectedMethod = url.pathname === "/link" ? "POST" : "GET";
    if (req.method !== expectedMethod) { send(405, { error: "Method not allowed." }); return; }
    try {
      const status = async () => {
        const state = wa.getState();
        const accountId = serializedId(client?.info?.wid);
        const qr = wa.getLastQr();
        return { state: state.state, linked: state.state === "ready", accountId,
          qrImage: qr ? await qrToDataURL(qr) : null,
          ...(state.error ? { error: String(state.error).slice(0, 1000) } : {}) };
      };
      if (url.pathname === "/status") { send(200, await status()); return; }
      if (url.pathname === "/link") { client = wa.ensureClient(); send(200, await status()); return; }
      const state = wa.getState();
      if (state.state !== "ready") {
        send(409, { error: "Link WhatsApp and wait for it to become ready." }); return;
      }
      client = wa.ensureClient();
      if (!serializedId(client?.info?.wid)) { send(409, { error: "Wait for the linked account to become ready." }); return; }
      if (url.pathname === "/chats") {
        const limit = integer(url.searchParams.get("limit"), 30, 100);
        const all = await directChatMetadata(client);
        all.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        send(200, {
          chats: all.slice(0, limit).map(chat => ({ id: chat.id._serialized,
            name: String(chat.name || chat.id.user || "").slice(0, 200), isGroup: false,
            lastActivity: chat.timestamp ? new Date(chat.timestamp * 1000).toISOString() : null })),
          truncated: all.length > limit,
        }); return;
      }
      if (url.pathname === "/messages") {
        const hours = integer(url.searchParams.get("hours"), 24, 168);
        const limit = integer(url.searchParams.get("limit"), 10, 50);
        const chatId = url.searchParams.get("chatId");
        if (!chatId || chatId.length > 200) { send(400, { error: "Choose one exact conversation ID." }); return; }
        let chat;
        if (createDirectChat && client.pupPage?.evaluate) {
          const [metadata] = await directChatMetadata(client, chatId);
          if (metadata) chat = createDirectChat(client, {
            id: metadata.id, formattedTitle: metadata.name, isGroup: false, t: metadata.timestamp,
          });
        } else {
          chat = await client.getChatById(chatId);
        }
        if (!chat || chat.isGroup || chat.id?._serialized !== chatId) {
          send(400, { error: "Choose one direct customer conversation." }); return;
        }
        const fetched = await chat.fetchMessages({ limit });
        const cutoff = now() - hours * 3_600_000;
        const selected = fetched.filter(message => message.timestamp * 1000 >= cutoff);
        send(200, {
          accountId: serializedId(client.info.wid),
          chat: { id: chatId, name: String(chat.name || "").slice(0, 200) },
          messages: selected.map(message => ({
            id: serializedId(message.id), body: typeof message.body === "string" ? message.body.slice(0, 40001) : "",
            type: message.type, fromMe: message.fromMe === true,
            sender: (() => {
              const sender = message.author || message.from || message._data?.author || message._data?.from;
              return typeof sender === "string" ? sender : serializedId(sender);
            })(),
            timestamp: new Date(message.timestamp * 1000).toISOString(),
          })),
          truncated: fetched.length >= limit,
        }); return;
      }
      send(404, { error: "Unknown helper operation." });
    } catch {
      send(502, { error: "The local WhatsApp read failed. Check the linked session and try again." });
    }
  });
  server.closeWhatsApp = async () => {
    const current = client;
    client = null;
    await current?.destroy();
  };
  return server;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const project = await inspectWhatsAppProject(process.argv[2]);
  const require = createRequire(join(project, "package.json"));
  const qrcode = require("qrcode");
  const { PrivateChat } = require("whatsapp-web.js");
  const wa = await import(pathToFileURL(join(project, "src", "wa.js")).href);
  const server = createWhatsAppHelper({
    wa, qrToDataURL: qr => qrcode.toDataURL(qr), token: process.env.RELEAF_WHATSAPP_TOKEN,
    createDirectChat: (client, data) => new PrivateChat(client, data),
  });
  const port = Number(process.env.RELEAF_WHATSAPP_PORT || 47291);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid helper port.");
  server.listen(port, "127.0.0.1");
  const shutdown = async () => {
    server.close();
    const timeout = setTimeout(() => process.exit(1), 4000);
    timeout.unref();
    try { await server.closeWhatsApp(); } finally { process.exit(0); }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("message", message => { if (message?.type === "shutdown") void shutdown(); });
  process.on("disconnect", () => { void shutdown(); });
}
