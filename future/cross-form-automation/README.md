# Cross-form automation prototype

This directory preserves the working prototype before the switch to fixed warehouse workflows on 2026-10-23. It is a future-direction demonstration, not part of the current application's served assets or public API.

## What to show

- `src/automation.js`: record triggers, AND/OR/NOT conditions, ordered create/update/delete actions, transactional cascades, cycle detection, previews and idempotency.
- `src/condition-expression.js`: named condition blocks and logical expressions.
- `src/stock-receipts.js`: find-or-create receipt posting and reversal.
- `public/workspace.js`: condition builder, target selectors and assignment editor.
- `src/agent-operations.js`, `src/server.js`: prototype Agent tools and HTTP routes.
- `docs/`: design explanations and API examples.

The complete src/public snapshot is included because the prototype depends on form storage, references, imports and AI tasks. It contains source code only; no databases, credentials or uploads.

Run its executable examples from the project root:

```powershell
node --test future/cross-form-automation/tests/*.demo.js
```

The main test suite also exercises these archived sources through the existing automation/receipt regression tests. Do not launch the archived server against the live database. No environment variable or UI switch enables this prototype in the current product.

## Current product boundary

The current system has fixed inbound/outbound business workflows. UI and Agent use the same warehouse service, validation, transaction, record version and audit trail. Neither can customize cross-form rules or directly change managed balances/statuses. Same-form notification conditions and numeric field formulas remain available. Existing saved cross-form rules remain in SQLite as historical data and do not execute.

The archived prototype predates authentication: its operator/approver names are entered labels. The current application uses local accounts, administrator/member roles and account-owned Agent tokens; warehouse applicants and operators come from the signed-in account, and approval/rejection requires the assigned active account.
