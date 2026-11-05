import { z } from "zod";
import { randomUUID } from "node:crypto";
import { db, transaction } from "./db";
import { HttpError, requireRole } from "./auth";
import * as m from "./management";
import { issueIntake, submissions } from "./intake";
import { activity } from "./domain";
import { assertOwner } from "./workflow-core";
import { packages, type User } from "../lib/types";
export async function managementRoute(
  path: string,
  request: Request,
  body: unknown,
  user: User,
): Promise<Response | null> {
  const url = new URL(request.url);
  const post = request.method === "POST";
  const input = body as Record<string, unknown>;
  if (!post && path === "jobs/review") {
    requireRole(user, ["admin"]);
    return Response.json(
      (
        await db.query(
          "SELECT j.id,j.kind,j.status,j.error,j.attempts,j.run_at,COALESCE(c.name,cc.name) company_name,m.recipient,m.subject,m.id message_id,m.provider_id,cl.provider_id call_sid,cl.recording_sid FROM jobs j LEFT JOIN messages m ON m.id::text=j.payload->>'messageId' LEFT JOIN companies c ON c.id=m.company_id LEFT JOIN calls cl ON cl.id::text=j.payload->>'callId' LEFT JOIN companies cc ON cc.id=cl.company_id WHERE j.status='review' ORDER BY j.run_at LIMIT 100",
        )
      ).rows,
    );
  }
  if (!post && path === "customers/history")
    return Response.json(
      await m.customerHistory(
        z.uuid().parse(url.searchParams.get("companyId")),
        url.searchParams.get("before") || undefined,
      ),
    );
  if (!post && path === "onboarding/intake")
    return Response.json(
      await submissions(z.uuid().parse(url.searchParams.get("projectId"))),
    );
  if (!post && path.startsWith("files/")) {
    const file = (
      await db.query("SELECT * FROM intake_files WHERE id=$1", [
        z.uuid().parse(path.split("/")[1]),
      ])
    ).rows[0];
    if (!file) throw new HttpError(404, "File not found.");
    return new Response(new Uint8Array(file.content), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${file.name}"`,
        "Cache-Control": "private,no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  if (!post) return null;
  if (path === "jobs/reconcile") {
    requireRole(user, ["admin"]);
    const value = z
      .object({
        id: z.uuid(),
        action: z.enum(["resolve", "retry"]),
        reason: z.string().min(10).max(1000),
        confirmedNotSent: z.boolean(),
      })
      .parse(body);
    await m.reconcileJob(
      value.id,
      value.action,
      value.reason,
      value.confirmedNotSent,
      user,
    );
  } else if (path === "customers/edit") {
    requireRole(user, ["admin", "sales"]);
    await m.editCustomer(m.editInput.parse(body), user);
  } else if (path === "contacts") {
    requireRole(user, ["admin", "sales"]);
    return Response.json({
      id: await m.addContact(m.contactInput.parse(body), user),
    });
  } else if (path === "opportunities") {
    requireRole(user, ["admin", "sales"]);
    return Response.json({
      id: await m.addOpportunity(m.opportunityInput.parse(body), user),
    });
  } else if (path === "leads/qualify") {
    requireRole(user, ["admin", "sales"]);
    return Response.json({
      id: await m.qualifyLead(z.uuid().parse(input.id), user),
    });
  } else if (path === "onboarding/edit") {
    requireRole(user, ["admin", "onboarding"]);
    await m.updateProject(m.projectInput.parse(body), user);
  } else if (path === "onboarding/existing") {
    requireRole(user, ["admin", "onboarding"]);
    const value = z
      .object({
        companyId: z.uuid(),
        package: z.enum(packages).refine((p) => p !== "Undecided"),
        requestKey: z.uuid(),
      })
      .parse(body);
    return Response.json({
      id: await m.existingProject(
        value.companyId,
        value.package,
        user,
        value.requestKey,
      ),
    });
  } else if (path === "onboarding/intake-link") {
    requireRole(user, ["admin", "onboarding"]);
    return Response.json(await issueIntake(z.uuid().parse(input.id), user));
  } else if (path === "notifications/read")
    await db.query(
      "UPDATE notifications SET read_at=now() WHERE id=$1 AND user_id=$2",
      [z.uuid().parse(input.id), user.id],
    );
  else if (path === "settings/automation") {
    requireRole(user, ["admin"]);
    const value = z
      .object({
        welcome: z.boolean(),
        intakeNudge: z.boolean(),
        schedulingUrl: z.union([
          z
            .url()
            .refine(
              (v) => new URL(v).protocol === "https:",
              "Use an HTTPS scheduling link.",
            ),
          z.literal(""),
        ]),
      })
      .parse(body);
    if (value.welcome && !value.schedulingUrl)
      throw new HttpError(
        400,
        "Add a scheduling link before enabling automatic welcome.",
      );
    await db.query("UPDATE settings SET value=$1 WHERE key='automation'", [
      JSON.stringify(value),
    ]);
  } else if (path === "team/invite") {
    requireRole(user, ["admin"]);
    return Response.json(await m.invite(m.inviteInput.parse(body), user));
  } else if (path === "team/access") {
    requireRole(user, ["admin"]);
    const value = z
      .object({
        id: z.uuid(),
        active: z.boolean(),
        role: z.enum(["admin", "sales", "onboarding"]),
      })
      .parse(body);
    if (value.id === user.id)
      throw new HttpError(409, "You cannot change your own access here.");
    await transaction(async (tx) => {
      await tx.query("UPDATE users SET active=$2,role=$3 WHERE id=$1", [
        value.id,
        value.active,
        value.role,
      ]);
      await tx.query("DELETE FROM sessions WHERE user_id=$1", [value.id]);
    });
  } else if (path === "tasks/edit") {
    const value = z
      .object({
        id: z.uuid(),
        ownerId: z.uuid(),
        title: z.string().trim().min(1).max(300),
        dueAt: z.iso.datetime(),
        resolution: z.enum(["open", "completed", "cancelled"]),
      })
      .parse(body);
    await transaction(async (tx) => {
      await assertOwner(tx, value.ownerId);
      const task = (
        await tx.query("SELECT * FROM tasks WHERE id=$1 FOR UPDATE", [value.id])
      ).rows[0];
      if (!task) throw new HttpError(404, "Task not found.");
      if (task.onboarding_id && value.resolution === "cancelled")
        throw new HttpError(
          409,
          "Required onboarding tasks cannot be cancelled. Use readiness applicability instead.",
        );
      await tx.query(
        "UPDATE tasks SET title=$2,owner_id=$3,due_at=$4,resolution=$5,completed_at=CASE WHEN $5='completed' THEN now() ELSE NULL END,resolved_at=CASE WHEN $5='open' THEN NULL ELSE now() END WHERE id=$1",
        [task.id, value.title, value.ownerId, value.dueAt, value.resolution],
      );
      if (task.is_next_action && task.opportunity_id)
        await tx.query(
          "UPDATE opportunities SET next_action=$2,next_action_at=$3,version=version+1 WHERE id=$1",
          [
            task.opportunity_id,
            value.resolution === "open" ? value.title : "",
            value.resolution === "open" ? value.dueAt : null,
          ],
        );
      await activity(
        tx,
        task.company_id,
        user.id,
        "task",
        "Task updated",
        `${value.title}: ${value.resolution}`,
      );
    });
  } else if (path === "tasks/add") {
    const value = z
      .object({
        companyId: z.uuid(),
        opportunityId: z.uuid(),
        ownerId: z.uuid(),
        title: z.string().trim().min(1).max(300),
        dueAt: z.iso.datetime(),
      })
      .parse(body);
    await transaction(async (tx) => {
      await assertOwner(tx, value.ownerId);
      if (
        !(
          await tx.query(
            "SELECT id FROM opportunities WHERE id=$1 AND company_id=$2",
            [value.opportunityId, value.companyId],
          )
        ).rowCount
      )
        throw new HttpError(400, "Invalid opportunity.");
      await tx.query(
        "INSERT INTO tasks(id,company_id,opportunity_id,owner_id,title,due_at) VALUES ($1,$2,$3,$4,$5,$6)",
        [
          randomUUID(),
          value.companyId,
          value.opportunityId,
          value.ownerId,
          value.title,
          value.dueAt,
        ],
      );
      await activity(
        tx,
        value.companyId,
        user.id,
        "task",
        "Additional task created",
        value.title,
      );
    });
  } else return null;
  return Response.json({ ok: true });
}
