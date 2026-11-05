import { processCadences, processSequences, inSendWindow } from "./operations";
import { notify } from "./workflow-core";
import { scheduleReminders } from "./management";
import { issueIntake } from "./intake";
import { queueMessage } from "./domain";
import { db, transaction } from "./db";
import { activity, canSend, enqueue } from "./domain";
import { sendProviderMessage, twilioClient } from "./providers";
import { isLive } from "./config";

// Outbound delivery is deliberately not retried after an ambiguous provider response.
// A crash may happen after acceptance but before the provider ID is committed.
export async function runOneJob() {
  const job = await transaction(async (tx) => {
    const row = (
      await tx.query(
        "SELECT * FROM jobs WHERE status='pending' AND run_at<=now() ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT 1",
      )
    ).rows[0];
    if (!row) return null;
    await tx.query(
      "UPDATE jobs SET status='running',locked_at=now(),attempts=attempts+1 WHERE id=$1",
      [row.id],
    );
    return { ...row, attempts: row.attempts + 1 };
  });
  if (!job) return false;
  try {
    if (job.kind === "staff_notification") {
      const notification = await transaction(async (tx) => {
        const n = (
          await tx.query(
            "SELECT n.*,u.email,u.active FROM notifications n JOIN users u ON u.id=n.user_id WHERE n.id=$1 FOR UPDATE OF n",
            [job.payload.notificationId],
          )
        ).rows[0];
        if (!n || n.email_status !== "queued") return null;
        const enabled =
          (
            await tx.query(
              "SELECT value->>'staffEmail' enabled FROM settings WHERE key='automation'",
            )
          ).rows[0]?.enabled === "true";
        if (
          !enabled ||
          !n.active ||
          n.email !== n.email_recipient ||
          n.email_mode !== (isLive() ? "live" : "demo") ||
          (isLive() && n.email.toLowerCase().endsWith(".test"))
        ) {
          await tx.query(
            "UPDATE notifications SET email_status='cancelled' WHERE id=$1",
            [n.id],
          );
          return null;
        }
        await tx.query(
          "UPDATE notifications SET email_status='sending' WHERE id=$1",
          [n.id],
        );
        return n;
      });
      if (notification) {
        const result = await sendProviderMessage({
          id: notification.id,
          channel: "email",
          recipient: notification.email_recipient,
          subject: notification.title,
          body: `${notification.body}\n\nOpen Linkd Sales Force: ${new URL("/?view=notifications", process.env.APP_URL || "http://localhost:3000")}`,
        });
        await db.query(
          "UPDATE notifications SET email_status=$2,email_provider_id=$3 WHERE id=$1",
          [notification.id, result.status, result.id],
        );
      }
    } else if (job.kind === "phase_email") {
      const p = (
        await db.query(
          "SELECT p.*,o.contact_id,c.name company_name FROM onboarding p LEFT JOIN opportunities o ON o.id=p.opportunity_id JOIN companies c ON c.id=p.company_id WHERE p.id=$1",
          [job.payload.projectId],
        )
      ).rows[0];
      const enabled =
        (
          await db.query(
            "SELECT value->>'phaseEmails' enabled FROM settings WHERE key='automation'",
          )
        ).rows[0]?.enabled === "true";
      const actor = (
        await db.query(
          "SELECT id,name,email,role FROM users WHERE id=$1 AND active=true",
          [job.payload.userId],
        )
      ).rows[0];
      if (
        enabled &&
        p?.phase === job.payload.phase &&
        actor &&
        job.payload.deliveryMode === (isLive() ? "live" : "demo")
      ) {
        if (!p.contact_id)
          await notify(
            db,
            actor.id,
            p.company_id,
            "Phase email needs a recipient",
            "This project has no linked opportunity contact. Review the recipient and send the template manually.",
            `phase-recipient:${job.id}`,
          );
        else {
          const c = (
            await db.query("SELECT name FROM contacts WHERE id=$1", [
              p.contact_id,
            ])
          ).rows[0];
          const render = (text: string) =>
            text
              .replaceAll("{{contact}}", c.name)
              .replaceAll("{{company}}", p.company_name)
              .replaceAll("{{phase}}", p.phase);
          await queueMessage(
            {
              contactId: p.contact_id,
              companyId: p.company_id,
              channel: "email",
              subject: render(job.payload.template.subject),
              body: render(job.payload.template.body),
              idempotencyKey: job.payload.messageKey,
            },
            actor,
          );
        }
      }
    } else if (job.kind === "welcome" || job.kind === "intake_nudge") {
      const p = (
        await db.query(
          "SELECT p.*,o.contact_id FROM onboarding p LEFT JOIN opportunities o ON o.id=p.opportunity_id WHERE p.id=$1",
          [job.payload.projectId],
        )
      ).rows[0];
      const settings = (
        await db.query("SELECT value FROM settings WHERE key='automation'")
      ).rows[0].value;
      const enabled =
        job.kind === "welcome" ? settings.welcome : settings.intakeNudge;
      const actor = (
        await db.query(
          "SELECT id,name,email,role FROM users WHERE id=$1 AND active=true",
          [job.payload.userId],
        )
      ).rows[0];
      if (
        job.payload.deliveryMode === (isLive() ? "live" : "demo") &&
        p &&
        p.contact_id &&
        actor &&
        enabled &&
        p.phase !== "Onboarded" &&
        !(job.kind === "intake_nudge" && p.intake_received_at)
      ) {
        const contact = (
          await db.query(
            "SELECT ct.*,c.do_not_contact company_do_not_contact FROM contacts ct JOIN companies c ON c.id=$2 WHERE ct.id=$1",
            [p.contact_id, p.company_id],
          )
        ).rows[0];
        canSend(contact, "email");
        const existing = (
          await db.query("SELECT id FROM messages WHERE idempotency_key=$1", [
            job.payload.messageKey,
          ])
        ).rows[0];
        if (existing) {
          await db.query(
            "UPDATE jobs SET status='completed',error=NULL WHERE id=$1",
            [job.id],
          );
          return true;
        }
        const link = await issueIntake(p.id, actor, false);
        await queueMessage(
          {
            contactId: p.contact_id,
            companyId: p.company_id,
            channel: "email",
            subject:
              job.kind === "welcome"
                ? "Welcome to Linkd — your next steps"
                : "Your Linkd intake is waiting",
            body: `Hi ${contact.name},\n\nPlease complete your secure onboarding intake: ${link.url}\n${settings.schedulingUrl ? `Book your onboarding call: ${settings.schedulingUrl}` : ""}\n\nYour Linkd team`,
            idempotencyKey: job.payload.messageKey,
          },
          actor,
        );
      }
    } else if (job.kind === "send_message") {
      const enrollment = (
        await db.query(
          "SELECT e.* FROM sequence_enrollments e JOIN sequence_steps s ON s.enrollment_id=e.id WHERE s.message_id=$1",
          [job.payload.messageId],
        )
      ).rows[0];
      if (
        enrollment &&
        (enrollment.status === "paused" ||
          (enrollment.status === "active" &&
            !inSendWindow(new Date(), enrollment.snapshot)))
      ) {
        await db.query(
          "UPDATE jobs SET status='pending',run_at=now()+interval '1 minute' WHERE id=$1",
          [job.id],
        );
        return true;
      }
      if (enrollment && enrollment.status !== "active")
        await db.query(
          "UPDATE messages SET status='cancelled',error='Sequence stopped.' WHERE id=$1 AND status='queued'",
          [job.payload.messageId],
        );
      const message = await transaction(async (tx) => {
        const row = (
          await tx.query(
            "SELECT m.*,ct.sms_consent,ct.email_consent,ct.sms_opted_out,ct.email_suppressed,ct.phone,ct.email,ct.do_not_contact,c.do_not_contact company_do_not_contact FROM messages m JOIN contacts ct ON ct.id=m.contact_id JOIN companies c ON c.id=m.company_id WHERE m.id=$1 FOR UPDATE OF m,ct,c",
            [job.payload.messageId],
          )
        ).rows[0];
        if (!row || row.status !== "queued") return null;
        if (row.delivery_mode !== (isLive() ? "live" : "demo")) {
          await tx.query(
            "UPDATE messages SET status='cancelled',error='Delivery mode changed. Review and queue a new message.' WHERE id=$1",
            [row.id],
          );
          return null;
        }
        try {
          canSend(row, row.channel);
          if (row.recipient !== (row.channel === "sms" ? row.phone : row.email))
            throw new Error(
              "Contact destination changed. Queue a new message.",
            );
        } catch (e) {
          await tx.query(
            "UPDATE messages SET status='cancelled',error=$2 WHERE id=$1",
            [row.id, (e as Error).message],
          );
          return null;
        }
        await tx.query(
          "UPDATE messages SET status='sending',updated_at=now() WHERE id=$1",
          [row.id],
        );
        return row;
      });
      if (message) {
        const result = await sendProviderMessage(message);
        await transaction(async (tx) => {
          await tx.query(
            `UPDATE messages SET provider_id=COALESCE(provider_id,$2),status=CASE WHEN status IN ('delivered','bounced','suppressed','failed','undelivered') THEN status ELSE $3 END,updated_at=now() WHERE id=$1`,
            [message.id, result.id, result.status],
          );
          await activity(
            tx,
            message.company_id,
            message.user_id,
            message.channel,
            result.status === "simulated"
              ? "Demo message simulated"
              : "Message accepted by provider",
            message.subject || message.body.slice(0, 120),
          );
        });
      }
    } else if (job.kind === "transcribe") {
      const call = (
        await db.query("SELECT * FROM calls WHERE id=$1", [job.payload.callId])
      ).rows[0];
      if (call?.recording_sid && !call.transcript_sid) {
        const transcript =
          await twilioClient().intelligence.v2.transcripts.create({
            serviceSid: process.env.TWILIO_INTELLIGENCE_SERVICE_SID!,
            channel: { media_properties: { source_sid: call.recording_sid } },
            customerKey: call.id,
          });
        await transaction(async (tx) => {
          await tx.query("UPDATE calls SET transcript_sid=$2 WHERE id=$1", [
            call.id,
            transcript.sid,
          ]);
          await enqueue(
            tx,
            "transcript_poll",
            { callId: call.id },
            `transcript:${transcript.sid}`,
            new Date(Date.now() + 30000),
          );
        });
      }
    } else if (job.kind === "transcript_poll") {
      const call = (
        await db.query("SELECT * FROM calls WHERE id=$1", [job.payload.callId])
      ).rows[0];
      if (call?.transcript_sid) {
        const resource = twilioClient().intelligence.v2.transcripts(
          call.transcript_sid,
        );
        const transcript = await resource.fetch();
        if (transcript.status === "failed")
          throw new Error("Transcription failed at the provider.");
        if (transcript.status !== "completed")
          throw new Error("Transcript is still processing.");
        const sentences = await resource.sentences.list({ limit: 10000 });
        const segments = sentences.map((s) => ({
          speaker: `Speaker ${s.mediaChannel}`,
          time: Number(s.startTime),
          text: s.transcript,
        }));
        await transaction(async (tx) => {
          await tx.query("UPDATE calls SET transcript=$2 WHERE id=$1", [
            call.id,
            JSON.stringify(segments),
          ]);
          await activity(
            tx,
            call.company_id,
            call.user_id,
            "call",
            "Call transcript ready",
          );
        });
      }
    }
    await db.query(
      "UPDATE jobs SET status='completed',error=NULL WHERE id=$1",
      [job.id],
    );
  } catch (error) {
    if (job.kind === "staff_notification")
      await db.query(
        "UPDATE notifications SET email_status='review' WHERE id=$1 AND email_status='sending'",
        [job.payload.notificationId],
      );
    const retry = job.kind === "transcript_poll" && job.attempts < 12;
    // Do not persist provider error payloads, which may contain credentials or contact data.
    const message = ["welcome", "intake_nudge", "phase_email"].includes(
      job.kind,
    )
      ? "Automation needs review. Check contact permission and provider configuration."
      : ["send_message", "staff_notification"].includes(job.kind)
        ? "Delivery could not be confirmed. Review the provider log before resending."
        : job.kind === "transcribe"
          ? "Transcription request needs provider reconciliation."
          : "Transcript retrieval is not ready or failed.";
    await db.query(
      "UPDATE jobs SET status=$2,error=$3,run_at=now()+($4::int*interval '1 second') WHERE id=$1",
      [
        job.id,
        retry ? "pending" : "review",
        message,
        Math.min(300, 15 * 2 ** job.attempts),
      ],
    );
    if (job.kind === "send_message")
      await db.query(
        "UPDATE messages SET status='review',error=$2,updated_at=now() WHERE id=$1 AND status='sending'",
        [job.payload.messageId, message],
      );
  }
  return true;
}
export async function recoverStaleJobs() {
  await processCadences();
  await processSequences();
  await scheduleReminders();
  await transaction(async (tx) => {
    await tx.query(
      "UPDATE messages SET status='review',error='Worker interrupted. Check provider before resending.' WHERE status='sending' AND updated_at<now()-interval '10 minutes'",
    );
    await tx.query(
      "UPDATE jobs SET status=CASE WHEN kind='transcript_poll' THEN 'pending' ELSE 'review' END,error='Worker interrupted; provider reconciliation may be required.' WHERE status='running' AND locked_at<now()-interval '10 minutes'",
    );
    await tx.query(
      "UPDATE notifications SET email_status='review' WHERE email_status='sending' AND id IN (SELECT (payload->>'notificationId')::uuid FROM jobs WHERE kind='staff_notification' AND status='review')",
    );
    await tx.query("DELETE FROM sessions WHERE expires_at<now()");
    await tx.query(
      "DELETE FROM login_attempts WHERE created_at<now()-interval '1 day'",
    );
  });
}
