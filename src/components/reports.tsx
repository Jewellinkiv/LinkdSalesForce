"use client";
import { useState } from "react";
import {
  CircleDollarSign,
  Users,
  MapPin,
  Columns3,
  Trophy,
  CalendarCheck,
  Rocket,
  Target,
} from "lucide-react";
import type { Workspace } from "@/lib/types";
const metricVisuals: Record<string, { tone: string; icon: typeof Users }> = {
  "Current MRR": { tone: "teal", icon: CircleDollarSign },
  "Active customers": { tone: "blue", icon: Users },
  "Active locations": { tone: "cyan", icon: MapPin },
  "Pipeline MRR": { tone: "violet", icon: Columns3 },
  "Booked MRR": { tone: "green", icon: Trophy },
  "Closed won this month": { tone: "blue", icon: CalendarCheck },
  "Onboarding MRR": { tone: "teal", icon: Rocket },
  "Monthly win rate": { tone: "violet", icon: Target },
};
const money = (c: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(c / 100);
export function Reports({
  data,
  openCustomer,
}: {
  data: Workspace;
  openCustomer: (id: string) => void;
}) {
  const [owner, setOwner] = useState("all"),
    [month, setMonth] = useState(new Date().toISOString().slice(0, 7)),
    [metric, setMetric] = useState("Current MRR");
  const accounts = data.customers.filter(
    (c) => owner === "all" || c.owner_id === owner,
  );
  const deals = data.opportunities.filter(
    (o) =>
      o.kind === "deal" &&
      (owner === "all" || o.opportunity_owner_id === owner),
  );
  const active = accounts.filter((c) => c.lifecycle === "active");
  const pipeline = deals.filter(
    (o) => !["Won", "Lost", "Be back", "Qualified"].includes(o.stage),
  );
  const won = deals.filter((o) => o.stage === "Won"),
    closed = deals.filter(
      (o) =>
        o.closed_at?.startsWith(month) && ["Won", "Lost"].includes(o.stage),
    );
  const projects = data.projects.filter(
    (p) =>
      p.phase !== "Onboarded" &&
      (owner === "all" ||
        p.owner_id === owner ||
        p.cs_owner_id === owner ||
        p.sales_owner_id === owner),
  );
  const cards = [
    [
      "Current MRR",
      money(active.reduce((s, c) => s + (c.current_mrr_cents || 0), 0)),
      "Verified active-account amounts; unverified accounts excluded",
    ],
    [
      "Active customers",
      String(active.length),
      "Distinct active customer accounts",
    ],
    [
      "Active locations",
      String(active.reduce((s, c) => s + c.locations, 0)),
      "Locations belonging to active customer accounts",
    ],
    [
      "Pipeline MRR",
      money(pipeline.reduce((s, c) => s + c.mrr_cents, 0)),
      "Open qualified deals; excludes lost, won, and be back",
    ],
    [
      "Booked MRR",
      money(won.reduce((s, c) => s + c.mrr_cents, 0)),
      "All-time won-deal value; may include repeat sales",
    ],
    [
      "Closed won this month",
      String(closed.filter((c) => c.stage === "Won").length),
      `Closed date in ${month} (UTC)`,
    ],
    [
      "Onboarding MRR",
      money(projects.reduce((s, p) => s + p.mrr_cents, 0)),
      "Deal value tied to unfinished projects; existing projects may have no deal",
    ],
    [
      "Monthly win rate",
      `${Math.round((100 * closed.filter((c) => c.stage === "Won").length) / Math.max(1, closed.length))}%`,
      "Won / (won + lost) closed in selected month",
    ],
  ];
  let rows: { id: string; name: string; status: string; value: string }[] = [];
  if (["Current MRR", "Active customers", "Active locations"].includes(metric))
    rows = active.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.current_mrr_cents === null ? "MRR unverified" : c.lifecycle,
      value:
        metric === "Active locations"
          ? `${c.locations} locations`
          : c.current_mrr_cents === null
            ? "—"
            : money(c.current_mrr_cents),
    }));
  else if (metric === "Onboarding MRR")
    rows = projects.map((p) => ({
      id: p.company_id,
      name: p.company_name,
      status: p.phase,
      value: money(p.mrr_cents),
    }));
  else
    rows = (
      metric === "Pipeline MRR"
        ? pipeline
        : metric === "Booked MRR"
          ? won
          : metric === "Closed won this month"
            ? closed.filter((c) => c.stage === "Won")
            : closed
    ).map((c) => ({
      id: c.id,
      name: c.name,
      status: c.stage,
      value: money(c.mrr_cents),
    }));
  return (
    <>
      <div className="operations-toolbar">
        <label>
          Owner{" "}
          <select value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="all">All owners</option>
            {data.users.map((u) => (
              <option value={u.id} key={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Close reporting month{" "}
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
          />
        </label>
        <button
          className="button"
          onClick={() => {
            const csv = [
              "Company,Status,Value",
              ...rows.map((r) =>
                [r.name, r.status, r.value]
                  .map(
                    (v) =>
                      '"' +
                      (/[=+@\-\t\r]/.test(v[0] || "") ? "'" : "") +
                      v.replaceAll('"', '""') +
                      '"',
                  )
                  .join(","),
              ),
            ].join("\r\n");
            const url = URL.createObjectURL(
              new Blob([csv], { type: "text/csv" }),
            );
            const a = document.createElement("a");
            a.href = url;
            a.download = "linkd-report.csv";
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          Export current detail
        </button>
      </div>
      {active.some((c) => c.current_mrr_cents === null) && (
        <div className="notice amber">
          {active.filter((c) => c.current_mrr_cents === null).length} active
          accounts need verified current MRR. The current MRR total is
          incomplete until those amounts are entered.
        </div>
      )}
      <div className="metrics">
        {cards.map(([name, value, description]) => {
          const { tone, icon: Icon } = metricVisuals[name];
          return (
            <button
              className="metric report-metric"
              data-tone={tone}
              aria-pressed={metric === name}
              key={name}
              onClick={() => setMetric(name)}
            >
              <div>
                <span>{name}</span>
                <i aria-hidden="true">
                  <Icon size={22} />
                </i>
              </div>
              <strong>{value}</strong>
              <small>{description}</small>
            </button>
          );
        })}
      </div>
      <section className="panel">
        <div className="panel-head">
          <h2>{metric} · detail</h2>
          <span>{rows.length} records</span>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Customer</th>
                <th>Status</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.id}:${i}`}>
                  <td>
                    <button
                      className="heading-button"
                      onClick={() => openCustomer(r.id)}
                    >
                      {r.name}
                    </button>
                  </td>
                  <td>{r.status}</td>
                  <td>{r.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="report-note">
          Account metrics use account owners; deal metrics use opportunity
          owners; onboarding includes technical, CS, and sales owners. Current
          MRR is team-verified contract value, not collected revenue. Month
          selection applies to monthly close metrics.
        </p>
      </section>
    </>
  );
}
