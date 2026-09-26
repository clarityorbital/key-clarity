// Runs test/vscode/suite.ts inside a real, headless VS Code with an isolated profile,
// isolated Claude/Codex config homes, and a temporary git workspace.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
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

await runTests({
  extensionDevelopmentPath: root,
  extensionTestsPath: path.join(root, "dist-test/suite.js"),
  launchArgs: [workspace, "--disable-extensions", `--user-data-dir=${path.join(sandbox, "user-data")}`, "--disable-gpu", "--password-store=basic"],
  extensionTestsEnv: {
    CLAUDE_CONFIG_DIR: path.join(sandbox, "claude"),
    CODEX_HOME: path.join(sandbox, "codex"),
    KEY_CLARITY_HOME: path.join(sandbox, "key-clarity"),
    KC_TEST_WORKSPACE: workspace,
  },
});
