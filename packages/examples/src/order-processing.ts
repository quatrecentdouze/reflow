import { defineWorkflow } from "@reflow/sdk";
import { log, simulateWork } from "./support.js";

export interface OrderInput {
  orderId: string;
  amount: number;
}

export interface OrderOutput {
  status: "fulfilled";
  chargeId: string;
}

const paymentAttempts = new Map<string, number>();

export const orderProcessing = defineWorkflow<OrderInput, OrderOutput>({
  name: "order-processing",
  async run(ctx, input) {
    await ctx.step("reserve-inventory", async () => {
      log(`[${input.orderId}] reserving inventory...`);
      await simulateWork(2_000);
      log(`[${input.orderId}] inventory reserved`);
      return { reserved: true };
    });

    const charge = await ctx.step(
      "charge-payment",
      async () => {
        const attempt = (paymentAttempts.get(ctx.runId) ?? 0) + 1;
        paymentAttempts.set(ctx.runId, attempt);
        log(`[${input.orderId}] charging ${input.amount}€ (attempt ${attempt})...`);
        await simulateWork(1_000);
        if (attempt < 3) {
          log(`[${input.orderId}] payment gateway timeout!`);
          throw new Error("payment gateway timeout");
        }
        log(`[${input.orderId}] payment accepted`);
        return { chargeId: `ch_${ctx.runId.slice(0, 8)}` };
      },
      { retry: { maxAttempts: 5, initialDelayMs: 3_000, backoffFactor: 2 } },
    );

    await ctx.step("ship-order", async () => {
      log(`[${input.orderId}] shipping order...`);
      await simulateWork(2_000);
      log(`[${input.orderId}] order shipped`);
      return { shipped: true };
    });

    log(`[${input.orderId}] waiting 15s before follow-up email (durable timer)`);
    await ctx.sleep(15_000);

    await ctx.step("send-follow-up-email", async () => {
      log(`[${input.orderId}] sending follow-up email`);
      await simulateWork(500);
      return { sent: true };
    });

    return { status: "fulfilled", chargeId: charge.chargeId };
  },
});
