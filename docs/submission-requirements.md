# Submission Requirements

Reviewed on 2026-10-22 (Asia/Singapore). This is a preparation checklist, not a claim that the submission is complete.

## Primary Sources

- [Organizer's submission repository](https://github.com/michaelzhngg/SDC_Hackathon_Submission_Template)
- [Organizer's README](https://github.com/michaelzhngg/SDC_Hackathon_Submission_Template/blob/main/README.md)
- [Participant resources linked by the README](https://drive.google.com/drive/folders/1xw7c2aN8N-at8hPEULzkcU76e_FFb0Ef)
- Local `1. Documentation for Submission/2. Template for docs inside GitHub Rep/1. SDC Hackathon_ Submission Template_.pdf` (14 PDF pages; preliminary proposal).
- Local `1. Documentation for Submission/2. Template for docs inside GitHub Rep/2. SDC Hackathon_ Technical Tools Declaration Template.pdf` (16 PDF pages).
- Local `1. Documentation for Submission/1. Github Sample Folder/SDC Hackathon Submission Template (GitHub)` is a ZIP archive without a `.zip` extension, not a plain text file. Its bundled README uses older sample filenames; use the current online names below.

The local files are from the participant resource download. Page references below count PDF pages, including the cover.

## Required by the Online Template

The organizer's README lists these files under `submission/`; replace `TeamName` with the confirmed team name:

| File | Purpose |
| --- | --- |
| `SDC2026_TeamName_Preliminary.pdf` | Preliminary submission |
| `SDC2026_TeamName_TechDeclaration.pdf` | Technology declaration |
| `SDC2026_TeamName_Replit_POU.pdf` | Replit proof of use |
| `SDC2026_TeamName_Runpod_POU.pdf` | RunPod proof of use |

Its checklist also requests team/domain/SDG details, slides and demo-video links, verified run instructions, and a repository free of secrets. The README supplies fields for leader, university, team size, member roles, project overview, features, architecture, technology stack, lessons, improvements, repository, Replit, live demo, and RunPod endpoint links.

Both platform-use sections are explicitly marked **Required**. They share a template covering Domain 1 and Domain 2; no Domain 2 exemption appears there. Evidence must document actual use. Source: organizer's README.

## Preliminary Proposal: Local PDF

The cover states **25 October 2026** as the submission deadline. It gives no cutoff time or timezone. Complete every field and export one PDF named `SDC2026_TeamName_Preliminary.pdf`; incomplete submissions may not be reviewed. Source: preliminary PDF, page 1.

| Section | What to provide | Limit / source |
| --- | --- | --- |
| 1. Team/project | Team name, domain, SDG track, solution name, leader name/contact, affiliations, member count | Page 2 |
| 2.1 Problem | Specific real-world challenge, affected users, and relevant social/environmental/economic significance | Maximum 250 words; page 3 |
| 2.2 AI solution | How AI addresses the problem and which workshop tools/skills are planned | Maximum 300 words; page 4 |
| 3.1 Stack | Technologies, APIs, database, simple architecture, and any sponsor GenAI/cloud use | Page 5 |
| 3.2 Deployment strategy | Design thinking, viability, usability, and readiness for deployed Phase 2 prototype | Maximum 200 words; page 6 |
| 4. SDG impact | Exact SDG sub-target, numeric baseline, measurable KPI, and realistic percentage-based Phase 2 target | Pages 7-9; cite evidence, estimates, or public benchmarks |
| 5. Eligibility | Workshop completion, verified SDG-linked problem, deployed-app objective, completed fields | Page 10; only tick statements the team can confirm |
| 6. IP/originality | Pre-existing work and ownership, third-party libraries/data/models and licenses, employment/internship/consulting IP obligations | Pages 11-13 |
| 7. Declaration | Team leader's signature and date | Page 14 |

The template names GenAI, Database, and Cloud Deployment workshops as mandatory in its readiness checklist. The team must confirm attendance rather than infer it from the code.

## Technical Declaration: Local PDF

Declare all APIs, cloud services, AI tools, datasets, models, and sponsor resources. Complete every section; use No/None when inapplicable instead of leaving blanks. Export one `SDC2026_TeamName_TechDeclaration.pdf` with the project submission. Its cover has an unfilled deadline placeholder, not a second confirmed date. Source: technical-declaration PDF, page 1.

| Section | What to provide | Limit / source |
| --- | --- | --- |
| 1. Team/project links | Team/project, leader/contact, university, live prototype URL, repository URL | Page 2; repository may be public **or access granted to judges** |
| 2.1 Architecture | End-to-end component connections; diagram appendix if available | Maximum 200 words; page 3 |
| 2.2 Software | Languages/frameworks/libraries, versions, licenses, purpose | Page 4 |
| 3.1 APIs | Every external API, provider, tier, and purpose; no secrets | Page 5 |
| 3.2 Cloud | Hosting/storage/database/auth/compute, provider, plan/region, deployment purpose | Page 6 |
| 4.1 Models | Model/version, source/provider, license/terms, use type | Page 7 |
| 4.2 Datasets | Name/source, public/private/synthetic type, license, personal-data status | Page 8 |
| 4.3 Development AI | Assistants/completion/design/content tools, version if known, use and extent | Page 9; declared use does not reduce score, undeclared use may |
| Review of generated output | How the team reviewed, tested, and accepted responsibility | Maximum 100 words; page 10 |
| 5. Sponsor resources | Actual sponsor APIs/credits/platforms/data/mentoring and their use | Page 11 |
| Sponsor replaceability | Whether essential or replaceable and why | Maximum 100 words; page 12 |
| 6.1 Data/privacy | Collected/stored/transmitted data, protection, and retention | Maximum 150 words; page 13 |
| 6.2 Risks | AI limits, hallucination/bias/rate-limit/provider risks, and mitigations | Maximum 150 words; page 14 |
| 7. Readiness | Complete declarations, licenses, no credentials, disclosed AI use, judge access, word limits | Page 15 |
| 8. Declaration | Team leader's signature and date | Page 16 |

Use [technical-inventory.md](technical-inventory.md) for verified implementation notes. It does not replace the signed PDF or the team's factual confirmations.

## Examples Versus Requirements

Python, Flask/FastAPI, the sample handler, and the sample folder tree illustrate an implementation. The README does not establish a mandatory Python stack. Retaining this project's Node.js implementation is consistent with that evidence.

## Unresolved Rules

- The preliminary PDF supplies the date above, but no exact cutoff time/timezone or actual submission channel was established from these files.
- The technical declaration explicitly allows a public repository or access granted to judges; publicity is not established as mandatory.
- Domain-specific handbooks and later organizer announcements must be checked for additional rules or updates. This review covers the requested submission repository and local submission documentation folder.
- Confirm any claimed exception to Replit or RunPod directly with the organizer if local guidance differs.
- The online checklist includes slides, demo video, platform proofs, and deployment links. These sources do not establish that every final-demo item is due at the preliminary stage; confirm stage-specific timing.
- The archived Replit and RunPod proof PDFs each contain only their title and an "EXAMPLE ONLY" label. They specify no concrete screenshots, logs, or minimum evidence count. They are not evidence of this team's usage; confirm the required evidence content and current template version before exporting.

## First Commit Versus Competition Submission

The first GitHub commit can preserve the working prototype and expose unfinished submission items. It does not complete the competition submission.

Pending items should remain visibly pending until supported by real artifacts: confirmed team identity and SDG track, slides, video, platform links and usage evidence, completed PDF forms, and any organizer-specified final submission action. Do not substitute blank PDFs, fabricated screenshots, or sample endpoints for evidence.
