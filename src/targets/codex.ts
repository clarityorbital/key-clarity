import * as os from "node:os";
import * as path from "node:path";
import { parse as parseToml } from "smol-toml";
import { ConfigEditError, type PreviousValues } from "./claude";

// Edits ~/.codex/config.toml as text instead of re-serializing it, so the user's comments
// and layout survive. Key Clarity owns one provider table (plus its `.auth` sub-table) and
// the root `model_provider` key (and `model`, when the user picks one). Every edit is
// re-parsed and checked before it can be written.

export const MARKER_COMMENT = "# Managed by Key Clarity.";

export interface CodexActivation {
  providerId: string;
  /** Proxy root; `/v1` is appended. */
  baseUrl: string;
  keyFilePath: string;
  alias: string;
  /** Written as root `model` when set. */
  model?: string;
  platform?: NodeJS.Platform;
}

export function codexConfigPath(): string {
  const dir = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(dir, "config.toml");
}

export function parseCodexConfig(text: string | undefined): Record<string, unknown> {
  if (!text || !text.trim()) return {};
  try {
    return parseToml(text) as Record<string, unknown>;
  } catch (err) {
    const reason = err instanceof Error ? err.message.split("\n")[0] : String(err);
    throw new ConfigEditError(`The Codex config isn't valid TOML (${reason}). Fix it and try again.`);
  }
}

/** Codex runs the auth command directly, without a shell, and reads the token from stdout. */
export function authCommand(keyFilePath: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  if (platform === "win32") return { command: "cmd", args: ["/d", "/c", "type", keyFilePath] };
  return { command: "cat", args: [keyFilePath] };
}

function assertProviderId(id: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new ConfigEditError(`Provider id "${id}" may only contain letters, digits, "_" and "-".`);
  }
}

const tomlString = (s: string): string => JSON.stringify(s);

function providerBlock(a: CodexActivation): string {
  const auth = authCommand(a.keyFilePath, a.platform);
  return [
    `${MARKER_COMMENT} Active key: ${a.alias.replace(/[\r\n]/g, " ")}. Switch keys in VS Code; edits here are replaced.`,
    `[model_providers.${a.providerId}]`,
    `name = "LiteLLM (Key Clarity)"`,
    `base_url = ${tomlString(a.baseUrl + "/v1")}`,
    `wire_api = "responses"`,
    ``,
    `[model_providers.${a.providerId}.auth]`,
    `command = ${tomlString(auth.command)}`,
    `args = [${auth.args.map(tomlString).join(", ")}]`,
    `timeout_ms = 5000`,
    `refresh_interval_ms = 60000`,
    ``,
  ].join("\n");
}

const HEADER = /^\s*\[/;

function isOwnHeader(line: string, providerId: string): boolean {
  const m = /^\s*\[\s*([^\]]+?)\s*\]\s*(#.*)?$/.exec(line);
  if (!m || line.trimStart().startsWith("[[")) return false;
  const parts = m[1].split(".").map((s) => s.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1"));
  return parts[0] === "model_providers" && parts[1] === providerId;
}

/** Removes `[model_providers.<id>]`, its sub-tables, and Key Clarity's marker comment. */
export function removeProviderTables(text: string, providerId: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (HEADER.test(line)) skipping = isOwnHeader(line, providerId);
    if (skipping) continue;
    out.push(line);
  }
  // Drop marker comments left above the removed tables.
  const cleaned = out.filter((line) => !line.startsWith(MARKER_COMMENT));
  return collapseBlankRuns(cleaned).join("\n");
}

function collapseBlankRuns(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line.trim() === "" && out.length > 0 && out[out.length - 1].trim() === "") continue;
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
  return out;
}

/** Sets (or removes, when `value` is undefined) a single-line key in the root table. */
export function setRootKey(text: string, key: string, value: string | undefined): string {
  const lines = text.length ? text.split(/\r?\n/) : [];
  let rootEnd = lines.findIndex((l) => HEADER.test(l));
  if (rootEnd < 0) rootEnd = lines.length;
  const keyRe = new RegExp(`^\\s*${key}\\s*=`);
  const idx = lines.slice(0, rootEnd).findIndex((l) => keyRe.test(l));
  const line = value === undefined ? undefined : `${key} = ${tomlString(value)}`;
  if (idx >= 0) {
    if (line === undefined) lines.splice(idx, 1);
    else lines[idx] = line;
  } else if (line !== undefined) {
    // Insert after the root table's last non-blank line, keeping the blank line before the first header.
    let at = rootEnd;
    while (at > 0 && lines[at - 1].trim() === "") at--;
    lines.splice(at, 0, line);
    if (at === 0 && rootEnd < lines.length - 1 && lines[1]?.trim() !== "") lines.splice(1, 0, "");
  }
  return lines.join("\n");
}

function getRoot(parsed: Record<string, unknown>, key: string): string | undefined {
  const v = parsed[key];
  return typeof v === "string" ? v : undefined;
}

/**
 * Points Codex at the proxy through a Key Clarity provider whose auth command reads the key file.
 * `previous` records root keys this call changed, for undoing later.
 */
export function applyCodexActivation(text: string | undefined, a: CodexActivation): { text: string; previous: PreviousValues } {
  assertProviderId(a.providerId);
  const source = text ?? "";
  const parsed = parseCodexConfig(source);
  const previous: PreviousValues = {};

  const rootKeys: Array<[string, string]> = [["model_provider", a.providerId]];
  if (a.model) rootKeys.push(["model", a.model]);

  let out = removeProviderTables(source, a.providerId);
  for (const [key, value] of rootKeys) {
    const before = getRoot(parsed, key);
    if (before !== value) previous[key] = before === undefined ? { existed: false } : { existed: true, value: before };
    out = setRootKey(out, key, value);
  }
  out = (out.trim() ? out.replace(/\s*$/, "\n\n") : "") + providerBlock(a);

  // Verify: the edit must parse and say exactly what we meant.
  let check: Record<string, unknown>;
  try {
    check = parseToml(out) as Record<string, unknown>;
  } catch (err) {
    const reason = err instanceof Error ? err.message.split("\n")[0] : String(err);
    throw new ConfigEditError(
      `Couldn't update the Codex config safely (${reason}). If it defines model_providers.${a.providerId} some other way, remove that and try again.`,
    );
  }
  const provider = ((check.model_providers ?? {}) as Record<string, Record<string, unknown>>)[a.providerId];
  const auth = (provider?.auth ?? {}) as Record<string, unknown>;
  const expected = authCommand(a.keyFilePath, a.platform);
  const ok =
    check.model_provider === a.providerId &&
    (!a.model || check.model === a.model) &&
    provider?.base_url === a.baseUrl + "/v1" &&
    auth.command === expected.command &&
    JSON.stringify(auth.args) === JSON.stringify(expected.args);
  if (!ok) throw new ConfigEditError("Couldn't update the Codex config safely: the result didn't match what was intended.");
  return { text: out, previous };
}

/** Removes Key Clarity's provider and restores the recorded root keys. */
export function restoreCodex(text: string | undefined, previous: PreviousValues, providerId: string): string {
  if (!text) return "";
  parseCodexConfig(text);
  let out = removeProviderTables(text, providerId);
  for (const [key, prev] of Object.entries(previous)) {
    out = setRootKey(out, key, prev.existed && typeof prev.value === "string" ? prev.value : undefined);
  }
  if (out.trim()) out = out.replace(/\s*$/, "\n");
  parseCodexConfig(out);
  return out;
}

/** A selected profile that sets its own model_provider overrides the root one. */
export function findProfileOverride(text: string | undefined): string | undefined {
  const parsed = parseCodexConfig(text);
  const profile = typeof parsed.profile === "string" ? parsed.profile : undefined;
  if (!profile) return undefined;
  const profiles = (parsed.profiles ?? {}) as Record<string, Record<string, unknown>>;
  return profiles[profile]?.model_provider !== undefined ? profile : undefined;
}

export function currentModel(text: string | undefined): string | undefined {
  return getRoot(parseCodexConfig(text), "model");
}
