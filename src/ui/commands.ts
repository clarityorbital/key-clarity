import * as vscode from "vscode";
import { describeError, type Controller } from "../controller";
import { budgetText } from "../format";
import type { HeldKey } from "../keys/keyStore";
import { isForbidden, isInsecureRemote, LiteLLMClient, normalizeBaseUrl, ProxyError } from "../proxy/client";
import { claudeUserSettingsPath, claudeWorkspaceSettingsPath } from "../targets/claude";
import type { KeyNode } from "./keysTree";

const ASKED_LOGIN_PROMPT = "keyClarity.askedLoginPrompt";

type UseTarget = "both" | "claude" | "claudeWorkspace" | "codex";

export function registerCommands(ctx: vscode.ExtensionContext, controller: Controller, refresh: () => Promise<void>): void {
  const register = (id: string, fn: (...args: any[]) => PromiseLike<unknown>) =>
    ctx.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: any[]) => {
        try {
          await fn(...args);
        } catch (err) {
          void vscode.window.showErrorMessage(`Key Clarity: ${describeError(err)}`);
        }
      }),
    );

  // ----- helpers -------------------------------------------------------------------

  const pickHeldKey = async (placeHolder: string): Promise<HeldKey | undefined> => {
    const keys = (await controller.store.list()).sort((a, b) => a.alias.localeCompare(b.alias));
    if (keys.length === 0) {
      const add = await vscode.window.showInformationMessage("No keys stored yet.", "Add Existing Key", "Generate New Key");
      if (add === "Add Existing Key") await vscode.commands.executeCommand("keyClarity.addKey");
      if (add === "Generate New Key") await vscode.commands.executeCommand("keyClarity.generateKey");
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      keys.map((key) => {
        const info = controller.status.get(key.hash)?.info;
        const active = controller.activeLabels(key.hash);
        return {
          label: key.alias,
          description: [active.length ? `in use: ${active.join(", ")}` : "", info ? budgetText(info) : ""].filter(Boolean).join(" · "),
          key,
        };
      }),
      { placeHolder },
    );
    return picked?.key;
  };

  const keyFromArg = async (arg: unknown, placeHolder: string): Promise<HeldKey | undefined> => {
    const node = arg as KeyNode | undefined;
    if (node?.kind === "held") return node.key;
    return pickHeldKey(placeHolder);
  };

  const pickFolder = async (candidates?: readonly vscode.WorkspaceFolder[]): Promise<vscode.WorkspaceFolder | undefined> => {
    const folders = candidates ?? vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      void vscode.window.showWarningMessage("Open a folder first.");
      return undefined;
    }
    if (folders.length === 1) return folders[0];
    return vscode.window.showWorkspaceFolderPick({ placeHolder: "Which workspace folder?" });
  };

  const requireAccountKey = async (): Promise<string | undefined> => {
    const account = await controller.accountKey();
    if (!account) {
      void vscode.window.showWarningMessage("Add a key first, or set an account key, so Key Clarity can talk to the proxy for you.");
    }
    return account;
  };

  // ----- activation flows ---------------------------------------------------------

  /** Warns about credentials that outrank the helper. Returns undefined if the user cancels. */
  const resolveClaudeConflicts = async (settingsFile: string): Promise<{ removeConflicts: boolean } | undefined> => {
    const c = await controller.claudeConflicts(settingsFile);
    if (c.inProcess.length) {
      void vscode.window.showWarningMessage(
        `VS Code was started with ${c.inProcess.join(", ")} set. Claude Code uses that before Key Clarity's key. Unset it in your shell and restart VS Code.`,
      );
    }
    if (c.inVsCodeSetting.length) {
      void vscode.window
        .showWarningMessage(
          `The claudeCode.environmentVariables setting sets ${c.inVsCodeSetting.join(", ")}, which Claude Code uses before Key Clarity's key.`,
          "Open Setting",
        )
        .then((choice) => {
          if (choice) void vscode.commands.executeCommand("workbench.action.openSettings", "claudeCode.environmentVariables");
        });
    }
    if (c.inUserFile.length) {
      void vscode.window.showWarningMessage(
        `${claudeUserSettingsPath()} sets ${c.inUserFile.join(", ")}, which Claude Code uses before this workspace's key. Remove it there, or use Key Clarity for Claude Code globally.`,
      );
    }
    if (c.inFile.length === 0) return { removeConflicts: false };
    const choice = await vscode.window.showWarningMessage(
      `${settingsFile} sets ${c.inFile.join(", ")}, which Claude Code uses before Key Clarity's key.`,
      { modal: true, detail: "Remove it? Key Clarity puts it back if you stop using Key Clarity for Claude Code." },
      "Remove",
      "Keep",
    );
    if (!choice) return undefined;
    return { removeConflicts: choice === "Remove" };
  };

  const offerLoginPromptOff = async () => {
    if (!controller.loginPromptEnabled() || ctx.globalState.get<boolean>(ASKED_LOGIN_PROMPT)) return;
    await ctx.globalState.update(ASKED_LOGIN_PROMPT, true);
    const choice = await vscode.window.showInformationMessage(
      "The Claude Code panel may still ask you to sign in with an Anthropic account. Turn off that prompt? This is recommended when using a proxy.",
      "Turn Off",
      "Not Now",
    );
    if (choice === "Turn Off") await controller.disableLoginPrompt();
  };

  const useForClaude = async (key: HeldKey): Promise<string | undefined> => {
    const resolved = await resolveClaudeConflicts(claudeUserSettingsPath());
    if (!resolved) return undefined;
    const firstTime = !controller.managed("claude");
    await controller.activateClaude(key.hash, resolved);
    void offerLoginPromptOff();
    return firstTime ? "Start a new Claude Code session to use it." : "Running Claude Code sessions switch within a minute.";
  };

  const useForClaudeWorkspace = async (key: HeldKey): Promise<string | undefined> => {
    const folder = await pickFolder();
    if (!folder) return undefined;
    const resolved = await resolveClaudeConflicts(claudeWorkspaceSettingsPath(folder.uri.fsPath));
    if (!resolved) return undefined;
    const firstTime = !controller.managedWorkspace(folder.uri.fsPath);
    await controller.activateClaudeWorkspace(key.hash, folder.uri.fsPath, resolved);
    if (!(await controller.workspaceSettingsIgnored(folder.uri.fsPath))) {
      const choice = await vscode.window.showWarningMessage(
        `.claude/settings.local.json in "${folder.name}" isn't ignored by git. It holds your proxy URL (not the key). Keep it out of commits?`,
        "Add to .git/info/exclude",
        "Leave It",
      );
      if (choice === "Add to .git/info/exclude") await controller.excludeWorkspaceSettings(folder.uri.fsPath);
    }
    void offerLoginPromptOff();
    return `${firstTime ? "Start a new Claude Code session" : "Running sessions switch within a minute"} in "${folder.name}".`;
  };

  const useForCodex = async (key: HeldKey, forceModelPick = false): Promise<string | undefined> => {
    const override = await controller.codexProfileOverride();
    if (override) {
      void vscode.window.showWarningMessage(
        `Your Codex profile "${override}" sets its own model_provider, which overrides Key Clarity while that profile is selected.`,
      );
    }
    const firstTime = !controller.managed("codex");
    await controller.activateCodex(key.hash);

    const models = await controller
      .client()
      .listModels(key.secret)
      .catch(() => [] as string[]);
    const current = await controller.codexModel();
    if (models.length > 0 && (forceModelPick || !current || !models.includes(current))) {
      const reason = current && !models.includes(current) ? `Codex's model "${current}" isn't available with this key. ` : "";
      const model = await vscode.window.showQuickPick(models, { placeHolder: `${reason}Pick the model Codex should use` });
      if (model) await controller.activateCodex(key.hash, model);
    }
    return firstTime ? "Restart Codex (reload the Codex panel) to use it." : "Running Codex sessions switch within a minute.";
  };

  const use = async (key: HeldKey, target: UseTarget) => {
    const notes: string[] = [];
    const labels: string[] = [];
    if (target === "both" || target === "claude") {
      const note = await useForClaude(key);
      if (note === undefined) return;
      notes.push(note);
      labels.push("Claude Code");
    }
    if (target === "claudeWorkspace") {
      const note = await useForClaudeWorkspace(key);
      if (note === undefined) return;
      notes.push(note);
      labels.push("Claude Code in this workspace");
    }
    if (target === "both" || target === "codex") {
      const note = await useForCodex(key);
      if (note === undefined) return;
      notes.push(note);
      labels.push("Codex");
    }
    void vscode.window.showInformationMessage(`${labels.join(" and ")} now use "${key.alias}". ${notes.join(" ")}`);
  };

  const offerUse = async (key: HeldKey, verb: string) => {
    const choice = await vscode.window.showInformationMessage(
      `${verb} "${key.alias}".`,
      "Use for Claude Code and Codex",
      "Use for Claude Code",
      "Use for Codex",
    );
    if (choice === "Use for Claude Code and Codex") await use(key, "both");
    if (choice === "Use for Claude Code") await use(key, "claude");
    if (choice === "Use for Codex") await use(key, "codex");
  };

  // ----- commands -------------------------------------------------------------------

  register("keyClarity.setupProxy", async () => {
    const input = await vscode.window.showInputBox({
      title: "Key Clarity: LiteLLM proxy",
      prompt: "Base URL of your LiteLLM proxy",
      placeHolder: "https://litellm.example.com",
      value: controller.proxyUrl(),
      ignoreFocusOut: true,
      validateInput: (v) => {
        try {
          normalizeBaseUrl(v);
          return undefined;
        } catch (err) {
          return err instanceof Error ? err.message : "Enter a URL.";
        }
      },
    });
    if (!input) return;
    const url = normalizeBaseUrl(input);
    if (isInsecureRemote(url)) {
      const go = await vscode.window.showWarningMessage(
        `${url} uses plain http, so your keys would travel unencrypted.`,
        { modal: true, detail: "Use https unless this proxy is only reachable on a network you trust." },
        "Use It Anyway",
      );
      if (go !== "Use It Anyway") return;
    }
    const reachable = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Checking ${url}…` },
      () =>
        new LiteLLMClient(url)
          .health()
          .then(() => true)
          .catch(() => false),
    );
    if (!reachable) {
      const save = await vscode.window.showWarningMessage(`Couldn't reach ${url}/health/liveliness.`, "Save Anyway", "Cancel");
      if (save !== "Save Anyway") return;
    }
    await vscode.workspace.getConfiguration("keyClarity").update("proxyUrl", url, vscode.ConfigurationTarget.Global);
    if ((await controller.store.list()).length === 0) {
      const next = await vscode.window.showInformationMessage(`Connected to ${url}. Add a key to get started.`, "Add Existing Key", "Generate New Key");
      if (next === "Add Existing Key") await vscode.commands.executeCommand("keyClarity.addKey");
      if (next === "Generate New Key") await vscode.commands.executeCommand("keyClarity.generateKey");
    }
  });

  register("keyClarity.addKey", async () => {
    const client = controller.client();
    const secret = (
      await vscode.window.showInputBox({
        title: "Key Clarity: add a key",
        prompt: "Paste a LiteLLM virtual key. It's stored in VS Code's secret storage.",
        placeHolder: "sk-…",
        password: true,
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim() ? undefined : "Paste a key."),
      })
    )?.trim();
    if (!secret) return;
    let suggested = "";
    try {
      suggested = (await client.keyInfo(secret)).alias ?? "";
    } catch (err) {
      try {
        // Keys limited to model calls can't read /key/info; listing models proves the key works.
        if (!isForbidden(err)) throw err;
        await client.listModels(secret);
      } catch (checkErr) {
        if (checkErr instanceof ProxyError && (checkErr.status === 401 || checkErr.status === 403)) {
          void vscode.window.showErrorMessage(`The proxy rejected this key: ${checkErr.message}`);
          return;
        }
        const go = await vscode.window.showWarningMessage(`Couldn't check the key: ${describeError(checkErr)}`, "Add Anyway", "Cancel");
        if (go !== "Add Anyway") return;
      }
    }
    const alias = await vscode.window.showInputBox({
      prompt: "Name for this key",
      value: suggested,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : "Enter a name."),
    });
    if (!alias) return;
    const key = await controller.store.add(secret, alias.trim());
    await refresh();
    await offerUse(key, "Added");
  });

  register("keyClarity.generateKey", async () => {
    const client = controller.client();
    const account = await requireAccountKey();
    if (!account) return;
    const alias = await vscode.window.showInputBox({
      title: "Key Clarity: generate a key (1/4)",
      prompt: "Name for the new key",
      placeHolder: "project-x",
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : "Enter a name."),
    });
    if (!alias) return;

    const available = await client.listModels(account).catch(() => [] as string[]);
    let models: string[] | undefined;
    if (available.length > 0) {
      const picked = await vscode.window.showQuickPick(available, {
        title: "Key Clarity: generate a key (2/4)",
        placeHolder: "Models the key may call. Leave all unchecked to allow every model your account can use.",
        canPickMany: true,
        ignoreFocusOut: true,
      });
      if (!picked) return;
      models = picked;
    }

    const budget = await vscode.window.showInputBox({
      title: "Key Clarity: generate a key (3/4)",
      prompt: "Maximum budget in USD. Leave empty for no key-level budget.",
      placeHolder: "50",
      ignoreFocusOut: true,
      validateInput: (v) => (!v.trim() || (Number.isFinite(Number(v)) && Number(v) > 0) ? undefined : "Enter a positive number, or leave empty."),
    });
    if (budget === undefined) return;

    const duration = await vscode.window.showInputBox({
      title: "Key Clarity: generate a key (4/4)",
      prompt: "Expire after, such as 30d or 12h. Leave empty for no expiry.",
      placeHolder: "30d",
      ignoreFocusOut: true,
      validateInput: (v) => (!v.trim() || /^\d+[smhd]$/.test(v.trim()) ? undefined : "Use a number followed by s, m, h or d, such as 30d."),
    });
    if (duration === undefined) return;

    const created = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Creating key…" }, () =>
      client.generateKey(account, {
        alias: alias.trim(),
        models,
        maxBudget: budget.trim() ? Number(budget) : undefined,
        duration: duration.trim() || undefined,
      }),
    );
    const key = await controller.store.add(created.key, alias.trim());
    await refresh();
    await offerUse(key, "Created");
  });

  register("keyClarity.refresh", () =>
    vscode.window.withProgress({ location: { viewId: "keyClarity.keys" } }, () => refresh()),
  );

  register("keyClarity.switchKey", async () => {
    if (!controller.proxyUrl()) {
      await vscode.commands.executeCommand("keyClarity.setupProxy");
      return;
    }
    const key = await pickHeldKey("Switch to which key?");
    if (!key) return;
    const targets: Array<{ label: string; target: UseTarget }> = [
      { label: "Claude Code and Codex", target: "both" },
      { label: "Claude Code", target: "claude" },
    ];
    if (vscode.workspace.workspaceFolders?.length) targets.push({ label: "Claude Code in this workspace only", target: "claudeWorkspace" });
    targets.push({ label: "Codex", target: "codex" });
    const picked = await vscode.window.showQuickPick(targets, { placeHolder: `Use "${key.alias}" for…` });
    if (picked) await use(key, picked.target);
  });

  register("keyClarity.activateBoth", async (arg) => {
    const key = await keyFromArg(arg, "Use which key for Claude Code and Codex?");
    if (key) await use(key, "both");
  });
  register("keyClarity.activateClaude", async (arg) => {
    const key = await keyFromArg(arg, "Use which key for Claude Code?");
    if (key) await use(key, "claude");
  });
  register("keyClarity.activateClaudeWorkspace", async (arg) => {
    const key = await keyFromArg(arg, "Use which key for Claude Code in this workspace?");
    if (key) await use(key, "claudeWorkspace");
  });
  register("keyClarity.activateCodex", async (arg) => {
    const key = await keyFromArg(arg, "Use which key for Codex?");
    if (key) await use(key, "codex");
  });

  register("keyClarity.chooseCodexModel", async () => {
    const managed = controller.managed("codex");
    const key = managed ? await controller.store.get(managed.hash) : undefined;
    if (!key) {
      void vscode.window.showInformationMessage("Use a key for Codex first.");
      return;
    }
    await useForCodex(key, true);
  });

  register("keyClarity.copyKey", async (arg) => {
    const key = await keyFromArg(arg, "Copy which key?");
    if (!key) return;
    await vscode.env.clipboard.writeText(key.secret);
    void vscode.window.showInformationMessage(`Copied "${key.alias}" to the clipboard.`);
  });

  register("keyClarity.renameKey", async (arg) => {
    const key = await keyFromArg(arg, "Rename which key?");
    if (!key) return;
    const alias = (
      await vscode.window.showInputBox({ prompt: "New name", value: key.alias, validateInput: (v) => (v.trim() ? undefined : "Enter a name.") })
    )?.trim();
    if (!alias || alias === key.alias) return;
    await controller.store.rename(key.hash, alias);
    try {
      await controller.client().updateAlias((await controller.accountKey()) ?? key.secret, key.secret, alias);
    } catch (err) {
      void vscode.window.showWarningMessage(`Renamed here, but couldn't rename it on the proxy: ${describeError(err)}`);
    }
    if (controller.activeLabels(key.hash).length) await controller.reapplyActive();
    await refresh();
  });

  register("keyClarity.forgetKey", async (arg) => {
    const key = await keyFromArg(arg, "Remove which key from Key Clarity?");
    if (!key) return;
    const active = controller.activeLabels(key.hash);
    if (active.length) {
      void vscode.window.showWarningMessage(`"${key.alias}" is in use for ${active.join(", ")}. Switch to another key or stop managing it first.`);
      return;
    }
    const ok = await vscode.window.showWarningMessage(
      `Remove "${key.alias}" from Key Clarity?`,
      { modal: true, detail: "The key stays valid on the proxy. Keep a copy if you'll need it again." },
      "Remove",
    );
    if (ok !== "Remove") return;
    await controller.store.remove(key.hash);
    await refresh();
  });

  register("keyClarity.deleteKeyOnProxy", async (arg) => {
    const node = arg as KeyNode | undefined;
    let hash: string;
    let name: string;
    if (node?.kind === "remote") {
      hash = node.key.hash;
      name = node.key.alias ?? node.key.maskedKey ?? hash.slice(0, 8);
    } else {
      const key = await keyFromArg(arg, "Delete which key on the proxy?");
      if (!key) return;
      hash = key.hash;
      name = key.alias;
    }
    const active = controller.activeLabels(hash);
    if (active.length) {
      void vscode.window.showWarningMessage(`"${name}" is in use for ${active.join(", ")}. Switch to another key first.`);
      return;
    }
    const account = await requireAccountKey();
    if (!account) return;
    const ok = await vscode.window.showWarningMessage(
      `Delete "${name}" on the proxy?`,
      { modal: true, detail: "Anything using this key stops working. This can't be undone." },
      "Delete Key",
    );
    if (ok !== "Delete Key") return;
    await controller.client().deleteKeys(account, [hash]);
    await controller.store.remove(hash);
    await refresh();
  });

  register("keyClarity.setAccountKey", async () => {
    const current = await controller.store.getAccountKey();
    const secret = await vscode.window.showInputBox({
      title: "Key Clarity: account key",
      prompt: current
        ? "Key used to list and create keys. Leave empty to clear it and use your active key instead."
        : "Optional key used to list and create keys. Without one, Key Clarity uses your active key.",
      password: true,
      ignoreFocusOut: true,
    });
    if (secret === undefined) return;
    if (secret.trim()) await controller.client().keyInfo(secret.trim());
    await controller.store.setAccountKey(secret.trim() || undefined);
    void vscode.window.showInformationMessage(secret.trim() ? "Account key saved." : "Account key cleared.");
    await refresh();
  });

  register("keyClarity.deactivateClaude", async () => {
    const done = await controller.deactivateClaude();
    void vscode.window.showInformationMessage(
      done ? "Claude Code is back to its settings from before Key Clarity. Start a new session to apply." : "Key Clarity isn't managing Claude Code.",
    );
  });

  register("keyClarity.deactivateClaudeWorkspace", async () => {
    const managed = (vscode.workspace.workspaceFolders ?? []).filter((f) => controller.managedWorkspace(f.uri.fsPath));
    if (managed.length === 0) {
      void vscode.window.showInformationMessage("Key Clarity isn't managing Claude Code in any open workspace folder.");
      return;
    }
    const folder = await pickFolder(managed);
    if (!folder) return;
    await controller.deactivateClaudeWorkspace(folder.uri.fsPath);
    void vscode.window.showInformationMessage(`Claude Code in "${folder.name}" is back to its previous settings.`);
  });

  register("keyClarity.deactivateCodex", async () => {
    const done = await controller.deactivateCodex();
    void vscode.window.showInformationMessage(
      done ? "Codex is back to its settings from before Key Clarity. Restart Codex to apply." : "Key Clarity isn't managing Codex.",
    );
  });
}
