import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, transaction, type Connection } from "./db";
import { HttpError } from "./auth";
import {
  phases,
  stages,
  packages,
  type User,
  type Workspace,
} from "../lib/types";
import { publicConfig, isLive, integrationStatus } from "./config";

export async function activity(
  tx: Connection,
  companyId: string,
  userId: string | null,
  kind: string,
  title: string,
  body = "",
) {
  await tx.query(
    "INSERT INTO activities(id,company_id,user_id,kind,title,body) VALUES ($1,$2,$3,$4,$5,$6)",
    [randomUUID(), companyId, userId, kind, title, body],
  );
}
export async function enqueue(
  tx: Connection,
  kind: string,
  payload: object,
  key: string,
  at = new Date(),
) {
  await tx.query(
    "INSERT INTO jobs(id,kind,payload,dedupe_key,run_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(dedupe_key) DO NOTHING",
    [randomUUID(), kind, JSON.stringify(payload), key, at],
  );
}
export const customerInput = z
  .object({
    name: z.string().trim().min(2).max(150),
    contactName: z.string().trim().min(2).max(150),
    email: z.union([z.email(), z.literal("")]),
    phone: z
      .string()
      .regex(
        /^$|^\+[1-9]\d{7,14}$/,
        "Use an international number, such as +15551234567.",
      ),
    city: z.string().max(150).default(""),
    pos: z.string().max(100).default(""),
    locations: z.coerce.number().int().min(1).max(1000).default(1),
    source: z.string().max(100).default("Direct"),
    package: z.enum(packages),
    mrr: z.coerce.number().min(0).max(1000000),
    nextAction: z.string().trim().min(1).max(300),
    nextActionAt: z.iso.datetime(),
    smsConsent: z.boolean().default(false),
    emailConsent: z.boolean().default(false),
    consentSource: z.string().max(300).default(""),
  })
  .refine(
    (x) =>
      !(x.smsConsent || x.emailConsent) || x.consentSource.trim().length > 0,
    {
      message: "Record where communication permission came from.",
      path: ["consentSource"],
    },
  );

export async function createCustomer(
  input: z.infer<typeof customerInput>,
  user: User,
) {
  return transaction(async (tx) => {
    const companyId = randomUUID(),
      contactId = randomUUID(),
      opportunityId = randomUUID();
    await tx.query(
      "INSERT INTO companies(id,name,city,pos,locations,owner_id,source) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [
        companyId,
        input.name,
        input.city,
        input.pos,
        input.locations,
        user.id,
        input.source,
      ],
    );
    await tx.query(
      "INSERT INTO contacts(id,company_id,name,email,phone,sms_consent,email_consent,consent_source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        contactId,
        companyId,
        input.contactName,
        input.email.toLowerCase(),
        input.phone,
        input.smsConsent,
        input.emailConsent,
        input.consentSource,
      ],
    );
    await tx.query(
      "INSERT INTO opportunities(id,company_id,contact_id,owner_id,stage,package,mrr_cents,next_action,next_action_at) VALUES ($1,$2,$3,$4,'New lead',$5,$6,$7,$8)",
      [
        opportunityId,
        companyId,
        contactId,
        user.id,
        input.package,
        Math.round(input.mrr * 100),
        input.nextAction,
        input.nextActionAt,
      ],
    );
    await tx.query(
      "INSERT INTO tasks(id,company_id,opportunity_id,owner_id,title,due_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [
        randomUUID(),
        companyId,
        opportunityId,
        user.id,
        input.nextAction,
        input.nextActionAt,
      ],
    );
    await activity(
      tx,
      companyId,
      user.id,
      "lead",
      "Lead added",
      `${input.source} · ${input.package}`,
    );
    return companyId;
  });
}

export function checklistFor(packageName: string) {
  const core = [
    ["Handoff", "Confirm purchase, contacts, locations, and owners", 1],
    ["Handoff", "Send welcome email and intake link", 1],
    ["Intake & pre-build", "Collect intake form and user list", 3],
    ["Working session", "Provision users and confirm access", 7],
    ["Training", "Deliver live team training", 14],
    ["Training", "Complete manager enablement", 21],
    ["Go-live", "Confirm go-live and resolve launch issues", 28],
    ["Adoption", "Complete first-week usage check-in", 35],
    ["Adoption", "Complete 30-day adoption and manager review", 58],
  ] as [string, string, number][];
  if (["Full suite", "Data & training"].includes(packageName))
    core.push([
      "Intake & pre-build",
      "Start POS data transfer and validate import",
      3,
    ]);
  if (["Full suite", "Texting"].includes(packageName))
    core.push(
      [
        "Intake & pre-build",
        "Submit texting registration and number requirements",
        3,
      ],
      ["Working session", "Verify texting and applicable integrations", 10],
    );
  if (packageName === "Full suite")
    core.push([
      "Working session",
      "Configure branding, calendar, and webchat",
      10,
    ]);
  return core;
}
export async function changeStage(
  id: string,
  stage: (typeof stages)[number],
  user: User,
  reason = "",
) {
  return transaction(async (tx) => {
    const deal = (
      await tx.query(
        "SELECT o.*,c.pos,c.locations,ct.name AS contact_name FROM opportunities o JOIN companies c ON c.id=o.company_id JOIN contacts ct ON ct.id=o.contact_id WHERE o.id=$1 FOR UPDATE OF o",
        [id],
      )
    ).rows[0];
    if (!deal) throw new HttpError(404, "Opportunity not found.");
    if (deal.stage === stage) return;
    if (deal.stage === "Won")
      throw new HttpError(
        409,
        "Won opportunities are preserved. Create a separate opportunity for a new sale.",
      );
    if (stage === "Lost" && !reason.trim())
      throw new HttpError(400, "Add a loss reason.");
    if (
      stage === "Won" &&
      (!deal.package || !deal.pos || !deal.contact_name || !deal.locations)
    )
      throw new HttpError(
        400,
        "Complete the package, primary contact, POS, and location count before handoff.",
      );
    await tx.query(
      "UPDATE opportunities SET stage=$2,won_at=CASE WHEN $2='Won' THEN now() ELSE won_at END,lost_reason=$3,updated_at=now() WHERE id=$1",
      [id, stage, reason || null],
    );
    await activity(
      tx,
      deal.company_id,
      user.id,
      "stage",
      `${deal.stage} → ${stage}`,
      reason,
    );
    if (["Won", "Lost", "Be back"].includes(stage)) {
      await tx.query(
        "UPDATE tasks SET completed_at=now() WHERE opportunity_id=$1 AND onboarding_id IS NULL AND completed_at IS NULL",
        [id],
      );
      await cancelQueued(tx, deal.contact_id, "Opportunity moved to " + stage);
      if (stage !== "Be back")
        await tx.query(
          "UPDATE opportunities SET next_action_at=NULL,next_action='' WHERE id=$1",
          [id],
        );
    }
    if (stage === "Contacted") {
      await tx.query(
        "UPDATE opportunities SET next_action='Follow up after outreach',next_action_at=now()+interval '2 days' WHERE id=$1",
        [id],
      );
      await tx.query(
        "UPDATE tasks SET completed_at=now() WHERE opportunity_id=$1 AND onboarding_id IS NULL AND completed_at IS NULL",
        [id],
      );
      await tx.query(
        "INSERT INTO tasks(id,company_id,opportunity_id,owner_id,title,due_at) VALUES ($1,$2,$3,$4,'Follow up after outreach',now()+interval '2 days')",
        [randomUUID(), deal.company_id, id, deal.owner_id],
      );
    }
    if (stage === "Be back") {
      const due =
        deal.next_action_at && new Date(deal.next_action_at) > new Date()
          ? new Date(deal.next_action_at)
          : new Date(Date.now() + 30 * 86400000);
      const title = "Reconnect after deferred decision";
      await tx.query(
        "UPDATE opportunities SET next_action=$2,next_action_at=$3 WHERE id=$1",
        [id, title, due],
      );
      await tx.query(
        "INSERT INTO tasks(id,company_id,opportunity_id,owner_id,title,due_at) VALUES ($1,$2,$3,$4,$5,$6)",
        [randomUUID(), deal.company_id, id, deal.owner_id, title, due],
      );
    }
    if (stage === "Won") {
      const owner =
        (
          await tx.query(
            "SELECT id FROM users WHERE role='onboarding' ORDER BY created_at LIMIT 1",
          )
        ).rows[0]?.id ?? user.id;
      const projectId = randomUUID();
      const result = await tx.query(
        "INSERT INTO onboarding(id,opportunity_id,company_id,owner_id,target_at) VALUES ($1,$2,$3,$4,now()+interval '28 days') ON CONFLICT(opportunity_id) DO NOTHING RETURNING id",
        [projectId, id, deal.company_id, owner],
      );
      if (result.rowCount) {
        for (const [phase, title, days] of checklistFor(deal.package))
          await tx.query(
            "INSERT INTO tasks(id,company_id,opportunity_id,onboarding_id,owner_id,title,phase,due_at) VALUES ($1,$2,$3,$4,$5,$6,$7,now()+($8::int * interval '1 day'))",
            [
              randomUUID(),
              deal.company_id,
              id,
              projectId,
              owner,
              title,
              phase,
              days,
            ],
          );
        await activity(
          tx,
          deal.company_id,
          user.id,
          "onboarding",
          "Onboarding handoff created",
          `${deal.package} checklist assigned. Welcome is due within 24 hours.`,
        );
      }
    }
  });
}
export async function advancePhase(id: string, user: User) {
  return transaction(async (tx) => {
    const project = (
      await tx.query("SELECT * FROM onboarding WHERE id=$1 FOR UPDATE", [id])
    ).rows[0];
    if (!project) throw new HttpError(404, "Onboarding project not found.");
    if (project.phase === "Onboarded") return;
    if (project.blocker.trim())
      throw new HttpError(409, "Resolve the blocker before advancing.");
    const open = Number(
      (
        await tx.query(
          "SELECT count(*) FROM tasks WHERE onboarding_id=$1 AND phase=$2 AND completed_at IS NULL",
          [id, project.phase],
        )
      ).rows[0].count,
    );
    if (open)
      throw new HttpError(
        409,
        `Complete the ${open} remaining ${project.phase.toLowerCase()} task${open === 1 ? "" : "s"} first.`,
      );
    const next = phases[phases.indexOf(project.phase) + 1];
    if (
      next === "Onboarded" &&
      Number(
        (
          await tx.query(
            "SELECT count(*) FROM tasks WHERE onboarding_id=$1 AND completed_at IS NULL",
            [id],
          )
        ).rows[0].count,
      )
    )
      throw new HttpError(409, "Finish all checklist tasks before graduation.");
    await tx.query(
      "UPDATE onboarding SET phase=$2,phase_started_at=now(),completed_at=CASE WHEN $2='Onboarded' THEN now() ELSE NULL END WHERE id=$1",
      [id, next],
    );
    await activity(
      tx,
      project.company_id,
      user.id,
      "onboarding",
      `Onboarding: ${next}`,
    );
  });
}
export async function cancelQueued(
  tx: Connection,
  contactId: string,
  reason: string,
) {
  const cancelled = await tx.query(
    "UPDATE messages SET status='cancelled',error=$2,updated_at=now() WHERE contact_id=$1 AND direction='outbound' AND status='queued' RETURNING id",
    [contactId, reason],
  );
  for (const m of cancelled.rows)
    await tx.query(
      "UPDATE jobs SET status='cancelled' WHERE dedupe_key=$1 AND status='pending'",
      [`message:${m.id}`],
    );
}
export function canSend(
  contact: {
    sms_consent: boolean;
    email_consent: boolean;
    sms_opted_out: boolean;
    email_suppressed: boolean;
    phone: string;
    email: string;
  },
  channel: "sms" | "email",
) {
  if (
    channel === "sms" &&
    (!contact.sms_consent || contact.sms_opted_out || !contact.phone)
  )
    throw new HttpError(
      409,
      "SMS needs a phone number and recorded permission, without an opt-out.",
    );
  if (
    channel === "email" &&
    (!contact.email_consent || contact.email_suppressed || !contact.email)
  )
    throw new HttpError(
      409,
      "Email needs an address and recorded permission, without a suppression.",
    );
  if (
    isLive() &&
    (contact.email.endsWith(".test") ||
      /^\+120255501\d{2}$/.test(contact.phone))
  )
    throw new HttpError(409, "Sample contacts cannot receive live messages.");
}
export const messageInput = z
  .object({
    contactId: z.uuid(),
    channel: z.enum(["sms", "email"]),
    subject: z.string().max(200).default(""),
    body: z.string().trim().min(1).max(10000),
    scheduledAt: z.iso.datetime().optional(),
    idempotencyKey: z.uuid(),
  })
  .refine((x) => x.channel !== "email" || x.subject.trim().length > 0, {
    message: "Add an email subject.",
    path: ["subject"],
  });
export async function queueMessage(
  input: z.infer<typeof messageInput>,
  user: User,
) {
  return transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      input.idempotencyKey,
    ]);
    const existing = (
      await tx.query(
        "SELECT id,contact_id,user_id,channel,subject,body FROM messages WHERE idempotency_key=$1",
        [input.idempotencyKey],
      )
    ).rows[0];
    if (existing) {
      if (
        existing.contact_id !== input.contactId ||
        existing.user_id !== user.id ||
        existing.body !== input.body ||
        existing.channel !== input.channel ||
        existing.subject !== input.subject
      )
        throw new HttpError(
          409,
          "This request key was already used for another message.",
        );
      return existing.id;
    }
    const contact = (
      await tx.query("SELECT * FROM contacts WHERE id=$1 FOR UPDATE", [
        input.contactId,
      ])
    ).rows[0];
    if (!contact) throw new HttpError(404, "Contact not found.");
    canSend(contact, input.channel);
    if (
      isLive() &&
      !integrationStatus().find(
        (s) => s.name === (input.channel === "sms" ? "Twilio SMS" : "Postmark"),
      )?.ready
    )
      throw new HttpError(
        503,
        "Finish provider configuration before sending live messages.",
      );
    const id = randomUUID(),
      at = input.scheduledAt ? new Date(input.scheduledAt) : new Date();
    await tx.query(
      "INSERT INTO messages(id,company_id,contact_id,user_id,channel,direction,subject,body,recipient,idempotency_key,scheduled_at,delivery_mode) VALUES ($1,$2,$3,$4,$5,'outbound',$6,$7,$8,$9,$10,$11)",
      [
        id,
        contact.company_id,
        contact.id,
        user.id,
        input.channel,
        input.subject,
        input.body,
        input.channel === "sms" ? contact.phone : contact.email,
        input.idempotencyKey,
        at,
        isLive() ? "live" : "demo",
      ],
    );
    await enqueue(tx, "send_message", { messageId: id }, `message:${id}`, at);
    await activity(
      tx,
      contact.company_id,
      user.id,
      input.channel,
      `${input.channel === "sms" ? "Text" : "Email"} queued`,
      input.body,
    );
    return id;
  });
}
export async function getWorkspace(user: User): Promise<Workspace> {
  const results = await Promise.all([
    db.query("SELECT id,name,email,role FROM users ORDER BY name"),
    db.query(
      `SELECT c.*,u.name owner_name,ct.id contact_id,ct.name contact_name,ct.email,ct.phone,ct.sms_consent,ct.email_consent,ct.sms_opted_out,ct.email_suppressed,o.id opportunity_id,o.stage,o.package,o.mrr_cents,o.next_action,o.next_action_at FROM companies c JOIN users u ON u.id=c.owner_id JOIN opportunities o ON o.company_id=c.id JOIN contacts ct ON ct.id=o.contact_id ORDER BY c.created_at DESC`,
    ),
    db.query(
      "SELECT t.*,c.name company_name,u.name owner_name FROM tasks t JOIN companies c ON c.id=t.company_id JOIN users u ON u.id=t.owner_id ORDER BY t.due_at",
    ),
    db.query(
      `SELECT p.*,c.name company_name,u.name owner_name,o.package,o.mrr_cents,(SELECT count(*)::int FROM tasks WHERE onboarding_id=p.id) total_tasks,(SELECT count(*)::int FROM tasks WHERE onboarding_id=p.id AND completed_at IS NOT NULL) completed_tasks FROM onboarding p JOIN companies c ON c.id=p.company_id JOIN users u ON u.id=p.owner_id JOIN opportunities o ON o.id=p.opportunity_id ORDER BY p.target_at`,
    ),
    db.query(
      "SELECT a.*,c.name company_name,u.name actor FROM activities a JOIN companies c ON c.id=a.company_id LEFT JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT 200",
    ),
    db.query(
      "SELECT m.*,c.name company_name,ct.name contact_name FROM messages m LEFT JOIN companies c ON c.id=m.company_id LEFT JOIN contacts ct ON ct.id=m.contact_id ORDER BY m.created_at DESC LIMIT 200",
    ),
    db.query(
      "SELECT x.*,c.name company_name,ct.name contact_name,u.name user_name FROM calls x LEFT JOIN companies c ON c.id=x.company_id LEFT JOIN contacts ct ON ct.id=x.contact_id JOIN users u ON u.id=x.user_id ORDER BY x.created_at DESC LIMIT 100",
    ),
    db.query(
      "SELECT kind,status,count(*)::int count FROM jobs GROUP BY kind,status",
    ),
  ]);
  return {
    user,
    users: results[0].rows,
    customers: results[1].rows,
    tasks: results[2].rows,
    projects: results[3].rows,
    activities: results[4].rows,
    messages: results[5].rows,
    calls: results[6].rows,
    jobs: results[7].rows,
    config: publicConfig(),
  };
}
