# Spaces, Navigation, Error Center, and AI Tasks

Status: accepted design, with the first runtime implementation delivered on 2026-10-23. See [Workspace Automations](workspace-automation.md) for the implemented subset and remaining work. This document retains the broader design, not a claim that every planned extension is complete. The common formula and automation contract is in [Form Automations](form-automation-design.md).

## Space Ownership and Navigation

A Space is the scope for related forms, references, workflows, files, and processing runs. The current installation can begin as a single Space named Inventory Management System.

Users can create exactly two navigation entry types:

- Node: a text label used to organize child nodes and forms; it has no record schema or business data.
- Form: a leaf that opens the custom form, including records, field editing, formulas, automation configuration, and notification settings.

Nodes may be nested, renamed, expanded/collapsed, reordered, and moved within the Space. Forms may be created at the root or inside a node, and moved without changing their identity. The initial deletion policy permits deleting empty nodes; a nonempty node must have its children moved or removed explicitly first. Moving an entry below one of its own descendants is invalid.

Proposed ownership data:

| Object | Required ownership and identity |
| --- | --- |
| Space | Stable ID and editable name |
| Navigation entry | Stable ID, Space ID, parent node ID, kind, and display order; a form entry links to a stable form ID |
| Form | Stable ID and explicit Space ID, independent of navigation placement |
| Workflow or AI task | Space ID and form IDs for explicitly configured inputs and outputs |
| File and processing run | Space ID and source/task association |

The server validates Space ownership for automation targets, formula lookups, references, import destinations, record discovery, and Agent calls. Hiding other Spaces in a dropdown is not sufficient. Two forms in different folders of the same Space remain available to each other.

Space membership does not imply that every user or token can access every Space. The selected Space and actor scope must be carried through discovery and execution. The current single-Space installation can use its existing access behavior while adding explicit Space ownership; finer permissions are a separate feature.

### Migration from Fixed Modules

Currently `moduleId` controls both navigation grouping and parts of inventory, meeting, and supplier behavior. Migrate existing groups into initial nodes, preserve all existing form and record IDs, and preserve their business bindings separately from the tree.

Reorganizing the tree must not change a form's inventory role, meeting processing, references, formulas, or automation rules. Inventory/supplier/meeting role bindings that are currently global must become Space-scoped before a second Space can work independently.

Existing stock summaries, stock movements, recognition, reconciliation, and import screens are specialized views. They remain available as form or Space tools; they do not become a third user-created navigation entry type. Error Center is a fixed Space tool outside the editable business tree.

## Error Center

The Space has an Error Center entry with an unresolved count. Its list supports filtering by time, form, rule/task, error category, and status.

Each entry provides:

- Time, a readable summary, and the failed step.
- Source form/record, target form/record when relevant, and links to the rule or AI task.
- Run ID, request/event identity, attempt count, and applicable configuration versions.
- Relevant input and change context, within the actor's Space access. No provider keys, tokens, or authorization headers.
- A structured reason, such as invalid formula, type mismatch, missing match, broken reference, stale data, recursion limit, provider failure, or invalid AI output.
- Status: Unresolved, Retrying, Resolved, or Ignored, with a history of status changes and attempts.
- Actions appropriate to the failure: open the affected configuration/data, inspect the run, retry when possible, or mark ignored.

A rolled-back new record may have no saved record to open. In that case the error links to the attempted input and source form instead of a nonexistent record. Error logging survives rollback of the business operation.

Retry is stage-aware. A failed local atomic operation can be attempted again after correcting its inputs/configuration; already applied effects cannot be applied twice. An AI inference failure can rerun inference, while a writeback failure can reuse a valid stored result. A changed source, schema, or task requires a refreshed preview or inference as appropriate. Successful retry resolves the original error but retains its attempt history.

Business discrepancies, such as a delivered quantity differing from the supplier's quantity, remain visible in the appropriate reconciliation/review records. Error Center covers failed execution; it can link to those review records without classifying every legitimate discrepancy as a software failure.

## Configurable AI Tasks

The existing supplier feature already has local extraction, draft retrieval, commit, and deterministic reconciliation interfaces. The extension is a configurable processing definition and Space-scoped execution interface, not a requirement for the model to directly access the database.

An AI Task can be launched manually from a form or used as an asynchronous step in an automation. Reusable task templates allow supplier recognition, meeting action extraction, text classification, or other user-defined processing to share the same flow. Node and Form remain the only navigation creation options.

### User Configuration

| Setting | Purpose |
| --- | --- |
| Name | Identify the task and its purpose |
| Trigger | Manual execution or a configured form event and conditions |
| Inputs | Selected fields, selected attachments, and explicitly filtered same-Space reference data |
| Connection/model | Choose a saved provider URL/key connection and model |
| Instructions | User-editable processing instructions with field placeholders selected from the schema |
| Output shape | One object or a list of objects, with typed fields; derive from a destination form or define an intermediate result |
| Result mapping | Map validated output to the common Create/Update/Delete actions, target filters, and field assignments |
| Apply mode | Review results or automatically apply results that satisfy all configured checks |
| Test | Run against selected input and show parsed output, proposed record changes, and validation errors |

Result mappings are configured by the user. Model output supplies values; it does not acquire arbitrary database execution rights. Required/unique/type/reference rules still apply. A rule that maps output to deletion must explicitly configure that action and its target filters.

The present field types do not include a generic Attachment field. To make file processing usable across all forms, add an Attachment type backed by Space-owned file IDs, reusing the existing upload/source concept. It should support selecting one or multiple files according to field configuration. Field values reference stored files rather than containing a local filesystem path or arbitrary file contents.

Fetching a provider's model list does not verify image or structured-output compatibility. The task test must exercise the required input/output features and report unsupported behavior. Existing provider settings are reusable; a multi-connection picker is a separate extension if users need different providers per task.

### Procurement Template

```text
Document uploaded
  -> AI extracts item lines and source evidence
  -> Validate structured fields and resolve catalog/order references
  -> Map valid lines into supplier-document records or a review draft
  -> Match against selected receipt records with configured deterministic rules
  -> Matching result: run configured acceptance actions
  -> Difference or unresolved information: send to the review form
```

Users configure matching keys, quantity fields, units, and any explicit tolerance. A model can propose a material mapping, but unresolved or ambiguous identity cannot silently become an approved stock receipt. After identities are resolved, the comparison program evaluates the configured rules consistently.

Only actual verified/approved receipts are candidates for stock posting. The existing stock ledger must remain the authority for inventory effects. A matching supplier document alone is not evidence that stock was physically received.

### Asynchronous Execution

Model requests run outside the local cross-form transaction:

1. Commit the initiating form changes and a durable queued task together.
2. Process the queued task using a captured input/configuration snapshot.
3. Store the parsed result and its evidence; validate output types, references, and mappings.
4. Compare the current source data, schema, lookup/match set, and task versions with the task snapshot.
5. Present the complete proposed changes for review, or apply them when automatic mode and configured checks permit it.
6. Apply the result and any local downstream actions in a new atomic transaction, then mark the result applied.

AI processing may fail after the initial input has been saved. The input remains available for correction or retry; the failure appears in Error Center. Remote requests cannot be undone by rolling back the local database.

Suggested run states: Queued, Running, Needs review, Applied, Failed, Cancelled, and Stale. A stale result cannot overwrite newer input silently.

The interface to start a task returns a run ID. The caller can query state, inspect the structured result and proposed changes, and use the existing review/full-access model to apply results. The eventual Agent interface also exposes task discovery and run inspection within its Space scope. Human review permissions remain separate from Agent suggestions.

Retrying a run does not create duplicate mapped records or stock effects. Reuse completed inference when only writeback failed and the inputs still match. Applying a result is idempotent. A retried provider call may still incur another upstream request; local idempotency is not a promise that every provider supports request deduplication.

Input documents and table values remain data, even if their text contains apparent instructions. Only the configured task definition supplies processing instructions. Logs and result previews redact connection secrets.

## Implementation Order

1. Space ownership and navigation migration, preserving all current identities and business bindings.
2. Form-level field formulas, typed AND/OR/NOT condition expressions, and shared mutation execution.
3. Cross-form actions, cascade previews, dependency checks, and Error Center.
4. Attachments and reusable asynchronous AI tasks, starting with the current supplier-recognition flow as a template.

This order establishes the same form/Space contracts used by the later configurable AI features. It does not require rebuilding all business modules before exposing useful task interfaces.
