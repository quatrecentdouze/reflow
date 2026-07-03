import pg from "pg";
import { migrate, PostgresStore } from "@reflow/store-postgres";
import { buildServer } from "./server.js";

const DATABASE_URL =
  process.env["DATABASE_URL"] ?? "postgres://reflow:reflow@localhost:5432/reflow";
const PORT = Number(process.env["PORT"] ?? 3000);
const HOST = process.env["HOST"] ?? "0.0.0.0";

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  await migrate(pool);

  const app = buildServer({ store: new PostgresStore(pool), logger: true });

  const shutdown = async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await app.listen({ port: PORT, host: HOST });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
