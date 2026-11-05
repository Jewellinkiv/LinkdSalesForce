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
    if (job.kind === "welcome" || job.kind === "intake_nudge") {
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
            "SELECT ct.*,c.do_not_contact company_do_not_contact FROM contacts ct JOIN companies c ON c.id=ct.company_id WHERE ct.id=$1",
            [p.contact_id],
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
      const message = await transaction(async (tx) => {
        const row = (
          await tx.query(
            "SELECT m.*,ct.sms_consent,ct.email_consent,ct.sms_opted_out,ct.email_suppressed,ct.phone,ct.email,ct.do_not_contact,c.do_not_contact company_do_not_contact FROM messages m JOIN contacts ct ON ct.id=m.contact_id JOIN companies c ON c.id=ct.company_id WHERE m.id=$1 FOR UPDATE OF m,ct,c",
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
    const retry = job.kind === "transcript_poll" && job.attempts < 12;
    // Do not persist provider error payloads, which may contain credentials or contact data.
    const message = ["welcome", "intake_nudge"].includes(job.kind)
      ? "Automation needs review. Check contact permission and provider configuration."
      : job.kind === "send_message"
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
  await scheduleReminders();
  await transaction(async (tx) => {
    await tx.query(
      "UPDATE messages SET status='review',error='Worker interrupted. Check provider before resending.' WHERE status='sending' AND updated_at<now()-interval '10 minutes'",
    );
    await tx.query(
      "UPDATE jobs SET status=CASE WHEN kind='transcript_poll' THEN 'pending' ELSE 'review' END,error='Worker interrupted; provider reconciliation may be required.' WHERE status='running' AND locked_at<now()-interval '10 minutes'",
    );
    await tx.query("DELETE FROM sessions WHERE expires_at<now()");
    await tx.query(
      "DELETE FROM login_attempts WHERE created_at<now()-interval '1 day'",
    );
  });
}
