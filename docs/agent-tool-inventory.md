# Agent Tool Inventory

Source-derived snapshot of `AGENT_TOOLS` in `src/agent-operations.js`, 25 October 2026.

**64 tool operations, not 64 separate HTTP endpoints.** Discovery uses `GET /api/agent/tools`; execution uses `POST /api/agent/operations`. See [the API contract](agent-api.md) and generated OpenAPI discovery for arguments, authentication and alternate REST routes.

The actual discovered set is filtered by the owner's current role and token Space. Agent writes default to human review; explicit Full access never bypasses account permissions, version checks or business workflow rules. A business payment confirmation requires explicit operator instruction. Tool names do not imply outbound WhatsApp messaging, Orbyte integration or dedicated meeting-summary extraction.

| Area | Operations |
| --- | ---: |
| Orders, payments and invoices | 9 |
| Selected-chat WhatsApp intake | 4 |
| Inventory workflows, catalog and analysis | 13 |
| Attachments | 2 |
| Workspace navigation | 5 |
| Notifications and same-form rules | 6 |
| AI task definitions and runs | 11 |
| Error handling | 2 |
| Tables, schemas and records | 12 |
| **Total** | **64** |

## Orders, payments and invoices

| # | Operation | Write/review classified | Contract |
| ---: | --- | --- | --- |
| 1 | `list_orders` | No | List orders in the dedicated Order Management Space (order-management). Members can manage their own orders; administrators can manage all orders. |
| 2 | `get_order` | No | Read order notes, amount, payment and invoice details, current version and available workflow actions before changing it. |
| 3 | `parse_customer_order` | No | Classify and extract a read-only draft from customer text. Keep products and quantities in notes. Never fill totalAmount, even when a source mentions a price. Report missing details; a person enters the amount and reviews the saved order. No inventory linkage. |
| 4 | `create_order` | Yes | Save an order and its linked unpaid confirmation record. AI-captured orders must have reviewed=false and totalAmount=null; only use an amount or reviewed=true when explicitly supplied/confirmed by the operator. messageSentAt is the source message time, never the import time; leave it null unless known. Products and quantities stay in notes. Creation is not acceptance, payment confirmation or stock movement. |
| 5 | `update_order` | Yes | Edit a draft or accepted order with its current version. Omitted fields stay unchanged; null clears optional text. Products stay in notes, totalAmount is explicitly confirmed. Status, payments and invoices use dedicated actions. |
| 6 | `transition_order` | Yes | Advance an order through accept, prepare, ready, dispatch, complete or cancel using its current version and the same state rules as the UI. |
| 7 | `confirm_order_payment` | Yes | Set or revoke the order's paid-in-full checkbox only on the operator's explicit instruction after checking receipt. Requires a reviewed order with a manually entered amount and its current order version. A customer message, screenshot or Full access is not proof of receipt. There is no partial-payment ledger. |
| 8 | `record_order_invoice` | Yes | Add an invoice entry using its actual invoice number, amount and current order version. Do not infer that invoicing proves payment. |
| 9 | `prepare_order_notification` | Yes | Prepare a local status notification as copyable text using the current order version. No WhatsApp message is sent and no delivery is verified. |

## Selected-chat WhatsApp intake

| # | Operation | Write/review classified | Contract |
| ---: | --- | --- | --- |
| 10 | `get_whatsapp_status` | No | Read the optional local, read-only WhatsApp connection status. Administrator only. Does not connect, read chats or send messages. |
| 11 | `list_whatsapp_chats` | No | List exact personal chat IDs from the connected WhatsApp account when the administrator asks. No group chats or outbound messages. |
| 12 | `preview_whatsapp_import` | No | Read a bounded, explicitly selected WhatsApp chat afresh on every preview, classify incoming text and prepare unreviewed order candidates regardless of previously imported or deleted orders. Customer uses the WhatsApp conversation name and messageSentAt uses the message timestamp, not AI guesses. No orders are saved. Never scan arbitrary chats; prices from messages are ignored. Returns an owner-scoped expiring plan and fingerprint. |
| 13 | `import_whatsapp_orders` | Yes | Save the exact WhatsApp preview plan as new unreviewed orders and linked unpaid confirmation records, even if another preview imported the same messages. Retrying the same applied plan returns its original result. Human review and manual amounts are still required. Does not accept orders, mark payments received, send messages or write invoices. |

## Inventory workflows, catalog and analysis

| # | Operation | Write/review classified | Contract |
| ---: | --- | --- | --- |
| 14 | `upload_inventory_file` | No | Upload an XLSX or UTF-8 CSV with base64 file.data and file.name, up to 5 MB. Upload stores the source file only; it does not change business records or start workflows. Returns fileId as id, worksheets, headers and samples. Use match_inventory_file next. |
| 15 | `get_inventory_file` | No | Read an uploaded spreadsheet's worksheet headers and samples within the authorized Space. |
| 16 | `match_inventory_file` | No | Match spreadsheet headers and product records. Resolve exact product codes first, or unambiguous names; report row errors. Optional mapping uses zero-based column indices or null to ignore a field. Does not write business data. |
| 17 | `preview_inventory_import` | No | Validate and preview a whole spreadsheet batch. stage=draft saves drafts; submit starts approval; post explicitly approves and posts using approvalActor matching each assigned approver. Default submit. Returns fingerprint, matched requests and errors. Never invent operators or silently choose post. |
| 18 | `execute_inventory_import` | Yes | Execute the exact validated spreadsheet batch with its preview fingerprint. Atomic, duplicate protected, and subject to Agent review/full access. All workflow validations still apply. |
| 19 | `save_inventory_catalog` | Yes | Use the catalog workflow to register or maintain products, warehouses or stock settings. Warehouse forms are read-only through generic CRUD. Products need code/name/unit; stock settings need product and warehouse IDs and optional minimum/openingQuantity. Updates need recordId and version. |
| 20 | `setup_inventory_workspace` | Yes | Install the fixed warehouse tables and workflows in a Space, as the Set up warehouse button. Idempotent; keeps existing records. |
| 21 | `get_inventory_workspace` | No | Discover warehouse form IDs, managed fields, two workflows and recent stock movements in a Space. Use query_records to resolve warehouse and product IDs. |
| 22 | `get_inventory_dashboard` | No | Read inventory analysis: monthly inbound/outbound trends, current low-stock alerts and monthly opening/closing balances, quantity turnover and signed reversal adjustments. from/to are inclusive YYYY-MM (up to 24 months); optional warehouseId, productId and unit filters. Quantities never mix units. This operation is read-only and uses the same report as the dashboard. |
| 23 | `get_inventory_request` | No | Read an inbound/outbound document, its product lines, current version and workflow events. |
| 24 | `create_inventory_request` | Yes | Create one inbound/outbound document with all lines atomically. values: warehouse record ID, applicant, approver, optional type/applicationDate/notes/photos. lines: product catalog record ID (not stock ID), quantity, optional notes. Set submit=true to start approval. First inbound posting creates missing warehouse stock. No stock changes until approved and posted. Do not invent missing business values. |
| 25 | `update_inventory_request` | Yes | Replace a draft/rejected document's complete line list. Existing lines need id and version; omitted lines are deleted. Header values are a partial update. Workflow-managed fields cannot be edited. |
| 26 | `advance_inventory_request` | Yes | Submit, approve, reject, cancel, post or reverse a warehouse request using the same rules as the UI. Requires its current version and operator name; approval/rejection require the assigned approver; reject/cancel/reverse need a reason. Agent review/full access is separate from the document workflow status. |

## Attachments

| # | Operation | Write/review classified | Contract |
| ---: | --- | --- | --- |
| 27 | `upload_attachment` | Yes | Upload a PDF, PNG or JPEG for a record using base64 file.data and file.name. Follows the same validation and review mode as user uploads; use the returned ID in attachment fields. PDF images may contain up to six rendered data-URL pages. |
| 28 | `get_attachment` | No | Read an attachment and its base64 content within the authorized Space. |

## Workspace navigation

| # | Operation | Write/review classified | Contract |
| ---: | --- | --- | --- |
| 29 | `list_navigation` | No | Read the Space navigation tree. |
| 30 | `create_navigation_node` | Yes | Create a display node in the Space. |
| 31 | `update_navigation_node` | Yes | Rename or move a node with the same UI validation. |
| 32 | `move_navigation_node` | Yes | Move a node and its complete subtree before, after or inside another node. |
| 33 | `delete_navigation_node` | Yes | Delete an empty display node. Cannot delete forms or nonempty folders. |

## Notifications and same-form rules

| # | Operation | Write/review classified | Contract |
| ---: | --- | --- | --- |
| 34 | `list_notifications` | No | List notifications in this Space. |
| 35 | `mark_notification_read` | Yes | Mark a notification as read. |
| 36 | `list_notification_rules` | No | Read same-form notification rules in a Space. |
| 37 | `create_notification_rule` | Yes | Propose a same-form notification rule. Only one notify action is supported; cross-form actions are built in and not configurable. |
| 38 | `update_notification_rule` | Yes | Propose a full automation definition with its current version. |
| 39 | `delete_notification_rule` | Yes | Propose removing an automation rule. |

## AI task definitions and runs

| # | Operation | Write/review classified | Contract |
| ---: | --- | --- | --- |
| 40 | `create_ai_task` | Yes | Create a configurable AI processing task using the same definition as the UI. |
| 41 | `update_ai_task` | Yes | Update an AI processing task definition with its current version. |
| 42 | `delete_ai_task` | Yes | Delete a task without run history. |
| 43 | `list_ai_runs` | No | Read the processing history in a Space. |
| 44 | `preview_ai_run` | No | Preview the data changes produced by an AI task. |
| 45 | `apply_ai_run` | Yes | Apply reviewed AI output using a fresh fingerprint from preview_ai_run. |
| 46 | `retry_ai_run` | Yes | Retry a failed or stale AI run. |
| 47 | `cancel_ai_run` | Yes | Cancel a queued or reviewable AI run. |
| 48 | `list_ai_tasks` | No | Discover configurable AI tasks in a Space. |
| 49 | `start_ai_task` | Yes | Queue an AI task using a saved input record. Results may require later review. |
| 50 | `get_ai_run` | No | Read AI task state, structured output and proposed changes. |

## Error handling

| # | Operation | Write/review classified | Contract |
| ---: | --- | --- | --- |
| 51 | `resolve_error` | Yes | Change an Error Center item status. |
| 52 | `list_errors` | No | Read processing errors for a Space. |

## Tables, schemas and records

| # | Operation | Write/review classified | Contract |
| ---: | --- | --- | --- |
| 53 | `list_forms` | No | List tables, field schemas and record counts within a Space. |
| 54 | `list_spaces` | No | List available Spaces. Tokens only see their own Space. |
| 55 | `get_form` | No | Read a table schema and its current version. |
| 56 | `query_records` | No | Search and filter records. Filters use field IDs; references store record IDs. All filters are ANDed. |
| 57 | `get_record` | No | Read a record and its version before editing it. |
| 58 | `create_record` | Yes | Propose a record using field IDs and the current schemaVersion. Required fields must be supplied. |
| 59 | `update_record` | Yes | Propose a partial record edit with the read record version and schemaVersion. Preserve other values. |
| 60 | `delete_record` | Yes | Propose deletion of one record, retaining activity history. |
| 61 | `create_form` | Yes | Propose a custom table. Supply stable field IDs, names, types, required/unique rules; select needs options and reference needs a unique target field. |
| 62 | `update_form` | Yes | Propose a complete replacement schema and table name at the current version. Keep existing field IDs. Removed fields disappear from the active schema; stored historical values are retained. |
| 63 | `preview_form_deletion` | No | Read form name, affected record count and dependency blockers before proposing deletion. Warehouse system forms cannot be deleted. |
| 64 | `delete_form` | Yes | Propose deleting a custom form and its active records from the workspace. Always requires local human confirmation, even in full access. Supply version from get_form. Dependencies and warehouse system forms are protected; historical data is retained. |

## Current Boundary and Next Steps

- Meeting summaries already have an authenticated browser-session import workflow. Task records can be queried/edited through generic table operations within permissions, but there is no dedicated external-Agent meeting-summary extraction/import tool.
- Inventory spreadsheet source upload, matching and preview are separate from committing business changes. Posting is separate from approval; order intake does not move stock.
- Complete missing API business logic and end-to-end workflow coverage, add dedicated meeting-task operations, standardize request/error formats, and extend permission/retry/failure tests.
- Mocked-provider tests verify implementation contracts, not live-model accuracy, sponsor integration or measured SME impact.
