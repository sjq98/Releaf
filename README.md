# Releaf

An English-language SME workspace for custom business tables, order history, AI-assisted meeting follow-up, and supplier-document reconciliation, with a review-first Agent API.

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

Small businesses can record orders in tables while meeting commitments remain in separate notes and supplier documents remain separate from internal receipt records. Staff need to trace changed orders, agreed actions, and differences between goods received and supplier-stated quantities.

### Solution

Releaf provides editable business tables and field-level record history. Schema-aware AI extraction converts meeting text and supplier documents into drafts for human review. Reference fields connect records to orders using stable record IDs. Deterministic reconciliation compares selected receipt and supplier-document records, preserving the sources and flagging discrepancies. A floating assistant and independent Agent tokens expose table operations with change previews and optional full access.

The sustainability hypothesis is that clearer follow-up could reduce missed work and avoidable rework. Environmental benefits, an SDG sub-target, a baseline, and an impact target must still be established and measured.

### Key Features

- Order Management, Meeting Follow-up and Supplier Reconciliation modules with custom tables.
- Eight field types, required/unique constraints, and editable dropdown options.
- Automatic history for record creation, field changes, and deletion.
- Reference fields that link directly to records in another table.
- Meeting text import, structured AI extraction, evidence quotes, human review, and transactional saving.
- AI provider settings with upstream model discovery; manual workflows work without an AI key.
- Floating chat assistant with its own provider configuration, tool calling, change previews and optional full access.
- Separate, revocable Agent tokens and a documented API for custom table/record operations, filtering and schema editing.
- Shared XLSX/CSV import: create a table or append records with field mapping, validation, preview and confirmation.
- Supplier document image/PDF recognition with editable drafts, source files and human confirmation.
- Scoped receipt/document quantity reconciliation, discrepancy reviews, source snapshots and CSV export.

This is an independent prototype. It is not yet integrated with Orbyte APIs, authentication, or templates. Automatic replanning, reminders, notifications, and automatic task creation from order changes are not implemented.

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

The first launch creates the database at `data/forms.sqlite` and an empty Orders table. Local records and saved AI credentials are excluded from Git. An existing database in this location is reused.

On Windows, you can also double-click `start-server.bat`, which fixes the port to **5174**. Use this port for local development and verification. If it is occupied, use the existing Releaf server or stop that server before restarting; do not launch another development server on a different port.

### Configure AI

Open **AI settings**, enter the provider name, API base URL and key, click **Fetch models**, choose a model, and save. The provider must support model discovery and strict JSON-schema Chat Completions.

Alternatively, copy `.env.example` to `.env` and fill in `AI_API_KEY` and `AI_MODEL`. The server loads that file on startup. Saved database settings take precedence. API keys stay server-side, but the local database stores them without encryption.

See the [user guide](docs/user-guide.md) for configuration, limits, references, record history, and the HTTP API.
See the [supplier reconciliation and spreadsheet guide](docs/supplier-reconciliation.md) for the new module, input limits, matching rules and workflow endpoints. Document recognition requires an image-capable model; quantities are compared by code, not by the model.

The floating **Assistant** has separate provider settings in its header. Choose a model that supports compatible function/tool calling. **Review first** is the default; writes wait in **Approvals**. **Full access** requires explicit confirmation. Use the header's key icon to create separate Agent access tokens. See the [Assistant and Agent API guide](docs/agent-api.md) for endpoints, OpenAPI discovery, idempotency and deployment limits.

### Tests and Development

```powershell
npm.cmd test
npm.cmd run dev
```

Tests use in-memory or temporary databases and mock provider responses. They do not verify a live AI service, sponsor usage, or Orbyte integration.

Local verification on 2026-10-22: **98 tests passed, 0 failed**; `npm.cmd audit --omit=dev` reported **0 vulnerabilities**. These results are a point-in-time check, not a production-security certification.

## Project Structure

```text
.
|-- src/                    # HTTP server, SQLite store, field types and AI integration
|-- public/                 # Browser UI and local styling
|-- tests/                  # Node test runner suites
|-- docs/                   # Architecture, user guide and submission requirements
|-- examples/               # Synthetic meeting input for a local walkthrough
|-- submission/             # Submission checklist; final PDFs are pending
|-- start-server.bat        # Windows launcher fixed to port 5174
|-- GLOSSARY.md             # Supplier-reconciliation terminology
|-- .env.example            # Configuration names without credentials
|-- .gitignore
|-- LICENSE
|-- package.json
|-- package-lock.json
`-- README.md
```

`data/`, `output/`, and `.playwright-cli/` are local runtime/verification directories and are not committed.

## Architecture and Tech Stack

Browser HTML/CSS/JavaScript -> Node.js HTTP API -> local SQLite. Meeting and supplier-document extraction call a configured AI provider; validated drafts return for review before saving. The assistant uses an independently configured provider and shares approval-aware operations with external Agents. Spreadsheet parsing uses a bounded worker; quantity reconciliation uses decimal arithmetic without an AI call.

| Layer | Implementation |
| --- | --- |
| Frontend | HTML, CSS, native JavaScript modules, Lucide icons 1.60.0 |
| Backend | Node.js standard library, native HTTP server |
| Storage | Node.js built-in SQLite |
| Import / documents | ExcelJS, csv-parse, PDF.js; Decimal.js for quantity arithmetic |
| AI | Configurable compatible provider; no model bundled |
| Hosting | Local loopback server at present |
| Testing | Built-in Node.js test runner |

See [architecture](docs/architecture.md) and the [technical inventory](docs/technical-inventory.md).

## How We Use Replit

Pending. This repository does not yet establish actual Replit usage or include its proof PDF. The organizer's online template marks this platform and proof of use as required; confirm any domain-specific exception with the organizer.

## How We Use RunPod

Pending. The current prototype calls a configurable AI API and has no RunPod-specific client or serverless handler. Do not treat a compatible API URL alone as proof of RunPod usage.

## Challenges and Learnings

The implementation keeps record IDs stable when labels change, validates schema edits against existing records, and validates AI output before it can become business data. Extraction and saving are separate so users can correct unsupported or incomplete suggestions. Agent writes share the same constraints as manual edits and detect stale approvals. Quantity comparisons preserve source snapshots and use decimal arithmetic; ambiguous units and returns require review rather than silent conversion.

## Future Improvements

- Confirm team information, SDG sub-target, and quantitative impact baseline.
- Validate the workflow with an SME and measure a relevant process KPI.
- Confirm Orbyte integration access and implement an agreed interface.
- Complete required sponsor-platform usage and collect genuine evidence.
- Prepare judge-accessible deployment, slides, demo video, and signed PDFs.

The server binds to `127.0.0.1`. External Agent endpoints have token authorization, but local workspace administration has no user accounts and trusts local programs. Judge-facing cloud deployment still needs authenticated users, ownership controls, TLS and deployment configuration before exposure.

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
