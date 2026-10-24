# Assistant and Agent API

Warehouse business operations now include atomic request creation/editing, submission, approval/rejection, cancellation, stock posting and reversal. See [the warehouse API contract](warehouse.md). Orders, payment confirmations and invoices are shared forms; query them with generic read tools and use the order tools below for controlled business writes. Administrator generic edits retain the same invariants. Custom cross-form rule tools have been removed; their archived counterparts cannot execute through this server. Same-form notification rules use `list_notification_rules`, `create_notification_rule`, `update_notification_rule`, `delete_notification_rule` and `/api/notification-rules`.

The seven warehouse tables are read-only to member accounts through generic CRUD/schema tools. Administrator-owned Agents can maintain records and custom fields, but cannot bypass protected core fields, balances, statuses or history. Use `save_inventory_catalog` for product/warehouse/stock settings, and inventory request tools for business documents. Document lines reference **product catalog record IDs**, not stock IDs. Generic custom-form and record writes also require an administrator owner.

## Floating Assistant

After signing in, open **Assistant** at the bottom right of any workspace page. Its provider settings are independent of the workspace AI-task provider: as an administrator, open **Assistant provider**, enter the provider name, API base URL and key, fetch models, select one, and save. Members can use the configured assistant but cannot change provider settings. The provider must support OpenAI-compatible `GET /models` and Chat Completions function/tool calling. Model discovery alone does not prove tool support.

The assistant can discover/query tables and use warehouse and order workflows. It can extract and save a pending order from customer text, but must not treat extraction as human review. AI-imported orders have no amount; a person enters it during review. Each order creates one linked, unchecked payment confirmation. Members manage their own orders and administrators manage all orders. Orders store product details in notes and have no menu or inventory linkage. Generic form/schema mutations remain administrator-only. It cannot approve its own proposals, change permissions, manage tokens, execute SQL or run arbitrary code. Whole-form deletion always requires local human confirmation, including full access. Core system forms and dependencies are protected. See [deletion contract](form-deletion.md) and [order workflow](orders.md).

**Review first** is the default. A write creates a validated preview in **Approvals** without saving business data. The proposal owner or an administrator can choose **Approve** or **Reject**; execution still uses the owner's current role, not the confirming administrator's privileges. The main table refreshes after approval. For a multi-step task, approve the current step, return to Chat, and ask the assistant to continue. It reads the updated action status on the next turn.

**Full access** requires an explicit confirmation and applies future permitted writes immediately. It does not grant administrator rights, bypass the assigned business approver or retroactively approve pending previews. Field rules, references, version checks, idempotency, record history, and the agent action log still apply. Chat mode is per user; switching back to Review first affects subsequent writes.

Previews expire after 24 hours. Confirmation rechecks schema and record versions; schema edits also verify that the table's records have not changed since preview. A stale or invalid approval fails without partially applying. Ask for a new preview. Removing a field hides it from the active schema; the existing store retains historical values.

Conversations and action logs persist in local SQLite and belong to their account. Members can access their own conversations and proposals; administrators can inspect them across users, but only the conversation owner can send new messages. This avoids persisting an administrator's private tool results into another user's conversation. The browser remembers a conversation ID, not its credentials. **New conversation** starts a fresh conversation; existing pending approvals remain in the workspace.

The paperclip uploads XLSX/UTF-8 CSV files (5 MB each, at most three attachments per message). Upload stores a Space-scoped source only; matching and workflow writes are separate operations. The model receives verified file IDs, not base64 file bytes. Spreadsheet content is untrusted business data, never a new instruction source.

## Separate Agent Tokens

Open **Agent access tokens** in the assistant header. Create a named token with **Review first** or **Full access**, bound to the signed-in account and selected Space. The complete `rlf_...` token is shown only once; copy it into the external agent's secret configuration, not its prompt or source code.

Tokens are stored as SHA-256 hashes. Owners can change their token's mode or revoke it; administrators can manage tokens across users. Revocation takes effect on the next request and rejects its pending proposals. At most 20 active tokens are permitted per user. Chat access mode and each token's mode are independent.

Every request checks the owner's current account status and role. Disabling the owner
blocks token authentication; changing the role changes available operations without
issuing a new token. Full access never elevates a member into an administrator. Tokens
created before account ownership was introduced cannot authenticate after first-admin
setup; create replacement tokens while signed in.

The provider API key authenticates Releaf to the model provider. The Agent token authenticates an external integration to Releaf. They are not interchangeable.

## External Interface

Base URL while local: `http://127.0.0.1:5174`.

Tokens belong to their owner and the Space selected when created. The server enforces the Space boundary on form discovery, queries, references, warehouse operations, notifications, AI tasks and error discovery. Account roles add authorization within that Space; they are not per-Space account memberships or tenant isolation.

Every `/api/agent/` endpoint requires:

```http
Authorization: Bearer rlf_YOUR_TOKEN
```

Writes additionally require `Content-Type: application/json` and a unique `Idempotency-Key` header of 1-200 characters. Retrying the same operation/body with the same key returns its existing action, including after approval; it does not create a second record. Reusing a key for a different body returns 409. A corrected request or a fresh preview needs a new key.

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/api/agent/openapi.json` | OpenAPI 3.1 description |
| GET | `/api/agent/tools` | Function-call tool schemas filtered for the owner's current role |
| POST | `/api/agent/files` | Spreadsheet upload `{file:{name,data:base64},spaceId?}`; returns id/sheet headers/samples, requires token but not a business-write idempotency key |
| POST | `/api/agent/operations` | Run a discovered tool using `{ "operation": "...", "args": {} }`; writes still require idempotency and review/full access |
| GET | `/api/agent/forms` | All forms, schemas and record counts |
| POST | `/api/agent/forms` | Propose/create a table: `name`, `fields`, optional `moduleId` |
| GET | `/api/agent/forms/{formId}` | Current schema and `version` |
| PUT | `/api/agent/forms/{formId}` | Propose/edit schema: `version`, `name`, complete `fields` |
| DELETE | `/api/agent/forms/{formId}` | Propose whole-form deletion: `version`; always awaits local confirmation |
| GET | `/api/agent/forms/{formId}/records` | Paginated query; parameters below |
| POST | `/api/agent/forms/{formId}/query` | Same query using a JSON body; this is read-only, no idempotency key needed |
| POST | `/api/agent/forms/{formId}/records` | Propose/create: `schemaVersion`, `values` |
| GET | `/api/agent/records/{recordId}` | Current record and `version` |
| PATCH | `/api/agent/records/{recordId}` | Propose/partially update: `schemaVersion`, `version`, `values` |
| DELETE | `/api/agent/records/{recordId}` | Propose/delete: `schemaVersion`, `version` |
| GET | `/api/agent/actions/{actionId}` | This token's action status and result |

Read the schema first; use stable field IDs in `values` and filters. Reference values must be target record IDs, not their displayed unique labels. Query the target table to resolve them. Schema edits must keep existing field IDs when renaming/reordering fields. Supported field definitions are the same as the manual editor.

Generic form/schema/record writes, navigation changes, notification-rule/task configuration,
AI result writeback, warehouse setup, catalog maintenance and error resolution require an administrator
owner. Members can query, use document workflows, run/retry/cancel configured AI
tasks and mark notifications read. Supplying an unavailable operation directly still
returns 403; tool filtering is not the only permission check.

Calculated number fields include `formula: { expression, bindings }`; omit their values in writes. The server recalculates them. Write previews include `preview.changes` for the complete atomic operation, including fixed warehouse document/stock changes. The configurable cross-form engine is archived and is not invoked by warehouse workflows. Approval verifies a conservative fingerprint of all form data, notification rules and AI task definitions in the Space; any change requires a fresh preview. Async AI outputs are reviewed separately once inference completes.

The tools endpoint also describes warehouse and order workflows, navigation, same-form notification rules, AI task configuration/runs and Error Center. Use the generic operations route with each published tool schema. Agents can apply an AI result using a fresh preview fingerprint, under their configured review/full access mode. They cannot approve their own Agent change proposals, edit provider keys or manage access tokens.

### Order Tools

Discover the available order operations through `GET /api/agent/tools` or the
OpenAPI document. The order tool family is:

| Tool | Behavior |
| --- | --- |
| `list_orders` | List orders within the token's Space and the owner's order permissions |
| `get_order` | Read order notes, review state, paid-in-full confirmation, invoices, history and current version |
| `parse_customer_order` | Read-only AI extraction from customer text; creates no order |
| `create_order` | Create an order and its linked unchecked payment record; imported drafts use `reviewed:false,totalAmount:null` |
| `update_order` | Edit an order using its current version |
| `transition_order` | Accept, prepare, mark ready, dispatch, complete or cancel |
| `confirm_order_payment` | Set/revoke the paid-in-full checkbox on explicit operator instruction, using the current order version |
| `record_order_invoice` | Add an invoice entry with the current order version |
| `prepare_order_notification` | Prepare a local status message for copying; does not deliver it |

Every existing-order write, including notification preparation, requires the
current order version. Every write also needs a unique `Idempotency-Key`.
Review-mode calls create a pending proposal; Full access performs the same
validated operation immediately. Agent identity is bound to the token owner.
Members may operate only on their own orders, while administrators may operate
across users. An Agent cannot use an administrator's privileges merely because
an administrator later reviews its proposal.

`parse_customer_order` accepts customer text up to 40,000 characters. It is a
read operation, so it does not require an idempotency key and never creates an
order. The caller may save its extracted details with `create_order` as an
unreviewed order with a null amount, subject to the Agent access mode.
Product requests become notes. The model contract never extracts an amount,
even when a quoted total appears in the source. An operator later supplies
`totalAmount` in MYR with at most two decimals and explicitly confirms review.
No product prices or stock data are consulted.

Order tools are scoped to the Agent token's Space. Resolving an order ID from
another Space returns an authorization error. Orders have no warehouse action
and do not change inventory. Status notifications are local text only; no
WhatsApp messages are sent. There is no partial-payment ledger or
received/outstanding balance. A customer message, image or Full access is
never evidence that payment was received. The former `record_order_payment`
tool is retired. See [orders.md](orders.md) for lifecycle and data semantics.

### WhatsApp Import Tools

The optional [local bridge](whatsapp-bridge.md) exposes administrator-only
`get_whatsapp_status`, `list_whatsapp_chats`, `preview_whatsapp_import` and
`import_whatsapp_orders`. Connect and QR linking happen explicitly in the
order screen, not inside the assistant. A token must belong to
`order-management`; chat calls also enforce that Space.

Choose one exact chat ID and a read bound (1-50 messages, 1-168 hours). Preview
classifies inbound text and returns an owner-scoped 30-minute `planId` and
`fingerprint`; it creates no orders. Import uses those exact values and a new
idempotency key. Review mode stages the complete import for approval; Full
access commits it through the same workflow. Replayed message source IDs
cannot create duplicate orders. Every saved order still needs human review
and a manually entered amount, and its paid-in-full checkbox starts unchecked.

These tools do not read all chats automatically, process media, send messages,
connect an e-wallet or register invoices. Selected source messages are sent to
the configured workspace AI provider. Only use an authorized linked account.

`get_inventory_dashboard` reads the same monthly trends, current low-stock alerts and
reconciled reports as the UI. Optional arguments are `spaceId`, `from`/`to` (inclusive
YYYY-MM, up to 24 months), `warehouseId`, `productId` and `unit`. It is read-only,
available to members, and enforces the token's Space. See [dashboard calculations](inventory-dashboard.md).

### Spreadsheet Batch Sequence

1. `upload_inventory_file` (or `/api/agent/files`) returns `id`; pass that as `fileId`.
2. `match_inventory_file` discovers header mappings and product/warehouse matches. Optional `mapping` uses zero-based column indices; null ignores a field. Report errors instead of inventing catalog records or operators.
3. `preview_inventory_import` takes `fileId`, optional `sheetIndex`, `mapping`, `kind`, header `values`, and `stage`. Stages are `draft`, `submit` (default) and explicit `post`; `post` also needs `approvalActor`, and the token owner must be the assigned active approver. The server binds applicant and workflow actor to the owner; `actor`/`approvalActor` cannot impersonate another account.
4. `execute_inventory_import` receives the same arguments plus the returned `fingerprint`, under a unique `Idempotency-Key`. Review mode returns a pending proposal; full mode applies the batch. Stock/approval validation, atomic rollback and duplicate protection apply to both.

A batch supports 1,000 source rows, 20 requests and 100 distinct product lines. The API/Agent batch interface remains available, but the workflow overview has no standalone bulk-import button; the UI imports product lines inside an inbound/outbound application. See [supported columns and grouping](warehouse.md#spreadsheet-workflows). Different completion stages do not create a second copy of a processed batch; use request transition tools to continue existing documents.

### Historical Receiving Prototype

The former `receive_stock` action and its examples are [archived](../future/cross-form-automation/README.md). Runtime receipt routes/tools have been removed. Receiving uses `create_inventory_request` and the fixed workflow in [warehouse.md](warehouse.md).

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

Queries also accept a nested `condition` tree with `AND`, `OR` and unary `NOT`; GET encodes it as JSON. A leaf uses `{ fieldId, operator, value: { kind: "literal", value: ... } }`. Legacy `filters` and `condition` are combined with AND. Numeric filter values must be numbers, not numeric strings. See the rule guide for the complete condition contract.

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

Errors use `{ "error": "...", "fields": {} }`. Common codes: 400 invalid arguments, 401 invalid/revoked token or inactive owner, 403 insufficient role/assigned-approver permission or forbidden route/origin, 404 missing resource, 409 stale version/uniqueness/idempotency conflict, 413 oversized request, 502 upstream model failure, 503 unconfigured assistant.

## Local Administration

`/api/assistant/` endpoints back the signed-in local UI: provider config/models, chat sessions/messages, chat mode, token management, and action approval/rejection. They require a session cookie and do not accept Agent Bearer tokens. Provider settings require an administrator; other operations check account ownership/role. `/api/forms`, `/api/records`, `/api/warehouse` and provider endpoints remain the authenticated local workspace interface, not an alternate external-agent interface. Legacy meeting, supplier and recipe/purchase routes and `/api/automations` are retired (410).

First-run `POST /api/auth/setup` creates the first administrator, with no default
password and a minimum of 12 characters. `POST /api/auth/login` issues a seven-day
HttpOnly, SameSite=Strict session; `POST /api/auth/logout` ends it.
`GET /api/auth/status` reports setup/sign-in state. Signed-in users can change their
own password with `POST /api/auth/password` and read active approvers through
`GET /api/auth/assignees`. Administrators use `GET/POST /api/auth/users` and
`PATCH /api/auth/users/:id` for account creation, roles, disabling and password resets.
API role values are `admin` (Administrator) and `user` (Member).
Password/role/active-status changes invalidate existing sessions. The last active
administrator cannot be disabled or demoted.

**This remains a local prototype, not a public deployment.** The server binds to
loopback, requires a local Host header, rejects cross-origin browser requests, and
restricts browser administration to loopback connections. Accounts share the workspace;
they are not tenant boundaries. Local programs no longer bypass login merely by using
a local endpoint, but processes with access to the database remain outside this
application-level isolation. Do not publish or reverse-proxy the server as-is.

Before deployment, add tenant/table ownership, TLS, an explicit trusted proxy/Host
policy, deployment-wide rate limits, secret encryption/storage and retention controls.
The reserved Agent API can then be exposed behind that boundary. No public URL or
Orbyte connection is implemented.

## Privacy and Verification

The assistant sends messages, requested table schemas and tool-query results to the configured provider. Query results can contain business information; only connect approved providers and use authorized data. Provider keys remain server-side but are stored unencrypted in the local SQLite file. Passwords use salted scrypt hashes; session and Agent tokens are hashed. Chat and action records are not encrypted.

The server stores conversation history rather than accepting client-supplied tool history. Only allowlisted operations run. Tool-call rounds, response sizes and queries are bounded. These controls reduce risk but do not guarantee an AI model will interpret every business instruction correctly. Human review remains recommended.

Tests use mock providers and isolated databases. A passing test suite does not verify a real model provider, public deployment, sponsor usage, or Orbyte integration.
