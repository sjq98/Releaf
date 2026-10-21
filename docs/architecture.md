# Architecture

## Current System

```text
Browser (public/)
    |
    | same-origin HTTP / JSON
    v
Node.js server (src/server.js)
    |-- store.js ---------> SQLite (data/forms.sqlite, not committed)
    |-- field-types.js ---> Shared normalization / validation
    |-- modules.js -------> Order Management / Meeting Follow-up definitions
    `-- ai-config.js -----> Upstream model list / saved configuration
             |
             `-- meeting-ai.js ---> Configured external AI provider
```

The native Node.js HTTP server serves an explicit allowlist of browser assets. `src/field-types.js` and `src/errors.js` are deliberately served as shared browser modules; server-only code, environment files, and the database are not served. Moving source files into `src/` does not change the public asset URLs or the default database location.

## Orders and References

Tables define stable field IDs, names, types, and constraints. Records contain values keyed by those IDs. A separate unique-value index enforces uniqueness, while version numbers detect stale writes.

Every record creation, update, and deletion creates a history event. Updates store field-level differences. Editing a schema is not itself a record history event, and changing an order does not automatically create a follow-up task.

Reference values hold target record IDs. Display labels are resolved from the target table's unique field, so renaming an order number preserves its links. Deletion and incompatible schema changes are blocked when they would invalidate references.

## Meeting Extraction

1. The user supplies a meeting title, date, and text.
2. The server builds a structured extraction request from the current table schema and permitted reference candidates.
3. The configured provider returns proposed values and evidence quotes.
4. The server validates the structure, values, reference IDs, and verbatim evidence, then stores a draft.
5. The user corrects the draft and selects items.
6. A transaction creates the selected records and retains source provenance. Repeating a completed commit returns the existing result.

AI output is data, never executable SQL or application code. Tests mock provider responses; a passing suite does not prove that any particular upstream model supports strict structured output.

## Configuration and Data

Saved provider settings override environment fallback settings and apply without restarting. Environment changes require a restart. The API returns whether a key is present, never the saved key itself.

SQLite stores business records, meeting source text, drafts, history, and saved provider credentials. Credentials are not encrypted at rest. Extraction sends meeting text, field definitions, and relevant reference identifiers/unique values to the chosen provider. No automatic data-retention policy is implemented.

## Integration Status

Orbyte integration, Replit deployment, and RunPod-specific integration are not implemented. The existing REST interface is a possible starting point for a future adapter, but it currently has no user authentication or authorization and rejects cross-origin browser requests.

The local server binds to `127.0.0.1`; cloud deployment and multi-user access need explicit work. No diagram or configuration here claims a live sponsor-platform integration.
