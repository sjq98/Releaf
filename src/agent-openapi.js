import { AGENT_TOOLS } from "./agent-operations.js";

const json = (schema) => ({ "application/json": { schema } });
const action = { $ref: "#/components/schemas/Action" };
const error = { description: "Validation, authentication, version conflict or server error.",
  content: json({ type: "object", properties: { error: { type: "string" }, fields: { type: "object" } } }) };
const pathParameter = (name) => ({ name, in: "path", required: true, schema: { type: "string" } });
const schemas = Object.fromEntries(AGENT_TOOLS.map((tool) => [tool.function.name, tool.function.parameters]));
function operation(name, { id, write = false, description, query = false } = {}) {
  const source = structuredClone(schemas[name]);
  if (id) { delete source.properties[id]; source.required = source.required.filter((key) => key !== id); }
  const parameters = id ? [pathParameter(id)] : [];
  if (write) parameters.push({ name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", minLength: 1, maxLength: 200 } });
  if (query) {
    for (const [key, schema] of Object.entries(source.properties)) parameters.push({ name: key, in: "query",
      ...(schema.type === "array" || schema.type === "object" ? { content: json(schema) } : { schema }) });
  }
  return {
    operationId: name + (query ? "_get" : ""), summary: description || AGENT_TOOLS.find((tool) => tool.function.name === name).function.description,
    parameters,
    ...(!query && Object.keys(source.properties).length ? { requestBody: { required: true, content: json(source) } } : {}),
    responses: {
      200: { description: write ? "Applied action, or existing action for an idempotent retry. Inspect status." : "Result", content: json(write ? action : {}) },
      ...(write ? { 202: { description: "Preview only; awaits local human approval. Nothing has been saved.", content: json(action) } } : {}),
      default: error,
    },
  };
}
export const AGENT_OPENAPI = {
  openapi: "3.1.0",
  info: { title: "Releaf Agent API", version: "1.0.0", description: "Local prototype. Agent tokens cannot approve changes, change permissions or configure providers. Full access is granted only by a local workspace administrator." },
  servers: [{ url: "/" }],
  security: [{ AgentToken: [] }],
  paths: {
    "/api/agent/forms": { get: operation("list_forms"), post: operation("create_form", { write: true }) },
    "/api/agent/forms/{formId}": { get: operation("get_form", { id: "formId" }), put: operation("update_form", { id: "formId", write: true }) },
    "/api/agent/forms/{formId}/records": { get: operation("query_records", { id: "formId", query: true }), post: operation("create_record", { id: "formId", write: true }) },
    "/api/agent/forms/{formId}/query": { post: operation("query_records", { id: "formId" }) },
    "/api/agent/records/{recordId}": { get: operation("get_record", { id: "recordId" }),
      patch: operation("update_record", { id: "recordId", write: true }), delete: operation("delete_record", { id: "recordId", write: true }) },
    "/api/agent/actions/{actionId}": { get: { operationId: "get_action", summary: "Get an action created by this token.",
      parameters: [pathParameter("actionId")], responses: { 200: { description: "Action status", content: json(action) }, default: error } } },
    "/api/agent/tools": { get: { operationId: "get_tools", summary: "Discover compatible function-call schemas.",
      responses: { 200: { description: "Tools", content: json({ type: "object" }) }, default: error } } },
  },
  components: {
    securitySchemes: { AgentToken: { type: "http", scheme: "bearer", bearerFormat: "rlf_..." } },
    schemas: { Action: { type: "object", required: ["id", "operation", "status", "preview"],
      properties: { id: { type: "string" }, operation: { type: "string" }, status: { type: "string", enum: ["pending", "applied", "rejected", "failed"] },
        preview: { type: "object" }, result: {}, error: { type: ["string", "null"] } } } },
  },
};
