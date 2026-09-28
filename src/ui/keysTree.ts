import * as vscode from "vscode";
import type { Controller } from "../controller";
import { budgetRows, budgetWindowRows, expiryText, highestPercent, money, spendSummary, type SharedBudget } from "../format";
import { maskKey, type HeldKey } from "../keys/keyStore";
import type { Budget, KeyInfo, RemoteKey } from "../proxy/client";

export type KeyNode =
  | { kind: "held"; key: HeldKey }
  | { kind: "remoteGroup"; keys: RemoteKey[] }
  | { kind: "remote"; key: RemoteKey };

export class KeysTreeProvider implements vscode.TreeDataProvider<KeyNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly controller: Controller) {
    controller.onDidChange(() => this.emitter.fire());
  }

  async getChildren(node?: KeyNode): Promise<KeyNode[]> {
    if (node?.kind === "remoteGroup") return node.keys.map((key) => ({ kind: "remote", key }));
    if (node) return [];
    if (!this.controller.proxyUrl()) return [];
    const held = await this.controller.store.list();
    const nodes: KeyNode[] = held
      .sort((a, b) => a.alias.localeCompare(b.alias))
      .map((key) => ({ kind: "held", key }));
    if (this.controller.remote.length > 0) nodes.push({ kind: "remoteGroup", keys: this.controller.remote });
    return nodes;
  }

  getTreeItem(node: KeyNode): vscode.TreeItem {
    if (node.kind === "remoteGroup") {
      const item = new vscode.TreeItem(`Other keys on the proxy (${node.keys.length})`, vscode.TreeItemCollapsibleState.Collapsed);
      item.tooltip = "Your keys on the proxy whose secrets aren't stored here. Add one with \"Add Existing Key\" to use it.";
      item.iconPath = new vscode.ThemeIcon("cloud");
      return item;
    }
    if (node.kind === "remote") {
      const k = node.key;
      const item = new vscode.TreeItem(k.alias ?? k.maskedKey ?? k.hash.slice(0, 8));
      const shared = this.controller.sharedBudgets(k);
      item.description = [spendSummary(k, shared), expiryText(k)].filter(Boolean).join(" · ");
      item.tooltip = new vscode.MarkdownString(detailsTable(k.maskedKey ?? "(hidden)", k, [], shared));
      item.iconPath = new vscode.ThemeIcon("key", new vscode.ThemeColor("disabledForeground"));
      item.contextValue = "remoteKey";
      return item;
    }

    const { key } = node;
    const status = this.controller.status.get(key.hash);
    const active = this.controller.activeLabels(key.hash);
    const item = new vscode.TreeItem(key.alias);
    const parts: string[] = [];
    if (active.length) parts.push(active.join(", "));
    const shared = status?.info ? this.controller.sharedBudgets(status.info) : [];
    if (status?.info) {
      parts.push(spendSummary(status.info, shared));
      const exp = expiryText(status.info);
      if (exp) parts.push(exp);
    } else if (status?.limited) {
      parts.push("spend not shown");
    } else if (status?.error) {
      parts.push("can't reach proxy or key invalid");
    }
    item.description = parts.join(" · ");
    item.tooltip = new vscode.MarkdownString(
      status?.info
        ? detailsTable(maskKey(key.secret), status.info, active, shared)
        : status?.limited
          ? limitedTooltip(key.alias, maskKey(key.secret), status.limited.models, active)
          : `**${escape(key.alias)}** \`${maskKey(key.secret)}\`\n\n${escape(status?.error ?? "Not checked yet.")}`,
    );
    const pct = status?.info ? highestPercent(status.info, shared) : undefined;
    const threshold = vscode.workspace.getConfiguration("keyClarity").get<number>("budgetWarningPercent") ?? 90;
    const warn = !!status?.error || (pct !== undefined && pct >= threshold) || status?.info?.blocked;
    item.iconPath = new vscode.ThemeIcon(
      active.length ? "pass-filled" : "key",
      warn ? new vscode.ThemeColor("list.warningForeground") : active.length ? new vscode.ThemeColor("charts.green") : undefined,
    );
    item.contextValue = "heldKey";
    return item;
  }
}

function limitedTooltip(alias: string, masked: string, models: string[], active: string[]): string {
  const lines = [
    `**${escape(alias)}** \`${masked}\``,
    "",
    "This key works, but your proxy limits it to model calls, so it can't report its own spend or budget. " +
      "To see them, use **Key Clarity: Set Account Key** with a key that has key-management access.",
    "",
    `Models: ${models.length ? models.map(escape).join(", ") : "none listed"}`,
  ];
  if (active.length) lines.push("", `In use for: ${active.join(", ")}`);
  return lines.join("\n");
}

function escape(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, "\\$&");
}

function table(rows: Array<[string, string]>): string {
  return "| | |\n|---|---|\n" + rows.map(([k, v]) => `| ${k} | ${v} |`).join("\n");
}

/** Budget rows with proxy-supplied text (such as the period) escaped. */
function escapedBudgetRows(budget: Budget): Array<[string, string]> {
  return budgetRows(budget).map(([k, v]) => [k, escape(v)]);
}

function detailsTable(masked: string, info: KeyInfo, active: string[], shared: SharedBudget[]): string {
  const rows: Array<[string, string]> = [
    ["Key", `\`${masked.replace(/`/g, "")}\``],
    // With budget windows and no other key budget, the key's own spend is its all-time total.
    ...(info.budgetWindows.length && info.maxBudget === null && !info.budgetDuration
      ? [["Spent in total", escape(money(info.spend))] as [string, string]]
      : escapedBudgetRows(info)),
    ...info.budgetWindows.flatMap((w) => budgetWindowRows(w).map(([k, v]): [string, string] => [k, escape(v)])),
  ];
  rows.push(["Expires", info.expires ? `${new Date(info.expires).toLocaleString()} (${expiryText(info)})` : "never"]);
  rows.push(["Models", info.models.length ? info.models.map(escape).join(", ") : "all models the proxy allows"]);
  if (info.blocked) rows.push(["Status", "blocked"]);
  if (active.length) rows.push(["In use for", active.join(", ")]);
  const title = info.alias ? `**${escape(info.alias)}**\n\n` : "";
  const sections = shared.map((b) => {
    const team = escape(b.name ?? "");
    const heading =
      b.scope === "member"
        ? `**Your budget in team ${team}**, shared by your keys in the team`
        : b.scope === "user"
          ? "**Your budget**, shared by all your keys"
          : `**Team budget: ${team}**, shared by the team's keys`;
    return `\n\n${heading}\n\n${table(escapedBudgetRows(b.budget))}`;
  });
  return title + table(rows) + sections.join("");
}
