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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATIC = new Map([
  ["/", ["public/index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["public/app.js", "text/javascript; charset=utf-8"]],
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

export function createApp({ database = resolve(ROOT, "data/forms.sqlite"), ai, documentAI, env = process.env, aiFetch = fetch, assistantFetch = aiFetch } = {}) {
  const store = createStore(database);
  const aiConfig = createAIConfig({ store, env, fetchImpl: aiFetch });
  const meetingAI = ai || aiConfig;
  const operations = createAgentOperations(store);
  const assistant = createAssistant({ store, operations, env, fetchImpl: assistantFetch });
  const agentHTTP = createAgentHTTP({ store, operations, assistant, readJson });
  const tableImport = createTableImport(store);
  const suppliers = createSupplierService({ store, aiConfig, fetchImpl: aiFetch, documentAI });
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
        if (pathname === "/api/bootstrap" && method === "GET") return send(200, { ...store.bootstrap(url.searchParams.get("formId")), ai: meetingAI.status });
        if (pathname === "/api/ai/config" && method === "GET") return send(200, aiConfig.publicConfig());
        if (pathname === "/api/ai/config" && method === "PUT") return send(200, await aiConfig.save(await readJson(request)));
        if (pathname === "/api/ai/models" && method === "POST") return send(200, await aiConfig.models(await readJson(request)));
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
          if (method === "GET") return send(200, store.listForms());
          if (method === "POST") return send(201, store.createForm(await readJson(request)));
        }
        const formMatch = pathname.match(/^\/api\/forms\/([a-zA-Z0-9-]+)(?:\/(records|changes))?$/);
        if (formMatch) {
          const [, id, resource] = formMatch;
          if (!resource && method === "GET") return send(200, store.getForm(id));
          if (!resource && method === "PUT") return send(200, store.updateForm(id, await readJson(request)));
          if (resource === "records" && method === "GET") return send(200, store.listRecords(id));
          if (resource === "records" && method === "POST") return send(201, store.createRecord(id, await readJson(request)));
          if (resource === "changes" && method === "GET") return send(200, store.listChanges(id));
        }
        const recordMatch = pathname.match(/^\/api\/records\/([a-zA-Z0-9-]+)$/);
        if (recordMatch) {
          const id = recordMatch[1];
          if (method === "GET") return send(200, store.getRecord(id));
          if (method === "PATCH") return send(200, store.updateRecord(id, await readJson(request)));
          if (method === "DELETE") return send(200, store.deleteRecord(id, await readJson(request)));
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
