import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Worker, WorkflowRegistry, type WorkflowDefinition } from "@reflow/core";
import { defineWorkflow } from "@reflow/sdk";
import { createTestStore, delay, startRun, type TestStore } from "./helpers.js";

let ts: TestStore;

beforeEach(async () => {
  ts = await createTestStore();
});

afterEach(async () => {
  await ts.close();
});

function worker(registry: WorkflowRegistry): Worker {
  return new Worker({ store: ts.store, registry }, { workerId: "versions" });
}

const v1 = defineWorkflow<null, string[]>({
  name: "evolving",
  async run(ctx) {
    const steps: string[] = [];
    steps.push(await ctx.step("step-a", () => "a"));
    steps.push(await ctx.step("step-b", () => "b"));
    await ctx.sleep(30);
    steps.push(await ctx.step("step-d", () => "d"));
    return steps;
  },
});

const v2: WorkflowDefinition<null, string[]> = {
  name: "evolving",
  async run(ctx) {
    const steps: string[] = [];
    steps.push(await ctx.step("step-a", () => "a"));
    if ((await ctx.version("insert-step-c", 1)) >= 1) {
      steps.push(await ctx.step("step-c", () => "c"));
    }
    steps.push(await ctx.step("step-b", () => "b"));
    await ctx.sleep(30);
    steps.push(await ctx.step("step-d", () => "d"));
    return steps;
  },
};

describe("workflow versioning", () => {
  it("replays old runs on their old code path after a deploy", async () => {
    const run = await startRun(ts.store, "evolving");

    const oldWorker = worker(new WorkflowRegistry().register(v1));
    expect(await oldWorker.tick()).toBe("suspended");

    await delay(50);
    const newWorker = worker(new WorkflowRegistry().register(v2 as never));
    expect(await newWorker.tick()).toBe("completed");

    const final = await ts.store.getRun(run.id);
    expect(final?.status).toBe("completed");
    expect(final?.output).toEqual(["a", "b", "d"]);
  });

  it("gives fresh runs the new version and records a marker", async () => {
    const run = await startRun(ts.store, "evolving");
    const newWorker = worker(new WorkflowRegistry().register(v2 as never));

    expect(await newWorker.tick()).toBe("suspended");
    await delay(50);
    expect(await newWorker.tick()).toBe("completed");

    const final = await ts.store.getRun(run.id);
    expect(final?.output).toEqual(["a", "c", "b", "d"]);

    const history = await ts.store.getHistory(run.id);
    const marker = history.find((h) => h.event.type === "version_marked");
    expect(marker?.event).toEqual({
      type: "version_marked",
      changeId: "insert-step-c",
      version: 1,
    });
  });

  it("keeps the recorded version stable across crashes and replays", async () => {
    let failedOnce = false;
    const flaky: WorkflowDefinition<null, number> = {
      name: "flaky-versioned",
      async run(ctx) {
        const version = await ctx.version("some-change", 3);
        await ctx.step(
          "unstable",
          () => {
            if (!failedOnce) {
              failedOnce = true;
              throw new Error("transient");
            }
            return null;
          },
          { retry: { maxAttempts: 2, initialDelayMs: 10 } },
        );
        return version;
      },
    };

    const run = await startRun(ts.store, "flaky-versioned");
    const w = worker(new WorkflowRegistry().register(flaky as never));

    expect(await w.tick()).toBe("suspended");
    await delay(30);
    expect(await w.tick()).toBe("completed");

    expect((await ts.store.getRun(run.id))?.output).toBe(3);

    const history = await ts.store.getHistory(run.id);
    const markers = history.filter((h) => h.event.type === "version_marked");
    expect(markers).toHaveLength(1);
  });
});
