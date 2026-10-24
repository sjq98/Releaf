# Releaf User Guide

## Run

Use Node.js 22.13 or later. On Windows, double-click `start-server.bat`, or:

```powershell
npm.cmd install
npm.cmd start
```

Open `http://127.0.0.1:5174`. Keep development on this port. Use `npm.cmd` in PowerShell
to avoid the `npm.ps1` execution-policy restriction.

## Accounts and Permissions

On the first visit, choose **Create administrator** and enter a username, display name
and password of at least 12 characters. No default password is provided. Later visits
use **Sign in**. Usernames contain 3-32 letters, numbers, dots, underscores or hyphens,
start with a letter or number, and are stored in lowercase.

Use the account menu to **Change password** or **Sign out**. Administrators also have
**Manage users** to add accounts, change display names and roles, disable accounts or
reset passwords. The last active administrator cannot be disabled or demoted. Sessions
last seven days; password, role or active-status changes invalidate existing sessions.
Changing your own password replaces the current session and signs out other sessions.

| Role | Access |
| --- | --- |
| Administrator | Member workflows plus user management, form/schema/record editing, navigation, AI/provider settings, notification rules and Error Center resolution |
| Member | Read shared tables and inventory analysis, manage own orders, create/edit requests, run warehouse transitions, approve/reject when assigned, use the assistant and own Agent tokens, read notifications and run/retry/cancel configured AI tasks |

Members cannot directly edit table records or schemas, create/move/delete forms and
navigation nodes, configure AI tasks or change provider settings. Accounts share the
local workspace; this is not per-company or per-Space membership isolation. Product,
warehouse and stock-setting maintenance also require an administrator.

## Inventory Analysis

**Inventory analysis** opens by default and is available from the sidebar. Choose a
month range, warehouse, product and unit, then apply the filters. The two curves show
posted inbound/outbound quantities. Stock alerts show live balances and shortages;
the monthly report shows reconciled opening/closing quantities and operational
turnover. Use record links to inspect source data, or the download icon to export
the filtered report. Members can read/export without gaining editing privileges.
See [calculation rules and demo data](inventory-dashboard.md).

## Order Management

Select the **Order management** Space alongside Inventory Management System.
Its sidebar contains Orders, Payment confirmations and Invoices as real forms.
Create an order manually, or paste a customer message and **Import order** with
the configured workspace AI provider. Import saves a pending order and one linked,
unchecked payment confirmation. AI never fills an order amount, even when a
customer quotes a total. A person verifies the details and notes, enters the MYR
amount and checks the order-review box.

Use the detail dialog to accept, prepare and complete an order. Delivery orders
also have a dispatch step. Draft and accepted orders can be edited; cancellation
is blocked by a confirmed payment or invoices. After checking actual wallet
receipts, check **Paid in full**. There is no received/outstanding amount or
partial-payment ledger. Changing the order amount clears the confirmation for
recheck. Register invoice numbers and amounts manually through **Record invoice**.
Products and quantities stay in Notes; orders never change inventory.

Administrators may use **WhatsApp** to start the separately installed connector,
link an authorized account by scanning its QR, select one chat and preview/import
bounded recent incoming text. No account is linked or messages read automatically.
Orders still need human review and manual amounts. See [bridge setup and privacy](whatsapp-bridge.md).

**Prepare status message** creates text to copy locally; it does not send WhatsApp
messages. Members manage orders they created; administrators manage all orders.
Agent operations enforce the same rules. See [Order Management](orders.md).

## Workspace and Forms

The language selector changes system labels without translating custom names, values
or expressions. A Space owns its forms, files and Agent tokens. Administrators create
display nodes and forms with the sidebar plus icon; drag handles move entries and whole subtrees.

New installations start with a generic **New form**, not legacy business templates.
Open **Warehouse workflows > Set up warehouse** to install the fixed warehouse tables
and approval workflows. See [Warehouse Management](warehouse.md).

For administrators, the settings icon edits names and fields. Types: text, long text, number, date,
datetime, dropdown, checkbox, reference and attachment. Fields support Required and
Unique rules; text uniqueness is case-insensitive. Numeric formulas use stable field
IDs and recalculate automatically. Calculated and warehouse-managed values cannot be
overwritten. References target another same-Space form's unique field.

Record creation, edits and deletion retain activity history. The trash icon beside
table settings deletes a custom form after an impact preview and confirmation.
The sidebar form menu has the same entry. References, AI-task dependencies and core
warehouse forms block deletion. See [Form Deletion](form-deletion.md).

Hold the middle mouse button over a table and drag in any direction to pan. This also
works in document-line dialogs and dashboard tables. Vertical movement uses the enclosing
modal or page when the table has no vertical overflow. Left-click editing, text selection,
the mouse wheel and touch scrolling remain unchanged.

For custom forms, the administrator's spreadsheet icon imports XLSX/CSV into an existing or new table. Map columns,
preview errors and confirm. Imports append transactionally, resolve unique reference
values and reject stale previews; they never silently overwrite records.

## Warehouse Testing

The seven warehouse tables are read-only for members. Administrators can maintain
records and custom fields, but core fields can only be renamed/reordered, and managed
balances/statuses and posted history stay protected. Open **Warehouse workflows**:

1. As an administrator, use **Product registration** to add a unique code, name and unit. Maintain warehouse details with **Warehouse registration**.
2. Start **Inbound workflow**, choose a warehouse and an active approver account, then select catalog products. The applicant is the signed-in user. Existing stock is not required.
3. **Import product lines** can fill an individual request from XLSX/CSV headers such as 商品编码 and 数量. Preview and replace the lines, then submit.
4. Sign in as the assigned approver to approve or reject. After approval, preview and confirm stock movement. A stock row is created automatically for a new product/warehouse pair.
5. Run **Outbound workflow** to consume stock. Insufficient stock blocks posting without partial changes.

Excel import belongs inside the inbound/outbound application through **Import product
lines**; there is no standalone bulk-import button on the workflow overview. Agent/API
batch matching remains available. Workflow actions record the signed-in account, and
an administrator cannot impersonate the assigned approver by entering another name.

商品登记与维护, 仓库登记与维护 and 库存初始化与阈值 are the Chinese labels for the catalog controls. Opening stock is initialization, not a correction to posted stock; reverse or create a new document for later movements. See [field relationships, import columns and limits](warehouse.md).

## AI and Notifications

Administrators use top-bar **AI settings** to configure the workspace processing provider using its name,
base URL, API key and upstream model discovery. **AI tasks** selects input fields,
instructions and typed outputs; results can require review. Inputs may include
supported image/PDF attachments. Actual model compatibility must be verified.

The floating **Assistant** has independent provider settings and shares users' table
and warehouse operations. Review-first writes appear under **Approvals**. Full access
applies permitted writes immediately, but whole-form deletion always needs local
confirmation. External Agents use independent tokens bound to their owner and Space.
Neither mode bypasses the owner's current role or warehouse approval checks. See [Agent API](agent-api.md).

Attach a spreadsheet with the assistant paperclip and request matching/import. Upload
does not itself create documents. Agent batch writes have the same preview, validation,
approval and duplicate checks as the workflow page.

The bell opens notifications; administrators also configure same-form notification
rules. **Error Center** retains errors with source information, details and status;
administrators can resolve/ignore errors and use supported error retries.

## Data and Limits

SQLite lives in ignored `data/forms.sqlite`. Provider keys are server-side but
unencrypted at rest. Do not share the database or backups. Passwords use salted hashes
and session/Agent tokens are stored as hashes. Local authenticated roles are implemented;
public deployment, tenant isolation, billing and an Orbyte connection are not.

The former order, supplier and recipe/purchase prototypes, and the old meeting prototype,
are no longer active. The current independent [order module](orders.md) replaces the
former order prototype.
The replacement [Meeting Tasks Space](meeting-tasks.md) supports one-click
summary extraction into its Tasks form, alongside the inventory Space.
Their source remains only under `future/`; never run that snapshot against live data.
