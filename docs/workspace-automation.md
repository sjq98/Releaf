# Workspace Automations

> Superseded for cross-form automation: user-configurable rules are disabled in the active product. Their working source and demos are preserved in [future/cross-form-automation](../future/cross-form-automation/README.md). See [Warehouse Management](warehouse.md) for current fixed workflows, UI and Agent API. Formula, Space and notification concepts below remain relevant.

Implemented local prototype, 2026-10-23. The UI supports English and Chinese. Run on `http://127.0.0.1:5174`.

Use the language selector in the top bar or automation editor to switch immediately; the choice is remembered in this browser. System labels change without reloading or discarding drafts. Form/field names, record values, custom dropdown options, provider/model names and user expressions remain unchanged.

## Spaces and Navigation

The current database migrates into **Inventory Management System** without replacing forms, record IDs, saved credentials or business bindings. Previous modules become initial nodes. The Space selector switches form ownership scopes; its plus button creates a Space with an initial form.

The sidebar plus button creates a **Node** (text container) or **Form** (record table). A node can contain nodes and forms. Its plus button creates a child. An entry's ellipsis opens rename, parent and numeric sort-position settings; smaller positions come first. Navigation moves never change a form's ID or legacy module role. Empty nodes can be deleted; nonempty nodes and form data cannot be deleted through the navigation menu. Cycles and cross-Space parent moves are rejected.

Drag a sidebar label or its grip to move a Node/Form. The upper/lower edge places it before/after that entry; the center of a Node moves it inside. A moved parent carries its entire subtree, including collapsed children. The **Space root** drop area appears while dragging and moves an entry to the end of the root list. Forms cannot contain children, and self/descendant/cross-Space drops are rejected. Touch uses the grip; Escape cancels. Focus a grip and use Up/Down to reorder siblings, or activate it to open the existing parent/position editor.

Moves save automatically and atomically. The UI changes only after a successful response, so failed writes preserve the previous order. Dragging does not change form schema versions, records, references or business bindings. Fixed tool links are not part of the customizable tree.

References, cross-form actions, lookups, attachment values and Agent tokens must remain in the same Space. References use target record IDs. A referenced field cannot be removed, made nonunique or incompatibly retyped until dependent reference fields are removed, including when their records are empty.

The legacy inventory ledger, meeting imports and supplier-reconciliation tools remain available only in the default Space. New Spaces support custom forms, formulas, rules, AI tasks, files, notifications and errors. The prototype is not a tenant-authentication system.

## Calculated Fields

Open **Edit table fields**, choose a Number field and click its formula icon. Select form fields, add operators/constants/functions, test the result, then choose **Use formula** and **Save table**. The formula belongs to the field definition; ordinary field inputs evaluate for each record. **All records** explicitly inserts a same-form aggregate.

Supported arithmetic: `+ - * / %`, parentheses, comparisons and Boolean operators. Functions: `SUM`, `COUNT`, `MIN`, `MAX`, `ROUND`, `ABS`, `COALESCE`, `IF`. Formula evaluation uses a restricted parsed expression, not JavaScript, VBA or SQL. Symbols such as `v1` bind to stable field IDs; their labels are shown below the expression.

```json
{
  "expression": "quantity * price",
  "bindings": {
    "quantity": { "scope": "record", "fieldId": "qty" },
    "price": { "scope": "record", "fieldId": "unitPrice" }
  }
}
```

Calculated outputs are read-only. Omit them from API/import values; the store computes them before running conditions. Renaming/reordering inputs preserves bindings. Unknown inputs, dependency cycles, division by zero and invalid numeric results reject the entire write. Null arithmetic remains null; use `COALESCE(v1, 0)` explicitly. Form-level aggregates take manually entered numeric fields; aggregate-of-calculated-field dependencies are not supported.

Saving a changed formula recalculates existing rows atomically. Changed computed values increment record versions and create activity; schema recalculation does not replay ordinary update automations.

## Cross-Form Rules

Open **Automations**, or use the workflow icon on a form, to view that form's rules. Select **Record created**, **Record updated** or **Record deleted**, then click **Add action**. Each tab shows its rule count, including disabled rules. The editor fixes the source form and trigger to this context; saving returns to the same form and trigger tab. Configure:

- Rule name and enabled state. The source form and trigger are read-only.
- Optional watched fields for updates, saved condition tiles and an AND/OR/NOT trigger expression.
- Ordered action steps: Create, Update or Delete records; Receive stock for Created rules; optional Notify or Run AI task steps.
- Same-Space target, nested target filters, First/All matching and Fail/Skip when no records match.
- Typed field assignments using literals, trigger Before/After, current target, filtered lookup, aggregate, formula or Set empty.

Existing rules remain associated with their stored source form and trigger, without migration. **Run history** shows only the current form's runs (including runs of deleted rules). The list and history APIs accept `formId` alongside `spaceId`; history filtering occurs before the 200-run limit. Error Center links open the rule's own form, and the notification shortcut still creates an Updated rule. AI task source selection is unchanged.

**Keep** means omitted: updates retain that field. **Set empty** means explicit null. Zero and false are valid values and are not treated as omitted. Required fields still reject missing/empty values. Delete removes entire records; clearing selected fields is an Update action.

### Trigger Condition Composer

Create each comparison with **New condition**, then **Save condition**. Saved comparisons receive IDs such as `C1` and `C2`; their tiles can be edited or inserted at the expression cursor. Combine them using the operator buttons or type an expression, for example `(C1 OR C2) AND NOT C3`. Precedence is NOT, then AND, then OR; parentheses override it. IDs and keywords are case-insensitive.

The editor validates the expression before saving. A referenced tile cannot be deleted until its ID is removed from the expression. Unused tiles are retained. Saved tiles require a nonblank expression; no tiles and a blank expression mean no trigger filter. Limits are 30 tiles, 2,000 expression characters, 150 tokens and 10 levels of nesting. Existing nested trigger rules are converted into tiles when opened, preserving their logic. Target action and lookup filters retain their nested editors.

The rule API accepts an optional `conditionBuilder` object in addition to the existing `condition` AST:

```json
{
  "conditionBuilder": {
    "conditions": [
      { "id": "C1", "condition": { "fieldId": "qty", "operator": "gt", "value": { "kind": "literal", "value": 10 } } }
    ],
    "expression": "C1"
  }
}
```

The server compiles this into the existing AST and validates every saved comparison. If both representations are supplied they must agree. Existing clients can continue supplying only `condition`. This is a restricted Boolean parser, not executable JavaScript.

First match uses creation time descending, then insertion order descending, matching the record list. A lookup can select first or require exactly one matching row. Aggregates inspect all matches rather than a query page.

A condition leaf:

```json
{
  "fieldId": "material",
  "operator": "eq",
  "value": { "kind": "field", "scope": "source", "fieldId": "material" }
}
```

A group uses `{ "op": "AND", "conditions": [...] }`, or OR/NOT. NOT has exactly one child. Supported comparisons: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `contains`, `is_empty`, `not_empty`, `changed`, with field-type validation.

Example generic stock update action (requires an existing matching record):

```json
{
  "type": "update",
  "formId": "TARGET_STOCK_FORM_ID",
  "selection": "first",
  "noMatch": "error",
  "condition": {
    "fieldId": "material",
    "operator": "eq",
    "value": { "kind": "field", "scope": "source", "fieldId": "material" }
  },
  "assignments": {
    "qty": {
      "kind": "formula",
      "formula": {
        "expression": "COALESCE(current, 0) + received",
        "bindings": {
          "current": { "scope": "target", "fieldId": "qty" },
          "received": { "scope": "source", "fieldId": "qty" }
        }
      }
    }
  }
}
```

Web edits, Agent operations, spreadsheet imports and validated extraction writebacks share the record store. Source changes and synchronous cascades commit together or roll back together. Failed writes leave an Error Center entry after rollback. No-op updates trigger no rules. Execution is limited to 20 nested synchronous rules and 1,000 record changes; repeated rule/record ancestry fails. Formula input/schema dependencies cannot silently be removed.

Saved rules offer a dry-run preview and run history. The simulation executes all applicable enabled rules, not just the selected rule. Agent approval and spreadsheet import previews include all synchronous record changes. Their conservative Space fingerprint invalidates a preview when related data, schemas, rules or task definitions change.

### Receive Stock

Use **receipt form > Automations > Record created > Add action**, then select **Receive stock** in the action editor. This is one business operation with field mappings, without a general-purpose branch editor. Existing conditions and ordered steps remain available.

Choose the stock form in the same Space, the receipt material and quantity fields, and the target material matching field. For a custom stock table, also choose an editable, non-unique Number field for its balance. Optional unit checking requires both receipt and target unit fields. For the registered **Materials** table, stock goes to the existing inventory ledger and the receipt unit field is required; view the result in **Stock summary** and **Stock movements**.

| Matching result | Outcome |
| --- | --- |
| No matching material | Create it with the received quantity |
| Exactly one match | Add the received quantity to its current balance |
| Multiple matches | Reject and roll back the whole source write |

Text matching trims whitespace and ignores case. Prefer a unique material code. Reference fields match stable record IDs; if the receipt field directly references the target stock form, it must reference an existing material and never creates a missing one. Other compatible reference fields must point to the same form and unique field.

**New material values** maps additional fields from receipt fields or fixed values; required fields must be supplied. These values are used only when creating a material and do not overwrite existing material details. For Materials matched by name, map its required SKU here, or match by SKU and map its name. A direct reference to the stock form does not require these creation defaults.

Received quantities must be positive, at most `1e12`, with up to six decimals. Unit mismatches fail without conversion. One receipt record can run this operation only once; duplicate actions/rules reject atomically. Request retries and import confirmations retain existing idempotency. Different receipt records represent different deliveries, so use a unique receipt-line field to prevent importing the same physical delivery twice.

Manual record creation, confirmed spreadsheet imports, Agent writes and validated AI writebacks all use this action. Agent approval previews include stock changes; later ledger or receipt changes invalidate pending previews. A failed action rolls back the receipt, target record, inventory movements and subsequent actions, and remains visible in **Error Center**.

In **Run history > Run details > Stock receipt**, enter a reversal reason, preview changes and confirm. Reversal subtracts the original quantity from the current balance and preserves history; it refuses to create negative stock. Active receipts protect their material, quantity and unit, along with mapped schema fields, even if the rule is deleted. Receipt reversal can also use the existing inventory movement reversal for ledger-backed receipts.

Rules apply only to newly created records after configuration. Editing an old record, changing an approval field later, or reversing a receipt does not post it again. To correct an entered quantity, reverse the original and create a replacement receipt with a new receipt-line identifier; retain the original as history. The action does not automatically reconcile purchase documents or infer approval. Avoid configuring two receipt tables to count the same delivery.

## Notifications and Errors

The bell opens notifications and creates a notification rule for the current form. Choose a field, comparator, threshold and message; the resulting rule can be edited in Automations. Updated-record notifications fire when the condition becomes true, not for every edit while it remains true. These are in-app event notifications, not scheduled/email/push notifications.

**Error Center** supports date, source-form, category and status filters; details show the attempted source operation, failed rule/step and available run context. Open source data/configuration, retry a saved local operation, mark resolved or ignore. Local retries retain the original version checks: stale edits require a new operation. Successful local retries resolve the original error atomically. AI failures can be retried through their run; a valid failed writeback can reuse stored output. Errors and run history are retained locally, with bounded list responses.

## Configurable AI Tasks

In **AI tasks**, create a task and select:

1. Source form and input fields, including Attachment fields when needed.
2. Processing instructions, saved provider/default model or an upstream-discovered model.
3. Destination form and typed structured output fields.
4. Create/Update/Delete action, matching filters and assignment overrides.
5. Review results or Automatically apply valid results.

Fields selected for structured output define the model's output schema. Assignment overrides can combine output with trigger values, target values and deterministic expressions. For an output-field override, select **Field**, the destination form and **AI output**. Other cross-form lookups support filters and explicit selectors. Formula-dialog lookup bindings currently use the newest record or SUM; use the Field value editor for filtered lookup/aggregate choices.

Run a task against a saved source record, or add a Run AI task step to a form automation. The queue is committed locally before inference. Network calls run outside the SQLite write transaction. Input/task/schema snapshots are validated again before writeback. AI results are values only, not executable operations.

In **Runs**, inspect typed results. Review-mode results remain unwritten until **Preview changes** and **Apply result**. Automatic mode uses the same atomic validation/write path. Changed inputs/tasks/schemas become stale; changed preview dependencies require another preview. Applied runs are idempotent. Failed and stale runs can retry; queued/review/failed/stale runs can be cancelled. Active network calls cannot currently be cancelled. Queued jobs persist; interrupted Running jobs requeue on server restart. Async task ancestry prevents self-trigger chains and caps chained tasks at 10.

Attachment fields support PNG/JPEG/PDF uploads, up to 10 files per field. File bytes stay in SQLite, not in record JSON. PDFs uploaded through the browser are rendered to at most 6 image pages; AI runs accept at most 12 image pages total. Configure a model that supports both images and strict structured JSON. Text-only tasks do not need image support. Provider keys stay server-side, stored unencrypted in the local database.

The existing supplier extraction and deterministic reconciliation screens remain available. This generic AI-task interface does not replace arithmetic reconciliation with model guesses. Live AI quality/provider compatibility and real procurement data still need user testing.

## Local API

Local administration routes do not accept Agent Bearer tokens. Writes use JSON. Core form/record creation routes support `Idempotency-Key`; rule/task edits use version checks.

| Method | Path | Purpose |
| --- | --- | --- |
| GET / POST | `/api/spaces` | Discover/create Spaces |
| PATCH | `/api/spaces/{id}` | Rename a Space |
| GET / POST | `/api/nodes` | List/create navigation nodes |
| PATCH / DELETE | `/api/nodes/{id}` | Rename/move/reorder; delete empty nodes |
| POST | `/api/nodes/{id}/move` | Atomic drag move; returns the node and updated navigation tree |
| POST | `/api/formulas/preview` | Test draft fields/values without writing |
| POST | `/api/expressions/preview` | Test an assignment formula using current samples |
| GET / POST | `/api/automations` | List/create rules |
| PUT / DELETE | `/api/automations/{id}` | Versioned edit/delete |
| POST | `/api/automations/preview` | Simulate a source record write and its cascade |
| GET | `/api/automation-runs` | Synchronous run history |
| GET | `/api/stock-receipts/{id}` | Receipt mapping, quantity, stock effect and reversal status |
| POST | `/api/stock-receipts/{id}/reverse-preview` | Preview reversal with `{note}`; returns changes and a fingerprint |
| POST | `/api/stock-receipts/{id}/reverse` | Confirm with `{note, fingerprint}` and an Idempotency-Key |
| GET | `/api/errors` | Processing failures |
| PATCH | `/api/errors/{id}` | Resolve/ignore |
| POST | `/api/errors/{id}/retry` | Retry retained source operation or AI run |
| GET | `/api/notifications` | Notifications |
| PATCH | `/api/notifications/{id}` | Mark read |
| POST | `/api/attachments` | Upload original file and optional PDF image pages |
| GET | `/api/attachments/{id}` | Download original file |
| GET | `/api/attachments/{id}/info` | Metadata only |
| GET / POST | `/api/ai-tasks` | List/create task definitions |
| PUT / DELETE | `/api/ai-tasks/{id}` | Versioned edit/delete |
| POST | `/api/ai-tasks/{id}/run` | Queue task with `recordId` |
| GET | `/api/ai-runs` | List AI runs |
| GET | `/api/ai-runs/{id}` | Inspect one run |
| POST | `/api/ai-runs/{id}/preview` | Dry-run structured output writeback |
| POST | `/api/ai-runs/{id}/apply` | Human apply with returned `fingerprint` |
| POST | `/api/ai-runs/{id}/retry` | Retry failed/stale run |
| POST | `/api/ai-runs/{id}/cancel` | Cancel eligible run |

Space-scoped list routes accept `?spaceId=...` (default `default`). Form creation/import accept `spaceId` and `parentId`. The bootstrap response adds `space`, `spaces`, `navigation`, `errorCount` and `notifications`. External integrations must use the [Agent API](agent-api.md), including the discovered `/api/agent/operations` contract.

The local drag endpoint accepts `{ "targetId": "NODE_OR_FORM_ENTRY_ID", "placement": "before" }`, with `before`, `after` or `inside`. `inside` requires a Node, or `targetId: null` for the Space root. It supports `Idempotency-Key` and renumbers affected sibling lists in one transaction; descendant parent IDs remain unchanged.

## Remaining Work

This release does not automatically install the finished-goods inventory/shortfall production workflow, implement billing, publish a website, or integrate Orbyte authentication/APIs. Legacy specialized tools are not yet independent per Space. Advanced error-attempt timelines/retention controls, filtered AI context sources, editable intermediate AI output schemas and prompt field-placeholder controls remain extensions. The current AI output shape is a list derived from an existing destination form.
