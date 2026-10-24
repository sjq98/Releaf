# WhatsApp Order Bridge

The optional local bridge supplies WhatsApp text to Releaf's order extraction
and review workflow. The checkout is an external dependency, not a skill
installed into Codex. Configuring Codex MCP is neither required nor sufficient
to connect the floating Releaf assistant.

## What It Does

1. An administrator explicitly starts the local connector and requests linking.
2. The administrator scans the QR shown in Releaf using WhatsApp's linked-device
   interface. A saved session can reconnect without another scan.
3. The administrator chooses one direct conversation and a bounded read window.
4. Preview reads only that conversation, classifies inbound text and prepares an
   owner-scoped import plan. Outbound messages, groups, media and non-order
   chatter do not create orders.
5. Import saves each selected new order as an unreviewed order and creates its
   linked payment-confirmation record through the normal order workflow.
6. A person verifies the order and enters its amount. A person also confirms
   payment in full after checking the actual receipt. No customer message or
   screenshot automatically confirms a payment.

There is no background polling, message sending, screenshot OCR, wallet
connection or invoice extraction. Opening the application does not start the
WhatsApp browser or read chats. Import is explicitly requested and bounded;
it is not an account-wide history export.

Opening the WhatsApp dialog checks the connector status. Once the linked
account is ready, it loads direct-conversation metadata once per dialog
opening. Status polling does not repeatedly read the chat list. Empty results
and read failures remain visible until the administrator refreshes the list.
An available helper is labeled "Connector running"; starting it again is not
a chat refresh or an account relink.

## Local Setup

Use a separate checkout next to `order-system`:

```powershell
cd "D:\Work_project\SDC Hackathon"
git clone https://github.com/LevNyyon/whatsapp-digest-local.git
cd whatsapp-digest-local
git checkout --detach a104fa2054fc4ce0b228fc3c68052e73e721afbf
npm.cmd ci --ignore-scripts
```

The upstream package is named `whatsapp-digest`, although its repository folder
is normally `whatsapp-digest-local`. It uses `whatsapp-web.js`, QR-linked
WhatsApp Web and a local browser. An existing supported browser may be used;
browser installation and its current compatibility are external prerequisites.
The current workstation checkout and dependencies have been installed separately.

The bridge validates the upstream `src/wa.js` against revision
`a104fa2054fc4ce0b228fc3c68052e73e721afbf` before launching it:

```text
SHA-256, with CRLF normalized to LF:
2c60a1ef37204b66daa7e9f76ea6b095a442a7e74da102c953be6b4e8694a67b
```

It refuses an unverified source revision instead of executing an arbitrary
configured script. A future upstream upgrade needs a source review and a
corresponding verified-hash change.

## Architecture

Releaf remains on `127.0.0.1:5174`. The connector helper uses the external tool's
conventional loopback port, `127.0.0.1:47291`; it is not another Releaf
development server.

`scripts/whatsapp-helper.mjs` imports the verified upstream WhatsApp wrapper.
It accesses the existing `whatsapp-web.js` client through `ensureClient()` and
uses exact conversation and message identifiers. The upstream stock MCP/HTTP
output only contains chat names and message descriptions, which is insufficient
for reliable replay protection or selecting one exact chat. The bridge does
not patch or copy upstream source.

Conversation discovery reads only the browser's direct-chat identifiers,
titles and activity timestamps. It avoids the SDK's full-chat serializer:
current WhatsApp Web builds can use `$1` identifiers where that serializer
expects `_serialized` last-message keys. Both identifier formats are supported.
For an explicitly selected conversation, the helper constructs the SDK's
`PrivateChat` from exact matching metadata and uses its bounded `fetchMessages`
method. Discovery does not read message bodies, and selecting one chat does
not serialize unrelated conversations.

The helper exposes only status, QR linking, direct-conversation discovery and
one-conversation bounded text reading. It never exposes message sending,
resetting/deleting a session, arbitrary JavaScript or arbitrary browser access.
It binds to loopback, checks Host/method/origin and requires a private random
Bearer token. The token stays in local SQLite and the helper environment; it
is not returned by status or sent to the AI provider.

The app starts the helper as a hidden Node child process, without a shell or
an arbitrary command string. It does not kill another program already using
the port. Stop an incompatible upstream MCP/HTTP helper before starting the
Releaf-owned helper. The two helpers must not concurrently control the same
WhatsApp session.

## Import Contract

The bridge module provides:

```text
status()
connect({projectPath?})
link()
chats({limit?})
previewImport({chatId,hours?,limit?})
getPlan({planId})
importMessages({planId,fingerprint})
close()
```

All methods that access account information or import plans require a signed-in
administrator. This protects a shared linked WhatsApp account from incidental
access by ordinary members. Imported orders belong to the account performing
the import and retain the existing order-ownership rules.

`previewImport` is asynchronous and stores a temporary plan, not business
orders. The default read is 10 recent messages from the selected chat within
24 hours. Allowed bounds are 1-50 messages and 1-168 hours. Available WhatsApp
Web history can be incomplete; `truncated` flags a read that hit its cap.
Local helper requests have a 45-second deadline to accommodate browser chat
synchronization; a timeout does not start a background retry or write orders.
An expired read reports a timeout (HTTP 504), not a claim that the local helper
has stopped. Connector availability, WhatsApp readiness and a successfully
loaded conversation list are separate states.

Source metadata retains the account ID, exact chat ID, exact message ID, chat
name, sender and timestamp. Existing sources are checked before model
extraction. The model's validated `isOrder` result controls whether a message
is an order candidate; customer/source text remains untrusted data.
Amounts are forced to null even if an upstream extraction result contains one.

Plans expire after 30 minutes, are bound to their creator and carry a
fingerprint. `importMessages` is synchronous and transaction-compatible:
normal Agent review can run the complete operation in a rollback preview and
apply it only after approval. A failure rolls back the whole import. Retrying
an applied plan returns its original result; replaying the same source through
another plan does not create a second order.

This identifies repeated delivery of the same WhatsApp message, not every
semantic duplicate. If a customer sends two different messages requesting the
same goods, both might be genuine new orders. Human review must resolve that
ambiguity instead of merging solely by amount or text.

## Privacy and Verification

The upstream linked-device browser session persists under its checkout's
`.wa-session` directory. Keep the checkout, session, SQLite database and
connector credentials private and outside Git. Releaf stores selected
import-source text with the order and temporary import plans in local SQLite.
The configured AI provider receives the selected messages used for extraction.
Do not describe this workflow as data that never leaves the machine.

Tests use mock clients, fake providers and isolated in-memory SQLite. They
cover exact identity selection, authentication, role checks, non-order
filtering, deduplication, transaction rollback, preview expiry and replay.
HTTP integration tests also exercise Agent review and approval against the
real application: preview writes no orders, approval creates linked payment
records, and both Space restrictions and the import owner's current role are
checked before applying a plan.
Tests do not establish that a real WhatsApp account has been linked or that a
particular browser/WhatsApp Web version currently works.
Local troubleshooting may separately verify status and direct-conversation
metadata against an existing linked session. Such checks do not establish
that message extraction or order import has been tested with real messages.

## Sources

The implementation was checked against the upstream primary source on
October 24, 2026:

- [Pinned WhatsApp wrapper](https://github.com/LevNyyon/whatsapp-digest-local/blob/a104fa2054fc4ce0b228fc3c68052e73e721afbf/src/wa.js)
- [Pinned package metadata](https://github.com/LevNyyon/whatsapp-digest-local/blob/a104fa2054fc4ce0b228fc3c68052e73e721afbf/package.json)
- [Upstream repository](https://github.com/LevNyyon/whatsapp-digest-local)

This unofficial connector is optional and intended for a local prototype.
Its upstream account/browser compatibility and usage restrictions remain
external constraints. See the earlier [integration research](whatsapp-integration.md)
for the distinction from the official WhatsApp business integration.
