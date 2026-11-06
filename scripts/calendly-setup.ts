import { z } from "zod";
const apply = process.argv.includes("--apply");
const token = process.env.CALENDLY_ACCESS_TOKEN;
const key = process.env.CALENDLY_SIGNING_KEY;
const origin = new URL(process.env.APP_URL || "http://localhost:3000");
const endpoint = new URL("/api/webhooks/calendly", origin).href;
async function api(path: string, body?: unknown) {
  const response = await fetch("https://api.calendly.com/" + path, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new Error(
      `Calendly returned ${response.status}. Verify token permissions, organization admin access, and a plan supporting webhooks.`,
    );
  return response.json();
}
async function main() {
  if (!token || !key || key.length < 24)
    throw new Error(
      "Configure CALENDLY_ACCESS_TOKEN and a CALENDLY_SIGNING_KEY of at least 24 characters.",
    );
  if (origin.protocol !== "https:" || origin.hostname !== "sales.linkd.com")
    throw new Error(
      "Set APP_URL=https://sales.linkd.com after deploying the public service.",
    );
  const me = await api("users/me");
  const org = z
    .string()
    .regex(/^https:\/\/api\.calendly\.com\/organizations\/[A-Za-z0-9-]+$/)
    .parse(
      process.env.CALENDLY_ORGANIZATION_URI || me.resource.current_organization,
    );
  const query = new URLSearchParams({
    organization: org,
    scope: "organization",
    count: "100",
  });
  const subscriptions: {
    uri: string;
    callback_url: string;
    events: string[];
    state: string;
  }[] = [];
  for (let page = 0; page < 100; page++) {
    const list = await api("webhook_subscriptions?" + query);
    subscriptions.push(...list.collection);
    if (!list.pagination?.next_page_token) break;
    query.set("page_token", list.pagination.next_page_token);
    if (page === 99)
      throw new Error(
        "Subscription listing exceeded the safe page limit. Inspect Calendly subscriptions manually.",
      );
  }
  const matching = subscriptions.filter((s) => s.callback_url === endpoint);
  if (matching.length) {
    console.log(
      JSON.stringify(
        {
          action: "existing_subscription",
          endpoint,
          subscriptions: matching.map((s) => ({
            uri: s.uri,
            state: s.state,
            events: s.events,
          })),
          note: "No duplicate created. Confirm the existing subscription uses the configured signing key and includes both invitee events.",
        },
        null,
        2,
      ),
    );
    return;
  }
  if (!apply) {
    console.log(
      JSON.stringify(
        {
          action: "preview",
          endpoint,
          organization: org,
          events: ["invitee.created", "invitee.canceled"],
          next: "After deploying the endpoint, rerun with --apply to subscribe.",
        },
        null,
        2,
      ),
    );
    return;
  }
  // A public route must be reachable before creating a subscription.
  const health = await fetch(new URL("/api/auth/info", origin), {
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  if (!health.ok || (await health.json()).demoLogin !== false)
    throw new Error(
      "The public service must be reachable with demo login disabled.",
    );
  const result = await api("webhook_subscriptions", {
    url: endpoint,
    organization: org,
    scope: "organization",
    events: ["invitee.created", "invitee.canceled"],
    signing_key: key,
  });
  console.log(
    JSON.stringify(
      { action: "subscribed", uri: result.resource.uri, endpoint },
      null,
      2,
    ),
  );
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : "Calendly setup failed.");
  process.exitCode = 1;
});
