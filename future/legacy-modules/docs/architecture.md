# Historical Architecture (Retired Modules)

Current warehouse boundaries: [warehouse.md](warehouse.md). The fixed `src/warehouse-system.js` service is called by local routes and Agent operations; store hooks protect CRUD, imports and AI writes. The active `src/automation.js` retains transaction/preview/query/error/notification infrastructure only. Configurable cross-form execution is archived in `future/cross-form-automation/`.

## Current System

```text
Browser (public/)
    |
    | same-origin HTTP / JSON
    v
Node.js server (src/server.js)
    |-- store.js ---------> SQLite (data/forms.sqlite, not committed)
    |-- field-types.js ---> Shared normalization / validation
    |-- spaces.js --------> Space ownership and nested navigation
    |-- expressions.js --> Restricted formulas and decimal recomputation
    |-- automation.js ---> Atomic rules, notifications and Error Center
    |-- ai-tasks.js ------> Persisted structured AI queue and reviewed writeback
    |-- attachments.js ---> Space-scoped files and rendered image pages
    |-- modules.js -------> Order / Meeting / Supplier / Inventory definitions
    `-- ai-config.js -----> Upstream model list / saved configuration
             |
             `-- meeting-ai.js ---> Configured external AI provider
```

The floating assistant adds `assistant.js` (server-owned conversations and tool-call loop), `agent-operations.js` (shared allowlisted queries/mutations), `agent-repository.js` (tokens, settings, conversations and action log), and `agent-http.js` (separate Agent and local-administration routes). `agent-openapi.js` derives external endpoint request schemas from the same tool definitions.

The native Node.js HTTP server serves an explicit allowlist of browser assets. `src/field-types.js` and `src/errors.js` are deliberately served as shared browser modules; server-only code, environment files, and the database are not served. Moving source files into `src/` does not change the public asset URLs or the default database location.

## Orders and References

Tables define stable field IDs, names, types, and constraints. Records contain values keyed by those IDs. A separate unique-value index enforces uniqueness, while version numbers detect stale writes.

Every record creation, update, and deletion creates a history event. Updates store field-level differences. Editing a schema is not itself a record history event, except that changed calculated values generate record activity. Changing an order creates follow-up records only when a corresponding automation has been configured.

Reference values hold target record IDs. Display labels are resolved from the target table's unique field, so renaming an order number preserves its links. Deletion and incompatible schema changes are blocked when they would invalidate references.

## Spaces, Rules and AI Tasks

Forms belong to a Space; navigation nodes are a separate tree with stable form IDs. References, Agent tokens, rule targets, lookups and attachments are Space-scoped. Legacy business-role bindings remain in the default Space and are independent of navigation placement.

`expressions.js` validates a restricted jsep syntax tree and evaluates numeric formulas with Decimal.js. Calculated fields are read-only inputs to the shared store. `automation.js` executes nested conditions and ordered record actions inside the source write transaction; failed cascades roll back and retain diagnostic context outside that transaction. Web, Agent, import and reviewed extraction writes use this path. Approval previews simulate and fingerprint the full synchronous cascade.

`ai-tasks.js` persists input snapshots and queue state in the transaction, then performs inference outside it. Typed output is validated before reviewed or automatic writeback through the same store. Snapshot checks reject changed sources/configuration; synchronous ancestry and asynchronous task lineage limit loops. `attachments.js` retains original files and rendered pages in SQLite. See the [workspace guide](workspace-automation.md) for contracts and current limits.

## Meeting Extraction

1. The user supplies a meeting title, date, and text.
2. The server builds a structured extraction request from the current table schema and permitted reference candidates.
3. The configured provider returns proposed values and evidence quotes.
4. The server validates the structure, values, reference IDs, and verbatim evidence, then stores a draft.
5. The user corrects the draft and selects items.
6. A transaction creates the selected records and retains source provenance. Repeating a completed commit returns the existing result.

AI output is data, never executable SQL or application code. Tests mock provider responses; a passing suite does not prove that any particular upstream model supports strict structured output or tool calling.

## Supplier Reconciliation and Imports

`table-import.js` validates generic row-to-field mappings and stores reviewed previews; `table-import-worker.js` parses XLSX/CSV in a time/memory-bounded worker using ExcelJS and csv-parse. Existing store methods validate previews inside rollback savepoints, then revalidate and commit the entire import transactionally. Imports append, never silently overwrite.

`supplier-reconciliation.js` owns receipt/document defaults, schema-aware vision extraction, reviewed document commits and deterministic quantity matching. The browser renders PDF pages with PDF.js before sending page images to the configured workspace extraction provider. `workflow-repository.js` stores table roles, import drafts, original files, document provenance and comparison snapshots in SQLite.

Receipt and supplier tables remain ordinary custom tables, so references, field edits, history and Agent record operations use existing store behavior. Supplier files and workflow routes are local administration only. Comparison results retain immutable computed data while allowing reviewed status/notes with version checks. Changed selected source rows or schemas mark snapshots stale. See [workflow details](supplier-reconciliation.md).

## Assistant Operations and Approval

Chat and external Agent APIs share one operation service. Writes run existing store methods inside a rollback savepoint to produce a validated preview. Approving runs the immutable request again, verifies expected versions (and table-record fingerprints for schema edits), and atomically commits both business data and action status. Idempotency keys prevent duplicate execution. Full access uses the same pipeline but applies immediately.

The UI controls chat permissions; each external token has separate permissions. Agent tokens cannot call local approval/configuration routes. Token values are returned only at creation and stored as hashes. Revocation rejects pending proposals from that token. Preview creation does not leave records, unique indexes or business activity behind. Agent action history also records table-schema operations, which are not part of the existing record activity list.

## Inventory Ledger

`inventory.js` initializes four ordinary custom tables and implements order mappings, quantity calculation, posting previews, confirmations, adjustments and reversals. `inventory-repository.js` persists immutable posting snapshots and In/Out entries, idempotency requests and table roles. Store-level guards protect core schema fields, positive quantities, unique recipe pairs, material units with history and the stock-related values of actively posted sources across manual, Agent and spreadsheet writes.

Stock summary is derived from all posted entries using Decimal.js, not an editable balance field. An order multiplies each recipe quantity by ordered product quantity. A purchase confirmation creates an inbound entry. Draft creation and the Completed dropdown never post stock. Confirmation recalculates and hashes the same dependencies and balances inside a transaction, rejects stale previews and shortages, and posts all lines atomically. One active posting is allowed per order/purchase source; reversal appends opposite entries and unlocks stock-related source fields without deleting history.

Inventory routes are local workspace administration. The existing Agent interface can edit the input tables subject to the same guards, but does not expose stock-posting operations. See [inventory](inventory.md) for scope, examples and limits.

## Configuration and Data

Saved provider settings override environment fallback settings and apply without restarting. Environment changes require a restart. The API returns whether a key is present, never the saved key itself.

SQLite stores business records, meeting source text, drafts, history, assistant conversations/actions, token hashes, and saved provider credentials. Provider credentials and business content are not encrypted at rest. Meeting extraction and assistant providers are configured independently. Extraction sends meeting text, field definitions, and relevant reference identifiers/unique values to the chosen provider; chat sends conversation text and requested tool results. No automatic data-retention policy is implemented.

## Integration Status

Orbyte integration, Replit deployment, and RunPod-specific integration are not implemented. `/api/agent/` provides Bearer-token authorization, OpenAPI discovery and approval-aware operations for future adapters. The local workspace still trusts loopback clients and has no user accounts, tenant ownership or authenticated human identity. Local programs can access legacy administration without a token; token separation is not a sandbox against software on the same computer. See [Agent API](agent-api.md).

The local server binds to `127.0.0.1`; cloud deployment and multi-user access need explicit work. No diagram or configuration here claims a live sponsor-platform integration.
