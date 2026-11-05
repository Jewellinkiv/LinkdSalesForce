# Normalized migration: dry run first

The import command loads reviewed account/contact/opportunity records from a private normalized JSON file. It does not fetch Monday data, guess field mappings, merge ambiguous accounts, recreate old automations, or send messages. Keep exports and reports outside source control, for example in the ignored `.local/` directory.

```sh
npm run db:import -- .local/reviewed-import.json
# Only after resolving every review row:
npm run db:import -- .local/reviewed-import.json --apply
```

The default command is read-only. Applying recomputes the plan under a transaction and advisory lock. Any review issue blocks the entire batch. Previously imported source IDs are skipped; they are not silently updated. This is a first-pass importer, not a continuing synchronization service. The audit log records each import and its run summary.

Example (fictional data only; replace ownerEmail with an existing active team member):

```json
{
  "source": "monday-reviewed-accounts",
  "rows": [
    {
      "externalId": "example-001",
      "name": "Example Jewelry",
      "contactName": "Example Person",
      "email": "example@example.test",
      "phone": "",
      "ownerEmail": "alex@example.test",
      "city": "Example City",
      "pos": "The Edge",
      "locations": 1,
      "kind": "deal",
      "stage": "Won",
      "package": "Full suite",
      "lifecycle": "active",
      "mrr": 500,
      "currentMrr": 450,
      "setup": 100,
      "discount": 50,
      "effectiveDate": "2025-02-01",
      "closedAt": "2025-01-15T18:00:00.000Z",
      "notes": "Reviewed historical notes",
      "doNotContact": false,
      "smsConsent": false,
      "emailConsent": false,
      "smsOptedOut": false,
      "emailSuppressed": false,
      "consentSource": ""
    }
  ]
}
```

Open records also require `nextAction` and `nextActionAt` (ISO timestamp). Closed records require their original `closedAt`; never substitute the import time. MRR, setup and amount discounts are dollars and stored as cents. Set `discountType` to `percent` for a percentage discount; a value of 10 stays 10%, never $10. `currentMrr` may be null when unverified. Permission defaults false and requires a source when enabled. Preserve explicit opt-out/suppression and do-not-contact fields from the source.

The preview flags duplicate external IDs, repeated company/contact destinations, companies already present, missing owners, invalid stage/kind combinations, missing follow-ups, missing original close dates, and permission without a source. The schema currently requires globally unique nonempty contact emails/phone numbers. Shared store/direct/cell numbers and extra email text can be preserved in `contactProfile`. Verified multi-account links use one canonical contact; select explicit `companyId` and `contactId` for an existing relationship. Never discard a value to make an import pass.

Each row creates one opportunity and defaults to a new account/contact. Explicit existing account/contact IDs allow reviewed relationships to be reused. A contact must already be linked to the selected account. Existing permissions are never automatically upgraded; imported restrictions can only strengthen them. Historic Won records never create fresh checklists or welcome jobs. An explicit `project` preserves its original phase, timestamps, role owners, readiness, scope and supplied tasks. No missing task/phase history is invented.

## Preparing a Monday CSV export

Keep exports private. Export stable item IDs and a single header row; remove title/group-summary rows. Supply an explicit mapping rather than relying on guessed Monday column names or ambiguous date/currency formats:

```json
{
  "source": "monday-reviewed",
  "columns": {
    "externalId": { "column": "Item ID" },
    "name": { "column": "Company" },
    "contactName": { "column": "Contact" },
    "email": { "column": "Email" },
    "discount": { "column": "Discount", "type": "number" },
    "stage": {
      "column": "Stage",
      "values": { "New": "New lead", "Contacted": "Contacted" }
    }
  },
  "defaults": {
    "phone": "",
    "ownerEmail": "alex@example.test",
    "discountType": "percent"
  }
}
```

```sh
npm run monday:prepare -- .local/source.csv .local/reviewed-mapping.json .local/normalized.json
npm run db:import -- .local/normalized.json
```

Preparation accepts quoted/multiline CSV, fails on missing columns/unmapped values/invalid schema, requires a stable item ID and explicit discount units, and only writes inside `.local/`. It never overwrites an existing import file. Dates must be reviewed ISO dates/timestamps; numeric columns must be plain decimals. Boolean labels require an explicit mapping or true/false. Open records still need a real next action/date; preparation does not invent these. Original columns are preserved in `sourceFields`. CSV is a preparation format, not a claim that all Monday relationships, files or private email are present in one export.

## Preserving ongoing work and history

The schema in `src/server/import-history.ts` defines optional enrichment fields for a reviewed batch:

- `companyId` / `contactId`: reuse existing reviewed IDs. Resolve links in Directory first. No automatic fuzzy merge or deduplication.
- `accountProfile`, `contactProfile`, `sourceFields`: bounded text dictionaries. Preserve extra source values even when they do not map to an active sending destination.
- `project`: phase/package/source, technical/CS/sales owner emails, original `startedAt`, `phaseStartedAt`, `targetAt`, completion/intake/billing/go-live dates, blocker, readiness, scope and exact `tasks`. Include original `completedAt` for completed projects/tasks. Every owner must match an active teammate. An existing active project blocks importing another one for the same account.
- `tasks`: standalone historical or open tasks, including owner, due date, progress and resolution.
- `history`: dated title/body/kind activity entries.
- `messages`: dated email/SMS records with explicit direction and historical status. Imported records are archival, use no provider ID or idempotency key, and never create send jobs.
- `files`: original name, MIME, base64 content and creation date. The same attachment validation applies as live intake.

Enrichment is explicit; obtain original files/messages and review their sharing policy before supplying them. Import only history intended for this shared internal workspace. The source payload and resulting account/contact/opportunity IDs are retained for reconciliation. A source ID is immutable after import; changed payloads require review rather than a silent resync. Re-running the same reviewed batch skips imported IDs. Applying a batch is transactional and reruns collision/owner/file checks.

Compare source record IDs, current recurring revenue, won amounts by original close month, ongoing phase/task counts and history/file counts before switching over. The automated tests prove preservation for fictional records; no actual source totals or complete production export have been reconciled. Back up the target before a production import; roll back a failed pilot using that backup before accepting new production writes.
