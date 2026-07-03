import { PGlite } from "@electric-sql/pglite";
import { Worker } from "@reflow/core";
import { createExampleRegistry } from "@reflow/examples";
import { buildServer } from "@reflow/server";
import { migrate, PostgresStore, type SqlClient } from "@reflow/store-postgres";

const PORT = Number(process.env["PORT"] ?? 3000);

async function main(): Promise<void> {
  const db = new PGlite();
  const client: SqlClient = {
    query: async (text, params) => db.query(text, params as unknown[]),
  };
  await migrate(client);
  const store = new PostgresStore(client);

  const registry = createExampleRegistry();
  const worker = new Worker(
    { store, registry },
    {
      pollIntervalMs: 200,
      onRunFinished: (run, outcome) =>
        console.log(`run ${run.id} (${run.workflowName}) -> ${outcome}`),
      onError: (err) => console.error("worker error:", err),
    },
  );
  worker.start();

  const app = buildServer({ store });
  await app.listen({ port: PORT, host: "127.0.0.1" });

  console.log(`
reflow demo ready on http://localhost:${PORT} (embedded Postgres, in-memory)

Try it:

  # start an order workflow (flaky payment -> watch the retries)
  curl -X POST http://localhost:${PORT}/api/workflows/order-processing/runs \\
       -H "content-type: application/json" \\
       -d '{"input": {"orderId": "order-1", "amount": 99}}'

  # start an approval workflow, then deliver the decision signal
  curl -X POST http://localhost:${PORT}/api/workflows/expense-approval/runs \\
       -H "content-type: application/json" \\
       -d '{"input": {"employee": "ada", "amount": 1200, "reason": "conference"}}'
  curl -X POST http://localhost:${PORT}/api/runs/<RUN_ID>/signals/decision \\
       -H "content-type: application/json" \\
       -d '{"payload": {"approved": true, "reviewer": "grace"}}'

  # inspect a run and its full event history
  curl "http://localhost:${PORT}/api/runs/<RUN_ID>?include=history"
`);

  const shutdown = async () => {
    await worker.stop();
    await app.close();
    await db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
