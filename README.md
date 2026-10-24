# Releaf

The warehouse module provides a product catalog, stock, linked inbound/outbound documents and two fixed approval workflows. Its seven tables are read-only for members; administrators can maintain them within protected business constraints. UI and Agent use shared catalog/document workflows, including XLSX/CSV matching and atomic batch execution. See [warehouse guide and API](docs/warehouse.md). The former customizable cross-form automation is preserved separately as a [future-direction prototype](future/cross-form-automation/README.md), and is disabled in the active application.

An English/Chinese SME workspace with independent order management, warehouse workflows, meeting-to-task import, custom forms and a review-first Agent API. The former order, supplier and recipe/purchase prototypes are retired. The new order module keeps product details in notes and runs independently of inventory. The new Meeting Tasks Space replaces the archived meeting prototype without re-enabling its legacy endpoints. Use the [current user guide](docs/user-guide.md) and [form deletion guide](docs/form-deletion.md) for the active product.

This is a working local prototype for SDC Hackathon Domain 2. The application currently displays **Form Studio** as its workspace name. Competition documents, sponsor-platform evidence, and deployment are still in preparation; see the [submission checklist](submission/README.md).

## Team Information

| Field | Details |
| --- | --- |
| Project | Releaf |
| Team name | Pending confirmation; project and team names may differ |
| Domain | Domain 2 |
| SDG track | Pending confirmation; no impact measurement has been completed |
| Team leader and members | Pending confirmation |
| University | Xiamen University Malaysia; confirm all members' affiliations |
| Number of members | Pending confirmation |

## Links

| Resource | Status |
| --- | --- |
| Repository | https://github.com/sjq98/Releaf |
| Local application | http://127.0.0.1:5174 after starting the server |
| Replit project | Pending; no Replit project URL supplied |
| Live demo | Pending; local application only |
| RunPod endpoint | Pending; no RunPod integration or usage evidence supplied |
| Slide deck | Pending |
| Demo video | Pending |

## Overview

### Problem

Small businesses often track stock and warehouse requests in disconnected spreadsheets. Draft requests can be confused with completed movements, and manual updates can leave quantities, document lines and approval status inconsistent.

### Solution

Releaf connects stock, warehouse documents and their detail lines through fixed approval and posting workflows. Only posted documents change stock; shortage checks and reversals preserve ledger consistency. A floating assistant and independent Agent tokens use the same business validations as the UI. Custom forms, spreadsheet import, typed AI tasks and field-level history support additional work without bypassing warehouse rules.

The sustainability hypothesis is that reliable stock visibility could reduce avoidable over-ordering and waste. Environmental benefits, an SDG sub-target, a baseline, and an impact target must still be established and measured.

### Key Features

- Fixed warehouse stock, linked inbound/outbound documents and two approval workflows.
- Inventory analysis dashboard with monthly receipt/issue curves, live stock alerts, monthly balance/turnover reports and matching read-only Agent queries.
- Independent order Space with real Orders, Payment confirmations and Invoices forms, pending AI intake, manual amount review, paid-in-full confirmation and pickup/delivery workflows. See [orders](docs/orders.md).
- Optional administrator-only WhatsApp read bridge: explicitly selected chat, bounded message preview, source deduplication and review-first Agent imports. No message sending or automatic receipt/invoice confirmation. See [bridge setup](docs/whatsapp-bridge.md).
- A separate Meeting Tasks Space: paste or import a UTF-8 TXT/Markdown summary and extract actionable commitments directly into the Tasks table, with source quotes, meeting history and duplicate protection. See [meeting tasks](docs/meeting-tasks.md).
- Local accounts with administrator/member roles, authenticated approval identities and owner-bound Agent tokens.
- Separate product catalog, protected warehouse writes, spreadsheet batch matching and assistant file uploads.
- Nine field types, including same-Space references and image/PDF attachments, with required/unique constraints.
- Automatic history for record creation, field changes, and deletion.
- Reference fields that link directly to records in another table.
- AI provider settings with upstream model discovery; manual workflows work without an AI key.
- Floating chat assistant with its own provider configuration, tool calling, change previews and optional full access.
- Separate, revocable Agent tokens and a documented API for custom table/record operations, filtering and schema editing.
- Shared XLSX/CSV import: create a table or append records with field mapping, validation, preview and confirmation.
- Stock posting, shortage checks, immutable movements and guarded reversals.
- Custom form deletion with impact preview, explicit confirmation and dependency protection, shared with Agent tools.
- Spaces with nested Node/Form navigation, persisted drag sorting and whole-subtree moves, independently of business bindings.
- Calculated numeric fields with a visual formula editor, decimal arithmetic, dependency checks and automatic recalculation.
- Same-form notification rules; custom cross-form event automation is archived.
- Saved trigger-condition tiles with validated Boolean expressions, plus instant English/Chinese UI switching that preserves custom names, values and unsaved inputs.
- Cascade-aware Agent and spreadsheet previews; atomic local rollback, version checks, execution limits and idempotent writes.
- Error Center with source/category/date/status filters, failed-step details, retry, resolve and ignore.
- Configurable asynchronous AI tasks with selected inputs, typed output fields, mappings, review/automatic writeback and stale-input protection.

This is an independent prototype, not yet integrated with Orbyte APIs or Orbyte authentication. Scheduled reminders, production planning, billing and public multi-user deployment are not implemented. Old business modules are no longer loaded or served; their source remains only in the independent future-direction snapshot.

## How to Run

Requires Node.js **22.13.0 or later** and npm. No Python, GPU, or external database is needed for the local application.

On Windows, double-click `start-server.bat` or run `.\start-server.bat` in PowerShell. It switches to the project directory, installs missing dependencies, and starts the server. Keep its window open while using the app; press Ctrl+C to stop it. Startup errors stay visible.

```powershell
git clone https://github.com/sjq98/Releaf.git
cd Releaf
npm.cmd ci
npm.cmd start
```

Open **http://127.0.0.1:5174**. In a POSIX shell, use `npm` instead of `npm.cmd`.

The first launch creates `data/forms.sqlite` and a generic **New form**. On the sign-in screen, create the first administrator with a username, display name and password of at least **12 characters**. There is no default password. Subsequent visits require sign-in. An administrator can add accounts, change roles, disable accounts and reset passwords under **Account > Manage users**; all users can change their own password or sign out. Sessions expire after seven days, and password/role/active-status changes invalidate that user's existing sessions.

Administrators manage forms, fields, records, product/warehouse catalogs, stock settings, navigation, AI settings and users. Members read tables and the dashboard and use warehouse request workflows, including approval when assigned; they cannot edit table schemas, maintain catalog records or use generic record CRUD. Use **Warehouse workflows > Set up warehouse** as an administrator to install the warehouse system in a Space. Local data and credentials are excluded from Git. Deleting the last form does not regenerate a template. See [account and workflow details](docs/user-guide.md).

Select the **Order management** Space to use its three shared forms and fixed workflows. AI intake saves a pending order and one linked unchecked payment confirmation; a person reviews the order and enters the amount, then checks **Paid in full** after checking the actual wallet receipt. Invoices are registered manually. Members manage their own orders; administrators manage all orders and schemas within protected rules. Orders do not reserve or move inventory. An administrator can open **WhatsApp** for optional local connector setup and explicit selected-chat import; the app never connects or reads messages automatically.

Open **Inventory analysis** for stock alerts and six-month reports. Optional synthetic demo data and its backup-first command are documented in the [dashboard guide](docs/inventory-dashboard.md).

On Windows, you can also double-click `start-server.bat`, which fixes the port to **5174**. Use this port for local development and verification. If it is occupied, use the existing Releaf server or stop that server before restarting; do not launch another development server on a different port.

### Configure AI

As an administrator, open **AI settings**, enter the provider name, API base URL and key, click **Fetch models**, choose a model, and save. The provider must support model discovery and strict JSON-schema Chat Completions.

Alternatively, copy `.env.example` to `.env` and fill in `AI_API_KEY` and `AI_MODEL`. The server loads that file on startup. Saved database settings take precedence. API keys stay server-side, but the local database stores them without encryption.

See the [user guide](docs/user-guide.md) for configuration, limits, references, record history, and the HTTP API.
See the [warehouse guide](docs/warehouse.md) for fixed inbound/outbound workflows and their shared Agent API. The [workspace automation guide](docs/workspace-automation.md) retains earlier design context; customizable cross-form execution is now archived.

The floating **Assistant** has separate administrator-managed provider settings in its header. Choose a model that supports compatible function/tool calling. **Review first** is the default; writes wait in **Approvals**. **Full access** requires explicit confirmation and never overrides the user's role or business approval checks. Use the header's key icon to create separate Agent access tokens, bound to the signed-in account and selected Space. See the [Assistant and Agent API guide](docs/agent-api.md) for endpoints, OpenAPI discovery, idempotency and deployment limits.

### Tests and Development

```powershell
npm.cmd test
npm.cmd run dev
```

Tests use in-memory or temporary databases and mock provider responses. They do not verify a live AI service, sponsor usage, or Orbyte integration.

Automated verification uses mocked AI providers and isolated data; browser checks cover desktop and mobile. The suite also retains explicitly archived prototype regression tests. Run `npm.cmd test` for the current summary. A passing suite is not a production-security certification or verification of a live model provider.

## Project Structure

```text
.
|-- src/                    # HTTP server, SQLite store, field types and AI integration
|-- public/                 # Browser UI and local styling
|-- tests/                  # Node test runner suites
|-- docs/                   # Architecture, user guide and submission requirements
|-- future/                 # Independent historical prototypes, not loaded by the app
|-- scripts/                # Backup-first local maintenance
|-- examples/               # Historical synthetic sample input
|-- submission/             # Submission checklist; final PDFs are pending
|-- start-server.bat        # Windows launcher fixed to port 5174
|-- GLOSSARY.md             # Business terminology and historical design context
|-- .env.example            # Configuration names without credentials
|-- .gitignore
|-- LICENSE
|-- package.json
|-- package-lock.json
`-- README.md
```

`data/`, `output/`, and `.playwright-cli/` are local runtime/verification directories and are not committed.

## Architecture and Tech Stack

Browser HTML/CSS/JavaScript -> authenticated Node.js HTTP API -> local SQLite. Fixed warehouse transitions reuse shared CRUD, transactions, reference validation and change history; they do not call the archived configurable cross-form engine. Stock checks use decimal arithmetic and immutable movements. Configurable AI tasks send selected inputs to a provider and validate typed outputs before writeback. The assistant uses an independently configured provider and shares approval-aware operations with external Agents. Spreadsheet parsing uses a bounded worker.

| Layer | Implementation |
| --- | --- |
| Frontend | HTML, CSS, native JavaScript modules, Lucide icons 1.60.0 |
| Charts | Locally served Chart.js 4.6.1 |
| Backend | Node.js standard library, native HTTP server |
| Storage | Node.js built-in SQLite |
| Import / documents | ExcelJS, csv-parse, PDF.js; Decimal.js for quantity arithmetic |
| Rules / formulas | Restricted jsep expressions, Decimal.js arithmetic, fixed warehouse transactions and same-form notifications |
| AI | Configurable compatible provider; no model bundled |
| Hosting | Local loopback server at present |
| Testing | Built-in Node.js test runner |

See [architecture](docs/architecture.md) and the [technical inventory](docs/technical-inventory.md).

## How We Use Replit

Pending. This repository does not yet establish actual Replit usage or include its proof PDF. The organizer's online template marks this platform and proof of use as required; confirm any domain-specific exception with the organizer.

## How We Use RunPod

Pending. The current prototype calls a configurable AI API and has no RunPod-specific client or serverless handler. Do not treat a compatible API URL alone as proof of RunPod usage.

## Challenges and Learnings

The implementation keeps record IDs stable when labels change, validates schema edits against existing records, and validates AI output before it can become business data. Agent writes share the same constraints as manual edits and detect stale approvals. Warehouse documents and lines stay synchronized; posting and reversal run atomically. Form deletion checks dependencies and requires explicit confirmation without erasing local history.

## Future Improvements

- Confirm team information, SDG sub-target, and quantitative impact baseline.
- Validate the workflow with an SME and measure a relevant process KPI.
- Confirm Orbyte integration access and implement an agreed interface.
- Complete required sponsor-platform usage and collect genuine evidence.
- Prepare judge-accessible deployment, slides, demo video, and signed PDFs.

The server binds to `127.0.0.1`. Browser APIs require a login session; external Agent endpoints require a token and enforce its owner's current role. Accounts share the local workspace rather than isolated tenants. Judge-facing cloud deployment still needs tenant ownership boundaries, TLS, a deployment-specific Host/proxy policy and production secret storage before exposure.

## Team

The team roster has not been supplied. Replace this placeholder with one row per confirmed member before competition submission.

| Name | Role / contribution | GitHub |
| --- | --- | --- |
| Pending confirmation | Pending confirmation | Pending confirmation |

## Submission Checklist

This GitHub update preserves the current prototype; it is not the final competition submission.

- [ ] Confirm team roster, leader, contacts, domain and SDG track.
- [ ] Complete and sign `submission/SDC2026_TeamName_Preliminary.pdf`.
- [ ] Complete and sign `submission/SDC2026_TeamName_TechDeclaration.pdf`.
- [ ] Provide genuine `submission/SDC2026_TeamName_Replit_POU.pdf`.
- [ ] Provide genuine `submission/SDC2026_TeamName_Runpod_POU.pdf`.
- [ ] Add judge-accessible deployment, slide-deck and demo-video links.
- [ ] Verify sponsor-platform usage and any domain-specific exceptions.
- [ ] Complete final clean-checkout, credentials and artifact checks.
- [ ] Complete the organizer's submission step.

Replace `TeamName` with the confirmed team name. See [submission preparation](submission/README.md) and [requirements](docs/submission-requirements.md) for word limits, deadlines and unresolved items. Blank templates and sample platform proofs are not included as completed team deliverables.

## License

The repository retains its existing [Apache License 2.0](LICENSE). Third-party licenses remain applicable; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
