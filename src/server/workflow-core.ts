import { randomUUID } from "node:crypto";
import { HttpError } from "./auth";
import type { Connection } from "./db";

export async function notify(
  tx: Connection,
  userId: string,
  companyId: string | null,
  title: string,
  body: string,
  key: string,
) {
  await tx.query(
    "INSERT INTO notifications(id,user_id,company_id,title,body,dedupe_key) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(dedupe_key) DO NOTHING",
    [randomUUID(), userId, companyId, title, body, key],
  );
}
export function addBusinessDays(start: Date, days: number) {
  const result = new Date(start);
  while (days > 0) {
    result.setUTCDate(result.getUTCDate() + 1);
    if (![0, 6].includes(result.getUTCDay())) days--;
  }
  return result;
}
export function readinessDefaults(pkg: string): Record<
  string,
  {
    status: "not_started" | "in_progress" | "verified" | "not_applicable";
    notes: string;
  }
> {
  const data = ["Full suite", "Data & training"].includes(pkg),
    texting = ["Full suite", "Texting"].includes(pkg);
  return Object.fromEntries(
    [
      "user_list",
      "data",
      "texting",
      "branding",
      "calendar",
      "webchat",
      "facebook",
      "instagram",
      "whatsapp",
      "payments",
      "training",
      "modules",
      "manager",
      "live",
      "adoption",
    ].map((key) => [
      key,
      {
        status:
          (key === "data" && !data) ||
          (key === "texting" && !texting) ||
          ([
            "branding",
            "calendar",
            "webchat",
            "facebook",
            "instagram",
            "whatsapp",
            "payments",
          ].includes(key) &&
            pkg !== "Full suite") ||
          ["facebook", "instagram", "whatsapp", "payments"].includes(key)
            ? "not_applicable"
            : "not_started",
        notes: "",
      },
    ]),
  );
}
export function checkReadiness(p: {
  phase: string;
  owner_id: string;
  cs_owner_id: string | null;
  intake_received_at: string | null;
  readiness: Record<string, { status: string; notes: string }>;
  go_live_at: string | null;
}) {
  const requireKeys = (
    keys: string[],
    allowed = ["verified", "not_applicable"],
  ) => {
    const missing = keys.filter(
      (k) => !allowed.includes(p.readiness[k]?.status),
    );
    if (missing.length)
      throw new HttpError(
        409,
        `Confirm readiness: ${missing.join(", ").replaceAll("_", " ")}.`,
      );
  };
  if (p.phase === "Handoff" && (!p.owner_id || !p.cs_owner_id))
    throw new HttpError(
      409,
      "Assign both technical and customer-success owners.",
    );
  if (p.phase === "Intake & pre-build") {
    if (!p.intake_received_at)
      throw new HttpError(
        409,
        "Receive the customer intake before the working session.",
      );
    requireKeys(["user_list"]);
    requireKeys(
      ["data", "texting"],
      ["in_progress", "verified", "not_applicable"],
    );
  }
  if (p.phase === "Working session")
    requireKeys([
      "data",
      "texting",
      "branding",
      "calendar",
      "webchat",
      "facebook",
      "instagram",
      "whatsapp",
      "payments",
    ]);
  if (p.phase === "Training") requireKeys(["training", "modules", "manager"]);
  if (p.phase === "Go-live") {
    requireKeys(["live"]);
    if (
      !p.go_live_at ||
      new Date(p.go_live_at).toISOString().slice(0, 10) >
        new Date().toISOString().slice(0, 10)
    )
      throw new HttpError(
        409,
        "Record an actual go-live date, today or earlier.",
      );
  }
  if (p.phase === "Adoption") requireKeys(["adoption", "manager"]);
}
export async function assertOwner(tx: Connection, id: string) {
  if (
    !(await tx.query("SELECT id FROM users WHERE id=$1 AND active=true", [id]))
      .rowCount
  )
    throw new HttpError(400, "Choose an active team member.");
}
