# Order Management

## Space and Forms

Order Management is an independent Space (`order-management`), alongside
Inventory Management System and Meeting Tasks. Space, form and field names are
business data: switching the UI language does not rename them.

Orders are independent of inventory. Products, quantities and preparation
requests stay in order notes. There is no catalog selector, pricing calculation,
stock reservation or warehouse outbound action.

The sidebar contains three real forms. Their records use the same schema,
reference, query, history, validation and Agent APIs as other business forms.

| Form | Core fields and relationship |
| --- | --- |
| Orders | Unique order number, status, customer/phone, department, salesperson, fulfillment, delivery address, requested/estimated/actual delivery time, nullable amount, reviewed, payment confirmed, notes, customer message, attachments, owner |
| Payment confirmations | Unique confirmation number, unique required reference to Orders.number, mirrored order amount, method, paid-in-full checkbox, confirmer/time, notes, owner |
| Invoices | Invoice number, required reference to Orders.number, amount, notes, operator, owner |

References display the unique order number but store the stable target record ID.
Each order has exactly one payment confirmation; invoices can have multiple rows
per order. Invoice numbers must not repeat within an order.

## Fixed Workflows

1. Paste a customer message or use the optional selected-chat
   [WhatsApp bridge](whatsapp-bridge.md). AI identifies order details and saves a
   **pending-review** record, with a linked unchecked payment confirmation.
2. A person verifies customer details, notes and fulfillment, manually enters the
   MYR order amount, and checks the order-review box. Amounts remain null until
   explicitly entered; even a price quoted in the source is never auto-filled.
3. Advance fulfillment:
   - Pickup: draft -> accepted -> preparing -> ready -> completed.
   - Delivery: draft -> accepted -> preparing -> ready -> dispatched -> completed.
4. Check the actual wallet receipt and manually check **Paid in full**. It can be
   revoked. This records the operator and time, not a gateway transaction.
5. Register actual invoice numbers and amounts manually through the invoice
   workflow. Preparing a customer status message produces local copyable text
   only; it never sends WhatsApp messages.

Drafts can omit information. Review, acceptance, payment confirmation and invoice
registration require a manually entered amount and complete fulfillment details.
Zero is a valid explicit order amount; amounts support up to two decimal places.
Invoice totals cannot exceed the order amount.

There is no received/outstanding amount or partial-payment ledger. An unchecked
payment box means **not confirmed paid in full**, not necessarily no receipt.
Changing the order amount clears any existing payment confirmation for recheck.

Draft and accepted orders can be edited. Cancellation is allowed in those states
only and is blocked by a confirmed payment or invoices. Later states retain the
order details. Administrators may delete only an unpaid draft without invoices;
its paired payment record is removed atomically. A payment confirmation cannot
be deleted separately. System forms cannot be deleted.

## Permissions

Existing permissions are unchanged. Members use controlled workflows on their
own orders; administrators can access all orders and maintain generic records
and schemas. Core workflow fields cannot be bypassed through generic edits.
Administrators may rename/reorder core fields and add custom fields, but must
keep core types, required/unique rules and references.

Shared form queries, reference catalogs, history, notifications and diagnostics
respect order ownership. Members cannot read another user's orders through a
linked payment/invoice or its activity history.

Agent operations use the same owner permissions and fixed workflows. Review
mode previews changes without saving them; Full access applies permitted writes
but is not permission to invent a human review or a receipt. Source text is
untrusted business data, never an instruction to confirm payment.

## AI Provider Compatibility

The top-right **AI settings** button configures order extraction, meeting
extraction and form AI tasks. The floating assistant has separate settings.
DeepSeek uses `response_format: {"type":"json_object"}`; its complete output
schema is included in the system instruction. Other providers keep the existing
strict JSON Schema request. This compatibility logic lives in
`src/ai-provider.js`.

JSON object mode guarantees JSON syntax, not correct business fields. Order
results still pass the same server-side checks for required fields, types,
source quotes and forbidden price/payment fields before becoming a preview.
Malformed, refused or truncated results fail without creating orders.

## Service Contract

```text
state(spaceId)                    forms, summary, statuses and visible orders
list(spaceId), get(id)             visible orders and their current versions
create(body), update(id, body)     create/edit details; amount may be null
transition(id, body)              accept / prepare / ready / dispatch / complete / cancel
confirmPayment(id, body)          {version, confirmed: true|false}
invoice(id, body)                 {version, number, amount, note?}
notification(id, body)            local message text; no delivery
extract({spaceId, text})          read-only classification/extraction, <=40,000 chars
importExtracted({draft,text,source?})  save unreviewed/null-amount order
```

Signed-in local routes: `/api/orders/workspace`, `/api/orders/extract`,
`/api/orders/intake`, `/api/orders`, `/api/orders/:id` and POST actions under
`/:id/transition`, `payment-confirmation`, `invoices`, `notifications`.
The former `/:id/payments` route returns 410.

Every existing-order workflow write requires the current **order** `version`,
including payment confirmation, invoice registration and notification preparation.
Generic records use their own record version and schemaVersion.
External integrations use the [Agent API](agent-api.md) with a token scoped to
`order-management` and an idempotency key for every write.

## Migration

Startup transactionally migrates historical orders to shared form records,
retaining IDs, order numbers, owners, timestamps, amounts, invoices and history.
Attachments from inventory are copied without invalidating old file references.
Order-number collisions receive a new number with the previous number retained
in history. Historical product lines become notes; stock is never changed.
Old payment entries are retained as archived history, but **never** interpreted
as confirmation that an order is fully paid. Migration is idempotent.
