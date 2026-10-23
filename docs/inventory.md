# Inventory Management

> Historical prototype only. The recipe/purchase inventory module and the routes below
> are retired and no longer loaded. Use [Warehouse Management](warehouse.md) for the
> active system. Source is retained in `future/cross-form-automation/`.

The module runs in the existing application on **http://127.0.0.1:5174**. No new dependency or external AI call is required for inventory calculations.

## Tables and Views

Opening Inventory Management creates four ordinary, initially empty custom tables without replacing existing orders:

| Table | Core fields | Purpose |
| --- | --- | --- |
| Materials | Material SKU (unique), name, stock unit, reorder level | Raw-material identity and base unit |
| Products | Product code (unique), name | Products sold on orders |
| Recipes | Product reference, material reference, quantity per product | Material requirements for one product |
| Purchases | Purchase line number (unique), material reference, quantity | One material per purchase line, with optional supplier/date/notes |

These tables support ordinary record editing, spreadsheet import, references, custom additional fields, and the existing Agent CRUD operations. Core field IDs, types, references and required/unique constraints are protected; labels and table names may be changed. Do not add another stock-unit interpretation to a material with stock history.

**Stock movements** is a read-only ledger with an explicit **In / Out** field, positive quantity, unit, timestamp, source-record link and note. **Stock summary** is a read-only computed view of each material's total in, total out, on-hand quantity and reorder level. Both support search, filtering, refresh and CSV export. They are not editable custom tables; changing a balance directly would bypass the ledger.

## Purchase to Stock

1. Add a material and choose its stock unit, such as `kg`.
2. Create or import a purchase line using its material reference and quantity in that unit.
3. Click the row's **Receive purchase** icon.
4. Review the quantity and before/after balance, then select **Confirm receipt**.

Creating a purchase draft or importing its rows does **not** establish physical receipt or increase stock. Confirmation posts one inbound movement. Repeating a request does not receive it twice. The first version receives a purchase line in full; split a delivery into separate unique purchase lines when needed.

Goods Receipts and supplier-recognition records do not post inventory by default. Configure a **Record created > Receive stock** automation on the chosen receipt form to receive automatically. Select Materials as the stock form, map its material name/SKU and receipt quantity/unit, and supply the other required new-material values. The operation matches or creates a material and writes an inbound ledger entry atomically. It is also available for custom stock tables with a numeric balance field. See [Receive Stock](workspace-automation.md#receive-stock).

Choose one receipt source per physical delivery. The same source record cannot have two active postings, but separate purchase and goods-receipt records are not automatically identified as the same delivery. Document reconciliation does not automatically approve or post inventory. Existing records and later approval-field edits are not retroactively posted by a Created rule.

## Order to Material Issue

1. Create a product and its material recipe lines.
2. Use the product's exact unique code, exact name, or a Products reference in the order.
3. Set its ordered quantity and click the row's **Issue order stock** icon.
4. Review all calculated material issues, then select **Confirm issue**.

The default Orders table automatically maps `item` and `quantity` when inventory is initialized. For other order tables, use the settings icon on Stock summary or Stock movements to map a product field and numeric quantity field. Product codes match case-insensitively and take precedence over names; ambiguous names are rejected. Product references use stable record IDs.

For example, these are illustrative quantities, not a food-production recommendation:

| Material | Recipe per bread | Order of 30 breads |
| --- | --- | --- |
| Flour | 0.1 kg | 3 kg Out |
| Sea salt | 0.002 kg | 0.06 kg Out |
| Butter | 0.02 kg | 0.6 kg Out |

The issue is all-or-nothing. If any ingredient is short, confirmation is disabled and the server rejects posting without deducting any ingredient. Merely creating an order or changing its Completed dropdown does not issue stock. Existing orders are never retroactively deducted.

## Corrections and Counts

Use **Stock adjustment** for an opening count, found stock, waste or loss. A material, In/Out direction, positive quantity and reason are required.

Use a movement row's **Reverse entire stock posting** icon for a correction. Reversal adds equal opposite movements; it never removes the original ledger. A multi-material order is reversed as one operation. A purchase cannot be reversed if doing so would make stock negative. A reversal cannot itself be reversed.

Active posted source material/product/quantity fields are locked. For manual purchase/order posting, reverse first, edit the source, then post a new preview. For an automatic Receive stock action, reverse from **Run history > Run details > Stock receipt**, then create a corrected replacement receipt; updating the original does not repost it. Other fields, such as an order's completion status, remain editable. Records with ledger history cannot be deleted, even after reversal. Recipe edits affect future postings, not quantities already recorded.

## Consistency and Limits

- Decimal.js calculates quantities with 40-digit precision; input quantities are positive, at most `1e12`, with up to six decimal places. Reorder levels may be zero.
- Each material uses one base unit. There is no automatic kg/g, pack/piece, currency or density conversion.
- Duplicate product/material recipe pairs are rejected. An order supports up to 100 recipe materials.
- Every confirmation rechecks its preview against current source records, recipe, relevant stock balances and field schemas inside one SQLite transaction. A changed preview must be regenerated.
- Idempotency keys prevent retry duplication, and an active source record can have only one purchase/order/automatic-receipt stock posting.
- Existing validation, references, record history, Agent approvals and spreadsheet-import constraints still apply to the editable tables.
- This version has no warehouse locations, reservations, partial issues/receipts, lots, expiry dates, valuation, nested recipes, scheduled purchasing or automatic reorder notifications.

## Local HTTP Interface

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/api/inventory` | Tables, mappings, summary, movements and active source postings |
| POST | `/api/inventory/tables` | Idempotently initialize the four editable tables |
| PUT | `/api/inventory/mappings` | Save `{formId, itemField, quantityField}` for an order table |
| POST | `/api/inventory/preview` | Calculate an order, purchase, adjustment or reversal without posting |
| POST | `/api/inventory/post` | Revalidate and post using `previewToken` and `idempotencyKey` |

Order/purchase previews take `{kind: "order" | "purchase", sourceId, note?}`. Reversal takes `{kind: "reversal", sourceId: postingId, note}`. Adjustment takes `{kind: "adjustment", materialId, direction: "In" | "Out", quantity, note}`. Send the same arguments plus the returned preview token and a fresh idempotency key to confirm; retry the identical request with the same key after a connection failure.

The inventory HTTP routes above are local workspace administration and reject Agent tokens. Agent CRUD writes can trigger configured Receive stock rules and their ledger effects; `list_stock_receipts`, `get_stock_receipt` and `reverse_stock_receipt` expose receipt inspection and reversal through the [Agent API](agent-api.md). Writes retain review/full-access rules, idempotency and source locks. Agents cannot directly edit a computed ledger balance. Authentication and multi-tenant ownership remain separate work.
