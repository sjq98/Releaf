import { AppError } from "./errors.js";
import { AGENT_OPENAPI } from "./agent-openapi.js";

function confirmFull(body) {
  if (body.mode === "full" && body.confirmFullAccess !== true) throw new AppError(400, "Explicitly confirm full access before enabling it.");
}

export function createAgentHTTP({ store, operations, assistant, readJson }) {
  const repo = store.agent;
  return async function handle(request, url, send) {
    const path = url.pathname;
    const method = request.method;
    if (path.startsWith("/api/agent/")) {
      const token = operations.authenticate(request.headers.authorization);
      const handle = async () => {
        const actor = { ...token, type: "token", userId: token.userId };
        if (path === "/api/agent/files" && method === "POST") return send(201, await operations.run("upload_inventory_file", await readJson(request, 8 * 1024 * 1024), actor));
        const write = (operation, args) => {
          const result = operations.run(operation, args, actor, request.headers["idempotency-key"]);
          return send(result.status === "pending" ? 202 : 200, result);
        };
        if (path === "/api/agent/tools" && method === "GET") return send(200, { tools: operations.tools() });
        if (path === "/api/agent/openapi.json" && method === "GET") return send(200, AGENT_OPENAPI);
        if (path === "/api/agent/operations" && method === "POST") {
          const body = await readJson(request, 24 * 1024 * 1024);
          const result = await operations.run(body.operation, body.args ?? {}, actor, request.headers["idempotency-key"]);
          return send(result?.status === "pending" ? 202 : 200, result);
        }
        if (path === "/api/agent/forms") {
          if (method === "GET") return send(200, operations.run("list_forms", url.searchParams.has("spaceId") ? { spaceId: url.searchParams.get("spaceId") } : {}, actor));
          if (method === "POST") return write("create_form", await readJson(request));
        }
        const form = path.match(/^\/api\/agent\/forms\/([a-zA-Z0-9-]+)(?:\/(records|query))?$/);
        if (form) {
          const [, formId, resource] = form;
          if (!resource && method === "GET") return send(200, operations.run("get_form", { formId }, actor));
          if (!resource && method === "PUT") return write("update_form", { ...await readJson(request), formId });
          if (!resource && method === "DELETE") return write("delete_form", { ...await readJson(request), formId });
          if (resource === "query" && method === "POST") return send(200, operations.run("query_records", { ...await readJson(request), formId }, actor));
          if (resource === "records" && method === "POST") return write("create_record", { ...await readJson(request), formId });
          if (resource === "records" && method === "GET") {
            const args = { formId };
            for (const key of url.searchParams.keys()) {
              if (!["q", "limit", "offset", "filters", "sort", "condition"].includes(key)) throw new AppError(400, "Unknown query parameter.");
              const value = url.searchParams.get(key);
              try { args[key] = ["filters", "sort", "condition"].includes(key) ? JSON.parse(value) : ["limit", "offset"].includes(key) ? Number(value) : value; }
              catch { throw new AppError(400, "Filters and sort must be valid JSON."); }
            }
            return send(200, operations.run("query_records", args, actor));
          }
        }
        const record = path.match(/^\/api\/agent\/records\/([a-zA-Z0-9-]+)$/);
        if (record) {
          const recordId = record[1];
          if (method === "GET") return send(200, operations.run("get_record", { recordId }, actor));
          if (method === "PATCH") return write("update_record", { ...await readJson(request), recordId });
          if (method === "DELETE") return write("delete_record", { ...await readJson(request), recordId });
        }
        const action = path.match(/^\/api\/agent\/actions\/([a-zA-Z0-9-]+)$/);
        if (method === "GET" && action) {
          const value = repo.getAction(action[1]);
          if (value.actorId !== token.id) throw new AppError(404, "Action not found.");
          return send(200, value);
        }
        throw new AppError(404, "Agent endpoint not found.");
      };
      return token.owner && store.auth?.withUser ? store.auth.withUser(token.owner, handle) : handle();
    }
    if (!path.startsWith("/api/assistant/")) return false;
    const user = store.auth?.currentUser?.() ?? null;
    const admin = user?.role === "admin";
    const requireAdmin = () => store.auth?.requireAdmin?.();
    if (path === "/api/assistant/state" && method === "GET") return send(200, {
      mode: operations.getMode(), config: admin ? assistant.config.publicConfig() : assistant.config.status,
      actions: repo.actionFeed(undefined, admin ? undefined : user?.id),
    });
    if (path === "/api/assistant/config") {
      if (method === "GET") { requireAdmin(); return send(200, assistant.config.publicConfig()); }
      if (method === "PUT") { requireAdmin(); return send(200, await assistant.config.save(await readJson(request))); }
    }
    if (path === "/api/assistant/models" && method === "POST") { requireAdmin(); return send(200, await assistant.config.models(await readJson(request))); }
    if (path === "/api/assistant/mode" && method === "PUT") {
      const body = await readJson(request);
      confirmFull(body);
      return send(200, operations.setMode(body.mode));
    }
    if (path === "/api/assistant/tokens") {
      if (method === "GET") return send(200, repo.listTokens(admin || !user ? {} : { userId: user.id }));
      if (method === "POST") {
        const body = await readJson(request);
        confirmFull(body);
        return send(201, operations.createToken(body));
      }
    }
    const token = path.match(/^\/api\/assistant\/tokens\/([a-zA-Z0-9-]+)$/);
    if (token && method === "DELETE") return send(200, operations.revokeToken(token[1]));
    if (token && method === "PATCH") {
      const body = await readJson(request);
      confirmFull(body);
      return send(200, operations.updateToken(token[1], body.mode));
    }
    if (path === "/api/assistant/sessions" && method === "POST") return send(201, repo.createSession(user?.id ?? null));
    const session = path.match(/^\/api\/assistant\/sessions\/([a-zA-Z0-9-]+)(\/messages)?$/);
    if (session) {
      if (method === "GET" && !session[2]) return send(200, assistant.sessionView(session[1]));
      if (method === "POST" && session[2]) { const body = await readJson(request); return send(200, await assistant.chat(session[1], body.text, body)); }
    }
    const decision = path.match(/^\/api\/assistant\/actions\/([a-zA-Z0-9-]+)\/(approve|reject)$/);
    if (decision && method === "POST") {
      await readJson(request);
      return send(200, decision[2] === "approve" ? operations.approve(decision[1]) : operations.reject(decision[1]));
    }
    throw new AppError(404, "Assistant endpoint not found.");
  };
}
