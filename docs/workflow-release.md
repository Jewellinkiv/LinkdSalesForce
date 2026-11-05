# Sales and onboarding workflow release

This release closes the core day-to-day gaps identified in the initial workflow audit. It keeps one account page while separating leads, qualified deals, and customer lifecycle. The application still needs provider configuration, migration reconciliation, and a controlled team pilot before it replaces the current system.

## Sales work

- **Edit record** updates company/contact details, account and opportunity owners, POS, locations, package, MRR, setup fee, discount, appointment, effective date, permission source, lifecycle, and do-not-contact restrictions. Version checks reject stale saves. Won package changes require a new opportunity to preserve the original sale.
- **Qualify lead** creates exactly one connected deal and transfers open follow-up tasks. Repeated qualification does not duplicate the deal. New leads may use **Undecided** until the package is known.
- Add contacts and repeat opportunities to an existing account. The customer page lets you choose the lead/opportunity whose commercial details and primary contact you are viewing. The record editor's contact selector edits other contacts without changing an opportunity's primary contact.
- Leads and deals have separate views with owner/My Work filters, Be Back, and Missing Next Action. Customer records have lifecycle filters. Account ownership and opportunity ownership are independent.
- Rescheduling a next action supersedes its prior task without marking it completed. Independent tasks remain open. Tasks support owner/date changes and explicit completion/cancellation; required onboarding tasks cannot be cancelled.
- Company- and contact-level do-not-contact restrictions block email, SMS, and calls. The worker rechecks restrictions, permission, destination, and delivery mode. Provider opt-outs/suppressions cannot be cleared by editing consent.
- Customer history is paginated independently of the recent workspace feed. The cursor preserves database timestamp precision and uses the event ID to break ties.

## Onboarding and intake

New won deals create package-specific checklists and a staff notification. Existing customers can start a project without fabricating another sale. The project editor assigns technical, customer-success, and sales/training owners and distributes open tasks by responsibility.

Readiness tracks user-list review, POS data, texting, branding, calendar, webchat, applicable social/payment connections, training, Academy modules, manager readiness, live operation, and adoption. Statuses are not started, in progress, verified, or not applicable. Verification and exclusions require evidence/reasons. These fields record the team's work; they do not provision the customer's external systems.

Phase advancement checks both tasks and readiness. Intake must be received before the working session. Applicable data/texting must be moving before that session and verified before training. Training/module/manager readiness is required. Graduation requires live and adoption confirmation.

Staff can issue a 30-day intake link. Manually issuing a replacement revokes older links. Links contain random bearer tokens; only their hashes are stored. The customer form collects contact/POS/location details, desired start, a user list, and requirements. It accepts up to three CSV/TXT/PDF files of 2 MB each. Submissions are idempotent and create staff notifications; they do not silently overwrite verified account details. Staff review the submission before confirming readiness. Files are stored in PostgreSQL and downloaded through authenticated routes as attachments. They are not rendered inline or scanned by an external malware service.

A target-date change shifts unfinished working-session/training/launch/adoption deadlines. Once actual go-live is entered, adoption checks are based on that date: one week and 30 days. Individual tasks remain editable. Initial phase offsets still use calendar days; the intake reminder uses Monday–Friday business days in UTC without a holiday calendar.

## Notifications and automation

**Notifications** contains handoffs, intake submissions, owner assignments, phase changes, overdue tasks, and approaching/overdue targets. Deadline processing requires the worker. The view contains the latest 100 notifications for the signed-in user. These are in-app staff notifications, not automatic staff emails.

An administrator can enable customer welcome and missing-intake email rules in **Settings → Configure automations**. Both are off by default. Welcome requires an HTTPS scheduling link and includes an automatically issued intake link. The reminder runs after two business days if intake remains missing. Rules apply to newly won handoffs; enabling them does not backfill old projects.

Incoming replies cancel pending automated follow-ups and queued messages for that contact. Intake submission cancels its pending intake reminder. Existing consent, suppression, and communication mode checks still apply. Demo-created automation jobs cannot become live sends when configuration changes.

**Review delivery issues** gives administrators provider/message references and a reconciliation log. Unknown sends require an explicit verification that the provider did not accept the request before retry. Requests with a known provider ID cannot be retried through this flow. Transcript-creation uncertainty requires provider reconciliation, not blind creation of another transcript. Closing a review never sends a message.

## Reporting definitions

Reports include owner filters, a close-reporting month, detail lists, and CSV export of the selected detail. Metric definitions:

| Metric                | Definition                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Current MRR           | Sum of **verified current account MRR** on active customer records. Blank amounts are excluded and surfaced as incomplete data. |
| Active customers      | Distinct accounts with lifecycle `active`.                                                                                      |
| Active locations      | Location counts on those active accounts.                                                                                       |
| Pipeline MRR          | Open qualified deal values, excluding Won, Lost, Be Back, and lead records.                                                     |
| Booked MRR            | All-time Won deal values, including repeat sales. This is not current account or collected revenue.                             |
| Closed won this month | Won deals whose original close timestamp falls in the selected UTC month.                                                       |
| Onboarding MRR        | Associated deal values for unfinished projects. An existing-customer project without a deal contributes zero.                   |
| Monthly win rate      | Won divided by Won + Lost, using close timestamps in the selected UTC month.                                                    |

Account metrics filter by account owner, deal metrics by opportunity owner, and project metrics by any assigned project owner. Current MRR is manually verified contract data, not billing-system integration. Initial existing demo accounts have no invented current MRR. Historical source widget populations must be reconciled before comparing totals.

## Team administration

Administrators generate one-time invitations, valid for three days. Share the link directly with the teammate. The recipient creates a password of at least 14 characters. Admins can change other users' roles or disable access; existing sessions are revoked. Self-access changes are blocked. All enabled users can read the shared internal workspace. Finer record-level access, SSO/MFA, password recovery, and recording retention remain follow-up work.

## Upgrade and checks

Apply `npm run db:migrate`, then restart the web and worker processes. Migration 003 is additive apart from widening stage/package checks. It retains existing records and classifies prior progressed/won opportunities as deals. It does not invent historical qualification records or mark existing readiness as verified. Review and populate readiness on existing projects before further advancement.

The suite now covers 36 database-backed scenarios: existing communications safeguards plus stale-edit rejection, linked qualification, additional contacts/opportunities, DNC at queue/send/call time, truthful task rescheduling, private/idempotent intake, readiness gates, go-live-relative deadlines, reminder deduplication, history pagination, team access, normalized import behavior, automation mode isolation, operator retry safety, preservation of qualification terms, next-action creation alongside independent work, and a complete intake-to-graduation scenario using active owners. Browser checks covered lead creation/editing/qualification, replacement follow-ups, simulated email/SMS/calls, won handoff, phase rejection, reporting totals, owner filtering, and customer intake submission/review. Live provider calls remain untested.

## Local QA fixes

The hands-on QA pass found and corrected qualification dropping setup fee, discount, effective date, and appointment; qualification skipping a next-action task when independent work remained; handoffs selecting disabled onboarding staff; and sales-view totals showing unrelated deal values. Overview metrics and onboarding previews now honor the owner filter consistently. Browser back/forward resets view-specific filters to prevent an incompatible lead/deal tab from hiding records.

## Remaining cutover dependencies

- Configure and validate Twilio/Postmark in a controlled environment. Configure hosting, backups, and worker monitoring.
- Map the actual source exports and reconcile shared contacts, existing links, historical onboarding progress, files, and activity. The normalized importer is intentionally not an unreviewed whole-workspace migration.
- Resolve ambiguous/disabled legacy automations and the unknown external stage webhook; do not duplicate them automatically.
- Agree on verified current MRR and monthly reporting populations, then reconcile totals against the source.
- Run sales/onboarding/CS acceptance scenarios. Add finer permissions, recovery/SSO, and retention before broad deployment as needed.
- Inbound call routing, AI call summaries, mailbox-history sync, rich email/threading, remain separate enhancements. Customizable email/call sequences are now included below. Recent inbox/call lists remain bounded; complete activity history is available per customer.

## Team workflows expansion

`/?view=operations` adds research review and correction, explicit approval/conversion, customer-success recurrence, email/call sequences, account/contact verification, detailed service scope, a paginated communication/file archive, and a cutover dependency register. The public `/contact` form creates a review item and never grants marketing permission. It additionally asks for company name so the team can match accounts before conversion.

- Cadences default to 45 calendar days. On the due date the worker creates one check-in and advances the next due date by whole intervals until it is in the future. Missed tasks remain open. Only active accounts with active owners generate new work. Graduation creates a default cadence; existing customers can be configured explicitly. Meeting/contact dates record completed interactions, not scheduled appointments.
- Sequences snapshot their steps and send window on enrollment. Waits are calendar days after the preceding step completes; email steps wait for provider acceptance (or a demo simulation), and call steps wait for a completed task. Replies, suppression, closed/deferred opportunities, disabled senders, and demo/live changes stop the enrollment. Pausing holds queued work. Uncertain delivery requires operator review and does not automatically resend. Existing enrollments keep their snapshots when the sequence is edited or closed to new enrollments. Emails use the configured workspace sender, with enrollment owner recorded for accountability. An in-flight provider request cannot be recalled by pausing.
- Sequence counts separate actual provider acceptance from demo simulation. Open/click counts are provider observations; outbound tracking remains off by default. Missing observations do not establish that a recipient did not engage. Research and enrollment lists currently show the most recent 1,000 rows; sequence counts cover all rows. The paginated archive covers all message, call and customer/intake attachment records.
- A canonical contact can be explicitly linked to multiple accounts with verification evidence. Sending/calling from a record uses that account's restrictions/history. Channel suppression stays with the canonical contact. Inbound replies stop that contact's queued outreach across accounts; unmatched account context remains on the primary account pending review. Extra store/direct/cell numbers and email text are preserved as reference fields, not silently turned into permitted outbound destinations. Existing accounts can be selected on lead creation; duplicate-name account creation is rejected.
- Discounts now explicitly distinguish amount from percent. Percentage values remain percentages through editing, qualification and import. Effective date, close date, billing date, and actual go-live remain separate; Won does not overwrite a previously supplied effective date.
- Intake includes country, EDT license, team overview, texting request/platform/number choice, and data-transfer intent. A user list is optional at submission; staff readiness gates still require review before advancement. CSV/TXT/PDF/XLSX/DOCX attachments have a 2 MB limit each; Office containers are checked and served as authenticated downloads, never executed or previewed. These checks are not a malware scanner.
- Service scope records data method/timing, texting provider/number, authorization and registration references, payment status, add-ons and role-based Academy assignments. Project cards show elapsed/phase days, target and blockers. These fields document evidence; they do not provision third-party accounts or synchronize Academy usage.
- Settings can route new handoffs to named technical and CS owners. Disabled configured owners block a new handoff rather than silently losing it. Optional staff email copies default off and use Postmark with mode pinning, disabled-recipient checks and operator review for uncertain delivery. Staff notifications remain available in-app. Administrators can manage template content, availability and phase assignment in Team workflows → Templates. Integration-prerequisite and working-session agenda templates are included. Automatic phase delivery requires both an active automatic template and the Settings rule, which defaults off. Phase jobs snapshot content, preserve mode and permission checks, and flag projects without a linked recipient for manual review. Starter templates and active managed templates are available in the message composer.

Migrations 004–008 are additive. Run migrations before restarting both the web app and worker. Local automated coverage is now 55 database-backed scenarios, plus successful typecheck and production build. Browser QA covered public inquiry → review → approval → conversion, permission rejection for sequence enrollment, a consented demo enrollment, pause/stop, account review and cadence setup. Provider delivery remains unverified in this demo environment.

This release does not establish production cutover parity. The actual source export, totals, private activity policy, owner-only webhook destinations/conditions, customer-status Gmail rule, graduation destination, billing semantics and contract use still need reconciliation. The dependency register records evidence and an owner; saving a disposition does not validate an external system. Live Twilio/Postmark acceptance, inbound calling/voicemail, AI summaries, mailbox sync, identity recovery/SSO and record-level privacy remain separate work or configuration. Keep existing production workflows in place until their replacements have passed acceptance.
