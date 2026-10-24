# Releaf

The warehouse module provides a product catalog, stock, linked inbound/outbound documents and two fixed approval workflows. Its seven tables are read-only for members; administrators can maintain them within protected business constraints. UI and Agent use shared catalog/document workflows, including XLSX/CSV matching and atomic batch execution. See [warehouse guide and API](docs/warehouse.md). The former customizable cross-form automation is preserved separately as a [future-direction prototype](future/cross-form-automation/README.md), and is disabled in the active application.

An English/Chinese SME workspace with independent order management, warehouse workflows, meeting-to-task import, custom forms and a review-first Agent API. The former order, supplier and recipe/purchase prototypes are retired. The new order module keeps product details in notes and runs independently of inventory. The new Meeting Tasks Space replaces the archived meeting prototype without re-enabling its legacy endpoints. Use the [current user guide](docs/user-guide.md) and [form deletion guide](docs/form-deletion.md) for the active product.

This is Releaf's SDC Hackathon 2026 submission repository for **Domain 2 - Orbyte Smart SME Challenge**. The interface is branded **Releaf**. The [pitch deck](submission/SDC2026_Releaf_Pitch_Deck.pdf), [proposal](submission/SDC2026_Releaf_Preliminary.pdf), [technical declaration](submission/SDC2026_Releaf_TechDeclaration.pdf) and [Replit evidence](submission/SDC2026_Releaf_Replit_POU.pdf) are in `submission/`. See the [submission status](submission/README.md) for remaining factual checks; a GitHub push is not the organizer's portal submission.

## Team Information

| Field | Details |
| --- | --- |
| Project | Releaf |
| Team name | Releaf |
| Domain | Domain 2 - Orbyte Smart SME Challenge |
| SDG track | SDG 8; primary target 8.3, supporting target 8.2 |
| Team leader | Lin Jiarun |
| University | Xiamen University Malaysia |
| Number of members | 5, as declared in the supplied proposal |
| Contact | See signed PDFs; their leader email digits differ and require confirmation |

## Links

| Resource | Status |
| --- | --- |
| Repository | https://github.com/sjq98/Releaf |
| Local application | http://127.0.0.1:5174 after starting the server |
| Replit proof | [Own-account usage and project screenshots](submission/SDC2026_Releaf_Replit_POU.pdf) |
| Live prototype | https://releaf-prometheusjens.replit.app - page reachable; authentication configuration still being verified |
| RunPod endpoint | Not used; no team RunPod endpoint or proof supplied |
| Slide deck | [Pitch deck PDF](submission/SDC2026_Releaf_Pitch_Deck.pdf) |
| Demo video | https://youtu.be/8xv9_2mSclk - approximately 5 minutes 35 seconds |

## Overview

### Problem

Small businesses often track stock and warehouse requests in disconnected spreadsheets. Draft requests can be confused with completed movements, and manual updates can leave quantities, document lines and approval status inconsistent.

### Solution

Releaf connects stock, warehouse documents and their detail lines through fixed approval and posting workflows. Only posted documents change stock; shortage checks and reversals preserve ledger consistency. A floating assistant and independent Agent tokens use the same business validations as the UI. Custom forms, spreadsheet import, typed AI tasks and field-level history support additional work without bypassing warehouse rules.

Releaf targets **SDG 8.3**, supporting productive activities and micro-, small- and medium-sized enterprises, with **8.2** as a supporting productivity target. See the [United Nations Goal 8 targets](https://sdgs.un.org/goals/goal8). The proposal uses an explicitly illustrative baseline: 40 movements/week at 6 minutes each gives 4 hours/week. A proposed pilot target is 60% less handling time; this is not an achieved result. No customer pilot, observed time saving, reduction in stock discrepancies or environmental benefit has yet been measured.

### Key Features

- Fixed warehouse stock, linked inbound/outbound documents and two approval workflows.
- Inventory analysis dashboard with monthly receipt/issue curves, live stock alerts, monthly balance/turnover reports and matching read-only Agent queries.
- Independent order Space with real Orders, Payment confirmations and Invoices forms, pending AI intake, manual amount review, paid-in-full confirmation and pickup/delivery workflows. See [orders](docs/orders.md).
- Optional administrator-only WhatsApp read bridge: explicitly selected chat, fresh bounded message scans and review-first Agent imports. Each new preview can import the same messages again; retries of an applied plan return the original result. No message sending or automatic receipt/invoice confirmation. See [bridge setup](docs/whatsapp-bridge.md).
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

This is an independent prototype, not yet integrated with Orbyte APIs or Orbyte authentication. Orbyte summaries can be pasted or imported, but there is no direct connector. Scheduled reminders, production planning, billing and production tenant isolation are not implemented. The Replit hosting URL is supplied; public availability needs verification. Old business modules are no longer loaded or served; their source remains only in the independent future-direction snapshot.

### Existing Agent API

The source defines **64 Agent tool operations**, not 64 separate HTTP paths. The [complete categorized inventory](docs/agent-tool-inventory.md) lists all 64 directly from `AGENT_TOOLS`. Discovery uses `GET /api/agent/tools`; execution uses `POST /api/agent/operations`. Additional REST routes and OpenAPI discovery are described in the [API guide](docs/agent-api.md).

Operations cover tables and records, inventory workflows and analysis, spreadsheet import, orders/payments/invoices, selected-chat WhatsApp intake, navigation, notifications, AI processing and errors. Availability follows the token owner's current role and Space. Dedicated external-Agent meeting extraction/import is future work; generic task-table CRUD is not a dedicated meeting-import API.

## How to Run

Requires Node.js **22.13.0 or later** and npm. No Python, GPU, or external database is needed for the local application.

On Windows, double-click `start-server.bat` or run `.\start-server.bat` in PowerShell. It switches to the project directory, installs locked dependencies on first use or when `package-lock.json` changes, and starts the server. Keep its window open while using the app; press Ctrl+C to stop it. Startup errors stay visible.

```powershell
git clone https://github.com/sjq98/Releaf.git
cd Releaf
npm.cmd ci
npm.cmd start
```

Open **http://127.0.0.1:5174**. In a POSIX shell, use `npm` instead of `npm.cmd`.

The first launch creates `data/forms.sqlite` and a generic **New form**, with no accounts or business records. On the sign-in screen, create the first administrator with a username, display name and password of at least **12 characters**. There is no default password or bundled local account. After this setup, anyone using the local workspace can choose **Create account** to register and sign in as a **Member**, without administrator approval; self-registration cannot grant administrator privileges. Subsequent visits require sign-in. An administrator can add accounts, change roles, disable accounts and reset passwords under **Account > Manage users**; all users can change their own password or sign out. Sessions expire after seven days, and password/role/active-status changes invalidate that user's existing sessions.

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

Submission verification on 25 October 2026: `npm ci --ignore-scripts` succeeded and `npm test` passed **319/319** tests from a clean worktree of the submitted `main` application code. No product source changes were made during submission packaging.

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
|-- submission/             # Pitch deck, signed forms, Replit proof and status
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
| AI | Configurable compatible provider; demo uses DeepSeek `deepseek-flash`; no model bundled |
| Hosting | `main` runs locally; hosted configuration is published on the `deploy/render` branch; Replit live URL above |
| Testing | Built-in Node.js test runner |

See [architecture](docs/architecture.md) and the [technical inventory](docs/technical-inventory.md).

## How We Use Replit

The supplied [Replit proof](submission/SDC2026_Releaf_Replit_POU.pdf) shows the team's account usage and Agent/project work used for planning and collaboration. It is also appended to the technical declaration. The team supplied `https://releaf-prometheusjens.replit.app` for hosting. The page is reachable, but its authentication status API returned 403 during verification. The configured public URL and functional judge access must be checked. Development-platform usage alone is not claimed as product-level Replit API integration.

## How We Use RunPod

RunPod was not used; the prototype calls a configurable hosted AI API and has no RunPod-specific client, team Pod or Serverless endpoint. No RunPod declaration, example proof or placeholder PDF is included. The Participant Handbook sections 9.3 and 10.7 link RunPod and its evidence to GPU work/teams that used it; the generic repository template lists its proof as required. No organizer-approved exception for hosted model APIs is claimed. See [requirements](docs/submission-requirements.md).

## Challenges and Learnings

The implementation keeps record IDs stable when labels change, validates schema edits against existing records, and validates AI output before it can become business data. Agent writes share the same constraints as manual edits and detect stale approvals. Warehouse documents and lines stay synchronized; posting and reversal run atomically. Form deletion checks dependencies and requires explicit confirmation without erasing local history.

## Future Improvements

- Complete API business logic and end-to-end workflow coverage.
- Add dedicated meeting-task extraction/import operations for external Agents.
- Standardize request/error contracts and strengthen permission, retry and failure tests.
- Validate public deployment, secure secrets, improve backup/retention controls and add tenant isolation.
- Pilot with an SME, establish an observed baseline and measure handling time and stock discrepancy.
- Evaluate an Orbyte connector once its agreed API/authentication interface is available.

The default `main` server binds to `127.0.0.1`. The separate [`deploy/render` source branch](https://github.com/sjq98/Releaf/tree/deploy/render) adds HTTPS-origin/Host checks and hosted administrator bootstrap; submission packaging does not modify that deployment branch. Browser APIs require login; external Agent endpoints require an owner-bound token. This is a shared demo workspace, not tenant-isolated production software. Hosted configuration, secrets, persistence and functional access require verification before using sensitive data.

## Team

The signed proposal names Lin Jiarun as leader and declares five members. The confirmed team members and contributions are listed below. One additional member's details and individual GitHub handles remain to be supplied and are not inferred from repository accounts.

| Name | Role / contribution | GitHub |
| --- | --- | --- |
| Lin Jiarun | Team leader | Not supplied |
| SHAO JUNQIN | Technical Director and primary developer. Originated the overall product concept and technical direction, led the application architecture, and built the core Releaf application, including inventory management, order management, meeting-task workflows and Agent API integration. | Not supplied |
| ZHANG WEIYU | Product ideation support. Contributed ideas and feedback to help refine the product concept and explore solution approaches during product planning. | Not supplied |
| SHI BOWEI | Pitch presentation and logistics support. Prepared pitch-deck materials and provided supporting presentation and logistical work for the team's project showcase. | Not supplied |
| One additional member | Name and individual contribution require confirmation | Not supplied |

## Submission Checklist

The repository contains the supplied submission artifacts. The organizer's portal submission is a separate action by the team leader.

- [x] Record declared team, leader, university, size, domain and SDG targets.
- [x] Include the proposal with the supplied handwritten signature/date.
- [x] Include the technical declaration with the supplied signature/date and Replit appendix.
- [x] Include genuine supplied Replit proof.
- [x] Include pitch deck PDF and accessible YouTube demo link.
- [x] Fill the supplied Live Prototype URL.
- [ ] Verify the deployment is reachable and usable by judges.
- [ ] Confirm leader email and individual member/role/GitHub details.
- [ ] Have the leader review corrected forms and confirm eligibility/IP attestations.
- [ ] Resolve applicable sponsor requirements; no RunPod proof is claimed.
- [ ] Complete the organizer's submission step.

See [submission preparation](submission/README.md) and [requirements](docs/submission-requirements.md) for word limits, deadline and remaining checks. Blank templates and sample proofs are not represented as completed deliverables.

## License

The repository retains its existing [Apache License 2.0](LICENSE). Third-party licenses remain applicable; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
