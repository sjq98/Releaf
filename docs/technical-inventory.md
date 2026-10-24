# Technical Inventory for the Declaration

Working notes for `SDC2026_TeamName_TechDeclaration.pdf`, reviewed on 2026-10-23. This is not a completed or signed declaration.

## Software in the Prototype

| Resource | Version / identity | Purpose | License / status |
| --- | --- | --- | --- |
| JavaScript, HTML, CSS | See source | Browser UI and server logic | Repository Apache-2.0 |
| Node.js | Requires >=22.13.0; local verification environment records its own version | HTTP, file access, test runner, built-in SQLite | Node.js MIT and bundled third-party notices |
| SQLite through `node:sqlite` | Bundled with the selected Node.js runtime | Local persistence | SQLite public domain; retain runtime notices |
| `lucide` | 1.60.0, pinned in `package-lock.json` | Browser icons | ISC plus Feather-derived MIT notices |
| `exceljs` | 4.4.0 | XLSX parsing in a bounded worker | MIT |
| `csv-parse` | 7.0.3 | CSV parsing | MIT |
| `pdfjs-dist` | 6.4.299 | Browser-side PDF page rendering | Apache-2.0 |
| `decimal.js` | 10.6.0 | Decimal quantities and formula arithmetic | MIT |
| `jsep` | 1.4.0 | Parse restricted formula expressions | MIT |
| `chart.js` | 4.6.1 | Locally served inventory trend charts | MIT |
| Git / GitHub | Repository `sjq98/Releaf` | Version control and source hosting | Service terms; no application dependency |

The project has seven direct npm dependencies. ExcelJS's UUID dependency is overridden to 11.1.1; see the lockfile for the full dependency graph. No Python package or GPU runtime is required to run the app.

The optional WhatsApp bridge (added October 24, 2026) loads a separate
`whatsapp-digest-local` checkout pinned to
`a104fa2054fc4ce0b228fc3c68052e73e721afbf` (MIT), using that checkout's
`whatsapp-web.js` and `qrcode` dependencies. It is not an eighth direct Releaf
dependency. Record this external component in the final declaration when used.
Only mock-account integration has been verified; installation is not evidence
of a real linked account, delivered messages, or official WhatsApp API usage.

## External APIs and Models

The app supports independently configured workspace AI-task and chat-assistant providers. Both use model discovery and compatible Chat Completions; tasks require strict JSON schema, while the assistant requires function/tool calling. It has no fixed production provider or bundled model. Record the actual provider, model ID/version, access tier, and applicable terms used by the team when preparing the declaration. Do not copy keys or Agent tokens into any document.

Legacy meeting extraction, supplier recognition/reconciliation and recipe/purchase inventory modules are retired. Their source is retained only in the independent `future/` snapshot and is not served by the active app. The new `meeting-ai.js` and `meeting-tasks.js` use the workspace provider for direct summary-to-task import in a separate Space, with strict typed output, exact-quote validation and transactional writes. Fixed warehouse calculations do not call AI.

Configurable AI tasks also use the workspace provider with per-task model selection. Selected record fields and attachment pages form the input; a strict destination-field schema controls output. Tasks can require review or automatically apply valid results. Models are not permitted to return executable code or arbitrary database operations.

An API being configurable does not establish that it was used, sponsored, hosted on RunPod, or tested live.

## Cloud and Sponsor Resources

No Replit deployment, RunPod workload, Orbyte connection, sponsor credits, or judge-accessible live prototype has been verified in this repository. Each must be updated using actual usage and evidence before final submission.

## AI-Assisted Development

OpenAI Codex was used to assist with project development, tests, documentation, and repository preparation. The declaration should describe this as substantial assistance and confirm the actual extent with the team. Record model/version details only when known; do not infer one model version for all earlier work.

The team must review generated code and documents, run the tests, manually verify key user workflows, check factual claims, and take responsibility for the submitted work. Passing automated tests alone does not establish complete correctness.

## Datasets and Privacy

No training or fine-tuning dataset is included. `examples/meeting.txt` is synthetic walkthrough text; automated tests use synthetic fixtures and mocked AI output. Inventory any additional meeting records or evaluation datasets the team actually uses, including personal-data status and permission.

The local app stores records, warehouse history, assistant conversations and action logs in SQLite. AI tasks transmit selected inputs, schemas and relevant reference identifiers/unique values to an external provider; chat sends messages and requested tool results. Retired forms and historical legacy material remain in local storage and backups rather than being purged. Saved provider keys are server-side but unencrypted. External Agent tokens are hashed and have independent review/full-access modes; local workspace administration still trusts loopback programs. No automatic retention period, user login, tenant ownership or production deployment security is implemented. Record actual retention and deployment arrangements before signing.

## Items Only the Team Can Confirm

- Team members, leader contact details, and signatures.
- Any work created before the hackathon period and its ownership.
- Employment, internship, or consulting IP obligations.
- Actual platform subscriptions, regions, sponsor resources, and model terms.
- Actual data sources, licenses, permissions, and data-retention practices.
