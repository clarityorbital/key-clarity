import { describe, expect, it } from "vitest";
import { budgetText, expiryText, keyWarnings, money } from "../src/format";
import type { KeyInfo } from "../src/proxy/client";

const now = Date.parse("2026-09-26T12:00:00Z");
const info = (over: Partial<KeyInfo> = {}): KeyInfo => ({
  alias: "k",
  spend: 0,
  maxBudget: null,
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
});
