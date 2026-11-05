import { randomUUID, randomBytes } from "node:crypto";
import { z } from "zod";
import { db, transaction, type Connection } from "./db";
import { HttpError, requireRole, hash } from "./auth";
import { activity, canSend, cancelQueued, enqueue } from "./domain";
import { assertOwner, notify } from "./workflow-core";
import { isLive, integrationStatus } from "./config";
import { fileMimes, validateFile } from "./file-validation";
import type { User } from "../lib/types";

const text = (max = 500) => z.string().trim().max(max).default("");
const optionalDate = z.union([z.iso.datetime(), z.literal("")]);
export const prospectInput = z.object({
  requestKey: z.uuid(),
  name: z.string().trim().min(2).max(150),
  contactName: z.string().trim().min(2).max(150),
  email: z.union([z.email(), z.literal("")]).default(""),
  phone: text(40),
  website: text(300),
  source: text(100),
  notes: text(10000),
  signals: text(1000),
  fitScore: z.number().min(0).max(10).nullable().default(null),
});
export async function addProspect(
  input: z.infer<typeof prospectInput>,
  user: User | null,
  rateKey = "",
) {
  return transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      input.requestKey,
    ]);
    const existing = (
      await tx.query("SELECT id FROM prospects WHERE request_key=$1", [
        input.requestKey,
      ])
    ).rows[0];
    if (existing) return existing.id;
    if (!user) {
      await tx.query("SELECT pg_advisory_xact_lock(17304568)");
      const limits = await tx.query(
        "SELECT count(*) FILTER(WHERE key=$1)::int personal,count(*)::int total FROM public_requests WHERE created_at>now()-interval '1 hour'",
        [rateKey],
      );
      if (limits.rows[0].personal >= 5 || limits.rows[0].total >= 100)
        throw new HttpError(429, "Please try again later.");
      await tx.query("INSERT INTO public_requests(key) VALUES($1)", [rateKey]);
    }
    const owner =
      user?.id ||
      (
        await tx.query(
          "SELECT id FROM users WHERE active=true AND role IN ('sales','admin') ORDER BY CASE WHEN role='sales' THEN 0 ELSE 1 END,created_at LIMIT 1",
        )
      ).rows[0]?.id;
    if (!owner)
      throw new HttpError(503, "The team is not accepting requests yet.");
    const id = randomUUID();
    await tx.query(
      "INSERT INTO prospects(id,request_key,name,contact_name,email,phone,website,source,notes,signals,fit_score,status,owner_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
      [
        id,
        input.requestKey,
        input.name,
        input.contactName,
        input.email.toLowerCase(),
        input.phone,
        input.website,
        user ? input.source : "Website inquiry",
        input.notes,
        input.signals,
        input.fitScore,
        user ? "research" : "review",
        owner,
      ],
    );
    await notify(
      tx,
      owner,
      null,
      "New prospect to review",
      `${input.name}: review before creating a lead.`,
      `prospect:${id}`,
    );
    return id;
  });
}
export async function convertProspect(
  id: string,
  companyId: string | null,
  user: User,
) {
  return transaction(async (tx) => {
    const p = (
      await tx.query("SELECT * FROM prospects WHERE id=$1 FOR UPDATE", [id])
    ).rows[0];
    if (!p) throw new HttpError(404, "Prospect not found.");
    if (p.status === "converted") return p.opportunity_id;
    if (p.status !== "approved")
      throw new HttpError(409, "Approve this prospect before creating a lead.");
    await assertOwner(tx, p.owner_id);
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      p.name.trim().toLowerCase(),
    ]);
    const matches = (
      await tx.query(
        "SELECT id FROM companies WHERE lower(trim(name))=lower(trim($1))",
        [p.name],
      )
    ).rows;
    if (!companyId && matches.length)
      throw new HttpError(
        409,
        "An account with this name exists. Select the matching account before conversion.",
      );
    const company = companyId || randomUUID();
    if (companyId) {
      if (
        !(await tx.query("SELECT id FROM companies WHERE id=$1", [company]))
          .rowCount
      )
        throw new HttpError(404, "Account not found.");
    } else
      await tx.query(
        "INSERT INTO companies(id,name,website,owner_id,source) VALUES($1,$2,$3,$4,$5)",
        [company, p.name, p.website, p.owner_id, p.source],
      );
    const found = (
      await tx.query(
        "SELECT * FROM contacts WHERE (email<>'' AND lower(email)=lower($1)) OR (phone<>'' AND phone=$2)",
        [p.email, p.phone],
      )
    ).rows;
    const linked = new Set(
      (
        await tx.query(
          "SELECT contact_id FROM company_contacts WHERE company_id=$1",
          [company],
        )
      ).rows.map((c) => c.contact_id),
    );
    if (
      found.some((c) => !linked.has(c.id)) ||
      new Set(found.map((c) => c.id)).size > 1
    )
      throw new HttpError(
        409,
        "This destination matches another contact. Reconcile the contact/account relationship first.",
      );
    let contact = found[0]?.id;
    if (!contact) {
      contact = randomUUID();
      // Store non-normalized numbers without inventing an outbound destination or permission.
      const primary = /^\+[1-9]\d{7,14}$/.test(p.phone) ? p.phone : "";
      await tx.query(
        "INSERT INTO contacts(id,company_id,name,email,phone,profile) VALUES($1,$2,$3,$4,$5,$6)",
        [
          contact,
          company,
          p.contact_name,
          p.email,
          primary,
          JSON.stringify({ storePhone: p.phone }),
        ],
      );
    }
    const opportunity = randomUUID(),
      task = randomUUID();
    await tx.query(
      "INSERT INTO opportunities(id,company_id,contact_id,owner_id,kind,stage,package,next_action,next_action_at) VALUES($1,$2,$3,$4,'lead','New lead','Undecided','Review inquiry and schedule outreach',now()+interval '1 day')",
      [opportunity, company, contact, p.owner_id],
    );
    await tx.query(
      "INSERT INTO tasks(id,company_id,opportunity_id,owner_id,title,due_at,is_next_action) VALUES($1,$2,$3,$4,'Review inquiry and schedule outreach',now()+interval '1 day',true)",
      [task, company, opportunity, p.owner_id],
    );
    await tx.query(
      "UPDATE prospects SET status='converted',company_id=$2,opportunity_id=$3,version=version+1 WHERE id=$1",
      [id, company, opportunity],
    );
    await activity(
      tx,
      company,
      user.id,
      "lead",
      "Approved prospect converted",
      p.notes,
    );
    return opportunity;
  });
}
export async function processCadences() {
  await transaction(async (tx) => {
    const rows = (
      await tx.query(
        "SELECT r.*,c.name FROM customer_cadences r JOIN companies c ON c.id=r.company_id JOIN users u ON u.id=r.owner_id WHERE r.enabled AND c.lifecycle='active' AND u.active AND r.next_at<=now() FOR UPDATE OF r SKIP LOCKED",
      )
    ).rows;
    for (const r of rows) {
      if (
        !(
          await tx.query(
            "SELECT task_id FROM recurring_touches WHERE company_id=$1 AND scheduled_at=$2",
            [r.company_id, r.next_at],
          )
        ).rowCount
      ) {
        const task = randomUUID();
        await tx.query(
          "INSERT INTO tasks(id,company_id,owner_id,title,due_at) VALUES($1,$2,$3,$4,$5)",
          [
            task,
            r.company_id,
            r.owner_id,
            `${r.interval_days}-day customer check-in`,
            r.next_at,
          ],
        );
        await tx.query(
          "INSERT INTO recurring_touches(company_id,scheduled_at,task_id) VALUES($1,$2,$3)",
          [r.company_id, r.next_at, task],
        );
        await notify(
          tx,
          r.owner_id,
          r.company_id,
          "Customer check-in due",
          `${r.name}: review last contact, arrange a meeting, and record the outcome.`,
          `touch:${task}`,
        );
      }
      // Advance the due date, preserving the uncompleted task. Catch up without generating a storm.
      const days = Math.max(
        1,
        Math.floor(
          (Date.now() - new Date(r.next_at).getTime()) /
            (r.interval_days * 86400000),
        ) + 1,
      );
      await tx.query(
        "UPDATE customer_cadences SET next_at=next_at+($2::int*interval '1 day'),version=version+1 WHERE company_id=$1",
        [r.company_id, days * r.interval_days],
      );
    }
    await tx.query(
      "DELETE FROM public_requests WHERE created_at<now()-interval '1 day'",
    );
  });
}
export const sequenceInput = z
  .object({
    id: z.uuid().optional(),
    version: z.number().int().optional(),
    name: z.string().trim().min(2).max(100),
    active: z.boolean(),
    timezone: z.string().refine((v) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: v });
        return true;
      } catch {
        return false;
      }
    }, "Use a valid time zone."),
    startHour: z.number().int().min(0).max(22),
    endHour: z.number().int().min(1).max(23),
    weekdaysOnly: z.boolean(),
    steps: z
      .array(
        z.object({
          kind: z.enum(["email", "call"]),
          waitDays: z.number().int().min(0).max(365),
          subject: text(200),
          body: z.string().trim().min(1).max(9000),
        }),
      )
      .min(1)
      .max(30),
  })
  .refine(
    (x) =>
      x.endHour > x.startHour &&
      x.steps.every((s) => s.kind !== "email" || s.subject.length > 0),
    "Set a valid send window and an email subject for each email step.",
  );
export function inSendWindow(
  at: Date,
  s: {
    timezone: string;
    startHour: number;
    endHour: number;
    weekdaysOnly: boolean;
  },
) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: s.timezone,
    weekday: "short",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === "hour")?.value),
    day = parts.find((p) => p.type === "weekday")?.value;
  return (
    hour >= s.startHour &&
    hour < s.endHour &&
    (!s.weekdaysOnly || !["Sat", "Sun"].includes(day || ""))
  );
}
export async function stopEnrollment(
  tx: Connection,
  id: string,
  reason: string,
) {
  await tx.query(
    "UPDATE sequence_enrollments SET status='stopped',reason=$2,updated_at=now() WHERE id=$1 AND status<>'completed'",
    [id, reason],
  );
  await tx.query(
    "UPDATE messages SET status='cancelled',error=$2 WHERE status='queued' AND id IN (SELECT message_id FROM sequence_steps WHERE enrollment_id=$1)",
    [id, reason],
  );
  await tx.query(
    "UPDATE tasks SET resolution='cancelled',resolved_at=now() WHERE resolution='open' AND id IN (SELECT task_id FROM sequence_steps WHERE enrollment_id=$1)",
    [id],
  );
}
export async function enroll(
  sequenceId: string,
  opportunityId: string,
  requestKey: string,
  user: User,
) {
  return transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [requestKey]);
    const old = (
      await tx.query(
        "SELECT * FROM sequence_enrollments WHERE request_key=$1",
        [requestKey],
      )
    ).rows[0];
    if (old) {
      if (
        old.sequence_id !== sequenceId ||
        old.opportunity_id !== opportunityId
      )
        throw new HttpError(409, "Request key belongs to another enrollment.");
      return old.id;
    }
    const s = (
      await tx.query(
        "SELECT * FROM sales_sequences WHERE id=$1 AND active=true",
        [sequenceId],
      )
    ).rows[0];
    const o = (
      await tx.query("SELECT * FROM opportunities WHERE id=$1", [opportunityId])
    ).rows[0];
    if (!s || !o || ["Won", "Lost", "Be back", "Qualified"].includes(o.stage))
      throw new HttpError(
        409,
        "Choose an active sequence and an open opportunity.",
      );
    const c = (
      await tx.query(
        "SELECT ct.*,co.do_not_contact company_do_not_contact FROM contacts ct JOIN companies co ON co.id=$2 WHERE ct.id=$1 FOR UPDATE OF ct",
        [o.contact_id, o.company_id],
      )
    ).rows[0];
    canSend(c, "email");
    if (
      (
        await tx.query(
          "SELECT id FROM sequence_enrollments WHERE contact_id=$1 AND status IN ('active','paused','review')",
          [o.contact_id],
        )
      ).rowCount
    )
      throw new HttpError(
        409,
        "This contact already has an active, paused or review sequence.",
      );
    await assertOwner(tx, user.id);
    if (
      isLive() &&
      !integrationStatus().find((i) => i.name === "Postmark")?.ready
    )
      throw new HttpError(503, "Configure Postmark before live enrollment.");
    const id = randomUUID(),
      snapshot = {
        steps: s.steps,
        timezone: s.timezone,
        startHour: s.start_hour,
        endHour: s.end_hour,
        weekdaysOnly: s.weekdays_only,
      };
    await tx.query(
      "INSERT INTO sequence_enrollments(id,sequence_id,opportunity_id,contact_id,owner_id,request_key,delivery_mode,snapshot,next_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+($9::int*interval '1 day'))",
      [
        id,
        sequenceId,
        opportunityId,
        o.contact_id,
        user.id,
        requestKey,
        isLive() ? "live" : "demo",
        JSON.stringify(snapshot),
        s.steps[0].waitDays,
      ],
    );
    await activity(
      tx,
      o.company_id,
      user.id,
      "sequence",
      "Sequence enrolled",
      s.name,
    );
    return id;
  });
}
export async function processSequences() {
  const ids = (
    await db.query(
      "SELECT id FROM sequence_enrollments WHERE status='active' AND next_at<=now() ORDER BY next_at LIMIT 100",
    )
  ).rows;
  for (const { id } of ids)
    await transaction(async (tx) => {
      const e = (
        await tx.query(
          "SELECT * FROM sequence_enrollments WHERE id=$1 AND status='active' AND next_at<=now() FOR UPDATE SKIP LOCKED",
          [id],
        )
      ).rows[0];
      if (!e) return;
      const o = (
        await tx.query("SELECT * FROM opportunities WHERE id=$1", [
          e.opportunity_id,
        ])
      ).rows[0];
      const c = (
        await tx.query(
          "SELECT ct.*,co.name company_name,co.do_not_contact company_do_not_contact FROM contacts ct JOIN companies co ON co.id=$2 WHERE ct.id=$1",
          [e.contact_id, o?.company_id],
        )
      ).rows[0];
      const owner = (
        await tx.query("SELECT * FROM users WHERE id=$1 AND active=true", [
          e.owner_id,
        ])
      ).rows[0];
      if (
        !owner ||
        !["admin", "sales"].includes(owner.role) ||
        !o ||
        ["Won", "Lost", "Be back", "Qualified"].includes(o.stage) ||
        e.delivery_mode !== (isLive() ? "live" : "demo")
      ) {
        await stopEnrollment(
          tx,
          id,
          "Owner, opportunity or delivery mode changed.",
        );
        return;
      }
      try {
        canSend(c, "email");
      } catch {
        await stopEnrollment(
          tx,
          id,
          "Contact permission or suppression prevents outreach.",
        );
        return;
      }
      const prior = (
        await tx.query(
          "SELECT st.*,m.status message_status,t.resolution task_status FROM sequence_steps st LEFT JOIN messages m ON m.id=st.message_id LEFT JOIN tasks t ON t.id=st.task_id WHERE enrollment_id=$1 AND step_index=$2",
          [id, e.step_index],
        )
      ).rows[0];
      if (prior) {
        if (prior.task_id && prior.task_status !== "completed") {
          if (prior.task_status !== "open")
            await stopEnrollment(tx, id, "Call task cancelled.");
          return;
        }
        if (
          prior.message_id &&
          !["sent", "accepted", "delivered", "simulated"].includes(
            prior.message_status,
          )
        ) {
          if (
            [
              "review",
              "failed",
              "bounced",
              "suppressed",
              "undelivered",
              "cancelled",
            ].includes(prior.message_status)
          ) {
            await tx.query(
              "UPDATE sequence_enrollments SET status='review',reason='Review the last message before continuing.',updated_at=now() WHERE id=$1",
              [id],
            );
            await notify(
              tx,
              e.owner_id,
              o.company_id,
              "Sequence needs review",
              "A message could not be confirmed. Do not resend without checking delivery.",
              `sequence-review:${id}:${e.step_index}`,
            );
          }
          return;
        }
        const next = e.step_index + 1;
        await tx.query(
          "UPDATE sequence_steps SET completed_at=now() WHERE enrollment_id=$1 AND step_index=$2",
          [id, e.step_index],
        );
        await tx.query(
          "UPDATE sequence_enrollments SET step_index=$2,status=$3,next_at=now()+($4::int*interval '1 day'),updated_at=now() WHERE id=$1",
          [
            id,
            next,
            next >= e.snapshot.steps.length ? "completed" : "active",
            e.snapshot.steps[next]?.waitDays || 0,
          ],
        );
        return;
      }
      if (!inSendWindow(new Date(), e.snapshot)) return;
      const step = e.snapshot.steps[e.step_index];
      if (!step) return;
      if (step.kind === "call") {
        const task = randomUUID();
        await tx.query(
          "INSERT INTO tasks(id,company_id,opportunity_id,owner_id,title,due_at) VALUES($1,$2,$3,$4,$5,now())",
          [task, o.company_id, o.id, e.owner_id, step.body.slice(0, 300)],
        );
        await tx.query(
          "INSERT INTO sequence_steps(enrollment_id,step_index,task_id) VALUES($1,$2,$3)",
          [id, e.step_index, task],
        );
        await notify(
          tx,
          e.owner_id,
          o.company_id,
          "Sequence call task ready",
          step.body.slice(0, 300),
          `sequence-call:${id}:${e.step_index}`,
        );
      } else {
        const message = randomUUID(),
          token = randomBytes(32).toString("hex");
        await tx.query(
          "INSERT INTO sequence_unsubscribes(contact_id,token_hash) VALUES($1,$2)",
          [c.id, hash(token)],
        );
        const render = (value: string) =>
          value
            .replaceAll("{{contact}}", c.name)
            .replaceAll("{{company}}", c.company_name);
        const body = `${render(step.body)}\n\nStop sales emails: ${new URL("/unsubscribe/" + token, process.env.APP_URL || "http://localhost:3000").toString()}`;
        await tx.query(
          "INSERT INTO messages(id,company_id,contact_id,user_id,channel,direction,subject,body,recipient,idempotency_key,delivery_mode) VALUES($1,$2,$3,$4,'email','outbound',$5,$6,$7,$1,$8)",
          [
            message,
            o.company_id,
            c.id,
            e.owner_id,
            render(step.subject),
            body,
            c.email,
            e.delivery_mode,
          ],
        );
        await tx.query(
          "INSERT INTO sequence_steps(enrollment_id,step_index,message_id) VALUES($1,$2,$3)",
          [id, e.step_index, message],
        );
        await enqueue(
          tx,
          "send_message",
          { messageId: message },
          `message:${message}`,
        );
        await activity(
          tx,
          o.company_id,
          e.owner_id,
          "sequence",
          "Sequence email queued",
          render(step.subject),
        );
      }
    });
}
export async function unsubscribe(token: string) {
  await transaction(async (tx) => {
    const e = (
      await tx.query(
        "SELECT contact_id FROM sequence_unsubscribes WHERE token_hash=$1",
        [hash(token)],
      )
    ).rows[0];
    if (!e) throw new HttpError(404, "Unsubscribe link not found.");
    await tx.query(
      "UPDATE contacts SET email_suppressed=true,version=version+1 WHERE id=$1",
      [e.contact_id],
    );
    await cancelQueued(tx, e.contact_id, "Unsubscribed from sales emails");
  });
}
export async function operationsRoute(
  path: string,
  request: Request,
  body: unknown,
  user: User,
): Promise<Response | null> {
  if (!path.startsWith("operations/")) return null;
  const url = new URL(request.url),
    action = path.slice(11);
  if (request.method === "GET") {
    if (action === "data") {
      const [
        prospects,
        companies,
        contacts,
        cadences,
        sequences,
        enrollments,
        dependencies,
        projects,
      ] = await Promise.all([
        db.query(
          "SELECT p.*,u.name owner_name FROM prospects p LEFT JOIN users u ON u.id=p.owner_id ORDER BY p.created_at DESC LIMIT 1000",
        ),
        db.query(
          "SELECT c.*,(SELECT count(*)::int FROM company_contacts WHERE company_id=c.id) contact_count FROM companies c ORDER BY name",
        ),
        db.query(
          "SELECT ct.id,ct.company_id,ct.name,ct.email,ct.phone,ct.title,ct.profile,ct.do_not_contact,ct.email_suppressed,ct.sms_opted_out,ct.version,ARRAY(SELECT company_id FROM company_contacts WHERE contact_id=ct.id) company_ids FROM contacts ct ORDER BY name",
        ),
        db.query(
          "SELECT r.*,c.name,c.lifecycle,u.name owner_name,(SELECT count(*)::int FROM recurring_touches rt JOIN tasks t ON t.id=rt.task_id WHERE rt.company_id=r.company_id AND t.resolution='open') open_touches FROM customer_cadences r JOIN companies c ON c.id=r.company_id JOIN users u ON u.id=r.owner_id ORDER BY next_at",
        ),
        db.query(
          "SELECT s.*,(SELECT count(*)::int FROM sequence_enrollments e WHERE e.sequence_id=s.id) enrollment_count,(SELECT count(*)::int FROM sequence_enrollments e WHERE e.sequence_id=s.id AND e.status='active') active_count,(SELECT count(*)::int FROM sequence_enrollments e WHERE e.sequence_id=s.id AND e.reason ILIKE '%incoming reply%') replied_count,(SELECT json_build_object('sent',count(*) FILTER(WHERE m.status IN ('sent','accepted','delivered')),'simulated',count(*) FILTER(WHERE m.status='simulated'),'opened',count(*) FILTER(WHERE m.opened_at IS NOT NULL),'clicked',count(*) FILTER(WHERE m.clicked_at IS NOT NULL),'review',count(*) FILTER(WHERE m.status IN ('review','failed','bounced','undelivered'))) FROM sequence_steps st JOIN sequence_enrollments e ON e.id=st.enrollment_id JOIN messages m ON m.id=st.message_id WHERE e.sequence_id=s.id) metrics FROM sales_sequences s ORDER BY name",
        ),
        db.query(
          "SELECT e.id,e.sequence_id,e.opportunity_id,e.owner_id,e.status,e.step_index,e.reason,e.delivery_mode,e.next_at,e.created_at,s.name,c.name company_name,ct.name contact_name FROM sequence_enrollments e JOIN sales_sequences s ON s.id=e.sequence_id JOIN opportunities o ON o.id=e.opportunity_id JOIN companies c ON c.id=o.company_id JOIN contacts ct ON ct.id=e.contact_id ORDER BY e.created_at DESC LIMIT 1000",
        ),
        db.query("SELECT * FROM workflow_dependencies ORDER BY id"),
        db.query(
          "SELECT p.id,p.company_id,p.phase,p.scope,p.version,p.started_at,p.phase_started_at,p.completed_at,p.target_at,p.blocker,c.name FROM onboarding p JOIN companies c ON c.id=p.company_id ORDER BY p.started_at DESC",
        ),
      ]);
      return Response.json({
        prospects: prospects.rows,
        companies: companies.rows,
        contacts: contacts.rows,
        cadences: cadences.rows,
        sequences: sequences.rows,
        enrollments: enrollments.rows,
        dependencies: dependencies.rows,
        projects: projects.rows,
      });
    }
    if (action === "archive") {
      const channel = z
        .enum(["messages", "calls", "files"])
        .parse(url.searchParams.get("kind"));
      const offset = z.coerce
        .number()
        .int()
        .min(0)
        .max(1000000)
        .parse(url.searchParams.get("offset") || 0);
      const company = z
        .union([z.uuid(), z.literal("")])
        .parse(url.searchParams.get("companyId") || "");
      const q = (url.searchParams.get("q") || "").slice(0, 150);
      const queries = {
        messages:
          "SELECT m.*,c.name company_name FROM messages m LEFT JOIN companies c ON c.id=m.company_id WHERE ($1='' OR m.company_id::text=$1) AND (m.body ILIKE $2 OR m.subject ILIKE $2) ORDER BY m.created_at DESC,m.id DESC LIMIT 51 OFFSET $3",
        calls:
          "SELECT m.*,c.name company_name FROM calls m LEFT JOIN companies c ON c.id=m.company_id WHERE ($1='' OR m.company_id::text=$1) AND (m.summary ILIKE $2 OR m.transcript::text ILIKE $2) ORDER BY m.created_at DESC,m.id DESC LIMIT 51 OFFSET $3",
        files:
          "SELECT m.id,m.company_id,m.name,m.mime,m.created_at,c.name company_name FROM (SELECT id,company_id,name,mime,created_at FROM record_files UNION ALL SELECT f.id,p.company_id,f.name,f.mime,f.created_at FROM intake_files f JOIN intake_submissions s ON s.id=f.submission_id JOIN onboarding p ON p.id=s.project_id) m JOIN companies c ON c.id=m.company_id WHERE ($1='' OR m.company_id::text=$1) AND m.name ILIKE $2 ORDER BY m.created_at DESC,m.id DESC LIMIT 51 OFFSET $3",
      };
      const rows = (
        await db.query(queries[channel], [company, `%${q}%`, offset])
      ).rows;
      return Response.json({ rows: rows.slice(0, 50), more: rows.length > 50 });
    }
    if (action === "file") {
      const f = (
        await db.query(
          "SELECT name,mime,content FROM record_files WHERE id=$1 UNION ALL SELECT name,mime,content FROM intake_files WHERE id=$1",
          [z.uuid().parse(url.searchParams.get("id"))],
        )
      ).rows[0];
      if (!f) throw new HttpError(404, "File not found.");
      return new Response(new Uint8Array(f.content), {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${f.name}"`,
          "Cache-Control": "private,no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    throw new HttpError(404, "Workflow not found.");
  }
  const raw = body as Record<string, unknown>;
  if (action === "template") {
    requireRole(user, ["admin"]);
    const v = z
      .object({
        id: z.uuid().optional(),
        version: z.number().int().optional(),
        name: z.string().trim().min(2).max(100),
        subject: z.string().trim().min(1).max(200),
        body: z.string().trim().min(1).max(9000),
        phase: z.enum([
          "",
          "Intake & pre-build",
          "Working session",
          "Training",
          "Go-live",
          "Adoption",
        ]),
        active: z.boolean(),
        automatic: z.boolean(),
      })
      .refine(
        (v) => !v.automatic || !!v.phase,
        "Choose a phase for automatic delivery.",
      )
      .parse(body);
    if (v.id) {
      const r = await db.query(
        "UPDATE message_templates SET name=$3,subject=$4,body=$5,phase=$6,active=$7,automatic=$8,version=version+1 WHERE id=$1 AND version=$2 RETURNING id",
        [
          v.id,
          v.version,
          v.name,
          v.subject,
          v.body,
          v.phase || null,
          v.active,
          v.automatic,
        ],
      );
      if (!r.rowCount)
        throw new HttpError(409, "Template changed. Refresh first.");
    } else
      await db.query(
        "INSERT INTO message_templates(id,name,subject,body,phase,active,automatic) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          randomUUID(),
          v.name,
          v.subject,
          v.body,
          v.phase || null,
          v.active,
          v.automatic,
        ],
      );
    return Response.json({ ok: true });
  }
  if (action === "prospect") {
    requireRole(user, ["admin", "sales"]);
    return Response.json({
      id: await addProspect(prospectInput.parse(body), user),
    });
  }
  if (action === "prospect-edit") {
    requireRole(user, ["admin", "sales"]);
    const v = prospectInput
      .omit({ requestKey: true })
      .extend({ id: z.uuid(), version: z.number().int() })
      .parse(body);
    const r = await db.query(
      "UPDATE prospects SET name=$3,contact_name=$4,email=$5,phone=$6,website=$7,source=$8,signals=$9,fit_score=$10,notes=$11,status=CASE WHEN status='approved' THEN 'review' ELSE status END,version=version+1 WHERE id=$1 AND version=$2 AND status<>'converted' RETURNING id",
      [
        v.id,
        v.version,
        v.name,
        v.contactName,
        v.email.toLowerCase(),
        v.phone,
        v.website,
        v.source,
        v.signals,
        v.fitScore,
        v.notes,
      ],
    );
    if (!r.rowCount)
      throw new HttpError(
        409,
        "Prospect changed or was converted. Refresh first.",
      );
  } else if (action === "prospect-review") {
    requireRole(user, ["admin", "sales"]);
    const v = z
      .object({
        id: z.uuid(),
        version: z.number().int(),
        status: z.enum(["research", "review", "approved", "suppressed"]),
        ownerId: z.uuid(),
        notes: z.string().trim().min(3).max(2000),
      })
      .parse(body);
    await assertOwner(db, v.ownerId);
    const changed = await db.query(
      "UPDATE prospects SET status=$3,owner_id=$4,review_notes=$5,reviewed_by=$6,reviewed_at=now(),version=version+1 WHERE id=$1 AND version=$2 AND status<>'converted' RETURNING id",
      [v.id, v.version, v.status, v.ownerId, v.notes, user.id],
    );
    if (!changed.rowCount)
      throw new HttpError(409, "Prospect changed. Refresh first.");
  } else if (action === "convert") {
    requireRole(user, ["admin", "sales"]);
    const v = z
      .object({ id: z.uuid(), companyId: z.uuid().nullable() })
      .parse(body);
    return Response.json({
      id: await convertProspect(v.id, v.companyId, user),
    });
  } else if (action === "cadence") {
    const v = z
      .object({
        companyId: z.uuid(),
        ownerId: z.uuid(),
        intervalDays: z.number().int().min(1).max(365),
        nextAt: z.iso.datetime(),
        enabled: z.boolean(),
        version: z.number().int().default(0),
      })
      .parse(body);
    await transaction(async (tx) => {
      await assertOwner(tx, v.ownerId);
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        v.companyId,
      ]);
      const old = (
        await tx.query(
          "SELECT * FROM customer_cadences WHERE company_id=$1 FOR UPDATE",
          [v.companyId],
        )
      ).rows[0];
      if (old && old.version !== v.version)
        throw new HttpError(409, "Cadence changed. Refresh first.");
      await tx.query(
        "INSERT INTO customer_cadences(company_id,owner_id,interval_days,next_at,enabled) VALUES($1,$2,$3,$4,$5) ON CONFLICT(company_id) DO UPDATE SET owner_id=$2,interval_days=$3,next_at=$4,enabled=$5,version=customer_cadences.version+1",
        [v.companyId, v.ownerId, v.intervalDays, v.nextAt, v.enabled],
      );
      await activity(
        tx,
        v.companyId,
        user.id,
        "customer-success",
        "Customer cadence updated",
        `${v.intervalDays} days; ${v.enabled ? "enabled" : "paused"}`,
      );
    });
  } else if (action === "touch") {
    const v = z
      .object({
        companyId: z.uuid(),
        kind: z.enum(["meeting", "contact"]),
        at: z.iso.datetime(),
        notes: z.string().trim().min(1).max(10000),
        taskId: z.uuid().optional(),
      })
      .parse(body);
    if (new Date(v.at) > new Date())
      throw new HttpError(
        400,
        "Record a completed contact, not a future event.",
      );
    await transaction(async (tx) => {
      const field =
        v.kind === "meeting" ? "last_meeting_at" : "last_contact_at";
      await tx.query(
        `UPDATE customer_cadences SET ${field}=GREATEST(${field},$2::timestamptz),notes=$3,version=version+1 WHERE company_id=$1`,
        [v.companyId, v.at, v.notes],
      );
      if (v.taskId) {
        const changed = await tx.query(
          "UPDATE tasks SET resolution='completed',completed_at=$3,resolved_at=now() WHERE id=$1 AND company_id=$2 AND id IN(SELECT task_id FROM recurring_touches WHERE company_id=$2) AND resolution='open' RETURNING id",
          [v.taskId, v.companyId, v.at],
        );
        if (!changed.rowCount)
          throw new HttpError(
            409,
            "Check-in task is not open for this account.",
          );
      }
      await activity(
        tx,
        v.companyId,
        user.id,
        "customer-success",
        `${v.kind === "meeting" ? "Meeting" : "Contact"} recorded · ${v.at}`,
        v.notes,
      );
    });
  } else if (action === "sequence") {
    requireRole(user, ["admin", "sales"]);
    const v = sequenceInput.parse(body);
    if (v.id) {
      const r = await db.query(
        "UPDATE sales_sequences SET name=$3,steps=$4,active=$5,timezone=$6,start_hour=$7,end_hour=$8,weekdays_only=$9,version=version+1 WHERE id=$1 AND version=$2 RETURNING id",
        [
          v.id,
          v.version,
          v.name,
          JSON.stringify(v.steps),
          v.active,
          v.timezone,
          v.startHour,
          v.endHour,
          v.weekdaysOnly,
        ],
      );
      if (!r.rowCount)
        throw new HttpError(409, "Sequence changed. Refresh first.");
    } else
      await db.query(
        "INSERT INTO sales_sequences(id,name,steps,active,timezone,start_hour,end_hour,weekdays_only,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          randomUUID(),
          v.name,
          JSON.stringify(v.steps),
          v.active,
          v.timezone,
          v.startHour,
          v.endHour,
          v.weekdaysOnly,
          user.id,
        ],
      );
  } else if (action === "enroll") {
    requireRole(user, ["admin", "sales"]);
    const v = z
      .object({
        sequenceId: z.uuid(),
        opportunityId: z.uuid(),
        requestKey: z.uuid(),
      })
      .parse(body);
    return Response.json({
      id: await enroll(v.sequenceId, v.opportunityId, v.requestKey, user),
    });
  } else if (action === "enrollment") {
    requireRole(user, ["admin", "sales"]);
    const v = z
      .object({ id: z.uuid(), status: z.enum(["active", "paused", "stopped"]) })
      .parse(body);
    await transaction(async (tx) => {
      const e = (
        await tx.query(
          "SELECT * FROM sequence_enrollments WHERE id=$1 FOR UPDATE",
          [v.id],
        )
      ).rows[0];
      if (!e) throw new HttpError(404, "Enrollment not found.");
      if (v.status === "stopped")
        await stopEnrollment(tx, v.id, "Stopped by team");
      else {
        if (!["active", "paused"].includes(e.status))
          throw new HttpError(
            409,
            "Stopped, completed and review enrollments cannot be resumed.",
          );
        await tx.query(
          "UPDATE sequence_enrollments SET status=$2,updated_at=now() WHERE id=$1",
          [v.id, v.status],
        );
      }
    });
  } else if (action === "profile") {
    requireRole(user, ["admin", "sales", "onboarding"]);
    const v = z
      .object({
        companyId: z.uuid(),
        version: z.number().int(),
        website: text(300),
        address: text(500),
        country: text(100),
        buyingGroup: text(100),
        verification: z.enum(["unverified", "verified", "review"]),
        notes: text(2000),
      })
      .parse(body);
    if (v.verification === "verified" && !v.notes)
      throw new HttpError(400, "Record matching evidence before verifying.");
    const r = await db.query(
      "UPDATE companies SET website=$3,profile=profile||$4::jsonb,version=version+1 WHERE id=$1 AND version=$2 RETURNING id",
      [
        v.companyId,
        v.version,
        v.website,
        JSON.stringify({
          address: v.address,
          country: v.country,
          buyingGroup: v.buyingGroup,
          verification: v.verification,
          notes: v.notes,
        }),
      ],
    );
    if (!r.rowCount)
      throw new HttpError(409, "Account changed. Refresh first.");
    await activity(
      db,
      v.companyId,
      user.id,
      "record",
      "Account profile reviewed",
      v.notes,
    );
  } else if (action === "contact-link") {
    requireRole(user, ["admin", "sales"]);
    const v = z
      .object({
        contactId: z.uuid(),
        companyId: z.uuid(),
        evidence: z.string().trim().min(10).max(2000),
      })
      .parse(body);
    await transaction(async (tx) => {
      await tx.query(
        "INSERT INTO company_contacts(company_id,contact_id,evidence) VALUES($1,$2,$3) ON CONFLICT(company_id,contact_id) DO UPDATE SET evidence=$3",
        [v.companyId, v.contactId, v.evidence],
      );
      await activity(
        tx,
        v.companyId,
        user.id,
        "record",
        "Contact relationship verified",
        v.evidence,
      );
    });
  } else if (action === "contact-profile") {
    const v = z
      .object({
        id: z.uuid(),
        version: z.number().int(),
        title: text(150),
        firstName: text(100),
        lastName: text(100),
        storePhone: text(40),
        directPhone: text(40),
        cellPhone: text(40),
        additionalEmails: text(1000),
        verification: z.enum(["unverified", "verified", "review"]),
        notes: text(2000),
      })
      .parse(body);
    const { id, version, title, ...profile } = v;
    if (v.verification === "verified" && !v.notes)
      throw new HttpError(400, "Record verification evidence.");
    const r = await db.query(
      "UPDATE contacts SET title=$3,profile=profile||$4::jsonb,version=version+1 WHERE id=$1 AND version=$2 RETURNING company_id",
      [id, version, title, JSON.stringify(profile)],
    );
    if (!r.rowCount)
      throw new HttpError(409, "Contact changed. Refresh first.");
    await activity(
      db,
      r.rows[0].company_id,
      user.id,
      "record",
      "Contact profile reviewed",
      v.notes,
    );
  } else if (action === "scope") {
    requireRole(user, ["admin", "onboarding"]);
    const v = z
      .object({
        id: z.uuid(),
        version: z.number().int(),
        scope: z.object({
          dataMethod: text(100),
          dataStarted: optionalDate,
          dataCompleted: optionalDate,
          textingProvider: text(100),
          numberChoice: text(100),
          hostedNumber: text(40),
          authorizationStatus: text(100),
          authorizationReference: text(500),
          registrationStatus: text(100),
          verificationCallAt: optionalDate,
          edtLicense: text(100),
          paymentStatus: text(100),
          productModules: text(1000),
          trainingModules: text(1000),
          notes: text(5000),
        }),
      })
      .parse(body);
    if (
      v.scope.dataCompleted &&
      (!v.scope.dataStarted ||
        new Date(v.scope.dataCompleted) < new Date(v.scope.dataStarted))
    )
      throw new HttpError(
        400,
        "Data completion requires a start date at or before completion.",
      );
    const r = await db.query(
      "UPDATE onboarding SET scope=$3,version=version+1 WHERE id=$1 AND version=$2 RETURNING company_id",
      [v.id, v.version, JSON.stringify(v.scope)],
    );
    if (!r.rowCount)
      throw new HttpError(409, "Project changed. Refresh first.");
    await activity(
      db,
      r.rows[0].company_id,
      user.id,
      "onboarding",
      "Service scope updated",
      v.scope.notes,
    );
  } else if (action === "dependency") {
    requireRole(user, ["admin"]);
    const v = z
      .object({
        id: z.string(),
        status: z.enum(["unverified", "retained", "replaced", "retired"]),
        ownerId: z.uuid(),
        evidence: z.string().trim().min(10).max(5000),
      })
      .parse(body);
    await assertOwner(db, v.ownerId);
    await db.query(
      "UPDATE workflow_dependencies SET status=$2,owner_id=$3,evidence=$4,updated_at=now() WHERE id=$1",
      [v.id, v.status, v.ownerId, v.evidence],
    );
  } else if (action === "file") {
    const v = z
      .object({
        companyId: z.uuid(),
        name: z.string().min(1).max(160),
        mime: z.enum(fileMimes),
        data: z.string().max(2800000),
      })
      .parse(body);
    const f = validateFile(v);
    const id = randomUUID();
    await db.query(
      "INSERT INTO record_files(id,company_id,user_id,name,mime,content) VALUES($1,$2,$3,$4,$5,$6)",
      [id, v.companyId, user.id, f.name, f.mime, f.content],
    );
    await activity(db, v.companyId, user.id, "file", "File attached", f.name);
  } else if (action === "task-progress") {
    await db.query(
      "UPDATE tasks SET in_progress=$2 WHERE id=$1 AND resolution='open'",
      [z.uuid().parse(raw.id), z.boolean().parse(raw.inProgress)],
    );
  } else throw new HttpError(404, "Workflow not found.");
  return Response.json({ ok: true });
}
