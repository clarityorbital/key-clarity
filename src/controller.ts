import { execFile } from "node:child_process";
import { chmod, realpath, rm } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { sharedBudgets, windowStart, type SharedBudget } from "./format";
import { KeyStore, type HeldKey } from "./keys/keyStore";
import { LiteLLMClient, ProxyError, type KeyInfo, type OwnerBudgets, type RemoteKey } from "./proxy/client";
import { fetchKeyStatus, type KeyStatus } from "./proxy/keyStatus";
import {
  applyClaudeActivation,
  claudeUserSettingsPath,
  claudeWorkspaceSettingsPath,
  DEFAULT_ENV_FLAGS,
  findClaudeConflicts,
  mergePrevious,
  OUTRANKING_ENV,
  parseSettings,
  removeEnvVars,
  restoreClaude,
  type PreviousValues,
} from "./targets/claude";
import { applyCodexActivation, codexConfigPath, currentModel, findProfileOverride, removeProviderTables, restoreCodex } from "./targets/codex";
import { assertNoSymlinks, atomicWrite, backupOnce, readIfExists } from "./targets/fsUtil";
import { claudeKeyFile, codexKeyFile, removeKeyFile, workspaceBackupFile, workspaceKeyFile, writeKeyFile } from "./targets/keyFiles";

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
  /** Codex only: the provider id written, so a later change to the setting can't orphan or clobber tables. */
  providerId?: string;
}

/** Secret-storage key holding credential values removed from a settings file, for restoring later. */
const removedEnvKey = (file: string) => `keyClarity.removedEnv:${file}`;

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
  /** Budgets of the account key's user and teams, when the proxy shares them. */
  owner: OwnerBudgets | undefined;
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

  /**
   * The key used to read spend, list keys and create keys: the account key if set, else the first
   * held key the proxy lets read key info, trying the Claude and Codex keys first. Keys limited to
   * model calls can't, so picking one of them would hide spend and other keys.
   */
  async accountKey(): Promise<string | undefined> {
    const explicit = await this.store.getAccountKey();
    if (explicit) return explicit;
    const keys = await this.store.list();
    const preferred = [this.managed("claude")?.hash, this.managed("codex")?.hash];
    const rank = (hash: string) => {
      const i = preferred.indexOf(hash);
      return i === -1 ? preferred.length : i;
    };
    const ordered = [...keys].sort((a, b) => rank(a.hash) - rank(b.hash));
    if (this.proxyUrl()) {
      const client = this.client();
      for (const k of ordered) {
        try {
          await client.keyInfo(k.secret);
          return k.secret;
        } catch (err) {
          // Unreachable proxy: trying the other keys would only wait out more timeouts.
          if (err instanceof ProxyError && err.status === null) break;
        }
      }
    }
    return ordered[0]?.secret;
  }

  /** Refreshes spend and budget for every held key, the user and team budgets, then the user's other keys on the proxy. */
  async refresh(): Promise<void> {
    if (!this.proxyUrl()) {
      this.status.clear();
      this.remote = [];
      this.owner = undefined;
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
    this.owner = account ? await client.ownerBudgets(account).catch(() => undefined) : undefined;
    await Promise.all(keys.map((k) => this.fillWindowSpend(client, account, k, this.status.get(k.hash)?.info)));
    this.remote = account ? await this.fetchRemote(client, account, keys).catch(() => []) : [];
    this.fireChanged();
  }

  /**
   * Fills in spend for a key's budget windows, which the proxy only reports by date range. Asks with
   * the key itself, else the account key when it's the same user's: the proxy scopes spend to the
   * caller's user, so another user's key would see none.
   */
  private async fillWindowSpend(client: LiteLLMClient, account: string | undefined, key: HeldKey, info: KeyInfo | undefined): Promise<void> {
    if (!info?.budgetWindows.length) return;
    const auth = [key.secret];
    if (account && account !== key.secret && this.owner?.userId && this.owner.userId === info.userId) auth.push(account);
    const today = new Date().toISOString().slice(0, 10);
    await Promise.all(
      info.budgetWindows.map(async (w) => {
        const start = windowStart(w);
        if (!start) return;
        for (const a of auth) {
          try {
            w.spend = await client.keySpend(a, key.hash, start.toISOString().slice(0, 10), today);
            return;
          } catch {
            // Try the next key, or leave the spend unknown.
          }
        }
      }),
    );
  }

  /** User and team budgets that also limit a key. */
  sharedBudgets(info: KeyInfo): SharedBudget[] {
    return sharedBudgets(info, this.owner);
  }

  private async fetchRemote(client: LiteLLMClient, account: string, held: HeldKey[]): Promise<RemoteKey[]> {
    const userId = this.owner?.userId ?? (await client.keyInfo(account)).userId;
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
    // The repo controls these paths: never follow a link it planted to some other file.
    await assertNoSymlinks([path.dirname(file), file]);
    const managed = await this.writeClaudeSettings(file, keyFile, key, opts.removeConflicts, this.managedWorkspace(folder), workspaceBackupFile(folder));
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
    backupPath?: string,
  ): Promise<Omit<Managed, "hash">> {
    const before = await readIfExists(file);
    let text = before ?? "";
    let removed: PreviousValues = {};
    if (removeConflicts && before) {
      const names = findClaudeConflicts(before);
      const env = (parseSettings(before).env ?? {}) as Record<string, unknown>;
      // The removed values are credentials: keep them in secret storage, not in plain extension state.
      const stash = await this.readRemovedEnv(file);
      for (const n of names) if (!(`env.${n}` in stash)) stash[`env.${n}`] = env[n];
      await this.ctx.secrets.store(removedEnvKey(file), JSON.stringify(stash));
      removed = Object.fromEntries(names.map((n) => [`env.${n}`, { existed: true, inSecretStorage: true }]));
      text = removeEnvVars(text, names);
    }
    const config = vscode.workspace.getConfiguration("keyClarity");
    const ttl = config.get<number>("claude.helperTtlMs") ?? 60000;
    const flags = DEFAULT_ENV_FLAGS.filter((f) => config.get<boolean>(`claude.${f.setting}`) ?? true).map((f) => f.env);
    const result = applyClaudeActivation(
      text,
      { baseUrl: this.client().baseUrl, keyFilePath: keyFile, alias: key.alias, helperTtlMs: ttl, flags },
      earlier?.previous,
    );
    if (result.text !== before) {
      await this.backup(file, backupPath);
      await atomicWrite(file, result.text);
    }
    const kept = Object.fromEntries(Object.entries(earlier?.previous ?? {}).filter(([k]) => !result.released.includes(k)));
    return {
      previous: mergePrevious(kept, { ...removed, ...result.previous }),
      createdFile: earlier ? earlier.createdFile : before === undefined,
    };
  }

  private async readRemovedEnv(file: string): Promise<Record<string, unknown>> {
    try {
      return JSON.parse((await this.ctx.secrets.get(removedEnvKey(file))) ?? "{}") as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  /** Backs a file up once, with owner-only permissions when the backup lives outside the file's folder. */
  private async backup(file: string, backupPath?: string): Promise<void> {
    const made = await backupOnce(file, backupPath);
    if (made && backupPath) await chmod(made, 0o600).catch(() => undefined);
  }

  /** Undoes Key Clarity's edits to a Claude settings file, deleting it if Key Clarity created it and it is now empty. */
  private async restoreClaudeFile(file: string, managed: Managed): Promise<void> {
    const text = await readIfExists(file);
    const stash = await this.readRemovedEnv(file);
    await this.ctx.secrets.delete(removedEnvKey(file));
    if (text === undefined) return;
    const previous: PreviousValues = Object.fromEntries(
      Object.entries(managed.previous).map(([k, v]) => [k, v.inSecretStorage ? { existed: k in stash, value: stash[k] } : v]),
    );
    const restored = restoreClaude(text, previous);
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
    const file = claudeWorkspaceSettingsPath(folder);
    await assertNoSymlinks([path.dirname(file), file]);
    await this.restoreClaudeFile(file, managed);
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
    const rel = await new Promise<string>((resolve, reject) =>
      execFile("git", ["-C", folder, "rev-parse", "--git-path", "info/exclude"], (err, stdout) => (err ? reject(err) : resolve(stdout.trim()))),
    );
    // A repo can point .git elsewhere with a `gitdir:` file; only write inside this folder.
    const root = await realpath(folder);
    const exclude = path.resolve(root, rel);
    if (!exclude.startsWith(root + path.sep)) {
      throw new Error("This repo's git folder is outside the workspace. Add .claude/settings.local.json to .gitignore instead.");
    }
    await assertNoSymlinks([path.dirname(exclude), exclude]);
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
    const providerId = this.providerId();
    const earlierId = this.managed("codex")?.providerId;
    const source = before !== undefined && earlierId && earlierId !== providerId ? removeProviderTables(before, earlierId) : before;
    const result = applyCodexActivation(source, {
      providerId,
      baseUrl: this.client().baseUrl,
      keyFilePath: keyFile,
      alias: key.alias,
      model,
    });
    await writeKeyFile(keyFile, key.secret);
    if (result.text !== before) {
      await this.backup(file);
      await atomicWrite(file, result.text);
    }
    const previous = mergePrevious(this.managed("codex")?.previous, result.previous);
    await this.ctx.globalState.update(STATE.codex, { hash, previous, providerId } satisfies Managed);
    await this.updateTerminalEnv();
    this.fireChanged();
  }

  async deactivateCodex(): Promise<boolean> {
    const managed = this.managed("codex");
    if (!managed) return false;
    const file = codexConfigPath();
    const text = await readIfExists(file);
    if (text !== undefined) await atomicWrite(file, restoreCodex(text, managed.previous, managed.providerId ?? this.providerId()));
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
