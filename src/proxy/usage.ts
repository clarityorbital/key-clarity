// Spend by day, model and key, from LiteLLM's `/user/daily/activity`. Pure: no vscode, no network.
// Response shape: litellm/types/proxy/management_endpoints/common_daily_activity.py.

export interface UsageMetrics {
  spend: number;
  inputTokens: number;
  outputTokens: number;
  requests: number;
  failedRequests: number;
}

export interface UsageDay {
  /** UTC date, `YYYY-MM-DD`. */
  date: string;
  total: UsageMetrics;
  /** By the model name callers asked for (LiteLLM's model group), else the underlying model. */
  models: Map<string, UsageMetrics>;
}

export interface KeyUsage extends UsageMetrics {
  /** sha256 hex of the key. */
  hash: string;
  alias: string | null;
}

export interface UsageReport {
  start: string;
  end: string;
  /** Every date from start through end, oldest first; days without spend are zero. */
  days: UsageDay[];
  total: UsageMetrics;
  /** Totals per model, highest spend first. */
  models: Array<[string, UsageMetrics]>;
  /** Totals per key, highest spend first. */
  keys: KeyUsage[];
}

/** Days and keys gathered from one or more pages; a date can span pages. */
export interface UsageAccumulator {
  days: Map<string, UsageDay>;
  keys: Map<string, KeyUsage>;
}

export const emptyMetrics = (): UsageMetrics => ({ spend: 0, inputTokens: 0, outputTokens: 0, requests: 0, failedRequests: 0 });

export function newAccumulator(): UsageAccumulator {
  return { days: new Map(), keys: new Map() };
}

function add(into: UsageMetrics, m: UsageMetrics): void {
  into.spend += m.spend;
  into.inputTokens += m.inputTokens;
  into.outputTokens += m.outputTokens;
  into.requests += m.requests;
  into.failedRequests += m.failedRequests;
}

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function parseMetrics(value: unknown): UsageMetrics {
  const m = asRecord(value);
  return {
    spend: n(m.spend),
    inputTokens: n(m.prompt_tokens),
    outputTokens: n(m.completion_tokens),
    requests: n(m.api_requests),
    failedRequests: n(m.failed_requests),
  };
}

/** Adds one page of `/user/daily/activity` to `acc`. Returns whether the proxy has more pages. */
export function addActivityPage(acc: UsageAccumulator, body: unknown): boolean {
  const rec = asRecord(body);
  if (!Array.isArray(rec.results)) throw new Error("The proxy did not return daily activity.");
  for (const item of rec.results) {
    const row = asRecord(item);
    const date = typeof row.date === "string" ? row.date.slice(0, 10) : null;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    let day = acc.days.get(date);
    if (!day) acc.days.set(date, (day = { date, total: emptyMetrics(), models: new Map() }));
    add(day.total, parseMetrics(row.metrics));

    const breakdown = asRecord(row.breakdown);
    // Model groups are the names callers use, such as `claude-opus-5-5`. Older proxies only have models.
    const groups = asRecord(breakdown.model_groups);
    const byModel = Object.keys(groups).length > 0 ? groups : asRecord(breakdown.models);
    for (const [name, entry] of Object.entries(byModel)) {
      let m = day.models.get(name);
      if (!m) day.models.set(name, (m = emptyMetrics()));
      add(m, parseMetrics(asRecord(entry).metrics));
    }

    for (const [hash, entry] of Object.entries(asRecord(breakdown.api_keys))) {
      const e = asRecord(entry);
      let k = acc.keys.get(hash);
      if (!k) acc.keys.set(hash, (k = { hash, alias: null, ...emptyMetrics() }));
      const alias = asRecord(e.metadata).key_alias;
      if (typeof alias === "string" && alias) k.alias = alias;
      add(k, parseMetrics(e.metrics));
    }
  }
  return asRecord(rec.metadata).has_more === true;
}

export function buildReport(acc: UsageAccumulator, start: string, end: string): UsageReport {
  const days: UsageDay[] = [];
  const total = emptyMetrics();
  const models = new Map<string, UsageMetrics>();
  for (const date of datesBetween(start, end)) {
    const day = acc.days.get(date) ?? { date, total: emptyMetrics(), models: new Map() };
    days.push(day);
    add(total, day.total);
    for (const [name, m] of day.models) {
      let t = models.get(name);
      if (!t) models.set(name, (t = emptyMetrics()));
      add(t, m);
    }
  }
  return {
    start,
    end,
    days,
    total,
    models: [...models].sort((a, b) => b[1].spend - a[1].spend || a[0].localeCompare(b[0])),
    keys: [...acc.keys.values()].sort((a, b) => b.spend - a.spend || a.hash.localeCompare(b.hash)),
  };
}

/** Inclusive list of UTC dates; at most 400, so a bad range can't run away. */
export function datesBetween(start: string, end: string): string[] {
  const out: string[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || Number.isNaN(last.getTime())) return out;
  while (d <= last && out.length < 400) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export type UsagePeriod = "7d" | "30d" | "90d" | "thisMonth" | "lastMonth";

export const USAGE_PERIODS: ReadonlyArray<{ id: UsagePeriod; label: string }> = [
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "90d", label: "Last 90 days" },
  { id: "thisMonth", label: "This month" },
  { id: "lastMonth", label: "Last month" },
];

/** The UTC date range of a period, ending today. */
export function periodRange(period: UsagePeriod, now: Date = new Date()): { start: string; end: string } {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  switch (period) {
    case "thisMonth":
      return { start: day(new Date(Date.UTC(y, m, 1))), end: day(now) };
    case "lastMonth":
      return { start: day(new Date(Date.UTC(y, m - 1, 1))), end: day(new Date(Date.UTC(y, m, 0))) };
    default: {
      const days = Number(period.slice(0, -1));
      return { start: day(new Date(Date.UTC(y, m, now.getUTCDate() - days + 1))), end: day(now) };
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
