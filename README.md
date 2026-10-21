# Releaf

An English-language SME workspace that connects custom order tables, change history, and AI-assisted meeting follow-up.

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
| Local application | http://127.0.0.1:5173 after starting the server |
| Replit project / live demo | Pending; no deployed URL supplied |
| RunPod endpoint | Pending; no RunPod integration or usage evidence supplied |
| Slide deck | Pending |
| Demo video | Pending |

## Problem and Solution

Small businesses can record orders in tables while meeting commitments remain in separate notes. When requirements change, staff need to connect the current order, the change history, the responsible person, and the agreed action.

Releaf provides editable business tables and field-level record history. A schema-aware AI extraction flow converts meeting text into proposed action items, which a user reviews before saving. Reference fields connect those items to orders using stable record IDs.

The sustainability hypothesis is that clearer follow-up could reduce missed work and avoidable rework. Environmental benefits, an SDG sub-target, a baseline, and an impact target must still be established and measured.

## Current Features

- Order Management and Meeting Follow-up modules with custom tables.
- Eight field types, required/unique constraints, and editable dropdown options.
- Automatic history for record creation, field changes, and deletion.
- Reference fields that link directly to records in another table.
- Meeting text import, structured AI extraction, evidence quotes, human review, and transactional saving.
- AI provider settings with upstream model discovery; manual workflows work without an AI key.

This is an independent prototype. It is not yet integrated with Orbyte APIs, authentication, or templates. Automatic replanning, reminders, notifications, and automatic task creation from order changes are not implemented.

## Run Locally

Requires Node.js **22.13.0 or later** and npm. No Python, GPU, or external database is needed for the local application.

```powershell
git clone https://github.com/sjq98/Releaf.git
cd Releaf
npm.cmd ci
npm.cmd start
```

Open **http://127.0.0.1:5173**. In a POSIX shell, use `npm` instead of `npm.cmd`.

The first launch creates the database at `data/forms.sqlite` and an empty Orders table. Local records and saved AI credentials are excluded from Git. An existing database in this location is reused.

If port 5173 is occupied:

```powershell
$env:PORT = "5174"
npm.cmd start
```

### Configure AI

Open **AI settings**, enter the provider name, API base URL and key, click **Fetch models**, choose a model, and save. The provider must support model discovery and strict JSON-schema Chat Completions.

Alternatively, copy `.env.example` to `.env` and fill in `AI_API_KEY` and `AI_MODEL`. The server loads that file on startup. Saved database settings take precedence. API keys stay server-side, but the local database stores them without encryption.

See the [user guide](docs/user-guide.md) for configuration, limits, references, record history, and the HTTP API.

### Tests and Development

```powershell
npm.cmd test
npm.cmd run dev
```

Tests use in-memory or temporary databases and mock provider responses. They do not verify a live AI service, sponsor usage, or Orbyte integration.

## Project Structure

```text
.
|-- src/                    # HTTP server, SQLite store, field types and AI integration
|-- public/                 # Browser UI and local styling
|-- tests/                  # Node test runner suites
|-- docs/                   # Architecture, user guide and submission requirements
|-- examples/               # Synthetic meeting input for a local walkthrough
|-- submission/             # Submission checklist; final PDFs are pending
|-- .env.example            # Configuration names without credentials
|-- .gitignore
|-- LICENSE
|-- package.json
|-- package-lock.json
`-- README.md
```

`data/`, `output/`, and `.playwright-cli/` are local runtime/verification directories and are not committed.

## Architecture and Tech Stack

Browser HTML/CSS/JavaScript -> Node.js HTTP API -> local SQLite. Meeting extraction calls a configured external AI provider; validated drafts return to the browser for review before records are saved.

| Layer | Implementation |
| --- | --- |
| Frontend | HTML, CSS, native JavaScript modules, Lucide icons 1.60.0 |
| Backend | Node.js standard library, native HTTP server |
| Storage | Node.js built-in SQLite |
| AI | Configurable compatible provider; no model bundled |
| Hosting | Local loopback server at present |
| Testing | Built-in Node.js test runner |

See [architecture](docs/architecture.md) and the [technical inventory](docs/technical-inventory.md).

## How We Use Replit

Pending. This repository does not yet establish actual Replit usage or include its proof PDF. The organizer's online template marks this platform and proof of use as required; confirm any domain-specific exception with the organizer.

## How We Use RunPod

Pending. The current prototype calls a configurable AI API and has no RunPod-specific client or serverless handler. Do not treat a compatible API URL alone as proof of RunPod usage.

## Challenges and Learnings

The implementation keeps record IDs stable when labels change, validates schema edits against existing records, and validates AI output before it can become business data. Extraction and saving are separate so users can correct unsupported or incomplete suggestions.

## Next Milestones

- Confirm team information, SDG sub-target, and quantitative impact baseline.
- Validate the workflow with an SME and measure a relevant process KPI.
- Confirm Orbyte integration access and implement an agreed interface.
- Complete required sponsor-platform usage and collect genuine evidence.
- Prepare judge-accessible deployment, slides, demo video, and signed PDFs.

The server binds to `127.0.0.1` and has no user accounts or authorization. Judge-facing cloud deployment needs deployment configuration and access controls before exposure.

## License

The repository retains its existing [Apache License 2.0](LICENSE). Third-party licenses remain applicable; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
