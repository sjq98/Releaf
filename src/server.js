import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { AppError, createStore } from "./store.js";
import { createAIConfig } from "./ai-config.js";
import { createAgentOperations } from "./agent-operations.js";
import { createAssistant } from "./assistant.js";
import { createAgentHTTP } from "./agent-http.js";
import { createTableImport, parseTableFile } from "./table-import.js";
import { sessionCookie, clearSessionCookie } from "./auth.js";
import { ORDER_SPACE_ID } from "./order-system.js";
import { createWhatsAppBridge } from "./whatsapp-bridge.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATIC = new Map([
  ["/", ["public/index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["public/app.js", "text/javascript; charset=utf-8"]],
  ["/table-pan.js", ["public/table-pan.js", "text/javascript; charset=utf-8"]],
  ["/auth.js", ["public/auth.js", "text/javascript; charset=utf-8"]],
  ["/auth.css", ["public/auth.css", "text/css; charset=utf-8"]],
  ["/i18n.js", ["public/i18n.js", "text/javascript; charset=utf-8"]],
  ["/locales/zh.js", ["public/locales/zh.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["public/styles.css", "text/css; charset=utf-8"]],
  ["/field-types.js", ["src/field-types.js", "text/javascript; charset=utf-8"]],
  ["/errors.js", ["src/errors.js", "text/javascript; charset=utf-8"]],
  ["/field-ui.js", ["public/field-ui.js", "text/javascript; charset=utf-8"]],
  ["/form-deletion.js", ["public/form-deletion.js", "text/javascript; charset=utf-8"]],
  ["/space-deletion.js", ["public/space-deletion.js", "text/javascript; charset=utf-8"]],
  ["/ai-settings.js", ["public/ai-settings.js", "text/javascript; charset=utf-8"]],
  ["/assistant.js", ["public/assistant.js", "text/javascript; charset=utf-8"]],
  ["/assistant.css", ["public/assistant.css", "text/css; charset=utf-8"]],
  ["/table-import.js", ["public/table-import.js", "text/javascript; charset=utf-8"]],
  ["/workflows.css", ["public/workflows.css", "text/css; charset=utf-8"]],
  ["/warehouse.js", ["public/warehouse.js", "text/javascript; charset=utf-8"]],
  ["/warehouse-import.js", ["public/warehouse-import.js", "text/javascript; charset=utf-8"]],
  ["/warehouse.css", ["public/warehouse.css", "text/css; charset=utf-8"]],
  ["/inventory-dashboard.js", ["public/inventory-dashboard.js", "text/javascript; charset=utf-8"]],
  ["/inventory-dashboard.css", ["public/inventory-dashboard.css", "text/css; charset=utf-8"]],
  ["/meeting-tasks.js", ["public/meeting-tasks.js", "text/javascript; charset=utf-8"]],
  ["/meeting-tasks.css", ["public/meeting-tasks.css", "text/css; charset=utf-8"]],
  ["/orders.js", ["public/orders.js", "text/javascript; charset=utf-8"]],
  ["/orders.css", ["public/orders.css", "text/css; charset=utf-8"]],
  ["/workspace.js", ["public/workspace.js", "text/javascript; charset=utf-8"]],
  ["/navigation-drag.js", ["public/navigation-drag.js", "text/javascript; charset=utf-8"]],
  ["/workspace.css", ["public/workspace.css", "text/css; charset=utf-8"]],
  ["/formula-editor.js", ["public/formula-editor.js", "text/javascript; charset=utf-8"]],
  ["/condition-expression.js", ["src/condition-expression.js", "text/javascript; charset=utf-8"]],
  ["/vendor/pdf.mjs", ["node_modules/pdfjs-dist/build/pdf.min.mjs", "text/javascript; charset=utf-8"]],
  ["/vendor/pdf.worker.mjs", ["node_modules/pdfjs-dist/build/pdf.worker.min.mjs", "text/javascript; charset=utf-8"]],
  ["/vendor/lucide.js", ["node_modules/lucide/dist/umd/lucide.min.js", "text/javascript; charset=utf-8"]],
  ["/vendor/chart.js", ["node_modules/chart.js/dist/chart.umd.min.js", "text/javascript; charset=utf-8"]],
]);

async function readJson(request, limit = 256 * 1024) {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    throw new AppError(415, "Content-Type must be application/json.");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new AppError(413, "Request is too large.");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new AppError(400, "Invalid JSON request body.");
  }
}

export function createApp({ database = resolve(ROOT, "data/forms.sqlite"), taskAI, env = process.env, aiFetch = fetch, assistantFetch = aiFetch, whatsappOptions = {} } = {}) {
  const store = createStore(database);
  const auth = store.auth;
  const aiConfig = createAIConfig({ store, env, fetchImpl: aiFetch });
  store.meetings.initialize();
  store.meetings.configure({ aiConfig, fetchImpl: aiFetch });
  store.orders.configure({ aiConfig, fetchImpl: aiFetch });
  store.whatsapp = createWhatsAppBridge({
    store, projectPath: resolve(ROOT, "..", "whatsapp-digest-local"), ...whatsappOptions,
  });
  const operations = createAgentOperations(store);
  const assistant = createAssistant({ store, operations, env, fetchImpl: assistantFetch });
  const agentHTTP = createAgentHTTP({ store, operations, assistant, readJson });
  const tableImport = createTableImport(store);
  store.tasks.configure({ aiConfig, fetchImpl: aiFetch, taskAI });
  const stopTasks = store.tasks.start();
  const server = createServer(async (request, response) => {
    const send = (status, value) => {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify(value));
    };
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "same-origin");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      const url = new URL(request.url, "http://localhost");
      const { pathname } = url;
      const method = request.method;
      if (pathname.startsWith("/api/")) {
        const origin = request.headers.origin;
        if (origin && origin !== `http://${request.headers.host}`) throw new AppError(403, "Cross-origin requests are not allowed.");
        const host = new URL(`http://${request.headers.host}`).hostname;
        const localAddress = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress);
        if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) throw new AppError(403, "Use the local workspace address.");
        if (!pathname.startsWith("/api/agent/")) {
          if (!localAddress) throw new AppError(403, "Workspace administration is local-only.");
          if (request.headers.authorization) throw new AppError(403, "Agent tokens may only access /api/agent/ endpoints.");
          if (request.headers["sec-fetch-site"] === "cross-site") throw new AppError(403, "Cross-site requests are not allowed.");
        }
        if (pathname === "/api/auth/status" && method === "GET") {
          let user = null;
          try { user = auth.authenticate(request.headers.cookie); } catch (error) { if (error.status !== 401) throw error; }
          return send(200, { setupRequired: auth.status().setupRequired, user, permissions: auth.permissions(user) });
        }
        if (method === "POST" && ["/api/auth/setup", "/api/auth/register", "/api/auth/login"].includes(pathname)) {
          const body = await readJson(request, 8 * 1024);
          const action = pathname.slice("/api/auth/".length);
          const result = auth[action](body, request.socket.remoteAddress);
          response.setHeader("Set-Cookie", sessionCookie(result.sessionToken));
          return send(action === "login" ? 200 : 201, { user: result.user, permissions: auth.permissions(result.user) });
        }
        if (pathname === "/api/auth/logout" && method === "POST") {
          await readJson(request, 8 * 1024);
          const result = auth.logout(request.headers.cookie);
          response.setHeader("Set-Cookie", clearSessionCookie());
          return send(200, result);
        }
        if (pathname.startsWith("/api/agent/")) {
          await agentHTTP(request, url, send);
          return;
        }
        const user = auth.authenticate(request.headers.cookie);
        return await auth.withUser(user, async () => {
        if (pathname === "/api/auth/password" && method === "POST") {
          const result = auth.changePassword(await readJson(request, 8 * 1024));
          response.setHeader("Set-Cookie", sessionCookie(result.sessionToken));
          return send(200, { changed: true, user: result.user, permissions: auth.permissions(result.user) });
        }
        if (pathname === "/api/auth/assignees" && method === "GET") return send(200, auth.assignees());
        if (pathname.startsWith("/api/assistant/")) return await agentHTTP(request, url, send);
        if (pathname === "/api/auth/users") {
          auth.requireAdmin();
          if (method === "GET") return send(200, auth.listUsers());
          if (method === "POST") return send(201, auth.createUser(await readJson(request, 8 * 1024)));
        }
        const userMatch = pathname.match(/^\/api\/auth\/users\/([a-zA-Z0-9-]+)$/);
        if (userMatch && method === "PATCH") {
          auth.requireAdmin();
          return send(200, auth.updateUser(userMatch[1], await readJson(request, 8 * 1024)));
        }
        const memberWrite = pathname === "/api/formulas/preview" ||
          pathname === "/api/warehouse/files" || pathname.startsWith("/api/warehouse/imports/") ||
          pathname === "/api/warehouse/documents" || /^\/api\/warehouse\/documents\/[a-zA-Z0-9-]+(?:\/(?:preview|transition))?$/.test(pathname) ||
          pathname === "/api/attachments" || /^\/api\/notifications\/[a-zA-Z0-9-]+$/.test(pathname) ||
          pathname === "/api/orders" || pathname === "/api/orders/extract" || pathname === "/api/orders/intake" ||
          /^\/api\/orders\/[a-zA-Z0-9-]+(?:\/(?:transition|payments|payment-confirmation|invoices|notifications))?$/.test(pathname) ||
          /^\/api\/ai-tasks\/[a-zA-Z0-9-]+\/run$/.test(pathname) ||
          /^\/api\/ai-runs\/[a-zA-Z0-9-]+\/(?:preview|retry|cancel)$/.test(pathname);
        if (!["GET", "HEAD"].includes(method) && !memberWrite) auth.requireAdmin();
        const spaceId = url.searchParams.get("spaceId") ?? "default";
        const write = (body, callback) => {
          const key = request.headers["idempotency-key"];
          if (key && (typeof key !== "string" || key.length > 200)) throw new AppError(400, "Invalid idempotency key.");
          const scopedKey = key ? `user:${user.id}:${createHash("sha256").update(key).digest("hex")}` : undefined;
          return store.automation.once(scopedKey, { pathname, method, body }, callback);
        };
        if (pathname === "/api/bootstrap" && method === "GET") return send(200, { ...store.bootstrap(url.searchParams.get("formId"), spaceId), ai: aiConfig.status, user, permissions: auth.permissions(user) });
        if (pathname === "/api/orders/workspace" && method === "GET") return send(200, store.orders.state(url.searchParams.get("spaceId") ?? ORDER_SPACE_ID));
        if (pathname === "/api/orders/extract" && method === "POST") return send(200, await store.orders.extract(await readJson(request)));
        if (pathname === "/api/orders/intake" && method === "POST") {
          const body = await readJson(request);
          const draft = await store.orders.extract(body);
          return send(201, write(body, () => store.orders.importExtracted({
            draft, text: body.text,
          })));
        }
        if (pathname.startsWith("/api/whatsapp/")) {
          auth.requireAdmin();
          if (pathname === "/api/whatsapp/status" && method === "GET") return send(200, await store.whatsapp.status());
          if (pathname === "/api/whatsapp/chats" && method === "GET") return send(200, await store.whatsapp.chats());
          if (method === "POST") {
            const body = await readJson(request);
            if (pathname === "/api/whatsapp/connect") return send(200, await store.whatsapp.connect(body));
            if (pathname === "/api/whatsapp/link") return send(200, await store.whatsapp.link());
            if (pathname === "/api/whatsapp/preview") return send(200, await store.whatsapp.previewImport(body));
            if (pathname === "/api/whatsapp/import") return send(201, write(body, () => store.whatsapp.importMessages(body)));
          }
        }
        if (pathname === "/api/orders") {
          if (method === "GET") return send(200, store.orders.list(url.searchParams.get("spaceId") ?? ORDER_SPACE_ID));
          if (method === "POST") {
            const body = await readJson(request);
            return send(201, write(body, () => store.orders.create(body)));
          }
        }
        const orderMatch = pathname.match(/^\/api\/orders\/([a-zA-Z0-9-]+)(?:\/(transition|payments|payment-confirmation|invoices|notifications))?$/);
        if (orderMatch) {
          const [, id, action] = orderMatch;
          if (!action && method === "GET") return send(200, store.orders.get(id));
          if (!action && method === "PATCH") {
            const body = await readJson(request);
            return send(200, write(body, () => store.orders.update(id, body)));
          }
          if (action && method === "POST") {
            if (action === "payments") throw new AppError(410, "Per-payment amounts are retired. Use the paid-in-full confirmation workflow.");
            const handler = { transition: "transition", "payment-confirmation": "confirmPayment", invoices: "invoice", notifications: "notification" }[action];
            const body = await readJson(request);
            return send(200, write(body, () => store.orders[handler](id, body)));
          }
        }
        if (pathname === "/api/meeting-tasks/imports") {
          if (method === "GET") return send(200, store.meetings.list(spaceId));
          if (method === "POST") return send(200, await store.meetings.importSummary(await readJson(request), request.headers["idempotency-key"]));
        }
        const meetingImport = pathname.match(/^\/api\/meeting-tasks\/imports\/([a-zA-Z0-9-]+)$/);
        if (meetingImport && method === "GET") return send(200, store.meetings.get(meetingImport[1], spaceId));
        if (/^\/api\/(?:inventory|suppliers|reconciliations|meetings|stock-receipts)(?:\/|$)/.test(pathname)) {
          throw new AppError(410, "This legacy module has been retired. Use the warehouse workspace or configurable AI tasks.");
        }
        if (pathname === "/api/warehouse" && method === "GET") return send(200, store.warehouse.state(spaceId));
        if (pathname === "/api/warehouse/dashboard" && method === "GET") {
          return send(200, store.warehouseDashboard.report(Object.fromEntries(url.searchParams)));
        }
        if (pathname === "/api/warehouse/catalog" && method === "POST") {
          const body = await readJson(request); return send(200, write(body, () => store.warehouse.catalog(body)));
        }
        if (pathname === "/api/warehouse/files" && method === "POST") return send(201, await store.warehouseImports.upload(await readJson(request, 8 * 1024 * 1024)));
        const warehouseFile = pathname.match(/^\/api\/warehouse\/files\/([a-zA-Z0-9-]+)$/);
        if (warehouseFile && method === "GET") return send(200, store.warehouseImports.info(warehouseFile[1]));
        if (pathname === "/api/warehouse/imports/match" && method === "POST") return send(200, store.warehouseImports.match(await readJson(request)));
        if (pathname === "/api/warehouse/imports/preview" && method === "POST") return send(200, store.warehouseImports.preview(await readJson(request)));
        if (pathname === "/api/warehouse/imports/execute" && method === "POST") {
          const body = await readJson(request); return send(200, write(body, () => store.warehouseImports.execute(body)));
        }
        if (pathname === "/api/warehouse/setup" && method === "POST") {
          const body = await readJson(request); return send(200, write(body, () => store.warehouse.ensureTables(body.spaceId)));
        }
        if (pathname === "/api/warehouse/documents" && method === "POST") {
          const body = await readJson(request); return send(201, write(body, () => store.warehouse.createDocument(body)));
        }
        const warehouseDoc = pathname.match(/^\/api\/warehouse\/documents\/([a-zA-Z0-9-]+)(?:\/(preview|transition))?$/);
        if (warehouseDoc) {
          const [, id, action] = warehouseDoc;
          if (!action && method === "GET") return send(200, store.warehouse.document(id));
          if (!action && method === "PUT") { const body = await readJson(request); return send(200, write(body, () => store.warehouse.updateDocument(id, body))); }
          if (action && method === "POST") {
            const body = await readJson(request), doc = store.warehouse.document(id), owner = store.getForm(doc.record.formId).spaceId;
            if (action === "preview") {
              const fingerprint = store.automation.fingerprint(owner);
              return send(200, store.preview(() => ({ result: store.warehouse.transition(id, body), changes: store.automation.changes(), fingerprint })));
            }
            return send(200, write(body, () => store.transaction(() => {
              if (["post", "reverse"].includes(body.action) && body.fingerprint !== store.automation.fingerprint(owner)) throw new AppError(409, "Warehouse data changed. Preview this action again.");
              return store.warehouse.transition(id, body);
            })));
          }
        }
        if (pathname === "/api/spaces" && method === "GET") return send(200, store.spaces.list());
        if (pathname === "/api/spaces" && method === "POST") {
          const body = await readJson(request);
          return send(201, write(body, () => store.transaction(() => {
            const space = store.spaces.create(body.name);
            store.createForm({ name: "New form", spaceId: space.id, parentId: null });
            return space;
          })));
        }
        const spaceMatch = pathname.match(/^\/api\/spaces\/([a-zA-Z0-9-]+)(\/deletion-preview)?$/);
        if (spaceMatch?.[2] && method === "GET") return send(200, store.spaceDeletions.inspect(spaceMatch[1]));
        if (spaceMatch && !spaceMatch[2] && method === "PATCH") return send(200, store.spaces.rename(spaceMatch[1], (await readJson(request)).name));
        if (spaceMatch && !spaceMatch[2] && method === "DELETE") {
          const body = await readJson(request);
          return send(200, write(body, () => store.spaceDeletions.remove(spaceMatch[1], body)));
        }
        if (pathname === "/api/nodes" && method === "GET") return send(200, store.spaces.tree(spaceId));
        if (pathname === "/api/nodes" && method === "POST") {
          const body = await readJson(request); return send(201, write(body, () => store.spaces.createNode(body)));
        }
        const nodeMove = pathname.match(/^\/api\/nodes\/([a-zA-Z0-9_-]+)\/move$/);
        if (nodeMove && method === "POST") {
          const body = await readJson(request);
          return send(200, write(body, () => store.transaction(() => {
            const node = store.spaces.moveNode(nodeMove[1], body);
            return { node, navigation: store.spaces.tree(node.spaceId) };
          })));
        }
        const nodeMatch = pathname.match(/^\/api\/nodes\/([a-zA-Z0-9_-]+)$/);
        if (nodeMatch && method === "PATCH") {
          const body = await readJson(request);
          return send(200, store.transaction(() => store.spaces.updateNode(nodeMatch[1], body)));
        }
        if (nodeMatch && method === "DELETE") return send(200, store.spaces.deleteNode(nodeMatch[1]));
        if (pathname === "/api/formulas/preview" && method === "POST") return send(200, store.formulaPreview(await readJson(request)));
        if (pathname === "/api/expressions/preview" && method === "POST") {
          const body = await readJson(request), form = store.getForm(body.formId), target = store.getForm(body.targetFormId ?? body.formId);
          if (target.spaceId !== form.spaceId) throw new AppError(400, "Expressions must stay within one Space.");
          const expression = { kind: "formula", formula: body.formula };
          store.automation.validateValue(expression, form, target, form.spaceId);
          const source = store.listRecords(form.id)[0], row = store.listRecords(target.id)[0];
          return send(200, { value: store.automation.value(expression, { spaceId: form.spaceId, event: { after: source?.values, before: source?.values }, target: row }) });
        }
        if (/^\/api\/automations(?:\/|$)/.test(pathname)) throw new AppError(410, "Custom cross-form automation is archived; warehouse workflows are built in.");
        if (pathname === "/api/notification-rules" && method === "GET") return send(200, store.automation.list(spaceId, url.searchParams.get("formId")));
        if (pathname === "/api/notification-rules" && method === "POST") {
          const body = await readJson(request); return send(201, write(body, () => store.automation.save(body)));
        }
        const automationMatch = pathname.match(/^\/api\/notification-rules\/([a-zA-Z0-9-]+)$/);
        if (automationMatch && method === "PUT") { const body = await readJson(request); return send(200, store.automation.save(body, automationMatch[1])); }
        if (automationMatch && method === "DELETE") return send(200, store.automation.remove(automationMatch[1], (await readJson(request)).version));
        if (pathname === "/api/automation-runs" && method === "GET") return send(200, store.automation.runs(spaceId, url.searchParams.get("formId")));
        if (pathname === "/api/notification-rules/preview" && method === "POST") {
          const body = await readJson(request), form = store.getForm(body.formId);
          const baseline = store.automation.fingerprint(form.spaceId);
          const preview = store.preview(() => {
            const result = body.operation === "create" ? store.createRecord(form.id, { schemaVersion: form.version, values: body.values })
              : body.operation === "update" ? store.updateRecord(body.recordId, { schemaVersion: form.version, version: store.getRecord(body.recordId).version, values: body.values })
                : body.operation === "delete" ? store.deleteRecord(body.recordId, { version: store.getRecord(body.recordId).version }) : null;
            if (!result) throw new AppError(400, "Choose a create, update, or delete simulation.");
            return { result, changes: store.automation.changes() };
          });
          return send(200, { ...preview, fingerprint: baseline });
        }
        if (pathname === "/api/errors" && method === "GET") return send(200, store.automation.errors(spaceId));
        const errorMatch = pathname.match(/^\/api\/errors\/([a-zA-Z0-9-]+)(\/retry)?$/);
        if (errorMatch && method === "PATCH") return send(200, store.automation.resolveError(errorMatch[1], (await readJson(request)).status));
        if (errorMatch && errorMatch[2] && method === "POST") {
          const item = store.automation.errors(spaceId).find((item) => item.id === errorMatch[1]);
          if (!item) throw new AppError(404, "Error not found.");
          if (item.status !== "Unresolved") return send(200, item);
          if (item.context.runId) return send(200, store.tasks.retry(item.context.runId));
          const { operation, formId, recordId, body } = item.context;
          const result = store.transaction(() => {
            const result = operation === "create_record" ? store.createRecord(formId, body)
              : operation === "update_record" ? store.updateRecord(recordId, body)
                : operation === "delete_record" ? store.deleteRecord(recordId, body)
                  : operation === "update_form" ? store.updateForm(formId, body) : null;
            if (!result) throw new AppError(400, "Open the source configuration to correct this error.");
            store.automation.resolveError(item.id, "Resolved"); return result;
          });
          return send(200, result);
        }
        if (pathname === "/api/notifications" && method === "GET") return send(200, store.automation.notifications(spaceId));
        const notification = pathname.match(/^\/api\/notifications\/([a-zA-Z0-9-]+)$/);
        if (notification && method === "PATCH") return send(200, store.automation.readNotification(notification[1]));
        if (pathname === "/api/attachments" && method === "POST") return send(201, store.files.upload(await readJson(request, 24 * 1024 * 1024)));
        const attachment = pathname.match(/^\/api\/attachments\/([a-zA-Z0-9-]+)(\/info)?$/);
        if (attachment && method === "GET") {
          if (attachment[2]) return send(200, store.files.info(attachment[1]));
          const file = store.files.get(attachment[1]);
          response.writeHead(200, { "Content-Type": file.mime, "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`, "Cache-Control": "no-store" });
          return response.end(file.bytes);
        }
        if (pathname === "/api/ai-tasks" && method === "GET") return send(200, store.tasks.list(spaceId));
        if (pathname === "/api/ai-tasks" && method === "POST") {
          const body = await readJson(request); return send(201, write(body, () => store.tasks.save(body)));
        }
        const taskMatch = pathname.match(/^\/api\/ai-tasks\/([a-zA-Z0-9-]+)(\/run)?$/);
        if (taskMatch && method === "PUT") return send(200, store.tasks.save(await readJson(request), taskMatch[1]));
        if (taskMatch && method === "DELETE") return send(200, store.tasks.remove(taskMatch[1], (await readJson(request)).version));
        if (taskMatch?.[2] && method === "POST") {
          const body = await readJson(request); return send(202, write(body, () => store.transaction(() => store.tasks.enqueue(taskMatch[1], body))));
        }
        if (pathname === "/api/ai-runs" && method === "GET") return send(200, store.tasks.runs(spaceId));
        const aiRun = pathname.match(/^\/api\/ai-runs\/([a-zA-Z0-9-]+)(?:\/(preview|apply|retry|cancel))?$/);
        if (aiRun && method === "GET") return send(200, store.tasks.run(aiRun[1]));
        if (aiRun && method === "POST") {
          const body = await readJson(request), id = aiRun[1];
          if (aiRun[2] === "preview") return send(200, store.tasks.preview(id));
          if (aiRun[2] === "apply") return send(200, store.tasks.apply(id, { fingerprint: body.fingerprint }));
          if (aiRun[2] === "retry") return send(202, store.tasks.retry(id));
          if (aiRun[2] === "cancel") return send(200, store.tasks.cancel(id));
        }
        if (pathname === "/api/ai/config" && method === "GET") return send(200, aiConfig.publicConfig());
        if (pathname === "/api/ai/config" && method === "PUT") return send(200, await aiConfig.save(await readJson(request)));
        if (pathname === "/api/ai/models" && method === "POST") return send(200, await aiConfig.models(await readJson(request)));
        if (pathname === "/api/imports/parse" && method === "POST") return send(200, await parseTableFile((await readJson(request, 8 * 1024 * 1024)).file));
        if (pathname === "/api/imports/preview" && method === "POST") return send(200, tableImport.preview(await readJson(request, 8 * 1024 * 1024)));
        const importMatch = pathname.match(/^\/api\/imports\/([a-zA-Z0-9-]+)\/commit$/);
        if (importMatch && method === "POST") return send(200, tableImport.commit(importMatch[1]));
        if (pathname === "/api/forms") {
          if (method === "GET") return send(200, store.listForms(spaceId));
          if (method === "POST") { const body = await readJson(request); return send(201, write(body, () => store.createForm(body))); }
        }
        const formMatch = pathname.match(/^\/api\/forms\/([a-zA-Z0-9-]+)(?:\/(records|changes|deletion-preview))?$/);
        if (formMatch) {
          const [, id, resource] = formMatch;
          if (!resource && method === "GET") return send(200, store.getForm(id));
          if (!resource && method === "PUT") { const body = await readJson(request); return send(200, write(body, () => store.updateForm(id, body))); }
          if (!resource && method === "DELETE") { const body = await readJson(request); return send(200, write(body, () => store.deletions.remove(id, body))); }
          if (resource === "deletion-preview" && method === "GET") return send(200, store.deletions.inspect(id));
          if (resource === "records" && method === "GET") return send(200, store.listRecords(id));
          if (resource === "records" && method === "POST") { const body = await readJson(request); return send(201, write(body, () => store.createRecord(id, body))); }
          if (resource === "changes" && method === "GET") return send(200, store.listChanges(id));
        }
        const recordMatch = pathname.match(/^\/api\/records\/([a-zA-Z0-9-]+)$/);
        if (recordMatch) {
          const id = recordMatch[1];
          if (method === "GET") return send(200, store.getRecord(id));
          if (method === "PATCH") { const body = await readJson(request); return send(200, write(body, () => store.updateRecord(id, body))); }
          if (method === "DELETE") { const body = await readJson(request); return send(200, write(body, () => store.deleteRecord(id, body))); }
        }
        throw new AppError(404, "API endpoint not found.");
        });
      }
      if (pathname === "/favicon.ico") {
        response.writeHead(204);
        return response.end();
      }
      const asset = STATIC.get(pathname);
      if (!asset || (method !== "GET" && method !== "HEAD")) throw new AppError(404, "Page not found.");
      const content = await readFile(resolve(ROOT, asset[0]));
      response.writeHead(200, { "Content-Type": asset[1], "Cache-Control": "no-cache" });
      response.end(method === "HEAD" ? undefined : content);
    } catch (error) {
      if (!(error instanceof AppError)) console.error(error);
      send(error.status || 500, { error: error.status ? error.message : "An unexpected server error occurred.", fields: error.fields || {} });
    }
  });
  server.on("close", stopTasks);
  server.on("close", () => store.whatsapp.close());
  return { server, store };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 5174);
  const database = process.env.ORDER_DB ? resolve(process.env.ORDER_DB) : undefined;
  const { server, store } = createApp({ database });
  server.on("error", (error) => {
    console.error(error.code === "EADDRINUSE" ? `Port ${port} is already in use. Use the running server or stop it before restarting.` : error.message);
    store.close();
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => console.log(`Form Studio: http://127.0.0.1:${port}`));
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => server.close(() => {
      store.close();
      process.exit(0);
    }));
  }
}
