# Linkd Sales Force

Linkd’s internal sales and onboarding workspace. Built around the team’s outreach, follow-up, deal handoff, and customer launch process, using Linkd’s logo and blue/navy palette.

This is a working first release with PostgreSQL persistence and a local demo. Twilio and Postmark adapters are implemented; live provider configuration and end-to-end delivery still need validation in your accounts. The repository contains fictional sample records only.

## Run locally

Requires Node.js 22+, npm, and Docker with Compose.

```sh
npm ci
cp .env.example .env
docker compose up -d --wait
npm run db:migrate
npm run db:seed
npm run dev
```

Open **http://localhost:3000** and choose **Open demo workspace**. Use `localhost`, matching `APP_URL`; requests from a different origin are rejected. In another terminal, start scheduled message processing:

```sh
npm run worker
```

The demo login is development-only. Demo messages are simulated locally, and demo calls only create activity records. Provider credentials are unnecessary for the demo. Stop each process with Ctrl+C; `docker compose stop` preserves the database. Do not use `docker compose down -v` unless you intend to erase local data.

## What works

The [workflow release guide](docs/workflow-release.md) describes the new editing, qualification, intake, readiness, automation, reporting, and team flows. [Migration tooling](docs/migration.md) supports reviewed dry runs and idempotent initial imports.

- Editable customer/contact/commercial records, ownership, separate lead qualification and deals, repeat opportunities, lifecycle filters, notes, and dated follow-ups.
- Won-deal and existing-customer onboarding, separate technical/CS/training owners, readiness evidence, phase gates, secure customer intake/files, and paginated account history.
- SMS/email composition, templates, scheduled delivery, cancellation, incoming replies, and provider status callbacks.
- Outbound browser calling through Twilio, optional recording, post-call transcripts, transcript search, and manual call outcomes/notes.
- Reporting with owner/month filters, matching details and exports, verified current account MRR, active customers/locations, pipeline/booked MRR, monthly closes, and onboarding MRR.
- In-app staff notifications, optional automatic welcome/intake reminders, team invitations/access controls, and operator delivery reconciliation.
- Password sessions, sales/onboarding/admin action roles, authenticated webhooks, durable jobs, duplicate-request protection, and suppression checks.

## Configuration and operations

See [provider setup](docs/integrations.md), [architecture and workflow behavior](docs/architecture.md), and the [next milestones](docs/roadmap.md).

For an initial hosted environment, use a **fresh database**, private secrets, an HTTPS domain, and separate web and worker processes. Set `APP_MODE=live`, `ENABLE_DEMO_LOGIN=false`, and keep `COMMUNICATIONS_MODE=demo` until controlled provider testing. Set `ADMIN_EMAIL`, `ADMIN_NAME`, and `ADMIN_PASSWORD` (at least 14 characters), then run migrations and `npm run db:seed` to bootstrap the administrator. Remove the bootstrap password from the runtime environment afterward. The seed will not change existing passwords.

```sh
npm run build
npm start
# Separate process, with the same database and configuration:
npm run worker
```

Production login requires HTTPS and a matching `APP_URL`. The application serves one internal organization; all authenticated team members can read the shared workspace. SSO/MFA, password recovery, broader customizable sequences, inbound call routing, and full historical Monday migration remain future work. Initial invitations, secure intake, bounded automation rules, and normalized import tooling are implemented. Do not treat this first release as the completed production rollout.

## Checks

```sh
npm run typecheck
npm test
npm run build
npm run format:check
```

Tests create a temporary PostgreSQL schema and remove it afterward; the configured database user needs schema privileges. They cover session/origin protection, atomic lead creation, concurrent handoffs, onboarding gates, duplicate messages, demo/live separation, suppression/reply handling, and interrupted workers. They do not contact live providers. GitHub Actions runs these checks against a disposable database.

## Brand

Logo: `public/brand/linkd-logo-main.webp`, sourced from [Linkd’s public website](https://linkd.com). Palette: navy `#17213a`, blue `#2f7ed8`, deep blue `#215fa8`, and teal `#16827a`. The name and brand assets remain Linkd’s property; their inclusion does not grant rights to reuse the brand.
