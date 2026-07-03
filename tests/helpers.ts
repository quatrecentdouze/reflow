import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { WorkflowRun, WorkflowStore } from "@reflow/core";
import { migrate, PostgresStore, type SqlClient } from "@reflow/store-postgres";

export interface TestStore {
  store: PostgresStore;
  client: SqlClient;
  close: () => Promise<void>;
}

export async function createTestStore(): Promise<TestStore> {
  const db = new PGlite();
  const client: SqlClient = {
    query: async (text, params) => db.query(text, params as unknown[]),
  };
  await migrate(client);
  return { store: new PostgresStore(client), client, close: () => db.close() };
}

export function startRun(
  store: WorkflowStore,
  workflowName: string,
  input: unknown = null,
): Promise<WorkflowRun> {
  return store.createRun({ id: randomUUID(), workflowName, input });
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(
  predicate: () => Promise<boolean>,
  { timeoutMs = 10_000, intervalMs = 20 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(intervalMs);
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}
