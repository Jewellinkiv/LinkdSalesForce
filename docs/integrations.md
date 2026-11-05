# Twilio and Postmark setup

Live integrations are implemented but have not been verified against this team’s provider accounts. Settings shows whether required environment variables are present; it does not perform a provider health check. Start with a controlled contact and a staging database.

## Shared configuration

Set `APP_URL` to the externally reachable HTTPS origin, without a path. Run both the application and worker with the same variables. `APP_MODE` controls the demo presentation; `COMMUNICATIONS_MODE` controls actual provider requests. Keep `COMMUNICATIONS_MODE=demo` until provider setup is complete, then switch it deliberately to `live`. Demo-queued messages are not eligible for live delivery. `.test` email addresses and the seeded fictional phone range cannot receive live calls/messages.

## Twilio Voice and transcripts

1. Configure the account SID, auth token, API key SID/secret, TwiML application SID, and a Twilio caller ID in the matching `.env.example` fields.
2. Set the TwiML application's Voice request URL to `https://YOUR_HOST/api/webhooks/twilio/voice` using POST. The browser receives a short-lived outgoing-only access token. The server authorizes a one-use call ticket tied to the logged-in user and chooses the saved contact number.
3. The generated TwiML supplies the call-status and recording callback URLs. Enable Twilio recording authentication for the account; the app proxies audio behind its authenticated session.
4. To record, set `CALL_RECORDING_ENABLED=true`, customize `CALL_RECORDING_NOTICE`, and record permission in the call dialog. The called party hears the notice before bridging. Confirm your recording and retention process before enabling it for the team.
5. Create/configure a Twilio Conversation Intelligence service and set `TWILIO_INTELLIGENCE_SERVICE_SID`. Completed recordings of at least two seconds queue a transcript request. The worker polls for sentences and saves searchable speaker/time/text segments.

The first release handles **outbound browser calls**. It does not route inbound phone calls, implement ring groups/voicemail, or generate AI call summaries. Outcomes and summary notes are entered by the rep. Microphone access is required for live calling. Recording audio remains with Twilio; transcripts are stored in PostgreSQL.

References: [Voice JavaScript SDK](https://www.twilio.com/docs/voice/sdks/javascript), [TwiML Dial](https://www.twilio.com/docs/voice/twiml/dial), [Transcript resource](https://www.twilio.com/docs/conversation-intelligence-classic/api/transcript-resource), [Twilio webhook security](https://www.twilio.com/docs/usage/security).

## Twilio SMS

Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_MESSAGING_SERVICE_SID`. Configure the Messaging Service sender/registration for your traffic and set its incoming-message webhook to `https://YOUR_HOST/api/webhooks/twilio/sms-inbound` (POST). Enable Advanced Opt-Out so STOP/START events reach the app. The send request supplies its own status callback at `/api/webhooks/twilio/sms-status?messageId=…`.

Contacts need a phone number in E.164 format, recorded SMS permission, and no opt-out. Unknown incoming numbers appear as unmatched inbox messages; automatic contact creation and reassignment are not implemented. Incoming replies pause queued messages for that contact.

Reference: [Messaging Services](https://www.twilio.com/docs/messaging/services), [Advanced Opt-Out](https://www.twilio.com/docs/messaging/tutorials/advanced-opt-out).

## Postmark email

Set `POSTMARK_SERVER_TOKEN`, a verified `POSTMARK_FROM_EMAIL`, and the appropriate `POSTMARK_MESSAGE_STREAM`. Use expected, permission-based customer communication; do not load cold prospect lists into the Postmark flow. Contacts require recorded email permission and no suppression.

Configure a custom inbound domain in Postmark and set it as `POSTMARK_INBOUND_DOMAIN`. Replies use `reply+MESSAGE_UUID@YOUR_INBOUND_DOMAIN`. This requires a domain configured for inbound processing; a default Postmark hash mailbox is not interchangeable with this domain setting. Incoming mail is currently associated by sender email.

Point inbound processing and delivery, bounce, spam-complaint, and subscription-change webhooks to `https://YOUR_HOST/api/webhooks/postmark`. Protect them with the Basic Auth username/password configured as `POSTMARK_WEBHOOK_USER` and `POSTMARK_WEBHOOK_PASSWORD`. Postmark supports HTTP Basic Auth for webhook endpoints. Keep those credentials out of documentation, screenshots, and source control.

The handler supports manual suppression events with a null MessageID. Reactivating an address at Postmark does not automatically clear the app’s suppression or establish permission. Only plain-text content is stored/displayed; attachments and rich email rendering are not implemented. The payload limit is 1 MB; inbound messages with large attachments will be rejected and require provider-side/operator handling.

References: [Inbound setup](https://postmarkapp.com/developer/user-guide/inbound), [Inbound webhook](https://postmarkapp.com/developer/webhooks/inbound-webhook), [Webhook overview and security](https://postmarkapp.com/developer/webhooks/webhooks-overview), [Subscription changes](https://postmarkapp.com/developer/webhooks/subscription-change-webhook), [Postmark sending requirements](https://postmarkapp.com/support/article/1207-what-types-of-messages-are-a-good-fit-for-postmark).

## Controlled live validation

Use a contact and destination you control. Verify outbound SMS and email, replies, delivery receipts, STOP, and suppression before adding a team/customer cohort. Make an outbound call and verify the called-party recording notice, audio access, transcript, and saved outcome. Check provider logs and the app timeline together. Verify behavior with the worker stopped/restarted and with a duplicate callback. No live delivery has been exercised by the repository’s test suite. See the workflow release guide for optional welcome/intake automation, staff notifications, and operator review; all still require the worker.
