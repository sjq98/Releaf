import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "./errors.js";
import { whatsappOrderFields } from "./order-system.js";

export const WHATSAPP_PROTOCOL = "releaf-whatsapp-v1";
export const WHATSAPP_SOURCE_REVISION = "a104fa2054fc4ce0b228fc3c68052e73e721afbf";
export const WHATSAPP_SOURCE_HASH = "2c60a1ef37204b66daa7e9f76ea6b095a442a7e74da102c953be6b4e8694a67b";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HELPER_URL = "http://127.0.0.1:47291";
const PLAN_TTL = 30 * 60 * 1000;
const fail = (status, message) => { throw new AppError(status, message); };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const digest = value => createHash("sha256").update(value).digest("hex");

export async function inspectWhatsAppProject(projectPath) {
  if (typeof projectPath !== "string" || !isAbsolute(projectPath) || projectPath.length > 1000) {
    fail(400, "Choose the absolute path of the installed whatsapp-digest-local project.");
  }
  try {
    const directory = await realpath(projectPath);
    const metadata = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    const source = await readFile(join(directory, "src", "wa.js"), "utf8");
    if (metadata.name !== "whatsapp-digest" ||
        digest(source.replaceAll("\r\n", "\n")) !== WHATSAPP_SOURCE_HASH) {
      fail(409, "This connector revision has not been verified. Use the documented pinned whatsapp-digest-local revision.");
    }
    if (!(await stat(join(directory, "node_modules", "whatsapp-web.js"))).isDirectory() ||
        !(await stat(join(directory, "node_modules", "qrcode"))).isDirectory()) {
      fail(400, "Install the WhatsApp connector dependencies before connecting.");
    }
    return directory;
  } catch (error) {
    if (error instanceof AppError) throw error;
    fail(400, "The WhatsApp connector project or dependencies could not be found.");
  }
}

function importOptions(input) {
  if (!object(input) || typeof input.chatId !== "string" || !input.chatId ||
      input.chatId.length > 200) fail(400, "Choose one WhatsApp conversation.");
  const hours = input.hours ?? 24, limit = input.limit ?? 10;
  if (!Number.isInteger(hours) || hours < 1 || hours > 168 ||
      !Number.isInteger(limit) || limit < 1 || limit > 50) {
    fail(400, "Choose 1-168 hours and 1-50 recent messages.");
  }
  return { chatId: input.chatId, hours, limit };
}

export function createWhatsAppBridge({
  store, fetchImpl = fetch, projectPath = resolve(ROOT, "..", "whatsapp-digest-local"),
  spawnImpl = spawn, inspectProject = inspectWhatsAppProject, now = () => Date.now(),
  helperBaseUrl = HELPER_URL, requestTimeoutMs = 45000,
} = {}) {
  const helperUrl = new URL(helperBaseUrl);
  if (helperUrl.protocol !== "http:" || helperUrl.hostname !== "127.0.0.1" ||
      helperUrl.username || helperUrl.password || helperUrl.pathname !== "/" ||
      helperUrl.search || helperUrl.hash) throw new TypeError("The WhatsApp helper must use a loopback HTTP URL.");
  const db = store.database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS whatsapp_bridge_settings (
      id INTEGER PRIMARY KEY CHECK(id = 1), project_path TEXT NOT NULL,
      helper_token TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS whatsapp_import_plans (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      payload_json TEXT NOT NULL, expires_at TEXT NOT NULL, result_json TEXT,
      created_at TEXT NOT NULL
    );
  `);
  let child = null, connecting = null;
  const settings = () => db.prepare("SELECT * FROM whatsapp_bridge_settings WHERE id = 1").get();
  const requireAdmin = () => {
    store.auth.requireAdmin();
    const user = store.auth.currentUser();
    if (!user) fail(401, "Sign in before connecting WhatsApp.");
    return user;
  };
  const timestamp = () => new Date(now()).toISOString();

  async function request(path, { method = "GET", token = settings()?.helper_token } = {}) {
    if (!token) fail(503, "Connect the WhatsApp helper first.");
    const signal = AbortSignal.timeout(requestTimeoutMs);
    const timeoutMessage = "The WhatsApp read timed out. The connector may still be running; wait and refresh conversations.";
    let response;
    try {
      response = await fetchImpl(`${helperUrl.origin}${path}`, {
        method, redirect: "error", signal,
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
    } catch (error) {
      if (signal.aborted || error?.name === "TimeoutError") fail(504, timeoutMessage);
      fail(503, "The local WhatsApp helper is not running. Connect it before importing.");
    }
    let payload;
    try {
      const raw = await response.text();
      if (raw.length > 3_000_000) fail(502, "The WhatsApp helper returned too much data.");
      payload = JSON.parse(raw);
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (signal.aborted || error?.name === "TimeoutError") fail(504, timeoutMessage);
      fail(502, "The local WhatsApp helper returned an invalid response.");
    }
    if (payload.protocol !== WHATSAPP_PROTOCOL) {
      fail(409, "Another or incompatible helper is using the WhatsApp port. Stop it before connecting Releaf.");
    }
    if (!response.ok) fail(response.status === 401 ? 409 : response.status,
      typeof payload.error === "string" ? payload.error : "The WhatsApp helper could not complete this request.");
    return payload;
  }

  async function status() {
    requireAdmin();
    const config = settings();
    const base = {
      configured: Boolean(config), available: false, protocol: WHATSAPP_PROTOCOL,
      state: "offline", linked: false, readOnly: true, projectPath: config?.project_path ?? projectPath,
      qrImage: null,
    };
    if (!config) return { ...base, state: "not_configured" };
    try {
      const value = await request("/status");
      return { ...base, available: true, state: value.state, linked: value.linked === true,
        qrImage: value.qrImage ?? null, accountId: value.accountId ?? null,
        ...(value.error ? { error: value.error } : {}) };
    } catch (error) {
      return { ...base, error: error.message };
    }
  }

  async function connect(input = {}) {
    requireAdmin();
    if (!object(input) || Object.keys(input).some(key => key !== "projectPath")) fail(400, "Invalid WhatsApp connection options.");
    if (connecting) return connecting;
    connecting = (async () => {
      const current = settings();
      const directory = await inspectProject(input.projectPath || current?.project_path || projectPath);
      if (current) {
        const existing = await status();
        if (existing.available) {
          if (directory !== current.project_path) fail(409, "Stop the current helper before changing its project path.");
          return existing;
        }
      }
      const token = current?.helper_token || randomBytes(32).toString("base64url");
      db.prepare(`INSERT INTO whatsapp_bridge_settings VALUES (1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET project_path=excluded.project_path, updated_at=excluded.updated_at`)
        .run(directory, token, timestamp());
      if (!child || child.exitCode !== null) {
        child = spawnImpl(process.execPath, [join(ROOT, "scripts", "whatsapp-helper.mjs"), directory], {
          cwd: directory, windowsHide: true, shell: false,
          env: { ...process.env, RELEAF_WHATSAPP_TOKEN: token, RELEAF_WHATSAPP_PORT: helperUrl.port || "47291" },
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
        child.once?.("error", () => {});
      }
      for (let attempt = 0; attempt < 15; attempt++) {
        const value = await status();
        if (value.available) return value;
        if (child?.exitCode !== null && child?.exitCode !== undefined) break;
        await new Promise(resolveWait => setTimeout(resolveWait, 200));
      }
      const value = await status();
      if (!value.available) fail(503, value.error || "The WhatsApp helper could not start.");
      return value;
    })();
    try { return await connecting; } finally { connecting = null; }
  }

  async function link() {
    requireAdmin();
    const value = await request("/link", { method: "POST" });
    return { ...await status(), ...value, available: true, readOnly: true };
  }

  async function chats({ limit = 30 } = {}) {
    requireAdmin();
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail(400, "Choose 1-100 conversations.");
    return request(`/chats?${new URLSearchParams({ limit })}`);
  }

  async function previewImport(input) {
    const user = requireAdmin(), options = importOptions(input);
    const response = await request(`/messages?${new URLSearchParams(options)}`);
    if (response.chat?.id !== options.chatId || typeof response.accountId !== "string" ||
        !Array.isArray(response.messages) || response.messages.length > options.limit) {
      fail(502, "The WhatsApp helper returned an invalid conversation.");
    }
    const candidates = [], skipped = [], seen = new Set();
    for (const message of response.messages) {
      const id = message?.id;
      if (typeof id !== "string" || !id || id.length > 500) fail(502, "A WhatsApp message is missing its stable source ID.");
      if (seen.has(id)) continue;
      seen.add(id);
      if (message.fromMe || message.type !== "chat" || typeof message.body !== "string" ||
          !message.body.trim() || message.body.length > 40000) {
        skipped.push({ messageId: id, reason: message.fromMe ? "outbound_message" : "unsupported_message" });
        continue;
      }
      const source = {
        channel: "whatsapp", accountId: response.accountId, chatId: response.chat.id,
        chatName: String(response.chat.name ?? "").slice(0, 200), messageId: id,
        sender: typeof message.sender === "string" ? message.sender.slice(0, 200) : null,
        timestamp: typeof message.timestamp === "string" ? message.timestamp : null,
      };
      const draft = await store.orders.extract({ text: message.body });
      if (draft.isOrder !== true) { skipped.push({ messageId: id, reason: "not_an_order" }); continue; }
      candidates.push({
        source, text: message.body,
        draft: { ...draft, ...whatsappOrderFields(source), totalAmount: null, reviewed: false },
      });
    }
    const payload = {
      chat: { id: response.chat.id, name: String(response.chat.name ?? "").slice(0, 200) },
      candidates, duplicates: 0, skipped,
      counts: { scanned: seen.size, candidates: candidates.length, duplicates: 0, skipped: skipped.length },
      truncated: response.truncated === true,
    };
    const planId = randomUUID(), createdAt = timestamp(), expiresAt = new Date(now() + PLAN_TTL).toISOString();
    const fingerprint = digest(JSON.stringify({ ownerId: user.id, createdAt, payload }));
    db.prepare("DELETE FROM whatsapp_import_plans WHERE expires_at < ? AND result_json IS NULL").run(createdAt);
    db.prepare("INSERT INTO whatsapp_import_plans VALUES (?, ?, ?, ?, ?, NULL, ?)")
      .run(planId, user.id, fingerprint, JSON.stringify(payload), expiresAt, createdAt);
    return { planId, fingerprint, expiresAt, ...payload };
  }

  function planFor(input) {
    const user = requireAdmin();
    if (!object(input) || typeof input.planId !== "string") fail(400, "Choose a WhatsApp import preview.");
    const row = db.prepare("SELECT * FROM whatsapp_import_plans WHERE id = ? AND owner_id = ?").get(input.planId, user.id);
    if (!row) fail(404, "This WhatsApp import preview does not exist.");
    return row;
  }

  function getPlan(input) {
    const row = planFor(input);
    return { planId: row.id, fingerprint: row.fingerprint, expiresAt: row.expires_at,
      applied: row.result_json !== null, ...JSON.parse(row.payload_json) };
  }

  function importMessages(input) {
    const row = planFor(input);
    if (input.fingerprint !== row.fingerprint) fail(409, "The WhatsApp import preview changed. Create a new preview.");
    if (row.result_json) return { ...JSON.parse(row.result_json), replayed: true };
    if (Date.parse(row.expires_at) <= now()) fail(409, "The WhatsApp import preview expired. Create a new preview.");
    return store.transaction(() => {
      const payload = JSON.parse(row.payload_json);
      const orders = [], skipped = [...payload.skipped];
      for (const candidate of payload.candidates) {
        const order = store.orders.importExtracted({
          draft: candidate.draft, source: candidate.source, text: candidate.text,
        }, { deduplicateSource: false });
        if (order.skipped) skipped.push({ messageId: candidate.source.messageId, reason: order.reason });
        else orders.push(order);
      }
      const result = { orders, imported: orders.length, duplicates: 0, skipped, replayed: false };
      db.prepare("UPDATE whatsapp_import_plans SET result_json = ? WHERE id = ?").run(JSON.stringify(result), row.id);
      return result;
    });
  }

  function close() {
    if (child && child.exitCode === null) {
      const running = child;
      if (running.connected && running.send) {
        running.send({ type: "shutdown" }, () => {});
        const timeout = setTimeout(() => running.kill(), 5000);
        timeout.unref();
        running.once?.("exit", () => clearTimeout(timeout));
      } else running.kill();
    }
    child = null;
  }
  return { status, connect, link, chats, previewImport, getPlan, importMessages, close };
}
