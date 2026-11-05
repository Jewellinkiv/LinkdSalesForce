import { readFile } from "node:fs/promises";
import { db } from "../src/server/db";
import { previewImport, applyImport } from "../src/server/importer";
async function run() {
  const file = process.argv[2];
  if (!file)
    throw new Error(
      "Usage: npm run db:import -- /private/path/normalized.json [--apply]",
    );
  const input = JSON.parse(await readFile(file, "utf8"));
  if (!process.argv.includes("--apply"))
    console.log(JSON.stringify(await previewImport(input), null, 2));
  else {
    const actor = (
      await db.query(
        "SELECT id,name,email,role FROM users WHERE role='admin' AND active=true ORDER BY created_at LIMIT 1",
      )
    ).rows[0];
    if (!actor) throw new Error("Bootstrap an administrator first.");
    console.log(JSON.stringify(await applyImport(input, actor), null, 2));
  }
}
run()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => db.end());
