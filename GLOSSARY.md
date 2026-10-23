# Releaf

Releaf organizes custom operational forms and a fixed warehouse system. UI and Agent share catalog maintenance, document approval and stock-posting workflows; older supplier and customizable cross-form prototypes are archived.

## Language

### Forms and Workflows

**Space**:
A named collection of forms, navigation nodes, and workflows that belong together. Cross-form operations select forms within the same Space.

**Node**:
A named navigation container that can contain child nodes and forms. It organizes the Space without holding business records of its own.

**Calculated Field**:
A numeric form field governed by a formula defined once for the form and applied to its records. The formula selects form fields, with explicit scope for any cross-record calculation.
_Avoid_: Macro

**Automation Rule**:
A configurable cross-form rule preserved in the future-direction prototype, not an active warehouse feature. Active warehouse relationships are fixed business logic.

**Trigger Record**:
The record whose creation, modification, or deletion starts an automation rule.

**Target Record**:
A record selected for an automation action; one action may select one or many target records.

**Set Empty**:
An update assignment that empties a selected field while retaining the record and its other values.
_Avoid_: Delete record

**Delete Record**:
An action that removes the entire record from a form's active records.
_Avoid_: Set empty

**AI Task**:
A configured data-processing task that defines selected inputs, processing instructions, expected output, and how validated results are used in forms.

**Error Center**:
The Space's view of failed processing and automation attempts, their causes, and the available correction or retry actions.

### Warehouse

**Product**:
A catalog record identifying a SKU independently of warehouses, with a unique code, name and unit. Document lines reference this record even before any stock exists.
_Avoid_: Stock record

**Stock Record**:
The balance and minimum-stock settings for one product in one warehouse. Current quantity derives from opening quantity and posted movements.
_Avoid_: Product

**Warehouse Request**:
An inbound or outbound document with one warehouse, applicant, approver and product lines. A submitted or approved request has no stock effect until posting.
_Avoid_: Stock movement

**Posting**:
The atomic confirmation of a whole approved document that creates immutable movements and recalculates stock. Reversal records opposite movements without erasing history.

**Catalog Workflow**:
The controlled entry point for registering or updating products, warehouses and stock settings. Unlike warehouse requests, catalog maintenance applies immediately without a separate business-approval document.

**Import Batch**:
A matched spreadsheet plan containing one or more warehouse requests. Preview validates the complete plan; execution commits all requests atomically and rejects stale or duplicate plans.

### Archived Supplier Reconciliation

**Goods Receipt**:
An internal record of goods actually received by the enterprise, as recorded by its staff. It is distinct from the supplier's claim about goods delivered or billed.

**Supplier Document**:
A supplier-issued document describing goods delivered or billed. It does not by itself establish what the enterprise actually received.

**Reconciliation Result**:
A comparison of internal goods receipts and supplier-stated details for a defined scope, identifying agreements, discrepancies, and unresolved matches.
