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

Open records also require `nextAction` and `nextActionAt` (ISO timestamp). Closed records require their original `closedAt`; never substitute the import time. Monetary values are dollars and stored as cents. `currentMrr` may be null when unverified. Permission defaults false and requires a source when enabled. Preserve explicit opt-out/suppression and do-not-contact fields from the source.

The preview flags duplicate external IDs, repeated company/contact destinations, companies already present, missing owners, invalid stage/kind combinations, missing follow-ups, missing original close dates, and permission without a source. The schema currently requires globally unique nonempty contact emails/phone numbers. Shared store numbers and multi-company contacts require a deliberate relationship model and merge decision; they must not be discarded to make an import pass.

Each row currently represents one account with one initial contact/opportunity. Additional contacts and opportunities can be created through the app afterward; existing multi-record source relationships need a richer mapped batch before actual cutover. Historic Won records do not create new onboarding projects or welcome jobs. Preserve/reconcile ongoing onboarding separately rather than resetting it to Handoff. Full historical messages, attachments, stage history, and file migration are not included in this normalized importer.
