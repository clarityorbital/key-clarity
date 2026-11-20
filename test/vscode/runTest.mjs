// Runs test/vscode/suite.ts inside a real, headless VS Code with an isolated profile,
// isolated Claude/Codex config homes, and a temporary git workspace.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { runTests } from "@vscode/test-electron";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
await esbuild.build({
  entryPoints: [path.join(root, "test/vscode/suite.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: path.join(root, "dist-test/suite.js"),
  external: ["vscode"],
  // jsonc-parser's UMD entry loads its own files at runtime; its ESM build bundles cleanly.
  mainFields: ["module", "main"],
});

const sandbox = mkdtempSync(path.join(tmpdir(), "kc-vscode-"));
const workspace = path.join(sandbox, "workspace");
mkdirSync(workspace);
execFileSync("git", ["init", "-q", workspace]);

// Keep the developer's git config out of the tests: a global ignore of .claude/settings.local.json,
// which Claude Code users often have, would make the workspace settings look excluded already.
const gitConfig = path.join(sandbox, "gitconfig");
const gitIgnore = path.join(sandbox, "gitignore");
writeFileSync(gitIgnore, "");
writeFileSync(gitConfig, `[core]\n\texcludesFile = ${JSON.stringify(gitIgnore)}\n`);

await runTests({
  extensionDevelopmentPath: root,
  extensionTestsPath: path.join(root, "dist-test/suite.js"),
  launchArgs: [workspace, "--disable-extensions", `--user-data-dir=${path.join(sandbox, "user-data")}`, "--disable-gpu", "--password-store=basic"],
  extensionTestsEnv: {
    CLAUDE_CONFIG_DIR: path.join(sandbox, "claude"),
    CODEX_HOME: path.join(sandbox, "codex"),
    KEY_CLARITY_HOME: path.join(sandbox, "key-clarity"),
    KC_TEST_WORKSPACE: workspace,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
  },
});
