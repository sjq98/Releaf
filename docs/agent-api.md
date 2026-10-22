# Assistant and Agent API

## Floating Assistant

Open **Assistant** at the bottom right of any workspace page. Its provider settings are independent of Meeting Follow-up: open **Assistant provider**, enter the provider name, API base URL and key, fetch models, select one, and save. The provider must support OpenAI-compatible `GET /models` and Chat Completions function/tool calling. Model discovery alone does not prove tool support.

The assistant can discover every custom table, read schemas, search/filter records, create/update/delete records, create tables, and edit table fields. It cannot delete whole tables, approve its own changes, change permissions, manage tokens, execute SQL, or run arbitrary code.

**Review first** is the default. A write creates a validated preview in **Approvals** without saving business data. Choose **Approve** or **Reject**. The main table refreshes after approval. For a multi-step task, approve the current step, return to Chat, and ask the assistant to continue. It reads the updated action status on the next turn.

**Full access** requires an explicit confirmation and applies future writes immediately. It does not retroactively approve pending previews. Field rules, references, version checks, idempotency, record history, and the agent action log still apply. Switching back to Review first affects subsequent writes.

Previews expire after 24 hours. Confirmation rechecks schema and record versions; schema edits also verify that the table's records have not changed since preview. A stale or invalid approval fails without partially applying. Ask for a new preview. Removing a field hides it from the active schema; the existing store retains historical values.

Conversations and action logs persist in local SQLite. The current browser remembers only its conversation ID in local storage. **New conversation** starts a fresh conversation; existing pending approvals remain in the workspace.

## Separate Agent Tokens

Open **Agent access tokens** in the assistant header. Create a named token with **Review first** or **Full access**. The complete `rlf_...` token is shown only once; copy it into the external agent's secret configuration, not its prompt or source code.

Tokens are stored as SHA-256 hashes. The UI can change a token's mode or revoke it. Revocation takes effect on the next request and rejects its pending proposals. At most 20 active tokens are permitted. Chat access mode and each token's mode are independent.

The provider API key authenticates Releaf to the model provider. The Agent token authenticates an external integration to Releaf. They are not interchangeable.

## External Interface

Base URL while local: `http://127.0.0.1:5173` (or the configured port).

Every `/api/agent/` endpoint requires:

```http
Authorization: Bearer rlf_YOUR_TOKEN
```

Writes additionally require `Content-Type: application/json` and a unique `Idempotency-Key` header of 1-200 characters. Retrying the same operation/body with the same key returns its existing action, including after approval; it does not create a second record. Reusing a key for a different body returns 409. A corrected request or a fresh preview needs a new key.

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/api/agent/openapi.json` | OpenAPI 3.1 description |
| GET | `/api/agent/tools` | Function-call tool schemas |
| GET | `/api/agent/forms` | All forms, schemas and record counts |
| POST | `/api/agent/forms` | Propose/create a table: `name`, `fields`, optional `moduleId` |
| GET | `/api/agent/forms/{formId}` | Current schema and `version` |
| PUT | `/api/agent/forms/{formId}` | Propose/edit schema: `version`, `name`, complete `fields` |
| GET | `/api/agent/forms/{formId}/records` | Paginated query; parameters below |
| POST | `/api/agent/forms/{formId}/query` | Same query using a JSON body; this is read-only, no idempotency key needed |
| POST | `/api/agent/forms/{formId}/records` | Propose/create: `schemaVersion`, `values` |
| GET | `/api/agent/records/{recordId}` | Current record and `version` |
| PATCH | `/api/agent/records/{recordId}` | Propose/partially update: `schemaVersion`, `version`, `values` |
| DELETE | `/api/agent/records/{recordId}` | Propose/delete: `schemaVersion`, `version` |
| GET | `/api/agent/actions/{actionId}` | This token's action status and result |

Read the schema first; use stable field IDs in `values` and filters. Reference values must be target record IDs, not their displayed unique labels. Query the target table to resolve them. Schema edits must keep existing field IDs when renaming/reordering fields. Supported field definitions are the same as the manual editor.

### Query Example

POST `/api/agent/forms/{formId}/query`:

```json
{
  "q": "packaging",
  "filters": [
    { "fieldId": "completed", "operator": "eq", "value": "No" },
    { "fieldId": "quantity", "operator": "gte", "value": 10 }
  ],
  "sort": { "fieldId": "quantity", "direction": "desc" },
  "limit": 20,
  "offset": 0
}
```

The response contains `formId`, `schemaVersion`, `records`, `total`, `limit`, `offset`, and `hasMore`. Search and filters are combined with AND. Text comparison/search is case-insensitive. Filter values must match the field type and, for dropdown equality, an actual option. Operators: `eq`, `ne`, `contains` (text/dropdown), `gt`, `gte`, `lt`, `lte` (numbers/dates), and `is_empty` (no value needed). Sorting uses a field ID and `asc`/`desc`.

Default page size is 50, maximum 100; maximum 20 filters. GET accepts the same properties as query parameters, with JSON-encoded `filters` and `sort`. Queries currently scan local records in memory; this is not yet a large-dataset search service.

### Write Example

POST `/api/agent/forms/{formId}/records`, with `Idempotency-Key: order-create-1001`:

```json
{
  "schemaVersion": 1,
  "values": {
    "orderNumber": "ORD-1001",
    "quantity": 12,
    "completed": "No"
  }
}
```

A review-mode response uses HTTP **202** with an action:

```json
{
  "id": "ACTION_ID",
  "operation": "create_record",
  "status": "pending",
  "preview": { "title": "Create record in Orders", "diff": [] },
  "result": null
}
```

This is an abbreviated example. Actual previews include before/after differences; schema edits include affected visible values. The action is not a saved record. Poll `GET /api/agent/actions/{actionId}` until `status` is `applied`, `rejected`, or `failed`. On `applied`, record creation returns the real record ID in `result.record.id`. Full-access writes return HTTP **200**, `status: applied`. Existing idempotent requests may also return 200 with a rejected/failed action; always inspect `status`.

Errors use `{ "error": "...", "fields": {} }`. Common codes: 400 invalid arguments, 401 invalid/revoked token, 403 forbidden route/origin, 404 missing resource, 409 stale version/uniqueness/idempotency conflict, 413 oversized request, 502 upstream model failure, 503 unconfigured assistant.

## Local Administration

`/api/assistant/` endpoints back the local UI: provider config/models, chat sessions/messages, chat mode, token management, and action approval/rejection. They do not accept Agent Bearer tokens. Existing `/api/forms`, `/api/records`, meeting and provider endpoints remain the local workspace interface, not an alternate external-agent interface.

**This is not production multi-user authentication.** The server still binds to loopback, requires a local Host header, rejects cross-origin browser requests, and restricts administration to loopback connections. Any program running as the local user can act as a local administrator, including through legacy local endpoints. Tokens are an integration boundary, not isolation from other programs on this machine. Do not publish or reverse-proxy the whole server as-is.

Before deployment, add authenticated user accounts, tenant/table ownership, administrator roles, authenticated approval identity, TLS, explicit trusted proxy/Host policy, rate limits, secret encryption/storage, and retention controls. The reserved Agent API can then be exposed behind that deployment boundary. No public URL, Orbyte connection or shared team login is implemented by this change.

## Privacy and Verification

The assistant sends messages, requested table schemas and tool-query results to the configured provider. Query results can contain business information; only connect approved providers and use authorized data. Provider keys remain server-side but are stored unencrypted in the local SQLite file. Tokens are hashed; chat and action records are not encrypted.

The server stores conversation history rather than accepting client-supplied tool history. Only allowlisted operations run. Tool-call rounds, response sizes and queries are bounded. These controls reduce risk but do not guarantee an AI model will interpret every business instruction correctly. Human review remains recommended.

Tests use mock providers and isolated databases. A passing test suite does not verify a real model provider, public deployment, sponsor usage, or Orbyte integration.
