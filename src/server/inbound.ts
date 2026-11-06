import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { db, transaction, type Connection } from "./db";
import { HttpError, requireRole, hash } from "./auth";
import { boundedText } from "./webhooks";
import { assertOwner, notify } from "./workflow-core";
import { inboundBrands, brandNames, type InboundBrand } from "../lib/inbound";
import type { User } from "../lib/types";

const text = (max = 1000) => z.string().trim().max(max).default("");
const brandSchema = z.enum(inboundBrands);
const sourceSecret = (brand: string) =>
  process.env[`INBOUND_${brand.toUpperCase()}_SECRET`];
const stamp = z.iso.datetime({ offset: true });
const optionalUrl = z.union([z.url().max(2000), z.literal("")]).default("");
export const formInput = z.object({
  submissionId: z.string().trim().min(1).max(200),
  form: z.string().trim().min(1).max(150),
  name: z.string().trim().min(1).max(150),
  email: z
    .union([z.email().max(254), z.literal("")])
    .default("")
    .transform((v) => v.toLowerCase()),
  company: text(180),
  phone: text(80),
  message: text(10000),
  pageUrl: optionalUrl,
  submittedAt: stamp.optional(),
  fields: z
    .record(z.string().max(100), z.string().max(4000))
    .refine((v) => Object.keys(v).length <= 40)
    .default({}),
  tracking: z
    .record(z.string().max(100), z.string().max(500))
    .refine((v) => Object.keys(v).length <= 12)
    .default({}),
});

/** Raw body signatures authenticate servers, never browser form fields. */
export function verifyInboundSignature(
  raw: string,
  header: string | null,
  secret: string | undefined,
) {
  if (!secret || secret.length < 24)
    throw new HttpError(503, "Integration signing key is not configured.");
  const parts = (header || "").split(",").map((p) => p.trim().split("="));
  const timestamps = parts.filter((p) => p[0] === "t");
  if (timestamps.length !== 1 || !/^\d{10}$/.test(timestamps[0][1] || ""))
    throw new HttpError(401, "Invalid webhook signature.");
  const timestamp = timestamps[0][1];
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 180)
    throw new HttpError(401, "Expired webhook signature.");
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${raw}`)
    .digest();
  const valid = parts.some(
    ([k, value]) =>
      k === "v1" &&
      /^[a-f0-9]{64}$/i.test(value || "") &&
      timingSafeEqual(expected, Buffer.from(value, "hex")),
  );
  if (!valid) throw new HttpError(401, "Invalid webhook signature.");
}

async function matchEmail(tx: Connection, email: string) {
  if (!email)
    return {
      companyId: null,
      retailerId: null,
      prospectId: null,
      matchStatus: "unmatched",
    };
  // A shared contact or chain email is not enough evidence to pick a store.
  const companies = (
    await tx.query(
      `SELECT DISTINCT cc.company_id id FROM contacts c JOIN company_contacts cc ON cc.contact_id=c.id WHERE lower(c.email)=$1
       UNION SELECT company_id id FROM inbound_records WHERE lower(email)=$1 AND match_status='manual' AND company_id IS NOT NULL`,
      [email],
    )
  ).rows;
  const retailers = (
    await tx.query(
      `SELECT DISTINCT r.id,COALESCE(r.company_id,p.company_id) company_id,r.prospect_id FROM retailer_people rp JOIN retailers r ON r.id=rp.retailer_id LEFT JOIN prospects p ON p.id=r.prospect_id WHERE lower(trim(rp.email))=$1`,
      [email],
    )
  ).rows;
  const prospects = (
    await tx.query(
      `SELECT id,company_id FROM prospects WHERE lower(email)=$1 AND status NOT IN ('suppressed')`,
      [email],
    )
  ).rows;
  const companyIds = new Set(
    [
      ...companies.map((c) => c.id),
      ...retailers.map((r) => r.company_id),
      ...prospects.map((p) => p.company_id),
    ].filter(Boolean),
  );
  const ambiguous =
    companyIds.size > 1 || retailers.length > 1 || prospects.length > 1;
  return {
    companyId: !ambiguous ? [...companyIds][0] || null : null,
    retailerId: !ambiguous ? retailers[0]?.id || null : null,
    prospectId: !ambiguous
      ? prospects[0]?.id || retailers[0]?.prospect_id || null
      : null,
    matchStatus: ambiguous
      ? "ambiguous"
      : companyIds.size || retailers.length || prospects.length
        ? "matched"
        : "unmatched",
  };
}
async function ownerFor(
  tx: Connection,
  brand: string,
  companyId: string | null,
  retailerId: string | null,
) {
  const owner = (
    await tx.query(
      `SELECT u.id FROM users u WHERE u.active AND (
    u.id=(SELECT owner_id FROM companies WHERE id=$2) OR u.id=(SELECT owner_id FROM retailers WHERE id=$3)
    OR u.id=(SELECT owner_id FROM inbound_routing WHERE brand=$1) OR u.role IN ('sales','admin'))
    ORDER BY CASE WHEN u.id=(SELECT owner_id FROM companies WHERE id=$2) THEN 0 WHEN u.id=(SELECT owner_id FROM retailers WHERE id=$3) THEN 1
    WHEN u.id=(SELECT owner_id FROM inbound_routing WHERE brand=$1) THEN 2 WHEN u.role='sales' THEN 3 ELSE 4 END,u.created_at LIMIT 1`,
      [brand, companyId, retailerId],
    )
  ).rows[0]?.id;
  if (!owner)
    throw new HttpError(503, "Assign an active sales team member first.");
  return owner as string;
}
async function alertTeam(
  tx: Connection,
  record: {
    id: string;
    brand: string;
    owner_id: string;
    company_id: string | null;
    name: string;
    title: string;
  },
  title: string,
  eventKey: string,
) {
  const routing = (
    await tx.query(
      "SELECT notify_user_ids FROM inbound_routing WHERE brand=$1",
      [record.brand],
    )
  ).rows[0];
  const ids: string[] = routing?.notify_user_ids || [];
  const users = (
    await tx.query(
      `SELECT id FROM users WHERE active AND (id=$1 OR (CASE WHEN cardinality($2::uuid[])>0 THEN id=ANY($2::uuid[]) ELSE role IN ('admin','sales') END))`,
      [record.owner_id, ids],
    )
  ).rows;
  for (const u of users)
    await notify(
      tx,
      u.id,
      record.company_id,
      title,
      `${record.name} · ${record.title}. Open Intake & bookings to review.`,
      `inbound:${eventKey}:${u.id}`,
    );
}
async function event(
  tx: Connection,
  id: string,
  key: string,
  title: string,
  body = "",
  actor: string | null = null,
  at: string | null = null,
) {
  await tx.query(
    `INSERT INTO inbound_events(id,record_id,event_key,title,body,actor_id,occurred_at) VALUES($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz,now())) ON CONFLICT(event_key) DO NOTHING`,
    [randomUUID(), id, key, title, body, actor, at],
  );
}
export async function receiveForm(
  brand: InboundBrand,
  input: z.infer<typeof formInput>,
) {
  if (!input.email && !input.phone)
    throw new HttpError(400, "Provide an email or phone number.");
  if (brand === "unknown") throw new HttpError(400, "Choose a website source.");
  if (input.pageUrl) {
    const url = new URL(input.pageUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      ![`${brand}.com`, `www.${brand}.com`].includes(url.hostname)
    )
      throw new HttpError(400, "Page URL must belong to the source website.");
  }
  return transaction(async (tx) => {
    const provider = `website:${brand}`,
      key = `${provider}:${input.submissionId}`;
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
    const existing = (
      await tx.query(
        "SELECT id FROM inbound_records WHERE provider=$1 AND external_id=$2",
        [provider, input.submissionId],
      )
    ).rows[0];
    if (existing) return { id: existing.id, duplicate: true };
    const match = await matchEmail(tx, input.email);
    const owner = await ownerFor(tx, brand, match.companyId, match.retailerId);
    const id = randomUUID();
    await tx.query(
      `INSERT INTO inbound_records(id,kind,provider,external_id,brand,title,name,email,phone,company_name,company_id,retailer_id,prospect_id,owner_id,match_status,status,details,provider_updated_at) VALUES($1,'form',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'received',$15,$16)`,
      [
        id,
        provider,
        input.submissionId,
        brand,
        input.form,
        input.name,
        input.email,
        input.phone,
        input.company,
        match.companyId,
        match.retailerId,
        match.prospectId,
        owner,
        match.matchStatus,
        JSON.stringify({
          message: input.message,
          pageUrl: input.pageUrl,
          fields: input.fields,
          tracking: input.tracking,
        }),
        input.submittedAt || new Date().toISOString(),
      ],
    );
    await event(
      tx,
      id,
      key,
      `${brandNames[brand]} form received`,
      `${input.form}\n${input.message}`,
      null,
      input.submittedAt || null,
    );
    await alertTeam(
      tx,
      {
        id,
        brand,
        owner_id: owner,
        company_id: match.companyId,
        name: input.name,
        title: input.form,
      },
      `New ${brandNames[brand]} inquiry`,
      key,
    );
    return { id, duplicate: false };
  });
}
export async function websiteWebhook(request: Request, source: string) {
  const brand = brandSchema.exclude(["unknown"]).parse(source);
  const raw = await boundedText(request, 64000);
  verifyInboundSignature(
    raw,
    request.headers.get("X-Linkd-Signature"),
    sourceSecret(brand),
  );
  const result = await receiveForm(brand, formInput.parse(JSON.parse(raw)));
  return Response.json({ ok: true, ...result });
}

const calendlyURI = z
  .string()
  .regex(/^https:\/\/api\.calendly\.com\/scheduled_events\/[a-zA-Z0-9-]+$/);
const inviteeURI = z
  .string()
  .regex(
    /^https:\/\/api\.calendly\.com\/scheduled_events\/[a-zA-Z0-9-]+\/invitees\/[a-zA-Z0-9-]+$/,
  );
const scheduledSchema = z
  .object({
    name: z.string().max(250),
    start_time: stamp,
    end_time: stamp,
    event_type: z.string().max(300).optional(),
    location: z
      .object({ type: text(100), location: text(2000), join_url: optionalUrl })
      .nullish(),
    event_memberships: z
      .array(z.object({ user_name: text(150), user_email: text(254) }))
      .max(50)
      .default([]),
  })
  .refine(
    (e) => Date.parse(e.end_time) > Date.parse(e.start_time),
    "Meeting end must follow start.",
  );
const calendlyInput = z.object({
  event: z.enum(["invitee.created", "invitee.canceled"]),
  created_at: stamp,
  payload: z.object({
    uri: inviteeURI,
    event: calendlyURI,
    email: z.email().transform((s) => s.toLowerCase()),
    name: z.string().max(150),
    updated_at: stamp,
    created_at: stamp.optional(),
    status: z.enum(["active", "canceled"]),
    timezone: text(100),
    cancel_url: optionalUrl,
    reschedule_url: optionalUrl,
    rescheduled: z.boolean().default(false),
    old_invitee: inviteeURI.nullish(),
    new_invitee: inviteeURI.nullish(),
    scheduled_event: scheduledSchema.optional(),
    cancellation: z
      .object({ reason: text(4000), canceled_by: text(200) })
      .nullish(),
    questions_and_answers: z
      .array(
        z.object({
          question: z.string().max(1000),
          answer: z.string().max(8000),
        }),
      )
      .max(50)
      .default([]),
    tracking: z
      .record(z.string().max(100), z.string().max(500).nullable())
      .nullish(),
  }),
});
function safeLink(value: string | undefined, host?: string) {
  try {
    const u = new URL(value || "");
    return u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      (!host || u.hostname === host)
      ? u.href
      : "";
  } catch {
    return "";
  }
}
export async function calendlyWebhook(request: Request) {
  const raw = await boundedText(request, 128000);
  verifyInboundSignature(
    raw,
    request.headers.get("Calendly-Webhook-Signature"),
    process.env.CALENDLY_SIGNING_KEY,
  );
  const rawBody = JSON.parse(raw);
  if (!["invitee.created", "invitee.canceled"].includes(rawBody.event))
    return Response.json({ ok: true, ignored: true });
  const input = calendlyInput.parse(rawBody),
    p = input.payload;
  if (!p.scheduled_event) {
    if (!process.env.CALENDLY_ACCESS_TOKEN)
      throw new HttpError(
        503,
        "Calendly event details require an access token.",
      );
    const response = await fetch(p.event, {
      headers: { Authorization: `Bearer ${process.env.CALENDLY_ACCESS_TOKEN}` },
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok)
      throw new HttpError(
        503,
        "Calendly event details could not be loaded; retry this delivery.",
      );
    p.scheduled_event = scheduledSchema.parse((await response.json()).resource);
  }
  const scheduled = p.scheduled_event;
  const result = await transaction(async (tx) => {
    // Serialize a short transaction so reschedule pairs arriving concurrently retain their links.
    await tx.query("SELECT pg_advisory_xact_lock(17304569)");
    const existing = (
      await tx.query(
        "SELECT * FROM inbound_records WHERE provider='calendly' AND external_id=$1 FOR UPDATE",
        [p.uri],
      )
    ).rows[0];
    const canceled =
      input.event === "invitee.canceled" || p.status === "canceled";
    const terminal =
      existing && ["canceled", "rescheduled"].includes(existing.status);
    if (
      existing &&
      ((terminal && !canceled) ||
        (Date.parse(existing.provider_updated_at) >= Date.parse(p.updated_at) &&
          !(canceled && !terminal)))
    )
      return { id: existing.id, duplicate: true };
    const key = `calendly:${p.uri}:${input.event}:${p.updated_at}`;
    const prior = (
      await tx.query("SELECT 1 FROM inbound_events WHERE event_key=$1", [key])
    ).rowCount;
    if (prior) return { id: existing?.id, duplicate: true };
    const routes = (await tx.query("SELECT * FROM inbound_routing")).rows;
    const mapped = routes.filter((r) =>
      r.event_type_uris.includes(scheduled.event_type),
    );
    const source = (p.tracking?.utm_source || "")
      .toLowerCase()
      .replace(/^www\./, "")
      .replace(/\.com$/, "");
    const priorBooking = p.old_invitee
      ? (
          await tx.query(
            `SELECT * FROM inbound_records WHERE provider='calendly' AND external_id=$1`,
            [p.old_invitee],
          )
        ).rows[0]
      : null;
    const brand: InboundBrand =
      existing?.brand ||
      (mapped.length === 1
        ? mapped[0].brand
        : inboundBrands.includes(source as InboundBrand)
          ? source
          : priorBooking?.brand || "unknown");
    const match = await matchEmail(tx, p.email);
    const inherited = priorBooking?.email === p.email ? priorBooking : null;
    const company =
      existing?.company_id || inherited?.company_id || match.companyId;
    const retailer =
      existing?.retailer_id || inherited?.retailer_id || match.retailerId;
    const prospect =
      existing?.prospect_id || inherited?.prospect_id || match.prospectId;
    const owner =
      existing?.owner_id ||
      inherited?.owner_id ||
      (await ownerFor(tx, brand, company, retailer));
    const id = existing?.id || randomUUID();
    const status = canceled
      ? p.rescheduled
        ? "rescheduled"
        : "canceled"
      : "scheduled";
    const details = {
      questions: p.questions_and_answers,
      tracking: p.tracking || {},
      location: scheduled.location?.location || scheduled.location?.type || "",
      joinUrl: safeLink(scheduled.location?.join_url),
      host: scheduled.event_memberships
        .map((m) => m.user_name || m.user_email)
        .join(", "),
      cancelUrl: safeLink(p.cancel_url, "calendly.com"),
      rescheduleUrl: safeLink(p.reschedule_url, "calendly.com"),
      oldInvitee: p.old_invitee || existing?.details.oldInvitee || null,
      newInvitee: p.new_invitee || existing?.details.newInvitee || null,
      cancellation: p.cancellation || null,
      eventType: scheduled.event_type || "",
    };
    await tx.query(
      `INSERT INTO inbound_records(id,kind,provider,external_id,brand,title,name,email,company_id,retailer_id,prospect_id,owner_id,match_status,status,starts_at,ends_at,timezone,details,provider_updated_at)
      VALUES($1,'booking','calendly',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      ON CONFLICT(provider,external_id) DO UPDATE SET status=EXCLUDED.status,details=EXCLUDED.details,starts_at=EXCLUDED.starts_at,ends_at=EXCLUDED.ends_at,title=EXCLUDED.title,provider_updated_at=EXCLUDED.provider_updated_at,review_status='new',updated_at=now(),version=inbound_records.version+1`,
      [
        id,
        p.uri,
        brand,
        scheduled.name,
        p.name,
        p.email,
        company,
        retailer,
        prospect,
        owner,
        existing?.match_status || inherited?.match_status || match.matchStatus,
        status,
        scheduled.start_time,
        scheduled.end_time,
        p.timezone,
        JSON.stringify(details),
        p.updated_at,
      ],
    );
    // The new booking may arrive before the old cancellation. Mark the old record
    // superseded immediately; a delayed created event can never revive it.
    if (p.old_invitee)
      await tx.query(
        `UPDATE inbound_records SET status='rescheduled',details=jsonb_set(details,'{newInvitee}',to_jsonb($2::text)),updated_at=now(),version=version+1 WHERE provider='calendly' AND external_id=$1 AND status='scheduled'`,
        [p.old_invitee, p.uri],
      );
    const newer = (
      await tx.query(
        `SELECT external_id FROM inbound_records WHERE provider='calendly' AND details->>'oldInvitee'=$1 LIMIT 1`,
        [p.uri],
      )
    ).rows[0];
    if (newer)
      await tx.query(
        `UPDATE inbound_records SET status='rescheduled',details=jsonb_set(details,'{newInvitee}',to_jsonb($2::text)) WHERE id=$1`,
        [id, newer.external_id],
      );
    const title = `Meeting ${newer ? "rescheduled" : status}`;
    await event(
      tx,
      id,
      key,
      title,
      `${scheduled.name} · ${scheduled.start_time}${p.cancellation?.reason ? "\n" + p.cancellation.reason : ""}`,
      null,
      input.created_at,
    );
    await alertTeam(
      tx,
      {
        id,
        brand,
        owner_id: owner,
        company_id: company,
        name: p.name,
        title: scheduled.name,
      },
      title,
      key,
    );
    return { id, duplicate: false };
  });
  return Response.json({ ok: true, ...result });
}

const recordView = `SELECT i.*,COALESCE(i.company_id,p.company_id,r.company_id,rp.company_id) linked_company_id,
 c.name linked_company_name,r.name retailer_name,u.name owner_name FROM inbound_records i
 LEFT JOIN prospects p ON p.id=i.prospect_id LEFT JOIN retailers r ON r.id=i.retailer_id LEFT JOIN prospects rp ON rp.id=r.prospect_id
 LEFT JOIN companies c ON c.id=COALESCE(i.company_id,p.company_id,r.company_id,rp.company_id) JOIN users u ON u.id=i.owner_id`;
export async function inboundList(params: URLSearchParams) {
  const filter = z
    .object({
      brand: z.union([brandSchema, z.literal("")]).default(""),
      kind: z.enum(["", "form", "booking"]).default(""),
      q: text(200),
      filter: z
        .enum(["", "review", "unlinked", "upcoming", "archived", "history"])
        .default(""),
      companyId: z.uuid().optional(),
      retailerId: z.uuid().optional(),
      offset: z.coerce.number().int().min(0).max(100000).default(0),
    })
    .parse(Object.fromEntries(params));
  const conditions = `WHERE ($1='' OR i.brand=$1) AND ($2='' OR i.kind=$2) AND ($3='' OR concat_ws(' ',i.name,i.email,i.company_name,i.title,c.name,r.name) ILIKE '%'||$3||'%')
   AND (CASE WHEN $4='archived' THEN i.review_status='archived' WHEN $4='history' THEN true ELSE i.review_status<>'archived' END)
   AND ($4<>'review' OR i.review_status='new') AND ($4<>'unlinked' OR (COALESCE(i.company_id,p.company_id,r.company_id,rp.company_id) IS NULL AND i.retailer_id IS NULL AND i.prospect_id IS NULL))
   AND ($4<>'upcoming' OR (i.kind='booking' AND i.status='scheduled' AND i.ends_at>now()))
   AND ($5::uuid IS NULL OR COALESCE(i.company_id,p.company_id,r.company_id,rp.company_id)=$5) AND ($6::uuid IS NULL OR i.retailer_id=$6 OR COALESCE(i.company_id,p.company_id,r.company_id,rp.company_id)=(SELECT COALESCE(rr.company_id,pp.company_id) FROM retailers rr LEFT JOIN prospects pp ON pp.id=rr.prospect_id WHERE rr.id=$6))`;
  const args = [
    filter.brand,
    filter.kind,
    filter.q,
    filter.filter,
    filter.companyId || null,
    filter.retailerId || null,
  ];
  const records = await db.query(
    `${recordView} ${conditions} ORDER BY CASE WHEN $4='upcoming' THEN i.starts_at END ASC,i.created_at DESC,i.id LIMIT 50 OFFSET $7`,
    [...args, filter.offset],
  );
  const count = await db.query(
    `SELECT count(*)::int total FROM (${recordView} ${conditions}) t`,
    args,
  );
  return { records: records.rows, total: count.rows[0].total };
}
export async function inboundDashboard(params: URLSearchParams) {
  const [list, stats, routing, accounts, calendly] = await Promise.all([
    inboundList(params),
    db.query(`SELECT count(*) FILTER(WHERE kind='form')::int forms,count(*) FILTER(WHERE kind='booking' AND status='scheduled' AND ends_at>now())::int upcoming,
      count(*) FILTER(WHERE review_status='new')::int needs_review,count(*) FILTER(WHERE match_status IN ('unmatched','ambiguous'))::int unlinked FROM inbound_records WHERE review_status<>'archived'`),
    db.query(
      `SELECT r.*,count(i.id)::int received,max(i.created_at) last_received FROM inbound_routing r LEFT JOIN inbound_records i ON i.brand=r.brand AND i.kind='form' GROUP BY r.brand ORDER BY r.brand`,
    ),
    db.query("SELECT id,name,city FROM companies ORDER BY name"),
    db.query(
      `SELECT count(*)::int count,max(occurred_at) last_received FROM inbound_events WHERE event_key LIKE 'calendly:%'`,
    ),
  ]);
  return {
    ...list,
    stats: stats.rows[0],
    routing: routing.rows.map((r) => ({
      ...r,
      configured: (sourceSecret(r.brand)?.length || 0) >= 24,
    })),
    accounts: accounts.rows,
    calendly: {
      configured: (process.env.CALENDLY_SIGNING_KEY?.length || 0) >= 24,
      verifiedEvents: calendly.rows[0].count,
      lastReceived: calendly.rows[0].last_received,
    },
  };
}
export async function inboundDetail(id: string) {
  const record = (await db.query(recordView + " WHERE i.id=$1", [id])).rows[0];
  if (!record) throw new HttpError(404, "Inquiry or booking not found.");
  const events = (
    await db.query(
      "SELECT e.*,u.name actor FROM inbound_events e LEFT JOIN users u ON u.id=e.actor_id WHERE record_id=$1 ORDER BY occurred_at DESC,id",
      [id],
    )
  ).rows;
  const related = (
    await db.query(
      `SELECT id,title,status,starts_at FROM inbound_records WHERE provider='calendly' AND external_id=ANY($1::text[])`,
      [[record.details.oldInvitee, record.details.newInvitee].filter(Boolean)],
    )
  ).rows;
  return { record, events, related };
}
export async function updateInbound(body: unknown, user: User) {
  const input = z
    .object({
      id: z.uuid(),
      version: z.number().int(),
      ownerId: z.uuid(),
      companyId: z.uuid().nullable(),
      retailerId: z.uuid().nullable(),
      brand: brandSchema,
      reviewStatus: z.enum(["new", "reviewed", "archived"]),
      outcome: z.enum(["", "completed", "no_show", "follow_up"]),
      notes: text(10000),
    })
    .parse(body);
  await transaction(async (tx) => {
    const old = (
      await tx.query("SELECT * FROM inbound_records WHERE id=$1 FOR UPDATE", [
        input.id,
      ])
    ).rows[0];
    if (!old) throw new HttpError(404, "Record not found.");
    if (old.version !== input.version)
      throw new HttpError(409, "This record changed. Refresh before saving.");
    await assertOwner(tx, input.ownerId);
    if (
      input.companyId &&
      !(
        await tx.query("SELECT 1 FROM companies WHERE id=$1", [input.companyId])
      ).rowCount
    )
      throw new HttpError(404, "Account not found.");
    const retailer = input.retailerId
      ? (
          await tx.query(
            "SELECT r.id,COALESCE(r.company_id,p.company_id) company_id FROM retailers r LEFT JOIN prospects p ON p.id=r.prospect_id WHERE r.id=$1",
            [input.retailerId],
          )
        ).rows[0]
      : null;
    if (input.retailerId && !retailer)
      throw new HttpError(404, "Retailer not found.");
    if (
      retailer?.company_id &&
      input.companyId &&
      retailer.company_id !== input.companyId
    )
      throw new HttpError(409, "This retailer belongs to a different account.");
    const changedLinks =
      old.company_id !== input.companyId ||
      old.retailer_id !== input.retailerId;
    await tx.query(
      `UPDATE inbound_records SET company_id=$2,retailer_id=$3,owner_id=$4,brand=$5,review_status=$6,outcome=$7,notes=$8,
      prospect_id=CASE WHEN $9 THEN NULL ELSE prospect_id END,match_status=CASE WHEN $9 THEN CASE WHEN $2::uuid IS NOT NULL OR $3::uuid IS NOT NULL THEN 'manual' ELSE 'unmatched' END ELSE match_status END,
      version=version+1,updated_at=now() WHERE id=$1`,
      [
        input.id,
        input.companyId,
        input.retailerId,
        input.ownerId,
        input.brand,
        input.reviewStatus,
        input.outcome,
        input.notes,
        changedLinks,
      ],
    );
    await event(
      tx,
      input.id,
      `edit:${randomUUID()}`,
      "Team review updated",
      `Review: ${input.reviewStatus}. Outcome: ${input.outcome || "not recorded"}.${changedLinks ? " Account/store links changed." : ""}\n${input.notes}`,
      user.id,
    );
    if (old.owner_id !== input.ownerId)
      await notify(
        tx,
        input.ownerId,
        input.companyId,
        "Inquiry or booking assigned",
        `${old.name} · ${old.title}`,
        `inbound-assigned:${input.id}:${input.version}`,
      );
  });
}
export async function inboundToProspect(id: string, user: User) {
  return transaction(async (tx) => {
    const r = (
      await tx.query("SELECT * FROM inbound_records WHERE id=$1 FOR UPDATE", [
        id,
      ])
    ).rows[0];
    if (!r) throw new HttpError(404, "Record not found.");
    if (r.prospect_id) return { id: r.prospect_id };
    const company = r.company_id
      ? (
          await tx.query("SELECT do_not_contact FROM companies WHERE id=$1", [
            r.company_id,
          ])
        ).rows[0]
      : null;
    const retailer = r.retailer_id
      ? (
          await tx.query(
            "SELECT prospect_id,outreach_status FROM retailers WHERE id=$1",
            [r.retailer_id],
          )
        ).rows[0]
      : null;
    if (
      company?.do_not_contact ||
      retailer?.outreach_status === "do_not_contact"
    )
      throw new HttpError(
        409,
        "This account or retailer is marked do not contact.",
      );
    if (r.match_status === "ambiguous")
      throw new HttpError(
        409,
        "Resolve the account or retailer match before creating a prospect.",
      );
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `inbound-prospect:${r.email}`,
    ]);
    const matches = (
      await tx.query(
        `SELECT id,company_id FROM prospects WHERE $1<>'' AND lower(email)=$1 AND status IN ('research','review','approved')`,
        [r.email],
      )
    ).rows;
    if (matches.length > 1)
      throw new HttpError(
        409,
        "Multiple prospects use this email. Reconcile them in Research first.",
      );
    if (
      matches[0]?.company_id &&
      r.company_id &&
      matches[0].company_id !== r.company_id
    )
      throw new HttpError(
        409,
        "The existing prospect belongs to another account. Reconcile it in Research first.",
      );
    let prospectId = retailer?.prospect_id || matches[0]?.id;
    if (!prospectId) {
      prospectId = randomUUID();
      await tx.query(
        `INSERT INTO prospects(id,request_key,name,contact_name,email,phone,source,notes,status,owner_id,company_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'review',$9,$10)`,
        [
          prospectId,
          randomUUID(),
          r.company_name || r.name,
          r.name,
          r.email,
          r.phone,
          `${brandNames[r.brand as InboundBrand]} ${r.kind}`,
          r.details.message || r.title,
          r.owner_id,
          r.company_id,
        ],
      );
      if (r.retailer_id)
        await tx.query(
          "UPDATE retailers SET prospect_id=$2,version=version+1 WHERE id=$1 AND prospect_id IS NULL",
          [r.retailer_id, prospectId],
        );
    }
    await tx.query(
      `UPDATE inbound_records SET prospect_id=$2,review_status='reviewed',match_status=CASE WHEN match_status='unmatched' THEN 'manual' ELSE match_status END,version=version+1,updated_at=now() WHERE id=$1`,
      [id, prospectId],
    );
    await event(
      tx,
      id,
      `prospect:${id}`,
      "Sent to Research",
      "Review and qualify this prospect before starting outreach.",
      user.id,
    );
    return { id: prospectId };
  });
}
const bookingUrl = z.union([
  z.literal(""),
  z.url().refine((v) => {
    const u = new URL(v);
    return (
      u.protocol === "https:" &&
      u.hostname === "calendly.com" &&
      !u.username &&
      !u.password
    );
  }, "Use an HTTPS calendly.com booking link."),
]);
export async function saveRouting(body: unknown) {
  const input = z
    .object({
      brand: brandSchema,
      ownerId: z.uuid().nullable(),
      notifyUserIds: z.array(z.uuid()).max(100),
      bookingUrl,
      eventTypeUris: z
        .array(
          z
            .string()
            .regex(
              /^https:\/\/api\.calendly\.com\/event_types\/[a-zA-Z0-9-]+$/,
            ),
        )
        .max(50),
      version: z.number().int(),
    })
    .parse(body);
  await transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(17304570)");
    for (const id of new Set(
      [input.ownerId, ...input.notifyUserIds].filter(Boolean) as string[],
    ))
      await assertOwner(tx, id);
    if (
      (
        await tx.query(
          "SELECT 1 FROM inbound_routing WHERE brand<>$1 AND event_type_uris && $2::text[]",
          [input.brand, input.eventTypeUris],
        )
      ).rowCount
    )
      throw new HttpError(
        409,
        "An event type is already assigned to another brand.",
      );
    const saved = await tx.query(
      `UPDATE inbound_routing SET owner_id=$2,notify_user_ids=$3,booking_url=$4,event_type_uris=$5,version=version+1 WHERE brand=$1 AND version=$6`,
      [
        input.brand,
        input.ownerId,
        input.notifyUserIds,
        input.bookingUrl,
        input.eventTypeUris,
        input.version,
      ],
    );
    if (!saved.rowCount)
      throw new HttpError(409, "Routing changed. Refresh before saving.");
  });
}
export async function manualBooking(body: unknown, user: User) {
  const input = z
    .object({
      requestKey: z.uuid(),
      brand: brandSchema,
      title: z.string().trim().min(2).max(250),
      name: z.string().trim().min(1).max(150),
      email: z.email().transform((v) => v.toLowerCase()),
      companyId: z.uuid().nullable(),
      retailerId: z.uuid().nullable(),
      ownerId: z.uuid(),
      startsAt: stamp,
      endsAt: stamp,
      location: text(2000),
      notes: text(10000),
    })
    .refine(
      (v) => Date.parse(v.endsAt) > Date.parse(v.startsAt),
      "End must follow start.",
    )
    .parse(body);
  return transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      input.requestKey,
    ]);
    const old = (
      await tx.query(
        `SELECT id FROM inbound_records WHERE provider='manual' AND external_id=$1`,
        [input.requestKey],
      )
    ).rows[0];
    if (old) return { id: old.id };
    await assertOwner(tx, input.ownerId);
    if (
      input.companyId &&
      !(
        await tx.query("SELECT 1 FROM companies WHERE id=$1", [input.companyId])
      ).rowCount
    )
      throw new HttpError(404, "Account not found.");
    const r = input.retailerId
      ? (
          await tx.query(
            "SELECT r.id,COALESCE(r.company_id,p.company_id) company_id FROM retailers r LEFT JOIN prospects p ON p.id=r.prospect_id WHERE r.id=$1",
            [input.retailerId],
          )
        ).rows[0]
      : null;
    if (input.retailerId && !r) throw new HttpError(404, "Retailer not found.");
    if (r?.company_id && input.companyId && r.company_id !== input.companyId)
      throw new HttpError(409, "Retailer belongs to a different account.");
    const match = await matchEmail(tx, input.email),
      explicit = Boolean(input.companyId || input.retailerId);
    const companyId = explicit
      ? input.companyId || r?.company_id || null
      : match.companyId;
    const retailerId = explicit ? input.retailerId : match.retailerId;
    const id = randomUUID();
    await tx.query(
      `INSERT INTO inbound_records(id,kind,provider,external_id,brand,title,name,email,company_id,retailer_id,prospect_id,owner_id,match_status,status,starts_at,ends_at,details,notes,provider_updated_at) VALUES($1,'booking','manual',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'scheduled',$12,$13,$14,$15,now())`,
      [
        id,
        input.requestKey,
        input.brand,
        input.title,
        input.name,
        input.email,
        companyId,
        retailerId,
        explicit ? null : match.prospectId,
        input.ownerId,
        explicit ? "manual" : match.matchStatus,
        input.startsAt,
        input.endsAt,
        JSON.stringify({ location: input.location }),
        input.notes,
      ],
    );
    await event(
      tx,
      id,
      `manual:${input.requestKey}`,
      "Meeting recorded",
      `${input.title} · ${input.startsAt}`,
      user.id,
    );
    await alertTeam(
      tx,
      {
        id,
        brand: input.brand,
        owner_id: input.ownerId,
        company_id: companyId,
        name: input.name,
        title: input.title,
      },
      "Meeting recorded",
      input.requestKey,
    );
    return { id };
  });
}
export async function inboundRoute(
  path: string,
  request: Request,
  body: unknown,
  user: User,
): Promise<Response | null> {
  if (!path.startsWith("inbound")) return null;
  const params = new URL(request.url).searchParams;
  const json = (v: unknown) =>
    Response.json(v, { headers: { "Cache-Control": "private,no-store" } });
  if (request.method === "GET") {
    if (path === "inbound") return json(await inboundDashboard(params));
    if (path === "inbound/history") {
      if (!params.get("companyId") && !params.get("retailerId"))
        throw new HttpError(400, "Choose an account or retailer.");
      params.set("filter", "history");
      return json(await inboundList(params));
    }
    if (path === "inbound/detail")
      return json(await inboundDetail(z.uuid().parse(params.get("id"))));
    if (path === "inbound/retailers")
      return json(
        (
          await db.query(
            `SELECT id,name,city,state FROM retailers WHERE name ILIKE '%'||$1||'%' ORDER BY name,city LIMIT 40`,
            [
              z
                .string()
                .max(200)
                .parse(params.get("q") || ""),
            ],
          )
        ).rows,
      );
    return null;
  }
  requireRole(user, ["admin", "sales"]);
  if (path === "inbound/update") await updateInbound(body, user);
  else if (path === "inbound/prospect")
    return json(
      await inboundToProspect(z.object({ id: z.uuid() }).parse(body).id, user),
    );
  else if (path === "inbound/manual")
    return json(await manualBooking(body, user));
  else if (path === "inbound/routing") {
    requireRole(user, ["admin"]);
    await saveRouting(body);
  } else if (path === "inbound/cancel") {
    const input = z
      .object({
        id: z.uuid(),
        version: z.number().int(),
        reason: z.string().trim().min(3).max(4000),
      })
      .parse(body);
    await transaction(async (tx) => {
      const r = (
        await tx.query(
          `UPDATE inbound_records SET status='canceled',version=version+1,updated_at=now() WHERE id=$1 AND version=$2 AND provider='manual' AND status='scheduled' RETURNING *`,
          [input.id, input.version],
        )
      ).rows[0];
      if (!r)
        throw new HttpError(
          409,
          "Only a current manual booking can be canceled here. Manage Calendly bookings through Calendly.",
        );
      await event(
        tx,
        r.id,
        `cancel:${r.id}`,
        "Meeting canceled",
        input.reason,
        user.id,
      );
      await alertTeam(tx, r, "Meeting canceled", `cancel:${r.id}`);
    });
  } else return null;
  return json({ ok: true });
}
