# Architecture and workflow behavior

## Application

Next.js App Router and React provide the web workspace. Server route handlers use Zod validation and PostgreSQL transactions. The database is the system of record; the browser refreshes workspace data every 15 seconds and after writes. Twilio and Postmark credentials stay server-side. An independent Node worker processes scheduled communications and transcription jobs.

| Area                           | Responsibility                                             |
| ------------------------------ | ---------------------------------------------------------- |
| `src/components/workspace.tsx` | Team workspace and browser call controls                   |
| `src/server/domain.ts`         | Lead creation, stages, onboarding gates, message queueing  |
| `src/server/auth.ts`           | Password hashing, sessions, origin checks, role checks     |
| `src/server/providers.ts`      | Provider requests, voice tokens, webhook authentication    |
| `src/server/webhooks.ts`       | Incoming replies, delivery/suppression events, recordings  |
| `src/server/worker.ts`         | Job claiming, sending, transcription, crash recovery       |
| `migrations/`                  | Versioned database changes, applied under an advisory lock |

## Records

Companies hold business details, POS, location count, source, and owner. Contacts hold communication destinations and recorded permissions. Opportunities hold package, stage, MRR, next action, and won/lost information. Onboarding projects belong to won opportunities; a unique constraint allows only one project per opportunity. Tasks connect sales follow-ups or onboarding work to owners and due dates.

Activities provide a shared customer timeline. Messages, calls, and provider event identifiers preserve communication state. Jobs carry scheduled work with unique deduplication keys. Sessions store hashed tokens; passwords use salted scrypt. Cookies are HttpOnly/SameSite and Secure in production. Mutation routes require the configured same origin; provider routes instead authenticate the provider.

## Sales and onboarding rules

The initial stages are New lead → Contacted → Demo scheduled → Decision → Won, with Lost and Be back available. Creating a lead requires a dated next action. Contacted schedules a two-day follow-up. Be back keeps a future reconnect task, defaulting to 30 days when the previous date has passed. Lost requires a reason. Won requires package, contact, POS, and locations and creates the onboarding checklist atomically. Won records are preserved rather than reopened.

The onboarding phases are Handoff → Intake & pre-build → Working session → Training → Go-live → Adoption → Onboarded. Each phase requires its tasks to be complete and its blocker resolved. Full suite, Data & training, Texting, and Training only produce different checklists. The initial welcome task is due in one day. Initial task offsets use calendar days, not a business-day/holiday calendar. The owner defaults to the first onboarding team member, falling back to the person winning the deal.

This release creates tasks automatically; it does **not** automatically send a welcome email when a stage changes. A team member reviews a template and queues a message. The worker then delivers it at its scheduled time.

## Communication reliability

Queueing a message checks permission and suppression, saves the record and job in one transaction, and uses a request idempotency key. The worker claims jobs using `FOR UPDATE SKIP LOCKED`, rechecks permission, and marks sending before calling the provider. Messages retain the mode in which they were queued; changing demo/live configuration cancels a mismatched job.

An incoming reply cancels that contact’s queued messages across channels. STOP suppresses SMS; START clears the carrier opt-out without inventing consent. Hard bounces, spam complaints, and subscription suppressions stop queued delivery. Postmark reactivation does not automatically restore permission. The UI exposes these flags but does not yet include a consent-editing workflow.

Ambiguous external sends are marked **review**, never automatically resent. A process can fail after a provider accepts a request but before its ID is saved. Check provider logs before manually creating a replacement message. Stale running jobs are reconciled after ten minutes. Transcription polling retries with bounded backoff; an uncertain transcription creation also requires review. A reply or opt-out arriving after an external send has already begun cannot retract that send.

## Reporting definitions and limits

MRR is the manually entered monthly contract value in USD cents, not accounting or collected revenue. Open pipeline excludes Won, Lost, and Be back. Booked MRR totals Won opportunities; onboarding MRR uses their associated projects. Win rate compares Won to closed Won/Lost opportunities, with no cohort attribution. These are operational counts, not billing analytics.

The current workspace loads all customer, task, and onboarding records, the latest 200 messages/activities, and 100 calls. Search and communication counts are limited to those loaded records. Add server pagination and date/cohort filters before a large migration. Dates display in the browser’s timezone. Reports do not yet provide historical snapshots, exports, or custom filters.

## Deployment boundary

Run the web app and persistent worker against the same PostgreSQL database. Use migrations as a separate release step, a managed database with backups, and HTTPS at the ingress. Keep `APP_URL` exactly aligned with the external callback URL. Use an environment secret manager and a dedicated production database role; the included Compose credentials are local-only.

There is no multi-tenant separation. Authenticated users see all customers, messages, and recordings. Sales/admin can create leads, move deals, and initiate calls; onboarding/admin can advance onboarding or change blockers. Shared notes, follow-ups, messages, task completion, and call outcomes are available to authenticated team members. Fine-grained permissions, invitations, MFA, password recovery, recording retention/deletion, monitoring, and operator reconciliation UI remain deployment prerequisites for a broader rollout.
