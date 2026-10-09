import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { describeError, type Controller } from "../controller";
import { isForbidden } from "../proxy/client";
import { periodRange, USAGE_PERIODS, type UsagePeriod } from "../proxy/usage";
import { renderUsageHtml, type UsageViewState } from "../usageView";

const FORBIDDEN =
  "Your proxy only lets these keys make model calls, so it won't share usage. Use Key Clarity: Set Account Key with a key created with full access (key-management routes allowed).";

/**
 * Spend by day, model and key, like the LiteLLM UI's usage page. One panel at a time. It reads the
 * proxy only when opened, when a filter changes and on Refresh, never on a timer.
 */
export class UsagePanel {
  private static current: UsagePanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly state: UsageViewState;
  /** Ignores replies to loads that a newer load replaced. */
  private loadId = 0;

  static show(controller: Controller, keyHash: string | null): void {
    if (UsagePanel.current) {
      UsagePanel.current.panel.reveal();
      if (keyHash !== null && keyHash !== UsagePanel.current.state.keyHash) void UsagePanel.current.load(UsagePanel.current.state.period, keyHash);
      return;
    }
    UsagePanel.current = new UsagePanel(controller, keyHash);
  }

  private constructor(
    private readonly controller: Controller,
    keyHash: string | null,
  ) {
    this.panel = vscode.window.createWebviewPanel("keyClarity.usage", "Key Clarity: Usage", vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [],
    });
    this.state = { period: "30d", keyHash, keyOptions: [], keyNames: new Map(), loading: false, slots: new Map() };
    this.panel.onDidDispose(() => {
      if (UsagePanel.current === this) UsagePanel.current = undefined;
    });
    this.panel.webview.onDidReceiveMessage((msg: { type?: string; period?: string; key?: string }) => {
      if (msg?.type !== "load") return;
      const period = USAGE_PERIODS.some((p) => p.id === msg.period) ? (msg.period as UsagePeriod) : this.state.period;
      void this.load(period, msg.key ? msg.key : null);
    });
    void this.load(this.state.period, keyHash);
  }

  private render(): void {
    this.panel.webview.html = renderUsageHtml(this.state, { nonce: randomBytes(16).toString("base64"), cspSource: this.panel.webview.cspSource });
  }

  private async load(period: UsagePeriod, keyHash: string | null): Promise<void> {
    const id = ++this.loadId;
    Object.assign(this.state, { period, keyHash, loading: true, error: undefined });
    await this.updateKeys();
    this.render();
    try {
      const report = await this.fetch(period, keyHash);
      if (id !== this.loadId) return;
      Object.assign(this.state, { report, loadedAt: new Date() });
    } catch (err) {
      if (id !== this.loadId) return;
      Object.assign(this.state, { report: undefined, error: isForbidden(err) ? FORBIDDEN : describeError(err) });
    }
    this.state.loading = false;
    this.render();
  }

  private async fetch(period: UsagePeriod, keyHash: string | null) {
    const client = this.controller.client();
    const account = await this.controller.accountKey();
    if (!account) throw new Error("Add a key first, or set an account key, so Key Clarity can read usage from the proxy.");
    const { start, end } = periodRange(period);
    // Without a user id, LiteLLM shows an admin's key every user's spend.
    const userId = this.controller.owner?.userId ?? (await client.keyInfo(account)).userId;
    const opts = { startDate: start, endDate: end, keyHash: keyHash ?? undefined, userId };
    try {
      return await client.usage(account, opts);
    } catch (err) {
      // A held key with full access can still read its own usage when the account key can't.
      const held = keyHash ? await this.controller.store.get(keyHash) : undefined;
      if (!isForbidden(err) || !held || held.secret === account) throw err;
      return await client.usage(held.secret, { ...opts, userId: null });
    }
  }

  private async updateKeys(): Promise<void> {
    const held = (await this.controller.store.list()).map((k) => ({ hash: k.hash, label: k.alias }));
    const remote = this.controller.remote.map((k) => ({ hash: k.hash, label: k.alias ?? k.maskedKey ?? k.hash.slice(0, 8) }));
    const options = [...held, ...remote].sort((a, b) => a.label.localeCompare(b.label));
    if (this.state.keyHash && !options.some((o) => o.hash === this.state.keyHash)) options.push({ hash: this.state.keyHash, label: `${this.state.keyHash.slice(0, 8)}…` });
    this.state.keyOptions = options;
    this.state.keyNames = new Map(options.map((o) => [o.hash, o.label]));
  }
}
