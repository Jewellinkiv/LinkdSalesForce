# Sales Force hosting

Target origin: **https://sales.linkd.com**.

## Verified locally on November 6, 2026

The production Docker image runs as a non-root user with runtime-injected
configuration. Its build context and Cloud Build upload use allowlists that
exclude `.env`, `.local`, Git metadata, retailer spreadsheets, and local database
files. The image contains both the web app and the migration/worker commands.

An isolated, disposable database passed all 10 migrations, real administrator
bootstrap, a rollback preview and committed retailer transfer, secure-cookie
login, disabled demo login, signed submissions from all four website brands,
duplicate rejection, four team notifications, and worker health. The temporary
database and containers were removed afterward. The original local database was
read only during the transfer. The existing 74 tests also passed.

**This is deployment preparation, not a live deployment.** Google Cloud access
currently requires account reauthentication. No production database, service,
DNS record, website forwarding configuration, or Calendly subscription has been
created by this deployment attempt.

## Runtime layout

- Web: Cloud Run service, port 8080, default image command. Public ingress is
  needed for signed webhooks and customer intake; team data remains behind the
  application's session authentication. `/api/health` checks database access.
- Worker: separate private Cloud Run service using the same image, command
  `node --import tsx scripts/worker.ts`, `WORKER_HEALTH_PORT=8080`, minimum one
  instance, maximum one instance, and CPU throttling disabled. `/health` reports
  whether the worker is making progress; it returns 503 while stopping or after
  two minutes without a healthy pass. Use service minimum capacity, not a
  revision minimum. No public invoker is needed.
- PostgreSQL: dedicated Sales Force database and database user, managed backups
  and point-in-time recovery, encryption in transit. Do not reuse another app's
  database credentials. Cloud SQL socket URLs or a managed TLS connection work
  with the existing `DATABASE_URL` connection.
- Secrets: runtime Secret Manager references for the database and provider
  credentials. Restrict the runtime service account to the specific secrets and
  database connection it needs. No provider credentials are required at build
  time.

Cloud Run's background-worker CPU and probe configuration follow the official
[billing settings](https://docs.cloud.google.com/run/docs/configuring/billing-settings)
and [health checks](https://docs.cloud.google.com/run/docs/configuring/healthchecks).

## Build and initialization

Build locally with `docker build -t linkd-sales-force:release .`. Cloud Build uses
`cloudbuild.yaml` with `_IMAGE` set to the selected Artifact Registry image name.
Deploy web and worker from the same immutable image digest.

Run these as separate one-time jobs against the dedicated destination database:

```sh
node --import tsx scripts/migrate.ts
node --import tsx scripts/seed.ts
```

Set `APP_MODE=live`, `ENABLE_DEMO_LOGIN=false`,
`APP_URL=https://sales.linkd.com`, and initially `COMMUNICATIONS_MODE=demo`.
The seed job requires `ADMIN_EMAIL`, `ADMIN_NAME`, and a strong
`ADMIN_PASSWORD`; remove the bootstrap password from the job after creation.
Do not attach it to the long-lived web or worker services. Existing passwords
are never overwritten by the seed job.

Production jobs invoke Node directly because the convenience npm migration and
worker commands load a local `.env` file, which is deliberately absent from the
container. `tsx` is a production dependency for these commands. The Next config
uses `.mjs` so production startup does not install a TypeScript compiler.

## Transfer the retailer directory

`scripts/promote-retailers.ts` is a one-time launch transfer for the current
unlinked retailer directory. Set `SOURCE_DATABASE_URL`, `TARGET_DATABASE_URL`,
and `TARGET_OWNER_EMAIL` through private environment configuration. The target
owner must be an active administrator. Run without flags first for a complete
transactional preview that rolls back; use `--apply` to commit the same transfer.

The transfer includes applied source imports, retailers, people, and source
membership. It reassigns ownership to the real destination administrator and
excludes demo accounts, users, sessions, jobs, and unused import drafts. It
refuses nonempty destination retailer tables and refuses source account links,
photos, or history requiring a broader relationship-preserving migration.
Current-client classifications remain unverified until reconciled with an
authoritative customer list.

## Domain and integrations

`linkd.com` uses GoDaddy nameservers (`ns43.domaincontrol.com` and
`ns44.domaincontrol.com`), not the connected Cloudflare zone. Configure the
`sales` record from the actual hosting provider's issued domain mapping, verify
HTTPS, then verify `/api/auth/info` reports `demoLogin: false` before connecting
external senders.

The connected Cloudflare account contains `jewellink-website` and
`countretail-website` Pages projects. JewelHire demo access runs in the separate
JewelHire Cloud Run app. Linkd marketing source declares Sites project
`appgprj_6a6375b822b481919aa4051b7b016da8`; the currently connected Sites account
returns project-not-found for that ID, so its owning account/workspace must be
connected before publishing its changes. Preserve the existing website audience
and notifications.

Follow [Inbound and bookings](inbound-and-bookings.md) for per-site signing keys,
website PRs, routing, and Calendly subscription setup. Enable each site's
`SALES_FORCE_ENABLED` only after the receiver is reachable and its matching
secret has been verified. Test a controlled submission through the actual
website, then a Calendly booking, reschedule, and cancellation against the same
account. Configure real team recipients before enabling staff email.

Twilio calling/SMS/transcripts and Postmark remain subject to their live
credentials, sender configuration, consent rules, and controlled delivery
verification. Demo communications are not evidence of live provider delivery.

## Promotion and rollback

Retain the previous web/worker image digest and traffic mapping on later
releases. Apply additive migrations before promoting web traffic. Verify health,
login, protected endpoints, inbound deduplication, account history, and worker
progress after promotion. Pause website forwarding if its receiver is unhealthy;
the existing website email notification path remains available. Roll back web
traffic and the worker image together when needed, without reverting durable
customer records or blindly reversing database migrations.
