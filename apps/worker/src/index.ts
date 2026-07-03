import pg from "pg";
import { Worker } from "@reflow/core";
import { createExampleRegistry } from "@reflow/examples";
import { migrate, PostgresStore } from "@reflow/store-postgres";

const DATABASE_URL =
  process.env["DATABASE_URL"] ?? "postgres://reflow:reflow@localhost:5432/reflow";

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  await migrate(pool);

  const registry = createExampleRegistry();
  const worker = new Worker(
    { store: new PostgresStore(pool), registry },
    {
      pollIntervalMs: 500,
      lockTtlMs: 30_000,
      onRunFinished: (run, outcome) => {
        console.log(
          `${new Date().toISOString()} run ${run.id} (${run.workflowName}) -> ${outcome}`,
        );
      },
      onError: (err) => console.error("worker error:", err),
    },
  );

  console.log(`worker ${worker.workerId} started (pid ${process.pid})`);
  console.log(`registered workflows: ${registry.names().join(", ")}`);
  worker.start();

  const shutdown = async () => {
    console.log("shutting down, waiting for in-flight runs...");
    await worker.stop();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
