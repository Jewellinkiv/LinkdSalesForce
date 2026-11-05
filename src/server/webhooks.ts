import { randomUUID, createHash } from "node:crypto";
import twilio from "twilio";
import { z } from "zod";
import { transaction, db } from "./db";
import { activity, cancelQueued, enqueue } from "./domain";
import { verifyTwilio, verifyPostmark, publicUrl } from "./providers";
import { HttpError } from "./auth";

export async function boundedText(request: Request, max = 1000000) {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new HttpError(413, "Request is too large.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
const xml = (body: string) =>
  new Response(body, { headers: { "Content-Type": "text/xml" } });
export async function twilioWebhook(request: Request, route: string) {
  const params = Object.fromEntries(
    new URLSearchParams(await boundedText(request, 64000)),
  );
  verifyTwilio(request, params);
  const url = new URL(request.url);
  if (route === "voice-notice") {
    const response = new twilio.twiml.VoiceResponse();
    response.say(
      process.env.CALL_RECORDING_NOTICE ||
        "This call is being recorded for training and quality purposes.",
    );
    return xml(response.toString());
  }
  if (route === "voice") {
    const response = new twilio.twiml.VoiceResponse();
    const callId = z.uuid().parse(params.CallId);
    const call = await transaction(async (tx) => {
      const row = (
        await tx.query(
          "SELECT x.*,ct.phone,ct.do_not_contact,c.do_not_contact company_do_not_contact,u.active FROM calls x JOIN contacts ct ON ct.id=x.contact_id JOIN companies c ON c.id=ct.company_id JOIN users u ON u.id=x.user_id WHERE x.id=$1 FOR UPDATE OF x,ct,c,u",
          [callId],
        )
      ).rows[0];
      if (
        !row ||
        row.do_not_contact ||
        row.company_do_not_contact ||
        !row.active ||
        params.From !== `client:${row.user_id}` ||
        new Date(row.created_at).getTime() < Date.now() - 5 * 60000
      )
        throw new HttpError(403, "Call authorization expired or invalid.");
      if (row.provider_id && row.provider_id !== params.CallSid)
        throw new HttpError(409, "Call authorization already used.");
      await tx.query(
        "UPDATE calls SET provider_id=$2,status='initiated' WHERE id=$1",
        [callId, params.CallSid],
      );
      return row;
    });
    const record =
      process.env.CALL_RECORDING_ENABLED === "true" && call.recording_consent;
    const dial = response.dial({
      callerId: process.env.TWILIO_PHONE_NUMBER,
      timeout: 30,
      timeLimit: 3600,
      action: publicUrl(`/api/webhooks/twilio/call-status?callId=${call.id}`),
      ...(record
        ? {
            record: "record-from-answer-dual" as const,
            recordingStatusCallback: publicUrl(
              `/api/webhooks/twilio/recording?callId=${call.id}`,
            ),
            recordingStatusCallbackEvent: ["completed" as const],
          }
        : {}),
    });
    dial.number(
      record ? { url: publicUrl("/api/webhooks/twilio/voice-notice") } : {},
      call.phone,
    );
    return xml(response.toString());
  }
  await transaction(async (tx) => {
    const eventKey =
      route === "sms-inbound"
        ? `sms-inbound:${params.MessageSid}`
        : createHash("sha256")
            .update(route + JSON.stringify(params) + url.search)
            .digest("hex");
    const inserted = await tx.query(
      "INSERT INTO webhook_events(provider,event_key) VALUES ('twilio',$1) ON CONFLICT DO NOTHING RETURNING event_key",
      [eventKey],
    );
    if (!inserted.rowCount) return;
    if (route === "sms-inbound") {
      const p = z
        .object({
          MessageSid: z.string().regex(/^SM[a-fA-F0-9]{32}$/),
          From: z.string(),
          Body: z.string().max(10000),
          OptOutType: z.string().optional(),
        })
        .parse(params);
      const contact = (
        await tx.query("SELECT * FROM contacts WHERE phone=$1 FOR UPDATE", [
          p.From,
        ])
      ).rows[0];
      if (contact) {
        // START records that the carrier lifted its block; it does not invent new marketing consent.
        const stop =
          p.OptOutType === "STOP" ||
          /^(stop|stopall|unsubscribe|cancel|end|quit)$/i.test(p.Body.trim());
        if (stop)
          await tx.query("UPDATE contacts SET sms_opted_out=true WHERE id=$1", [
            contact.id,
          ]);
        if (p.OptOutType === "START")
          await tx.query(
            "UPDATE contacts SET sms_opted_out=false WHERE id=$1",
            [contact.id],
          );
        await cancelQueued(
          tx,
          contact.id,
          stop ? "Contact opted out" : "Paused after an incoming reply",
        );
        await activity(
          tx,
          contact.company_id,
          null,
          "sms",
          stop ? "SMS opt-out received" : "Text reply received",
          p.Body,
        );
      }
      await tx.query(
        "INSERT INTO messages(id,company_id,contact_id,channel,direction,body,recipient,status,provider_id) VALUES ($1,$2,$3,'sms','inbound',$4,$5,'received',$6) ON CONFLICT(provider_id) DO NOTHING",
        [
          randomUUID(),
          contact?.company_id ?? null,
          contact?.id ?? null,
          p.Body,
          p.From,
          p.MessageSid,
        ],
      );
    } else if (route === "sms-status") {
      const status = params.MessageStatus;
      const messageId = url.searchParams.get("messageId");
      const message = (
        await tx.query(
          "SELECT * FROM messages WHERE provider_id=$1 OR id::text=$2 FOR UPDATE",
          [params.MessageSid, messageId],
        )
      ).rows[0];
      if (message) {
        const rank: Record<string, number> = {
          queued: 0,
          sending: 1,
          accepted: 1,
          sent: 2,
          delivered: 3,
          undelivered: 4,
          failed: 4,
        };
        if (status in rank && rank[status] >= (rank[message.status] ?? -1))
          await tx.query(
            "UPDATE messages SET provider_id=COALESCE(provider_id,$2),status=$3,updated_at=now() WHERE id=$1",
            [message.id, params.MessageSid, status],
          );
      }
    } else if (route === "call-status") {
      const id = z.uuid().parse(url.searchParams.get("callId"));
      await tx.query(
        "UPDATE calls SET status=$2,duration=$3 WHERE id=$1 AND provider_id=$4",
        [
          id,
          params.DialCallStatus || params.CallStatus,
          Math.max(
            0,
            Number(params.DialCallDuration || params.CallDuration) || 0,
          ),
          params.CallSid,
        ],
      );
    } else if (route === "recording") {
      if (
        params.RecordingStatus !== "completed" ||
        !(Number(params.RecordingDuration) >= 2)
      )
        return;
      const id = z.uuid().parse(url.searchParams.get("callId"));
      const sid = z
        .string()
        .regex(/^RE[a-fA-F0-9]{32}$/)
        .parse(params.RecordingSid);
      const row = (
        await tx.query(
          "UPDATE calls SET recording_sid=$2 WHERE id=$1 AND provider_id=$3 AND recording_consent=true RETURNING id",
          [id, sid, params.CallSid],
        )
      ).rows[0];
      if (row && process.env.TWILIO_INTELLIGENCE_SERVICE_SID)
        await enqueue(tx, "transcribe", { callId: id }, `recording:${sid}`);
    } else throw new HttpError(404, "Unknown webhook.");
  });
  return route === "sms-inbound" || route === "call-status"
    ? xml("<Response/>")
    : Response.json({ ok: true });
}

export async function postmarkWebhook(request: Request) {
  verifyPostmark(request);
  const p = z
    .object({
      RecordType: z.string().optional(),
      MessageID: z.string().nullable().optional(),
      From: z.string().optional(),
      TextBody: z.string().optional(),
      StrippedTextReply: z.string().optional(),
      Subject: z.string().optional(),
      Email: z.string().optional(),
      Recipient: z.string().optional(),
      SuppressSending: z.boolean().optional(),
      Inactive: z.boolean().optional(),
      Metadata: z.record(z.string(), z.string()).optional(),
    })
    .passthrough()
    .parse(JSON.parse(await boundedText(request)));
  const type = p.RecordType || "Inbound";
  if (type !== "SubscriptionChange" && !p.MessageID)
    throw new HttpError(400, "MessageID is required for this event.");
  if (
    ![
      "Inbound",
      "Delivery",
      "Bounce",
      "SpamComplaint",
      "SubscriptionChange",
      "Open",
      "Click",
    ].includes(type)
  )
    return Response.json({ ok: true });
  await transaction(async (tx) => {
    const key = `${type}:${p.MessageID}:${request.headers.get("x-pm-webhook-trace-id") || createHash("sha256").update(JSON.stringify(p)).digest("hex")}`;
    const inserted = await tx.query(
      "INSERT INTO webhook_events(provider,event_key) VALUES ('postmark',$1) ON CONFLICT DO NOTHING RETURNING event_key",
      [key],
    );
    if (!inserted.rowCount) return;
    if (type === "Inbound") {
      const email = (p.From || "").trim().toLowerCase();
      const contact = (
        await tx.query(
          "SELECT * FROM contacts WHERE lower(email)=$1 FOR UPDATE",
          [email],
        )
      ).rows[0];
      const body =
        p.StrippedTextReply || p.TextBody || "[No plain-text content]";
      const result = await tx.query(
        "INSERT INTO messages(id,company_id,contact_id,channel,direction,subject,body,recipient,status,provider_id) VALUES ($1,$2,$3,'email','inbound',$4,$5,$6,'received',$7) ON CONFLICT(provider_id) DO NOTHING RETURNING id",
        [
          randomUUID(),
          contact?.company_id ?? null,
          contact?.id ?? null,
          p.Subject || "",
          body,
          email,
          p.MessageID,
        ],
      );
      if (contact && result.rowCount) {
        await cancelQueued(tx, contact.id, "Paused after an incoming reply");
        await activity(
          tx,
          contact.company_id,
          null,
          "email",
          "Email reply received",
          body,
        );
      }
    } else {
      const message = (
        await tx.query(
          "SELECT * FROM messages WHERE provider_id=$1 OR id::text=$2 FOR UPDATE",
          [p.MessageID, p.Metadata?.messageId ?? null],
        )
      ).rows[0];
      if (message) {
        if (
          type === "Delivery" &&
          !["bounced", "suppressed"].includes(message.status)
        )
          await tx.query(
            "UPDATE messages SET provider_id=COALESCE(provider_id,$2),status='delivered',updated_at=now() WHERE id=$1",
            [message.id, p.MessageID],
          );
        if (type === "Bounce")
          await tx.query(
            "UPDATE messages SET status='bounced',updated_at=now() WHERE id=$1",
            [message.id],
          );
      }
      if (
        type === "SpamComplaint" ||
        (type === "Bounce" && p.Inactive) ||
        (type === "SubscriptionChange" && p.SuppressSending)
      ) {
        const contact = message?.contact_id
          ? (
              await tx.query("SELECT * FROM contacts WHERE id=$1 FOR UPDATE", [
                message.contact_id,
              ])
            ).rows[0]
          : (
              await tx.query(
                "SELECT * FROM contacts WHERE lower(email)=$1 FOR UPDATE",
                [(p.Email || p.Recipient || "").toLowerCase()],
              )
            ).rows[0];
        if (contact) {
          await tx.query(
            "UPDATE contacts SET email_suppressed=true WHERE id=$1",
            [contact.id],
          );
          await cancelQueued(tx, contact.id, "Email address suppressed");
        }
      }
    }
  });
  return Response.json({ ok: true });
}
