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

const registry = new WorkflowRegistry().register(
  defineWorkflow<null, string>({
    name: "approval-with-deadline",
    async run(ctx) {
      await ctx.step("notify", () => null);
      const decision = await ctx.waitForSignal<{ approved: boolean }>("decision", {
        timeoutMs: 60,
      });
      if (!decision.received) {
        return await ctx.step("escalate", () => "escalated");
      }
      return decision.payload.approved ? "approved" : "rejected";
    },
  }),
);

function worker(): Worker {
  return new Worker({ store: ts.store, registry }, { workerId: "deadline" });
}

describe("waitForSignal with timeout", () => {
  it("takes the signal path when it arrives before the deadline", async () => {
    const run = await startRun(ts.store, "approval-with-deadline");
    const w = worker();

    expect(await w.tick()).toBe("suspended");
    const sleeping = await ts.store.getRun(run.id);
    expect(sleeping?.wakeAt).not.toBeNull();

    await ts.store.signalRun(run.id, "decision", { approved: true });
    expect(await w.tick()).toBe("completed");
    expect((await ts.store.getRun(run.id))?.output).toBe("approved");
  });

  it("takes the timeout path when no signal arrives", async () => {
    const run = await startRun(ts.store, "approval-with-deadline");
    const w = worker();

    expect(await w.tick()).toBe("suspended");
    expect(await w.tick()).toBeNull();

    await delay(80);
    expect(await w.tick()).toBe("completed");
    expect((await ts.store.getRun(run.id))?.output).toBe("escalated");

    const history = await ts.store.getHistory(run.id);
    expect(history.some((h) => h.event.type === "timer_fired")).toBe(true);
  });

  it("replays the chosen branch deterministically after the run continues", async () => {
    const escalations: number[] = [];
    const twoPhase = defineWorkflow<null, string>({
      name: "two-phase",
      async run(ctx) {
        const first = await ctx.waitForSignal("go", { timeoutMs: 30 });
        if (!first.received) {
          await ctx.step("escalate", () => {
            escalations.push(1);
            return null;
          });
        }
        await ctx.sleep(30);
        return first.received ? "signalled" : "timed out";
      },
    });

    const reg = new WorkflowRegistry().register(twoPhase);
    const w = new Worker({ store: ts.store, registry: reg }, { workerId: "deadline" });
    const run = await startRun(ts.store, "two-phase");

    expect(await w.tick()).toBe("suspended");
    await delay(50);
    expect(await w.tick()).toBe("suspended");
    await delay(50);
    expect(await w.tick()).toBe("completed");

    expect((await ts.store.getRun(run.id))?.output).toBe("timed out");
    expect(escalations).toHaveLength(1);
  });
});
