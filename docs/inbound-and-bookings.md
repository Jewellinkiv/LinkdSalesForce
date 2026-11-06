# Website intake and call bookings

For production packaging, verified container checks, and current deployment
access requirements, see [Sales Force hosting](hosting.md).

Production address selected for this project: **https://sales.linkd.com**. The local app remains at `http://localhost:3000/?view=intake`. The implementation is usable locally; DNS, hosting, website secrets, and a Calendly webhook subscription must be configured before live traffic arrives.

## Team workflow

- **Intake & bookings** combines website inquiries, Calendly meetings, and manually recorded calls/demos. Filter by brand, type, review status, upcoming meetings, or missing account links. Counts cover all active records; lists paginate 50 at a time.
- Preserve submitted fields, page, campaign attribution, contact information, owner, review notes, and meeting outcomes. New inbound contact does not grant marketing permission or start a sales sequence.
- Exact email matches attach to a unique known account, retailer, prospect, or manually verified account relationship. Shared contacts and multiple store matches stay ambiguous. Phone-only inquiries remain unlinked for review.
- Team members can resolve the account/store, assign an owner, archive an inquiry, or send it into the existing Research → approval → lead qualification flow. Later prospect conversion makes the original forms and bookings visible on the new account.
- Account and retailer profiles include website/meeting history, including archived entries. Calendly reschedules retain both meeting records and their relationship; old deliveries cannot restore a canceled meeting.
- In-app notifications go to the owner plus selected teammates. No selected recipients means all active sales/admin users. Existing account ownership takes precedence over a brand's default owner. Postmark staff email uses the existing Settings → Configure automations → staff email setting and worker. Demo mode simulates email.
- Calendly manages availability, invitations, meeting links, and visitor rescheduling/cancellation. Sales Force shows the resulting schedule and history. Manual meeting entry records an arrangement already made; it sends no customer calendar invitation. Use Calendly for availability and automatic calendar invitations.

## Website inventory and prepared connectors

The server adapter is [website-intake.mjs](../integrations/website-intake.mjs). It wraps the website's existing validated marketing endpoint, preserving validation, spam checks, and existing Postmark alerts. Enable only after Sales Force is publicly reachable. When enabled, an unconfirmed CRM delivery returns a retryable error instead of claiming success. Up to three immediate attempts use the same submission ID. Browser keys survive a retry; legacy clients without a key get protection within that request only. Existing Postmark alerts can repeat if the visitor retries after a CRM outage; the CRM record and CRM notifications deduplicate by source and submission ID.

| Website         | Source repository                                                | Form endpoints prepared                                                                                                                                                     |
| --------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| jewellink.com   | Jewellinkiv/website                                              | `/api/demo` (demo and Linkd landing page), `/api/guided-demo-lead`, `/api/system-demo-access`, `/api/ring-builder-demo-lead`, `/api/3cx-provider`, trivia lead registration |
| linkd.com       | Jewellinkiv/Linkdwebsite                                         | `/api/inquiry`, `/api/demo-access`, `/api/suite-demo-access`                                                                                                                |
| countretail.com | Jewellinkiv/Countretailwebsite                                   | `/api/demo`, `/api/guided-demo-access`                                                                                                                                      |
| jewelhire.com   | Marketing site links to app.jewelhire.com; Jewellinkiv/Jewelhire | `/api/public/demo-access` in the actual app                                                                                                                                 |

JewelHire's marketing site has no current standalone sales form; its guided demo points to the application. Applicant/job applications, employment assessments, authentication, and operational customer forms are not sales leads and are not forwarded. Store account signup is also a separate account-provisioning flow, not included in this marketing connector. Existing email-only contact links are not form submissions.

Per website server, set:

```dotenv
SALES_FORCE_ENABLED=true
SALES_FORCE_SIGNING_KEY=<unique random secret for this brand, at least 24 characters>
```

On Sales Force, set matching `INBOUND_JEWELLINK_SECRET`, `INBOUND_LINKD_SECRET`, `INBOUND_JEWELHIRE_SECRET`, and `INBOUND_COUNTRETAIL_SECRET`. Keep them server-side. Default disabled connector behavior leaves the existing site flow intact. Credentials, sample customer data, and private lists must not enter this public repository.

Endpoints:

```text
https://sales.linkd.com/api/webhooks/websites/jewellink
https://sales.linkd.com/api/webhooks/websites/linkd
https://sales.linkd.com/api/webhooks/websites/jewelhire
https://sales.linkd.com/api/webhooks/websites/countretail
```

Send JSON with `submissionId`, `form`, `name`, `email` or `phone`, optional `company`, `message`, `pageUrl`, `fields`, and `tracking`. `pageUrl` must belong to the brand. The adapter omits credentials, anti-bot tokens, and arbitrary user-supplied fields.

Authenticate the exact raw request body with `X-Linkd-Signature: t=<unix seconds>,v1=<HMAC-SHA256 hex>`, signing `<timestamp>.<raw JSON>` with the brand key. Deliveries outside a three-minute window are rejected. Regenerate the signature, but reuse the submission ID on retries. The endpoint is for server-to-server delivery; do not put its key in browser code.

## Calendly connection

Set `APP_URL=https://sales.linkd.com`, `CALENDLY_ACCESS_TOKEN`, and a random `CALENDLY_SIGNING_KEY`. `CALENDLY_ORGANIZATION_URI` is optional; the setup script discovers the token owner's current organization.

```sh
npm run calendly:connect
# After inspecting the preview and deploying the public endpoint:
npm run calendly:connect -- --apply
```

The script discovers existing organization subscriptions and avoids creating a duplicate. It subscribes to `invitee.created` and `invitee.canceled` at `https://sales.linkd.com/api/webhooks/calendly`, with the configured signing key. Existing subscriptions are reported without modification; verify their events, active state, and signing key manually. Organization scope requires the appropriate Calendly privileges and a plan supporting webhooks. Keys and tokens are never printed.

In **Sources & booking links**, configure each brand's booking URL, default owner, notification recipients, and optional Calendly event type URIs. One shared event can serve multiple brands through `utm_source=jewellink|linkd|jewelhire|countretail`; an explicit event-type mapping takes precedence for new records. The existing shared JewelLink/CountRetail booking link is prefilled for both brands; prepared website changes add source tracking. Other booking URLs are left unconfigured until chosen.

The receiver verifies Calendly's raw-body signature and timestamp. It stores invitee URI, time, timezone, host, meeting location/link, questions, campaign fields, cancellation and reschedule links, and old/new invitee relationships. If an event does not include its scheduled-event details, the server retrieves them using the access token from the fixed Calendly API host. No outbound customer communication is triggered by ingesting a booking.

References: [Calendly webhook signatures](https://developer.calendly.com/api-docs/overview/webhooks/webhook-signatures), [sample payload](https://developer.calendly.com/api-docs/calendly-api/webhooks/get-sample-webhook-data), [subscription setup](https://developer.calendly.com/docs/api-guides/receive-data-from-scheduled-events-in-real-time-with-webhook-subscriptions), and [reschedule behavior](https://developer.calendly.com/docs/api-guides/see-how-webhook-payloads-change-when-invitees-reschedule-events).

## Cutover and verification

1. Deploy Sales Force web and worker processes with PostgreSQL, HTTPS, migrations through 010, real team accounts, `APP_MODE=live`, and demo login disabled. Point `sales.linkd.com` to that deployment. Keep customer communications in demo mode until provider acceptance testing.
2. Deploy the prepared website changes with forwarding disabled. Then configure a different matching key on each website/server pair and enable forwarding.
3. Configure booking links and team routing; register the Calendly subscription. Make a controlled test inquiry and booking, then reschedule/cancel it. Verify the account/store, times, history, and exactly one notification per teammate per event.
4. Enable Postmark staff email when ready and verify its worker delivery. Website legacy alerts remain in place during cutover.

No historical website inbox or Calendly event backfill is performed by this feature. No DNS change, production deployment, Calendly subscription, or live customer message was made during local implementation. Calendly calendar availability stays in Calendly; this app is the shared relationship record and meeting tracker.

## Prepared website pull requests

- [JewelLink website #15](https://github.com/Jewellinkiv/website/pull/15)
- [Linkd website #2](https://github.com/Jewellinkiv/Linkdwebsite/pull/2)
- [CountRetail website #1](https://github.com/Jewellinkiv/Countretailwebsite/pull/1)
- [JewelHire application #110](https://github.com/Jewellinkiv/Jewelhire/pull/110)

Website validation: signed-adapter tests for all four repositories; JewelLink's existing lead-routing audit and changed-script syntax checks; CountRetail's 13 existing tests; Linkd's production build and 27 rendered-HTML tests; JewelHire's TypeScript check. Linkd's standalone TypeScript command is blocked by its existing `drizzle.config.ts` import of an uninstalled `drizzle-kit` package; its production build passes. These branches are drafts and forwarding remains disabled pending deployment/configuration.
