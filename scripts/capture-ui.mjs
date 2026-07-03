import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.REFLOW_URL ?? "http://localhost:3000";

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok && res.status !== 202) {
    throw new Error(`${method} ${path} -> ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function seed() {
  const order = await api("POST", "/api/workflows/order-processing/runs", {
    input: { orderId: "order-1042", amount: 129 },
  });

  const batch = await api("POST", "/api/workflows/batch-notify/runs", {
    input: { userIds: ["ada", "grace", "linus"], message: "deploy done" },
  });

  const approval = await api("POST", "/api/workflows/expense-approval/runs", {
    input: { employee: "ada", amount: 1200, reason: "conference" },
  });

  const approved = await api("POST", "/api/workflows/expense-approval/runs", {
    input: { employee: "grace", amount: 340, reason: "gpu credits" },
  });

  await api("POST", "/api/workflows/ghost-workflow/runs", {
    input: { oops: true },
  });

  const doomed = await api("POST", "/api/workflows/order-processing/runs", {
    input: { orderId: "order-cancelled", amount: 15 },
  });
  await api("POST", `/api/runs/${doomed.id}/cancel`);

  await wait(2_500);
  await api("POST", `/api/runs/${approved.id}/signals/decision`, {
    payload: { approved: true, reviewer: "grace" },
  });

  await wait(6_000);
  return { batch: batch.id, approval: approval.id, order: order.id };
}

async function capture() {
  mkdirSync("docs", { recursive: true });
  const { batch, order } = await seed();

  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1440, height: 860 },
    deviceScaleFactor: 2,
  });

  await page.goto(BASE);
  await page.waitForSelector(".run");
  await page.click(`.run[data-id="${batch}"]`);
  await page.waitForSelector(".event");
  await wait(2_500);
  await page.screenshot({ path: "docs/ui.png" });

  await page.click(`.run[data-id="${order}"]`);
  await page.waitForSelector(".event");
  await wait(2_500);
  await page.screenshot({ path: "docs/ui-retries.png" });

  await browser.close();
  console.log("saved docs/ui.png and docs/ui-retries.png");
}

capture().catch((err) => {
  console.error(err);
  process.exit(1);
});
