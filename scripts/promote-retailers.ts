import { Client } from "pg";

// One-time launch transfer. No demo users, accounts, sessions or jobs are copied.
// Refuse an existing destination or records with account/history links; those
// require a full migration plan instead of silently dropping relationships.
const sourceUrl = process.env.SOURCE_DATABASE_URL;
const targetUrl = process.env.TARGET_DATABASE_URL;
const ownerEmail = process.env.TARGET_OWNER_EMAIL?.toLowerCase();
if (!sourceUrl || !targetUrl || !ownerEmail || sourceUrl === targetUrl)
  throw new Error(
    "Set distinct SOURCE_DATABASE_URL, TARGET_DATABASE_URL and TARGET_OWNER_EMAIL.",
  );
const source = new Client({
  connectionString: sourceUrl,
  connectionTimeoutMillis: 5000,
});
const target = new Client({
  connectionString: targetUrl,
  connectionTimeoutMillis: 5000,
});
const apply = process.argv.includes("--apply");

async function main() {
  await source.connect();
  await target.connect();
  await source.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await target.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  await target.query("SELECT pg_advisory_xact_lock(17304568)");
  const owner = (
    await target.query(
      "SELECT id FROM users WHERE lower(email)=$1 AND active=true AND role='admin'",
      [ownerEmail],
    )
  ).rows[0];
  if (!owner)
    throw new Error("Destination must have the intended active administrator.");
  for (const table of [
    "retailers",
    "retailer_imports",
    "retailer_people",
    "retailer_sources",
    "retailer_events",
    "retailer_photos",
  ]) {
    const count = Number(
      (await target.query(`SELECT count(*) n FROM ${table}`)).rows[0].n,
    );
    if (count)
      throw new Error(
        `Destination ${table} is not empty; refusing to overwrite or merge.`,
      );
  }
  const linked = Number(
    (
      await source.query(
        "SELECT count(*) n FROM retailers WHERE company_id IS NOT NULL OR prospect_id IS NOT NULL",
      )
    ).rows[0].n,
  );
  const history = Number(
    (
      await source.query(
        "SELECT (SELECT count(*) FROM retailer_events)+(SELECT count(*) FROM retailer_photos) n",
      )
    ).rows[0].n,
  );
  if (linked || history)
    throw new Error(
      "Source now has account links, events or photos. Use a full relationship-preserving migration.",
    );
  const imports = (
    await source.query(
      "SELECT i.* FROM retailer_imports i WHERE i.applied_at IS NOT NULL AND EXISTS (SELECT 1 FROM retailer_sources s WHERE s.import_id=i.id) ORDER BY i.id",
    )
  ).rows;
  const retailers = (
    await source.query(
      "SELECT r.* FROM retailers r WHERE EXISTS (SELECT 1 FROM retailer_sources s JOIN retailer_imports i ON i.id=s.import_id WHERE s.retailer_id=r.id AND i.applied_at IS NOT NULL) ORDER BY r.id",
    )
  ).rows;
  const ids = retailers.map((row) => row.id);
  const people = (
    await source.query(
      "SELECT * FROM retailer_people WHERE retailer_id=ANY($1::uuid[]) ORDER BY id",
      [ids],
    )
  ).rows;
  const sources = (
    await source.query(
      "SELECT * FROM retailer_sources WHERE import_id=ANY($1::uuid[]) ORDER BY id",
      [imports.map((row) => row.id)],
    )
  ).rows;
  for (const row of imports) row.created_by = owner.id;
  for (const row of retailers) row.owner_id = owner.id;
  const tables = {
    retailer_imports: imports,
    retailers,
    retailer_people: people,
    retailer_sources: sources,
  };
  for (const [table, rows] of Object.entries(tables)) {
    if (!rows.length) continue;
    const columns = Object.keys(rows[0]);
    // Names come exclusively from these fixed database tables, never user input.
    const quoted = columns
      .map((name) => `"${name.replaceAll('"', '""')}"`)
      .join(",");
    await target.query(
      `INSERT INTO ${table} (${quoted}) SELECT ${quoted} FROM jsonb_populate_recordset(NULL::${table},$1::jsonb)`,
      [JSON.stringify(rows)],
    );
    const count = Number(
      (await target.query(`SELECT count(*) n FROM ${table}`)).rows[0].n,
    );
    if (count !== rows.length) throw new Error(`Count mismatch in ${table}.`);
  }
  await target.query(apply ? "COMMIT" : "ROLLBACK");
  await source.query("COMMIT");
  console.log(
    JSON.stringify({
      applied: apply,
      counts: Object.fromEntries(
        Object.entries(tables).map(([name, rows]) => [name, rows.length]),
      ),
    }),
  );
}

main()
  .catch(async (error) => {
    await target.query("ROLLBACK").catch(() => {});
    console.error(error instanceof Error ? error.message : "Transfer failed.");
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([source.end(), target.end()]);
  });
