import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, transaction, type Connection } from "./db";
import { HttpError, hash, requireRole } from "./auth";
import { assertOwner } from "./workflow-core";
import {
  readRetailerFile,
  mapRetailerRows,
  normalizeRetailer,
} from "./retailer-files";
import { retailerFields, type RetailerRow } from "../lib/retailers";
import type { User } from "../lib/types";
import { cancelQueued } from "./domain";

const text = (max = 500) => z.string().trim().max(max).default("");
const fileInput = z.object({
  name: z
    .string()
    .max(200)
    .regex(/\.(xlsx|csv)$/i),
  data: z.string().max(2800000),
});
const selection = z.object({
  file: fileInput,
  sheet: z.string().max(200),
  headerRow: z.number().int().min(0).max(19),
  mapping: z.partialRecord(
    z.enum(retailerFields),
    z.number().int().min(0).max(99),
  ),
  group: z.string().trim().min(1).max(80),
  list: z.string().trim().min(1).max(150),
});
const identity = (r: RetailerRow) =>
  [r.name, r.city, r.state].map(normalizeRetailer).join("|");
const view = `SELECT r.*,COALESCE(r.company_id,p.company_id) AS company_id,
 CASE WHEN c.id IS NOT NULL THEN CASE WHEN c.lifecycle IN ('active','onboarding') THEN 'current' WHEN c.lifecycle='paused' THEN 'unverified' ELSE 'not_current' END ELSE r.client_status END AS effective_client_status,
 u.name AS owner_name,
 COALESCE((SELECT array_agg(DISTINCT group_name ORDER BY group_name) FROM retailer_sources WHERE retailer_id=r.id),'{}') AS groups,
 COALESCE((SELECT array_agg(DISTINCT list_name ORDER BY list_name) FROM retailer_sources WHERE retailer_id=r.id),'{}') AS lists,
 (SELECT count(*)::int FROM retailer_people WHERE retailer_id=r.id) AS people_count,
 GREATEST((SELECT max(occurred_at) FROM retailer_events WHERE retailer_id=r.id AND kind IN ('call','email','sms','meeting')),
 (SELECT max(created_at) FROM messages WHERE company_id=c.id AND status IN ('sent','delivered','received')),
 (SELECT max(created_at) FROM calls WHERE company_id=c.id AND status='completed' AND provider_id IS NOT NULL)) AS last_touch,
 (SELECT id FROM retailer_photos WHERE retailer_id=r.id ORDER BY created_at DESC LIMIT 1) AS photo_id
 FROM retailers r LEFT JOIN prospects p ON p.id=r.prospect_id LEFT JOIN companies c ON c.id=COALESCE(r.company_id,p.company_id) JOIN users u ON u.id=r.owner_id`;

async function plan(tx: Connection, rows: RetailerRow[]) {
  const existing = (
    await tx.query("SELECT id,identity_key,name,address FROM retailers")
  ).rows;
  const known = new Map(existing.map((r) => [r.identity_key, r]));
  let created = 0,
    matched = 0;
  const warnings: { row: number; reason: string }[] = [];
  for (const row of rows) {
    let key = identity(row);
    if (!normalizeRetailer(row.city) || !normalizeRetailer(row.state)) {
      key += "|" + hash(JSON.stringify(row.raw));
      warnings.push({
        row: row.row,
        reason: "Incomplete location; kept separate for review",
      });
    }
    const candidate = known.get(key);
    if (
      candidate?.address &&
      row.address &&
      normalizeRetailer(candidate.address) !== normalizeRetailer(row.address)
    ) {
      key += "|" + normalizeRetailer(row.address);
      warnings.push({
        row: row.row,
        reason:
          "Same name/location, different address; kept separate for review",
      });
    }
    if (known.has(key)) matched++;
    else {
      created++;
      known.set(key, {
        id: "",
        identity_key: key,
        name: row.name,
        address: row.address,
      });
    }
  }
  return { created, matched, warnings, sourceRows: rows.length };
}
export async function previewRetailers(input: unknown, user: User) {
  const data = selection.parse(input),
    parsed = await readRetailerFile(data.file),
    sheet = parsed.sheets.find((s) => s.name === data.sheet);
  if (!sheet) throw new HttpError(400, "Choose a worksheet from this file.");
  const { rows, skipped } = mapRetailerRows(
    sheet,
    data.mapping,
    data.headerRow,
  );
  if (!rows.length)
    throw new HttpError(
      400,
      "No retailer rows found. Check the sheet, header and column mapping.",
    );
  const fingerprint = hash(
    JSON.stringify([
      parsed.fingerprint,
      data.sheet,
      data.headerRow,
      data.mapping,
      data.group,
      data.list,
    ]),
  );
  const already = (
    await db.query(
      "SELECT id,summary FROM retailer_imports WHERE fingerprint=$1 AND applied_at IS NOT NULL",
      [fingerprint],
    )
  ).rows[0];
  if (already)
    return {
      id: already.id,
      already: true,
      ...already.summary,
      skipped,
      sample: rows.slice(0, 8),
    };
  const summary = await plan(db, rows),
    id = randomUUID();
  await db.query(
    "INSERT INTO retailer_imports(id,fingerprint,filename,sheet,group_name,list_name,rows,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [
      id,
      fingerprint,
      data.file.name,
      data.sheet,
      data.group,
      data.list,
      JSON.stringify(rows),
      user.id,
    ],
  );
  return { id, ...summary, skipped, sample: rows.slice(0, 8) };
}
export async function applyRetailers(id: string, user: User) {
  return transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(17304570)");
    const batch = (
      await tx.query("SELECT * FROM retailer_imports WHERE id=$1 FOR UPDATE", [
        id,
      ])
    ).rows[0];
    if (!batch) throw new HttpError(404, "Import preview not found.");
    if (batch.created_by !== user.id && user.role !== "admin")
      throw new HttpError(
        403,
        "Only the importing teammate or an admin can apply this preview.",
      );
    const previous = (
      await tx.query(
        "SELECT summary FROM retailer_imports WHERE fingerprint=$1 AND applied_at IS NOT NULL",
        [batch.fingerprint],
      )
    ).rows[0];
    if (previous) return { ...previous.summary, already: true };
    await assertOwner(tx, user.id);
    const rows = batch.rows as RetailerRow[],
      summary = await plan(tx, rows);
    for (const row of rows) {
      let key = identity(row);
      let review =
        !normalizeRetailer(row.city) || !normalizeRetailer(row.state);
      if (review) key += "|" + hash(JSON.stringify(row.raw));
      const candidate = (
        await tx.query(
          "SELECT id,address FROM retailers WHERE identity_key=$1",
          [key],
        )
      ).rows[0];
      if (
        candidate?.address &&
        row.address &&
        normalizeRetailer(candidate.address) !== normalizeRetailer(row.address)
      ) {
        key += "|" + normalizeRetailer(row.address);
        review = true;
      }
      const retailer = (
        await tx.query(
          `INSERT INTO retailers(id,identity_key,name,city,state,country,address,postal,website,owner_id,tags)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(identity_key) DO UPDATE SET identity_key=excluded.identity_key RETURNING id`,
          [
            randomUUID(),
            key,
            row.name,
            row.city,
            row.state,
            row.country,
            row.address,
            row.postal,
            row.website,
            user.id,
            review ? ["Review duplicate / location"] : [],
          ],
        )
      ).rows[0].id;
      await tx.query(
        "INSERT INTO retailer_sources(id,retailer_id,import_id,group_name,list_name,source_row,raw) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          randomUUID(),
          retailer,
          id,
          batch.group_name,
          batch.list_name,
          row.row,
          JSON.stringify(row.raw),
        ],
      );
      if (/hold/i.test(batch.sheet))
        await tx.query(
          "UPDATE retailers SET tags=array(SELECT DISTINCT unnest(tags||ARRAY['Membership on hold'])) WHERE id=$1",
          [retailer],
        );
      const people = [
        {
          name: row.contactName,
          title: "",
          email: row.email,
          phone: row.phone,
        },
      ];
      if (
        row.ownerName &&
        normalizeRetailer(row.ownerName) !== normalizeRetailer(row.contactName)
      )
        people.push({
          name: row.ownerName,
          title: "Owner (source list)",
          email: "",
          phone: "",
        });
      for (const person of people) {
        if (!person.name && !person.email && !person.phone) continue;
        // Identity is scoped to this store; a shared store phone never merges different people.
        const sourceKey = hash(
          JSON.stringify([
            person.name.toLowerCase(),
            person.email.toLowerCase(),
            person.phone,
          ]),
        );
        await tx.query(
          "INSERT INTO retailer_people(id,retailer_id,name,title,email,phone,notes,source_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(retailer_id,source_key) DO NOTHING",
          [
            randomUUID(),
            retailer,
            person.name,
            person.title,
            person.email,
            person.phone,
            row.notes,
            sourceKey,
          ],
        );
      }
    }
    await tx.query(
      "UPDATE retailer_imports SET applied_at=now(),summary=$2 WHERE id=$1",
      [id, JSON.stringify(summary)],
    );
    return summary;
  });
}

export async function retailerDetail(id: string) {
  const retailer = (await db.query(view + " WHERE r.id=$1", [id])).rows[0];
  if (!retailer) throw new HttpError(404, "Retailer not found.");
  const [people, events, photos, sources, accounts, history] =
    await Promise.all([
      db.query(
        "SELECT id,name,title,email,phone,notes,version FROM retailer_people WHERE retailer_id=$1 ORDER BY name",
        [id],
      ),
      db.query(
        "SELECT e.*,u.name AS author FROM retailer_events e JOIN users u ON u.id=e.user_id WHERE retailer_id=$1 ORDER BY occurred_at DESC LIMIT 200",
        [id],
      ),
      db.query(
        "SELECT id,caption,person_id FROM retailer_photos WHERE retailer_id=$1 ORDER BY created_at DESC",
        [id],
      ),
      db.query(
        "SELECT s.*,i.filename,i.sheet FROM retailer_sources s JOIN retailer_imports i ON i.id=s.import_id WHERE retailer_id=$1 ORDER BY i.created_at DESC,s.source_row",
        [id],
      ),
      db.query("SELECT id,name,city,lifecycle FROM companies ORDER BY name"),
      db.query(
        `SELECT * FROM (
   SELECT id,kind,title||': '||body AS body,created_at FROM activities WHERE company_id=$1
   UNION ALL SELECT id,channel||' · '||direction||' · '||status||' · '||delivery_mode,subject||' '||body,created_at FROM messages WHERE company_id=$1
   UNION ALL SELECT id,'call · '||status,summary||' '||outcome,created_at FROM calls WHERE company_id=$1
  ) h ORDER BY created_at DESC LIMIT 100`,
        [retailer.company_id],
      ),
    ]);
  return {
    retailer,
    people: people.rows,
    events: events.rows,
    photos: photos.rows,
    sources: sources.rows,
    accounts: accounts.rows,
    history: history.rows,
  };
}

export async function retailerRoute(
  path: string,
  request: Request,
  body: unknown,
  user: User,
) {
  if (!path.startsWith("retailers")) return null;
  const url = new URL(request.url);
  if (request.method === "GET") {
    if (path === "retailers") {
      const q = (url.searchParams.get("q") || "").slice(0, 200),
        group = url.searchParams.get("group") || "",
        status = url.searchParams.get("status") || "",
        tag = url.searchParams.get("tag") || "",
        outreach = url.searchParams.get("outreach") || "";
      const page = Math.max(
        0,
        Math.min(10000, Number(url.searchParams.get("page")) || 0),
      );
      const base = `WITH network AS (${view}) SELECT * FROM network WHERE ($1='' OR name ILIKE '%'||$1||'%' OR city ILIKE '%'||$1||'%' OR state ILIKE '%'||$1||'%') AND ($2='' OR $2=ANY(groups)) AND ($3='' OR effective_client_status=$3) AND ($4='' OR $4=ANY(tags)) AND ($5='' OR outreach_status=$5)`;
      const args = [q, group, status, tag, outreach];
      const [rows, count, groups, tags, stats] = await Promise.all([
        db.query(base + " ORDER BY name,id LIMIT 50 OFFSET $6", [
          ...args,
          page * 50,
        ]),
        db.query(
          "SELECT count(*)::int total FROM (" + base + ") filtered",
          args,
        ),
        db.query(
          "SELECT DISTINCT group_name FROM retailer_sources ORDER BY group_name",
        ),
        db.query(
          "SELECT DISTINCT unnest(tags) AS tag FROM retailers ORDER BY tag",
        ),
        db.query(
          `SELECT count(*)::int total,count(*) FILTER(WHERE effective_client_status='current')::int current,count(*) FILTER(WHERE effective_client_status='unverified')::int unverified,count(*) FILTER(WHERE last_touch IS NOT NULL)::int contacted FROM (${base}) n`,
          args,
        ),
      ]);
      return Response.json(
        {
          retailers: rows.rows,
          total: count.rows[0].total,
          groups: groups.rows.map((r) => r.group_name),
          tags: tags.rows.map((r) => r.tag),
          stats: stats.rows[0],
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    if (path === "retailers/detail")
      return Response.json(
        await retailerDetail(z.uuid().parse(url.searchParams.get("id"))),
        { headers: { "Cache-Control": "no-store" } },
      );
    if (path === "retailers/photo") {
      const p = (
        await db.query("SELECT mime,content FROM retailer_photos WHERE id=$1", [
          z.uuid().parse(url.searchParams.get("id")),
        ])
      ).rows[0];
      if (!p) throw new HttpError(404, "Photo not found.");
      return new Response(p.content, {
        headers: {
          "Content-Type": p.mime,
          "Cache-Control": "private,no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    throw new HttpError(404, "Route not found.");
  }
  requireRole(user, ["admin", "sales"]);
  if (path === "retailers/parse")
    return Response.json(await readRetailerFile(fileInput.parse(body)));
  if (path === "retailers/preview")
    return Response.json(await previewRetailers(body, user));
  if (path === "retailers/import")
    return Response.json(
      await applyRetailers(z.object({ id: z.uuid() }).parse(body).id, user),
    );
  if (path === "retailers/save") {
    const b = z
      .object({
        id: z.uuid(),
        version: z.number().int(),
        ownerId: z.uuid(),
        companyId: z.union([z.uuid(), z.literal("")]),
        clientStatus: z.enum(["current", "not_current", "unverified"]),
        clientEvidence: text(2000),
        outreachStatus: z.enum([
          "not_started",
          "contacted",
          "replied",
          "meeting_booked",
          "nurture",
          "do_not_contact",
        ]),
        nextAction: text(300),
        nextAt: z.union([z.iso.datetime(), z.literal("")]),
        tags: z.array(z.string().trim().min(1).max(80)).max(30),
      })
      .parse(body);
    if (b.clientStatus !== "unverified" && !b.companyId && !b.clientEvidence)
      throw new HttpError(400, "Record how client status was verified.");
    if (Boolean(b.nextAction) !== Boolean(b.nextAt))
      throw new HttpError(400, "Add both a next action and follow-up date.");
    await transaction(async (tx) => {
      await assertOwner(tx, b.ownerId);
      const r = (
        await tx.query("SELECT * FROM retailers WHERE id=$1 FOR UPDATE", [b.id])
      ).rows[0];
      if (!r || r.version !== b.version)
        throw new HttpError(409, "This record changed. Refresh before saving.");
      if (
        b.companyId &&
        !(await tx.query("SELECT id FROM companies WHERE id=$1", [b.companyId]))
          .rowCount
      )
        throw new HttpError(400, "Account not found.");
      if (r.prospect_id) {
        const p = (
          await tx.query("SELECT company_id FROM prospects WHERE id=$1", [
            r.prospect_id,
          ])
        ).rows[0];
        if (p?.company_id && p.company_id !== b.companyId)
          throw new HttpError(
            409,
            "This retailer has a converted sales record. Keep its linked account.",
          );
      }
      await tx.query(
        "UPDATE retailers SET owner_id=$2,company_id=$3,client_status=$4,client_evidence=$5,outreach_status=$6,next_action=$7,next_at=$8,tags=$9,version=version+1 WHERE id=$1",
        [
          b.id,
          b.ownerId,
          b.companyId || null,
          b.clientStatus,
          b.clientEvidence,
          b.outreachStatus,
          b.nextAction,
          b.nextAt || null,
          [...new Set(b.tags)],
        ],
      );
      if (b.outreachStatus === "do_not_contact" && b.companyId) {
        await tx.query(
          "UPDATE companies SET do_not_contact=true,version=version+1 WHERE id=$1",
          [b.companyId],
        );
        const contacts = (
          await tx.query(
            "SELECT contact_id FROM company_contacts WHERE company_id=$1",
            [b.companyId],
          )
        ).rows;
        for (const contact of contacts)
          await cancelQueued(
            tx,
            contact.contact_id,
            "Retailer marked do not contact",
          );
      }
      await tx.query(
        "INSERT INTO retailer_events(id,retailer_id,user_id,request_key,kind,body) VALUES($1,$2,$3,$1,'profile',$4)",
        [
          randomUUID(),
          b.id,
          user.id,
          `Updated assignment, client verification and outreach plan. Client: ${b.clientStatus}. ${b.clientEvidence}`,
        ],
      );
    });
  } else if (path === "retailers/tags") {
    const b = z
      .object({
        ids: z.array(z.uuid()).min(1).max(500),
        tag: z.string().trim().min(1).max(80),
        remove: z.boolean().default(false),
      })
      .parse(body);
    await db.query(
      b.remove
        ? "UPDATE retailers SET tags=array_remove(tags,$2),version=version+1 WHERE id=ANY($1::uuid[])"
        : "UPDATE retailers SET tags=array(SELECT DISTINCT unnest(tags||ARRAY[$2::text])),version=version+1 WHERE id=ANY($1::uuid[])",
      [b.ids, b.tag],
    );
  } else if (path === "retailers/person") {
    const b = z
      .object({
        retailerId: z.uuid(),
        id: z.uuid().optional(),
        version: z.number().int().optional(),
        name: text(200),
        title: text(200),
        email: text(500),
        phone: text(200),
        notes: text(5000),
      })
      .parse(body);
    if (!b.name && !b.email && !b.phone)
      throw new HttpError(400, "Add a name or contact information.");
    if (b.id) {
      if (
        !(
          await db.query(
            "UPDATE retailer_people SET name=$3,title=$4,email=$5,phone=$6,notes=$7,version=version+1 WHERE id=$1 AND retailer_id=$2 AND version=$8",
            [
              b.id,
              b.retailerId,
              b.name,
              b.title,
              b.email,
              b.phone,
              b.notes,
              b.version,
            ],
          )
        ).rowCount
      )
        throw new HttpError(409, "Contact changed. Refresh and try again.");
    } else
      await db.query(
        "INSERT INTO retailer_people(id,retailer_id,name,title,email,phone,notes) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          randomUUID(),
          b.retailerId,
          b.name,
          b.title,
          b.email,
          b.phone,
          b.notes,
        ],
      );
  } else if (path === "retailers/event") {
    const b = z
      .object({
        id: z.uuid(),
        requestKey: z.uuid(),
        kind: z.enum(["note", "call", "email", "sms", "meeting"]),
        body: z.string().trim().min(1).max(10000),
        occurredAt: z.iso.datetime(),
      })
      .parse(body);
    if (new Date(b.occurredAt).getTime() > Date.now() + 60000)
      throw new HttpError(
        400,
        "Log completed outreach in the past; use next action for future work.",
      );
    await transaction(async (tx) => {
      const inserted = await tx.query(
        "INSERT INTO retailer_events(id,retailer_id,user_id,request_key,kind,body,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(request_key) DO NOTHING",
        [
          randomUUID(),
          b.id,
          user.id,
          b.requestKey,
          b.kind,
          b.body,
          b.occurredAt,
        ],
      );
      if (inserted.rowCount && b.kind !== "note")
        await tx.query(
          "UPDATE retailers SET outreach_status=CASE WHEN outreach_status='not_started' THEN 'contacted' ELSE outreach_status END,version=version+1 WHERE id=$1",
          [b.id],
        );
    });
  } else if (path === "retailers/photo") {
    const b = z
      .object({
        id: z.uuid(),
        personId: z.union([z.uuid(), z.literal("")]),
        requestKey: z.uuid(),
        caption: z.string().trim().min(1).max(500),
        mime: z.enum(["image/jpeg", "image/png", "image/webp"]),
        data: z.string().max(2800000),
      })
      .parse(body);
    const bytes = Buffer.from(b.data, "base64");
    const valid =
      b.mime === "image/jpeg"
        ? bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
        : b.mime === "image/png"
          ? bytes
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : bytes.toString("ascii", 0, 4) === "RIFF" &&
            bytes.toString("ascii", 8, 12) === "WEBP";
    if (!valid || bytes.length > 2000000 || !bytes.length)
      throw new HttpError(
        400,
        "Choose a valid JPEG, PNG or WebP photo up to 2 MB.",
      );
    if (
      b.personId &&
      !(
        await db.query(
          "SELECT id FROM retailer_people WHERE id=$1 AND retailer_id=$2",
          [b.personId, b.id],
        )
      ).rowCount
    )
      throw new HttpError(400, "Choose a person at this retailer.");
    await db.query(
      "INSERT INTO retailer_photos(id,retailer_id,person_id,user_id,request_key,caption,mime,content) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(request_key) DO NOTHING",
      [
        randomUUID(),
        b.id,
        b.personId || null,
        user.id,
        b.requestKey,
        b.caption,
        b.mime,
        bytes,
      ],
    );
  } else if (path === "retailers/research") {
    const b = z.object({ id: z.uuid(), personId: z.uuid() }).parse(body);
    await transaction(async (tx) => {
      const r = (
        await tx.query("SELECT * FROM retailers WHERE id=$1 FOR UPDATE", [b.id])
      ).rows[0];
      if (!r) throw new HttpError(404, "Retailer not found.");
      if (r.prospect_id) return;
      if (r.outreach_status === "do_not_contact")
        throw new HttpError(409, "This retailer is marked do not contact.");
      const p = (
        await tx.query(
          "SELECT * FROM retailer_people WHERE id=$1 AND retailer_id=$2",
          [b.personId, b.id],
        )
      ).rows[0];
      if (!p?.name || p.name.length < 2)
        throw new HttpError(400, "Record the contact name first.");
      if (p.email && !z.email().safeParse(p.email).success)
        throw new HttpError(
          400,
          "Choose a contact with a single valid email address, or correct the contact first.",
        );
      await assertOwner(tx, r.owner_id);
      const id = randomUUID();
      await tx.query(
        "INSERT INTO prospects(id,request_key,name,contact_name,email,phone,website,source,notes,status,owner_id,company_id) VALUES($1,$1,$2,$3,$4,$5,$6,'Retailer network',$7,'review',$8,$9)",
        [
          id,
          r.name,
          p.name,
          p.email.toLowerCase(),
          p.phone,
          r.website,
          `Retailer network record ${r.id}. Review contact permissions before outreach. ${p.notes}`,
          r.owner_id,
          r.company_id,
        ],
      );
      await tx.query(
        "UPDATE retailers SET prospect_id=$2,version=version+1 WHERE id=$1",
        [r.id, id],
      );
    });
  } else throw new HttpError(404, "Route not found.");
  return Response.json({ ok: true });
}
