import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Worker, WorkflowRegistry } from "@reflow/core";
import { defineWorkflow } from "@reflow/sdk";
import { buildServer } from "@reflow/server";
import { createTestStore, delay, type TestStore } from "./helpers.js";

let ts: TestStore;

beforeEach(async () => {
  ts = await createTestStore();
});

afterEach(async () => {
  await ts.close();
});

const registry = new WorkflowRegistry().register(
  defineWorkflow<null, string>({
    name: "delayed",
    async run(ctx) {
      return await ctx.step("work", () => "done later");
    },
  }),
);

describe("scheduled runs", () => {
  it("keeps a future-scheduled run unclaimable until due", async () => {
    const run = await ts.store.createRun({
      id: randomUUID(),
      workflowName: "delayed",
      input: null,
      startAt: new Date(Date.now() + 60),
    });
    expect(run.status).toBe("sleeping");
    expect(run.wakeAt).not.toBeNull();

    const worker = new Worker({ store: ts.store, registry }, { workerId: "sched" });
    expect(await worker.tick()).toBeNull();

    await delay(80);
    expect(await worker.tick()).toBe("completed");
    expect((await ts.store.getRun(run.id))?.output).toBe("done later");
  });

  it("starts immediately when startAt is in the past", async () => {
    const run = await ts.store.createRun({
      id: randomUUID(),
      workflowName: "delayed",
      input: null,
      startAt: new Date(Date.now() - 1_000),
    });
    expect(run.status).toBe("pending");

    const worker = new Worker({ store: ts.store, registry }, { workerId: "sched" });
    expect(await worker.tick()).toBe("completed");
  });

  it("accepts startAt through the API", async () => {
    const app = buildServer({ store: ts.store });
    const startAt = new Date(Date.now() + 3_600_000).toISOString();

    const created = await app.inject({
      method: "POST",
      url: "/api/workflows/delayed/runs",
      payload: { startAt },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().status).toBe("sleeping");
    expect(created.json().wakeAt).toBe(startAt);

    const invalid = await app.inject({
      method: "POST",
      url: "/api/workflows/delayed/runs",
      payload: { startAt: "tomorrow" },
    });
    expect(invalid.statusCode).toBe(400);

    await app.close();
  });
});
