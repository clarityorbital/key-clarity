import { describe, expect, it } from "vitest";
import { addActivityPage, buildReport, datesBetween, newAccumulator, periodRange } from "../src/proxy/usage";

describe("periodRange", () => {
  const now = new Date("2026-10-09T15:00:00Z");
  it("ends today and counts today as a day", () => {
    expect(periodRange("7d", now)).toEqual({ start: "2026-10-03", end: "2026-10-09" });
    expect(periodRange("30d", now)).toEqual({ start: "2026-09-10", end: "2026-10-09" });
  });
  it("covers calendar months in UTC", () => {
    expect(periodRange("thisMonth", now)).toEqual({ start: "2026-10-01", end: "2026-10-09" });
    expect(periodRange("lastMonth", now)).toEqual({ start: "2026-09-01", end: "2026-09-30" });
    expect(periodRange("lastMonth", new Date("2026-01-05T00:00:00Z"))).toEqual({ start: "2025-12-01", end: "2025-12-31" });
  });
});

describe("activity pages", () => {
  it("falls back to underlying models when the proxy has no model groups, and ignores junk", () => {
    const acc = newAccumulator();
    const more = addActivityPage(acc, {
      results: [
        { date: "2026-09-02", metrics: { spend: 3, api_requests: 2 }, breakdown: { models: { "anthropic/claude-opus-5-5": { metrics: { spend: 3 } } } } },
        { date: "not a date", metrics: { spend: 99 } },
        "junk",
      ],
      metadata: { has_more: true },
    });
    expect(more).toBe(true);
    const report = buildReport(acc, "2026-09-01", "2026-09-02");
    expect(report.total).toMatchObject({ spend: 3, requests: 2 });
    expect(report.models).toEqual([["anthropic/claude-opus-5-5", expect.objectContaining({ spend: 3 })]]);
    expect(() => addActivityPage(acc, { detail: "nope" })).toThrow(/daily activity/);
  });

  it("caps runaway date ranges", () => {
    expect(datesBetween("2026-01-01", "2030-01-01")).toHaveLength(400);
    expect(datesBetween("bad", "2026-01-01")).toEqual([]);
  });
});
