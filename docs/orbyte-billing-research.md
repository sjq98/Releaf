# Orbyte Billing Philosophy

Verified: 2026-10-22. Scope: the SME platform by Alpha Red Pro Sdn Bhd, not unrelated products using the Orbyte name.

## Core Principle

Orbyte separates access from billable activity. Giving an employee access or enabling a module should not automatically add a seat subscription. Its own paid services generally charge when real business activity occurs, so software costs follow use rather than headcount. [S1, PDF pages 12-13]

The deck summarizes this as "Charge when business happens." Its 80-employee claims example contrasts buying 80 licenses with granting access to everyone and charging for the actual transactions. The example does not establish a charge per login, per active user, or per API request. [S1, PDF pages 12-13]

## Commercial Models and Examples

- Free: Work is described as free for every team. [S1, PDF pages 14, 29-31]
- Freemium: a free core or allowance, with chargeable extras; eLeave has a monthly free request block and charges beyond it. [S1, PDF pages 14, 26]
- Transaction: eClaim charges per claim processed; eOT per overtime request; eSign per document signed. Quiet eOT months incur no charge. [S1, PDF pages 27-28, 36-37]
- Premium: specialized or higher-value capabilities have their own commercial model; the deck does not provide a universal rate. [S1, PDF page 14]
- Partner: integrated providers set terms appropriate to their solutions. The native-service philosophy is not a requirement that every partner adopt an identical tariff. [S1, PDF pages 12, 14, 20]

The platform presents a shared credit wallet across modules and rejects native per-seat fees. This describes the pricing approach, not published credit conversion rates, expiry rules, refunds, or final partnership contracts. Partner commercial arrangements are agreed individually; revenue sharing is not specified. [S1, PDF pages 14, 20]

## Implications for Releaf

Design interpretation, not an official Orbyte requirement: broad access plus a free/basic workflow and optional paid AI-processing events would fit this philosophy better than charging every employee for access. Suitable metering units need a separate product decision: for example, a meeting-processing job or a completed business automation, rather than assuming every internal API call is billable.

Nothing in these sources requires charging for chat messages, tokens, API requests, CRUD operations, or approvals. Do not implement a tariff on the claim that Orbyte mandates it. [Inference from S1]

## Sources

- **S1:** `D:\Work_project\SDC Hackathon\1. SDC Hackathon_ Orbyte Introduction.pdf`, 39 PDF pages. Relevant pages were text-extracted; pages 12-14 were also rendered and visually checked. Page numbers here count from the PDF cover, starting at 1.
- **S2:** Official pricing page, https://www.orbyte.my/pricing (parent-agent live verification, 2026-10-22).
- **S3:** Official FAQ, https://www.orbyte.my/faq (parent-agent live verification, 2026-10-22).

The public site corroborates the deck's usage-based positioning. No account was created, no billing transaction was tested, and no confidential commercial terms were accessed.
