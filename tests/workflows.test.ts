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
    "UPDATE tasks SET completed_at=now() WHERE onboarding_id=$1 AND phase='Handoff'",
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
      "SELECT * FROM tasks WHERE opportunity_id=$1 AND completed_at IS NULL",
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
