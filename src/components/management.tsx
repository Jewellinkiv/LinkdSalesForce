"use client";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type FormEvent,
} from "react";
import type { Workspace, Customer, Project, Task, Activity } from "@/lib/types";
import { packages } from "@/lib/types";
export async function request(path: string, body?: unknown) {
  const r = await fetch(`/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await r.json();
  if (!r.ok) throw new Error(value.error || "Request failed.");
  return value;
}
const day = (value: string | null | undefined) =>
  value ? value.slice(0, 10) : "";
const local = (value: string | undefined) => {
  const d = value ? new Date(value) : new Date(Date.now() + 86400000);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
};
export function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} className="management-dialog" onCancel={onClose}>
      <div className="panel-head">
        <h2>{title}</h2>
        <button className="button" onClick={onClose} aria-label="Close editor">
          Close
        </button>
      </div>
      {children}
    </dialog>
  );
}
export type EditorState = {
  mode:
    | "edit"
    | "contact"
    | "opportunity"
    | "project"
    | "existing"
    | "task"
    | "add-task"
    | "team"
    | "automation";
  customer?: Customer;
  project?: Project;
  task?: Task;
};
const readinessLabels: Record<string, string> = {
  user_list: "User list reviewed",
  data: "POS data transfer",
  texting: "Twilio texting setup",
  branding: "Branding",
  calendar: "Company calendar",
  webchat: "Website chat",
  facebook: "Facebook",
  instagram: "Instagram",
  whatsapp: "WhatsApp",
  payments: "Payments",
  training: "Live team training",
  modules: "Academy modules assigned",
  manager: "Manager readiness",
  live: "Live operation verified",
  adoption: "30-day adoption review",
};
function defaultReady(p: Project, key: string) {
  if (p.readiness[key]) return p.readiness[key];
  const pkg = p.package;
  const na =
    (key === "data" && !["Full suite", "Data & training"].includes(pkg)) ||
    (key === "texting" && !["Full suite", "Texting"].includes(pkg)) ||
    (["branding", "calendar", "webchat"].includes(key) &&
      pkg !== "Full suite") ||
    ["facebook", "instagram", "whatsapp", "payments"].includes(key);
  return {
    status: na ? "not_applicable" : "not_started",
    notes: na ? "Outside the initial package scope" : "",
  };
}
export function Editor({
  state,
  data,
  onClose,
  onDone,
}: {
  state: EditorState;
  data: Workspace;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [error, setError] = useState(""),
    [saving, setSaving] = useState(false),
    [link, setLink] = useState("");
  const key = useRef(crypto.randomUUID());
  const c = state.customer,
    p = state.project,
    t = state.task;
  const form = useRef<HTMLFormElement>(null);
  const [contactId, setContactId] = useState(c?.contact_id || "");
  const contact = data.contacts.find((x) => x.id === contactId);
  const people = data.users.filter(
    (u) => (u as { active?: boolean }).active !== false,
  );
  const owner = (name: string, value: string | undefined, label: string) => (
    <label>
      {label}
      <select name={name} defaultValue={value || data.user.id}>
        {people.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name} · {u.role}
          </option>
        ))}
      </select>
    </label>
  );
  const field = (
    name: string,
    label: string,
    value: string | number | undefined,
    type = "text",
    required = false,
  ) => (
    <label>
      {label}
      <input
        name={name}
        defaultValue={value ?? ""}
        type={type}
        required={required}
        step={type === "number" ? "0.01" : undefined}
        min={type === "number" ? 0 : undefined}
      />
    </label>
  );
  const check = (name: string, label: string, value: boolean | undefined) => (
    <label className="checkbox-label">
      <input name={name} type="checkbox" defaultChecked={value} />
      {label}
    </label>
  );
  const packageSelect = (value: string | undefined) => (
    <label>
      Package
      <select name="package" defaultValue={value || "Undecided"}>
        {packages
          .filter((x) => state.mode !== "existing" || x !== "Undecided")
          .map((x) => (
            <option key={x}>{x}</option>
          ))}
      </select>
    </label>
  );
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setSaving(true);
    const f = new FormData(e.currentTarget);
    const str = (k: string) => String(f.get(k) || "");
    const num = (k: string) => Number(f.get(k));
    const bool = (k: string) => f.get(k) === "on";
    try {
      let route = "",
        body: unknown;
      if (state.mode === "edit" && c && contact) {
        route = "customers/edit";
        body = {
          id: c.id,
          opportunityId: c.opportunity_id,
          contactId: contact.id,
          version: c.version,
          opportunityVersion: c.opportunity_version,
          contactVersion: contact.version,
          name: str("name"),
          city: str("city"),
          pos: str("pos"),
          locations: num("locations"),
          source: str("source"),
          ownerId: str("ownerId"),
          opportunityOwnerId: str("opportunityOwnerId"),
          lifecycle: str("lifecycle"),
          doNotContact: bool("doNotContact"),
          restrictionReason: str("restrictionReason"),
          contactName: str("contactName"),
          email: str("email"),
          phone: str("phone"),
          contactDoNotContact: bool("contactDoNotContact"),
          smsConsent: bool("smsConsent"),
          emailConsent: bool("emailConsent"),
          consentSource: str("consentSource"),
          package: str("package"),
          mrr: num("mrr"),
          setup: num("setup"),
          discount: num("discount"),
          effectiveDate: str("effectiveDate"),
          appointmentAt: str("appointmentAt")
            ? new Date(str("appointmentAt")).toISOString()
            : "",
          currentMrr: str("currentMrr") === "" ? null : num("currentMrr"),
        };
      }
      if (state.mode === "contact" && c) {
        route = "contacts";
        body = {
          companyId: c.id,
          name: str("name"),
          email: str("email"),
          phone: str("phone"),
          title: str("title"),
        };
      }
      if (state.mode === "opportunity" && c) {
        route = "opportunities";
        body = {
          companyId: c.id,
          contactId: str("contactId"),
          ownerId: str("ownerId"),
          package: str("package"),
          mrr: num("mrr"),
          nextAction: str("nextAction"),
          dueAt: new Date(str("dueAt")).toISOString(),
          requestKey: key.current,
        };
      }
      if (state.mode === "existing" && c) {
        route = "onboarding/existing";
        body = {
          companyId: c.id,
          package: str("package"),
          requestKey: key.current,
        };
      }
      if (state.mode === "project" && p) {
        route = "onboarding/edit";
        body = {
          id: p.id,
          version: p.version,
          ownerId: str("ownerId"),
          csOwnerId: str("csOwnerId"),
          salesOwnerId: str("salesOwnerId"),
          targetAt: str("targetAt"),
          billingAt: str("billingAt"),
          goLiveAt: str("goLiveAt"),
          blocker: str("blocker"),
          readiness: Object.fromEntries(
            Object.keys(readinessLabels).map((k) => [
              k,
              { status: str(k), notes: str(`${k}_notes`) },
            ]),
          ),
        };
      }
      if (state.mode === "task" && t) {
        route = "tasks/edit";
        body = {
          id: t.id,
          ownerId: str("ownerId"),
          title: str("title"),
          dueAt: new Date(str("dueAt")).toISOString(),
          resolution: str("resolution"),
        };
      }
      if (state.mode === "add-task" && c) {
        route = "tasks/add";
        body = {
          companyId: c.id,
          opportunityId: c.opportunity_id,
          ownerId: str("ownerId"),
          title: str("title"),
          dueAt: new Date(str("dueAt")).toISOString(),
        };
      }
      if (state.mode === "team") {
        route = "team/invite";
        body = { name: str("name"), email: str("email"), role: str("role") };
      }
      if (state.mode === "automation") {
        route = "settings/automation";
        body = {
          welcome: bool("welcome"),
          intakeNudge: bool("intakeNudge"),
          schedulingUrl: str("schedulingUrl"),
        };
      }
      const result = await request(route, body);
      await onDone();
      if (result.url) setLink(result.url);
      else onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  const titles = {
    edit: "Edit customer and opportunity",
    contact: "Add a contact",
    opportunity: "Create another opportunity",
    project: "Onboarding readiness & owners",
    existing: "Existing-customer onboarding",
    task: "Edit task",
    "add-task": "Add a task",
    team: "Invite a team member",
    automation: "Communication automation",
  };
  return (
    <Dialog title={titles[state.mode]} onClose={onClose}>
      <form ref={form} className="modal-form" onSubmit={submit}>
        {state.mode === "edit" && c && (
          <>
            <p>
              Company details apply to every opportunity. Changes are recorded
              in the account history.
            </p>
            <div className="form-grid">
              {field("name", "Company name", c.name, "text", true)}
              {field("city", "City / state", c.city)}
              {field("pos", "Current POS", c.pos)}
              {field("locations", "Locations", c.locations, "number", true)}
              {field("source", "Source / campaign", c.source)}
              {owner("ownerId", c.owner_id, "Account owner")}
              <label>
                Customer lifecycle
                <select name="lifecycle" defaultValue={c.lifecycle}>
                  {[
                    "prospect",
                    "onboarding",
                    "active",
                    "paused",
                    "churned",
                  ].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              {field(
                "currentMrr",
                "Verified current account MRR ($)",
                c.current_mrr_cents === null ? "" : c.current_mrr_cents / 100,
                "number",
              )}
            </div>
            <p className="muted">
              Current MRR is the full recurring account amount verified by your
              team, independent of booked deals. Leave blank if unverified.
            </p>
            {check(
              "doNotContact",
              "Do not contact this company (all contacts and channels)",
              c.do_not_contact,
            )}
            {field(
              "restrictionReason",
              "Restriction reason",
              c.restriction_reason,
            )}
            <div className="form-section-label">Contact details</div>
            <label>
              Contact to edit
              <select
                value={contactId}
                onChange={(e) => setContactId(e.target.value)}
              >
                {data.contacts
                  .filter((x) => x.company_id === c.id)
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
              </select>
            </label>
            {contact && (
              <div key={contact.id}>
                <div className="form-grid">
                  {field("contactName", "Name", contact.name, "text", true)}
                  {field("email", "Email", contact.email, "email")}
                  {field("phone", "Phone (international)", contact.phone)}
                  {field(
                    "consentSource",
                    "Permission source / date",
                    contact.consent_source || "",
                  )}
                </div>
                {check(
                  "contactDoNotContact",
                  "Do not contact this person",
                  contact.do_not_contact,
                )}
                {check(
                  "smsConsent",
                  "Recorded permission to text",
                  contact.sms_consent,
                )}
                {check(
                  "emailConsent",
                  "Recorded permission to email",
                  contact.email_consent,
                )}
                {(contact.sms_opted_out || contact.email_suppressed) && (
                  <p className="notice amber">
                    Provider suppression is active. Editing permission does not
                    override a carrier opt-out or email suppression.
                  </p>
                )}
              </div>
            )}
            <div className="form-section-label">
              This opportunity · {c.kind} / {c.stage}
            </div>
            <div className="form-grid">
              {owner(
                "opportunityOwnerId",
                c.opportunity_owner_id,
                "Opportunity owner",
              )}
              {packageSelect(c.package)}
              {field(
                "mrr",
                "Booked monthly value ($)",
                c.mrr_cents / 100,
                "number",
              )}
              {field("setup", "Setup fee ($)", c.setup_cents / 100, "number")}
              {field(
                "discount",
                "Discount ($)",
                c.discount_cents / 100,
                "number",
              )}
              {field(
                "effectiveDate",
                "Effective date",
                day(c.effective_date),
                "date",
              )}
              {field(
                "appointmentAt",
                "Appointment",
                c.appointment_at ? local(c.appointment_at) : "",
                "datetime-local",
              )}
            </div>
          </>
        )}
        {state.mode === "contact" && (
          <div className="form-grid">
            {field("name", "Contact name", "", "text", true)}
            {field("email", "Email", "", "email")}
            {field("phone", "Phone (international)", "")}
            {field("title", "Role / title", "")}
          </div>
        )}
        {state.mode === "opportunity" && c && (
          <>
            <p>
              This creates a deal linked to the existing customer. Existing
              sales and onboarding history stays intact.
            </p>
            <div className="form-grid">
              <label>
                Primary contact
                <select name="contactId" defaultValue={c.contact_id}>
                  {data.contacts
                    .filter((x) => x.company_id === c.id)
                    .map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                </select>
              </label>
              {owner("ownerId", c.opportunity_owner_id, "Owner")}
              {packageSelect("Undecided")}
              {field("mrr", "Monthly value ($)", 0, "number")}
              {field("nextAction", "Next action", "", "text", true)}
              {field("dueAt", "Due", local(undefined), "datetime-local", true)}
            </div>
          </>
        )}
        {state.mode === "existing" && (
          <>
            <p>
              Open a new project for an existing customer without manufacturing
              another sale.
            </p>
            {packageSelect(
              c?.package === "Undecided" ? "Full suite" : c?.package,
            )}
          </>
        )}
        {state.mode === "project" && p && (
          <>
            <p>
              {p.company_name} · {p.package} ·{" "}
              {p.source === "new_sale" ? "New sale" : "Existing customer"}
            </p>
            <div className="form-grid">
              {owner("ownerId", p.owner_id, "Technical owner")}
              {owner(
                "csOwnerId",
                p.cs_owner_id || undefined,
                "Customer success owner",
              )}
              {owner(
                "salesOwnerId",
                p.sales_owner_id || undefined,
                "Sales / training owner",
              )}
              {field(
                "targetAt",
                "Target go-live",
                day(p.target_at),
                "date",
                true,
              )}
              {field("billingAt", "Target billing", day(p.billing_at), "date")}
              {field("goLiveAt", "Actual go-live", day(p.go_live_at), "date")}
            </div>
            {field("blocker", "Current blocker", p.blocker)}
            <p className="notice">
              Changing the target shifts open later-phase tasks. Adoption checks
              follow the actual go-live date. Evidence is required when
              verifying readiness or excluding a service.
            </p>
            <div className="readiness-grid">
              {Object.entries(readinessLabels).map(([key, label]) => {
                const value = defaultReady(p, key);
                return (
                  <div className="readiness-item" key={key}>
                    <label>
                      {label}
                      <select name={key} defaultValue={value.status}>
                        {[
                          "not_started",
                          "in_progress",
                          "verified",
                          "not_applicable",
                        ].map((status) => (
                          <option key={status} value={status}>
                            {status.replaceAll("_", " ")}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Evidence / reason
                      <textarea
                        name={`${key}_notes`}
                        defaultValue={value.notes}
                        maxLength={2000}
                      />
                    </label>
                  </div>
                );
              })}
            </div>
          </>
        )}
        {(state.mode === "task" || state.mode === "add-task") && (
          <>
            <div className="form-grid">
              {field("title", "Task", t?.title || "", "text", true)}
              {owner(
                "ownerId",
                t?.owner_id || c?.opportunity_owner_id,
                "Owner",
              )}
              {field("dueAt", "Due", local(t?.due_at), "datetime-local", true)}
              {t && (
                <label>
                  Status
                  <select name="resolution" defaultValue={t.resolution}>
                    {[
                      "open",
                      "completed",
                      ...(t.onboarding_id ? [] : ["cancelled"]),
                    ].map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          </>
        )}
        {state.mode === "team" && !link && (
          <div className="form-grid">
            {field("name", "Name", "", "text", true)}
            {field("email", "Work email", "", "email", true)}
            <label>
              Role
              <select name="role">
                <option value="sales">Sales</option>
                <option value="onboarding">Onboarding</option>
                <option value="admin">Admin</option>
              </select>
            </label>
          </div>
        )}
        {state.mode === "automation" && (
          <>
            <p>
              These rules apply to new won-deal handoffs. Permission,
              suppression, and demo/live checks still apply at delivery time.
              Staff reminders appear in Notifications.
            </p>
            {check(
              "welcome",
              "Queue welcome email with secure intake and scheduling links",
              data.automation.welcome,
            )}
            {check(
              "intakeNudge",
              "Queue missing-intake reminder after two business days",
              data.automation.intakeNudge,
            )}
            {field(
              "schedulingUrl",
              "HTTPS scheduling link",
              data.automation.schedulingUrl,
              "url",
            )}
            <p className="muted">
              Business days are Monday–Friday in UTC; holidays are not
              configured.
            </p>
          </>
        )}
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
        {link ? (
          <label>
            One-time invitation link · expires in 3 days
            <input readOnly value={link} onFocus={(e) => e.target.select()} />
            <small>Share directly with the intended teammate.</small>
          </label>
        ) : (
          <div className="form-actions">
            <button type="button" className="button" onClick={onClose}>
              Cancel
            </button>
            <button className="button primary" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        )}
      </form>
    </Dialog>
  );
}
export function HistoryPanel({
  companyId,
  revision,
}: {
  companyId: string;
  revision: string;
}) {
  const [items, setItems] = useState<Activity[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    request(`customers/history?companyId=${companyId}`)
      .then((r) => {
        if (alive) {
          setItems(r.items);
          setCursor(r.next);
          setError("");
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [companyId, revision]);
  async function more() {
    setBusy(true);
    try {
      const r = await request(
        `customers/history?companyId=${companyId}&before=${encodeURIComponent(cursor!)}`,
      );
      setItems((x) => [...x, ...r.items]);
      setCursor(r.next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="timeline">
      {items.map((a) => (
        <div key={a.id} className="timeline-event">
          <div>
            <strong>{a.title}</strong>
            <small>
              {new Date(a.created_at).toLocaleString()} ·{" "}
              {a.actor || "System / customer"}
            </small>
            <p>{a.body}</p>
          </div>
        </div>
      ))}
      {error && <p role="alert">{error}</p>}
      {cursor && (
        <button className="button" disabled={busy} onClick={more}>
          Load older activity
        </button>
      )}
    </div>
  );
}
export function IntakeReview({
  project,
  onClose,
}: {
  project: Project;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<
      {
        id: string;
        created_at: string;
        payload: Record<string, string | number>;
        files: { id: string; name: string }[];
      }[]
    >([]),
    [error, setError] = useState(""),
    [link, setLink] = useState("");
  useEffect(() => {
    request(`onboarding/intake?projectId=${project.id}`)
      .then(setRows)
      .catch((e) => setError(e.message));
  }, [project.id]);
  return (
    <Dialog title={`Intake · ${project.company_name}`} onClose={onClose}>
      <div className="modal-form">
        <button
          className="button primary"
          onClick={async () => {
            try {
              setLink(
                (await request("onboarding/intake-link", { id: project.id }))
                  .url,
              );
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          Issue new secure intake link
        </button>
        <p className="muted">
          Links expire after 30 days. Issuing a new link revokes older links.
        </p>
        {link && (
          <label>
            Customer intake link
            <input readOnly value={link} onFocus={(e) => e.target.select()} />
            <a href={link} target="_blank" rel="noreferrer">
              Open form
            </a>
          </label>
        )}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        {rows.map((row) => (
          <section className="intake-submission" key={row.id}>
            <h3>Received {new Date(row.created_at).toLocaleString()}</h3>
            <dl>
              {Object.entries(row.payload).map(([key, value]) => (
                <div key={key}>
                  <dt>{key.replace(/([A-Z])/g, " $1")}</dt>
                  <dd style={{ whiteSpace: "pre-wrap" }}>
                    {String(value) || "—"}
                  </dd>
                </div>
              ))}
            </dl>
            {row.files.map((f) => (
              <p key={f.id}>
                <a href={`/api/files/${f.id}`}>{f.name}</a>
              </p>
            ))}
          </section>
        ))}
        {!rows.length && (
          <p>No submissions yet. Send the secure link to the customer.</p>
        )}
      </div>
    </Dialog>
  );
}
export function NotificationList({
  data,
  onRead,
  onOpen,
}: {
  data: Workspace;
  onRead: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Team notifications</h2>
        <span>
          {data.notifications.filter((n) => !n.read_at).length} unread
        </span>
      </div>
      <div className="notification-list">
        {data.notifications.map((n) => (
          <article key={n.id} className={n.read_at ? "read" : ""}>
            <div>
              <strong>{n.title}</strong>
              <p>{n.body}</p>
              <small>{new Date(n.created_at).toLocaleString()}</small>
            </div>
            <div>
              {n.company_id && (
                <button
                  className="button"
                  onClick={() => onOpen(n.company_id!)}
                >
                  Open customer
                </button>
              )}
              {!n.read_at && (
                <button className="button" onClick={() => onRead(n.id)}>
                  Mark read
                </button>
              )}
            </div>
          </article>
        ))}
        {!data.notifications.length && (
          <p>
            Handoffs, intake submissions, and deadline reminders will appear
            here.
          </p>
        )}
      </div>
    </section>
  );
}
export function JobReview({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [jobs, setJobs] = useState<
      {
        id: string;
        kind: string;
        error: string;
        attempts: number;
        company_name: string;
        recipient: string;
        subject: string;
        message_id: string;
        provider_id: string;
        call_sid: string;
        recording_sid: string;
      }[]
    >([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    request("jobs/review")
      .then(setJobs)
      .catch((e) => setError(e.message));
  }, []);
  return (
    <Dialog title="Delivery and automation review" onClose={onClose}>
      <div className="modal-form">
        <p>
          Check the provider log before retrying an uncertain send. Accepted
          requests must not be resent.
        </p>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        {jobs.map((job) => (
          <form
            className="intake-submission"
            key={job.id}
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              const f = new FormData(e.currentTarget);
              try {
                await request("jobs/reconcile", {
                  id: job.id,
                  action: f.get("action"),
                  reason: f.get("reason"),
                  confirmedNotSent: f.get("confirmed") === "on",
                });
                setJobs((j) => j.filter((x) => x.id !== job.id));
                await onDone();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <h3>{job.kind.replaceAll("_", " ")}</h3>
            <small>
              Reference {job.id} · {job.attempts} attempts
            </small>
            <p>
              {job.company_name} {job.recipient} · {job.subject}
            </p>
            <small>
              Provider reference:{" "}
              {job.provider_id || job.call_sid || "not confirmed"}
              {job.message_id && ` · App message ${job.message_id}`}
              {job.recording_sid && ` · Recording ${job.recording_sid}`}
            </small>
            <p>{job.error}</p>
            <label>
              Provider reconciliation notes
              <textarea
                name="reason"
                required
                minLength={10}
                maxLength={1000}
              />
            </label>
            <label>
              Action
              <select name="action">
                <option value="resolve">Close review without sending</option>
                {job.kind !== "transcribe" && (
                  <option value="retry">
                    Retry after provider verification
                  </option>
                )}
              </select>
            </label>
            {job.kind === "send_message" && (
              <label className="checkbox-label">
                <input name="confirmed" type="checkbox" />I verified this
                request was not accepted by the provider
              </label>
            )}
            <button className="button" disabled={busy}>
              Apply review
            </button>
          </form>
        ))}
        {!jobs.length && <p>No jobs need review.</p>}
      </div>
    </Dialog>
  );
}
