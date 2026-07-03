import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import type { WorkflowStore } from "@reflow/core";

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
  status: z.enum(["pending", "running", "sleeping", "completed", "failed"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
const getRunQuery = z.object({
  include: z.literal("history").optional(),
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

function serializeRun(run: import("@reflow/core").WorkflowRun) {
  return {
    id: run.id,
    workflowName: run.workflowName,
    status: run.status,
    input: run.input,
    output: run.output,
    error: run.error,
    wakeAt: run.wakeAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  };
}
