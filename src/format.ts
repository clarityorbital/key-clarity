import type { Budget, BudgetWindow, KeyInfo, OwnerBudgets } from "./proxy/client";

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
// LiteLLM resets 7d windows weekly and 30d windows on the 1st of each month, and its UI labels them so.
const SAME_AS: Record<string, string> = { "60m": "hour", "24h": "day", "7d": "week", "30d": "month" };
const ADVERBS: Record<string, string> = { hour: "hourly", day: "daily", week: "weekly", month: "monthly" };

/** A LiteLLM budget duration in words: `1mo` and `30d` are "month", `7d` is "week", `14d` is "14 days". */
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

export function budgetText(info: Budget): string {
  const period = info.budgetDuration;
  if (info.maxBudget !== null) {
    const base = `${money(info.spend)} / ${money(info.maxBudget)}`;
    return period ? `${base} ${periodAdverb(period)}` : base;
  }
  return period ? `${money(info.spend)} ${thisPeriod(period)}` : `${money(info.spend)} spent`;
}

/** When a periodic budget next resets, such as "resets in 3 days". */
export function resetText(info: Budget, now = Date.now()): string | undefined {
  if (!info.budgetDuration || !info.budgetResetAt || Number.isNaN(Date.parse(info.budgetResetAt))) return undefined;
  const ms = Date.parse(info.budgetResetAt) - now;
  if (ms <= 0) return "resets soon";
  const days = Math.floor(ms / DAY_MS);
  if (days === 0) return "resets today";
  return days === 1 ? "resets in 1 day" : `resets in ${days} days`;
}

/** Budget, spend and reset rows for a key, user or team, as label and plain-text value. */
export function budgetRows(info: Budget, now = Date.now()): Array<[string, string]> {
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

const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400, w: 604_800 };

/** When a budget window began: its next reset, less one period. A 30d window is a calendar month, as LiteLLM resets it. */
export function windowStart(w: Pick<BudgetWindow, "budgetDuration" | "resetAt">): Date | undefined {
  const reset = w.resetAt ? Date.parse(w.resetAt) : NaN;
  const m = /^(\d+)\s*(mo|s|m|h|d|w)$/.exec(w.budgetDuration.trim());
  if (Number.isNaN(reset) || !m) return undefined;
  const monthly = m[2] === "d" && m[1] === "30";
  const n = monthly ? 1 : Number(m[1]);
  if (m[2] === "mo" || monthly) {
    const start = new Date(reset);
    start.setUTCMonth(start.getUTCMonth() - n);
    return start;
  }
  return new Date(reset - n * UNIT_SECONDS[m[2]] * 1000);
}

const asBudget = (w: BudgetWindow, spend: number): Budget => ({
  spend,
  maxBudget: w.maxBudget,
  budgetDuration: w.budgetDuration,
  budgetResetAt: w.resetAt,
});

/** A key's budget windows whose spend is known, as budgets. */
export function windowBudgets(info: KeyInfo): Budget[] {
  return info.budgetWindows.flatMap((w) => (w.spend === null ? [] : [asBudget(w, w.spend)]));
}

/** Rows for one budget window, like `budgetRows`, saying so when its spend isn't known. */
export function budgetWindowRows(w: BudgetWindow, now = Date.now()): Array<[string, string]> {
  const rows = budgetRows(asBudget(w, w.spend ?? 0), now);
  if (w.spend === null) rows[1] = [rows[1][0], "not available"];
  return rows;
}

/** The budget closest to its limit. */
function tightest(budgets: Budget[]): Budget | undefined {
  let best: Budget | undefined;
  for (const b of budgets) {
    const pct = budgetPercent(b);
    if (pct !== undefined && (best === undefined || pct > budgetPercent(best)!)) best = b;
  }
  return best;
}

/** A user or team budget that also limits a key. */
export interface SharedBudget {
  /** `member` is the user's own budget within a team. */
  scope: "member" | "user" | "team";
  /** The team's alias or id; null for the user. */
  name: string | null;
  budget: Budget;
}

/** The budgets with a limit that apply to a key besides its own: the user's in the key's team, the user's, then the team's. */
export function sharedBudgets(info: Pick<KeyInfo, "userId" | "teamId">, owner: OwnerBudgets | undefined): SharedBudget[] {
  if (!owner) return [];
  const out: SharedBudget[] = [];
  const mine = !!info.userId && info.userId === owner.userId;
  const team = info.teamId ? owner.teams.find((t) => t.id === info.teamId) : undefined;
  const teamName = team ? (team.alias ?? team.id) : null;
  if (mine && team?.member && team.member.maxBudget !== null) out.push({ scope: "member", name: teamName, budget: team.member });
  if (mine && owner.user && owner.user.maxBudget !== null) out.push({ scope: "user", name: null, budget: owner.user });
  if (team && team.maxBudget !== null) out.push({ scope: "team", name: teamName, budget: team });
  return out;
}

export function sharedLabel(shared: SharedBudget): string {
  return shared.scope === "team" ? `team ${shared.name}` : "you";
}

/**
 * The key's spend, plus the budget that limits it when the key has none of its own:
 * "$12.40 spent · you: $50.00 / $200.00 monthly".
 */
export function spendSummary(info: KeyInfo, shared: SharedBudget[]): string {
  // The key's own budget windows come first: the one closest to its limit, such as "$42.00 / $200.00 monthly".
  const window = tightest(windowBudgets(info));
  if (window) return budgetText(window);
  const unknown = info.budgetWindows[0];
  if (unknown) return `${budgetText(info)} · ${money(unknown.maxBudget)} ${periodAdverb(unknown.budgetDuration)} limit`;
  const outer = info.maxBudget === null ? shared[0] : undefined;
  return outer ? `${budgetText(info)} · ${sharedLabel(outer)}: ${budgetText(outer.budget)}` : budgetText(info);
}

/** The highest share used of any budget that limits the key. */
export function highestPercent(info: KeyInfo, shared: SharedBudget[]): number | undefined {
  const all = [info, ...windowBudgets(info), ...shared.map((s) => s.budget)].map(budgetPercent).filter((p): p is number => p !== undefined);
  return all.length ? Math.max(...all) : undefined;
}

export function expiryText(info: KeyInfo, now = Date.now()): string | undefined {
  if (!info.expires || Number.isNaN(Date.parse(info.expires))) return undefined;
  const ms = Date.parse(info.expires) - now;
  if (ms <= 0) return "expired";
  const days = Math.floor(ms / DAY_MS);
  if (days === 0) return "expires today";
  return days === 1 ? "1 day left" : `${days} days left`;
}

export function budgetPercent(info: Budget): number | undefined {
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
  // One budget warning per key, for whichever of its budgets is closest to the limit.
  const closest = tightest([info, ...windowBudgets(info)]);
  const budget = closest && budgetWarning(`Key "${alias}" has`, "its", closest, opts.budgetPercent, now);
  if (budget) out.push({ kind: "budget", message: budget });
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

/** Warnings for user and team budgets near their limit, each with an id to show it once. */
export function sharedWarnings(shared: SharedBudget[], opts: { budgetPercent: number }, now = Date.now()): Array<{ id: string; message: string }> {
  const out: Array<{ id: string; message: string }> = [];
  for (const s of shared) {
    const message =
      s.scope === "member"
        ? budgetWarning("You have", "your", s.budget, opts.budgetPercent, now, ` in team "${s.name}"`)
        : s.scope === "user"
          ? budgetWarning("You have", "your", s.budget, opts.budgetPercent, now)
          : budgetWarning(`Team "${s.name}" has`, "its", s.budget, opts.budgetPercent, now);
    if (message) out.push({ id: `${s.scope}:${s.name ?? ""}`, message });
  }
  return out;
}

function budgetWarning(subject: string, possessive: string, b: Budget, threshold: number, now: number, where = ""): string | undefined {
  const pct = budgetPercent(b);
  if (pct === undefined || pct < threshold) return undefined;
  const adverb = b.budgetDuration ? ADVERBS[periodName(b.budgetDuration)] : undefined;
  const which = adverb ? `${adverb} budget` : "budget";
  const reset = resetText(b, now);
  const tail = reset ? `; it ${reset}` : "";
  return `${subject} used ${Math.floor(pct)}% of ${possessive} ${which}${where} (${money(b.spend)} / ${money(b.maxBudget!)})${tail}.`;
}
