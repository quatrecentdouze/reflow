import { describe, expect, it } from "vitest";
import { computeRetryDelayMs } from "@reflow/core";

describe("computeRetryDelayMs", () => {
  it("grows exponentially from the initial delay", () => {
    const policy = { maxAttempts: 5, initialDelayMs: 100, backoffFactor: 2 };
    expect(computeRetryDelayMs(policy, 1)).toBe(100);
    expect(computeRetryDelayMs(policy, 2)).toBe(200);
    expect(computeRetryDelayMs(policy, 3)).toBe(400);
  });

  it("caps the delay at maxDelayMs", () => {
    const policy = {
      maxAttempts: 10,
      initialDelayMs: 1_000,
      backoffFactor: 10,
      maxDelayMs: 5_000,
    };
    expect(computeRetryDelayMs(policy, 4)).toBe(5_000);
  });

  it("applies defaults", () => {
    expect(computeRetryDelayMs({ maxAttempts: 3 }, 1)).toBe(1_000);
    expect(computeRetryDelayMs({ maxAttempts: 3 }, 2)).toBe(2_000);
  });
});
