import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { KeyStore, type HeldKey } from "./keys/keyStore";
import { LiteLLMClient, ProxyError, type RemoteKey } from "./proxy/client";
import { fetchKeyStatus, type KeyStatus } from "./proxy/keyStatus";
import {
  applyClaudeActivation,
  claudeUserSettingsPath,
  claudeWorkspaceSettingsPath,
  findClaudeConflicts,
  mergePrevious,
  OUTRANKING_ENV,
  parseSettings,
  removeEnvVars,
  restoreClaude,
  type PreviousValues,
} from "./targets/claude";
import { applyCodexActivation, codexConfigPath, currentModel, findProfileOverride, restoreCodex } from "./targets/codex";
import { atomicWrite, backupOnce, readIfExists } from "./targets/fsUtil";
import { claudeKeyFile, codexKeyFile, removeKeyFile, workspaceKeyFile, writeKeyFile } from "./targets/keyFiles";

export type Target = "claude" | "codex";

export type { KeyStatus };

export interface ClaudeConflicts {
  /** Outranking variables in the settings file's env block; Key Clarity can remove these. */
  inFile: string[];
  /** Outranking variables VS Code itself was started with; the user must unset these. */
  inProcess: string[];
  /** Outranking variables in the `claudeCode.environmentVariables` VS Code setting. */
  inVsCodeSetting: string[];
  /** For a workspace activation: outranking variables in the user settings file, which also apply. */
  inUserFile: string[];
}

interface Managed {
  hash: string;
  previous: PreviousValues;
  /** Key Clarity created the settings file, so it is deleted again if nothing else ends up in it. */
  createdFile?: boolean;
}

const CLAUDE_EXTENSION_ID = "anthropic.claude-code";

const STATE = {
  claude: "keyClarity.managed.claude",
  codex: "keyClarity.managed.codex",
  workspacePrefix: "keyClarity.managed.claudeWorkspace:",
  loginPrompt: "keyClarity.setLoginPrompt",
} as const;

/** Owns the key store, cached key status, and every write to Claude Code and Codex config. */
export class Controller implements vscode.Disposable {
  readonly store: KeyStore;
  readonly status = new Map<string, KeyStatus>();
  remote: RemoteKey[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.store = new KeyStore(ctx.secrets);
  }

  dispose(): void {
    this.changed.dispose();
  }

  fireChanged(): void {
    this.changed.fire();
  }

  // ----- proxy -------------------------------------------------------------

  proxyUrl(): string | undefined {
    const url = vscode.workspace.getConfiguration("keyClarity").get<string>("proxyUrl")?.trim();
    return url || undefined;
  }

  client(): LiteLLMClient {
    const url = this.proxyUrl();
    if (!url) throw new Error("Set up your LiteLLM proxy first (Key Clarity: Set Up Proxy).");
    return new LiteLLMClient(url);
  }

  /** The key used to list and create keys: the account key if set, else the Claude or Codex key, else the first key. */
  async accountKey(): Promise<string | undefined> {
    const explicit = await this.store.getAccountKey();
    if (explicit) return explicit;
    const keys = await this.store.list();
    const preferred = [this.managed("claude")?.hash, this.managed("codex")?.hash];
    for (const hash of preferred) {
      const k = keys.find((x) => x.hash === hash);
      if (k) return k.secret;
    }
    return keys[0]?.secret;
  }

  /** Refreshes spend and budget for every held key, then the list of the user's other keys on the proxy. */
  async refresh(): Promise<void> {
    if (!this.proxyUrl()) {
      this.status.clear();
      this.remote = [];
      this.fireChanged();
      return;
    }
    const client = this.client();
    const keys = await this.store.list();
    const account = await this.accountKey();
    await Promise.all(keys.map(async (k) => this.status.set(k.hash, await fetchKeyStatus(client, k.secret, account))));
    for (const hash of [...this.status.keys()]) {
      if (!keys.some((k) => k.hash === hash)) this.status.delete(hash);
    }
    this.remote = await this.fetchRemote(client, keys).catch(() => []);
    this.fireChanged();
  }

  private async fetchRemote(client: LiteLLMClient, held: HeldKey[]): Promise<RemoteKey[]> {
    const account = await this.accountKey();
    if (!account) return [];
    const userId = (await client.keyInfo(account)).userId;
    if (!userId) return [];
    const heldHashes = new Set(held.map((k) => k.hash));
    return (await client.listKeys(account, userId)).filter((k) => !heldHashes.has(k.hash));
  }

  // ----- state ---------------------------------------------------------------

  managed(target: Target): Managed | undefined {
    return this.ctx.globalState.get<Managed>(STATE[target]);
  }

  managedWorkspace(folder: string): Managed | undefined {
    return this.ctx.workspaceState.get<Managed>(STATE.workspacePrefix + folder);
  }

  /** Targets a key is active for, as labels. */
  activeLabels(hash: string): string[] {
    const labels: string[] = [];
    if (this.managed("claude")?.hash === hash) labels.push("Claude");
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (this.managedWorkspace(folder.uri.fsPath)?.hash === hash) labels.push(`Claude (${folder.name})`);
    }
    if (this.managed("codex")?.hash === hash) labels.push("Codex");
    return labels;
  }

  private async requireKey(hash: string): Promise<HeldKey> {
    const key = await this.store.get(hash);
    if (!key) throw new Error("That key is no longer stored in Key Clarity.");
    return key;
  }

  // ----- Claude Code -----------------------------------------------------------

  async claudeConflicts(settingsFile = claudeUserSettingsPath()): Promise<ClaudeConflicts> {
    const inFile = findClaudeConflicts(await readIfExists(settingsFile));
    const inProcess = OUTRANKING_ENV.filter((n) => !!process.env[n] && process.env[n] !== "0");
    const setting = vscode.workspace.getConfiguration("claudeCode").get<Array<{ name?: string; value?: string }>>("environmentVariables") ?? [];
    const inVsCodeSetting = OUTRANKING_ENV.filter((n) => setting.some((v) => v?.name === n && !!v.value));
    const userFile = claudeUserSettingsPath();
    const inUserFile = settingsFile === userFile ? [] : findClaudeConflicts(await readIfExists(userFile));
    return { inFile, inProcess, inVsCodeSetting, inUserFile };
  }

  async activateClaude(hash: string, opts: { removeConflicts: boolean }): Promise<void> {
    const key = await this.requireKey(hash);
    const file = claudeUserSettingsPath();
    const keyFile = claudeKeyFile();
    const managed = await this.writeClaudeSettings(file, keyFile, key, opts.removeConflicts, this.managed("claude"));
    await writeKeyFile(keyFile, key.secret);
    await this.ctx.globalState.update(STATE.claude, { hash, ...managed } satisfies Managed);
    this.fireChanged();
  }

  async activateClaudeWorkspace(hash: string, folder: string, opts: { removeConflicts: boolean }): Promise<void> {
    const key = await this.requireKey(hash);
    const file = claudeWorkspaceSettingsPath(folder);
    const keyFile = workspaceKeyFile(folder);
    const managed = await this.writeClaudeSettings(file, keyFile, key, opts.removeConflicts, this.managedWorkspace(folder));
    await writeKeyFile(keyFile, key.secret);
    await this.ctx.workspaceState.update(STATE.workspacePrefix + folder, { hash, ...managed } satisfies Managed);
    this.fireChanged();
  }

  private async writeClaudeSettings(
    file: string,
    keyFile: string,
    key: HeldKey,
    removeConflicts: boolean,
    earlier: Managed | undefined,
  ): Promise<Omit<Managed, "hash">> {
    const before = await readIfExists(file);
    let text = before ?? "";
    let removed: PreviousValues = {};
    if (removeConflicts && before) {
      const names = findClaudeConflicts(before);
      const env = (parseSettings(before).env ?? {}) as Record<string, unknown>;
      removed = Object.fromEntries(names.map((n) => [`env.${n}`, { existed: true, value: env[n] }]));
      text = removeEnvVars(text, names);
    }
    const ttl = vscode.workspace.getConfiguration("keyClarity").get<number>("claude.helperTtlMs") ?? 60000;
    const result = applyClaudeActivation(text, { baseUrl: this.client().baseUrl, keyFilePath: keyFile, alias: key.alias, helperTtlMs: ttl });
    if (result.text !== before) {
      await backupOnce(file);
      await atomicWrite(file, result.text);
    }
    return {
      previous: mergePrevious(earlier?.previous, { ...removed, ...result.previous }),
      createdFile: earlier ? earlier.createdFile : before === undefined,
    };
  }

  /** Undoes Key Clarity's edits to a Claude settings file, deleting it if Key Clarity created it and it is now empty. */
  private async restoreClaudeFile(file: string, managed: Managed): Promise<void> {
    const text = await readIfExists(file);
    if (text === undefined) return;
    const restored = restoreClaude(text, managed.previous);
    if (managed.createdFile && Object.keys(parseSettings(restored)).length === 0) {
      await rm(file, { force: true });
    } else {
      await atomicWrite(file, restored);
    }
  }

  async deactivateClaude(): Promise<boolean> {
    const managed = this.managed("claude");
    if (!managed) return false;
    await this.restoreClaudeFile(claudeUserSettingsPath(), managed);
    await removeKeyFile(claudeKeyFile());
    await this.ctx.globalState.update(STATE.claude, undefined);
    await this.restoreLoginPrompt();
    this.fireChanged();
    return true;
  }

  async deactivateClaudeWorkspace(folder: string): Promise<boolean> {
    const managed = this.managedWorkspace(folder);
    if (!managed) return false;
    await this.restoreClaudeFile(claudeWorkspaceSettingsPath(folder), managed);
    await removeKeyFile(workspaceKeyFile(folder));
    await this.ctx.workspaceState.update(STATE.workspacePrefix + folder, undefined);
    this.fireChanged();
    return true;
  }

  /** True when the Claude Code extension is installed and would still show its login screen. */
  loginPromptEnabled(): boolean {
    if (!vscode.extensions.getExtension(CLAUDE_EXTENSION_ID)) return false;
    return !vscode.workspace.getConfiguration("claudeCode").get<boolean>("disableLoginPrompt");
  }

  async disableLoginPrompt(): Promise<void> {
    await vscode.workspace.getConfiguration("claudeCode").update("disableLoginPrompt", true, vscode.ConfigurationTarget.Global);
    await this.ctx.globalState.update(STATE.loginPrompt, true);
  }

  private async restoreLoginPrompt(): Promise<void> {
    if (!this.ctx.globalState.get<boolean>(STATE.loginPrompt)) return;
    await this.ctx.globalState.update(STATE.loginPrompt, undefined);
    if (!vscode.extensions.getExtension(CLAUDE_EXTENSION_ID)) return;
    await vscode.workspace.getConfiguration("claudeCode").update("disableLoginPrompt", undefined, vscode.ConfigurationTarget.Global);
  }

  /**
   * Returns true when `.claude/settings.local.json` in the folder is ignored by git (or the
   * folder isn't a repo). The file holds the proxy URL, which shouldn't be committed.
   */
  async workspaceSettingsIgnored(folder: string): Promise<boolean> {
    const rel = path.join(".claude", "settings.local.json");
    return new Promise((resolve) => {
      execFile("git", ["-C", folder, "check-ignore", "-q", "--no-index", rel], (err) => {
        const code = (err as { code?: number } | null)?.code;
        resolve(!err || code !== 1);
      });
    });
  }

  /** Adds the workspace settings file to `.git/info/exclude`, which is never committed. */
  async excludeWorkspaceSettings(folder: string): Promise<void> {
    const gitDir = await new Promise<string>((resolve, reject) =>
      execFile("git", ["-C", folder, "rev-parse", "--git-dir"], (err, stdout) => (err ? reject(err) : resolve(stdout.trim()))),
    );
    const exclude = path.resolve(folder, gitDir, "info", "exclude");
    const text = (await readIfExists(exclude)) ?? "";
    const line = ".claude/settings.local.json";
    if (!text.split(/\r?\n/).includes(line)) {
      await atomicWrite(exclude, `${text.replace(/\s*$/, text ? "\n" : "")}${line}\n`);
    }
  }

  // ----- Codex --------------------------------------------------------------------

  providerId(): string {
    return vscode.workspace.getConfiguration("keyClarity").get<string>("codex.providerId") || "key-clarity";
  }

  async codexProfileOverride(): Promise<string | undefined> {
    return findProfileOverride(await readIfExists(codexConfigPath()));
  }

  async codexModel(): Promise<string | undefined> {
    return currentModel(await readIfExists(codexConfigPath()));
  }

  async activateCodex(hash: string, model?: string): Promise<void> {
    const key = await this.requireKey(hash);
    const file = codexConfigPath();
    const keyFile = codexKeyFile();
    const before = await readIfExists(file);
    const result = applyCodexActivation(before, {
      providerId: this.providerId(),
      baseUrl: this.client().baseUrl,
      keyFilePath: keyFile,
      alias: key.alias,
      model,
    });
    await writeKeyFile(keyFile, key.secret);
    if (result.text !== before) {
      await backupOnce(file);
      await atomicWrite(file, result.text);
    }
    const previous = mergePrevious(this.managed("codex")?.previous, result.previous);
    await this.ctx.globalState.update(STATE.codex, { hash, previous } satisfies Managed);
    await this.updateTerminalEnv();
    this.fireChanged();
  }

  async deactivateCodex(): Promise<boolean> {
    const managed = this.managed("codex");
    if (!managed) return false;
    const file = codexConfigPath();
    const text = await readIfExists(file);
    if (text !== undefined) await atomicWrite(file, restoreCodex(text, managed.previous, this.providerId()));
    await removeKeyFile(codexKeyFile());
    await this.ctx.globalState.update(STATE.codex, undefined);
    await this.updateTerminalEnv();
    this.fireChanged();
    return true;
  }

  // ----- housekeeping --------------------------------------------------------------

  /** Rewrites key files from secret storage, in case they were deleted or the key was renamed. */
  async syncKeyFiles(): Promise<void> {
    const pairs: Array<[Managed | undefined, string]> = [
      [this.managed("claude"), claudeKeyFile()],
      [this.managed("codex"), codexKeyFile()],
      ...(vscode.workspace.workspaceFolders ?? []).map(
        (f) => [this.managedWorkspace(f.uri.fsPath), workspaceKeyFile(f.uri.fsPath)] as [Managed | undefined, string],
      ),
    ];
    for (const [managed, file] of pairs) {
      if (!managed) continue;
      const key = await this.store.get(managed.hash);
      if (key) await writeKeyFile(file, key.secret);
    }
  }

  /** Re-applies active keys, for example after the proxy URL changes. */
  async reapplyActive(): Promise<void> {
    const claude = this.managed("claude");
    if (claude) await this.activateClaude(claude.hash, { removeConflicts: false });
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const ws = this.managedWorkspace(folder.uri.fsPath);
      if (ws) await this.activateClaudeWorkspace(ws.hash, folder.uri.fsPath, { removeConflicts: false });
    }
    const codex = this.managed("codex");
    if (codex) await this.activateCodex(codex.hash);
  }

  /** Optionally exposes the Codex key (or the Claude key) to new integrated terminals. */
  async updateTerminalEnv(): Promise<void> {
    const env = this.ctx.environmentVariableCollection;
    env.persistent = false;
    env.clear();
    const enabled = vscode.workspace.getConfiguration("keyClarity").get<boolean>("terminal.exportVariables");
    const url = this.proxyUrl();
    const hash = this.managed("codex")?.hash ?? this.managed("claude")?.hash;
    if (!enabled || !url || !hash) return;
    const key = await this.store.get(hash);
    if (!key) return;
    const base = this.client().baseUrl;
    env.description = `Key Clarity: LiteLLM key "${key.alias}"`;
    env.replace("LITELLM_PROXY_URL", base);
    env.replace("LITELLM_PROXY_API_KEY", key.secret);
    env.replace("OPENAI_BASE_URL", `${base}/v1`);
    env.replace("OPENAI_API_KEY", key.secret);
  }
}

export function describeError(err: unknown): string {
  if (err instanceof ProxyError && err.status === 403) {
    return `${err.message}. Keys limited to model calls can't list or create keys. Use Key Clarity: Set Account Key with a key that has key-management access, or create keys in the LiteLLM UI and add them here.`;
  }
  return err instanceof Error ? err.message : String(err);
}
