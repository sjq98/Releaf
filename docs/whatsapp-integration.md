# WhatsApp Order Integration Research

Verified: 2026-10-24. Research only: no project installed, account linked,
customer messages read, or outbound messages sent.

## Recommendation

Use pasted customer text for the current demonstration and make the channel
adapter replaceable. `LevNyyon/whatsapp-digest-local` can supply an optional
local, read-only intake experiment, but cannot send order confirmations or
ready/delivery notifications. Its source contains no send operation.
For a business deployment, the official WhatsApp Cloud API provides inbound
message webhooks and outbound messaging. [L1, L2, L3, M1, M2]

The application currently supports text-based order extraction and locally
prepared status messages. A live WhatsApp connection is a proposed integration,
not an implemented feature. See [Order Management](orders.md).

## What Is a Skill?

The digest project's `skill/SKILL.md` tells an AI assistant how to use its
separate MCP service and summarize results. Installing that instruction file
alone does not connect WhatsApp or give Releaf a messaging API. The Node service
and a linked WhatsApp Web session provide account access; the AI client reasons
over the returned text. [L1, L2, L3]

## Current Local Integration Status

Rechecked on 2026-10-24 against the local application and the upstream default
branch. The upstream branch still resolved to
`a104fa2054fc4ce0b228fc3c68052e73e721afbf`; no newer implementation was
assumed.

- Releaf's **New order -> Customer message -> Extract draft** sends pasted
  text to `/api/orders/extract`. The configured workspace AI provider extracts
  a draft; a person reviews it before saving. Product descriptions and
  quantities go into notes. See [`public/orders.js`](../public/orders.js),
  [`src/order-ai.js`](../src/order-ai.js) and
  [`src/server.js`](../src/server.js).
- Releaf's floating assistant exposes its own registered business tools. It
  has no external MCP client or WhatsApp tools. Configuring an MCP server in
  Codex would make tools available to Codex, not automatically to Releaf's
  web assistant. See [`src/assistant.js`](../src/assistant.js),
  [`src/agent-operations.js`](../src/agent-operations.js) and
  [`package.json`](../package.json).
- The local Codex `config.toml` contained no WhatsApp/digest configuration.
  No `whatsapp-digest` directory existed in the checked user skill roots
  (`.codex/skills` and `.agents/skills`); no checkout existed in the checked
  workspace locations; no service was listening on the helper's default port
  47291. This is a scoped configuration/filesystem inspection, not a claim
  about every directory or application on the machine.
- The earlier work was source research and the generic order extraction
  feature. The digest skill was **not installed or connected**, and no
  WhatsApp account has been linked by this project work.

## How to Extract Orders Now

The working path needs no WhatsApp connector:

1. Sign in to Releaf and switch to the Order Management Space.
2. Configure the workspace **AI settings** if they are not configured.
3. Choose **New order**, copy a customer's WhatsApp message, and paste it
   into **Customer message**.
4. Choose **Extract draft**. Review the customer, pickup/delivery details,
   notes and explicit order total. Fill missing values, then confirm/save.

This extracts information from supplied text. It does not read the WhatsApp
account, automatically import chats, or send a reply.

## Optional Local Connector Setup

The following is a proposed manual setup, not something installed or run during
this verification. It connects a local MCP-capable AI client to WhatsApp first.
Releaf intake would still need either manual copy/paste or an additional adapter.

1. Clone the external tool beside Releaf and install dependencies. On this
   Windows machine, `npm.cmd` avoids the PowerShell `npm.ps1` execution-policy
   issue encountered earlier:

   ```powershell
   cd "D:\Work_project\SDC Hackathon"
   git clone https://github.com/LevNyyon/whatsapp-digest-local.git
   cd "D:\Work_project\SDC Hackathon\whatsapp-digest-local"
   npm.cmd install
   ```

   Upstream declares Node 18+. Browser setup can use an installed
   Chrome/Edge/Brave; otherwise Puppeteer's browser may be needed. The inspected
   code also accepts `WA_CHROME_PATH` or `PUPPETEER_EXECUTABLE_PATH`. [L1, L3, L7]

2. Register its **stdio MCP server** in the AI client. For Codex, official
   documentation supports `[mcp_servers.<name>]` with a command, arguments
   and working directory. The following example uses the detected local
   `node.exe` path and the proposed checkout path; it is an example to merge
   with existing configuration, not a replacement configuration. [C1]

   ```toml
   [mcp_servers.whatsapp-digest]
   command = "C:/Program Files/nodejs/node.exe"
   args = ["D:/Work_project/SDC Hackathon/whatsapp-digest-local/src/index.js"]
   cwd = "D:/Work_project/SDC Hackathon/whatsapp-digest-local"
   startup_timeout_sec = 30
   tool_timeout_sec = 90
   ```

3. The optional instruction skill can be placed at
   `C:/Users/shaoj/.agents/skills/whatsapp-digest/SKILL.md` by copying the
   upstream `skill/SKILL.md`. Codex discovers user skills under
   `$HOME/.agents/skills`. The skill only describes a summarization workflow;
   the separate MCP server remains necessary. [C2, L9]

4. After the client loads the MCP configuration, check `whatsapp_status`.
   For a first-time unlinked account, call `link_whatsapp`; scan the local QR
   page from **WhatsApp -> Linked Devices -> Link a Device**, then wait until
   status is `ready`. A saved login that is reconnecting should be retried
   rather than reset or relinked immediately. [L1, L2]

5. Request a bounded read, for example:

   ```text
   list_chats({ "limit": 10 })
   get_messages({ "hours": 24, "chat": "Customer chat name" })
   search_messages({ "query": "order", "hours": 168 })
   ```

   These are MCP tool calls made by the AI client, not commands to paste into
   PowerShell. Ask the client to keep the source chat/sender/time alongside
   order text. The existing Releaf path is then to paste the chosen messages
   into **Customer message**; automatic forwarding has not been implemented.
   [L2, L3]

The WhatsApp connector itself does not need an extra LLM API key; the AI client
uses its own model. Releaf's existing extraction still uses its configured AI
provider. The tool is unofficial, read-only and limited to WhatsApp Web's
available synchronized history. It does not download order images for OCR or
send confirmations. Its local account session and any large-result JSON exports
should stay outside the Releaf repository. [L1, L3, L5]

## Options

| Approach | Authentication and intake | Sending | Fit |
| --- | --- | --- | --- |
| Paste text / process an exported chat | User supplies text or a file; no linked account needed for that processing | No live channel | Smallest demonstration dependency; preserves merchant review |
| LevNyyon digest-local | QR-linked WhatsApp Web session; local MCP read/search tools | No send implementation | Optional local intake experiment, with adapter changes |
| Official Meta Cloud API | Business app/account, access token and permissions; inbound HTTPS webhooks | Graph API with message-window/template rules | Recommended business integration |

The exported-chat option is supported by the parser skill's documented `.txt`
input, including locale-dependent timestamps, senders, multiline messages and
media markers. This research did not verify WhatsApp's export size limits or
implement that parser. [E1]

## LevNyyon Source Findings

Inspected revision:
[`a104fa2054fc4ce0b228fc3c68052e73e721afbf`][L0], committed
2026-07-03. Claims below describe this revision, not a live connection test.

- **Session:** `whatsapp-web.js` controls headless Chromium and uses `LocalAuth`.
  A phone QR scan links a device. Login data defaults to `.wa-session` in the
  project and can be redirected with `WA_SESSION_DIR`. Node 18 or later is
  declared; the package is MIT licensed. [L3, L7]
- **Transport:** each stdio MCP client forwards to one shared background
  HTTP helper. The helper defaults to `127.0.0.1:47291`, independently of
  Releaf's port 5174. It checks Host and `Sec-Fetch-Site` headers, but has no
  password/token authentication. Routes switch by path without consistently
  enforcing an HTTP method. It should remain a local helper, not a public API.
  [L2, L4, L6]
- **Actual tools:** source registers `whatsapp_status`, `link_whatsapp`,
  `list_chats`, `get_messages`, `search_messages` and `reset_whatsapp`.
  The README and manifest tool lists lag the six source registrations. [L1,
  L2, L8]
- **Reading limits:** `get_messages` accepts a 1-4320-hour window and an optional
  chat-name fragment. Its implementation defaults to at most 20 chats, with a
  per-chat cap of 800 messages for a named conversation or 150 for a broad
  scan. Search uses separate caps and reports partial coverage. These are
  bounded reads of WhatsApp Web's available synchronization, not a complete
  six-month archive guarantee. [L2, L3, L1]
- **Order ingestion gap:** returned messages contain sender, body, time and
  `fromMe`, grouped by chat name. Stable chat IDs and message IDs are not exposed
  in those results. The adapter would need source changes to provide reliable
  customer matching and replay deduplication. Media without text becomes a
  `[media]` marker; this is not image download or OCR. [L3]
- **Sending gap:** no send tool/function is exposed. The bundled skill is
  explicitly read-only. Sending a future digest to the account owner appears
  in the README roadmap, not the implemented feature set. [L1, L2, L3, L9]
- **Storage:** despite the README's broad no-message-storage wording, results
  larger than 60,000 characters are written as JSON under the operating system
  temporary directory's `whatsapp-digest-exports`. Authentication/browser data
  also persists. An AI client/model may receive the message text it reads.
  Do not describe this as "messages never touch disk or leave the machine."
  [L1, L3, L5]
- **Maintenance:** the README identifies the client as unofficial and warns
  about account restrictions and breakage after WhatsApp Web changes. These
  are the project's stated limitations, not an independent audit or a claim
  about every permitted WhatsApp integration. [L1]

## Official Meta Cloud API

Meta's inspected documentation describes sending through Graph API and receiving
customer messages and delivery-status events through HTTPS webhooks. The
business integration uses access tokens and permissions rather than a scraped
personal WhatsApp Web session. [M1, M2, M3]

The getting-started guide provides test resources and a temporary token, then
describes a system-user token for longer-lived development. Setup requires a
developer/business app, the appropriate business/account assets and a webhook
endpoint. Its example requests `business_management`,
`whatsapp_business_messaging` and `whatsapp_business_management`; the permissions
needed in production depend on the operations and account setup. This research
did not test onboarding, existing-number eligibility or account review. [M2]

Incoming webhook examples include the business `phone_number_id`, customer
identity, message `id`, `from`, `timestamp`, message type and text body.
Delivery updates have a separate `statuses` array. Those provider IDs give an
adapter a firmer deduplication and correlation basis than chat display names.
Do not label an accepted API request as delivered; consume the delivery status.
[M3, M4; adapter inference]

A customer message or call opens a 24-hour customer-service window under the
inspected send guide. Free-form service messages are available in that window;
outside it, use an appropriate template subject to Meta's requirements. An
order may take longer than that window to fulfill, so ready/delivery
notifications need a template-aware path. No pricing or unlimited-free-use
claim is made here. [M1, M2, M4]

For a future endpoint, validate the webhook subscription challenge separately
from event signatures. Meta documents `hub.verify_token` for the initial GET
verification and a SHA256 signature using the App Secret for incoming event
payloads, supplied as `X-Hub-Signature-256`. The verify token, App Secret and
messaging access token serve different purposes. [M5]

This is a business-message integration recommendation. It is not a claim that
Cloud API can dump arbitrary personal chat history. Account coexistence,
history and group capabilities require their own current eligibility and
documentation review before being promised.

## Proposed Releaf Adapter

The following is a design recommendation, not implemented API documentation.

1. **Normalize intake.** Keep provider/account configuration separate from the
   order service. Normalize `channel`, `accountId`, `conversationId`,
   `messageId`, `senderId`, `sentAt`, `text` and media metadata. Deduplicate
   provider events by account/message ID and keep their original source.
2. **Extract a draft.** Process permitted inbound business messages, ignoring
   the merchant's own outbound messages. Treat customer text and attachments
   as data, not instructions. Preserve requested products, quantities and
   preparation details in order notes. Extract a whole-order total only with
   exact source evidence; show missing totals for merchant confirmation.
3. **Confirm the business action.** A chat extraction must not itself accept an
   order, record payment or alter stock. A merchant or authorized Agent uses
   the same order actions and validation as the UI; existing Agent review
   settings remain in force. Orders are independent of inventory and have no
   warehouse issue action.
4. **Queue notifications separately.** A status change can prepare a
   notification with an idempotency key. Track pending approval, submitted,
   delivered and failed states, provider message ID and retry history. Check
   the service window/template before sending.
5. **Keep credentials on the server.** A channel's token/session is not an
   end-user Agent token. Apply existing workspace/account permissions to
   channel data and order actions. Expose a local read-only experiment only as
   such; do not make its helper a remote unauthenticated service.

This keeps the order workflow stable when switching from pasted text to a
local connector or official webhooks. Releaf's current order extraction and
copyable messages are described in [orders.md](orders.md).

## Other Repository Considered

[`kotevcode/whatsapp-mcp`][A1] uses Baileys, QR linking and persisted message
storage. It advertises reading/search, group statistics and sending to groups,
so it has a broader capability surface than the read-only digest. It is useful
comparison material, but is not a verified drop-in business-order channel or a
reason to prefer unofficial automation over Cloud API. Its README was reviewed;
no installation, Windows compatibility or sending was tested.

## Sources and Verification Limits

Primary repository files and official Meta pages were fetched on 2026-10-24.
Repository code was read only; no dependencies were installed or executed.
The Meta getting-started page showed an update date of 2026-06-16. Documentation
access does not establish successful onboarding, delivery, reliability,
security auditing or production pricing.

- [L0: inspected LevNyyon commit][L0]
- [L1: LevNyyon README][L1]
- [L2: MCP tool registrations][L2]
- [L3: WhatsApp client, reading and output mapping][L3]
- [L4: local HTTP helper routes and checks][L4]
- [L5: temporary-file export behavior][L5]
- [L6: helper lifecycle and shared port][L6]
- [L7: package requirements and license declaration][L7]
- [L8: manifest][L8]
- [L9: digest skill instructions][L9]
- [C1: Codex MCP configuration][C1]
- [C2: Codex skill discovery][C2]
- [M1: Meta Cloud API overview][M1]
- [M2: Meta Cloud API getting started][M2]
- [M3: Meta messages webhook reference][M3]
- [M4: Meta message sending guide][M4]
- [M5: Meta webhook verification and event validation][M5]
- [M6: Meta sample for token-authenticated message submission][M6]
- [E1: exported-chat parser skill][E1]
- [A1: alternative MCP README][A1]

[L0]: https://github.com/LevNyyon/whatsapp-digest-local/commit/a104fa2054fc4ce0b228fc3c68052e73e721afbf
[L1]: https://github.com/LevNyyon/whatsapp-digest-local/blob/a104fa2054fc4ce0b228fc3c68052e73e721afbf/README.md
[L2]: https://github.com/LevNyyon/whatsapp-digest-local/blob/a104fa2054fc4ce0b228fc3c68052e73e721afbf/src/index.js
[L3]: https://github.com/LevNyyon/whatsapp-digest-local/blob/a104fa2054fc4ce0b228fc3c68052e73e721afbf/src/wa.js
[L4]: https://github.com/LevNyyon/whatsapp-digest-local/blob/a104fa2054fc4ce0b228fc3c68052e73e721afbf/src/daemon.js
[L5]: https://github.com/LevNyyon/whatsapp-digest-local/blob/a104fa2054fc4ce0b228fc3c68052e73e721afbf/src/format.js
[L6]: https://github.com/LevNyyon/whatsapp-digest-local/blob/a104fa2054fc4ce0b228fc3c68052e73e721afbf/src/daemon-control.js
[L7]: https://github.com/LevNyyon/whatsapp-digest-local/blob/a104fa2054fc4ce0b228fc3c68052e73e721afbf/package.json
[L8]: https://github.com/LevNyyon/whatsapp-digest-local/blob/a104fa2054fc4ce0b228fc3c68052e73e721afbf/manifest.json
[L9]: https://github.com/LevNyyon/whatsapp-digest-local/blob/a104fa2054fc4ce0b228fc3c68052e73e721afbf/skill/SKILL.md
[C1]: https://developers.openai.com/codex/mcp
[C2]: https://developers.openai.com/codex/skills
[M1]: https://developers.facebook.com/docs/whatsapp/cloud-api/overview
[M2]: https://developers.facebook.com/docs/whatsapp/cloud-api/get-started
[M3]: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/components
[M4]: https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages
[M5]: https://developers.facebook.com/docs/graph-api/webhooks/getting-started
[M6]: https://github.com/fbsamples/whatsapp-api-examples/blob/main/send-messages-movie-ticket-app-js/messageHelper.js
[E1]: https://github.com/ShenSeanChen/launch-agent-skills/blob/main/skills/whatsapp-parser/skill.md
[A1]: https://github.com/kotevcode/whatsapp-mcp/blob/main/README.md
