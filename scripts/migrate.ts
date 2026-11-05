import { readFile, readdir } from "node:fs/promises";
import { db, transaction } from "../src/server/db";
export async function migrate() {
  await transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(17304567)");
    await tx.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())",
    );
    const applied = new Set(
      (await tx.query("SELECT name FROM schema_migrations")).rows.map(
        (r) => r.name,
      ),
    );
    for (const file of (await readdir("migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      if (applied.has(file)) continue;
      await tx.query(await readFile(`migrations/${file}`, "utf8"));
      await tx.query("INSERT INTO schema_migrations(name) VALUES ($1)", [file]);
      console.log(`Applied ${file}`);
    }
  });
}
if (process.argv[1]?.endsWith("migrate.ts"))
  migrate()
    .then(() => db.end())
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
