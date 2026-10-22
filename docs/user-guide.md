# Releaf User Guide

A local-first, English-language workspace for small business workflows, organized into **Order Management**, **Meeting Follow-up**, and **Supplier Reconciliation** modules. Create custom tables, manage records, link tables through unique fields, and turn meeting text into reviewable action items. See [Supplier Reconciliation and Spreadsheet Import](supplier-reconciliation.md) for shared Excel/CSV import, document recognition, and quantity comparisons.

## Requirements

- Node.js 22.13 or later (`node:sqlite` is used for persistent storage)
- npm

## Run

```powershell
npm.cmd install
npm.cmd start
```

Open `http://127.0.0.1:5174`. On Windows, `start-server.bat` also starts the application on port 5174. Keep local development and verification on this port; if it is occupied, use the running server or stop it before restarting. The default database is created at `data/forms.sqlite`; set `ORDER_DB` to choose a different path.

Use `npm.cmd` in PowerShell to avoid the Windows script-policy restriction on `npm.ps1`. No execution-policy change is needed.

The first launch creates an **Orders** table with Order number, Delivery time, Order item, Quantity, and Completed fields. Existing tables and data are preserved and placed under Order Management. New tables start with one required text field.

## Modules and table settings

- **Order Management** contains order tables and their record activity.
- **Meeting Follow-up** contains **Import meeting**, **To-do Items**, and any custom tables created in this module.
- Use the plus icon next to a module to create a table.
- Open a table's **Records** page and click the gear icon (**Edit table fields**) to edit its schema in a dialog. There is no separate Form builder sidebar page.

Each table has its own schema and records. Add, rename, reorder, and remove fields; choose whether each is Required or Unique. Supported types:

- Text
- Long text
- Number
- Date
- Date & time
- Dropdown, with editable options
- Checkbox
- Reference, targeting a unique, non-reference field in a different table

Field IDs are stable even when a field is renamed or moved. Required and unique constraints are enforced by the server. Text uniqueness is case-insensitive. Optional blank values are not indexed as unique values. A required checkbox must be checked. The system refuses schema changes that would invalidate existing active records, including incompatible type changes, newly required blank values, or duplicate values when enabling Unique.

Removed fields are hidden from the current schema, while stored record values and historical snapshots are retained. Deleted records are removed from the active list, their unique values are released, and their activity history remains.

### Reference fields

Choose **Reference**, then a target table and its unique field in the table settings dialog. Record inputs offer the target table's unique values. A reference cell is a link that opens the exact target record; the URL can also be opened in a new tab.

References store stable record IDs, not copied display labels. Renaming an order number updates the displayed label without breaking its links. Deleting a referenced record, clearing its referenced unique value, or removing/changing the target field is blocked until dependent references are removed. A table cannot reference itself, and reference fields cannot themselves be reference targets.

Field-type definitions, normalization, and validation are in `src/field-types.js`; browser input, cell, and link rendering are in `public/field-ui.js`. Business modules are defined in `src/modules.js`. All commands in this guide run from the repository root.

## Meeting Follow-up

1. Open **Import meeting**. The module creates its default **To-do Items** table on first use.
2. Enter the meeting title and date, then paste text or import a UTF-8 `.txt` file.
3. Click **Extract action items**. The server sends the current table schema and relevant reference candidates to the configured AI provider.
4. Review the candidates, edit values, select related orders, fill missing required fields, and exclude unwanted items.
5. Click **Save selected** to create records in one transaction. Extraction alone does not create records.

The default fields are Action item, Owner, Due date, Status, Acceptance criteria, and Related order. Related order is added automatically when an order table has an eligible unique field. The To-do Items table supports the same manual record editing and custom schema settings as Orders. Custom fields are included in future extraction requests.

The AI returns strict structured JSON, not executable SQL or application code. The server validates field names, values, dates, reference IDs, and verbatim evidence from the meeting. Unknown details remain blank for human review. Saved items retain their meeting title, date, and source quote. Retrying a completed import does not duplicate its records. If the table schema changes after extraction, re-extract the source against the new schema before saving.

### Configure an AI provider

Click **AI settings** in the top bar (or the sliders button on **Import meeting**). Enter a provider name, its OpenAI-compatible API base URL, and API key, then click **Fetch models**, choose a model, and save. The server loads models from `{base URL}/models`; saving checks the model list again. For example, OpenAI's base URL is `https://api.openai.com/v1`. Do not include `/models` or `/chat/completions` in the base URL.

Settings take effect immediately; no restart is needed. The saved configuration is stored in the local SQLite database and takes precedence over environment variables. When a key is already saved, leave the API key field blank to reuse it with the same base URL. The key is never returned to the browser, but it is stored without encryption in the local database; protect that file and do not share it.

Only OpenAI-compatible providers exposing `GET /models` and Chat Completions with `response_format: json_schema` and `strict: true` are supported. A model appearing in the provider's list does not guarantee it supports structured extraction; unsupported models will return an extraction error.

Environment variables remain available as a fallback when no saved settings exist:

```powershell
Copy-Item .env.example .env
notepad .env
npm.cmd start
```

Set `AI_API_KEY` and `AI_MODEL` in `.env`. `OPENAI_API_KEY` is also accepted if `AI_API_KEY` is absent. `AI_BASE_URL` defaults to `https://api.openai.com/v1`; `AI_PROVIDER_NAME` is optional. `npm.cmd start` and `npm.cmd run dev` load `.env` when it exists, and environment variables set in PowerShell take precedence. Restart after changing environment variables. This prototype does not silently fall back to unstructured text or simulated AI.

Alternatively, configure only the current PowerShell session:

```powershell
$env:AI_API_KEY = "your-provider-key"
$env:AI_MODEL = "your-supported-model"
# Optional: $env:AI_BASE_URL = "https://your-provider.example/v1"
npm.cmd start
```

Without AI configuration, manual table/record editing and references still work; extraction shows a configuration message. Automated tests use mock AI responses, not a live provider.

Limits: 40,000 characters per meeting, 160 KB per uploaded text file, up to 50 extracted items, up to 40 fields per table, and 500 reference candidates per extraction. Large reference lists and dropdowns are also checked against the provider's structured-schema enum limits. There is a 60-second AI request timeout.

**Privacy:** source meeting text, drafts, evidence, and records are stored in local SQLite. Clicking Extract sends the meeting text, field definitions, and relevant reference identifiers/unique values to the configured external AI provider. Do not submit confidential meeting text without permission.

## Activity

Record creation, field-level updates, and deletion are recorded automatically. Each changed field stores its label, type, previous value, and new value. Saving without changing values does not create an event. Schema edits themselves are not record activity events.

## HTTP API

All write requests use `Content-Type: application/json`.

- `GET /api/bootstrap?formId={id}` returns modules, tables, the selected table, records, activity, reference candidates, meeting import history, and AI configuration status (never the API key).
- `GET /api/ai/config` returns saved AI settings with a `hasApiKey` flag, never the key itself.
- `POST /api/ai/models` accepts `providerName`, `baseUrl`, and `apiKey`; returns model IDs discovered from the upstream provider.
- `PUT /api/ai/config` accepts those credentials plus a selected `model`; verifies the model upstream and saves the settings.
- `GET /api/forms` lists forms.
- `POST /api/forms` creates a table. Optional `fields` and `moduleId` (`orders`, `meetings`, or `suppliers`) may be supplied.
- `GET /api/forms/{id}` retrieves a form schema.
- `PUT /api/forms/{id}` updates its name and fields; include the current `version`.
- `GET /api/forms/{id}/records` lists active records.
- `POST /api/forms/{id}/records` creates a record; include `schemaVersion` and `values` keyed by stable field ID.
- `GET /api/forms/{id}/changes` lists activity.
- `GET /api/records/{id}` retrieves a record.
- `PATCH /api/records/{id}` updates a record; include `schemaVersion`, record `version`, and `values`.
- `DELETE /api/records/{id}` deletes a record; include record `version`.
- `POST /api/meetings/table` creates or returns the module's default To-do Items table.
- `POST /api/meetings/extract` accepts `formId`, `title`, `date` (`YYYY-MM-DD`), and `text`; returns a validated extraction draft.
- `GET /api/meetings/{id}` retrieves the draft, source text, and committed record IDs if saved.
- `POST /api/meetings/{id}/commit` accepts `items: [{ index, values }]` and atomically creates the selected records. `index` identifies the original extracted candidate.

Example record body:

```json
{
  "schemaVersion": 1,
  "values": {
    "orderNumber": "ORD-1001",
    "quantity": 12,
    "completed": "No"
  }
}
```

These endpoints are the local workspace interface. The server restricts administration to loopback connections and rejects cross-origin browser requests. There is no user login or tenant ownership, so do not expose it to an untrusted network.

## Chat Assistant and External Agents

Use **Assistant** at the bottom right. Its header has independent provider settings and Agent token management. The default **Review first** mode validates changes and displays an approval preview; **Full access** applies future changes without approval after explicit confirmation. The same field constraints and record history apply in both modes.

External integrations should use the separate Bearer-protected `/api/agent/` interface. It supports all custom forms, typed filters/pagination, record CRUD and schema creation/editing. Read the [Assistant and Agent API guide](agent-api.md) for configuration, endpoint details, idempotency, approval semantics, privacy and deployment limitations.

This is an independent prototype; it is not connected to Orbyte's APIs or authentication.

## Development

```powershell
npm.cmd test
npm.cmd run dev
```

The tests use in-memory or temporary databases and do not modify the default local data.
