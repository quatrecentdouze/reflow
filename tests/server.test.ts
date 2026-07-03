import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Worker, WorkflowRegistry } from "@reflow/core";
import { defineWorkflow } from "@reflow/sdk";
import { buildServer } from "@reflow/server";
import { createTestStore, type TestStore } from "./helpers.js";

let ts: TestStore;
let app: FastifyInstance;

const registry = new WorkflowRegistry().register(
  defineWorkflow<{ item: string }, string>({
    name: "approval",
    async run(ctx, input) {
      await ctx.step("request-approval", () => `asking for ${input.item}`);
      const decision = await ctx.waitForSignal<{ approved: boolean }>("decision");
      return decision.approved ? "approved" : "rejected";
    },
  }),
);

beforeEach(async () => {
  ts = await createTestStore();
  app = buildServer({ store: ts.store });
});

afterEach(async () => {
  await app.close();
  await ts.close();
});

function worker(): Worker {
  return new Worker({ store: ts.store, registry }, { workerId: "api-test-worker" });
}

describe("REST API", () => {
  it("serves the web ui at the root", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("reflow");
  });

  it("starts a run and exposes its state", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/workflows/approval/runs",
      payload: { input: { item: "laptop" } },
    });
    expect(created.statusCode).toBe(201);
    const run = created.json();
    expect(run.status).toBe("pending");
    expect(run.workflowName).toBe("approval");

    const fetched = await app.inject({ method: "GET", url: `/api/runs/${run.id}` });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().input).toEqual({ item: "laptop" });
  });

  it("drives a full run through signal delivery", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/workflows/approval/runs",
      payload: { input: { item: "gpu" } },
    });
    const runId = created.json().id as string;

    expect(await worker().tick()).toBe("suspended");

    const signaled = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/signals/decision`,
      payload: { payload: { approved: true } },
    });
    expect(signaled.statusCode).toBe(202);

    expect(await worker().tick()).toBe("completed");

    const final = await app.inject({
      method: "GET",
      url: `/api/runs/${runId}?include=history`,
    });
    const body = final.json();
    expect(body.status).toBe("completed");
    expect(body.output).toBe("approved");
    expect(body.history.map((h: { type: string }) => h.type)).toEqual([
      "run_started",
      "step_completed",
      "signal_received",
      "run_completed",
    ]);
  });

  it("lists runs with status filtering", async () => {
    await app.inject({
      method: "POST",
      url: "/api/workflows/approval/runs",
      payload: { input: { item: "a" } },
    });
    await app.inject({
      method: "POST",
      url: "/api/workflows/approval/runs",
      payload: { input: { item: "b" } },
    });

    const all = await app.inject({ method: "GET", url: "/api/runs" });
    expect(all.json().runs).toHaveLength(2);

    const completed = await app.inject({
      method: "GET",
      url: "/api/runs?status=completed",
    });
    expect(completed.json().runs).toHaveLength(0);
  });

  it("returns 404 for unknown runs and 400 for invalid queries", async () => {
    const missing = await app.inject({
      method: "GET",
      url: "/api/runs/00000000-0000-0000-0000-000000000000",
    });
    expect(missing.statusCode).toBe(404);

    const missingSignal = await app.inject({
      method: "POST",
      url: "/api/runs/00000000-0000-0000-0000-000000000000/signals/decision",
      payload: {},
    });
    expect(missingSignal.statusCode).toBe(404);

    const badQuery = await app.inject({ method: "GET", url: "/api/runs?limit=9999" });
    expect(badQuery.statusCode).toBe(400);
  });
});
