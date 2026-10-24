# Architecture

## Runtime

```text
Browser: generic forms / orders / warehouse / assistant
    |
src/server.js: local routes, security checks, explicit asset allowlist
    |-- auth.js: local accounts, password/session verification and role context
    |-- agent-http.js / agent-operations.js: scoped Agent operations
    |-- order-system.js / order-ai.js: shared order forms, fixed workflows and pending-review extraction
    |-- whatsapp-bridge.js: optional administrator-selected, read-only WhatsApp intake
    |-- warehouse-system.js: fixed workflows and stock movements
    |-- warehouse-import.js: scoped spreadsheets, matching and atomic workflow batches
    |-- warehouse-dashboard.js: read-only ledger snapshots, unit-safe trends and alerts
    |-- form-deletion.js: impact, dependencies and confirmation
    |-- table-import.js / import-drafts.js: spreadsheet imports
    |-- ai-tasks.js: structured processing queue and reviewed writeback
    `-- store.js: shared validation, references, versions, history and SQLite
```

Warehouse totals, line states, balances and transitions live in one module, called by
both UI routes and Agent tools. Store hooks enforce protected balances, statuses,
core-field definitions and history. Members use single-use document workflow
permits; administrators maintain catalogs, records/custom fields within the same business
constraints. Product IDs are independent of warehouse
stock IDs; first inbound posting creates a stock row. See [warehouse.md](warehouse.md).

The fixed warehouse workflow does not invoke the archived configurable cross-form
engine. It reuses shared CRUD, transactions, references, change history and notification
infrastructure. Customizable cross-form actions are not part of the active write path.

## Authentication and Roles

`auth.js` creates the first administrator only when no accounts exist. There is no
default password; passwords need at least 12 characters and use salted scrypt hashes.
Browser business API requests require a seven-day HttpOnly, SameSite=Strict session cookie;
session tokens are hashed in SQLite. Role, password and active-status changes invalidate
the user's sessions. Administrators manage accounts, and the last active administrator
cannot be disabled or demoted. Users can change their own password or sign out.
After initial setup, public local self-registration creates only active Member
accounts and issues a session. Registration cannot select roles or alter existing
accounts, and is limited to ten attempts per client in fifteen minutes.

Administrators manage forms, generic records, navigation, provider/task/rule settings
and users, product/warehouse catalogs and stock settings. Members read shared data and
inventory analysis and use warehouse request operations, notifications,
configured AI task runs and their assistant/tokens. A request's applicant and workflow
actor come from the authenticated account; approval/rejection requires the assigned
active approver. Roles do not bypass protected warehouse state or stock checks.

External Agent Bearer tokens belong to an account and Space. Each request reloads the
active owner and executes in that owner's role context. Approval rechecks the proposal
owner's current permissions instead of borrowing the confirming administrator's role.
Review/full access controls confirmation, not authorization. Ownerless legacy tokens
cannot authenticate after account setup. Conversations and proposals are owner-bound;
members access their own, while administrators can manage them across users.

The dashboard reads the full movement ledger through one computation shared by the
browser and `get_inventory_dashboard` Agent operation. It does not persist derived
statistics or grant editing access. Month snapshots use posting dates and signed
reversals; current alerts use live stock records, and quantities stay unit-filtered.
See [dashboard calculations](inventory-dashboard.md).

## Forms and Deletion

Fields and records have stable IDs. Shared store methods validate required/unique
constraints, restricted numeric formulas and references. Navigation is separate from
business bindings; moving a folder or form does not change identity.

Deletion uses one shared interface for dependency inspection and transactional removal.
Preview returns schema version, record count, blockers and a Space fingerprint.
Confirmation rechecks these. Warehouse core forms and reference/task dependencies
cannot be bypassed through Agent tools. Whole-form Agent deletion always requires
human confirmation, even in full access.

Deletion removes navigation, unique indexes and owned notifications, then sets
`forms.deleted_at`. Records and activity remain local history, inaccessible through
active form/record routes. `form_deletions` retains an audit entry. Empty Spaces are
valid and do not regenerate templates. See [form-deletion.md](form-deletion.md).

## Processing

`automation.js` retains notifications, expressions, queries, transaction effects,
fingerprints, idempotency and Error Center, not configurable cross-form actions.
`expressions.js` evaluates restricted formulas through jsep and Decimal.js.
AI inference runs outside transactions; typed outputs go through the same store.
Uploads are Space-scoped.

The assistant uses server-owned conversation history and allowlisted operations.
Previews run real validation in rollback savepoints. Confirmation rechecks dependencies
and atomically commits business changes plus action status. Agent tokens cannot approve
their own proposals or access local settings.

Preview rollback restores the in-memory effect context as well as SQLite data, so
Agent full-access batches do not double-count simulated changes. Spreadsheet parsing
runs outside transactions in the existing bounded worker. Files and completed import
plans are stored separately; matching is read-only and execution calls the same
document transitions as the UI. A failure rolls back every request in the batch.

## Retired Modules

Old order, supplier and recipe/purchase logic, and the old meeting prototype, are not loaded by the active
server. Source is isolated under `future/cross-form-automation/`; historical docs/tests
are under `future/legacy-modules/`. Maintenance backs up SQLite before retiring registered
templates, preserving custom forms, current warehouse data and secrets. Historical
business rows are not physically purged. Saved cross-form rules remain dormant and
`/api/automations` is retired (410); no runtime flag re-enables the archived engine.

## Meeting Tasks

The new meeting workflow is implemented separately in `meeting-tasks.js` and
`meeting-ai.js`. Server initialization idempotently creates a `meeting-tasks`
Space and a protected Tasks form. AI calls use the workspace provider, run outside
SQLite transactions, and validate exact source quotes and typed task values.
Authorization and schema version are rechecked before atomic record/history writes.
Content hashes and in-flight request keys prevent repeated imports from creating
duplicate tasks. The retired `/api/meetings` routes remain unavailable.

## Orders

`order-system.js` owns independent orders, fulfillment transitions, payment/invoice
entries, attachments and local message history. Product requests are notes, and the
total amount is explicit. The service does not call warehouse operations or read the
inventory catalog. Members access their own orders; administrators access all orders.
UI and Agent operations share this contract, with version checks for existing-order
writes.

`order-system.js` owns three real shared forms and their lifecycle hooks, rather
than a separate order record store. Ownership scopes generic queries, reference
catalogs, activity and diagnostics. Member workflow permits and administrator
generic edits share business validation. Startup migrates legacy orders
transactionally without inferring receipt from old payment entries.

`order-ai.js` classifies source-evidenced drafts with the workspace provider
outside transactions. Import saves unreviewed orders with null amounts and
one linked unchecked payment confirmation. A person manually enters the amount,
reviews the order and separately confirms full receipt. Invoice registration
is manual. See [orders.md](orders.md).

The optional `whatsapp-bridge.js` starts a private, loopback-only helper on an
explicit administrator request. It uses a verified external checkout, exact
chat/message IDs, bounded reads and owner-scoped import plans. It never starts
a WhatsApp browser on app initialization or exposes sending. Agent preview
and approval call the same import workflow. See [whatsapp-bridge.md](whatsapp-bridge.md).

## Deployment

The server binds to loopback on 5174. Browser APIs require sessions and external Agent
APIs require owner-bound tokens; local Host/origin and connection checks remain.
Accounts share one local workspace rather than isolated tenants. Keys and business
content are unencrypted at rest. Public deployment still needs tenant ownership,
TLS, a trusted proxy/Host policy, deployment-wide rate limits and production secret
storage. Orbyte, Replit and RunPod integration are not implemented.
