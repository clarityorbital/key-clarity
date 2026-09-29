import * as vscode from "vscode";
import { Controller } from "./controller";
import { keyWarnings, sharedWarnings } from "./format";
import { registerCommands } from "./ui/commands";
import { KeysTreeProvider } from "./ui/keysTree";
import { StatusBar } from "./ui/statusBar";

/** Only returned to integration tests; other extensions must never reach the key store. */
export interface TestApi {
  controller: Controller;
  tree: KeysTreeProvider;
}

export function activate(ctx: vscode.ExtensionContext): TestApi | undefined {
  const controller = new Controller(ctx);
  const tree = new KeysTreeProvider(controller);
  ctx.subscriptions.push(
    controller,
    new StatusBar(controller),
    vscode.window.registerTreeDataProvider("keyClarity.keys", tree),
  );

  // Each warning is shown once per window session.
  const warned = new Set<string>();
  const warnForActiveKeys = async () => {
    const config = vscode.workspace.getConfiguration("keyClarity");
    const opts = {
      budgetPercent: config.get<number>("budgetWarningPercent") ?? 90,
      expiryDays: config.get<number>("expiryWarningDays") ?? 3,
    };
    for (const key of await controller.store.list()) {
      const info = controller.status.get(key.hash)?.info;
      if (!info || controller.activeLabels(key.hash).length === 0) continue;
      const warnings = [
        ...keyWarnings(key.alias, info, opts).map((w) => ({ id: `${key.hash}:${w.kind}`, message: w.message })),
        // User and team budgets are shared, so warn about each once, not once per key.
        ...sharedWarnings(controller.sharedBudgets(info), opts),
      ];
      for (const w of warnings) {
        if (warned.has(w.id)) continue;
        warned.add(w.id);
        void vscode.window.showWarningMessage(w.message, "Switch Key").then((c) => {
          if (c) void vscode.commands.executeCommand("keyClarity.switchKey");
        });
      }
    }
  };

  const refresh = async () => {
    await controller.refresh();
    await warnForActiveKeys();
  };
  const refreshQuietly = () => void refresh().catch(() => undefined);

  registerCommands(ctx, controller, refresh);

  const setContext = () =>
    void vscode.commands.executeCommand("setContext", "keyClarity.proxyConfigured", !!controller.proxyUrl());
  setContext();

  let timer: NodeJS.Timeout | undefined;
  const schedule = () => {
    if (timer) clearInterval(timer);
    const minutes = Math.max(1, vscode.workspace.getConfiguration("keyClarity").get<number>("refreshIntervalMinutes") ?? 5);
    timer = setInterval(refreshQuietly, minutes * 60_000);
  };
  schedule();
  ctx.subscriptions.push({ dispose: () => timer && clearInterval(timer) });

  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration("keyClarity.proxyUrl")) {
        setContext();
        try {
          await controller.reapplyActive();
        } catch (err) {
          void vscode.window.showErrorMessage(`Key Clarity: couldn't update Claude Code or Codex for the new proxy URL: ${err instanceof Error ? err.message : err}`);
        }
        refreshQuietly();
      } else if (e.affectsConfiguration("keyClarity.claude")) {
        try {
          await controller.reapplyActive();
        } catch (err) {
          void vscode.window.showErrorMessage(`Key Clarity: couldn't update Claude Code settings: ${err instanceof Error ? err.message : err}`);
        }
      }
      if (e.affectsConfiguration("keyClarity.refreshIntervalMinutes")) schedule();
      if (e.affectsConfiguration("keyClarity.terminal.exportVariables")) void controller.updateTerminalEnv();
      if (e.affectsConfiguration("keyClarity.budgetWarningPercent")) controller.fireChanged();
    }),
  );

  // Rewrite managed config if an update changed what Key Clarity writes (for example the
  // Windows apiKeyHelper command). Unchanged files aren't touched.
  void controller.reapplyActive().catch(() => controller.syncKeyFiles().catch(() => undefined));
  void controller.updateTerminalEnv();
  refreshQuietly();

  return ctx.extensionMode === vscode.ExtensionMode.Test ? { controller, tree } : undefined;
}

export function deactivate(): void {}
