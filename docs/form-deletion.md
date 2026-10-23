# Form Deletion and Legacy Cleanup

## User Interface

Use the trash icon beside table settings, or the sidebar form's ellipsis menu and trash
icon. The dialog names the form, counts records and notification rules, and lists
blockers. Cancel is initially focused. Nothing is deleted until **Delete form** is confirmed.

Core warehouse forms cannot be deleted individually. Referencing schema fields block
deletion even with no records. Remove dependent AI tasks or external notification
lookups first. Tasks with run history retain their existing deletion protection;
their forms cannot be removed while those tasks exist.

Deletion removes the form and records from the active workspace, not local historical
storage. There is no restore UI or automatic purge policy.

## Shared Interface

- `GET /api/forms/:id/deletion-preview`: name, version, record count, notification-rule
  count, blockers, `canDelete` and fingerprint.
- `DELETE /api/forms/:id`: `{ version, fingerprint, confirmed: true }`; local-only,
  with optional `Idempotency-Key`.
- Agent `preview_form_deletion { formId }` returns the same impact information.
- Agent `delete_form { formId, version }`, also available as
  `DELETE /api/agent/forms/:formId`, always creates a pending action. Only local human
  approval executes it, including full access.

Changed records/schema/dependencies invalidate the preview. Approval rechecks the
Space fingerprint and deletion rules. No partial deletion occurs. Idempotent retries
return the existing result. Removing a Space's last form leaves a valid empty workspace.

## Legacy Cleanup

Stop the server and run this local maintenance script:

```powershell
node scripts/retire-legacy-forms.mjs data/forms.sqlite --apply
```

It makes a complete SQLite backup in ignored `data/backups/` before cleanup. It retires
registered legacy meeting/supplier/recipe/purchase tables and the original seeded Orders
template, removes obsolete navigation and preserves user-created forms and warehouse
roles. External custom references/tasks block cleanup. History and credentials remain.
The script is idempotent and is not exposed to users or Agents.

Legacy routes return 410; old assets/tools are no longer served. The independent
`future/` snapshot preserves the old implementation for demonstration.
