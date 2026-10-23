# Form Formulas and Cross-Form Automations

Status: accepted design, with the first runtime implementation delivered on 2026-10-23. See [Workspace Automations](workspace-automation.md) for implemented behavior, endpoints, limits and remaining work. The sections below remain the broader design contract.

## Scope and Current State

The priority is the common form engine and its interfaces. Inventory workflows will consume this engine later. The accepted production policy is to use available finished goods first and produce only the shortfall; stock reservations will need to distinguish available stock from stock already allocated to other orders.

Currently implemented:

- Custom field names, types, required/unique constraints, dropdown options, references, and field ordering.
- Record creation, partial updates, deletion, history, and Agent queries with AND filters and sorting.
- Agent review/full-access modes, write idempotency, and transactional previews.
- Protection against removing a field, changing its type, or removing its unique constraint while another reference field targets it.

The first runtime version now includes calculated number fields, a visual formula editor, cross-form automation configuration/execution, cascade-aware Agent/import previews, space-scoped navigation, notifications and Error Center. Finished-goods production and automatic shortfall fulfillment remain a later business workflow; the generic rule engine does not install those business rules automatically.

The related space, error-reporting, and configurable AI-task design is in [Spaces and AI Tasks](spaces-and-ai-tasks-design.md).

## Calculated Number Fields

Every number field can select manual input or formula calculation. The field editor opens a formula dialog containing a picker for this form's fields (columns), numeric constants, operators, parentheses, and a result preview. A formula is configured once on the form field and applies to the form's records; it is not configured separately on a row. Proposed initial operators are addition, subtraction, multiplication, division, and remainder; functions include ROUND, MIN, MAX, and COALESCE.

- Formula operands use stable field IDs. Renaming or reordering columns does not change the expression.
- Dependencies can refer to other calculated fields, regardless of column position. Evaluation follows dependency order; circular dependencies are rejected.
- Formula outputs are read-only in record editing, imports, and write interfaces. Callers supply the input fields; the server calculates outputs.
- Selecting a field selects a column definition. Ordinary arithmetic evaluates that column's value for each record being calculated. Cross-record calculations must explicitly select an aggregate such as SUM, including its record scope; they cannot silently choose an arbitrary row. Cross-form reads belong to automation expressions with an explicit record selector.
- Empty numeric input remains empty, rather than silently becoming zero. Arithmetic with an empty operand returns null unless COALESCE supplies a fallback, such as COALESCE(value, 0). A required calculated output cannot remain null. Division by zero, invalid types, and non-finite results produce field errors.
- Formulas use a validated expression structure, not executable JavaScript or VBA. Required, unique, reference, and domain checks apply to calculated results.
- A record write recalculates its dependent fields before conditions are evaluated. This produces one record change containing both input and calculated changes.
- Saving a changed formula previews and recalculates existing records atomically, increments affected record versions, and records the schema-recalculation reason. Schema recalculation does not automatically replay ordinary record-update automations. Explicit replay, if added, is a separate operation.

## Automation Configuration

A rule belongs to a source form and has a name, enabled state, version, trigger, optional conditions, and one or more ordered action steps. The initial UI uses English labels: Automations, Trigger, Conditions, Target form, Matches, and Assignments.

Triggers:

| Trigger | Source values available | Execution rule |
| --- | --- | --- |
| Record created | After | Once for each newly created record |
| Record updated | Before and After | Once for an actual value change; optionally watch selected fields |
| Record deleted | Before | Once for a deleted record, using its retained pre-deletion values |

Bulk imports produce one event per record. A no-op update produces no event. Automation-generated changes can trigger subsequent rules, subject to cycle and execution limits.

Conditions support AND, OR, NOT, and nested groups. The editor represents parentheses explicitly; the saved expression is a tree with AND/OR groups, unary NOT, and typed comparison leaves, so there is no ambiguous operator precedence. Text supports equality and inequality; numbers support equality, inequality, greater/less than, and inclusive comparisons. Empty/not-empty checks are explicit. Other types use type-appropriate comparisons. An update rule can also test whether a field changed or whether a condition became true, such as Completed changing from No to Yes. Empty comparisons have defined Boolean results (equality with empty is true only for empty values; ordered comparisons with empty are false); NOT negates those results rather than relying on database-specific null behavior.

### Actions and Field Values

The action target is another form in the same Space. The backend validates this ownership for targets, lookups, reference candidates, and Agent calls as well as filtering the form picker. Different navigation folders inside one Space do not restrict access to each other's forms.

| Action | Record selection | Field behavior |
| --- | --- | --- |
| Create record | None | Display every target field. Map editable fields to literals, source values, lookup values, or expressions. Optional fields can be empty; required fields still need valid values. Formula fields calculate automatically. |
| Update records | Filters plus first/all matches | Each editable field selects Keep, Set value, Set empty, or Formula. Leaving a field unconfigured means Keep. |
| Delete records | Filters plus first/all matches | Remove entire selected records, subject to existing reference and domain constraints. |

There are exactly three record mutation actions: Create, Update, and Delete. Clearing selected values is Update with Set empty assignments; it is not a fourth action. Delete removes whole records.

Omitted assignment, zero, false, an empty string, and explicit clearing are distinct. In the interface contract, an omitted field means Keep and an explicit clear means null where the type allows it. Required fields cannot be cleared. Formula outputs cannot be directly assigned or cleared.

The current checkbox normalizer converts null to false. The proposed contract makes optional checkboxes nullable: Set empty stores null and displays an empty state distinct from unchecked false. Existing false values remain false. Required checkboxes cannot be cleared.

### Selecting Target Records

- Filters compare a target field with a literal, a source Before/After value, or a resolved expression value. Support nested AND/OR/NOT expressions with visible grouping, using the same condition model as triggers and lookups.
- Two references to the same catalog compare referenced record IDs, not displayed names. References to different catalogs require an explicit mapping. A text label does not implicitly equal a reference ID.
- The initial default is creation time descending (newest first), consistent with the existing record list. First match uses the same order as the form's default listing. Equal timestamps use the same stable creation-order tie-breaker in both paths. Custom automation sorting is deferred until needed.
- All matches means the complete matching set, not the first page of the record-query interface. Freeze the matching set at the start of an action. Exceeding a documented execution limit must fail explicitly, never silently truncate.
- No-match behavior is configurable: Skip and report, or Fail the operation. It must be visible in the execution result. An optional future create-if-missing branch must be explicitly configured; updating does not silently create records.
- Intentionally selecting every record is an explicit selection mode. Missing or invalid filters are not interpreted as permission to modify everything.

### Formula Value Sources

The automation formula dialog selects a table and a record scope before selecting a field:

| Scope | Meaning |
| --- | --- |
| Trigger record, After | The saved values of the event's source record, including recalculated fields; default for create/update |
| Trigger record, Before | Values before the update or deletion |
| Current target record | Each matched target's values immediately before the current action |
| Another record | A referenced record or a lookup with explicit filters and a unique/ordered-first selection |
| Aggregate | An explicitly selected SUM, COUNT, MIN, or MAX over a filtered record set |

A multi-record lookup cannot be placed in a scalar expression without a selector or aggregate. Missing lookup results produce an empty value or the explicitly selected fallback; a failed required mapping is an error.

All assignments within one action evaluate against its initial snapshot, so column order cannot change the result. Each target in an All matches update uses its own prior values. Later action steps can read results of earlier steps in the same transaction. Trigger Before/After snapshots stay fixed throughout the run. Deleted records are available through Before, not through a query for a current record.

## Example: Receipt Updates a Material Balance

Assume receipt and balance rows both reference the same Materials catalog.

```text
Source form: Goods Receipts
Trigger: Record created
Target form: Material Balances
Action: Update records
Filter: Target.Material = Trigger.After.Material
Matches: First, with a unique Material constraint
Assignment: Target.Quantity = Target.Quantity + Trigger.After.Quantity
No match: Fail the operation
```

Companion rules are necessary if the source remains editable:

- Quantity changes for the same material: add After.Quantity - Before.Quantity.
- Material changes: subtract Before.Quantity from the old material and add After.Quantity to the new material, within one transaction.
- Receipt deletion: subtract Before.Quantity, only when the business meaning of deletion permits reversing that receipt.
- Editing an unrelated note must not add receipt quantities again; watch the relevant fields or use a change condition.

These rules demonstrate generic form behavior. The existing Inventory Stock summary is a derived, read-only view, not an ordinary balance form. Its integration should post stock movements and derive balances through the inventory module; generic automation cannot bypass existing posted-stock protections. The receipt example also does not remove the planned requirement to verify or approve actual receipts before inventory posting.

## Shared Execution and Interface Contract

All entry points must use the same mutation path: browser editing, Agent calls, spreadsheet imports, meeting extraction commits, supplier document commits, and automation actions.

The common execution sequence is:

1. Validate the initiating request, schema/record versions, and idempotency identity.
2. Normalize input, evaluate the form's field formulas for affected records, validate constraints, and capture Before/After.
3. Evaluate enabled rules in deterministic order; select target records and calculate assignments.
4. Apply action steps through the same mutation path, collecting changes and dependent events.
5. Commit the complete local operation atomically, then deliver notifications. If any required step fails, roll back the initiating write and all dependent writes.

This transaction contract covers local data operations. A remote AI step creates a durable queued task as part of the local commit. Model processing runs afterward; its validated result is applied through a separate atomic local operation. The source write is retained if the later AI request fails. This distinction is detailed in the related AI-task design.

Each run records the root event, rule version, action order, matched record IDs, before/after changes, skipped actions, and failure details. The interface returns the initiating result plus a complete change summary or a run identifier to inspect the full result. Failed-run diagnostics are recorded separately from rolled-back business changes.

Errors are exposed in a dedicated space-level Error Center, including formula failures, invalid assignments, missing required matches, cyclic automation, stale results, and AI execution failures. Error rows link to the relevant form, record when it exists, rule/task, and failed step.

Root write retries reuse the same idempotency identity and cannot apply an increment twice. A retry with different contents is a conflict. Independent events that update one balance must not overwrite each other's increments. Record versions and transactional execution protect the update.

Rules execute in explicit order, with stable IDs as tie-breakers. Downstream events are processed in a deterministic queue. A rule cannot repeatedly revisit the same source record along one event's ancestor chain; execution depth and affected-record limits also stop loops. This is not a transaction-wide visited set: independent receipt rows in one import may legitimately update the same balance. A detected cycle fails the whole operation with an explanation instead of silently discarding part of it.

Existing form and record interfaces remain the entry points for business data. Proposed additions expose:

- Formula definitions as number-field metadata in form schemas.
- Automation rule discovery, creation, editing, enabling/disabling, and deletion.
- A dry run using a selected source record or proposed create/update/delete payload, showing all affected forms and records.
- Run details and field-dependency information for configuration and troubleshooting.

Agent tools must discover these same capabilities. Review mode previews the entire cascade and saves no business changes or real notifications. Approval revalidates source and target data, rules, formula/schema versions, lookups, and the complete filter match set, including newly matching rows. A changed dependency requires a fresh preview. Full access applies the same validated operation immediately.

## Field Dependencies

If any reference field targets a field, that dependency must be removed before deleting the target field. Emptying all referencing cells is not enough because the reference field definition still exists. Changing or removing the dependent field's reference configuration also removes that dependency. Field renaming and reordering preserve stable IDs.

Formula operands, trigger conditions, filter conditions, lookup definitions, and action assignments are also dependencies. Deleting or incompatibly changing a field lists the dependent configurations and requires their references to be removed or revised first. Merely disabling a rule does not make its stored field references valid after deletion.

Record-level reference constraints are separate: deleting a referenced record requires removing the actual referring values; it does not require deleting unrelated reference columns.

## Verification Targets for Implementation

- Formula chains, renaming/reordering, empty input, circular dependencies, and invalid arithmetic.
- Create/update/delete events from every write entry point, including private meeting-import insertion paths.
- Clear versus Keep versus zero/false, required constraints, and calculated output protection.
- Nested AND/OR/NOT filters, first/all selection, creation-time ordering, no match, and matches beyond one query page.
- Reference identity comparisons and arbitrary-table lookups with explicit row selection.
- Receipt create, quantity adjustment, material reassignment, and deletion without duplicate increments.
- Cascade rollback, concurrent increments, repeat requests, and cycle handling.
- Agent preview/approval with changed target values, rule versions, and newly matching records.
- Schema formula recalculation without replaying ordinary business automations.
- Reference, formula, and automation dependency protection on field deletion and type changes.
- Same-space enforcement for targets, lookups, references, and Agent operations.
- Error Center entries survive business rollback and provide the correct retry or correction path.
