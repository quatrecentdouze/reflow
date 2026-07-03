import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Worker, WorkflowRegistry } from "@reflow/core";
import { defineWorkflow } from "@reflow/sdk";
import { buildServer } from "@reflow/server";
import { createTestStore, delay, waitFor, type TestStore } from "./helpers.js";

let ts: TestStore;

beforeEach(async () => {
  ts = await createTestStore();
});

afterEach(async () => {
  await ts.close();
});

const registry = new WorkflowRegistry().register(
  defineWorkflow<{ tag: string }, string>({
    name: "heartbeat-report",
    async run(ctx, input) {
      return await ctx.step("report", () => `reported ${input.tag}`);
    },
  }),
);

describe("recurring schedules", () => {
  it("spawns runs repeatedly at the configured interval", async () => {
    await ts.store.createSchedule({
      id: randomUUID(),
      workflowName: "heartbeat-report",
      input: { tag: "cron" },
      intervalMs: 60,
    });

    const worker = new Worker(
      { store: ts.store, registry },
      { workerId: "scheduler", pollIntervalMs: 10 },
    );
    worker.start();

    try {
      await waitFor(async () => {
        const runs = await ts.store.listRuns({ status: "completed" });
        return runs.length >= 3;
      });
    } finally {
      await worker.stop();
    }

    const runs = await ts.store.listRuns({});
    expect(runs.every((r) => r.workflowName === "heartbeat-report")).toBe(true);
    expect(runs.every((r) => r.status === "completed")).toBe(true);
  });

  it("stops spawning once the schedule is deleted", async () => {
    const schedule = await ts.store.createSchedule({
      id: randomUUID(),
      workflowName: "heartbeat-report",
      input: { tag: "stop-me" },
      intervalMs: 40,
    });

    const worker = new Worker(
      { store: ts.store, registry },
      { workerId: "scheduler", pollIntervalMs: 10 },
    );
    worker.start();

    try {
      await waitFor(async () => (await ts.store.listRuns({})).length >= 1);
      expect(await ts.store.deleteSchedule(schedule.id)).toBe(true);

      await delay(50);
      const countAfterDelete = (await ts.store.listRuns({})).length;
      await delay(120);
      expect((await ts.store.listRuns({})).length).toBe(countAfterDelete);
    } finally {
      await worker.stop();
    }

    expect(await ts.store.deleteSchedule(schedule.id)).toBe(false);
  });

  it("manages schedules through the API", async () => {
    const app = buildServer({ store: ts.store });

    const created = await app.inject({
      method: "POST",
      url: "/api/workflows/heartbeat-report/schedules",
      payload: { input: { tag: "api" }, intervalMs: 5_000 },
    });
    expect(created.statusCode).toBe(201);
    const schedule = created.json();
    expect(schedule.workflowName).toBe("heartbeat-report");
    expect(schedule.intervalMs).toBe(5_000);

    const listed = await app.inject({ method: "GET", url: "/api/schedules" });
    expect(listed.json().schedules).toHaveLength(1);

    const tooFast = await app.inject({
      method: "POST",
      url: "/api/workflows/heartbeat-report/schedules",
      payload: { intervalMs: 1 },
    });
    expect(tooFast.statusCode).toBe(400);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/schedules/${schedule.id}`,
    });
    expect(deleted.statusCode).toBe(204);

    const missing = await app.inject({
      method: "DELETE",
      url: `/api/schedules/${schedule.id}`,
    });
    expect(missing.statusCode).toBe(404);

    await app.close();
  });
});
