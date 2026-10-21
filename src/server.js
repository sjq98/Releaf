import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { AppError, createStore } from "./store.js";
import { validateMeeting, validateExtraction } from "./meeting-ai.js";
import { createAIConfig } from "./ai-config.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATIC = new Map([
  ["/", ["public/index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["public/app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["public/styles.css", "text/css; charset=utf-8"]],
  ["/field-types.js", ["src/field-types.js", "text/javascript; charset=utf-8"]],
  ["/errors.js", ["src/errors.js", "text/javascript; charset=utf-8"]],
  ["/field-ui.js", ["public/field-ui.js", "text/javascript; charset=utf-8"]],
  ["/ai-settings.js", ["public/ai-settings.js", "text/javascript; charset=utf-8"]],
  ["/vendor/lucide.js", ["node_modules/lucide/dist/umd/lucide.min.js", "text/javascript; charset=utf-8"]],
]);

async function readJson(request) {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    throw new AppError(415, "Content-Type must be application/json.");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 256 * 1024) throw new AppError(413, "Request is too large.");
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

export function createApp({ database = resolve(ROOT, "data/forms.sqlite"), ai, env = process.env, aiFetch = fetch } = {}) {
  const store = createStore(database);
  const aiConfig = createAIConfig({ store, env, fetchImpl: aiFetch });
  const meetingAI = ai || aiConfig;
  const server = createServer(async (request, response) => {
    const send = (status, value) => {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify(value));
    };
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "same-origin");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      const url = new URL(request.url, "http://localhost");
      const { pathname } = url;
      const method = request.method;
      if (pathname.startsWith("/api/")) {
        // External integrations need an explicit authentication policy.
        const origin = request.headers.origin;
        if (origin && origin !== `http://${request.headers.host}`) throw new AppError(403, "Cross-origin requests are not allowed.");
        if (pathname === "/api/bootstrap" && method === "GET") return send(200, { ...store.bootstrap(url.searchParams.get("formId")), ai: meetingAI.status });
        if (pathname === "/api/ai/config" && method === "GET") return send(200, aiConfig.publicConfig());
        if (pathname === "/api/ai/config" && method === "PUT") return send(200, await aiConfig.save(await readJson(request)));
        if (pathname === "/api/ai/models" && method === "POST") return send(200, await aiConfig.models(await readJson(request)));
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
  const port = Number(process.env.PORT || 5173);
  const database = process.env.ORDER_DB ? resolve(process.env.ORDER_DB) : undefined;
  const { server, store } = createApp({ database });
  server.on("error", (error) => {
    console.error(error.code === "EADDRINUSE" ? `Port ${port} is in use. Set a different PORT.` : error.message);
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
