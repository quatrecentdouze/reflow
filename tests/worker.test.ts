import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Worker, WorkflowRegistry } from "@reflow/core";
import { defineWorkflow } from "@reflow/sdk";
import { createTestStore, delay, startRun, waitFor, type TestStore } from "./helpers.js";

let ts: TestStore;

beforeEach(async () => {
  ts = await createTestStore();
});

afterEach(async () => {
  await ts.close();
});

describe("crash recovery", () => {
  it("lets another worker take over a run whose lock expired", async () => {
    const registry = new WorkflowRegistry().register(
      defineWorkflow<null, string>({
        name: "takeover",
        async run(ctx) {
          return await ctx.step("work", () => "done by survivor");
        },
      }),
    );

    const run = await startRun(ts.store, "takeover");

    const claimed = await ts.store.claimRun("dead-worker", 30);
    expect(claimed?.id).toBe(run.id);

    expect(await ts.store.claimRun("survivor", 5_000)).toBeNull();

    await delay(50);

    const survivor = new Worker(
      { store: ts.store, registry },
      { workerId: "survivor", lockTtlMs: 5_000 },
    );
    expect(await survivor.tick()).toBe("completed");
    expect((await ts.store.getRun(run.id))?.output).toBe("done by survivor");
  });

  it("keeps the lock alive through heartbeats during long executions", async () => {
    const registry = new WorkflowRegistry().register(
      defineWorkflow<null, string>({
        name: "slow",
        async run(ctx) {
          return await ctx.step("slow-step", async () => {
            await delay(250);
            return "slow done";
          });
        },
      }),
    );

    const worker = new Worker(
      { store: ts.store, registry },
      { workerId: "steady", lockTtlMs: 100, heartbeatIntervalMs: 30 },
    );

    const run = await startRun(ts.store, "slow");
    const execution = worker.tick();

    await delay(150);
    expect(await ts.store.claimRun("thief", 5_000)).toBeNull();

    expect(await execution).toBe("completed");
    expect((await ts.store.getRun(run.id))?.output).toBe("slow done");
  });
});

describe("polling loop", () => {
  it("drains queued runs in the background until stopped", async () => {
    const registry = new WorkflowRegistry().register(
      defineWorkflow<{ n: number }, number>({
        name: "double",
        async run(ctx, input) {
          return await ctx.step("double", () => input.n * 2);
        },
      }),
    );

    const runs = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => startRun(ts.store, "double", { n })),
    );

    const worker = new Worker(
      { store: ts.store, registry },
      { workerId: "looper", pollIntervalMs: 10 },
    );
    worker.start();

    try {
      await waitFor(async () => {
        const all = await Promise.all(runs.map((r) => ts.store.getRun(r.id)));
        return all.every((r) => r?.status === "completed");
      });
    } finally {
      await worker.stop();
    }

    const outputs = await Promise.all(
      runs.map(async (r) => (await ts.store.getRun(r.id))?.output),
    );
    expect(outputs).toEqual([2, 4, 6, 8, 10]);
  });
});
