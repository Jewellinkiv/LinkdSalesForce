import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, transaction } from "@/server/db";
import {
  HttpError,
  requireUser,
  requireRole,
  checkOrigin,
  createSession,
  demoLoginEnabled,
  login,
  hash,
} from "@/server/auth";
import {
  createCustomer,
  customerInput,
  changeStage,
  advancePhase,
  getWorkspace,
  activity,
  queueMessage,
  messageInput,
} from "@/server/domain";
import { isLive, integrationStatus } from "@/server/config";
import { boundedText, twilioWebhook, postmarkWebhook } from "@/server/webhooks";
import { voiceToken } from "@/server/providers";
import { stages } from "@/lib/types";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handler(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  try {
    const path = (await context.params).path.join("/");
    if (request.method === "POST" && path.startsWith("webhooks/twilio/"))
      return await twilioWebhook(request, path.split("/")[2]);
    if (request.method === "POST" && path === "webhooks/postmark")
      return await postmarkWebhook(request);
    if (request.method === "GET" && path === "auth/info")
      return Response.json({ demoLogin: demoLoginEnabled() });
    if (request.method === "POST") checkOrigin(request);
    const body =
      request.method === "POST"
        ? JSON.parse((await boundedText(request, 64000)) || "{}")
        : {};
    if (request.method === "POST" && path === "auth/demo") {
      if (!demoLoginEnabled())
        throw new HttpError(403, "Demo login is disabled.");
      const user = (
        await db.query("SELECT id FROM users WHERE email='alex@example.test'")
      ).rows[0];
      if (!user) throw new HttpError(503, "Run the demo seed first.");
      return Response.json(
        { ok: true },
        { headers: { "Set-Cookie": await createSession(user.id) } },
      );
    }
    if (request.method === "POST" && path === "auth/login") {
      const input = z
        .object({ email: z.email(), password: z.string().min(1).max(200) })
        .parse(body);
      return Response.json(
        { ok: true },
        {
          headers: {
            "Set-Cookie": await login(request, input.email, input.password),
          },
        },
      );
    }
    const user = await requireUser(request);
    if (request.method === "GET" && path === "workspace")
      return Response.json(await getWorkspace(user), {
        headers: { "Cache-Control": "no-store" },
      });
    if (
      request.method === "GET" &&
      /^calls\/[a-f0-9-]+\/recording$/.test(path)
    ) {
      const call = (
        await db.query("SELECT recording_sid FROM calls WHERE id=$1", [
          z.uuid().parse(path.split("/")[1]),
        ])
      ).rows[0];
      if (!isLive() || !call?.recording_sid)
        throw new HttpError(404, "Recording unavailable.");
      const url = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Recordings/${call.recording_sid}.mp3`;
      const response = await fetch(url, {
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(
              `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`,
            ).toString("base64"),
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok)
        throw new HttpError(502, "Recording is not available from Twilio.");
      return new Response(response.body, {
        headers: {
          "Content-Type": "audio/mpeg",
          "Cache-Control": "private,no-store",
        },
      });
    }
    if (request.method !== "POST") throw new HttpError(404, "Route not found.");
    if (path === "auth/logout") {
      const token = request.headers
        .get("cookie")
        ?.split(";")
        .map((s) => s.trim())
        .find((s) => s.startsWith("linkd_session="))
        ?.slice(14);
      if (token)
        await db.query("DELETE FROM sessions WHERE token_hash=$1", [
          hash(token),
        ]);
      return Response.json(
        { ok: true },
        {
          headers: {
            "Set-Cookie":
              "linkd_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
          },
        },
      );
    }
    if (path === "customers") {
      requireRole(user, ["admin", "sales"]);
      return Response.json({
        id: await createCustomer(customerInput.parse(body), user),
      });
    }
    if (path === "opportunities/stage") {
      requireRole(user, ["admin", "sales"]);
      const input = z
        .object({
          id: z.uuid(),
          stage: z.enum(stages),
          reason: z.string().max(500).optional(),
        })
        .parse(body);
      await changeStage(input.id, input.stage, user, input.reason);
    } else if (path === "onboarding/advance") {
      requireRole(user, ["admin", "onboarding"]);
      await advancePhase(z.uuid().parse(body.id), user);
    } else if (path === "onboarding/blocker") {
      requireRole(user, ["admin", "onboarding"]);
      const input = z
        .object({ id: z.uuid(), blocker: z.string().trim().max(500) })
        .parse(body);
      await transaction(async (tx) => {
        const row = (
          await tx.query(
            "UPDATE onboarding SET blocker=$2 WHERE id=$1 RETURNING company_id",
            [input.id, input.blocker],
          )
        ).rows[0];
        if (!row) throw new HttpError(404, "Project not found.");
        await activity(
          tx,
          row.company_id,
          user.id,
          "onboarding",
          input.blocker ? "Blocker recorded" : "Blocker resolved",
          input.blocker,
        );
      });
    } else if (path === "tasks/complete") {
      const id = z.uuid().parse(body.id);
      await transaction(async (tx) => {
        const task = (
          await tx.query(
            "UPDATE tasks SET completed_at=now() WHERE id=$1 AND completed_at IS NULL RETURNING *",
            [id],
          )
        ).rows[0];
        if (task) {
          await activity(
            tx,
            task.company_id,
            user.id,
            "task",
            "Task completed",
            task.title,
          );
          if (task.opportunity_id && !task.onboarding_id)
            await tx.query(
              "UPDATE opportunities SET next_action='',next_action_at=NULL WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM tasks WHERE opportunity_id=$1 AND onboarding_id IS NULL AND completed_at IS NULL)",
              [task.opportunity_id],
            );
        }
      });
    } else if (path === "customers/note") {
      const input = z
        .object({
          companyId: z.uuid(),
          body: z.string().trim().min(1).max(10000),
        })
        .parse(body);
      if (
        !(
          await db.query("SELECT id FROM companies WHERE id=$1", [
            input.companyId,
          ])
        ).rowCount
      )
        throw new HttpError(404, "Company not found.");
      await activity(
        db,
        input.companyId,
        user.id,
        "note",
        "Note added",
        input.body,
      );
    } else if (path === "customers/follow-up") {
      const input = z
        .object({
          opportunityId: z.uuid(),
          title: z.string().trim().min(1).max(300),
          dueAt: z.iso.datetime(),
        })
        .parse(body);
      await transaction(async (tx) => {
        const deal = (
          await tx.query("SELECT * FROM opportunities WHERE id=$1 FOR UPDATE", [
            input.opportunityId,
          ])
        ).rows[0];
        if (!deal) throw new HttpError(404, "Opportunity not found.");
        await tx.query(
          "UPDATE tasks SET completed_at=now() WHERE opportunity_id=$1 AND onboarding_id IS NULL AND completed_at IS NULL",
          [deal.id],
        );
        await tx.query(
          "INSERT INTO tasks(id,company_id,opportunity_id,owner_id,title,due_at) VALUES ($1,$2,$3,$4,$5,$6)",
          [
            randomUUID(),
            deal.company_id,
            deal.id,
            user.id,
            input.title,
            input.dueAt,
          ],
        );
        await tx.query(
          "UPDATE opportunities SET next_action=$2,next_action_at=$3 WHERE id=$1",
          [deal.id, input.title, input.dueAt],
        );
        await activity(
          tx,
          deal.company_id,
          user.id,
          "task",
          "Follow-up scheduled",
          input.title,
        );
      });
    } else if (path === "messages")
      return Response.json({
        id: await queueMessage(messageInput.parse(body), user),
      });
    else if (path === "messages/cancel") {
      const id = z.uuid().parse(body.id);
      await transaction(async (tx) => {
        await tx.query(
          "UPDATE messages SET status='cancelled',error='Cancelled by team member' WHERE id=$1 AND status='queued'",
          [id],
        );
        await tx.query(
          "UPDATE jobs SET status='cancelled' WHERE dedupe_key=$1 AND status='pending'",
          [`message:${id}`],
        );
      });
    } else if (path === "calls/token") {
      requireRole(user, ["admin", "sales"]);
      if (!isLive() || !integrationStatus()[0].ready)
        throw new HttpError(503, "Live calling requires Twilio configuration.");
      return Response.json({ token: voiceToken(user.id) });
    } else if (path === "calls/start") {
      requireRole(user, ["admin", "sales"]);
      const input = z
        .object({
          contactId: z.uuid(),
          recordingConsent: z.boolean().default(false),
        })
        .parse(body);
      const ct = (
        await db.query("SELECT * FROM contacts WHERE id=$1", [input.contactId])
      ).rows[0];
      if (!ct?.phone)
        throw new HttpError(400, "A contact phone number is required.");
      if (
        isLive() &&
        (!integrationStatus()[0].ready ||
          ct.email.endsWith(".test") ||
          /^\+120255501\d{2}$/.test(ct.phone))
      )
        throw new HttpError(
          409,
          "Configure Twilio and use a real contact before calling.",
        );
      if (
        isLive() &&
        process.env.CALL_RECORDING_ENABLED === "true" &&
        !input.recordingConsent
      )
        throw new HttpError(
          400,
          "Confirm recording permission or disable recording in server configuration.",
        );
      const id = randomUUID();
      await transaction(async (tx) => {
        await tx.query(
          "INSERT INTO calls(id,company_id,contact_id,user_id,status,recording_consent) VALUES ($1,$2,$3,$4,$5,$6)",
          [
            id,
            ct.company_id,
            ct.id,
            user.id,
            isLive() ? "queued" : "demo",
            input.recordingConsent,
          ],
        );
        await activity(
          tx,
          ct.company_id,
          user.id,
          "call",
          isLive() ? "Call initiated" : "Demo call logged",
          isLive() ? "" : "No phone call was placed.",
        );
      });
      return Response.json({ id, demo: !isLive() });
    } else if (path === "calls/outcome") {
      const input = z
        .object({
          id: z.uuid(),
          outcome: z.string().trim().min(1).max(100),
          summary: z.string().max(5000),
        })
        .parse(body);
      await transaction(async (tx) => {
        const call = (
          await tx.query(
            "UPDATE calls SET outcome=$2,summary=$3 WHERE id=$1 RETURNING company_id",
            [input.id, input.outcome, input.summary],
          )
        ).rows[0];
        if (!call) throw new HttpError(404, "Call not found.");
        if (call.company_id)
          await activity(
            tx,
            call.company_id,
            user.id,
            "call",
            "Call outcome saved",
            input.outcome,
          );
      });
    } else throw new HttpError(404, "Route not found.");
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof HttpError)
      return Response.json({ error: error.message }, { status: error.status });
    if (error instanceof z.ZodError)
      return Response.json(
        {
          error: error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
        },
        { status: 400 },
      );
    if (error instanceof SyntaxError)
      return Response.json({ error: "Invalid request body." }, { status: 400 });
    if ((error as { code?: string }).code === "23505")
      return Response.json(
        {
          error:
            "A record with this email, phone, or request key already exists.",
        },
        { status: 409 },
      );
    console.error(
      "Request failed:",
      error instanceof Error ? error.name : "Unknown error",
    );
    return Response.json(
      {
        error:
          "The request could not be completed. Check the server and database connection.",
      },
      { status: 500 },
    );
  }
}
export const GET = handler;
export const POST = handler;
