# Warehouse Management

## Current product boundary

Users and Agents share the warehouse business operations and validations. Fixed code handles document totals, line states, stock balances, workflow transitions and reversals. Neither user nor Agent can define cross-form event rules, edit managed balances/statuses directly, delete posted history or bypass stock checks.

The old cross-form API, engine, UI and executable examples are preserved in [future/cross-form-automation](../future/cross-form-automation/README.md). Its source is not served by the application. Existing saved cross-form rules are retained but ignored, and pre-upgrade Agent proposals for those operations cannot be approved. Old `/api/automations` routes return 410. There is no runtime feature flag to restore them.

Custom nonwarehouse forms retain numeric formulas, notification conditions, and manually launched AI processing tasks. The seven warehouse forms are read-only for members. Administrators can maintain records and add custom fields through the shared editor/API, but core fields may only be renamed or reordered: their types, required/unique rules, references and formulas cannot change. Managed balances/statuses, noneditable documents, movement history and reference constraints stay protected regardless of role. Use the catalog or document workflows below for ordinary business changes. Navigation placement and notification rules are administrator-configurable.

The fixed warehouse workflow does not call the archived configurable cross-form automation engine. It reuses shared CRUD, transactions, reference validation and change history, plus active notification infrastructure. Shared infrastructure is not a re-enabled cross-form rule system.

## Accounts and Workflow Identity

The first visit creates an administrator; there is no default password, and passwords
must contain at least 12 characters. Administrators manage accounts under **Account >
Manage users**, including role changes, disabling and password resets. Members read
shared tables and inventory analysis and use document workflows; only administrators
maintain catalogs, set up the module or edit table definitions, generic records, navigation and settings. Sessions
last seven days, and password/role/active-status changes invalidate existing sessions.

New requests bind the applicant to the signed-in username. Editing a request preserves
its original applicant. Select an active account as approver; submission validates the
selection. Approval and rejection must be performed while signed in as that assigned
account, even for administrators. Workflow events record the current account, not an
editable operator label. Current workflows do not otherwise restrict draft editing,
submission, posting, cancellation or reversal to the original applicant.

Agent requests run as the token's owning account, with its current active status and
role. The same applicant and approver checks apply. Neither Full access nor a human
approving an Agent proposal can impersonate a different business approver.

## Tables and identity

Administrator setup adds a navigation tree and seven forms in the selected Space:

| Table | Purpose |
| --- | --- |
| Products | Unique product code, name, pictures, category, specification, unit, notes and active flag |
| Stock | Product reference + warehouse reference, current/opening quantity and minimum; catalog details are derived |
| Inbound Requests | Inbound request header, approver and workflow state |
| Inbound Request Lines | Product, quantity and remarks, linked to an inbound header |
| Outbound Requests | Outbound request header, approver and workflow state |
| Outbound Request Lines | Product, quantity and remarks, linked to an outbound header |
| Warehouses | Warehouse codes, names, locations and managers |

Setup is idempotent. It creates one default warehouse, no sample products or movements. Custom tables remain unchanged. Legacy Materials/Recipes logic is retired; only this warehouse system posts current stock.

Stock identity is product + warehouse, represented by a managed unique stockKey. Both detail tables reference Products, not Stock. Each detail also references its corresponding document; documents and stock reference Warehouses. References store stable record IDs, not labels. Product code and unit cannot change once referenced. Opening quantity/product/warehouse cannot change after a movement exists. Catalog name/image/category/specification edits propagate to stock display fields.

Warehouse form, field and navigation names default to English. Startup translates the original Chinese labels in existing warehouse forms and their navigation ancestors. It preserves field/form IDs, constraints, references, record values and movement history, and leaves unrelated forms and custom labels unchanged. Repeated startup does not increment already migrated form versions. Business names stay English when switching the interface language.

Upgrades automatically add the product catalog and migrate active stock/line references transactionally, preserving stock IDs, balances, documents and movement history. Conflicting details for the same code abort migration instead of silently merging different products. Back up the SQLite database before upgrading.

## User workflow

1. As an administrator, open 出入库流程. Use 商品登记与维护 to register products and 仓库登记与维护 for warehouses. 库存初始化与阈值 sets opening quantities and minimum stock. These are immediate administrator-only catalog maintenance workflows, not approval documents.
2. Start 入库流程 or 出库审批. Choose a warehouse and active approver account; the applicant is the signed-in user. Select products from the catalog or import product lines. Products do not need a pre-existing stock row. First inbound posting creates it with zero opening stock; missing outbound stock is rejected.
3. Save a draft, or submit. Submission creates Pending approval and does not change stock.
4. The assigned approver signs in to approve or reject. Rejection requires a reason and allows correction/resubmission. Approval still does not change stock.
5. Confirm stock movement. Preview the product balances and confirm. The whole document posts atomically; outbound stock is checked again and cannot become negative.
6. Cancel an unposted request with a reason. Reverse a posted document with a reason. Reversal preserves original movements and refuses to remove stock already consumed.

One product appears once per document, with up to 100 lines. This version posts whole documents; partial receipts/deliveries are not implemented. Totals and child state/date follow the header. Balances use decimal arithmetic. Below-minimum balances are highlighted and generate notifications when crossing the threshold. The bell also opens custom same-form notification rules.

The tables support search, applicable warehouse filters, state tabs and reference links. Members open a document's workflow to take actions rather than editing table fields directly. System labels support English/Chinese while business labels and values remain unchanged.

## Spreadsheet Workflows

An individual request's **Import product lines** accepts XLSX or UTF-8 CSV. The first row contains headers. Product code (preferred) or an unambiguous product name and positive quantity are required; unit and notes are optional. Preview and explicitly replace the request's lines. The request is not submitted automatically.

There is no standalone bulk-import button on the workflow overview; Excel import is inside the inbound/outbound application. The programmatic batch API and Agent tools remain available. They also match warehouse, direction, approver, application date and external request number, while binding the applicant to the authenticated account. Rows are grouped by direction, warehouse, header values and external request number; repeated products within one group are summed exactly. For example, when signed in as `alice` and `sam` is an active account:

```csv
商品编码,数量,仓库编码,方向,申请人,审批人,外部单号
P001,10,WH001,入库,alice,sam,BATCH-01
P002,5,WH001,入库,alice,sam,BATCH-01
```

English aliases include `SKU` / `Product code`, `Product name`, `Quantity` / `Qty`, `Unit`, `Notes`, `Warehouse code`, `Warehouse`, `Direction`, `Applicant`, `Approver` and `Request number`. 入库数量/出库数量 can infer direction. Unknown headers can be mapped manually; ambiguous headers, unknown/ambiguous products, mismatched units or conflicting defaults block execution. Identifiers match case-insensitively without discarding internal punctuation or spaces.

API batch stages are `draft`, `submit` (default), or explicitly `post`. The last option requires `approvalActor` and the authenticated caller must be the assigned approver on every request; supplying another username does not grant approval authority. Stock/state checks are unchanged. Preview shows products, request grouping and stock changes. Any failing request rolls back the entire batch. A changed workspace invalidates its preview. The same file/sheet and resolved request plan is deduplicated, including equivalent automatic/manual mappings; a processed batch is not a mechanism for advancing its saved documents to another stage.

Limits: XLSX/CSV only (not legacy XLS), 5 MB, 1,000 data rows, 20 requests and 100 distinct product lines per batch. Multi-sheet files require selecting a worksheet. This is deterministic header/product matching, not AI image recognition.

## Shared API

UI routes require a login session and local Host/origin checks. Setup, catalog maintenance and generic table/schema mutations require an administrator; document workflows are available to members subject to the business rules above:

| Route | Purpose |
| --- | --- |
| GET /api/warehouse?spaceId=... | Tables, products, warehouses, workflows and latest movements |
| GET /api/warehouse/dashboard?spaceId=... | Read-only trends, live stock alerts and monthly reports; see [dashboard filters and formulas](inventory-dashboard.md) |
| POST /api/warehouse/setup | Install the module in a Space |
| POST /api/warehouse/catalog | Register/update products, warehouses or stock settings; updates need recordId/version |
| POST /api/warehouse/files | Upload `{spaceId?,file:{name,data:base64}}`; no business writes |
| GET /api/warehouse/files/:id | Read worksheet metadata and samples |
| POST /api/warehouse/imports/match | Match headers/products; linesOnly supports an individual request |
| POST /api/warehouse/imports/preview | Validate an entire batch in a rollback preview |
| POST /api/warehouse/imports/execute | Execute with the exact body and fresh fingerprint |
| POST /api/warehouse/documents | Create a header and all lines atomically |
| GET /api/warehouse/documents/:id | Read header, lines and workflow history |
| PUT /api/warehouse/documents/:id | Edit a draft/rejected document and replace its complete line list |
| POST /api/warehouse/documents/:id/preview | Preview a transition without writing |
| POST /api/warehouse/documents/:id/transition | Execute a transition; post/reverse require the fresh preview fingerprint |

External integrations call `/api/agent/operations` with a Bearer token and Idempotency-Key. Discover tools via `/api/agent/tools` or `/api/agent/openapi.json`.

Warehouse tools: `setup_inventory_workspace`, `get_inventory_workspace`, `get_inventory_dashboard`, `save_inventory_catalog`, `get_inventory_request`, `create_inventory_request`, `update_inventory_request`, `advance_inventory_request`. General queries work on warehouse forms. Generic record CRUD and schema tools require an administrator owner and still enforce warehouse field/state constraints; setup and catalog maintenance also require an administrator. `upload_attachment` / `get_attachment` handle pictures and evidence. Spreadsheet tools are `upload_inventory_file`, `get_inventory_file`, `match_inventory_file`, `preview_inventory_import`, `execute_inventory_import`. External clients can upload through `POST /api/agent/files` using their Bearer token, or the upload tool; transport uploads do not require Agent business-change approval.

The floating assistant's paperclip accepts up to three spreadsheet attachments per message. Files are stored in the selected Space; the model receives verified file IDs and filenames and uses tools to read/match them. Upload alone does not start a workflow. Business writes follow Review first / Full access exactly as other Agent tools.

Example Agent request after resolving the actual warehouse/product record IDs:

```json
{
  "operation": "create_inventory_request",
  "args": {
    "spaceId": "default",
    "kind": "inbound",
    "values": { "warehouse": "WAREHOUSE_RECORD_ID", "approver": "sam" },
    "lines": [{ "product": "PRODUCT_RECORD_ID", "quantity": 10 }],
    "submit": true,
    "actor": "alice"
  }
}
```

Transition actions: `submit`, `approve`, `reject`, `cancel`, `post`, `reverse`. Agent transition arguments require `recordId`, current `version` and `actor`; reject/cancel/reverse also require `note`. The authenticated account determines the recorded actor; the argument cannot impersonate another user. Approval/rejection requires that account to match the assigned active approver. Unknown actions are rejected by the operation schema and business service.

Agent Review first previews the entire atomic write; Full access executes it immediately. This is distinct from business approval: approving an Agent proposal to submit a request only submits it. Posting still requires the business document to reach Approved. Agents can perform business approvals when requested, under the same assigned-approver check as the UI. They cannot approve their own Agent review proposals or grant themselves Full access.

## Prototype limits

Local accounts and administrator/member roles now supply workflow identity. Accounts share the workspace; Space-scoped Agent tokens are not per-company or per-Space account membership isolation. The server remains loopback-only and needs TLS, deployment-specific Host/proxy policy, tenant boundaries and production secret storage before public deployment. Provider credentials remain unencrypted at rest. Legacy supplier, meeting and recipe/purchase modules are retired.

Tests cover migration with dormant legacy rules, old pending Agent actions, atomic stock posting, negative-stock protection, stale previews, idempotency, schema guards, review/full modes, Space isolation, spreadsheet imports and threshold notifications. Browser QA uses an isolated temporary database on port 5174.
