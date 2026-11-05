import { runOneJob, recoverStaleJobs } from "../src/server/worker";
import { db } from "../src/server/db";
let stopping = false;
process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});
async function run() {
  console.log(
    `Linkd Sales Force worker started (${process.env.COMMUNICATIONS_MODE || "demo"} mode).`,
  );
  let passes = 0;
  while (!stopping) {
    try {
      if (passes++ % 30 === 0) await recoverStaleJobs();
      if (await runOneJob()) continue;
    } catch {
      console.error("Worker could not reach the database. Retrying.");
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  await db.end();
}
run();
