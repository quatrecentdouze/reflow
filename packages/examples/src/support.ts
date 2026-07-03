export function log(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`);
}

export function simulateWork(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
