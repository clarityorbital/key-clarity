import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWrite } from "./fsUtil";

// Claude Code's apiKeyHelper and Codex's auth command run outside VS Code, so they can't
// read SecretStorage. The active key for each target is mirrored into a 0600 file in a
// 0700 directory, the same protection Claude Code and Codex give their own credential files.

export function keyDir(): string {
  return process.env.KEY_CLARITY_HOME || path.join(os.homedir(), ".key-clarity");
}

export function claudeKeyFile(): string {
  return path.join(keyDir(), "claude.key");
}

export function codexKeyFile(): string {
  return path.join(keyDir(), "codex.key");
}

/** One key file per workspace folder, named by a hash of its path. */
export function workspaceKeyFile(workspacePath: string): string {
  const id = createHash("sha256").update(path.resolve(workspacePath)).digest("hex").slice(0, 12);
  const name = path.basename(workspacePath).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40);
  return path.join(keyDir(), "workspaces", `${name}-${id}.key`);
}

export async function writeKeyFile(file: string, secret: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  for (const dir of new Set([keyDir(), path.dirname(file)])) {
    await fs.chmod(dir, 0o700).catch(() => undefined);
  }
  await atomicWrite(file, secret + "\n", 0o600);
}

export async function removeKeyFile(file: string): Promise<void> {
  await fs.rm(file, { force: true });
}
