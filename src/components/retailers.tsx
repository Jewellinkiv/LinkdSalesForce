"use client";
import { InboundHistory } from "./inbound";
import {
  useCallback,
  useEffect,
  useState,
  useRef,
  type ReactNode,
  type FormEvent,
} from "react";
import {
  Store,
  Upload,
  Users,
  BadgeCheck,
  CircleHelp,
  Phone,
  Camera,
  X,
  Search,
  RefreshCw,
  ArrowUpRight,
} from "lucide-react";
import { request, Dialog } from "./management";
import {
  retailerFields,
  type Retailer,
  type RetailerDetail,
  type RetailerMapping,
  type RetailerSheet,
  type RetailerPerson,
  type RetailerRow,
} from "../lib/retailers";
import type { Workspace } from "../lib/types";

const statuses: Record<string, string> = {
  unverified: "Client status unverified",
  current: "Current client",
  not_current: "Not a current client",
};
const outreach: Record<string, string> = {
  not_started: "Not started",
  contacted: "Contacted",
  replied: "Replied",
  meeting_booked: "Meeting booked",
  nurture: "Nurture",
  do_not_contact: "Do not contact",
};
const str = (f: FormData, k: string) => String(f.get(k) || "");
const localDate = (v?: string | null) => {
  const d = v ? new Date(v) : new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
};
const displayDate = (v: string | null) =>
  v ? new Date(v).toLocaleString() : "Not recorded";
async function encode(file: File) {
  if (file.size > 2000000) throw new Error("Choose a file up to 2 MB.");
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(new Error("Could not read this file."));
    reader.readAsDataURL(file);
  });
}
function Form({
  children,
  onSave,
  label = "Save",
}: {
  children: ReactNode;
  onSave: (f: FormData) => Promise<void>;
  label?: string;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <form
      className="ops-form"
      onSubmit={async (e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        const form = e.currentTarget;
        setBusy(true);
        setError("");
        try {
          await onSave(new FormData(form));
          form.reset();
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
function Field({
  name,
  label,
  value = "",
  type = "text",
  required = false,
}: {
  name: string;
  label: string;
  value?: string;
  type?: string;
  required?: boolean;
}) {
  return (
    <label>
      {label}
      <input name={name} defaultValue={value} type={type} required={required} />
    </label>
  );
}
type ListData = {
  retailers: Retailer[];
  total: number;
  groups: string[];
  tags: string[];
  stats: {
    total: number;
    current: number;
    unverified: number;
    contacted: number;
  };
};
type Preview = {
  id: string;
  created: number;
  matched: number;
  already?: boolean;
  sourceRows: number;
  warnings: { row: number; reason: string }[];
  skipped: { row: number; reason: string }[];
  sample: RetailerRow[];
};

export function Retailers({
  workspace,
  openCustomer,
}: {
  workspace: Workspace;
  openCustomer: (id: string) => void;
}) {
  const [data, setData] = useState<ListData | null>(null),
    [query, setQuery] = useState(""),
    [group, setGroup] = useState(""),
    [status, setStatus] = useState(""),
    [tag, setTag] = useState(""),
    [touch, setTouch] = useState(""),
    [page, setPage] = useState(0),
    [selected, setSelected] = useState<string[]>([]),
    [detail, setDetail] = useState<RetailerDetail | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [importing, setImporting] = useState(false);
  const loadVersion = useRef(0),
    detailVersion = useRef(0);
  const editable = ["admin", "sales"].includes(workspace.user.role);
  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    try {
      const params = new URLSearchParams({
        q: query,
        group,
        status,
        tag,
        outreach: touch,
        page: String(page),
      });
      const result = await request("retailers?" + params);
      if (version !== loadVersion.current) return;
      setData(result);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [query, group, status, tag, touch, page]);
  useEffect(() => {
    const t = setTimeout(() => void load(), 180);
    return () => clearTimeout(t);
  }, [load]);
  async function show(id: string) {
    const version = ++detailVersion.current;
    try {
      const result = await request("retailers/detail?id=" + id);
      if (version !== detailVersion.current) return;
      setDetail(result);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    if (detail)
      document
        .getElementById("retailer-profile")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [detail?.retailer.id]);
  async function save(path: string, body: unknown) {
    await request("retailers/" + path, body);
    await load();
    if (detail) await show(detail.retailer.id);
    setNotice("Saved.");
  }
  function reset() {
    setPage(0);
    setSelected([]);
  }
  return (
    <div className="retailer-hub">
      <div className="retailer-hero">
        <div>
          <span className="eyebrow">YOUR RETAILER NETWORK</span>
          <h2>Know the store. Know the people.</h2>
          <p>
            Groups, relationships, team photos, and every next conversation.
          </p>
        </div>
        {editable && (
          <button className="button primary" onClick={() => setImporting(true)}>
            <Upload size={18} /> Import retailer list
          </button>
        )}
      </div>
      <div className="retailer-metrics">
        {[
          [Store, data?.stats.total, "Retailer locations", "blue"],
          [
            BadgeCheck,
            data?.stats.current,
            "Verified current clients",
            "green",
          ],
          [
            CircleHelp,
            data?.stats.unverified,
            "Client status to verify",
            "amber",
          ],
          [Phone, data?.stats.contacted, "Recorded outreach", "violet"],
        ].map(([Icon, n, label, tone]) => {
          const Symbol = Icon as typeof Store;
          return (
            <div key={String(label)} className={"retailer-metric " + tone}>
              <Symbol size={22} />
              <strong>{String(n ?? "—")}</strong>
              <span>{String(label)}</span>
            </div>
          );
        })}
      </div>
      <p className="muted">
        Counts follow your filters. Group membership does not establish client
        status. Outreach counts include logged activity and completed live
        communications; demo sends are excluded.
      </p>
      <div className="retailer-filters">
        <label>
          <Search size={15} /> Search
          <input
            aria-label="Search retailers"
            value={query}
            placeholder="Store, city or state"
            onChange={(e) => {
              setQuery(e.target.value);
              reset();
            }}
          />
        </label>
        <label>
          Group
          <select
            value={group}
            onChange={(e) => {
              setGroup(e.target.value);
              reset();
            }}
          >
            <option value="">All groups</option>
            {data?.groups.map((g) => (
              <option key={g}>{g}</option>
            ))}
          </select>
        </label>
        <label>
          Client status
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              reset();
            }}
          >
            <option value="">All client statuses</option>
            {Object.entries(statuses).map(([v, l]) => (
              <option value={v} key={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label>
          Outreach
          <select
            value={touch}
            onChange={(e) => {
              setTouch(e.target.value);
              reset();
            }}
          >
            <option value="">All outreach stages</option>
            {Object.entries(outreach).map(([v, l]) => (
              <option value={v} key={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label>
          Tag
          <select
            value={tag}
            onChange={(e) => {
              setTag(e.target.value);
              reset();
            }}
          >
            <option value="">All tags</option>
            {data?.tags.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <button
          className="button"
          aria-label="Refresh retailers"
          onClick={load}
        >
          <RefreshCw size={17} />
        </button>
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
      {selected.length > 0 && editable && (
        <div className="retailer-bulk">
          <strong>{selected.length} selected</strong>
          <Form
            label="Apply tag"
            onSave={async (f) => {
              await save("tags", {
                ids: selected,
                tag: str(f, "tag"),
                remove: str(f, "action") === "remove",
              });
              setSelected([]);
            }}
          >
            <Field name="tag" label="Tag" required />
            <label>
              Action
              <select name="action">
                <option value="add">Add tag</option>
                <option value="remove">Remove tag</option>
              </select>
            </label>
          </Form>
        </div>
      )}
      <div className={"retailer-layout " + (detail ? "has-detail" : "")}>
        <section className="panel retailer-table">
          <div className="panel-head">
            <h3>
              <Store size={19} /> Retailers{" "}
              <span className="muted">{data?.total ?? 0}</span>
            </h3>
            {editable && (
              <label className="retailer-select">
                <input
                  type="checkbox"
                  aria-label="Select this page"
                  checked={
                    !!data?.retailers.length &&
                    data.retailers.every((r) => selected.includes(r.id))
                  }
                  onChange={(e) =>
                    setSelected(
                      e.target.checked
                        ? data?.retailers.map((r) => r.id) || []
                        : [],
                    )
                  }
                />{" "}
                Select page
              </label>
            )}
          </div>
          {!data ? (
            <p className="muted">Loading retailers…</p>
          ) : !data.total ? (
            <p className="muted">
              No retailers match. Import a list or adjust your filters.
            </p>
          ) : (
            data.retailers.map((r) => (
              <div
                className={
                  "retailer-row " +
                  (detail?.retailer.id === r.id ? "selected" : "")
                }
                key={r.id}
              >
                {editable && (
                  <input
                    aria-label={"Select " + r.name}
                    type="checkbox"
                    checked={selected.includes(r.id)}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? [...selected, r.id]
                          : selected.filter((id) => id !== r.id),
                      )
                    }
                  />
                )}
                <button className="retailer-open" onClick={() => show(r.id)}>
                  {r.photo_id ? (
                    <img
                      className="retailer-avatar"
                      src={"/api/retailers/photo?id=" + r.photo_id}
                      alt="Retailer team"
                    />
                  ) : (
                    <span className="retailer-avatar">
                      <Store size={23} />
                    </span>
                  )}
                  <span className="retailer-row-main">
                    <strong>{r.name}</strong>
                    <span className="retailer-mobile-status">
                      <span
                        className={
                          "retailer-status " + r.effective_client_status
                        }
                      >
                        {statuses[r.effective_client_status]}
                      </span>
                      <small>{outreach[r.outreach_status]}</small>
                    </span>
                    <small>
                      {[r.city, r.state, r.country]
                        .filter(Boolean)
                        .join(", ") || "Location needs review"}{" "}
                      · {r.people_count} contacts
                    </small>
                    <span className="retailer-chips">
                      {r.groups.map((g) => (
                        <span key={g} className="retailer-chip group">
                          {g}
                        </span>
                      ))}
                      {r.tags.map((t) => (
                        <span key={t} className="retailer-chip">
                          {t}
                        </span>
                      ))}
                    </span>
                  </span>
                  <span className="retailer-row-meta">
                    <span
                      className={"retailer-status " + r.effective_client_status}
                    >
                      {statuses[r.effective_client_status]}
                    </span>
                    <small>{outreach[r.outreach_status]}</small>
                    <small>
                      {r.next_at
                        ? "Next: " + new Date(r.next_at).toLocaleDateString()
                        : "No follow-up scheduled"}
                    </small>
                  </span>
                </button>
              </div>
            ))
          )}
          <div className="retailer-pagination">
            <button
              className="button"
              disabled={page === 0}
              onClick={() => {
                setPage(page - 1);
                setSelected([]);
              }}
            >
              Previous
            </button>
            <span>
              Page {page + 1} of{" "}
              {Math.max(1, Math.ceil((data?.total || 0) / 50))}
            </span>
            <button
              className="button"
              disabled={(page + 1) * 50 >= (data?.total || 0)}
              onClick={() => {
                setPage(page + 1);
                setSelected([]);
              }}
            >
              Next
            </button>
          </div>
        </section>
        {detail && (
          <aside
            id="retailer-profile"
            className="panel retailer-detail"
            key={detail.retailer.id}
          >
            <div className="panel-head">
              <div>
                <span className="eyebrow">STORE PROFILE</span>
                <h2>{detail.retailer.name}</h2>
              </div>
              <button
                className="icon-button"
                aria-label="Close retailer profile"
                onClick={() => {
                  detailVersion.current++;
                  setDetail(null);
                }}
              >
                <X size={20} />
              </button>
            </div>
            <p>
              {[
                detail.retailer.address,
                detail.retailer.city,
                detail.retailer.state,
                detail.retailer.postal,
              ]
                .filter(Boolean)
                .join(", ")}
            </p>
            <div className="retailer-chips">
              {detail.retailer.groups.map((g) => (
                <span className="retailer-chip group" key={g}>
                  {g}
                </span>
              ))}
            </div>
            <p>
              <span
                className={
                  "retailer-status " + detail.retailer.effective_client_status
                }
              >
                {statuses[detail.retailer.effective_client_status]}
              </span>{" "}
              · {detail.retailer.owner_name}
            </p>
            <p>
              <strong>Last outreach:</strong>{" "}
              {displayDate(detail.retailer.last_touch)}
            </p>
            {detail.retailer.next_at && (
              <p>
                <strong>Next:</strong> {detail.retailer.next_action} ·{" "}
                {displayDate(detail.retailer.next_at)}
              </p>
            )}
            {detail.retailer.company_id &&
              workspace.customers.some(
                (c) => c.id === detail.retailer.company_id,
              ) && (
                <button
                  className="button primary"
                  onClick={() => openCustomer(detail.retailer.company_id!)}
                >
                  Open sales record <ArrowUpRight size={16} />
                </button>
              )}
            <details className="retailer-section">
              <summary>
                <BadgeCheck size={18} /> Client verification, owner & follow-up
              </summary>
              <p className="muted">
                Match an existing Linkd account to use its lifecycle and
                communication history. Unmatched stores remain unverified until
                you record evidence.
              </p>
              <fieldset disabled={!editable}>
                <Form
                  key={detail.retailer.version}
                  onSave={async (f) =>
                    save("save", {
                      id: detail.retailer.id,
                      version: detail.retailer.version,
                      ownerId: str(f, "owner"),
                      companyId: str(f, "company"),
                      clientStatus: str(f, "status"),
                      clientEvidence: str(f, "evidence"),
                      outreachStatus: str(f, "outreach"),
                      nextAction: str(f, "action"),
                      nextAt: str(f, "next")
                        ? new Date(str(f, "next")).toISOString()
                        : "",
                      tags: str(f, "tags")
                        .split(",")
                        .map((t) => t.trim())
                        .filter(Boolean),
                    })
                  }
                >
                  <label>
                    Linked account
                    <select
                      name="company"
                      defaultValue={detail.retailer.company_id || ""}
                    >
                      <option value="">Unmatched — verify manually</option>
                      {detail.accounts.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} · {c.city} · {c.lifecycle}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Manual client status (used when unmatched)
                    <select
                      name="status"
                      defaultValue={detail.retailer.client_status}
                    >
                      {Object.entries(statuses).map(([v, l]) => (
                        <option value={v} key={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Field
                    name="evidence"
                    label="Verification evidence"
                    value={detail.retailer.client_evidence}
                  />
                  <label>
                    Assigned teammate
                    <select
                      name="owner"
                      defaultValue={detail.retailer.owner_id}
                    >
                      {workspace.users
                        .filter((u) => u.active !== false)
                        .map((u) => (
                          <option value={u.id} key={u.id}>
                            {u.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    Outreach stage
                    <select
                      name="outreach"
                      defaultValue={detail.retailer.outreach_status}
                    >
                      {Object.entries(outreach).map(([v, l]) => (
                        <option value={v} key={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Field
                    name="action"
                    label="Next action"
                    value={detail.retailer.next_action}
                  />
                  <Field
                    name="next"
                    label="Follow-up date"
                    type="datetime-local"
                    value={
                      detail.retailer.next_at
                        ? localDate(detail.retailer.next_at)
                        : ""
                    }
                  />
                  <Field
                    name="tags"
                    label="Tags (comma separated)"
                    value={detail.retailer.tags.join(", ")}
                  />
                </Form>
              </fieldset>
            </details>
            <section className="retailer-section">
              <h3>
                <Users size={18} /> Team & contacts
              </h3>
              <p className="muted">
                Source contact details are preserved as supplied. Store numbers
                and list membership do not grant email or SMS permission.
              </p>
              {detail.people.map((person) => (
                <details className="retailer-person" key={person.id}>
                  <summary>
                    <strong>{person.name || "Contact name needed"}</strong>
                    <small>
                      {person.title} {person.email}
                    </small>
                  </summary>
                  <p>{person.phone || "No phone supplied"}</p>
                  <fieldset disabled={!editable}>
                    <PersonForm
                      person={person}
                      save={(body) =>
                        save("person", {
                          ...body,
                          retailerId: detail.retailer.id,
                        })
                      }
                    />
                  </fieldset>
                </details>
              ))}
              {editable && (
                <details>
                  <summary>Add team member</summary>
                  <PersonForm
                    save={(body) =>
                      save("person", {
                        ...body,
                        retailerId: detail.retailer.id,
                      })
                    }
                  />
                </details>
              )}
            </section>
            <section className="retailer-section">
              <h3>
                <Camera size={18} /> Team photos
              </h3>
              <div className="retailer-gallery">
                {detail.photos.map((p) => (
                  <figure key={p.id}>
                    <a
                      href={"/api/retailers/photo?id=" + p.id}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <img
                        src={"/api/retailers/photo?id=" + p.id}
                        alt={p.caption}
                      />
                    </a>
                    <figcaption>
                      {p.caption}
                      {p.person_id && (
                        <small>
                          {
                            detail.people.find((c) => c.id === p.person_id)
                              ?.name
                          }
                        </small>
                      )}
                    </figcaption>
                  </figure>
                ))}
              </div>
              {!detail.photos.length && (
                <p className="muted">
                  Add a team photo and identify the people in the caption.
                </p>
              )}
              {editable && (
                <details>
                  <summary>Upload a photo</summary>
                  <Form
                    label="Upload photo"
                    onSave={async (f) => {
                      const file = f.get("photo") as File;
                      if (!file?.size) throw new Error("Choose a photo.");
                      await save("photo", {
                        id: detail.retailer.id,
                        personId: str(f, "person"),
                        requestKey: crypto.randomUUID(),
                        caption: str(f, "caption"),
                        mime: file.type,
                        data: await encode(file),
                      });
                    }}
                  >
                    <label>
                      Photo (JPEG, PNG, WebP · up to 2 MB)
                      <input
                        type="file"
                        name="photo"
                        accept="image/jpeg,image/png,image/webp"
                        required
                      />
                    </label>
                    <Field
                      name="caption"
                      label="Caption / names left to right"
                      required
                    />
                    <label>
                      Person pictured
                      <select name="person">
                        <option value="">Whole team / multiple people</option>
                        {detail.people.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name || p.email}
                          </option>
                        ))}
                      </select>
                    </label>
                  </Form>
                </details>
              )}
            </section>
            <section className="retailer-section">
              <h3>
                <Phone size={18} /> Notes & outreach
              </h3>
              {editable && (
                <Form
                  label="Record activity"
                  onSave={async (f) =>
                    save("event", {
                      id: detail.retailer.id,
                      requestKey: crypto.randomUUID(),
                      kind: str(f, "kind"),
                      body: str(f, "body"),
                      occurredAt: new Date(str(f, "occurred")).toISOString(),
                    })
                  }
                >
                  <label>
                    Activity
                    <select name="kind">
                      <option value="note">Internal note</option>
                      <option value="call">Call made</option>
                      <option value="email">Email sent</option>
                      <option value="sms">SMS sent</option>
                      <option value="meeting">Meeting held</option>
                    </select>
                  </label>
                  <label>
                    Notes
                    <textarea
                      name="body"
                      required
                      maxLength={10000}
                      placeholder="Who you spoke with, what matters, and what comes next…"
                    />
                  </label>
                  <Field
                    name="occurred"
                    label="When it happened"
                    value={localDate()}
                    type="datetime-local"
                    required
                  />
                </Form>
              )}
              <p className="muted">
                Recording activity logs work already done. Send messages and
                place calls from the linked sales record.
              </p>
              <div className="retailer-timeline">
                {detail.events.map((e) => (
                  <article key={e.id}>
                    <strong>
                      {e.kind} · {e.author}
                    </strong>
                    <small>{displayDate(e.occurred_at)}</small>
                    <p>{e.body}</p>
                  </article>
                ))}
              </div>
              <details>
                <summary>
                  Linked account history ({detail.history.length} most recent)
                </summary>
                {detail.history.length ? (
                  detail.history.map((h) => (
                    <article className="retailer-history" key={h.id}>
                      <strong>{h.kind}</strong>
                      <small>{displayDate(h.created_at)}</small>
                      <p>{h.body}</p>
                    </article>
                  ))
                ) : (
                  <p className="muted">
                    Match an account to see its messages, calls, and sales
                    activity here.
                  </p>
                )}
              </details>
            </section>
            <InboundHistory
              key={detail.retailer.id}
              retailerId={detail.retailer.id}
            />
            {editable && (
              <details className="retailer-section">
                <summary>Start sales review</summary>
                {detail.retailer.prospect_id ? (
                  <p>
                    Already added to research. Continue in{" "}
                    <a href="/?view=operations">Team workflows → Research</a>.
                  </p>
                ) : (
                  <>
                    <p>
                      Creates one research record for approval before a sales
                      lead. No messages are sent and no permission is inferred.
                    </p>
                    <Form
                      label="Add to research review"
                      onSave={async (f) =>
                        save("research", {
                          id: detail.retailer.id,
                          personId: str(f, "person"),
                        })
                      }
                    >
                      <label>
                        Primary contact
                        <select name="person" required>
                          <option value="">Choose a named contact</option>
                          {detail.people.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name || "Name needed"} · {p.email}
                            </option>
                          ))}
                        </select>
                      </label>
                    </Form>
                  </>
                )}
              </details>
            )}
            <details className="retailer-section">
              <summary>
                Source lists & original details ({detail.sources.length})
              </summary>
              {detail.sources.map((s, i) => (
                <details key={i} className="retailer-source">
                  <summary>
                    {s.group_name} · {s.list_name}
                  </summary>
                  <p>
                    {s.filename} · {s.sheet} · row {s.source_row}
                  </p>
                  <dl>
                    {Object.entries(s.raw)
                      .filter(([, v]) => v)
                      .map(([k, v]) => (
                        <div key={k}>
                          <dt>{k}</dt>
                          <dd>{v}</dd>
                        </div>
                      ))}
                  </dl>
                </details>
              ))}
            </details>
          </aside>
        )}
      </div>
      {importing && (
        <ImportRetailers
          close={() => setImporting(false)}
          applied={async (s) => {
            setNotice(
              `Import complete: ${s.created} new retailer locations, ${s.matched} rows matched to existing locations. Client status awaits verification.`,
            );
            await load();
          }}
        />
      )}
    </div>
  );
}

function PersonForm({
  person,
  save,
}: {
  person?: RetailerPerson;
  save: (body: Record<string, unknown>) => Promise<void>;
}) {
  return (
    <Form
      key={person?.version || "new"}
      label={person ? "Save contact" : "Add contact"}
      onSave={async (f) =>
        save({
          id: person?.id,
          version: person?.version,
          name: str(f, "name"),
          title: str(f, "title"),
          email: str(f, "email"),
          phone: str(f, "phone"),
          notes: str(f, "notes"),
        })
      }
    >
      <Field name="name" label="Name" value={person?.name} />
      <Field name="title" label="Role / title" value={person?.title} />
      <Field
        name="email"
        label="Email / source email text"
        value={person?.email}
      />
      <Field name="phone" label="Phone / extensions" value={person?.phone} />
      <label>
        Contact notes
        <textarea name="notes" defaultValue={person?.notes} />
      </label>
    </Form>
  );
}

function ImportRetailers({
  close,
  applied,
}: {
  close: () => void;
  applied: (s: Preview) => Promise<void>;
}) {
  const [file, setFile] = useState<{ name: string; data: string } | null>(null),
    [sheets, setSheets] = useState<RetailerSheet[]>([]),
    [sheetName, setSheetName] = useState(""),
    [header, setHeader] = useState(0),
    [mapping, setMapping] = useState<RetailerMapping>({}),
    [group, setGroup] = useState(""),
    [list, setList] = useState(""),
    [preview, setPreview] = useState<Preview | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const sheet = sheets.find((s) => s.name === sheetName);
  async function choose(f: File) {
    setBusy(true);
    setError("");
    setPreview(null);
    setFile(null);
    setSheets([]);
    try {
      const source = { name: f.name, data: await encode(f) },
        data = await request("retailers/parse", source);
      setFile(source);
      setSheets(data.sheets);
      const first =
        data.sheets.find((s: RetailerSheet) => s.mapping.name !== undefined) ||
        data.sheets[0];
      setSheetName(first.name);
      setHeader(first.headerRow);
      setMapping(first.mapping);
      setList(f.name.replace(/\.xlsx$|\.csv$/i, ""));
      setGroup(
        /\bIJO\b/i.test(f.name)
          ? "IJO"
          : /\bRJO\b/i.test(f.name)
            ? "RJO"
            : /CBG/i.test(f.name)
              ? "CBG"
              : /Centurion/i.test(f.name)
                ? "Centurion"
                : "",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="Import a retailer list" onClose={close}>
      <div className="retailer-import">
        <p>
          Upload → map columns → preview → import. Retailers enter your network
          as possible leads; messaging permissions stay unchanged.
        </p>
        <label>
          CSV or Excel (.xlsx), up to 2 MB
          <input
            type="file"
            accept=".xlsx,.csv"
            disabled={busy}
            onChange={(e) => {
              if (e.target.files?.[0]) void choose(e.target.files[0]);
            }}
          />
        </label>
        {file && sheet && (
          <>
            <div className="form-grid">
              <label>
                Worksheet
                <select
                  value={sheetName}
                  onChange={(e) => {
                    const s = sheets.find((s) => s.name === e.target.value)!;
                    setSheetName(s.name);
                    setHeader(s.headerRow);
                    setMapping(s.mapping);
                    setPreview(null);
                  }}
                >
                  {sheets.map((s) => (
                    <option key={s.name}>{s.name}</option>
                  ))}
                </select>
              </label>
              <label>
                Header row
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={header + 1}
                  onChange={(e) => {
                    setHeader(Number(e.target.value) - 1);
                    setPreview(null);
                  }}
                />
              </label>
              <label>
                Group
                <input
                  value={group}
                  onChange={(e) => {
                    setGroup(e.target.value);
                    setPreview(null);
                  }}
                  placeholder="IJO, RJO, CBG, Centurion…"
                />
              </label>
              <label>
                List / event
                <input
                  value={list}
                  onChange={(e) => {
                    setList(e.target.value);
                    setPreview(null);
                  }}
                />
              </label>
            </div>
            <details open={!preview}>
              <summary>Column mapping</summary>
              <div className="retailer-mapping">
                {retailerFields.map((field) => (
                  <label key={field}>
                    {field === "name"
                      ? "Retailer / company (required)"
                      : field.replace(/([A-Z])/g, " $1")}
                    <select
                      value={mapping[field] ?? ""}
                      onChange={(e) => {
                        const next = { ...mapping };
                        if (e.target.value === "") delete next[field];
                        else next[field] = Number(e.target.value);
                        setMapping(next);
                        setPreview(null);
                      }}
                    >
                      <option value="">Not supplied</option>
                      {sheet.rows[header]?.map((h, i) => (
                        <option key={i} value={i}>
                          {i + 1}: {h || "Unlabelled"}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            </details>
            <button
              className="button"
              disabled={
                busy ||
                !group.trim() ||
                !list.trim() ||
                mapping.name === undefined
              }
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  setPreview(
                    await request("retailers/preview", {
                      file,
                      sheet: sheetName,
                      headerRow: header,
                      mapping,
                      group,
                      list,
                    }),
                  );
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Preview import
            </button>
            {preview && (
              <div className="retailer-preview">
                <h3>
                  {preview.already
                    ? "This list has already been imported"
                    : `${preview.sourceRows} source rows ready`}
                </h3>
                <p>
                  {preview.created} new retailer locations · {preview.matched}{" "}
                  matching rows · {preview.skipped.length} excluded rows
                </p>
                <ul>
                  {preview.sample.map((r) => (
                    <li key={r.row}>
                      {r.name} · {r.city}, {r.state} ·{" "}
                      {r.contactName || "No named contact"}
                    </li>
                  ))}
                </ul>
                {(preview.warnings.length > 0 ||
                  preview.skipped.length > 0) && (
                  <details>
                    <summary>
                      {preview.warnings.length} review flags /{" "}
                      {preview.skipped.length} exclusions
                    </summary>
                    {[...preview.warnings, ...preview.skipped].map((w, i) => (
                      <p key={i}>
                        Row {w.row}: {w.reason}
                      </p>
                    ))}
                  </details>
                )}
                <p>
                  Different addresses stay separate. Shared contact destinations
                  do not merge people. All original row values are retained.
                </p>
                <button
                  className="button primary"
                  disabled={busy || preview.already}
                  onClick={async () => {
                    setBusy(true);
                    setError("");
                    try {
                      const result = await request("retailers/import", {
                        id: preview.id,
                      });
                      await applied(result);
                      close();
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {busy ? "Importing…" : "Import into retailer network"}
                </button>
              </div>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
        {busy && <p role="status">Processing list…</p>}
      </div>
    </Dialog>
  );
}
