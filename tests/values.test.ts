import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Worker, WorkflowRegistry } from "@reflow/core";
import { defineWorkflow } from "@reflow/sdk";
import { createTestStore, delay, startRun, type TestStore } from "./helpers.js";

let ts: TestStore;

beforeEach(async () => {
  ts = await createTestStore();
});

afterEach(async () => {
  await ts.close();
});

describe("deterministic values", () => {
  it("records now() and random() once and replays them across executions", async () => {
    const producedRandoms: number[] = [];
    let failedOnce = false;

    const registry = new WorkflowRegistry().register(
      defineWorkflow<null, { stamp: string; rand: number }>({
        name: "valued",
        async run(ctx) {
          const stamp = await ctx.now();
          const rand = await ctx.random();
          producedRandoms.push(rand);

          await ctx.step(
            "flaky",
            () => {
              if (!failedOnce) {
                failedOnce = true;
                throw new Error("transient");
              }
              return null;
            },
            { retry: { maxAttempts: 2, initialDelayMs: 10 } },
          );

          return { stamp: stamp.toISOString(), rand };
        },
      }),
    );

    const run = await startRun(ts.store, "valued");
    const worker = new Worker({ store: ts.store, registry }, { workerId: "values-worker" });

    expect(await worker.tick()).toBe("suspended");
    await delay(30);
    expect(await worker.tick()).toBe("completed");

    expect(producedRandoms).toHaveLength(2);
    expect(producedRandoms[1]).toBe(producedRandoms[0]);

    const final = await ts.store.getRun(run.id);
    const output = final?.output as { stamp: string; rand: number };
    expect(output.rand).toBe(producedRandoms[0]);
    expect(new Date(output.stamp).getTime()).toBeGreaterThan(0);

    const history = await ts.store.getHistory(run.id);
    const valueEvents = history.filter((h) => h.event.type === "value_recorded");
    expect(valueEvents).toHaveLength(2);
  });

  it("detects a value kind mismatch as nondeterminism", async () => {
    const v1 = defineWorkflow<null, number>({
      name: "shifting",
      async run(ctx) {
        const rand = await ctx.random();
        await ctx.sleep(10);
        return rand;
      },
    });
    const v2 = defineWorkflow<null, number>({
      name: "shifting",
      async run(ctx) {
        const stamp = await ctx.now();
        await ctx.sleep(10);
        return stamp.getTime();
      },
    });

    const run = await startRun(ts.store, "shifting");
    const w1 = new Worker(
      { store: ts.store, registry: new WorkflowRegistry().register(v1) },
      { workerId: "w1" },
    );
    expect(await w1.tick()).toBe("suspended");

    await delay(20);
    const w2 = new Worker(
      { store: ts.store, registry: new WorkflowRegistry().register(v2) },
      { workerId: "w2" },
    );
    expect(await w2.tick()).toBe("failed");
    expect((await ts.store.getRun(run.id))?.error).toContain("now()");
  });
});
