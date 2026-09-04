import { config } from "../config.js";

export class BudgetExceededError extends Error {
  constructor(public readonly label: string, public readonly wouldSpend: number, public readonly cap: number) {
    super(`read budget exceeded: ${label} would bring spend to $${wouldSpend.toFixed(4)} (cap $${cap})`);
    this.name = "BudgetExceededError";
  }
}

/**
 * Hard per-read COGS cap (READ_BUDGET_USD). Checked BEFORE each external call —
 * a read that would exceed it fails cleanly rather than silently eating margin.
 */
export class BudgetGuard {
  private spent = 0;
  readonly entries: Array<{ label: string; cost: number }> = [];

  constructor(private readonly cap: number = config.readBudgetUsd) {}

  register(label: string, cost: number): void {
    const wouldSpend = this.spent + cost;
    if (wouldSpend > this.cap) throw new BudgetExceededError(label, wouldSpend, this.cap);
    this.spent = wouldSpend;
    this.entries.push({ label, cost });
  }

  total(): number {
    return this.spent;
  }
}
