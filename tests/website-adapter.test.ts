import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  deliverIntake,
  normalizeIntake,
  withSalesForce,
} from "../integrations/website-intake.mjs";
const env = {
  SALES_FORCE_ENABLED: "true",
  SALES_FORCE_SIGNING_KEY: "fictional-server-signing-key-long-enough",
};
const opts = { brand: "linkd", form: "Demo request", page: "/demo/" };
test("website adapter sends only the allowed form fields and signs the exact payload", async () => {
  const input = normalizeIntake(
    {
      submissionId: "fixture-1",
      name: "Person",
      storeName: "Store",
      email: "person@example.test",
      sourceUrl:
        "https://linkd.com/demo/?utm_source=partner&resumeToken=never-forward",
      password: "never-forward",
      turnstileToken: "never-forward",
      notes: "Call please",
      locations: "2",
    },
    opts,
  );
  let deliveries = 0;
  await deliverIntake(env, "linkd", input, async (url, options) => {
    deliveries++;
    assert.equal(url, "https://sales.linkd.com/api/webhooks/websites/linkd");
    const h = options.headers as Record<string, string>,
      [time, sig] = h["X-Linkd-Signature"].split(",");
    assert.equal(
      sig.slice(3),
      createHmac("sha256", env.SALES_FORCE_SIGNING_KEY)
        .update(time.slice(2) + "." + options.body)
        .digest("hex"),
    );
    assert.doesNotMatch(
      String(options.body),
      /password|turnstileToken|never-forward/,
    );
    assert.equal(JSON.parse(String(options.body)).submissionId, "fixture-1");
    return new Response("{}", { status: deliveries === 1 ? 503 : 200 });
  });
  assert.equal(deliveries, 2);
  assert.equal(input.tracking.utm_source, "partner");
});
test("website adapter rejects an unconfirmed intake and preserves honeypot and failed validation behavior", async () => {
  const request = (data: unknown) =>
    new Request("https://linkd.com/api/demo", {
      method: "POST",
      body: JSON.stringify(data),
    });
  let originalCalls = 0;
  const handler = withSalesForce(
    async () => {
      originalCalls++;
      return Response.json({ ok: true });
    },
    { ...opts, getEnv: async () => ({ SALES_FORCE_ENABLED: "true" }) },
  );
  assert.equal(
    (await handler(request({ name: "Person", email: "person@example.test" })))
      .status,
    503,
  );
  assert.equal(
    (
      await handler(
        request({
          name: "Person",
          email: "person@example.test",
          website: "spam",
        }),
      )
    ).status,
    200,
  );
  const invalid = withSalesForce(
    async () => Response.json({ error: "invalid" }, { status: 400 }),
    { ...opts, getEnv: async () => env },
  );
  assert.equal((await invalid(request({ name: "Person" }))).status, 400);
  assert.equal(originalCalls, 2);
});
test("website adapter disabled mode leaves the existing form response intact and phone-only forms are retained", async () => {
  const payload = normalizeIntake(
    { name: "Phone person", phone: "2025550123", design: { shape: "round" } },
    { brand: "jewellink", form: "Ring builder", page: "/ring-builder/" },
  );
  assert.equal(payload.email, "");
  assert.equal(payload.fields["design.shape"], "round");
  let calls = 0;
  assert.deepEqual(
    await deliverIntake({}, "jewellink", payload, async () => {
      calls++;
      throw new Error("Must not send");
    }),
    { enabled: false },
  );
  assert.equal(calls, 0);
});
