import type { KeyInfo } from "./proxy/client";

const DAY_MS = 86_400_000;

export function money(n: number): string {
  if (n > 0 && n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

export function budgetText(info: KeyInfo): string {
  return info.maxBudget !== null ? `${money(info.spend)} / ${money(info.maxBudget)}` : `${money(info.spend)} spent`;
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
    out.push({ kind: "budget", message: `Key "${alias}" has used ${Math.floor(pct)}% of its budget (${budgetText(info)}).` });
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
