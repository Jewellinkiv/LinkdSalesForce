import type { Integration } from "../lib/types";
export function integrationStatus(): Integration[] {
  const specs = [
    {
      name: "Calendly",
      description:
        "Booking events and meeting history; requires a connected webhook subscription",
      keys: ["CALENDLY_SIGNING_KEY"],
    },
    {
      name: "Website intake",
      description: "Signed form delivery from all four websites",
      keys: [
        "INBOUND_JEWELLINK_SECRET",
        "INBOUND_LINKD_SECRET",
        "INBOUND_JEWELHIRE_SECRET",
        "INBOUND_COUNTRETAIL_SECRET",
      ],
    },
    {
      name: "Twilio Voice",
      description: "Browser calling and call events",
      keys: [
        "TWILIO_ACCOUNT_SID",
        "TWILIO_AUTH_TOKEN",
        "TWILIO_API_KEY_SID",
        "TWILIO_API_KEY_SECRET",
        "TWILIO_TWIML_APP_SID",
        "TWILIO_PHONE_NUMBER",
      ],
    },
    {
      name: "Call transcripts",
      description: "Post-call transcription through Twilio Intelligence",
      keys: [
        "TWILIO_ACCOUNT_SID",
        "TWILIO_AUTH_TOKEN",
        "TWILIO_INTELLIGENCE_SERVICE_SID",
      ],
    },
    {
      name: "Twilio SMS",
      description: "Two-way messaging and delivery receipts",
      keys: [
        "TWILIO_ACCOUNT_SID",
        "TWILIO_AUTH_TOKEN",
        "TWILIO_MESSAGING_SERVICE_SID",
      ],
    },
    {
      name: "Postmark",
      description: "Email delivery, inbound replies, and bounce handling",
      keys: [
        "POSTMARK_SERVER_TOKEN",
        "POSTMARK_FROM_EMAIL",
        "POSTMARK_INBOUND_DOMAIN",
        "POSTMARK_WEBHOOK_USER",
        "POSTMARK_WEBHOOK_PASSWORD",
      ],
    },
  ];
  return specs.map((s) => ({
    name: s.name,
    description: s.description,
    missing: s.keys.filter((k) => !process.env[k]),
    ready: s.keys.every((k) => Boolean(process.env[k])),
  }));
}
export function isLive() {
  return process.env.COMMUNICATIONS_MODE === "live";
}
export function publicConfig() {
  return {
    demo: process.env.APP_MODE === "demo",
    communicationMode: isLive() ? "live" : "demo",
    recordingEnabled: process.env.CALL_RECORDING_ENABLED === "true",
    integrations: integrationStatus(),
  };
}
