import { randomUUID } from "node:crypto";
import { z } from "zod";
import { phases } from "../lib/types";
import type { Connection } from "./db";
import { fileMimes, validateFile } from "./file-validation";
export const profileSchema = z
  .record(z.string().max(100), z.string().max(10000))
  .refine((v) => Object.keys(v).length <= 100);
const taskSchema = z
  .object({
    title: z.string().min(1).max(300),
    ownerEmail: z.email(),
    phase: z.enum(phases).optional(),
    dueAt: z.iso.datetime(),
    completedAt: z.iso.datetime().optional(),
    resolution: z
      .enum(["open", "completed", "cancelled", "superseded"])
      .default("open"),
    inProgress: z.boolean().default(false),
  })
  .refine(
    (t) => t.resolution !== "completed" || !!t.completedAt,
    "Completed tasks need their original completion date.",
  );
export const historyShape = {
  companyId: z.uuid().optional(),
  contactId: z.uuid().optional(),
  accountProfile: profileSchema.default({}),
  contactProfile: profileSchema.default({}),
  sourceFields: profileSchema.default({}),
  project: z
    .object({
      phase: z.enum(phases),
      package: z.string().min(1).max(100),
      source: z.enum(["new_sale", "existing_customer"]),
      technicalOwnerEmail: z.email(),
      csOwnerEmail: z.email(),
      salesOwnerEmail: z.email(),
      startedAt: z.iso.datetime(),
      phaseStartedAt: z.iso.datetime(),
      targetAt: z.iso.datetime(),
      completedAt: z.iso.datetime().optional(),
      intakeReceivedAt: z.iso.datetime().optional(),
      billingAt: z.iso.date().optional(),
      goLiveAt: z.iso.date().optional(),
      blocker: z.string().max(2000).default(""),
      readiness: z
        .record(
          z.string(),
          z.object({
            status: z.enum([
              "not_started",
              "in_progress",
              "verified",
              "not_applicable",
            ]),
            notes: z.string().max(5000),
          }),
        )
        .default({}),
      scope: profileSchema.default({}),
      tasks: z.array(taskSchema).max(500),
    })
    .refine(
      (p) => p.phase !== "Onboarded" || !!p.completedAt,
      "Completed projects need their original completion date.",
    )
    .refine(
      (p) => new Date(p.phaseStartedAt) >= new Date(p.startedAt),
      "Phase cannot start before the project.",
    )
    .optional(),
  tasks: z.array(taskSchema).max(500).default([]),
  history: z
    .array(
      z.object({
        kind: z.string().max(50),
        title: z.string().max(300),
        body: z.string().max(50000),
        createdAt: z.iso.datetime(),
      }),
    )
    .max(2000)
    .default([]),
  messages: z
    .array(
      z.object({
        channel: z.enum(["email", "sms"]),
        direction: z.enum(["inbound", "outbound"]),
        subject: z.string().max(200).default(""),
        body: z.string().max(100000),
        recipient: z.string().max(500),
        status: z.enum([
          "received",
          "sent",
          "delivered",
          "bounced",
          "suppressed",
          "cancelled",
          "failed",
        ]),
        createdAt: z.iso.datetime(),
      }),
    )
    .max(2000)
    .default([]),
  files: z
    .array(
      z.object({
        name: z.string().max(160),
        mime: z.enum(fileMimes),
        data: z.string().max(2800000),
        createdAt: z.iso.datetime(),
      }),
    )
    .max(100)
    .default([]),
};
export const historySchema = z.object(historyShape);
export type ImportHistory = z.infer<typeof historySchema>;
export async function inspectHistory(tx: Connection, row: ImportHistory) {
  const issues: string[] = [];
  const emails = new Set([
    ...row.tasks.map((t) => t.ownerEmail),
    ...(row.project
      ? [
          row.project.technicalOwnerEmail,
          row.project.csOwnerEmail,
          row.project.salesOwnerEmail,
          ...row.project.tasks.map((t) => t.ownerEmail),
        ]
      : []),
  ]);
  for (const email of emails)
    if (
      !(
        await tx.query(
          "SELECT id FROM users WHERE lower(email)=lower($1) AND active=true",
          [email],
        )
      ).rowCount
    )
      issues.push(`Historical work owner is not active: ${email}`);
  for (const f of row.files)
    try {
      validateFile(f);
    } catch (e) {
      issues.push(`Attachment ${f.name}: ${(e as Error).message}`);
    }
  if (row.companyId) {
    if (
      !(await tx.query("SELECT id FROM companies WHERE id=$1", [row.companyId]))
        .rowCount
    )
      issues.push("Selected existing account does not exist.");
    if (
      row.project &&
      (
        await tx.query(
          "SELECT id FROM onboarding WHERE company_id=$1 AND phase<>'Onboarded'",
          [row.companyId],
        )
      ).rowCount
    )
      issues.push(
        "Existing account has an active project; reconcile before importing another.",
      );
  }
  if (row.contactId) {
    if (
      !row.companyId ||
      !(
        await tx.query(
          "SELECT 1 FROM company_contacts WHERE company_id=$1 AND contact_id=$2",
          [row.companyId, row.contactId],
        )
      ).rowCount
    )
      issues.push(
        "Existing contact must be explicitly linked to the selected existing account.",
      );
  }
  return issues;
}
export async function importHistory(
  tx: Connection,
  row: ImportHistory,
  company: string,
  contact: string,
  opportunity: string,
  actor: string,
) {
  const owner = async (email: string) =>
    (
      await tx.query(
        "SELECT id FROM users WHERE lower(email)=lower($1) AND active=true",
        [email],
      )
    ).rows[0].id as string;
  const insertTask = async (
    t: z.infer<typeof taskSchema>,
    project: string | null,
  ) =>
    tx.query(
      "INSERT INTO tasks(id,company_id,opportunity_id,onboarding_id,owner_id,title,phase,due_at,resolution,completed_at,resolved_at,in_progress,is_next_action) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,false)",
      [
        randomUUID(),
        company,
        opportunity,
        project,
        await owner(t.ownerEmail),
        t.title,
        t.phase || null,
        t.dueAt,
        t.resolution,
        t.completedAt || null,
        t.inProgress && t.resolution === "open",
      ],
    );
  if (row.project) {
    const p = row.project,
      id = randomUUID();
    await tx.query(
      "INSERT INTO onboarding(id,company_id,opportunity_id,owner_id,cs_owner_id,sales_owner_id,phase,package,source,started_at,phase_started_at,target_at,completed_at,intake_received_at,billing_at,go_live_at,blocker,readiness,scope) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)",
      [
        id,
        company,
        p.source === "new_sale" ? opportunity : null,
        await owner(p.technicalOwnerEmail),
        await owner(p.csOwnerEmail),
        await owner(p.salesOwnerEmail),
        p.phase,
        p.package,
        p.source,
        p.startedAt,
        p.phaseStartedAt,
        p.targetAt,
        p.completedAt || null,
        p.intakeReceivedAt || null,
        p.billingAt || null,
        p.goLiveAt || null,
        p.blocker,
        JSON.stringify(p.readiness),
        JSON.stringify(p.scope),
      ],
    );
    for (const t of p.tasks) await insertTask(t, id);
  }
  for (const t of row.tasks) await insertTask(t, null);
  for (const a of row.history)
    await tx.query(
      "INSERT INTO activities(id,company_id,user_id,kind,title,body,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [randomUUID(), company, actor, a.kind, a.title, a.body, a.createdAt],
    );
  for (const m of row.messages)
    await tx.query(
      "INSERT INTO messages(id,company_id,contact_id,user_id,channel,direction,subject,body,recipient,status,created_at,updated_at,delivery_mode) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,'demo')",
      [
        randomUUID(),
        company,
        contact,
        actor,
        m.channel,
        m.direction,
        m.subject,
        m.body,
        m.recipient,
        m.status,
        m.createdAt,
      ],
    );
  for (const f of row.files) {
    const checked = validateFile(f);
    await tx.query(
      "INSERT INTO record_files(id,company_id,user_id,name,mime,content,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        randomUUID(),
        company,
        actor,
        checked.name,
        checked.mime,
        checked.content,
        f.createdAt,
      ],
    );
  }
  if (Object.keys(row.accountProfile).length)
    await tx.query(
      "UPDATE companies SET profile=profile||$2::jsonb WHERE id=$1",
      [company, JSON.stringify(row.accountProfile)],
    );
  if (Object.keys(row.contactProfile).length)
    await tx.query(
      "UPDATE contacts SET profile=profile||$2::jsonb WHERE id=$1",
      [contact, JSON.stringify(row.contactProfile)],
    );
}
