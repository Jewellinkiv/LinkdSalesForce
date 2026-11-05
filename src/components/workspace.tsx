"use client";
import {
  useState,
  useEffect,
  useRef,
  useCallback,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  LayoutDashboard,
  Columns3,
  Building2,
  MessageSquare,
  Phone,
  ClipboardCheck,
  BarChart3,
  Settings,
  Search,
  Plus,
  ArrowUpRight,
  ArrowRight,
  ChevronRight,
  ChevronDown,
  Check,
  CheckCircle2,
  Clock,
  Mail,
  MoreHorizontal,
  X,
  Loader2,
  LogOut,
  CalendarDays,
  FileText,
  AlertCircle,
  Send,
  Activity as ActivityIcon,
  ShieldCheck,
  Headphones,
  PhoneOff,
  Menu,
  RefreshCw,
  Link2,
  Target,
  Filter,
  Users,
} from "lucide-react";
import type {
  Workspace as Data,
  Customer,
  Task,
  Project,
  Call,
  Message,
} from "@/lib/types";
import { stages, phases, packages } from "@/lib/types";

const money = (cents: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
const shortDate = (date: string | null) =>
  date
    ? new Date(date).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      })
    : "Not scheduled";
const time = (date: string) =>
  new Date(date).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
const initials = (name: string) =>
  name
    .split(" ")
    .slice(0, 2)
    .map((s) => s[0])
    .join("");
const active = (c: Customer) => !["Won", "Lost", "Be back"].includes(c.stage);
const todayEnd = () => new Date(new Date().setHours(23, 59, 59, 999)).getTime();
const todayStart = () => new Date(new Date().setHours(0, 0, 0, 0)).getTime();
const isOverdue = (d: string) => new Date(d).getTime() < todayStart();
const localDatetime = (date = new Date(Date.now() + 86400000)) =>
  new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
const nav = [
  ["overview", "Overview", LayoutDashboard],
  ["pipeline", "Pipeline", Columns3],
  ["customers", "Customers", Building2],
  ["inbox", "Inbox", MessageSquare],
  ["calls", "Calls & transcripts", Phone],
  ["onboarding", "Onboarding", ClipboardCheck],
  ["reports", "Reports", BarChart3],
  ["settings", "Settings", Settings],
] as const;
type View = (typeof nav)[number][0];
type Composer = { customer: Customer; channel: "email" | "sms" };

async function api(path: string, body?: unknown) {
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}
function Logo() {
  return (
    <div className="brand">
      <div className="brand-logo">
        <img src="/brand/linkd-logo-main.webp" alt="Linkd" />
      </div>
      <span>SALES FORCE</span>
    </div>
  );
}
function Avatar({ name, small = false }: { name: string; small?: boolean }) {
  return (
    <span className={`avatar ${small ? "small" : ""}`}>{initials(name)}</span>
  );
}
function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
function StageBadge({ stage }: { stage: string }) {
  return (
    <Badge
      tone={
        stage === "Won"
          ? "green"
          : stage === "Lost"
            ? "red"
            : stage === "Decision"
              ? "purple"
              : stage === "Demo scheduled"
                ? "blue"
                : "neutral"
      }
    >
      {stage}
    </Badge>
  );
}
function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty">
      <CheckCircle2 size={30} />
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}
function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const first = ref.current?.querySelector<HTMLElement>(
      "input,textarea,select,button",
    );
    first?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
      if (event.key === "Tab") {
        const all = Array.from(
          ref.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),textarea,select,a[href],[tabindex="0"]',
          ) || [],
        );
        const first = all[0],
          last = all[all.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`modal ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={ref}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export default function Workspace() {
  const [data, setData] = useState<Data | null>(null),
    [loading, setLoading] = useState(true),
    [signedOut, setSignedOut] = useState(false),
    [demoLogin, setDemoLogin] = useState(false);
  const [view, setView] = useState<View>("overview"),
    [query, setQuery] = useState(""),
    [toast, setToast] = useState<{ text: string; error?: boolean } | null>(
      null,
    ),
    [busy, setBusy] = useState(false),
    [mobileNav, setMobileNav] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null),
    [newLead, setNewLead] = useState(false),
    [composer, setComposer] = useState<Composer | null>(null),
    [followup, setFollowup] = useState<Customer | null>(null),
    [selectedCall, setSelectedCall] = useState<Call | null>(null),
    [calling, setCalling] = useState<Customer | null>(null),
    [lost, setLost] = useState<Customer | null>(null);
  const [queueFilter, setQueueFilter] = useState("Due now"),
    [pipelineView, setPipelineView] = useState("Active pipeline"),
    [inboxChannel, setInboxChannel] = useState("All channels"),
    [messageId, setMessageId] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/workspace", { cache: "no-store" });
      if (r.status === 401) {
        setSignedOut(true);
        setData(null);
        return;
      }
      const value = await r.json();
      if (!r.ok) throw new Error(value.error);
      setData(value);
      setSignedOut(false);
    } catch (e) {
      setToast({ text: (e as Error).message, error: true });
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    refresh();
    api("auth/info").then((r) => setDemoLogin(r.demoLogin));
    const interval = setInterval(refresh, 15000);
    const update = () => {
      const v = new URLSearchParams(location.search).get("view");
      if (nav.some((n) => n[0] === v)) setView(v as View);
    };
    update();
    window.addEventListener("popstate", update);
    return () => {
      clearInterval(interval);
      window.removeEventListener("popstate", update);
    };
  }, [refresh]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);
  function go(next: View) {
    setView(next);
    setQuery("");
    setMobileNav(false);
    history.pushState({}, "", `?view=${next}`);
  }
  async function mutate(path: string, body: unknown, success: string) {
    setBusy(true);
    try {
      await api(path, body);
      await refresh();
      setToast({ text: success });
      return true;
    } catch (e) {
      setToast({ text: (e as Error).message, error: true });
      return false;
    } finally {
      setBusy(false);
    }
  }
  const selected = data?.customers.find((c) => c.id === selectedId);
  const filtered =
    data?.customers.filter((c) =>
      `${c.name} ${c.contact_name} ${c.city} ${c.email}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    ) || [];
  const openTasks = data?.tasks.filter((t) => !t.completed_at) || [];
  const dueTasks = openTasks.filter(
    (t) => new Date(t.due_at).getTime() <= todayEnd(),
  );
  const projects = data?.projects.filter((p) => p.phase !== "Onboarded") || [];
  const pipeline = data?.customers.filter(active) || [];
  const booked = data?.customers.filter((c) => c.stage === "Won") || [];
  const selectedMessage = data?.messages.find((m) => m.id === messageId);
  const loginSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await mutate(
      "auth/login",
      { email: f.get("email"), password: f.get("password") },
      "Welcome back.",
    );
  };

  if (loading)
    return (
      <div className="loading-screen">
        <Logo />
        <Loader2 className="spin" />
        <p>Opening your workspace…</p>
      </div>
    );
  if (signedOut || !data)
    return (
      <div className="login-page">
        <div className="login-story">
          <Logo />
          <div>
            <span className="eyebrow">LINKD SALES FORCE</span>
            <h1>
              Great relationships.
              <br />
              Clear next steps.
            </h1>
            <p>
              Your sales conversations, pipeline, and customer onboarding.
              Connected from the first hello.
            </p>
            <div className="login-features">
              <span>
                <Phone size={18} /> Every conversation
              </span>
              <span>
                <Target size={18} /> Every opportunity
              </span>
              <span>
                <ClipboardCheck size={18} /> Every handoff
              </span>
            </div>
          </div>
          <small>Built for the team behind the relationship.</small>
        </div>
        <div className="login-form">
          <div>
            <span className="eyebrow">YOUR TEAM WORKSPACE</span>
            <h2>Welcome to Sales Force</h2>
            <p>Sign in to pick up where you left off.</p>
            <form onSubmit={loginSubmit}>
              <label>
                Work email
                <input
                  type="email"
                  name="email"
                  autoComplete="username"
                  required
                  placeholder="you@linkd.com"
                />
              </label>
              <label>
                Password
                <input
                  type="password"
                  name="password"
                  autoComplete="current-password"
                  required
                />
              </label>
              <button className="button primary full" disabled={busy}>
                Sign in <ArrowRight size={16} />
              </button>
            </form>
            {demoLogin && (
              <div className="demo-login">
                <p>Explore the first release with fictional customer data.</p>
                <button
                  className="button full"
                  disabled={busy}
                  onClick={() =>
                    mutate(
                      "auth/demo",
                      {},
                      "Demo workspace ready. No live messages will be sent.",
                    )
                  }
                >
                  Open demo workspace <ArrowUpRight size={16} />
                </button>
              </div>
            )}
            {toast && (
              <p role="alert" className="error-text">
                {toast.text}
              </p>
            )}
          </div>
        </div>
      </div>
    );

  function taskList(tasks: Task[], compact = false) {
    return tasks.length ? (
      <div className={`task-list ${compact ? "compact" : ""}`}>
        {tasks.map((t) => (
          <div className="task-row" key={t.id}>
            <button
              className="task-check"
              aria-label={`Complete ${t.title}`}
              disabled={busy}
              onClick={() =>
                mutate("tasks/complete", { id: t.id }, "Task completed.")
              }
            >
              <Check size={13} />
            </button>
            <button
              className="task-main"
              onClick={() => setSelectedId(t.company_id)}
            >
              <strong>{t.title}</strong>
              <span>
                {t.company_name}
                {t.phase && (
                  <>
                    {" "}
                    <i>·</i> {t.phase}
                  </>
                )}
              </span>
            </button>
            <span
              className={`due-date ${isOverdue(t.due_at) ? "overdue" : ""}`}
            >
              <Clock size={12} />
              {isOverdue(t.due_at) ? "Overdue" : shortDate(t.due_at)}
            </span>
            <Avatar name={t.owner_name} small />
          </div>
        ))}
      </div>
    ) : (
      <Empty
        title="You’re all caught up"
        body="Scheduled follow-ups and onboarding tasks will appear here."
      />
    );
  }
  function projectCard(p: Project) {
    return (
      <button
        className="project-preview"
        key={p.id}
        onClick={() => setSelectedId(p.company_id)}
      >
        <div className="row-between">
          <strong>{p.company_name}</strong>
          <ChevronRight size={15} />
        </div>
        <div className="row-between">
          <span>{p.phase}</span>
          <small>
            {p.completed_tasks}/{p.total_tasks}
          </small>
        </div>
        <div className="progress">
          <span
            style={{
              width: `${p.total_tasks ? (p.completed_tasks / p.total_tasks) * 100 : 0}%`,
            }}
          />
        </div>
        {p.blocker && (
          <small className="blocker">
            <AlertCircle size={12} />
            {p.blocker}
          </small>
        )}
      </button>
    );
  }
  async function setStage(customer: Customer, stage: string) {
    if (stage === "Lost") {
      setLost(customer);
      return;
    }
    await mutate(
      "opportunities/stage",
      { id: customer.opportunity_id, stage },
      stage === "Won"
        ? "Deal won. Onboarding checklist created."
        : "Pipeline updated.",
    );
  }

  return (
    <div className="app-shell">
      {mobileNav && (
        <button
          className="nav-scrim"
          aria-label="Close navigation"
          onClick={() => setMobileNav(false)}
        />
      )}
      <aside className={`sidebar ${mobileNav ? "open" : ""}`}>
        <Logo />
        <div className="workspace-picker">
          <span className="workspace-icon">
            <Link2 size={17} />
          </span>
          <div>
            <strong>Linkd team</strong>
            <small>Sales workspace</small>
          </div>
          <ChevronDown size={15} />
        </div>
        <span className="nav-section">WORKSPACE</span>
        <nav>
          {nav.slice(0, 7).map(([id, label, Icon]) => (
            <button
              key={id}
              className={view === id ? "active" : ""}
              onClick={() => go(id)}
            >
              <Icon size={18} />
              <span>{label}</span>
              {id === "inbox" &&
                data.messages.some((m) => m.direction === "inbound") && (
                  <span className="nav-dot" />
                )}
              {id === "onboarding" && <small>{projects.length}</small>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="team-card">
            <span className="team-orbit">
              <Users size={19} />
            </span>
            <strong>One team. All connected.</strong>
            <p>
              From first conversation
              <br />
              to a confident customer.
            </p>
          </div>
          <button
            className={`settings-link ${view === "settings" ? "active" : ""}`}
            onClick={() => go("settings")}
          >
            <Settings size={18} />
            Settings
          </button>
          <div className="profile">
            <Avatar name={data.user.name} />
            <div>
              <strong>{data.user.name}</strong>
              <small>
                {data.user.role === "admin"
                  ? "Workspace admin"
                  : data.user.role}
              </small>
            </div>
            <button
              aria-label="Sign out"
              className="icon-button"
              onClick={() => mutate("auth/logout", {}, "Signed out.")}
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="Open navigation"
              onClick={() => setMobileNav(true)}
            >
              <Menu size={20} />
            </button>
            <span>Workspace</span>
            <ChevronRight size={14} />
            <strong>{nav.find((n) => n[0] === view)?.[1]}</strong>
          </div>
          <div className="topbar-right">
            <label className="global-search">
              <Search size={16} />
              <input
                aria-label="Search workspace"
                placeholder="Search this view…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <button
              className="icon-button"
              aria-label="Refresh workspace"
              onClick={refresh}
            >
              <RefreshCw size={17} />
            </button>
            <Avatar name={data.user.name} small />
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                {view === "overview"
                  ? new Date().toLocaleDateString("en-US", {
                      weekday: "long",
                      month: "long",
                      day: "numeric",
                    })
                  : "LINKD SALES FORCE"}
              </div>
              <h1>
                {view === "overview"
                  ? `Good ${new Date().getHours() < 12 ? "morning" : "afternoon"}, ${data.user.name.split(" ")[0]}.`
                  : nav.find((n) => n[0] === view)?.[1]}
              </h1>
              <p>
                {
                  {
                    overview:
                      "A clear view of your relationships and what comes next.",
                    pipeline:
                      "Keep every opportunity moving toward the next conversation.",
                    customers:
                      "The people, stores, and relationships behind your pipeline.",
                    inbox:
                      "Email and text conversations, together in one place.",
                    calls: "Turn every conversation into a clear next step.",
                    onboarding:
                      "A smooth handoff. A confident launch. A customer ready to grow.",
                    reports:
                      "Understand progress across sales and customer onboarding.",
                    settings:
                      "Your team, communication providers, and workspace configuration.",
                  }[view]
                }
              </p>
            </div>
            <button className="button primary" onClick={() => setNewLead(true)}>
              <Plus size={17} />
              New lead
            </button>
          </div>
          {data.config.demo && (
            <div className="demo-strip">
              <span className="demo-dot" /> Demo workspace{" "}
              <span className="demo-divider" /> Fictional records ·{" "}
              {data.config.communicationMode === "demo"
                ? "Calls and messages are simulated"
                : "Live provider mode configured — sample recipients remain blocked"}
              <button onClick={() => go("settings")}>
                View setup <ArrowUpRight size={13} />
              </button>
            </div>
          )}

          {view === "overview" && (
            <>
              <div className="metrics">
                <Metric
                  label="Open pipeline"
                  value={money(pipeline.reduce((s, c) => s + c.mrr_cents, 0))}
                  detail={`${pipeline.length} active opportunities · monthly value`}
                  icon={<Columns3 size={18} />}
                  onClick={() => go("pipeline")}
                />
                <Metric
                  label="Follow-ups & tasks due"
                  value={String(dueTasks.length)}
                  detail={`${dueTasks.filter((t) => isOverdue(t.due_at)).length} overdue · team-wide`}
                  icon={<CalendarDays size={18} />}
                  onClick={() => setQueueFilter("Due now")}
                />
                <Metric
                  label="In onboarding"
                  value={String(projects.length)}
                  detail={`${projects.filter((p) => p.blocker).length} need a hand to move forward`}
                  icon={<ClipboardCheck size={18} />}
                  onClick={() => go("onboarding")}
                />
                <Metric
                  label="Booked monthly revenue"
                  value={money(booked.reduce((s, c) => s + c.mrr_cents, 0))}
                  detail={`${booked.length} won deals · contracted value`}
                  icon={<BarChart3 size={18} />}
                  onClick={() => go("reports")}
                />
              </div>
              <div className="overview-grid">
                <section className="panel priority-panel">
                  <div className="panel-head">
                    <div>
                      <h2>
                        Your priority queue{" "}
                        <span className="count">{dueTasks.length}</span>
                      </h2>
                      <p>The next action is the most important one.</p>
                    </div>
                    <button
                      className="icon-button"
                      aria-label="Show all tasks"
                      onClick={() => setQueueFilter("All open")}
                    >
                      <Filter size={17} />
                    </button>
                  </div>
                  <div className="tabs">
                    {["Due now", "Overdue", "All open"].map((f) => (
                      <button
                        key={f}
                        className={queueFilter === f ? "selected" : ""}
                        onClick={() => setQueueFilter(f)}
                      >
                        {f}
                      </button>
                    ))}
                  </div>
                  {taskList(
                    (queueFilter === "All open"
                      ? openTasks
                      : queueFilter === "Overdue"
                        ? openTasks.filter((t) => isOverdue(t.due_at))
                        : dueTasks
                    )
                      .filter((t) =>
                        `${t.title} ${t.company_name}`
                          .toLowerCase()
                          .includes(query.toLowerCase()),
                      )
                      .slice(0, 10),
                  )}
                  <div className="panel-footer">
                    <span>Across sales and onboarding</span>
                    <button onClick={() => go("onboarding")}>
                      Open onboarding <ArrowRight size={14} />
                    </button>
                  </div>
                </section>
                <section className="panel">
                  <div className="panel-head">
                    <div>
                      <h2>Onboarding watch</h2>
                      <p>Keep every launch on track.</p>
                    </div>
                    <span className="mini-icon">
                      <ClipboardCheck size={17} />
                    </span>
                  </div>
                  <div className="project-previews">
                    {projects.slice(0, 3).map(projectCard)}
                  </div>
                  <button
                    className="panel-link"
                    onClick={() => go("onboarding")}
                  >
                    View all onboarding <ArrowRight size={15} />
                  </button>
                </section>
              </div>
              <div className="overview-grid bottom-grid">
                <section className="panel">
                  <div className="panel-head">
                    <div>
                      <h2>Recent activity</h2>
                      <p>A shared view of the work moving forward.</p>
                    </div>
                    <ActivityIcon size={18} />
                  </div>
                  <div className="activity-list">
                    {data.activities.slice(0, 5).map((a) => (
                      <button
                        key={a.id}
                        className="activity-row"
                        onClick={() => setSelectedId(a.company_id)}
                      >
                        <span className={`activity-icon ${a.kind}`}>
                          <ActivitySymbol kind={a.kind} />
                        </span>
                        <div>
                          <strong>{a.title}</strong>
                          <p>
                            {a.company_name}
                            {a.actor && ` · ${a.actor}`}
                          </p>
                        </div>
                        <time>{shortDate(a.created_at)}</time>
                      </button>
                    ))}
                  </div>
                </section>
                <section className="next-move">
                  <span className="eyebrow">RELATIONSHIPS IN MOTION</span>
                  <h2>
                    Make room for the
                    <br />
                    next conversation.
                  </h2>
                  <p>
                    {pipeline.filter((c) => !c.next_action_at).length
                      ? `${pipeline.filter((c) => !c.next_action_at).length} active opportunities need a next action.`
                      : "Your active opportunities have a next step. Keep the momentum going."}
                  </p>
                  <button className="button" onClick={() => go("pipeline")}>
                    Review your pipeline <ArrowUpRight size={16} />
                  </button>
                  <div className="decorative-links" aria-hidden="true">
                    <Link2 size={160} />
                  </div>
                </section>
              </div>
            </>
          )}

          {view === "pipeline" && (
            <>
              <div className="view-toolbar">
                <div className="tabs standalone">
                  {["Active pipeline", "Won", "Lost / Be back"].map((f) => (
                    <button
                      key={f}
                      className={pipelineView === f ? "selected" : ""}
                      onClick={() => setPipelineView(f)}
                    >
                      {f}
                    </button>
                  ))}
                </div>
                <span className="muted">
                  {money(pipeline.reduce((s, c) => s + c.mrr_cents, 0))}{" "}
                  potential MRR
                </span>
              </div>
              <div className="kanban">
                {(pipelineView === "Won"
                  ? ["Won"]
                  : pipelineView === "Lost / Be back"
                    ? ["Lost", "Be back"]
                    : stages.slice(0, 4)
                ).map((stage) => {
                  const customers = filtered.filter((c) => c.stage === stage);
                  return (
                    <section className="kanban-column" key={stage}>
                      <div className="column-heading">
                        <span
                          className={`stage-dot stage-${stages.indexOf(stage as (typeof stages)[number])}`}
                        />
                        <strong>{stage}</strong>
                        <span className="count">{customers.length}</span>
                      </div>
                      <p className="column-total">
                        {money(customers.reduce((s, c) => s + c.mrr_cents, 0))}{" "}
                        / mo
                      </p>
                      {customers.map((c) => (
                        <div className="deal-card" key={c.opportunity_id}>
                          <button
                            className="deal-title"
                            onClick={() => setSelectedId(c.id)}
                          >
                            <div className="company-avatar">
                              {initials(c.name)}
                            </div>
                            <ArrowUpRight size={15} />
                            <h3>{c.name}</h3>
                            <span>{c.contact_name}</span>
                          </button>
                          <div className="deal-value">
                            {money(c.mrr_cents)}
                            <small>/mo</small>
                            <Badge>{c.package}</Badge>
                          </div>
                          <div className="deal-next">
                            <Clock size={13} />
                            <span>
                              {c.next_action || "No next action scheduled"}
                            </span>
                          </div>
                          <div className="deal-bottom">
                            <span
                              className={
                                c.next_action_at && isOverdue(c.next_action_at)
                                  ? "overdue"
                                  : ""
                              }
                            >
                              {shortDate(c.next_action_at)}
                            </span>
                            <Avatar name={c.owner_name} small />
                          </div>
                          <label className="stage-control">
                            <span className="sr-only">Stage for {c.name}</span>
                            <select
                              value={c.stage}
                              disabled={busy || c.stage === "Won"}
                              onChange={(e) => setStage(c, e.target.value)}
                            >
                              {stages.map((s) => (
                                <option key={s}>{s}</option>
                              ))}
                            </select>
                          </label>
                        </div>
                      ))}
                      {!customers.length && (
                        <div className="column-empty">
                          No opportunities here yet
                        </div>
                      )}
                    </section>
                  );
                })}
              </div>
            </>
          )}

          {view === "customers" && (
            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>
                    All relationships{" "}
                    <span className="count">{filtered.length}</span>
                  </h2>
                  <p>One customer record, from first contact to onboarding.</p>
                </div>
                <Building2 size={18} />
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Company / contact</th>
                      <th>Stage</th>
                      <th>Package</th>
                      <th>Monthly value</th>
                      <th>Next action</th>
                      <th>Owner</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((c) => (
                      <tr key={c.opportunity_id}>
                        <td>
                          <button
                            className="company-cell"
                            onClick={() => setSelectedId(c.id)}
                          >
                            <span className="company-avatar">
                              {initials(c.name)}
                            </span>
                            <span>
                              <strong>{c.name}</strong>
                              <small>
                                {c.contact_name} · {c.city}
                              </small>
                            </span>
                          </button>
                        </td>
                        <td>
                          <StageBadge stage={c.stage} />
                        </td>
                        <td>{c.package}</td>
                        <td className="numeric">{money(c.mrr_cents)}</td>
                        <td>
                          <span>{c.next_action || "—"}</span>
                          <small
                            className={
                              c.next_action_at && isOverdue(c.next_action_at)
                                ? "overdue"
                                : ""
                            }
                          >
                            {shortDate(c.next_action_at)}
                          </small>
                        </td>
                        <td>
                          <Avatar name={c.owner_name} small />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!filtered.length && (
                  <Empty
                    title="No matching customers"
                    body="Try a different search or add a lead."
                  />
                )}
              </div>
            </section>
          )}

          {view === "inbox" && (
            <>
              <div className="view-toolbar">
                <div className="tabs standalone">
                  {["All channels", "Email", "SMS"].map((c) => (
                    <button
                      key={c}
                      className={inboxChannel === c ? "selected" : ""}
                      onClick={() => setInboxChannel(c)}
                    >
                      {c}
                    </button>
                  ))}
                </div>
                <button
                  className="button"
                  onClick={() => {
                    go("customers");
                    setToast({ text: "Open a customer to start a message." });
                  }}
                >
                  <Plus size={15} />
                  New message
                </button>
              </div>
              <div className="inbox-layout panel">
                <div className="conversation-list">
                  {data.messages
                    .filter(
                      (m) =>
                        (inboxChannel === "All channels" ||
                          m.channel === inboxChannel.toLowerCase()) &&
                        `${m.company_name} ${m.body} ${m.subject}`
                          .toLowerCase()
                          .includes(query.toLowerCase()),
                    )
                    .map((m) => (
                      <button
                        key={m.id}
                        className={`conversation ${messageId === m.id ? "selected" : ""}`}
                        onClick={() => setMessageId(m.id)}
                      >
                        <div className="row-between">
                          <span className={`channel-icon ${m.channel}`}>
                            {m.channel === "email" ? (
                              <Mail size={15} />
                            ) : (
                              <MessageSquare size={15} />
                            )}
                          </span>
                          <time>{shortDate(m.created_at)}</time>
                        </div>
                        <strong>{m.company_name || "Unmatched sender"}</strong>
                        <span>
                          {m.subject || m.contact_name || "Text message"}
                        </span>
                        <p>{m.body}</p>
                        <Badge
                          tone={m.direction === "inbound" ? "blue" : "neutral"}
                        >
                          {m.direction === "inbound" ? "Received" : m.status}
                        </Badge>
                      </button>
                    ))}
                  {!data.messages.length && (
                    <Empty
                      title="A clean inbox"
                      body="Emails and text messages will appear here."
                    />
                  )}
                </div>
                <div className="message-detail">
                  {selectedMessage ? (
                    <>
                      <div className="message-detail-head">
                        <div>
                          <h2>
                            {selectedMessage.subject || "Text conversation"}
                          </h2>
                          <p>
                            {selectedMessage.contact_name || "Unknown contact"}{" "}
                            · {selectedMessage.company_name || "Needs matching"}
                          </p>
                        </div>
                        <Badge
                          tone={
                            selectedMessage.status === "review"
                              ? "amber"
                              : "blue"
                          }
                        >
                          {selectedMessage.status}
                        </Badge>
                      </div>
                      <div className="message-body">
                        <span className="eyebrow">
                          {selectedMessage.direction} ·{" "}
                          {shortDate(selectedMessage.created_at)} AT{" "}
                          {time(selectedMessage.created_at)}
                        </span>
                        <p>{selectedMessage.body}</p>
                        {selectedMessage.error && (
                          <div className="notice amber">
                            {selectedMessage.error}
                          </div>
                        )}
                      </div>
                      <div className="message-actions">
                        {selectedMessage.company_id && (
                          <button
                            className="button primary"
                            onClick={() => {
                              const c = data.customers.find(
                                (c) => c.id === selectedMessage.company_id,
                              );
                              if (c)
                                setComposer({
                                  customer: c,
                                  channel: selectedMessage.channel,
                                });
                            }}
                          >
                            <Send size={15} />
                            Reply
                          </button>
                        )}
                        {selectedMessage.status === "queued" && (
                          <button
                            className="button"
                            disabled={busy}
                            onClick={() =>
                              mutate(
                                "messages/cancel",
                                { id: selectedMessage.id },
                                "Scheduled message cancelled.",
                              )
                            }
                          >
                            Cancel scheduled send
                          </button>
                        )}
                      </div>
                    </>
                  ) : (
                    <Empty
                      title="Every conversation, connected"
                      body="Select a message to read it, reply, or open the customer record."
                    />
                  )}
                </div>
              </div>
            </>
          )}

          {view === "calls" && (
            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>Call library</h2>
                  <p>
                    Recordings, searchable transcripts, and team follow-through.
                  </p>
                </div>
                <Badge
                  tone={
                    data.config.communicationMode === "demo" ? "amber" : "blue"
                  }
                >
                  {data.config.communicationMode === "demo"
                    ? "Demo calling"
                    : "Twilio Voice"}
                </Badge>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Customer</th>
                      <th>Rep</th>
                      <th>Outcome</th>
                      <th>Duration</th>
                      <th>Transcript</th>
                      <th>Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.calls
                      .filter((c) =>
                        `${c.company_name} ${c.contact_name} ${c.summary} ${c.transcript.map((t) => t.text).join(" ")}`
                          .toLowerCase()
                          .includes(query.toLowerCase()),
                      )
                      .map((c) => (
                        <tr key={c.id}>
                          <td>
                            <button
                              className="company-cell"
                              onClick={() => setSelectedCall(c)}
                            >
                              <span className="company-avatar">
                                <Phone size={17} />
                              </span>
                              <span>
                                <strong>
                                  {c.company_name || "Unknown company"}
                                </strong>
                                <small>{c.contact_name}</small>
                              </span>
                            </button>
                          </td>
                          <td>{c.user_name}</td>
                          <td>
                            <Badge
                              tone={c.status === "demo" ? "amber" : "neutral"}
                            >
                              {c.outcome || c.status}
                            </Badge>
                          </td>
                          <td>
                            {c.duration
                              ? `${Math.floor(c.duration / 60)}m ${c.duration % 60}s`
                              : "—"}
                          </td>
                          <td>
                            <button
                              className="text-button"
                              onClick={() => setSelectedCall(c)}
                            >
                              <FileText size={14} />
                              {c.transcript.length
                                ? "Read transcript"
                                : "Add outcome"}
                            </button>
                          </td>
                          <td>{shortDate(c.created_at)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              {!data.calls.length && (
                <Empty
                  title="Your call history starts here"
                  body="Open a customer and choose Call to start a conversation."
                />
              )}
            </section>
          )}

          {view === "onboarding" && (
            <>
              <div className="summary-chips">
                <span>
                  <span className="dot blue" />
                  {projects.length} active projects
                </span>
                <span>
                  <span className="dot amber" />
                  {projects.filter((p) => p.blocker).length} blocked
                </span>
                <span>
                  <span className="dot green" />
                  {
                    data.projects.filter((p) => p.phase === "Onboarded").length
                  }{" "}
                  onboarded
                </span>
              </div>
              <div className="onboarding-grid">
                {data.projects
                  .filter((p) =>
                    p.company_name.toLowerCase().includes(query.toLowerCase()),
                  )
                  .map((p) => (
                    <section className="panel onboarding-card" key={p.id}>
                      <div className="panel-head">
                        <div>
                          <span className="eyebrow">{p.package}</span>
                          <button
                            className="heading-button"
                            onClick={() => setSelectedId(p.company_id)}
                          >
                            <h2>{p.company_name}</h2>
                            <ArrowUpRight size={16} />
                          </button>
                        </div>
                        <Avatar name={p.owner_name} />
                      </div>
                      <div
                        className="phase-track"
                        aria-label={`Phase: ${p.phase}`}
                      >
                        {phases.map((phase, i) => (
                          <span
                            key={phase}
                            className={
                              i <= phases.indexOf(p.phase) ? "done" : ""
                            }
                            title={phase}
                          />
                        ))}
                      </div>
                      <div className="onboarding-meta">
                        <Badge tone="blue">{p.phase}</Badge>
                        <span>Go-live target {shortDate(p.target_at)}</span>
                      </div>
                      {p.blocker && (
                        <div className="notice amber">
                          <AlertCircle size={16} />
                          <span>{p.blocker}</span>
                          <button
                            onClick={() =>
                              mutate(
                                "onboarding/blocker",
                                { id: p.id, blocker: "" },
                                "Blocker resolved.",
                              )
                            }
                            disabled={busy}
                          >
                            Resolve
                          </button>
                        </div>
                      )}
                      <div className="onboarding-tasks">
                        {data.tasks
                          .filter(
                            (t) =>
                              t.onboarding_id === p.id && t.phase === p.phase,
                          )
                          .map((t) => (
                            <label
                              className={`checklist-task ${t.completed_at ? "completed" : ""}`}
                              key={t.id}
                            >
                              <input
                                type="checkbox"
                                checked={!!t.completed_at}
                                disabled={!!t.completed_at || busy}
                                onChange={() =>
                                  mutate(
                                    "tasks/complete",
                                    { id: t.id },
                                    "Checklist updated.",
                                  )
                                }
                              />
                              <span>{t.title}</span>
                            </label>
                          ))}
                        {p.phase === "Onboarded" && (
                          <p className="green-text">
                            <CheckCircle2 size={16} />
                            Ready for ongoing customer success.
                          </p>
                        )}
                      </div>
                      <div className="onboarding-footer">
                        <span>
                          {p.completed_tasks} of {p.total_tasks} complete
                        </span>
                        {p.phase !== "Onboarded" && (
                          <button
                            className="button small-button"
                            disabled={busy}
                            onClick={() =>
                              mutate(
                                "onboarding/advance",
                                { id: p.id },
                                "Onboarding phase advanced.",
                              )
                            }
                          >
                            Next phase <ArrowRight size={14} />
                          </button>
                        )}
                      </div>
                    </section>
                  ))}
              </div>
              {!data.projects.length && (
                <Empty
                  title="Ready for your first handoff"
                  body="Mark a complete opportunity won to create an onboarding checklist."
                />
              )}
            </>
          )}

          {view === "reports" && (
            <>
              <div className="metrics">
                <Metric
                  label="Open pipeline MRR"
                  value={money(pipeline.reduce((s, c) => s + c.mrr_cents, 0))}
                  detail="Active opportunities, unweighted"
                  icon={<Columns3 size={18} />}
                />
                <Metric
                  label="Booked MRR"
                  value={money(booked.reduce((s, c) => s + c.mrr_cents, 0))}
                  detail="Won deals; not billing-system revenue"
                  icon={<BarChart3 size={18} />}
                />
                <Metric
                  label="Awaiting onboarding"
                  value={money(projects.reduce((s, p) => s + p.mrr_cents, 0))}
                  detail="Won MRR not yet fully onboarded"
                  icon={<ClipboardCheck size={18} />}
                />
                <Metric
                  label="Closed-deal win rate"
                  value={`${Math.round((booked.length / Math.max(1, data.customers.filter((c) => ["Won", "Lost"].includes(c.stage)).length)) * 100)}%`}
                  detail="Won ÷ (won + lost), all time"
                  icon={<Target size={18} />}
                />
              </div>
              <div className="overview-grid">
                <section className="panel">
                  <div className="panel-head">
                    <div>
                      <h2>Pipeline by stage</h2>
                      <p>Opportunity count · all owners · all time</p>
                    </div>
                  </div>
                  <div className="bar-chart">
                    {stages.map((stage) => {
                      const count = data.customers.filter(
                        (c) => c.stage === stage,
                      ).length;
                      return (
                        <button
                          key={stage}
                          onClick={() => {
                            go("pipeline");
                            setPipelineView(
                              stage === "Won"
                                ? "Won"
                                : ["Lost", "Be back"].includes(stage)
                                  ? "Lost / Be back"
                                  : "Active pipeline",
                            );
                          }}
                        >
                          <span>{stage}</span>
                          <div>
                            <i
                              style={{
                                width: `${(count / Math.max(1, ...stages.map((s) => data.customers.filter((c) => c.stage === s).length))) * 100}%`,
                              }}
                            />
                          </div>
                          <strong>{count}</strong>
                        </button>
                      );
                    })}
                  </div>
                </section>
                <section className="panel">
                  <div className="panel-head">
                    <div>
                      <h2>Operational attention</h2>
                      <p>The gaps worth closing next.</p>
                    </div>
                  </div>
                  <div className="attention-list">
                    <button
                      onClick={() => {
                        go("overview");
                        setQueueFilter("Overdue");
                      }}
                    >
                      <span>Overdue tasks</span>
                      <strong>
                        {openTasks.filter((t) => isOverdue(t.due_at)).length}
                        <ChevronRight size={16} />
                      </strong>
                    </button>
                    <button onClick={() => go("pipeline")}>
                      <span>Active deals without a next action</span>
                      <strong>
                        {pipeline.filter((c) => !c.next_action_at).length}
                        <ChevronRight size={16} />
                      </strong>
                    </button>
                    <button onClick={() => go("onboarding")}>
                      <span>Blocked onboarding projects</span>
                      <strong>
                        {projects.filter((p) => p.blocker).length}
                        <ChevronRight size={16} />
                      </strong>
                    </button>
                    <button onClick={() => go("inbox")}>
                      <span>Messages requiring review</span>
                      <strong>
                        {
                          data.messages.filter((m) => m.status === "review")
                            .length
                        }
                        <ChevronRight size={16} />
                      </strong>
                    </button>
                  </div>
                  <div className="report-note">
                    All values come from this workspace. Sample data is labeled;
                    billing and product adoption are not connected yet.
                  </div>
                </section>
              </div>
            </>
          )}

          {view === "settings" && (
            <>
              <section className="panel settings-panel">
                <div className="panel-head">
                  <div>
                    <h2>Communication connections</h2>
                    <p>
                      Credentials are configured on the server and never exposed
                      in the browser.
                    </p>
                  </div>
                  <Badge
                    tone={
                      data.config.communicationMode === "live"
                        ? "green"
                        : "amber"
                    }
                  >
                    {data.config.communicationMode === "live"
                      ? "Live mode"
                      : "Demo mode"}
                  </Badge>
                </div>
                {data.config.integrations.map((i) => (
                  <div className="integration-row" key={i.name}>
                    <span className="integration-icon">
                      {i.name === "Postmark" ? (
                        <Mail size={22} />
                      ) : i.name === "Call transcripts" ? (
                        <FileText size={22} />
                      ) : i.name === "Twilio SMS" ? (
                        <MessageSquare size={22} />
                      ) : (
                        <Phone size={22} />
                      )}
                    </span>
                    <div>
                      <h3>{i.name}</h3>
                      <p>{i.description}</p>
                      <small>
                        {i.ready
                          ? "Server credentials present. Complete provider setup and live verification before rollout."
                          : `Needs ${i.missing.length} server configuration values`}
                      </small>
                    </div>
                    <Badge tone={i.ready ? "green" : "neutral"}>
                      {i.ready ? "Configured" : "Not connected"}
                    </Badge>
                  </div>
                ))}
                <div className="notice settings-notice">
                  <ShieldCheck size={19} />
                  <p>
                    Demo sends are simulated. Live messages require recorded
                    permission. Incoming replies pause queued follow-ups;
                    opt-outs and suppressed addresses block sending.
                  </p>
                </div>
              </section>
              <div className="overview-grid">
                <section className="panel">
                  <div className="panel-head">
                    <h2>Team members</h2>
                    <Badge>{data.users.length} members</Badge>
                  </div>
                  {data.users.map((u) => (
                    <div className="team-row" key={u.id}>
                      <Avatar name={u.name} />
                      <div>
                        <strong>{u.name}</strong>
                        <small>{u.email}</small>
                      </div>
                      <Badge>{u.role}</Badge>
                    </div>
                  ))}
                </section>
                <section className="panel">
                  <div className="panel-head">
                    <div>
                      <h2>Automation activity</h2>
                      <p>Durable jobs processed by the worker.</p>
                    </div>
                  </div>
                  {data.jobs.length ? (
                    <div className="attention-list">
                      {data.jobs.map((j) => (
                        <div key={j.kind + j.status}>
                          <span>
                            {j.kind.replaceAll("_", " ")}{" "}
                            <Badge>{j.status}</Badge>
                          </span>
                          <strong>{j.count}</strong>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <Empty
                      title="Ready when you are"
                      body="Queued messages and transcript jobs appear here."
                    />
                  )}
                  <div className="report-note">
                    Call recording:{" "}
                    {data.config.recordingEnabled
                      ? "enabled with per-call permission confirmation"
                      : "disabled"}
                    . Outbound browser calling is included in this first
                    release; inbound routing is a next milestone.
                  </div>
                </section>
              </div>
            </>
          )}
          <footer className="workspace-footer">
            <span>
              <Link2 size={13} />
              Linkd Sales Force
            </span>
            <span>Connected conversations. Clear next steps.</span>
          </footer>
        </main>
      </div>

      {selected && !composer && !calling && !followup && (
        <Modal title={selected.name} wide onClose={() => setSelectedId(null)}>
          <div className="customer-detail">
            <div className="detail-overview">
              <div className="customer-hero">
                <span className="company-avatar large">
                  {initials(selected.name)}
                </span>
                <div>
                  <h3>{selected.contact_name}</h3>
                  <p>
                    {selected.city} · {selected.locations} location
                    {selected.locations === 1 ? "" : "s"}
                  </p>
                  <StageBadge stage={selected.stage} />
                </div>
              </div>
              <div className="contact-actions">
                <button className="button" onClick={() => setCalling(selected)}>
                  <Phone size={15} />
                  Call
                </button>
                <button
                  className="button"
                  onClick={() =>
                    setComposer({ customer: selected, channel: "sms" })
                  }
                >
                  <MessageSquare size={15} />
                  Text
                </button>
                <button
                  className="button"
                  onClick={() =>
                    setComposer({ customer: selected, channel: "email" })
                  }
                >
                  <Mail size={15} />
                  Email
                </button>
              </div>
              <dl className="detail-fields">
                <div>
                  <dt>Email</dt>
                  <dd>{selected.email || "Not added"}</dd>
                </div>
                <div>
                  <dt>Phone</dt>
                  <dd>{selected.phone || "Not added"}</dd>
                </div>
                <div>
                  <dt>Current POS</dt>
                  <dd>{selected.pos || "Not added"}</dd>
                </div>
                <div>
                  <dt>Package</dt>
                  <dd>{selected.package}</dd>
                </div>
                <div>
                  <dt>Monthly value</dt>
                  <dd>{money(selected.mrr_cents)}</dd>
                </div>
                <div>
                  <dt>Source</dt>
                  <dd>{selected.source}</dd>
                </div>
                <div>
                  <dt>Owner</dt>
                  <dd>{selected.owner_name}</dd>
                </div>
              </dl>
              <div className="next-action-box">
                <span className="eyebrow">NEXT ACTION</span>
                <strong>{selected.next_action || "Set the next step"}</strong>
                <p>{shortDate(selected.next_action_at)}</p>
                <button
                  className="text-button"
                  onClick={() => setFollowup(selected)}
                >
                  Schedule follow-up <ArrowRight size={14} />
                </button>
              </div>
              <div className="permission-summary">
                <small>
                  SMS:{" "}
                  {selected.sms_opted_out
                    ? "Opted out"
                    : selected.sms_consent
                      ? "Permission recorded"
                      : "No permission"}
                </small>
                <small>
                  Email:{" "}
                  {selected.email_suppressed
                    ? "Suppressed"
                    : selected.email_consent
                      ? "Permission recorded"
                      : "No permission"}
                </small>
              </div>
            </div>
            <div className="detail-timeline">
              <h3>Relationship timeline</h3>
              <form
                className="note-form"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const form = e.currentTarget;
                  const body = new FormData(form).get("note");
                  if (
                    await mutate(
                      "customers/note",
                      { companyId: selected.id, body },
                      "Note saved.",
                    )
                  )
                    form.reset();
                }}
              >
                <textarea
                  name="note"
                  aria-label="Add a customer note"
                  placeholder="Add context for the next conversation…"
                  required
                  rows={3}
                />
                <button className="button small-button" disabled={busy}>
                  Save note
                </button>
              </form>
              <div className="timeline">
                {data.activities
                  .filter((a) => a.company_id === selected.id)
                  .map((a) => (
                    <div className="timeline-event" key={a.id}>
                      <span className={`activity-icon ${a.kind}`}>
                        <ActivitySymbol kind={a.kind} />
                      </span>
                      <div>
                        <strong>{a.title}</strong>
                        <small>
                          {shortDate(a.created_at)} · {time(a.created_at)}
                          {a.actor && ` · ${a.actor}`}
                        </small>
                        <p>{a.body}</p>
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          </div>
        </Modal>
      )}
      {newLead && (
        <NewLead
          busy={busy}
          onClose={() => setNewLead(false)}
          onSave={async (body) => {
            if (
              await mutate(
                "customers",
                body,
                "Lead created with its first follow-up.",
              )
            )
              setNewLead(false);
          }}
        />
      )}
      {composer && (
        <MessageComposer
          value={composer}
          demo={data.config.communicationMode === "demo"}
          busy={busy}
          onClose={() => setComposer(null)}
          onSave={async (body) => {
            if (
              await mutate(
                "messages",
                body,
                data.config.communicationMode === "demo"
                  ? "Demo message queued. The worker will simulate delivery."
                  : "Message queued for delivery.",
              )
            )
              setComposer(null);
          }}
        />
      )}
      {followup && (
        <Modal
          title={`Follow up with ${followup.name}`}
          onClose={() => setFollowup(null)}
        >
          <form
            className="modal-form"
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              if (
                await mutate(
                  "customers/follow-up",
                  {
                    opportunityId: followup.opportunity_id,
                    title: f.get("title"),
                    dueAt: new Date(String(f.get("date"))).toISOString(),
                  },
                  "Follow-up scheduled.",
                )
              )
                setFollowup(null);
            }}
          >
            <label>
              Next action
              <input
                name="title"
                defaultValue={followup.next_action}
                required
                maxLength={300}
              />
            </label>
            <label>
              When
              <input
                name="date"
                type="datetime-local"
                required
                defaultValue={localDatetime()}
              />
            </label>
            <button className="button primary" disabled={busy}>
              Schedule follow-up
            </button>
          </form>
        </Modal>
      )}
      {lost && (
        <Modal title="Record deal outcome" onClose={() => setLost(null)}>
          <form
            className="modal-form"
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              if (
                await mutate(
                  "opportunities/stage",
                  {
                    id: lost.opportunity_id,
                    stage: "Lost",
                    reason: f.get("reason"),
                  },
                  "Loss reason saved.",
                )
              )
                setLost(null);
            }}
          >
            <p>What kept {lost.name} from moving forward?</p>
            <label>
              Loss reason
              <textarea name="reason" required maxLength={500} />
            </label>
            <button className="button primary" disabled={busy}>
              Mark lost
            </button>
          </form>
        </Modal>
      )}
      {selectedCall && (
        <CallDetail
          call={
            data.calls.find((c) => c.id === selectedCall.id) || selectedCall
          }
          busy={busy}
          onClose={() => setSelectedCall(null)}
          onSave={(body) =>
            mutate("calls/outcome", body, "Call outcome saved.")
          }
        />
      )}
      {calling && (
        <CallDialog
          customer={calling}
          demo={data.config.communicationMode === "demo"}
          recording={data.config.recordingEnabled}
          onClose={() => {
            setCalling(null);
            refresh();
          }}
          onComplete={refresh}
        />
      )}
      {toast && (
        <div
          role={toast.error ? "alert" : "status"}
          className={`toast ${toast.error ? "error" : ""}`}
        >
          {toast.error ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
          <span>{toast.text}</span>
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast(null)}
          >
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  detail,
  icon,
  onClick,
}: {
  label: string;
  value: string;
  detail: string;
  icon: ReactNode;
  onClick?: () => void;
}) {
  return (
    <button className="metric" onClick={onClick} disabled={!onClick}>
      <div>
        <span>{label}</span>
        <i>{icon}</i>
      </div>
      <strong>{value}</strong>
      <small>{detail}</small>
    </button>
  );
}
function ActivitySymbol({ kind }: { kind: string }) {
  return kind === "call" ? (
    <Phone size={15} />
  ) : kind === "email" ? (
    <Mail size={15} />
  ) : kind === "sms" ? (
    <MessageSquare size={15} />
  ) : kind === "onboarding" ? (
    <ClipboardCheck size={15} />
  ) : kind === "task" ? (
    <Check size={15} />
  ) : kind === "note" ? (
    <FileText size={15} />
  ) : (
    <ArrowUpRight size={15} />
  );
}

function NewLead({
  onClose,
  onSave,
  busy,
}: {
  onClose: () => void;
  onSave: (body: unknown) => Promise<void>;
  busy: boolean;
}) {
  return (
    <Modal title="Add a new lead" onClose={onClose} wide>
      <form
        className="modal-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          await onSave({
            name: f.get("name"),
            contactName: f.get("contactName"),
            email: f.get("email"),
            phone: f.get("phone"),
            city: f.get("city"),
            pos: f.get("pos"),
            locations: Number(f.get("locations")),
            source: f.get("source"),
            package: f.get("package"),
            mrr: Number(f.get("mrr")),
            nextAction: f.get("nextAction"),
            nextActionAt: new Date(String(f.get("nextActionAt"))).toISOString(),
            smsConsent: f.get("smsConsent") === "on",
            emailConsent: f.get("emailConsent") === "on",
            consentSource: f.get("consentSource"),
          });
        }}
      >
        <div className="form-section-label">THE RELATIONSHIP</div>
        <div className="form-grid">
          <label>
            Company name
            <input
              name="name"
              required
              minLength={2}
              maxLength={150}
              placeholder="Company or store"
            />
          </label>
          <label>
            Contact name
            <input
              name="contactName"
              required
              minLength={2}
              maxLength={150}
              placeholder="First and last name"
            />
          </label>
          <label>
            Email
            <input
              name="email"
              type="email"
              placeholder="contact@company.com"
            />
          </label>
          <label>
            Phone
            <input
              name="phone"
              type="tel"
              placeholder="+12025550123"
              pattern="\+[1-9][0-9]{7,14}"
            />
          </label>
          <label>
            City / state
            <input name="city" placeholder="City, ST" maxLength={150} />
          </label>
          <label>
            Current POS
            <input
              name="pos"
              placeholder="The Edge, other, or none"
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
            />
          </label>
          <label>
            Source
            <select name="source">
              {["Website", "Referral", "Trade show", "Outbound", "Direct"].map(
                (s) => (
                  <option key={s}>{s}</option>
                ),
              )}
            </select>
          </label>
          <label>
            Package
            <select name="package">
              {packages.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
          <label>
            Monthly value ($)
            <input
              name="mrr"
              type="number"
              min={0}
              max={1000000}
              step="0.01"
              defaultValue={0}
            />
          </label>
        </div>
        <div className="form-section-label">THE NEXT STEP</div>
        <div className="form-grid">
          <label>
            Next action
            <input
              name="nextAction"
              required
              placeholder="Schedule a discovery call"
              maxLength={300}
            />
          </label>
          <label>
            Follow-up date
            <input
              type="datetime-local"
              name="nextActionAt"
              required
              defaultValue={localDatetime()}
            />
          </label>
        </div>
        <div className="consent-fields">
          <label className="checkbox-label">
            <input type="checkbox" name="emailConsent" />
            Permission to email is recorded
          </label>
          <label className="checkbox-label">
            <input type="checkbox" name="smsConsent" />
            Permission to text is recorded
          </label>
          <label>
            Permission source
            <input
              name="consentSource"
              placeholder="Example: requested a demo through our website"
              maxLength={300}
            />
          </label>
        </div>
        <div className="form-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? <Loader2 className="spin" size={16} /> : <Plus size={16} />}
            Create lead
          </button>
        </div>
      </form>
    </Modal>
  );
}
function MessageComposer({
  value,
  demo,
  busy,
  onClose,
  onSave,
}: {
  value: Composer;
  demo: boolean;
  busy: boolean;
  onClose: () => void;
  onSave: (body: unknown) => Promise<void>;
}) {
  const [template, setTemplate] = useState(""),
    [text, setText] = useState(""),
    [subject, setSubject] = useState("");
  const key = useRef(crypto.randomUUID());
  const templates: Record<string, { subject: string; body: string }> = {
    Welcome: {
      subject: `Welcome to Linkd, ${value.customer.name}`,
      body: `Hi ${value.customer.contact_name.split(" ")[0]},\n\nWelcome to Linkd. We’re looking forward to getting your team started. I’ll help coordinate your intake, setup, and training.\n\nWhat is the best time this week to connect?`,
    },
    "Follow-up": {
      subject: "Following up on our conversation",
      body: `Hi ${value.customer.contact_name.split(" ")[0]}, just following up on our conversation. What questions can I help answer before we take the next step?`,
    },
    "Intake reminder": {
      subject: "Your next step with Linkd",
      body: `Hi ${value.customer.contact_name.split(" ")[0]}, a quick reminder that we’re waiting on your intake details and user list to keep your setup moving. Reply here if you need a hand.`,
    },
  };
  return (
    <Modal
      title={`${value.channel === "email" ? "Email" : "Text"} ${value.customer.contact_name}`}
      onClose={onClose}
    >
      <form
        className="modal-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          await onSave({
            contactId: value.customer.contact_id,
            channel: value.channel,
            subject,
            body: text,
            idempotencyKey: key.current,
            ...(f.get("scheduledAt")
              ? {
                  scheduledAt: new Date(
                    String(f.get("scheduledAt")),
                  ).toISOString(),
                }
              : {}),
          });
        }}
      >
        <div className="recipient-line">
          <Avatar name={value.customer.contact_name} />
          <div>
            <strong>{value.customer.name}</strong>
            <small>
              {value.channel === "email"
                ? value.customer.email
                : value.customer.phone}
            </small>
          </div>
        </div>
        {demo && (
          <div className="notice">
            Demo message: delivery will be simulated. Nothing leaves this
            workspace.
          </div>
        )}
        <label>
          Start from a template
          <select
            value={template}
            onChange={(e) => {
              setTemplate(e.target.value);
              const t = templates[e.target.value];
              if (t) {
                setText(t.body);
                setSubject(t.subject);
              }
            }}
          >
            <option value="">Write your own</option>
            {Object.keys(templates).map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        {value.channel === "email" && (
          <label>
            Subject
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              required
              maxLength={200}
            />
          </label>
        )}
        <label>
          Message
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            required
            rows={7}
            maxLength={10000}
            placeholder="Keep the conversation moving…"
          />
        </label>
        <label>
          Schedule for later <span className="muted">(optional)</span>
          <input
            type="datetime-local"
            name="scheduledAt"
            min={localDatetime(new Date())}
          />
        </label>
        <div className="form-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            <Send size={15} />
            {demo ? "Queue demo message" : "Queue message"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function CallDetail({
  call,
  onClose,
  onSave,
  busy,
}: {
  call: Call;
  onClose: () => void;
  onSave: (body: unknown) => Promise<boolean>;
  busy: boolean;
}) {
  const [search, setSearch] = useState("");
  return (
    <Modal
      title={`Call with ${call.company_name || "customer"}`}
      wide
      onClose={onClose}
    >
      <div className="call-detail">
        <div className="call-summary">
          <div className="row-between">
            <Badge tone={call.status === "demo" ? "amber" : "blue"}>
              {call.status === "demo" ? "Sample call" : call.status}
            </Badge>
            <span className="muted">
              {shortDate(call.created_at)} · {call.user_name}
            </span>
          </div>
          <h3>Call notes & outcome</h3>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              await onSave({
                id: call.id,
                outcome: f.get("outcome"),
                summary: f.get("summary"),
              });
            }}
          >
            <label>
              Outcome
              <select name="outcome" defaultValue={call.outcome || "Connected"}>
                {Array.from(
                  new Set(
                    [
                      call.outcome,
                      "Connected",
                      "Demo completed",
                      "Appointment set",
                      "No answer",
                      "Left voicemail",
                      "Not a fit",
                    ].filter(Boolean),
                  ),
                ).map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            <label>
              Summary / commitments
              <textarea
                name="summary"
                defaultValue={call.summary}
                rows={4}
                maxLength={5000}
                placeholder="Capture the next step and commitments from this call."
              />
            </label>
            <button className="button small-button" disabled={busy}>
              Save outcome
            </button>
          </form>
          {call.recording_sid && (
            <audio
              controls
              preload="none"
              src={`/api/calls/${call.id}/recording`}
            />
          )}
        </div>
        <div className="transcript-panel">
          <div className="row-between">
            <h3>Transcript</h3>
            <FileText size={17} />
          </div>
          <label className="transcript-search">
            <Search size={15} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search this conversation"
              aria-label="Search transcript"
            />
          </label>
          {call.transcript.length ? (
            <div className="transcript-lines">
              {call.transcript
                .filter((s) =>
                  s.text.toLowerCase().includes(search.toLowerCase()),
                )
                .map((s, i) => (
                  <div className="transcript-line" key={i}>
                    <span>
                      {Math.floor(Number(s.time) / 60)}:
                      {String(Math.floor(Number(s.time) % 60)).padStart(2, "0")}
                    </span>
                    <div>
                      <strong>{s.speaker}</strong>
                      <p>{s.text}</p>
                    </div>
                  </div>
                ))}
            </div>
          ) : (
            <Empty
              title="No transcript yet"
              body="Recorded live calls are transcribed after processing. Demo call actions do not create artificial conversations."
            />
          )}
        </div>
      </div>
    </Modal>
  );
}
function CallDialog({
  customer,
  demo,
  recording,
  onClose,
  onComplete,
}: {
  customer: Customer;
  demo: boolean;
  recording: boolean;
  onClose: () => void;
  onComplete: () => void;
}) {
  const [status, setStatus] = useState("Ready to call"),
    [busy, setBusy] = useState(false),
    [consent, setConsent] = useState(false),
    [error, setError] = useState("");
  const device = useRef<import("@twilio/voice-sdk").Device | null>(null),
    call = useRef<import("@twilio/voice-sdk").Call | null>(null);
  useEffect(
    () => () => {
      call.current?.disconnect();
      device.current?.destroy();
    },
    [],
  );
  async function start() {
    setBusy(true);
    setError("");
    try {
      const result = await api("calls/start", {
        contactId: customer.contact_id,
        recordingConsent: consent,
      });
      if (result.demo) {
        setStatus("Demo call logged — no number dialed");
        onComplete();
        return;
      }
      const { token } = await api("calls/token", {});
      const { Device } = await import("@twilio/voice-sdk");
      device.current = new Device(token, { logLevel: 1 });
      device.current.on("error", (e: Error) => {
        setError(e.message);
        setBusy(false);
      });
      device.current.on("tokenWillExpire", async () => {
        try {
          device.current?.updateToken((await api("calls/token", {})).token);
        } catch {
          setError("Session expired. End the call and sign in again.");
        }
      });
      setStatus("Connecting…");
      call.current = await device.current.connect({
        params: { CallId: result.id },
      });
      call.current.on("accept", () => setStatus("Call connected"));
      call.current.on("disconnect", () => {
        setStatus("Call ended");
        setBusy(false);
        onComplete();
      });
      call.current.on("cancel", () => {
        setStatus("Call cancelled");
        setBusy(false);
      });
      call.current.on("error", (e: Error) => {
        setError(e.message);
        setBusy(false);
      });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal title={demo ? "Demo call" : "Call customer"} onClose={onClose}>
      <div className="dialer">
        <div className="dialer-avatar">
          <Phone size={32} />
        </div>
        <h2>{customer.contact_name}</h2>
        <p>{customer.name}</p>
        <strong>{customer.phone || "No phone number"}</strong>
        <Badge tone="blue">{status}</Badge>
        {demo ? (
          <div className="notice">
            This logs a demo call. Live calling becomes available after Twilio
            is configured.
          </div>
        ) : (
          recording && (
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              I have confirmed recording permission. The customer will hear the
              recording notice.
            </label>
          )
        )}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="contact-actions">
          <button
            className="button primary"
            disabled={
              busy || !customer.phone || (!demo && recording && !consent)
            }
            onClick={start}
          >
            <Phone size={16} />
            {demo ? "Log demo call" : "Start call"}
          </button>
          {!demo && busy && (
            <button
              className="button danger"
              onClick={() => {
                call.current?.disconnect();
                device.current?.destroy();
                setBusy(false);
                setStatus("Call ended");
              }}
            >
              <PhoneOff size={16} />
              End call
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
