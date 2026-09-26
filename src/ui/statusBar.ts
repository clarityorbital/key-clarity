import * as vscode from "vscode";
import type { Controller } from "../controller";
import { budgetPercent, budgetText } from "../format";

/** Shows the key in use for Claude Code and Codex; clicking opens the key switcher. */
export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem("keyClarity.status", vscode.StatusBarAlignment.Left, 50);

  constructor(private readonly controller: Controller) {
    this.item.name = "Key Clarity";
    this.item.command = "keyClarity.switchKey";
    controller.onDidChange(() => void this.update());
    void this.update();
  }

  dispose(): void {
    this.item.dispose();
  }

  private async update(): Promise<void> {
    if (!this.controller.proxyUrl()) {
      this.item.hide();
      return;
    }
    const keys = await this.controller.store.list();
    const alias = (hash: string | undefined) => keys.find((k) => k.hash === hash)?.alias;
    const claudeHash = this.controller.managed("claude")?.hash;
    const codexHash = this.controller.managed("codex")?.hash;
    const claude = alias(claudeHash);
    const codex = alias(codexHash);

    let label: string;
    if (!claude && !codex) label = "LiteLLM: no key in use";
    else if (claudeHash === codexHash || !codex || !claude) label = (claude ?? codex)!;
    else label = `Claude: ${claude} · Codex: ${codex}`;

    const primary = claudeHash ?? codexHash;
    const info = primary ? this.controller.status.get(primary)?.info : undefined;
    const spend = info && (claudeHash === codexHash || !codex || !claude) ? ` · ${budgetText(info)}` : "";
    this.item.text = `$(key) ${label}${spend}`;

    const pct = info ? budgetPercent(info) : undefined;
    const threshold = vscode.workspace.getConfiguration("keyClarity").get<number>("budgetWarningPercent") ?? 90;
    this.item.backgroundColor = pct !== undefined && pct >= threshold ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;

    const lines = [
      `Claude Code: ${claude ?? "not managed by Key Clarity"}`,
      `Codex: ${codex ?? "not managed by Key Clarity"}`,
      "",
      "Click to switch keys.",
    ];
    this.item.tooltip = lines.join("\n");
    this.item.show();
  }
}
