import { runOneJob, recoverStaleJobs } from "../src/server/worker";
import { db } from "../src/server/db";
import { createServer } from "node:http";
let stopping = false;
let lastHealthyPass = 0;
// A private Cloud Run service can use this endpoint for its container probes.
// Local workers do not open a port unless explicitly configured.
const healthPort = process.env.WORKER_HEALTH_PORT;
const healthServer = healthPort
  ? createServer((request, response) => {
      const healthy = !stopping && Date.now() - lastHealthyPass < 120_000;
      const knownPath = request.url === "/health";
      response.writeHead(knownPath ? (healthy ? 200 : 503) : 404, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify({ ok: knownPath && healthy }));
    })
  : undefined;
process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});
async function run() {
  await db.query("SELECT 1");
  lastHealthyPass = Date.now();
  if (healthServer) healthServer.listen(Number(healthPort), "0.0.0.0");
  console.log(
    `Linkd Sales Force worker started (${process.env.COMMUNICATIONS_MODE || "demo"} mode).`,
  );
  let passes = 0;
  while (!stopping) {
    try {
      if (passes++ % 30 === 0) await recoverStaleJobs();
      const worked = await runOneJob();
      lastHealthyPass = Date.now();
      if (worked) continue;
    } catch {
      console.error("Worker could not reach the database. Retrying.");
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  await db.end();
  healthServer?.close();
}
run().catch(() => {
  console.error("Worker startup failed. Verify database connectivity.");
  process.exit(1);
});
