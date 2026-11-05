import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { db, transaction } from "./db";
import { hash, HttpError } from "./auth";
import { activity } from "./domain";
import { notify } from "./workflow-core";
import type { User } from "../lib/types";
export async function issueIntake(
  projectId: string,
  user: User,
  rotate = true,
) {
  const token = randomBytes(32).toString("hex");
  await transaction(async (tx) => {
    const p = (
      await tx.query("SELECT * FROM onboarding WHERE id=$1 FOR UPDATE", [
        projectId,
      ])
    ).rows[0];
    if (!p) throw new HttpError(404, "Project not found.");
    if (rotate)
      await tx.query(
        "UPDATE intake_links SET revoked_at=now() WHERE project_id=$1 AND revoked_at IS NULL",
        [projectId],
      );
    await tx.query(
      "INSERT INTO intake_links(id,project_id,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '30 days')",
      [randomUUID(), projectId, hash(token)],
    );
    await activity(
      tx,
      p.company_id,
      user.id,
      "onboarding",
      "Secure intake link issued",
      rotate
        ? "Expires in 30 days; older links revoked."
        : "Expires in 30 days.",
    );
  });
  return {
    url: new URL(
      `/intake/${token}`,
      process.env.APP_URL || "http://localhost:3000",
    ).toString(),
  };
}
export async function intakeInfo(token: string) {
  const row = (
    await db.query(
      "SELECT c.name,p.package,p.intake_received_at FROM intake_links l JOIN onboarding p ON p.id=l.project_id JOIN companies c ON c.id=p.company_id WHERE l.token_hash=$1 AND l.revoked_at IS NULL AND l.expires_at>now()",
      [hash(token)],
    )
  ).rows[0];
  if (!row)
    throw new HttpError(
      404,
      "This intake link has expired or been replaced. Request a fresh link from your Linkd contact.",
    );
  return row;
}
export const intakeInput = z
  .object({
    requestKey: z.uuid(),
    contactName: z.string().trim().min(2).max(150),
    email: z.email(),
    phone: z.string().max(40),
    pos: z.string().trim().min(1).max(100),
    locations: z.number().int().min(1).max(1000),
    desiredStart: z.union([z.iso.date(), z.literal("")]),
    userList: z.string().max(20000),
    requirements: z.string().max(10000),
    files: z
      .array(
        z.object({
          name: z.string().min(1).max(160),
          mime: z.enum(["text/csv", "text/plain", "application/pdf"]),
          data: z.string().max(2800000),
        }),
      )
      .max(3),
  })
  .refine((x) => x.userList.trim().length > 0 || x.files.length > 0, {
    message: "Provide the user list or attach a file.",
  });
export async function submitIntake(
  token: string,
  input: z.infer<typeof intakeInput>,
) {
  const files = input.files.map((file) => {
    const content = Buffer.from(file.data, "base64");
    if (content.length > 2000000 || !content.length)
      throw new HttpError(400, "Each file must be between 1 byte and 2 MB.");
    if (
      file.mime === "application/pdf" &&
      !content.subarray(0, 5).equals(Buffer.from("%PDF-"))
    )
      throw new HttpError(400, "The PDF is not valid.");
    if (
      file.mime !== "application/pdf" &&
      (content.includes(0) ||
        /<(?:script|html|svg)\b/i.test(content.toString("utf8")))
    )
      throw new HttpError(
        400,
        "Only plain-text CSV/TXT files or PDFs are accepted.",
      );
    return { ...file, name: file.name.replace(/[^\w. ()-]/g, "_"), content };
  });
  return transaction(async (tx) => {
    const link = (
      await tx.query(
        "SELECT l.*,p.company_id,p.owner_id,p.cs_owner_id FROM intake_links l JOIN onboarding p ON p.id=l.project_id WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now() FOR UPDATE OF l,p",
        [hash(token)],
      )
    ).rows[0];
    if (!link)
      throw new HttpError(
        404,
        "This intake link has expired or been replaced.",
      );
    const existing = (
      await tx.query(
        "SELECT project_id FROM intake_submissions WHERE request_key=$1",
        [input.requestKey],
      )
    ).rows[0];
    if (existing) {
      if (existing.project_id !== link.project_id)
        throw new HttpError(409, "Request key already used.");
      return;
    }
    if (
      Number(
        (
          await tx.query(
            "SELECT count(*) FROM intake_submissions WHERE project_id=$1 AND created_at>now()-interval '1 day'",
            [link.project_id],
          )
        ).rows[0].count,
      ) >= 10
    )
      throw new HttpError(
        429,
        "Too many submissions today. Contact your onboarding team.",
      );
    const id = randomUUID();
    const { files: _files, requestKey: _key, ...payload } = input;
    await tx.query(
      "INSERT INTO intake_submissions(id,project_id,request_key,payload) VALUES ($1,$2,$3,$4)",
      [id, link.project_id, input.requestKey, JSON.stringify(payload)],
    );
    for (const f of files)
      await tx.query(
        "INSERT INTO intake_files(id,submission_id,name,mime,content) VALUES ($1,$2,$3,$4,$5)",
        [randomUUID(), id, f.name, f.mime, f.content],
      );
    await tx.query(
      "UPDATE onboarding SET intake_received_at=now(),version=version+1 WHERE id=$1",
      [link.project_id],
    );
    await tx.query(
      "UPDATE jobs SET status='cancelled' WHERE kind='intake_nudge' AND payload->>'projectId'=$1 AND status='pending'",
      [link.project_id],
    );
    await activity(
      tx,
      link.company_id,
      null,
      "onboarding",
      "Customer intake received",
      "Review the submitted details and user list before confirming readiness.",
    );
    for (const owner of new Set<string>(
      [link.owner_id, link.cs_owner_id].filter(Boolean),
    ))
      await notify(
        tx,
        owner,
        link.company_id,
        "Intake received",
        "Review the new submission and attached user list.",
        `intake:${id}:${owner}`,
      );
  });
}
export async function submissions(projectId: string) {
  return (
    await db.query(
      "SELECT s.*,COALESCE((SELECT json_agg(json_build_object('id',f.id,'name',f.name,'mime',f.mime)) FROM intake_files f WHERE f.submission_id=s.id),'[]'::json) files FROM intake_submissions s WHERE project_id=$1 ORDER BY created_at DESC",
      [projectId],
    )
  ).rows;
}
