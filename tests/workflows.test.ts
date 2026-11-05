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
  await worker.runOneJob();
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
  await worker.runOneJob();
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
    while (await worker.runOneJob()) {}
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
  while (await worker.runOneJob()) {}
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
    while (await worker.runOneJob()) {}
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
    while (await worker.runOneJob()) {}
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
