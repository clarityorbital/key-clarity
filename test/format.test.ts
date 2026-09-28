import { describe, expect, it } from "vitest";
import { budgetRows, budgetText, expiryText, keyWarnings, money, periodName, resetText } from "../src/format";
import type { KeyInfo } from "../src/proxy/client";

const now = Date.parse("2026-09-26T12:00:00Z");
const info = (over: Partial<KeyInfo> = {}): KeyInfo => ({
  alias: "k",
  spend: 0,
  maxBudget: null,
  budgetDuration: null,
  budgetResetAt: null,
  expires: null,
  models: [],
  userId: null,
  blocked: false,
  status: null,
  ...over,
});
const opts = { budgetPercent: 90, expiryDays: 3 };

describe("format", () => {
  it("formats money and budgets", () => {
    expect(money(12.4)).toBe("$12.40");
    expect(money(0.001)).toBe("<$0.01");
    expect(money(0)).toBe("$0.00");
    expect(budgetText(info({ spend: 12.4, maxBudget: 50 }))).toBe("$12.40 / $50.00");
    expect(budgetText(info({ spend: 3 }))).toBe("$3.00 spent");
  });

  it("names budget periods", () => {
    expect(periodName("1mo")).toBe("month");
    expect(periodName("7d")).toBe("week");
    expect(periodName("1w")).toBe("week");
    expect(periodName("24h")).toBe("day");
    expect(periodName("30d")).toBe("30 days");
    expect(periodName("3mo")).toBe("3 months");
    expect(periodName("odd")).toBe("odd");
  });

  it("formats periodic budgets", () => {
    expect(budgetText(info({ spend: 12.4, maxBudget: 200, budgetDuration: "1mo" }))).toBe("$12.40 / $200.00 monthly");
    expect(budgetText(info({ spend: 12.4, maxBudget: 200, budgetDuration: "30d" }))).toBe("$12.40 / $200.00 every 30 days");
    expect(budgetText(info({ spend: 3, budgetDuration: "1mo" }))).toBe("$3.00 this month");
  });

  it("describes when a periodic budget resets", () => {
    const monthly = { maxBudget: 200, budgetDuration: "1mo" };
    expect(resetText(info({ ...monthly, budgetResetAt: "2026-10-01T00:00:00Z" }), now)).toBe("resets in 4 days");
    expect(resetText(info({ ...monthly, budgetResetAt: "2026-09-26T20:00:00Z" }), now)).toBe("resets today");
    expect(resetText(info({ ...monthly, budgetResetAt: "2026-09-26T00:00:00Z" }), now)).toBe("resets soon");
    // A leftover reset date on a total budget is ignored.
    expect(resetText(info({ maxBudget: 200, budgetResetAt: "2026-10-01T00:00:00Z" }), now)).toBeUndefined();
  });

  it("lists budget rows for monthly, total and unlimited keys", () => {
    const monthly = budgetRows(info({ spend: 50, maxBudget: 200, budgetDuration: "1mo", budgetResetAt: "2026-10-01T00:00:00Z" }), now);
    expect(monthly.map(([k]) => k)).toEqual(["Budget", "Spent this month", "Resets"]);
    expect(monthly[0][1]).toBe("$200.00 per month");
    expect(monthly[1][1]).toBe("$50.00 (25%), $150.00 left");
    expect(monthly[2][1]).toMatch(/\(in 4 days\)$/);

    expect(budgetRows(info({ spend: 510, maxBudget: 500 }), now)).toEqual([
      ["Budget", "$500.00 total"],
      ["Spent", "$510.00 (102%), $0.00 left"],
    ]);
    expect(budgetRows(info({ spend: 3 }), now)).toEqual([
      ["Budget", "no limit"],
      ["Spent", "$3.00"],
    ]);
    expect(budgetRows(info({ spend: 3, budgetDuration: "30d" }), now)[0][1]).toBe("no limit, spend resets every 30 days");
  });

  it("describes expiry", () => {
    expect(expiryText(info(), now)).toBeUndefined();
    expect(expiryText(info({ expires: "2026-09-26T18:00:00Z" }), now)).toBe("expires today");
    expect(expiryText(info({ expires: "2026-09-27T13:00:00Z" }), now)).toBe("1 day left");
    expect(expiryText(info({ expires: "2026-10-06T12:00:00Z" }), now)).toBe("10 days left");
    expect(expiryText(info({ expires: "2026-09-25T12:00:00Z" }), now)).toBe("expired");
  });
});

describe("keyWarnings", () => {
  it("is quiet for a healthy key", () => {
    expect(keyWarnings("k", info({ spend: 10, maxBudget: 50, expires: "2026-12-01T00:00:00Z" }), opts, now)).toEqual([]);
  });

  it("warns near budget, near expiry and when blocked", () => {
    const w = keyWarnings("proj", info({ spend: 46, maxBudget: 50, expires: "2026-09-28T13:00:00Z", blocked: true }), opts, now);
    expect(w.map((x) => x.kind)).toEqual(["blocked", "budget", "expiry"]);
    expect(w[1].message).toBe(`Key "proj" has used 92% of its budget ($46.00 / $50.00).`);
    expect(w[2].message).toBe(`Key "proj" expires in 2 days.`);
    expect(keyWarnings("p", info({ expires: "2026-09-26T01:00:00Z" }), opts, now)[0].message).toBe(`Key "p" has expired.`);
  });

  it("names the period and reset in a periodic budget warning", () => {
    const w = keyWarnings("proj", info({ spend: 190, maxBudget: 200, budgetDuration: "1mo", budgetResetAt: "2026-10-01T00:00:00Z" }), opts, now);
    expect(w[0].message).toBe(`Key "proj" has used 95% of its monthly budget ($190.00 / $200.00); it resets in 4 days.`);
  });
});
