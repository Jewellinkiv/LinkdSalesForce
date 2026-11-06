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
read only during the transfer. The original 74 tests passed; launch QA added regressions for blank booking URLs,
Twilio readiness independent of Calendly, and Cloudflare redirect handling.

## Production rollout on November 6, 2026

The web app and private worker are deployed in Google Cloud project
`linkd-v2-500003`, region `us-central1`, as `sales-force` and
`sales-force-worker`. Both run application image `3595c19` at immutable digest
`sha256:40bdd132b3a6da5a2df9902125ac6abee44658f69c349a69277da2aee077c2a9`.
The temporary service URL is https://sales-force-en5ridjafa-uc.a.run.app.

Dedicated Cloud SQL instance `linkd-sales-force-db` has private networking,
encrypted connections, deletion protection, daily backups, and point-in-time
recovery. The runtime database role has ordinary data access without database
creation, role management, replication, or superuser privileges. A successful
post-import backup is available. The bootstrap job and temporary transfer
bucket were removed; bootstrap-only secret versions were disabled.

Production checks verified secure administrator login, disabled demo login,
unauthenticated access rejected for team records, and all 2,271 retailers under
CBG, Centurion, IJO, and RJO. All remain unverified as current clients until an
authoritative client list is reconciled. No demo customers or users were copied.
Worker startup and liveness checks passed.

GoDaddy now has `sales CNAME ghs.googlehosted.com` and
`inbound.sales MX 10 inbound.postmarkapp.com`. The custom domain passes HTTPS health, administrator login, and protected-record
checks. JewelLink and CountRetail forwarding is enabled following that verification.

A dedicated live Postmark server is configured with verified `linkd.com` sending
and inbound-domain routing. Delivery, bounce, spam, and suppression hooks passed Postmark verification.
Two controlled website submissions created one CRM record each, duplicate replays
created no extra records, and Postmark confirmed both staff alerts delivered to
the administrator mailbox. The QA records are archived. Staff email is enabled;
customer welcome, phase email, and intake nudges remain disabled. Live inbound
email replies still require an acceptance test. A dedicated
Twilio subaccount has sales number `(501) 474-7718`, a voice application, and an
Intelligence service with account-wide auto-transcription and data logging disabled.
Outbound SMS remains disabled pending carrier registration. The production calling-token endpoint passed; a controlled voice call and
transcript acceptance test and the Calendly subscription remain pending.

JewelLink and CountRetail adapters are published with matching private keys and
forwarding enabled. JewelLink's deployment preserves the currently published
legal directory from commit `5f19981`; unrelated unpublished legal changes were
excluded. JewelHire's connector passed full CI, merged as `416592eb`, and entered its guarded
release (GitHub Actions run `42289962249`).
Linkd marketing still requires access to its owning Sites account.

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

## Launch fixes and evidence

Live QA found and corrected two server bugs: an empty optional scheduling URL
caused an exception while saving staff notifications, and calling checked the
Calendly configuration by array position instead of the Twilio Voice integration.
The production image includes both fixes, with 76 passing tests and type checks.

Cloudflare rejects Fetch's `redirect: "error"` mode. Website adapters now use
`manual`, reject redirect responses, and never forward signed data to the
redirect target. A deployed diagnostic reproduced the runtime failure and was
removed after the fix. The extra adapter regression passes. Follow-up website
fixes are merged in JewelLink #16 (`2004665`) and CountRetail #2 (`d28e909`).
Current verified Pages deployments are `1d7669ee` and `3f148466`, respectively.
Previous disabled releases remain available for rollback.

Unsigned Postmark, Twilio, Calendly, and website callbacks were rejected in
production. Twilio recording is enabled only behind the per-call consent check
and spoken notice. No live sales call, customer SMS, or campaign was sent during
launch verification. API tokens, credentials, transfer snapshots, and detailed
QA logs remain outside the public repository.
