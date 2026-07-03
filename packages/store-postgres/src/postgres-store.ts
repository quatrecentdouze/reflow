import type {
  CreateRunInput,
  CreateScheduleInput,
  HistoryEvent,
  HistoryRecord,
  ListRunsOptions,
  WorkflowRun,
  WorkflowRunId,
  WorkflowSchedule,
  WorkflowStore,
} from "@reflow/core";
import type { SqlClient } from "./sql-client.js";

const RUN_COLUMNS = `id, workflow_name, status, input, output, error,
  wake_at, parent_run_id, locked_by, locked_until, created_at, updated_at`;

const SCHEDULE_COLUMNS = `id, workflow_name, input, interval_ms, next_run_at,
  enabled, created_at, updated_at`;

export class PostgresStore implements WorkflowStore {
  constructor(private readonly db: SqlClient) {}

  async createRun(input: CreateRunInput): Promise<WorkflowRun> {
    const startAt = input.startAt ?? null;
    const scheduled = startAt !== null && startAt.getTime() > Date.now();
    const { rows } = await this.db.query(
      `INSERT INTO workflow_runs (id, workflow_name, input, status, wake_at, parent_run_id)
       VALUES ($1, $2, $3::jsonb, $4, $5::timestamptz, $6)
       RETURNING ${RUN_COLUMNS}`,
      [
        input.id,
        input.workflowName,
        JSON.stringify(input.input ?? null),
        scheduled ? "sleeping" : "pending",
        scheduled ? startAt.toISOString() : null,
        input.parentRunId ?? null,
      ],
    );
    await this.appendEvent(input.id, { type: "run_started", input: input.input ?? null });
    return mapRun(rows[0]);
  }

  async getRun(id: WorkflowRunId): Promise<WorkflowRun | null> {
    const { rows } = await this.db.query(
      `SELECT ${RUN_COLUMNS} FROM workflow_runs WHERE id = $1`,
      [id],
    );
    return rows[0] ? mapRun(rows[0]) : null;
  }

  async listRuns(options: ListRunsOptions = {}): Promise<WorkflowRun[]> {
    const limit = options.limit ?? 50;
    if (options.status) {
      const { rows } = await this.db.query(
        `SELECT ${RUN_COLUMNS} FROM workflow_runs
         WHERE status = $1 ORDER BY created_at DESC LIMIT $2`,
        [options.status, limit],
      );
      return rows.map(mapRun);
    }
    const { rows } = await this.db.query(
      `SELECT ${RUN_COLUMNS} FROM workflow_runs ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map(mapRun);
  }

  async getHistory(runId: WorkflowRunId): Promise<HistoryRecord[]> {
    const { rows } = await this.db.query(
      `SELECT run_id, seq, payload, recorded_at FROM workflow_events
       WHERE run_id = $1 ORDER BY seq ASC`,
      [runId],
    );
    return rows.map((row) => {
      const r = row as Record<string, unknown>;
      return {
        runId: r["run_id"] as string,
        seq: Number(r["seq"]),
        event: r["payload"] as HistoryEvent,
        recordedAt: new Date(r["recorded_at"] as string | Date),
      };
    });
  }

  async appendEvent(runId: WorkflowRunId, event: HistoryEvent): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.db.query(
          `INSERT INTO workflow_events (run_id, seq, type, payload)
           SELECT $1, COALESCE(MAX(seq), -1) + 1, $2, $3::jsonb
           FROM workflow_events WHERE run_id = $1`,
          [runId, event.type, JSON.stringify(event)],
        );
        return;
      } catch (err) {
        if (attempt >= 4 || !isUniqueViolation(err)) throw err;
      }
    }
  }

  async claimRun(workerId: string, lockTtlMs: number): Promise<WorkflowRun | null> {
    const { rows } = await this.db.query(
      `WITH candidate AS (
         SELECT id FROM workflow_runs
         WHERE (
             (status = 'pending' AND (locked_until IS NULL OR locked_until < now()))
             OR (status = 'sleeping' AND wake_at IS NOT NULL AND wake_at <= now()
                 AND (locked_until IS NULL OR locked_until < now()))
             OR (status = 'running' AND locked_until IS NOT NULL AND locked_until < now())
           )
         ORDER BY created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE workflow_runs r
       SET status = 'running',
           locked_by = $1,
           locked_until = now() + $2::int * interval '1 millisecond',
           wake_at = NULL,
           updated_at = now()
       FROM candidate
       WHERE r.id = candidate.id
       RETURNING ${prefixed("r")}`,
      [workerId, lockTtlMs],
    );
    return rows[0] ? mapRun(rows[0]) : null;
  }

  async extendLock(
    runId: WorkflowRunId,
    workerId: string,
    lockTtlMs: number,
  ): Promise<boolean> {
    const { rows } = await this.db.query(
      `UPDATE workflow_runs
       SET locked_until = now() + $3::int * interval '1 millisecond', updated_at = now()
       WHERE id = $1 AND locked_by = $2 AND status = 'running'
       RETURNING id`,
      [runId, workerId, lockTtlMs],
    );
    return rows.length > 0;
  }

  async suspendRun(runId: WorkflowRunId, wakeAt: Date | null): Promise<void> {
    await this.db.query(
      `UPDATE workflow_runs
       SET status = 'sleeping',
           wake_at = CASE
             WHEN wake_at IS NOT NULL AND ($2::timestamptz IS NULL OR wake_at < $2::timestamptz)
               THEN wake_at
             ELSE $2::timestamptz
           END,
           locked_by = NULL,
           locked_until = NULL,
           updated_at = now()
       WHERE id = $1`,
      [runId, wakeAt === null ? null : wakeAt.toISOString()],
    );
  }

  async completeRun(runId: WorkflowRunId, output: unknown): Promise<void> {
    await this.db.query(
      `UPDATE workflow_runs
       SET status = 'completed', output = $2::jsonb, wake_at = NULL,
           locked_by = NULL, locked_until = NULL, updated_at = now()
       WHERE id = $1`,
      [runId, JSON.stringify(output ?? null)],
    );
    await this.wakeParent(runId);
  }

  async failRun(runId: WorkflowRunId, error: string): Promise<void> {
    await this.db.query(
      `UPDATE workflow_runs
       SET status = 'failed', error = $2, wake_at = NULL,
           locked_by = NULL, locked_until = NULL, updated_at = now()
       WHERE id = $1`,
      [runId, error],
    );
    await this.wakeParent(runId);
  }

  private async wakeParent(childRunId: WorkflowRunId): Promise<void> {
    await this.db.query(
      `UPDATE workflow_runs
       SET wake_at = LEAST(COALESCE(wake_at, now()), now()), updated_at = now()
       WHERE id = (SELECT parent_run_id FROM workflow_runs WHERE id = $1)
         AND status IN ('pending', 'running', 'sleeping')`,
      [childRunId],
    );
  }

  async retryRun(runId: WorkflowRunId): Promise<boolean> {
    const run = await this.getRun(runId);
    if (!run || run.status !== "failed") {
      return false;
    }
    await this.appendEvent(runId, { type: "run_retried" });
    await this.db.query(
      `UPDATE workflow_runs
       SET status = 'pending', error = NULL, wake_at = NULL,
           locked_by = NULL, locked_until = NULL, updated_at = now()
       WHERE id = $1 AND status = 'failed'`,
      [runId],
    );
    return true;
  }

  async cancelRun(runId: WorkflowRunId): Promise<boolean> {
    const run = await this.getRun(runId);
    if (!run || run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
      return false;
    }
    await this.appendEvent(runId, { type: "run_cancelled" });
    await this.db.query(
      `UPDATE workflow_runs
       SET status = CASE WHEN status IN ('pending', 'sleeping') THEN 'cancelled' ELSE status END,
           wake_at = CASE WHEN status = 'running' THEN LEAST(COALESCE(wake_at, now()), now()) ELSE NULL END,
           locked_by = CASE WHEN status IN ('pending', 'sleeping') THEN NULL ELSE locked_by END,
           locked_until = CASE WHEN status IN ('pending', 'sleeping') THEN NULL ELSE locked_until END,
           updated_at = now()
       WHERE id = $1 AND status IN ('pending', 'sleeping', 'running')`,
      [runId],
    );
    const updated = await this.getRun(runId);
    if (updated?.status === "cancelled") {
      await this.wakeParent(runId);
    }
    return true;
  }

  async markRunCancelled(runId: WorkflowRunId): Promise<void> {
    await this.db.query(
      `UPDATE workflow_runs
       SET status = 'cancelled', wake_at = NULL,
           locked_by = NULL, locked_until = NULL, updated_at = now()
       WHERE id = $1`,
      [runId],
    );
    await this.wakeParent(runId);
  }

  async createSchedule(input: CreateScheduleInput): Promise<WorkflowSchedule> {
    const firstRunAt = input.firstRunAt ?? new Date();
    const { rows } = await this.db.query(
      `INSERT INTO workflow_schedules (id, workflow_name, input, interval_ms, next_run_at)
       VALUES ($1, $2, $3::jsonb, $4, $5::timestamptz)
       RETURNING ${SCHEDULE_COLUMNS}`,
      [
        input.id,
        input.workflowName,
        JSON.stringify(input.input ?? null),
        input.intervalMs,
        firstRunAt.toISOString(),
      ],
    );
    return mapSchedule(rows[0]);
  }

  async listSchedules(): Promise<WorkflowSchedule[]> {
    const { rows } = await this.db.query(
      `SELECT ${SCHEDULE_COLUMNS} FROM workflow_schedules ORDER BY created_at DESC`,
    );
    return rows.map(mapSchedule);
  }

  async deleteSchedule(id: string): Promise<boolean> {
    const { rows } = await this.db.query(
      `DELETE FROM workflow_schedules WHERE id = $1 RETURNING id`,
      [id],
    );
    return rows.length > 0;
  }

  async claimDueSchedule(): Promise<WorkflowSchedule | null> {
    const { rows } = await this.db.query(
      `WITH candidate AS (
         SELECT id FROM workflow_schedules
         WHERE enabled AND next_run_at <= now()
         ORDER BY next_run_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE workflow_schedules s
       SET next_run_at = now() + (s.interval_ms * interval '1 millisecond'),
           updated_at = now()
       FROM candidate
       WHERE s.id = candidate.id
       RETURNING ${prefixedColumns("s", SCHEDULE_COLUMNS)}`,
    );
    return rows[0] ? mapSchedule(rows[0]) : null;
  }

  async signalRun(
    runId: WorkflowRunId,
    name: string,
    payload: unknown,
  ): Promise<boolean> {
    const run = await this.getRun(runId);
    if (!run || run.status === "completed" || run.status === "failed") {
      return false;
    }
    await this.appendEvent(runId, { type: "signal_received", name, payload: payload ?? null });
    await this.db.query(
      `UPDATE workflow_runs
       SET wake_at = LEAST(COALESCE(wake_at, now()), now()), updated_at = now()
       WHERE id = $1 AND status IN ('pending', 'running', 'sleeping')`,
      [runId],
    );
    return true;
  }
}

function prefixed(alias: string): string {
  return prefixedColumns(alias, RUN_COLUMNS);
}

function prefixedColumns(alias: string, columns: string): string {
  return columns
    .split(",")
    .map((column) => `${alias}.${column.trim()}`)
    .join(", ");
}

function mapSchedule(row: unknown): WorkflowSchedule {
  const r = row as Record<string, unknown>;
  return {
    id: r["id"] as string,
    workflowName: r["workflow_name"] as string,
    input: r["input"] ?? null,
    intervalMs: Number(r["interval_ms"]),
    nextRunAt: toDate(r["next_run_at"])!,
    enabled: Boolean(r["enabled"]),
    createdAt: toDate(r["created_at"])!,
    updatedAt: toDate(r["updated_at"])!,
  };
}

function mapRun(row: unknown): WorkflowRun {
  const r = row as Record<string, unknown>;
  return {
    id: r["id"] as string,
    workflowName: r["workflow_name"] as string,
    status: r["status"] as WorkflowRun["status"],
    input: r["input"] ?? null,
    output: r["output"] ?? null,
    error: (r["error"] as string | null) ?? null,
    wakeAt: toDate(r["wake_at"]),
    parentRunId: (r["parent_run_id"] as string | null) ?? null,
    lockedBy: (r["locked_by"] as string | null) ?? null,
    lockedUntil: toDate(r["locked_until"]),
    createdAt: toDate(r["created_at"])!,
    updatedAt: toDate(r["updated_at"])!,
  };
}

function toDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(value as string);
}

function isUniqueViolation(err: unknown): boolean {
  const anyErr = err as { code?: string; message?: string };
  return (
    anyErr?.code === "23505" ||
    /duplicate key|unique constraint/i.test(anyErr?.message ?? "")
  );
}
