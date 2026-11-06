"use client";
import { fileMime } from "../lib/file-mime";
import { useEffect, useState, useRef } from "react";
import { request } from "./management";
export function PublicForm({
  token,
  kind,
}: {
  token: string;
  kind: "intake" | "join";
}) {
  const [info, setInfo] = useState<{ name: string; package: string } | null>(
      null,
    ),
    [error, setError] = useState(""),
    [done, setDone] = useState(false),
    [busy, setBusy] = useState(false);
  const key = useRef("");
  useEffect(() => {
    key.current = crypto.randomUUID();
    if (kind === "intake")
      request(`intake/${token}`)
        .then(setInfo)
        .catch((e) => setError(e.message));
  }, [token, kind]);
  return (
    <main className="public-form">
      <div className="brand-logo">
        <img src="/brand/linkd-logo-main.webp" alt="Linkd" />
      </div>
      <h1>Linkd {kind === "intake" ? "customer intake" : "team invitation"}</h1>
      {kind === "intake" && info && (
        <p>
          {info.name} · {info.package}
        </p>
      )}
      {done ? (
        <>
          <h2>
            {kind === "intake"
              ? "Thank you — intake received."
              : "Your account is ready."}
          </h2>
          <p>
            {kind === "intake"
              ? "Your onboarding team will review your details and follow up."
              : "Sign in with your invited email and the password you just created."}
          </p>
          {kind === "join" && <a href="/">Sign in</a>}
        </>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            const f = new FormData(e.currentTarget);
            try {
              if (kind === "join")
                await request(`join/${token}`, { password: f.get("password") });
              else {
                const files = await Promise.all(
                  f
                    .getAll("files")
                    .filter((x) => x instanceof File && x.size)
                    .map(async (x) => {
                      const file = x as File;
                      if (file.size > 2000000)
                        throw new Error("Each file must be 2 MB or smaller.");
                      const data = await new Promise<string>(
                        (resolve, reject) => {
                          const reader = new FileReader();
                          reader.onload = () =>
                            resolve(String(reader.result).split(",")[1]);
                          reader.onerror = reject;
                          reader.readAsDataURL(file);
                        },
                      );
                      return {
                        name: file.name,
                        mime: fileMime(file.name),
                        data,
                      };
                    }),
                );
                await request(`intake/${token}`, {
                  requestKey: key.current,
                  contactName: f.get("contactName"),
                  email: f.get("email"),
                  phone: f.get("phone"),
                  pos: f.get("pos"),
                  locations: Number(f.get("locations")),
                  desiredStart: f.get("desiredStart"),
                  userList: f.get("userList"),
                  requirements: f.get("requirements"),
                  ...Object.fromEntries(
                    [
                      "country",
                      "edtLicense",
                      "teamOverview",
                      "textingRequested",
                      "textingPlatform",
                      "numberChoice",
                      "dataTransferRequested",
                    ].map((k) => [k, f.get(k)]),
                  ),
                  files,
                });
              }
              setDone(true);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {kind === "join" ? (
            <label>
              Create password (at least 14 characters)
              <input
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={14}
                maxLength={200}
                required
              />
            </label>
          ) : (
            info && (
              <>
                <p>
                  Share the details your team needs for setup. Do not include
                  passwords, payment details, or private identification
                  documents.
                </p>
                <div className="form-grid">
                  <label>
                    Primary contact
                    <input name="contactName" required maxLength={150} />
                  </label>
                  <label>
                    Email
                    <input name="email" type="email" required />
                  </label>
                  <label>
                    Phone
                    <input name="phone" maxLength={40} />
                  </label>
                  <label>
                    Current POS
                    <input
                      name="pos"
                      required
                      placeholder="POS name or None"
                      maxLength={100}
                    />
                  </label>
                  <label>
                    Locations
                    <input
                      name="locations"
                      type="number"
                      min={1}
                      max={1000}
                      defaultValue={1}
                      required
                    />
                  </label>
                  <label>
                    Desired start
                    <input name="desiredStart" type="date" />
                  </label>
                </div>
                <div className="form-grid">
                  <label>
                    Country
                    <input name="country" required maxLength={100} />
                  </label>
                  <label>
                    Edge EDT license
                    <select name="edtLicense">
                      <option value="unknown">Not sure</option>
                      <option value="yes">Yes</option>
                      <option value="no">No</option>
                      <option value="not_applicable">Not using Edge</option>
                    </select>
                  </label>
                  <label>
                    Set up texting?
                    <select name="textingRequested">
                      <option value="unknown">Discuss with my team</option>
                      <option value="yes">Yes</option>
                      <option value="no">No</option>
                    </select>
                  </label>
                  <label>
                    Current texting / clienteling platform
                    <input
                      name="textingPlatform"
                      maxLength={150}
                      placeholder="Clientbook, Podium, another provider, or none"
                    />
                  </label>
                  <label>
                    Texting number
                    <select name="numberChoice">
                      <option value="undecided">Undecided</option>
                      <option value="new">New number</option>
                      <option value="existing">Existing store number</option>
                    </select>
                  </label>
                  <label>
                    Transfer POS data?
                    <select name="dataTransferRequested">
                      <option value="unknown">Discuss with my team</option>
                      <option value="yes">Yes</option>
                      <option value="no">No</option>
                    </select>
                  </label>
                </div>
                <label>
                  Current team and training goals
                  <textarea name="teamOverview" maxLength={10000} />
                </label>
                <label>
                  User list — names, work emails, and roles
                  <textarea name="userList" maxLength={20000} />
                </label>
                <label>
                  Requirements and questions
                  <textarea name="requirements" maxLength={10000} />
                </label>
                <label>
                  User list / requirements files
                  <input
                    name="files"
                    type="file"
                    accept=".csv,.txt,.pdf,.xlsx,.docx"
                    multiple
                  />
                  <small>
                    Optional: up to three CSV, TXT, PDF, XLSX or DOCX files; 2
                    MB each. You can send your user list later.
                  </small>
                </label>
              </>
            )
          )}
          {error && (
            <p role="alert" className="error-text">
              {error}
            </p>
          )}
          <button
            className="button primary"
            disabled={busy || (kind === "intake" && !info)}
          >
            {busy
              ? "Submitting…"
              : kind === "intake"
                ? "Submit intake"
                : "Create account"}
          </button>
        </form>
      )}
    </main>
  );
}
