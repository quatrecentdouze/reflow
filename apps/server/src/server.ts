import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import type { WorkflowStore } from "@reflow/core";
import { INDEX_HTML } from "./ui.js";

export interface BuildServerOptions {
  store: WorkflowStore;
  logger?: boolean;
}

const startRunBody = z.object({
  input: z.unknown().optional(),
  startAt: z.iso.datetime({ offset: true }).optional(),
});
const signalBody = z.object({ payload: z.unknown().optional() });
const listRunsQuery = z.object({
  status: z
    .enum(["pending", "running", "sleeping", "completed", "failed", "cancelled"])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
const getRunQuery = z.object({
  include: z.literal("history").optional(),
});
const createScheduleBody = z
  .object({
    input: z.unknown().optional(),
    intervalMs: z.number().int().min(100).optional(),
    cron: z.string().min(1).optional(),
    firstRunAt: z.iso.datetime({ offset: true }).optional(),
  })
  .refine((body) => (body.intervalMs === undefined) !== (body.cron === undefined), {
    message: "provide exactly one of intervalMs or cron",
  });

export function buildServer({ store, logger = false }: BuildServerOptions): FastifyInstance {
  const app = Fastify({ logger });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.status(400).send({ error: "invalid request", issues: err.issues });
    }
    app.log.error(err);
    return reply.status(500).send({ error: "internal error" });
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/", (_req, reply) => reply.type("text/html").send(INDEX_HTML));

  app.post("/api/workflows/:name/runs", async (req, reply) => {
    const { name } = req.params as { name: string };
    const body = startRunBody.parse(req.body ?? {});
    const run = await store.createRun({
      id: randomUUID(),
      workflowName: name,
      input: body.input ?? null,
      startAt: body.startAt ? new Date(body.startAt) : undefined,
    });
    return reply.status(201).send(serializeRun(run));
  });

  app.get("/api/runs", async (req) => {
    const query = listRunsQuery.parse(req.query);
    const runs = await store.listRuns(query);
    return { runs: runs.map(serializeRun) };
  });

  app.get("/api/runs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = getRunQuery.parse(req.query);

    const run = await store.getRun(id);
    if (!run) return reply.status(404).send({ error: "run not found" });

    if (query.include === "history") {
      const history = await store.getHistory(id);
      return {
        ...serializeRun(run),
        history: history.map((h) => ({
          seq: h.seq,
          recordedAt: h.recordedAt.toISOString(),
          ...h.event,
        })),
      };
    }
    return serializeRun(run);
  });

  app.post("/api/runs/:id/retry", async (req, reply) => {
    const { id } = req.params as { id: string };

    const run = await store.getRun(id);
    if (!run) return reply.status(404).send({ error: "run not found" });
    if (run.status !== "failed") {
      return reply.status(409).send({ error: "only failed runs can be retried" });
    }

    await store.retryRun(id);
    return reply.status(202).send({ retried: true });
  });

  app.post("/api/workflows/:name/schedules", async (req, reply) => {
    const { name } = req.params as { name: string };
    const body = createScheduleBody.parse(req.body ?? {});
    let schedule;
    try {
      schedule = await store.createSchedule({
        id: randomUUID(),
        workflowName: name,
        input: body.input ?? null,
        intervalMs: body.intervalMs,
        cron: body.cron,
        firstRunAt: body.firstRunAt ? new Date(body.firstRunAt) : undefined,
      });
    } catch (err) {
      return reply.status(400).send({
        error: err instanceof Error ? err.message : "invalid schedule",
      });
    }
    return reply.status(201).send(serializeSchedule(schedule));
  });

  app.get("/api/schedules", async () => {
    const schedules = await store.listSchedules();
    return { schedules: schedules.map(serializeSchedule) };
  });

  app.delete("/api/schedules/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const deleted = await store.deleteSchedule(id);
    if (!deleted) return reply.status(404).send({ error: "schedule not found" });
    return reply.status(204).send();
  });

  app.post("/api/runs/:id/cancel", async (req, reply) => {
    const { id } = req.params as { id: string };

    const run = await store.getRun(id);
    if (!run) return reply.status(404).send({ error: "run not found" });

    const cancelled = await store.cancelRun(id);
    if (!cancelled) {
      return reply.status(409).send({ error: "run already finished" });
    }
    return reply.status(202).send({ cancelled: true });
  });

  app.post("/api/runs/:id/signals/:name", async (req, reply) => {
    const { id, name } = req.params as { id: string; name: string };
    const body = signalBody.parse(req.body ?? {});

    const delivered = await store.signalRun(id, name, body.payload ?? null);
    if (!delivered) {
      return reply.status(404).send({ error: "run not found or already finished" });
    }
    return reply.status(202).send({ delivered: true });
  });

  return app;
}

function serializeSchedule(schedule: import("@reflow/core").WorkflowSchedule) {
  return {
    id: schedule.id,
    workflowName: schedule.workflowName,
    input: schedule.input,
    intervalMs: schedule.intervalMs,
    cron: schedule.cron,
    nextRunAt: schedule.nextRunAt.toISOString(),
    enabled: schedule.enabled,
    createdAt: schedule.createdAt.toISOString(),
  };
}

function serializeRun(run: import("@reflow/core").WorkflowRun) {
  return {
    id: run.id,
    workflowName: run.workflowName,
    status: run.status,
    input: run.input,
    output: run.output,
    error: run.error,
    wakeAt: run.wakeAt?.toISOString() ?? null,
    parentRunId: run.parentRunId,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  };
}
