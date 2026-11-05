"use client";
import { useRef, useState } from "react";
import { request } from "./management";
export function ContactForm({ token }: { token?: string }) {
  const key = useRef("");
  const [done, setDone] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <main className="public-form">
      <div className="brand-logo">
        <img src="/brand/linkd-logo-main.webp" alt="Linkd" />
      </div>
      <h1>{token ? "Email preferences" : "Let’s connect"}</h1>
      {done ? (
        <p role="status">
          {token
            ? "You are unsubscribed from sales emails."
            : "Thanks. Your request has reached our team. We’ll review it and follow up."}
        </p>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            const f = new FormData(e.currentTarget);
            try {
              key.current ||= crypto.randomUUID();
              if (token)
                await request(`unsubscribe/${encodeURIComponent(token)}`, {});
              else
                await request("public/inquiry", {
                  requestKey: key.current,
                  name: f.get("name"),
                  contactName: f.get("contactName"),
                  email: f.get("email"),
                  phone: f.get("phone"),
                  notes: f.get("notes"),
                  websiteTrap: f.get("websiteTrap"),
                });
              setDone(true);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {token ? (
            <p>
              Confirm below to stop sales emails to the address associated with
              this link.
            </p>
          ) : (
            <>
              <label>
                Your name
                <input
                  name="contactName"
                  autoComplete="name"
                  required
                  minLength={2}
                  maxLength={150}
                />
              </label>
              <label>
                Company
                <input
                  name="name"
                  autoComplete="organization"
                  required
                  minLength={2}
                  maxLength={150}
                />
              </label>
              <label>
                Email
                <input
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  maxLength={254}
                />
              </label>
              <label>
                Phone
                <input
                  name="phone"
                  type="tel"
                  autoComplete="tel"
                  maxLength={40}
                />
              </label>
              <label>
                How can we help?
                <textarea name="notes" required maxLength={10000} />
              </label>
              <div className="contact-trap" aria-hidden="true">
                <label>
                  Leave empty
                  <input name="websiteTrap" tabIndex={-1} autoComplete="off" />
                </label>
              </div>
              <p>
                We’ll use these details to respond to your request. Submitting
                does not opt you into automated marketing or text messages.
              </p>
            </>
          )}
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          <button className="button primary" disabled={busy}>
            {busy ? "Saving…" : token ? "Unsubscribe" : "Send request"}
          </button>
        </form>
      )}
    </main>
  );
}
