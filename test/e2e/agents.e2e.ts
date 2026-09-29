import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyClaudeActivation, DEFAULT_ENV_FLAGS } from "../../src/targets/claude";
import { applyCodexActivation } from "../../src/targets/codex";
import { writeKeyFile } from "../../src/targets/keyFiles";
import { startMockProxy, type MockProxy } from "../mockProxy";

// Runs the real CLIs against the mock proxy with config written by Key Clarity's own
// code, in an isolated HOME, and checks which key each request carried. The CLI is
// stopped as soon as its first model request arrives; no model output is needed.

const CODEX_BIN = process.env.CODEX_BIN || "codex";
const has = (bin: string) => spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0;

let proxy: MockProxy;
beforeAll(async () => {
  proxy = await startMockProxy();
});
afterAll(() => proxy.close());

function isolatedEnv(home: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    DISABLE_TELEMETRY: "1",
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ...extra,
  };
}

/** Runs the command until the proxy sees a request on `pathPart`, then stops it. */
async function firstModelRequest(cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, pathPart: string) {
  const start = proxy.requests.length;
  // Own process group, so wrapper scripts (the npm `codex` shim) die with their children.
  const child = spawn(cmd, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  try {
    for (let i = 0; i < 600; i++) {
      const hit = proxy.requests.slice(start).find((r) => r.path.includes(pathPart));
      if (hit) return hit;
      if (child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`No request to ${pathPart}. CLI output:\n${output.slice(-2000)}`);
  } finally {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      // Already exited.
    }
  }
}

describe.skipIf(!has("claude"))("Claude Code CLI", () => {
  it("sends the key from the apiKeyHelper Key Clarity configures, and follows a switch", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "kc-claude-"));
    const configDir = path.join(home, ".claude");
    const keyFile = path.join(home, ".key-clarity", "claude.key");
    const settingsFile = path.join(configDir, "settings.json");
    await mkdir(configDir, { recursive: true });
    const env = isolatedEnv(home, { CLAUDE_CONFIG_DIR: configDir });

    const keyA = proxy.seed("alpha");
    const keyB = proxy.seed("beta");
    const run = async (secret: string, alias: string) => {
      // With the default flags on, as Key Clarity writes them out of the box.
      const flags = DEFAULT_ENV_FLAGS.map((f) => f.env);
      const { text } = applyClaudeActivation(undefined, { baseUrl: proxy.url, keyFilePath: keyFile, alias, helperTtlMs: 60000, flags });
      await writeFile(settingsFile, text);
      await writeKeyFile(keyFile, secret);
      return firstModelRequest("claude", ["-p", "say hi", "--max-turns", "1"], env, home, "/v1/messages");
    };

    expect((await run(keyA, "alpha")).auth).toBe(keyA);
    expect((await run(keyB, "beta")).auth).toBe(keyB);
  });
});

describe.skipIf(!has(CODEX_BIN))("Codex CLI", () => {
  it("sends the key from the auth command Key Clarity configures, and follows a switch", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "kc-codex-"));
    const codexHome = path.join(home, ".codex");
    const keyFile = path.join(home, ".key-clarity", "codex.key");
    await mkdir(codexHome, { recursive: true });
    const env = isolatedEnv(home, { CODEX_HOME: codexHome });

    const keyA = proxy.seed("alpha");
    const keyB = proxy.seed("beta");
    const run = async (secret: string, alias: string) => {
      const { text } = applyCodexActivation(undefined, { providerId: "key-clarity", baseUrl: proxy.url, keyFilePath: keyFile, alias, model: "gpt-5.6-terra" });
      await writeFile(path.join(codexHome, "config.toml"), text);
      await writeKeyFile(keyFile, secret);
      return firstModelRequest(CODEX_BIN, ["exec", "--skip-git-repo-check", "say hi"], env, home, "/v1/responses");
    };

    expect((await run(keyA, "alpha")).auth).toBe(keyA);
    expect((await run(keyB, "beta")).auth).toBe(keyB);
  });
});
