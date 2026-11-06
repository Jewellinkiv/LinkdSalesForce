import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import twilio from "twilio";
import type { User } from "../src/lib/types";

const schema = `test_${randomUUID().replaceAll("-", "")}`;
process.env.DATABASE_SCHEMA = schema;
process.env.COMMUNICATIONS_MODE = "demo";
process.env.APP_MODE = "demo";
process.env.ENABLE_DEMO_LOGIN = "true";
process.env.APP_URL = "http://localhost:3000";
let db: (typeof import("../src/server/db"))["db"];
let domain: typeof import("../src/server/domain");
let worker: typeof import("../src/server/worker");
let hooks: typeof import("../src/server/webhooks");
let routes: typeof import("../src/app/api/[...path]/route");
let auth: typeof import("../src/server/auth");
const admin: User = {
  id: randomUUID(),
  name: "Test Admin",
  email: "alex@example.test",
  role: "admin",
};
let counter = 0;
async function customer(options: Record<string, unknown> = {}) {
  const n = ++counter;
  const id = await domain.createCustomer(
    domain.customerInput.parse({
      name: `Test Company ${n}`,
      contactName: "Test Person",
      email: `test${n}@example.test`,
      phone: `+12025550${String(n).padStart(3, "0")}`,
      city: "Test City",
      pos: "Test POS",
      locations: 1,
      package: "Full suite",
      mrr: 500,
      source: "Test",
      nextAction: "Follow up",
      nextActionAt: new Date().toISOString(),
      smsConsent: true,
      emailConsent: true,
      consentSource: "Test fixture",
      ...options,
    }),
    admin,
  );
  const ct = (
    await db.query("SELECT * FROM contacts WHERE company_id=$1", [id])
  ).rows[0];
  const deal = (
    await db.query("SELECT * FROM opportunities WHERE company_id=$1", [id])
  ).rows[0];
  return { id, ct, deal };
}
const request = (
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new Request(`http://localhost:3000/api/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
      ...headers,
    },
    body: JSON.stringify(body),
  });
before(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(`CREATE SCHEMA ${schema}`);
  await pool.end();
  ({ db } = await import("../src/server/db"));
  domain = await import("../src/server/domain");
  worker = await import("../src/server/worker");
  hooks = await import("../src/server/webhooks");
  auth = await import("../src/server/auth");
  routes = await import("../src/app/api/[...path]/route");
  await (await import("../scripts/migrate")).migrate();
  await db.query(
    "INSERT INTO users(id,name,email,role,password_hash) VALUES ($1,$2,$3,$4,$5)",
    [
      admin.id,
      admin.name,
      admin.email,
      admin.role,
      auth.passwordHash("a-long-test-password"),
    ],
  );
});
after(async () => {
  await db.query(`DROP SCHEMA ${schema} CASCADE`);
  await db.end();
});

// PostgreSQL runs in Docker; wait for its clock to reach the host's enqueue
// instant before draining. Future-scheduled messages remain future-scheduled.
async function drainDueJobs() {
  for (let processed = 0; processed < 1000; processed++) {
    await db.query(
      "SELECT pg_sleep(LEAST(1,GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))))",
      [new Date().toISOString()],
    );
    if (!(await worker.runOneJob())) return;
  }
  throw new Error("Test job queue did not drain.");
}

const retailerCsv = (name = "Fictional Gem Store") => ({
  name: "test-retailers.csv",
  data: Buffer.from(
    `Store,Full Name,Email,Phone,City,State,Address\n${name},Alice Owner,alice@example.test,(202) 555-0100,Austin,TX,1 Main St\n${name},Bob Manager,bob@example.test,(202) 555-0100,Austin,TX,1 Main St\n`,
  ).toString("base64"),
});
const retailerPreviewInput = (
  file = retailerCsv(),
  group = "Test Guild",
  list = "Test event",
) => ({
  file,
  sheet: "CSV",
  headerRow: 0,
  mapping: {
    name: 0,
    contactName: 1,
    email: 2,
    phone: 3,
    city: 4,
    state: 5,
    address: 6,
  },
  group,
  list,
});
test("retailer imports preserve shared phone contacts and memberships without granting consent or creating jobs", async () => {
  const service = await import("../src/server/retailers");
  const jobs = Number(
    (await db.query("SELECT count(*) FROM jobs")).rows[0].count,
  );
  const p = await service.previewRetailers(retailerPreviewInput(), admin);
  assert.equal(p.created, 1);
  assert.equal(p.matched, 1);
  const applied = await service.applyRetailers(p.id, admin);
  assert.equal(applied.created, 1);
  assert.equal((await service.applyRetailers(p.id, admin)).already, true);
  const r = (
    await db.query("SELECT * FROM retailers WHERE name='Fictional Gem Store'")
  ).rows[0];
  assert.equal(r.client_status, "unverified");
  assert.equal(r.company_id, null);
  assert.equal(
    (
      await db.query("SELECT * FROM retailer_people WHERE retailer_id=$1", [
        r.id,
      ])
    ).rowCount,
    2,
  );
  assert.equal(
    (
      await db.query("SELECT * FROM retailer_sources WHERE retailer_id=$1", [
        r.id,
      ])
    ).rowCount,
    2,
  );
  assert.equal(
    Number((await db.query("SELECT count(*) FROM jobs")).rows[0].count),
    jobs,
  );
  const renamed = { ...retailerCsv(), name: "renamed-copy.csv" };
  assert.equal(
    (await service.previewRetailers(retailerPreviewInput(renamed), admin))
      .already,
    true,
  );
  const another = await service.previewRetailers(
    retailerPreviewInput(retailerCsv(), "Second Guild", "Another event"),
    admin,
  );
  await service.applyRetailers(another.id, admin);
  const detail = await service.retailerDetail(r.id);
  assert.deepEqual(detail.retailer.groups, ["Second Guild", "Test Guild"]);
  assert.equal(detail.people.length, 2);
});
test("retailer imports keep different locations and conflicting addresses separate", async () => {
  const service = await import("../src/server/retailers");
  const rows =
    "Store,City,State,Address\nLocation Test,Austin,TX,1 Main\nLocation Test,Austin,TX,2 Main\nLocation Test,Dallas,TX,1 Main\nLocation Test,,,\n";
  const p = await service.previewRetailers(
    {
      file: {
        name: "locations.csv",
        data: Buffer.from(rows).toString("base64"),
      },
      sheet: "CSV",
      headerRow: 0,
      mapping: { name: 0, city: 1, state: 2, address: 3 },
      group: "Location Guild",
      list: "Locations",
    },
    admin,
  );
  assert.equal(p.created, 4);
  assert.equal(p.warnings.length, 2);
  await service.applyRetailers(p.id, admin);
  assert.equal(
    (await db.query("SELECT * FROM retailers WHERE name='Location Test'"))
      .rowCount,
    4,
  );
});
test("retailer Excel parsing maps offset CBG headers, retains provenance, and excludes footers", async () => {
  const ExcelJS = await import("exceljs");
  const w = new ExcelJS.default.Workbook(),
    s = w.addWorksheet("Retailer List");
  s.addRow(["Report title"]);
  s.addRow(["Instructions"]);
  s.addRow(["Locations", "Retailer Company Name (DBA)", "Active Dates"]);
  s.addRow([1, "Fictional Gems\nAustin, TX (JBT 123)", "2024"]);
  s.addRow(["Total"]);
  s.mergeCells("A5:B5");
  const files = await import("../src/server/retailer-files");
  const parsed = await files.readRetailerFile({
    name: "retailers.XLSX",
    data: Buffer.from(await w.xlsx.writeBuffer()).toString("base64"),
  });
  const sheet = parsed.sheets[0];
  assert.equal(sheet.headerRow, 2);
  assert.equal(sheet.mapping.name, 1);
  const mapped = files.mapRetailerRows(sheet, sheet.mapping, sheet.headerRow);
  assert.equal(mapped.rows.length, 1);
  assert.equal(mapped.rows[0].city, "Austin");
  assert.equal(mapped.rows[0].state, "TX");
  assert.equal(mapped.skipped.length, 1);
  assert.match(mapped.rows[0].raw["2: Retailer Company Name (DBA)"], /JBT 123/);
});
test("retailer client status derives from a linked account and rejects stale updates and unsupported verification", async () => {
  const service = await import("../src/server/retailers"),
    c = await customer();
  await db.query("UPDATE companies SET lifecycle='active' WHERE id=$1", [c.id]);
  const p = await service.previewRetailers(
    retailerPreviewInput(retailerCsv("Verified Retail Test")),
    admin,
  );
  await service.applyRetailers(p.id, admin);
  const r = (
    await db.query("SELECT * FROM retailers WHERE name='Verified Retail Test'")
  ).rows[0];
  const body = {
    id: r.id,
    version: r.version,
    ownerId: admin.id,
    companyId: "",
    clientStatus: "current",
    clientEvidence: "",
    outreachStatus: "not_started",
    nextAction: "",
    nextAt: "",
    tags: ["VIP"],
  };
  await assert.rejects(
    () =>
      service.retailerRoute(
        "retailers/save",
        request("retailers/save", body),
        body,
        admin,
      ),
    /verified/,
  );
  body.companyId = c.id;
  await service.retailerRoute(
    "retailers/save",
    request("retailers/save", body),
    body,
    admin,
  );
  assert.equal(
    (await service.retailerDetail(r.id)).retailer.effective_client_status,
    "current",
  );
  await assert.rejects(
    () =>
      service.retailerRoute(
        "retailers/save",
        request("retailers/save", body),
        body,
        admin,
      ),
    /changed/,
  );
  await db.query("UPDATE companies SET lifecycle='churned' WHERE id=$1", [
    c.id,
  ]);
  assert.equal(
    (await service.retailerDetail(r.id)).retailer.effective_client_status,
    "not_current",
  );
});
test("retailer photos require authentication, validate image type, and remain private", async () => {
  const service = await import("../src/server/retailers");
  const r = (await db.query("SELECT id FROM retailers LIMIT 1")).rows[0];
  const bad = {
    id: r.id,
    personId: "",
    requestKey: randomUUID(),
    caption: "Test team",
    mime: "image/png",
    data: Buffer.from('<svg onload="alert(1)"/>').toString("base64"),
  };
  await assert.rejects(
    () =>
      service.retailerRoute(
        "retailers/photo",
        request("retailers/photo", bad),
        bad,
        admin,
      ),
    /valid JPEG/,
  );
  const b = {
    ...bad,
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF2sAAAAASUVORK5CYII=",
  };
  await service.retailerRoute(
    "retailers/photo",
    request("retailers/photo", b),
    b,
    admin,
  );
  const photo = (
    await db.query("SELECT id FROM retailer_photos WHERE request_key=$1", [
      b.requestKey,
    ])
  ).rows[0];
  const url = `http://localhost:3000/api/retailers/photo?id=${photo.id}`;
  const unauth = await routes.GET(new Request(url), {
    params: Promise.resolve({ path: ["retailers", "photo"] }),
  });
  assert.equal(unauth.status, 401);
  const response = await service.retailerRoute(
    "retailers/photo",
    new Request(url),
    {},
    admin,
  );
  assert.equal(response?.headers.get("Cache-Control"), "private,no-store");
  assert.equal(response?.headers.get("Content-Type"), "image/png");
  await assert.rejects(
    () =>
      service.retailerRoute(
        "retailers/photo",
        request("retailers/photo", b),
        b,
        { ...admin, role: "onboarding" },
      ),
    /role/,
  );
});
test("retailer outreach logs are idempotent and do not send communications", async () => {
  const service = await import("../src/server/retailers"),
    r = (await db.query("SELECT id FROM retailers LIMIT 1")).rows[0];
  const before = Number(
      (await db.query("SELECT count(*) FROM messages")).rows[0].count,
    ),
    b = {
      id: r.id,
      requestKey: randomUUID(),
      kind: "call",
      body: "Fictional completed call",
      occurredAt: new Date().toISOString(),
    };
  await service.retailerRoute(
    "retailers/event",
    request("retailers/event", b),
    b,
    admin,
  );
  await service.retailerRoute(
    "retailers/event",
    request("retailers/event", b),
    b,
    admin,
  );
  assert.equal(
    (
      await db.query("SELECT * FROM retailer_events WHERE request_key=$1", [
        b.requestKey,
      ])
    ).rowCount,
    1,
  );
  assert.equal(
    Number((await db.query("SELECT count(*) FROM messages")).rows[0].count),
    before,
  );
  const details = await service.retailerDetail(r.id);
  assert.equal(details.retailer.outreach_status, "contacted");
  assert.ok(details.retailer.last_touch);
});

test("retailer review preserves account identity and do-not-contact stops conversion and queued outreach", async () => {
  const service = await import("../src/server/retailers"),
    ops = await import("../src/server/operations"),
    c = await customer();
  const p = await service.previewRetailers(
    retailerPreviewInput(retailerCsv("Restricted Retail Test")),
    admin,
  );
  await service.applyRetailers(p.id, admin);
  let r = (
    await db.query(
      "SELECT * FROM retailers WHERE name='Restricted Retail Test'",
    )
  ).rows[0];
  const person = (
    await db.query(
      "SELECT id FROM retailer_people WHERE retailer_id=$1 LIMIT 1",
      [r.id],
    )
  ).rows[0];
  const body = {
    id: r.id,
    version: r.version,
    ownerId: admin.id,
    companyId: c.id,
    clientStatus: "unverified",
    clientEvidence: "Test match",
    outreachStatus: "not_started",
    nextAction: "",
    nextAt: "",
    tags: [],
  };
  await service.retailerRoute(
    "retailers/save",
    request("retailers/save", body),
    body,
    admin,
  );
  const research = { id: r.id, personId: person.id };
  await service.retailerRoute(
    "retailers/research",
    request("retailers/research", research),
    research,
    admin,
  );
  r = (await db.query("SELECT * FROM retailers WHERE id=$1", [r.id])).rows[0];
  await db.query("UPDATE prospects SET status='approved' WHERE id=$1", [
    r.prospect_id,
  ]);
  await assert.rejects(
    () => ops.convertProspect(r.prospect_id, null, admin),
    /verified linked account/,
  );
  const message = await domain.queueMessage(
    domain.messageInput.parse({
      contactId: c.ct.id,
      companyId: c.id,
      channel: "email",
      subject: "test",
      body: "test",
      idempotencyKey: randomUUID(),
    }),
    admin,
  );
  const restrict = {
    ...body,
    version: r.version,
    outreachStatus: "do_not_contact",
  };
  await service.retailerRoute(
    "retailers/save",
    request("retailers/save", restrict),
    restrict,
    admin,
  );
  assert.equal(
    (await db.query("SELECT status FROM messages WHERE id=$1", [message]))
      .rows[0].status,
    "cancelled",
  );
  assert.equal(
    (await db.query("SELECT do_not_contact FROM companies WHERE id=$1", [c.id]))
      .rows[0].do_not_contact,
    true,
  );
  await assert.rejects(
    () => ops.convertProspect(r.prospect_id, c.id, admin),
    /do not contact/,
  );
});

test("retailer group and client-status filtering reconciles counts", async () => {
  const service = await import("../src/server/retailers");
  const response = await service.retailerRoute(
    "retailers",
    new Request(
      "http://localhost:3000/api/retailers?group=Second%20Guild&status=unverified",
    ),
    {},
    admin,
  );
  const data = await response!.json();
  assert.equal(data.total, 1);
  assert.equal(data.stats.total, 1);
  assert.equal(data.stats.unverified, 1);
  assert.equal(data.retailers.length, 1);
  assert.equal(data.retailers[0].name, "Fictional Gem Store");
});

test("workspace requires a session and writes reject foreign origins", async () => {
  const r = await routes.GET(
    new Request("http://localhost:3000/api/workspace"),
    { params: Promise.resolve({ path: ["workspace"] }) },
  );
  assert.equal(r.status, 401);
  const bad = await routes.POST(
    request("auth/demo", {}, { origin: "https://evil.example" }),
    { params: Promise.resolve({ path: ["auth", "demo"] }) },
  );
  assert.equal(bad.status, 403);
});
test("login creates a hashed session and an HttpOnly cookie", async () => {
  const r = await routes.POST(
    request("auth/login", {
      email: admin.email,
      password: "a-long-test-password",
    }),
    { params: Promise.resolve({ path: ["auth", "login"] }) },
  );
  assert.equal(r.status, 200);
  const cookie = r.headers.get("set-cookie")!;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  const user = await auth.userForRequest(
    new Request("http://localhost:3000", { headers: { cookie } }),
  );
  assert.equal(user?.id, admin.id);
  const raw = cookie.split(";")[0].slice(14);
  assert.equal(
    (
      await db.query("SELECT token_hash FROM sessions WHERE token_hash=$1", [
        raw,
      ])
    ).rowCount,
    0,
  );
});
test("failed customer creation rolls back the company and follow-up", async () => {
  const first = await customer();
  const before = (await db.query("SELECT count(*) FROM companies")).rows[0]
    .count;
  await assert.rejects(() => customer({ email: first.ct.email }));
  assert.equal(
    (await db.query("SELECT count(*) FROM companies")).rows[0].count,
    before,
  );
});
test("concurrent won transitions create exactly one onboarding and one checklist", async () => {
  const c = await customer();
  await Promise.all([
    domain.changeStage(c.deal.id, "Won", admin),
    domain.changeStage(c.deal.id, "Won", admin),
  ]);
  const p = (
    await db.query("SELECT * FROM onboarding WHERE opportunity_id=$1", [
      c.deal.id,
    ])
  ).rows;
  assert.equal(p.length, 1);
  const tasks = (
    await db.query("SELECT * FROM tasks WHERE onboarding_id=$1", [p[0].id])
  ).rows;
  assert.equal(tasks.length, domain.checklistFor("Full suite").length);
  assert.equal(new Set(tasks.map((t) => t.title)).size, tasks.length);
});
test("handoff refuses missing POS and leaves the original stage unchanged", async () => {
  const c = await customer({ pos: "" });
  await assert.rejects(
    () => domain.changeStage(c.deal.id, "Won", admin),
    /Complete the package/,
  );
  assert.equal(
    (await db.query("SELECT stage FROM opportunities WHERE id=$1", [c.deal.id]))
      .rows[0].stage,
    "New lead",
  );
});
test("onboarding advancement respects incomplete tasks and blockers", async () => {
  const c = await customer();
  await domain.changeStage(c.deal.id, "Won", admin);
  const p = (
    await db.query("SELECT * FROM onboarding WHERE company_id=$1", [c.id])
  ).rows[0];
  await assert.rejects(
    () => domain.advancePhase(p.id, admin),
    /remaining handoff/,
  );
  await db.query(
    "UPDATE tasks SET completed_at=now(),resolution='completed',resolved_at=now() WHERE onboarding_id=$1 AND phase='Handoff'",
    [p.id],
  );
  await db.query(
    "UPDATE onboarding SET blocker='Waiting for customer' WHERE id=$1",
    [p.id],
  );
  await assert.rejects(
    () => domain.advancePhase(p.id, admin),
    /Resolve the blocker/,
  );
  await db.query("UPDATE onboarding SET blocker='' WHERE id=$1", [p.id]);
  await domain.advancePhase(p.id, admin);
  assert.equal(
    (await db.query("SELECT phase FROM onboarding WHERE id=$1", [p.id])).rows[0]
      .phase,
    "Intake & pre-build",
  );
});
test("package-specific checklists omit texting for training-only customers", () => {
  assert.ok(
    !domain
      .checklistFor("Training only")
      .some((t) => /texting|POS data/i.test(t[1])),
  );
  assert.ok(
    domain
      .checklistFor("Full suite")
      .some((t) => /texting registration/i.test(t[1])),
  );
});
test("concurrent duplicate message requests return one message and one job", async () => {
  const c = await customer();
  const input = {
    contactId: c.ct.id,
    channel: "email" as const,
    subject: "Test",
    body: "Test message",
    idempotencyKey: randomUUID(),
  };
  const [a, b] = await Promise.all([
    domain.queueMessage(input, admin),
    domain.queueMessage(input, admin),
  ]);
  assert.equal(a, b);
  assert.equal(
    (
      await db.query("SELECT count(*) FROM jobs WHERE dedupe_key=$1", [
        `message:${a}`,
      ])
    ).rows[0].count,
    "1",
  );
  await assert.rejects(
    () => domain.queueMessage({ ...input, body: "Different" }, admin),
    /another message/,
  );
  await drainDueJobs();
  assert.equal(
    (await db.query("SELECT status FROM messages WHERE id=$1", [a])).rows[0]
      .status,
    "simulated",
  );
});
test("send-time permission check cancels an already queued message after opt-out", async () => {
  const c = await customer();
  const id = await domain.queueMessage(
    {
      contactId: c.ct.id,
      channel: "sms",
      subject: "",
      body: "Test",
      idempotencyKey: randomUUID(),
    },
    admin,
  );
  await db.query("UPDATE contacts SET sms_opted_out=true WHERE id=$1", [
    c.ct.id,
  ]);
  await drainDueJobs();
  assert.equal(
    (await db.query("SELECT status FROM messages WHERE id=$1", [id])).rows[0]
      .status,
    "cancelled",
  );
});
test("unsigned Twilio and unauthenticated Postmark callbacks cannot mutate data", async () => {
  process.env.COMMUNICATIONS_MODE = "live";
  process.env.TWILIO_AUTH_TOKEN = "test-token";
  process.env.POSTMARK_WEBHOOK_USER = "test";
  process.env.POSTMARK_WEBHOOK_PASSWORD = "test-password";
  try {
    const tw = await routes.POST(
      new Request("http://localhost:3000/api/webhooks/twilio/sms-inbound", {
        method: "POST",
        body: "MessageSid=bad",
      }),
      {
        params: Promise.resolve({
          path: ["webhooks", "twilio", "sms-inbound"],
        }),
      },
    );
    assert.ok([403, 503].includes(tw.status));
    const pm = await routes.POST(
      new Request("http://localhost:3000/api/webhooks/postmark", {
        method: "POST",
        body: "{}",
      }),
      { params: Promise.resolve({ path: ["webhooks", "postmark"] }) },
    );
    assert.equal(pm.status, 401);
  } finally {
    process.env.COMMUNICATIONS_MODE = "demo";
  }
});
test("signed STOP events suppress sending, cancel queued follow-ups, and deduplicate", async () => {
  const c = await customer();
  const id = await domain.queueMessage(
    {
      contactId: c.ct.id,
      channel: "sms",
      subject: "",
      body: "Later",
      scheduledAt: new Date(Date.now() + 86400000).toISOString(),
      idempotencyKey: randomUUID(),
    },
    admin,
  );
  process.env.COMMUNICATIONS_MODE = "live";
  process.env.APP_URL = "https://sales.example.test";
  process.env.TWILIO_AUTH_TOKEN = "test-token";
  try {
    const url = "https://sales.example.test/api/webhooks/twilio/sms-inbound";
    const params = {
      MessageSid: "SM" + "a".repeat(32),
      From: c.ct.phone,
      Body: "STOP",
      OptOutType: "STOP",
    };
    const send = () =>
      hooks.twilioWebhook(
        new Request(url, {
          method: "POST",
          headers: {
            "x-twilio-signature": twilio.getExpectedTwilioSignature(
              "test-token",
              url,
              params,
            ),
          },
          body: new URLSearchParams(params),
        }),
        "sms-inbound",
      );
    await send();
    await send();
    assert.equal(
      (
        await db.query("SELECT sms_opted_out FROM contacts WHERE id=$1", [
          c.ct.id,
        ])
      ).rows[0].sms_opted_out,
      true,
    );
    assert.equal(
      (await db.query("SELECT status FROM messages WHERE id=$1", [id])).rows[0]
        .status,
      "cancelled",
    );
    assert.equal(
      (
        await db.query("SELECT count(*) FROM messages WHERE provider_id=$1", [
          params.MessageSid,
        ])
      ).rows[0].count,
      "1",
    );
  } finally {
    process.env.COMMUNICATIONS_MODE = "demo";
    process.env.APP_URL = "http://localhost:3000";
  }
});
test("Postmark incoming replies pause queued follow-ups and duplicate callbacks are harmless", async () => {
  const c = await customer();
  const id = await domain.queueMessage(
    {
      contactId: c.ct.id,
      channel: "email",
      subject: "Follow up",
      body: "Later",
      scheduledAt: new Date(Date.now() + 86400000).toISOString(),
      idempotencyKey: randomUUID(),
    },
    admin,
  );
  process.env.COMMUNICATIONS_MODE = "live";
  process.env.POSTMARK_WEBHOOK_USER = "test";
  process.env.POSTMARK_WEBHOOK_PASSWORD = "test-password";
  try {
    const make = () =>
      new Request("http://localhost:3000/api/webhooks/postmark", {
        method: "POST",
        headers: {
          authorization:
            "Basic " + Buffer.from("test:test-password").toString("base64"),
        },
        body: JSON.stringify({
          RecordType: "Inbound",
          MessageID: "reply-test",
          From: c.ct.email,
          TextBody: "Let’s talk next week.",
          Subject: "Re: follow-up",
        }),
      });
    await hooks.postmarkWebhook(make());
    await hooks.postmarkWebhook(make());
    assert.equal(
      (await db.query("SELECT status FROM messages WHERE id=$1", [id])).rows[0]
        .status,
      "cancelled",
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*) FROM messages WHERE provider_id='reply-test'",
        )
      ).rows[0].count,
      "1",
    );
  } finally {
    process.env.COMMUNICATIONS_MODE = "demo";
  }
});
test("worker crash recovery does not automatically resend an uncertain delivery", async () => {
  const c = await customer();
  const id = await domain.queueMessage(
    {
      contactId: c.ct.id,
      channel: "email",
      subject: "Test",
      body: "Test",
      idempotencyKey: randomUUID(),
    },
    admin,
  );
  await db.query(
    "UPDATE messages SET status='sending',updated_at=now()-interval '11 minutes' WHERE id=$1",
    [id],
  );
  await db.query(
    "UPDATE jobs SET status='running',locked_at=now()-interval '11 minutes' WHERE dedupe_key=$1",
    [`message:${id}`],
  );
  await worker.recoverStaleJobs();
  assert.equal(
    (await db.query("SELECT status FROM messages WHERE id=$1", [id])).rows[0]
      .status,
    "review",
  );
  assert.equal(
    (
      await db.query("SELECT status FROM jobs WHERE dedupe_key=$1", [
        `message:${id}`,
      ])
    ).rows[0].status,
    "review",
  );
});
test("a demo queue cannot become a live send when configuration changes", async () => {
  const c = await customer();
  const id = await domain.queueMessage(
    {
      contactId: c.ct.id,
      channel: "email",
      subject: "Mode test",
      body: "Demo only",
      idempotencyKey: randomUUID(),
    },
    admin,
  );
  process.env.COMMUNICATIONS_MODE = "live";
  try {
    // Drain other due jobs, including cancelled messages from previous tests.
    await drainDueJobs();
    const message = (
      await db.query("SELECT status,error FROM messages WHERE id=$1", [id])
    ).rows[0];
    assert.equal(message.status, "cancelled");
    assert.match(message.error, /Delivery mode changed/);
  } finally {
    process.env.COMMUNICATIONS_MODE = "demo";
  }
});
test("Be back retains an actionable future follow-up instead of losing the task", async () => {
  const c = await customer();
  await domain.changeStage(c.deal.id, "Be back", admin);
  const pending = (
    await db.query(
      "SELECT * FROM tasks WHERE opportunity_id=$1 AND resolution='open'",
      [c.deal.id],
    )
  ).rows;
  assert.equal(pending.length, 1);
  assert.ok(new Date(pending[0].due_at) > new Date());
  const deal = (
    await db.query("SELECT * FROM opportunities WHERE id=$1", [c.deal.id])
  ).rows[0];
  assert.equal(deal.next_action, pending[0].title);
  assert.equal(
    new Date(deal.next_action_at).toISOString(),
    new Date(pending[0].due_at).toISOString(),
  );
});
test("Postmark manual suppression works without a MessageID", async () => {
  const c = await customer();
  process.env.COMMUNICATIONS_MODE = "live";
  process.env.POSTMARK_WEBHOOK_USER = "test";
  process.env.POSTMARK_WEBHOOK_PASSWORD = "test-password";
  try {
    const result = await hooks.postmarkWebhook(
      new Request("http://localhost:3000/api/webhooks/postmark", {
        method: "POST",
        headers: {
          authorization:
            "Basic " + Buffer.from("test:test-password").toString("base64"),
        },
        body: JSON.stringify({
          RecordType: "SubscriptionChange",
          MessageID: null,
          Recipient: c.ct.email,
          SuppressSending: true,
          Origin: "Customer",
        }),
      }),
    );
    assert.equal(result.status, 200);
    assert.equal(
      (
        await db.query("SELECT email_suppressed FROM contacts WHERE id=$1", [
          c.ct.id,
        ])
      ).rows[0].email_suppressed,
      true,
    );
  } finally {
    process.env.COMMUNICATIONS_MODE = "demo";
  }
});

test("record editing fixes missing POS, preserves suppression, and rejects stale versions", async () => {
  const m = await import("../src/server/management");
  const c = await customer({ pos: "" });
  const data = await domain.getWorkspace(admin);
  const row = data.customers.find((x) => x.id === c.id)!;
  const input = m.editInput.parse({
    id: c.id,
    opportunityId: c.deal.id,
    contactId: c.ct.id,
    version: row.version,
    opportunityVersion: row.opportunity_version,
    contactVersion: row.contact_version,
    name: row.name,
    city: row.city,
    pos: "The Edge",
    locations: row.locations,
    source: row.source,
    ownerId: admin.id,
    opportunityOwnerId: admin.id,
    lifecycle: "prospect",
    doNotContact: false,
    restrictionReason: "",
    contactName: row.contact_name,
    email: row.email,
    phone: row.phone,
    contactDoNotContact: false,
    smsConsent: true,
    emailConsent: true,
    consentSource: "Test fixture",
    package: row.package,
    mrr: 500,
    setup: 100,
    discount: 25,
    effectiveDate: "2026-11-05",
    appointmentAt: "",
    currentMrr: null,
  });
  await db.query("UPDATE contacts SET email_suppressed=true WHERE id=$1", [
    c.ct.id,
  ]);
  await m.editCustomer(input, admin);
  await assert.rejects(() => m.editCustomer(input, admin), /record changed/);
  assert.equal(
    (
      await db.query("SELECT email_suppressed FROM contacts WHERE id=$1", [
        c.ct.id,
      ])
    ).rows[0].email_suppressed,
    true,
  );
  await domain.changeStage(c.deal.id, "Won", admin);
  assert.equal(
    (await db.query("SELECT stage FROM opportunities WHERE id=$1", [c.deal.id]))
      .rows[0].stage,
    "Won",
  );
});
test("concurrent qualification creates one connected deal and one account view", async () => {
  const m = await import("../src/server/management");
  const c = await customer();
  const [a, b] = await Promise.all([
    m.qualifyLead(c.deal.id, admin),
    m.qualifyLead(c.deal.id, admin),
  ]);
  assert.equal(a, b);
  assert.notEqual(a, c.deal.id);
  const data = await domain.getWorkspace(admin);
  assert.equal(data.customers.filter((x) => x.id === c.id).length, 1);
  assert.equal(data.opportunities.filter((x) => x.id === c.id).length, 2);
  assert.equal(
    (await db.query("SELECT stage FROM opportunities WHERE id=$1", [c.deal.id]))
      .rows[0].stage,
    "Qualified",
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*) FROM tasks WHERE opportunity_id=$1 AND resolution='open'",
        [a],
      )
    ).rows[0].count,
    "1",
  );
});
test("qualification preserves commercial terms and original appointment", async () => {
  const m = await import("../src/server/management");
  const c = await customer();
  const appointment = "2026-12-10T16:00:00.000Z";
  await db.query(
    "UPDATE opportunities SET setup_cents=20000,discount_cents=5000,effective_date='2026-12-01',appointment_at=$2 WHERE id=$1",
    [c.deal.id, appointment],
  );
  const id = await m.qualifyLead(c.deal.id, admin);
  const row = (
    await db.query(
      "SELECT *,effective_date::text effective FROM opportunities WHERE id=$1",
      [id],
    )
  ).rows[0];
  assert.equal(row.mrr_cents, c.deal.mrr_cents);
  assert.equal(row.setup_cents, 20000);
  assert.equal(row.discount_cents, 5000);
  assert.equal(row.effective, "2026-12-01");
  assert.equal(row.appointment_at.toISOString(), appointment);
});
test("qualification creates a next-action task even when independent work exists", async () => {
  const m = await import("../src/server/management");
  const c = await customer();
  await db.query(
    "UPDATE tasks SET resolution='completed',completed_at=now() WHERE opportunity_id=$1",
    [c.deal.id],
  );
  await db.query(
    "UPDATE opportunities SET next_action='',next_action_at=NULL WHERE id=$1",
    [c.deal.id],
  );
  await db.query(
    "INSERT INTO tasks(id,company_id,opportunity_id,owner_id,title,due_at) VALUES ($1,$2,$3,$4,'Independent admin work',now())",
    [randomUUID(), c.id, c.deal.id, admin.id],
  );
  const id = await m.qualifyLead(c.deal.id, admin);
  const rows = (
    await db.query(
      "SELECT * FROM tasks WHERE opportunity_id=$1 AND resolution='open'",
      [id],
    )
  ).rows;
  assert.equal(rows.length, 2);
  const next = rows.find((t) => t.is_next_action);
  assert.ok(next);
  const deal = (await db.query("SELECT * FROM opportunities WHERE id=$1", [id]))
    .rows[0];
  assert.equal(next.title, deal.next_action);
  assert.equal(next.due_at.toISOString(), deal.next_action_at.toISOString());
});
test("additional contacts and opportunities reuse the existing company", async () => {
  const m = await import("../src/server/management");
  const c = await customer();
  const count = (await db.query("SELECT count(*) FROM companies")).rows[0]
    .count;
  const contact = await m.addContact(
    {
      companyId: c.id,
      name: "Second Person",
      email: "secondary@example.test",
      phone: "",
      title: "Manager",
    },
    admin,
  );
  const key = randomUUID();
  const input = {
    companyId: c.id,
    contactId: contact,
    ownerId: admin.id,
    package: "Training only" as const,
    mrr: 350,
    nextAction: "Discuss training",
    dueAt: new Date().toISOString(),
    requestKey: key,
  };
  await m.addOpportunity(input, admin);
  await m.addOpportunity(input, admin);
  assert.equal(
    (await db.query("SELECT count(*) FROM companies")).rows[0].count,
    count,
  );
  assert.equal(
    (
      await db.query("SELECT count(*) FROM opportunities WHERE company_id=$1", [
        c.id,
      ])
    ).rows[0].count,
    "2",
  );
});
test("company and contact restrictions block queueing and send-time dispatch", async () => {
  const c = await customer();
  await db.query("UPDATE companies SET do_not_contact=true WHERE id=$1", [
    c.id,
  ]);
  const input = {
    contactId: c.ct.id,
    channel: "email" as const,
    subject: "DNC test",
    body: "Must not send",
    idempotencyKey: randomUUID(),
  };
  await assert.rejects(
    () => domain.queueMessage(input, admin),
    /Do not contact/,
  );
  await db.query("UPDATE companies SET do_not_contact=false WHERE id=$1", [
    c.id,
  ]);
  const id = await domain.queueMessage(input, admin);
  await db.query("UPDATE contacts SET do_not_contact=true WHERE id=$1", [
    c.ct.id,
  ]);
  await drainDueJobs();
  assert.equal(
    (await db.query("SELECT status FROM messages WHERE id=$1", [id])).rows[0]
      .status,
    "cancelled",
  );
  const cookie = await auth.createSession(admin.id);
  const r = await routes.POST(
    request("calls/start", { contactId: c.ct.id }, { cookie }),
    { params: Promise.resolve({ path: ["calls", "start"] }) },
  );
  assert.equal(r.status, 409);
});
test("rescheduling supersedes only the next-action task and never claims completion", async () => {
  const c = await customer();
  const extra = randomUUID();
  await db.query(
    "INSERT INTO tasks(id,company_id,opportunity_id,owner_id,title,due_at) VALUES ($1,$2,$3,$4,'Independent work',now())",
    [extra, c.id, c.deal.id, admin.id],
  );
  const cookie = await auth.createSession(admin.id);
  const r = await routes.POST(
    request(
      "customers/follow-up",
      {
        opportunityId: c.deal.id,
        title: "New next action",
        dueAt: new Date(Date.now() + 86400000).toISOString(),
      },
      { cookie },
    ),
    { params: Promise.resolve({ path: ["customers", "follow-up"] }) },
  );
  assert.equal(r.status, 200);
  const rows = (
    await db.query("SELECT * FROM tasks WHERE opportunity_id=$1", [c.deal.id])
  ).rows;
  assert.equal(
    rows.find((t) => t.title === "Follow up").resolution,
    "superseded",
  );
  assert.equal(rows.find((t) => t.title === "Follow up").completed_at, null);
  assert.equal(rows.find((t) => t.id === extra).resolution, "open");
  assert.equal(
    rows.filter((t) => t.is_next_action && t.resolution === "open").length,
    1,
  );
  const completed = await routes.POST(
    request(
      "tasks/complete",
      { id: rows.find((t) => t.title === "New next action").id },
      { cookie },
    ),
    { params: Promise.resolve({ path: ["tasks", "complete"] }) },
  );
  assert.equal(completed.status, 200);
  const deal = (
    await db.query(
      "SELECT next_action,next_action_at FROM opportunities WHERE id=$1",
      [c.deal.id],
    )
  ).rows[0];
  assert.equal(deal.next_action, "");
  assert.equal(deal.next_action_at, null);
  assert.equal(
    (await db.query("SELECT resolution FROM tasks WHERE id=$1", [extra]))
      .rows[0].resolution,
    "open",
  );
});
test("intake token rotation, submission idempotence, files, and notifications", async () => {
  const intake = await import("../src/server/intake");
  const c = await customer();
  await domain.changeStage(c.deal.id, "Won", admin);
  const p = (
    await db.query("SELECT * FROM onboarding WHERE company_id=$1", [c.id])
  ).rows[0];
  const old = (await intake.issueIntake(p.id, admin)).url.split("/").at(-1)!;
  const token = (await intake.issueIntake(p.id, admin)).url.split("/").at(-1)!;
  await assert.rejects(() => intake.intakeInfo(old), /expired/);
  const input = intake.intakeInput.parse({
    requestKey: randomUUID(),
    contactName: "Test Person",
    email: c.ct.email,
    phone: c.ct.phone,
    pos: "Test POS",
    locations: 1,
    desiredStart: "",
    userList: "A Person, member@example.test, Associate",
    requirements: "Texting requested",
    files: [
      {
        name: "users.csv",
        mime: "text/csv",
        data: Buffer.from("name,email\nTest,test@example.test").toString(
          "base64",
        ),
      },
    ],
  });
  await intake.submitIntake(token, input);
  await intake.submitIntake(token, input);
  assert.equal((await intake.submissions(p.id)).length, 1);
  assert.equal(
    (
      await db.query(
        "SELECT count(*) FROM intake_files f JOIN intake_submissions s ON s.id=f.submission_id WHERE s.project_id=$1",
        [p.id],
      )
    ).rows[0].count,
    "1",
  );
  assert.ok(
    (
      await db.query("SELECT intake_received_at FROM onboarding WHERE id=$1", [
        p.id,
      ])
    ).rows[0].intake_received_at,
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*) FROM notifications WHERE company_id=$1 AND title='Intake received'",
        [c.id],
      )
    ).rows[0].count,
    "1",
  );
  await assert.rejects(
    () =>
      intake.submitIntake(token, {
        ...input,
        requestKey: randomUUID(),
        files: [
          {
            name: "bad.txt",
            mime: "text/plain",
            data: Buffer.from("<script>bad()</script>").toString("base64"),
          },
        ],
      }),
    /plain-text/,
  );
});
test("readiness gates require intake and applicable service evidence", async () => {
  const { checkReadiness, readinessDefaults } =
    await import("../src/server/workflow-core");
  const readiness = readinessDefaults("Full suite");
  const p = {
    phase: "Intake & pre-build",
    owner_id: admin.id,
    cs_owner_id: admin.id,
    intake_received_at: null as string | null,
    readiness,
    go_live_at: null as string | null,
  };
  assert.throws(() => checkReadiness(p), /Receive the customer intake/);
  p.intake_received_at = new Date().toISOString();
  assert.throws(() => checkReadiness(p), /user list/);
  readiness.user_list.status = "verified";
  readiness.data.status = "in_progress";
  readiness.texting.status = "in_progress";
  checkReadiness(p);
  p.phase = "Working session";
  assert.throws(() => checkReadiness(p), /data/);
  p.phase = "Go-live";
  readiness.live.status = "verified";
  assert.throws(() => checkReadiness(p), /go-live date/);
  p.go_live_at = "2026-01-01";
  checkReadiness(p);
});
test("project ownership and actual go-live rebase future adoption tasks", async () => {
  const m = await import("../src/server/management");
  const { readinessDefaults } = await import("../src/server/workflow-core");
  const c = await customer();
  await domain.changeStage(c.deal.id, "Won", admin);
  const p = (
    await db.query("SELECT * FROM onboarding WHERE company_id=$1", [c.id])
  ).rows[0];
  const readiness = readinessDefaults("Full suite");
  for (const value of Object.values(readiness))
    value.notes = "Applicable service scope reviewed";
  await m.updateProject(
    {
      id: p.id,
      version: p.version,
      ownerId: admin.id,
      csOwnerId: admin.id,
      salesOwnerId: admin.id,
      targetAt: "2026-10-01",
      billingAt: "2026-11-01",
      goLiveAt: "2026-10-05",
      blocker: "",
      readiness,
    },
    admin,
  );
  const task = (
    await db.query(
      "SELECT due_at FROM tasks WHERE onboarding_id=$1 AND title LIKE '%30-day%'",
      [p.id],
    )
  ).rows[0];
  assert.equal(new Date(task.due_at).toISOString().slice(0, 10), "2026-11-04");
});
test("reminders use business days and do not duplicate notifications", async () => {
  const m = await import("../src/server/management");
  const { addBusinessDays } = await import("../src/server/workflow-core");
  assert.equal(
    addBusinessDays(new Date("2026-11-06T12:00:00Z"), 2).toISOString(),
    "2026-11-10T12:00:00.000Z",
  );
  await m.scheduleReminders();
  const count = (await db.query("SELECT count(*) FROM notifications")).rows[0]
    .count;
  await m.scheduleReminders();
  assert.equal(
    (await db.query("SELECT count(*) FROM notifications")).rows[0].count,
    count,
  );
});
test("customer history pagination is independent of the global activity limit", async () => {
  const m = await import("../src/server/management");
  const c = await customer();
  for (let i = 0; i < 62; i++)
    await domain.activity(db, c.id, admin.id, "note", `History ${i}`);
  const first = await m.customerHistory(c.id);
  assert.equal(first.items.length, 50);
  assert.ok(first.next);
  const second = await m.customerHistory(c.id, first.next!);
  assert.equal(first.items.length + second.items.length, 63);
  assert.equal(
    new Set([...first.items, ...second.items].map((a) => a.id)).size,
    63,
  );
  assert.ok(first.items.every((a) => !("metadata" in a)));
});
test("invitations can be accepted once and disabled users lose session access", async () => {
  const m = await import("../src/server/management");
  const result = await m.invite(
    { name: "New Rep", email: "newrep@example.test", role: "sales" },
    admin,
  );
  const token = result.url.split("/").at(-1)!;
  await m.acceptInvite(token, "a-long-invitation-password");
  await assert.rejects(
    () => m.acceptInvite(token, "a-long-invitation-password"),
    /expired or already used/,
  );
  const user = (
    await db.query("SELECT * FROM users WHERE email='newrep@example.test'")
  ).rows[0];
  const cookie = await auth.createSession(user.id);
  assert.ok(
    await auth.userForRequest(
      new Request("http://localhost:3000", { headers: { cookie } }),
    ),
  );
  await db.query("UPDATE users SET active=false WHERE id=$1", [user.id]);
  assert.equal(
    await auth.userForRequest(
      new Request("http://localhost:3000", { headers: { cookie } }),
    ),
    null,
  );
});

test("migration dry runs detect collisions, preserve source IDs, and never trigger handoffs", async () => {
  const { previewImport, applyImport } = await import("../src/server/importer");
  const batch = {
    source: "test-monday",
    rows: [
      {
        externalId: "12345",
        name: "Imported Fixture",
        contactName: "Import Person",
        email: "imported@example.test",
        phone: "",
        ownerEmail: admin.email,
        kind: "deal",
        stage: "Won",
        package: "Full suite",
        mrr: 500,
        currentMrr: 450,
        lifecycle: "active",
        closedAt: "2025-01-01T12:00:00.000Z",
        effectiveDate: "2025-02-01",
        notes: "Historical context",
        doNotContact: true,
      },
    ],
  };
  const preview = await previewImport(batch);
  assert.equal(preview.create, 1);
  assert.equal(preview.review, 0);
  const imported = await applyImport(batch, admin);
  assert.equal(imported.create, 1);
  assert.equal((await previewImport(batch)).skip, 1);
  await applyImport(batch, admin);
  const mapped = (
    await db.query(
      "SELECT company_id FROM external_records WHERE source='test-monday'",
    )
  ).rows[0];
  assert.equal(
    (
      await db.query("SELECT count(*) FROM onboarding WHERE company_id=$1", [
        mapped.company_id,
      ])
    ).rows[0].count,
    "0",
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*) FROM companies WHERE id=$1 AND do_not_contact=true AND current_mrr_cents=45000",
        [mapped.company_id],
      )
    ).rows[0].count,
    "1",
  );
  const conflict = await previewImport({
    source: "another",
    rows: [{ ...batch.rows[0], externalId: "different" }],
  });
  assert.equal(conflict.review, 1);
  await assert.rejects(
    () =>
      applyImport(
        {
          source: "another",
          rows: [{ ...batch.rows[0], externalId: "different" }],
        },
        admin,
      ),
    /Resolve every review/,
  );
});
test("demo-created automation jobs cannot become live sends after a mode switch", async () => {
  const c = await customer();
  await db.query(
    'UPDATE settings SET value=\'{"welcome":true,"intakeNudge":true,"schedulingUrl":"https://example.test/book"}\' WHERE key=\'automation\'',
  );
  await domain.changeStage(c.deal.id, "Won", admin);
  const p = (
    await db.query("SELECT id FROM onboarding WHERE company_id=$1", [c.id])
  ).rows[0];
  const job = (
    await db.query(
      "SELECT payload FROM jobs WHERE kind='welcome' AND payload->>'projectId'=$1",
      [p.id],
    )
  ).rows[0];
  assert.equal(job.payload.deliveryMode, "demo");
  process.env.COMMUNICATIONS_MODE = "live";
  try {
    await drainDueJobs();
    assert.equal(
      (
        await db.query("SELECT count(*) FROM messages WHERE company_id=$1", [
          c.id,
        ])
      ).rows[0].count,
      "0",
    );
  } finally {
    process.env.COMMUNICATIONS_MODE = "demo";
    await db.query(
      'UPDATE settings SET value=\'{"welcome":false,"intakeNudge":false,"schedulingUrl":""}\' WHERE key=\'automation\'',
    );
  }
});

test("the public stage route requires lead qualification before deal progress", async () => {
  const c = await customer();
  const cookie = await auth.createSession(admin.id);
  const r = await routes.POST(
    request("opportunities/stage", { id: c.deal.id, stage: "Won" }, { cookie }),
    { params: Promise.resolve({ path: ["opportunities", "stage"] }) },
  );
  assert.equal(r.status, 409);
  assert.equal(
    (await db.query("SELECT stage FROM opportunities WHERE id=$1", [c.deal.id]))
      .rows[0].stage,
    "New lead",
  );
});
test("automatic welcome contains intake and scheduling links; replies cancel the pending nudge", async () => {
  const c = await customer();
  await db.query(
    'UPDATE settings SET value=\'{"welcome":true,"intakeNudge":true,"schedulingUrl":"https://example.test/book"}\' WHERE key=\'automation\'',
  );
  try {
    await domain.changeStage(c.deal.id, "Won", admin);
    await drainDueJobs();
    const messages = (
      await db.query("SELECT * FROM messages WHERE company_id=$1", [c.id])
    ).rows;
    assert.equal(messages.length, 1);
    assert.equal(messages[0].status, "simulated");
    assert.match(messages[0].body, /localhost:3000\/intake\//);
    assert.match(messages[0].body, /https:\/\/example.test\/book/);
    await domain.cancelQueued(db, c.ct.id, "Reply received");
    const pending = (
      await db.query(
        "SELECT j.status FROM jobs j JOIN onboarding p ON p.id::text=j.payload->>'projectId' WHERE j.kind='intake_nudge' AND p.company_id=$1",
        [c.id],
      )
    ).rows;
    assert.ok(pending.every((j) => j.status === "cancelled"));
  } finally {
    await db.query(
      'UPDATE settings SET value=\'{"welcome":false,"intakeNudge":false,"schedulingUrl":""}\' WHERE key=\'automation\'',
    );
  }
});
test("operator retry requires verification and refuses accepted sends", async () => {
  const m = await import("../src/server/management");
  const c = await customer();
  const id = await domain.queueMessage(
    {
      contactId: c.ct.id,
      channel: "email",
      subject: "Review",
      body: "Review test",
      idempotencyKey: randomUUID(),
    },
    admin,
  );
  await db.query("UPDATE messages SET status='review' WHERE id=$1", [id]);
  const job = (
    await db.query(
      "UPDATE jobs SET status='review' WHERE dedupe_key=$1 RETURNING id",
      [`message:${id}`],
    )
  ).rows[0];
  await assert.rejects(
    () =>
      m.reconcileJob(
        job.id,
        "retry",
        "Provider showed no acceptance",
        false,
        admin,
      ),
    /Only retry/,
  );
  await db.query(
    "UPDATE messages SET provider_id='already-accepted-test' WHERE id=$1",
    [id],
  );
  await assert.rejects(
    () =>
      m.reconcileJob(
        job.id,
        "retry",
        "Provider showed no acceptance",
        true,
        admin,
      ),
    /Only retry/,
  );
  await db.query(
    "UPDATE messages SET provider_id=NULL,status='cancelled' WHERE id=$1",
    [id],
  );
  await assert.rejects(
    () =>
      m.reconcileJob(
        job.id,
        "retry",
        "Provider showed no acceptance",
        true,
        admin,
      ),
    /Only retry/,
  );
  await m.reconcileJob(
    job.id,
    "resolve",
    "Accepted at provider; do not resend",
    false,
    admin,
  );
  assert.equal(
    (await db.query("SELECT status FROM jobs WHERE id=$1", [job.id])).rows[0]
      .status,
    "completed",
  );
});
test("intake files require a staff session and sales cannot edit onboarding readiness", async () => {
  const file = await routes.GET(
    new Request(`http://localhost:3000/api/files/${randomUUID()}`),
    { params: Promise.resolve({ path: ["files", randomUUID()] }) },
  );
  assert.equal(file.status, 401);
  const userId = randomUUID();
  await db.query(
    "INSERT INTO users(id,name,email,role) VALUES ($1,'Limited Rep','limited@example.test','sales')",
    [userId],
  );
  const cookie = await auth.createSession(userId);
  const r = await routes.POST(request("onboarding/edit", {}, { cookie }), {
    params: Promise.resolve({ path: ["onboarding", "edit"] }),
  });
  assert.equal(r.status, 403);
});

test("a qualified sale completes intake and every onboarding phase with active owners", async () => {
  const m = await import("../src/server/management");
  const intake = await import("../src/server/intake");
  const { readinessDefaults } = await import("../src/server/workflow-core");
  const { phases } = await import("../src/lib/types");
  await db.query(
    "INSERT INTO users(id,name,email,role,active,created_at) VALUES ($1,'Former onboarding owner','former-onboarding@example.test','onboarding',false,'2000-01-01')",
    [randomUUID()],
  );
  const c = await customer();
  const dealId = await m.qualifyLead(c.deal.id, admin);
  const cookie = await auth.createSession(admin.id);
  async function post(path: string, body: unknown) {
    const result = await routes.POST(request(path, body, { cookie }), {
      params: Promise.resolve({ path: path.split("/") }),
    });
    assert.equal(result.status, 200, await result.text());
  }
  await post("opportunities/stage", { id: dealId, stage: "Won" });
  let project = (
    await db.query("SELECT * FROM onboarding WHERE opportunity_id=$1", [dealId])
  ).rows[0];
  assert.ok(
    (await db.query("SELECT active FROM users WHERE id=$1", [project.owner_id]))
      .rows[0].active,
    "Handoffs must not be assigned to a disabled teammate",
  );
  const token = (await intake.issueIntake(project.id, admin)).url
    .split("/")
    .at(-1)!;
  await post(`intake/${token}`, {
    requestKey: randomUUID(),
    contactName: "Test Person",
    email: c.ct.email,
    phone: c.ct.phone,
    pos: "Test POS",
    locations: 1,
    desiredStart: "",
    userList: "Test Associate, associate@example.test",
    requirements: "Full-suite QA",
    files: [],
  });
  project = (
    await db.query("SELECT * FROM onboarding WHERE id=$1", [project.id])
  ).rows[0];
  const readiness = readinessDefaults("Full suite");
  for (const item of Object.values(readiness)) {
    if (item.status !== "not_applicable") item.status = "verified";
    item.notes = "Verified in the isolated QA scenario";
  }
  await post("onboarding/edit", {
    id: project.id,
    version: project.version,
    ownerId: admin.id,
    csOwnerId: admin.id,
    salesOwnerId: admin.id,
    targetAt: new Date(project.target_at).toISOString().slice(0, 10),
    billingAt: "",
    goLiveAt: new Date(Date.now() - 31 * 86400000).toISOString().slice(0, 10),
    blocker: "",
    readiness,
  });
  for (const phase of phases.filter((p) => p !== "Onboarded")) {
    const tasks = (
      await db.query(
        "SELECT id FROM tasks WHERE onboarding_id=$1 AND phase=$2 AND resolution='open'",
        [project.id, phase],
      )
    ).rows;
    for (const task of tasks) await post("tasks/complete", { id: task.id });
    await post("onboarding/advance", { id: project.id });
  }
  project = (
    await db.query("SELECT * FROM onboarding WHERE id=$1", [project.id])
  ).rows[0];
  assert.equal(project.phase, "Onboarded");
  assert.ok(project.completed_at);
  const account = (await domain.getWorkspace(admin)).customers.find(
    (row) => row.id === c.id,
  )!;
  assert.equal(account.lifecycle, "active");
  assert.equal(
    account.current_mrr_cents,
    null,
    "A won sale must not invent verified current account MRR",
  );
});

test("research approval, account matching and conversion are explicit and idempotent", async () => {
  const ops = await import("../src/server/operations");
  const c = await customer();
  const input = ops.prospectInput.parse({
    requestKey: randomUUID(),
    name: `Research ${randomUUID()}`,
    contactName: "Research Person",
    email: `${randomUUID()}@example.test`,
    signals: "Requested demo",
    fitScore: 8,
  });
  const id = await ops.addProspect(input, admin);
  assert.equal(await ops.addProspect(input, admin), id);
  await assert.rejects(ops.convertProspect(id, null, admin), /Approve/);
  await db.query(
    "UPDATE prospects SET status='approved',name=(SELECT name FROM companies WHERE id=$2) WHERE id=$1",
    [id, c.id],
  );
  await assert.rejects(
    ops.convertProspect(id, null, admin),
    /matching account/,
  );
  const [a, b] = await Promise.all([
    ops.convertProspect(id, c.id, admin),
    ops.convertProspect(id, c.id, admin),
  ]);
  assert.equal(a, b);
  const row = (
    await db.query(
      "SELECT o.company_id,ct.email_consent,ct.sms_consent FROM opportunities o JOIN contacts ct ON ct.id=o.contact_id WHERE o.id=$1",
      [a],
    )
  ).rows[0];
  assert.equal(row.company_id, c.id);
  assert.equal(row.email_consent, false);
  assert.equal(row.sms_consent, false);
});
test("public inquiries require same origin, deduplicate and throttle without queueing outreach", async () => {
  const input = {
    requestKey: randomUUID(),
    name: "Public QA Company",
    contactName: "QA Person",
    email: `${randomUUID()}@example.test`,
    notes: "Please contact me",
  };
  const send = (body: unknown) =>
    routes.POST(request("public/inquiry", body), {
      params: Promise.resolve({ path: ["public", "inquiry"] }),
    });
  assert.equal((await send(input)).status, 200);
  assert.equal((await send(input)).status, 200);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM prospects WHERE request_key=$1",
        [input.requestKey],
      )
    ).rows[0].n,
    1,
  );
  for (let i = 0; i < 4; i++)
    assert.equal(
      (await send({ ...input, requestKey: randomUUID() })).status,
      200,
    );
  assert.equal(
    (await send({ ...input, requestKey: randomUUID() })).status,
    429,
  );
  const forged = await routes.POST(
    request(
      "public/inquiry",
      { ...input, requestKey: randomUUID() },
      { origin: "https://foreign.example" },
    ),
    { params: Promise.resolve({ path: ["public", "inquiry"] }) },
  );
  assert.equal(forged.status, 403);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM messages WHERE recipient=$1",
        [input.email],
      )
    ).rows[0].n,
    0,
  );
});
test("recurring check-ins advance on due date once, retain missed tasks and pause with the account", async () => {
  const ops = await import("../src/server/operations");
  const c = await customer();
  await db.query("UPDATE companies SET lifecycle='active' WHERE id=$1", [c.id]);
  await db.query(
    "INSERT INTO customer_cadences(company_id,owner_id,next_at) VALUES($1,$2,now()-interval '1 day')",
    [c.id, admin.id],
  );
  await Promise.all([ops.processCadences(), ops.processCadences()]);
  let r = (
    await db.query(
      "SELECT r.next_at,t.* FROM customer_cadences r JOIN recurring_touches rt ON rt.company_id=r.company_id JOIN tasks t ON t.id=rt.task_id WHERE r.company_id=$1",
      [c.id],
    )
  ).rows;
  assert.equal(r.length, 1);
  assert.equal(r[0].resolution, "open");
  assert.ok(new Date(r[0].due_at) < new Date());
  assert.ok(new Date(r[0].next_at) > new Date(Date.now() + 43 * 86400000));
  await db.query(
    "UPDATE customer_cadences SET next_at=now()-interval '1 hour' WHERE company_id=$1",
    [c.id],
  );
  await db.query("UPDATE companies SET lifecycle='paused' WHERE id=$1", [c.id]);
  await ops.processCadences();
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM recurring_touches WHERE company_id=$1",
        [c.id],
      )
    ).rows[0].n,
    1,
  );
});
async function sequenceFixture(
  steps: { kind: string; waitDays: number; subject: string; body: string }[],
) {
  const ops = await import("../src/server/operations"),
    c = await customer(),
    id = randomUUID();
  // Pick a zone safely inside a 00:00–23:00 window, independent of test execution time.
  const zones = ["UTC", "Pacific/Honolulu", "Asia/Tokyo"];
  const timezone = zones.find((timezone) =>
    ops.inSendWindow(new Date(), {
      timezone,
      startHour: 0,
      endHour: 23,
      weekdaysOnly: false,
    }),
  )!;
  await db.query(
    "INSERT INTO sales_sequences(id,name,steps,active,timezone,start_hour,end_hour,weekdays_only,created_by) VALUES($1,'QA sequence',$2,true,$3,0,23,false,$4)",
    [id, JSON.stringify(steps), timezone, admin.id],
  );
  const key = randomUUID(),
    enrollment = await ops.enroll(id, c.deal.id, key, admin);
  assert.equal(await ops.enroll(id, c.deal.id, key, admin), enrollment);
  return { ops, c, id, enrollment };
}
test("sequence email and call steps progress once and wait for task completion", async () => {
  const s = await sequenceFixture([
    {
      kind: "email",
      waitDays: 0,
      subject: "Hello {{company}}",
      body: "Hi {{contact}}",
    },
    { kind: "call", waitDays: 0, subject: "", body: "Call after first email" },
    { kind: "email", waitDays: 2, subject: "Follow up", body: "Second email" },
  ]);
  await Promise.all([s.ops.processSequences(), s.ops.processSequences()]);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM sequence_steps WHERE enrollment_id=$1",
        [s.enrollment],
      )
    ).rows[0].n,
    1,
  );
  await drainDueJobs();
  const message = (
    await db.query(
      "SELECT m.* FROM messages m JOIN sequence_steps st ON st.message_id=m.id WHERE st.enrollment_id=$1",
      [s.enrollment],
    )
  ).rows[0];
  assert.equal(message.status, "simulated");
  assert.match(message.body, /Test Person/);
  await s.ops.processSequences();
  await s.ops.processSequences();
  let tasks = (
    await db.query(
      "SELECT task_id FROM sequence_steps WHERE enrollment_id=$1 AND task_id IS NOT NULL",
      [s.enrollment],
    )
  ).rows;
  assert.equal(tasks.length, 1);
  await s.ops.processSequences();
  assert.equal(
    (
      await db.query(
        "SELECT step_index FROM sequence_enrollments WHERE id=$1",
        [s.enrollment],
      )
    ).rows[0].step_index,
    1,
  );
  await db.query(
    "UPDATE tasks SET resolution='completed',completed_at=now() WHERE id=$1",
    [tasks[0].task_id],
  );
  await s.ops.processSequences();
  const e = (
    await db.query("SELECT * FROM sequence_enrollments WHERE id=$1", [
      s.enrollment,
    ])
  ).rows[0];
  assert.equal(e.step_index, 2);
  assert.ok(new Date(e.next_at) > new Date(Date.now() + 1.9 * 86400000));
  await db.query(
    "UPDATE sequence_enrollments SET status='stopped' WHERE id=$1",
    [s.enrollment],
  );
});
test("paused sequence keeps queued email unsent; an old unsubscribe link stops later steps", async () => {
  const s = await sequenceFixture([
    { kind: "email", waitDays: 0, subject: "First", body: "First body" },
    { kind: "email", waitDays: 0, subject: "Second", body: "Second body" },
  ]);
  await s.ops.processSequences();
  const first = (
    await db.query(
      "SELECT m.* FROM messages m JOIN sequence_steps st ON st.message_id=m.id WHERE st.enrollment_id=$1",
      [s.enrollment],
    )
  ).rows[0];
  await db.query(
    "UPDATE sequence_enrollments SET status='paused' WHERE id=$1",
    [s.enrollment],
  );
  await drainDueJobs();
  assert.equal(
    (await db.query("SELECT status FROM messages WHERE id=$1", [first.id]))
      .rows[0].status,
    "queued",
  );
  await db.query(
    "UPDATE sequence_enrollments SET status='active' WHERE id=$1",
    [s.enrollment],
  );
  await db.query(
    "UPDATE jobs SET run_at=now() WHERE payload->>'messageId'=$1",
    [first.id],
  );
  await drainDueJobs();
  await s.ops.processSequences();
  await s.ops.processSequences();
  const token = first.body.match(/unsubscribe\/([a-f0-9]+)/)[1];
  await s.ops.unsubscribe(token);
  await s.ops.unsubscribe(token);
  assert.equal(
    (
      await db.query("SELECT status FROM sequence_enrollments WHERE id=$1", [
        s.enrollment,
      ])
    ).rows[0].status,
    "stopped",
  );
  assert.equal(
    (
      await db.query("SELECT email_suppressed FROM contacts WHERE id=$1", [
        s.c.ct.id,
      ])
    ).rows[0].email_suppressed,
    true,
  );
  assert.equal(
    (
      await db.query(
        "SELECT m.status FROM messages m JOIN sequence_steps st ON st.message_id=m.id WHERE enrollment_id=$1 AND step_index=1",
        [s.enrollment],
      )
    ).rows[0].status,
    "cancelled",
  );
});
test("sequence stops on changed delivery mode and respects weekday/time-zone windows", async () => {
  const s = await sequenceFixture([
    { kind: "email", waitDays: 0, subject: "First", body: "Body" },
  ]);
  assert.equal(
    s.ops.inSendWindow(new Date("2026-11-07T17:00:00Z"), {
      timezone: "America/Chicago",
      startHour: 9,
      endHour: 17,
      weekdaysOnly: true,
    }),
    false,
  );
  assert.equal(
    s.ops.inSendWindow(new Date("2026-11-05T17:00:00Z"), {
      timezone: "America/Chicago",
      startHour: 9,
      endHour: 17,
      weekdaysOnly: true,
    }),
    true,
  );
  process.env.COMMUNICATIONS_MODE = "live";
  try {
    await s.ops.processSequences();
  } finally {
    process.env.COMMUNICATIONS_MODE = "demo";
  }
  assert.equal(
    (
      await db.query("SELECT status FROM sequence_enrollments WHERE id=$1", [
        s.enrollment,
      ])
    ).rows[0].status,
    "stopped",
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM sequence_steps WHERE enrollment_id=$1",
        [s.enrollment],
      )
    ).rows[0].n,
    0,
  );
});
test("intake supports the source questions without requiring a user list", async () => {
  const { intakeInput } = await import("../src/server/intake");
  const parsed = intakeInput.parse({
    requestKey: randomUUID(),
    contactName: "QA Person",
    email: "qa@example.test",
    phone: "",
    companyName: "QA",
    pos: "Edge",
    locations: 1,
    desiredStart: "",
    userList: "",
    requirements: "",
    country: "United States",
    edtLicense: "yes",
    teamOverview: "Two managers",
    textingRequested: "yes",
    textingPlatform: "Existing platform",
    numberChoice: "existing",
    dataTransferRequested: "yes",
    files: [],
  });
  assert.equal(parsed.country, "United States");
  assert.equal(parsed.userList, "");
  assert.equal(parsed.files.length, 0);
});
test("Office uploads validate the document container and reject renamed or macro files", async () => {
  const { validateFile, fileMimes } =
    await import("../src/server/file-validation");
  // Minimal ZIP metadata fixture; uploads remain opaque and are never extracted.
  const zip = (names: string[]) => {
    const first = Buffer.alloc(30);
    first.writeUInt32LE(0x04034b50);
    const entries = names.map((name) => {
      const b = Buffer.alloc(46 + Buffer.byteLength(name));
      b.writeUInt32LE(0x02014b50);
      b.writeUInt16LE(Buffer.byteLength(name), 28);
      b.write(name, 46);
      return b;
    });
    const central = Buffer.concat(entries),
      end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50);
    end.writeUInt16LE(names.length, 10);
    end.writeUInt32LE(central.length, 12);
    end.writeUInt32LE(first.length, 16);
    return Buffer.concat([first, central, end]).toString("base64");
  };
  for (const [extension, part, mime] of [
    ["xlsx", "xl/workbook.xml", fileMimes[3]],
    ["docx", "word/document.xml", fileMimes[4]],
  ]) {
    assert.ok(
      validateFile({
        name: `users.${extension}`,
        mime,
        data: zip(["[Content_Types].xml", part]),
      }).content.length,
    );
    assert.throws(
      () =>
        validateFile({
          name: `users.${extension}`,
          mime,
          data: zip(["[Content_Types].xml", part, "vbaProject.bin"]),
        }),
      /Macro/,
    );
    assert.throws(
      () =>
        validateFile({
          name: `users.${extension}`,
          mime,
          data: Buffer.from("not a document").toString("base64"),
        }),
      /Invalid Office/,
    );
  }
});

test("shared contacts preserve account context and each account's send-time restrictions", async () => {
  const a = await customer(),
    b = await customer();
  const ops = await import("../src/server/operations");
  await ops.operationsRoute(
    "operations/contact-link",
    request("operations/contact-link", {}),
    {
      contactId: a.ct.id,
      companyId: b.id,
      evidence: "Verified QA contact represents both accounts",
    },
    admin,
  );
  const m = await import("../src/server/management");
  const opportunity = await m.addOpportunity(
    m.opportunityInput.parse({
      companyId: b.id,
      contactId: a.ct.id,
      ownerId: admin.id,
      package: "Texting",
      mrr: 100,
      nextAction: "Review shared account",
      dueAt: new Date().toISOString(),
      requestKey: randomUUID(),
    }),
    admin,
  );
  assert.equal(
    (
      await db.query("SELECT company_id FROM opportunities WHERE id=$1", [
        opportunity,
      ])
    ).rows[0].company_id,
    b.id,
  );
  const id = await domain.queueMessage(
    domain.messageInput.parse({
      contactId: a.ct.id,
      companyId: b.id,
      channel: "email",
      subject: "Shared account",
      body: "QA",
      idempotencyKey: randomUUID(),
    }),
    admin,
  );
  assert.equal(
    (await db.query("SELECT company_id FROM messages WHERE id=$1", [id]))
      .rows[0].company_id,
    b.id,
  );
  await db.query("UPDATE companies SET do_not_contact=true WHERE id=$1", [
    b.id,
  ]);
  await drainDueJobs();
  assert.equal(
    (await db.query("SELECT status FROM messages WHERE id=$1", [id])).rows[0]
      .status,
    "cancelled",
  );
  await assert.rejects(
    domain.queueMessage(
      domain.messageInput.parse({
        contactId: a.ct.id,
        companyId: b.id,
        channel: "email",
        subject: "Blocked",
        body: "QA",
        idempotencyKey: randomUUID(),
      }),
      admin,
    ),
    /Do not contact/,
  );
  const data = await domain.getWorkspace(admin);
  assert.ok(
    data.contacts.find((c) => c.id === a.ct.id)!.company_ids.includes(b.id),
  );
  const cookie = await auth.createSession(admin.id);
  const call = await routes.POST(
    request("calls/start", { contactId: a.ct.id, companyId: b.id }, { cookie }),
    { params: Promise.resolve({ path: ["calls", "start"] }) },
  );
  assert.equal(call.status, 409);
});
test("new leads reuse reviewed accounts and reject silent duplicate company creation", async () => {
  const c = await customer();
  const name = (
    await db.query("SELECT name FROM companies WHERE id=$1", [c.id])
  ).rows[0].name;
  const input = domain.customerInput.parse({
    name,
    contactName: c.ct.name,
    email: c.ct.email,
    phone: c.ct.phone,
    package: "Undecided",
    mrr: 0,
    nextAction: "A new need",
    nextActionAt: new Date().toISOString(),
  });
  await assert.rejects(domain.createCustomer(input, admin), /Existing account/);
  assert.equal(
    await domain.createCustomer({ ...input, companyId: c.id }, admin),
    c.id,
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM contacts WHERE company_id=$1",
        [c.id],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM opportunities WHERE company_id=$1",
        [c.id],
      )
    ).rows[0].n,
    2,
  );
});
test("configured handoff routing assigns technical and customer-success work separately", async () => {
  const c = await customer(),
    technical = randomUUID(),
    cs = randomUUID();
  for (const id of [technical, cs])
    await db.query(
      "INSERT INTO users(id,name,email,role,password_hash) VALUES($1,'QA Owner',$2,'onboarding','unused')",
      [id, `${id}@example.test`],
    );
  const original = (
    await db.query("SELECT value FROM settings WHERE key='automation'")
  ).rows[0].value;
  await db.query(
    "UPDATE settings SET value=value||$1::jsonb WHERE key='automation'",
    [JSON.stringify({ technicalOwnerId: technical, csOwnerId: cs })],
  );
  try {
    await domain.changeStage(c.deal.id, "Won", admin);
    const p = (
      await db.query("SELECT * FROM onboarding WHERE company_id=$1", [c.id])
    ).rows[0];
    assert.equal(p.owner_id, technical);
    assert.equal(p.cs_owner_id, cs);
    assert.equal(
      (
        await db.query(
          "SELECT owner_id FROM tasks WHERE onboarding_id=$1 AND phase='Handoff' LIMIT 1",
          [p.id],
        )
      ).rows[0].owner_id,
      cs,
    );
    assert.equal(
      (
        await db.query(
          "SELECT owner_id FROM tasks WHERE onboarding_id=$1 AND phase='Working session' LIMIT 1",
          [p.id],
        )
      ).rows[0].owner_id,
      technical,
    );
  } finally {
    await db.query("UPDATE settings SET value=$1 WHERE key='automation'", [
      JSON.stringify(original),
    ]);
  }
});
test("percent discounts retain their units when a lead qualifies", async () => {
  const c = await customer(),
    m = await import("../src/server/management");
  await db.query(
    "UPDATE opportunities SET discount_type='percent',discount_percent=10,discount_cents=0 WHERE id=$1",
    [c.deal.id],
  );
  const id = await m.qualifyLead(c.deal.id, admin);
  const row = (
    await db.query(
      "SELECT discount_type,discount_percent,discount_cents FROM opportunities WHERE id=$1",
      [id],
    )
  ).rows[0];
  assert.equal(row.discount_type, "percent");
  assert.equal(Number(row.discount_percent), 10);
  assert.equal(row.discount_cents, 0);
});

test("historical migration retains project phase, tasks, files and messages without restarting automations", async () => {
  const imp = await import("../src/server/importer");
  const n = randomUUID();
  const batch = {
    source: "history-qa",
    rows: [
      {
        externalId: n,
        name: `Historical ${n}`,
        contactName: "Archived Contact",
        email: `${n}@example.test`,
        phone: "",
        ownerEmail: admin.email,
        kind: "deal",
        stage: "Won",
        package: "Full suite",
        lifecycle: "onboarding",
        closedAt: "2025-01-01T12:00:00Z",
        discountType: "percent",
        discount: 15,
        accountProfile: { country: "US" },
        contactProfile: { storePhone: "555 shared store" },
        sourceFields: { originalStage: "Training" },
        project: {
          phase: "Training",
          package: "Full suite",
          source: "new_sale",
          technicalOwnerEmail: admin.email,
          csOwnerEmail: admin.email,
          salesOwnerEmail: admin.email,
          startedAt: "2025-01-02T12:00:00Z",
          phaseStartedAt: "2025-01-10T12:00:00Z",
          targetAt: "2025-01-30T12:00:00Z",
          readiness: { data: { status: "verified", notes: "Source review" } },
          tasks: [
            {
              title: "Finish original training",
              ownerEmail: admin.email,
              phase: "Training",
              dueAt: "2025-01-15T12:00:00Z",
              inProgress: true,
            },
            {
              title: "Original access complete",
              ownerEmail: admin.email,
              phase: "Working session",
              dueAt: "2025-01-09T12:00:00Z",
              resolution: "completed",
              completedAt: "2025-01-09T13:00:00Z",
            },
          ],
        },
        messages: [
          {
            channel: "email",
            direction: "inbound",
            subject: "Original history",
            body: "Historical reply",
            recipient: `${n}@example.test`,
            status: "received",
            createdAt: "2025-01-02T10:00:00Z",
          },
        ],
        files: [
          {
            name: "original.txt",
            mime: "text/plain",
            data: Buffer.from("Archived original file").toString("base64"),
            createdAt: "2025-01-02T10:00:00Z",
          },
        ],
      },
    ],
  };
  const preview = await imp.previewImport(batch);
  assert.equal(preview.review, 0);
  const jobsBefore = (await db.query("SELECT count(*)::int n FROM jobs"))
    .rows[0].n;
  await imp.applyImport(batch, admin);
  await imp.applyImport(batch, admin);
  const map = (
    await db.query(
      "SELECT * FROM external_records WHERE source=$1 AND external_id=$2",
      [batch.source, n],
    )
  ).rows[0];
  const p = (
    await db.query("SELECT * FROM onboarding WHERE company_id=$1", [
      map.company_id,
    ])
  ).rows[0];
  assert.equal(p.phase, "Training");
  assert.equal(p.started_at.toISOString(), "2025-01-02T12:00:00.000Z");
  assert.equal(p.readiness.data.status, "verified");
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM tasks WHERE onboarding_id=$1",
        [p.id],
      )
    ).rows[0].n,
    2,
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM messages WHERE company_id=$1",
        [map.company_id],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM record_files WHERE company_id=$1",
        [map.company_id],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (await db.query("SELECT count(*)::int n FROM jobs")).rows[0].n,
    jobsBefore,
  );
  assert.equal(map.payload.sourceFields.originalStage, "Training");
  const row = (
    await db.query(
      "SELECT discount_type,discount_percent FROM opportunities WHERE id=$1",
      [map.opportunity_id],
    )
  ).rows[0];
  assert.equal(row.discount_type, "percent");
  assert.equal(Number(row.discount_percent), 15);
});
test("CSV preparation preserves quoted fields and refuses unmapped stages or ambiguous discount units", async () => {
  const { prepareMonday, parseCsv } =
    await import("../src/server/monday-adapter");
  const config = {
    source: "qa",
    columns: {
      externalId: { column: "ID" },
      name: { column: "Name" },
      stage: { column: "Stage", values: { "Closed Won": "Won" } },
      discount: { column: "Discount", type: "number" },
    },
    defaults: { discountType: "percent" },
  };
  const r = prepareMonday(
    'ID,Name,Stage,Discount\r\n100,"Example, Inc.",Closed Won,10\r\n',
    config,
  );
  assert.equal(r.errors.length, 0);
  assert.equal(r.batch.rows[0].name, "Example, Inc.");
  assert.equal(r.batch.rows[0].discount, 10);
  assert.equal(
    prepareMonday("ID,Name,Stage,Discount\n101,Example,Unknown,10", config)
      .errors.length,
    1,
  );
  assert.equal(
    prepareMonday("ID,Name,Stage,Discount\n101,Example,Closed Won,10", {
      ...config,
      defaults: {},
    }).errors[0].field,
    "discountType",
  );
  assert.deepEqual(parseCsv('a,b\n"line one\nline two","say ""hello"""'), [
    ["a", "b"],
    ["line one\nline two", 'say "hello"'],
  ]);
  assert.throws(() => parseCsv('a\n"unterminated'), /Unclosed/);
});
test("staff notification email is deduplicated, mode-pinned and cancelled when a recipient is disabled", async () => {
  const core = await import("../src/server/workflow-core");
  const original = (
    await db.query("SELECT value FROM settings WHERE key='automation'")
  ).rows[0].value;
  await db.query(
    "UPDATE settings SET value=value||'{\"staffEmail\":true}'::jsonb WHERE key='automation'",
  );
  try {
    const key = randomUUID();
    await core.notify(
      db,
      admin.id,
      null,
      "QA internal notification",
      "Demo only",
      key,
    );
    await core.notify(
      db,
      admin.id,
      null,
      "QA internal notification",
      "Demo only",
      key,
    );
    let rows = (
      await db.query("SELECT * FROM notifications WHERE dedupe_key=$1", [key])
    ).rows;
    assert.equal(rows.length, 1);
    await drainDueJobs();
    assert.equal(
      (
        await db.query("SELECT email_status FROM notifications WHERE id=$1", [
          rows[0].id,
        ])
      ).rows[0].email_status,
      "simulated",
    );
    const key2 = randomUUID();
    await core.notify(
      db,
      admin.id,
      null,
      "QA disabled recipient",
      "Demo only",
      key2,
    );
    await db.query("UPDATE users SET active=false WHERE id=$1", [admin.id]);
    await drainDueJobs();
    assert.equal(
      (
        await db.query(
          "SELECT email_status FROM notifications WHERE dedupe_key=$1",
          [key2],
        )
      ).rows[0].email_status,
      "cancelled",
    );
  } finally {
    await db.query("UPDATE users SET active=true WHERE id=$1", [admin.id]);
    await db.query("UPDATE settings SET value=$1 WHERE key='automation'", [
      JSON.stringify(original),
    ]);
  }
});

test("resetting a cadence to an already processed date does not duplicate or stall it", async () => {
  const ops = await import("../src/server/operations");
  const c = await customer();
  await db.query("UPDATE companies SET lifecycle='active' WHERE id=$1", [c.id]);
  await db.query(
    "INSERT INTO customer_cadences(company_id,owner_id,next_at) VALUES($1,$2,now()-interval '1 day')",
    [c.id, admin.id],
  );
  await ops.processCadences();
  await db.query(
    "UPDATE customer_cadences SET next_at=(SELECT scheduled_at FROM recurring_touches WHERE company_id=$1 LIMIT 1) WHERE company_id=$1",
    [c.id],
  );
  await ops.processCadences();
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM recurring_touches WHERE company_id=$1",
        [c.id],
      )
    ).rows[0].n,
    1,
  );
  assert.ok(
    new Date(
      (
        await db.query(
          "SELECT next_at FROM customer_cadences WHERE company_id=$1",
          [c.id],
        )
      ).rows[0].next_at,
    ) > new Date(),
  );
});
test("operations metrics and file archive include imported and intake attachments with staff-only downloads", async () => {
  const ops = await import("../src/server/operations");
  const data = await ops.operationsRoute(
    "operations/data",
    new Request("http://localhost:3000/api/operations/data"),
    {},
    admin,
  );
  const body = await data!.json();
  assert.ok(body.sequences[0].metrics);
  assert.ok(
    body.contacts.every((c: { company_ids: string[] }) =>
      Array.isArray(c.company_ids),
    ),
  );
  const result = await ops.operationsRoute(
    "operations/archive",
    new Request("http://localhost:3000/api/operations/archive?kind=files"),
    {},
    admin,
  );
  const files = await result!.json();
  assert.ok(
    files.rows.some((f: { name: string }) => f.name === "original.txt"),
  );
  assert.ok(files.rows.length >= 2);
  const id = files.rows[0].id;
  const unauthorized = await routes.GET(
    new Request(`http://localhost:3000/api/operations/file?id=${id}`),
    { params: Promise.resolve({ path: ["operations", "file"] }) },
  );
  assert.equal(unauthorized.status, 401);
  const download = await ops.operationsRoute(
    "operations/file",
    new Request(`http://localhost:3000/api/operations/file?id=${id}`),
    {},
    admin,
  );
  assert.equal(
    download!.headers.get("Content-Type"),
    "application/octet-stream",
  );
  assert.match(download!.headers.get("Content-Disposition")!, /attachment/);
});

test("phase email templates snapshot content, obey settings and never restart imported work", async () => {
  const original = (
    await db.query("SELECT value FROM settings WHERE key='automation'")
  ).rows[0].value;
  const template = "00000000-0000-4000-8000-000000000001";
  const before = (
    await db.query("SELECT * FROM message_templates WHERE id=$1", [template])
  ).rows[0];
  await db.query(
    'UPDATE settings SET value=value||\'{"phaseEmails":true,"welcome":false,"intakeNudge":false}\'::jsonb WHERE key=\'automation\'',
  );
  await db.query(
    "UPDATE message_templates SET automatic=true,body='Snapshot hello {{contact}} at {{company}}' WHERE id=$1",
    [template],
  );
  try {
    const c = await customer();
    await domain.changeStage(c.deal.id, "Won", admin);
    const p = (
      await db.query("SELECT * FROM onboarding WHERE company_id=$1", [c.id])
    ).rows[0];
    await db.query(
      "UPDATE tasks SET resolution='completed',completed_at=now() WHERE onboarding_id=$1 AND phase='Handoff'",
      [p.id],
    );
    await domain.advancePhase(p.id, admin);
    const jobs = (
      await db.query(
        "SELECT * FROM jobs WHERE kind='phase_email' AND payload->>'projectId'=$1",
        [p.id],
      )
    ).rows;
    assert.equal(jobs.length, 1);
    await db.query(
      "UPDATE message_templates SET body='Edited later' WHERE id=$1",
      [template],
    );
    await drainDueJobs();
    const m = (
      await db.query("SELECT * FROM messages WHERE idempotency_key=$1", [
        jobs[0].payload.messageKey,
      ])
    ).rows[0];
    assert.equal(m.status, "simulated");
    assert.match(m.body, /Snapshot hello Test Person/);
    assert.ok(!m.body.includes("{{"));
  } finally {
    await db.query(
      "UPDATE message_templates SET automatic=$2,body=$3 WHERE id=$1",
      [template, before.automatic, before.body],
    );
    await db.query("UPDATE settings SET value=$1 WHERE key='automation'", [
      JSON.stringify(original),
    ]);
  }
});
test("research correction invalidates approval and rejects stale saves", async () => {
  const ops = await import("../src/server/operations");
  const input = ops.prospectInput.parse({
      requestKey: randomUUID(),
      name: "QA Correction",
      contactName: "QA Contact",
    }),
    id = await ops.addProspect(input, admin);
  await db.query("UPDATE prospects SET status='approved' WHERE id=$1", [id]);
  const value = { ...input, id, version: 1, name: "QA Corrected Account" };
  await ops.operationsRoute(
    "operations/prospect-edit",
    request("operations/prospect-edit", value),
    value,
    admin,
  );
  assert.equal(
    (await db.query("SELECT status FROM prospects WHERE id=$1", [id])).rows[0]
      .status,
    "review",
  );
  await assert.rejects(
    ops.operationsRoute(
      "operations/prospect-edit",
      request("operations/prospect-edit", value),
      value,
      admin,
    ),
    /changed/,
  );
});

const inboundForm = (email = "incoming@example.test") => ({
  submissionId: randomUUID(),
  form: "Demo request",
  name: "Demo Person",
  email,
  company: "Fictional Demo Store",
  phone: "",
  message: "Please show the team the product",
  pageUrl: "https://linkd.com/demo/",
  fields: { locations: "2" },
  tracking: { utm_campaign: "test" },
});
async function signedInbound(
  path: string,
  body: unknown,
  key: string,
  header = "X-Linkd-Signature",
  seconds = Math.floor(Date.now() / 1000),
) {
  const { createHmac } = await import("node:crypto");
  const raw = JSON.stringify(body),
    signature = createHmac("sha256", key)
      .update(`${seconds}.${raw}`)
      .digest("hex");
  return new Request("http://localhost:3000/api/" + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [header]: `t=${seconds},v1=${signature}`,
    },
    body: raw,
  });
}
const calendlyFixture = (
  email: string,
  uri = `https://api.calendly.com/scheduled_events/${randomUUID()}/invitees/${randomUUID()}`,
) => ({
  event: "invitee.created",
  created_at: new Date().toISOString(),
  payload: {
    uri,
    event: uri.split("/invitees/")[0],
    email,
    name: "Booked Person",
    updated_at: new Date().toISOString(),
    status: "active",
    timezone: "America/Chicago",
    rescheduled: false,
    old_invitee: null as string | null,
    new_invitee: null as string | null,
    cancel_url: "https://calendly.com/cancellations/example",
    reschedule_url: "https://calendly.com/reschedulings/example",
    questions_and_answers: [{ question: "Store?", answer: "Fictional Store" }],
    tracking: { utm_source: "linkd" },
    scheduled_event: {
      name: "Product demo",
      start_time: new Date(Date.now() + 86400000).toISOString(),
      end_time: new Date(Date.now() + 88200000).toISOString(),
      event_type: "https://api.calendly.com/event_types/demo",
      location: { type: "zoom", join_url: "https://zoom.us/j/12345" },
      event_memberships: [
        { user_name: "Demo Host", user_email: "host@example.test" },
      ],
    },
  },
});
test("website intake authenticates all four sources, deduplicates submissions, and never grants marketing consent", async () => {
  const service = await import("../src/server/inbound");
  const c = await customer({ emailConsent: false, smsConsent: false });
  const key = "test-website-signing-key-at-least-24-chars";
  for (const brand of ["jewellink", "linkd", "jewelhire", "countretail"]) {
    process.env[`INBOUND_${brand.toUpperCase()}_SECRET`] = key;
    const input = {
      ...inboundForm(c.ct.email),
      pageUrl: `https://${brand}.com/demo/`,
    };
    const call = () => routes.POST as typeof routes.POST;
    const response = await call()(
      await signedInbound(`webhooks/websites/${brand}`, input, key),
      { params: Promise.resolve({ path: ["webhooks", "websites", brand] }) },
    );
    assert.equal(response.status, 200);
    const result = await response.json();
    const repeat = await service.websiteWebhook(
      await signedInbound(`webhooks/websites/${brand}`, input, key),
      brand,
    );
    assert.equal((await repeat.json()).duplicate, true);
    const detail = await service.inboundDetail(result.id);
    assert.equal(detail.record.linked_company_id, c.id);
    assert.equal(detail.record.details.fields.locations, "2");
    assert.equal(detail.events.length, 1);
    const notifications = await db.query(
      "SELECT * FROM notifications WHERE dedupe_key LIKE $1",
      [`inbound:website:${brand}:${input.submissionId}:%`],
    );
    assert.ok(notifications.rowCount! >= 1);
  }
  const ct = (await db.query("SELECT * FROM contacts WHERE id=$1", [c.ct.id]))
    .rows[0];
  assert.equal(ct.sms_consent, false);
  assert.equal(ct.email_consent, false);
  await assert.rejects(
    service.websiteWebhook(
      await signedInbound(
        "webhooks/websites/linkd",
        inboundForm(),
        key,
        "X-Linkd-Signature",
        Math.floor(Date.now() / 1000) - 181,
      ),
      "linkd",
    ),
    /Expired/,
  );
  await assert.rejects(
    service.websiteWebhook(
      await signedInbound(
        "webhooks/websites/linkd",
        inboundForm(),
        "wrong-secret-is-long-enough-to-sign",
      ),
      "linkd",
    ),
    /Invalid webhook/,
  );
  await assert.rejects(
    service.receiveForm(
      "linkd",
      service.formInput.parse({
        ...inboundForm(),
        pageUrl: "https://evil.example/demo",
      }),
    ),
    /source website/,
  );
});
test("shared email matches stay in review instead of attaching a booking to the wrong store", async () => {
  const service = await import("../src/server/inbound");
  const a = await customer(),
    b = await customer();
  await db.query(
    "INSERT INTO company_contacts(company_id,contact_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
    [b.id, a.ct.id],
  );
  const input = service.formInput.parse(inboundForm(a.ct.email));
  const record = await service.receiveForm("linkd", input);
  const d = await service.inboundDetail(record.id);
  assert.equal(d.record.match_status, "ambiguous");
  assert.equal(d.record.company_id, null);
  await assert.rejects(service.inboundToProspect(record.id, admin), /Resolve/);
});
test("Calendly cancellation before creation cannot resurrect a meeting or duplicate alerts", async () => {
  const service = await import("../src/server/inbound");
  process.env.CALENDLY_SIGNING_KEY = "calendly-test-signing-key-long-enough";
  const c = await customer(),
    created = calendlyFixture(c.ct.email);
  const canceled = structuredClone(created);
  canceled.event = "invitee.canceled";
  canceled.payload.status = "canceled";
  canceled.payload.updated_at = new Date(Date.now() + 1000).toISOString();
  const send = async (body: unknown) =>
    service.calendlyWebhook(
      await signedInbound(
        "webhooks/calendly",
        body,
        process.env.CALENDLY_SIGNING_KEY!,
        "Calendly-Webhook-Signature",
      ),
    );
  const first = await (await send(canceled)).json();
  assert.equal((await (await send(created)).json()).duplicate, true);
  assert.equal((await (await send(canceled)).json()).duplicate, true);
  const d = await service.inboundDetail(first.id);
  assert.equal(d.record.status, "canceled");
  assert.equal(d.record.linked_company_id, c.id);
  assert.equal(d.events.length, 1);
  const history = await service.inboundList(
    new URLSearchParams({ companyId: c.id }),
  );
  assert.ok(history.records.some((r) => r.id === first.id));
  await assert.rejects(
    service.calendlyWebhook(
      await signedInbound(
        "webhooks/calendly",
        created,
        "wrong-calendly-secret-long-enough",
        "Calendly-Webhook-Signature",
      ),
    ),
    /Invalid webhook/,
  );
});
test("Calendly reschedule pairs retain both records, accept either delivery order, and reject older updates", async () => {
  const service = await import("../src/server/inbound");
  process.env.CALENDLY_SIGNING_KEY = "calendly-test-signing-key-long-enough";
  const send = async (body: unknown) =>
    await (
      await service.calendlyWebhook(
        await signedInbound(
          "webhooks/calendly",
          body,
          process.env.CALENDLY_SIGNING_KEY!,
          "Calendly-Webhook-Signature",
        ),
      )
    ).json();
  const c = await customer(),
    old = calendlyFixture(c.ct.email),
    next = calendlyFixture(c.ct.email);
  next.payload.old_invitee = old.payload.uri;
  next.payload.rescheduled = true;
  const n = await send(next),
    o = await send(old);
  let d = await service.inboundDetail(o.id);
  assert.equal(d.record.status, "rescheduled");
  assert.equal(d.related[0].id, n.id);
  const cancel = structuredClone(old);
  cancel.event = "invitee.canceled";
  cancel.payload.status = "canceled";
  cancel.payload.rescheduled = true;
  cancel.payload.new_invitee = next.payload.uri;
  cancel.payload.updated_at = new Date(Date.now() + 2000).toISOString();
  await send(cancel);
  await send(old);
  d = await service.inboundDetail(o.id);
  assert.equal(d.record.status, "rescheduled");
  assert.equal((await service.inboundDetail(n.id)).record.status, "scheduled");
  const upcoming = await service.inboundList(
    new URLSearchParams({ companyId: c.id, filter: "upcoming" }),
  );
  assert.equal(upcoming.total, 1);
  assert.equal(upcoming.records[0].id, n.id);
});
test("inquiry Research conversion preserves historical forms and archived records on the account", async () => {
  const service = await import("../src/server/inbound"),
    operations = await import("../src/server/operations");
  const r = await service.receiveForm(
    "linkd",
    service.formInput.parse(inboundForm("new-qualified-inquiry@example.test")),
  );
  const p = await service.inboundToProspect(r.id, admin);
  assert.equal((await service.inboundToProspect(r.id, admin)).id, p.id);
  await db.query("UPDATE prospects SET status='approved' WHERE id=$1", [p.id]);
  await operations.convertProspect(p.id, null, admin);
  const linked = (await service.inboundDetail(r.id)).record;
  assert.ok(linked.linked_company_id);
  await service.updateInbound(
    {
      id: r.id,
      version: linked.version,
      ownerId: admin.id,
      companyId: null,
      retailerId: null,
      brand: "linkd",
      reviewStatus: "archived",
      outcome: "",
      notes: "Handled by team",
    },
    admin,
  );
  const history = await service.inboundList(
    new URLSearchParams({
      companyId: linked.linked_company_id,
      filter: "history",
    }),
  );
  assert.equal(history.total, 1);
  const inbox = await service.inboundList(
    new URLSearchParams({ companyId: linked.linked_company_id }),
  );
  assert.equal(inbox.total, 0);
});
test("routing controls notification recipients and booking ownership; stale reviews are rejected", async () => {
  const service = await import("../src/server/inbound"),
    otherId = randomUUID();
  await db.query(
    "INSERT INTO users(id,name,email,role) VALUES($1,'Inbound Owner',$2,'sales')",
    [otherId, `owner-${otherId}@example.test`],
  );
  const row = (
    await db.query("SELECT * FROM inbound_routing WHERE brand='countretail'")
  ).rows[0];
  await service.saveRouting({
    brand: "countretail",
    ownerId: otherId,
    notifyUserIds: [otherId],
    bookingUrl: "https://calendly.com/example/demo",
    eventTypeUris: ["https://api.calendly.com/event_types/countretail"],
    version: row.version,
  });
  const r = await service.receiveForm(
    "countretail",
    service.formInput.parse({
      ...inboundForm("route-test@example.test"),
      pageUrl: "https://countretail.com/",
    }),
  );
  const detail = await service.inboundDetail(r.id);
  assert.equal(detail.record.owner_id, otherId);
  const notices = (
    await db.query(
      "SELECT user_id FROM notifications WHERE dedupe_key LIKE $1",
      [`inbound:website:countretail:%`],
    )
  ).rows;
  assert.ok(notices.some((n) => n.user_id === otherId));
  const input = {
    id: r.id,
    version: detail.record.version,
    ownerId: otherId,
    companyId: null,
    retailerId: null,
    brand: "countretail",
    reviewStatus: "reviewed",
    outcome: "",
    notes: "Follow up next week",
  };
  await service.updateInbound(input, admin);
  await assert.rejects(service.updateInbound(input, admin), /changed/);
  await assert.rejects(
    service.saveRouting({
      brand: "jewelhire",
      ownerId: null,
      notifyUserIds: [],
      bookingUrl: "https://calendly.com@example.evil/book",
      eventTypeUris: [],
      version: 1,
    }),
    /calendly/,
  );
});
test("manual bookings deduplicate, validate times, and require a session and sales role", async () => {
  const service = await import("../src/server/inbound"),
    c = await customer();
  const input = {
    requestKey: randomUUID(),
    brand: "linkd",
    title: "Discovery call",
    name: c.ct.name,
    email: c.ct.email,
    companyId: c.id,
    retailerId: null,
    ownerId: admin.id,
    startsAt: new Date(Date.now() + 86400000).toISOString(),
    endsAt: new Date(Date.now() + 88200000).toISOString(),
    location: "Phone",
    notes: "Fictional QA",
  };
  const r = await service.manualBooking(input, admin);
  assert.equal((await service.manualBooking(input, admin)).id, r.id);
  await assert.rejects(
    service.manualBooking(
      { ...input, requestKey: randomUUID(), endsAt: input.startsAt },
      admin,
    ),
    /End must follow/,
  );
  const unauth = await routes.POST(request("inbound/manual", input), {
    params: Promise.resolve({ path: ["inbound", "manual"] }),
  });
  assert.equal(unauth.status, 401);
  await assert.rejects(
    service.inboundRoute(
      "inbound/manual",
      request("inbound/manual", input),
      input,
      { ...admin, role: "onboarding" },
    ),
    /permission|allow|access/i,
  );
  const d = await service.inboundDetail(r.id);
  assert.equal(d.record.status, "scheduled");
  await service.inboundRoute(
    "inbound/cancel",
    request("inbound/cancel", {}),
    { id: r.id, version: d.record.version, reason: "Meeting postponed" },
    admin,
  );
  assert.equal((await service.inboundDetail(r.id)).record.status, "canceled");
});

test("phone-only website leads are retained without matching empty-email contacts", async () => {
  const service = await import("../src/server/inbound");
  const r = await service.receiveForm(
    "jewellink",
    service.formInput.parse({
      ...inboundForm(""),
      phone: "2025550133",
      pageUrl: "https://jewellink.com/ring-builder/",
    }),
  );
  const d = await service.inboundDetail(r.id);
  assert.equal(d.record.match_status, "unmatched");
  assert.equal(d.record.company_id, null);
  assert.equal(d.record.phone, "2025550133");
});
