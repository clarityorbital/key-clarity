import type { KeyInfo } from "./proxy/client";

const DAY_MS = 86_400_000;

export function money(n: number): string {
  if (n > 0 && n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

const UNITS: Record<string, [string, string]> = {
  s: ["second", "seconds"],
  m: ["minute", "minutes"],
  h: ["hour", "hours"],
  d: ["day", "days"],
  w: ["week", "weeks"],
  mo: ["month", "months"],
};
const SAME_AS: Record<string, string> = { "60m": "hour", "24h": "day", "7d": "week" };
const ADVERBS: Record<string, string> = { hour: "hourly", day: "daily", week: "weekly", month: "monthly" };

/** A LiteLLM budget duration in words: `1mo` is "month", `7d` is "week", `30d` is "30 days". */
export function periodName(duration: string): string {
  const m = /^(\d+)\s*(mo|s|m|h|d|w)$/.exec(duration.trim());
  if (!m) return duration;
  const n = Number(m[1]);
  const [one, many] = UNITS[m[2]];
  return SAME_AS[`${n}${m[2]}`] ?? (n === 1 ? one : `${n} ${many}`);
}

/** "monthly", "weekly", or "every 30 days". */
export function periodAdverb(duration: string): string {
  const name = periodName(duration);
  return ADVERBS[name] ?? `every ${name}`;
}

/** "this month", or "this period" for periods without a one-word name. */
function thisPeriod(duration: string): string {
  const name = periodName(duration);
  return name in ADVERBS ? `this ${name}` : "this period";
}

export function budgetText(info: KeyInfo): string {
  const period = info.budgetDuration;
  if (info.maxBudget !== null) {
    const base = `${money(info.spend)} / ${money(info.maxBudget)}`;
    return period ? `${base} ${periodAdverb(period)}` : base;
  }
  return period ? `${money(info.spend)} ${thisPeriod(period)}` : `${money(info.spend)} spent`;
}

/** When a periodic budget next resets, such as "resets in 3 days". */
export function resetText(info: KeyInfo, now = Date.now()): string | undefined {
  if (!info.budgetDuration || !info.budgetResetAt || Number.isNaN(Date.parse(info.budgetResetAt))) return undefined;
  const ms = Date.parse(info.budgetResetAt) - now;
  if (ms <= 0) return "resets soon";
  const days = Math.floor(ms / DAY_MS);
  if (days === 0) return "resets today";
  return days === 1 ? "resets in 1 day" : `resets in ${days} days`;
}

/** Budget, spend and reset rows for a key's details, as label and plain-text value. */
export function budgetRows(info: KeyInfo, now = Date.now()): Array<[string, string]> {
  const period = info.budgetDuration;
  const limit = info.maxBudget;
  const rows: Array<[string, string]> = [];
  if (limit !== null) {
    const name = period ? periodName(period) : undefined;
    const per = !name ? "total" : name in ADVERBS ? `per ${name}` : `every ${name}`;
    rows.push(["Budget", `${money(limit)} ${per}`]);
  } else {
    rows.push(["Budget", period ? `no limit, spend resets ${periodAdverb(period)}` : "no limit"]);
  }
  const spentLabel = period ? `Spent ${thisPeriod(period)}` : "Spent";
  const pct = budgetPercent(info);
  rows.push([
    spentLabel,
    limit !== null && pct !== undefined
      ? `${money(info.spend)} (${Math.floor(pct)}%), ${money(Math.max(0, limit - info.spend))} left`
      : money(info.spend),
  ]);
  const reset = resetText(info, now);
  if (reset && info.budgetResetAt) rows.push(["Resets", `${new Date(info.budgetResetAt).toLocaleString()} (${reset.replace(/^resets /, "")})`]);
  return rows;
}

export function expiryText(info: KeyInfo, now = Date.now()): string | undefined {
  if (!info.expires || Number.isNaN(Date.parse(info.expires))) return undefined;
  const ms = Date.parse(info.expires) - now;
  if (ms <= 0) return "expired";
  const days = Math.floor(ms / DAY_MS);
  if (days === 0) return "expires today";
  return days === 1 ? "1 day left" : `${days} days left`;
}

export function budgetPercent(info: KeyInfo): number | undefined {
  if (info.maxBudget === null || info.maxBudget <= 0) return undefined;
  return (info.spend / info.maxBudget) * 100;
}

export type Warning = { kind: "budget" | "expiry" | "blocked"; message: string };

/** Problems worth telling the user about for a key they are using. */
export function keyWarnings(alias: string, info: KeyInfo, opts: { budgetPercent: number; expiryDays: number }, now = Date.now()): Warning[] {
  const out: Warning[] = [];
  if (info.blocked || info.status === "revoked") {
    out.push({ kind: "blocked", message: `Key "${alias}" is blocked on the proxy.` });
  }
  const pct = budgetPercent(info);
  if (pct !== undefined && pct >= opts.budgetPercent) {
    const adverb = info.budgetDuration ? ADVERBS[periodName(info.budgetDuration)] : undefined;
    const which = adverb ? `${adverb} budget` : "budget";
    const reset = resetText(info, now);
    const tail = reset ? `; it ${reset}` : "";
    out.push({
      kind: "budget",
      message: `Key "${alias}" has used ${Math.floor(pct)}% of its ${which} (${money(info.spend)} / ${money(info.maxBudget!)})${tail}.`,
    });
  }
  if (info.expires && !Number.isNaN(Date.parse(info.expires))) {
    const ms = Date.parse(info.expires) - now;
    if (ms <= 0) out.push({ kind: "expiry", message: `Key "${alias}" has expired.` });
    else if (ms <= opts.expiryDays * DAY_MS) {
      const days = Math.floor(ms / DAY_MS);
      const when = days === 0 ? "today" : days === 1 ? "in 1 day" : `in ${days} days`;
      out.push({ kind: "expiry", message: `Key "${alias}" expires ${when}.` });
    }
  }
  return out;
}
