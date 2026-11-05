import { randomUUID, randomBytes } from "node:crypto";
import { z } from "zod";
import { db, transaction } from "./db";
import { HttpError, hash, passwordHash } from "./auth";
import { activity, cancelQueued, checklistFor, enqueue } from "./domain";
import {
  assertOwner,
  notify,
  readinessDefaults,
  addBusinessDays,
} from "./workflow-core";
import { packages, type User } from "../lib/types";

const email = z.union([z.email(), z.literal("")]);
const phone = z
  .string()
  .regex(/^$|^\+[1-9]\d{7,14}$/, "Use an international phone number.");
const date = z.union([z.iso.date(), z.literal("")]);
export const editInput = z.object({
  id: z.uuid(),
  opportunityId: z.uuid(),
  contactId: z.uuid(),
  currentMrr: z.number().min(0).max(1000000).nullable(),
  version: z.number().int(),
  opportunityVersion: z.number().int(),
  contactVersion: z.number().int(),
  name: z.string().trim().min(2).max(150),
  city: z.string().max(150),
  pos: z.string().max(100),
  locations: z.number().int().min(1).max(1000),
  source: z.string().max(100),
  ownerId: z.uuid(),
  opportunityOwnerId: z.uuid(),
  lifecycle: z.enum(["prospect", "onboarding", "active", "paused", "churned"]),
  doNotContact: z.boolean(),
  restrictionReason: z.string().max(500),
  contactName: z.string().trim().min(2).max(150),
  email,
  phone,
  contactDoNotContact: z.boolean(),
  smsConsent: z.boolean(),
  emailConsent: z.boolean(),
  consentSource: z.string().max(500),
  package: z.enum(packages),
  mrr: z.number().min(0).max(1000000),
  setup: z.number().min(0).max(1000000),
  discount: z.number().min(0).max(1000000),
  effectiveDate: date,
  appointmentAt: z.union([z.iso.datetime(), z.literal("")]),
});
export async function editCustomer(
  input: z.infer<typeof editInput>,
  user: User,
) {
  return transaction(async (tx) => {
    await assertOwner(tx, input.ownerId);
    await assertOwner(tx, input.opportunityOwnerId);
    const c = (
      await tx.query("SELECT * FROM companies WHERE id=$1 FOR UPDATE", [
        input.id,
      ])
    ).rows[0];
    const contact = (
      await tx.query(
        "SELECT * FROM contacts WHERE id=$1 AND company_id=$2 FOR UPDATE",
        [input.contactId, input.id],
      )
    ).rows[0];
    const o = (
      await tx.query(
        "SELECT * FROM opportunities WHERE id=$1 AND company_id=$2 FOR UPDATE",
        [input.opportunityId, input.id],
      )
    ).rows[0];
    if (!c || !contact || !o) throw new HttpError(404, "Record not found.");
    if (
      c.version !== input.version ||
      contact.version !== input.contactVersion ||
      o.version !== input.opportunityVersion
    )
      throw new HttpError(
        409,
        "This record changed. Close and reopen the editor to load the latest values.",
      );
    if (
      (input.doNotContact || input.contactDoNotContact) &&
      !input.restrictionReason.trim()
    )
      throw new HttpError(400, "Record the do-not-contact reason.");
    if ((input.smsConsent || input.emailConsent) && !input.consentSource.trim())
      throw new HttpError(400, "Record the permission source.");
    if (o.stage === "Won" && input.package !== o.package)
      throw new HttpError(
        409,
        "A won package is preserved. Create a new opportunity for a package change.",
      );
    // Consent belongs to the destination. New addresses/numbers need a fresh recorded source.
    if (
      (input.phone !== contact.phone && input.smsConsent) ||
      (input.email.toLowerCase() !== contact.email && input.emailConsent)
    ) {
      if (input.consentSource === contact.consent_source)
        throw new HttpError(
          400,
          "Record fresh permission for the changed communication destination.",
        );
    }
    await tx.query(
      "UPDATE companies SET name=$2,city=$3,pos=$4,locations=$5,source=$6,owner_id=$7,lifecycle=$8,do_not_contact=$9,restriction_reason=$10,current_mrr_cents=$11,version=version+1 WHERE id=$1",
      [
        c.id,
        input.name,
        input.city,
        input.pos,
        input.locations,
        input.source,
        input.ownerId,
        input.lifecycle,
        input.doNotContact,
        input.restrictionReason,
        input.currentMrr === null ? null : Math.round(input.currentMrr * 100),
      ],
    );
    await tx.query(
      "UPDATE contacts SET name=$2,email=$3,phone=$4,sms_consent=$5,email_consent=$6,consent_source=$7,do_not_contact=$8,restriction_reason=$9,version=version+1 WHERE id=$1",
      [
        contact.id,
        input.contactName,
        input.email.toLowerCase(),
        input.phone,
        input.smsConsent,
        input.emailConsent,
        input.consentSource,
        input.contactDoNotContact,
        input.restrictionReason,
      ],
    );
    await tx.query(
      "UPDATE opportunities SET owner_id=$2,package=$3,mrr_cents=$4,setup_cents=$5,discount_cents=$6,effective_date=$7,appointment_at=$8,version=version+1,updated_at=now() WHERE id=$1",
      [
        o.id,
        input.opportunityOwnerId,
        input.package,
        Math.round(input.mrr * 100),
        Math.round(input.setup * 100),
        Math.round(input.discount * 100),
        input.effectiveDate || null,
        input.appointmentAt || null,
      ],
    );
    if (input.opportunityOwnerId !== o.owner_id)
      await tx.query(
        "UPDATE tasks SET owner_id=$2 WHERE opportunity_id=$1 AND is_next_action=true AND resolution='open'",
        [o.id, input.opportunityOwnerId],
      );
    const contacts = (
      await tx.query("SELECT id FROM contacts WHERE company_id=$1", [c.id])
    ).rows;
    if (input.doNotContact)
      for (const row of contacts)
        await cancelQueued(tx, row.id, "Company marked do not contact");
    if (
      input.contactDoNotContact ||
      !input.smsConsent ||
      !input.emailConsent ||
      input.email.toLowerCase() !== contact.email ||
      input.phone !== contact.phone
    )
      await cancelQueued(
        tx,
        contact.id,
        "Contact details or communication permission changed",
      );
    const changes = Object.entries({
      name: input.name,
      pos: input.pos,
      owner_id: input.ownerId,
      lifecycle: input.lifecycle,
      do_not_contact: input.doNotContact,
    })
      .filter(([key, value]) => c[key] !== value)
      .map(([key]) => key);
    const auditId = await activity(
      tx,
      c.id,
      user.id,
      "record",
      "Customer record updated",
      `Company changes: ${changes.join(", ") || "none"}. Contact, permission, and commercial details reviewed.`,
    );
    await tx.query("UPDATE activities SET metadata=$2 WHERE id=$1", [
      auditId,
      JSON.stringify({
        before: { company: c, contact, opportunity: o },
        after: input,
      }),
    ]);
  });
}
export const contactInput = z.object({
  companyId: z.uuid(),
  name: z.string().trim().min(2).max(150),
  email,
  phone,
  title: z.string().max(100).default(""),
});
export async function addContact(
  input: z.infer<typeof contactInput>,
  user: User,
) {
  const id = randomUUID();
  await transaction(async (tx) => {
    if (
      !(
        await tx.query("SELECT id FROM companies WHERE id=$1", [
          input.companyId,
        ])
      ).rowCount
    )
      throw new HttpError(404, "Customer not found.");
    await tx.query(
      "INSERT INTO contacts(id,company_id,name,email,phone,title) VALUES ($1,$2,$3,$4,$5,$6)",
      [
        id,
        input.companyId,
        input.name,
        input.email.toLowerCase(),
        input.phone,
        input.title,
      ],
    );
    await activity(
      tx,
      input.companyId,
      user.id,
      "record",
      "Contact added",
      input.name,
    );
  });
  return id;
}
export const opportunityInput = z.object({
  companyId: z.uuid(),
  contactId: z.uuid(),
  ownerId: z.uuid(),
  package: z.enum(packages),
  mrr: z.number().min(0).max(1000000),
  nextAction: z.string().trim().min(1).max(300),
  dueAt: z.iso.datetime(),
  requestKey: z.uuid(),
});
export async function addOpportunity(
  input: z.infer<typeof opportunityInput>,
  user: User,
) {
  return transaction(async (tx) => {
    await assertOwner(tx, input.ownerId);
    if (
      !(
        await tx.query(
          "SELECT id FROM contacts WHERE id=$1 AND company_id=$2",
          [input.contactId, input.companyId],
        )
      ).rowCount
    )
      throw new HttpError(400, "Select a contact belonging to this customer.");
    const existing = (
      await tx.query("SELECT id,company_id FROM opportunities WHERE id=$1", [
        input.requestKey,
      ])
    ).rows[0];
    if (existing) {
      if (existing.company_id !== input.companyId)
        throw new HttpError(409, "Request key already used.");
      return existing.id;
    }
    await tx.query(
      "INSERT INTO opportunities(id,company_id,contact_id,owner_id,kind,stage,package,mrr_cents,next_action,next_action_at) VALUES ($1,$2,$3,$4,'deal','Need next meeting',$5,$6,$7,$8)",
      [
        input.requestKey,
        input.companyId,
        input.contactId,
        input.ownerId,
        input.package,
        Math.round(input.mrr * 100),
        input.nextAction,
        input.dueAt,
      ],
    );
    await tx.query(
      "INSERT INTO tasks(id,company_id,opportunity_id,owner_id,title,due_at,is_next_action) VALUES ($1,$2,$3,$4,$5,$6,true)",
      [
        randomUUID(),
        input.companyId,
        input.requestKey,
        input.ownerId,
        input.nextAction,
        input.dueAt,
      ],
    );
    await activity(
      tx,
      input.companyId,
      user.id,
      "deal",
      "Additional opportunity created",
      input.package,
    );
    return input.requestKey;
  });
}
export async function qualifyLead(id: string, user: User) {
  return transaction(async (tx) => {
    const lead = (
      await tx.query("SELECT * FROM opportunities WHERE id=$1 FOR UPDATE", [id])
    ).rows[0];
    if (!lead) throw new HttpError(404, "Lead not found.");
    const existing = (
      await tx.query("SELECT id FROM opportunities WHERE source_lead_id=$1", [
        id,
      ])
    ).rows[0];
    if (existing) return existing.id;
    if (lead.kind !== "lead" || ["Lost", "Qualified"].includes(lead.stage))
      throw new HttpError(409, "Only an open lead can be qualified.");
    const dealId = randomUUID();
    const nextAction = lead.next_action || "Schedule discovery meeting";
    const nextActionAt = lead.next_action_at || new Date(Date.now() + 86400000);
    await tx.query(
      "INSERT INTO opportunities(id,company_id,contact_id,owner_id,kind,stage,package,mrr_cents,source_lead_id,qualified_at,next_action,next_action_at,setup_cents,discount_cents,effective_date,appointment_at) VALUES ($1,$2,$3,$4,'deal','Need next meeting',$5,$6,$7,now(),$8,$9,$10,$11,$12,$13)",
      [
        dealId,
        lead.company_id,
        lead.contact_id,
        lead.owner_id,
        lead.package,
        lead.mrr_cents,
        id,
        nextAction,
        nextActionAt,
        lead.setup_cents,
        lead.discount_cents,
        lead.effective_date,
        lead.appointment_at,
      ],
    );
    await tx.query(
      "UPDATE opportunities SET stage='Qualified',qualified_at=now(),next_action='',next_action_at=NULL,version=version+1 WHERE id=$1",
      [id],
    );
    await tx.query(
      "UPDATE tasks SET opportunity_id=$2 WHERE opportunity_id=$1 AND resolution='open' AND onboarding_id IS NULL",
      [id, dealId],
    );
    if (
      !(
        await tx.query(
          "SELECT id FROM tasks WHERE opportunity_id=$1 AND resolution='open' AND is_next_action=true",
          [dealId],
        )
      ).rowCount
    )
      await tx.query(
        "INSERT INTO tasks(id,company_id,opportunity_id,owner_id,title,due_at,is_next_action) VALUES ($1,$2,$3,$4,$5,$6,true)",
        [
          randomUUID(),
          lead.company_id,
          dealId,
          lead.owner_id,
          nextAction,
          nextActionAt,
        ],
      );
    await activity(
      tx,
      lead.company_id,
      user.id,
      "stage",
      "Lead qualified; connected deal created",
    );
    return dealId;
  });
}
export const projectInput = z.object({
  id: z.uuid(),
  version: z.number().int(),
  ownerId: z.uuid(),
  csOwnerId: z.uuid(),
  salesOwnerId: z.uuid(),
  targetAt: z.iso.date(),
  billingAt: date,
  goLiveAt: date,
  blocker: z.string().max(1000),
  readiness: z.record(
    z.string(),
    z.object({
      status: z.enum([
        "not_started",
        "in_progress",
        "verified",
        "not_applicable",
      ]),
      notes: z.string().max(2000),
    }),
  ),
});
export async function updateProject(
  input: z.infer<typeof projectInput>,
  user: User,
) {
  await transaction(async (tx) => {
    const p = (
      await tx.query("SELECT * FROM onboarding WHERE id=$1 FOR UPDATE", [
        input.id,
      ])
    ).rows[0];
    if (!p) throw new HttpError(404, "Project not found.");
    if (p.version !== input.version)
      throw new HttpError(
        409,
        "Project changed. Reopen its editor before saving.",
      );
    for (const owner of [input.ownerId, input.csOwnerId, input.salesOwnerId])
      await assertOwner(tx, owner);
    const keys = Object.keys(readinessDefaults(p.package));
    if (
      keys.some((k) => !input.readiness[k]) ||
      Object.keys(input.readiness).some((k) => !keys.includes(k))
    )
      throw new HttpError(400, "Complete the readiness fields.");
    for (const [key, value] of Object.entries(input.readiness)) {
      const before = p.readiness[key];
      if (
        ["verified", "not_applicable"].includes(value.status) &&
        value.status !== before?.status &&
        !value.notes.trim()
      )
        throw new HttpError(
          400,
          `Record evidence or a reason for ${key.replaceAll("_", " ")}.`,
        );
      if (
        [
          "user_list",
          "training",
          "modules",
          "manager",
          "live",
          "adoption",
        ].includes(key) &&
        value.status === "not_applicable"
      )
        throw new HttpError(400, `${key.replaceAll("_", " ")} is required.`);
    }
    if (
      input.goLiveAt &&
      input.goLiveAt > new Date().toISOString().slice(0, 10)
    )
      throw new HttpError(400, "Actual go-live cannot be in the future.");
    await tx.query(
      "UPDATE onboarding SET owner_id=$2,cs_owner_id=$3,sales_owner_id=$4,target_at=$5,billing_at=$6,go_live_at=$7,blocker=$8,readiness=$9,version=version+1 WHERE id=$1",
      [
        p.id,
        input.ownerId,
        input.csOwnerId,
        input.salesOwnerId,
        input.targetAt,
        input.billingAt || null,
        input.goLiveAt || null,
        input.blocker,
        JSON.stringify(input.readiness),
      ],
    );
    const shiftDays = Math.round(
      (new Date(input.targetAt).getTime() - new Date(p.target_at).getTime()) /
        86400000,
    );
    if (shiftDays)
      await tx.query(
        "UPDATE tasks SET due_at=due_at+($2::int*interval '1 day') WHERE onboarding_id=$1 AND resolution='open' AND phase IN ('Working session','Training','Go-live','Adoption')",
        [p.id, shiftDays],
      );
    if (input.goLiveAt)
      await tx.query(
        "UPDATE tasks SET due_at=$2::date+CASE WHEN title LIKE '%30-day%' THEN interval '30 days' ELSE interval '7 days' END WHERE onboarding_id=$1 AND phase='Adoption' AND resolution='open'",
        [p.id, input.goLiveAt],
      );
    await tx.query(
      "UPDATE tasks SET owner_id=CASE WHEN phase='Training' THEN $3::uuid WHEN phase IN ('Handoff','Adoption') THEN $4::uuid ELSE $2::uuid END WHERE onboarding_id=$1 AND resolution='open'",
      [p.id, input.ownerId, input.salesOwnerId, input.csOwnerId],
    );
    await activity(
      tx,
      p.company_id,
      user.id,
      "onboarding",
      "Onboarding readiness and owners updated",
    );
    for (const owner of new Set([
      input.ownerId,
      input.csOwnerId,
      input.salesOwnerId,
    ]))
      if (![p.owner_id, p.cs_owner_id, p.sales_owner_id].includes(owner))
        await notify(
          tx,
          owner,
          p.company_id,
          "Onboarding assigned",
          "Review the project readiness and next tasks.",
          `assigned:${p.id}:${input.version}:${owner}`,
        );
  });
}
export async function existingProject(
  companyId: string,
  packageName: string,
  user: User,
  requestKey: string,
) {
  return transaction(async (tx) => {
    const c = (
      await tx.query("SELECT * FROM companies WHERE id=$1 FOR UPDATE", [
        companyId,
      ])
    ).rows[0];
    if (!c) throw new HttpError(404, "Customer not found.");
    if (c.lifecycle === "prospect")
      throw new HttpError(
        409,
        "Use the won-deal handoff for a prospect, or set the existing customer lifecycle first.",
      );
    if (
      (await tx.query("SELECT id FROM onboarding WHERE id=$1", [requestKey]))
        .rowCount
    )
      return requestKey;
    if (
      (
        await tx.query(
          "SELECT id FROM onboarding WHERE company_id=$1 AND phase<>'Onboarded'",
          [companyId],
        )
      ).rowCount
    )
      throw new HttpError(
        409,
        "This customer already has an active onboarding project.",
      );
    await tx.query(
      "INSERT INTO onboarding(id,company_id,owner_id,cs_owner_id,sales_owner_id,target_at,package,source,readiness) VALUES ($1,$2,$3,$3,$3,now()+interval '28 days',$4,'existing_customer',$5)",
      [
        requestKey,
        companyId,
        user.id,
        packageName,
        JSON.stringify(readinessDefaults(packageName)),
      ],
    );
    for (const [phase, title, days] of checklistFor(packageName))
      await tx.query(
        "INSERT INTO tasks(id,company_id,onboarding_id,owner_id,title,phase,due_at) VALUES ($1,$2,$3,$4,$5,$6,now()+($7::int*interval '1 day'))",
        [randomUUID(), companyId, requestKey, user.id, title, phase, days],
      );
    await activity(
      tx,
      companyId,
      user.id,
      "onboarding",
      "Existing-customer onboarding opened",
      packageName,
    );
    return requestKey;
  });
}
export async function customerHistory(companyId: string, before?: string) {
  if (
    !(await db.query("SELECT id FROM companies WHERE id=$1", [companyId]))
      .rowCount
  )
    throw new HttpError(404, "Customer not found.");
  // Cursor includes both timestamp and id to avoid losing events sharing a transaction timestamp.
  let cursor: { at: string; id: string } | null = null;
  if (before) {
    try {
      cursor = z
        .object({ at: z.iso.datetime(), id: z.uuid() })
        .parse(JSON.parse(Buffer.from(before, "base64url").toString()));
    } catch {
      throw new HttpError(400, "Invalid history cursor.");
    }
  }
  const rows = (
    await db.query(
      `SELECT a.*,to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_at,u.name actor FROM activities a LEFT JOIN users u ON u.id=a.user_id WHERE a.company_id=$1 AND ($2::timestamptz IS NULL OR (a.created_at,a.id)<($2::timestamptz,$3::uuid)) ORDER BY a.created_at DESC,a.id DESC LIMIT 51`,
      [companyId, cursor?.at || null, cursor?.id || null],
    )
  ).rows;
  const hasMore = rows.length > 50;
  const items = rows.slice(0, 50).map(({ metadata, ...row }) => row);
  const last = items.at(-1);
  return {
    items,
    next:
      hasMore && last
        ? Buffer.from(
            JSON.stringify({ at: last.cursor_at, id: last.id }),
          ).toString("base64url")
        : null,
  };
}
export async function scheduleReminders() {
  await transaction(async (tx) => {
    const projects = (
      await tx.query(
        "SELECT p.*,c.name FROM onboarding p JOIN companies c ON c.id=p.company_id WHERE phase<>'Onboarded'",
      )
    ).rows;
    for (const p of projects) {
      const owners = new Set<string>(
        [p.owner_id, p.cs_owner_id].filter(Boolean),
      );
      if (
        !p.intake_received_at &&
        new Date() >= addBusinessDays(new Date(p.started_at), 2)
      )
        for (const owner of owners)
          await notify(
            tx,
            owner,
            p.company_id,
            "Intake is overdue",
            `${p.name}: intake has not arrived after two business days.`,
            `intake-due:${p.id}:${owner}`,
          );
      const date = p.billing_at || p.target_at;
      const days = (new Date(date).getTime() - Date.now()) / 86400000;
      if (days <= 14)
        for (const owner of owners)
          await notify(
            tx,
            owner,
            p.company_id,
            days < 0
              ? "Onboarding target overdue"
              : "Onboarding target approaching",
            `${p.name}: review the target date and blockers.`,
            `target:${p.id}:${new Date(date).toISOString().slice(0, 10)}:${owner}`,
          );
    }
    const tasks = (
      await tx.query(
        "SELECT t.*,c.name FROM tasks t JOIN companies c ON c.id=t.company_id WHERE resolution='open' AND due_at<now() LIMIT 1000",
      )
    ).rows;
    for (const t of tasks)
      await notify(
        tx,
        t.owner_id,
        t.company_id,
        "Task due",
        `${t.name}: ${t.title}`,
        `task-due:${t.id}:${new Date(t.due_at).toISOString()}:${t.owner_id}`,
      );
  });
}
export const inviteInput = z.object({
  email: z.email(),
  name: z.string().trim().min(2).max(150),
  role: z.enum(["admin", "sales", "onboarding"]),
});
export async function invite(input: z.infer<typeof inviteInput>, actor: User) {
  const token = randomBytes(32).toString("hex");
  await transaction(async (tx) => {
    if (
      (
        await tx.query("SELECT id FROM users WHERE lower(email)=$1", [
          input.email.toLowerCase(),
        ])
      ).rowCount
    )
      throw new HttpError(409, "This user already exists.");
    await tx.query(
      "INSERT INTO invitations(id,email,name,role,token_hash,expires_at) VALUES ($1,$2,$3,$4,$5,now()+interval '3 days')",
      [
        randomUUID(),
        input.email.toLowerCase(),
        input.name,
        input.role,
        hash(token),
      ],
    );
    await notify(
      tx,
      actor.id,
      null,
      "Invitation created",
      `Share the one-time link with ${input.email}. It expires in three days.`,
      `invite:${hash(token)}`,
    );
  });
  return {
    url: new URL(
      `/join/${token}`,
      process.env.APP_URL || "http://localhost:3000",
    ).toString(),
  };
}
export async function acceptInvite(token: string, password: string) {
  z.string().min(14).max(200).parse(password);
  return transaction(async (tx) => {
    const row = (
      await tx.query(
        "SELECT * FROM invitations WHERE token_hash=$1 AND expires_at>now() AND accepted_at IS NULL FOR UPDATE",
        [hash(token)],
      )
    ).rows[0];
    if (!row) throw new HttpError(404, "Invitation expired or already used.");
    await tx.query(
      "INSERT INTO users(id,name,email,role,password_hash) VALUES ($1,$2,$3,$4,$5)",
      [randomUUID(), row.name, row.email, row.role, passwordHash(password)],
    );
    await tx.query("UPDATE invitations SET accepted_at=now() WHERE id=$1", [
      row.id,
    ]);
  });
}

export async function reconcileJob(
  id: string,
  action: "resolve" | "retry",
  reason: string,
  confirmed: boolean,
  user: User,
) {
  if (reason.trim().length < 10)
    throw new HttpError(400, "Record what you verified in the provider logs.");
  await transaction(async (tx) => {
    const job = (
      await tx.query(
        "SELECT * FROM jobs WHERE id=$1 AND status='review' FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (!job) throw new HttpError(409, "This job is not awaiting review.");
    let companyId: string | null = null;
    if (job.kind === "send_message") {
      const message = (
        await tx.query("SELECT * FROM messages WHERE id=$1 FOR UPDATE", [
          job.payload.messageId,
        ])
      ).rows[0];
      if (!message)
        throw new HttpError(
          409,
          "The message for this review no longer exists.",
        );
      companyId = message?.company_id;
      if (action === "retry") {
        if (!confirmed || message.provider_id || message.status !== "review")
          throw new HttpError(
            409,
            "Only retry an unconfirmed request after verifying it was not accepted by the provider.",
          );
        await tx.query(
          "UPDATE messages SET status='queued',error=NULL,updated_at=now() WHERE id=$1 AND status='review'",
          [message.id],
        );
      } else
        await tx.query(
          "UPDATE messages SET status='cancelled',error=$2,updated_at=now() WHERE id=$1 AND status='review'",
          [message.id, `Operator closed review: ${reason}`],
        );
    } else if (job.payload.projectId)
      companyId = (
        await tx.query("SELECT company_id FROM onboarding WHERE id=$1", [
          job.payload.projectId,
        ])
      ).rows[0]?.company_id;
    else if (job.payload.callId)
      companyId = (
        await tx.query("SELECT company_id FROM calls WHERE id=$1", [
          job.payload.callId,
        ])
      ).rows[0]?.company_id;
    if (action === "retry" && job.kind === "transcribe")
      throw new HttpError(
        409,
        "Reconcile the transcript resource with Twilio before requesting another transcription.",
      );
    await tx.query(
      "UPDATE jobs SET status=$2,error=$3,run_at=now(),locked_at=NULL,attempts=CASE WHEN $2='pending' THEN 0 ELSE attempts END WHERE id=$1",
      [id, action === "retry" ? "pending" : "completed", reason],
    );
    if (companyId)
      await activity(
        tx,
        companyId,
        user.id,
        "automation",
        action === "retry" ? "Job requeued after review" : "Job review closed",
        reason,
      );
  });
}
