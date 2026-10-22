# Supplier Reconciliation and Spreadsheet Import

## Workspace

**Supplier Reconciliation** contains **Goods Receipts**, **Supplier Documents**, **Document recognition**, and **Reconciliation results**. The two default tables are created on first entry, not during database migration. Existing orders and meeting data are not replaced.

Each table row is an item line. `Receipt line ID` / `Document line ID` is unique; the order reference is not unique, so an order can have several receipt batches and document lines. Receipt numbers and supplier document numbers may repeat across lines. Both tables use the ordinary record editor, field builder, history, references, and existing Agent table/record API.

The default order reference targets the first Order Management table with a unique scalar field, preferring `orderNumber`. Verify the target in table settings if the workspace has multiple order tables.

## Record Receipts

Staff enter the receipt number, received date, supplier, related order, item code, quantity, and unit. A unique receipt-line identifier is required. Optional descriptions and notes provide context.

Use the spreadsheet icon in any table's toolbar to import XLSX or UTF-8 CSV. The same import is available across all modules.

## Recognize Supplier Documents

1. Configure the workspace AI provider with an image-capable, compatible Chat Completions model supporting strict JSON schema. The Assistant's separate provider is not used.
2. Choose a PDF, JPG/JPEG, or PNG file up to 5 MB. PDFs support up to six pages. Browser-side PDF.js renders all pages; image inputs are resized to a maximum long edge of 1,500 pixels.
3. Inspect the page thumbnails; click a thumbnail to enlarge it.
4. Run recognition and review the proposed item lines, source transcription, page number, order link, quantities, and units.
5. Correct missing or inaccurate fields and save selected lines. Required, unique, and reference rules are applied on the server.

Recognition stores a draft and the original source file, but creates no business records until confirmed. **Recent recognition** reopens drafts and saved results after refresh. Schema changes invalidate unconfirmed drafts. Source files remain downloadable from recognition results and the saved record editor.

The model's source transcription is evidence for human review, not a verified quotation or proof of receipt. Missing fields are left blank. Unreadable pages, unsupported vision/JSON features, refusals, and incomplete responses return an error without creating business records.

Re-saving the same draft is idempotent. A previously committed file is rejected. Recognition confirmation also checks for an existing supplier + document type + document number, case-insensitively, to avoid importing another scan of the same document. Several lines from the same new document can be saved together. To correct a saved document, edit its existing rows instead of re-importing it. Ordinary manual edits and generic spreadsheet imports do not enforce a global composite document-number constraint.

Keep the original unique text field `Document line ID` for recognition. Additional fields are included in the recognition schema and editable review form.

## Compare Selected Data

1. Choose the source tables and one supplier document type: Delivery note, Invoice, or Statement.
2. Select the receipt and document lines belonging to this comparison. Default selection includes all visible source lines, so inspect the scope before running.
3. Adjust **Field mapping** when imported/custom tables use different fields. Map order, item, quantity, unit, and supplier on both sides, plus the document-type dropdown on supplier lines.
4. Run the comparison and inspect the saved result.

Both order fields must reference the same unique order field. Matching uses the stable order record ID plus item code, supplier, and unit. Text matching trims whitespace and ignores case; there is no fuzzy supplier/item matching, synonym dictionary, or unit conversion.

Quantities aggregate only across the explicitly selected lines. Decimal.js is used for quantity totals and subtraction. Difference means supplier-stated quantity minus internally received quantity. Missing-side quantities are shown as blank, not fabricated zero observations.

Outcomes are Matched, Quantity mismatch, Missing receipt, Missing document, and Needs review. Different units for the same order/item/supplier are flagged for review. Missing matching values and negative quantities are not automatically reconciled; returns require separate review.

This release compares quantities, not agreed prices, tax correctness, payment obligations, or supplier performance. Unit price/currency can be recorded but are not validated against contracts. The workflow does not rewrite orders or send claims to suppliers.

## Review Results

Every result links back to its order and selected source rows. Open the review icon to set Open / In progress / Resolved and record a note. Computed quantities and differences are not editable.

Comparisons retain source record/schema snapshots. Editing or deleting a selected source, or changing either source schema, marks a result out of date and blocks further resolution until a new comparison is run. New rows outside the selected scope do not alter an existing comparison. Old comparisons remain available in history.

Export results using the download icon. The CSV includes quantities, outcomes, reasons, status, and notes; text that could become a spreadsheet formula is escaped.

## Shared Spreadsheet Import

Choose **Existing table** to append records using column mapping, or **New table** to create a table in a chosen module. Choose the worksheet and header row. For new tables, edit the inferred field names/types, required/unique rules, dropdown options, and reference targets before previewing.

Preview shows the first 25 rows and up to 50 row-error details; all rows are validated. Confirm only when all rows are valid. The entire import commits atomically and appends records; there is no overwrite/upsert mode.

Limits: 5 MB, 10 worksheets, 40 columns per sheet, 1,100 source rows including headers, 1,000 imported data rows, and 5,000 characters per cell. Blank data rows are skipped. Legacy `.xls`, macros, external-link execution, and automatic formula evaluation are not supported. Formula cells need a saved cached result. Merged cells and multi-row headers are not reconstructed; use a flat header row and inspect the mapping.

Text identifiers retain leading zeros; simple Excel all-zero numeric formats are preserved. CSV numeric-looking text is conservatively treated as text until a numeric field is selected. Numeric fields reject currency/thousands separators. Dates must resolve to ISO dates or Excel date cells. Blank values and numeric zero are distinct.

References resolve source values against the target table's unique field, not against record UUIDs. Unknown references produce row errors; no orders are silently created. Required/type/unique/reference checks run during preview and again at confirmation. Existing-table schema changes require a fresh preview. Repeated confirmation is idempotent, and previously committed identical rows for the same destination are rejected.

## Local HTTP Endpoints

These workflow endpoints are local workspace administration routes, not externally token-authorized Agent routes. Existing Agent endpoints can still query/edit the underlying custom tables with their normal approval policies.

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/api/imports/parse` | Parse `{file: {name, data}}`; `data` is base64 |
| POST | `/api/imports/preview` | Validate rows, destination schema and column mapping |
| POST | `/api/imports/{id}/commit` | Confirm a stored table-import preview |
| POST | `/api/suppliers/tables` | Ensure the default receipt and document tables |
| POST | `/api/suppliers/extract` | Recognize original file plus rendered page images |
| GET | `/api/suppliers/drafts` | Recent recognition drafts/results |
| GET | `/api/suppliers/drafts/{id}` | Reopen a recognition draft/result |
| POST | `/api/suppliers/drafts/{id}/commit` | Save selected corrected lines |
| GET | `/api/suppliers/files/{id}` | Download the original source file |
| GET / POST | `/api/reconciliations` | List saved comparisons / run a new comparison |
| GET / PATCH | `/api/reconciliations/{id}` | Read result / save a row's status and notes |

Source files, recognition drafts, import previews, and comparison snapshots are retained in local SQLite without an automatic expiry/deletion policy. Original document images and relevant reference identifiers are sent to the configured external provider. Use synthetic or appropriately authorized/de-identified data during testing; do not share the database.
