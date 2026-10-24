# Render Demo Deployment

Deploy a separate, shared demonstration workspace. Never copy the local database,
WhatsApp sessions or `.env` into the repository or the hosted service. Registered
members share workspace data; this is not a tenant-isolated production SaaS.

## Before Deployment

If competition submissions are already frozen, obtain organizer permission before
changing submitted code or links. Deployment preparation does not establish that
permission. The deployment branch is separate from the existing `main` submission.

## Service Settings

In the Render dashboard, choose **New > Web Service**, connect GitHub and select
`sjq98/Releaf`. Use the `deploy/render` branch.

| Setting | Value |
| --- | --- |
| Name | A unique name such as `releaf-demo` |
| Language | Node |
| Region | Singapore if offered for the selected plan |
| Root Directory | Leave blank |
| Build Command | `npm ci` |
| Start Command | `npm start` |
| Health Check Path | `/healthz` |
| Instances | One |

The repository pins Node 24.19.0 in `.node-version`. Render supplies `PORT`,
`RENDER=true` and `RENDER_EXTERNAL_URL`; the hosted server binds to `0.0.0.0`.
The Windows launcher remains local-only and is not used on Render.

## Storage and Environment

Choose a paid web-service compute plan and add a persistent disk under Advanced:
mount path `/var/data`, initial size 1 GB. Review the displayed service and disk
charges before creating anything. Render does not support persistent disks on
free services; without a disk, SQLite changes are not durable.

Set these environment variables in Render before the first deployment:

| Variable | Value |
| --- | --- |
| `ORDER_DB` | `/var/data/forms.sqlite` |
| `RELEAF_ADMIN_USERNAME` | Your chosen administrator username |
| `RELEAF_ADMIN_DISPLAY_NAME` | Your chosen display name (optional) |
| `RELEAF_ADMIN_PASSWORD` | A unique password of at least 12 characters |

Do not put the password in Git, this document, screenshots or the chat.
On a fresh hosted database, startup creates the administrator from these values,
then discards its bootstrap session. Public first-admin setup is disabled in
hosted mode. Later restarts do not change an existing administrator or password;
use the account password screen to change it. Normal member self-registration
remains available.

Render's automatically supplied HTTPS URL is the allowed browser/API origin.
For a custom domain, set `RELEAF_PUBLIC_URL` to that exact HTTPS origin, without
a path. Only that configured domain will work for API calls. Forwarded headers
are not used to broaden the allowed origin or identify clients.

To enable AI, set the provider keys, model names and base URLs from `.env.example`
in Render's environment settings, or sign in as the administrator and configure
the providers in the app. Keys remain server-side; SQLite provider settings are
not application-encrypted. Only trusted administrators should manage this demo.

## Verify Before Sharing

1. Wait for a successful deploy and open the service's HTTPS URL.
2. Sign in with the administrator account set above.
3. Set up warehouse tables and create non-sensitive demonstration catalog entries.
4. In a private browser window, register a Member and verify expected workflows.
5. Confirm Members cannot access user management or administrator settings.
6. Restart the service and verify accounts, records and attachments persist.
7. Share the resulting HTTPS URL as the Live Prototype URL, not the GitHub link.

The local WhatsApp helper is not included in this deployment and does not connect
to your computer remotely. Do not expect hosted WhatsApp import to work.
Login/registration rate limits use the direct socket address, not unverified
forwarded IP headers; users behind the same hosting proxy can share a rate limit.
Use this as a small shared demo, not unrestricted production infrastructure.

## Official References

- https://render.com/docs/web-services
- https://render.com/docs/disks
- https://render.com/docs/environment-variables
- https://render.com/docs/node-version
- https://render.com/docs/health-checks
