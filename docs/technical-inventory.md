# Technical Inventory for the Declaration

Working notes for `SDC2026_TeamName_TechDeclaration.pdf`, reviewed on 2026-10-22. This is not a completed or signed declaration.

## Software in the Prototype

| Resource | Version / identity | Purpose | License / status |
| --- | --- | --- | --- |
| JavaScript, HTML, CSS | See source | Browser UI and server logic | Repository Apache-2.0 |
| Node.js | Requires >=22.13.0; local verification environment records its own version | HTTP, file access, test runner, built-in SQLite | Node.js MIT and bundled third-party notices |
| SQLite through `node:sqlite` | Bundled with the selected Node.js runtime | Local persistence | SQLite public domain; retain runtime notices |
| `lucide` | 1.60.0, pinned in `package-lock.json` | Browser icons | ISC plus Feather-derived MIT notices |
| Git / GitHub | Repository `sjq98/Releaf` | Version control and source hosting | Service terms; no application dependency |

The project has one direct npm dependency. No Python package or GPU runtime is required to run the app.

## External APIs and Models

The app supports a user-configured provider exposing a model list and strict JSON-schema Chat Completions. It has no fixed production provider or bundled model. Record the actual provider, model ID/version, access tier, and applicable terms used by the team when preparing the declaration. Do not copy keys from local settings into any document.

An API being configurable does not establish that it was used, sponsored, hosted on RunPod, or tested live.

## Cloud and Sponsor Resources

No Replit deployment, RunPod workload, Orbyte connection, sponsor credits, or judge-accessible live prototype has been verified in this repository. Each must be updated using actual usage and evidence before final submission.

## AI-Assisted Development

OpenAI Codex was used to assist with project development, tests, documentation, and repository preparation. The declaration should describe this as substantial assistance and confirm the actual extent with the team. Record model/version details only when known; do not infer one model version for all earlier work.

The team must review generated code and documents, run the tests, manually verify key user workflows, check factual claims, and take responsibility for the submitted work. Passing automated tests alone does not establish complete correctness.

## Datasets and Privacy

No training or fine-tuning dataset is included. `examples/meeting.txt` is synthetic walkthrough text; automated tests use synthetic fixtures and mocked AI output. Inventory any additional meeting records or evaluation datasets the team actually uses, including personal-data status and permission.

The local app stores records and meeting material in SQLite. Extraction transmits the text, schema, and relevant reference identifiers/unique values to an external provider. Saved keys are server-side but unencrypted in the database. No automatic retention period, user login, or authorization is implemented. Record the team's actual retention and deployment arrangements before signing.

## Items Only the Team Can Confirm

- Team members, leader contact details, and signatures.
- Any work created before the hackathon period and its ownership.
- Employment, internship, or consulting IP obligations.
- Actual platform subscriptions, regions, sponsor resources, and model terms.
- Actual data sources, licenses, permissions, and data-retention practices.
