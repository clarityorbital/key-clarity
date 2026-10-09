import { describe, expect, it } from "vitest";
import { addActivityPage, buildReport, emptyMetrics, newAccumulator } from "../src/proxy/usage";
import { assignSlots, axisMax, renderUsageHtml, SERIES_COUNT, type UsageViewState } from "../src/usageView";

const m = (spend: number) => ({ ...emptyMetrics(), spend });

describe("assignSlots", () => {
  it("keeps a model's color across loads and folds the rest into Other", () => {
    const slots = new Map<string, number>();
    assignSlots([["opus", m(9)], ["sonnet", m(5)], ["unused", m(0)]], slots);
    expect([...slots]).toEqual([["opus", 0], ["sonnet", 1]]);
    // Next load: sonnet now leads, but keeps its slot.
    assignSlots([["sonnet", m(20)], ["haiku", m(3)]], slots);
    expect(slots.get("sonnet")).toBe(1);
    expect(slots.get("haiku")).toBe(2);
    const many = Array.from({ length: 12 }, (_, i): [string, ReturnType<typeof m>] => [`m${i}`, m(1)]);
    assignSlots(many, slots);
    expect(slots.size).toBe(SERIES_COUNT);
  });
});

describe("axisMax", () => {
  it("lands gridlines on round steps", () => {
    expect(axisMax(31)).toBe(40);
    expect(axisMax(41)).toBe(80);
    expect(axisMax(0.3)).toBe(0.4);
    expect(axisMax(0)).toBe(1);
  });
});

describe("renderUsageHtml", () => {
  const base: UsageViewState = { period: "30d", keyHash: null, keyOptions: [], keyNames: new Map(), loading: false, slots: new Map() };
  const csp = { nonce: "abc", cspSource: "vscode-resource:" };

  it("escapes names from the proxy and only runs its own script", () => {
    const acc = newAccumulator();
    addActivityPage(acc, {
      results: [
        {
          date: "2026-09-01",
          metrics: { spend: 2, api_requests: 1 },
          breakdown: {
            model_groups: { "<img src=x onerror=alert(1)>": { metrics: { spend: 2 } } },
            api_keys: { abc: { metrics: { spend: 2 }, metadata: { key_alias: "<script>alert(2)</script>" } } },
          },
        },
      ],
    });
    const html = renderUsageHtml({ ...base, report: buildReport(acc, "2026-09-01", "2026-09-02") }, csp);
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).toContain(`<script nonce="abc">`);
    expect(html).toContain("script-src 'nonce-abc'");
  });

  it("shows errors and empty periods instead of a chart", () => {
    expect(renderUsageHtml({ ...base, error: "403 <nope>" }, csp)).toContain("403 &lt;nope&gt;");
    const empty = buildReport(newAccumulator(), "2026-09-01", "2026-09-07");
    expect(renderUsageHtml({ ...base, report: empty }, csp)).toContain("No usage in this period.");
  });
});
