import twilio from "twilio";
import { ServerClient } from "postmark";
import { timingSafeEqual } from "node:crypto";
import { HttpError } from "./auth";
import { isLive } from "./config";

export function twilioClient() {
  if (!isLive())
    throw new HttpError(409, "Live provider calls are disabled in demo mode.");
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN)
    throw new HttpError(503, "Twilio is not configured.");
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN, {
    timeout: 15000,
    autoRetry: false,
  });
}
export function publicUrl(path: string) {
  const url = new URL(path, process.env.APP_URL || "http://localhost:3000");
  if (isLive() && url.protocol !== "https:")
    throw new HttpError(503, "Live communications require an HTTPS APP_URL.");
  return url.toString();
}
export async function sendProviderMessage(message: {
  id: string;
  channel: string;
  recipient: string;
  subject: string;
  body: string;
}) {
  if (!isLive()) return { id: `demo-${message.id}`, status: "simulated" };
  if (message.channel === "sms") {
    const result = await twilioClient().messages.create({
      to: message.recipient,
      messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
      body: message.body,
      statusCallback: publicUrl(
        `/api/webhooks/twilio/sms-status?messageId=${message.id}`,
      ),
    });
    return { id: result.sid, status: result.status };
  }
  const client = new ServerClient(process.env.POSTMARK_SERVER_TOKEN!, {
    timeout: 15,
  });
  const result = await client.sendEmail({
    From: process.env.POSTMARK_FROM_EMAIL!,
    To: message.recipient,
    Subject: message.subject,
    TextBody: message.body,
    MessageStream: process.env.POSTMARK_MESSAGE_STREAM || "outbound",
    ReplyTo: `reply+${message.id}@${process.env.POSTMARK_INBOUND_DOMAIN}`,
    Metadata: { messageId: message.id },
    TrackOpens: false,
  });
  return { id: result.MessageID, status: "sent" };
}
export function voiceToken(userId: string) {
  const AccessToken = twilio.jwt.AccessToken;
  const token = new AccessToken(
    process.env.TWILIO_ACCOUNT_SID!,
    process.env.TWILIO_API_KEY_SID!,
    process.env.TWILIO_API_KEY_SECRET!,
    { identity: userId, ttl: 3600 },
  );
  token.addGrant(
    new AccessToken.VoiceGrant({
      outgoingApplicationSid: process.env.TWILIO_TWIML_APP_SID!,
      incomingAllow: false,
    }),
  );
  return token.toJwt();
}
export function verifyTwilio(request: Request, params: Record<string, string>) {
  if (!isLive() || !process.env.TWILIO_AUTH_TOKEN)
    throw new HttpError(503, "Twilio webhooks are not enabled.");
  const url = new URL(request.url);
  if (
    !twilio.validateRequest(
      process.env.TWILIO_AUTH_TOKEN,
      request.headers.get("x-twilio-signature") || "",
      publicUrl(url.pathname + url.search),
      params,
    )
  )
    throw new HttpError(403, "Invalid Twilio signature.");
}
export function verifyPostmark(request: Request) {
  if (
    !isLive() ||
    !process.env.POSTMARK_WEBHOOK_USER ||
    !process.env.POSTMARK_WEBHOOK_PASSWORD
  )
    throw new HttpError(503, "Postmark webhooks are not configured.");
  const actual = Buffer.from(request.headers.get("authorization") || "");
  const expected = Buffer.from(
    "Basic " +
      Buffer.from(
        `${process.env.POSTMARK_WEBHOOK_USER}:${process.env.POSTMARK_WEBHOOK_PASSWORD}`,
      ).toString("base64"),
  );
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new HttpError(401, "Invalid webhook credentials.");
}
