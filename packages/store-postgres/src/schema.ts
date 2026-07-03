import type { SqlClient } from "./sql-client.js";

export const MIGRATION_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS workflow_runs (
    id UUID PRIMARY KEY,
    workflow_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    input JSONB,
    output JSONB,
    error TEXT,
    wake_at TIMESTAMPTZ,
    parent_run_id UUID,
    locked_by TEXT,
    locked_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS parent_run_id UUID`,
  `CREATE INDEX IF NOT EXISTS idx_workflow_runs_claim
    ON workflow_runs (status, wake_at, created_at)`,
  `CREATE TABLE IF NOT EXISTS workflow_schedules (
    id UUID PRIMARY KEY,
    workflow_name TEXT NOT NULL,
    input JSONB,
    interval_ms INTEGER,
    cron TEXT,
    next_run_at TIMESTAMPTZ NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `ALTER TABLE workflow_schedules ADD COLUMN IF NOT EXISTS cron TEXT`,
  `ALTER TABLE workflow_schedules ALTER COLUMN interval_ms DROP NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_workflow_schedules_due
    ON workflow_schedules (enabled, next_run_at)`,
  `CREATE TABLE IF NOT EXISTS workflow_events (
    run_id UUID NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    payload JSONB NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, seq)
  )`,
];

export async function migrate(client: SqlClient): Promise<void> {
  for (const statement of MIGRATION_STATEMENTS) {
    await client.query(statement);
  }
}
