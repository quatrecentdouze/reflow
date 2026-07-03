import { defineWorkflow } from "@reflow/sdk";
import { log, simulateWork } from "./support.js";

export interface ExpenseInput {
  employee: string;
  amount: number;
  reason: string;
}

export interface Decision {
  approved: boolean;
  reviewer: string;
}

export const expenseApproval = defineWorkflow<ExpenseInput, string>({
  name: "expense-approval",
  async run(ctx, input) {
    await ctx.step("notify-reviewer", async () => {
      log(`expense of ${input.amount}€ from ${input.employee}: notifying reviewer`);
      await simulateWork(500);
      return { notified: true };
    });

    log(`waiting for a "decision" signal on run ${ctx.runId}`);
    const decision = await ctx.waitForSignal<Decision>("decision");

    if (!decision.approved) {
      await ctx.step("notify-rejection", async () => {
        log(`expense rejected by ${decision.reviewer}`);
        return null;
      });
      return "rejected";
    }

    await ctx.step("trigger-reimbursement", async () => {
      log(`expense approved by ${decision.reviewer}, reimbursing ${input.amount}€`);
      await simulateWork(1_000);
      return { reimbursed: input.amount };
    });
    return "approved";
  },
});
