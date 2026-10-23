# Retired Business Modules

The active application now has one fixed warehouse system and the generic custom-form engine.
The former seeded Orders table, meeting follow-up, supplier reconciliation, recipe/purchase inventory
and configurable receiving actions are no longer loaded, served or available as Agent tools.

Their source already exists in the independent [cross-form prototype snapshot](../cross-form-automation/README.md).
Files in `tests/*.reference` preserve historical tests, not active-product coverage.
Current spreadsheet-import coverage lives in `../../tests/table-import.test.js`.

Existing business rows are not physically purged. The one-time cleanup script creates a complete
SQLite backup in ignored `data/backups/`, retires only registered legacy templates, removes their
navigation entries and preserves custom forms and the current warehouse. Cross-references from
custom forms/tasks block cleanup instead of being silently removed.

```powershell
node scripts/retire-legacy-forms.mjs data/forms.sqlite --apply
```

Stop the local server before running maintenance. This is a local maintenance script, not a
user- or Agent-callable endpoint. Deleted historical rows have no active read/write route.
