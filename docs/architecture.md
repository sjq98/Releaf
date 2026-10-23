# Architecture

## Runtime

```text
Browser: generic forms / warehouse / assistant
    |
src/server.js: local routes, security checks, explicit asset allowlist
    |-- auth.js: local accounts, password/session verification and role context
    |-- agent-http.js / agent-operations.js: scoped Agent operations
    |-- warehouse-system.js: fixed workflows and stock movements
    |-- warehouse-import.js: scoped spreadsheets, matching and atomic workflow batches
    |-- form-deletion.js: impact, dependencies and confirmation
    |-- table-import.js / import-drafts.js: spreadsheet imports
    |-- ai-tasks.js: structured processing queue and reviewed writeback
    `-- store.js: shared validation, references, versions, history and SQLite
```

Warehouse totals, line states, balances and transitions live in one module, called by
both UI routes and Agent tools. Store hooks enforce protected balances, statuses,
core-field definitions and history. Members use single-use catalog/document service
permits; administrators can maintain records/custom fields within the same business
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

Administrators manage forms, generic records, navigation, provider/task/rule settings
and users. Members read shared data and use warehouse/catalog operations, notifications,
configured AI task runs and their assistant/tokens. A request's applicant and workflow
actor come from the authenticated account; approval/rejection requires the assigned
active approver. Roles do not bypass protected warehouse state or stock checks.

External Agent Bearer tokens belong to an account and Space. Each request reloads the
active owner and executes in that owner's role context. Approval rechecks the proposal
owner's current permissions instead of borrowing the confirming administrator's role.
Review/full access controls confirmation, not authorization. Ownerless legacy tokens
cannot authenticate after account setup. Conversations and proposals are owner-bound;
members access their own, while administrators can manage them across users.

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

Old order, meeting, supplier and recipe/purchase logic is not loaded by the active
server. Source is isolated under `future/cross-form-automation/`; historical docs/tests
are under `future/legacy-modules/`. Maintenance backs up SQLite before retiring registered
templates, preserving custom forms, current warehouse data and secrets. Historical
business rows are not physically purged. Saved cross-form rules remain dormant and
`/api/automations` is retired (410); no runtime flag re-enables the archived engine.

## Deployment

The server binds to loopback on 5174. Browser APIs require sessions and external Agent
APIs require owner-bound tokens; local Host/origin and connection checks remain.
Accounts share one local workspace rather than isolated tenants. Keys and business
content are unencrypted at rest. Public deployment still needs tenant ownership,
TLS, a trusted proxy/Host policy, deployment-wide rate limits and production secret
storage. Orbyte, Replit and RunPod integration are not implemented.
