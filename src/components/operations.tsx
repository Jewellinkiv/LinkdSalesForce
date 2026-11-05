"use client";
import { fileMime } from "../lib/file-mime";
import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  SearchCheck,
  Repeat2,
  Workflow,
  ContactRound,
  ShieldCheck,
  FolderArchive,
  Mail,
  ListChecks,
  Plus,
  RefreshCw,
} from "lucide-react";
import type { Workspace } from "@/lib/types";
import { request } from "./management";

type Profile = Record<string, string>;
type Company = {
  id: string;
  name: string;
  website: string;
  profile: Profile;
  version: number;
  lifecycle: string;
  contact_count: number;
};
type Contact = {
  company_ids: string[];
  id: string;
  company_id: string;
  name: string;
  email: string;
  phone: string;
  title: string;
  profile: Profile;
  version: number;
  do_not_contact: boolean;
  email_suppressed: boolean;
  sms_opted_out: boolean;
};
type Prospect = {
  website: string;
  id: string;
  name: string;
  contact_name: string;
  email: string;
  phone: string;
  notes: string;
  source: string;
  signals: string;
  fit_score: number | null;
  owner_id: string;
  status: string;
  version: number;
  review_notes: string;
};
type Cadence = {
  company_id: string;
  name: string;
  owner_id: string;
  owner_name: string;
  interval_days: number;
  next_at: string;
  enabled: boolean;
  version: number;
  last_meeting_at: string | null;
  last_contact_at: string | null;
  open_touches: number;
  lifecycle: string;
};
type Step = {
  kind: "email" | "call";
  waitDays: number;
  subject: string;
  body: string;
};
type Sequence = {
  enrollment_count: number;
  active_count: number;
  replied_count: number;
  metrics: {
    sent: number;
    simulated: number;
    opened: number;
    clicked: number;
    review: number;
  };
  id: string;
  name: string;
  active: boolean;
  timezone: string;
  start_hour: number;
  end_hour: number;
  weekdays_only: boolean;
  steps: Step[];
  version: number;
};
type Enrollment = {
  id: string;
  sequence_id: string;
  company_name: string;
  contact_name: string;
  name: string;
  status: string;
  step_index: number;
  reason: string;
  delivery_mode: string;
  next_at: string;
};
type Project = {
  target_at: string;
  blocker: string;
  id: string;
  company_id: string;
  name: string;
  phase: string;
  scope: Profile;
  version: number;
  started_at: string;
  phase_started_at: string;
  completed_at: string | null;
};
type Dependency = {
  id: string;
  name: string;
  status: string;
  owner_id: string | null;
  evidence: string;
};
type Data = {
  prospects: Prospect[];
  companies: Company[];
  contacts: Contact[];
  cadences: Cadence[];
  sequences: Sequence[];
  enrollments: Enrollment[];
  projects: Project[];
  dependencies: Dependency[];
};
const tabs = [
  ["research", "Research", SearchCheck],
  ["success", "Customer success", Repeat2],
  ["sequences", "Sequences", Workflow],
  ["directory", "Directory", ContactRound],
  ["readiness", "Service scope", ListChecks],
  ["archive", "Archive", FolderArchive],
  ["templates", "Templates", Mail],
  ["cutover", "Cutover", ShieldCheck],
] as const;
type Tab = (typeof tabs)[number][0];
const date = (v: string | null) =>
  v ? new Date(v).toLocaleString() : "Not recorded";
const local = (v?: string) => {
  const d = v ? new Date(v) : new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
};
const input = (
  name: string,
  label: string,
  value: string | number = "",
  type = "text",
  required = false,
) => (
  <label key={name}>
    {label}
    <input
      name={name}
      type={type}
      defaultValue={value}
      required={required}
      maxLength={type === "text" ? 2000 : undefined}
      step={type === "number" ? "any" : undefined}
    />
  </label>
);
const select = (
  name: string,
  label: string,
  value: string,
  options: string[],
) => (
  <label key={name}>
    {label}
    <select name={name} defaultValue={value}>
      {options.map((x) => (
        <option key={x} value={x}>
          {x.replaceAll("_", " ")}
        </option>
      ))}
    </select>
  </label>
);
function Form({
  children,
  save,
  label = "Save",
}: {
  children: ReactNode;
  save: (f: FormData) => Promise<void>;
  label?: string;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <form
      className="ops-form"
      onSubmit={async (e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          await save(new FormData(e.currentTarget));
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {children}
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      <button className="button primary" disabled={busy}>
        {busy ? "Saving…" : label}
      </button>
    </form>
  );
}
export function Operations({
  workspace,
  refresh,
}: {
  workspace: Workspace;
  refresh: () => Promise<void>;
}) {
  const [tab, setTab] = useState<Tab>("research"),
    [data, setData] = useState<Data | null>(null),
    [error, setError] = useState(""),
    [query, setQuery] = useState(""),
    [filter, setFilter] = useState("all"),
    [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    try {
      setData(await request("operations/data"));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15000);
    return () => clearInterval(timer);
  }, [load]);
  async function save(path: string, body: unknown) {
    await request(`operations/${path}`, body);
    await Promise.all([load(), refresh()]);
    setNotice("Saved.");
  }
  const owners = (name: string, value?: string) => (
    <label>
      Owner
      <select name={name} defaultValue={value || workspace.user.id}>
        {workspace.users
          .filter((u) => u.active !== false)
          .map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
      </select>
    </label>
  );
  const account = (
    name = "companyId",
    value = "",
    empty = "Choose account",
  ) => (
    <label>
      Account
      <select required name={name} defaultValue={value}>
        <option value="">{empty}</option>
        {data?.companies.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </label>
  );
  const str = (f: FormData, k: string) => String(f.get(k) || "");
  const textmatch = (...values: (string | null | undefined)[]) =>
    values.join(" ").toLowerCase().includes(query.toLowerCase());
  if (!data)
    return (
      <div className="panel ops">
        <p>{error || "Loading workflows…"}</p>
        <button className="button" onClick={load}>
          Retry
        </button>
      </div>
    );
  return (
    <div className="ops">
      <div className="ops-heading">
        <div>
          <span className="eyebrow">TEAM WORKFLOWS</span>
          <h2>From first inquiry to lasting customer</h2>
          <p>
            Review prospects, run outreach, and keep customer commitments
            visible.
          </p>
        </div>
        <button className="button" onClick={load}>
          <RefreshCw size={16} /> Refresh
        </button>
      </div>
      <div className="ops-tabs">
        {tabs.map(([id, label, Icon]) => (
          <button
            key={id}
            className={tab === id ? "active" : ""}
            onClick={() => {
              setTab(id);
              setQuery("");
              setFilter("all");
              setNotice("");
            }}
          >
            <Icon size={18} />
            {label}
          </button>
        ))}
      </div>
      {notice && (
        <p role="status" className="success-text">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      <div className="ops-toolbar">
        <input
          aria-label="Search workflows"
          placeholder="Search names and details…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {tab === "research" && (
          <select
            aria-label="Research status"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            {[
              "all",
              "research",
              "review",
              "approved",
              "suppressed",
              "converted",
            ].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        )}
        {tab === "directory" && (
          <select
            aria-label="Directory review filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            {[
              "all",
              "unverified",
              "review",
              "verified",
              "missing contacts",
              "suppressed",
            ].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        )}
      </div>
      {tab === "research" && (
        <>
          <div className="ops-banner">
            <SearchCheck />
            <div>
              <strong>Approve before outreach</strong>
              <p>
                Website inquiries arrive here for review. Conversion creates a
                lead and follow-up, preserving account links. Permission is
                never inferred from an inquiry.
              </p>
              <a href="/contact" target="_blank" rel="noreferrer">
                Open public Contact Us form ↗
              </a>
            </div>
          </div>
          <details className="panel ops-card">
            <summary>
              <Plus size={16} /> Add research prospect
            </summary>
            <Form
              label="Add to research"
              save={async (f) => {
                await save("prospect", {
                  requestKey: crypto.randomUUID(),
                  name: str(f, "name"),
                  contactName: str(f, "contactName"),
                  email: str(f, "email"),
                  phone: str(f, "phone"),
                  website: str(f, "website"),
                  source: str(f, "source"),
                  signals: str(f, "signals"),
                  notes: str(f, "notes"),
                  fitScore: str(f, "fitScore")
                    ? Number(f.get("fitScore"))
                    : null,
                });
              }}
            >
              <div className="form-grid">
                {input("name", "Company", "", "text", true)}
                {input("contactName", "Contact", "", "text", true)}
                {input("email", "Email", "", "email")}
                {input("phone", "Phone")}
                {input("website", "Website")}
                {input("source", "Source", "Research")}
                {input("fitScore", "Fit score (0–10)", "", "number")}
                {input("signals", "Target signals")}
              </div>
              <label>
                Research notes
                <textarea name="notes" maxLength={10000} />
              </label>
            </Form>
          </details>
          <div className="ops-list">
            {data.prospects
              .filter(
                (p) =>
                  (filter === "all" || p.status === filter) &&
                  textmatch(p.name, p.contact_name, p.signals, p.notes),
              )
              .map((p) => (
                <article
                  className="panel ops-card"
                  key={`${p.id}:${p.version}`}
                >
                  <div className="ops-card-title">
                    <h3>{p.name}</h3>
                    <span className={`ops-pill ${p.status}`}>{p.status}</span>
                  </div>
                  <p>
                    {p.contact_name} · {p.email || "No email"} · {p.source}
                  </p>
                  <p>
                    {p.signals}{" "}
                    {p.fit_score !== null && `· Fit ${p.fit_score}/10`}
                  </p>
                  <p className="ops-note">{p.notes}</p>
                  {p.review_notes && <p>Review: {p.review_notes}</p>}
                  {p.status !== "converted" && (
                    <details>
                      <summary>Correct research details</summary>
                      <Form
                        label="Save details"
                        save={(f) =>
                          save("prospect-edit", {
                            id: p.id,
                            version: p.version,
                            name: str(f, "name"),
                            contactName: str(f, "contactName"),
                            email: str(f, "email"),
                            phone: str(f, "phone"),
                            website: str(f, "website"),
                            source: str(f, "source"),
                            signals: str(f, "signals"),
                            fitScore:
                              str(f, "fitScore") === ""
                                ? null
                                : Number(f.get("fitScore")),
                            notes: str(f, "notes"),
                          })
                        }
                      >
                        <p>
                          Changing an approved prospect sends it back to review.
                        </p>
                        <div className="form-grid">
                          {input("name", "Company", p.name, "text", true)}
                          {input(
                            "contactName",
                            "Contact",
                            p.contact_name,
                            "text",
                            true,
                          )}
                          {input("email", "Email", p.email, "email")}
                          {input("phone", "Phone", p.phone)}
                          {input("website", "Website", p.website)}
                          {input("source", "Source", p.source)}
                          {input("signals", "Target signals", p.signals)}
                          {input(
                            "fitScore",
                            "Fit score (0–10)",
                            p.fit_score ?? "",
                            "number",
                          )}
                        </div>
                        <label>
                          Research notes
                          <textarea name="notes" defaultValue={p.notes} />
                        </label>
                      </Form>
                    </details>
                  )}

                  {p.status !== "converted" && (
                    <details>
                      <summary>Review and assign</summary>
                      <Form
                        label="Save review"
                        save={(f) =>
                          save("prospect-review", {
                            id: p.id,
                            version: p.version,
                            status: str(f, "status"),
                            ownerId: str(f, "ownerId"),
                            notes: str(f, "notes"),
                          })
                        }
                      >
                        <div className="form-grid">
                          {select("status", "Decision", p.status, [
                            "research",
                            "review",
                            "approved",
                            "suppressed",
                          ])}
                          {owners("ownerId", p.owner_id)}
                        </div>
                        <label>
                          Decision evidence
                          <textarea
                            name="notes"
                            required
                            minLength={3}
                            defaultValue={p.review_notes}
                          />
                        </label>
                      </Form>
                    </details>
                  )}
                  {p.status === "approved" && (
                    <Form
                      label="Create linked lead"
                      save={(f) =>
                        save("convert", {
                          id: p.id,
                          companyId: str(f, "companyId") || null,
                        })
                      }
                    >
                      <label>
                        Account match
                        <select name="companyId">
                          <option value="">Create a new account</option>
                          {data.companies.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    </Form>
                  )}
                </article>
              ))}
          </div>
          {!data.prospects.length && (
            <p>
              No prospects yet. Add research or submit the public inquiry form.
            </p>
          )}
        </>
      )}
      {tab === "success" && (
        <>
          <div className="ops-banner">
            <Repeat2 />
            <div>
              <strong>45-day relationship rhythm</strong>
              <p>
                When due, create a check-in task and advance the next date.
                Overdue work stays open. Paused/churned accounts do not generate
                new touches.
              </p>
            </div>
          </div>
          <details className="panel ops-card">
            <summary>Set up customer check-ins</summary>
            <Form
              save={(f) => {
                const companyId = str(f, "companyId"),
                  old = data.cadences.find((c) => c.company_id === companyId);
                return save("cadence", {
                  companyId,
                  ownerId: str(f, "ownerId"),
                  intervalDays: Number(f.get("intervalDays")),
                  nextAt: new Date(str(f, "nextAt")).toISOString(),
                  enabled: true,
                  version: old?.version || 0,
                });
              }}
            >
              <div className="form-grid">
                {account()}
                {owners("ownerId")}
                {input(
                  "intervalDays",
                  "Repeat every (days)",
                  45,
                  "number",
                  true,
                )}
                {input("nextAt", "First due", local(), "datetime-local", true)}
              </div>
            </Form>
          </details>
          <div className="ops-list">
            {data.cadences
              .filter((c) => textmatch(c.name, c.owner_name))
              .map((c) => (
                <article
                  className="panel ops-card"
                  key={`${c.company_id}:${c.version}`}
                >
                  <div className="ops-card-title">
                    <h3>{c.name}</h3>
                    <span className="ops-pill">
                      {c.enabled && c.lifecycle === "active"
                        ? "Running"
                        : !c.enabled
                          ? "Paused"
                          : `Waiting: ${c.lifecycle}`}
                    </span>
                  </div>
                  <p>
                    {c.owner_name} · Every {c.interval_days} days · Next{" "}
                    {date(c.next_at)}
                  </p>
                  <p>
                    {c.open_touches} open check-ins · Last meeting{" "}
                    {date(c.last_meeting_at)} · Last contact{" "}
                    {date(c.last_contact_at)}
                  </p>
                  <details>
                    <summary>Record a completed interaction</summary>
                    <Form
                      label="Record outcome"
                      save={(f) =>
                        save("touch", {
                          companyId: c.company_id,
                          kind: str(f, "kind"),
                          at: new Date(str(f, "at")).toISOString(),
                          notes: str(f, "notes"),
                          ...(str(f, "taskId")
                            ? { taskId: str(f, "taskId") }
                            : {}),
                        })
                      }
                    >
                      <div className="form-grid">
                        {select("kind", "Interaction", "contact", [
                          "contact",
                          "meeting",
                        ])}
                        {input(
                          "at",
                          "Completed at",
                          local(),
                          "datetime-local",
                          true,
                        )}
                      </div>
                      <label>
                        Complete a check-in task
                        <select name="taskId">
                          <option value="">Record interaction only</option>
                          {workspace.tasks
                            .filter(
                              (t) =>
                                t.company_id === c.company_id &&
                                t.resolution === "open" &&
                                t.title.includes("day customer check-in"),
                            )
                            .map((t) => (
                              <option value={t.id} key={t.id}>
                                {t.title} · {date(t.due_at)}
                              </option>
                            ))}
                        </select>
                      </label>
                      <label>
                        Outcome and next steps
                        <textarea name="notes" required />
                      </label>
                    </Form>
                  </details>
                  <details>
                    <summary>Adjust cadence</summary>
                    <Form
                      save={(f) =>
                        save("cadence", {
                          companyId: c.company_id,
                          ownerId: str(f, "ownerId"),
                          intervalDays: Number(f.get("intervalDays")),
                          nextAt: new Date(str(f, "nextAt")).toISOString(),
                          enabled: str(f, "enabled") === "yes",
                          version: c.version,
                        })
                      }
                    >
                      <div className="form-grid">
                        {owners("ownerId", c.owner_id)}
                        {input(
                          "intervalDays",
                          "Interval (days)",
                          c.interval_days,
                          "number",
                          true,
                        )}
                        {input(
                          "nextAt",
                          "Next due",
                          local(c.next_at),
                          "datetime-local",
                          true,
                        )}
                        {select(
                          "enabled",
                          "Enabled",
                          c.enabled ? "yes" : "no",
                          ["yes", "no"],
                        )}
                      </div>
                    </Form>
                  </details>
                </article>
              ))}
          </div>
        </>
      )}
      {tab === "sequences" && (
        <>
          <div className="ops-banner">
            <Workflow />
            <div>
              <strong>Outreach with a clear next step</strong>
              <p>
                Email and call-task steps run in the chosen time zone. Call
                steps wait for completion. Replies, opt-outs and closed/deferred
                opportunities stop outreach. Emails use the configured Postmark
                sender.
              </p>
            </div>
          </div>
          <SequenceEditor save={save} />
          {data.sequences
            .filter((s) => textmatch(s.name))
            .map((s) => (
              <article className="panel ops-card" key={`${s.id}:${s.version}`}>
                <div className="ops-card-title">
                  <h3>{s.name}</h3>
                  <span className="ops-pill">
                    {s.active ? "Active" : "Draft"}
                  </span>
                </div>
                <p>
                  {s.steps.length} steps · {s.timezone} · {s.start_hour}:00–
                  {s.end_hour}:00 {s.weekdays_only ? "weekdays" : ""}
                </p>
                <ol>
                  {s.steps.map((st, i) => (
                    <li key={i}>
                      {st.waitDays ? `Wait ${st.waitDays} days → ` : ""}
                      {st.kind === "email"
                        ? `Email: ${st.subject}`
                        : `Call: ${st.body}`}
                    </li>
                  ))}
                </ol>
                <div className="ops-metrics">
                  <span>
                    <b>{s.enrollment_count}</b> enrolled
                  </span>
                  <span>
                    <b>{s.active_count}</b> active
                  </span>
                  <span>
                    <b>{s.metrics.sent}</b> accepted / delivered
                  </span>
                  <span>
                    <b>{s.metrics.simulated}</b> simulated
                  </span>
                  <span>
                    <b>{s.replied_count}</b> stopped on reply
                  </span>
                  <span>
                    <b>{s.metrics.review}</b> delivery issues
                  </span>
                </div>
                <p>
                  Provider observations: {s.metrics.opened} opened ·{" "}
                  {s.metrics.clicked} clicked. Tracking is off by default; these
                  are observed counts, not a complete measure of engagement.
                </p>
                <SequenceEditor sequence={s} save={save} />
                {s.active && (
                  <details>
                    <summary>Enroll a lead or deal</summary>
                    <Form
                      label={`Enroll in ${workspace.config.communicationMode} mode`}
                      save={(f) =>
                        save("enroll", {
                          sequenceId: s.id,
                          opportunityId: str(f, "opportunityId"),
                          requestKey: crypto.randomUUID(),
                        })
                      }
                    >
                      <label>
                        Opportunity
                        <select name="opportunityId" required>
                          <option value="">Choose an open record</option>
                          {workspace.opportunities
                            .filter(
                              (o) =>
                                ![
                                  "Won",
                                  "Lost",
                                  "Qualified",
                                  "Be back",
                                ].includes(o.stage),
                            )
                            .map((o) => (
                              <option
                                value={o.opportunity_id}
                                key={o.opportunity_id}
                              >
                                {o.name} · {o.contact_name} · {o.kind}
                              </option>
                            ))}
                        </select>
                      </label>
                    </Form>
                  </details>
                )}
              </article>
            ))}
          <h3>Enrollment history</h3>
          <div className="ops-list">
            {data.enrollments
              .filter((e) => textmatch(e.name, e.company_name, e.contact_name))
              .map((e) => (
                <article className="panel ops-card" key={e.id}>
                  <div className="ops-card-title">
                    <h4>
                      {e.company_name} · {e.contact_name}
                    </h4>
                    <span className={`ops-pill ${e.status}`}>{e.status}</span>
                  </div>
                  <p>
                    {e.name} ·{" "}
                    {e.status === "completed"
                      ? "All steps complete"
                      : `Step ${e.step_index + 1}`}{" "}
                    · {e.delivery_mode} ·{" "}
                    {e.reason || `Next eligible ${date(e.next_at)}`}
                  </p>
                  <div className="ops-actions">
                    {["active", "paused"].includes(e.status) && (
                      <button
                        className="button"
                        onClick={() =>
                          save("enrollment", {
                            id: e.id,
                            status: e.status === "active" ? "paused" : "active",
                          }).catch((e) => setError(e.message))
                        }
                      >
                        {e.status === "active" ? "Pause" : "Resume"}
                      </button>
                    )}
                    {!["completed", "stopped"].includes(e.status) && (
                      <button
                        className="button"
                        onClick={() =>
                          save("enrollment", {
                            id: e.id,
                            status: "stopped",
                          }).catch((e) => setError(e.message))
                        }
                      >
                        Stop enrollment
                      </button>
                    )}
                  </div>
                </article>
              ))}
          </div>
        </>
      )}
      {tab === "directory" && (
        <>
          {["admin", "sales"].includes(workspace.user.role) && (
            <details className="panel ops-card">
              <summary>Link an existing contact to another account</summary>
              <Form
                label="Verify and link"
                save={(f) =>
                  save("contact-link", {
                    contactId: str(f, "contactId"),
                    companyId: str(f, "companyId"),
                    evidence: str(f, "evidence"),
                  })
                }
              >
                <div className="form-grid">
                  <label>
                    Contact
                    <select name="contactId" required>
                      {data.contacts.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} · {c.email || c.phone}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Account
                    <select name="companyId" required>
                      {data.companies.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label>
                  Relationship evidence
                  <textarea name="evidence" required minLength={10} />
                </label>
                <p>
                  Links share one contact identity and channel suppression.
                  Messages and calls use the selected account’s restrictions and
                  history.
                </p>
              </Form>
            </details>
          )}

          <p>
            Extra phone numbers and email addresses preserve source details.
            Outreach uses the primary destination and its recorded permission in
            Edit record.
          </p>
          <div className="ops-list">
            {data.companies
              .filter(
                (c) =>
                  textmatch(c.name, c.profile.buyingGroup) &&
                  (filter === "all" ||
                    (filter === "missing contacts" && c.contact_count === 0) ||
                    (["unverified", "verified", "review"].includes(filter) &&
                      (c.profile.verification || "unverified") === filter) ||
                    (filter === "suppressed" &&
                      data.contacts.some(
                        (ct) =>
                          ct.company_ids.includes(c.id) &&
                          (ct.do_not_contact ||
                            ct.email_suppressed ||
                            ct.sms_opted_out),
                      ))),
              )
              .map((c) => (
                <article
                  className="panel ops-card"
                  key={`${c.id}:${c.version}`}
                >
                  <div className="ops-card-title">
                    <h3>{c.name}</h3>
                    <span className="ops-pill">
                      {c.profile.verification || "unverified"}
                    </span>
                  </div>
                  <p>
                    {c.contact_count} contacts · {c.lifecycle} ·{" "}
                    {c.profile.buyingGroup}
                  </p>
                  <details>
                    <summary>Business profile and match evidence</summary>
                    <Form
                      save={(f) =>
                        save("profile", {
                          companyId: c.id,
                          version: c.version,
                          ...Object.fromEntries(
                            [
                              "website",
                              "address",
                              "country",
                              "buyingGroup",
                              "verification",
                              "notes",
                            ].map((k) => [k, str(f, k)]),
                          ),
                        })
                      }
                    >
                      <div className="form-grid">
                        {input("website", "Website", c.website)}
                        {input("address", "Address", c.profile.address)}
                        {input("country", "Country", c.profile.country)}
                        {input(
                          "buyingGroup",
                          "Buying group",
                          c.profile.buyingGroup,
                        )}
                        {select(
                          "verification",
                          "Match status",
                          c.profile.verification || "unverified",
                          ["unverified", "review", "verified"],
                        )}
                      </div>
                      <label>
                        Evidence / notes
                        <textarea name="notes" defaultValue={c.profile.notes} />
                      </label>
                    </Form>
                  </details>
                  {data.contacts
                    .filter((ct) => ct.company_ids.includes(c.id))
                    .map((ct) => (
                      <details key={`${ct.id}:${ct.version}`}>
                        <summary>
                          {ct.name} · {ct.email || ct.phone}{" "}
                          {(ct.do_not_contact ||
                            ct.email_suppressed ||
                            ct.sms_opted_out) &&
                            "· Restricted"}
                        </summary>
                        <Form
                          save={(f) =>
                            save("contact-profile", {
                              id: ct.id,
                              version: ct.version,
                              ...Object.fromEntries(
                                [
                                  "title",
                                  "firstName",
                                  "lastName",
                                  "storePhone",
                                  "directPhone",
                                  "cellPhone",
                                  "additionalEmails",
                                  "verification",
                                  "notes",
                                ].map((k) => [k, str(f, k)]),
                              ),
                            })
                          }
                        >
                          <div className="form-grid">
                            {input("title", "Role", ct.title)}
                            {input(
                              "firstName",
                              "First name",
                              ct.profile.firstName,
                            )}
                            {input(
                              "lastName",
                              "Last name",
                              ct.profile.lastName,
                            )}
                            {input(
                              "storePhone",
                              "Store phone",
                              ct.profile.storePhone,
                            )}
                            {input(
                              "directPhone",
                              "Direct phone",
                              ct.profile.directPhone,
                            )}
                            {input(
                              "cellPhone",
                              "Cell phone",
                              ct.profile.cellPhone,
                            )}
                            {input(
                              "additionalEmails",
                              "Additional emails (reference)",
                              ct.profile.additionalEmails,
                            )}
                            {select(
                              "verification",
                              "Verification",
                              ct.profile.verification || "unverified",
                              ["unverified", "review", "verified"],
                            )}
                          </div>
                          <label>
                            Verification evidence
                            <textarea
                              name="notes"
                              defaultValue={ct.profile.notes}
                            />
                          </label>
                        </Form>
                      </details>
                    ))}
                </article>
              ))}
          </div>
        </>
      )}
      {tab === "readiness" && (
        <>
          <p>
            Track the actual services and prerequisites purchased. Readiness
            evidence and phase advancement remain in Onboarding. Store
            authorization references here; attach documents in Archive.
          </p>
          <div className="ops-list">
            {data.projects
              .filter((p) => textmatch(p.name, p.phase))
              .map((p) => (
                <article
                  className="panel ops-card"
                  key={`${p.id}:${p.version}`}
                >
                  <div className="ops-card-title">
                    <h3>{p.name}</h3>
                    <span className="ops-pill">{p.phase}</span>
                  </div>
                  <p>
                    {Math.max(
                      0,
                      Math.floor(
                        (new Date(p.completed_at || Date.now()).getTime() -
                          new Date(p.started_at).getTime()) /
                          86400000,
                      ),
                    )}{" "}
                    days total ·{" "}
                    {Math.max(
                      0,
                      Math.floor(
                        (new Date(p.completed_at || Date.now()).getTime() -
                          new Date(p.phase_started_at).getTime()) /
                          86400000,
                      ),
                    )}{" "}
                    days in phase
                  </p>
                  <p
                    className={
                      !p.completed_at && new Date(p.target_at) < new Date()
                        ? "error-text"
                        : ""
                    }
                  >
                    Target: {new Date(p.target_at).toLocaleDateString()}
                    {!p.completed_at && new Date(p.target_at) < new Date()
                      ? " · Overdue"
                      : ""}
                    {p.blocker ? ` · Blocked: ${p.blocker}` : ""}
                  </p>
                  <details>
                    <summary>Edit service scope and prerequisites</summary>
                    <Form
                      save={(f) =>
                        save("scope", {
                          id: p.id,
                          version: p.version,
                          scope: Object.fromEntries(
                            [
                              "dataMethod",
                              "dataStarted",
                              "dataCompleted",
                              "textingProvider",
                              "numberChoice",
                              "hostedNumber",
                              "authorizationStatus",
                              "authorizationReference",
                              "registrationStatus",
                              "verificationCallAt",
                              "edtLicense",
                              "paymentStatus",
                              "productModules",
                              "trainingModules",
                              "notes",
                            ].map((k) => [
                              k,
                              [
                                "dataStarted",
                                "dataCompleted",
                                "verificationCallAt",
                              ].includes(k)
                                ? str(f, k)
                                  ? new Date(str(f, k)).toISOString()
                                  : ""
                                : str(f, k),
                            ]),
                          ),
                        })
                      }
                    >
                      <div className="form-grid">
                        {input(
                          "dataMethod",
                          "Data transfer method (BIG / EDT / export)",
                          p.scope.dataMethod,
                        )}
                        {input(
                          "dataStarted",
                          "Data started",
                          p.scope.dataStarted ? local(p.scope.dataStarted) : "",
                          "datetime-local",
                        )}
                        {input(
                          "dataCompleted",
                          "Data completed",
                          p.scope.dataCompleted
                            ? local(p.scope.dataCompleted)
                            : "",
                          "datetime-local",
                        )}
                        {input(
                          "textingProvider",
                          "Texting provider",
                          p.scope.textingProvider,
                        )}
                        {input(
                          "numberChoice",
                          "Number plan",
                          p.scope.numberChoice,
                        )}
                        {input(
                          "hostedNumber",
                          "Hosted number",
                          p.scope.hostedNumber,
                        )}
                        {input(
                          "authorizationStatus",
                          "LOA / authorization status",
                          p.scope.authorizationStatus,
                        )}
                        {input(
                          "authorizationReference",
                          "Authorization document reference",
                          p.scope.authorizationReference,
                        )}
                        {input(
                          "registrationStatus",
                          "Texting registration / EIN verification status",
                          p.scope.registrationStatus,
                        )}
                        {input(
                          "verificationCallAt",
                          "Store verification call",
                          p.scope.verificationCallAt
                            ? local(p.scope.verificationCallAt)
                            : "",
                          "datetime-local",
                        )}
                        {input("edtLicense", "EDT license", p.scope.edtLicense)}
                        {input(
                          "paymentStatus",
                          "Payment / approved terms status",
                          p.scope.paymentStatus,
                        )}
                        {input(
                          "productModules",
                          "Product modules and add-ons",
                          p.scope.productModules,
                        )}
                        {input(
                          "trainingModules",
                          "Role-based Academy assignments",
                          p.scope.trainingModules,
                        )}
                      </div>
                      <label>
                        Evidence and notes
                        <textarea name="notes" defaultValue={p.scope.notes} />
                      </label>
                    </Form>
                  </details>
                </article>
              ))}
          </div>
        </>
      )}
      {tab === "archive" && (
        <Archive companies={data.companies} query={query} />
      )}
      {tab === "templates" && (
        <>
          <div className="ops-banner">
            <Mail />
            <div>
              <strong>Reusable team emails</strong>
              <p>
                Variables: {"{{contact}}, {{company}}, {{phase}}"}. Automatic
                phase delivery also requires the rule in Settings. Each phase
                supports one active automatic template. Messages already queued
                retain their content.
              </p>
            </div>
          </div>
          {workspace.user.role === "admin" && <TemplateEditor save={save} />}{" "}
          {workspace.templates.map((t) => (
            <article className="panel ops-card" key={`${t.id}:${t.version}`}>
              <div className="ops-card-title">
                <h3>{t.name}</h3>
                <span className="ops-pill">
                  {!t.active
                    ? "Inactive"
                    : t.automatic
                      ? "Automatic"
                      : "Manual"}
                </span>
              </div>
              <p>
                {t.phase || "Any phase"} · {t.subject}
              </p>
              <p className="ops-note">{t.body}</p>
              {workspace.user.role === "admin" && (
                <TemplateEditor template={t} save={save} />
              )}
            </article>
          ))}
        </>
      )}
      {tab === "cutover" && (
        <>
          <div className="ops-banner">
            <ShieldCheck />
            <div>
              <strong>Resolve dependencies with evidence</strong>
              <p>
                Record the responsible owner, verified behavior and replacement
                test. A saved status is a team assertion; it does not validate
                external systems automatically.
              </p>
            </div>
          </div>
          {data.dependencies.map((d) => (
            <article className="panel ops-card" key={d.id}>
              <div className="ops-card-title">
                <h3>{d.name}</h3>
                <span className="ops-pill">{d.status}</span>
              </div>
              <p>
                {d.evidence ||
                  "Awaiting source configuration or acceptance evidence."}
              </p>
              {workspace.user.role === "admin" && (
                <details>
                  <summary>Record resolution</summary>
                  <Form
                    save={(f) =>
                      save("dependency", {
                        id: d.id,
                        status: str(f, "status"),
                        ownerId: str(f, "ownerId"),
                        evidence: str(f, "evidence"),
                      })
                    }
                  >
                    <div className="form-grid">
                      {owners("ownerId", d.owner_id || undefined)}
                      {select("status", "Disposition", d.status, [
                        "unverified",
                        "retained",
                        "replaced",
                        "retired",
                      ])}
                    </div>
                    <label>
                      Evidence and acceptance result
                      <textarea
                        name="evidence"
                        required
                        minLength={10}
                        defaultValue={d.evidence}
                      />
                    </label>
                  </Form>
                </details>
              )}
            </article>
          ))}
        </>
      )}
    </div>
  );
}
function SequenceEditor({
  sequence,
  save,
}: {
  sequence?: Sequence;
  save: (path: string, body: unknown) => Promise<void>;
}) {
  const [steps, setSteps] = useState<Step[]>(
    sequence?.steps || [{ kind: "email", waitDays: 0, subject: "", body: "" }],
  );
  const change = (i: number, patch: Partial<Step>) =>
    setSteps((old) => old.map((s, n) => (n === i ? { ...s, ...patch } : s)));
  return (
    <details className="panel ops-card">
      <summary>
        {sequence ? "Edit future enrollments" : "Create sequence"}
      </summary>
      <Form
        label="Save sequence"
        save={(f) =>
          save("sequence", {
            ...(sequence ? { id: sequence.id, version: sequence.version } : {}),
            name: String(f.get("name")),
            active: f.get("active") === "yes",
            timezone: String(f.get("timezone")),
            startHour: Number(f.get("startHour")),
            endHour: Number(f.get("endHour")),
            weekdaysOnly: f.get("weekdaysOnly") === "yes",
            steps,
          })
        }
      >
        <p>
          Existing enrollments keep their original steps. Variables:{" "}
          {"{{contact}}"} and {"{{company}}"}. Call steps wait for the assigned
          task to be completed.
        </p>
        <div className="form-grid">
          {input("name", "Sequence name", sequence?.name || "", "text", true)}
          {select(
            "active",
            "New enrollments",
            sequence?.active ? "yes" : "no",
            ["no", "yes"],
          )}
          {input(
            "timezone",
            "Time zone",
            sequence?.timezone || "America/Chicago",
            "text",
            true,
          )}
          {input(
            "startHour",
            "Send window start hour",
            sequence?.start_hour ?? 9,
            "number",
            true,
          )}
          {input(
            "endHour",
            "Send window end hour",
            sequence?.end_hour ?? 17,
            "number",
            true,
          )}
          {select(
            "weekdaysOnly",
            "Weekdays only",
            sequence?.weekdays_only === false ? "no" : "yes",
            ["yes", "no"],
          )}
        </div>
        {steps.map((s, i) => (
          <div className="ops-step" key={i}>
            <strong>Step {i + 1}</strong>
            <div className="form-grid">
              <label>
                Type
                <select
                  value={s.kind}
                  onChange={(e) =>
                    change(i, { kind: e.target.value as Step["kind"] })
                  }
                >
                  <option value="email">Automatic email</option>
                  <option value="call">Call task</option>
                </select>
              </label>
              <label>
                Wait days after prior completion
                <input
                  type="number"
                  min={0}
                  max={365}
                  value={s.waitDays}
                  onChange={(e) =>
                    change(i, { waitDays: Number(e.target.value) })
                  }
                />
              </label>
            </div>
            {s.kind === "email" && (
              <label>
                Subject
                <input
                  required
                  value={s.subject}
                  maxLength={200}
                  onChange={(e) => change(i, { subject: e.target.value })}
                />
              </label>
            )}
            <label>
              {s.kind === "email" ? "Email body" : "Call instructions"}
              <textarea
                required
                maxLength={9000}
                value={s.body}
                onChange={(e) => change(i, { body: e.target.value })}
              />
            </label>
            {steps.length > 1 && (
              <button
                className="button"
                type="button"
                onClick={() => setSteps((old) => old.filter((_, n) => n !== i))}
              >
                Remove step
              </button>
            )}
          </div>
        ))}
        <button
          className="button"
          type="button"
          disabled={steps.length >= 30}
          onClick={() =>
            setSteps([
              ...steps,
              { kind: "call", waitDays: 0, subject: "", body: "" },
            ])
          }
        >
          <Plus size={16} /> Add step
        </button>
      </Form>
    </details>
  );
}
function Archive({
  companies,
  query,
}: {
  companies: Company[];
  query: string;
}) {
  const [kind, setKind] = useState("messages"),
    [company, setCompany] = useState(""),
    [offset, setOffset] = useState(0),
    [result, setResult] = useState<{
      rows: Record<string, unknown>[];
      more: boolean;
    }>({ rows: [], more: false }),
    [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setResult(
        await request(
          `operations/archive?kind=${kind}&companyId=${company}&offset=${offset}&q=${encodeURIComponent(query)}`,
        ),
      );
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [kind, company, offset, query]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => setOffset(0), [kind, company, query]);
  return (
    <>
      <div className="ops-toolbar">
        <select
          aria-label="Archive type"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          {["messages", "calls", "files"].map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
        <select
          aria-label="Archive account"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
        >
          <option value="">All accounts</option>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      {error && <p className="error-text">{error}</p>}
      {kind === "files" && (
        <details className="panel ops-card">
          <summary>Attach customer document</summary>
          <Form
            label="Upload attachment"
            save={async (f) => {
              const file = f.get("file") as File;
              if (!file?.size || file.size > 2000000)
                throw new Error("Choose a file up to 2 MB.");
              const data = await new Promise<string>((resolve, reject) => {
                const r = new FileReader();
                r.onload = () => resolve(String(r.result).split(",")[1]);
                r.onerror = reject;
                r.readAsDataURL(file);
              });
              await request("operations/file", {
                companyId: f.get("companyId"),
                name: file.name,
                mime: fileMime(file.name),
                data,
              });
              await load();
            }}
          >
            <label>
              Account
              <select required name="companyId" defaultValue={company}>
                <option value="">Choose account</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              File
              <input
                type="file"
                name="file"
                required
                accept=".csv,.txt,.pdf,.xlsx,.docx"
              />
            </label>
          </Form>
        </details>
      )}
      {result.rows.map((r) => (
        <article key={String(r.id)} className="panel ops-card">
          <h3>
            {String(r.company_name || "Unmatched")} ·{" "}
            {String(r.subject || r.name || r.status || "Activity")}
          </h3>
          <p>{date(String(r.created_at))}</p>
          {kind === "files" ? (
            <a href={`/api/operations/file?id=${r.id}`}>
              Download {String(r.name)}
            </a>
          ) : (
            <p className="ops-note">
              {kind === "calls"
                ? String(r.summary || "") +
                  "\n" +
                  (Array.isArray(r.transcript)
                    ? r.transcript
                        .map(
                          (s: { speaker: string; text: string }) =>
                            `${s.speaker}: ${s.text}`,
                        )
                        .join("\n")
                    : "")
                : String(r.body || "")}
            </p>
          )}
        </article>
      ))}
      {!result.rows.length && <p>No matching records.</p>}
      <div className="ops-actions">
        <button
          className="button"
          disabled={!offset}
          onClick={() => setOffset(Math.max(0, offset - 50))}
        >
          Previous
        </button>
        <span>Page {Math.floor(offset / 50) + 1}</span>
        <button
          className="button"
          disabled={!result.more}
          onClick={() => setOffset(offset + 50)}
        >
          Next
        </button>
      </div>
    </>
  );
}

function TemplateEditor({
  template,
  save,
}: {
  template?: Workspace["templates"][number];
  save: (path: string, body: unknown) => Promise<void>;
}) {
  return (
    <details className="panel ops-card">
      <summary>{template ? "Edit template" : "Create template"}</summary>
      <Form
        label="Save template"
        save={(f) =>
          save("template", {
            ...(template ? { id: template.id, version: template.version } : {}),
            name: String(f.get("name")),
            subject: String(f.get("subject")),
            body: String(f.get("body")),
            phase: String(f.get("phase")),
            active: f.get("active") === "yes",
            automatic: f.get("automatic") === "yes",
          })
        }
      >
        <div className="form-grid">
          {input("name", "Template name", template?.name, "text", true)}
          {input("subject", "Subject", template?.subject, "text", true)}
          {select("phase", "Phase", template?.phase || "", [
            "",
            "Intake & pre-build",
            "Working session",
            "Training",
            "Go-live",
            "Adoption",
          ])}
          {select(
            "active",
            "Available",
            template?.active === false ? "no" : "yes",
            ["yes", "no"],
          )}
          {select(
            "automatic",
            "Automatic phase email",
            template?.automatic ? "yes" : "no",
            ["no", "yes"],
          )}
        </div>
        <label>
          Email body
          <textarea
            name="body"
            required
            maxLength={9000}
            defaultValue={template?.body}
          />
        </label>
      </Form>
    </details>
  );
}
