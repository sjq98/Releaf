import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { AppError, createStore } from "./store.js";
import { validateMeeting, validateExtraction } from "./meeting-ai.js";
import { createAIConfig } from "./ai-config.js";
import { createAgentOperations } from "./agent-operations.js";
import { createAssistant } from "./assistant.js";
import { createAgentHTTP } from "./agent-http.js";
import { createTableImport, parseTableFile } from "./table-import.js";
import { createSupplierService } from "./supplier-reconciliation.js";
import { createInventoryModule } from "./inventory.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATIC = new Map([
  ["/", ["public/index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["public/app.js", "text/javascript; charset=utf-8"]],
  ["/i18n.js", ["public/i18n.js", "text/javascript; charset=utf-8"]],
  ["/locales/zh.js", ["public/locales/zh.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["public/styles.css", "text/css; charset=utf-8"]],
  ["/field-types.js", ["src/field-types.js", "text/javascript; charset=utf-8"]],
  ["/errors.js", ["src/errors.js", "text/javascript; charset=utf-8"]],
  ["/field-ui.js", ["public/field-ui.js", "text/javascript; charset=utf-8"]],
  ["/ai-settings.js", ["public/ai-settings.js", "text/javascript; charset=utf-8"]],
  ["/assistant.js", ["public/assistant.js", "text/javascript; charset=utf-8"]],
  ["/assistant.css", ["public/assistant.css", "text/css; charset=utf-8"]],
  ["/table-import.js", ["public/table-import.js", "text/javascript; charset=utf-8"]],
  ["/supplier.js", ["public/supplier.js", "text/javascript; charset=utf-8"]],
  ["/workflows.css", ["public/workflows.css", "text/css; charset=utf-8"]],
  ["/inventory.js", ["public/inventory.js", "text/javascript; charset=utf-8"]],
  ["/inventory.css", ["public/inventory.css", "text/css; charset=utf-8"]],
  ["/warehouse.js", ["public/warehouse.js", "text/javascript; charset=utf-8"]],
  ["/warehouse.css", ["public/warehouse.css", "text/css; charset=utf-8"]],
  ["/workspace.js", ["public/workspace.js", "text/javascript; charset=utf-8"]],
  ["/navigation-drag.js", ["public/navigation-drag.js", "text/javascript; charset=utf-8"]],
  ["/workspace.css", ["public/workspace.css", "text/css; charset=utf-8"]],
  ["/formula-editor.js", ["public/formula-editor.js", "text/javascript; charset=utf-8"]],
  ["/condition-expression.js", ["src/condition-expression.js", "text/javascript; charset=utf-8"]],
  ["/vendor/pdf.mjs", ["node_modules/pdfjs-dist/build/pdf.min.mjs", "text/javascript; charset=utf-8"]],
  ["/vendor/pdf.worker.mjs", ["node_modules/pdfjs-dist/build/pdf.worker.min.mjs", "text/javascript; charset=utf-8"]],
  ["/vendor/lucide.js", ["node_modules/lucide/dist/umd/lucide.min.js", "text/javascript; charset=utf-8"]],
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

export function createApp({ database = resolve(ROOT, "data/forms.sqlite"), ai, documentAI, taskAI, env = process.env, aiFetch = fetch, assistantFetch = aiFetch } = {}) {
  const store = createStore(database);
  const aiConfig = createAIConfig({ store, env, fetchImpl: aiFetch });
  const meetingAI = ai || aiConfig;
  const operations = createAgentOperations(store);
  const assistant = createAssistant({ store, operations, env, fetchImpl: assistantFetch });
  const agentHTTP = createAgentHTTP({ store, operations, assistant, readJson });
  const tableImport = createTableImport(store);
  const suppliers = createSupplierService({ store, aiConfig, fetchImpl: aiFetch, documentAI });
  const inventory = createInventoryModule(store);
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
        if (pathname.startsWith("/api/agent/") || pathname.startsWith("/api/assistant/")) {
          await agentHTTP(request, url, send);
          return;
        }
        const spaceId = url.searchParams.get("spaceId") ?? "default";
        const write = (body, callback) => store.automation.once(request.headers["idempotency-key"], { pathname, method, body }, callback);
        if (pathname === "/api/bootstrap" && method === "GET") return send(200, { ...store.bootstrap(url.searchParams.get("formId"), spaceId), ai: meetingAI.status, inventory: inventory.state() });
        if (pathname === "/api/warehouse" && method === "GET") return send(200, store.warehouse.state(spaceId));
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
        const spaceMatch = pathname.match(/^\/api\/spaces\/([a-zA-Z0-9-]+)$/);
        if (spaceMatch && method === "PATCH") return send(200, store.spaces.rename(spaceMatch[1], (await readJson(request)).name));
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
        if (pathname === "/api/automations" && method === "GET") return send(200, store.automation.list(spaceId, url.searchParams.get("formId")));
        if (pathname === "/api/automations" && method === "POST") {
          const body = await readJson(request); return send(201, write(body, () => store.automation.save(body)));
        }
        const automationMatch = pathname.match(/^\/api\/automations\/([a-zA-Z0-9-]+)$/);
        if (automationMatch && method === "PUT") { const body = await readJson(request); return send(200, store.automation.save(body, automationMatch[1])); }
        if (automationMatch && method === "DELETE") return send(200, store.automation.remove(automationMatch[1], (await readJson(request)).version));
        if (pathname === "/api/automation-runs" && method === "GET") return send(200, store.automation.runs(spaceId, url.searchParams.get("formId")));
        const receiptMatch = pathname.match(/^\/api\/stock-receipts\/([a-zA-Z0-9-]+)(\/reverse-preview|\/reverse)?$/);
        if (receiptMatch) {
          const receipt = store.receipts.get(receiptMatch[1]);
          if (!receiptMatch[2] && method === "GET") return send(200, receipt);
          if (method === "POST") {
            const body = await readJson(request);
            if (receiptMatch[2] === "/reverse-preview") {
              const fingerprint = store.automation.fingerprint(receipt.spaceId);
              return send(200, store.preview(() => ({ ...store.receipts.reverse(receipt.id, body.note), changes: store.automation.changes(), fingerprint })));
            }
            if (receiptMatch[2] === "/reverse") return send(200, write(body, () => store.transaction(() => {
              if (!store.receipts.get(receipt.id).reversed && body.fingerprint !== store.automation.fingerprint(receipt.spaceId)) throw new AppError(409, "Stock or related data changed. Preview the receipt reversal again.");
              return store.receipts.reverse(receipt.id, body.note);
            })));
          }
        }
        if (pathname === "/api/automations/preview" && method === "POST") {
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
        if (pathname === "/api/inventory" && method === "GET") return send(200, inventory.state());
        if (pathname === "/api/inventory/tables" && method === "POST") return send(200, inventory.ensureTables());
        if (pathname === "/api/inventory/mappings" && method === "PUT") return send(200, inventory.saveMapping(await readJson(request)));
        if (pathname === "/api/inventory/preview" && method === "POST") return send(200, inventory.preview(await readJson(request)));
        if (pathname === "/api/inventory/post" && method === "POST") return send(200, inventory.post(await readJson(request)));
        if (pathname === "/api/imports/parse" && method === "POST") return send(200, await parseTableFile((await readJson(request, 8 * 1024 * 1024)).file));
        if (pathname === "/api/imports/preview" && method === "POST") return send(200, tableImport.preview(await readJson(request, 8 * 1024 * 1024)));
        const importMatch = pathname.match(/^\/api\/imports\/([a-zA-Z0-9-]+)\/commit$/);
        if (importMatch && method === "POST") return send(200, tableImport.commit(importMatch[1]));
        if (pathname === "/api/suppliers/tables" && method === "POST") return send(200, suppliers.ensureTables());
        if (pathname === "/api/suppliers/extract" && method === "POST") return send(200, await suppliers.extract(await readJson(request, 18 * 1024 * 1024)));
        if (pathname === "/api/suppliers/drafts" && method === "GET") return send(200, suppliers.listDocuments());
        const draftMatch = pathname.match(/^\/api\/suppliers\/drafts\/([a-zA-Z0-9-]+)$/);
        if (draftMatch && method === "GET") return send(200, suppliers.getDocumentDraft(draftMatch[1]));
        const documentMatch = pathname.match(/^\/api\/suppliers\/drafts\/([a-zA-Z0-9-]+)\/commit$/);
        if (documentMatch && method === "POST") return send(200, suppliers.commitDocument(documentMatch[1], await readJson(request, 2 * 1024 * 1024)));
        const fileMatch = pathname.match(/^\/api\/suppliers\/files\/([a-zA-Z0-9-]+)$/);
        if (fileMatch && method === "GET") {
          const file = store.workflows.file(fileMatch[1]);
          response.writeHead(200, { "Content-Type": file.mime, "Content-Disposition": `attachment; filename="document.${file.mime === "application/pdf" ? "pdf" : file.mime === "image/png" ? "png" : "jpg"}"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()]/g, (char) => `%${char.charCodeAt(0).toString(16)}`)}`, "Cache-Control": "no-store" });
          return response.end(Buffer.from(file.bytes));
        }
        if (pathname === "/api/reconciliations" && method === "GET") return send(200, suppliers.listRuns());
        if (pathname === "/api/reconciliations" && method === "POST") return send(201, suppliers.run(await readJson(request)));
        const runMatch = pathname.match(/^\/api\/reconciliations\/([a-zA-Z0-9-]+)$/);
        if (runMatch && method === "GET") return send(200, suppliers.getRun(runMatch[1]));
        if (runMatch && method === "PATCH") return send(200, suppliers.updateResult(runMatch[1], await readJson(request)));
        if (pathname === "/api/meetings/table" && method === "POST") return send(200, store.ensureMeetingTable());
        if (pathname === "/api/meetings/extract" && method === "POST") {
          const body = await readJson(request);
          const meeting = validateMeeting(body);
          const form = store.getForm(body.formId);
          if (form.moduleId !== "meetings") throw new AppError(400, "Choose a table in Meeting Follow-up.");
          const targets = new Set(form.fields.filter((field) => field.type === "reference").map((field) => field.reference.formId));
          const references = store.referenceCatalog().filter((table) => targets.has(table.id)).map((table) => {
            const keys = new Set(form.fields.filter((field) => field.type === "reference" && field.reference.formId === table.id).map((field) => field.reference.fieldId));
            return { ...table, fields: table.fields.filter((field) => keys.has(field.id)),
              records: table.records.map((record) => ({ id: record.id, values: Object.fromEntries(Object.entries(record.values).filter(([id]) => keys.has(id))) })) };
          });
          if (references.reduce((count, table) => count + table.records.length, 0) > 500) throw new AppError(400, "This prototype supports up to 500 reference candidates per extraction. Narrow the reference table first.");
          const result = await meetingAI.extract({ meeting, form, references });
          return send(200, store.saveExtraction(form, meeting, validateExtraction(result, form, meeting, references)));
        }
        const meetingMatch = pathname.match(/^\/api\/meetings\/([a-zA-Z0-9-]+)(\/commit)?$/);
        if (meetingMatch) {
          if (method === "GET" && !meetingMatch[2]) return send(200, store.getExtraction(meetingMatch[1]));
          if (method === "POST" && meetingMatch[2]) return send(200, store.commitExtraction(meetingMatch[1], await readJson(request)));
        }
        if (pathname === "/api/forms") {
          if (method === "GET") return send(200, store.listForms(spaceId));
          if (method === "POST") { const body = await readJson(request); return send(201, write(body, () => store.createForm(body))); }
        }
        const formMatch = pathname.match(/^\/api\/forms\/([a-zA-Z0-9-]+)(?:\/(records|changes))?$/);
        if (formMatch) {
          const [, id, resource] = formMatch;
          if (!resource && method === "GET") return send(200, store.getForm(id));
          if (!resource && method === "PUT") { const body = await readJson(request); return send(200, write(body, () => store.updateForm(id, body))); }
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
