# Meeting Tasks

The **Meeting Tasks** Space appears alongside **Inventory Management System**.
It contains a protected **Tasks** form and a **Meeting to tasks** import view.
Warehouse forms and workflows remain in their original Space.

## Import

1. Configure the workspace AI provider using **AI settings**. The Assistant's
   separate provider is not used for meeting extraction.
2. Select **Meeting Tasks** in the Space selector.
3. Paste a summary, or use **Import file** for a UTF-8 `.txt` or `.md` file
   (up to 200 KB and 40,000 characters).
4. Set the meeting title and date, then select **Extract and create tasks**.

The button extracts and immediately creates records; no separate approval step
is required. The summary and title are sent to the configured AI provider.
Only explicit actionable commitments are requested. Unknown owners, deadlines
and acceptance criteria remain empty, and new tasks default to Open.
AI output must contain exact quotes present in the summary, but matching quotes
do not guarantee a semantically correct interpretation. Review and edit tasks
in the task table after import.

Each task stores the action, owner, due date, status, acceptance criteria,
meeting title/date and source quote. Recent imports retain the original summary
and links to created records; this history is an import-time snapshot, not a
live copy of subsequently edited tasks. Editing or deleting a task does not
erase the original summary or cause re-import to recreate deleted tasks.

Administrators can import and edit task records. Members can read the tasks and
import history, matching the application's existing custom-form permissions.
Task core fields and deletion of the system task table are protected. Labels,
order and additional fields can be customized; extra required fields still have
to satisfy the ordinary record validation rules.

## Reliability

- Up to 50 tasks per import.
- The same meeting date and trimmed summary are imported only once, even with
  a changed title or concurrent requests. Whitespace/content changes or a
  different meeting date count as a different summary.
- An empty extraction creates a history entry but no task records.
- Invalid AI output, provider failure or validation failure creates no tasks.
- All task records, activity and import history commit in one transaction.
- Schema changes or lost admin privileges during inference reject the write.
- Only the latest 100 imports are listed; older imports remain stored.

## HTTP API

All endpoints require a local browser session. Writes require an administrator.

| Method | Path | Input |
| --- | --- | --- |
| GET | `/api/meeting-tasks/imports?spaceId=meeting-tasks` | Recent imports |
| GET | `/api/meeting-tasks/imports/:id?spaceId=meeting-tasks` | Original summary and created task IDs |
| POST | `/api/meeting-tasks/imports` | `{ "spaceId": "meeting-tasks", "title": "...", "date": "YYYY-MM-DD", "text": "..." }` |

POST accepts an `Idempotency-Key` header and returns the saved import with an
`items` array and `duplicate` boolean. Reusing a saved request key with different
content returns 409. The old `/api/meetings` API remains retired (410).
