import { randomUUID } from "node:crypto";
import type { WorkflowRegistry } from "../definition.js";
import { executeClaimedRun, type ExecutionOutcome } from "../engine/executor.js";
import type { WorkflowStore } from "../store.js";
import type { WorkflowRun } from "../types.js";

export interface WorkerOptions {
  workerId?: string;
  pollIntervalMs?: number;
  lockTtlMs?: number;
  heartbeatIntervalMs?: number;
  concurrency?: number;
  onRunFinished?: (run: WorkflowRun, outcome: ExecutionOutcome) => void;
  onError?: (err: unknown) => void;
}

export interface WorkerDeps {
  store: WorkflowStore;
  registry: WorkflowRegistry;
}

export class Worker {
  readonly workerId: string;

  private readonly store: WorkflowStore;
  private readonly registry: WorkflowRegistry;
  private readonly pollIntervalMs: number;
  private readonly lockTtlMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly concurrency: number;
  private readonly onRunFinished: ((run: WorkflowRun, outcome: ExecutionOutcome) => void) | undefined;
  private readonly onError: (err: unknown) => void;

  private running = false;
  private loops: Promise<void>[] = [];

  constructor(deps: WorkerDeps, options: WorkerOptions = {}) {
    this.store = deps.store;
    this.registry = deps.registry;
    this.workerId = options.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.lockTtlMs = options.lockTtlMs ?? 30_000;
    this.heartbeatIntervalMs =
      options.heartbeatIntervalMs ?? Math.max(1_000, Math.floor(this.lockTtlMs / 3));
    this.concurrency = options.concurrency ?? 1;
    this.onRunFinished = options.onRunFinished;
    this.onError = options.onError ?? (() => {});
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loops = Array.from({ length: this.concurrency }, () => this.loop());
  }

  async stop(): Promise<void> {
    this.running = false;
    await Promise.all(this.loops);
    this.loops = [];
  }

  async tick(): Promise<ExecutionOutcome | null> {
    const run = await this.store.claimRun(this.workerId, this.lockTtlMs);
    if (!run) return null;

    const heartbeat = setInterval(() => {
      this.store
        .extendLock(run.id, this.workerId, this.lockTtlMs)
        .catch((err) => this.onError(err));
    }, this.heartbeatIntervalMs);

    try {
      const outcome = await executeClaimedRun(run, {
        store: this.store,
        registry: this.registry,
      });
      this.onRunFinished?.(run, outcome);
      return outcome;
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async loop(): Promise<void> {
    while (this.running) {
      let outcome: ExecutionOutcome | null = null;
      try {
        outcome = await this.tick();
      } catch (err) {
        this.onError(err);
      }
      if (outcome === null && this.running) {
        await delay(this.pollIntervalMs);
      }
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
