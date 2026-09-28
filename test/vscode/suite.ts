import * as assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, symlink, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import * as vscode from "vscode";
import type { TestApi } from "../../src/extension";
import { hashKey } from "../../src/keys/keyStore";
import { startMockProxy } from "../mockProxy";

// Runs inside the VS Code extension host (see runTest.mjs). Drives the real extension
// through its controller and checks the files Claude Code and Codex would read.

const claudeSettings = path.join(process.env.CLAUDE_CONFIG_DIR!, "settings.json");
const codexConfig = path.join(process.env.CODEX_HOME!, "config.toml");
const keyHome = process.env.KEY_CLARITY_HOME!;
const workspace = process.env.KC_TEST_WORKSPACE!;

const originalClaude = `{
  // my settings
  "hooks": { "Stop": [] },
  "env": {
    "ANTHROPIC_API_KEY": "sk-old-direct-key",
    "FOO": "1"
  }
}
`;
const originalCodex = `model = "gpt-5.5-codex"
model_provider = "openai"

[mcp_servers.docs]
command = "docs-mcp"
`;

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.log(`  ✗ ${name}`);
    throw err;
  }
}

export async function run(): Promise<void> {
  const proxy = await startMockProxy();
  try {
    await mkdir(path.dirname(claudeSettings), { recursive: true });
    await mkdir(path.dirname(codexConfig), { recursive: true });
    await writeFile(claudeSettings, originalClaude);
    await writeFile(codexConfig, originalCodex);

    const ext = vscode.extensions.getExtension<TestApi>("clarity-orbital.key-clarity");
    assert.ok(ext, "extension is installed");
    const api = await ext.activate();
    assert.ok(api, "test API is exposed in test mode");
    const { controller, tree } = api;

    await step("registers its commands", async () => {
      const commands = await vscode.commands.getCommands(true);
      for (const id of ["keyClarity.setupProxy", "keyClarity.addKey", "keyClarity.generateKey", "keyClarity.switchKey", "keyClarity.deactivateCodex"]) {
        assert.ok(commands.includes(id), id);
      }
    });

    await step("shows nothing until a proxy is set", async () => {
      assert.deepEqual(await tree.getChildren(), []);
    });

    const secretA = proxy.seed("alpha", "user-1", { spend: 46, max_budget: 50 });
    const resetAt = new Date(Date.now() + 10.5 * 86_400_000).toISOString();
    const secretB = proxy.seed("beta", "user-1", {
      models: ["gpt-6-sol"],
      spend: 12.4,
      litellm_budget_table: { max_budget: 200, budget_duration: "1mo", budget_reset_at: resetAt },
    });
    proxy.seed("gamma-not-held", "user-1");
    const a = hashKey(secretA);
    const b = hashKey(secretB);

    await step("connects to the proxy and lists held and other keys", async () => {
      await vscode.workspace.getConfiguration("keyClarity").update("proxyUrl", proxy.url + "/v1", vscode.ConfigurationTarget.Global);
      await controller.store.add(secretA, "alpha");
      await controller.store.add(secretB, "beta");
      await controller.refresh();
      assert.equal(controller.status.get(a)?.info?.spend, 46);
      assert.deepEqual(controller.remote.map((k) => k.alias), ["gamma-not-held"]);
      const nodes = await tree.getChildren();
      assert.deepEqual(nodes.map((n) => n.kind), ["held", "held", "remoteGroup"]);
      const alphaItem = tree.getTreeItem(nodes[0]);
      assert.equal(alphaItem.label, "alpha");
      assert.equal(alphaItem.description, "$46.00 / $50.00");
      const betaItem = tree.getTreeItem(nodes[1]);
      assert.equal(betaItem.description, "$12.40 / $200.00 monthly");
      // Drop Markdown escapes to compare the visible text.
      const tooltip = (betaItem.tooltip as vscode.MarkdownString).value.replace(/\\/g, "");
      assert.match(tooltip, /\| Budget \| \$200\.00 per month \|/);
      assert.match(tooltip, /\| Spent this month \| \$12\.40 \(6%\), \$187\.60 left \|/);
      assert.match(tooltip, /\| Resets \| .* \(in 10 days\) \|/);
    });

    await step("ignores a proxy URL set by the workspace (a cloned repo can't redirect keys)", async () => {
      await mkdir(path.join(workspace, ".vscode"), { recursive: true });
      await writeFile(path.join(workspace, ".vscode", "settings.json"), JSON.stringify({ "keyClarity.proxyUrl": "https://attacker.invalid" }));
      await new Promise((r) => setTimeout(r, 1500));
      assert.equal(controller.proxyUrl(), proxy.url + "/v1");
      assert.equal(controller.client().baseUrl, proxy.url);
    });

    await step("detects a settings.json credential that would outrank the helper", async () => {
      const conflicts = await controller.claudeConflicts();
      assert.deepEqual(conflicts.inFile, ["ANTHROPIC_API_KEY"]);
    });

    await step("uses key A for Claude Code, keeping other settings", async () => {
      await controller.activateClaude(a, { removeConflicts: true });
      const text = await readFile(claudeSettings, "utf8");
      assert.match(text, /\/\/ my settings/);
      assert.match(text, /"hooks": \{ "Stop": \[\] \}/);
      assert.doesNotMatch(text, /sk-old-direct-key/);
      assert.match(text, /"ANTHROPIC_BASE_URL": "http:\/\/127\.0\.0\.1:\d+"/);
      assert.match(text, /"apiKeyHelper": "cat '.*claude\.key' # key-clarity:alpha"/);
      assert.equal(await readFile(path.join(keyHome, "claude.key"), "utf8"), secretA + "\n");
      assert.equal((await stat(path.join(keyHome, "claude.key"))).mode & 0o777, 0o600);
      assert.equal(await readFile(claudeSettings + ".key-clarity-backup", "utf8"), originalClaude);
      assert.doesNotMatch(JSON.stringify(controller.managed("claude")), /sk-old-direct-key/, "removed credential isn't kept in plain state");
      assert.deepEqual(controller.activeLabels(a), ["Claude"]);
    });

    await step("uses key A for Codex", async () => {
      await controller.activateCodex(a);
      const text = await readFile(codexConfig, "utf8");
      assert.match(text, /^model_provider = "key-clarity"$/m);
      assert.match(text, /\[model_providers\.key-clarity\.auth\]/);
      assert.match(text, /\[mcp_servers\.docs\]/);
      assert.equal(await readFile(path.join(keyHome, "codex.key"), "utf8"), secretA + "\n");
      assert.deepEqual(controller.activeLabels(a), ["Claude", "Codex"]);
    });

    await step("switches both to key B", async () => {
      await controller.activateClaude(b, { removeConflicts: false });
      await controller.activateCodex(b, "gpt-6-sol");
      assert.equal(await readFile(path.join(keyHome, "claude.key"), "utf8"), secretB + "\n");
      assert.equal(await readFile(path.join(keyHome, "codex.key"), "utf8"), secretB + "\n");
      const codex = await readFile(codexConfig, "utf8");
      assert.equal(codex.match(/\[model_providers\.key-clarity\]/g)?.length, 1);
      assert.match(codex, /^model = "gpt-6-sol"$/m);
      assert.match(await readFile(claudeSettings, "utf8"), /# key-clarity:beta/);
      assert.deepEqual(controller.activeLabels(a), []);
      assert.deepEqual(controller.activeLabels(b), ["Claude", "Codex"]);
    });

    await step("refuses a workspace settings file that is a planted symlink", async () => {
      const secretFile = path.join(path.dirname(workspace), "outside-secret.json");
      await writeFile(secretFile, `{ "token": "do-not-copy" }`);
      await mkdir(path.join(workspace, ".claude"), { recursive: true });
      const local = path.join(workspace, ".claude", "settings.local.json");
      await symlink(secretFile, local);
      await assert.rejects(controller.activateClaudeWorkspace(a, workspace, { removeConflicts: false }), /symbolic link/);
      assert.equal(await readFile(secretFile, "utf8"), `{ "token": "do-not-copy" }`);
      await unlink(local);
    });

    await step("uses a key for one workspace and keeps its settings out of git", async () => {
      await controller.activateClaudeWorkspace(a, workspace, { removeConflicts: false });
      const local = path.join(workspace, ".claude", "settings.local.json");
      assert.match(await readFile(local, "utf8"), /# key-clarity:alpha/);
      assert.equal(await controller.workspaceSettingsIgnored(workspace), false);
      await controller.excludeWorkspaceSettings(workspace);
      assert.equal(await controller.workspaceSettingsIgnored(workspace), true);
      assert.ok(controller.activeLabels(a)[0]?.startsWith("Claude ("));
      await controller.deactivateClaudeWorkspace(workspace);
      assert.equal(existsSync(local), false, "the settings file Key Clarity created is removed");
    });

    await step("follows a proxy URL change", async () => {
      const second = await startMockProxy();
      try {
        await vscode.workspace.getConfiguration("keyClarity").update("proxyUrl", second.url, vscode.ConfigurationTarget.Global);
        await new Promise((r) => setTimeout(r, 500));
        assert.match(await readFile(claudeSettings, "utf8"), new RegExp(`"ANTHROPIC_BASE_URL": "${second.url.replace(/\./g, "\\.")}"`));
        assert.match(await readFile(codexConfig, "utf8"), new RegExp(`base_url = "${second.url.replace(/\./g, "\\.")}/v1"`));
      } finally {
        await vscode.workspace.getConfiguration("keyClarity").update("proxyUrl", proxy.url, vscode.ConfigurationTarget.Global);
        await new Promise((r) => setTimeout(r, 500));
        await second.close();
      }
    });

    await step("stops managing both and restores the original files", async () => {
      assert.equal(await controller.deactivateClaude(), true);
      assert.equal(await controller.deactivateCodex(), true);
      // Same settings and comments; a restored key may move to the end of its block.
      const restored = await readFile(claudeSettings, "utf8");
      assert.match(restored, /\/\/ my settings/);
      assert.deepEqual(parseJsonc(restored), parseJsonc(originalClaude));
      assert.equal(await readFile(codexConfig, "utf8"), originalCodex);
      assert.equal(existsSync(path.join(keyHome, "claude.key")), false);
      assert.equal(existsSync(path.join(keyHome, "codex.key")), false);
    });

    await step("shows a key limited to model calls as working, without spend", async () => {
      const limitedSecret = proxy.seed("model-calls-only", "user-2", { allowed_routes: ["llm_api_routes"], models: ["gpt-6-sol"] });
      const limited = await controller.store.add(limitedSecret, "model-calls-only");
      await controller.refresh();
      assert.deepEqual(controller.status.get(limited.hash), { limited: { models: ["gpt-6-sol"] } });
      const node = (await tree.getChildren()).find((n) => n.kind === "held" && n.key.alias === "model-calls-only");
      assert.ok(node);
      assert.equal(tree.getTreeItem(node).description, "spend not shown");
      await controller.activateCodex(limited.hash);
      assert.equal(await readFile(path.join(keyHome, "codex.key"), "utf8"), limitedSecret + "\n");
      await controller.deactivateCodex();
    });

    await step("runs the refresh command without error", async () => {
      await vscode.commands.executeCommand("keyClarity.refresh");
    });
  } finally {
    await proxy.close();
  }
}
