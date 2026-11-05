import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, relative } from "node:path";
import { prepareMonday } from "../src/server/monday-adapter";
import { importSchema } from "../src/server/importer";
import { db } from "../src/server/db";
async function run() {
  const [source, mapping, output] = process.argv.slice(2);
  if (!source || !mapping || !output)
    throw new Error(
      "Usage: npm run monday:prepare -- private-export.csv reviewed-mapping.json .local/normalized.json",
    );
  const privateRoot = resolve(".local"),
    destination = resolve(output);
  if (
    relative(privateRoot, destination).startsWith("..") ||
    destination === privateRoot
  )
    throw new Error("Write prepared data inside the ignored .local directory.");
  const result = prepareMonday(
    await readFile(source, "utf8"),
    JSON.parse(await readFile(mapping, "utf8")),
  );
  const parsed = importSchema.safeParse(result.batch);
  const schemaIssues = parsed.success
    ? []
    : parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      }));
  const report = {
    sourceRows: result.sourceRows,
    preparedRows: result.batch.rows.length,
    mappingIssues: result.errors,
    schemaIssues,
  };
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(
    destination + ".review.json",
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  if (result.errors.length || !parsed.success)
    throw new Error(
      `Preparation needs review. See ${destination}.review.json. No import file was written.`,
    );
  await writeFile(destination, JSON.stringify(parsed.data, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    `Prepared ${parsed.data.rows.length} records. Run db:import without --apply for database collision/relationship review.`,
  );
}
run()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => db.end());
