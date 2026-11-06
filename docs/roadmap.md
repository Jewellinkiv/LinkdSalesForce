# Remaining rollout work

The [workflow release guide](workflow-release.md) records the implemented audit follow-up. Core editing, linked qualification, repeat opportunities, ownership, readiness, intake, reminders, reports, invitations, history pagination, and initial migration tooling are now implemented.

## Controlled pilot and cutover

- Configure hosted web/worker processes, backups, monitoring, and a fresh production database.
- Complete live Twilio/Postmark validation using controlled recipients and numbers.
- Resolve legacy webhook destinations and inconsistent automation descriptions with the relevant owners.
- Map actual source data, review duplicates/shared contact destinations, and reconcile source populations against the reporting definitions.
- Extend normalized imports for historic links, full activity/files, and in-progress onboarding; preserve original dates and suppressions.
- Run sales, onboarding, and CS acceptance scenarios before switching systems.

## Further product work

- SSO/MFA, password recovery, finer record-level permissions, retention/deletion, and restore testing.
- Inbound call routing, voicemail, availability, and missed-call tasks.
- AI call summaries and suggested follow-ups with rep review.
- Mailbox-history continuity, full conversation threading, email attachments, and server-side archive search beyond recent inbox/call lists.
- Broader configurable sequences, template management, holiday calendars, and optional staff email/push notification delivery.
- Actual product adoption/Academy/billing integrations; readiness fields currently capture human verification.
- Shared contact/phone modeling, controlled merging, correction/reversal workflows for won deals, and ongoing synchronization.
