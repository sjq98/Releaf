# Submission Requirements

Rechecked on 2026-10-25 (Asia/Singapore). This is a requirements checklist, not a claim that portal submission is complete.

## Final Operational Check

The current [official Participant Handbook](https://drive.google.com/file/d/1fGBS-jevDj_FrF8wsbYNPzyU5TTrfk1V/view), linked from the organizer's participant-resource Drive, was checked on 25 October 2026. Its operational instructions clarify the older preparation notes below:

- Section 6.3.1, PDF page 10: preliminary cutoff **25 October 2026, 07:59:59 AM MYT (UTC+8)**. The current [homepage](https://sdchack.my/) agrees to the minute; do not rely on the conflicting 23:59 tutorial subtitle.
- Section 6.3.5.6, PDF page 13: a **5-7 minute YouTube pitching video including prototype demonstration**.
- Section 9.2, PDF page 28: every team must use Replit as part of its solution.
- Section 9.3, PDF page 28: RunPod is required for work needing a GPU, including relevant training, fine-tuning and inference.
- Sections 10.6-10.7, PDF pages 28-29: own-account Replit proof and, for teams that used RunPod, their own dashboard or Serverless endpoint evidence. Replit proof should appear in the technical declaration; the supplied evidence is appended.
- The generic GitHub template still lists both platform PDFs. The handbook's conditional language does not explicitly settle GPU-backed third-party hosted APIs. No RunPod use, proof, separate declaration or organizer-approved exemption is claimed for Releaf.
- The [Domain 2 brief](https://sdchack.my/) permits synthetic data and simulated account/permission layers without live Orbyte access. This is not evidence that sponsor API integration has been completed.

The [official Terms and Conditions](https://sdchack.my/legal/terms-2026-08-21.pdf), sections 6.1.1 and 6.3.2, designate `sdchack.my` and its timestamp for submission. Section 6.6 restricts repository changes after the cutoff unless instructed by the organizer. The leader must submit through the [team portal](https://sdchack.my/login); a GitHub push is not that action.

Releaf's live URL is `https://releaf-prometheusjens.replit.app`. It has been filled into the technical declaration. The page is reachable, but authentication returned a 403 configured-address error during verification; functional judge access still needs checking. The source is `https://github.com/sjq98/Releaf`, and the video is `https://youtu.be/8xv9_2mSclk`.

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

Both platform-use sections are marked **Required** in the generic README. The current Participant Handbook gives the more specific conditional RunPod instructions summarized above. Evidence must document actual use; a missing proof cannot be replaced by a sample screenshot. Releaf includes no RunPod file, as requested by the team.

## Repository Preparation Review

The live [organizer's README](https://github.com/michaelzhngg/SDC_Hackathon_Submission_Template/blob/main/README.md) was rechecked on 2026-10-22 before the current code upload. The four PDF filenames above remain unchanged.

The repository README should expose the template's team-information table, resource links, overview, features, stack, structure, architecture, run/test instructions, platform-use disclosures, lessons, improvements, member/role/GitHub table, submission checklist, and license. Unknown team details and missing deliverables must remain explicitly pending.

The sample Python entry point, dependency file, Replit configuration, and RunPod handler should not be copied as nonfunctional placeholders into this Node.js implementation. Document the actual implementation and verified platform usage instead.

This review checks repository preparation only. Pushing code does not provide the missing signed PDFs, prove sponsor usage, establish deployment, or perform the organizer's separate submission step.

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

## Earlier Preparation Questions

The final operational check above resolves the deadline, channel and video duration questions in this older checklist. Private announcements, the authenticated portal and team-only facts still require team confirmation.

- The preliminary PDF supplies the date above, but no exact cutoff time/timezone or actual submission channel was established from these files.
- The technical declaration explicitly allows a public repository or access granted to judges; publicity is not established as mandatory.
- Domain-specific handbooks and later organizer announcements must be checked for additional rules or updates. This review covers the requested submission repository and local submission documentation folder.
- Confirm any claimed exception to Replit or RunPod directly with the organizer if local guidance differs.
- The online checklist includes slides, demo video, platform proofs, and deployment links. These sources do not establish that every final-demo item is due at the preliminary stage; confirm stage-specific timing.
- The archived Replit and RunPod proof PDFs each contain only their title and an "EXAMPLE ONLY" label. They specify no concrete screenshots, logs, or minimum evidence count. They are not evidence of this team's usage; confirm the required evidence content and current template version before exporting.

## First Commit Versus Competition Submission

The first GitHub commit can preserve the working prototype and expose unfinished submission items. It does not complete the competition submission.

Pending items should remain visibly pending until supported by real artifacts: confirmed team identity and SDG track, slides, video, platform links and usage evidence, completed PDF forms, and any organizer-specified final submission action. Do not substitute blank PDFs, fabricated screenshots, or sample endpoints for evidence.
