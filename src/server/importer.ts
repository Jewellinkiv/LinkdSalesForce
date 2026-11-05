import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, transaction, type Connection } from "./db";
import { HttpError } from "./auth";
import { activity } from "./domain";
import { packages, stages, type User } from "../lib/types";
const rowSchema = z.object({
  externalId: z.string().trim().min(1).max(100),
  name: z.string().trim().min(2).max(150),
  contactName: z.string().trim().min(2).max(150),
  email: z.union([z.email(), z.literal("")]),
  phone: z.string().regex(/^$|^\+[1-9]\d{7,14}$/),
  ownerEmail: z.email(),
  city: z.string().max(150).default(""),
  pos: z.string().max(100).default(""),
  locations: z.number().int().min(1).max(1000).default(1),
  source: z.string().max(100).default("Monday import"),
  lifecycle: z
    .enum(["prospect", "onboarding", "active", "paused", "churned"])
    .default("prospect"),
  kind: z.enum(["lead", "deal"]).default("lead"),
  stage: z.enum(stages).default("New lead"),
  package: z.enum(packages).default("Undecided"),
  mrr: z.number().min(0).max(1000000).default(0),
  currentMrr: z.number().min(0).max(1000000).nullable().default(null),
  setup: z.number().min(0).max(1000000).default(0),
  discount: z.number().min(0).max(1000000).default(0),
  effectiveDate: z.iso.date().optional(),
  closedAt: z.iso.datetime().optional(),
  nextAction: z.string().max(300).default(""),
  nextActionAt: z.iso.datetime().optional(),
  notes: z.string().max(20000).default(""),
  doNotContact: z.boolean().default(false),
  smsConsent: z.boolean().default(false),
  emailConsent: z.boolean().default(false),
  smsOptedOut: z.boolean().default(false),
  emailSuppressed: z.boolean().default(false),
  consentSource: z.string().max(500).default(""),
});
export const importSchema = z.object({
  source: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  rows: z.array(rowSchema).min(1).max(1000),
});
type Batch = z.infer<typeof importSchema>;
async function inspect(tx: Connection, batch: Batch) {
  const results: {
    externalId: string;
    name: string;
    action: "create" | "skip" | "review";
    issues: string[];
  }[] = [];
  const seenId = new Set<string>(),
    seenName = new Set<string>(),
    seenEmail = new Set<string>(),
    seenPhone = new Set<string>();
  for (const row of batch.rows) {
    const issues: string[] = [];
    const name = row.name.trim().toLowerCase(),
      email = row.email.toLowerCase();
    if (seenId.has(row.externalId))
      issues.push("Duplicate source ID in this batch.");
    seenId.add(row.externalId);
    const mapped = (
      await tx.query(
        "SELECT company_id FROM external_records WHERE source=$1 AND external_id=$2",
        [batch.source, row.externalId],
      )
    ).rows[0];
    if (mapped) {
      results.push({
        externalId: row.externalId,
        name: row.name,
        action: issues.length ? "review" : "skip",
        issues,
      });
      continue;
    }
    if (seenName.has(name))
      issues.push("Multiple rows for one company need relationship mapping.");
    seenName.add(name);
    if (email && seenEmail.has(email))
      issues.push("Repeated contact email needs review.");
    if (email) seenEmail.add(email);
    if (row.phone && seenPhone.has(row.phone))
      issues.push("Shared phone number needs review.");
    if (row.phone) seenPhone.add(row.phone);
    if (
      !(
        await tx.query(
          "SELECT id FROM users WHERE lower(email)=$1 AND active=true",
          [row.ownerEmail.toLowerCase()],
        )
      ).rowCount
    )
      issues.push("Owner email does not match an active teammate.");
    if (
      (
        await tx.query("SELECT id FROM companies WHERE lower(trim(name))=$1", [
          name,
        ])
      ).rowCount
    )
      issues.push("Company name already exists; reconcile before importing.");
    if (
      (
        await tx.query(
          "SELECT id FROM contacts WHERE (email<>'' AND lower(email)=$1) OR (phone<>'' AND phone=$2)",
          [email, row.phone],
        )
      ).rowCount
    )
      issues.push(
        "Contact destination already exists; review account linkage.",
      );
    if ((row.smsConsent || row.emailConsent) && !row.consentSource.trim())
      issues.push("Permission requires its recorded source.");
    if (
      row.kind === "lead" &&
      !["New lead", "Contacted", "Lost", "Be back"].includes(row.stage)
    )
      issues.push(
        "Map qualified deal rows separately; this stage is not an open lead stage.",
      );
    if (
      row.kind === "deal" &&
      ["New lead", "Contacted", "Qualified"].includes(row.stage)
    )
      issues.push("Map the deal to a deal stage.");
    if (["Won", "Lost"].includes(row.stage) && !row.closedAt)
      issues.push("Closed records require their original close date.");
    if (
      !["Won", "Lost", "Qualified"].includes(row.stage) &&
      (!row.nextAction || !row.nextActionAt)
    )
      issues.push("An open record requires its next action and due date.");
    results.push({
      externalId: row.externalId,
      name: row.name,
      action: issues.length ? "review" : "create",
      issues,
    });
  }
  return {
    source: batch.source,
    create: results.filter((r) => r.action === "create").length,
    skip: results.filter((r) => r.action === "skip").length,
    review: results.filter((r) => r.action === "review").length,
    rows: results,
  };
}
export async function previewImport(input: unknown) {
  return inspect(db, importSchema.parse(input));
}
export async function applyImport(input: unknown, user: User) {
  const batch = importSchema.parse(input);
  return transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(17304568)");
    const preview = await inspect(tx, batch);
    if (preview.review)
      throw new HttpError(
        409,
        "Resolve every review item in the dry run before applying this batch.",
      );
    for (const row of batch.rows) {
      if (
        preview.rows.find((r) => r.externalId === row.externalId)?.action ===
        "skip"
      )
        continue;
      const owner = (
        await tx.query("SELECT id FROM users WHERE lower(email)=$1", [
          row.ownerEmail.toLowerCase(),
        ])
      ).rows[0].id;
      const company = randomUUID(),
        contact = randomUUID(),
        opportunity = randomUUID();
      await tx.query(
        "INSERT INTO companies(id,name,city,pos,locations,owner_id,source,lifecycle,do_not_contact,restriction_reason,current_mrr_cents) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [
          company,
          row.name,
          row.city,
          row.pos,
          row.locations,
          owner,
          row.source,
          row.lifecycle,
          row.doNotContact,
          row.doNotContact ? "Imported do-not-contact restriction" : "",
          row.currentMrr === null ? null : Math.round(row.currentMrr * 100),
        ],
      );
      await tx.query(
        "INSERT INTO contacts(id,company_id,name,email,phone,sms_consent,email_consent,sms_opted_out,email_suppressed,consent_source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          contact,
          company,
          row.contactName,
          row.email.toLowerCase(),
          row.phone,
          row.smsConsent,
          row.emailConsent,
          row.smsOptedOut,
          row.emailSuppressed,
          row.consentSource,
        ],
      );
      await tx.query(
        "INSERT INTO opportunities(id,company_id,contact_id,owner_id,kind,stage,package,mrr_cents,setup_cents,discount_cents,effective_date,closed_at,won_at,next_action,next_action_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,CASE WHEN $6='Won' THEN $12::timestamptz ELSE NULL END,$13,$14)",
        [
          opportunity,
          company,
          contact,
          owner,
          row.kind,
          row.stage,
          row.package,
          Math.round(row.mrr * 100),
          Math.round(row.setup * 100),
          Math.round(row.discount * 100),
          row.effectiveDate || null,
          row.closedAt || null,
          row.nextAction,
          row.nextActionAt || null,
        ],
      );
      if (row.nextActionAt && !["Won", "Lost"].includes(row.stage))
        await tx.query(
          "INSERT INTO tasks(id,company_id,opportunity_id,owner_id,title,due_at,is_next_action) VALUES ($1,$2,$3,$4,$5,$6,true)",
          [
            randomUUID(),
            company,
            opportunity,
            owner,
            row.nextAction,
            row.nextActionAt,
          ],
        );
      await tx.query(
        "INSERT INTO external_records(source,external_id,company_id) VALUES ($1,$2,$3)",
        [batch.source, row.externalId, company],
      );
      await activity(
        tx,
        company,
        user.id,
        "import",
        "Historical record imported",
        `${batch.source} / ${row.externalId}. No communication or handoff automation was triggered.`,
      );
      if (row.notes)
        await activity(
          tx,
          company,
          user.id,
          "note",
          "Imported notes",
          row.notes,
        );
    }
    const id = randomUUID();
    await tx.query(
      "INSERT INTO import_runs(id,source,summary) VALUES ($1,$2,$3)",
      [
        id,
        batch.source,
        JSON.stringify({ created: preview.create, skipped: preview.skip }),
      ],
    );
    return { ...preview, runId: id };
  });
}
