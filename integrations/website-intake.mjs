/** Server-only adapter for existing validated marketing form handlers.
 * Enable after deploying Sales Force: SALES_FORCE_ENABLED=true and a brand-specific
 * SALES_FORCE_SIGNING_KEY. Never expose these values in browser JavaScript.
 */
const encoder = new TextEncoder();
const clean = (value, max = 4000) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";
const hex = (bytes) =>
  Array.from(new Uint8Array(bytes), (v) =>
    v.toString(16).padStart(2, "0"),
  ).join("");
export function normalizeIntake(data, { brand, form, page = "/" }) {
  let pageUrl = `https://${brand}.com${page}`;
  try {
    const candidate = new URL(
      data.sourceUrl || data.page || data.referrer || pageUrl,
    );
    if (
      candidate.protocol === "https:" &&
      [brand + ".com", "www." + brand + ".com"].includes(candidate.hostname)
    )
      pageUrl = candidate.href;
  } catch {}
  const fields = {};
  for (const key of [
    "locations",
    "currentPos",
    "demoFocus",
    "timeline",
    "preferredContact",
    "referrer",
    "zip",
    "radius",
    "provider",
    "providerName",
    "updates",
    "optIn",
  ]) {
    if (
      typeof data[key] === "string" ||
      typeof data[key] === "boolean" ||
      typeof data[key] === "number"
    )
      fields[key] = String(data[key]).slice(0, 4000);
  }
  if (Array.isArray(data.needs))
    fields.needs = data.needs
      .map((v) => clean(v, 100))
      .slice(0, 20)
      .join(", ");
  if (Array.isArray(data.visibleMatches))
    fields.providerMatches = JSON.stringify(
      data.visibleMatches
        .map((v) => ({
          name: clean(v.name, 180),
          tier: clean(v.tier, 80),
          distance: clean(String(v.distance), 30),
        }))
        .slice(0, 8),
    ).slice(0, 4000);
  if (Array.isArray(data.interests))
    fields.interests = data.interests
      .map((v) => clean(v, 100))
      .slice(0, 20)
      .join(", ");
  if (data.design && typeof data.design === "object")
    for (const key of [
      "shape",
      "style",
      "metal",
      "diamondType",
      "carat",
      "budget",
      "notes",
    ])
      fields[`design.${key}`] = clean(data.design[key]);
  const tracking = {};
  for (const [key, camel] of Object.entries({
    utm_source: "utmSource",
    utm_medium: "utmMedium",
    utm_campaign: "utmCampaign",
    utm_content: "utmContent",
    utm_term: "utmTerm",
  })) {
    const v = clean(
      data[camel] ||
        data.tracking?.[key] ||
        data.acquisition?.[key] ||
        new URL(pageUrl).searchParams.get(key),
      500,
    );
    if (v) tracking[key] = v;
  }
  // Keep campaign attribution, but never copy resume tokens or other URL secrets.
  const safePage = new URL(pageUrl);
  safePage.search = "";
  safePage.hash = "";
  safePage.username = "";
  safePage.password = "";
  for (const [key, value] of Object.entries(tracking))
    safePage.searchParams.set(key, value);
  pageUrl = safePage.href;
  if (fields.referrer) {
    try {
      const ref = new URL(fields.referrer);
      fields.referrer = ["https:", "http:"].includes(ref.protocol)
        ? ref.origin + ref.pathname
        : "";
    } catch {
      delete fields.referrer;
    }
  }
  return {
    submissionId: clean(data.submissionId, 200) || crypto.randomUUID(),
    form,
    name: clean(data.name, 150),
    email: clean(data.email, 254).toLowerCase(),
    company: clean(data.company || data.store || data.storeName, 180),
    phone: clean(data.phone, 80),
    message: clean(data.notes || data.message, 10000),
    pageUrl,
    fields,
    tracking,
  };
}
export async function deliverIntake(env, brand, payload, send = fetch) {
  if (env.SALES_FORCE_ENABLED !== "true") return { enabled: false };
  const secret = env.SALES_FORCE_SIGNING_KEY;
  if (typeof secret !== "string" || secret.length < 24)
    throw new Error("Sales Force signing key is missing");
  // Deliberately fixed destination: configuration cannot redirect retailer data.
  const destination = `https://sales.linkd.com/api/webhooks/websites/${brand}`;
  if (!["jewellink", "linkd", "jewelhire", "countretail"].includes(brand))
    throw new Error("Unsupported brand");
  const raw = JSON.stringify(payload);
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  for (let attempt = 0; attempt < 3; attempt++) {
    const t = String(Math.floor(Date.now() / 1000));
    const signature = hex(
      await crypto.subtle.sign("HMAC", key, encoder.encode(`${t}.${raw}`)),
    );
    try {
      const result = await send(destination, {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          "X-Linkd-Signature": `t=${t},v1=${signature}`,
        },
        body: raw,
        signal: AbortSignal.timeout(8000),
      });
      if (result.ok) return { enabled: true };
      if (result.status < 500 && result.status !== 429)
        throw new Error("Sales Force rejected the submission");
    } catch (error) {
      if (attempt === 2)
        throw new Error("Sales Force could not confirm receipt");
    }
  }
  throw new Error("Sales Force could not confirm receipt");
}
export function withSalesForce(handler, options) {
  return async function (...args) {
    const request = args[0] instanceof Request ? args[0] : args[0].request;
    if (request.method !== "POST") return handler(...args);
    let data;
    try {
      const reader = request.clone().body?.getReader();
      const chunks = [];
      let size = 0;
      if (reader)
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 64000) {
            void reader.cancel();
            return new Response("Request too large", { status: 413 });
          }
          chunks.push(value);
        }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      data = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return handler(...args);
    }
    const response = await handler(...args);
    // Preserve original validation, anti-spam, and delivery behavior. Only accepted
    // form submissions are forwarded. Never forward session/auth/HR fields.
    if (
      !response.ok ||
      !data ||
      typeof data !== "object" ||
      Boolean(data.website) ||
      !clean(data.name) ||
      (!clean(data.email) && !clean(data.phone))
    )
      return response;
    if (options.skipEvent && data.event === options.skipEvent) return response;
    const env = options.getEnv ? await options.getEnv() : args[0].env || {};
    try {
      await deliverIntake(env, options.brand, normalizeIntake(data, options));
      return response;
    } catch {
      return new Response(
        JSON.stringify({
          ok: false,
          message:
            "Your details could not be confirmed. Please retry with the same form.",
          error: {
            code: "intake_unavailable",
            message: "Please retry your request.",
          },
        }),
        {
          status: 503,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
        },
      );
    }
  };
}
