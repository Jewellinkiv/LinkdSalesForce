"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  CalendarDays,
  Globe2,
  Inbox,
  Link2,
  Plus,
  RefreshCw,
  Settings2,
  ExternalLink,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import { Dialog, request } from "./management";
import {
  brandNames,
  inboundBrands,
  type InboundBrand,
  type InboundData,
  type InboundRecord,
  type InboundRouting,
} from "@/lib/inbound";
import type { Workspace } from "@/lib/types";
const date = (s: string | null) =>
  s
    ? new Date(s).toLocaleString([], {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "Not scheduled";
const value = (f: FormData, k: string) => String(f.get(k) || "");
const localTime = (s: Date) =>
  new Date(s.getTime() - s.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
type Detail = {
  record: InboundRecord;
  events: {
    id: string;
    title: string;
    body: string;
    actor: string | null;
    occurred_at: string;
  }[];
  related: { id: string; title: string; status: string; starts_at: string }[];
};
function BrandOptions() {
  return (
    <>
      {inboundBrands.map((b) => (
        <option key={b} value={b}>
          {brandNames[b]}
        </option>
      ))}
    </>
  );
}
function bookingLink(url: string, brand: string, r?: InboundRecord) {
  const u = new URL(url);
  u.searchParams.set("utm_source", brand);
  u.searchParams.set("utm_medium", "sales_force");
  if (r) {
    u.searchParams.set("name", r.name);
    u.searchParams.set("email", r.email);
  }
  return u.href;
}

export function Inbound({
  workspace,
  refresh,
}: {
  workspace: Workspace;
  refresh: () => Promise<void>;
}) {
  const [data, setData] = useState<InboundData | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [brand, setBrand] = useState(""),
    [kind, setKind] = useState(""),
    [filter, setFilter] = useState(""),
    [search, setSearch] = useState(""),
    [offset, setOffset] = useState(0);
  const [detail, setDetail] = useState<Detail | null>(null),
    [routing, setRouting] = useState<InboundRouting | null>(null),
    [showSetup, setShowSetup] = useState(false),
    [manual, setManual] = useState(false),
    [busy, setBusy] = useState(false);
  const [storeQuery, setStoreQuery] = useState(""),
    [stores, setStores] = useState<
      { id: string; name: string; city: string; state: string }[]
    >([]);
  const sequence = useRef(0),
    detailSequence = useRef(0);
  const editable = ["admin", "sales"].includes(workspace.user.role);
  const load = useCallback(async () => {
    const seq = ++sequence.current;
    try {
      const d = await request(
        "inbound?" +
          new URLSearchParams({
            brand,
            kind,
            filter,
            q: search,
            offset: String(offset),
          }),
      );
      if (seq === sequence.current) setData(d);
    } catch (e) {
      if (seq === sequence.current) setError((e as Error).message);
    }
  }, [brand, kind, filter, search, offset]);
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("record");
    if (id && /^[a-f0-9-]{36}$/.test(id)) void show(id);
  }, []);
  useEffect(() => {
    const t = setTimeout(() => void load(), 180);
    return () => {
      clearTimeout(t);
      sequence.current++;
    };
  }, [load]);
  useEffect(() => {
    let active = true;
    const t = setTimeout(() => {
      request("inbound/retailers?q=" + encodeURIComponent(storeQuery))
        .then((v) => {
          if (active) setStores(v);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    }, 200);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [storeQuery]);
  async function show(id: string) {
    const seq = ++detailSequence.current;
    setError("");
    try {
      const d = await request("inbound/detail?id=" + id);
      if (seq === detailSequence.current) setDetail(d);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function act(path: string, body: unknown, message: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const r = await request(path, body);
      await load();
      await refresh();
      setNotice(message);
      return r;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }
  function change(setter: (v: string) => void, v: string) {
    setter(v);
    setOffset(0);
  }
  if (!data)
    return (
      <div className="panel inbound-empty">
        {error || "Loading inquiries and bookings…"}
      </div>
    );
  return (
    <>
      {error && (
        <p role="alert" className="inbound-alert">
          <AlertCircle size={18} />
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="inbound-success">
          <CheckCircle2 size={18} />
          {notice}
        </p>
      )}
      <div className="inbound-metrics">
        {[
          ["Website inquiries", data.stats.forms, Globe2, "blue"],
          ["Upcoming meetings", data.stats.upcoming, CalendarDays, "violet"],
          ["Awaiting review", data.stats.needs_review, Inbox, "amber"],
          ["Unlinked / ambiguous", data.stats.unlinked, Link2, "teal"],
        ].map(([label, n, Icon, tone]) => {
          const I = Icon as typeof Globe2;
          return (
            <div className={"inbound-metric " + tone} key={String(label)}>
              <I size={24} />
              <strong>{String(n)}</strong>
              <span>{String(label)}</span>
            </div>
          );
        })}
      </div>
      <div className="operations-toolbar">
        {editable && (
          <button className="button primary" onClick={() => setManual(true)}>
            <Plus size={16} />
            Record a meeting
          </button>
        )}
        <button className="button" onClick={() => setShowSetup(!showSetup)}>
          <Settings2 size={16} />
          {showSetup ? "Hide" : "Sources & booking links"}
        </button>
        <button className="button" onClick={() => void load()}>
          <RefreshCw size={16} />
          Refresh
        </button>
      </div>
      {showSetup && (
        <section className="panel inbound-setup">
          <div className="panel-head">
            <div>
              <h2>Websites & Calendly</h2>
              <p>
                Route inquiries to the right owner and keep the whole team
                informed.
              </p>
            </div>
          </div>
          <div className="inbound-source-grid">
            {data.routing
              .filter((r) => r.brand !== "unknown")
              .map((r) => (
                <article key={r.brand} className={"inbound-source " + r.brand}>
                  <Globe2 size={22} />
                  <h3>{brandNames[r.brand]}</h3>
                  <p>
                    {r.received} inquiries ·{" "}
                    {r.configured
                      ? "Signing key configured"
                      : "Awaiting website connection"}
                  </p>
                  <small>
                    Last received:{" "}
                    {r.last_received
                      ? date(r.last_received)
                      : "No deliveries yet"}
                  </small>
                  {r.booking_url && (
                    <a
                      className="button"
                      target="_blank"
                      rel="noopener noreferrer"
                      href={bookingLink(r.booking_url, r.brand)}
                    >
                      Open booking page <ExternalLink size={14} />
                    </a>
                  )}
                  {!r.booking_url && (
                    <p className="muted">No booking link configured.</p>
                  )}
                  {workspace.user.role === "admin" && (
                    <button className="button" onClick={() => setRouting(r)}>
                      Configure {brandNames[r.brand]}
                    </button>
                  )}
                </article>
              ))}
          </div>
          <p>
            <strong>Calendly:</strong>{" "}
            {data.calendly.configured
              ? "Signing key configured"
              : "Awaiting signing key and webhook subscription"}{" "}
            · {data.calendly.verifiedEvents} verified events.{" "}
            {data.calendly.lastReceived &&
              `Last event: ${date(data.calendly.lastReceived)}.`}
          </p>
          <p className="muted">
            In-app alerts go to the owner and configured teammates. With no
            recipients selected, all active sales/admin teammates receive
            alerts. Staff email delivery follows Settings → Configure
            automations. Booking links open Calendly; schedule changes sync once
            its webhook is connected.
          </p>
          {workspace.user.role === "admin" && (
            <button
              className="text-button"
              onClick={() =>
                setRouting(data.routing.find((r) => r.brand === "unknown")!)
              }
            >
              Configure bookings with an unassigned brand
            </button>
          )}
        </section>
      )}
      <section className="panel">
        <div className="inbound-filters">
          <input
            aria-label="Search inquiries and bookings"
            placeholder="Search name, email, store…"
            value={search}
            onChange={(e) => change(setSearch, e.target.value)}
          />
          <select
            aria-label="Website source"
            value={brand}
            onChange={(e) => change(setBrand, e.target.value)}
          >
            <option value="">All brands</option>
            <BrandOptions />
          </select>
          <select
            aria-label="Record type"
            value={kind}
            onChange={(e) => change(setKind, e.target.value)}
          >
            <option value="">Forms & bookings</option>
            <option value="form">Website forms</option>
            <option value="booking">Meetings</option>
          </select>
          <select
            aria-label="Intake filter"
            value={filter}
            onChange={(e) => change(setFilter, e.target.value)}
          >
            <option value="">All active records</option>
            <option value="review">Awaiting review</option>
            <option value="unlinked">Needs an account / store</option>
            <option value="upcoming">Upcoming meetings</option>
            <option value="archived">Archived</option>
          </select>
        </div>
        <div className="inbound-list">
          {data.records.map((r) => (
            <button
              className="inbound-row"
              key={r.id}
              onClick={() => void show(r.id)}
            >
              <span className={"inbound-row-icon " + r.kind}>
                {r.kind === "booking" ? (
                  <CalendarDays size={22} />
                ) : (
                  <Globe2 size={22} />
                )}
              </span>
              <span className="inbound-row-main">
                <strong>{r.title}</strong>
                <span>
                  {r.name} ·{" "}
                  {r.company_name ||
                    r.linked_company_name ||
                    r.retailer_name ||
                    r.email}
                </span>
                <small>
                  {brandNames[r.brand]} · {r.owner_name} ·{" "}
                  {r.provider === "manual"
                    ? "Recorded manually"
                    : r.kind === "booking"
                      ? "Calendly"
                      : "Website form"}
                </small>
              </span>
              <span className="inbound-row-meta">
                <strong>
                  {r.kind === "booking"
                    ? date(r.starts_at)
                    : date(r.created_at)}
                </strong>
                <span className={"inbound-pill " + r.status}>
                  {r.status.replaceAll("_", " ")}
                  {r.outcome ? ` · ${r.outcome.replaceAll("_", " ")}` : ""}
                </span>
                <small>
                  {r.match_status === "ambiguous"
                    ? "Account match needs review"
                    : r.linked_company_name ||
                      r.retailer_name ||
                      (r.prospect_id ? "Research prospect" : "Not linked")}{" "}
                  · {r.review_status}
                </small>
              </span>
            </button>
          ))}
        </div>
        {!data.records.length && (
          <div className="inbound-empty">
            <Inbox size={32} />
            <h3>
              No{" "}
              {filter === "upcoming"
                ? "upcoming meetings"
                : "matching inquiries or bookings"}{" "}
              yet
            </h3>
            <p>
              Website submissions and Calendly events will arrive here once
              connected. You can record a call or demo now.
            </p>
          </div>
        )}
        <div className="panel-head">
          <small>
            {data.total
              ? `${offset + 1}–${Math.min(offset + 50, data.total)} of ${data.total}`
              : "0 records"}
          </small>
          <div className="operations-toolbar">
            <button
              className="button"
              disabled={!offset}
              onClick={() => setOffset(Math.max(0, offset - 50))}
            >
              Previous
            </button>
            <button
              className="button"
              disabled={offset + 50 >= data.total}
              onClick={() => setOffset(offset + 50)}
            >
              Next
            </button>
          </div>
        </div>
      </section>
      {detail && (
        <Dialog
          title={detail.record.title}
          onClose={() => {
            detailSequence.current++;
            setDetail(null);
            setError("");
          }}
        >
          <div className="inbound-detail">
            {error && (
              <p role="alert" className="inbound-alert">
                {error}
              </p>
            )}
            <p className="eyebrow">
              {brandNames[detail.record.brand]} · {detail.record.kind} ·{" "}
              {detail.record.status}
            </p>
            <h3>{detail.record.name}</h3>
            <p>
              {detail.record.company_name} · {detail.record.email}
              {detail.record.phone && ` · ${detail.record.phone}`}
            </p>
            {detail.record.kind === "booking" && (
              <div className="inbound-meeting">
                <CalendarDays size={24} />
                <div>
                  <strong>
                    {date(detail.record.starts_at)} –{" "}
                    {date(detail.record.ends_at)}
                  </strong>
                  <p>
                    Times shown in your browser’s timezone. Invitee:{" "}
                    {detail.record.timezone || "not provided"}
                  </p>
                  <p>
                    {detail.record.details.host}
                    {detail.record.details.location &&
                      ` · ${detail.record.details.location}`}
                  </p>
                </div>
              </div>
            )}
            <div className="operations-toolbar">
              {detail.record.details.joinUrl && (
                <a
                  className="button primary"
                  href={detail.record.details.joinUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Join meeting
                </a>
              )}
              {detail.record.status === "scheduled" &&
                detail.record.details.rescheduleUrl && (
                  <a
                    className="button"
                    href={detail.record.details.rescheduleUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Reschedule in Calendly
                  </a>
                )}
              {detail.record.status === "scheduled" &&
                detail.record.details.cancelUrl && (
                  <a
                    className="button"
                    href={detail.record.details.cancelUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Cancel in Calendly
                  </a>
                )}
              {data.routing
                .filter((r) => r.booking_url && r.brand === detail.record.brand)
                .map((r) => (
                  <a
                    key={r.brand}
                    className="button"
                    href={bookingLink(r.booking_url, r.brand, detail.record)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Book a follow-up <ExternalLink size={14} />
                  </a>
                ))}
            </div>
            {detail.record.details.message && (
              <p className="inbound-pre">{detail.record.details.message}</p>
            )}
            {detail.record.details.pageUrl && (
              <p>
                Page:{" "}
                <a
                  href={detail.record.details.pageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {detail.record.details.pageUrl}
                </a>
              </p>
            )}
            <dl className="inbound-fields">
              {Object.entries(detail.record.details.fields || {}).map(
                ([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ),
              )}
              {detail.record.details.questions?.map((q, i) => (
                <div key={i}>
                  <dt>{q.question}</dt>
                  <dd>{q.answer}</dd>
                </div>
              ))}
            </dl>
            {Object.values(detail.record.details.tracking || {}).some(
              Boolean,
            ) && (
              <details>
                <summary>Campaign attribution</summary>
                <dl className="inbound-fields">
                  {Object.entries(detail.record.details.tracking || {})
                    .filter(([, v]) => v)
                    .map(([k, v]) => (
                      <div key={k}>
                        <dt>{k}</dt>
                        <dd>{v}</dd>
                      </div>
                    ))}
                </dl>
              </details>
            )}
            {editable && (
              <form
                className="ops-form"
                key={detail.record.id + ":" + detail.record.version}
                onSubmit={async (e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  if (
                    await act(
                      "inbound/update",
                      {
                        id: detail.record.id,
                        version: detail.record.version,
                        companyId: value(f, "companyId") || null,
                        retailerId: value(f, "retailerId") || null,
                        ownerId: value(f, "ownerId"),
                        brand: value(f, "brand"),
                        reviewStatus: value(f, "reviewStatus"),
                        outcome: value(f, "outcome"),
                        notes: value(f, "notes"),
                      },
                      "Review saved.",
                    )
                  )
                    await show(detail.record.id);
                }}
              >
                <h3>Account, owner & next step</h3>
                <p className="muted">
                  Exact email matches link automatically only when the store is
                  unambiguous. Review shared contacts before assigning a store.
                </p>
                <div className="form-grid">
                  <label>
                    Account
                    <select
                      name="companyId"
                      defaultValue={detail.record.company_id || ""}
                    >
                      <option value="">
                        {!detail.record.company_id &&
                        detail.record.linked_company_name
                          ? `Inherited: ${detail.record.linked_company_name}`
                          : "No account linked"}
                      </option>
                      {data.accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                          {a.city ? ` · ${a.city}` : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Search retailer network
                    <input
                      value={storeQuery}
                      onChange={(e) => setStoreQuery(e.target.value)}
                      placeholder="Store name"
                    />
                  </label>
                  <label>
                    Retailer / location
                    <select
                      name="retailerId"
                      defaultValue={detail.record.retailer_id || ""}
                    >
                      <option value="">No retailer linked</option>
                      {detail.record.retailer_id &&
                        !stores.some(
                          (s) => s.id === detail.record.retailer_id,
                        ) && (
                          <option value={detail.record.retailer_id}>
                            {detail.record.retailer_name}
                          </option>
                        )}
                      {stores.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name} · {s.city}, {s.state}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Owner
                    <select
                      name="ownerId"
                      defaultValue={detail.record.owner_id}
                    >
                      {workspace.users.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Brand
                    <select name="brand" defaultValue={detail.record.brand}>
                      <BrandOptions />
                    </select>
                  </label>
                  <label>
                    Review status
                    <select
                      name="reviewStatus"
                      defaultValue={detail.record.review_status}
                    >
                      <option value="new">Awaiting review</option>
                      <option value="reviewed">Reviewed</option>
                      <option value="archived">Archived</option>
                    </select>
                  </label>
                  {detail.record.kind === "booking" && (
                    <label>
                      Meeting outcome
                      <select
                        name="outcome"
                        defaultValue={detail.record.outcome}
                      >
                        <option value="">Not recorded</option>
                        <option value="completed">Completed</option>
                        <option value="no_show">No-show</option>
                        <option value="follow_up">Follow-up needed</option>
                      </select>
                    </label>
                  )}
                </div>
                <label>
                  Team notes / next step
                  <textarea
                    rows={3}
                    name="notes"
                    defaultValue={detail.record.notes}
                  />
                </label>
                <button className="button primary" disabled={busy}>
                  Save review
                </button>
              </form>
            )}
            {editable && !detail.record.prospect_id && (
              <button
                className="button"
                disabled={busy}
                onClick={async () => {
                  if (
                    await act(
                      "inbound/prospect",
                      { id: detail.record.id },
                      "Added to Research for qualification.",
                    )
                  )
                    await show(detail.record.id);
                }}
              >
                Send to Research
              </button>
            )}
            {detail.record.prospect_id && (
              <p>
                <a href="/?view=operations">
                  Open Research to qualify this prospect
                </a>
              </p>
            )}
            {editable &&
              detail.record.provider === "manual" &&
              detail.record.status === "scheduled" && (
                <form
                  className="ops-form"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    if (
                      await act(
                        "inbound/cancel",
                        {
                          id: detail.record.id,
                          version: detail.record.version,
                          reason: value(f, "reason"),
                        },
                        "Manual meeting canceled.",
                      )
                    )
                      await show(detail.record.id);
                  }}
                >
                  <label>
                    Cancellation reason
                    <input name="reason" required minLength={3} />
                  </label>
                  <button className="button" disabled={busy}>
                    Cancel recorded meeting
                  </button>
                </form>
              )}
            {!!detail.related.length && (
              <section>
                <h3>Reschedule history</h3>
                {detail.related.map((r) => (
                  <button
                    key={r.id}
                    className="text-button"
                    onClick={() => void show(r.id)}
                  >
                    {r.title} · {date(r.starts_at)} · {r.status}
                  </button>
                ))}
              </section>
            )}
            <section>
              <h3>History</h3>
              {detail.events.map((e) => (
                <article className="retailer-history" key={e.id}>
                  <strong>{e.title}</strong>
                  <small>
                    {date(e.occurred_at)}
                    {e.actor && ` · ${e.actor}`}
                  </small>
                  <p className="inbound-pre">{e.body}</p>
                </article>
              ))}
            </section>
          </div>
        </Dialog>
      )}
      {routing && (
        <Dialog
          title={`${brandNames[routing.brand]} routing`}
          onClose={() => {
            setRouting(null);
            setError("");
          }}
        >
          <form
            className="ops-form inbound-detail"
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              if (
                await act(
                  "inbound/routing",
                  {
                    brand: routing.brand,
                    version: routing.version,
                    ownerId: value(f, "owner") || null,
                    notifyUserIds: f.getAll("recipients"),
                    bookingUrl: value(f, "bookingUrl"),
                    eventTypeUris: value(f, "eventTypes")
                      .split(/\s+/)
                      .filter(Boolean),
                  },
                  "Source routing saved.",
                )
              )
                setRouting(null);
            }}
          >
            {error && (
              <p role="alert" className="inbound-alert">
                {error}
              </p>
            )}
            <label>
              Default owner
              <select name="owner" defaultValue={routing.owner_id || ""}>
                <option value="">Account owner, then sales team</option>
                {workspace.users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </label>
            <fieldset>
              <legend>Notify teammates</legend>
              <p>
                Owner always receives alerts. Leave all unchecked to notify all
                active sales/admin members.
              </p>
              {workspace.users.map((u) => (
                <label className="inbound-check" key={u.id}>
                  <input
                    type="checkbox"
                    name="recipients"
                    value={u.id}
                    defaultChecked={routing.notify_user_ids.includes(u.id)}
                  />
                  {u.name}
                </label>
              ))}
            </fieldset>
            <label>
              Calendly booking link
              <input
                type="url"
                name="bookingUrl"
                defaultValue={routing.booking_url}
                placeholder="https://calendly.com/your-team/demo"
              />
            </label>
            <label>
              Calendly event type URIs
              <textarea
                name="eventTypes"
                rows={3}
                defaultValue={routing.event_type_uris.join("\n")}
                placeholder="https://api.calendly.com/event_types/…"
              />
            </label>
            <small>
              One per line. These assign a brand even when visitors book without
              campaign tracking.
            </small>
            {routing.brand !== "unknown" && (
              <p>
                Website endpoint:{" "}
                <code>/api/webhooks/websites/{routing.brand}</code>
              </p>
            )}
            <p>
              Calendly endpoint: <code>/api/webhooks/calendly</code>
            </p>
            <p className="muted">
              Signing secrets stay in server configuration. A configured key
              does not confirm that the external website or Calendly is
              connected.
            </p>
            <button className="button primary" disabled={busy}>
              Save routing
            </button>
          </form>
        </Dialog>
      )}
      {manual && (
        <Dialog
          title="Record a scheduled call or demo"
          onClose={() => {
            setManual(false);
            setError("");
          }}
        >
          <ManualForm
            workspace={workspace}
            accounts={data.accounts}
            busy={busy}
            error={error}
            onSave={async (body) => {
              const r = await act(
                "inbound/manual",
                body,
                "Meeting recorded. No external invitation was sent.",
              );
              if (r) {
                setManual(false);
                await show(r.id);
              }
            }}
          />
        </Dialog>
      )}
    </>
  );
}
function ManualForm({
  workspace,
  accounts,
  busy,
  error,
  onSave,
}: {
  workspace: Workspace;
  accounts: InboundData["accounts"];
  busy: boolean;
  error: string;
  onSave: (body: unknown) => Promise<void>;
}) {
  const [key] = useState(() => crypto.randomUUID());
  return (
    <form
      className="ops-form inbound-detail"
      onSubmit={async (e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        await onSave({
          requestKey: key,
          brand: value(f, "brand"),
          title: value(f, "title"),
          name: value(f, "name"),
          email: value(f, "email"),
          companyId: value(f, "companyId") || null,
          retailerId: null,
          ownerId: value(f, "ownerId"),
          startsAt: new Date(value(f, "startsAt")).toISOString(),
          endsAt: new Date(value(f, "endsAt")).toISOString(),
          location: value(f, "location"),
          notes: value(f, "notes"),
        });
      }}
    >
      {error && (
        <p role="alert" className="inbound-alert">
          {error}
        </p>
      )}
      <p>
        Use this for a meeting arranged by phone or email. To offer availability
        and send calendar invitations, use a Calendly booking link.
      </p>
      <div className="form-grid">
        <label>
          Meeting title
          <input
            name="title"
            required
            minLength={2}
            placeholder="Discovery call, demo, onboarding…"
          />
        </label>
        <label>
          Brand
          <select name="brand" defaultValue="linkd">
            <BrandOptions />
          </select>
        </label>
        <label>
          Contact name
          <input name="name" required />
        </label>
        <label>
          Email
          <input name="email" required type="email" />
        </label>
        <label>
          Account
          <select name="companyId">
            <option value="">Match by email / review later</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Owner
          <select name="ownerId" defaultValue={workspace.user.id}>
            {workspace.users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Start (your timezone)
          <input
            type="datetime-local"
            name="startsAt"
            required
            defaultValue={localTime(new Date(Date.now() + 86400000))}
          />
        </label>
        <label>
          End (your timezone)
          <input
            type="datetime-local"
            name="endsAt"
            required
            defaultValue={localTime(new Date(Date.now() + 88200000))}
          />
        </label>
      </div>
      <label>
        Meeting location / call details
        <input name="location" />
      </label>
      <label>
        Notes
        <textarea name="notes" rows={3} />
      </label>
      <button className="button primary" disabled={busy}>
        Save meeting
      </button>
    </form>
  );
}

export function InboundHistory({
  companyId,
  retailerId,
}: {
  companyId?: string;
  retailerId?: string;
}) {
  const [records, setRecords] = useState<InboundRecord[]>([]),
    [total, setTotal] = useState(0),
    [error, setError] = useState(""),
    [offset, setOffset] = useState(0),
    [detail, setDetail] = useState<Detail | null>(null);
  useEffect(() => {
    let live = true;
    const p = new URLSearchParams({ offset: String(offset) });
    if (companyId) p.set("companyId", companyId);
    if (retailerId) p.set("retailerId", retailerId);
    request("inbound/history?" + p)
      .then((r) => {
        if (live) {
          setRecords(r.records);
          setTotal(r.total);
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [companyId, retailerId, offset]);
  return (
    <section className="inbound-history">
      <h3>
        <CalendarDays size={18} /> Website inquiries & meetings
      </h3>
      {error && <p role="alert">{error}</p>}
      {!records.length && (
        <p className="muted">No linked forms or meetings yet.</p>
      )}
      {records.map((r) => (
        <button
          className="inbound-history-row"
          key={r.id}
          onClick={async () => {
            try {
              setDetail(await request("inbound/detail?id=" + r.id));
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          <strong>{r.title}</strong>
          <span>
            {brandNames[r.brand]} · {r.status}
            {r.outcome ? ` · ${r.outcome.replaceAll("_", " ")}` : ""}
          </span>
          <small>{date(r.starts_at || r.created_at)}</small>
        </button>
      ))}
      {total > 50 && (
        <div className="operations-toolbar">
          <button
            className="button"
            disabled={!offset}
            onClick={() => setOffset(offset - 50)}
          >
            Previous
          </button>
          <button
            className="button"
            disabled={offset + 50 >= total}
            onClick={() => setOffset(offset + 50)}
          >
            Next
          </button>
        </div>
      )}
      {detail && (
        <Dialog title={detail.record.title} onClose={() => setDetail(null)}>
          <div className="inbound-detail">
            <p>
              {detail.record.name} · {detail.record.email}
            </p>
            <p>
              {detail.record.status} ·{" "}
              {date(detail.record.starts_at || detail.record.created_at)}
            </p>
            <p className="inbound-pre">
              {detail.record.details.message || detail.record.notes}
            </p>
            {detail.events.map((e) => (
              <article className="retailer-history" key={e.id}>
                <strong>{e.title}</strong>
                <small>{date(e.occurred_at)}</small>
                <p className="inbound-pre">{e.body}</p>
              </article>
            ))}
            <a href={`/?view=intake&record=${detail.record.id}`}>
              Open Intake & bookings to manage this record
            </a>
          </div>
        </Dialog>
      )}
    </section>
  );
}
